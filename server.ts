// server.ts — the HTTP layer: one node:http server, a tiny request context, and
// the dispatcher. All responses are JSON unless a handler writes raw bytes
// (git smart HTTP). Every response carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  /** The raw request body (null until read). */
  body: Buffer | null;
  /** The parsed JSON body, when it parses. */
  json: unknown;
  store: Store;
}

export interface Handler {
  (ctx: Ctx): Promise<void> | void;
}

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `forge-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId(),
    ...(extraHeaders ?? {}),
  });
  ctx.res.end(body);
}

/** Send precomputed bytes verbatim (the read-workload fast path). */
export function sendBuf(ctx: Ctx, status: number, body: Buffer, extraHeaders?: Record<string, string>): void {
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId(),
    ...(extraHeaders ?? {}),
  });
  ctx.res.end(body);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function sendRaw(ctx: Ctx, status: number, contentType: string, body: Buffer): void {
  ctx.res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId(),
  });
  ctx.res.end(body);
}

export async function readBody(ctx: Ctx): Promise<Buffer> {
  if (ctx.body !== null) return ctx.body;
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  ctx.body = Buffer.concat(chunks);
  return ctx.body;
}

export async function readJson(ctx: Ctx): Promise<unknown> {
  const body = await readBody(ctx);
  if (body.length === 0) {
    ctx.json = null;
    return null;
  }
  try {
    ctx.json = JSON.parse(body.toString('utf8'));
  } catch {
    ctx.json = undefined;
  }
  return ctx.json;
}

/** True when the request carries a non-empty Bearer token. */
export function hasAuth(ctx: Ctx): boolean {
  const auth = ctx.req.headers.authorization;
  return typeof auth === 'string' && /^Bearer\s+\S+/.test(auth);
}

/** One request header, without building a headers object per request. */
export function header(ctx: Ctx, name: string): string | undefined {
  const v = ctx.req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A hint of the viewer's login from the token, when it is a JWT that names one. */
export function tokenLoginHint(ctx: Ctx): string | null {
  const auth = ctx.req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const token = auth.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const login = payload.login ?? payload.username ?? payload.preferred_username;
    return typeof login === 'string' && login !== '' ? login : null;
  } catch {
    return null;
  }
}

export function learnViewerFrom(ctx: Ctx): void {
  if (ctx.store.viewer === null) {
    const hint = tokenLoginHint(ctx);
    if (hint) ctx.store.learnViewer(hint);
  }
}

export type Route = {
  method: string;
  pattern: RegExp;
  handler: Handler;
};

export interface ServerOptions {
  store: Store;
  routes: Route[];
  fallback: Handler;
}

/** Build the server; the dispatcher runs handlers synchronously on the hot path. */
export function createForgeServer(opts: ServerOptions) {
  const { store, routes, fallback } = opts;
  const EMPTY_PARAMS = new URLSearchParams();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '/';
        const qmark = rawUrl.indexOf('?');
        const path = qmark < 0 ? rawUrl : rawUrl.slice(0, qmark);
        const ctx: Ctx = {
          req,
          res,
          method: (req.method ?? 'GET').toUpperCase(),
          path,
          query: qmark < 0 ? EMPTY_PARAMS : new URLSearchParams(rawUrl.slice(qmark + 1)),
          body: null,
          json: undefined,
          store,
        };
        for (const route of routes) {
          if (route.method !== ctx.method) continue;
          const m = route.pattern.exec(path);
          if (!m) continue;
          (ctx as unknown as { params: string[] }).params = m.slice(1);
          await route.handler(ctx);
          return;
        }
        await fallback(ctx);
      } catch (err) {
        if (!res.writableEnded) {
          const message = err instanceof Error ? err.message : 'internal error';
          try {
            res.writeHead(500, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId() });
            res.end(JSON.stringify({ message }));
          } catch {
            // The socket is gone; nothing more to do.
          }
        }
      }
    })();
  });
  return server;
}

/** Read the route params captured by the dispatcher. */
export function params(ctx: Ctx): string[] {
  return (ctx as unknown as { params?: string[] }).params ?? [];
}

/** Percent-decode one path segment (plus stays a plus in a path). */
export function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
