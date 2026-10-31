// Pins the REST API: list/get/delete/prune share the ops with MCP; mutating requests need a JSON content type.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/store.js';
import { fixtureFile, publish, startApp } from './_helpers.mjs';
import { publishApp, startApps, waitStatus } from './_apps.mjs';

async function seeded(t) {
  const app = await startApp(t);
  const a = await publish(app, { path: await fixtureFile(t, 'a.md', '# a'), title: 'A' });
  await app.mcp('update_artifact', { artifact: a.id, path: await fixtureFile(t, 'a2.md', '# a2') });
  const b = await publish(app, { path: await fixtureFile(t, 'b.bin', 'b'), title: 'B' }, { sessionId: 's', project: 'proj-b' });
  return { app, a, b };
}

test('GET api/artifacts lists full records with deep links; filters by project and kind', async (t) => {
  const { app, a, b } = await seeded(t);
  const { data } = await app.get('/api/artifacts');
  assert.deepEqual(data.artifacts.map((r) => r.id), [b.id, a.id]);
  const rec = data.artifacts.find((r) => r.id === a.id);
  assert.equal(rec.link, `http://cc.internal/#plugin/code-artifact/a/${a.id}/`);
  assert.deepEqual(rec.versions.map((v) => v.versionLink), [1, 2].map((n) => `http://cc.internal/#plugin/code-artifact/a/${a.id}/v/${n}/`));
  assert.deepEqual((await app.get('/api/artifacts?project=proj-b')).data.artifacts.map((r) => r.id), [b.id]);
  assert.deepEqual((await app.get('/api/artifacts?kind=markdown')).data.artifacts.map((r) => r.id), [a.id]);
  assert.equal((await app.get('/api/artifacts?kind=bogus')).status, 400);
});

test('GET api/artifacts/:id returns the record; an unknown id is 404 {error, code}', async (t) => {
  const { app, a } = await seeded(t);
  assert.equal((await app.get(`/api/artifacts/${a.id}`)).data.id, a.id);
  const miss = await app.get('/api/artifacts/nope-abc123');
  assert.equal(miss.status, 404);
  assert.equal(miss.data.code, 'ARTIFACT_UNKNOWN');
  assert.equal(typeof miss.data.error, 'string');
  assert.equal((await app.get('/api/artifacts/BAD..ID')).data.code, 'INVALID_ARGUMENT');
});

test('DELETE api/artifacts/:id/versions/:n deletes one version; the last one is 409 LAST_VERSION', async (t) => {
  const { app, a } = await seeded(t);
  assert.deepEqual((await app.del(`/api/artifacts/${a.id}/versions/1`)).data, { deleted: 'version', id: a.id, version: 1, latest: 2 });
  const last = await app.del(`/api/artifacts/${a.id}/versions/2`);
  assert.equal(last.status, 409);
  assert.equal(last.data.code, 'LAST_VERSION');
  assert.equal((await app.del(`/api/artifacts/${a.id}/versions/9`)).status, 404);
  assert.equal((await app.del(`/api/artifacts/${a.id}/versions/x`)).status, 400);
});

test('DELETE api/artifacts/:id removes the artifact', async (t) => {
  const { app, a } = await seeded(t);
  assert.deepEqual((await app.del(`/api/artifacts/${a.id}`)).data, { deleted: 'artifact', id: a.id });
  assert.equal((await app.get(`/api/artifacts/${a.id}`)).status, 404);
});

test('a POST with text/plain and a DELETE without a JSON content type are 415', async (t) => {
  const { app, a } = await seeded(t);
  const post = await app.raw('POST', '/api/prune', '{"olderThanDays":1}', { 'content-type': 'text/plain' });
  assert.equal(post.status, 415);
  assert.equal(post.data.code, 'UNSUPPORTED_MEDIA_TYPE');
  const del = await fetch(`${app.base}/api/artifacts/${a.id}`, { method: 'DELETE' });
  assert.equal(del.status, 415);
  assert.equal((await app.get(`/api/artifacts/${a.id}`)).status, 200, 'nothing was deleted');
  const mcp = await app.raw('POST', '/api/mcp', '{}', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(mcp.status, 415);
});

test('a JSON content type with a charset is accepted', async (t) => {
  const { app } = await seeded(t);
  const res = await app.raw('POST', '/api/prune', { olderThanDays: 1, dryRun: true }, { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(res.status, 200);
});

test('POST api/prune dry-runs, then prunes, never touching latest versions', async (t) => {
  const day = 86_400_000;
  const root = await fsp.mkdtemp(path.join((await import('node:os')).tmpdir(), 'ca-api-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const storeDir = path.join(root, 'store');
  const seed = await Store.open(storeDir, { now: () => new Date(Date.now() - 60 * day) });
  const dir = await seed.newStaging();
  await fsp.mkdir(path.join(dir, 'content'));
  const rec = await seed.create({ title: 'Old', kind: 'download', project: 'p', version: { file: 'x', bytes: 0, files: 1, sessionId: null, sessionLabel: null, source: { name: 'x', type: 'file' } } }, dir);
  const dir2 = await seed.newStaging();
  await fsp.mkdir(path.join(dir2, 'content'));
  await seed.addVersion(rec.id, { version: { file: 'x', bytes: 0, files: 1, sessionId: null, sessionLabel: null, source: { name: 'x', type: 'file' } } }, dir2);
  const app = await startApp(t, { storeDir });
  const dry = await app.post('/api/prune', { olderThanDays: 30, dryRun: true });
  assert.deepEqual(dry.data, { versions: [{ id: rec.id, version: 1 }], artifacts: 1 });
  assert.equal((await app.get(`/api/artifacts/${rec.id}`)).data.versions.length, 2);
  assert.equal((await app.post('/api/prune', { olderThanDays: 30, project: 'other' })).data.versions.length, 0);
  assert.deepEqual((await app.post('/api/prune', { olderThanDays: 30 })).data.versions, [{ id: rec.id, version: 1 }]);
  assert.deepEqual((await app.get(`/api/artifacts/${rec.id}`)).data.versions.map((v) => v.n), [2]);
  assert.equal((await app.post('/api/prune', { olderThanDays: 0 })).status, 400);
});

test('with no store configured the API answers 503 {error, code: STORE_UNCONFIGURED}', async (t) => {
  const app = await startApp(t, { unconfigured: true });
  const res = await app.get('/api/artifacts');
  assert.equal(res.status, 503);
  assert.equal(res.data.code, 'STORE_UNCONFIGURED');
  assert.equal((await app.get('/api/health')).status, 200);
});

test('api/apps/:id: status, start, stop and the log tail, with their statuses and shapes', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const id = pub.id;

  const status = await app.get(`/api/apps/${id}`);
  assert.equal(status.status, 200);
  assert.deepEqual({ ...status.data, since: typeof status.data.since }, { id, status: 'stopped', version: null, error: null, since: 'string' });

  const log = await app.get(`/api/apps/${id}/log`);
  assert.equal(log.status, 200);
  assert.match(log.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.equal(log.headers.get('cache-control'), 'no-store');
  assert.equal(log.text, '', 'no log yet is an empty body');

  const started = await app.post(`/api/apps/${id}/start`, {});
  assert.equal(started.status, 202);
  assert.equal(started.data.id, id);
  await waitStatus(app, id, 'running');
  assert.match((await app.get(`/api/apps/${id}/log`)).text, /fixture listening/);
  assert.match((await app.get(`/api/apps/${id}/log?bytes=10`)).text, /^.{1,10}$/s, 'bytes bounds the tail');

  const stopped = await app.post(`/api/apps/${id}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.status, 'stopped');
});

test('api/apps/:id refuses an unknown id, a non-app, a missing JSON content type and a bad bytes', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const doc = await publish(app, { path: await fixtureFile(t, 'a.md', '# a'), title: 'A' });

  for (const url of ['/api/apps/nope-abc123', '/api/apps/nope-abc123/log']) {
    const res = await app.get(url);
    assert.equal(res.status, 404, url);
    assert.equal(res.data.code, 'ARTIFACT_UNKNOWN');
  }
  for (const [method, url] of [['GET', `/api/apps/${doc.id}`], ['POST', `/api/apps/${doc.id}/start`], ['POST', `/api/apps/${doc.id}/stop`], ['GET', `/api/apps/${doc.id}/log`]]) {
    const res = await app.raw(method, url, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 409, url);
    assert.equal(res.data.code, 'NOT_AN_APP');
  }
  assert.equal((await app.raw('POST', `/api/apps/${pub.id}/start`, undefined, {})).status, 415);
  assert.equal((await app.raw('POST', `/api/apps/${pub.id}/stop`, undefined, {})).status, 415);
  for (const bytes of ['0', '-1', 'abc', '1.5', '1048577', '']) {
    const res = await app.get(`/api/apps/${pub.id}/log?bytes=${bytes}`);
    assert.equal(res.status, 400, `bytes=${bytes}`);
    assert.equal(res.data.code, 'INVALID_ARGUMENT');
  }
  assert.equal((await app.get(`/api/apps/${pub.id}/log?bytes=1048576`)).status, 200);
});

test('api/apps answers 503 STORE_UNCONFIGURED without a store', async (t) => {
  const app = await startApp(t, { unconfigured: true });
  const res = await app.get('/api/apps/some-app-abc123');
  assert.equal(res.status, 503);
  assert.equal(res.data.code, 'STORE_UNCONFIGURED');
});
