// Pins ingest: byte-identical copies, an untouched source, refusal of unsafe entries with nothing left staged,
// the size caps, tarball extraction, download packing and the reserved v/<n> path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { execFileSync } from 'node:child_process';
import { inspectSource } from '../src/source.js';
import { resolveKind } from '../src/kinds.js';
import { stageContent } from '../src/ingest.js';
import { fixtureDir, fixtureFile, packDir, rawTarball, tmp, writeTree } from './_helpers.mjs';

const refusal = (code) => (e) => e.code === code;

async function stage(t, source, explicit, limits) {
  const info = await inspectSource(source, explicit, limits);
  const kind = resolveKind(info, explicit);
  const staging = await tmp(t, 'ca-stage-');
  const out = await stageContent(info, kind, staging, limits);
  return { out, staging, kind };
}
const listTree = async (dir) => (await fsp.readdir(dir, { recursive: true })).sort();

test('markdown: the file is copied byte-identically, rendered.html is written, the source is untouched', async (t) => {
  const bytes = Buffer.from([0x23, 0x20, 0x68, 0x69, 0xff, 0x0a]);
  const src = await fixtureFile(t, 'n.md', bytes);
  const before = await fsp.stat(src);
  const { out, staging } = await stage(t, src);
  assert.deepEqual(await fsp.readFile(path.join(staging, 'content', 'n.md')), bytes);
  assert.match(await fsp.readFile(path.join(staging, 'rendered.html'), 'utf8'), /<h1>hi/);
  assert.deepEqual(out, { bytes: bytes.length, files: 1, file: 'n.md' });
  assert.equal((await fsp.stat(src)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fsp.readFile(src), bytes);
});

test('a markdown source over the cap is TOO_LARGE', async (t) => {
  const src = await fixtureFile(t, 'n.md', 'x'.repeat(100));
  await assert.rejects(stage(t, src, undefined, { maxBytes: 1e9, maxFiles: 100, maxMarkdownBytes: 50 }), refusal('TOO_LARGE'));
});

test('static dir: the tree is copied byte-identically', async (t) => {
  const src = await fixtureDir(t, { 'index.html': 'home', 'css/a.css': 'body{}', 'img/': '' });
  const { out, staging } = await stage(t, src);
  assert.equal(await fsp.readFile(path.join(staging, 'content/css/a.css'), 'utf8'), 'body{}');
  assert.deepEqual(await listTree(path.join(staging, 'content')), ['css', 'css/a.css', 'img', 'index.html']);
  assert.equal(out.files, 2);
  assert.equal(out.bytes, 'home'.length + 'body{}'.length);
});

test('a lone html file is stored as content/index.html', async (t) => {
  const { staging, kind } = await stage(t, await fixtureFile(t, 'page.html', '<p>x</p>'));
  assert.equal(kind, 'static');
  assert.equal(await fsp.readFile(path.join(staging, 'content/index.html'), 'utf8'), '<p>x</p>');
});

test('download: a file is kept as-is; a tarball is kept un-extracted', async (t) => {
  const { out, staging } = await stage(t, await fixtureFile(t, 'd.bin', 'abc'));
  assert.deepEqual(out, { bytes: 3, files: 1, file: 'd.bin' });
  assert.equal(await fsp.readFile(path.join(staging, 'content/d.bin'), 'utf8'), 'abc');
  const dir = await fixtureDir(t, { 'a.txt': 'x', 'b.txt': 'y' }, 'pkg');
  const tgz = await packDir(t, dir, { name: 'pkg.tgz' });
  const r = await stage(t, tgz);
  assert.deepEqual(await listTree(path.join(r.staging, 'content')), ['pkg.tgz']);
});

test('download: a directory is packed as <basename>.tar.gz that holds its files', async (t) => {
  const dir = await fixtureDir(t, { 'a.txt': 'one', 'sub/b.txt': 'two' }, 'bundle');
  const { out, staging } = await stage(t, dir);
  assert.equal(out.file, 'bundle.tar.gz');
  assert.equal(out.files, 2);
  const unpack = await tmp(t);
  await tar.x({ file: path.join(staging, 'content/bundle.tar.gz'), cwd: unpack });
  assert.equal(await fsp.readFile(path.join(unpack, 'sub/b.txt'), 'utf8'), 'two');
});

test('a directory symlink, a file symlink and a fifo are UNSAFE_ENTRY naming the relative path', async (t) => {
  const dir = await fixtureDir(t, { 'index.html': 'x', 'real/f.txt': 'y' });
  await fsp.symlink('real', path.join(dir, 'linkdir'));
  await assert.rejects(stage(t, dir), (e) => e.code === 'UNSAFE_ENTRY' && e.message.includes('linkdir'));
  await fsp.rm(path.join(dir, 'linkdir'));
  await fsp.symlink('/etc/passwd', path.join(dir, 'real/pw'));
  await assert.rejects(stage(t, dir), (e) => e.code === 'UNSAFE_ENTRY' && e.message.includes('real/pw'));
  await fsp.rm(path.join(dir, 'real/pw'));
  execFileSync('mkfifo', [path.join(dir, 'pipe')]);
  await assert.rejects(stage(t, dir), (e) => e.code === 'UNSAFE_ENTRY' && e.message.includes('pipe'));
});

test('a file name with a backslash is UNSAFE_ENTRY', async (t) => {
  const dir = await fixtureDir(t, { 'index.html': 'x', 'a\\b.txt': 'y' });
  await assert.rejects(stage(t, dir), refusal('UNSAFE_ENTRY'));
});

test('a directory past the file or byte cap is TOO_LARGE', async (t) => {
  const dir = await fixtureDir(t, { 'index.html': 'x', 'a.txt': 'yy', 'b.txt': 'zz' });
  await assert.rejects(stage(t, dir, undefined, { maxBytes: 1e9, maxFiles: 2, maxMarkdownBytes: 1e6 }), refusal('TOO_LARGE'));
  await assert.rejects(stage(t, dir, undefined, { maxBytes: 4, maxFiles: 100, maxMarkdownBytes: 1e6 }), refusal('TOO_LARGE'));
});

test('a static tarball is extracted, with the sole top directory stripped', async (t) => {
  const site = await fixtureDir(t, { 'index.html': 'home', 'js/app.js': 'x' }, 'dist');
  const { staging, out } = await stage(t, await packDir(t, site, { wrap: true }));
  assert.deepEqual(await listTree(path.join(staging, 'content')), ['index.html', 'js', 'js/app.js']);
  assert.equal(out.files, 2);
});

test('a static tarball with several root entries keeps its layout', async (t) => {
  const site = await fixtureDir(t, { 'index.html': 'home', 'dist/x.txt': 'x' });
  const { staging } = await stage(t, await packDir(t, site));
  assert.deepEqual(await listTree(path.join(staging, 'content')), ['dist', 'dist/x.txt', 'index.html']);
});

test('tar entries with .., an absolute path, a symlink or a hardlink are UNSAFE_ENTRY', async (t) => {
  const outside = await tmp(t);
  for (const entry of [
    { name: '../escape.txt', data: 'x' }, { name: '/tmp/ca-escape.txt', data: 'x' },
    { name: 'ln', type: '2', linkname: outside }, { name: 'hl', type: '1', linkname: 'index.html' },
  ]) {
    const file = await rawTarball(t, [{ name: 'index.html', data: 'x' }, entry]);
    await assert.rejects(stage(t, file, 'static'), refusal('UNSAFE_ENTRY'), entry.name);
  }
});

test('a static source with a root v/<number> directory is RESERVED_PATH; v/<name> is fine', async (t) => {
  const bad = await fixtureDir(t, { 'index.html': 'x', 'v/1/a.txt': 'y' });
  await assert.rejects(stage(t, bad), refusal('RESERVED_PATH'));
  const ok = await fixtureDir(t, { 'index.html': 'x', 'v/foo/a.txt': 'y', 'a/v/1/b.txt': 'z' });
  await stage(t, ok);
  const tgz = await packDir(t, bad);
  await assert.rejects(stage(t, tgz), refusal('RESERVED_PATH'));
});
