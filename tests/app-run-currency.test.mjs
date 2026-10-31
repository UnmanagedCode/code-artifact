// Pins run currency: a callback from a run that has been replaced (Start → Stop → Start, or a failed run started again)
// never changes the current run. The processes are fakes the test controls, so a late event is delivered on cue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createCc } from '../src/cc.js';
import { createOps } from '../src/ops.js';
import { createAppHost } from '../src/appHost.js';
import { tmp } from './_helpers.mjs';
import { TIMINGS, appSource, waitFor } from './_apps.mjs';

function fakeProcs() {
  let pid = 1000;
  let port = 40_000;
  const fake = {
    children: [], kills: [], listening: true,
    spawnGroup: (cmd) => { const c = new EventEmitter(); c.pid = ++pid; c.cmd = cmd; fake.children.push(c); return c; },
    killGroup: async (pgid) => { fake.kills.push(pgid); return true; },
    probe: async () => (fake.listening ? '127.0.0.1' : null),
    freePort: async () => ++port,
    reapMarked: async () => 0,
  };
  return fake;
}

async function setup(t) {
  const storeDir = path.join(await tmp(t), 'store');
  const store = await Store.open(storeDir);
  const procs = fakeProcs();
  const apps = createAppHost({ store, storeDir, timings: { ...TIMINGS, probeMs: 5 }, procs });
  t.after(() => apps.shutdown());
  const ops = createOps({ store, cc: createCc(null), apps });
  const pub = await ops.publish({ path: await appSource(t), title: 'x' }, { sessionId: 's', project: 'p' });
  const status = () => apps.status(pub.id);
  const running = () => waitFor(() => status().status === 'running', { what: 'running' });
  return { apps, procs, id: pub.id, status, running };
}

test('after Start → Stop → Start, a late exit of the first run changes nothing about the second', async (t) => {
  const { apps, procs, id, status, running } = await setup(t);
  await apps.start(id);
  await running();
  const [first] = procs.children;
  await apps.stop(id);
  await apps.start(id);
  await running();
  const second = procs.children[1];
  const before = { ...status() };
  const kills = procs.kills.length;

  first.emit('exit', 1, null); // the first run's exit arrives late, after it was replaced
  first.emit('error', new Error('late'));

  assert.deepEqual(status(), before, 'the second run is untouched');
  assert.equal(status().status, 'running');
  assert.equal(status().error, null);
  assert.equal(procs.kills.length, kills, 'no kill is aimed at the first run\'s old process group');
  assert.notEqual(second.pid, first.pid);
  second.emit('exit', 5, null);
  assert.equal(status().status, 'failed', 'while the current run\'s own exit still counts');
  assert.match(status().error, /exited with code 5/);
});

test('a run that failed and was started again ignores the failed run\'s late events', async (t) => {
  const { apps, procs, id, status, running } = await setup(t);
  procs.listening = false;
  await apps.start(id);
  await waitFor(() => procs.children.length === 1, { what: 'the first process' });
  const [first] = procs.children;
  first.emit('exit', 3, null);
  assert.equal(status().status, 'failed');
  const killsAfterFailure = procs.kills.length;

  procs.listening = true;
  await apps.start(id);
  await running();
  const before = { ...status() };
  first.emit('error', new Error('late')); // its error listener outlived its exit listener
  assert.deepEqual(status(), before);
  assert.equal(procs.kills.length, killsAfterFailure, 'the stale run is not killed a second time');
});
