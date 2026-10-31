// Pins the OS layer's liveness rule: a zombie is not alive, though kill(pid, 0) still succeeds on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { HAS_PROC, groupAlive, pidAlive } from '../src/appProcs.js';
import { waitFor } from './_apps.mjs';

test('an unreaped zombie is reported gone by pidAlive although kill(pid, 0) succeeds', { skip: !HAS_PROC }, async (t) => {
  // The inner sh exits at once; its parent `sleep` (exec'd over the outer sh) never waits, so the child stays a zombie.
  const sleeper = spawn('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
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
