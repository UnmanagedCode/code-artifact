// Pins the source → kind inference table and the explicit-kind compatibility refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from '../src/source.js';
import { resolveKind } from '../src/kinds.js';
import { fixtureDir, fixtureFile, packDir, rawTarball } from './_helpers.mjs';

const kindOf = async (p, explicit) => resolveKind(await inspectSource(p, explicit), explicit);
const refusal = (code) => (e) => e.code === code;

test('a .md or .MD file is markdown', async (t) => {
  assert.equal(await kindOf(await fixtureFile(t, 'notes.md', '# hi')), 'markdown');
  assert.equal(await kindOf(await fixtureFile(t, 'NOTES.MD', '# hi')), 'markdown');
});

test('a lone .html or .htm file is static', async (t) => {
  assert.equal(await kindOf(await fixtureFile(t, 'a.html', '<p>x')), 'static');
  assert.equal(await kindOf(await fixtureFile(t, 'a.HTM', '<p>x')), 'static');
});

test('any other file is a download', async (t) => {
  assert.equal(await kindOf(await fixtureFile(t, 'data.csv', 'a,b')), 'download');
});

test('a dir with index.html is static; any other dir is a download', async (t) => {
  assert.equal(await kindOf(await fixtureDir(t, { 'index.html': 'x' })), 'static');
  assert.equal(await kindOf(await fixtureDir(t, { 'readme.txt': 'x' })), 'download');
  assert.equal(await kindOf(await fixtureDir(t, { 'sub/index.html': 'x' })), 'download', 'only a root index.html counts');
});

test('a dir with artifact.json is app, even beside index.html', async (t) => {
  const dir = await fixtureDir(t, { 'artifact.json': '{}', 'index.html': 'x' });
  assert.equal(await kindOf(dir), 'app');
});

test('an explicit app kind needs a root artifact.json, else KIND_SOURCE_MISMATCH', async (t) => {
  await assert.rejects(kindOf(await fixtureDir(t, { 'index.html': 'x' }), 'app'), refusal('KIND_SOURCE_MISMATCH'));
  await assert.rejects(kindOf(await fixtureFile(t, 'artifact.json', '{}'), 'app'), refusal('KIND_SOURCE_MISMATCH'), 'a lone file is never an app');
  assert.equal(await kindOf(await fixtureDir(t, { 'artifact.json': '{}' }), 'app'), 'app');
});

test('a tarball with a root or sole-top-dir index.html is static; otherwise a download', async (t) => {
  const site = await fixtureDir(t, { 'index.html': 'x', 'a.js': 'y' }, 'dist');
  assert.equal(await kindOf(await packDir(t, site)), 'static');
  assert.equal(await kindOf(await packDir(t, site, { wrap: true })), 'static');
  const plain = await fixtureDir(t, { 'a.txt': 'x', 'b.txt': 'y' }, 'dist');
  assert.equal(await kindOf(await packDir(t, plain)), 'download');
});

test('a tarball with a root artifact.json is app, inferred or explicit', async (t) => {
  const dir = await fixtureDir(t, { 'artifact.json': '{}' }, 'dist');
  assert.equal(await kindOf(await packDir(t, dir, { wrap: true })), 'app');
  assert.equal(await kindOf(await packDir(t, dir), 'app'), 'app');
  const plain = await fixtureDir(t, { 'a.txt': 'x' }, 'dist');
  await assert.rejects(kindOf(await packDir(t, plain), 'app'), refusal('KIND_SOURCE_MISMATCH'));
});

test('the sole-top-dir rule strips one level only and only for a single directory root', async (t) => {
  const two = await fixtureDir(t, { 'dist/index.html': 'x', 'other.txt': 'y' });
  const info = await inspectSource(await packDir(t, two));
  assert.equal(info.strip, 0);
  const wrapped = await fixtureDir(t, { 'index.html': 'x' }, 'dist');
  const info2 = await inspectSource(await packDir(t, wrapped, { wrap: true }));
  assert.equal(info2.strip, 1);
  assert.deepEqual(info2.rootEntries, [{ name: 'index.html', dir: false }]);
});

test('explicit markdown needs a regular non-tarball file; a dir or tarball is KIND_SOURCE_MISMATCH', async (t) => {
  assert.equal(await kindOf(await fixtureFile(t, 'notes.txt', 'x'), 'markdown'), 'markdown');
  await assert.rejects(kindOf(await fixtureDir(t, { 'a.md': 'x' }), 'markdown'), refusal('KIND_SOURCE_MISMATCH'));
  const dir = await fixtureDir(t, { 'a.md': 'x' }, 'd');
  await assert.rejects(kindOf(await packDir(t, dir), 'markdown'), refusal('KIND_SOURCE_MISMATCH'));
});

test('explicit static needs an html file or a root index.html; anything else is KIND_SOURCE_MISMATCH', async (t) => {
  await assert.rejects(kindOf(await fixtureFile(t, 'a.txt', 'x'), 'static'), refusal('KIND_SOURCE_MISMATCH'));
  await assert.rejects(kindOf(await fixtureDir(t, { 'a.txt': 'x' }), 'static'), refusal('KIND_SOURCE_MISMATCH'));
  assert.equal(await kindOf(await fixtureFile(t, 'a.html', 'x'), 'static'), 'static');
});

test('explicit download accepts any source, a corrupt tarball included (it is kept as-is, never listed)', async (t) => {
  assert.equal(await kindOf(await fixtureFile(t, 'a.md', 'x'), 'download'), 'download');
  assert.equal(await kindOf(await fixtureFile(t, 'broken.tgz', 'not a tarball'), 'download'), 'download');
  assert.equal(await kindOf(await fixtureDir(t, { 'index.html': 'x' }), 'download'), 'download');
});

test('an unknown explicit kind is INVALID_ARGUMENT', async (t) => {
  await assert.rejects(kindOf(await fixtureFile(t, 'a.md', 'x'), 'bogus'), refusal('INVALID_ARGUMENT'));
});

test('source errors: relative path, missing path, special file', async (t) => {
  await assert.rejects(inspectSource('rel/path'), refusal('PATH_NOT_ABSOLUTE'));
  await assert.rejects(inspectSource('/nonexistent/zzz'), refusal('PATH_NOT_FOUND'));
  await assert.rejects(inspectSource('/dev/null'), refusal('UNSUPPORTED_SOURCE'));
  await assert.rejects(inspectSource('/tmp/a\0b'), refusal('INVALID_ARGUMENT'));
});

test('a corrupt tarball with no explicit kind is BAD_ARCHIVE', async (t) => {
  await assert.rejects(inspectSource(await fixtureFile(t, 'broken.tgz', 'not a tarball')), refusal('BAD_ARCHIVE'));
  await assert.rejects(inspectSource(await fixtureFile(t, 'junk.tgz', Buffer.alloc(3000, 7))), refusal('BAD_ARCHIVE'));
});

test('unsafe tar entries are refused while listing: .., absolute, backslash, symlink, hardlink, device', async (t) => {
  const bad = [
    { name: '../evil.txt' }, { name: '/abs.txt' }, { name: 'a\\b.txt' },
    { name: 'ln', type: '2', linkname: '/etc/passwd' }, { name: 'hl', type: '1', linkname: 'x' }, { name: 'dev', type: '3' },
  ];
  for (const entry of bad) {
    const file = await rawTarball(t, [{ name: 'index.html', data: 'x' }, entry]);
    await assert.rejects(inspectSource(file), (e) => e.code === 'UNSAFE_ENTRY' && e.message.includes(entry.name.split('\\')[0]), entry.name);
  }
});

test('a tarball past the entry cap is TOO_LARGE while listing', async (t) => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
  const file = await rawTarball(t, entries);
  await assert.rejects(inspectSource(file, undefined, { maxBytes: 1e9, maxFiles: 3, maxMarkdownBytes: 1 }), refusal('TOO_LARGE'));
  await assert.rejects(inspectSource(file, undefined, { maxBytes: 3, maxFiles: 100, maxMarkdownBytes: 1 }), refusal('TOO_LARGE'));
});
