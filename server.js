import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeRoot, ccUrl } from './src/config.js';
import { Refusal } from './src/refusal.js';
import { Store } from './src/store.js';
import { createCc } from './src/cc.js';
import { createOps } from './src/ops.js';
import { createTools, handle } from './src/mcp.js';
import { apiRouter } from './src/api.js';
import { contentRouter } from './src/serve.js';
import { DEFAULT_DIST, jsonOnlyMutations, mountUi, securityHeaders, terminalHandlers } from './src/webui.js';

/**
 * Builds the backend, not yet listening. `storeDir` null means unconfigured: every store-backed route
 * answers 503 STORE_UNCONFIGURED while the UI and health stay up. `distDir` and `limits` are test seams.
 */
export async function createServer({ storeDir, distDir = DEFAULT_DIST, ccUrl: cc = null, limits } = {}) {
  const store = storeDir ? await Store.open(storeDir) : null;
  const getStore = () => {
    if (!store) throw new Refusal('STORE_UNCONFIGURED', 'set CODE_ARTIFACT_STORE or PROJECTS_ROOT');
    return store;
  };
  const ops = createOps({ store: getStore, cc: createCc(cc), limits });

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(jsonOnlyMutations);
  app.use('/api', apiRouter({ ops, tools: createTools(ops), handleMcp: handle }));
  app.use(contentRouter(getStore));
  mountUi(app, distDir);
  terminalHandlers(app);

  const server = http.createServer(app);
  server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return server;
}

export async function start({ port = Number(process.env.PORT) || 7500, host = '127.0.0.1' } = {}) {
  let storeDir = null;
  try {
    storeDir = storeRoot();
  } catch (e) {
    console.warn(`code-artifact: ${e.message}; the API will answer 503 STORE_UNCONFIGURED`);
  }
  const server = await createServer({ storeDir, ccUrl: ccUrl() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`code-artifact listening on http://${host}:${server.address().port}`);
  return server;
}

// Direct-run guard: only auto-start when invoked as `node server.js`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
