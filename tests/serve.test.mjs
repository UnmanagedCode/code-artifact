// Pins content serving: latest vs pinned versions and their cache headers, static path resolution and its traversal refusals,
// the CSP split between pages and static sites, markdown/download pages, attachments, and 404s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import * as tar from 'tar';
import { fixtureDir, fixtureFile, publish, startApp, tmp } from './_helpers.mjs';

const SITE = { 'index.html': '<h1>home</h1>', 'app.js': 'console.log(1)', 'docs/index.html': 'docs', 'docs/guide.txt': 'guide', 'empty/': '', '.secret': 'nope', 'sub/.hidden/x.txt': 'nope' };

async function staticApp(t, files = SITE) {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureDir(t, files), title: 'Site' });
  return { app, art };
}

test('a/<id> and a/<id>/v/<n> redirect to a relative trailing-slash URL', async (t) => {
  const { app, art } = await staticApp(t);
  const r1 = await app.get(`/a/${art.id}`);
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get('location'), `${art.id}/`);
  const r2 = await app.get(`/a/${art.id}/v/1`);
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.get('location'), '1/');
});

test('the latest route serves the newest version with no-cache; the pinned route serves its own version, immutable', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureDir(t, { 'index.html': 'ONE' }), title: 'Site' });
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureDir(t, { 'index.html': 'TWO' }) });
  const latest = await app.get(`/a/${art.id}/`);
  assert.equal(latest.text, 'TWO');
  assert.equal(latest.headers.get('cache-control'), 'no-cache');
  const pinned = await app.get(`/a/${art.id}/v/1/`);
  assert.equal(pinned.text, 'ONE');
  assert.equal(pinned.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal((await app.get(`/a/${art.id}/v/2/`)).text, 'TWO');
  assert.equal((await app.get(`/a/${art.id}/v/3/`)).status, 404);
  assert.equal((await app.get(`/a/${art.id}/v/0/`)).status, 404);
});

test('static: index.html is the default, files and nested index.html serve, with their content types', async (t) => {
  const { app, art } = await staticApp(t);
  assert.equal((await app.get(`/a/${art.id}/`)).text, '<h1>home</h1>');
  const js = await app.get(`/a/${art.id}/app.js`);
  assert.equal(js.text, 'console.log(1)');
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await app.get(`/a/${art.id}/docs/`)).text, 'docs');
  assert.equal((await app.get(`/a/${art.id}/docs/guide.txt`)).text, 'guide');
  assert.equal((await app.get(`/a/${art.id}/v/1/docs/guide.txt`)).text, 'guide');
});

test('static: a directory without a slash gets a relative 301; an empty directory and a file with a slash are 404', async (t) => {
  const { app, art } = await staticApp(t);
  const r = await app.get(`/a/${art.id}/docs`);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'docs/');
  const pinned = await app.get(`/a/${art.id}/v/1/docs`);
  assert.equal(pinned.status, 301);
  assert.equal(pinned.headers.get('location'), 'docs/');
  assert.equal((await app.get(`/a/${art.id}/empty/`)).status, 404, 'no listings');
  assert.equal((await app.get(`/a/${art.id}/app.js/`)).status, 404);
  assert.equal((await app.get(`/a/${art.id}/missing.txt`)).status, 404);
});

test('static: dot segments, encoded slashes and backslashes, and dotfiles are 404', async (t) => {
  const { app, art } = await staticApp(t);
  for (const p of ['%2e%2e/%2e%2e/x', '..%2fapp.js', 'docs%2fguide.txt', 'docs%5cguide.txt', '.secret', 'sub/.hidden/x.txt', '%2esecret', 'docs//guide.txt', '%00']) {
    const res = await app.get(`/a/${art.id}/${p}`);
    assert.equal(res.status, 404, p);
  }
  assert.equal((await app.get(`/a/${art.id}/%zz`)).status, 400, 'an undecodable path is refused by the router');
  // fetch() normalises dot segments away, so send the raw request line.
  const raw = await new Promise((resolve, reject) => {
    const url = new URL(app.base);
    http.get({ host: url.hostname, port: url.port, path: `/a/${art.id}/../../api/health` }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal(raw.status, 404);
  assert.notEqual(raw.body, '{"ok":true}');
});

test('static: a symlink planted in the store after ingest is 404, to a file or a directory outside the content', async (t) => {
  const { app, art } = await staticApp(t);
  const content = path.join(app.storeDir, 'artifacts', art.id, 'v', '1', 'content');
  const outside = await tmp(t);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
  await fsp.symlink(path.join(outside, 'secret.txt'), path.join(content, 'leak.txt'));
  await fsp.symlink(outside, path.join(content, 'leakdir'));
  await fsp.symlink(path.join(content, 'app.js'), path.join(content, 'inner.js'));
  for (const p of ['leak.txt', 'leakdir/secret.txt', 'leakdir/', 'inner.js']) assert.equal((await app.get(`/a/${art.id}/${p}`)).status, 404, p);
});

test('static responses carry no plugin CSP but keep nosniff; pages and the API keep the CSP', async (t) => {
  const { app, art } = await staticApp(t);
  const site = await app.get(`/a/${art.id}/`);
  assert.equal(site.headers.get('content-security-policy'), null);
  assert.equal(site.headers.get('x-content-type-options'), 'nosniff');
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# hi'), title: 'Doc' });
  assert.match((await app.get(`/a/${md.id}/`)).headers.get('content-security-policy'), /default-src 'none'/);
  assert.match((await app.get('/api/health')).headers.get('content-security-policy'), /default-src 'none'/);
  assert.match((await app.get(`/a/${art.id}/missing`)).headers.get('content-security-policy') ?? '', /default-src 'none'|^$/);
});

test('a lone html file serves as the site root', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'page.html', '<p>lone</p>'), title: 'Lone' });
  assert.equal(art.kind, 'static');
  assert.equal((await app.get(`/a/${art.id}/`)).text, '<p>lone</p>');
});

test('markdown: the page has the bridge first, the theme, relative assets, sanitized content and the CSP', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'n.md', '# Title\n\n<script>alert(1)</script>\n\n| a |\n|---|\n| 1 |\n'), title: 'My <doc>' });
  const page = await app.get(`/a/${art.id}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const head = page.text.slice(page.text.indexOf('<head>'));
  assert.ok(head.indexOf('/pluginBridge.js') < head.indexOf('/pluginTheme.css'));
  assert.match(head, /<script src="\/pluginBridge\.js"><\/script>/);
  assert.match(head, /href="\.\.\/\.\.\/_page\/page\.css"/);
  assert.match(head, /src="\.\.\/\.\.\/_page\/theme-init\.js"/);
  assert.match(head, /src="\.\.\/\.\.\/_page\/nav\.js"/);
  assert.match(page.text, /<h1>Title<\/h1>/);
  assert.match(page.text, /<table>/);
  assert.ok(!page.text.includes('alert(1)'));
  assert.ok(page.text.includes('<title>My &lt;doc&gt;</title>'), 'the title is escaped');
  assert.match(page.text, /href="\.\.\/\.\.\/dl\/[^"]+\/1"/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('the pinned markdown page uses the deeper relative prefix and says pinned', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'n.md', '# v1'), title: 'Doc' });
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureFile(t, 'm.md', '# v2') });
  const pinned = await app.get(`/a/${art.id}/v/1/`);
  assert.match(pinned.text, /href="\.\.\/\.\.\/\.\.\/\.\.\/_page\/page\.css"/);
  assert.match(pinned.text, /v1 · pinned/);
  assert.match(pinned.text, /<h1>v1<\/h1>/);
  assert.match((await app.get(`/a/${art.id}/`)).text, /v2 · latest/);
});

test('page assets are served and everything else under _page is 404', async (t) => {
  const app = await startApp(t);
  for (const f of ['page.css', 'fallback.css', 'theme-init.js', 'nav.js']) assert.equal((await app.get(`/_page/${f}`)).status, 200, f);
  assert.match((await app.get('/_page/fallback.css')).text, /--background/);
  for (const f of ['other.css', '..%2fpackage.json', 'constructor']) assert.equal((await app.get(`/_page/${f}`)).status, 404, f);
});

test('markdown and download artifacts answer 404 for any deeper subpath', async (t) => {
  const app = await startApp(t);
  const md = await publish(app, { path: await fixtureFile(t, 'n.md', '# x'), title: 'Doc' });
  const dl = await publish(app, { path: await fixtureFile(t, 'd.bin', 'x'), title: 'Bin' });
  for (const id of [md.id, dl.id]) {
    assert.equal((await app.get(`/a/${id}/x`)).status, 404);
    assert.equal((await app.get(`/a/${id}/v/1/x`)).status, 404);
  }
});

test('download: the deep link is a landing page, and dl/ sends the attachment', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'report.csv', 'a,b\n1,2\n'), title: 'Report' });
  const landing = await app.get(`/a/${art.id}/`);
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get('content-disposition'), null);
  assert.match(landing.text, /report\.csv/);
  assert.match(landing.text, /href="\.\.\/\.\.\/dl\/[^"]+\/1"/);
  const dl = await app.get(`/dl/${art.id}/1`);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="report.csv"/);
  assert.equal(dl.text, 'a,b\n1,2\n');
});

test('dl/ sends markdown as an attachment and a dotfile-named download', async (t) => {
  const app = await startApp(t);
  const md = await publish(app, { path: await fixtureFile(t, 'n.md', '# x'), title: 'Doc' });
  const res = await app.get(`/dl/${md.id}/1`);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.equal(res.text, '# x');
  const dot = await publish(app, { path: await fixtureFile(t, '.env.example', 'A=1'), title: 'Dot' });
  assert.equal((await app.get(`/dl/${dot.id}/1`)).text, 'A=1');
});

test('dl/ for a static version is a tar.gz of the site named <id>-v<n>.tar.gz that round-trips', async (t) => {
  const { app, art } = await staticApp(t);
  const res = await fetch(`${app.base}/dl/${art.id}/1`);
  assert.match(res.headers.get('content-disposition'), new RegExp(`attachment; filename="${art.id}-v1.tar.gz"`));
  const out = path.join(await tmp(t), 'dl.tgz');
  await fsp.writeFile(out, Buffer.from(await res.arrayBuffer()));
  const unpack = await tmp(t);
  await tar.x({ file: out, cwd: unpack });
  assert.equal(await fsp.readFile(path.join(unpack, 'docs/guide.txt'), 'utf8'), 'guide');
  assert.equal(await fsp.readFile(path.join(unpack, 'index.html'), 'utf8'), '<h1>home</h1>');
});

test('dl/ pinned to an older version serves that version', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'a.bin', 'old'), title: 'Bin' });
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureFile(t, 'b.bin', 'new') });
  assert.equal((await app.get(`/dl/${art.id}/1`)).text, 'old');
  assert.equal((await app.get(`/dl/${art.id}/2`)).text, 'new');
});

test('unknown ids and versions are 404 plain text, never a stack or a path', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'a.bin', 'x'), title: 'Bin' });
  for (const url of ['/a/nope-abc123/', '/a/NOPE/', '/a/../x', `/dl/${art.id}/2`, `/dl/${art.id}/0`, `/dl/${art.id}/x`, '/dl/nope-abc123/1', `/a/${art.id}/v/9/`]) {
    const res = await app.get(url);
    assert.equal(res.status, 404, url);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.ok(!res.text.includes(app.storeDir));
  }
});

test('with no store configured the content routes answer 503 plain text', async (t) => {
  const app = await startApp(t, { unconfigured: true });
  assert.equal((await app.get('/a/x-abc123/')).status, 503);
});
