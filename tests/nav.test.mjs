// Pins the steering contract: when cc replaces the document's path and fires popstate, the page reloads;
// a query-only or hash-only change does not. Also pins that every document of the plugin loads the script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';
import { fixtureFile, publish, startApp } from './_helpers.mjs';

const source = await fsp.readFile(new URL('../frontend/public/nav.js', import.meta.url), 'utf8');

/** Runs nav.js as a document would: `pathname`/`search` are live, `marked` says whether <html> carries the marker. */
function load(pathname, { search = '', marked = false } = {}) {
  const listeners = [];
  const location = { pathname, search, hash: '', reloaded: 0, reload() { this.reloaded++; } };
  const document = { documentElement: { hasAttribute: (name) => marked && name === 'data-reload-on-search' } };
  vm.runInNewContext(source, { location, document, window: { addEventListener: (type, fn) => listeners.push([type, fn]) } });
  assert.deepEqual(listeners.map(([t]) => t), ['popstate']);
  return { location, popstate: listeners[0][1] };
}

test('a popstate after the path changed reloads, in the UI document and in a server-rendered page', () => {
  for (const marked of [false, true]) {
    const { location, popstate } = load('/plugins/code-artifact/a/one/', { marked });
    location.pathname = '/plugins/code-artifact/a/two/';
    popstate();
    assert.equal(location.reloaded, 1, `marked=${marked}`);
  }
});

test('the UI document (no marker) does not reload on a query-only or hash-only change: the query is its own routing', () => {
  const { location, popstate } = load('/plugins/code-artifact/');
  location.search = '?artifact=x';
  location.hash = '#anchor';
  popstate();
  assert.equal(location.reloaded, 0);
});

test('a server-rendered page (marker) reloads on a query-only change but not on a hash-only change', () => {
  const { location, popstate } = load('/plugins/code-artifact/a/x/', { search: '?page=1', marked: true });
  location.hash = '#anchor';
  popstate();
  assert.equal(location.reloaded, 0, 'hash-only');
  location.search = '?page=2';
  popstate();
  assert.equal(location.reloaded, 1, 'query-only');
});

test('every server-rendered page carries the marker and the UI document does not', async (t) => {
  const index = await fsp.readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.ok(!index.includes('data-reload-on-search'));
  const app = await startApp(t);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' });
  const dl = await publish(app, { path: await fixtureFile(t, 'a.bin', 'x'), title: 'Bin' });
  const site = await publish(app, { path: await fixtureFile(t, 'a.html', '<p>x'), title: 'Site' });
  for (const id of [md.id, dl.id, site.id]) assert.match((await app.get(`/a/${id}/`)).text, /<html [^>]*data-reload-on-search/, id);
});

test('the UI document and the server-rendered pages all load nav.js', async (t) => {
  const index = await fsp.readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.match(index, /<script src="nav\.js"/);
  const app = await startApp(t);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' });
  const dl = await publish(app, { path: await fixtureFile(t, 'a.bin', 'x'), title: 'Bin' });
  for (const id of [md.id, dl.id]) assert.match((await app.get(`/a/${id}/`)).text, /<script src="\.\.\/\.\.\/_page\/nav\.js"><\/script>/);
});
