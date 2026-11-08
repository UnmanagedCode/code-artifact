// Pins both views of every MCP tool over a realistic corpus (every kind, multi-version artifacts with a gap, labelled and
// unlabelled sessions): json is the complete data and validates against the manifest outputSchema (the helper checks every
// json reply); text is prose that keeps the identifiers a caller acts on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appSource, runApp, startApps } from './_apps.mjs';
import { fakeCc, fixtureDir, fixtureFile, packDir, startApp } from './_helpers.mjs';

const LABELLED = { sessionId: 'sess-1', project: 'proj-a' };
const UNLABELLED = { project: 'p' };

async function corpus(t, start = startApp) {
  const cc = await fakeCc(t, { projects: ['proj-a', 'p'], instances: [{ sessionId: 'sess-1', displayLabel: 'Fix the parser' }] });
  const app = await start(t, { ccUrl: cc.url });
  const ids = {};
  const pub = async (name, source, title, caller = LABELLED) => {
    const res = await app.mcp('publish_artifact', { path: source, title }, caller);
    assert.ok(res.data.structured, `${name}: ${JSON.stringify(res.data)}`);
    ids[name] = res.data.structured.id;
  };
  const upd = async (name, source) => {
    const res = await app.mcp('update_artifact', { artifact: ids[name], path: source });
    assert.ok(res.data.structured, `${name}: ${JSON.stringify(res.data)}`);
  };
  const site = { 'index.html': '<p>site', 'a.css': 'x' };

  await pub('md', await fixtureFile(t, 'a.md', '# one'), 'Notes');
  for (const n of ['2', '3', '4']) await upd('md', await fixtureFile(t, `n${n}.md`, `# v${n}`));
  assert.ok((await app.mcp('delete_artifact', { artifact: ids.md, version: 2 })).data.structured);

  await pub('html', await fixtureFile(t, 'p.html', '<p>one'), 'Page', UNLABELLED);
  await upd('html', await fixtureFile(t, 'p2.html', '<p>two'));
  await pub('dir', await fixtureDir(t, site), 'Site dir');
  await upd('dir', await fixtureDir(t, { ...site, 'b.css': 'y' }));
  await pub('tgz', await packDir(t, await fixtureDir(t, site)), 'Site tgz');
  await upd('tgz', await packDir(t, await fixtureDir(t, { ...site, 'b.css': 'y' })));
  await pub('file', await fixtureFile(t, 'data.bin', 'bin'), 'Data file');
  await upd('file', await fixtureFile(t, 'data2.bin', 'bin2'));
  await pub('pack', await packDir(t, await fixtureDir(t, { 'a.txt': 'a', 'b/c.txt': 'c' })), 'Packed download');
  await upd('pack', await packDir(t, await fixtureDir(t, { 'a.txt': 'a2' })));
  await pub('app', await appSource(t), 'An app');
  await upd('app', await appSource(t, { version: '2' }));
  return { app, ids };
}

const structured = async (app, tool, args) => {
  const res = await app.mcp(tool, args);
  assert.ok(res.data.structured, JSON.stringify(res.data));
  return res.data.structured;
};
const textOf = async (app, tool, args) => {
  const res = await app.mcp(tool, args, undefined, 'text');
  assert.deepEqual(Object.keys(res.data), ['text']);
  assert.throws(() => JSON.parse(res.data.text), 'text is prose, not JSON');
  return res.data.text;
};

test('list_artifacts json is the complete data: every artifact, every version, equal to REST', async (t) => {
  const { app, ids } = await corpus(t);
  const list = await structured(app, 'list_artifacts', {});
  assert.equal(list.artifacts.length, Object.keys(ids).length);
  const md = list.artifacts.find((a) => a.id === ids.md);
  assert.deepEqual(md.versions.map((v) => v.n), [1, 3, 4]);
  for (const a of list.artifacts) for (const v of a.versions) assert.equal(typeof v.versionLink, 'string');
  assert.deepEqual(list, (await app.get('/api/artifacts')).data);
});

test('list_artifacts filters by project and kind; omitting both returns everything', async (t) => {
  const { app, ids } = await corpus(t);
  const idsOf = async (args) => (await structured(app, 'list_artifacts', args)).artifacts.map((a) => a.id).sort();
  assert.deepEqual(await idsOf({ project: 'p' }), [ids.html]);
  assert.deepEqual(await idsOf({ kind: 'app' }), [ids.app]);
  assert.deepEqual(await idsOf({ kind: 'download' }), [ids.file, ids.pack].sort());
  assert.deepEqual(await idsOf({ project: 'proj-a', kind: 'markdown' }), [ids.md]);
  assert.deepEqual(await idsOf({}), Object.values(ids).sort());
});

test('get_artifact json is the full stored record for every kind, equal to REST', async (t) => {
  const { app, ids } = await corpus(t);
  for (const [name, id] of Object.entries(ids)) {
    const got = await structured(app, 'get_artifact', { artifact: id });
    assert.deepEqual(got, (await app.get(`/api/artifacts/${id}`)).data, name);
    assert.equal(got.versions.length, name === 'md' ? 3 : 2, name);
  }
  const record = await structured(app, 'get_artifact', { artifact: ids.app });
  assert.equal(record.app.status, 'stopped');
});

test('a running app reports its live state through get_artifact', async (t) => {
  const { app, ids } = await corpus(t, startApps);
  await runApp(app, ids.app);
  const record = await structured(app, 'get_artifact', { artifact: ids.app });
  assert.equal(record.app.status, 'running');
  assert.ok(Number.isInteger(record.app.version));
  const listed = (await structured(app, 'list_artifacts', { kind: 'app' })).artifacts[0];
  assert.equal(listed.app.status, 'running');
});

test('publish and update json acks validate for every kind; the app ack carries its status', async (t) => {
  const { app } = await corpus(t);
  const checks = [
    ['m', await fixtureFile(t, 'm.md', '# m')], ['h', await fixtureFile(t, 'h.html', '<p>h')],
    ['d', await fixtureFile(t, 'd.bin', 'd')], ['a', await appSource(t)],
  ];
  for (const [title, source] of checks) {
    const pub = await structured(app, 'publish_artifact', { path: source, title });
    assert.equal(pub.version, 1);
    assert.equal(pub.app?.status, title === 'a' ? 'stopped' : undefined);
    const upd = await structured(app, 'update_artifact', { artifact: pub.id, path: title === 'a' ? await appSource(t, { version: '2' }) : source });
    assert.equal(upd.version, 2);
  }
});

test('delete_artifact json answers each branch of its schema', async (t) => {
  const { app, ids } = await corpus(t);
  assert.deepEqual(await structured(app, 'delete_artifact', { artifact: ids.md, version: 3 }), { deleted: 'version', id: ids.md, version: 3, latest: 4 });
  assert.deepEqual(await structured(app, 'delete_artifact', { artifact: ids.md }), { deleted: 'artifact', id: ids.md });
});

test('publish and update text keep the identifiers a caller acts on', async (t) => {
  const { app, ids } = await corpus(t);
  const text = await textOf(app, 'publish_artifact', { path: await fixtureDir(t, { 'index.html': '<p>xxxxx', 'a.css': 'yyy' }), title: 'Y' });
  // The version, file count and byte count all differ here, so the version needle can only come from the version field.
  const published = (await structured(app, 'list_artifacts', { project: 'proj-a', kind: 'static' })).artifacts.find((a) => a.title === 'Y');
  for (const needle of [published.id, published.link, published.versions[0].versionLink, 'sess-1', `(version ${published.versions[0].n})`]) assert.ok(text.includes(needle), needle);
  const up = await textOf(app, 'update_artifact', { artifact: ids.md, path: await fixtureFile(t, 'z.md', '# z') });
  const after = await structured(app, 'get_artifact', { artifact: ids.md });
  const latest = after.versions.at(-1);
  for (const needle of [ids.md, `Published version ${latest.n} of artifact ${ids.md}`, latest.versionLink, after.link]) assert.ok(up.includes(needle), needle);
  const appUp = await textOf(app, 'update_artifact', { artifact: ids.app, path: await appSource(t, { version: '3' }) });
  assert.match(appUp, /app\.status: stopped/);
});

test('list_artifacts text names every artifact with its link and latest version, and says it summarises', async (t) => {
  const { app, ids } = await corpus(t);
  const text = await textOf(app, 'list_artifacts', {});
  const all = (await structured(app, 'list_artifacts', {})).artifacts;
  for (const a of all) {
    assert.ok(text.includes(a.id), a.id);
    assert.ok(text.includes(a.link), a.id);
    assert.ok(text.includes(`latest v${a.versions.at(-1).n}`), a.id);
  }
  for (const a of all) {
    assert.equal(text.split('\n').filter((l) => l.startsWith(`${a.id}  "`)).length, 1, `exactly one row for ${a.id}`);
  }
  assert.match(text.split('\n')[0], new RegExp(`^${all.length} artifacts?, newest first`), 'one header leads the rows');
  const appRow = text.split('\n').find((l) => l.startsWith(`${ids.app}  "`));
  assert.match(appRow, /app\.status stopped/, 'an app row reports its live status');
  assert.match(text, /get_artifact/, 'the cut is announced along with how to get the rest');
  const md = all.find((a) => a.id === ids.md);
  assert.ok(!text.includes(md.versions[0].versionLink), 'an older version is left to get_artifact');
});

test('a count of one renders singular: one artifact, one version', async (t) => {
  const app = await startApp(t);
  const pub = await structured(app, 'publish_artifact', { path: await fixtureFile(t, 'one.md', '# one'), title: 'One' });
  const text = await textOf(app, 'list_artifacts', {});
  assert.match(text.split('\n')[0], /^1 artifact, newest first/);
  const row = text.split('\n').find((l) => l.startsWith(`${pub.id}  "`));
  assert.match(row, /\(1 version\)/);
  assert.match(await textOf(app, 'get_artifact', { artifact: pub.id }), /^1 version, oldest first:$/m);
});

test('list_artifacts text answers an empty store and an empty filter', async (t) => {
  const app = await startApp(t);
  assert.match(await textOf(app, 'list_artifacts', {}), /No artifacts/);
  assert.match(await textOf(app, 'list_artifacts', { project: 'nope' }), /No artifacts.*nope/);
});

test('get_artifact text lists every version with its link, and the live state of an app', async (t) => {
  const { app, ids } = await corpus(t);
  const record = await structured(app, 'get_artifact', { artifact: ids.md });
  const text = await textOf(app, 'get_artifact', { artifact: ids.md });
  for (const v of record.versions) assert.ok(text.includes(v.versionLink), `v${v.n}`);
  assert.ok(text.includes(ids.md));
  assert.ok(text.includes('Fix the parser'), 'the session label is used when there is one');
  const download = await structured(app, 'get_artifact', { artifact: ids.file });
  const dlText = (await textOf(app, 'get_artifact', { artifact: ids.file })).split('\n');
  for (const v of download.versions) {
    assert.ok(v.file, 'a download version stores a file');
    const line = dlText.find((l) => l.startsWith(`v${v.n}  `));
    assert.ok(line.includes(`file ${v.file}`), `v${v.n} line names its stored file`);
  }
  assert.match(await textOf(app, 'get_artifact', { artifact: ids.app }), /app\.status: stopped/);
  assert.match(await textOf(app, 'get_artifact', { artifact: ids.html }), /unknown session/);
});

test('delete_artifact text names the artifact and the version', async (t) => {
  const { app, ids } = await corpus(t);
  const version = await textOf(app, 'delete_artifact', { artifact: ids.md, version: 4 });
  assert.ok(version.includes(ids.md));
  assert.match(version, /Deleted version 4 of artifact /);
  assert.match(version, /latest version is now 3\b/);
  const whole = await textOf(app, 'delete_artifact', { artifact: ids.md });
  assert.ok(whole.includes(ids.md));
});
