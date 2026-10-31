// Pins the app wrapper page: what it frames or shows per state, the version rules (only the latest runs), the sub-path
// and query it forwards into the frame, that it is never cached, and its script asset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appSource, publishApp, runApp, startApps, waitStatus } from './_apps.mjs';
import { rawGet } from './_helpers.mjs';

const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const attr = (html, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m && unescape(m[1]);
};
const frameSrc = (html) => {
  const m = /<iframe[^>]*\ssrc="([^"]*)"/.exec(html);
  return m && unescape(m[1]);
};
const page = async (app, url) => {
  const res = await app.get(url);
  assert.equal(res.status, 200, url);
  return res;
};

test('a running latest version frames the proxied app, forwarding the sub-path and query', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const root = await page(app, `/a/${pub.id}/`);
  assert.equal(frameSrc(root.text), `../../app/${pub.id}/`);
  assert.match(root.text, /v1 · latest/);
  assert.equal(attr(root.text, 'data-status'), 'running');

  const deep = await page(app, `/a/${pub.id}/foo/bar?x=1&y=%22q%22`);
  assert.equal(frameSrc(deep.text), `../../../app/${pub.id}/foo/bar?x=1&y=%22q%22`);
  const hidden = await page(app, `/a/${pub.id}/.well-known/x`);
  assert.equal(frameSrc(hidden.text), `../../../app/${pub.id}/.well-known/x`, 'dot-led paths belong to the app');
});

test('a stopped app has no frame and offers Start', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const { text } = await page(app, `/a/${pub.id}/`);
  assert.equal(frameSrc(text), null);
  assert.equal(attr(text, 'data-status'), 'stopped');
  assert.equal(attr(text, 'data-api'), `../../api/apps/${pub.id}`);
  assert.match(text, /<button[^>]*data-role="start"[^>]*>Start<\/button>/);
  assert.doesNotMatch(text, /data-role="start"[^>]*hidden/, 'the Start control is visible');
});

test('a failed app shows its error, escaped, and offers Start again', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'echo "<b>boom</b>" >&2; exit 4' } });
  await app.post(`/api/apps/${pub.id}/start`, {});
  await waitStatus(app, pub.id, 'failed');
  const { text } = await page(app, `/a/${pub.id}/`);
  assert.equal(attr(text, 'data-status'), 'failed');
  assert.match(text, /exited with code 4 before listening/);
  assert.equal(frameSrc(text), null);
  assert.match(text, /data-role="start"/);
});

test('the wrapper has a bar-level alert region for a refused Start or Stop, hidden until needed', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  for (const run of [false, true]) {
    if (run) await runApp(app, pub.id);
    const { text } = await page(app, `/a/${pub.id}/`);
    assert.match(text, /<p[^>]*data-role="action-error"[^>]*role="alert"[^>]*hidden/, `running=${run}`);
  }
});

test('a pinned link to the latest version runs like latest, badged pinned', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const { text } = await page(app, `/a/${pub.id}/v/1/`);
  assert.equal(frameSrc(text), `../../../../app/${pub.id}/`);
  assert.match(text, /v1 · pinned/);
  assert.equal(attr(text, 'data-api'), `../../../../api/apps/${pub.id}`);
});

test('a pinned link to an older version does not run: a notice and a link to the latest, no controls', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { version: '1' });
  const upd = await app.mcp('update_artifact', { artifact: pub.id, path: await appSource(t, { version: '2' }) });
  assert.equal(upd.data.result.version, 2);
  const { text } = await page(app, `/a/${pub.id}/v/1/`);
  assert.equal(attr(text, 'data-api'), null);
  assert.equal(frameSrc(text), null);
  assert.doesNotMatch(text, /data-role="start"|data-role="toggle"/);
  assert.match(text, /v1 does not run; only the latest \(v2\) runs/);
  assert.match(text, new RegExp(`href="../../../../a/${pub.id}/"[^>]*>Open latest`));
  assert.doesNotMatch(text, /app-page\.js/, 'nothing to drive');
});

test('every app page is no-cache, pinned or not, running or not', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  for (const url of [`/a/${pub.id}/`, `/a/${pub.id}/v/1/`]) {
    assert.equal((await page(app, url)).headers.get('cache-control'), 'no-cache', url);
  }
  await runApp(app, pub.id);
  for (const url of [`/a/${pub.id}/`, `/a/${pub.id}/v/1/`]) {
    assert.equal((await page(app, url)).headers.get('cache-control'), 'no-cache', url);
  }
});

test('a sub-path that climbs out of the app, or holds a backslash, is 404', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  for (const p of [`/a/${pub.id}/%2e%2e/x`, `/a/${pub.id}/a/%2E%2E/b`, `/a/${pub.id}/a%5Cb`]) {
    assert.equal((await rawGet(app, p)).status, 404, p);
  }
});

test('the wrapper\'s script is served', async (t) => {
  const app = await startApps(t);
  const res = await app.get('/_page/app-page.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});
