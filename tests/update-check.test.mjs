// Pins the update notice on a latest-URL page: assets/update-check.js runs against fakes (timers, fetch, a minimal DOM),
// then the server side: which pages carry the hooks, and the endpoint contract the script relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';
import { fixtureDir, fixtureFile, publish, startApp } from './_helpers.mjs';
import { publishApp, startApps } from './_apps.mjs';

const src = await fsp.readFile(new URL('../assets/update-check.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** A hand-driven setTimeout: `fire()` runs every pending callback. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn) => { pending.set(next, fn); return next++; },
    clearTimeout: (id) => { pending.delete(id); },
    get count() { return pending.size; },
    fire() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
  };
}

/** A minimal element: children, text, attributes and click listeners. */
function fakeEl(tag) {
  const el = {
    tag, children: [], attrs: {}, listeners: {}, _text: '',
    get firstChild() { return el.children[0] ?? null; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children.splice(el.children.indexOf(c), 1); return c; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    click() { (el.listeners.click ?? []).forEach((fn) => fn({ preventDefault() {} })); },
    set textContent(v) { el._text = String(v); el.children = []; },
    get textContent() { return el._text + el.children.map((c) => c.textContent).join(''); },
    buttons() { return [...(el.tag === 'button' ? [el] : []), ...el.children.flatMap((c) => c.buttons())]; },
  };
  return el;
}

const resp = (status, body) => ({ status, ok: status < 400, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });
const record = (...ns) => ({ id: 'demo-abc123', versions: ns.map((n) => ({ n })) });

/** Runs update-check.js on a page showing `shown` (null: no update attributes, as on a pinned page). `answers` queues fetch outcomes. */
function load({ shown = 1, answers = [], hidden = false, container = true } = {}) {
  const timers = fakeTimers();
  const notice = fakeEl('div');
  const fetched = [];
  const queue = [...answers];
  const listeners = [];
  const reloads = [];
  const attrs = shown === null ? {} : { 'data-update-api': '../../api/artifacts/demo-abc123', 'data-shown-version': String(shown) };
  const document = {
    hidden,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); },
    body: { getAttribute: (k) => (Object.hasOwn(attrs, k) ? attrs[k] : null) },
    querySelector: (sel) => (sel === '[data-role="update"]' && container ? notice : null),
    createElement: fakeEl,
  };
  const fetch = (url, opts) => {
    fetched.push({ url, opts });
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  vm.runInNewContext(src, {
    document, fetch, location: { reload: () => reloads.push(1) },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return {
    notice, timers, fetched, reloads, document, queue,
    tick: async () => { timers.fire(); await flush(); },
    visible: async () => { document.hidden = false; listeners.forEach((fn) => fn()); await flush(); },
  };
}

// Pins: a current page polls the record's URL uncached, leaves the region truly empty (no child nodes), and keeps polling.
test('same version: polls the data-update-api URL with no-store, notice stays empty, polling continues', async () => {
  const p = load({ answers: [resp(200, record(1))] });
  await p.tick();
  assert.equal(p.fetched.length, 1);
  assert.equal(p.fetched[0].url, '../../api/artifacts/demo-abc123');
  assert.equal(p.fetched[0].opts.cache, 'no-store');
  assert.equal(p.notice.textContent, '');
  assert.equal(p.notice.children.length, 0, 'no child nodes, so the stylesheet hides the region (:empty)');
  assert.equal(p.timers.count, 1);
});

// Pins: a newer version produces a notice naming it with one button whose click reloads; polling continues.
test('newer version: notice names it, one button, click reloads once, polling continues', async () => {
  const p = load({ answers: [resp(200, record(1, 2))] });
  await p.tick();
  assert.match(p.notice.textContent, /v2/);
  const buttons = p.notice.buttons();
  assert.equal(buttons.length, 1);
  assert.equal(p.reloads.length, 0, 'no auto-switch');
  buttons[0].click();
  assert.equal(p.reloads.length, 1);
  assert.equal(p.timers.count, 1);
});

// Pins: successive updates replace the notice in place with the newest version; never stack.
test('two updates in a row: the notice names the newest, still one button', async () => {
  const p = load({ answers: [resp(200, record(1, 2)), resp(200, record(1, 2, 3))] });
  await p.tick();
  await p.tick();
  assert.match(p.notice.textContent, /v3/);
  assert.doesNotMatch(p.notice.textContent, /v2/);
  assert.equal(p.notice.buttons().length, 1);
});

// Pins: an unchanged poll leaves the existing notice DOM alone (focus and live-region announcement survive).
test('unchanged poll after newer keeps the same button node', async () => {
  const p = load({ answers: [resp(200, record(1, 2)), resp(200, record(1, 2))] });
  await p.tick();
  const button = p.notice.buttons()[0];
  await p.tick();
  assert.equal(p.notice.buttons()[0], button);
});

// Pins: a deleted shown version still offers a way to the latest.
test('shown version deleted: notice with a button, click reloads', async () => {
  const p = load({ shown: 3, answers: [resp(200, record(1, 2))] });
  await p.tick();
  assert.match(p.notice.textContent, /v3/);
  assert.match(p.notice.textContent, /v2/);
  assert.equal(p.notice.buttons().length, 1);
  p.notice.buttons()[0].click();
  assert.equal(p.reloads.length, 1);
});

// Pins: an unknown artifact is terminal: a notice with no button and polling stops.
test('404 ARTIFACT_UNKNOWN: buttonless notice and polling stops', async () => {
  const p = load({ answers: [resp(404, { code: 'ARTIFACT_UNKNOWN' })] });
  await p.tick();
  assert.notEqual(p.notice.textContent, '');
  assert.equal(p.notice.buttons().length, 0);
  assert.equal(p.timers.count, 0);
  await p.visible();
  assert.equal(p.fetched.length, 1, 'visibility does not revive a stopped check');
});

// Pins: transient failures change nothing and retry on the next tick.
test('transient failures leave the notice unchanged and retry', async () => {
  const p = load({ answers: [resp(200, record(1, 2)), new Error('down'), resp(503, { code: 'X' }), resp(502), resp(404, { code: 'OTHER' })] });
  await p.tick();
  const before = p.notice.textContent;
  for (let i = 0; i < 4; i++) {
    await p.tick();
    assert.equal(p.notice.textContent, before);
    assert.equal(p.timers.count, 1, `retry scheduled after failure ${i + 1}`);
  }
  assert.equal(p.fetched.length, 5);
});

// Pins: hidden tabs do not poll; becoming visible checks at once.
test('hidden at tick: no fetch, no timer; visibilitychange to visible fetches immediately', async () => {
  const p = load({ hidden: true, answers: [resp(200, record(1, 2))] });
  await p.tick();
  assert.equal(p.fetched.length, 0);
  assert.equal(p.timers.count, 0);
  await p.visible();
  assert.equal(p.fetched.length, 1);
  assert.match(p.notice.textContent, /v2/);
  assert.equal(p.timers.count, 1);
});

// Pins: a page without the update attributes (pinned) or without the container is inert.
test('no data-update-api (pinned) or no container: no fetch and no timer', async () => {
  for (const opts of [{ shown: null }, { container: false }]) {
    const p = load(opts);
    assert.equal(p.timers.count, 0);
    await p.visible();
    assert.equal(p.fetched.length, 0);
  }
});

// ---- server side ----

const attr = (html, name) => new RegExp(` ${name}="([^"]*)"`).exec(html)?.[1];
const hooks = (html) => ({
  api: attr(html, 'data-update-api'), shown: attr(html, 'data-shown-version'),
  container: /data-role="update"/.test(html), script: /_page\/update-check\.js/.test(html),
});

async function publishKinds(t, app) {
  const md = await publish(app, { path: await fixtureFile(t, 'a.md', '# one'), title: 'Md' });
  const dl = await publish(app, { path: await fixtureFile(t, 'a.bin', 'bin'), title: 'Dl', kind: 'download' });
  const st = await publish(app, { path: await fixtureDir(t, { 'index.html': 'ONE', 'docs/page.html': 'P' }), title: 'Site' });
  const ap = await publishApp(t, app, { title: 'App' });
  for (const [art, to] of [[md, '# two'], [st, 'TWO']]) {
    const p = art === md ? await fixtureFile(t, 'b.md', to) : await fixtureDir(t, { 'index.html': to });
    await app.mcp('update_artifact', { artifact: art.id, path: p });
  }
  return [['markdown', md, '/'], ['download', dl, '/'], ['static', st, '/docs/page.html'], ['app', ap, '/']];
}

// Pins: every kind's latest page carries the hooks, resolving (from any depth) to the record whose latest n it shows; pinned pages carry none.
test('latest pages carry the update hooks that resolve to the record; pinned pages carry none', async (t) => {
  const app = await startApps(t);
  for (const [kind, art, sub] of await publishKinds(t, app)) {
    const page = `/a/${art.id}${sub}`;
    const h = hooks((await app.get(page)).text);
    assert.ok(h.api && h.shown && h.container && h.script, `${kind}: hooks present`);
    const rec = await app.get(new URL(h.api, `${app.base}${page}`).pathname);
    assert.equal(rec.status, 200, kind);
    assert.equal(rec.data.id, art.id);
    assert.equal(String(rec.data.versions.at(-1).n), h.shown, `${kind}: shown is the latest n`);
    const pinned = hooks((await app.get(`/a/${art.id}/v/1${sub}`)).text);
    assert.deepEqual(pinned, { api: undefined, shown: undefined, container: false, script: false }, `${kind}: pinned`);
  }
});

// Pins: the contract the script polls: an update raises the latest n; deleting the artifact is 404 ARTIFACT_UNKNOWN.
test('the polled URL reports an update, then ARTIFACT_UNKNOWN after delete', async (t) => {
  const app = await startApp(t);
  const art = await publish(app, { path: await fixtureFile(t, 'a.md', '# one'), title: 'Md' });
  const url = new URL(hooks((await app.get(`/a/${art.id}/`)).text).api, `${app.base}/a/${art.id}/`).pathname;
  assert.equal((await app.get(url)).data.versions.at(-1).n, 1);
  await app.mcp('update_artifact', { artifact: art.id, path: await fixtureFile(t, 'b.md', '# two') });
  assert.equal((await app.get(url)).data.versions.at(-1).n, 2);
  await app.mcp('delete_artifact', { artifact: art.id });
  const gone = await app.get(url);
  assert.equal(gone.status, 404);
  assert.equal(gone.data.code, 'ARTIFACT_UNKNOWN');
});

// Pins: the script is served as a page asset.
test('GET _page/update-check.js serves JavaScript', async (t) => {
  const app = await startApp(t);
  const res = await app.get('/_page/update-check.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});
