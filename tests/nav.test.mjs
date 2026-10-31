// Pins the steering contract: when cc replaces the document's path and fires popstate, the page reloads;
// a query-only or hash-only change does not. Also pins that every document of the plugin loads the script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';
import { fixtureFile, publish, startApp } from './_helpers.mjs';

const source = await fsp.readFile(new URL('../frontend/public/nav.js', import.meta.url), 'utf8');

function load(pathname) {
  const listeners = [];
  const location = { pathname, reloaded: 0, reload() { this.reloaded++; } };
  vm.runInNewContext(source, { location, window: { addEventListener: (type, fn) => listeners.push([type, fn]) } });
  assert.deepEqual(listeners.map(([t]) => t), ['popstate']);
  return { location, popstate: listeners[0][1] };
}

test('a popstate after the path changed reloads the document', () => {
  const { location, popstate } = load('/plugins/code-artifact/a/one/');
  location.pathname = '/plugins/code-artifact/a/two/';
  popstate();
  assert.equal(location.reloaded, 1);
});

test('a popstate with the same path (query or hash changes, the UI\'s own routing) does not reload', () => {
  const { location, popstate } = load('/plugins/code-artifact/');
  location.search = '?artifact=x';
  location.hash = '#anchor';
  popstate();
  assert.equal(location.reloaded, 0);
});

test('the UI document and the server-rendered pages all load nav.js', async (t) => {
  const index = await fsp.readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.match(index, /<script src="nav\.js"/);
  const app = await startApp(t);
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# x'), title: 'Doc' });
  const dl = await publish(app, { path: await fixtureFile(t, 'a.bin', 'x'), title: 'Bin' });
  for (const id of [md.id, dl.id]) assert.match((await app.get(`/a/${id}/`)).text, /<script src="\.\.\/\.\.\/_page\/nav\.js"><\/script>/);
});
