// store.ts — the forge's whole in-memory model: objects, repos, issues, pulls,
// labels, comments, the deterministic clock, and the response caches that make
// the hot paths fast. No I/O, no wall clock: every timestamp comes from the
// seeded counter, so a replayed trial leaves byte-identical state.

import {
  ZERO_OID,
  hashObject,
  parseTree,
  buildTree,
  parseCommit,
  buildCommit,
  collectReachable,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';

export type { GitObject, GitObjectType, TreeEntry };

// ---------------------------------------------------------------- clock

const EPOCH_DEFAULT = 1735689600; // 2025-01-01T00:00:00Z

function seedEpoch(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return EPOCH_DEFAULT;
}

/** Deterministic clock: every stamp the server emits comes from this counter. */
export class Clock {
  private sec: number;
  constructor() {
    this.sec = seedEpoch();
  }
  /** The next second, as a Unix timestamp. */
  next(): number {
    const v = this.sec;
    this.sec += 1;
    return v;
  }
  iso(): string {
    return new Date(this.next() * 1000).toISOString();
  }
  isoAt(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }
}

// ---------------------------------------------------------------- global ids (opaque, stable)

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return b64url(`Repository:${owner}/${name}`);
}
export function issueGlobalId(owner: string, repo: string, number: number): string {
  return b64url(`Issue:${owner}/${repo}:${number}`);
}
export function pullGlobalId(owner: string, repo: string, number: number): string {
  return b64url(`PullRequest:${owner}/${repo}:${number}`);
}
export function commentGlobalId(owner: string, repo: string, issueNumber: number, id: number): string {
  return b64url(`IssueComment:${owner}/${repo}:${issueNumber}:${id}`);
}

export interface DecodedId {
  kind: string;
  owner: string;
  repo: string;
  number: number;
  extra: number;
}

export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const m = /^(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^:]+)(?::(\d+))?(?::(\d+))?$/.exec(text);
    if (!m) return null;
    return {
      kind: m[1]!,
      owner: m[2]!,
      repo: m[3]!,
      number: m[4] !== undefined ? Number(m[4]) : 0,
      extra: m[5] !== undefined ? Number(m[5]) : 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- model

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  seq: number;
  /** Precomputed GET-one response bytes (the read workload hammers this). */
  jsonBuf: Buffer | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
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
  createdAt: string;
  updatedAt: string;
  seq: number;
  files: PullFile[];
  /** The tree the head had at creation, and the base tree at creation (merge base). */
  headTreeAtCreate: string;
  baseTreeAtCreate: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // bound on first owner-bearing access (the viewer)
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  /** Bump on any ref/object change: invalidates the git caches. */
  rev: number;
  advV2: Buffer | null;
  advV2Rev: number;
  advV0Up: Buffer | null;
  advV0UpRev: number;
  advV0Recv: Buffer | null;
  advV0RecvRev: number;
  lsRefsCache: Map<string, Buffer>;
  lsRefsRev: number;
  packCache: Map<string, Buffer>;
  packRev: number;
  repoJsonBuf: Buffer | null;
}

export class Store {
  readonly clock = new Clock();
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>(); // key: lower(name) — one namespace per trial
  /** Commit oid -> parent oids, parsed once at store time (the fast-forward walk reads this). */
  readonly commitParents = new Map<string, string[]>();
  viewer: string | null = null;
  private repoSeq = 5000;
  private globalSeq = 100000;
  private labelSeq = 1;

  nextIssueId(): number {
    return this.globalSeq++;
  }
  nextPullId(): number {
    return this.globalSeq++;
  }
  nextLabelId(): number {
    return this.labelSeq++;
  }
  /** Set from the Authorization token when it looks like it names the viewer. */
  tokenHint: string | null = null;

  // ------------------------------------------------------------ viewer learning
  /** The login the token names, once any owner-bearing access has named it. */
  learnViewer(login: string): void {
    if (login !== '' && this.viewer === null) this.viewer = login;
  }

  /** Bind a repo's owner on first access; returns false when the owner mismatches. */
  bindOwner(repo: Repo, owner: string): boolean {
    if (repo.owner === null) {
      repo.owner = owner;
      this.learnViewer(owner);
      return true;
    }
    return repo.owner === owner;
  }

  /** Find a repo by owner+name, honouring the viewer binding. Null when absent or foreign. */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name.toLowerCase());
    if (!repo) return null;
    if (repo.owner === null) {
      // First owner-bearing access to this repo binds it.
      repo.owner = owner;
      this.learnViewer(owner);
      return repo;
    }
    return repo.owner === owner ? repo : null;
  }

  /** Find a repo by name alone (creation-time lookups, MCP tools that pass owner separately). */
  findRepoByName(name: string): Repo | null {
    return this.repos.get(name.toLowerCase()) ?? null;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const now = this.clock.iso();
    const repo: Repo = {
      id: this.repoSeq++,
      name,
      owner: this.viewer,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      rev: 0,
      advV2: null,
      advV2Rev: -1,
      advV0Up: null,
      advV0UpRev: -1,
      advV0Recv: null,
      advV0RecvRev: -1,
      lsRefsCache: new Map(),
      lsRefsRev: -1,
      packCache: new Map(),
      packRev: -1,
      repoJsonBuf: null,
    };
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name.toLowerCase());
  }

  // ------------------------------------------------------------ objects
  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      if (type === 'commit') this.commitParents.set(oid, parseCommit(data).parents);
    }
    return oid;
  }

  /** Store an object whose id is already known (pack ingestion); indexes commit parents. */
  putObjectWithId(oid: string, obj: GitObject): void {
    if (this.objects.has(oid)) return;
    this.objects.set(oid, obj);
    if (obj.type === 'commit') this.commitParents.set(oid, parseCommit(obj.data).parents);
  }

  putBlob(data: Buffer): string {
    return this.putObject('blob', data);
  }

  /** A commit object; message gets git's trailing newline when it lacks one. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const ts = this.clock.next();
    const who = `Forge <forge@example.invalid>`;
    const data = buildCommit({ tree, parents, message: msg, author: who, committer: who, timestamp: ts });
    return this.putObject('commit', data);
  }

  // ------------------------------------------------------------ trees
  /** The tree with `segments` set to `blobOid` (or removed when null). */
  editTree(rootOid: string | null, segments: readonly string[], blobOid: string | null, mode = '100644'): string {
    if (segments.length === 0) throw new Error('empty tree path');
    const head = segments[0]!;
    const rest = segments.slice(1);
    const entries: TreeEntry[] = rootOid ? parseTree(this.objects.get(rootOid)?.data ?? Buffer.alloc(0)) : [];
    const kept = entries.filter((e) => e.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid });
    } else {
      const existing = entries.find((e) => e.name === head && e.mode === '40000');
      const childOid = existing ? this.editTree(existing.oid, rest, blobOid, mode) : this.editTree(null, rest, blobOid, mode);
      const child = this.objects.get(childOid);
      // Prune a subtree that became empty.
      if (child && parseTree(child.data).length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
    }
    return this.putObject('tree', buildTree(kept));
  }

  /** path -> {oid, mode} for every blob under a tree (recursive). */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Blob oid at `path` under a tree, or null. */
  treeBlobAt(treeOid: string, path: string): string | null {
    const segments = path.split('/');
    let oid: string | null = treeOid;
    for (let i = 0; i < segments.length; i++) {
      if (oid === null) return null;
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      oid = entry.oid;
    }
    return null;
  }

  /** Lines of a blob, for diff counts. */
  blobLines(oid: string): string[] {
    const obj = this.objects.get(oid);
    if (!obj) return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Line-diff counts between two blobs (multiset difference). */
  lineDiff(oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const oldLines = oldOid ? this.blobLines(oldOid) : [];
    const newLines = newOid ? this.blobLines(newOid) : [];
    const oldCount = new Map<string, number>();
    for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) {
      const c = oldCount.get(l) ?? 0;
      if (c > 0) oldCount.set(l, c - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const c of oldCount.values()) deletions += c;
    return { additions, deletions };
  }

  /** The changed files between two trees. */
  diffTrees(oldTree: string | null, newTree: string | null): PullFile[] {
    const oldMap = oldTree ? this.flattenTree(oldTree) : new Map();
    const newMap = newTree ? this.flattenTree(newTree) : new Map();
    const files: PullFile[] = [];
    const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const path of [...paths].sort()) {
      const o = oldMap.get(path);
      const n = newMap.get(path);
      if (o && !n) {
        const d = this.lineDiff(o.oid, null);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions });
      } else if (!o && n) {
        const d = this.lineDiff(null, n.oid);
        files.push({ filename: path, status: 'added', additions: d.additions, deletions: 0, changes: d.additions });
      } else if (o && n && o.oid !== n.oid) {
        const d = this.lineDiff(o.oid, n.oid);
        files.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
      }
    }
    return files;
  }
}

// ---------------------------------------------------------------- JSON views

/** The GitHub repository object (a superset of what the suite reads). */
export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `https://example.invalid/${owner}/${repo.name}.git`,
  };
}

export function repoJsonBuf(store: Store, repo: Repo): Buffer {
  if (repo.repoJsonBuf) return repo.repoJsonBuf;
  const buf = Buffer.from(`${JSON.stringify(repoJson(store, repo))}\n`, 'utf8');
  repo.repoJsonBuf = buf;
  return buf;
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: owner, id: repo.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

/** The cached GET-one bytes for an issue; rebuilt on any change to it. */
export function issueJsonBuf(store: Store, repo: Repo, issue: Issue): Buffer {
  if (issue.jsonBuf) return issue.jsonBuf;
  const buf = Buffer.from(`${JSON.stringify(issueJson(store, repo, issue))}\n`, 'utf8');
  issue.jsonBuf = buf;
  return buf;
}

export function commentJson(store: Store, repo: Repo, issueNumber: number, c: Comment): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: c.id,
    body: c.body,
    user: { login: owner, id: repo.id, type: 'User' },
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issueNumber}#issuecomment-${c.id}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issueNumber}/comments/${c.id}`,
  };
}

export function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${owner}:${pr.headRef}`, repo: { name: repo.name, full_name: `${owner}/${repo.name}` } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${owner}:${pr.baseRef}`, repo: { name: repo.name, full_name: `${owner}/${repo.name}` } },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.merged ? true : !prHasConflict(store, repo, pr),
    user: { login: owner, id: repo.id, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`,
  };
}

export function commitJson(store: Store, commitOid: string): Record<string, unknown> | null {
  const obj = store.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const parseWho = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: line, email: '', date: '' };
    return { name: m[1]!, email: m[2]!, date: store.clock.isoAt(Number(m[3])) };
  };
  const author = parseWho(c.author);
  const committer = parseWho(c.committer);
  return {
    sha: commitOid,
    commit: {
      message: c.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: c.tree },
    },
    author: { login: '', name: author.name, email: author.email },
    committer: { login: '', name: committer.name, email: committer.email },
    parents: c.parents.map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------- issues / pulls

export function createIssueIn(store: Store, repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) return { error: `label ${name} does not exist` };
    labels.push(label);
  }
  const now = store.clock.iso();
  const issue: Issue = {
    id: store.nextIssueId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    seq: repo.issues.length,
    jsonBuf: null,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullIn(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | { error: string } {
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headOid) return { error: `head branch ${headRef} does not exist` };
  if (!baseOid) return { error: `base branch ${baseRef} does not exist` };
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { error: 'a pull request is already open for this head and base' };
    }
  }
  const headObj = store.objects.get(headOid);
  const baseObj = store.objects.get(baseOid);
  if (!headObj || headObj.type !== 'commit' || !baseObj || baseObj.type !== 'commit') {
    return { error: 'head or base does not point at a commit' };
  }
  const headTree = parseCommit(headObj.data).tree;
  const baseTree = parseCommit(baseObj.data).tree;
  const now = store.clock.iso();
  const pr: Pull = {
    id: store.nextPullId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha: headOid,
    baseSha: baseOid,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    seq: repo.pulls.length,
    files: store.diffTrees(baseTree, headTree),
    headTreeAtCreate: headTree,
    baseTreeAtCreate: baseTree,
  };
  repo.pulls.push(pr);
  return pr;
}

/** Whether merging `pr` now would conflict: a path the head changed was also changed on the base since creation. */
export function prHasConflict(store: Store, repo: Repo, pr: Pull): boolean {
  const baseOid = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseOid || baseOid === pr.baseSha) return false;
  const baseObj = store.objects.get(baseOid);
  const createBaseObj = store.objects.get(pr.baseSha);
  if (!baseObj || baseObj.type !== 'commit' || !createBaseObj || createBaseObj.type !== 'commit') return false;
  const currentBaseTree = parseCommit(baseObj.data).tree;
  const changedOnBase = store.diffTrees(pr.baseTreeAtCreate, currentBaseTree);
  if (changedOnBase.length === 0) return false;
  const headChanged = new Set(pr.files.map((f) => f.filename));
  return changedOnBase.some((f) => headChanged.has(f.filename));
}

/** Squash-merge `pr` onto its base branch. Returns the merge commit oid, or an error string. */
export function mergePullIn(store: Store, repo: Repo, pr: Pull): string | { error: string } {
  if (pr.state !== 'open') return { error: 'pull request is not open' };
  if (prHasConflict(store, repo, pr)) return { error: 'merge conflict' };
  const baseOid = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseOid) return { error: 'base branch does not exist' };
  const baseObj = store.objects.get(baseOid);
  if (!baseObj || baseObj.type !== 'commit') return { error: 'base does not point at a commit' };
  const baseTree = parseCommit(baseObj.data).tree;
  // Apply the head's diff (base-at-creation -> head) onto the current base tree.
  let tree = baseTree;
  const headFlat = store.flattenTree(pr.headTreeAtCreate);
  for (const file of pr.files) {
    if (file.status === 'removed') {
      tree = store.editTree(tree, file.filename.split('/'), null);
    } else {
      const entry = headFlat.get(file.filename);
      if (entry) tree = store.editTree(tree, file.filename.split('/'), entry.oid, entry.mode);
    }
  }
  const mergeOid = store.makeCommit(tree, [baseOid], `Merge pull request #${pr.number} from ${pr.headRef}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeOid);
  repo.rev += 1;
  repo.repoJsonBuf = null;
  const now = store.clock.iso();
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = now;
  pr.mergeCommitSha = mergeOid;
  pr.updatedAt = now;
  return mergeOid;
}

// ---------------------------------------------------------------- contents commits

export interface ContentsWrite {
  ok: true;
  commitOid: string;
  blobOid: string | null;
  created: boolean;
}
export interface ContentsError {
  ok: false;
  status: number;
  message: string;
}

/** Create or update a file on a branch (creating the branch from the default tip when needed). */
export function writeContents(
  store: Store,
  repo: Repo,
  branchName: string,
  path: string,
  data: Buffer,
  message: string,
  expectedSha: string | null,
): ContentsWrite | ContentsError {
  const ref = `refs/heads/${branchName}`;
  let tip = repo.refs.get(ref);
  let createdBranch = false;
  if (tip === undefined) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) {
      tip = defaultTip;
      createdBranch = true;
    }
  }
  const isNewFile = tip === undefined ? true : store.treeBlobAt(parseCommit(store.objects.get(tip)!.data).tree, path) === null;
  if (expectedSha !== null) {
    if (tip === undefined) return { ok: false, status: 409, message: 'file does not exist' };
    const current = store.treeBlobAt(parseCommit(store.objects.get(tip)!.data).tree, path);
    if (current !== expectedSha) return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  const blobOid = store.putBlob(data);
  const parentTree = tip === undefined ? null : parseCommit(store.objects.get(tip)!.data).tree;
  const newTree = store.editTree(parentTree, path.split('/'), blobOid);
  const commitOid = store.makeCommit(newTree, tip === undefined ? [] : [tip], message);
  repo.refs.set(ref, commitOid);
  repo.rev += 1;
  repo.repoJsonBuf = null;
  return { ok: true, commitOid, blobOid, created: isNewFile || createdBranch };
}

/** Delete a file from a branch. */
export function deleteContents(
  store: Store,
  repo: Repo,
  branchName: string,
  path: string,
  message: string,
  expectedSha: string | null,
): ContentsWrite | ContentsError {
  const ref = `refs/heads/${branchName}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return { ok: false, status: 404, message: 'branch not found' };
  const tree = parseCommit(store.objects.get(tip)!.data).tree;
  const current = store.treeBlobAt(tree, path);
  if (current === null) return { ok: false, status: 404, message: 'file not found' };
  if (expectedSha !== null && current !== expectedSha) return { ok: false, status: 409, message: 'sha does not match the current file' };
  const newTree = store.editTree(tree, path.split('/'), null);
  const commitOid = store.makeCommit(newTree, [tip], message);
  repo.refs.set(ref, commitOid);
  repo.rev += 1;
  repo.repoJsonBuf = null;
  return { ok: true, commitOid, blobOid: null, created: false };
}

/** Commits reachable from a ref tip, newest first (first-parent walk). */
export function listCommits(store: Store, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const c = parseCommit(obj.data);
    if (c.parents.length > 0) queue.push(c.parents[0]!);
  }
  return out;
}

/** The reachable set of a ref tip (for pack exclusion). */
export function reachableSet(store: Store, tip: string): Set<string> {
  return collectReachable([tip], store.lookup);
}

/** True when `newOid` fast-forwards `oldOid` (old ZERO = create, new ZERO = delete). */
export function fastForwardOk(store: Store, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (newOid === ZERO_OID) return true;
  // Walk the new tip's parents from the index (parsed once at store time), so
  // a long chain costs map lookups instead of a re-parse per commit.
  const seen = new Set<string>();
  const queue: string[] = [newOid];
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === oldOid) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const parents = store.commitParents.get(cur);
    if (parents !== undefined) {
      for (const p of parents) queue.push(p);
    } else {
      const obj = store.objects.get(cur);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      }
    }
  }
  return false;
}
