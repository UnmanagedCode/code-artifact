// Pins the log file helpers: rotation keeps the newest `cap` bytes and truncates, leaves a small log alone; tail reads the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readTail, rotateIfOver } from '../src/appLog.js';
import { tmp } from './_helpers.mjs';

test('rotateIfOver keeps the last cap bytes in .1 and truncates the log', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  const text = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}\n`).join('');
  await fsp.writeFile(file, text);
  await rotateIfOver(file, 40);
  assert.equal(await fsp.readFile(`${file}.1`, 'utf8'), text.slice(-40));
  assert.equal((await fsp.stat(file)).size, 0);
});

test('rotateIfOver leaves a log at or under the cap alone', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  await fsp.writeFile(file, 'x'.repeat(40));
  await rotateIfOver(file, 40);
  assert.equal((await fsp.stat(file)).size, 40);
  await assert.rejects(fsp.access(`${file}.1`));
  await rotateIfOver(path.join(path.dirname(file), 'missing.log'), 40);
});

test('readTail returns the last bytes, all of a short file, and empty for no file', async (t) => {
  const file = path.join(await tmp(t), 'app.log');
  assert.equal(await readTail(file, 10), '');
  await fsp.writeFile(file, 'abcdefghij');
  assert.equal(await readTail(file, 4), 'ghij');
  assert.equal(await readTail(file, 100), 'abcdefghij');
});
