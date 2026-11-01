// Pins the "← Artifacts" link on every server-rendered artifact page: it reaches the overview list filtered to the
// artifact's project, from any URL depth, and encodes an untrusted project name as one param.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publish, fixtureFile, fixtureDir } from './_helpers.mjs';
import { startApps, appSource } from './_apps.mjs';
import { markdownPage, staticPage } from '../src/pages.js';
import { parseRoute } from '../frontend/src/lib/artifacts.ts';

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const backHref = (html) => {
  const m = /<a [^>]*href="([^"]*)"[^>]*>(?:(?!<\/a>)[\s\S])*Artifacts<\/a>/.exec(html);
  assert.ok(m, 'the page has an Artifacts link');
  return unescape(m[1]);
};
const caller = { sessionId: 's1', project: 'proj-a' };
const BASE = 'http://plugin.test';

async function assertBack(app, pagePath, project = 'proj-a') {
  const res = await app.get(pagePath);
  assert.equal(res.status, 200, pagePath);
  const url = new URL(backHref(res.text), `${BASE}${pagePath}`);
  assert.equal(url.pathname, '/', `${pagePath} links to the plugin root`);
  assert.deepEqual(parseRoute(url.search), { view: 'list', project });
}

test('every artifact view links back to the overview list filtered to its project', async (t) => {
  const app = await startApps(t);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' }, caller);
  const dl = await publish(app, { path: await fixtureFile(t, 'data.bin', 'D'), title: 'Bin' }, caller);
  const st = await publish(app, { path: await fixtureDir(t, { 'index.html': 'ONE' }), title: 'Site' }, caller);
  const ap = await publish(app, { path: await appSource(t), title: 'App' }, caller);
  for (const art of [md, dl, st, ap]) await assertBack(app, `/a/${art.id}/`);
});

test('the back link resolves to the plugin root from any URL depth', async (t) => {
  const app = await startApps(t);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' }, caller);
  const st = await publish(app, { path: await fixtureDir(t, { 'index.html': 'ONE', 'docs/a.html': 'a' }), title: 'Site' }, caller);
  const ap = await publish(app, { path: await appSource(t), title: 'App' }, caller);
  const up = await app.mcp('update_artifact', { artifact: ap.id, path: await appSource(t, { version: '2' }) });
  assert.ifError(up.data.error);
  await assertBack(app, `/a/${md.id}/v/1/`);
  await assertBack(app, `/a/${st.id}/v/1/docs/a.html`);
  await assertBack(app, `/a/${st.id}/docs/a.html`);
  await assertBack(app, `/a/${ap.id}/v/1/`);
});

test('an untrusted project name cannot add a param or break the attribute', () => {
  const project = 'x&artifact=y"<b>';
  const version = { n: 1, title: 'T', file: 'f', bytes: 1, publishedAt: '2026-01-01T00:00:00Z' };
  const htmls = [
    markdownPage({ prefix: '../../', id: 'i', project, version, latest: true, rendered: '' }),
    staticPage({ prefix: '../../', id: 'i', project, version, latest: true, frameSrc: 'f' }),
  ];
  for (const html of htmls) {
    assert.deepEqual(parseRoute(new URL(backHref(html), BASE).search), { view: 'list', project });
    assert.ok(!html.includes('"<b>'), 'the project name is escaped in the markup');
  }
});
