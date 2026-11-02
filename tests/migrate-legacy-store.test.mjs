// Pins the one-shot boot move of <PROJECTS_ROOT>/.code-artifact into the plugin data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { migrateLegacyStore } from '../src/migrateLegacyStore.js';
import { tmp, writeTree } from './_helpers.mjs';

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

async function fixture(t) {
  const root = await tmp(t);
  const legacy = path.join(root, '.code-artifact');
  await writeTree(legacy, { 'artifacts/x/artifact.json': '{"id":"x"}', 'note.txt': 'hello' });
  const data = path.join(root, '.code-conductor', 'plugins', 'data', 'code-artifact');
  const lines = [];
  const log = { log: (l) => lines.push(l) };
  const run = (over = {}) => migrateLegacyStore({ env: { PROJECTS_ROOT: root }, dataDir: data, log, ...over });
  return { root, legacy, data, lines, run };
}

const refused = async (promise, ...paths) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, 'ESTOREMIGRATE');
    for (const p of paths) assert.ok(e.message.includes(p), `message names ${p}: ${e.message}`);
    return true;
  });
};

test('no PROJECTS_ROOT (unset or empty) is a no-op', async (t) => {
  const { legacy, data, run } = await fixture(t);
  assert.equal(await run({ env: {} }), 'no-root');
  assert.equal(await run({ env: { PROJECTS_ROOT: '' } }), 'no-root');
  assert.ok(await exists(path.join(legacy, 'note.txt')));
  assert.equal(await exists(data), false);
});

test('an absent legacy store is a no-op', async (t) => {
  const { legacy, data, lines, run } = await fixture(t);
  await fsp.rm(legacy, { recursive: true });
  assert.equal(await run(), 'absent');
  assert.equal(await exists(path.dirname(data)), false);
  assert.deepEqual(lines, []);
});

test('the legacy store moves whole, keeping modes, and parents are created', async (t) => {
  const { legacy, data, lines, run } = await fixture(t);
  await fsp.chmod(legacy, 0o750);
  await fsp.chmod(path.join(legacy, 'note.txt'), 0o600);
  assert.equal(await run(), 'moved');
  assert.equal(await exists(legacy), false);
  assert.equal((await fsp.stat(data)).mode & 0o777, 0o750);
  const note = path.join(data, 'note.txt');
  assert.equal((await fsp.stat(note)).mode & 0o777, 0o600);
  assert.equal(await fsp.readFile(note, 'utf8'), 'hello');
  assert.ok(await exists(path.join(data, 'artifacts', 'x', 'artifact.json')));
  assert.ok(lines.some((l) => l.includes(legacy) && l.includes(data)));
});

test('an empty target dir is replaced', async (t) => {
  const { data, run } = await fixture(t);
  await fsp.mkdir(data, { recursive: true });
  assert.equal(await run(), 'moved');
  assert.equal(await fsp.readFile(path.join(data, 'note.txt'), 'utf8'), 'hello');
});

test('a non-empty target is refused and nothing moves', async (t) => {
  const { legacy, data, run } = await fixture(t);
  await writeTree(data, { keep: 'mine' });
  await refused(run(), legacy, data);
  assert.equal(await fsp.readFile(path.join(legacy, 'note.txt'), 'utf8'), 'hello');
  assert.deepEqual(await fsp.readdir(data), ['keep']);
  assert.equal(await fsp.readFile(path.join(data, 'keep'), 'utf8'), 'mine');
});

test('a legacy path that is not a directory is refused', async (t) => {
  const { root, legacy, data, run } = await fixture(t);
  const real = path.join(root, 'real-store');
  await fsp.rename(legacy, real);
  await fsp.symlink(real, legacy);
  await refused(run(), legacy, data);
  assert.ok((await fsp.lstat(legacy)).isSymbolicLink());
  assert.ok(await exists(path.join(real, 'note.txt')));

  await fsp.unlink(legacy);
  await fsp.writeFile(legacy, 'a file');
  await refused(run(), legacy, data);
  assert.equal(await fsp.readFile(legacy, 'utf8'), 'a file');
});

test('a target that is not a directory is refused', async (t) => {
  const { legacy, data, run } = await fixture(t);
  await fsp.mkdir(path.dirname(data), { recursive: true });
  await fsp.writeFile(data, 'a file');
  await refused(run(), legacy, data);
  assert.ok(await exists(path.join(legacy, 'note.txt')));
  assert.equal(await fsp.readFile(data, 'utf8'), 'a file');
});

test('EXDEV is refused with the mv fix and nothing moves', async (t) => {
  const { legacy, data, run } = await fixture(t);
  const rename = async () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); };
  await assert.rejects(run({ rename }), (e) => {
    assert.equal(e.code, 'ESTOREMIGRATE');
    assert.ok(e.message.includes(legacy) && e.message.includes(data) && e.message.includes('mv'));
    assert.equal(e.cause.code, 'EXDEV');
    return true;
  });
  assert.ok(await exists(path.join(legacy, 'note.txt')));
  assert.equal(await exists(data), false);
});

test('a second run is a no-op', async (t) => {
  const { data, run } = await fixture(t);
  assert.equal(await run(), 'moved');
  assert.equal(await run(), 'absent');
  assert.equal(await fsp.readFile(path.join(data, 'note.txt'), 'utf8'), 'hello');
});

test('a data dir equal to the legacy path is a no-op', async (t) => {
  const { legacy, run } = await fixture(t);
  assert.equal(await run({ dataDir: legacy }), 'same');
  assert.ok(await exists(path.join(legacy, 'note.txt')));
});
