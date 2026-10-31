// Pins the pure UI logic: grouping/ordering, route parsing, which Open link is used, and the displayed texts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appActions, formatBytes, groupByProject, isTransient, openHref, parseRoute, relativeTime, sessionText, statusLabel } from '../frontend/src/lib/artifacts.ts';

const art = (id, project, publishedAt) => ({
  id, project, title: id, kind: 'markdown', createdAt: publishedAt, link: `http://cc.internal/#plugin/code-artifact/a/${id}/`,
  versions: [{ n: 1, title: id, publishedAt, sessionId: null, sessionLabel: null, source: { name: 'x', type: 'file' }, bytes: 1, files: 1, versionLink: `http://cc.internal/#plugin/code-artifact/a/${id}/v/1/` }],
});

test('groupByProject sorts projects by name and artifacts newest first', () => {
  const groups = groupByProject([
    art('old-b', 'beta', '2026-01-01T00:00:00Z'), art('x', 'alpha', '2026-01-02T00:00:00Z'),
    art('new-b', 'beta', '2026-03-01T00:00:00Z'), art('mid-b', 'beta', '2026-02-01T00:00:00Z'),
  ]);
  assert.deepEqual(groups.map((g) => g.project), ['alpha', 'beta']);
  assert.deepEqual(groups[1].artifacts.map((a) => a.id), ['new-b', 'mid-b', 'old-b']);
});

test('groupByProject orders by the latest version, not the first', () => {
  const a = art('a', 'p', '2026-01-01T00:00:00Z');
  a.versions.push({ ...a.versions[0], n: 2, publishedAt: '2026-05-01T00:00:00Z' });
  const b = art('b', 'p', '2026-03-01T00:00:00Z');
  assert.deepEqual(groupByProject([b, a])[0].artifacts.map((x) => x.id), ['a', 'b']);
});

test('groupByProject of nothing is empty', () => assert.deepEqual(groupByProject([]), []));

test('parseRoute reads the artifact from the query string', () => {
  assert.deepEqual(parseRoute(''), { view: 'list' });
  assert.deepEqual(parseRoute('?'), { view: 'list' });
  assert.deepEqual(parseRoute('?artifact=notes-abc123'), { view: 'detail', id: 'notes-abc123' });
  assert.deepEqual(parseRoute('?ccProject=x&artifact=a-b'), { view: 'detail', id: 'a-b' });
  assert.deepEqual(parseRoute('?artifact='), { view: 'list' });
});

test('openHref picks the cc.internal link when embedded and a relative link otherwise', () => {
  const a = art('doc-abc123', 'p', '2026-01-01T00:00:00Z');
  const v = a.versions[0];
  assert.equal(openHref(true, a), a.link);
  assert.equal(openHref(true, a, v), v.versionLink);
  assert.equal(openHref(false, a), 'a/doc-abc123/');
  assert.equal(openHref(false, a, v), 'a/doc-abc123/v/1/');
});

test('formatBytes uses binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MiB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GiB');
});

test('sessionText prefers the label, then the 8-character id, then "unknown session"', () => {
  assert.equal(sessionText({ sessionId: 'abcdef123456', sessionLabel: 'Fix bug' }), 'Fix bug');
  assert.equal(sessionText({ sessionId: 'abcdef123456', sessionLabel: null }), 'abcdef12');
  assert.equal(sessionText({ sessionId: null, sessionLabel: null }), 'unknown session');
});

test('relativeTime counts in the largest whole unit', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const ago = (s) => relativeTime(new Date(now - s * 1000).toISOString(), now);
  assert.equal(ago(5), 'just now');
  assert.equal(ago(60), '1 minute ago');
  assert.equal(ago(150), '2 minutes ago');
  assert.equal(ago(3600), '1 hour ago');
  assert.equal(ago(86400 * 3), '3 days ago');
  assert.equal(ago(86400 * 60), '2 months ago');
});

test('appActions enables Start from stopped or failed and Stop while installing, starting or running', () => {
  assert.deepEqual(appActions('stopped'), { start: true, stop: false });
  assert.deepEqual(appActions('failed'), { start: true, stop: false });
  for (const s of ['installing', 'starting', 'running']) assert.deepEqual(appActions(s), { start: false, stop: true }, s);
});

test('isTransient is true only for the states that change by themselves', () => {
  assert.deepEqual(['stopped', 'installing', 'starting', 'running', 'failed'].filter(isTransient), ['installing', 'starting']);
});

test('statusLabel names every state', () => {
  for (const s of ['stopped', 'installing', 'starting', 'running', 'failed']) assert.ok(statusLabel(s).length > 0, s);
});
