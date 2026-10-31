// Golden-path visual check: boots the backend on a seeded sandbox store, drives the list, detail, prune dialog and
// the markdown, download and static pages, and saves a screenshot per step in light and dark and at phone width.
// Run: node harness/playwright/golden.mjs   (needs `npm install` first, for frontend/dist; export CC_PROJECTS_ROOT outside cc)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { seed } from './seed.mjs';

const { withPage } = await import(BROWSER);
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(outDir, { recursive: true });
const HOST_URLS = /pluginBridge\.js|pluginTheme\.css/;

const world = await seed();
const failures = [];
const shots = [];

function watchErrors(page) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !HOST_URLS.test(m.text()) && !/^Failed to load resource/.test(m.text())) failures.push(m.text());
  });
  page.on('response', (r) => { if (r.status() >= 400 && !HOST_URLS.test(r.url())) failures.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
}

const VIEWS = [
  { name: 'desktop', viewport: { width: 1100, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
];
const SCHEMES = ['light', 'dark'];

try {
  for (const { name: vname, viewport } of VIEWS) {
    for (const scheme of SCHEMES) {
      await withPage(async (page) => {
        watchErrors(page);
        await page.emulateMedia({ colorScheme: scheme });
        const shot = async (step) => {
          const file = path.join(outDir, `${step}-${vname}-${scheme}.png`);
          await page.screenshot({ path: file, animations: 'disabled', fullPage: step.startsWith('page-') && !step.startsWith('page-static') });
          shots.push(file);
        };

        // List, grouped by project.
        await page.goto(world.url);
        await page.getByRole('heading', { name: 'Artifacts', level: 1 }).waitFor();
        await page.getByRole('link', { name: 'Release notes' }).waitFor();
        assert.deepEqual(await page.locator('section[aria-label] > h2').allTextContents(), ['demo', 'tools']);
        assert.equal(await page.getByRole('link', { name: 'Open' }).count(), 3);
        await shot('list');

        // Detail of the two-version markdown artifact.
        await page.getByRole('link', { name: 'Release notes' }).click();
        await page.getByRole('heading', { name: 'Release notes', level: 1 }).waitFor();
        assert.equal(await page.locator('section[aria-label="Versions"] > *').count(), 2);
        assert.ok(await page.getByText('latest', { exact: true }).isVisible());
        assert.match(new URL(page.url()).search, /artifact=release-notes-/);
        await shot('detail');

        // Delete a version: the confirm dialog opens and cancels cleanly.
        await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
        await page.getByRole('dialog').waitFor();
        await shot('confirm');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });

        // A single-version artifact cannot lose its only version.
        await page.goBack().catch(() => {});
        await page.goto(`${world.url}/?artifact=${world.ids.download}`);
        await page.getByRole('heading', { name: 'Quarterly report', level: 1 }).waitFor();
        assert.ok(await page.getByRole('button', { name: 'Delete', exact: true }).isDisabled());

        // Prune dialog with its live dry-run count.
        await page.goto(world.url);
        await page.getByRole('button', { name: /Delete old/ }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByTestId('prune-preview').filter({ hasText: /Deletes 1 version across 1 artifact/ }).waitFor();
        await shot('prune');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });

        // Server-rendered pages.
        await page.goto(`${world.url}/a/${world.ids.markdown}/`);
        await page.getByRole('heading', { name: 'Release notes', level: 1 }).first().waitFor();
        assert.ok(await page.locator('article.md table').isVisible());
        assert.equal(await page.locator('article.md input[type=checkbox]').count(), 2);
        await shot('page-markdown');
        await page.goto(`${world.url}/a/${world.ids.download}/`);
        await page.getByRole('link', { name: 'Download' }).waitFor();
        await shot('page-download');
        await page.goto(`${world.url}/a/${world.ids.static}/`);
        // The wrapper: a compact bar plus an iframe that fills the rest of the viewport and shows the site.
        await page.frameLocator('iframe.site').getByRole('heading', { name: 'Demo site' }).waitFor();
        const frameBox = await page.locator('iframe.site').boundingBox();
        const barBox = await page.locator('.bar').boundingBox();
        assert.ok(Math.abs(frameBox.y - (barBox.y + barBox.height)) < 2, 'the iframe sits directly under the bar');
        assert.ok(Math.abs(frameBox.y + frameBox.height - viewport.height) < 2, 'the iframe fills the viewport');
        assert.ok(Math.abs(frameBox.width - viewport.width) < 2, 'the iframe spans the width');
        assert.match(await page.locator('iframe.site').getAttribute('src'), /^\.\.\/\.\.\/raw\//);
        await shot('page-static');
        await page.goto(`${world.url}/a/${world.ids.static}/v/1/`);
        await page.frameLocator('iframe.site').getByRole('heading', { name: 'Demo site' }).waitFor();
        await shot('page-static-pinned');
      }, { headless: true, viewport });
    }
  }
  assert.deepEqual(failures, [], `console or network failures:\n${failures.join('\n')}`);
  console.log(`golden path ok: ${shots.length} screenshots in ${outDir}`);
  for (const s of shots) console.log(s);
} finally {
  await world.close();
}
