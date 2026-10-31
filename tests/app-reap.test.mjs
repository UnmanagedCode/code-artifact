// Pins that apps never outlive their backend: a crashed backend's orphans are reaped by the next boot on the same store,
// another store's apps are left alone, shutdown() stops everything, and a SIGTERMed backend stops its apps before it exits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, pidAlive } from '../src/appProcs.js';
import { tmp } from './_helpers.mjs';
import { appSource, markerPids, pidGone, publishApp, recordedPid, runApp, startApps, waitFor } from './_apps.mjs';

test('a boot on the same store reaps what a crashed backend left behind', async (t) => {
  const a = await startApps(t);
  const pub = await publishApp(t, a);
  await runApp(a, pub.id);
  const pid = await recordedPid(a.storeDir, pub.id);
  assert.ok((await markerPids(a.storeDir)).includes(pid));
  // A crash: the listener goes, the host never gets to stop anything.
  await new Promise((r) => { a.server.close(r); a.server.closeAllConnections(); });
  assert.ok(await pidAlive(pid), 'the orphan is still running');

  const b = await startApps(t, { storeDir: a.storeDir });
  await pidGone(pid);
  assert.deepEqual(await markerPids(a.storeDir), []);
  assert.equal((await b.get(`/api/apps/${pub.id}`)).data.status, 'stopped', 'apps come back stopped, never adopted');
});

test('a boot on another store leaves this store\'s apps running', async (t) => {
  const a = await startApps(t);
  const pub = await publishApp(t, a);
  await runApp(a, pub.id);
  const pid = await recordedPid(a.storeDir, pub.id);
  const b = await startApps(t);
  assert.ok(b.storeDir !== a.storeDir);
  assert.ok(await pidAlive(pid));
  assert.equal((await (await fetch(`${a.base}/app/${pub.id}/echo`)).json()).version, '1');
});

test('shutdown() stops every running app and leaves nothing marked', async (t) => {
  const a = await startApps(t);
  const ids = [(await publishApp(t, a)).id, (await publishApp(t, a)).id];
  for (const id of ids) await runApp(a, id);
  const pids = await Promise.all(ids.map((id) => recordedPid(a.storeDir, id)));
  await a.server.apps.shutdown();
  for (const pid of pids) await pidGone(pid);
  assert.deepEqual(await markerPids(a.storeDir), []);
});

test('SIGTERM to the backend stops its apps and exits 0', async (t) => {
  const storeDir = path.join(await tmp(t), 'store');
  const port = await freePort();
  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, CODE_ARTIFACT_STORE: storeDir, PORT: String(port) };
  delete env.CONDUCTOR_URL;
  const backend = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  backend.stdout.on('data', (d) => { output += d; });
  backend.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => backend.once('exit', (code, sig) => resolve({ code, sig })));
  t.after(() => { if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGKILL'); });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${base}/api/health`).then((r) => r.ok, () => false), { what: `the backend to listen\n${output}` });

  const json = { 'content-type': 'application/json' };
  const call = async (url, body) => (await fetch(base + url, { method: 'POST', headers: json, body: JSON.stringify(body) })).json();
  const pub = (await call('/api/mcp', { tool: 'publish_artifact', arguments: { path: await appSource(t), title: 'x' }, caller: { project: 'p' } })).result;
  await call(`/api/apps/${pub.id}/start`, {});
  await waitFor(async () => (await (await fetch(`${base}/api/apps/${pub.id}`)).json()).status === 'running', { what: `the app to run\n${output}` });
  const pid = await recordedPid(storeDir, pub.id);
  assert.ok(await pidAlive(pid));

  backend.kill('SIGTERM');
  const result = await waitFor(() => Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 20))]), { timeout: 10_000, what: `the backend to exit\n${output}` });
  assert.deepEqual(result, { code: 0, sig: null });
  assert.equal(await pidAlive(pid), false, 'the app was stopped before the backend exited');
  assert.deepEqual(await markerPids(storeDir), []);
  await fsp.access(storeDir);
});
