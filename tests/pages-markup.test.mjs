// Pins the static and app wrapper markup byte for byte against tests/fixtures/pages/, and the header shared by every artifact page.
// An intended wrapper change regenerates the fixtures: UPDATE_FIXTURES=1 node --test tests/pages-markup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticPage, appPage } from '../src/pages.js';

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
  'app-pinned-not-running': () => appPage({ ...app, latest: false, latestN: 3, state: { status: 'stopped' } }),
};

test('static and app wrapper markup is byte-identical to the captured fixtures', async () => {
  for (const [name, render] of Object.entries(CASES)) {
    const file = path.join(DIR, `${name}.html`);
    if (process.env.UPDATE_FIXTURES) await fsp.writeFile(file, render());
    assert.equal(render(), await fsp.readFile(file, 'utf8'), name);
  }
});
