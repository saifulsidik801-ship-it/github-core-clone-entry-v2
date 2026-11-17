// gitface.ts — git smart HTTP: info/refs (v2 + v0), ls-refs, fetch (v2 + v0)
// and receive-pack (v0). All packs are plain objects; the suite's client only
// ever sends plain packs, and plain packs are all we ever send.

import {
  pktLine,
  pktLines,
  decodePktLines,
  demuxSideband,
  readPack,
  writePack,
  collectReachable,
  parseCommit,
  parseTag,
  parseTree,
  isObjectId,
  ZERO_OID,
  PKT_FLUSH,
  PKT_DELIM,
  type GitObject,
} from './gitproto.ts';
import {
  fastForwardOk,
  type Repo,
  type Store,
} from './store.ts';
import {
  decodeSegment,
  header,
  params,
  readBody,
  sendError,
  sendJson,
  sendRaw,
  type Ctx,
} from './server.ts';

// ---------------------------------------------------------------- advertisements

const V2_CAPS = ['version 2', 'agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const V0_UP_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main';
const V0_RECV_CAPS = 'report-status side-band-64k delete-refs ofs-delta thin-pack symref=HEAD:refs/heads/main';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function refLinesV0(store: Store, repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const names = sortedRefNames(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (names.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  // HEAD first, caps on its line.
  lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
  for (const name of names) {
    if (name === `refs/heads/${repo.defaultBranch}`) {
      // HEAD already names it; git still lists the branch line too.
      lines.push(`${repo.refs.get(name)} ${name}\n`);
      continue;
    }
    lines.push(`${repo.refs.get(name)} ${name}\n`);
    // Peeled line for annotated tags.
    if (name.startsWith('refs/tags/')) {
      const obj = store.objects.get(repo.refs.get(name)!);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        lines.push(`${target} ${name}^{}\n`);
      }
    }
  }
  return lines;
}

function buildV2Advertisement(): Buffer {
  return pktLines(['# service=git-upload-pack\n', 'flush', ...V2_CAPS, 'flush']);
}

function buildV0Advertisement(store: Store, repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = service === 'upload' ? V0_UP_CAPS : V0_RECV_CAPS;
  const svc = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pktLine(`# service=${svc}\n`), PKT_FLUSH];
  for (const line of refLinesV0(store, repo, caps)) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function getAdvertisement(store: Store, repo: Repo, service: 'upload' | 'receive', v2: boolean): Buffer {
  if (service === 'upload' && v2) {
    if (repo.advV2 === null || repo.advV2Rev !== repo.rev) {
      repo.advV2 = buildV2Advertisement();
      repo.advV2Rev = repo.rev;
    }
    return repo.advV2;
  }
  if (service === 'upload') {
    if (repo.advV0Up === null || repo.advV0UpRev !== repo.rev) {
      repo.advV0Up = buildV0Advertisement(store, repo, 'upload');
      repo.advV0UpRev = repo.rev;
    }
    return repo.advV0Up;
  }
  if (repo.advV0Recv === null || repo.advV0RecvRev !== repo.rev) {
    repo.advV0Recv = buildV0Advertisement(store, repo, 'receive');
    repo.advV0RecvRev = repo.rev;
  }
  return repo.advV0Recv;
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  refPrefix: string | null;
}

function parseLsRefsBody(body: Buffer): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, refPrefix: null };
  const { packets } = decodePktLines(body);
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.refPrefix = line.slice('ref-prefix '.length);
  }
  return args;
}

function buildLsRefs(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const key = `${args.peel ? 'p' : ''}${args.symrefs ? 's' : ''}${args.unborn ? 'u' : ''}|${args.refPrefix ?? ''}`;
  if (repo.lsRefsRev === repo.rev) {
    const cached = repo.lsRefsCache.get(key);
    if (cached) return cached;
  } else {
    repo.lsRefsCache.clear();
    repo.lsRefsRev = repo.rev;
  }
  const lines: string[] = [];
  const names = sortedRefNames(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headWanted = args.refPrefix === null || 'HEAD'.startsWith(args.refPrefix);
  if (names.length === 0) {
    if (args.unborn && headWanted) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    if (headWanted && headTip) {
      lines.push(args.symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`);
    }
    for (const name of names) {
      if (args.refPrefix !== null && !name.startsWith(args.refPrefix)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      if (args.peel && name.startsWith('refs/tags/')) {
        const obj = store.objects.get(oid);
        if (obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
      }
      lines.push(`${line}\n`);
    }
  }
  const buf = pktLines([...lines, 'flush']);
  repo.lsRefsCache.set(key, buf);
  return buf;
}

// ---------------------------------------------------------------- repo resolution

function resolveGitRepo(ctx: Ctx): Repo | null {
  const [ownerRaw, repoRaw] = params(ctx);
  const owner = decodeSegment(ownerRaw ?? '');
  const name = decodeSegment((repoRaw ?? '').replace(/\.git$/, ''));
  if (owner === '' || name === '') return null;
  const repo = ctx.store.findRepo(owner, name);
  if (repo) ctx.store.learnViewer(owner);
  return repo;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export async function handleInfoRefs(ctx: Ctx): Promise<void> {
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 400, 'unknown service');
    return;
  }
  const repo = resolveGitRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const v2 = (header(ctx, 'git-protocol') ?? '').includes('version=2');
  const adv = getAdvertisement(ctx.store, repo, service === 'git-upload-pack' ? 'upload' : 'receive', v2);
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  sendRaw(ctx, 200, contentType, adv);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
}

function parseFetchV2(body: Buffer): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null };
  const { packets } = decodePktLines(body);
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = Number(line.slice(7).trim());
  }
  return req;
}

function parseFetchV0(body: Buffer): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null };
  const { packets } = decodePktLines(body);
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').trim();
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = Number(line.slice(7).trim());
  }
  return req;
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch must deliver, and the shallow boundary it reports. */
function planFetch(store: Store, repo: Repo, req: FetchRequest): FetchPlan {
  const lookup = store.lookup;
  // Resolve wants: tag wants contribute their target commit as a root.
  const roots: string[] = [];
  const tagObjects: string[] = [];
  for (const want of req.wants) {
    const obj = lookup(want);
    if (!obj) throw new Error(`want ${want} is not in the store`);
    if (obj.type === 'tag') {
      tagObjects.push(want);
      roots.push(parseTag(obj.data).object);
    } else if (obj.type === 'commit') {
      roots.push(want);
    }
  }
  const shallowSet = new Set(req.shallows);
  // What the client already has: the closure of its haves, except that a
  // shallow commit's parents are NOT in its possession (a shallow clone holds
  // the boundary commit but none of its history).
  const haveSet = new Set<string>();
  for (const h of req.haves) {
    try {
      for (const oid of collectReachable([h], lookup)) haveSet.add(oid);
    } catch {
      // A have the server does not know: ignore it (the client still expects NAK).
    }
  }
  const shallowCut = new Set<string>();
  for (const s of req.shallows) {
    const obj = lookup(s);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) {
        try {
          for (const oid of collectReachable([p], lookup)) shallowCut.add(oid);
        } catch {
          // Unknown parent: nothing to cut.
        }
      }
    }
  }
  const possessed = (oid: string): boolean => haveSet.has(oid) && !shallowCut.has(oid);
  // Included commits: BFS from roots, bounded by depth, minus the haves closure.
  // Traversal continues through shallow haves (their parents are not had) but
  // stops at a fully-possessed commit (everything below it is had).
  const depth = req.deepen === null ? Infinity : req.deepen;
  const included = new Map<string, number>(); // oid -> generations from a want
  const queue: Array<[string, number]> = roots.map((r) => [r, 0] as [string, number]);
  const seenGen = new Map<string, number>();
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (seenGen.has(oid) && seenGen.get(oid)! <= gen) continue;
    seenGen.set(oid, gen);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (possessed(oid) && !shallowSet.has(oid)) continue;
    if (!possessed(oid)) included.set(oid, gen);
    if (gen + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
    }
  }
  // Shallow: included commits whose parents were not included because of depth.
  const shallow: string[] = [];
  if (req.deepen !== null) {
    for (const [oid, gen] of included) {
      if (gen + 1 >= depth) shallow.push(oid);
    }
  }
  // Unshallow: a client-shallow commit whose parents are now all included.
  const unshallow: string[] = [];
  for (const s of req.shallows) {
    const obj = lookup(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0 || parents.every((p) => included.has(p))) unshallow.push(s);
  }
  // Objects: tag objects + each included commit and its tree closure, minus haves.
  const objectOids = new Set<string>(tagObjects);
  for (const oid of included.keys()) {
    objectOids.add(oid);
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') {
      const tree = parseCommit(obj.data).tree;
      const queue = [tree];
      while (queue.length) {
        const t = queue.pop()!;
        if (objectOids.has(t)) continue;
        const tobj = lookup(t);
        if (!tobj) continue;
        objectOids.add(t);
        if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) queue.push(e.oid);
      }
    }
  }
  for (const h of haveSet) {
    // Only delete objects the client actually holds: a shallow commit's
    // ancestors are in its closure but were never delivered to it.
    if (!shallowCut.has(h)) objectOids.delete(h);
  }
  const objects = [...objectOids]
    .map((oid) => ({ oid, obj: lookup(oid)! }))
    .filter((e) => e.obj !== undefined)
    .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0))
    .map((e) => e.obj);
  return { pack: writePack(objects), shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const framed = Buffer.allocUnsafe(1 + slice.length);
    framed[0] = 1;
    slice.copy(framed, 1);
    out.push(pktLine(framed));
  }
  return out;
}

function buildFetchV2Response(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const cacheKey = `${req.wants.join(',')}|${req.haves.join(',')}|${req.shallows.join(',')}|${req.deepen ?? ''}`;
  if (repo.packRev === repo.rev) {
    const cached = repo.packCache.get(cacheKey);
    if (cached) return cached;
  } else {
    repo.packCache.clear();
    repo.packRev = repo.rev;
  }
  const plan = planFetch(store, repo, req);
  const parts: Buffer[] = [];
  const allHavesKnown = req.haves.length > 0 && req.haves.every((h) => store.objects.has(h));
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine(allHavesKnown ? `ACK ${req.haves[0]}\n` : 'NAK\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  const buf = Buffer.concat(parts);
  repo.packCache.set(cacheKey, buf);
  return buf;
}

function buildFetchV0Response(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(store, repo, req);
  const parts: Buffer[] = [];
  const allHavesKnown = req.haves.length > 0 && req.haves.every((h) => store.objects.has(h));
  parts.push(pktLine(allHavesKnown ? `ACK ${req.haves[0]}\n` : 'NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack (v2 command or v0 fetch). */
export async function handleUploadPack(ctx: Ctx): Promise<void> {
  const repo = resolveGitRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const body = await readBody(ctx);
  const v2 = (header(ctx, 'git-protocol') ?? '').includes('version=2');
  try {
    if (v2) {
      const text = body.toString('utf8');
      if (text.includes('command=ls-refs')) {
        const buf = buildLsRefs(ctx.store, repo, parseLsRefsBody(body));
        sendRaw(ctx, 200, 'application/x-git-upload-pack-result', buf);
        return;
      }
      if (!text.includes('command=fetch')) {
        sendError(ctx, 400, 'unknown git v2 command');
        return;
      }
      const buf = buildFetchV2Response(ctx.store, repo, parseFetchV2(body));
      sendRaw(ctx, 200, 'application/x-git-upload-pack-result', buf);
      return;
    }
    const buf = buildFetchV0Response(ctx.store, repo, parseFetchV0(body));
    sendRaw(ctx, 200, 'application/x-git-upload-pack-result', buf);
  } catch (err) {
    sendError(ctx, 400, err instanceof Error ? err.message : 'bad fetch request');
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').trim();
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error('malformed push command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      throw new Error('malformed push command');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('no push commands');
  return { commands, pack: rest };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export async function handleReceivePack(ctx: Ctx): Promise<void> {
  const repo = resolveGitRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const body = await readBody(ctx);
  let parsed: { commands: PushCommand[]; pack: Buffer };
  try {
    parsed = parseReceivePack(body);
  } catch (err) {
    sendError(ctx, 400, err instanceof Error ? err.message : 'malformed push');
    return;
  }
  if (parsed.pack.length > 0) {
    try {
      const { objects } = readPack(parsed.pack, ctx.store.lookup);
      for (const [oid, obj] of objects) ctx.store.putObjectWithId(oid, obj);
    } catch (err) {
      sendError(ctx, 400, err instanceof Error ? err.message : 'malformed pack');
      return;
    }
  }
  const lines: string[] = ['unpack ok'];
  let changed = false;
  for (const cmd of parsed.commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = false;
    let reason = '';
    if (cmd.newOid === ZERO_OID) {
      if (current !== undefined) {
        repo.refs.delete(cmd.ref);
        ok = true;
      } else {
        reason = 'remote ref does not exist';
      }
    } else if (cmd.oldOid === ZERO_OID) {
      if (current === undefined) {
        repo.refs.set(cmd.ref, cmd.newOid);
        ok = true;
      } else {
        reason = 'remote ref already exists';
      }
    } else if (current === undefined) {
      reason = 'remote ref does not exist';
    } else if (current !== cmd.oldOid) {
      reason = 'non-fast-forward';
    } else if (!fastForwardOk(ctx.store, cmd.oldOid, cmd.newOid)) {
      reason = 'non-fast-forward';
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      ok = true;
    }
    if (ok) {
      changed = true;
      lines.push(`ok ${cmd.ref}`);
    } else {
      lines.push(`ng ${cmd.ref} ${reason || 'non-fast-forward'}`);
    }
  }
  if (changed) {
    repo.rev += 1;
    repo.repoJsonBuf = null;
  }
  const parts: Buffer[] = [];
  for (const line of lines) {
    const framed = Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')]);
    parts.push(pktLine(framed));
  }
  parts.push(PKT_FLUSH);
  sendRaw(ctx, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
