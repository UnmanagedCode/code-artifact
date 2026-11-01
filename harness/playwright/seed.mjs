// Boots the backend on a sandboxed store and publishes one artifact of each kind (two apps: one that runs, one that fails) and two
// image downloads (a PNG and a hostile SVG) over MCP, plus a second markdown version, then backdates the first so the prune dialog has something to count.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { BROWSER } from './resolve.mjs';

const { bootServer } = await import(BROWSER);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Store } = await import(path.join(ROOT, 'src', 'store.js'));

const UNBROKEN_LABEL = `https://example.com/${'a'.repeat(70)}`;

// What cc's display label holds for a session that was untitled at publish: its raw markdown first prompt.
const MARKDOWN_LABEL = '**Operational task:** fix the `foo` parser, see [the spec](https://example.com/spec) and ship it before the release';

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

// Visible shapes, a script that marks the top document if it ever runs, and an external fetch that must never happen.
const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">
<rect width="200" height="120" rx="12" fill="#2f6fde"/><circle cx="60" cy="60" r="36" fill="#f5c542"/><path d="M110 90 150 30 190 90z" fill="#e8eef9"/>
<script>top.document.documentElement.dataset.pwned = '1';</script>
<image href="https://example.invalid/x.png" width="10" height="10"/>
</svg>`;

/** A `w`×`h` RGB PNG with a diagonal gradient. */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(Math.round((255 * x) / w), Math.round((255 * y) / h), 160);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** Returns `{url, ids, close}`: a running backend and the ids of the seeded artifacts. */
export async function seed() {
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-seed-'));
  fs.writeFileSync(path.join(files, 'notes.md'), MARKDOWN);
  fs.writeFileSync(path.join(files, 'notes-v2.md'), `${MARKDOWN}\nSecond version.\n`);
  fs.mkdirSync(path.join(files, 'site'));
  fs.writeFileSync(path.join(files, 'site', 'index.html'), '<!doctype html><title>Demo</title><h1>Demo site</h1><p>Served as authored.</p>');
  fs.writeFileSync(path.join(files, 'report.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(files, 'chart.png'), png(480, 300));
  fs.writeFileSync(path.join(files, 'evil.svg'), EVIL_SVG);
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
  // Bare images, no explicit kind: inferred as downloads, whose page previews them.
  const image = await mcp('publish_artifact', { path: path.join(files, 'chart.png'), title: 'Chart' });
  const svg = await mcp('publish_artifact', { path: path.join(files, 'evil.svg'), title: 'Hostile SVG' });

  // Backdate version 1 of the markdown artifact (the server reads artifact.json per request).
  const record = path.join(srv.sandbox.dirs.CODE_ARTIFACT_STORE, 'artifacts', md.id, 'artifact.json');
  const json = JSON.parse(fs.readFileSync(record, 'utf8'));
  json.versions[0].publishedAt = new Date(Date.now() - 90 * 86_400_000).toISOString();
  fs.writeFileSync(record, JSON.stringify(json));

  // MCP publishes in this sandbox with no session label, so the markdown-label version is created through the store.
  const store = await Store.open(srv.sandbox.dirs.CODE_ARTIFACT_STORE);
  const staging = await store.newStaging();
  fs.mkdirSync(path.join(staging, 'content'));
  fs.writeFileSync(path.join(staging, 'content', 'label.csv'), 'a,b\n1,2\n');
  const labelled = await store.create({
    title: 'Labelled session', kind: 'download', project: 'demo',
    version: { file: 'label.csv', bytes: 8, files: 1, sessionId: 'a1b2c3d4-0000', sessionLabel: MARKDOWN_LABEL, source: { name: 'label.csv', type: 'file' } },
  }, staging);

  const unbrokenStaging = await store.newStaging();
  fs.mkdirSync(path.join(unbrokenStaging, 'content'));
  fs.writeFileSync(path.join(unbrokenStaging, 'content', 'label.csv'), 'a,b\n1,2\n');
  const unbroken = await store.create({
    title: 'Unbroken session', kind: 'download', project: 'demo',
    version: { file: 'label.csv', bytes: 8, files: 1, sessionId: 'a1b2c3d4-0000', sessionLabel: UNBROKEN_LABEL, source: { name: 'label.csv', type: 'file' } },
  }, unbrokenStaging);

  return {
    url: srv.url,
    ids: { unbroken: unbroken.id, labelled: labelled.id, markdown: md.id, static: site.id, download: dl.id, image: image.id, svg: svg.id, app: app.id, failing: failing.id },
    close: async () => { await srv.close(); fs.rmSync(files, { recursive: true, force: true }); },
  };
}
