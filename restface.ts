// restface.ts — the REST v3 surface: repos, branches, commits, refs, contents,
// labels, issues, pulls. One store, shared with git, GraphQL and MCP.

import { parseCommit, parseTree, isObjectId } from './gitproto.ts';
import {
  repoJson,
  repoJsonBuf,
  issueJson,
  issueJsonBuf,
  commentJson,
  pullJson,
  commitJson,
  createIssueIn,
  createPullIn,
  mergePullIn,
  prHasConflict,
  writeContents,
  deleteContents,
  listCommits,
  labelJson,
  type Repo,
  type Issue,
} from './store.ts';
import {
  decodeSegment,
  hasAuth,
  header,
  params,
  readJson,
  sendBuf,
  sendError,
  sendJson,
  type Ctx,
} from './server.ts';

// ---------------------------------------------------------------- shared helpers

function needAuth(ctx: Ctx): boolean {
  if (!hasAuth(ctx)) {
    sendError(ctx, 401, 'requires authentication');
    return false;
  }
  return true;
}

function resolveRepo(ctx: Ctx): Repo | null {
  const [ownerRaw, nameRaw] = params(ctx);
  const owner = decodeSegment(ownerRaw ?? '');
  const name = decodeSegment(nameRaw ?? '');
  if (owner === '' || name === '') return null;
  const repo = ctx.store.findRepo(owner, name);
  if (repo) ctx.store.learnViewer(owner);
  return repo;
}

function hostOf(ctx: Ctx): string {
  return header(ctx, 'host') ?? '127.0.0.1';
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], ctx: Ctx): { slice: T[]; link: string | null } {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const total = items.length;
  const path = ctx.path;
  const base = `http://${hostOf(ctx)}${path}`;
  const links: string[] = [];
  if (start + perPage < total) links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (page > 1) links.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  links.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  links.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  return { slice, link: links.join(', ') };
}

function sendPage(ctx: Ctx, items: readonly unknown[], extra?: Record<string, string>): void {
  const { slice, link } = paginate(items, ctx);
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (link) headers.Link = link;
  sendJson(ctx, 200, slice, headers);
}

function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(204, { 'X-GitHub-Request-Id': `forge-${Date.now().toString(36)}` });
  ctx.res.end();
}

function badJson(ctx: Ctx): boolean {
  // readJson leaves ctx.json undefined when the body does not parse.
  if (ctx.json === undefined) {
    sendError(ctx, 400, 'malformed JSON');
    return true;
  }
  return false;
}

type Body = Record<string, unknown>;
function bodyOf(ctx: Ctx): Body {
  return (ctx.json ?? {}) as Body;
}

// ---------------------------------------------------------------- root / meta / user

export async function handleRoot(ctx: Ctx): Promise<void> {
  const base = `http://${hostOf(ctx)}/api/v3`;
  sendJson(ctx, 200, { current_user_url: `${base}/user`, rate_limit_url: `${base}/rate_limit` }, { 'X-OAuth-Scopes': 'repo, user' });
}

export async function handleMeta(ctx: Ctx): Promise<void> {
  sendJson(ctx, 200, { installed_version: '1.0.0' });
}

export async function handleGetUser(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const viewer = ctx.store.viewer;
  if (viewer === null) {
    sendError(ctx, 404, 'viewer not known');
    return;
  }
  sendJson(ctx, 200, { login: viewer, id: 1, type: 'User' });
}

export async function handleListUserRepos(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repos = [...ctx.store.repos.values()].sort((a, b) => a.id - b.id);
  sendPage(ctx, repos.map((r) => repoJson(ctx.store, r)));
}

export async function handleCreateUserRepo(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name === '') {
    sendError(ctx, 422, 'name is required');
    return;
  }
  if (ctx.store.findRepoByName(name)) {
    sendError(ctx, 422, 'name already exists on this account');
    return;
  }
  const repo = ctx.store.createRepo(name, b.private === true, typeof b.description === 'string' ? b.description : '');
  sendJson(ctx, 201, repoJson(ctx.store, repo));
}

// ---------------------------------------------------------------- repos

export async function handleGetRepo(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  sendBuf(ctx, 200, repoJsonBuf(ctx.store, repo));
}

export async function handlePatchRepo(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  if (typeof b.description === 'string') repo.description = b.description;
  if (typeof b.private === 'boolean') repo.isPrivate = b.private;
  repo.updatedAt = ctx.store.clock.iso();
  repo.repoJsonBuf = null;
  sendJson(ctx, 200, repoJson(ctx.store, repo));
}

export async function handleDeleteRepo(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  ctx.store.deleteRepo(repo.name);
  sendNoContent(ctx);
}

// ---------------------------------------------------------------- branches / commits / refs

export async function handleListBranches(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const branches = [...repo.refs.keys()]
    .filter((r) => r.startsWith('refs/heads/'))
    .map((r) => r.slice('refs/heads/'.length))
    .sort()
    .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false }));
  sendJson(ctx, 200, branches);
}

export async function handleGetBranch(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const branch = decodeSegment(params(ctx)[2] ?? '');
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) {
    sendError(ctx, 404, 'branch not found');
    return;
  }
  sendJson(ctx, 200, { name: branch, commit: { sha: oid }, protected: false });
}

export async function handleListCommits(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const shaParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (shaParam) {
    tip = isObjectId(shaParam) ? shaParam : repo.refs.get(`refs/heads/${shaParam}`);
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (!tip) {
    sendJson(ctx, 200, []);
    return;
  }
  const oids = listCommits(ctx.store, tip, 100);
  const out = oids.map((o) => commitJson(ctx.store, o)).filter(Boolean);
  sendJson(ctx, 200, out);
}

export async function handleCreateRef(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const ref = typeof b.ref === 'string' ? b.ref : '';
  const sha = typeof b.sha === 'string' ? b.sha : '';
  if (!ref.startsWith('refs/') || !isObjectId(sha)) {
    sendError(ctx, 422, 'invalid ref or sha');
    return;
  }
  if (!ctx.store.objects.has(sha)) {
    sendError(ctx, 422, 'sha does not exist');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx, 422, 'ref already exists');
    return;
  }
  repo.refs.set(ref, sha);
  repo.rev += 1;
  repo.repoJsonBuf = null;
  sendJson(ctx, 201, { ref, object: { sha } });
}

export async function handleGetRef(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const branch = decodeSegment(params(ctx)[2] ?? '');
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) {
    sendError(ctx, 404, 'reference not found');
    return;
  }
  sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha: oid } });
}

// ---------------------------------------------------------------- contents

/** The tree oid at `path` under a root tree, or null. */
function subtreeOid(store: import('./store.ts').Store, rootTree: string, path: string): string | null {
  if (path === '') return rootTree;
  let oid: string | null = rootTree;
  for (const seg of path.split('/')) {
    if (oid === null) return null;
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    oid = entry.oid;
  }
  return oid;
}

export async function handlePutContents(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const path = decodeSegment(params(ctx)[2] ?? '');
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const message = typeof b.message === 'string' ? b.message : 'update';
  const contentB64 = typeof b.content === 'string' ? b.content : '';
  if (contentB64 === '') {
    sendError(ctx, 422, 'content is required');
    return;
  }
  let data: Buffer;
  try {
    data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    sendError(ctx, 422, 'content is not valid base64');
    return;
  }
  const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  const sha = typeof b.sha === 'string' ? b.sha : null;
  const res = writeContents(ctx.store, repo, branch, path, data, message, sha);
  if (!res.ok) {
    sendError(ctx, res.status, res.message);
    return;
  }
  sendJson(ctx, res.created ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: res.blobOid, size: data.length, encoding: 'base64' },
    commit: { sha: res.commitOid },
  });
}

export async function handleGetContents(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const path = decodeSegment(params(ctx)[2] ?? '');
  const refParam = ctx.query.get('ref');
  let tip: string | undefined;
  if (refParam) {
    tip = isObjectId(refParam) ? refParam : repo.refs.get(`refs/heads/${refParam}`);
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (!tip) {
    sendError(ctx, 404, 'repository is empty');
    return;
  }
  const obj = ctx.store.objects.get(tip);
  if (!obj || obj.type !== 'commit') {
    sendError(ctx, 404, 'repository is empty');
    return;
  }
  const rootTree = parseCommit(obj.data).tree;
  const owner = repo.owner ?? ctx.store.viewer ?? '';
  if (path === '') {
    const entries = parseTree(ctx.store.objects.get(rootTree)?.data ?? Buffer.alloc(0));
    sendJson(ctx, 200, entries.map((e) => dirEntry(ctx.store, repo, '', e)));
    return;
  }
  const blobOid = ctx.store.treeBlobAt(rootTree, path);
  if (blobOid !== null) {
    const blob = ctx.store.objects.get(blobOid);
    const data = blob ? blob.data : Buffer.alloc(0);
    const b64 = data.toString('base64');
    const wrapped = b64.replace(/(.{60})/g, '$1\n');
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: wrapped,
      sha: blobOid,
      url: `/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `/api/v3/repos/${owner}/${repo.name}/git/blobs/${blobOid}`,
      download_url: `https://example.invalid/${owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    });
    return;
  }
  const dirOid = subtreeOid(ctx.store, rootTree, path);
  if (dirOid === null) {
    sendError(ctx, 404, 'path not found');
    return;
  }
  const entries = parseTree(ctx.store.objects.get(dirOid)?.data ?? Buffer.alloc(0));
  sendJson(ctx, 200, entries.map((e) => dirEntry(ctx.store, repo, path, e)));
}

function dirEntry(
  store: import('./store.ts').Store,
  repo: Repo,
  parentPath: string,
  e: { mode: string; name: string; oid: string },
): Record<string, unknown> {
  const path = parentPath === '' ? e.name : `${parentPath}/${e.name}`;
  if (e.mode === '40000') {
    return { type: 'dir', name: e.name, path, sha: e.oid, size: 0 };
  }
  const blob = store.objects.get(e.oid);
  return { type: 'file', name: e.name, path, sha: e.oid, size: blob ? blob.data.length : 0 };
}

export async function handleDeleteContents(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const path = decodeSegment(params(ctx)[2] ?? '');
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const message = typeof b.message === 'string' ? b.message : 'delete';
  const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
  const sha = typeof b.sha === 'string' ? b.sha : null;
  const res = deleteContents(ctx.store, repo, branch, path, message, sha);
  if (!res.ok) {
    sendError(ctx, res.status, res.message);
    return;
  }
  sendJson(ctx, 200, { commit: { sha: res.commitOid } });
}

// ---------------------------------------------------------------- labels

export async function handleCreateLabel(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const color = typeof b.color === 'string' ? b.color : 'ededed';
  if (name === '') {
    sendError(ctx, 422, 'name is required');
    return;
  }
  if (repo.labels.has(name)) {
    sendError(ctx, 422, 'label already exists');
    return;
  }
  const label = { id: ctx.store.nextLabelId(), name, color, description: typeof b.description === 'string' ? b.description : '' };
  repo.labels.set(name, label);
  sendJson(ctx, 201, labelJson(label));
}

export async function handleListLabels(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
}

// ---------------------------------------------------------------- issues

function findIssue(repo: Repo, n: number): Issue | null {
  return repo.issues.find((i) => i.number === n) ?? null;
}

export async function handleCreateIssue(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const title = typeof b.title === 'string' ? b.title : '';
  const bodyText = typeof b.body === 'string' ? b.body : '';
  const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
  if (title === '') {
    sendError(ctx, 422, 'title is required');
    return;
  }
  const res = createIssueIn(ctx.store, repo, title, bodyText, labels);
  if ('error' in res) {
    sendError(ctx, 422, res.error);
    return;
  }
  sendJson(ctx, 201, issueJson(ctx.store, repo, res));
}

export async function handleListIssues(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const state = ctx.query.get('state') ?? 'open';
  let items = repo.issues;
  if (state !== 'all') items = items.filter((i) => i.state === state);
  const direction = ctx.query.get('direction') ?? 'desc';
  const sorted = [...items].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  sendPage(ctx, sorted.map((i) => issueJson(ctx.store, repo, i)));
}

export async function handleGetIssue(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const issue = findIssue(repo, n);
  if (!issue) {
    sendError(ctx, 404, 'issue not found');
    return;
  }
  // The read workload's fast path: a precomputed response buffer.
  sendBuf(ctx, 200, issueJsonBuf(ctx.store, repo, issue));
}

export async function handlePatchIssue(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const issue = findIssue(repo, n);
  if (!issue) {
    sendError(ctx, 404, 'issue not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string') issue.body = b.body;
  if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
  if (Array.isArray(b.labels)) {
    const labels: typeof issue.labels = [];
    for (const name of b.labels) {
      if (typeof name !== 'string') continue;
      const label = repo.labels.get(name);
      if (!label) {
        sendError(ctx, 422, `label ${name} does not exist`);
        return;
      }
      labels.push(label);
    }
    issue.labels = labels;
  }
  issue.updatedAt = ctx.store.clock.iso();
  issue.jsonBuf = null;
  sendJson(ctx, 200, issueJson(ctx.store, repo, issue));
}

export async function handleCreateComment(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const issue = findIssue(repo, n);
  if (!issue) {
    sendError(ctx, 404, 'issue not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const bodyText = typeof b.body === 'string' ? b.body : '';
  const now = ctx.store.clock.iso();
  const comment = { id: repo.nextCommentId++, body: bodyText, createdAt: now, updatedAt: now };
  const list = repo.comments.get(n) ?? [];
  list.push(comment);
  repo.comments.set(n, list);
  issue.jsonBuf = null;
  sendJson(ctx, 201, commentJson(ctx.store, repo, n, comment));
}

export async function handleListComments(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const issue = findIssue(repo, n);
  if (!issue) {
    sendError(ctx, 404, 'issue not found');
    return;
  }
  const list = repo.comments.get(n) ?? [];
  sendJson(ctx, 200, list.map((c) => commentJson(ctx.store, repo, n, c)));
}

// ---------------------------------------------------------------- pulls

function findPull(repo: Repo, n: number) {
  return repo.pulls.find((p) => p.number === n) ?? null;
}

export async function handleCreatePull(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  const b = bodyOf(ctx);
  const title = typeof b.title === 'string' ? b.title : '';
  const bodyText = typeof b.body === 'string' ? b.body : '';
  const head = typeof b.head === 'string' ? b.head : '';
  const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
  if (title === '' || head === '') {
    sendError(ctx, 422, 'title and head are required');
    return;
  }
  const res = createPullIn(ctx.store, repo, title, bodyText, head, base);
  if ('error' in res) {
    sendError(ctx, 422, res.error);
    return;
  }
  sendJson(ctx, 201, pullJson(ctx.store, repo, res));
}

export async function handleListPulls(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const state = ctx.query.get('state') ?? 'open';
  let items = repo.pulls;
  if (state !== 'all') items = items.filter((p) => p.state === state);
  const sorted = [...items].sort((a, b) => b.number - a.number);
  sendPage(ctx, sorted.map((p) => pullJson(ctx.store, repo, p)));
}

export async function handleGetPull(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const pr = findPull(repo, n);
  if (!pr) {
    sendError(ctx, 404, 'pull request not found');
    return;
  }
  sendJson(ctx, 200, pullJson(ctx.store, repo, pr));
}

export async function handleListPullFiles(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const pr = findPull(repo, n);
  if (!pr) {
    sendError(ctx, 404, 'pull request not found');
    return;
  }
  sendJson(ctx, 200, pr.files);
}

export async function handleMergePull(ctx: Ctx): Promise<void> {
  if (!needAuth(ctx)) return;
  const repo = resolveRepo(ctx);
  if (!repo) {
    sendError(ctx, 404, 'repository not found');
    return;
  }
  const n = Number(params(ctx)[2]);
  const pr = findPull(repo, n);
  if (!pr) {
    sendError(ctx, 404, 'pull request not found');
    return;
  }
  await readJson(ctx);
  if (badJson(ctx)) return;
  if (pr.state !== 'open') {
    sendError(ctx, 409, 'pull request is not open');
    return;
  }
  if (prHasConflict(ctx.store, repo, pr)) {
    sendError(ctx, 405, 'merge conflict');
    return;
  }
  const res = mergePullIn(ctx.store, repo, pr);
  if (typeof res !== 'string') {
    sendError(ctx, 405, res.error);
    return;
  }
  sendJson(ctx, 200, { merged: true, sha: res, message: `Pull request #${pr.number} merged` });
}
