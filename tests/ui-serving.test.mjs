// Pins UI serving per the plugin UI reference: a plain-text 503 while unbuilt, host URLs and non-allowlisted files are 404,
// the CSP and nosniff are on every response, and the UI never shadows the API or content routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmp, startApp, fixtureFile, publish, writeTree } from './_helpers.mjs';

async function builtDist(t) {
  const dist = path.join(await tmp(t), 'dist');
  await writeTree(dist, {
    'index.html': '<!doctype html><title>ui</title>', 'theme-init.js': '//x', 'assets/index-AbC_123.js': '//js', 'assets/index-AbC_123.css': 'a{}',
    'assets/index-AbC_123.js.map': '{}', '.hidden.js': '//h', '.vite/manifest.json': '{}', 'secret.txt': 'no',
  });
  return dist;
}

test('unbuilt: / is a plain-text 503, other html too, every other path is 404 including the host URLs', async (t) => {
  const dist = path.join(await tmp(t), 'missing');
  const app = await startApp(t, { distDir: dist });
  t.mock.method(console, 'error', () => {});
  const root = await app.get('/');
  assert.equal(root.status, 503);
  assert.match(root.headers.get('content-type'), /text\/plain/);
  assert.equal((await app.get('/index.html')).status, 503);
  for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/assets/index-AbC_123.js', '/theme-init.js', '/nothing']) {
    assert.equal((await app.get(p)).status, 404, p);
  }
  assert.equal((await app.get('/api/health')).status, 200, 'the API stays up');
});

test('built: the allowlisted files are served', async (t) => {
  const app = await startApp(t, { distDir: await builtDist(t) });
  assert.match((await app.get('/')).text, /<title>ui<\/title>/);
  assert.equal((await app.get('/index.html')).status, 200);
  assert.equal((await app.get('/theme-init.js')).status, 200);
  const js = await app.get('/assets/index-AbC_123.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await app.get('/assets/index-AbC_123.css')).status, 200);
});

test('built: .map files, dotfiles, .vite/, other extensions and the host URLs are 404, percent-encoding included', async (t) => {
  const app = await startApp(t, { distDir: await builtDist(t) });
  for (const p of ['/assets/index-AbC_123.js.map', '/assets/index-AbC_123%2Ejs%2Emap', '/assets/index-AbC_123.JS.MAP', '/.hidden.js', '/.vite/manifest.json', '/secret.txt', '/pluginBridge.js', '/pluginTheme.css', '/assets/', '/assets/nope.js']) {
    assert.equal((await app.get(p)).status, 404, p);
  }
});

test('built: a symlink in dist that leaves dist is 404', async (t) => {
  const dist = await builtDist(t);
  const outside = await fixtureFile(t, 'out.js', '//secret');
  await fsp.symlink(outside, path.join(dist, 'assets', 'leak-1.js'));
  const app = await startApp(t, { distDir: dist });
  assert.equal((await app.get('/assets/leak-1.js')).status, 404);
});

test('built: there is no SPA fallback for an unknown route', async (t) => {
  const app = await startApp(t, { distDir: await builtDist(t) });
  const res = await app.get('/some/route');
  assert.equal(res.status, 404);
  assert.ok(!res.text.includes('<title>ui</title>'));
});

test('the CSP and nosniff are on every response: UI, API, 404, 503, 415 and errors', async (t) => {
  const missing = path.join(await tmp(t), 'missing');
  t.mock.method(console, 'error', () => {});
  const app = await startApp(t, { distDir: missing });
  const built = await startApp(t, { distDir: await builtDist(t) });
  const responses = [
    await app.get('/'), await app.get('/nope'), await app.get('/api/health'), await app.get('/api/artifacts/zzz'),
    await app.raw('POST', '/api/prune', '{}', { 'content-type': 'text/plain' }), await app.raw('POST', '/api/prune', '{bad', { 'content-type': 'application/json' }),
    await built.get('/'), await built.get('/assets/index-AbC_123.js'), await built.get('/pluginTheme.css'),
  ];
  for (const r of responses) {
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'; script-src 'self'/, `${r.status}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('the CSP lets the host assets and the UI work: self scripts and fonts, inline styles, https/data images, same-origin frames only', async (t) => {
  const app = await startApp(t);
  const csp = (await app.get('/api/health')).headers.get('content-security-policy');
  for (const d of ["script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'", 'img-src \'self\' https: data:', "connect-src 'self'", "frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(csp.includes(d), d);
  }
});

test('the built UI uses only relative asset URLs', async () => {
  const html = await fsp.readFile(new URL('../frontend/dist/index.html', import.meta.url), 'utf8').catch(() => null);
  if (html === null) return; // the real build is exercised by `npm run prepare`
  const rootRelative = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(rootRelative.sort(), ['/pluginBridge.js', '/pluginTheme.css']);
});

test('the UI route does not shadow content or API routes', async (t) => {
  const app = await startApp(t, { distDir: await builtDist(t) });
  const art = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' });
  assert.match((await app.get(`/a/${art.id}/`)).text, /<article class="md">/);
  assert.equal((await app.get('/api/artifacts')).status, 200);
});
