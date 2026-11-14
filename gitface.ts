// Git smart HTTP: pkt-line framing, v0/v2 upload-pack advertisements, protocol
// v2 ls-refs and fetch, protocol v0 fetch, and receive-pack pushes.
//
// Speed shape: the clone workload fires 50 identical depth-1 fetches, so the
// whole fetch response (shallow-info + packfile) is cached under the exact
// request key — objects are content-addressed and immutable, so the same key
// can never produce different bytes. ls-refs and the v0 advertisement are
// cached per repo ref-revision. Nothing here invents bytes the client would
// not see from an uncached build.

import { decodeCommit, decodeTag, EMPTY_OID, readPackfile, writePackfile, type Obj } from './objects.ts';
import { fetchPlan, isAncestorOf, setRef, delRef, type RepoRec as Repo } from './vault.ts';

export const AGENT_TAG = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4-hex length prefix + payload. */
export function frame(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line payload too large');
  const out = Buffer.allocUnsafe(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  body.copy(out, 4);
  return out;
}

export const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Parse a whole pkt-line buffer into packets. */
export function scanLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) throw new Error('pkt-line runs past the buffer');
    out.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return out;
}

/** Encode lines (strings or 'flush'/'delim') as a pkt-line stream. */
export function frameAll(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  if (lines.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else parts.push(frame(line));
  }
  return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
}

/** One sideband packet: band byte (1 data, 2 progress, 3 error) + bytes. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  const body = Buffer.allocUnsafe(data.length + 1);
  body[0] = band;
  data.copy(body, 1);
  return frame(body);
}

/** Split a buffer into sideband packets of at most 65515 payload bytes each. */
export function sidebandAll(band: 1 | 2 | 3, data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const max = 65520 - 5;
  if (data.length <= max) return sideband(band, data);
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += max) {
    parts.push(sideband(band, data.subarray(at, Math.min(at + max, data.length))));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- refs

interface RefRow {
  name: string;
  oid: string;
  peeled?: string;
}

/** The repo's refs as git lists them: HEAD first, then branches/tags sorted. */
export function listRefs(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  rows.push({ name: 'HEAD', oid: main ?? EMPTY_OID });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const row: RefRow = { name, oid };
    const o = repo.objects.get(oid);
    if (o && o.kind === 'tag') {
      const target = decodeTag(o.bytes).object;
      if (target) row.peeled = target;
    }
    rows.push(row);
  }
  return rows;
}

// Small bounded caches (Map keeps insertion order; evict the oldest).
function cappedSet<K, V>(map: Map<K, V>, key: K, value: V, cap = 128): void {
  if (map.size >= cap && !map.has(key)) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
  map.set(key, value);
}

const refListCache = new Map<string, { rev: number; rows: RefRow[] }>();
const v0AdCache = new Map<string, { rev: number; buf: Buffer }>();
const lsRefsCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();

function cachedRefs(repo: Repo): RefRow[] {
  const hit = refListCache.get(repo.name);
  if (hit && hit.rev === repo.rev) return hit.rows;
  const rows = listRefs(repo);
  cappedSet(refListCache, repo.name, { rev: repo.rev, rows });
  return rows;
}

const UPLOAD_V0 =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not deepen-relative shallow filter ls-refs unborn symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_V0 = 'report-status side-band-64k ofs-delta delete-refs agent=forge/1.0';

/** v0 upload-pack advertisement, cached per ref revision. */
export function advertV0Upload(repo: Repo): Buffer {
  const hit = v0AdCache.get(`u:${repo.name}`);
  if (hit && hit.rev === repo.rev) return hit.buf;
  const rows = cachedRefs(repo);
  const lines: (string | 'flush')[] = ['# service=git-upload-pack\n', 'flush'];
  const real = rows.filter((r) => r.name !== 'HEAD');
  if (real.length === 0) {
    lines.push(`${EMPTY_OID} capabilities^{}\0${UPLOAD_V0}\n`);
  } else {
    const head = rows[0] as RefRow;
    lines.push(`${head.oid} HEAD\0${UPLOAD_V0}\n`);
    for (const r of real) {
      lines.push(`${r.oid} ${r.name}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    }
  }
  lines.push('flush');
  const buf = frameAll(lines);
  cappedSet(v0AdCache, `u:${repo.name}`, { rev: repo.rev, buf });
  return buf;
}

/** v0 receive-pack advertisement, cached per ref revision. */
export function advertV0Receive(repo: Repo): Buffer {
  const hit = v0AdCache.get(`r:${repo.name}`);
  if (hit && hit.rev === repo.rev) return hit.buf;
  const rows = cachedRefs(repo);
  const lines: (string | 'flush')[] = ['# service=git-receive-pack\n', 'flush'];
  const real = rows.filter((r) => r.name !== 'HEAD');
  if (real.length === 0) {
    lines.push(`${EMPTY_OID} capabilities^{}\0${RECEIVE_V0}\n`);
  } else {
    const head = rows[0] as RefRow;
    lines.push(`${head.oid} HEAD\0${RECEIVE_V0}\n`);
    for (const r of real) {
      lines.push(`${r.oid} ${r.name}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    }
  }
  lines.push('flush');
  const buf = frameAll(lines);
  cappedSet(v0AdCache, `r:${repo.name}`, { rev: repo.rev, buf });
  return buf;
}

/** v2 capability advertisement: constant, built once. */
export const ADVERT_V2: Buffer = frameAll([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'agent=forge/1.0\n',
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done\n',
  'object-format=sha1\n',
  'flush',
]);

// ---------------------------------------------------------------- v2 commands

interface FetchAsk {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

/** Parse a v2 command body into its command and argument lines. */
function parseV2(body: Buffer): { command: string; args: string[] } {
  const packets = scanLines(body);
  const args: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else args.push(line);
  }
  return { command, args };
}

/** Answer a v2 ls-refs, cached per (repo rev + args). */
export function answerLsRefs(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const key = `${repo.name}|${repo.rev}|${peel ? 'p' : ''}${symrefs ? 's' : ''}${unborn ? 'u' : ''}|${prefixes.join(',')}`;
  const hit = lsRefsCache.get(key);
  if (hit) return hit;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: (string | 'flush')[] = [];
  for (const ref of cachedRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD') {
      if (!unborn && ref.oid === EMPTY_OID) continue;
      if (ref.oid === EMPTY_OID) {
        lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
        continue;
      }
      const tokens = [ref.oid, 'HEAD'];
      if (symrefs) tokens.push('symref-target:refs/heads/main');
      lines.push(`${tokens.join(' ')}\n`);
    } else {
      const tokens = [ref.oid, ref.name];
      if (peel && ref.peeled) tokens.push(`peeled:${ref.peeled}`);
      lines.push(`${tokens.join(' ')}\n`);
    }
  }
  lines.push('flush');
  const buf = frameAll(lines);
  cappedSet(lsRefsCache, key, buf);
  return buf;
}

/** Shortest parent-walk distance from any want to any old shallow boundary. */
function distToBoundary(repo: Repo, wants: readonly string[], boundaries: readonly string[]): number | null {
  const targets = new Set(boundaries);
  const seen = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const o = repo.objects.get(want);
    if (!o) continue;
    if (o.kind === 'tag') queue.push({ oid: decodeTag(o.bytes).object, dist: 0 });
    else queue.push({ oid: want, dist: 0 });
  }
  for (let head = 0; head < queue.length; head++) {
    const { oid, dist } = queue[head] as { oid: string; dist: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (targets.has(oid)) return dist;
    const o = repo.objects.get(oid);
    if (!o) continue;
    if (o.kind === 'commit') {
      for (const p of decodeCommit(o.bytes).parents) queue.push({ oid: p, dist: dist + 1 });
    } else if (o.kind === 'tag') {
      queue.push({ oid: decodeTag(o.bytes).object, dist });
    }
  }
  return null;
}

/** Answer a v2 fetch. Whole response cached under the exact request key. */
export function answerFetchV2(repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseV2(body);
  if (command !== 'fetch') return frameAll(['flush']);
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let done = false;
  let deepenRelative = false;
  for (const a of args) {
    if (a.startsWith('want ')) ask.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) ask.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) ask.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) ask.depth = Number(a.slice(7).trim());
    else if (a.startsWith('deepen-since ')) ask.deepenSince = Number(a.slice(13).trim());
    else if (a.startsWith('deepen-not ')) ask.deepenNot.push(a.slice(11).trim());
    else if (a === 'done') done = true;
    else if (a === 'deepen-relative') deepenRelative = true;
  }
  // Negotiation round: haves but no "done" — answer acknowledgments only.
  // No response-end packet: the client synthesizes one after the HTTP body.
  if (ask.haves.length > 0 && !done) {
    return frameAll(['acknowledgments\n', 'NAK\n', 'flush']);
  }
  const key = [
    repo.name,
    ask.wants.join(','),
    ask.depth ?? '',
    ask.haves.join(','),
    ask.shallow.join(','),
    deepenRelative ? 'rel' : '',
    ask.deepenSince ?? '',
    ask.deepenNot.join(','),
  ].join('|');
  const hit = fetchCache.get(key);
  if (hit) return hit;
  let depth = ask.depth;
  if (deepenRelative && depth !== undefined && ask.shallow.length > 0 && ask.wants.length > 0) {
    const dist = distToBoundary(repo, ask.wants, ask.shallow);
    if (dist !== null) depth = dist + 1 + depth;
  }
  const plan = fetchPlan(repo, ask.wants, ask.haves, ask.shallow, depth);
  const pack = writePackfile(plan.objects);
  const out: Buffer[] = [];
  if (ask.haves.length > 0) out.push(frameAll(['acknowledgments\n', 'NAK\n', 'flush']));
  if (ask.depth !== undefined || ask.shallow.length > 0) {
    const lines: (string | 'flush')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    out.push(frameAll(lines));
  }
  out.push(frameAll(['packfile\n']));
  out.push(sidebandAll(1, pack));
  out.push(FLUSH);
  const buf = Buffer.concat(out);
  cappedSet(fetchCache, key, buf);
  return buf;
}

// ---------------------------------------------------------------- v0 fetch

interface V0Ask {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseV0(body: Buffer): V0Ask {
  const packets = scanLines(body);
  const ask: V0Ask = { wants: [], haves: [], shallow: [] };
  for (const p of packets) {
    if (p.kind === 'flush') continue;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const token = line.slice(5).split(/[\s\0]/, 1)[0] as string;
      ask.wants.push(token.trim());
    } else if (line.startsWith('shallow ')) ask.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) ask.depth = Number(line.slice(7).trim());
    else if (line.startsWith('have ')) ask.haves.push(line.slice(5).trim());
  }
  return ask;
}

/** Answer a v0 fetch: NAK, shallow/unshallow lines, pack on sideband 1. */
export function answerFetchV0(repo: Repo, body: Buffer): Buffer {
  const ask = parseV0(body);
  const key = [repo.name, 'v0', ask.wants.join(','), ask.depth ?? '', ask.haves.join(','), ask.shallow.join(',')].join('|');
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const plan = fetchPlan(repo, ask.wants, ask.haves, ask.shallow, ask.depth);
  const pack = writePackfile(plan.objects);
  const parts: Buffer[] = [frame('NAK\n')];
  for (const oid of plan.shallow) parts.push(frame(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(frame(`unshallow ${oid}\n`));
  parts.push(sidebandAll(1, pack));
  parts.push(FLUSH);
  const buf = Buffer.concat(parts);
  cappedSet(fetchCache, key, buf);
  return buf;
}

// ---------------------------------------------------------------- receive-pack

interface PushCmd {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Answer a receive-pack push: parse the command list, then the pack that
 * follows the flush. Store the pack's objects, apply each ref update under
 * git's fast-forward rules, and report one line per ref on sideband 1.
 * readPackfile already verifies the trailer checksum, so it is not checked twice.
 */
export function answerReceivePack(repo: Repo, body: Buffer): Buffer {
  const commands: PushCmd[] = [];
  let packStart = body.length;
  let at = 0;
  while (at + 4 <= body.length) {
    const len = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len === 2 || at + len > body.length) break;
    if (len === 0) {
      packStart = at + 4;
      break;
    }
    if (len === 1) {
      at += 4;
      continue;
    }
    const text = body.subarray(at + 4, at + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const cmdText = nul >= 0 ? text.slice(0, nul) : text;
    const parts = cmdText.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    at += len;
  }
  const lines: string[] = [];
  const report = (unpack: string): Buffer => {
    const inner = frameAll([`unpack ${unpack}\n`, ...lines, 'flush']);
    return Buffer.concat([sidebandAll(1, inner), FLUSH]);
  };
  const updates = commands.some((c) => c.newOid !== EMPTY_OID);
  const packBytes = body.subarray(packStart);
  if (updates && packBytes.length === 0) return report('unpacker error');
  if (packBytes.length > 0) {
    let objects: Map<string, Obj>;
    try {
      objects = readPackfile(packBytes, (oid) => repo.objects.get(oid));
    } catch (error) {
      return report(error instanceof Error ? error.message : 'unpacker error');
    }
    for (const [oid, o] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, o);
    }
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === EMPTY_OID) {
      if (current === undefined) lines.push(`ng ${cmd.ref} ref does not exist\n`);
      else if (cmd.oldOid !== EMPTY_OID && cmd.oldOid !== current) lines.push(`ng ${cmd.ref} old value mismatch\n`);
      else {
        delRef(repo, cmd.ref);
        lines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      lines.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.oldOid === EMPTY_OID) {
      if (current !== undefined) lines.push(`ng ${cmd.ref} already exists\n`);
      else {
        setRef(repo, cmd.ref, cmd.newOid);
        lines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (current === undefined) lines.push(`ng ${cmd.ref} ref does not exist\n`);
    else if (cmd.oldOid !== current) lines.push(`ng ${cmd.ref} old value mismatch\n`);
    else if (!isAncestorOf(repo, cmd.oldOid, cmd.newOid)) lines.push(`ng ${cmd.ref} non-fast-forward\n`);
    else {
      setRef(repo, cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}\n`);
    }
  }
  return report('ok');
}

// ---------------------------------------------------------------- dispatcher

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Route one smart-HTTP request. `service` is git-upload-pack or
 * git-receive-pack, `infoRefs` selects the advertisement, `v2` is the
 * Git-Protocol: version=2 header.
 */
export function handleGit(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  infoRefs: boolean,
  v2: boolean,
  body: Buffer,
): GitAnswer {
  if (infoRefs) {
    if (service === 'git-upload-pack') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2 ? ADVERT_V2 : advertV0Upload(repo) };
    }
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertV0Receive(repo) };
  }
  if (service === 'git-upload-pack') {
    if (v2) {
      const { command } = parseV2(body);
      if (command === 'ls-refs') return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerLsRefs(repo, body) };
      if (command === 'fetch') return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerFetchV2(repo, body) };
      return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown v2 command ${command}`, 'utf8') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerFetchV0(repo, body) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: answerReceivePack(repo, body) };
}
