// The vault: one process, one in-memory model. Repositories own their git
// objects (content-addressed, SHA-1), refs, issues, comments and pull
// requests. Nothing here reads a clock or a random source: every timestamp is
// a fixed constant, every id a sequence, so two runs that receive the same
// requests reach byte-identical state.
//
// Layout differs from a plain array store on purpose: issues and pulls live
// in Maps keyed by number (O(1) lookup for the read path) with a separate
// creation-order list, and every graph walk uses an index pointer instead of
// shift(), so long histories stay linear.

import { decodeCommit, decodeTag, decodeTree, encodeCommit, encodeTree, looksLikeOid, oidOf, type Obj, type ObjKind, type TreeItem } from './objects.ts';
import { ISO_NOW, MAIN_BRANCH } from './seed.ts';

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  /** Cached rendered REST body; cleared by any mutation touching the issue. */
  cached: string | null;
  /** UTF-8 bytes of `cached`; cleared with it, so hot reads send bytes directly. */
  cachedBuf: Buffer | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** Bumped on every ref write; caches keyed on ref state read this. */
  rev: number;
  refs: Map<string, string>;
  objects: Map<string, Obj>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  issueOrder: number[];
  issueSeq: number;
  comments: Map<number, CommentRec[]>;
  commentSeq: number;
  pulls: Map<number, PullRec>;
  pullOrder: number[];
  pullSeq: number;
}

export interface Vault {
  viewer: string;
  repos: Map<string, RepoRec>;
  nextId: () => number;
  nextRepoId: () => number;
  nextCreatedSeq: () => number;
}

/** Create an empty vault for the viewer login. */
export function createVault(viewerLogin: string): Vault {
  let globalId = 1;
  let repoId = 1;
  let createdSeq = 1;
  return {
    viewer: viewerLogin,
    repos: new Map(),
    nextId: () => globalId++,
    nextRepoId: () => repoId++,
    nextCreatedSeq: () => createdSeq++,
  };
}

export function newRepo(vault: Vault, name: string, description: string, isPrivate: boolean): RepoRec | null {
  if (vault.repos.has(name)) return null;
  const repo: RepoRec = {
    id: vault.nextRepoId(),
    name,
    owner: vault.viewer,
    description,
    isPrivate,
    defaultBranch: MAIN_BRANCH,
    createdSeq: vault.nextCreatedSeq(),
    rev: 0,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    issueOrder: [],
    issueSeq: 1,
    comments: new Map(),
    commentSeq: 1,
    pulls: new Map(),
    pullOrder: [],
    pullSeq: 1,
  };
  vault.repos.set(name, repo);
  return repo;
}

export function repoNamed(vault: Vault, name: string): RepoRec | undefined {
  return vault.repos.get(name);
}

export function dropRepo(vault: Vault, name: string): boolean {
  return vault.repos.delete(name);
}

export function reposSorted(vault: Vault): RepoRec[] {
  return [...vault.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
}

/** Store an object unless present; returns its oid. */
export function storeObj(repo: RepoRec, kind: ObjKind, bytes: Buffer): string {
  const oid = oidOf(kind, bytes);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, bytes });
  return oid;
}

/** Write a ref and bump the repo's ref revision (invalidates ref caches). */
export function setRef(repo: RepoRec, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  repo.rev++;
}

/** Delete a ref and bump the repo's ref revision. */
export function delRef(repo: RepoRec, ref: string): void {
  repo.refs.delete(ref);
  repo.rev++;
}

// ---------------------------------------------------------------- graph walks

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function reachableObjs(repo: RepoRec, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) if (looksLikeOid(r)) stack.push(r);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    seen.add(oid);
    if (o.kind === 'commit') {
      const c = decodeCommit(o.bytes);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (o.kind === 'tag') {
      stack.push(decodeTag(o.bytes).object);
    } else if (o.kind === 'tree') {
      for (const e of decodeTree(o.bytes)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return seen;
}

/** True when `anc` is reachable from `desc` (or equal to it). */
export function isAncestorOf(repo: RepoRec, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = repo.objects.get(oid);
    if (!o) continue;
    if (o.kind === 'commit') {
      for (const p of decodeCommit(o.bytes).parents) stack.push(p);
    } else if (o.kind === 'tag') {
      stack.push(decodeTag(o.bytes).object);
    }
  }
  return false;
}

/** Nearest common ancestor of two commits (first hit from a BFS out of `b`). */
export function commonBase(repo: RepoRec, a: string, b: string): string | null {
  const inA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (inA.has(oid)) continue;
    inA.add(oid);
    const o = repo.objects.get(oid);
    if (o?.kind === 'commit') {
      for (const p of decodeCommit(o.bytes).parents) stackA.push(p);
    }
  }
  const queue = [b];
  const seenB = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const oid = queue[head] as string;
    if (inA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const o = repo.objects.get(oid);
    if (o?.kind === 'commit') {
      for (const p of decodeCommit(o.bytes).parents) queue.push(p);
    }
  }
  return null;
}

// ---------------------------------------------------------------- trees

export interface FileRef {
  oid: string;
  mode: string;
}

/** Flattened file map of a commit: path -> {oid, mode}. */
export function filesAt(repo: RepoRec, commitOid: string): Map<string, FileRef> {
  const out = new Map<string, FileRef>();
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.kind !== 'commit') return out;
  const root = decodeCommit(commit.bytes).tree;
  const stack: Array<{ tree: string; prefix: string }> = [{ tree: root, prefix: '' }];
  while (stack.length > 0) {
    const { tree, prefix } = stack.pop() as { tree: string; prefix: string };
    const t = repo.objects.get(tree);
    if (!t || t.kind !== 'tree') continue;
    for (const e of decodeTree(t.bytes)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') stack.push({ tree: e.oid, prefix: path });
      else if (e.mode !== '160000') out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

/** Build a tree object (and its subtrees) from a flattened file map. */
export function treeFromFiles(repo: RepoRec, files: Map<string, FileRef>): string {
  interface Node {
    files: Map<string, FileRef>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, f] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] as string;
      let child = node.dirs.get(seg);
      if (!child) {
        child = makeNode();
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, f);
  }
  const build = (node: Node): string => {
    const items: TreeItem[] = [];
    for (const [name, f] of node.files) items.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) items.push({ mode: '40000', name, oid: build(child) });
    return storeObj(repo, 'tree', encodeTree(items));
  };
  return build(root);
}

/** Blob bytes at a commit's path, or null. */
export function blobAt(repo: RepoRec, commitOid: string, path: string): Buffer | null {
  const entry = filesAt(repo, commitOid).get(path);
  if (!entry) return null;
  const blob = repo.objects.get(entry.oid);
  return blob && blob.kind === 'blob' ? blob.bytes : null;
}

// ---------------------------------------------------------------- diffs

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** Line diff counts via LCS (files here are small). */
function diffCounts(oldText: string, newText: string): { add: number; del: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  if (n === 0) return { add: m, del: 0 };
  if (m === 0) return { add: 0, del: n };
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[m] as number;
  return { add: m - lcs, del: n - lcs };
}

export interface Change {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two flattened file maps into per-file changes with line counts. */
export function diffMaps(repo: RepoRec, base: Map<string, FileRef>, head: Map<string, FileRef>): Change[] {
  const out: Change[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = repo.objects.get(b.oid)?.bytes.toString('utf8') ?? '';
      const deletions = countLines(oldText);
      out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const newText = repo.objects.get(h.oid)?.bytes.toString('utf8') ?? '';
      const additions = countLines(newText);
      out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.bytes.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.bytes.toString('utf8') ?? '';
      const { add, del } = diffCounts(oldText, newText);
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions: add, deletions: del, changes: add + del });
    }
  }
  return out;
}

// ---------------------------------------------------------------- merge

/** Three-way merge check: a path changed on both sides with different results is a conflict. */
export function hasConflict(repo: RepoRec, headTip: string, baseTip: string): boolean {
  const base = commonBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseFiles = filesAt(repo, base);
  const headFiles = filesAt(repo, headTip);
  const tipFiles = filesAt(repo, baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const t = tipFiles.get(path)?.oid ?? null;
    if (h !== b && t !== b && h !== t) return true;
  }
  return false;
}

export function mergeableState(repo: RepoRec, headTip: string, baseTip: string): 'MERGEABLE' | 'CONFLICTING' {
  return hasConflict(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge a pull request onto its base branch: the merged tree is the
 * base tip's files with the head's changes (against the merge base) applied,
 * committed as one commit on top of the base tip.
 */
export function squashMerge(repo: RepoRec, pull: PullRec): { ok: true; sha: string } | { ok: false; why: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return { ok: false, why: 'base branch does not exist' };
  if (hasConflict(repo, pull.headSha, baseTip)) return { ok: false, why: 'Merge conflict' };
  const base = commonBase(repo, pull.headSha, baseTip);
  const baseFiles = base ? filesAt(repo, base) : new Map<string, FileRef>();
  const headFiles = filesAt(repo, pull.headSha);
  const tipFiles = filesAt(repo, baseTip);
  const merged = new Map(tipFiles);
  for (const [path, f] of headFiles) {
    const inBase = baseFiles.get(path);
    if (!inBase || inBase.oid !== f.oid) merged.set(path, f);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) merged.delete(path);
  }
  const treeOid = treeFromFiles(repo, merged);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const sha = storeObj(repo, 'commit', encodeCommit({ tree: treeOid, parents: [baseTip], message }));
  setRef(repo, `refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ISO_NOW;
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return { ok: true, sha };
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  objects: Obj[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects the client already holds, given its haves and shallow boundary:
 * walk from the haves, never past a shallow commit's parents.
 */
export function heldObjs(repo: RepoRec, haves: readonly string[], oldShallow: readonly string[]): Set<string> {
  const shallowSet = new Set(oldShallow);
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    held.add(oid);
    if (o.kind === 'commit') {
      const c = decodeCommit(o.bytes);
      stack.push(c.tree);
      if (!shallowSet.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (o.kind === 'tag') {
      stack.push(decodeTag(o.bytes).object);
    } else if (o.kind === 'tree') {
      for (const e of decodeTree(o.bytes)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return held;
}

/**
 * Plan a fetch: which objects to send, and the shallow boundary.
 * Depth d includes commits at distance 0..d-1 from the wants; the boundary
 * commits (distance d-1) are the new shallow list.
 */
export function fetchPlan(repo: RepoRec, wants: readonly string[], haves: readonly string[], oldShallow: readonly string[], depth?: number): FetchPlan {
  const haveObjs = heldObjs(repo, haves, oldShallow);
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const o = repo.objects.get(want);
    if (!o) continue;
    if (o.kind === 'tag') {
      included.add(want);
      queue.push({ oid: decodeTag(o.bytes).object, dist: 0 });
    } else {
      queue.push({ oid: want, dist: 0 });
    }
  }
  const seenCommit = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const { oid, dist } = queue[head] as { oid: string; dist: number };
    if (seenCommit.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    if (o.kind === 'tag') {
      included.add(oid);
      queue.push({ oid: decodeTag(o.bytes).object, dist });
      continue;
    }
    if (o.kind !== 'commit') continue;
    seenCommit.add(oid);
    if (depth !== undefined && dist >= depth) continue;
    included.add(oid);
    if (depth !== undefined && dist === depth - 1) boundary.add(oid);
    for (const p of decodeCommit(o.bytes).parents) queue.push({ oid: p, dist: dist + 1 });
  }
  const wanted = new Set<string>();
  const stack = [...included];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (wanted.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    wanted.add(oid);
    if (o.kind === 'commit') {
      stack.push(decodeCommit(o.bytes).tree);
    } else if (o.kind === 'tag') {
      stack.push(decodeTag(o.bytes).object);
    } else if (o.kind === 'tree') {
      for (const e of decodeTree(o.bytes)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  const objects: Obj[] = [];
  for (const oid of [...wanted].sort()) {
    if (haveObjs.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (o) objects.push(o);
  }
  return {
    objects,
    shallow: [...boundary].sort(),
    unshallow: oldShallow.filter((oid) => included.has(oid) && !boundary.has(oid)).sort(),
  };
}

// ---------------------------------------------------------------- issue / pull records

/** Create an issue record (clears nothing else; number/seq follow v1's quirk: seq = number + 1). */
export function createIssueRec(vault: Vault, repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const number = repo.issueSeq++;
  const rec: IssueRec = { id: vault.nextId(), number, title, body, state: 'open', labels, seq: repo.issueSeq, cached: null, cachedBuf: null };
  repo.issues.set(number, rec);
  repo.issueOrder.push(number);
  repo.comments.set(number, []);
  return rec;
}

/** Create a pull request record. */
export function createPullRec(vault: Vault, repo: RepoRec, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRec {
  const number = repo.pullSeq++;
  const rec: PullRec = {
    id: vault.nextId(),
    number,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: repo.pullSeq,
  };
  repo.pulls.set(number, rec);
  repo.pullOrder.push(number);
  return rec;
}

/** Drop the cached REST body of an issue (call after any mutation touching it). */
export function clearIssueCache(issue: IssueRec): void {
  issue.cached = null;
  issue.cachedBuf = null;
}

/** Append a comment record. */
export function addCommentRec(repo: RepoRec, number: number, body: string): CommentRec {
  const comment: CommentRec = { id: repo.commentSeq++, body, seq: repo.commentSeq };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  const issue = repo.issues.get(number);
  if (issue) clearIssueCache(issue);
  return comment;
}

/** Resolve a ref name (branch, tag, full ref, HEAD, or oid) to a commit oid. */
export function refToCommit(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return tag;
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
  return null;
}

/** Commits reachable from a tip, newest first (depth-first pre-order). */
export function commitsFromTip(repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = repo.objects.get(oid);
    if (!o || o.kind !== 'commit') continue;
    out.push(oid);
    const parents = decodeCommit(o.bytes).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i] as string);
  }
  return out;
}

/** The tree oid at a directory path inside a commit, or null. */
export function treeAtPath(repo: RepoRec, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.kind !== 'commit') return null;
  let treeOid = decodeCommit(commit.bytes).tree;
  if (path === '' || path === '/') return treeOid;
  for (const seg of path.split('/').filter((p) => p !== '')) {
    const t = repo.objects.get(treeOid);
    if (!t || t.kind !== 'tree') return null;
    const entry = decodeTree(t.bytes).find((it) => it.name === seg && it.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}
