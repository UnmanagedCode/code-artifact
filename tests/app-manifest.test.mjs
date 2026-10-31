// Pins artifact.json: the schema parseAppManifest enforces, and how a source with (or without) one is classified and refused at publish.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseAppManifest } from '../src/appManifest.js';
import { fixtureDir, packDir, publish, startApp } from './_helpers.mjs';
import { appSource } from './_apps.mjs';

const refused = (input) => assert.throws(() => parseAppManifest(input), (e) => e.code === 'APP_MANIFEST_INVALID');

test('a valid manifest parses and prefix defaults to strip', () => {
  assert.deepEqual(parseAppManifest('{"start":"node server.js"}'), { start: 'node server.js', prefix: 'strip' });
  assert.deepEqual(
    parseAppManifest(Buffer.from('{"start":"s","install":"npm ci","prefix":"keep"}')),
    { start: 's', install: 'npm ci', prefix: 'keep' },
  );
});

test('every invalid shape is APP_MANIFEST_INVALID', () => {
  for (const bad of [
    'not json', '[]', 'null', '"x"', '{}', '{"start":""}', '{"start":"   "}', '{"start":5}', `{"start":"${'a'.repeat(4097)}"}`,
    '{"start":"s","install":5}', '{"start":"s","install":""}', '{"start":"s","prefix":"both"}', '{"start":"s","prefix":1}',
    '{"start":"s","instal":"npm ci"}',
  ]) refused(bad);
});

test('an oversized or non-UTF-8 manifest is refused', () => {
  refused(`{"start":"s"}${' '.repeat(16 * 1024)}`);
  refused(Buffer.from([0x7b, 0xff, 0x7d]));
});

test('a dir or a tarball (even under a sole top dir) with a root artifact.json is an app; the manifest is kept on the version', async (t) => {
  const app = await startApp(t);
  const dir = await appSource(t, { manifest: { start: 'node server.js', prefix: 'keep' } });
  const a = await publish(app, { path: dir, title: 'dir' });
  assert.equal(a.kind, 'app');
  const b = await publish(app, { path: await packDir(t, dir, { wrap: true }), title: 'tgz' });
  assert.equal(b.kind, 'app');
  const record = (await app.get(`/api/artifacts/${a.id}`)).data;
  assert.deepEqual(record.versions[0].app, { start: 'node server.js', prefix: 'keep' });
});

test('explicit app without a root artifact.json is KIND_SOURCE_MISMATCH', async (t) => {
  const app = await startApp(t);
  const dir = await fixtureDir(t, { 'index.html': 'x' });
  const res = await app.mcp('publish_artifact', { path: dir, title: 'x', kind: 'app' });
  assert.match(res.data.error, /^KIND_SOURCE_MISMATCH: /);
});

test('explicit static on an app dir with index.html still publishes a static site', async (t) => {
  const app = await startApp(t);
  const dir = await appSource(t, { files: { 'index.html': '<p>hi' } });
  const res = await publish(app, { path: dir, title: 'site', kind: 'static' });
  assert.equal(res.kind, 'static');
  assert.equal(res.app, undefined);
});

test('a refused manifest leaves no artifact and no staging dir', async (t) => {
  const app = await startApp(t);
  for (const manifest of ['{"start":""}', 'nope', '{"start":"s","typo":1}']) {
    const dir = await appSource(t, { manifest });
    const res = await app.mcp('publish_artifact', { path: dir, title: 'x' });
    assert.match(res.data.error, /^APP_MANIFEST_INVALID: /, manifest);
  }
  assert.deepEqual((await app.get('/api/artifacts')).data.artifacts, []);
  assert.deepEqual(await fsp.readdir(path.join(app.storeDir, '.staging')), []);
  assert.deepEqual(await fsp.readdir(path.join(app.storeDir, 'artifacts')), []);
});

test('a manifest that is a directory, not a file, does not make an app', async (t) => {
  const app = await startApp(t);
  const dir = await fixtureDir(t, { 'artifact.json/inner.txt': 'x' });
  assert.equal((await publish(app, { path: dir, title: 'x' })).kind, 'download');
});
