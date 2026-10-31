// Pins the app proxy: the pure rewrite rules (path modes, forwarded headers, Location, Set-Cookie) and the end-to-end
// behaviour in both prefix modes — HTTP, bodies, headers, redirects, cookies, and WebSocket upgrades.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardHeaders, rewriteLocation, rewriteSetCookie, selfOrigins, upstreamPath } from '../src/appRewrite.js';
import { echoOnce, publishApp, rawUpgrade, runApp, socketClosed, startApps, waitFor } from './_apps.mjs';
import { fixtureDir, publish } from './_helpers.mjs';

const MOUNT = '/plugins/code-artifact';
const BASE = `${MOUNT}/app/a1`;

test('upstreamPath: strip forwards the sub-path, keep puts it under the base path', () => {
  assert.equal(upstreamPath('strip', BASE, '/x?q=1'), '/x?q=1');
  assert.equal(upstreamPath('keep', BASE, '/x?q=1'), `${BASE}/x?q=1`);
  assert.equal(upstreamPath('keep', BASE, '/'), `${BASE}/`);
});

test('forwardHeaders replaces Host and the X-Forwarded set, keeping the rest in order and casing', () => {
  const raw = ['Host', 'share.example', 'Cookie', 'a=1', 'x-forwarded-prefix', '/plugins/code-artifact', 'Origin', 'https://share.example', 'X-Custom', 'v'];
  const out = forwardHeaders(raw, { upstreamHost: '127.0.0.1:9', basePath: BASE, remoteAddress: '10.0.0.1' });
  assert.deepEqual(out, [
    'Cookie', 'a=1', 'Origin', 'https://share.example', 'X-Custom', 'v',
    'Host', '127.0.0.1:9', 'X-Forwarded-Host', 'share.example', 'X-Forwarded-Proto', 'http', 'X-Forwarded-Prefix', BASE, 'X-Forwarded-For', '10.0.0.1',
  ]);
});

test('forwardHeaders keeps an incoming X-Forwarded-Host, -Proto and -For', () => {
  const raw = ['host', 'internal', 'X-FORWARDED-HOST', 'cc.example', 'X-Forwarded-Proto', 'https', 'X-Forwarded-For', '1.2.3.4'];
  const out = forwardHeaders(raw, { upstreamHost: '[::1]:9', basePath: BASE, remoteAddress: '10.0.0.1' });
  assert.deepEqual(out, [
    'Host', '[::1]:9', 'X-Forwarded-Host', 'cc.example', 'X-Forwarded-Proto', 'https', 'X-Forwarded-Prefix', BASE, 'X-Forwarded-For', '1.2.3.4',
  ]);
});

const loc = (value) => rewriteLocation(value, {
  basePath: BASE, mount: MOUNT, id: 'a1',
  upstreamOrigins: ['http://127.0.0.1:5000', 'http://localhost:5000', 'http://[::1]:5000', 'https://share.example'],
});

test('rewriteLocation: relative and external values pass; the app\'s own origin and root-absolute paths land under /app/<id>', () => {
  const table = [
    ['next', 'next'], ['./x?y=1', './x?y=1'], ['../x', '../x'], ['?q=1', '?q=1'],
    ['https://other.example/p', 'https://other.example/p'], ['//other.example/p', '//other.example/p'], ['mailto:a@b.c', 'mailto:a@b.c'],
    ['http://127.0.0.1:5000/login?x=1#h', '/app/a1/login?x=1#h'],
    ['https://share.example/login', '/app/a1/login'],
    ['//localhost:5000/z', '/app/a1/z'],
    ['http://127.0.0.1:5000', '/app/a1/'],
    [`${BASE}/x?y=1`, '/app/a1/x?y=1'], [BASE, '/app/a1'], [`${BASE}?q`, '/app/a1?q'], [`${BASE}#h`, '/app/a1#h'],
    [`http://127.0.0.1:5000${BASE}/z`, '/app/a1/z'],
    ['/login', '/app/a1/login'], ['/', '/app/a1/'], ['/a?b=1#c', '/app/a1/a?b=1#c'],
    [`${BASE}x`, `/app/a1${BASE}x`],
  ];
  for (const [input, want] of table) assert.equal(loc(input), want, input);
});

test('selfOrigins names the app and the client\'s host under both schemes', () => {
  assert.deepEqual(selfOrigins(5000, 'share.example'), [
    'http://127.0.0.1:5000', 'http://localhost:5000', 'http://[::1]:5000', 'http://share.example', 'https://share.example',
  ]);
  assert.equal(selfOrigins(5000, undefined).length, 3);
});

const cookie = (value) => rewriteSetCookie(value, { basePath: BASE });

test('rewriteSetCookie confines Path to the base path and leaves everything else alone', () => {
  const table = [
    ['a=1; Path=/', `a=1; Path=${BASE}/`],
    ['a=1; path=/x', `a=1; Path=${BASE}/x`],
    ['a=1;PATH=/x; HttpOnly', `a=1;Path=${BASE}/x; HttpOnly`],
    [`a=1; Path=${BASE}`, `a=1; Path=${BASE}`],
    [`a=1; Path=${BASE}/sub`, `a=1; Path=${BASE}/sub`],
    [`a=1; Path=${BASE}x`, `a=1; Path=${BASE}${BASE}x`],
    ['a=1; HttpOnly', 'a=1; HttpOnly'],
    ['a=1', 'a=1'],
    ['a=1; Domain=x.example; Path=/; Secure; SameSite=Lax', `a=1; Domain=x.example; Path=${BASE}/; Secure; SameSite=Lax`],
    ['a=1; Path=relative', 'a=1; Path=relative'],
    ['path=/v', 'path=/v'], ['Path=/v; Path=/w', `Path=/v; Path=${BASE}/w`], ['path=/v; HttpOnly', 'path=/v; HttpOnly'],
  ];
  for (const [input, want] of table) assert.equal(cookie(input), want, input);
});

const keep = { start: 'node server.js', prefix: 'keep' };

test('strip mode forwards the sub-path and query, with Host and the forwarded headers set', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const res = await fetch(`${app.base}/app/${pub.id}/echo?q=1`, { headers: { 'x-forwarded-host': 'share.example', 'x-forwarded-prefix': '/plugins/code-artifact', cookie: 'c=1' } });
  const seen = await res.json();
  const proxyHost = new URL(app.base).host;
  assert.equal(seen.url, '/echo?q=1');
  assert.equal(seen.headers.host, `127.0.0.1:${seen.env.PORT}`, 'Host is the upstream address');
  assert.equal(seen.headers['x-forwarded-host'], 'share.example');
  assert.equal(seen.headers['x-forwarded-prefix'], seen.env.BASE_PATH, 'cc\'s prefix is replaced by the app\'s base path');
  assert.equal(seen.headers['x-forwarded-proto'], 'http');
  assert.equal(seen.headers.cookie, 'c=1', 'cookies pass untouched');

  const plain = await (await fetch(`${app.base}/app/${pub.id}/echo`)).json();
  assert.equal(plain.headers['x-forwarded-host'], proxyHost, 'without a forwarded host, the incoming Host is reported');
});

test('keep mode forwards the sub-path under BASE_PATH; strip does not', async (t) => {
  const app = await startApps(t);
  const kept = await publishApp(t, app, { manifest: keep, fixture: { requireBase: true } });
  const stripped = await publishApp(t, app, { fixture: { requireBase: true } });
  await runApp(app, kept.id);
  await runApp(app, stripped.id);
  const seen = await (await fetch(`${app.base}/app/${kept.id}/echo?q=1`)).json();
  assert.equal(seen.url, `/plugins/code-artifact/app/${kept.id}/echo?q=1`);
  const miss = await fetch(`${app.base}/app/${stripped.id}/echo`);
  assert.equal(miss.status, 404, 'a strip app that insists on its base path is not given it');
  assert.match(await miss.text(), /outside the base: \/echo/);
});

test('a urlencoded POST body reaches the app (the JSON gate does not apply) and is streamed whole', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const form = await fetch(`${app.base}/app/${pub.id}/body`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' });
  assert.equal(form.status, 200);
  assert.deepEqual(await form.json(), { length: 7, type: 'application/x-www-form-urlencoded' });
  const big = 'z'.repeat(3 * 1024 * 1024);
  const res = await fetch(`${app.base}/app/${pub.id}/body`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: big });
  assert.equal((await res.json()).length, big.length);
});

test('the app\'s own CSP is on its responses and the plugin\'s is not', async (t) => {
  const app = await startApps(t);
  const own = await publishApp(t, app, { fixture: { csp: "default-src 'self'" } });
  const none = await publishApp(t, app);
  await runApp(app, own.id);
  await runApp(app, none.id);
  const a = await fetch(`${app.base}/app/${own.id}/`);
  assert.equal(a.headers.get('content-security-policy'), "default-src 'self'");
  const b = await fetch(`${app.base}/app/${none.id}/`);
  assert.equal(b.headers.get('content-security-policy'), null);
  assert.equal(b.headers.get('x-content-type-options'), null);
});

test('a stopped app is 503, an unknown or non-app id is 404, both with the plugin\'s CSP', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const stopped = await fetch(`${app.base}/app/${pub.id}/x`);
  assert.equal(stopped.status, 503);
  assert.match(stopped.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${app.base}/app/nope-abc123/x`)).status, 404);
  const site = await publish(app, { path: await fixtureDir(t, { 'index.html': 'x' }), title: 's' });
  assert.equal((await fetch(`${app.base}/app/${site.id}/`)).status, 404);
});

test('app/<id> without a trailing slash redirects to <id>/ and keeps the query', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const bare = await fetch(`${app.base}/app/${pub.id}`, { redirect: 'manual' });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), `${pub.id}/`);
  const query = await fetch(`${app.base}/app/${pub.id}?a=1`, { redirect: 'manual' });
  assert.equal(query.headers.get('location'), `${pub.id}/?a=1`);
});

test('an app\'s redirects and cookies are rewritten into its URL space end to end', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const base = `/plugins/code-artifact/app/${pub.id}`;
  const redirect = (to) => fetch(`${app.base}/app/${pub.id}/redirect?to=${encodeURIComponent(to)}`, { redirect: 'manual' }).then((r) => r.headers.get('location'));
  assert.equal(await redirect('/login'), `/app/${pub.id}/login`);
  assert.equal(await redirect(`${base}/x?y=1`), `/app/${pub.id}/x?y=1`);
  assert.equal(await redirect('next'), 'next');
  assert.equal(await redirect('https://other.example/p'), 'https://other.example/p');

  // Behind an https share cc still forwards X-Forwarded-Proto: http, so the app's https self-link must still be recognised.
  const behindShare = (to) => fetch(`${app.base}/app/${pub.id}/redirect?to=${encodeURIComponent(to)}`, {
    redirect: 'manual', headers: { 'x-forwarded-host': 'share.example', 'x-forwarded-proto': 'http' },
  }).then((r) => r.headers.get('location'));
  assert.equal(await behindShare('https://share.example/x?y=1'), `/app/${pub.id}/x?y=1`);
  assert.equal(await behindShare('http://share.example/x'), `/app/${pub.id}/x`);
  assert.equal(await behindShare('https://other.example/x'), 'https://other.example/x');

  const query = ['a=1; Path=/', `b=2; Path=${base}/sub`, 'c=3'].map((c) => `c=${encodeURIComponent(c)}`).join('&');
  const res = await fetch(`${app.base}/app/${pub.id}/cookies?${query}`);
  assert.deepEqual(res.headers.getSetCookie(), [`a=1; Path=${base}/`, `b=2; Path=${base}/sub`, 'c=3']);
});

for (const [mode, manifest, seenUrl] of [
  ['strip', { start: 'node server.js' }, () => '/ws?x=1'],
  ['keep', keep, (id) => `/plugins/code-artifact/app/${id}/ws?x=1`],
]) {
  test(`a WebSocket upgrade passes through in ${mode} mode: the upstream URL, Host and prefix are right and bytes flow both ways`, async (t) => {
    const app = await startApps(t);
    const pub = await publishApp(t, app, { manifest, fixture: { requireBase: mode === 'keep' } });
    await runApp(app, pub.id);
    const port = (await (await fetch(`${app.base}/app/${pub.id}/echo`)).json()).env.PORT;
    const up = await rawUpgrade(app.base, `/app/${pub.id}/ws?x=1`, { Origin: 'http://cc.example' });
    t.after(() => up.socket?.destroy());
    assert.equal(up.status, 101);
    assert.equal(up.headers['x-seen-url'], seenUrl(pub.id));
    assert.equal(up.headers['x-seen-host'], `127.0.0.1:${port}`);
    assert.equal(up.headers['x-seen-prefix'], `/plugins/code-artifact/app/${pub.id}`);
    assert.equal(await echoOnce(up.socket, 'ping'), 'ping');
    assert.equal(await echoOnce(up.socket, 'pong'), 'pong');
  });
}

test('an upgrade to a stopped app is 503, one outside /app/ is 404, and the connection closes', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const stopped = await rawUpgrade(app.base, `/app/${pub.id}/ws`);
  assert.equal(stopped.status, 503);
  assert.equal((await rawUpgrade(app.base, '/ws')).status, 404);
  assert.equal((await rawUpgrade(app.base, '/app/nope-abc123/ws')).status, 404);
});

test('closing the client end of an upgraded socket closes the app\'s end of it', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const open = async () => (await (await fetch(`${app.base}/app/${pub.id}/ws-open`)).json()).open;
  assert.equal(await open(), 0);
  const up = await rawUpgrade(app.base, `/app/${pub.id}/ws`);
  assert.equal(await echoOnce(up.socket, 'a'), 'a');
  assert.equal(await open(), 1, 'the app holds the upgraded connection');
  up.socket.destroy();
  await waitFor(async () => (await open()) === 0, { what: 'the app to see its end close' });
});

test('an app that closes its end of an upgraded socket closes the client\'s', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const up = await rawUpgrade(app.base, `/app/${pub.id}/ws`);
  await echoOnce(up.socket, 'a');
  await app.post(`/api/apps/${pub.id}/stop`, {});
  await socketClosed(up.socket);
});
