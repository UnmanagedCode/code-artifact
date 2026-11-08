// Pins the MCP wire contract: format selection (absent = text, bad value = 400), {structured} / {text} replies, refusals as
// {error, code, details?} in every format for every reachable code, and a full publish → update → get → delete round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CODES } from '../src/refusal.js';
import { LIMITS } from '../src/limits.js';
import { handle } from '../src/mcp.js';
import { deadUrl, fakeCc, fixtureDir, fixtureFile, publish, startApp } from './_helpers.mjs';


test('a call with no format is answered as text for every tool', async (t) => {
  const app = await startApp(t);
  const md = await fixtureFile(t, 'a.md', '# one');
  const pub = await publish(app, { path: md, title: 'Doc' });
  const calls = {
    publish_artifact: { path: await fixtureFile(t, 'b.md', '# b'), title: 'B' },
    update_artifact: { artifact: pub.id, path: await fixtureFile(t, 'c.md', '# c') },
    list_artifacts: {},
    get_artifact: { artifact: pub.id },
    delete_artifact: { artifact: pub.id, version: 2 },
  };
  for (const [tool, args] of Object.entries(calls)) {
    const res = await app.mcp(tool, args, undefined, null);
    assert.equal(res.status, 200, tool);
    assert.deepEqual(Object.keys(res.data), ['text'], tool);
    assert.equal(typeof res.data.text, 'string', tool);
  }
});

test('format "text" answers {text} and format "json" answers {structured}', async (t) => {
  const app = await startApp(t);
  const text = await app.mcp('list_artifacts', {}, undefined, 'text');
  assert.deepEqual(Object.keys(text.data), ['text']);
  const json = await app.mcp('list_artifacts', {}, undefined, 'json');
  assert.deepEqual(json.data, { structured: { artifacts: [] } });
});

test('an unknown format is a 400 envelope fault', async (t) => {
  const app = await startApp(t);
  for (const format of ['xml', 5, null, '']) {
    const res = await app.raw('POST', '/api/mcp', { tool: 'list_artifacts', arguments: {}, caller: {}, format });
    assert.equal(res.status, 400, JSON.stringify(format));
    assert.match(res.data.error, /format must be/);
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
  const res = await app.raw('POST', '/api/mcp', { tool: 'list_artifacts', format: 'json' });
  assert.deepEqual(res.data, { structured: { artifacts: [] } });
});

test('an unknown tool, including an inherited property name, is TOOL_UNKNOWN in every format', async (t) => {
  const app = await startApp(t);
  for (const tool of ['nope', 'constructor', 'toString']) {
    for (const format of ['json', 'text', null]) {
      const res = await app.mcp(tool, {}, undefined, format);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { error: `unknown tool ${tool}`, code: 'TOOL_UNKNOWN' }, `${tool} ${format}`);
    }
  }
});

test('an unexpected failure is INTERNAL and never echoes its message, in json and in a text view', async () => {
  const boom = () => { throw new Error('secret /path'); };
  const tools = { run_throws: { run: boom, text: () => 'x' }, text_throws: { run: () => ({}), text: boom } };
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const [tool, format] of [['run_throws', 'json'], ['run_throws', 'text'], ['text_throws', 'text']]) {
      const res = await handle(tools, { tool, arguments: {}, caller: {}, format });
      assert.deepEqual(res, { status: 200, body: { error: 'internal error', code: 'INTERNAL' } }, `${tool} ${format}`);
    }
  } finally {
    console.error = quiet;
  }
});

// Each case builds its fixtures once; `run(t, fx)` starts what it needs and returns {app, tool, args}. The same case runs in
// json, text and no-format, and the refusal must be identical in all three.
const refuse = (code, make, extra = {}) => ({ code, make, ...extra });
const fresh = (opts) => async (t, tool, args) => ({ app: await startApp(t, opts), tool, args });
const publishThen = (opts, build) => async (t, fx) => {
  const app = await startApp(t, opts?.(fx));
  const pub = await publish(app, { path: fx.md, title: 'Doc' });
  return build(app, pub, fx);
};

const CASES = [
  refuse('INVALID_ARGUMENT', async () => ({}), { run: (t) => fresh()(t, 'list_artifacts', { bogus: 1 }) }),
  refuse('PATH_NOT_ABSOLUTE', async () => ({}), { run: (t) => fresh()(t, 'publish_artifact', { path: 'relative', title: 'x' }) }),
  refuse('PATH_NOT_FOUND', async () => ({}), { run: (t) => fresh()(t, 'publish_artifact', { path: '/nonexistent/zzz', title: 'x' }) }),
  refuse('UNSUPPORTED_SOURCE', async () => ({}), { run: (t) => fresh()(t, 'publish_artifact', { path: '/dev/null', title: 'x' }) }),
  refuse('UNSAFE_ENTRY', async (t) => {
    const dir = await fixtureDir(t, { 'index.html': 'x', 'real/': '' });
    await fsp.symlink('real', path.join(dir, 'link'));
    return { dir };
  }, { run: (t, fx) => fresh()(t, 'publish_artifact', { path: fx.dir, title: 'x' }) }),
  refuse('BAD_ARCHIVE', async (t) => ({ tgz: await fixtureFile(t, 'a.tgz', 'not a tarball') }),
    { run: (t, fx) => fresh()(t, 'publish_artifact', { path: fx.tgz, title: 'x' }) }),
  refuse('TOO_LARGE', async (t) => ({ md: await fixtureFile(t, 'big.md', '0123456789') }),
    { run: (t, fx) => fresh({ limits: { ...LIMITS, maxMarkdownBytes: 4 } })(t, 'publish_artifact', { path: fx.md, title: 'x' }) }),
  refuse('KIND_SOURCE_MISMATCH', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x') }),
    { run: (t, fx) => fresh()(t, 'publish_artifact', { path: fx.md, title: 'x', kind: 'app' }) }),
  refuse('KIND_CHANGE', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x'), html: await fixtureFile(t, 'b.html', '<p>x') }), {
    run: publishThen(null, (app, pub, fx) => ({ app, tool: 'update_artifact', args: { artifact: pub.id, path: fx.html } })),
    details: { sourceKind: 'static', artifactKind: 'markdown' },
  }),
  refuse('RESERVED_PATH', async (t) => ({ dir: await fixtureDir(t, { 'index.html': 'x', 'v/1/x': 'y' }) }),
    { run: (t, fx) => fresh()(t, 'publish_artifact', { path: fx.dir, title: 'x' }) }),
  refuse('APP_MANIFEST_INVALID', async (t) => ({ dir: await fixtureDir(t, { 'artifact.json': '{' }) }),
    { run: (t, fx) => fresh()(t, 'publish_artifact', { path: fx.dir, title: 'x' }) }),
  refuse('PROJECT_REQUIRED', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x') }),
    { run: (t, fx) => fresh()(t, 'publish_artifact', { path: fx.md, title: 'x' }), caller: { project: '.conduct' } }),
  refuse('PROJECT_UNKNOWN', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x'), cc: (await fakeCc(t, { projects: [] })).url }),
    { run: (t, fx) => fresh({ ccUrl: fx.cc })(t, 'publish_artifact', { path: fx.md, title: 'x', project: 'nope' }) }),
  refuse('PROJECT_FIXED', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x') }), {
    run: publishThen(null, (app, pub, fx) => ({ app, tool: 'update_artifact', args: { artifact: pub.id, path: fx.md, project: 'other' } })),
  }),
  refuse('ARTIFACT_UNKNOWN', async () => ({}), { run: (t) => fresh()(t, 'get_artifact', { artifact: 'nope-abc123' }) }),
  refuse('VERSION_UNKNOWN', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x') }), {
    run: publishThen(null, (app, pub) => ({ app, tool: 'delete_artifact', args: { artifact: pub.id, version: 9 } })),
  }),
  refuse('LAST_VERSION', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x') }), {
    run: publishThen(null, (app, pub) => ({ app, tool: 'delete_artifact', args: { artifact: pub.id, version: 1 } })),
  }),
  refuse('CC_UNREACHABLE', async (t) => ({ md: await fixtureFile(t, 'a.md', '# x'), cc: await deadUrl() }),
    { run: (t, fx) => fresh({ ccUrl: fx.cc })(t, 'publish_artifact', { path: fx.md, title: 'x', project: 'p' }) }),
  refuse('STORE_UNCONFIGURED', async () => ({}), { run: (t) => fresh({ unconfigured: true })(t, 'list_artifacts', {}) }),
  refuse('TOOL_UNKNOWN', async () => ({}), { run: (t) => fresh()(t, 'no_such_tool', {}) }),
];

// A refusal reached only over REST has no MCP shape to pin.
const REST_ONLY = ['NOT_AN_APP', 'UNSUPPORTED_MEDIA_TYPE'];

for (const c of CASES) {
  test(`${c.code} is {error, code} with the same message in json, text and no-format`, async (t) => {
    const fx = await c.make(t);
    const bodies = [];
    for (const format of ['json', 'text', null]) {
      const { app, tool, args } = await c.run(t, fx);
      const res = await app.mcp(tool, args, c.caller ?? undefined, format);
      assert.equal(res.status, 200);
      bodies.push(res.data);
    }
    // The artifact id is random per app, so it is masked; every other character of the message must match.
    const [json, text, none] = bodies.map((b) => ({ ...b, error: b.error.replace(/\bdoc-[a-z0-9]{6}\b/g, '<id>') }));
    assert.equal(json.code, c.code);
    assert.doesNotMatch(json.error, /^[A-Z_]+: /);
    assert.deepEqual(json, { error: json.error, code: c.code, ...(c.details ? { details: c.details } : {}) });
    assert.deepEqual(text, json);
    assert.deepEqual(none, json);
  });
}

test('every refusal code an MCP call can reach has a wire-shape case above', () => {
  const covered = new Set([...CASES.map((c) => c.code), 'INTERNAL']);
  const reachable = Object.keys(CODES).filter((c) => !REST_ONLY.includes(c));
  assert.deepEqual([...covered].sort(), reachable.sort());
});

test('publish → update → get → delete version → delete artifact round trip', async (t) => {
  const app = await startApp(t);
  const pub = (await app.mcp('publish_artifact', { path: await fixtureFile(t, 'a.md', '# one'), title: 'Doc' })).data.structured;
  assert.equal(pub.version, 1);
  assert.equal(pub.project, 'proj-a');
  const upd = (await app.mcp('update_artifact', { artifact: pub.id, path: await fixtureFile(t, 'b.md', '# two') })).data.structured;
  assert.equal(upd.version, 2);
  const got = (await app.mcp('get_artifact', { artifact: pub.id })).data.structured;
  assert.deepEqual(got.versions.map((v) => v.n), [1, 2]);
  assert.equal(got.versions[1].versionLink, `http://cc.internal/#plugin/code-artifact/a/${pub.id}/v/2/`);
  const page = await app.get(`/a/${pub.id}/`);
  assert.match(page.text, /two/);
  assert.deepEqual((await app.mcp('delete_artifact', { artifact: pub.id, version: 2 })).data.structured, { deleted: 'version', id: pub.id, version: 2, latest: 1 });
  assert.deepEqual((await app.mcp('delete_artifact', { artifact: pub.id })).data.structured, { deleted: 'artifact', id: pub.id });
  assert.equal((await app.get(`/a/${pub.id}/`)).status, 404);
});
