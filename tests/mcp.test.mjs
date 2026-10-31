// Pins the MCP wire contract: 200 for every well-formed call with {result} or {error:"CODE: msg"}, 400 only for a malformed envelope,
// and a full publish → update → get → delete round trip over HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureFile, startApp } from './_helpers.mjs';

test('a successful call is 200 {result}', async (t) => {
  const app = await startApp(t);
  const res = await app.mcp('list_artifacts', {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { result: { artifacts: [] } });
});

test('a refusal is 200 {error} whose message starts with "CODE: "', async (t) => {
  const app = await startApp(t);
  const cases = [
    ['publish_artifact', { path: 'relative', title: 'x' }, 'PATH_NOT_ABSOLUTE'],
    ['publish_artifact', { path: '/nonexistent/zzz', title: 'x' }, 'PATH_NOT_FOUND'],
    ['get_artifact', { artifact: 'nope-abc123' }, 'ARTIFACT_UNKNOWN'],
    ['delete_artifact', { artifact: 'nope-abc123' }, 'ARTIFACT_UNKNOWN'],
    ['update_artifact', { artifact: 'nope-abc123', path: '/x' }, 'ARTIFACT_UNKNOWN'],
  ];
  for (const [tool, args, code] of cases) {
    const res = await app.mcp(tool, args);
    assert.equal(res.status, 200, tool);
    assert.match(res.data.error, new RegExp(`^${code}: `), tool);
    assert.equal(res.data.result, undefined);
  }
});

test('an unknown tool is 200 {error}, including an inherited property name', async (t) => {
  const app = await startApp(t);
  for (const tool of ['nope', 'constructor', 'toString']) {
    const res = await app.mcp(tool, {});
    assert.equal(res.status, 200);
    assert.match(res.data.error, /unknown tool/);
  }
});

test('a malformed envelope is 400', async (t) => {
  const app = await startApp(t);
  for (const body of [{}, { tool: 5 }, [], 'x', null]) {
    const res = await app.raw('POST', '/api/mcp', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('missing arguments and caller default to empty', async (t) => {
  const app = await startApp(t);
  const res = await app.raw('POST', '/api/mcp', { tool: 'list_artifacts' });
  assert.deepEqual(res.data, { result: { artifacts: [] } });
});

test('with no store configured every call is 200 {error: "STORE_UNCONFIGURED: …"}', async (t) => {
  const app = await startApp(t, { unconfigured: true });
  const res = await app.mcp('list_artifacts', {});
  assert.equal(res.status, 200);
  assert.match(res.data.error, /^STORE_UNCONFIGURED: /);
});

test('list_artifacts returns the summary shape, newest first', async (t) => {
  const app = await startApp(t);
  await app.mcp('publish_artifact', { path: await fixtureFile(t, 'a.md', '1'), title: 'First' });
  const second = (await app.mcp('publish_artifact', { path: await fixtureFile(t, 'b.md', '2'), title: 'Second', project: 'other' })).data.result;
  const { artifacts } = (await app.mcp('list_artifacts', {})).data.result;
  assert.equal(artifacts[0].id, second.id);
  assert.deepEqual(Object.keys(artifacts[0]).sort(), ['id', 'kind', 'latest', 'link', 'project', 'title', 'versions']);
  assert.deepEqual(Object.keys(artifacts[0].latest).sort(), ['publishedAt', 'sessionId', 'sessionLabel', 'version']);
  assert.equal(artifacts[0].versions, 1);
  assert.deepEqual((await app.mcp('list_artifacts', { project: 'other' })).data.result.artifacts.map((a) => a.id), [second.id]);
});

test('publish → update → get → delete version → delete artifact round trip', async (t) => {
  const app = await startApp(t);
  const pub = (await app.mcp('publish_artifact', { path: await fixtureFile(t, 'a.md', '# one'), title: 'Doc' })).data.result;
  assert.equal(pub.version, 1);
  assert.equal(pub.project, 'proj-a');
  const upd = (await app.mcp('update_artifact', { artifact: pub.id, path: await fixtureFile(t, 'b.md', '# two') })).data.result;
  assert.equal(upd.version, 2);
  const got = (await app.mcp('get_artifact', { artifact: pub.id })).data.result;
  assert.deepEqual(got.versions.map((v) => v.n), [1, 2]);
  assert.equal(got.versions[1].versionLink, `http://cc.internal/#plugin/code-artifact/a/${pub.id}/v/2/`);
  const page = await app.get(`/a/${pub.id}/`);
  assert.match(page.text, /two/);
  assert.deepEqual((await app.mcp('delete_artifact', { artifact: pub.id, version: 2 })).data.result, { deleted: 'version', id: pub.id, version: 2, latest: 1 });
  assert.deepEqual((await app.mcp('delete_artifact', { artifact: pub.id })).data.result, { deleted: 'artifact', id: pub.id });
  assert.equal((await app.get(`/a/${pub.id}/`)).status, 404);
});
