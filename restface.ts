// REST v3: repositories, branches, commits, refs, contents, labels, issues,
// comments and pull requests over the vault. Every reply is JSON (never
// HTML), every reply carries X-GitHub-Request-Id, an unknown route is a 404
// JSON {message}, a malformed JSON body is a 400, and a missing bearer token
// is a 401. A repository belongs to the login the token names; the same name
// under another owner is a 404, never a 403.
//
// Speed shape: the two hot paths (GET one issue, POST one issue) never build
// a shape object and never call JSON.stringify on one. The issue body is
// rendered once by string concatenation (string fields escaped with
// JSON.stringify per field) and cached on the issue record; any mutation
// touching the issue clears it. Routing is segment checks, not a regex chain.

import {
  addCommentRec, blobAt, clearIssueCache, commitsFromTip, commonBase, createIssueRec, createPullRec, diffMaps,
  dropRepo, filesAt, newRepo, refToCommit, repoNamed, reposSorted,
  setRef, squashMerge, storeObj, treeAtPath, treeFromFiles,
  type CommentRec, type IssueRec, type PullRec, type RepoRec, type Vault,
} from './vault.ts';
import { decodeCommit, decodeTree, encodeCommit } from './objects.ts';
import { ISO_NOW, VIEWER } from './seed.ts';

export interface RestReq {
  method: string;
  /** Path segments after /api/v3 (decoded, no leading empty element). */
  seg: string[];
  query: URLSearchParams;
  /** Raw Node headers (already lower-cased keys). */
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
  /** The request's absolute base URL without query, for pagination Link headers. */
  pathBase?: string;
}

export interface RestRes {
  status: number;
  headers?: Record<string, string>;
  /** Pre-rendered JSON body (string or UTF-8 bytes), or null for an empty body. */
  body: string | Buffer | null;
}

let reqSeq = 0;
function nextReqId(): string {
  reqSeq += 1;
  return `req-${reqSeq.toString(16).padStart(8, '0')}`;
}

function respond(status: number, body: string | Buffer | null, extra: Record<string, string> = {}): RestRes {
  return { status, headers: { 'X-GitHub-Request-Id': nextReqId(), ...extra }, body };
}

/** A response whose body is already UTF-8 bytes (no per-request encoding). */
function respondBuf(status: number, buf: Buffer, extra: Record<string, string> = {}): RestRes {
  return respond(status, buf, extra);
}

function respondJson(status: number, value: unknown, extra: Record<string, string> = {}): RestRes {
  return respond(status, JSON.stringify(value), extra);
}

function fail(status: number, message: string): RestRes {
  return respondJson(status, { message });
}

/** JSON-escape one string value (quotes, backslashes, control chars). */
function q(s: string): string {
  return JSON.stringify(s);
}

/** The constant viewer fragment, rendered once (userShape never changes). */
const USER_JSON = JSON.stringify({
  login: VIEWER.login,
  id: VIEWER.id,
  node_id: `U_${VIEWER.id}`,
  avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}`,
  gravatar_id: '',
  url: `https://api.github.com/users/${VIEWER.login}`,
  html_url: `https://github.com/${VIEWER.login}`,
  type: 'User',
  site_admin: false,
  name: VIEWER.name,
  email: VIEWER.email,
});

function userObj(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}`,
    gravatar_id: '',
    url: `https://api.github.com/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function openCount(repo: RepoRec): number {
  let n = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') n++;
  return n;
}

function repoObj(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObj(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: ISO_NOW,
    updated_at: ISO_NOW,
    pushed_at: ISO_NOW,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openCount(repo),
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function labelObj(name: string, color: string): Record<string, unknown> {
  return {
    id: 0,
    node_id: `L_${name}`,
    url: `https://api.github.com/repos/${VIEWER.login}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default: false,
    description: '',
  };
}

function labelJson(repo: RepoRec, name: string): string {
  const color = repo.labels.get(name)?.color ?? 'ededed';
  return `{"id":0,"node_id":${q(`L_${name}`)},"url":${q(`https://api.github.com/repos/${VIEWER.login}/labels/${encodeURIComponent(name)}`)},"name":${q(name)},"color":${q(color)},"default":false,"description":""}`;
}

/**
 * Render one issue as a JSON string by concatenation. Field order matches
 * the shape object exactly; string fields are escaped with JSON.stringify.
 * The result is cached on the issue record by the caller.
 */
export function renderIssue(repo: RepoRec, issue: IssueRec): string {
  const labels = issue.labels.map((name) => labelJson(repo, name)).join(',');
  const comments = (repo.comments.get(issue.number) ?? []).length;
  const closedAt = issue.state === 'closed' ? `"${ISO_NOW}"` : 'null';
  return (
    `{"id":${issue.id},"node_id":"I_${issue.id}",` +
    `"url":"https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}",` +
    `"html_url":"https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}",` +
    `"number":${issue.number},"title":${q(issue.title)},"body":${q(issue.body)},"state":${q(issue.state)},` +
    `"locked":false,"user":${USER_JSON},"labels":[${labels}],"assignee":null,"assignees":[],` +
    `"milestone":null,"comments":${comments},"created_at":"${ISO_NOW}","updated_at":"${ISO_NOW}",` +
    `"closed_at":${closedAt},"author_association":"OWNER"}`
  );
}

/** The cached (or freshly rendered) REST body for one issue. */
export function issueBody(repo: RepoRec, issue: IssueRec): string {
  if (issue.cached !== null) return issue.cached;
  const text = renderIssue(repo, issue);
  issue.cached = text;
  return text;
}

/** The cached (or freshly rendered) REST body for one issue, as UTF-8 bytes. */
export function issueBuf(repo: RepoRec, issue: IssueRec): Buffer {
  if (issue.cachedBuf !== null) return issue.cachedBuf;
  const buf = Buffer.from(issueBody(repo, issue), 'utf8');
  issue.cachedBuf = buf;
  return buf;
}

function commentObj(repo: RepoRec, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userObj(),
    created_at: ISO_NOW,
    updated_at: ISO_NOW,
    author_association: 'OWNER',
  };
}

function pullObj(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userObj(),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: ISO_NOW,
    updated_at: ISO_NOW,
    closed_at: pull.state === 'closed' ? ISO_NOW : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: 'unknown',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userObj(), repo: repoObj(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userObj(), repo: repoObj(repo) },
    author_association: 'OWNER',
  };
}

function branchObj(repo: RepoRec, name: string, sha: string): Record<string, unknown> {
  const o = repo.objects.get(sha);
  const message = o && o.kind === 'commit' ? decodeCommit(o.bytes).message : '';
  return {
    name,
    commit: {
      sha,
      commit: {
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW },
        committer: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW },
      },
    },
    protected: false,
  };
}

function commitObj(repo: RepoRec, sha: string): Record<string, unknown> | null {
  const o = repo.objects.get(sha);
  if (!o || o.kind !== 'commit') return null;
  const c = decodeCommit(o.bytes);
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      message: c.message,
      author: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW },
      committer: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW },
      tree: { sha: c.tree },
    },
    author: userObj(),
    committer: userObj(),
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

type JsonOk = { ok: true; value: Record<string, unknown> };
type JsonBad = { ok: false; res: RestRes };

function parseBody(req: RestReq): JsonOk | JsonBad {
  if (req.bodyText === '') return { ok: true, value: {} };
  try {
    const v: unknown = JSON.parse(req.bodyText);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, res: fail(400, 'Request body must be a JSON object') };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, res: fail(400, 'Problems parsing JSON') };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

/** Resolve a repo from owner/name; a foreign owner is a 404, never a 403. */
function resolveRepo(vault: Vault, owner: string, name: string): { ok: true; repo: RepoRec } | { ok: false; res: RestRes } {
  if (owner !== vault.viewer) return { ok: false, res: fail(404, 'Not Found') };
  const repo = repoNamed(vault, name);
  if (!repo) return { ok: false, res: fail(404, 'Not Found') };
  return { ok: true, repo };
}

function bearer(req: RestReq): string | null {
  const h = req.headers['authorization'];
  const value = Array.isArray(h) ? h.join(', ') : (h ?? '');
  if (!value || !value.toLowerCase().startsWith('bearer ')) return null;
  const token = value.slice('bearer '.length).trim();
  return token === '' ? null : token;
}

// ---------------------------------------------------------------- handlers

function rootRes(): RestRes {
  return respondJson(200, {
    current_user_url: 'https://api.github.com/user',
    current_user_authorizations_html_url: 'https://github.com/settings/applications',
    authorizations_url: 'https://api.github.com/authorizations',
    code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page,sort,order}',
    commit_search_url: 'https://api.github.com/search/commits?q={query}{&page,per_page,sort,order}',
    emails_url: 'https://api.github.com/user/emails',
    emojis_url: 'https://api.github.com/emojis',
    events_url: 'https://api.github.com/events',
    feeds_url: 'https://api.github.com/feeds',
    followers_url: 'https://api.github.com/users/{user}/followers',
    following_url: 'https://api.github.com/users/{user}/following{/target}',
    gists_url: 'https://api.github.com/gists{/gist_id}',
    hub_url: 'https://api.github.com/hub',
    issue_search_url: 'https://api.github.com/search/issues?q={query}{&page,per_page,sort,order}',
    issues_url: 'https://api.github.com/issues',
    keys_url: 'https://api.github.com/user/keys',
    label_search_url: 'https://api.github.com/search/labels?repository_id={repository_id}&q={query}',
    notifications_url: 'https://api.github.com/notifications',
    organization_url: 'https://api.github.com/orgs/{org}',
    public_gists_url: 'https://api.github.com/gists/public',
    rate_limit_url: 'https://api.github.com/rate_limit',
    repository_url: 'https://api.github.com/repos/{owner}/{repo}',
    repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}',
    current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}',
    starred_url: 'https://api.github.com/user/starred{/owner}{/repo}',
    starred_gists_url: 'https://api.github.com/gists/starred',
    topic_search_url: 'https://api.github.com/search/topics?q={query}{&page,per_page,sort,order}',
    user_url: 'https://api.github.com/users/{user}',
    user_organizations_url: 'https://api.github.com/user/orgs',
    user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort}',
    user_search_url: 'https://api.github.com/search/users?q={query}{&page,per_page,sort,order}',
  }, { 'X-OAuth-Scopes': 'repo, user, read:org' });
}

function metaRes(): RestRes {
  return respondJson(200, {
    verifiable_password_authentication: true,
    ssh_key_fingerprints: {},
    ssh_keys: [],
    hooks: [],
    github_enterprise_importer: [],
    installed_version: '1.0.0',
    domains: { website: ['github.com'], codespaces: [], copilot: [], packages: [] },
  });
}

function pageLinks(req: RestReq, page: number, perPage: number, total: number): string {
  const last = Math.max(1, Math.ceil(total / perPage));
  // The Link header needs the request's own base URL without query; main.ts
  // passes it through `pathBase` on the request.
  const root = req.pathBase ?? '';
  const link = (p: number, rel: string): string => `<${root}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < last) parts.push(link(page + 1, 'next'), link(last, 'last'));
  if (page > 1) parts.push(link(1, 'first'), link(page - 1, 'prev'));
  return parts.join(', ');
}

function listUserRepos(vault: Vault, req: RestReq): RestRes {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const repos = reposSorted(vault);
  const slice = repos.slice((page - 1) * perPage, page * perPage);
  const link = pageLinks(req, page, perPage, repos.length);
  return respondJson(200, slice.map((r) => repoObj(r)), link ? { Link: link } : {});
}

function createRepoH(vault: Vault, req: RestReq): RestRes {
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const name = str(parsed.value.name);
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return fail(422, 'Validation Failed: name is invalid');
  const repo = newRepo(vault, name, str(parsed.value.description) ?? '', bool(parsed.value.private) ?? false);
  if (!repo) return fail(422, 'Validation Failed: name already exists on this account');
  return respondJson(201, repoObj(repo));
}

function patchRepo(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const desc = str(parsed.value.description);
  if (desc !== undefined) repo.description = desc;
  const priv = bool(parsed.value.private);
  if (priv !== undefined) repo.isPrivate = priv;
  return respondJson(200, repoObj(repo));
}

function deleteRepoH(vault: Vault, owner: string, name: string): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  dropRepo(vault, name);
  return { status: 204, headers: { 'X-GitHub-Request-Id': nextReqId() }, body: null };
}

function listBranches(vault: Vault, owner: string, name: string): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const out: unknown[] = [];
  for (const refName of [...repo.refs.keys()].sort()) {
    if (!refName.startsWith('refs/heads/')) continue;
    out.push(branchObj(repo, refName.slice('refs/heads/'.length), repo.refs.get(refName) as string));
  }
  return respondJson(200, out);
}

function getBranch(vault: Vault, owner: string, name: string, branch: string): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const sha = resolved.repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return fail(404, 'Branch not found');
  return respondJson(200, branchObj(resolved.repo, branch, sha));
}

function listCommits(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = refToCommit(repo, ref);
  if (!tip) return respondJson(200, []);
  const out: unknown[] = [];
  for (const sha of commitsFromTip(repo, tip)) {
    const shape = commitObj(repo, sha);
    if (shape) out.push(shape);
  }
  return respondJson(200, out);
}

function getCommit(vault: Vault, owner: string, name: string, sha: string): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const shape = commitObj(resolved.repo, sha);
  if (!shape) return fail(404, 'Not Found');
  return respondJson(200, shape);
}

function createRef(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const ref = str(parsed.value.ref);
  const sha = str(parsed.value.sha);
  if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
    return fail(422, 'Validation Failed: ref and sha are required');
  }
  if (!repo.objects.has(sha)) return fail(422, 'Validation Failed: object does not exist');
  if (repo.refs.has(ref)) return fail(422, 'Validation Failed: reference already exists');
  setRef(repo, ref, sha);
  return respondJson(201, {
    ref,
    node_id: `REF_${ref}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
    object: { sha, type: repo.objects.get(sha)?.kind ?? 'commit', url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${repo.objects.get(sha)?.kind ?? 'commit'}s/${sha}` },
  });
}

function getRef(vault: Vault, owner: string, name: string, refPath: string): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (!sha) return fail(404, 'Not Found');
  return respondJson(200, {
    ref,
    node_id: `REF_${ref}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
    object: { sha, type: repo.objects.get(sha)?.kind ?? 'commit', url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${repo.objects.get(sha)?.kind ?? 'commit'}s/${sha}` },
  });
}

// ---------------------------------------------------------------- contents

function getContents(vault: Vault, owner: string, name: string, filePath: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  const tip = refToCommit(repo, ref);
  if (!tip) return fail(404, 'Not Found');
  const clean = filePath.replace(/^\/+|\/+$/g, '');
  const blob = blobAt(repo, tip, clean);
  if (blob) {
    const entry = filesAt(repo, tip).get(clean) as { oid: string; mode: string };
    return respondJson(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.length,
      name: clean.split('/').pop() ?? clean,
      path: clean,
      content: blob.toString('base64'),
      sha: entry.oid,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${clean}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${clean}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${clean}`,
    });
  }
  const treeOid = treeAtPath(repo, tip, clean);
  if (!treeOid) return fail(404, 'Not Found');
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.kind !== 'tree') return fail(404, 'Not Found');
  const entries: Record<string, unknown>[] = [];
  for (const item of decodeTree(tree.bytes)) {
    const childPath = clean === '' ? item.name : `${clean}/${item.name}`;
    const isDir = item.mode === '40000';
    const blobObj = !isDir ? repo.objects.get(item.oid) : undefined;
    entries.push({
      type: isDir ? 'dir' : 'file',
      size: blobObj ? blobObj.bytes.length : 0,
      name: item.name,
      path: childPath,
      sha: item.oid,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${ref}/${childPath}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${item.oid}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${ref}/${childPath}`,
    });
  }
  return respondJson(200, entries);
}

function putContents(vault: Vault, owner: string, name: string, filePath: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const body = parsed.value;
  const message = str(body.message);
  const content = str(body.content);
  if (!message || content === undefined) return fail(422, 'Validation Failed: message and content are required');
  const branch = str(body.branch) ?? repo.defaultBranch;
  const expectedSha = str(body.sha);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  } catch {
    return fail(422, 'Validation Failed: content is not valid base64');
  }
  const clean = filePath.replace(/^\/+|\/+$/g, '');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const isUpdate = tip ? blobAt(repo, tip, clean) !== null : false;
  if (isUpdate && tip) {
    const files = filesAt(repo, tip);
    const current = files.get(clean);
    if (expectedSha && current && expectedSha !== current.oid) {
      return fail(409, 'Conflict: the file has changed since the given sha');
    }
  }
  const blobOid = storeObj(repo, 'blob', bytes);
  const files = tip ? filesAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
  files.set(clean, { oid: blobOid, mode: '100644' });
  const treeOid = treeFromFiles(repo, files);
  const parents = tip ? [tip] : [];
  const commitOid = storeObj(repo, 'commit', encodeCommit({ tree: treeOid, parents, message }));
  setRef(repo, `refs/heads/${branch}`, commitOid);
  return respondJson(isUpdate ? 200 : 201, {
    content: {
      name: clean.split('/').pop() ?? clean,
      path: clean,
      sha: blobOid,
      size: bytes.length,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${clean}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${clean}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${clean}`,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(vault: Vault, owner: string, name: string, filePath: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const body = parsed.value;
  const message = str(body.message);
  if (!message) return fail(422, 'Validation Failed: message is required');
  const branch = str(body.branch) ?? repo.defaultBranch;
  const expectedSha = str(body.sha);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return fail(404, 'Not Found');
  const clean = filePath.replace(/^\/+|\/+$/g, '');
  const files = filesAt(repo, tip);
  const current = files.get(clean);
  if (!current) return fail(404, 'Not Found');
  if (expectedSha && expectedSha !== current.oid) {
    return fail(409, 'Conflict: the file has changed since the given sha');
  }
  files.delete(clean);
  const treeOid = treeFromFiles(repo, files);
  const commitOid = storeObj(repo, 'commit', encodeCommit({ tree: treeOid, parents: [tip], message }));
  setRef(repo, `refs/heads/${branch}`, commitOid);
  return respondJson(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- labels / issues / comments / pulls

function listLabels(vault: Vault, owner: string, name: string): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  return respondJson(200, [...resolved.repo.labels.values()].map((l) => labelObj(l.name, l.color)));
}

function createLabel(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const labelName = str(parsed.value.name);
  const color = str(parsed.value.color) ?? 'ededed';
  if (!labelName) return fail(422, 'Validation Failed: name is required');
  if (repo.labels.has(labelName)) return fail(422, 'Validation Failed: label already exists');
  repo.labels.set(labelName, { name: labelName, color });
  return respondJson(201, labelObj(labelName, color));
}

function listIssues(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  // List responses are built from the same renderer, joined as an array.
  const bodies = issues.map((i) => issueBody(repo, i));
  return respond(200, `[${bodies.join(',')}]`);
}

function createIssue(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const title = str(parsed.value.title);
  if (!title) return fail(422, 'Validation Failed: title is required');
  const labels = strList(parsed.value.labels) ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return fail(422, `Validation Failed: label "${label}" does not exist`);
  }
  const issue = createIssueRec(vault, repo, title, str(parsed.value.body) ?? '', labels);
  return respondBuf(201, issueBuf(repo, issue));
}

function getIssue(vault: Vault, owner: string, name: string, number: number): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const issue = resolved.repo.issues.get(number);
  if (!issue) return fail(404, 'Not Found');
  return respondBuf(200, issueBuf(resolved.repo, issue));
}

function patchIssue(vault: Vault, owner: string, name: string, number: number, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const issue = repo.issues.get(number);
  if (!issue) return fail(404, 'Not Found');
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const title = str(parsed.value.title);
  if (title !== undefined) issue.title = title;
  const body = str(parsed.value.body);
  if (body !== undefined) issue.body = body;
  const state = str(parsed.value.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  const labels = strList(parsed.value.labels);
  if (labels !== undefined) {
    for (const label of labels) {
      if (!repo.labels.has(label)) return fail(422, `Validation Failed: label "${label}" does not exist`);
    }
    issue.labels = labels;
  }
  clearIssueCache(issue);
  return respondBuf(200, issueBuf(repo, issue));
}

function listComments(vault: Vault, owner: string, name: string, number: number): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  if (!repo.issues.has(number)) return fail(404, 'Not Found');
  const comments = repo.comments.get(number) ?? [];
  return respondJson(200, comments.map((c) => commentObj(repo, number, c)));
}

function createComment(vault: Vault, owner: string, name: string, number: number, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  if (!repo.issues.has(number)) return fail(404, 'Not Found');
  const body = str(parsed.value.body);
  if (!body) return fail(422, 'Validation Failed: body is required');
  const comment = addCommentRec(repo, number, body);
  return respondJson(201, commentObj(repo, number, comment));
}

function stripOwner(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function listPulls(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const state = req.query.get('state') ?? 'open';
  const pulls = [...repo.pulls.values()]
    .filter((p) => state === 'all' || p.state === state)
    .sort((a, b) => b.seq - a.seq);
  return respondJson(200, pulls.map((p) => pullObj(repo, p)));
}

function createPull(vault: Vault, owner: string, name: string, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const headRef = stripOwner(str(parsed.value.head) ?? '');
  const baseRef = stripOwner(str(parsed.value.base) ?? '');
  const title = str(parsed.value.title);
  if (!headRef || !baseRef || !title) return fail(422, 'Validation Failed: head, base and title are required');
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha) return fail(422, `Validation Failed: head branch "${headRef}" does not exist`);
  if (!baseSha) return fail(422, `Validation Failed: base branch "${baseRef}" does not exist`);
  const pull = createPullRec(vault, repo, title, str(parsed.value.body) ?? '', headRef, baseRef, headSha, baseSha);
  return respondJson(201, pullObj(repo, pull));
}

function getPull(vault: Vault, owner: string, name: string, number: number): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const pull = resolved.repo.pulls.get(number);
  if (!pull) return fail(404, 'Not Found');
  return respondJson(200, pullObj(resolved.repo, pull));
}

function listPullFiles(vault: Vault, owner: string, name: string, number: number): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const repo = resolved.repo;
  const pull = repo.pulls.get(number);
  if (!pull) return fail(404, 'Not Found');
  const base = commonBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
  const changes = diffMaps(repo, filesAt(repo, base), filesAt(repo, pull.headSha));
  return respondJson(200, changes.map((c) => ({
    sha: c.newOid ?? c.oldOid,
    filename: c.path,
    status: c.status,
    additions: c.additions,
    deletions: c.deletions,
    changes: c.changes,
    blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${c.path}`,
    raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${c.path}`,
    contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${c.path}?ref=${pull.headSha}`,
  })));
}

function mergePull(vault: Vault, owner: string, name: string, number: number, req: RestReq): RestRes {
  const resolved = resolveRepo(vault, owner, name);
  if (!resolved.ok) return resolved.res;
  const parsed = parseBody(req);
  if (!parsed.ok) return parsed.res;
  const repo = resolved.repo;
  const pull = repo.pulls.get(number);
  if (!pull) return fail(404, 'Not Found');
  if (pull.state !== 'open' || pull.merged) return fail(405, 'Pull request is already closed');
  const merged = squashMerge(repo, pull);
  if (!merged.ok) {
    return merged.why === 'Merge conflict' ? fail(405, 'Merge conflict') : fail(422, `Validation Failed: ${merged.why}`);
  }
  return respondJson(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------- dispatcher

/**
 * Route one REST v3 request. Returns null when the path is not under /api/v3
 * at all (the HTTP layer then tries the other surfaces).
 */
export function handleRest(vault: Vault, req: RestReq): RestRes | null {
  if (!bearer(req)) return fail(401, 'Requires authentication');
  const seg = req.seg;
  const method = req.method;

  if (seg.length === 0) {
    return method === 'GET' ? rootRes() : fail(404, 'Not Found');
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    return method === 'GET' ? metaRes() : fail(404, 'Not Found');
  }
  if (seg.length === 1 && seg[0] === 'user') {
    return method === 'GET' ? respondJson(200, userObj()) : fail(404, 'Not Found');
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') return listUserRepos(vault, req);
    if (method === 'POST') return createRepoH(vault, req);
    return fail(404, 'Not Found');
  }
  if (seg.length < 3 || seg[0] !== 'repos') return fail(404, 'Not Found');
  const owner = decodeURIComponent(seg[1] as string);
  const repoName = decodeURIComponent(seg[2] as string);
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      const resolved = resolveRepo(vault, owner, repoName);
      return resolved.ok ? respondJson(200, repoObj(resolved.repo)) : resolved.res;
    }
    if (method === 'PATCH') return patchRepo(vault, owner, repoName, req);
    if (method === 'DELETE') return deleteRepoH(vault, owner, repoName);
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'branches') {
    if (rest.length === 1) return method === 'GET' ? listBranches(vault, owner, repoName) : fail(404, 'Not Found');
    if (rest.length === 2) {
      return method === 'GET' ? getBranch(vault, owner, repoName, decodeURIComponent(rest[1] as string)) : fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'commits') {
    if (rest.length === 1) return method === 'GET' ? listCommits(vault, owner, repoName, req) : fail(404, 'Not Found');
    if (rest.length === 2 && /^[0-9a-f]{40}$/.test(rest[1] as string)) {
      return method === 'GET' ? getCommit(vault, owner, repoName, rest[1] as string) : fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) return method === 'POST' ? createRef(vault, owner, repoName, req) : fail(404, 'Not Found');
    if (rest.length >= 3) {
      return method === 'GET'
        ? getRef(vault, owner, repoName, decodeURIComponent(rest.slice(2).join('/')))
        : fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (filePath === '') {
      return method === 'GET' ? getContents(vault, owner, repoName, '', req) : fail(404, 'Not Found');
    }
    const decoded = decodeURIComponent(filePath);
    if (method === 'GET') return getContents(vault, owner, repoName, decoded, req);
    if (method === 'PUT') return putContents(vault, owner, repoName, decoded, req);
    if (method === 'DELETE') return deleteContents(vault, owner, repoName, decoded, req);
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'labels') {
    if (rest.length !== 1) return fail(404, 'Not Found');
    if (method === 'GET') return listLabels(vault, owner, repoName);
    if (method === 'POST') return createLabel(vault, owner, repoName, req);
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(vault, owner, repoName, req);
      if (method === 'POST') return createIssue(vault, owner, repoName, req);
      return fail(404, 'Not Found');
    }
    if (rest.length === 2 && /^\d+$/.test(rest[1] as string)) {
      const number = Number(rest[1]);
      if (method === 'GET') return getIssue(vault, owner, repoName, number);
      if (method === 'PATCH') return patchIssue(vault, owner, repoName, number, req);
      return fail(404, 'Not Found');
    }
    if (rest.length === 3 && /^\d+$/.test(rest[1] as string) && rest[2] === 'comments') {
      const number = Number(rest[1]);
      if (method === 'GET') return listComments(vault, owner, repoName, number);
      if (method === 'POST') return createComment(vault, owner, repoName, number, req);
      return fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(vault, owner, repoName, req);
      if (method === 'POST') return createPull(vault, owner, repoName, req);
      return fail(404, 'Not Found');
    }
    if (rest.length === 2 && /^\d+$/.test(rest[1] as string)) {
      return method === 'GET' ? getPull(vault, owner, repoName, Number(rest[1])) : fail(404, 'Not Found');
    }
    if (rest.length === 3 && /^\d+$/.test(rest[1] as string) && rest[2] === 'files') {
      return method === 'GET' ? listPullFiles(vault, owner, repoName, Number(rest[1])) : fail(404, 'Not Found');
    }
    if (rest.length === 3 && /^\d+$/.test(rest[1] as string) && rest[2] === 'merge') {
      return method === 'PUT' ? mergePull(vault, owner, repoName, Number(rest[1]), req) : fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }
  return fail(404, 'Not Found');
}
