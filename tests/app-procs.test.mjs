// Pins the OS layer's liveness rule: a zombie, or a process being reaped, is not alive, though kill(pid, 0) still succeeds on a zombie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { HAS_PROC, groupAlive, isDead, parseStat, pidAlive } from '../src/appProcs.js';
import { waitFor } from './_apps.mjs';

test('an unreaped zombie is reported gone by pidAlive although kill(pid, 0) succeeds', { skip: !HAS_PROC }, async (t) => {
  // The inner sh exits only once its parent has exec'd into `sleep`, which never waits, so the child stays a zombie.
  // (An inner sh that exits earlier can be reaped by the outer sh before the exec.)
  const inner = 'while [ "$(cat /proc/$PPID/comm)" != sleep ]; do :; done';
  const sleeper = spawn('/bin/sh', ['-c', `sh -c '${inner}' & echo $!; exec sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  t.after(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ } });
  const zombie = Number(await new Promise((resolve) => sleeper.stdout.once('data', (d) => resolve(String(d).trim()))));
  const state = async () => {
    const stat = await fsp.readFile(`/proc/${zombie}/stat`, 'utf8').catch(() => '');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  };
  await waitFor(async () => (await state()) === 'Z', { what: 'the child to become a zombie' });
  assert.doesNotThrow(() => process.kill(zombie, 0), 'a naive check calls it alive');
  assert.equal(await pidAlive(zombie), false);
  assert.equal(await pidAlive(sleeper.pid), true, 'a live process still reads alive');
  assert.equal(await groupAlive(sleeper.pid), true);
  process.kill(-sleeper.pid, 'SIGKILL');
  await waitFor(async () => !(await groupAlive(sleeper.pid)), { what: 'the group to die' });
});

test('a process in state Z or X reads dead, any other state alive', () => {
  const stat = (state, comm = 'node') => `4242 (${comm}) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 5000 1000000 500 18446744073709551615`;
  for (const state of ['R', 'S', 'D', 'T']) assert.equal(isDead(parseStat(stat(state))), false, state);
  for (const state of ['Z', 'X']) assert.equal(isDead(parseStat(stat(state))), true, state);
  assert.equal(isDead(null), true, 'a gone process is dead');
  // comm may hold spaces and parens; the fields after it must still parse.
  assert.deepEqual(parseStat(stat('S', 'a b) S 9 9')), { state: 'S', ppid: 1, pgrp: 4242 });
});
