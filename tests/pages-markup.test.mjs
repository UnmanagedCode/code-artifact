// Pins the static and app wrapper markup byte for byte against tests/fixtures/pages/, and the header shared by every artifact page.
// An intended wrapper change regenerates the fixtures: UPDATE_FIXTURES=1 node --test tests/pages-markup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticPage, appPage, markdownPage, downloadPage } from '../src/pages.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pages');
const prefix = '../../';
const project = 'x&artifact=y"<b>';
const version = { n: 2, title: 'T <i>"&\'', file: 'f.bin', bytes: 1, publishedAt: '2026-01-01T00:00:00Z', sessionId: 's<1>' };
const base = { prefix, id: 'abc', project, version, latest: true, frameSrc: 'raw/x.html?a=1&b="2"' };
const app = { ...base, latestN: 2 };

const CASES = {
  'static-latest': () => staticPage(base),
  'static-pinned': () => staticPage({ ...base, latest: false }),
  'app-running-latest': () => appPage({ ...app, state: { status: 'running' } }),
  'app-stopped-error': () => appPage({ ...app, state: { status: 'stopped', error: 'boom <b>&"' } }),
  'app-installing': () => appPage({ ...app, state: { status: 'installing' } }),
  'app-starting': () => appPage({ ...app, state: { status: 'starting' } }),
  'app-failed': () => appPage({ ...app, state: { status: 'failed', error: 'exited with code 4' } }),
  'app-running-not-latest': () => appPage({ ...app, latest: false, state: { status: 'running' } }),
  'app-pinned-not-running': () => appPage({ ...app, latest: false, latestN: 3, state: { status: 'stopped' } }),
};

test('static and app wrapper markup is byte-identical to the captured fixtures', async () => {
  for (const [name, render] of Object.entries(CASES)) {
    const file = path.join(DIR, `${name}.html`);
    if (process.env.UPDATE_FIXTURES) await fsp.writeFile(file, render());
    assert.equal(render(), await fsp.readFile(file, 'utf8'), name);
  }
});

const barOf = (html) => /<header class="bar">[\s\S]*?<\/header>/.exec(html)?.[0];
const mdProps = { prefix, id: 'abc', project, version, rendered: '<p>x</p>' };

test('markdown and static pages render the same header bar', () => {
  for (const latest of [true, false]) {
    const md = barOf(markdownPage({ ...mdProps, latest }));
    assert.ok(md, 'the markdown page has a bar');
    assert.equal(md, barOf(staticPage({ ...base, latest })));
  }
});

test("the download page's bar has the back link, title and badge, and no Download link", () => {
  const html = downloadPage({ ...mdProps, version: { ...version, title: 'Bin' }, latest: true });
  const bar = barOf(html);
  assert.match(bar, /Artifacts<\/a>/);
  assert.match(bar, /<h1>Bin<\/h1>/);
  assert.match(bar, /v2 · latest/);
  assert.doesNotMatch(bar, /Download/);
  assert.match(html.slice(bar.length + html.indexOf(bar)), /<a class="btn primary" href="\.\.\/\.\.\/dl\/abc\/2">Download<\/a>/);
});

test('latest markdown and download pages put the update notice right after the bar, before the content; pinned ones have neither', () => {
  for (const render of [markdownPage, downloadPage]) {
    const latest = render({ ...mdProps, latest: true });
    const top = /<div class="page-top">([\s\S]*?)<\/div>\n<main/.exec(latest);
    assert.ok(top, 'the bar and notice share one top container before <main>');
    assert.ok(top[1].trimStart().startsWith(barOf(latest)), 'the bar leads the container');
    assert.match(top[1].trimStart().slice(barOf(latest).length), /^\s*<div class="update-notice"[^>]* role="status"><\/div>\s*$/);
    const pinned = render({ ...mdProps, latest: false });
    assert.doesNotMatch(pinned, /role="status"|update-check\.js/);
  }
});
