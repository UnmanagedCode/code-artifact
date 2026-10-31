// Pins how versions, deletion and prune interact with a running app: one process on the latest version,
// an update restarts an active app only, delete stops what it must, prune spares the active version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createCc } from '../src/cc.js';
import { createOps } from '../src/ops.js';
import { createAppHost } from '../src/appHost.js';
import { tmp } from './_helpers.mjs';
import { TIMINGS, appSource, markerPids, pidGone, publishApp, recordedPid, runApp, startApps, waitFor, waitStatus } from './_apps.mjs';

const update = async (t, app, id, opts) => {
  const res = await app.mcp('update_artifact', { artifact: id, path: await appSource(t, opts) });
  if (res.data.error) throw new Error(res.data.error);
  return res.data.result;
};
const echo = async (app, id) => (await fetch(`${app.base}/app/${id}/echo`)).json();

test('update_artifact restarts a running app on the new version and keeps DATA_DIR', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { version: '1' });
  await runApp(app, pub.id);
  await fetch(`${app.base}/app/${pub.id}/data?add=kept`);
  const oldPid = await recordedPid(app.storeDir, pub.id);

  const res = await update(t, app, pub.id, { version: '2' });
  assert.equal(res.version, 2);
  assert.ok(['installing', 'starting'].includes(res.app.status), `the result reports the restart, got ${res.app.status}`);
  await waitStatus(app, pub.id, 'running');
  const seen = await echo(app, pub.id);
  assert.equal(seen.version, '2');
  assert.equal((await app.get(`/api/apps/${pub.id}`)).data.version, 2);
  assert.equal((await (await fetch(`${app.base}/app/${pub.id}/data`)).json()).data, 'kept\n');
  await pidGone(oldPid);
});

test('update_artifact on a stopped app leaves it stopped', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const res = await update(t, app, pub.id, { version: '2' });
  assert.deepEqual(res.app, { status: 'stopped' });
  assert.deepEqual(await markerPids(app.storeDir), []);
});

test('each version installs into its own working copy', async (t) => {
  const app = await startApps(t);
  const manifest = { start: 'node server.js', install: 'echo x >> "$DATA_DIR/installs"' };
  const pub = await publishApp(t, app, { manifest, version: '1' });
  await runApp(app, pub.id);
  await update(t, app, pub.id, { manifest, version: '2' });
  await waitStatus(app, pub.id, 'running');
  assert.equal((await echo(app, pub.id)).installs, 2, 'the new version ran its install');
});

test('deleting a running artifact kills its processes and removes its data and logs', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const pid = await recordedPid(app.storeDir, pub.id);
  await fetch(`${app.base}/app/${pub.id}/spawn`);
  const grandchild = await recordedPid(app.storeDir, pub.id, 'grandchild.pid');

  const res = await app.mcp('delete_artifact', { artifact: pub.id });
  assert.deepEqual(res.data.result, { deleted: 'artifact', id: pub.id });
  await pidGone(pid);
  await pidGone(grandchild);
  await assert.rejects(fsp.access(path.join(app.storeDir, 'artifacts', pub.id)));
  assert.equal((await app.get(`/api/apps/${pub.id}`)).data.code, 'ARTIFACT_UNKNOWN');
  assert.equal((await app.post(`/api/apps/${pub.id}/start`, {})).data.code, 'ARTIFACT_UNKNOWN');
});

test('deleting the running (latest) version stops the app and does not start an older one', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { version: '1' });
  await update(t, app, pub.id, { version: '2' });
  await runApp(app, pub.id);
  const pid = await recordedPid(app.storeDir, pub.id);

  const res = await app.del(`/api/artifacts/${pub.id}/versions/2`);
  assert.equal(res.data.latest, 1);
  assert.equal((await app.get(`/api/apps/${pub.id}`)).data.status, 'stopped');
  await pidGone(pid);
  assert.deepEqual(await markerPids(app.storeDir), []);
});

test('deleting a version the app does not run leaves it running', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { version: '1' });
  await update(t, app, pub.id, { version: '2' });
  await runApp(app, pub.id);
  const pid = await recordedPid(app.storeDir, pub.id);
  assert.equal((await app.del(`/api/artifacts/${pub.id}/versions/1`)).status, 200);
  assert.equal((await app.get(`/api/apps/${pub.id}`)).data.status, 'running');
  assert.equal(await recordedPid(app.storeDir, pub.id), pid);
});

test('a refused version delete does not stop the app', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const res = await app.del(`/api/artifacts/${pub.id}/versions/1`);
  assert.equal(res.data.code, 'LAST_VERSION');
  assert.equal((await app.get(`/api/apps/${pub.id}`)).data.status, 'running');
});

test('prune skips a version the host reports as active, and spares nothing otherwise', async (t) => {
  const run = async (activeVersion) => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const storeDir = path.join(await tmp(t), 'store');
    const store = await Store.open(storeDir, { now: () => clock });
    const apps = { ...createAppHost({ store, storeDir }), activeVersion };
    const ops = createOps({ store, cc: createCc(null), apps });
    const caller = { sessionId: 's', project: 'p' };
    const src = await appSource(t);
    const rec = await ops.publish({ path: src, title: 'x' }, caller);
    clock = new Date('2026-01-02T00:00:00Z');
    await ops.update({ artifact: rec.id, path: src }, caller);
    clock = new Date('2026-03-01T00:00:00Z');
    return ops.prune({ olderThanDays: 1 });
  };
  assert.deepEqual((await run(() => null)).versions.map((v) => v.version), [1]);
  assert.deepEqual((await run((id) => 1)).versions, []);
});

test('an update cannot slip between a version delete\'s check and its unlink', async (t) => {
  const storeDir = path.join(await tmp(t), 'store');
  const store = await Store.open(storeDir);
  const host = createAppHost({ store, storeDir, timings: TIMINGS });
  t.after(() => host.shutdown());

  // The delete's first read of the record is held after it has read a one-version record.
  let gate = null;
  let reached;
  const arrived = new Promise((r) => { reached = r; });
  const gated = new Proxy(store, {
    get(target, prop) {
      if (prop === 'get') {
        return async (id) => {
          const record = await target.get(id);
          if (gate) { const held = gate; gate = null; reached(); await held.promise; }
          return record;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // Tells us when the update has reached its commit, which in a correct build then waits for the app's lock.
  let atCommit;
  const committing = new Promise((r) => { atCommit = r; });
  const apps = { ...host, committing: (id, fn) => { atCommit(); return host.committing(id, fn); } };
  const ops = createOps({ store: gated, cc: createCc(null), apps });
  const caller = { sessionId: 's', project: 'p' };
  const pub = await ops.publish({ path: await appSource(t, { version: '1' }), title: 'x' }, caller);
  await host.start(pub.id);
  await waitFor(() => host.status(pub.id).status === 'running', { what: 'the app to run' });

  let release;
  gate = { promise: new Promise((r) => { release = r; }) };
  const removing = ops.remove({ artifact: pub.id, version: 1 }).then(() => null, (e) => e);
  await arrived;
  const updating = ops.update({ artifact: pub.id, path: await appSource(t, { version: '2' }) }, caller);
  await committing;
  release();
  const [refused] = await Promise.all([removing, updating]);

  assert.equal(refused?.code, 'LAST_VERSION', 'the delete saw the record as it was, and was refused, not applied to a newer one');
  assert.deepEqual((await store.get(pub.id)).versions.map((v) => v.n), [1, 2]);
  await host.settled();
  assert.deepEqual({ status: host.status(pub.id).status, version: host.status(pub.id).version }, { status: 'running', version: 2 });
  await fsp.access(path.join(storeDir, 'artifacts', pub.id, 'v', '1', 'content'));
});
