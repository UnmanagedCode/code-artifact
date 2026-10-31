// Pins the process lifecycle of one app: states and their transitions, install-once-per-version from a clean working copy,
// every failure path, group-wide Stop (with SIGKILL after the grace), idempotence, and the log files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { waitFor, markerPids, pidGone, publishApp, recordedPid, runApp, startApps, waitStatus } from './_apps.mjs';

const dirOf = (app, id) => path.join(app.storeDir, 'artifacts', id);
const logOf = async (app, id) => (await app.get(`/api/apps/${id}/log`)).text;
const echo = async (app, id) => (await fetch(`${app.base}/app/${id}/echo`)).json();

test('Start goes installing → starting → running, and the app sees PORT, BASE_PATH and a writable DATA_DIR', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'true' } });

  const started = await app.post(`/api/apps/${pub.id}/start`, {});
  assert.equal(started.status, 202);
  assert.equal(started.data.status, 'installing');
  assert.equal(started.data.version, 1);
  await waitStatus(app, pub.id, 'running');

  const seen = await echo(app, pub.id);
  const port = /start v1 on port (\d+)/.exec(await logOf(app, pub.id))[1];
  assert.equal(seen.env.PORT, port, 'the app listens on the port the host probed');
  assert.equal(seen.env.BASE_PATH, `/plugins/code-artifact/app/${pub.id}`);
  assert.equal(seen.env.DATA_DIR, path.join(await fsp.realpath(app.storeDir), 'artifacts', pub.id, 'data'));
  assert.equal(seen.cwd, await fsp.realpath(path.join(dirOf(app, pub.id), 'v', '1', 'run')), 'it runs from the working copy');
  const written = await (await fetch(`${app.base}/app/${pub.id}/data?add=hello`)).json();
  assert.equal(written.data, 'hello\n');
});

test('an app without an install command still gets its working copy', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  const res = await app.post(`/api/apps/${pub.id}/start`, {});
  assert.equal(res.data.status, 'installing', 'the first Start copies, whatever the manifest says');
  await waitStatus(app, pub.id, 'running');
  assert.equal((await echo(app, pub.id)).version, '1');
});

test('install runs once per version: a second Start reuses the working copy', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'echo x >> "$DATA_DIR/installs"' } });
  await runApp(app, pub.id);
  assert.equal((await echo(app, pub.id)).installs, 1);
  await app.post(`/api/apps/${pub.id}/stop`, {});
  const again = await app.post(`/api/apps/${pub.id}/start`, {});
  assert.equal(again.data.status, 'starting', 'no install the second time');
  await waitStatus(app, pub.id, 'running');
  assert.equal((await echo(app, pub.id)).installs, 1);
});

test('a failed install is failed with its code, its output is in the log, and the retry starts from a clean copy', async (t) => {
  const app = await startApps(t);
  const install = 'if [ -e sentinel.txt ]; then echo STALE; exit 9; fi; touch sentinel.txt; echo install-output; exit 7';
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install } });
  await app.post(`/api/apps/${pub.id}/start`, {});
  const failed = await waitStatus(app, pub.id, 'failed');
  assert.match(failed.error, /install exited with code 7/);
  assert.match(await logOf(app, pub.id), /install-output/);
  await assert.rejects(fsp.access(path.join(dirOf(app, pub.id), 'v', '1', 'installed')), 'no marker after a failed install');

  await app.post(`/api/apps/${pub.id}/start`, {});
  const second = await waitStatus(app, pub.id, 'failed');
  assert.match(second.error, /code 7/, 'the stale file did not survive: the retry installed from a clean copy');
  assert.doesNotMatch(await logOf(app, pub.id), /^STALE$/m);
});

test('an install that outlives installTimeoutMs fails as timed out and its group is killed', async (t) => {
  const app = await startApps(t, { appTimings: { installTimeoutMs: 300 } });
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'sleep 300' } });
  await app.post(`/api/apps/${pub.id}/start`, {});
  const failed = await waitStatus(app, pub.id, 'failed');
  assert.match(failed.error, /install timed out/);
  await waitFor(async () => (await markerPids(app.storeDir)).length === 0, { what: 'the install group to die' });
});

test('an app that exits before listening is failed with its exit code', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { fixture: { failBeforeListen: true } });
  await app.post(`/api/apps/${pub.id}/start`, {});
  const failed = await waitStatus(app, pub.id, 'failed');
  assert.match(failed.error, /exited with code 3 before listening/);
  assert.match(await logOf(app, pub.id), /fixture failing before listen/, 'its output is in the log');
});

test('an app that exits after running is failed', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { fixture: { exitAfterMs: 800 } });
  await runApp(app, pub.id);
  const failed = await waitStatus(app, pub.id, 'failed');
  assert.match(failed.error, /^exited with code 0$/);
});

test('an app that never listens is failed after startTimeoutMs and its process is dead', async (t) => {
  const app = await startApps(t, { appTimings: { startTimeoutMs: 600 } });
  const pub = await publishApp(t, app, { fixture: { neverListen: true } });
  await app.post(`/api/apps/${pub.id}/start`, {});
  const failed = await waitStatus(app, pub.id, 'failed');
  assert.match(failed.error, /did not listen on port \d+ within/);
  await pidGone(await recordedPid(app.storeDir, pub.id));
});

test('Stop kills the whole process group, a grandchild included', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  const leader = await recordedPid(app.storeDir, pub.id);
  await fetch(`${app.base}/app/${pub.id}/spawn`);
  const grandchild = await recordedPid(app.storeDir, pub.id, 'grandchild.pid');
  const stopped = await app.post(`/api/apps/${pub.id}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.status, 'stopped');
  await pidGone(leader);
  await pidGone(grandchild);
  assert.deepEqual(await markerPids(app.storeDir), []);
});

test('an app that ignores SIGTERM is killed after the grace period', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { fixture: { ignoreTerm: true } });
  await runApp(app, pub.id);
  const pid = await recordedPid(app.storeDir, pub.id);
  assert.equal((await app.post(`/api/apps/${pub.id}/stop`, {})).data.status, 'stopped');
  await pidGone(pid);
});

test('Stop during installing kills the install', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'sleep 300' } });
  await app.post(`/api/apps/${pub.id}/start`, {});
  await waitFor(async () => (await markerPids(app.storeDir)).length > 0, { what: 'the install to run' });
  const stopped = await app.post(`/api/apps/${pub.id}/stop`, {});
  assert.equal(stopped.data.status, 'stopped');
  assert.deepEqual(await markerPids(app.storeDir), []);
  assert.equal((await app.get(`/api/apps/${pub.id}`)).data.status, 'stopped', 'a killed install is not a failure');
});

test('Start and Stop are idempotent, and Stop clears a failure', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  assert.equal((await app.post(`/api/apps/${pub.id}/stop`, {})).data.status, 'stopped', 'stop on a never-started app');
  await runApp(app, pub.id);
  const pid = await recordedPid(app.storeDir, pub.id);
  const again = await app.post(`/api/apps/${pub.id}/start`, {});
  assert.equal(again.data.status, 'running');
  assert.equal(await recordedPid(app.storeDir, pub.id), pid, 'no second process');
  assert.equal((await app.post(`/api/apps/${pub.id}/stop`, {})).data.status, 'stopped');
  assert.equal((await app.post(`/api/apps/${pub.id}/stop`, {})).data.status, 'stopped');

  const bad = await publishApp(t, app, { fixture: { failBeforeListen: true } });
  await app.post(`/api/apps/${bad.id}/start`, {});
  await waitStatus(app, bad.id, 'failed');
  const cleared = (await app.post(`/api/apps/${bad.id}/stop`, {})).data;
  assert.equal(cleared.status, 'stopped');
  assert.equal(cleared.error, null);
});

test('a second Start moves the previous run\'s log to app.log.1', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  await app.post(`/api/apps/${pub.id}/stop`, {});
  assert.match(await logOf(app, pub.id), /stopped/);
  await runApp(app, pub.id);
  assert.doesNotMatch(await logOf(app, pub.id), /stopped/, 'the new log starts empty of the old run');
  const previous = await fsp.readFile(path.join(dirOf(app, pub.id), 'app.log.1'), 'utf8');
  assert.match(previous, /fixture listening/);
  assert.match(previous, /\[code-artifact\] stopped/);
});

test('a running log over the cap is rotated: app.log.1 holds the newest bytes and app.log is truncated', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  await fetch(`${app.base}/app/${pub.id}/spam?lines=2500`);
  const log = path.join(dirOf(app, pub.id), 'app.log');
  const rotated = `${log}.1`;
  // Settled: .1 holds the final tail (a round that raced the app's write is skipped, never kept partial) and app.log is truncated.
  const settled = async () => {
    const kept = await fsp.readFile(rotated, 'utf8').catch(() => '');
    return kept.endsWith('line-02500\nEND\n') && (await fsp.stat(log)).size <= 4096 ? kept : null;
  };
  const kept = await waitFor(settled, { what: 'log rotation to settle' });
  assert.equal(Buffer.byteLength(kept), 4096, 'the cap\'s worth of the tail is kept');
  assert.doesNotMatch(kept, /line-00001\n/, 'the head is dropped');
});

test('the mount comes from createServer, not from a request: BASE_PATH follows it', async (t) => {
  const app = await startApps(t, { mount: '/mnt/x' });
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  assert.equal((await echo(app, pub.id)).env.BASE_PATH, `/mnt/x/app/${pub.id}`);
});

test('an installed marker without its working copy is not trusted: Start copies and installs again', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'echo x >> "$DATA_DIR/installs"' } });
  await runApp(app, pub.id);
  await app.post(`/api/apps/${pub.id}/stop`, {});
  const version = path.join(dirOf(app, pub.id), 'v', '1');
  await fsp.rm(path.join(version, 'run'), { recursive: true });
  await fsp.access(path.join(version, 'installed'));
  const again = await app.post(`/api/apps/${pub.id}/start`, {});
  assert.equal(again.data.status, 'installing');
  await waitStatus(app, pub.id, 'running');
  assert.equal((await echo(app, pub.id)).installs, 2);
});

test('an interrupted reinstall leaves no marker, so the next Start installs again', async (t) => {
  const app = await startApps(t);
  const install = 'if [ -e "$DATA_DIR/hang" ]; then sleep 300; fi; echo x >> "$DATA_DIR/installs"';
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install } });
  await runApp(app, pub.id);
  await app.post(`/api/apps/${pub.id}/stop`, {});
  const version = path.join(dirOf(app, pub.id), 'v', '1');
  await fsp.rm(path.join(version, 'run'), { recursive: true });
  await fsp.writeFile(path.join(dirOf(app, pub.id), 'data', 'hang'), '');

  await app.post(`/api/apps/${pub.id}/start`, {});
  await waitFor(async () => (await markerPids(app.storeDir)).length > 0, { what: 'the reinstall to run' });
  await app.post(`/api/apps/${pub.id}/stop`, {});
  await assert.rejects(fsp.access(path.join(version, 'installed')), 'the stale marker went before the copy did');

  await fsp.rm(path.join(dirOf(app, pub.id), 'data', 'hang'));
  const again = await app.post(`/api/apps/${pub.id}/start`, {});
  assert.equal(again.data.status, 'installing', 'a partial working copy is not an installed one');
  await waitStatus(app, pub.id, 'running');
  assert.equal((await echo(app, pub.id)).installs, 2);
});

test('Stop also kills a descendant that left the process group, found by the run marker', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app);
  await runApp(app, pub.id);
  await fetch(`${app.base}/app/${pub.id}/escape`);
  const escaped = await recordedPid(app.storeDir, pub.id, 'escaped.pid');
  const leader = await recordedPid(app.storeDir, pub.id);
  const stat = await fsp.readFile(`/proc/${escaped}/stat`, 'utf8');
  const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  assert.notEqual(pgrp, leader, 'it is in a group of its own');
  await app.post(`/api/apps/${pub.id}/stop`, {});
  await pidGone(escaped);
  assert.deepEqual(await markerPids(app.storeDir), []);
});
