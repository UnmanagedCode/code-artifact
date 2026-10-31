// Pins the deep-link contract: every link passes a faithful copy of cc's viewLinkHash rules and stays under the plugin's frame URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deepLink, ID_RE, PLUGIN_ID } from '../src/links.js';
import { newId } from '../src/store.js';

// The rules of cc's `viewLinkHash` for a plugin link: host exactly cc.internal, path "/", no search, no userinfo,
// and a frame URL (/plugins/<id>/<subpath>) that does not leave /plugins/<id>/ once dot segments resolve.
function acceptsLink(href) {
  let u;
  try { u = new URL(href); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || u.hostname !== 'cc.internal' || u.port !== '' || u.pathname !== '/' || u.search !== '' || u.username || u.password) return false;
  const m = /^#plugin\/([a-z][a-z0-9-]*)\/(.*)$/.exec(u.hash);
  if (!m) return false;
  const frame = new URL(`/plugins/${m[1]}/${m[2]}`, 'http://host.invalid');
  return frame.pathname.startsWith(`/plugins/${m[1]}/`);
}

test('the faithful copy rejects what cc rejects', () => {
  assert.equal(acceptsLink('http://cc.internal/#plugin/code-artifact/a/../../x/'), false);
  assert.equal(acceptsLink('http://cc.internal/?q=1#plugin/code-artifact/a/x/'), false);
  assert.equal(acceptsLink('http://cc.internal.evil.com/#plugin/code-artifact/a/x/'), false);
  assert.equal(acceptsLink('http://cc.internal/#plugin/code-artifact/a/x/'), true);
});

test('latest and pinned deep links are accepted and point at the plugin', () => {
  for (const id of [newId('Release notes'), newId(''), newId('x'), 'a', 'a-b-1']) {
    assert.ok(acceptsLink(deepLink(id)), deepLink(id));
    assert.ok(acceptsLink(deepLink(id, 12)), deepLink(id, 12));
  }
  assert.equal(deepLink('abc'), `http://cc.internal/#plugin/${PLUGIN_ID}/a/abc/`);
  assert.equal(deepLink('abc', 3), `http://cc.internal/#plugin/${PLUGIN_ID}/a/abc/v/3/`);
});

test('the id format excludes dot segments, slashes and uppercase', () => {
  for (const bad of ['.', '..', 'a/b', 'A', '-a', 'a.b', '', 'x'.repeat(49)]) assert.doesNotMatch(bad, ID_RE, bad);
  for (const ok of ['a', '0', 'a-b-c', 'x'.repeat(48)]) assert.match(ok, ID_RE, ok);
});
