// Pins the shared operations: caller defaults, project/session resolution, cc verification, the label snapshot,
// update/kind/project rules, argument checks, delete rules and prune.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createCc } from '../src/cc.js';
import { createOps } from '../src/ops.js';
import { createAppHost } from '../src/appHost.js';
import { deadUrl, fakeCc, fixtureDir, fixtureFile, tmp } from './_helpers.mjs';

async function setup(t, { ccUrl = null, now } = {}) {
  const storeDir = path.join(await tmp(t), 'store');
  const store = await Store.open(storeDir, { now });
  const ops = createOps({ store, cc: createCc(ccUrl), apps: createAppHost({ store, storeDir }) });
  return { store, ops };
}
const caller = { sessionId: 'sess-1', project: 'proj-a' };
const refusal = (code) => (e) => e.code === code;

test('project and session default from the caller; explicit args override', async (t) => {
  const cc = await fakeCc(t, { projects: ['other'] });
  const { ops } = await setup(t, { ccUrl: cc.url });
  const file = await fixtureFile(t, 'a.md', '# a');
  const r1 = await ops.publish({ path: file, title: 'A' }, caller);
  assert.equal(r1.project, 'proj-a');
  assert.equal(r1.sessionId, 'sess-1');
  assert.deepEqual(cc.calls.filter((c) => c.includes('/location')), [], 'a caller project is trusted, not verified');
  const r2 = await ops.publish({ path: file, title: 'B', project: 'other', sessionId: 'sess-2' }, caller);
  assert.equal(r2.project, 'other');
  assert.equal(r2.sessionId, 'sess-2');
});

test('a caller with no session publishes with sessionId null and no label lookup', async (t) => {
  const cc = await fakeCc(t);
  const { ops } = await setup(t, { ccUrl: cc.url });
  const r = await ops.publish({ path: await fixtureFile(t, 'a.md', 'x'), title: 'A' }, { sessionId: null, project: 'p' });
  assert.equal(r.sessionId, null);
  assert.deepEqual(cc.calls, []);
});

test('a conductor caller (project .conduct) or no project is PROJECT_REQUIRED; naming one works', async (t) => {
  const { ops } = await setup(t);
  const file = await fixtureFile(t, 'a.md', 'x');
  await assert.rejects(ops.publish({ path: file, title: 'A' }, { sessionId: 's', project: '.conduct' }), refusal('PROJECT_REQUIRED'));
  await assert.rejects(ops.publish({ path: file, title: 'A' }, { sessionId: 's', project: null }), refusal('PROJECT_REQUIRED'));
  await assert.rejects(ops.publish({ path: file, title: 'A' }, {}), refusal('PROJECT_REQUIRED'));
  await assert.rejects(ops.publish({ path: file, title: 'A', project: '.hidden' }, caller), refusal('PROJECT_REQUIRED'));
  const r = await ops.publish({ path: file, title: 'A', project: 'real' }, { sessionId: 's', project: '.conduct' });
  assert.equal(r.project, 'real');
});

test('an explicit project cc does not know is PROJECT_UNKNOWN; a down cc is CC_UNREACHABLE; a cc 5xx too', async (t) => {
  const file = await fixtureFile(t, 'a.md', 'x');
  const known = await setup(t, { ccUrl: (await fakeCc(t, { projects: ['x'] })).url });
  await assert.rejects(known.ops.publish({ path: file, title: 'A', project: 'nope' }, caller), refusal('PROJECT_UNKNOWN'));
  assert.equal((await known.ops.publish({ path: file, title: 'A', project: 'x' }, caller)).project, 'x');
  const down = await setup(t, { ccUrl: await deadUrl() });
  await assert.rejects(down.ops.publish({ path: file, title: 'A', project: 'x' }, caller), refusal('CC_UNREACHABLE'));
  const broken = await setup(t, { ccUrl: (await fakeCc(t, { status: 500 })).url });
  await assert.rejects(broken.ops.publish({ path: file, title: 'A', project: 'x' }, caller), refusal('CC_UNREACHABLE'));
});

test('standalone (no cc URL) skips the project check and warns once', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { ops } = await setup(t);
  const file = await fixtureFile(t, 'a.md', 'x');
  await ops.publish({ path: file, title: 'A', project: 'whatever' }, caller);
  await ops.publish({ path: file, title: 'B', project: 'whatever' }, caller);
  assert.equal(warn.mock.callCount(), 1);
});

test('the session label is snapshotted at publish; a failure leaves null and warns', async (t) => {
  const cc = await fakeCc(t, { instances: [{ sessionId: 'sess-1', displayLabel: 'Fix the bug' }, { sessionId: 'x', displayLabel: 'other' }] });
  const { ops, store } = await setup(t, { ccUrl: cc.url });
  const r = await ops.publish({ path: await fixtureFile(t, 'a.md', 'x'), title: 'A' }, caller);
  assert.equal((await store.get(r.id)).versions[0].sessionLabel, 'Fix the bug');
  const warn = t.mock.method(console, 'warn', () => {});
  const down = await setup(t, { ccUrl: await deadUrl() });
  const r2 = await down.ops.publish({ path: await fixtureFile(t, 'b.md', 'x'), title: 'B' }, caller);
  assert.equal((await down.store.get(r2.id)).versions[0].sessionLabel, null);
  assert.ok(warn.mock.callCount() >= 1);
});

test('publish returns the documented shape with deep links', async (t) => {
  const { ops } = await setup(t);
  const r = await ops.publish({ path: await fixtureFile(t, 'a.md', '# hello'), title: 'Hello' }, caller);
  assert.deepEqual(Object.keys(r).sort(), ['bytes', 'files', 'id', 'kind', 'link', 'project', 'sessionId', 'title', 'version', 'versionLink'].sort());
  assert.equal(r.version, 1);
  assert.equal(r.kind, 'markdown');
  assert.equal(r.link, `http://cc.internal/#plugin/code-artifact/a/${r.id}/`);
  assert.equal(r.versionLink, `http://cc.internal/#plugin/code-artifact/a/${r.id}/v/1/`);
});

test('a refused publish leaves nothing behind in the store', async (t) => {
  const { ops, store } = await setup(t);
  const dir = await fixtureDir(t, { 'index.html': 'x' });
  await import('node:fs/promises').then((fs) => fs.symlink('/etc/passwd', path.join(dir, 'bad')));
  await assert.rejects(ops.publish({ path: dir, title: 'A' }, caller), refusal('UNSAFE_ENTRY'));
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(path.join(path.dirname(store.versionDir('a', 1)), '..', '..', '..', '.staging')), []);
});

test('update adds a version, keeps the project, and the title is optional', async (t) => {
  const { ops, store } = await setup(t);
  const a = await ops.publish({ path: await fixtureFile(t, 'a.md', '# 1'), title: 'Doc' }, caller);
  const u = await ops.update({ artifact: a.id, path: await fixtureFile(t, 'b.md', '# 2') }, caller);
  assert.equal(u.version, 2);
  assert.equal(u.title, 'Doc');
  const u3 = await ops.update({ artifact: a.id, path: await fixtureFile(t, 'c.md', '# 3'), title: 'Doc v3' }, caller);
  assert.equal((await store.get(a.id)).title, 'Doc v3');
  assert.equal(u3.version, 3);
});

test('update of an unknown id is ARTIFACT_UNKNOWN, before the source is looked at', async (t) => {
  const { ops } = await setup(t);
  await assert.rejects(ops.update({ artifact: 'nope-abc123', path: '/does/not/exist' }, caller), refusal('ARTIFACT_UNKNOWN'));
});

test('an inferred or explicit kind that differs from the stored kind is KIND_CHANGE', async (t) => {
  const { ops } = await setup(t);
  const a = await ops.publish({ path: await fixtureFile(t, 'a.md', '# 1'), title: 'Doc' }, caller);
  const html = await fixtureFile(t, 'p.html', '<p>x');
  await assert.rejects(ops.update({ artifact: a.id, path: html }, caller), (e) => e.code === 'KIND_CHANGE' && /static/.test(e.message) && /kind:"markdown"/.test(e.message));
  await assert.rejects(ops.update({ artifact: a.id, path: html, kind: 'static' }, caller), refusal('KIND_CHANGE'));
  const u = await ops.update({ artifact: a.id, path: html, kind: 'markdown' }, caller);
  assert.equal(u.kind, 'markdown', 'passing the stored kind forces the source to be that kind');
});

test('a project key on update is PROJECT_FIXED, ahead of the unknown-argument check', async (t) => {
  const { ops } = await setup(t);
  const a = await ops.publish({ path: await fixtureFile(t, 'a.md', '# 1'), title: 'Doc' }, caller);
  await assert.rejects(ops.update({ artifact: a.id, path: '/x', project: 'other' }, caller), refusal('PROJECT_FIXED'));
});

test('unknown arguments and wrongly typed arguments are INVALID_ARGUMENT', async (t) => {
  const { ops } = await setup(t);
  const file = await fixtureFile(t, 'a.md', 'x');
  await assert.rejects(ops.publish({ path: file, title: 'A', bogus: 1 }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish({ path: file }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish({ path: file, title: '' }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish({ path: file, title: 'x'.repeat(201) }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish({ path: file, title: 'A', kind: 'weird' }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish({ path: file, title: 'A', project: 'bad name' }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish({ path: 5, title: 'A' }, caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.publish('nope', caller), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.get({ artifact: '../x' }), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.remove({ artifact: 'a-b', version: 0 }), refusal('INVALID_ARGUMENT'));
  await assert.rejects(ops.remove({ artifact: 'a-b', version: 1.5 }), refusal('INVALID_ARGUMENT'));
});

test('get returns the record with a deep link per version; list filters', async (t) => {
  const { ops } = await setup(t);
  const a = await ops.publish({ path: await fixtureFile(t, 'a.md', '1'), title: 'A' }, caller);
  await ops.update({ artifact: a.id, path: await fixtureFile(t, 'b.md', '2') }, caller);
  await ops.publish({ path: await fixtureFile(t, 'c.bin', '3'), title: 'C', project: 'other' }, caller);
  const got = await ops.get({ artifact: a.id });
  assert.equal(got.link, `http://cc.internal/#plugin/code-artifact/a/${a.id}/`);
  assert.deepEqual(got.versions.map((v) => v.versionLink), [1, 2].map((n) => `http://cc.internal/#plugin/code-artifact/a/${a.id}/v/${n}/`));
  assert.equal((await ops.list({})).artifacts.length, 2);
  assert.deepEqual((await ops.list({ project: 'other' })).artifacts.map((r) => r.kind), ['download']);
  assert.deepEqual((await ops.list({ kind: 'markdown' })).artifacts.map((r) => r.id), [a.id]);
  await assert.rejects(ops.get({ artifact: 'nope-abc123' }), refusal('ARTIFACT_UNKNOWN'));
});

test('remove deletes a version or the whole artifact, with the documented results and refusals', async (t) => {
  const { ops } = await setup(t);
  const a = await ops.publish({ path: await fixtureFile(t, 'a.md', '1'), title: 'A' }, caller);
  await ops.update({ artifact: a.id, path: await fixtureFile(t, 'b.md', '2') }, caller);
  assert.deepEqual(await ops.remove({ artifact: a.id, version: 2 }), { deleted: 'version', id: a.id, version: 2, latest: 1 });
  await assert.rejects(ops.remove({ artifact: a.id, version: 1 }), (e) => e.code === 'LAST_VERSION' && /delete the artifact instead/.test(e.message));
  await assert.rejects(ops.remove({ artifact: a.id, version: 5 }), refusal('VERSION_UNKNOWN'));
  assert.deepEqual(await ops.remove({ artifact: a.id }), { deleted: 'artifact', id: a.id });
  await assert.rejects(ops.remove({ artifact: a.id }), refusal('ARTIFACT_UNKNOWN'));
});

test('prune keeps every latest version, respects the project scope, and dryRun deletes nothing', async (t) => {
  const day = 86_400_000;
  let now = Date.parse('2026-06-01T00:00:00Z');
  const { ops, store } = await setup(t, { now: () => new Date(now) });
  const a = await ops.publish({ path: await fixtureFile(t, 'a.md', '1'), title: 'A' }, caller);
  await ops.update({ artifact: a.id, path: await fixtureFile(t, 'b.md', '2') }, caller);
  const b = await ops.publish({ path: await fixtureFile(t, 'c.md', '1'), title: 'B', project: 'other' }, caller);
  await ops.update({ artifact: b.id, path: await fixtureFile(t, 'd.md', '2') }, caller);
  now += 40 * day;
  assert.deepEqual(await ops.prune({ olderThanDays: 30, project: 'other', dryRun: true }), { versions: [{ id: b.id, version: 1 }], artifacts: 1 });
  assert.equal((await store.get(b.id)).versions.length, 2);
  const real = await ops.prune({ olderThanDays: 30, project: 'proj-a' });
  assert.deepEqual(real.versions, [{ id: a.id, version: 1 }]);
  assert.equal((await store.get(b.id)).versions.length, 2, 'the other project is untouched');
  assert.deepEqual((await store.get(a.id)).versions.map((v) => v.n), [2]);
  await assert.rejects(ops.prune({ olderThanDays: 0 }), refusal('INVALID_ARGUMENT'));
  for (const days of [1e9, 100_001, 1.5, Infinity]) await assert.rejects(ops.prune({ olderThanDays: days, dryRun: true }), refusal('INVALID_ARGUMENT'), String(days));
  await ops.prune({ olderThanDays: 100_000, dryRun: true });
  await assert.rejects(ops.prune({ olderThanDays: 1, dryRun: 'yes' }), refusal('INVALID_ARGUMENT'));
});
