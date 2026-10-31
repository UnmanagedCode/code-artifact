// Pins what publishing an app does and does not do: the record, the status every surface reports, no process spawned,
// the download being the published tree, and the store refusing an app version without a manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { startApp } from './_helpers.mjs';
import { appSource, markerPids, publishApp, runApp, startApps } from './_apps.mjs';

test('a published app is kind app with its manifest stored and status stopped on every surface', async (t) => {
  const app = await startApp(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'true', prefix: 'keep' } });
  assert.equal(pub.kind, 'app');
  assert.deepEqual(pub.app, { status: 'stopped' });

  const rest = (await app.get(`/api/artifacts/${pub.id}`)).data;
  assert.equal(rest.app.status, 'stopped');
  assert.equal(rest.app.version, null);
  assert.deepEqual(rest.versions[0].app, { start: 'node server.js', install: 'true', prefix: 'keep' });
  assert.equal((await app.get('/api/artifacts')).data.artifacts[0].app.status, 'stopped');

  const got = (await app.mcp('get_artifact', { artifact: pub.id })).data.result;
  assert.equal(got.app.status, 'stopped');
  const listed = (await app.mcp('list_artifacts', {})).data.result.artifacts[0];
  assert.equal(listed.app.status, 'stopped');
});

test('a non-app artifact carries no app status', async (t) => {
  const app = await startApp(t);
  const pub = (await app.mcp('publish_artifact', { path: await appSource(t, { files: { 'index.html': 'x' } }), title: 's', kind: 'static' })).data.result;
  assert.equal(pub.app, undefined);
  assert.equal((await app.get(`/api/artifacts/${pub.id}`)).data.app, undefined);
});

test('publishing spawns nothing: no process, no log, no working copy', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'touch installed-at-publish' } });
  assert.deepEqual(await markerPids(app.storeDir), []);
  const dir = path.join(app.storeDir, 'artifacts', pub.id);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['artifact.json', 'v']);
  assert.deepEqual(await fsp.readdir(path.join(dir, 'v', '1')), ['content']);
});

async function entriesOf(buffer) {
  const names = [];
  const parser = new tar.Parser({ onReadEntry: (e) => { names.push(e.path.replace(/^\.\//, '')); e.resume(); } });
  await new Promise((resolve, reject) => { parser.on('end', resolve); parser.on('error', reject); parser.end(buffer); });
  return names.filter((n) => n && n !== '.');
}

test('dl/ is the published tree, without what a run added to the working copy', async (t) => {
  const app = await startApps(t);
  const pub = await publishApp(t, app, { manifest: { start: 'node server.js', install: 'echo built > built.txt' } });
  const before = await entriesOf(Buffer.from(await (await fetch(`${app.base}/dl/${pub.id}/1`)).arrayBuffer()));
  assert.ok(before.includes('artifact.json') && before.includes('server.js'));

  await runApp(app, pub.id);
  await fetch(`${app.base}/app/${pub.id}/write-cwd`);
  const run = path.join(app.storeDir, 'artifacts', pub.id, 'v', '1', 'run');
  assert.ok((await fsp.readdir(run)).includes('built.txt'), 'the install ran in the working copy');
  assert.ok((await fsp.readdir(run)).includes('written-by-app.txt'));

  const res = await fetch(`${app.base}/dl/${pub.id}/1`);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${pub.id}-v1.tar.gz"`);
  const after = await entriesOf(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual([...after].sort(), [...before].sort());
  const content = path.join(app.storeDir, 'artifacts', pub.id, 'v', '1', 'content');
  assert.deepEqual((await fsp.readdir(content)).sort(), ['VERSION', 'artifact.json', 'fixture.json', 'server.js']);
});

test('the store treats an app version without a valid manifest as corrupt', async (t) => {
  const app = await startApp(t);
  const pub = await publishApp(t, app);
  const file = path.join(app.storeDir, 'artifacts', pub.id, 'artifact.json');
  const original = JSON.parse(await fsp.readFile(file, 'utf8'));
  const variants = [
    (r) => { delete r.versions[0].app; },
    (r) => { r.versions[0].app = { start: 'x', prefix: 'both' }; },
    (r) => { r.versions[0].app = { start: 5, prefix: 'strip' }; },
    (r) => { r.versions[0].app = { start: 'x', prefix: 'strip', install: 5 }; },
  ];
  for (const mutate of variants) {
    const record = structuredClone(original);
    mutate(record);
    await fsp.writeFile(file, JSON.stringify(record));
    assert.equal((await app.get(`/api/artifacts/${pub.id}`)).status, 404);
  }
  await fsp.writeFile(file, JSON.stringify(original));
  assert.equal((await app.get(`/api/artifacts/${pub.id}`)).status, 200);
});
