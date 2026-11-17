// main.ts — the forge entry point: one process, one node:http server.
// Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with
// the environment, serve until the environment reports done, then exit 0.
// Standalone mode (no MAKEFUN_ENV_URL): serve forever on $PORT (default 8123).

import { createForgeServer, sendJson, type Route, type Handler } from './server.ts';
import { Store } from './store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitface.ts';
import { handleGraphQL } from './gqlface.ts';
import { handleMcp } from './mcpface.ts';
import {
  handleRoot,
  handleMeta,
  handleGetUser,
  handleListUserRepos,
  handleCreateUserRepo,
  handleGetRepo,
  handlePatchRepo,
  handleDeleteRepo,
  handleListBranches,
  handleGetBranch,
  handleListCommits,
  handleCreateRef,
  handleGetRef,
  handlePutContents,
  handleGetContents,
  handleDeleteContents,
  handleCreateLabel,
  handleListLabels,
  handleCreateIssue,
  handleListIssues,
  handleGetIssue,
  handlePatchIssue,
  handleCreateComment,
  handleListComments,
  handleCreatePull,
  handleListPulls,
  handleGetPull,
  handleListPullFiles,
  handleMergePull,
} from './restface.ts';

const R = (method: string, pattern: RegExp, handler: Handler): Route => ({ method, pattern, handler });

const routes: Route[] = [
  // Health (the environment probes this twice).
  R('GET', /^\/healthz$/, (ctx) => sendJson(ctx, 200, { ok: true })),
  // Hot paths first: the benchmark hammers these four routes.
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, handleGetIssue),
  R('POST', /^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/, handleReceivePack),
  R('POST', /^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/, handleUploadPack),
  R('GET', /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/, handleInfoRefs),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, handleCreateIssue),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handleGetRepo),
  // GraphQL v4 and MCP.
  R('POST', /^\/api\/graphql$/, handleGraphQL),
  R('POST', /^\/mcp$/, handleMcp),
  // REST v3 (remaining).
  R('GET', /^\/api\/v3\/$/, handleRoot),
  R('GET', /^\/api\/v3\/meta$/, handleMeta),
  R('GET', /^\/api\/v3\/user$/, handleGetUser),
  R('GET', /^\/api\/v3\/user\/repos$/, handleListUserRepos),
  R('POST', /^\/api\/v3\/user\/repos$/, handleCreateUserRepo),
  R('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handlePatchRepo),
  R('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handleDeleteRepo),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/, handleListBranches),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/, handleGetBranch),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/, handleListCommits),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, handleCreateRef),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/, handleGetRef),
  R('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handlePutContents),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents$/, handleGetContents),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handleGetContents),
  R('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handleDeleteContents),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, handleCreateLabel),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, handleListLabels),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, handleListIssues),
  R('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, handlePatchIssue),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, handleCreateComment),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, handleListComments),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, handleCreatePull),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, handleListPulls),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, handleGetPull),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, handleListPullFiles),
  R('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, handleMergePull),
];

const fallback: Handler = (ctx) => sendJson(ctx, 404, { message: 'not found' });

const store = new Store();
const server = createForgeServer({ store, routes, fallback });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTrial(envUrl: string, port: number): Promise<void> {
  const base = envUrl.replace(/\/$/, '');
  let registered = false;
  for (let attempt = 0; attempt < 30 && !registered; attempt++) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) registered = true;
    } catch {
      // The environment may not be listening yet; retry.
    }
    if (!registered) await sleep(500);
  }
  if (!registered) {
    console.error('forge: could not register with the environment');
    process.exit(1);
  }
  for (;;) {
    await sleep(250);
    try {
      const res = await fetch(`${base}/done`, { signal: AbortSignal.timeout(5000) });
      const data = (await res.json()) as { done?: boolean };
      if (data.done === true) break;
    } catch {
      // Transient; keep polling.
    }
  }
  server.close(() => process.exit(0));
}

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
if (envUrl !== '') {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    void runTrial(envUrl, port);
  });
} else {
  const port = Number(process.env.PORT ?? '8123');
  server.listen(port, '127.0.0.1', () => {
    console.log(`forge listening on http://127.0.0.1:${port}`);
  });
}
