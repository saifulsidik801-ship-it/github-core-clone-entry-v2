// GraphQL v4: a small parser for the documents gh and github-mcp-server
// actually send, an executor over the vault, and the introspection those
// clients use for feature detection. No library: the wire is POST
// /api/graphql with a JSON {query, variables} body (or a JSON array of
// operations for batching), answered {data, errors} at HTTP 200 — a
// GraphQL-level failure is never an HTTP error. Unauthenticated is a 401.

import {
  clearIssueCache, createIssueRec, createPullRec, diffMaps, filesAt, mergeableState, commonBase,
  addCommentRec, squashMerge, type IssueRec, type PullRec, type RepoRec, type Vault,
} from './vault.ts';
import { ISO_NOW, VIEWER } from './seed.ts';

// ---------------------------------------------------------------- values

export type ValNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValNode }[] };

export interface Directive {
  name: string;
  args: { name: string; value: ValNode }[];
}

export interface FieldSel {
  kind: 'Field';
  alias?: string;
  name: string;
  args: { name: string; value: ValNode }[];
  directives: Directive[];
  selection?: SelNode[];
}

export type SelNode =
  | FieldSel
  | { kind: 'Spread'; name: string; directives: Directive[] }
  | { kind: 'Inline'; typeCondition?: string; directives: Directive[]; selection: SelNode[] };

export interface OpNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValNode }[];
  selection: SelNode[];
}

export interface FragNode {
  name: string;
  typeCondition: string;
  selection: SelNode[];
}

export interface DocNode {
  operations: OpNode[];
  fragments: Map<string, FragNode>;
}

interface Tok {
  kind: 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';
  value: string;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      toks.push({ kind: 'Punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1] as string;
          if (esc === 'u' && i + 5 < src.length) {
            value += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += ESCAPES[esc] ?? esc;
            i += 2;
          }
        } else {
          value += src[i];
          i++;
        }
      }
      i++;
      toks.push({ kind: 'String', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] as string)) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j++;
      }
      toks.push({ kind: isFloat ? 'Float' : 'Int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j++;
      toks.push({ kind: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  toks.push({ kind: 'EOF', value: '' });
  return toks;
}

interface Cursor {
  toks: Tok[];
  at: number;
}

function peek(c: Cursor): Tok {
  return c.toks[c.at] as Tok;
}

function take(c: Cursor): Tok {
  const t = c.toks[c.at] as Tok;
  c.at++;
  return t;
}

function wantPunct(c: Cursor, v: string): void {
  const t = take(c);
  if (t.kind !== 'Punct' || t.value !== v) {
    throw new Error(`Expected "${v}" in GraphQL document, got ${JSON.stringify(t.value)}`);
  }
}

function wantName(c: Cursor, v?: string): string {
  const t = take(c);
  if (t.kind !== 'Name' || (v !== undefined && t.value !== v)) {
    throw new Error(`Expected name ${v ?? ''} in GraphQL document, got ${JSON.stringify(t.value)}`);
  }
  return t.value;
}

function parseVal(c: Cursor): ValNode {
  const t = take(c);
  if (t.kind === 'Punct' && t.value === '$') return { kind: 'Variable', name: wantName(c) };
  if (t.kind === 'String') return { kind: 'String', value: t.value };
  if (t.kind === 'Int') return { kind: 'Int', value: Number(t.value) };
  if (t.kind === 'Float') return { kind: 'Float', value: Number(t.value) };
  if (t.kind === 'Name') {
    if (t.value === 'true') return { kind: 'Boolean', value: true };
    if (t.value === 'false') return { kind: 'Boolean', value: false };
    if (t.value === 'null') return { kind: 'Null' };
    return { kind: 'Enum', value: t.value };
  }
  if (t.kind === 'Punct' && t.value === '[') {
    const values: ValNode[] = [];
    while (!(peek(c).kind === 'Punct' && peek(c).value === ']')) values.push(parseVal(c));
    take(c);
    return { kind: 'List', values };
  }
  if (t.kind === 'Punct' && t.value === '{') {
    const fields: { name: string; value: ValNode }[] = [];
    while (!(peek(c).kind === 'Punct' && peek(c).value === '}')) {
      const name = wantName(c);
      wantPunct(c, ':');
      fields.push({ name, value: parseVal(c) });
    }
    take(c);
    return { kind: 'Object', fields };
  }
  throw new Error(`Unexpected value ${JSON.stringify(t.value)} in GraphQL document`);
}

function parseArgs(c: Cursor): { name: string; value: ValNode }[] {
  const args: { name: string; value: ValNode }[] = [];
  if (peek(c).kind === 'Punct' && peek(c).value === '(') {
    take(c);
    while (!(peek(c).kind === 'Punct' && peek(c).value === ')')) {
      const name = wantName(c);
      wantPunct(c, ':');
      args.push({ name, value: parseVal(c) });
    }
    take(c);
  }
  return args;
}

function parseDirectives(c: Cursor): Directive[] {
  const out: Directive[] = [];
  while (peek(c).kind === 'Punct' && peek(c).value === '@') {
    take(c);
    out.push({ name: wantName(c), args: parseArgs(c) });
  }
  return out;
}

function parseType(c: Cursor): void {
  if (peek(c).kind === 'Punct' && peek(c).value === '[') {
    take(c);
    parseType(c);
    wantPunct(c, ']');
  } else {
    wantName(c);
  }
  if (peek(c).kind === 'Punct' && peek(c).value === '!') take(c);
}

function parseSelSet(c: Cursor): SelNode[] {
  wantPunct(c, '{');
  const out: SelNode[] = [];
  while (!(peek(c).kind === 'Punct' && peek(c).value === '}')) out.push(parseSel(c));
  take(c);
  return out;
}

function parseSel(c: Cursor): SelNode {
  if (peek(c).kind === 'Punct' && peek(c).value === '...') {
    take(c);
    if (peek(c).kind === 'Name') {
      if (peek(c).value === 'on') {
        take(c);
        const typeCondition = wantName(c);
        const directives = parseDirectives(c);
        return { kind: 'Inline', typeCondition, directives, selection: parseSelSet(c) };
      }
      const name = take(c).value;
      return { kind: 'Spread', name, directives: parseDirectives(c) };
    }
    const directives = parseDirectives(c);
    return { kind: 'Inline', directives, selection: parseSelSet(c) };
  }
  const first = wantName(c);
  let alias: string | undefined;
  let name = first;
  if (peek(c).kind === 'Punct' && peek(c).value === ':') {
    take(c);
    alias = first;
    name = wantName(c);
  }
  const args = parseArgs(c);
  const directives = parseDirectives(c);
  let selection: SelNode[] | undefined;
  if (peek(c).kind === 'Punct' && peek(c).value === '{') selection = parseSelSet(c);
  return { kind: 'Field', alias, name, args, directives, selection };
}

function parseVarDefs(c: Cursor): { name: string; defaultValue?: ValNode }[] {
  const out: { name: string; defaultValue?: ValNode }[] = [];
  if (peek(c).kind === 'Punct' && peek(c).value === '(') {
    take(c);
    while (!(peek(c).kind === 'Punct' && peek(c).value === ')')) {
      wantPunct(c, '$');
      const name = wantName(c);
      wantPunct(c, ':');
      parseType(c);
      let defaultValue: ValNode | undefined;
      if (peek(c).kind === 'Punct' && peek(c).value === '=') {
        take(c);
        defaultValue = parseVal(c);
      }
      out.push({ name, defaultValue });
    }
    take(c);
  }
  return out;
}

/** Parse a GraphQL document string into an AST. Throws on syntax errors. */
export function parseDoc(src: string): DocNode {
  const c: Cursor = { toks: lex(src), at: 0 };
  const operations: OpNode[] = [];
  const fragments = new Map<string, FragNode>();
  while (peek(c).kind !== 'EOF') {
    if (peek(c).kind === 'Punct' && peek(c).value === '{') {
      operations.push({ kind: 'query', variables: [], selection: parseSelSet(c) });
      continue;
    }
    const keyword = wantName(c);
    if (keyword === 'query' || keyword === 'mutation') {
      let name: string | undefined;
      if (peek(c).kind === 'Name') name = take(c).value;
      const variables = parseVarDefs(c);
      operations.push({ kind: keyword, name, variables, selection: parseSelSet(c) });
    } else if (keyword === 'fragment') {
      const name = wantName(c);
      wantName(c, 'on');
      const typeCondition = wantName(c);
      fragments.set(name, { name, typeCondition, selection: parseSelSet(c) });
    } else {
      throw new Error(`Unexpected definition ${JSON.stringify(keyword)} in GraphQL document`);
    }
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- schema tables

/** The field names each object type holds (for validation and introspection). */
const FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', '__typename'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt', '__typename'],
  Ref: ['name', 'target', '__typename'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'repository', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', '__typename'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'repository', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommitSha', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFileEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', '__typename'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'url', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueCommentEdge: ['node', 'cursor', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  SearchResultItemEdge: ['node', 'cursor', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL', '__typename'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', '__typename'],
  Commit: ['oid', 'message', '__typename'],
};

const ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
};

const INPUTS: Record<string, readonly string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitHeadline', 'commitBody', 'expectedHeadOid', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
  PullRequestOrder: ['field', 'direction'],
};

// ---------------------------------------------------------------- global ids

/** Global ids are opaque base64 of a typed tag: never a bare database id. */
export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts.some((p) => p === '')) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- node builders

export interface GqlCtx {
  vault: Vault;
  variables: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

type Resolve = (args: Record<string, unknown>, ctx: GqlCtx) => unknown;

function userObj(): Record<string, unknown> {
  return {
    __typename: 'User',
    id: gid('User', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER.id}`,
    url: `https://api.github.com/users/${VIEWER.login}`,
  };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorAt(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const index = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(index) && index >= 0 ? index : null;
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: number;
  after?: string;
}

function connect<T>(items: readonly T[], args: PageArgs, connType: string, edgeType: string): Record<string, unknown> {
  const after = args.after ? cursorAt(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const first = args.first ?? items.length;
  const slice = items.slice(start, start + Math.max(0, first));
  const edges = slice.map((node, i) => ({ __typename: edgeType, node, cursor: cursorOf(start + i) }));
  return {
    __typename: connType,
    nodes: slice,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length ? (edges[0] as { cursor: string }).cursor : null,
      endCursor: edges.length ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
    },
    totalCount: items.length,
  };
}

function repoObj(vault: Vault, repo: RepoRec): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const node: Record<string, unknown> = {
    __typename: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObj(),
    description: repo.description,
    private: repo.isPrivate,
    defaultBranchRef: tip
      ? { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip, message: '' } }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
  };
  node.issue = ((args: Record<string, unknown>): unknown => {
    const issue = repo.issues.get(args.number as number);
    return issue ? issueObj(vault, repo, issue) : null;
  }) as Resolve;
  node.issues = ((args: Record<string, unknown>): unknown => {
    let issues = [...repo.issues.values()];
    const states = (args.states as string[] | undefined) ?? ['OPEN'];
    issues = issues.filter((i) => states.includes(i.state.toUpperCase()));
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction ?? 'DESC';
    issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    return connect(issues.map((i) => issueObj(vault, repo, i)), args as PageArgs, 'IssueConnection', 'IssueEdge');
  }) as Resolve;
  node.pullRequest = ((args: Record<string, unknown>): unknown => {
    const pull = repo.pulls.get(args.number as number);
    return pull ? pullObj(vault, repo, pull) : null;
  }) as Resolve;
  node.pullRequests = ((args: Record<string, unknown>): unknown => {
    let pulls = [...repo.pulls.values()];
    const states = args.states as string[] | undefined;
    if (states) {
      pulls = pulls.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
    } else {
      pulls = pulls.filter((p) => p.state === 'open');
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction ?? 'DESC';
    pulls.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    return connect(pulls.map((p) => pullObj(vault, repo, p)), args as PageArgs, 'PullRequestConnection', 'PullRequestEdge');
  }) as Resolve;
  return node;
}

function issueObj(vault: Vault, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const node: Record<string, unknown> = {
    __typename: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: repoObj(vault, repo),
    author: userObj(),
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    closedAt: issue.state === 'closed' ? ISO_NOW : null,
  };
  node.comments = ((args: Record<string, unknown>): unknown => {
    const comments = repo.comments.get(issue.number) ?? [];
    return connect(
      comments.map((c) => ({
        __typename: 'IssueComment',
        id: gid('IssueComment', repo.id, issue.number, c.id),
        databaseId: c.id,
        body: c.body,
        author: userObj(),
        createdAt: ISO_NOW,
        url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
      })),
      args as PageArgs,
      'IssueCommentConnection',
      'IssueCommentEdge',
    );
  }) as Resolve;
  return node;
}

function pullObj(vault: Vault, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const node: Record<string, unknown> = {
    __typename: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: mergeableState(repo, pull.headSha, pull.baseSha),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    repository: repoObj(vault, repo),
    author: userObj(),
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    mergedAt: pull.mergedAt,
    mergeCommitSha: pull.mergeCommitSha,
  };
  node.files = ((args: Record<string, unknown>): unknown => {
    const base = commonBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const changes = diffMaps(repo, filesAt(repo, base), filesAt(repo, pull.headSha));
    return connect(
      changes.map((c) => ({
        __typename: 'PullRequestChangedFile',
        path: c.path,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.changes,
      })),
      args as PageArgs,
      'PullRequestChangedFileConnection',
      'PullRequestChangedFileEdge',
    );
  }) as Resolve;
  return node;
}

function commentObj(vault: Vault, repo: RepoRec, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  void vault;
  return {
    __typename: 'IssueComment',
    id: gid('IssueComment', repo.id, issueNumber, comment.id),
    databaseId: comment.id,
    body: comment.body,
    author: userObj(),
    createdAt: ISO_NOW,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------- introspection

function fieldObj(name: string): Record<string, unknown> {
  return {
    __typename: '__Field',
    name,
    description: null,
    args: [],
    type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
    isDeprecated: false,
    deprecationReason: null,
  };
}

function enumObj(name: string): Record<string, unknown> {
  return { __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null };
}

function typeObj(name: string): Record<string, unknown> | null {
  if (FIELDS[name]) {
    const node: Record<string, unknown> = {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      description: null,
      interfaces: [],
      possibleTypes: null,
      ofType: null,
      specifiedByURL: null,
    };
    node.fields = (() => FIELDS[name]?.map((f) => fieldObj(f)) ?? []) as Resolve;
    node.enumValues = (() => null) as Resolve;
    node.inputFields = (() => null) as Resolve;
    return node;
  }
  if (ENUMS[name]) {
    const node: Record<string, unknown> = {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      interfaces: [],
      possibleTypes: null,
      ofType: null,
      specifiedByURL: null,
    };
    node.fields = (() => null) as Resolve;
    node.enumValues = (() => ENUMS[name]?.map((v) => enumObj(v)) ?? []) as Resolve;
    node.inputFields = (() => null) as Resolve;
    return node;
  }
  if (INPUTS[name]) {
    const node: Record<string, unknown> = {
      __typename: '__Type',
      name,
      kind: 'INPUT_OBJECT',
      description: null,
      interfaces: [],
      possibleTypes: null,
      ofType: null,
      specifiedByURL: null,
    };
    node.fields = (() => null) as Resolve;
    node.enumValues = (() => null) as Resolve;
    node.inputFields = (() =>
      INPUTS[name]?.map((f) => ({
        __typename: '__InputValue',
        name: f,
        description: null,
        type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
        defaultValue: null,
      })) ?? []) as Resolve;
    return node;
  }
  return null;
}

function schemaObj(): Record<string, unknown> {
  return {
    __typename: '__Schema',
    types: [
      ...Object.keys(FIELDS).map((name) => ({ __typename: '__Type', name, kind: 'OBJECT' })),
      ...Object.keys(ENUMS).map((name) => ({ __typename: '__Type', name, kind: 'ENUM' })),
      ...Object.keys(INPUTS).map((name) => ({ __typename: '__Type', name, kind: 'INPUT_OBJECT' })),
    ],
    queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
    mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
    subscriptionType: null,
    directives: [],
  };
}

// ---------------------------------------------------------------- executor

function valOf(node: ValNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': {
      const v = vars[node.name];
      return v === undefined ? null : v;
    }
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((item) => valOf(item, vars));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valOf(f.value, vars);
      return out;
    }
  }
}

function argsOf(field: FieldSel, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valOf(a.value, vars);
  return out;
}

function skipBy(directives: Directive[], vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const args: Record<string, unknown> = {};
    for (const a of d.args) args[a.name] = valOf(a.value, vars);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if !== true) return true;
  }
  return false;
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

function runSelection(
  parent: unknown,
  parentType: string,
  sels: SelNode[],
  ctx: GqlCtx,
  doc: DocNode,
  path: (string | number)[],
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'Spread') {
      const frag = doc.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      if (skipBy(sel.directives, ctx.variables)) continue;
      const sub = runSelection(parent, parentType, frag.selection, ctx, doc, path);
      if (sub) deepMerge(out, sub);
      continue;
    }
    if (sel.kind === 'Inline') {
      if (skipBy(sel.directives, ctx.variables)) continue;
      const typeName = (parent as Record<string, unknown>).__typename as string | undefined;
      if (sel.typeCondition && sel.typeCondition !== typeName && sel.typeCondition !== parentType) continue;
      const sub = runSelection(parent, parentType, sel.selection, ctx, doc, path);
      if (sub) deepMerge(out, sub);
      continue;
    }
    if (skipBy(sel.directives, ctx.variables)) continue;
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const fields = FIELDS[parentType];
    if (!fields || !fields.includes(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const raw = (parent as Record<string, unknown>)[sel.name];
    let value: unknown;
    if (typeof raw === 'function') {
      try {
        value = (raw as Resolve)(argsOf(sel, ctx.variables), ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
        out[key] = null;
        continue;
      }
    } else {
      value = raw;
    }
    if (sel.selection) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (item === null || typeof item !== 'object') return item;
          const child = (item as Record<string, unknown>).__typename as string | undefined;
          return runSelection(item, child ?? parentType, sel.selection as SelNode[], ctx, doc, fieldPath);
        });
      } else if (typeof value === 'object') {
        const child = (value as Record<string, unknown>).__typename as string | undefined;
        out[key] = runSelection(value, child ?? parentType, sel.selection, ctx, doc, fieldPath);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function repoById(vault: Vault, id: number): RepoRec | undefined {
  for (const r of vault.repos.values()) if (r.id === id) return r;
  return undefined;
}

function queryRoot(vault: Vault): Record<string, unknown> {
  const root: Record<string, unknown> = {
    __typename: 'Query',
    viewer: userObj(),
  };
  root.repository = ((args: Record<string, unknown>): unknown => {
    if (args.owner !== vault.viewer) return null;
    const repo = vault.repos.get(args.name as string);
    return repo ? repoObj(vault, repo) : null;
  }) as Resolve;
  root.node = ((args: Record<string, unknown>): unknown => {
    const parsed = ungid(args.id as string);
    if (!parsed) return null;
    if (parsed.kind === 'Repository') {
      const repo = repoById(vault, Number(parsed.parts[0]));
      return repo ? repoObj(vault, repo) : null;
    }
    if (parsed.kind === 'User' && Number(parsed.parts[0]) === VIEWER.id) return userObj();
    if (parsed.kind === 'Issue') {
      const repo = repoById(vault, Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      return repo && issue ? issueObj(vault, repo, issue) : null;
    }
    if (parsed.kind === 'PullRequest') {
      const repo = repoById(vault, Number(parsed.parts[0]));
      const pull = repo?.pulls.get(Number(parsed.parts[1]));
      return repo && pull ? pullObj(vault, repo, pull) : null;
    }
    if (parsed.kind === 'IssueComment') {
      const repo = repoById(vault, Number(parsed.parts[0]));
      const comments = repo?.comments.get(Number(parsed.parts[1])) ?? [];
      const comment = comments.find((c) => c.id === Number(parsed.parts[2]));
      return repo && comment ? commentObj(vault, repo, Number(parsed.parts[1]), comment) : null;
    }
    return null;
  }) as Resolve;
  root.search = ((args: Record<string, unknown>): unknown => {
    const query = String(args.query ?? '').toLowerCase();
    const type = args.type as string | undefined;
    const nodes: unknown[] = [];
    if (!type || type === 'ISSUE') {
      for (const repo of vault.repos.values()) {
        for (const issue of repo.issues.values()) {
          if (query === '' || issue.title.toLowerCase().includes(query) || issue.body.toLowerCase().includes(query)) {
            nodes.push(issueObj(vault, repo, issue));
          }
        }
      }
    }
    return connect(nodes, args as PageArgs, 'SearchResultItemConnection', 'SearchResultItemEdge');
  }) as Resolve;
  root.__type = ((args: Record<string, unknown>): unknown => typeObj(args.name as string)) as Resolve;
  root.__schema = (() => schemaObj()) as Resolve;
  return root;
}

function mutationRoot(vault: Vault): Record<string, unknown> {
  const root: Record<string, unknown> = { __typename: 'Mutation' };
  root.createIssue = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = ungid(input.repositoryId as string);
    if (!parsed || parsed.kind !== 'Repository') throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const repo = repoById(vault, Number(parsed.parts[0]));
    if (!repo) throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const title = input.title as string | undefined;
    if (!title) throw new Error('title is required');
    const issue = createIssueRec(vault, repo, title, (input.body as string | undefined) ?? '', []);
    return { __typename: 'CreateIssuePayload', issue: issueObj(vault, repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolve;
  root.closeIssue = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = ungid(input.issueId as string);
    if (!parsed || parsed.kind !== 'Issue') throw new Error(`Could not resolve to an Issue with the id of '${String(input.issueId)}'.`);
    const repo = repoById(vault, Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    if (!repo || !issue) throw new Error(`Could not resolve to an Issue with the id of '${String(input.issueId)}'.`);
    issue.state = 'closed';
    clearIssueCache(issue);
    return { __typename: 'CloseIssuePayload', issue: issueObj(vault, repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolve;
  root.createPullRequest = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = ungid(input.repositoryId as string);
    if (!parsed || parsed.kind !== 'Repository') throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const repo = repoById(vault, Number(parsed.parts[0]));
    if (!repo) throw new Error(`Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.`);
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const title = input.title as string | undefined;
    if (!headRef || !baseRef || !title) throw new Error('headRefName, baseRefName and title are required');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha) throw new Error(`Head branch "${headRef}" does not exist`);
    if (!baseSha) throw new Error(`Base branch "${baseRef}" does not exist`);
    const pull = createPullRec(vault, repo, title, (input.body as string | undefined) ?? '', headRef, baseRef, headSha, baseSha);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(vault, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolve;
  root.mergePullRequest = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = ungid(input.pullRequestId as string);
    if (!parsed || parsed.kind !== 'PullRequest') throw new Error(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.`);
    const repo = repoById(vault, Number(parsed.parts[0]));
    const pull = repo?.pulls.get(Number(parsed.parts[1]));
    if (!repo || !pull) throw new Error(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.`);
    if (pull.merged) {
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(vault, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
    }
    const merged = squashMerge(repo, pull);
    if (!merged.ok) throw new Error(merged.why);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(vault, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }) as Resolve;
  root.addComment = ((args: Record<string, unknown>): unknown => {
    const input = args.input as Record<string, unknown>;
    const parsed = ungid(input.subjectId as string);
    if (!parsed || parsed.kind !== 'Issue') throw new Error(`Could not resolve to an Issue with the id of '${String(input.subjectId)}'.`);
    const repo = repoById(vault, Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    if (!repo || !issue) throw new Error(`Could not resolve to an Issue with the id of '${String(input.subjectId)}'.`);
    const body = input.body as string | undefined;
    if (!body) throw new Error('body is required');
    const comment = addCommentRec(repo, issue.number, body);
    const list = repo.comments.get(issue.number) ?? [];
    const node = commentObj(vault, repo, issue.number, comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorOf(list.length - 1) },
      subject: issueObj(vault, repo, issue),
      clientMutationId: (input.clientMutationId as string | undefined) ?? null,
    };
  }) as Resolve;
  return root;
}

export interface GqlOp {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GqlOut {
  data: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

function runOp(vault: Vault, op: GqlOp): GqlOut {
  let doc: DocNode;
  try {
    doc = parseDoc(op.query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const variables: Record<string, unknown> = { ...(op.variables ?? {}) };
  let selected: OpNode | undefined;
  if (doc.operations.length === 1) {
    selected = doc.operations[0];
  } else if (op.operationName) {
    selected = doc.operations.find((item) => item.name === op.operationName);
    if (!selected) {
      return { data: null, errors: [{ message: `Unknown operation named "${op.operationName}".` }] };
    }
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  for (const v of selected.variables) {
    if (variables[v.name] === undefined && v.defaultValue !== undefined) {
      variables[v.name] = valOf(v.defaultValue, variables);
    }
  }
  const ctx: GqlCtx = { vault, variables, errors: [] };
  const root = selected.kind === 'mutation' ? mutationRoot(vault) : queryRoot(vault);
  const rootType = selected.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = runSelection(root, rootType, selected.selection, ctx, doc, []);
  const result: GqlOut = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------- dispatcher

export interface GqlReq {
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
}

export interface GqlRes {
  status: number;
  body: unknown;
}

function authToken(headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers['authorization'];
  const value = Array.isArray(h) ? h.join(', ') : (h ?? '');
  if (!value || !value.toLowerCase().startsWith('bearer ')) return null;
  const token = value.slice('bearer '.length).trim();
  return token === '' ? null : token;
}

/** Route one GraphQL request: a single operation or a batched array of them. */
export function handleGraphQL(vault: Vault, req: GqlReq): GqlRes {
  if (!authToken(req.headers)) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => {
      if (item === null || typeof item !== 'object' || typeof (item as { query?: unknown }).query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] } as GqlOut;
      }
      return runOp(vault, item as GqlOp);
    });
    return { status: 200, body: results };
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { query?: unknown }).query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'No query provided.' }] } };
  }
  return { status: 200, body: runOp(vault, parsed as GqlOp) };
}
