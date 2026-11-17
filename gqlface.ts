// gqlface.ts — a small GraphQL parser and executor for the v4 surface the suite
// exercises: viewer, repository (+ issues/pullRequests connections with cursors),
// issue/pullRequest by number, node(id), the five mutations, and __type
// introspection. No external dependency; the parser is a hand-rolled
// recursive-descent reader over the query text.

export interface GqlField {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, unknown>;
  selections: GqlSelection[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly input: string;
  constructor(input: string) {
    this.input = input;
  }

  private skipWs(): void {
    for (;;) {
      const c = this.input[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos++;
      else if (c === '#') {
        while (this.pos < this.input.length && this.input[this.pos] !== '\n') this.pos++;
      } else break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.input[this.pos] ?? '';
  }

  private consume(expected: string): void {
    this.skipWs();
    if (!this.input.startsWith(expected, this.pos)) throw new ParseError(`expected ${expected} at ${this.pos}`);
    this.pos += expected.length;
  }

  private tryConsume(expected: string): boolean {
    this.skipWs();
    if (!this.input.startsWith(expected, this.pos)) return false;
    this.pos += expected.length;
    return true;
  }

  private parseName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.input.slice(this.pos));
    if (!m) throw new ParseError(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private parseString(): string {
    this.skipWs();
    if (this.input[this.pos] !== '"') throw new ParseError(`expected string at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.input.length) {
      const c = this.input[this.pos]!;
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        const n = this.input[this.pos + 1];
        this.pos += 2;
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'u') {
          out += String.fromCharCode(parseInt(this.input.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += n ?? '';
        continue;
      }
      out += c;
      this.pos++;
    }
    throw new ParseError('unterminated string');
  }

  private parseNumber(): number {
    this.skipWs();
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.input.slice(this.pos));
    if (!m) throw new ParseError(`expected number at ${this.pos}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private parseValue(): unknown {
    this.skipWs();
    const c = this.input[this.pos];
    if (c === '"') return this.parseString();
    if (c === '[') {
      this.pos++;
      const items: unknown[] = [];
      while (!this.tryConsume(']')) {
        items.push(this.parseValue());
      }
      return items;
    }
    if (c === '{') {
      this.pos++;
      const obj: Record<string, unknown> = {};
      while (!this.tryConsume('}')) {
        const key = this.parseName();
        this.consume(':');
        obj[key] = this.parseValue();
      }
      return obj;
    }
    if (c === '$') {
      this.pos++;
      return { $var: this.parseName() };
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.parseNumber();
    const name = this.parseName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { $enum: name };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (!this.tryConsume('(')) return args;
    while (!this.tryConsume(')')) {
      const name = this.parseName();
      this.consume(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.pos++;
      this.parseName();
      this.parseArguments();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.consume('{');
    const selections: GqlSelection[] = [];
    while (!this.tryConsume('}')) {
      if (this.peek() === '') throw new ParseError('unexpected end of query');
      if (this.input.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipWs();
        if (this.peek() === '{' || /^[A-Za-z_]/.test(this.peek())) {
          let typeCondition: string | null = null;
          if (this.input.slice(this.pos).startsWith('on ')) {
            this.pos += 3;
            typeCondition = this.parseName();
          }
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else {
          // Named fragment spread: parse the name and skip (named fragments are
          // inlined by parseDocument below; here we just record the spread).
          const fragName = this.parseName();
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition: null, selections: [], ...( { __spread: fragName } as unknown as object ) });
        }
      } else {
        const first = this.parseName();
        let alias = first;
        let name = first;
        if (this.tryConsume(':')) {
          name = this.parseName();
        }
        const args = this.parseArguments();
        this.skipDirectives();
        let sels: GqlSelection[] = [];
        if (this.peek() === '{') sels = this.parseSelectionSet();
        selections.push({ kind: 'field', alias, name, args, selections: sels });
      }
    }
    return selections;
  }

  private skipType(): void {
    this.skipWs();
    if (this.tryConsume('[')) {
      this.skipType();
      this.consume(']');
    } else {
      this.parseName();
    }
    this.tryConsume('!');
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Record<string, GqlSelection[]> } {
    const operations: GqlOperation[] = [];
    const fragments: Record<string, GqlSelection[]> = {};
    for (;;) {
      this.skipWs();
      if (this.pos >= this.input.length) break;
      if (this.input.startsWith('fragment', this.pos) && !/[A-Za-z0-9_]/.test(this.input[this.pos + 8] ?? '')) {
        this.pos += 'fragment'.length;
        const name = this.parseName();
        this.skipWs();
        if (this.input.startsWith('on ', this.pos)) {
          this.pos += 3;
          this.parseName();
        }
        this.skipDirectives();
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      let type: 'query' | 'mutation' = 'query';
      if (this.input.startsWith('query', this.pos) && !/[A-Za-z0-9_]/.test(this.input[this.pos + 5] ?? '')) {
        this.pos += 5;
        type = 'query';
      } else if (this.input.startsWith('mutation', this.pos) && !/[A-Za-z0-9_]/.test(this.input[this.pos + 8] ?? '')) {
        this.pos += 8;
        type = 'mutation';
      }
      this.skipWs();
      let name: string | null = null;
      const c = this.input[this.pos];
      if (c !== undefined && c !== '{' && c !== '(') name = this.parseName();
      const varDefs: Record<string, unknown> = {};
      if (this.tryConsume('(')) {
        while (!this.tryConsume(')')) {
          if (this.peek() === '$') {
            this.pos++;
            const varName = this.parseName();
            this.consume(':');
            this.skipType();
            if (this.tryConsume('=')) varDefs[varName] = this.parseValue();
            else varDefs[varName] = undefined;
          } else {
            this.parseName();
          }
        }
      }
      this.skipDirectives();
      operations.push({ type, name, varDefs, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }
}

export function parseGraphQL(query: string): { operations: GqlOperation[]; fragments: Record<string, GqlSelection[]> } {
  return new Parser(query).parseDocument();
}

/** Resolve `$var` / enum wrappers against the operation's variables and defaults. */
export function resolveValue(value: unknown, variables: Record<string, unknown>, varDefs: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('$var' in (value as Record<string, unknown>)) {
      const name = (value as { $var: string }).$var;
      if (name in variables && variables[name] !== undefined) return variables[name];
      if (name in varDefs) return resolveValue(varDefs[name], variables, varDefs);
      return null;
    }
    if ('$enum' in (value as Record<string, unknown>)) return (value as { $enum: string }).$enum;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables, varDefs));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveValue(v, variables, varDefs);
    return out;
  }
  return value;
}

/** Inline named-fragment spreads using the document's fragment definitions. */
export function expandFragments(selections: GqlSelection[], fragments: Record<string, GqlSelection[]>): GqlSelection[] {
  const out: GqlSelection[] = [];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const spread = (sel as unknown as { __spread?: string }).__spread;
      if (spread && fragments[spread]) {
        out.push(...expandFragments(fragments[spread]!, fragments));
        continue;
      }
      out.push({ ...sel, selections: expandFragments(sel.selections, fragments) });
    } else {
      out.push({ ...sel, selections: expandFragments(sel.selections, fragments) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- executor

import {
  Store,
  decodeGlobalId,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  createIssueIn,
  createPullIn,
  mergePullIn,
  prHasConflict,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { hasAuth, readJson, sendError, sendJson, type Ctx } from './server.ts';

class UnknownFieldError extends Error {}

type Node = Record<string, unknown> & { __type: string };

const SCHEMA: Record<string, { kind: string; fields?: string[]; values?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'bodyText', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'body', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'mergedAt', 'mergeCommit'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate'],
  },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name'] },
};

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface ConnArgs {
  first?: number;
  after?: string;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

function connectionSlice<T extends { number: number }>(
  items: readonly T[],
  args: ConnArgs,
): { slice: T[]; hasNextPage: boolean; endCursor: string | null } {
  const direction = args.orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  let filtered = [...items];
  if (args.states && args.states.length > 0) {
    const wanted = new Set(args.states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    filtered = filtered.filter((i) => wanted.has((i as unknown as { state: string }).state));
  }
  filtered.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const after = cursorNumber(args.after);
  if (after !== null) {
    filtered = filtered.filter((i) => (direction === 'asc' ? i.number > after : i.number < after));
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : filtered.length;
  const slice = filtered.slice(0, first);
  const hasNextPage = filtered.length > slice.length;
  const endCursor = slice.length > 0 ? cursorFor(slice[slice.length - 1]!.number) : null;
  return { slice, hasNextPage, endCursor };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null): Node {
  return { __type: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: endCursor };
}

function issueNode(store: Store, repo: Repo, issue: Issue): Node {
  return { __type: 'Issue', repo, issue, store };
}

function pullNode(store: Store, repo: Repo, pr: Pull): Node {
  return { __type: 'PullRequest', repo, pr, store };
}

function repoNode(store: Store, repo: Repo): Node {
  return { __type: 'Repository', repo, store };
}

function prState(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(node: Node, name: string, args: Record<string, unknown>, store: Store): unknown {
  const type = node.__type;
  const bad = (): never => {
    throw new UnknownFieldError(`Cannot query field "${name}" on type "${type}".`);
  };
  switch (type) {
    case 'Query': {
      if (name === 'viewer') return { __type: 'User', login: store.viewer, store };
      if (name === 'repository') {
        const owner = String(args.owner ?? '');
        const repoName = String(args.name ?? '');
        const repo = store.findRepo(owner, repoName);
        return repo ? repoNode(store, repo) : null;
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        const repo = store.findRepo(decoded.owner, decoded.repo);
        if (!repo) return null;
        if (decoded.kind === 'Repository') return repoNode(store, repo);
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.find((i) => i.number === decoded.number);
          return issue ? issueNode(store, repo, issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const pr = repo.pulls.find((p) => p.number === decoded.number);
          return pr ? pullNode(store, repo, pr) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = String(args.name ?? '');
        const entry = SCHEMA[typeName];
        if (!entry) return null;
        return { __type: '__Type', name: typeName, kind: entry.kind, fields: entry.fields ?? null, enumValues: entry.values ?? null };
      }
      if (name === '__schema') return null;
      if (name === 'createIssue') return createIssueMutation(node, args, store);
      if (name === 'closeIssue') return closeIssueMutation(node, args, store);
      if (name === 'createPullRequest') return createPullRequestMutation(node, args, store);
      if (name === 'mergePullRequest') return mergePullRequestMutation(node, args, store);
      if (name === 'addComment') return addCommentMutation(node, args, store);
      return bad();
    }
    case 'User': {
      if (name === 'login') return (node.login as string | null) ?? null;
      if (name === 'name') return (node.login as string | null) ?? null;
      if (name === 'id') return '1';
      return bad();
    }
    case 'Repository': {
      const repo = node.repo as Repo;
      if (name === 'id') return repoGlobalId(repo.owner ?? store.viewer ?? '', repo.name);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner ?? store.viewer ?? ''}/${repo.name}`;
      if (name === 'owner') return { __type: 'User', login: repo.owner ?? store.viewer, store };
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __type: 'Ref', name: repo.defaultBranch } : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'createdAt') return repo.createdAt;
      if (name === 'updatedAt') return repo.updatedAt;
      if (name === 'url') return `https://example.invalid/${repo.owner ?? store.viewer ?? ''}/${repo.name}`;
      if (name === 'isPrivate') return repo.isPrivate;
      if (name === 'issue') {
        const n = Number(args.number ?? 0);
        const issue = repo.issues.find((i) => i.number === n);
        return issue ? issueNode(store, repo, issue) : null;
      }
      if (name === 'issues') {
        const { slice, hasNextPage, endCursor } = connectionSlice(repo.issues, args as ConnArgs);
        return {
          __type: 'IssueConnection',
          nodes: slice.map((i) => issueNode(store, repo, i)),
          edges: slice.map((i) => ({ __type: 'IssueEdge', node: issueNode(store, repo, i), cursor: cursorFor(i.number) })),
          pageInfo: pageInfoNode(hasNextPage, endCursor),
          totalCount: repo.issues.length,
        };
      }
      if (name === 'pullRequest') {
        const n = Number(args.number ?? 0);
        const pr = repo.pulls.find((p) => p.number === n);
        return pr ? pullNode(store, repo, pr) : null;
      }
      if (name === 'pullRequests') {
        const { slice, hasNextPage, endCursor } = connectionSlice(repo.pulls, args as ConnArgs);
        return {
          __type: 'PullRequestConnection',
          nodes: slice.map((p) => pullNode(store, repo, p)),
          edges: slice.map((p) => ({ __type: 'PullRequestEdge', node: pullNode(store, repo, p), cursor: cursorFor(p.number) })),
          pageInfo: pageInfoNode(hasNextPage, endCursor),
          totalCount: repo.pulls.length,
        };
      }
      return bad();
    }
    case 'Issue': {
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      if (name === 'id') return issueGlobalId(repo.owner ?? store.viewer ?? '', repo.name, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'body' || name === 'bodyText') return issue.body;
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'url') return `https://example.invalid/${repo.owner ?? store.viewer ?? ''}/${repo.name}/issues/${issue.number}`;
      if (name === 'author') return { __type: 'User', login: repo.owner ?? store.viewer, store };
      if (name === 'labels') return { __type: 'LabelConnection', nodes: issue.labels.map((l) => ({ __type: 'Label', name: l.name, color: l.color })) };
      if (name === 'comments') {
        const comments = repo.comments.get(issue.number) ?? [];
        const first = typeof args.first === 'number' ? args.first : comments.length;
        const slice = comments.slice(0, first);
        return {
          __type: 'IssueCommentConnection',
          nodes: slice.map((c) => ({ __type: 'IssueComment', id: commentGlobalId(repo.owner ?? store.viewer ?? '', repo.name, issue.number, c.id), body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, author: { __type: 'User', login: repo.owner ?? store.viewer, store } })),
          edges: slice.map((c) => ({ __type: 'IssueCommentEdge', node: { __type: 'IssueComment', id: commentGlobalId(repo.owner ?? store.viewer ?? '', repo.name, issue.number, c.id), body: c.body }, cursor: cursorFor(c.id) })),
          pageInfo: pageInfoNode(comments.length > slice.length, slice.length > 0 ? cursorFor(slice[slice.length - 1]!.id) : null),
          totalCount: comments.length,
        };
      }
      return bad();
    }
    case 'PullRequest': {
      const repo = node.repo as Repo;
      const pr = node.pr as Pull;
      if (name === 'id') return pullGlobalId(repo.owner ?? store.viewer ?? '', repo.name, pr.number);
      if (name === 'number') return pr.number;
      if (name === 'title') return pr.title;
      if (name === 'state') return prState(pr);
      if (name === 'headRefName') return pr.headRef;
      if (name === 'baseRefName') return pr.baseRef;
      if (name === 'mergeable') return pr.merged || !prHasConflict(store, repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
      if (name === 'merged') return pr.merged;
      if (name === 'body') return pr.body;
      if (name === 'createdAt') return pr.createdAt;
      if (name === 'updatedAt') return pr.updatedAt;
      if (name === 'url') return `https://example.invalid/${repo.owner ?? store.viewer ?? ''}/${repo.name}/pull/${pr.number}`;
      if (name === 'author') return { __type: 'User', login: repo.owner ?? store.viewer, store };
      if (name === 'mergedAt') return pr.mergedAt;
      if (name === 'mergeCommit') return pr.mergeCommitSha ? { __type: 'Commit', oid: pr.mergeCommitSha } : null;
      if (name === 'files') {
        const first = typeof args.first === 'number' ? args.first : pr.files.length;
        const slice = pr.files.slice(0, first);
        return {
          __type: 'FileConnection',
          nodes: slice.map((f) => ({ __type: 'File', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
          pageInfo: pageInfoNode(pr.files.length > slice.length, null),
          totalCount: pr.files.length,
        };
      }
      return bad();
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'FileConnection':
    case 'LabelConnection': {
      if (name === 'nodes') return (node.nodes as unknown[]) ?? [];
      if (name === 'edges') return (node.edges as unknown[]) ?? [];
      if (name === 'pageInfo') return node.pageInfo as Node;
      if (name === 'totalCount') return node.totalCount as number;
      return bad();
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge': {
      if (name === 'node') return node.node as Node;
      if (name === 'cursor') return node.cursor as string;
      return bad();
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return node.hasNextPage as boolean;
      if (name === 'endCursor') return node.endCursor as string | null;
      if (name === 'hasPreviousPage') return node.hasPreviousPage as boolean;
      if (name === 'startCursor') return node.startCursor as string | null;
      return bad();
    }
    case 'IssueComment': {
      if (name === 'id') return node.id as string;
      if (name === 'body') return node.body as string;
      if (name === 'createdAt') return node.createdAt as string;
      if (name === 'updatedAt') return node.updatedAt as string;
      if (name === 'author') return node.author as Node;
      return bad();
    }
    case 'Label': {
      if (name === 'name') return node.name as string;
      if (name === 'color') return node.color as string;
      if (name === 'id') return node.id as string;
      return bad();
    }
    case 'File': {
      if (name === 'path') return node.path as string;
      if (name === 'additions') return node.additions as number;
      if (name === 'deletions') return node.deletions as number;
      if (name === 'changeType') return node.changeType as string;
      return bad();
    }
    case 'Ref': {
      if (name === 'name') return node.name as string;
      return bad();
    }
    case 'Commit': {
      if (name === 'oid') return node.oid as string;
      return bad();
    }
    case '__Type': {
      if (name === 'name') return node.name as string;
      if (name === 'kind') return node.kind as string;
      if (name === 'fields') {
        const fields = node.fields as string[] | null;
        return fields === null ? null : fields.map((f) => ({ __type: 'Field', name: f }));
      }
      if (name === 'enumValues') {
        const values = node.enumValues as string[] | null;
        return values === null ? null : values.map((v) => ({ __type: 'EnumValue', name: v }));
      }
      return bad();
    }
    case 'Field':
    case 'EnumValue': {
      if (name === 'name') return node.name as string;
      return bad();
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return node.issue as Node | null;
      return bad();
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return node.pullRequest as Node | null;
      return bad();
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return node.commentEdge as Node;
      return bad();
    }
    case 'CommentEdge': {
      if (name === 'node') return node.node as Node;
      if (name === 'cursor') return node.cursor as string;
      return bad();
    }
    default:
      return bad();
  }
}

// ---------------------------------------------------------------- mutations

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return (args.input ?? {}) as Record<string, unknown>;
}

function createIssueMutation(_node: Node, args: Record<string, unknown>, store: Store): Node {
  const input = inputOf(args);
  const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
  if (!decoded) throw new Error('repository not found');
  const repo = store.findRepo(decoded.owner, decoded.repo);
  if (!repo) throw new Error('repository not found');
  const res = createIssueIn(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
  if ('error' in res) throw new Error(res.error);
  return { __type: 'CreateIssuePayload', issue: issueNode(store, repo, res) };
}

function closeIssueMutation(_node: Node, args: Record<string, unknown>, store: Store): Node {
  const input = inputOf(args);
  const decoded = decodeGlobalId(String(input.issueId ?? ''));
  if (!decoded) throw new Error('issue not found');
  const repo = store.findRepo(decoded.owner, decoded.repo);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (!repo || !issue) throw new Error('issue not found');
  issue.state = 'closed';
  issue.updatedAt = store.clock.iso();
  issue.jsonBuf = null;
  return { __type: 'CloseIssuePayload', issue: issueNode(store, repo, issue) };
}

function createPullRequestMutation(_node: Node, args: Record<string, unknown>, store: Store): Node {
  const input = inputOf(args);
  const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
  if (!decoded) throw new Error('repository not found');
  const repo = store.findRepo(decoded.owner, decoded.repo);
  if (!repo) throw new Error('repository not found');
  const res = createPullIn(
    store,
    repo,
    String(input.title ?? ''),
    String(input.body ?? ''),
    String(input.headRefName ?? ''),
    String(input.baseRefName ?? ''),
  );
  if ('error' in res) throw new Error(res.error);
  return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(store, repo, res) };
}

function mergePullRequestMutation(_node: Node, args: Record<string, unknown>, store: Store): Node {
  const input = inputOf(args);
  const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
  if (!decoded) throw new Error('pull request not found');
  const repo = store.findRepo(decoded.owner, decoded.repo);
  const pr = repo?.pulls.find((p) => p.number === decoded.number);
  if (!repo || !pr) throw new Error('pull request not found');
  if (!pr.merged && !prHasConflict(store, repo, pr)) {
    mergePullIn(store, repo, pr);
  }
  return { __type: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pr) };
}

function addCommentMutation(_node: Node, args: Record<string, unknown>, store: Store): Node {
  const input = inputOf(args);
  const decoded = decodeGlobalId(String(input.subjectId ?? ''));
  if (!decoded) throw new Error('issue not found');
  const repo = store.findRepo(decoded.owner, decoded.repo);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (!repo || !issue) throw new Error('issue not found');
  const now = store.clock.iso();
  const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdAt: now, updatedAt: now };
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  issue.jsonBuf = null;
  const node: Node = {
    __type: 'IssueComment',
    id: commentGlobalId(repo.owner ?? store.viewer ?? '', repo.name, issue.number, comment.id),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: { __type: 'User', login: repo.owner ?? store.viewer, store },
  };
  return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node, cursor: cursorFor(comment.id) } };
}

// ---------------------------------------------------------------- selection resolution

function resolveSelections(
  selections: GqlSelection[],
  node: Node,
  store: Store,
  variables: Record<string, unknown>,
  varDefs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== node.__type) continue;
      Object.assign(out, resolveSelections(sel.selections, node, store, variables, varDefs));
      continue;
    }
    if (sel.name === '__typename') {
      out[sel.alias] = node.__type;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables, varDefs);
    const value = resolveField(node, sel.name, args, store);
    if (value === null || value === undefined) {
      out[sel.alias] = value ?? null;
      continue;
    }
    if (sel.selections.length === 0) {
      out[sel.alias] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[sel.alias] = value.map((item) =>
        item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)
          ? resolveSelections(sel.selections, item as Node, store, variables, varDefs)
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      out[sel.alias] = resolveSelections(sel.selections, value as Node, store, variables, varDefs);
      continue;
    }
    out[sel.alias] = value;
  }
  return out;
}

function executeOne(body: unknown, store: Store): Record<string, unknown> {
  const b = (body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof b.query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  const variables = (b.variables ?? {}) as Record<string, unknown>;
  try {
    const doc = parseGraphQL(b.query);
    let operation: GqlOperation | undefined;
    if (typeof b.operationName === 'string') {
      operation = doc.operations.find((o) => o.name === b.operationName);
    }
    operation ??= doc.operations[0];
    if (!operation) return { data: null, errors: [{ message: 'no operation in query' }] };
    const selections = expandFragments(operation.selections, doc.fragments);
    const data = resolveSelections(selections, { __type: 'Query' }, store, variables, operation.varDefs);
    return { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'graphql error';
    return { data: null, errors: [{ message }] };
  }
}

/** POST /api/graphql */
export async function handleGraphQL(ctx: Ctx): Promise<void> {
  if (!hasAuth(ctx)) {
    sendError(ctx, 401, 'requires authentication');
    return;
  }
  await readJson(ctx);
  if (ctx.json === undefined) {
    sendError(ctx, 400, 'malformed JSON');
    return;
  }
  const bodies = Array.isArray(ctx.json) ? ctx.json : [ctx.json];
  const results = bodies.map((b) => executeOne(b, ctx.store));
  sendJson(ctx, 200, Array.isArray(ctx.json) ? results : results[0]);
}
