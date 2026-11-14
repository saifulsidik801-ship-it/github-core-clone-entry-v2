// The forge's entry point: one process, one HTTP server, four surfaces.
// The suite gives it MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN; the entry binds
// an ephemeral port, registers it, serves git smart HTTP, REST v3, GraphQL v4
// and MCP from the one vault, and exits 0 when the env's /done answers true.
// Without an env URL (a local run) it just serves on an ephemeral port.
//
// The hot path here is deliberately thin: no `new URL()` per request, no
// header Map copy (Node already lower-cases req.headers), no body read on
// GET/HEAD, and the query string is only parsed when the route needs it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createVault } from './vault.ts';
import { VIEWER } from './seed.ts';
import { handleGit } from './gitface.ts';
import { handleRest, type RestRes } from './restface.ts';
import { handleGraphQL } from './gqlface.ts';
import { handleMcp } from './mcpface.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
void SHOP_TOKEN;

const vault = createVault(VIEWER.login);

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  response.end(text);
}

function sendBuffer(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  response.end(body);
}

function sendRest(response: ServerResponse, result: RestRes): void {
  const headers = { ...(result.headers ?? {}) };
  if (result.body === null || result.body === undefined) {
    response.writeHead(result.status, { 'content-length': 0, ...headers });
    response.end();
    return;
  }
  if (Buffer.isBuffer(result.body)) {
    // Already UTF-8 bytes: send verbatim, no per-request encoding.
    response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': result.body.length, ...headers });
    response.end(result.body);
    return;
  }
  response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(result.body), ...headers });
  response.end(result.body);
}

async function register(port: number): Promise<void> {
  const response = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) throw new Error(`register failed with HTTP ${response.status}`);
}

/** Long-poll /done with backoff (250ms → 2000ms), returning when it answers true. */
async function waitDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`);
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // The env is briefly unreachable: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
  }
}

function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A shared empty query set, so requests without a query string pay nothing. */
const EMPTY_QUERY = new URLSearchParams('');

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const body = hasBody ? await readBody(request) : Buffer.alloc(0);
    const rawUrl = request.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const host = request.headers.host ?? '127.0.0.1';
    // Most paths carry no %-escapes; only decode when one is present.
    const path = rawPath.indexOf('%') === -1 ? rawPath : decodePath(rawPath);
    const headers = request.headers;

    if (path === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    const seg = path.split('/').filter((s) => s !== '');

    // Git smart HTTP: /:owner/:repo/info/refs | git-upload-pack | git-receive-pack
    if (
      (seg.length === 4 && seg[2] === 'info' && seg[3] === 'refs') ||
      (seg.length === 3 && (seg[2] === 'git-upload-pack' || seg[2] === 'git-receive-pack'))
    ) {
      const owner = seg[0] as string;
      // Git clients address a repo as <name>.git over smart HTTP; the vault
      // holds it under the bare name, so drop a trailing .git here.
      const repoName = (seg[1] as string).replace(/\.git$/, '');
      const tail = seg.length === 4 ? 'info/refs' : (seg[2] as string);
      const repo = owner === vault.viewer ? vault.repos.get(repoName) : undefined;
      if (!repo) {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      const isV2 = headers['git-protocol'] === 'version=2';
      if (tail === 'info/refs') {
        const query = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1);
        const service = new URLSearchParams(query).get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(response, 400, { message: 'Missing service parameter' });
          return;
        }
        const result = handleGit(repo, service, true, isV2, Buffer.alloc(0));
        sendBuffer(response, result.status, result.contentType, result.body);
        return;
      }
      const service = tail === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
      const result = handleGit(repo, service, false, isV2, body);
      sendBuffer(response, result.status, result.contentType, result.body);
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const restSeg = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
      const result = handleRest(vault, {
        method,
        seg: restSeg,
        query: qIndex === -1 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIndex + 1)),
        headers,
        bodyText: body.toString('utf8'),
        // Pagination Link headers must be absolute URLs (sameOrigin check).
        pathBase: `http://${host}${rawPath}`,
      });
      if (result === null) sendJson(response, 404, { message: 'Not Found' });
      else sendRest(response, result);
      return;
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      const result = handleGraphQL(vault, { headers, bodyText: body.toString('utf8') });
      sendJson(response, result.status, result.body);
      return;
    }

    if (path === '/mcp') {
      if (method === 'DELETE') {
        response.writeHead(204, { 'content-length': 0 });
        response.end();
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      const result = handleMcp(vault, { headers, bodyText: body.toString('utf8') });
      if (result.status === 202) {
        response.writeHead(202, { 'content-length': 0 });
        response.end();
        return;
      }
      sendJson(response, result.status, result.body);
      return;
    }

    sendJson(response, 404, { message: 'Not Found' });
  } catch (error) {
    // A malformed request must never kill the server.
    try {
      sendJson(response, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
    } catch {
      // The socket is already gone.
    }
  }
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL === '') {
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; standalone mode)`);
    return;
  }
  void (async () => {
    try {
      await register(port);
      await waitDone();
      server.close(() => process.exit(0));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  })();
});
