// Pins the store: versioning, never-reused numbers, latest = highest remaining, LAST_VERSION, persistence,
// the crash sweep, corrupt-record handling, the mutation mutex, prune, and id generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Store, newId } from '../src/store.js';
import { ID_RE } from '../src/links.js';
import { tmp } from './_helpers.mjs';

const VERSION = { sessionId: null, sessionLabel: null, source: { name: 'a', type: 'file' }, file: 'a', bytes: 1, files: 1 };

async function openStore(t, opts) {
  const root = path.join(await tmp(t), 'store');
  return { root, store: await Store.open(root, opts) };
}
async function staged(store, name = 'x') {
  const dir = await store.newStaging();
  await fsp.mkdir(path.join(dir, 'content'));
  await fsp.writeFile(path.join(dir, 'content', name), name);
  return dir;
}
const create = async (store, title = 'T', extra = {}) =>
  store.create({ title, kind: 'download', project: 'p', version: VERSION, ...extra }, await staged(store));
const add = async (store, id, title) => store.addVersion(id, { title, version: VERSION }, await staged(store));
const exists = (p) => fsp.stat(p).then(() => true, () => false);

test('create makes version 1 and addVersion makes version 2, moving the staged content into v/<n>', async (t) => {
  const { store } = await openStore(t);
  const r1 = await create(store, 'Release notes');
  assert.equal(r1.versions[0].n, 1);
  const r2 = await add(store, r1.id);
  assert.deepEqual(r2.versions.map((v) => v.n), [1, 2]);
  assert.equal(await fsp.readFile(path.join(store.versionDir(r1.id, 2), 'content', 'x'), 'utf8'), 'x');
  assert.deepEqual(await fsp.readdir(path.join(path.dirname(store.versionDir(r1.id, 1)), '..', '..', '..', '.staging')), [], 'staging was consumed');
});

test('a version title defaults to the current title; a given title becomes the artifact title', async (t) => {
  const { store } = await openStore(t);
  const r = await create(store, 'First');
  assert.equal((await add(store, r.id)).title, 'First');
  const r3 = await add(store, r.id, 'Renamed');
  assert.equal(r3.title, 'Renamed');
  assert.equal(r3.versions[2].title, 'Renamed');
  assert.equal(r3.versions[0].title, 'First');
});

test('version numbers are not reused after a delete; latest is the highest remaining', async (t) => {
  const { store } = await openStore(t);
  const r = await create(store);
  await add(store, r.id);
  await add(store, r.id);
  const after = await store.deleteVersion(r.id, 3);
  assert.deepEqual(after.versions.map((v) => v.n), [1, 2]);
  const r4 = await add(store, r.id);
  assert.deepEqual(r4.versions.map((v) => v.n), [1, 2, 4]);
  assert.equal(await exists(store.versionDir(r.id, 3)), false);
});

test('deleting the only remaining version is LAST_VERSION; an unknown artifact or version has its own code', async (t) => {
  const { store } = await openStore(t);
  const r = await create(store);
  await assert.rejects(store.deleteVersion(r.id, 1), { code: 'LAST_VERSION' });
  await assert.rejects(store.deleteVersion(r.id, 9), { code: 'VERSION_UNKNOWN' });
  await assert.rejects(store.deleteVersion('nope-123456', 1), { code: 'ARTIFACT_UNKNOWN' });
  await assert.rejects(store.deleteArtifact('nope-123456'), { code: 'ARTIFACT_UNKNOWN' });
  await assert.rejects(store.addVersion('nope-123456', { version: VERSION }, await staged(store)), { code: 'ARTIFACT_UNKNOWN' });
});

test('deleteArtifact removes the artifact and leaves .trash empty', async (t) => {
  const { store, root } = await openStore(t);
  const r = await create(store);
  await store.deleteArtifact(r.id);
  assert.equal(await store.get(r.id), null);
  assert.deepEqual(await fsp.readdir(path.join(root, '.trash')), []);
  assert.deepEqual(await fsp.readdir(path.join(root, 'artifacts')), []);
});

test('state survives re-opening the store', async (t) => {
  const { store, root } = await openStore(t);
  const r = await create(store, 'Persist');
  await add(store, r.id);
  const again = await Store.open(root);
  const got = await again.get(r.id);
  assert.equal(got.title, 'Persist');
  assert.deepEqual(got.versions.map((v) => v.n), [1, 2]);
  assert.equal(got.nextVersion, 3);
});

test('open sweeps staging, trash, an unlisted v/<n> and an artifact dir with no artifact.json', async (t) => {
  const { store, root } = await openStore(t);
  const r = await create(store);
  await fsp.mkdir(path.join(root, '.staging/leftover'));
  await fsp.mkdir(path.join(root, '.trash/leftover'));
  await fsp.mkdir(path.join(root, 'artifacts', r.id, 'v/7'), { recursive: true });
  await fsp.mkdir(path.join(root, 'artifacts/half-made-abc123/v/1'), { recursive: true });
  await Store.open(root);
  assert.deepEqual(await fsp.readdir(path.join(root, '.staging')), []);
  assert.deepEqual(await fsp.readdir(path.join(root, '.trash')), []);
  assert.deepEqual(await fsp.readdir(path.join(root, 'artifacts', r.id, 'v')), ['1']);
  assert.deepEqual(await fsp.readdir(path.join(root, 'artifacts')), [r.id]);
});

test('a corrupt artifact.json is logged and skipped, never deleted', async (t) => {
  const { store, root } = await openStore(t);
  const good = await create(store, 'Good');
  const bad = await create(store, 'Bad');
  const file = path.join(root, 'artifacts', bad.id, 'artifact.json');
  await fsp.writeFile(file, '{ not json');
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  const reopened = await Store.open(root);
  assert.deepEqual((await reopened.list()).map((r) => r.id), [good.id]);
  assert.equal(await fsp.readFile(file, 'utf8'), '{ not json');
  assert.ok(await exists(path.join(root, 'artifacts', bad.id, 'v/1')), 'its content stays too');
  assert.ok(errors.some((e) => e.includes(bad.id)));
});

test('concurrent addVersion calls get distinct consecutive numbers', async (t) => {
  const { store } = await openStore(t);
  const r = await create(store);
  const results = await Promise.all(Array.from({ length: 8 }, async () => add(store, r.id)));
  assert.equal(results.length, 8);
  const got = await store.get(r.id);
  assert.deepEqual(got.versions.map((v) => v.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const v of got.versions) assert.ok(await exists(store.versionDir(r.id, v.n)));
});

test('a failing mutation does not wedge the mutex', async (t) => {
  const { store } = await openStore(t);
  const r = await create(store);
  await assert.rejects(store.deleteVersion(r.id, 1));
  assert.equal((await add(store, r.id)).versions.length, 2);
});

test('list filters by project and kind, newest latest-version first', async (t) => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const { store } = await openStore(t, { now: () => new Date((clock += 1000)) });
  const a = await create(store, 'A', { project: 'p1' });
  const b = await create(store, 'B', { project: 'p2', kind: 'markdown' });
  const c = await create(store, 'C', { project: 'p1' });
  assert.deepEqual((await store.list()).map((r) => r.id), [c.id, b.id, a.id]);
  await add(store, a.id);
  assert.deepEqual((await store.list()).map((r) => r.id), [a.id, c.id, b.id], 'a new version moves the artifact up');
  assert.deepEqual((await store.list({ project: 'p1' })).map((r) => r.id), [a.id, c.id]);
  assert.deepEqual((await store.list({ kind: 'markdown' })).map((r) => r.id), [b.id]);
});

test('prune deletes versions older than N days, never the latest, honours project scope and dryRun', async (t) => {
  const day = 86_400_000;
  let now = Date.parse('2026-06-01T00:00:00Z');
  const { store } = await openStore(t, { now: () => new Date(now) });
  const a = await create(store, 'A', { project: 'p1' });   // day 0
  now += 10 * day; await add(store, a.id);                 // v2 day 10
  now += 10 * day; await add(store, a.id);                 // v3 day 20
  const solo = await create(store, 'Solo', { project: 'p2' }); // day 20, only version
  const old = await create(store, 'Old', { project: 'p1' });   // day 20
  now += 30 * day;                                         // today = day 50
  const dry = await store.prune({ olderThanDays: 15, dryRun: true });
  assert.deepEqual(dry.versions, [{ id: a.id, version: 1 }, { id: a.id, version: 2 }]);
  assert.equal(dry.artifacts, 1);
  assert.equal((await store.get(a.id)).versions.length, 3, 'dryRun deleted nothing');
  assert.deepEqual((await store.prune({ olderThanDays: 15, project: 'p2' })).versions, [], 'scoped to another project');
  const real = await store.prune({ olderThanDays: 15 });
  assert.equal(real.versions.length, 2);
  assert.deepEqual((await store.get(a.id)).versions.map((v) => v.n), [3]);
  assert.ok(await store.get(solo.id) && await store.get(old.id), 'single-version artifacts survive');
  assert.deepEqual((await store.prune({ olderThanDays: 1 })).versions, [], 'latest versions are never pruned');
});

test('ids are a slug of the title plus a base36 suffix and always match ID_RE', () => {
  for (const title of ['Release Notes!', '   ', 'ÄÖÜ', 'x'.repeat(300), '../../etc', 'A--B']) {
    const id = newId(title);
    assert.match(id, ID_RE, title);
    assert.match(id, /-[0-9a-z]{6}$/);
  }
  assert.match(newId('Release Notes!'), /^release-notes-[0-9a-z]{6}$/);
  assert.match(newId('ÄÖÜ'), /^artifact-/);
  assert.ok(newId('x'.repeat(300)).length <= 39);
});

test('get answers null for an id that fails the id format, without touching the disk', async (t) => {
  const { store } = await openStore(t);
  assert.equal(await store.get('../x'), null);
  assert.equal(await store.get('A'), null);
});

const writeRecord = (root, id, mutate) => async () => {
  const file = path.join(root, 'artifacts', id, 'artifact.json');
  const rec = JSON.parse(await fsp.readFile(file, 'utf8'));
  mutate(rec);
  await fsp.writeFile(file, JSON.stringify(rec));
  return file;
};

test('versionDir refuses a version number that is not a positive integer, and an id that is not an id', async (t) => {
  const { store } = await openStore(t);
  for (const n of ['../../x', '1', 0, -1, 1.5, NaN, undefined]) assert.throws(() => store.versionDir('a-b', n), /invalid/, String(n));
  assert.throws(() => store.versionDir('../x', 1), /invalid/);
  assert.match(store.versionDir('a-b', 3), /artifacts\/a-b\/v\/3$/);
});

test('a record whose version number is a path never reaches the disk: it is corrupt, out of get/list/prune, and untouched', async (t) => {
  const { store, root } = await openStore(t);
  const victim = path.join(path.dirname(root), 'victim');
  await fsp.mkdir(victim);
  await fsp.writeFile(path.join(victim, 'keep.txt'), 'keep');
  const r = await create(store);
  await add(store, r.id);
  const file = await writeRecord(root, r.id, (rec) => { rec.versions[0].n = '../../../../victim'; })();
  const before = await fsp.readFile(file, 'utf8');
  t.mock.method(console, 'error', () => {});
  const reopened = await Store.open(root, { now: () => new Date(Date.now() + 400 * 86_400_000) });
  assert.equal(await reopened.get(r.id), null);
  assert.deepEqual(await reopened.list(), []);
  assert.deepEqual(await reopened.prune({ olderThanDays: 1 }), { versions: [], artifacts: 0 });
  assert.equal(await fsp.readFile(path.join(victim, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fsp.readFile(file, 'utf8'), before, 'the record is never deleted or rewritten');
});

test('every malformed record shape is logged, left on disk, and excluded from get and list', async (t) => {
  const { store, root } = await openStore(t);
  const shapes = {
    'no versions': (rec) => { rec.versions = []; },
    'version without publishedAt': (rec) => { delete rec.versions[0].publishedAt; },
    'unparseable publishedAt': (rec) => { rec.versions[0].publishedAt = 'yesterday'; },
    'id does not match its directory': (rec) => { rec.id = 'someone-else'; },
    'id breaks the id format': (rec) => { rec.id = '../x'; },
    'unknown kind': (rec) => { rec.kind = 'weird'; },
    'versions not ascending': (rec) => { rec.versions.push({ ...rec.versions[0], n: 1 }); },
    'nextVersion behind the versions': (rec) => { rec.nextVersion = 1; },
    'not an object': () => 'null',
  };
  const good = await create(store, 'Good');
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  for (const [name, mutate] of Object.entries(shapes)) {
    const rec = await create(store, name.slice(0, 20));
    const file = path.join(root, 'artifacts', rec.id, 'artifact.json');
    if (name === 'not an object') await fsp.writeFile(file, 'null');
    else await writeRecord(root, rec.id, mutate)();
    const before = await fsp.readFile(file, 'utf8');
    assert.equal(await store.get(rec.id), null, name);
    assert.ok((await store.list()).every((r) => r.id === good.id || r.id !== rec.id), name);
    assert.ok(errors.some((e) => e.includes(rec.id)), `${name} was logged`);
    assert.equal(await fsp.readFile(file, 'utf8'), before, `${name} was left in place`);
  }
  assert.deepEqual((await store.list()).map((r) => r.id), [good.id]);
});

test('a non-directory under artifacts/ does not stop the store from opening', async (t) => {
  const { store, root } = await openStore(t);
  const r = await create(store);
  await fsp.writeFile(path.join(root, 'artifacts', '.DS_Store'), 'x');
  const reopened = await Store.open(root);
  assert.deepEqual((await reopened.list()).map((x) => x.id), [r.id]);
  assert.equal(await fsp.readFile(path.join(root, 'artifacts', '.DS_Store'), 'utf8'), 'x');
});

test('a failure moving content into place never leaves a durable record whose content is absent', async (t) => {
  const root = path.join(await tmp(t), 'store');
  let fail = true;
  const store = await Store.open(root, { moveIntoPlace: async (from, to) => { if (fail) throw new Error('disk full'); await fsp.rename(from, to); } });
  await assert.rejects(create(store), /disk full/);
  const reopened = await Store.open(root);
  assert.deepEqual(await reopened.list(), []);
  assert.deepEqual(await fsp.readdir(path.join(root, 'artifacts')), [], 'nothing of the failed create survives');
  fail = false;
  const ok = await create(store);
  fail = true;
  await assert.rejects(add(store, ok.id), /disk full/);
  const again = await Store.open(root);
  const got = await again.get(ok.id);
  assert.deepEqual(got.versions.map((v) => v.n), [1], 'the failed version is not listed');
  assert.equal(got.nextVersion, 2);
  for (const v of got.versions) assert.ok(await exists(again.versionDir(ok.id, v.n)), 'every listed version has its content');
});
