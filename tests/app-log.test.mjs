// Pins the log file helpers: rotation keeps the newest `cap` bytes and truncates, leaves a small log alone, skips a round that
// raced the app's write but only a bounded number in a row; tail reads the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRotator, readTail } from '../src/appLog.js';
import { tmp } from './_helpers.mjs';

test('a rotation keeps the last cap bytes in .1 and truncates the log', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  const text = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}\n`).join('');
  await fsp.writeFile(file, text);
  await createRotator(file, 40)();
  assert.equal(await fsp.readFile(`${file}.1`, 'utf8'), text.slice(-40));
  assert.equal((await fsp.stat(file)).size, 0);
});

test('a rotation leaves a log at or under the cap alone', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  await fsp.writeFile(file, 'x'.repeat(40));
  await createRotator(file, 40)();
  assert.equal((await fsp.stat(file)).size, 40);
  await assert.rejects(fsp.access(`${file}.1`));
  await createRotator(path.join(path.dirname(file), 'missing.log'), 40)();
});

test('readTail returns the last bytes, all of a short file, and empty for no file', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  assert.equal(await readTail(file, 10), '');
  await fsp.writeFile(file, 'abcdefghij');
  assert.equal(await readTail(file, 4), 'ghij');
  assert.equal(await readTail(file, 100), 'abcdefghij');
});

test('a round where the log grew under the read is skipped once, then the bounded round rotates anyway', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  await fsp.writeFile(file, 'a'.repeat(100));
  // The file grows between the stat and the read, every round: an app that never stops writing.
  const rotate = createRotator(file, 40, { maxSkips: 1, afterStat: () => fsp.appendFile(file, 'b'.repeat(10)) });
  await rotate();
  await assert.rejects(fsp.access(`${file}.1`), 'the first round saw the size move and skipped');
  assert.equal((await fsp.stat(file)).size, 110, 'the log was left as it was');
  await rotate();
  assert.equal((await fsp.stat(`${file}.1`)).size, 40, 'the second round rotated although the file was still growing');
  assert.equal((await fsp.stat(file)).size, 0);
});

test('with a stable size the very first round rotates, and the skip allowance resets after a rotation', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  let grow = true;
  await fsp.writeFile(file, 'a'.repeat(100));
  const rotate = createRotator(file, 40, { maxSkips: 1, afterStat: () => (grow ? fsp.appendFile(file, 'b') : undefined) });
  await rotate(); // skipped
  await rotate(); // forced
  await fsp.writeFile(file, 'c'.repeat(100));
  await rotate(); // skipped again: the allowance was reset
  assert.equal((await fsp.stat(file)).size, 101);
  grow = false;
  await rotate();
  assert.equal((await fsp.stat(file)).size, 0);
});
