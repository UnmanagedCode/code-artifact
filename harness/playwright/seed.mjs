// Boots the backend on a sandboxed store and publishes one artifact of each kind (two apps: one that runs, one that fails) over MCP,
// plus a second markdown version, then backdates the first so the prune dialog has something to count.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';

const { bootServer } = await import(BROWSER);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MARKDOWN = `# Release notes

A paragraph with **bold**, \`code\` and a [link](https://example.com).

| Area | Status |
|------|--------|
| Store | done |
| UI | done |

- [x] Publish
- [ ] Review

~~Old~~ plan, see https://example.com/docs.

\`\`\`js
console.log('hello');
\`\`\`
`;

/** Returns `{url, ids, close}`: a running backend and the ids of the seeded artifacts. */
export async function seed() {
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-seed-'));
  fs.writeFileSync(path.join(files, 'notes.md'), MARKDOWN);
  fs.writeFileSync(path.join(files, 'notes-v2.md'), `${MARKDOWN}\nSecond version.\n`);
  fs.mkdirSync(path.join(files, 'site'));
  fs.writeFileSync(path.join(files, 'site', 'index.html'), '<!doctype html><title>Demo</title><h1>Demo site</h1><p>Served as authored.</p>');
  fs.writeFileSync(path.join(files, 'report.csv'), 'a,b\n1,2\n');
  for (const [name, server, manifest] of [
    ['app', "require('node:http').createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><h1>App says hi</h1><p>served by a running process</p>'); }).listen(process.env.PORT, '127.0.0.1', () => console.log('demo app listening'));", { start: 'node server.js' }],
    ['failing', "console.error('boom: cannot bind'); process.exit(4);", { start: 'node server.js' }],
  ]) {
    fs.mkdirSync(path.join(files, name));
    fs.writeFileSync(path.join(files, name, 'server.js'), server);
    fs.writeFileSync(path.join(files, name, 'artifact.json'), JSON.stringify(manifest));
  }

  const srv = await bootServer({
    cwd: ROOT, entry: 'server.js',
    sandbox: { dirs: { CODE_ARTIFACT_STORE: 'store' }, env: { CONDUCTOR_URL: '' } },
  });
  const mcp = async (tool, args, project = 'demo') => {
    const res = await fetch(`${srv.url}/api/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool, arguments: args, caller: { sessionId: 'a1b2c3d4-0000', project } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${tool}: ${body.error}`);
    return body.result;
  };

  const md = await mcp('publish_artifact', { path: path.join(files, 'notes.md'), title: 'Release notes' });
  await mcp('update_artifact', { artifact: md.id, path: path.join(files, 'notes-v2.md') });
  const site = await mcp('publish_artifact', { path: path.join(files, 'site'), title: 'Demo site' }, 'tools');
  const app = await mcp('publish_artifact', { path: path.join(files, 'app'), title: 'Demo app' });
  const failing = await mcp('publish_artifact', { path: path.join(files, 'failing'), title: 'Broken app' });
  const dl = await mcp('publish_artifact', { path: path.join(files, 'report.csv'), title: 'Quarterly report' });

  // Backdate version 1 of the markdown artifact (the server reads artifact.json per request).
  const record = path.join(srv.sandbox.dirs.CODE_ARTIFACT_STORE, 'artifacts', md.id, 'artifact.json');
  const json = JSON.parse(fs.readFileSync(record, 'utf8'));
  json.versions[0].publishedAt = new Date(Date.now() - 90 * 86_400_000).toISOString();
  fs.writeFileSync(record, JSON.stringify(json));

  return {
    url: srv.url,
    ids: { markdown: md.id, static: site.id, download: dl.id, app: app.id, failing: failing.id },
    close: async () => { await srv.close(); fs.rmSync(files, { recursive: true, force: true }); },
  };
}
