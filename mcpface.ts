// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp. Modern revision
// 2026-07-28 first (server/discover, no session), the legacy initialize
// handshake as fallback. Tools act on the same vault as REST, so a repository
// or issue created over MCP is the same object over REST, with the same ids.
// Every request answers inside its own JSON-RPC id; a tool failure is
// isError:true, never an HTTP 500; no Authorization header is a 401.

import {
  addCommentRec, clearIssueCache, createIssueRec, createPullRec, newRepo, repoNamed, reposSorted,
  setRef, squashMerge, type IssueRec, type PullRec, type RepoRec, type Vault,
} from './vault.ts';
import { ISO_NOW, VIEWER } from './seed.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
  additionalProperties: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

function schema(props: Record<string, { type: string; description: string; enum?: string[] }>, required: string[]): ToolSchema {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

const OWNER_PROP = { type: 'string', description: 'The repository owner login.' };
const REPO_PROP = { type: 'string', description: 'The repository name.' };
const FULL_PROP = { type: 'string', description: 'The repository full name, owner/repo.' };

const TOOLS: Tool[] = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: schema({
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
  }, ['name']) },
  { name: 'get_repo', description: 'Get one repository by owner and name.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
  }, ['repo']) },
  { name: 'list_repos', description: 'List the authenticated user’s repositories.', inputSchema: schema({}, []) },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
    labels: { type: 'string', description: 'Comma-separated label names (each must already exist).' },
  }, ['owner', 'repo', 'title']) },
  { name: 'get_issue', description: 'Get one issue by repository and number.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    number: { type: 'number', description: 'The issue number.' },
    issue_number: { type: 'number', description: 'The issue number.' },
  }, ['repo', 'number']) },
  { name: 'list_issues', description: 'List the issues of a repository, optionally filtered by state.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']) },
  { name: 'close_issue', description: 'Close an issue in a repository.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    number: { type: 'number', description: 'The issue number.' },
    issue_number: { type: 'number', description: 'The issue number.' },
  }, ['repo', 'number']) },
  { name: 'create_pull_request', description: 'Open a pull request from a head branch into a base branch.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']) },
  { name: 'get_pull_request', description: 'Get one pull request by repository and number.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    pull_number: { type: 'number', description: 'The pull request number.' },
    number: { type: 'number', description: 'The pull request number.' },
  }, ['repo', 'pull_number']) },
  { name: 'list_pull_requests', description: 'List the pull requests of a repository, optionally filtered by state.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']) },
  { name: 'merge_pull_request', description: 'Squash-merge a pull request into its base branch.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    pull_number: { type: 'number', description: 'The pull request number.' },
    number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']) },
  { name: 'create_branch', description: 'Create a branch at an existing commit.', inputSchema: schema({
    owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_PROP,
    branch: { type: 'string', description: 'The new branch name.' },
    sha: { type: 'string', description: 'The commit the branch starts at.' },
  }, ['repo', 'branch', 'sha']) },
];

const ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

function squish(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a requested tool name to its canonical definition (prefix or alias). */
function lookupTool(name: string): Tool | null {
  const wanted = squish(name);
  for (const tool of TOOLS) {
    if (squish(tool.name) === wanted) return tool;
    const alias = ALIASES[squish(name)];
    if (alias && tool.name === alias) return tool;
  }
  for (const tool of TOOLS) {
    const normalized = squish(tool.name);
    if (wanted.length > normalized.length && wanted.endsWith(normalized)) return tool;
  }
  return null;
}

// ---------------------------------------------------------------- tool results

function repoOut(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ISO_NOW,
    updated_at: ISO_NOW,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

function issueOut(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: ISO_NOW,
    updated_at: ISO_NOW,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullOut(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: ISO_NOW,
    updated_at: ISO_NOW,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

type Outcome = { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean };

function okOut(value: unknown): Outcome {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value };
}

function errOut(message: string): Outcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = args[name];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function numArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const v = args[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function resolveTarget(vault: Vault, args: Record<string, unknown>): { repo: RepoRec } | { error: string } {
  let owner = strArg(args, 'owner', 'owner_login', 'login');
  let repoName = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
  const full = strArg(args, 'full_name', 'repo_full_name', 'repository_full_name');
  if ((!owner || !repoName) && full && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    owner = owner ?? o;
    repoName = repoName ?? r;
  }
  owner = owner ?? vault.viewer;
  if (!repoName) return { error: 'Missing required argument: repo' };
  if (owner !== vault.viewer) return { error: `Repository ${owner}/${repoName} not found` };
  const repo = repoNamed(vault, repoName);
  if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
  return { repo };
}

function runTool(vault: Vault, name: string, args: Record<string, unknown>): Outcome {
  const tool = lookupTool(name);
  if (!tool) return errOut(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errOut(`Missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name', 'repo', 'repository');
      if (!repoName) return errOut('Missing required argument: name');
      const repo = newRepo(vault, repoName, strArg(args, 'description') ?? '', args.private === true || args.is_private === true);
      if (!repo) return errOut(`Repository ${repoName} already exists`);
      return okOut(repoOut(repo));
    }
    case 'get_repo': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      return okOut(repoOut(resolved.repo));
    }
    case 'list_repos': {
      return okOut(reposSorted(vault).map((repo) => repoOut(repo)));
    }
    case 'create_issue': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const repo = resolved.repo;
      const title = strArg(args, 'title', 'issue_title', 'subject');
      if (!title) return errOut('Missing required argument: title');
      const body = strArg(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment') ?? '';
      const labelsRaw = strArg(args, 'labels');
      const labels = labelsRaw ? labelsRaw.split(',').map((l) => l.trim()).filter((l) => l !== '') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return errOut(`Label "${label}" does not exist`);
      }
      const issue = createIssueRec(vault, repo, title, body, labels);
      return okOut(issueOut(repo, issue));
    }
    case 'get_issue': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const number = numArg(args, 'number', 'issue_number');
      if (number === undefined) return errOut('Missing required argument: number');
      const issue = resolved.repo.issues.get(number);
      if (!issue) return errOut(`Issue #${number} not found`);
      return okOut(issueOut(resolved.repo, issue));
    }
    case 'list_issues': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const state = strArg(args, 'state', 'status') ?? 'open';
      const issues = [...resolved.repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((i) => issueOut(resolved.repo, i));
      return okOut(issues);
    }
    case 'close_issue': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const number = numArg(args, 'number', 'issue_number');
      if (number === undefined) return errOut('Missing required argument: number');
      const issue = resolved.repo.issues.get(number);
      if (!issue) return errOut(`Issue #${number} not found`);
      issue.state = 'closed';
      clearIssueCache(issue);
      return okOut(issueOut(resolved.repo, issue));
    }
    case 'create_pull_request': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const repo = resolved.repo;
      const title = strArg(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const head = strArg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from', 'from_branch', 'branch');
      const base = strArg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into', 'into_branch');
      if (!title) return errOut('Missing required argument: title');
      if (!head) return errOut('Missing required argument: head');
      if (!base) return errOut('Missing required argument: base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return errOut(`Head branch "${head}" does not exist`);
      if (!baseSha) return errOut(`Base branch "${base}" does not exist`);
      const pull = createPullRec(vault, repo, title, strArg(args, 'body', 'description', 'content', 'text') ?? '', head, base, headSha, baseSha);
      return okOut(pullOut(repo, pull));
    }
    case 'get_pull_request': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const number = numArg(args, 'pull_number', 'number', 'pr_number');
      if (number === undefined) return errOut('Missing required argument: pull_number');
      const pull = resolved.repo.pulls.get(number);
      if (!pull) return errOut(`Pull request #${number} not found`);
      return okOut(pullOut(resolved.repo, pull));
    }
    case 'list_pull_requests': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const state = strArg(args, 'state', 'status') ?? 'open';
      const pulls = [...resolved.repo.pulls.values()]
        .filter((p) => state === 'all' || p.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((p) => pullOut(resolved.repo, p));
      return okOut(pulls);
    }
    case 'merge_pull_request': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const repo = resolved.repo;
      const number = numArg(args, 'pull_number', 'number', 'pr_number', 'pull_request_number');
      if (number === undefined) return errOut('Missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (!pull) return errOut(`Pull request #${number} not found`);
      if (pull.merged) return okOut(pullOut(repo, pull));
      const merged = squashMerge(repo, pull);
      if (!merged.ok) return errOut(merged.why);
      return okOut(pullOut(repo, pull));
    }
    case 'create_branch': {
      const resolved = resolveTarget(vault, args);
      if ('error' in resolved) return errOut(resolved.error);
      const repo = resolved.repo;
      const branch = strArg(args, 'branch', 'ref', 'head', 'name');
      const sha = strArg(args, 'sha');
      if (!branch) return errOut('Missing required argument: branch');
      if (!sha) return errOut('Missing required argument: sha');
      if (!repo.objects.has(sha)) return errOut('Object does not exist');
      if (repo.refs.has(`refs/heads/${branch}`)) return errOut(`Branch "${branch}" already exists`);
      setRef(repo, `refs/heads/${branch}`, sha);
      return okOut({ ref: `refs/heads/${branch}`, sha });
    }
    default:
      return errOut(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

export interface McpReq {
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
}

export interface McpRes {
  status: number;
  body: unknown;
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleOne(vault: Vault, parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { method?: unknown }).method !== 'string') {
    return failure(null, -32600, 'Invalid Request');
  }
  const body = parsed as { jsonrpc?: unknown; id?: unknown; method: string; params?: Record<string, unknown> };
  const id = body.id === undefined ? null : body.id;
  const isNotification = body.id === undefined;
  const params = (body.params ?? {}) as Record<string, unknown>;
  switch (body.method) {
    case 'server/discover': {
      return result(id, {
        supportedVersions: [...VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = VERSIONS.includes(requested) ? requested : '2026-07-28';
      return result(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      return null;
    }
    case 'ping': {
      return result(id, {});
    }
    case 'tools/list': {
      return result(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) return failure(id, -32602, 'Missing required argument: name');
      if (!lookupTool(name)) return failure(id, -32602, `Unknown tool: ${name}`);
      return result(id, runTool(vault, name, args));
    }
    default: {
      if (isNotification) return null;
      return failure(id, -32601, `Method not found: ${body.method}`);
    }
  }
}

/** Route one MCP request. A notification (no id) answers 202 with no body. */
export function handleMcp(vault: Vault, req: McpReq): McpRes {
  const h = req.headers['authorization'];
  const header = Array.isArray(h) ? h.join(', ') : (h ?? '');
  const token = header && header.toLowerCase().startsWith('bearer ') ? header.slice('bearer '.length).trim() : '';
  if (!token) {
    return { status: 401, body: failure(null, -32000, 'Requires authentication') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.bodyText);
  } catch {
    return { status: 400, body: failure(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => handleOne(vault, item));
    return { status: 200, body: results.filter((r) => r !== null) };
  }
  const one = handleOne(vault, parsed);
  if (one === null) return { status: 202, body: null };
  return { status: 200, body: one };
}
