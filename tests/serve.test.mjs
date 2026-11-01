// Pins content serving: latest vs pinned versions and their cache headers, static path resolution and its traversal refusals,
// the CSP split between pages and static sites, markdown/download pages, attachments, image previews and dl/'s sandbox CSP, and 404s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { fixtureDir, fixtureFile, publish, rawGet, startApp, tmp } from './_helpers.mjs';

const SITE = { 'index.html': '<h1>home</h1>', 'app.js': 'console.log(1)', 'docs/index.html': 'docs', 'docs/guide.txt': 'guide', 'empty/': '', '.secret': 'nope', 'sub/.hidden/x.txt': 'nope' };

async function staticApp(t, files = SITE) {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureDir(t, files), title: 'Site' });
  return { app, art };
}

const CSP_RE = /default-src 'none'/;

test('raw/<id>/<n> serves the version it names, immutable, whatever is latest; the latest route is a no-cache wrapper', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureDir(t, { 'index.html': 'ONE' }), title: 'Site' });
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureDir(t, { 'index.html': 'TWO' }) });
  const one = await app.get(`/raw/${art.id}/1/`);
  assert.equal(one.text, 'ONE');
  assert.equal(one.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal((await app.get(`/raw/${art.id}/2/`)).text, 'TWO');
  assert.equal((await app.get(`/raw/${art.id}/3/`)).status, 404);
  assert.equal((await app.get(`/raw/${art.id}/0/`)).status, 404);
  assert.equal((await app.get(`/a/${art.id}/`)).headers.get('cache-control'), 'no-cache');
  assert.equal((await app.get(`/a/${art.id}/v/1/`)).headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal((await app.get(`/a/${art.id}/v/3/`)).status, 404);
});

test('raw: only static artifacts are served, and an unknown id is 404', async (t) => {
  const app = await startApp(t);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' });
  const dl = await publish(app, { path: await fixtureFile(t, 'data.bin', 'DATA'), title: 'Bin' });
  // The files exist in the store, so only the kind check can refuse them.
  for (const url of [`/raw/${md.id}/1/a.md`, `/raw/${md.id}/1/`, `/raw/${dl.id}/1/data.bin`, `/raw/${dl.id}/1/`]) assert.equal((await app.get(url)).status, 404, url);
  assert.equal((await app.get(`/dl/${dl.id}/1`)).text, 'DATA', 'the same file is served by dl/');
  assert.equal((await app.get('/raw/nope-abc123/1/')).status, 404);
  assert.equal((await app.get('/raw/NOPE/1/')).status, 404);
});

test('raw: index.html is the default, files and nested index.html serve, with their content types', async (t) => {
  const { app, art } = await staticApp(t);
  assert.equal((await app.get(`/raw/${art.id}/1/`)).text, '<h1>home</h1>');
  const js = await app.get(`/raw/${art.id}/1/app.js`);
  assert.equal(js.text, 'console.log(1)');
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await app.get(`/raw/${art.id}/1/docs/`)).text, 'docs');
  assert.equal((await app.get(`/raw/${art.id}/1/docs/guide.txt`)).text, 'guide');
});

test('raw: raw/<id>/<n> and a directory without a slash get a relative 301; an empty directory and a file with a slash are 404', async (t) => {
  const { app, art } = await staticApp(t);
  const bare = await app.get(`/raw/${art.id}/1`);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '1/');
  const r = await app.get(`/raw/${art.id}/1/docs`);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'docs/');
  assert.equal((await app.get(`/raw/${art.id}/1/empty/`)).status, 404, 'no listings');
  assert.equal((await app.get(`/raw/${art.id}/1/app.js/`)).status, 404);
  assert.equal((await app.get(`/raw/${art.id}/1/missing.txt`)).status, 404);
});

test('raw: dot segments, encoded slashes and backslashes, and dotfiles are 404', async (t) => {
  const { app, art } = await staticApp(t);
  for (const p of ['%2e%2e/%2e%2e/x', '%2e%2e/x', '..%2fapp.js', 'docs%2fguide.txt', 'docs%5cguide.txt', '.secret', 'sub/.hidden/x.txt', '%2esecret', 'docs//guide.txt', '%00']) {
    assert.equal((await rawGet(app, `/raw/${art.id}/1/${p}`)).status, 404, p);
  }
  assert.equal((await app.get(`/raw/${art.id}/1/%zz`)).status, 400, 'an undecodable path is refused by the router');
  const raw = await rawGet(app, `/raw/${art.id}/1/../../../api/health`);
  assert.equal(raw.status, 404);
  assert.notEqual(raw.body, '{"ok":true}');
});

test('raw: a symlink planted in the store after ingest is 404, to a file or a directory outside the content', async (t) => {
  const { app, art } = await staticApp(t);
  const content = path.join(app.storeDir, 'artifacts', art.id, 'v', '1', 'content');
  const outside = await tmp(t);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
  await fsp.symlink(path.join(outside, 'secret.txt'), path.join(content, 'leak.txt'));
  await fsp.symlink(outside, path.join(content, 'leakdir'));
  await fsp.symlink(path.join(content, 'app.js'), path.join(content, 'inner.js'));
  for (const p of ['leak.txt', 'leakdir/secret.txt', 'leakdir/', 'inner.js']) assert.equal((await app.get(`/raw/${art.id}/1/${p}`)).status, 404, p);
});

test('raw responses carry no plugin CSP but keep nosniff; the wrapper, other pages and the API keep the CSP', async (t) => {
  const { app, art } = await staticApp(t);
  const site = await app.get(`/raw/${art.id}/1/`);
  assert.equal(site.headers.get('content-security-policy'), null);
  assert.equal(site.headers.get('x-content-type-options'), 'nosniff');
  assert.match((await app.get(`/a/${art.id}/`)).headers.get('content-security-policy'), CSP_RE);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# hi'), title: 'Doc' });
  assert.match((await app.get(`/a/${md.id}/`)).headers.get('content-security-policy'), CSP_RE);
  assert.match((await app.get('/api/health')).headers.get('content-security-policy'), CSP_RE);
  const miss = await app.get(`/raw/${art.id}/1/missing`);
  assert.equal(miss.status, 404);
  assert.match(miss.headers.get('content-security-policy'), CSP_RE, 'a 404 under the raw route still carries the CSP');
});

const frameSrc = (html) => /<iframe[^>]* src="([^"]*)"/.exec(html)?.[1];

test('the static wrapper is a plugin page at latest, pinned and subpath URLs: bridge, theme, nav.js, CSP with the frame allowance', async (t) => {
  const { app, art } = await staticApp(t);
  for (const url of [`/a/${art.id}/`, `/a/${art.id}/v/1/`, `/a/${art.id}/docs/guide.txt`, `/a/${art.id}/v/1/docs/`]) {
    const res = await app.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const head = res.text.slice(res.text.indexOf('<head>'));
    assert.ok(head.indexOf('/pluginBridge.js') < head.indexOf('/pluginTheme.css'), url);
    assert.match(head, /_page\/nav\.js"/, url);
    assert.match(head, /_page\/theme-init\.js"/, url);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /frame-src 'self'(;|$)/, url);
    assert.ok(!/frame-src [^;]*(\*|https?:|data:)/.test(csp), 'the frame allowance is same-origin only');
    assert.ok(!/<iframe[^>]*\bsandbox\b/.test(res.text), 'the site frame is not sandboxed');
    assert.match(res.text, /class="badge">v1 · (latest|pinned)</);
    assert.match(res.text, /href="(\.\.\/)+dl\/[^"]+\/1"/, 'a relative Download link');
  }
});

test('the wrapper iframe src is relative and names the right version: latest follows the newest, pinned stays, the subpath carries through', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureDir(t, { 'index.html': 'ONE', 'docs/a.html': 'a' }), title: 'Site' });
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureDir(t, { 'index.html': 'TWO', 'docs/a.html': 'a' }) });
  assert.equal(frameSrc((await app.get(`/a/${art.id}/`)).text), `../../raw/${art.id}/2/`);
  assert.equal(frameSrc((await app.get(`/a/${art.id}/v/1/`)).text), `../../../../raw/${art.id}/1/`);
  assert.equal(frameSrc((await app.get(`/a/${art.id}/docs/a.html`)).text), `../../../raw/${art.id}/2/docs/a.html`);
  assert.equal(frameSrc((await app.get(`/a/${art.id}/v/1/docs/a.html`)).text), `../../../../../raw/${art.id}/1/docs/a.html`);
  assert.equal(frameSrc((await app.get(`/a/${art.id}/docs?x=1&y=2`)).text), `../../raw/${art.id}/2/docs?x=1&amp;y=2`, 'a query is forwarded, escaped');
  for (const url of [`/a/${art.id}/`, `/a/${art.id}/v/1/docs/a.html`]) assert.ok(!/^(\/|[a-z]+:)/.test(frameSrc((await app.get(url)).text)), 'never root-relative or absolute');
});

test('the wrapper src resolves, from the wrapper URL, to the raw route that serves the site', async (t) => {
  const { app, art } = await staticApp(t);
  for (const url of [`/a/${art.id}/`, `/a/${art.id}/v/1/docs/guide.txt`]) {
    const wrapper = new URL(url, `${app.base}/`);
    const target = new URL(frameSrc((await app.get(url)).text), wrapper);
    assert.match(target.pathname, new RegExp(`^/raw/${art.id}/1/`));
    assert.equal((await app.get(target.pathname)).status, 200, url);
  }
});

test('the wrapper refuses unsafe subpaths and unknown ids or versions with a 404, and a directory without a slash still wraps', async (t) => {
  const { app, art } = await staticApp(t);
  for (const p of ['%2e%2e/x', '../x', 'docs%2fguide.txt', '.secret', 'docs//guide.txt']) assert.equal((await rawGet(app, `/a/${art.id}/${p}`)).status, 404, p);
  assert.equal((await app.get(`/a/${art.id}/v/9/`)).status, 404);
  assert.equal((await app.get(`/a/nope-abc123/docs/`)).status, 404);
  assert.equal((await app.get(`/a/${art.id}/docs`)).status, 200);
});

test('a/<id> and a/<id>/v/<n> redirect to a relative trailing-slash URL', async (t) => {
  const { app, art } = await staticApp(t);
  const r1 = await app.get(`/a/${art.id}`);
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get('location'), `${art.id}/`);
  const r2 = await app.get(`/a/${art.id}/v/1`);
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.get('location'), '1/');
});

test('a lone html file is the site root of its raw version', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'page.html', '<p>lone</p>'), title: 'Lone' });
  assert.equal(art.kind, 'static');
  assert.equal((await app.get(`/raw/${art.id}/1/`)).text, '<p>lone</p>');
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

const imgSrcs = (html) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => /\ssrc="([^"]*)"/.exec(m[0])?.[1]);
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>/*EVIL_MARKER*/</script><image href="https://example.invalid/x.png"/></svg>';

test('download: an image\'s landing page previews it from dl/ and keeps Download', async (t) => {
  const app = await startApp(t);
  for (const name of ['a.png', 'a.jpg', 'a.JPEG', 'a.gif', 'a.webp', 'a.svg']) {
    const art = await publish(app, { path: await fixtureFile(t, name, 'IMG'), title: 'Pic' });
    const latest = await app.get(`/a/${art.id}/`);
    assert.deepEqual(imgSrcs(latest.text), [`../../dl/${art.id}/1`], name);
    assert.ok(latest.text.includes(`href="../../dl/${art.id}/1">Download</a>`), name);
    const pinned = await app.get(`/a/${art.id}/v/1/`);
    assert.deepEqual(imgSrcs(pinned.text), [`../../../../dl/${art.id}/1`], name);
    assert.ok(pinned.text.includes(`href="../../../../dl/${art.id}/1">Download</a>`), name);
  }
  const art = await publish(app, { path: await fixtureFile(t, 'b.png', 'ONE'), title: 'Pic' });
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureFile(t, 'b.png', 'TWO') });
  assert.deepEqual(imgSrcs((await app.get(`/a/${art.id}/`)).text), [`../../dl/${art.id}/2`], 'latest previews the latest version');
  assert.deepEqual(imgSrcs((await app.get(`/a/${art.id}/v/1/`)).text), [`../../../../dl/${art.id}/1`], 'pinned previews its own version');
});

test('download: the image preview\'s alt is the HTML-escaped title', async (t) => {
  const app = await startApp(t);
  const title = `a"b<i>c'd>`;
  const art = await publish(app, { path: await fixtureFile(t, 'a.png', 'IMG'), title });
  const { text } = await app.get(`/a/${art.id}/`);
  const imgs = [...text.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 1);
  assert.equal(/\salt="([^"]*)"/.exec(imgs[0])?.[1], 'a&quot;b&lt;i&gt;c&#39;d&gt;');
  assert.ok(!text.includes(title), 'the raw title appears nowhere');
  assert.ok(!text.includes('<i>'), 'the title injects no markup');
});

test('download: a non-image landing page has no preview', async (t) => {
  const app = await startApp(t);
  const sources = [
    ['report.csv', await fixtureFile(t, 'report.csv', 'a,b')], ['a.bmp', await fixtureFile(t, 'a.bmp', 'x')], ['png', await fixtureFile(t, 'png', 'x')],
    ['x.png.txt', await fixtureFile(t, 'x.png.txt', 'x')], ['shots.png.tar.gz', await fixtureDir(t, { 'x.png': 'x' }, 'shots.png')],
  ];
  for (const [file, src] of sources) {
    const art = await publish(app, { path: src, title: 'File' });
    const landing = await app.get(`/a/${art.id}/`);
    assert.ok(!landing.text.includes('<img'), file);
    assert.ok(landing.text.includes(`<p class="file">${file}</p>`), file);
    assert.ok(landing.text.includes(`href="../../dl/${art.id}/1">Download</a>`), file);
  }
});

test('every previewable extension is served by dl/ as image/*', async (t) => {
  const { isPreviewImage } = await import('../src/pages.js');
  const app = await startApp(t);
  for (const name of ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.JPEG', 'a.gif', 'a.webp', 'a.svg']) {
    assert.ok(isPreviewImage(name), name);
    const art = await publish(app, { path: await fixtureFile(t, name, 'IMG'), title: 'Pic' });
    const res = await app.get(`/dl/${art.id}/1`);
    assert.match(res.headers.get('content-type'), /^image\//, name);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
  }
  for (const name of ['a.bmp', 'a.ico', 'a.avif', 'png', 'x.png.txt', 'a.svgz']) assert.ok(!isPreviewImage(name), name);
});

test('dl/ can\'t render an SVG as a page: attachment, nosniff, sandboxing CSP with no script source', async (t) => {
  const app = await startApp(t);
  const svg = await publish(app, { path: await fixtureFile(t, 'evil.svg', EVIL_SVG), title: 'Evil' });
  const csv = await publish(app, { path: await fixtureFile(t, 'r.csv', 'a'), title: 'Csv' });
  const site = await publish(app, { path: await fixtureDir(t, SITE), title: 'Site' });
  for (const url of [`/dl/${svg.id}/1`, `/dl/${csv.id}/1`, `/dl/${site.id}/1`]) {
    const res = await app.get(url);
    assert.match(res.headers.get('content-disposition'), /^attachment/, url);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /(^|;\s*)sandbox(;|$)/, url);
    assert.match(csp, /default-src 'none'/, url);
    for (const bad of ['script-src', "'self'", 'https:']) assert.ok(!csp.includes(bad), `${url}: ${bad}`);
  }
});

test('the SVG preview is an <img>, never inlined or embedded', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'evil.svg', EVIL_SVG), title: 'Evil' });
  const landing = await app.get(`/a/${art.id}/`);
  assert.deepEqual(imgSrcs(landing.text), [`../../dl/${art.id}/1`]);
  for (const bad of ['<svg', 'EVIL_MARKER', 'example.invalid', '<object', '<embed', '<iframe']) assert.ok(!landing.text.includes(bad), bad);
  assert.match(landing.headers.get('content-security-policy'), CSP_RE);
  assert.match(landing.headers.get('content-security-policy'), /script-src 'self'/);
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
