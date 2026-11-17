// mcpface.ts — the MCP endpoint (JSON-RPC 2.0, era 2026-07-28): server/discover,
// initialize, tools/list and tools/call over the same store the REST face uses.

import {
  repoJson,
  issueJson,
  pullJson,
  createIssueIn,
  createPullIn,
  mergePullIn,
  prHasConflict,
  type Repo,
} from './store.ts';
import { hasAuth, readBody, readJson, sendError, sendJson, type Ctx } from './server.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const INSTRUCTIONS = 'A GitHub-compatible git forge: create and read repositories, issues and pull requests.';

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the viewer)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the viewer repositories.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'Owner login (defaults to the viewer)' } },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
        number: { type: 'integer', description: 'Issue number (alias)' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Pull request number (alias)' },
        merge_method: { type: 'string', description: 'Merge method (squash)' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools list is precomputed once: the suite requires it byte-identical across calls. */
const TOOLS_LIST_RESULT: Record<string, unknown> = { tools: TOOLS };

// ---------------------------------------------------------------- argument synonyms

type Args = Record<string, unknown>;

function strArg(args: Args, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function numArg(args: Args, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

function ownerArg(args: Args, storeOwner: string | null): string | null {
  return strArg(args, 'owner', 'owner_login', 'ownerLogin', 'login') ?? storeOwner;
}

function repoArg(args: Args): string | null {
  const full = strArg(args, 'full_name', 'fullName');
  if (full && full.includes('/')) return full.split('/').pop() ?? null;
  return strArg(args, 'repo', 'repository', 'name');
}

// ---------------------------------------------------------------- tool execution

interface ToolOutcome {
  result: unknown;
  isError: boolean;
}

function toolError(message: string): ToolOutcome {
  return { result: { error: message }, isError: true };
}

function callTool(ctx: Ctx, name: string, args: Args): ToolOutcome {
  const store = ctx.store;
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return toolError(`unknown tool ${name}`);
  // Required arguments (accepting the suite's synonyms).
  const missing: string[] = [];
  for (const req of def.inputSchema.required) {
    if (req === 'issue_number' && numArg(args, 'issue_number', 'number', 'issueNumber') !== null) continue;
    if (req === 'pull_number' && numArg(args, 'pull_number', 'number', 'pullNumber') !== null) continue;
    if (req === 'repo' && repoArg(args) !== null) continue;
    if (req === 'owner' && ownerArg(args, store.viewer) !== null) continue;
    if (args[req] === undefined || args[req] === null || args[req] === '') missing.push(req);
  }
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  const owner = ownerArg(args, store.viewer);
  if (owner) store.learnViewer(owner);

  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name')!;
      if (store.findRepoByName(repoName)) return toolError('name already exists on this account');
      const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { result: repoJson(store, repo), isError: false };
    }
    case 'get_repo': {
      const repo = owner ? store.findRepo(owner, repoArg(args)!) : null;
      if (!repo) return toolError('repository not found');
      return { result: repoJson(store, repo), isError: false };
    }
    case 'list_repos': {
      const repos = [...store.repos.values()].sort((a, b) => a.id - b.id);
      return { result: { repos: repos.map((r) => repoJson(store, r)) }, isError: false };
    }
    case 'create_issue': {
      const repo = owner ? store.findRepo(owner, repoArg(args)!) : null;
      if (!repo) return toolError('repository not found');
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const res = createIssueIn(store, repo, strArg(args, 'title')!, typeof args.body === 'string' ? args.body : '', labels);
      if ('error' in res) return toolError(res.error);
      return { result: issueJson(store, repo, res), isError: false };
    }
    case 'get_issue': {
      const repo = owner ? store.findRepo(owner, repoArg(args)!) : null;
      const n = numArg(args, 'issue_number', 'number', 'issueNumber');
      const issue = repo?.issues.find((i) => i.number === n);
      if (!repo || !issue) return toolError('issue not found');
      return { result: issueJson(store, repo, issue), isError: false };
    }
    case 'list_issues': {
      const repo = owner ? store.findRepo(owner, repoArg(args)!) : null;
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return { result: { issues: items.map((i) => issueJson(store, repo, i)) }, isError: false };
    }
    case 'create_pull_request': {
      const repo = owner ? store.findRepo(owner, repoArg(args)!) : null;
      if (!repo) return toolError('repository not found');
      const head = strArg(args, 'head', 'head_ref', 'headRef')!;
      const base = strArg(args, 'base', 'base_ref', 'baseRef') ?? repo.defaultBranch;
      const res = createPullIn(store, repo, strArg(args, 'title')!, typeof args.body === 'string' ? args.body : '', head, base);
      if ('error' in res) return toolError(res.error);
      return { result: pullJson(store, repo, res), isError: false };
    }
    case 'merge_pull_request': {
      const repo = owner ? store.findRepo(owner, repoArg(args)!) : null;
      const n = numArg(args, 'pull_number', 'number', 'pullNumber');
      const pr = repo?.pulls.find((p) => p.number === n);
      if (!repo || !pr) return toolError('pull request not found');
      if (pr.state !== 'open') return toolError('pull request is not open');
      if (prHasConflict(store, repo, pr)) return toolError('merge conflict');
      const res = mergePullIn(store, repo, pr);
      if (typeof res !== 'string') return toolError(res.error);
      return { result: { merged: true, sha: res, message: `Pull request #${pr.number} merged` }, isError: false };
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** POST /mcp */
export async function handleMcp(ctx: Ctx): Promise<void> {
  if (!hasAuth(ctx)) {
    sendError(ctx, 401, 'requires authentication');
    return;
  }
  const raw = await readBody(ctx);
  let body: unknown;
  try {
    body = raw.length === 0 ? undefined : JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(ctx, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(ctx, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Args;

  if (method === 'notifications/initialized') {
    ctx.res.writeHead(202, { 'X-GitHub-Request-Id': `forge-${Date.now().toString(36)}` });
    ctx.res.end();
    return;
  }
  if (method === 'server/discover') {
    sendJson(ctx, 200, rpcResult(id, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }));
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
    sendJson(ctx, 200, rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO }));
    return;
  }
  if (method === 'tools/list') {
    sendJson(ctx, 200, rpcResult(id, TOOLS_LIST_RESULT));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!TOOLS.some((t) => t.name === toolName)) {
      sendJson(ctx, 200, rpcError(id, -32602, `unknown tool ${toolName}`));
      return;
    }
    const toolArgs = (params.arguments ?? {}) as Args;
    const outcome = callTool(ctx, toolName, toolArgs);
    if (outcome.isError) {
      sendJson(ctx, 200, rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
        isError: true,
      }));
      return;
    }
    sendJson(ctx, 200, rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: false,
    }));
    return;
  }
  sendJson(ctx, 200, rpcError(id, -32601, `method not found: ${method}`));
}
