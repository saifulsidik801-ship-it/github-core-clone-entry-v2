// Git objects: content-addressed blobs, trees, commits and tags (SHA-1), plus
// packfile reading and writing with OFS/REF delta resolution. The store keeps
// objects as raw bytes; everything here is pure and deterministic.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { EPOCH, SIGNATURE } from './seed.ts';

export const EMPTY_OID = '0'.repeat(40);

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface Obj {
  kind: ObjKind;
  bytes: Buffer;
}

const KIND_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git object id: SHA-1 over `<kind> <size>\0` + bytes. */
export function oidOf(kind: ObjKind, bytes: Buffer): string {
  const h = createHash('sha1');
  h.update(`${kind} ${bytes.length}\0`, 'utf8');
  h.update(bytes);
  return h.digest('hex');
}

export function looksLikeOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

/** git tree sort: a directory compares as if its name ended in '/'. */
function treeOrder(a: TreeItem, b: TreeItem): number {
  const la = a.mode === '40000' ? `${a.name}/` : a.name;
  const lb = b.mode === '40000' ? `${b.name}/` : b.name;
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/** Serialize tree items (sorted git's way) into a tree object's bytes. */
export function encodeTree(items: readonly TreeItem[]): Buffer {
  const sorted = [...items].sort(treeOrder);
  const chunks: Buffer[] = [];
  for (const it of sorted) {
    chunks.push(Buffer.from(`${it.mode} ${it.name}\0`, 'utf8'));
    chunks.push(Buffer.from(it.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Parse a tree object's bytes into items, in stored order. */
export function decodeTree(bytes: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let at = 0;
  while (at < bytes.length) {
    const sp = bytes.indexOf(0x20, at);
    const nul = bytes.indexOf(0x00, sp + 1);
    items.push({
      mode: bytes.subarray(at, sp).toString('ascii'),
      name: bytes.subarray(sp + 1, nul).toString('utf8'),
      oid: bytes.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return items;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function decodeCommit(bytes: Buffer): CommitInfo {
  const blank = bytes.indexOf('\n\n');
  const headEnd = blank < 0 ? bytes.length : blank;
  const out: CommitInfo = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : bytes.subarray(blank + 2).toString('utf8') };
  for (const line of bytes.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5);
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7));
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

/** Serialize a commit. Timestamps always use the fixed epoch. */
export function encodeCommit(f: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  when?: number;
}): Buffer {
  const when = f.when ?? EPOCH;
  const who = (name?: string): string => `${name ?? SIGNATURE} ${when} +0000`;
  const head = [`tree ${f.tree}`];
  for (const p of f.parents ?? []) head.push(`parent ${p}`);
  head.push(`author ${who(f.author)}`, `committer ${who(f.committer)}`, '');
  return Buffer.from(`${head.join('\n')}\n${f.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  kind: ObjKind;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function decodeTag(bytes: Buffer): TagInfo {
  const blank = bytes.indexOf('\n\n');
  const headEnd = blank < 0 ? bytes.length : blank;
  const got = new Map<string, string>();
  for (const line of bytes.subarray(0, headEnd).toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) got.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: got.get('object') ?? '',
    kind: (got.get('type') ?? 'commit') as ObjKind,
    tag: got.get('tag') ?? '',
    tagger: got.get('tagger') ?? '',
    message: blank < 0 ? '' : bytes.subarray(blank + 2).toString('utf8'),
  };
}

/** Serialize an annotated tag object. */
export function encodeTag(f: { object: string; kind: ObjKind; tag: string; message: string; tagger?: string; when?: number }): Buffer {
  const when = f.when ?? EPOCH;
  return Buffer.from(
    `object ${f.object}\ntype ${f.kind}\ntag ${f.tag}\ntagger ${f.tagger ?? SIGNATURE} ${when} +0000\n\n${f.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- deltas

function readVarint(buf: Buffer, at: number): { value: number; next: number; head: number } {
  let b = buf[at] as number;
  const head = b;
  let value = b & 0x0f;
  let shift = 4;
  let pos = at + 1;
  while (b & 0x80) {
    b = buf[pos++] as number;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { value, next: pos, head };
}

function readOfs(buf: Buffer, at: number): { back: number; next: number } {
  let b = buf[at] as number;
  let pos = at + 1;
  let value = b & 0x7f;
  while (b & 0x80) {
    b = buf[pos++] as number;
    value = (value + 1) * 128 + (b & 0x7f);
  }
  return { back: value, next: pos };
}

/** Apply a git delta stream to a base object's bytes. */
export function expandDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readNum = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[at++] as number;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcLen = readNum();
  const dstLen = readNum();
  if (srcLen !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(dstLen);
  let done = 0;
  while (at < delta.length) {
    const op = delta[at++] as number;
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      let sh = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) off += (delta[at++] as number) * 2 ** sh;
        sh += 8;
      }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) len += (delta[at++] as number) * 2 ** sh;
        sh += 8;
      }
      if (len === 0) len = 0x10000;
      base.copy(out, done, off, off + len);
      done += len;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, done, at, at + n);
      at += n;
      done += n;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (done !== dstLen) throw new Error('delta produced the wrong size');
  return out;
}

// ---------------------------------------------------------------- packfiles

interface RawEntry {
  at: number;
  code: number;
  size: number;
  data: Buffer;
  ofsBase?: number;
  refBase?: string;
  done?: { kind: ObjKind; bytes: Buffer; oid: string };
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries.
 * `outside` supplies a base a thin pack leaves out. Throws on corruption.
 * The trailer checksum is verified here, so callers must not check it twice.
 */
export function readPackfile(pack: Buffer, outside?: (oid: string) => Obj | undefined): Map<string, Obj> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.length - 20;
  if (!createHash('sha1').update(pack.subarray(0, trailer)).digest().equals(pack.subarray(trailer))) {
    throw new Error('pack trailer checksum mismatch');
  }

  const entries: RawEntry[] = [];
  const byAt = new Map<number, RawEntry>();
  let at = 12;
  for (let i = 0; i < count; i++) {
    const start = at;
    const hdr = readVarint(pack, at);
    at = hdr.next;
    const code = (hdr.head >> 4) & 0x07;
    const entry: RawEntry = { at: start, code, size: hdr.value, data: Buffer.alloc(0) };
    if (code === 6) {
      const base = readOfs(pack, at);
      at = base.next;
      entry.ofsBase = start - base.back;
    } else if (code === 7) {
      entry.refBase = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (!CODE_KIND[code]) {
      throw new Error(`pack entry has unknown type code ${code}`);
    }
    // inflateSync with info reports the zlib stream's consumed input length
    // in engine.bytesWritten: that is how one entry's end is found.
    const got = inflateSync(pack.subarray(at, trailer), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (got.buffer.length !== hdr.value) throw new Error('pack entry size mismatch');
    entry.data = got.buffer;
    at += got.engine.bytesWritten;
    entries.push(entry);
    byAt.set(start, entry);
  }
  if (at !== trailer) throw new Error('pack has stray bytes before its trailer');

  const out = new Map<string, Obj>();
  const byOid = new Map<string, RawEntry>();
  const busy = new Set<number>();
  const settle = (e: RawEntry): { kind: ObjKind; bytes: Buffer; oid: string } => {
    if (e.done) return e.done;
    if (busy.has(e.at)) throw new Error('delta cycle in pack');
    busy.add(e.at);
    let kind: ObjKind;
    let bytes: Buffer;
    if (e.code === 6) {
      const baseEntry = byAt.get(e.ofsBase as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = settle(baseEntry);
      kind = base.kind;
      bytes = expandDelta(base.bytes, e.data);
    } else if (e.code === 7) {
      const want = e.refBase as string;
      const inPack = byOid.get(want);
      if (inPack) {
        const base = settle(inPack);
        kind = base.kind;
        bytes = expandDelta(base.bytes, e.data);
      } else {
        const ext = outside?.(want);
        if (!ext) throw new Error(`ref-delta base ${want} is neither in the pack nor on the server`);
        kind = ext.kind;
        bytes = expandDelta(ext.bytes, e.data);
      }
    } else {
      kind = CODE_KIND[e.code] as ObjKind;
      bytes = e.data;
    }
    const oid = oidOf(kind, bytes);
    e.done = { kind, bytes, oid };
    byOid.set(oid, e);
    busy.delete(e.at);
    return e.done;
  };
  for (const e of entries) {
    const r = settle(e);
    if (!out.has(r.oid)) out.set(r.oid, { kind: r.kind, bytes: r.bytes });
  }
  return out;
}

function packHeader(kind: ObjKind, size: number): Buffer {
  const code = KIND_CODE[kind];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over the rest. */
export function writePackfile(objects: readonly Obj[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) {
    parts.push(packHeader(o.kind, o.bytes.length));
    parts.push(deflateSync(o.bytes));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
