// Guards the palette and its use: the standalone fallback equals cc's tokens, every colour used by the plugin's own code
// goes through a token, and the Tailwind theme maps each colour to the matching token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fsp.readFile(path.join(ROOT, rel), 'utf8');

// Pinned snapshot of cc's palette (the :root and .dark blocks of its theme token sheet).
const LIGHT = {
  '--radius': '0.75rem',
  '--background': 'oklch(0.99 0.002 60)',
  '--foreground': 'oklch(0.2 0.01 50)',
  '--card': 'oklch(1 0 0)',
  '--card-foreground': 'var(--foreground)',
  '--popover': 'oklch(1 0 0)',
  '--popover-foreground': 'var(--foreground)',
  '--primary': 'oklch(0.66 0.17 38)',
  '--primary-foreground': 'oklch(0.99 0.01 60)',
  '--secondary': 'oklch(0.96 0.005 60)',
  '--secondary-foreground': 'oklch(0.25 0.01 50)',
  '--muted': 'oklch(0.965 0.004 60)',
  '--muted-foreground': 'oklch(0.52 0.012 55)',
  '--accent': 'oklch(0.955 0.02 45)',
  '--accent-foreground': 'oklch(0.35 0.08 38)',
  '--destructive': 'oklch(0.58 0.22 25)',
  '--border': 'oklch(0.915 0.006 60)',
  '--input': 'oklch(0.9 0.006 60)',
  '--ring': 'oklch(0.66 0.17 38 / 0.5)',
  '--sidebar': 'oklch(0.975 0.004 60)',
  '--sidebar-foreground': 'var(--foreground)',
  '--sidebar-border': 'var(--border)',
  '--sidebar-accent': 'oklch(0.94 0.008 60)',
  '--success': 'oklch(0.62 0.15 155)',
  '--warning': 'oklch(0.74 0.15 75)',
  '--info': 'oklch(0.6 0.14 245)',
  '--plan': 'oklch(0.58 0.17 290)',
};

const DARK = {
  '--background': 'oklch(0.17 0.006 50)',
  '--foreground': 'oklch(0.95 0.005 60)',
  '--card': 'oklch(0.205 0.007 50)',
  '--card-foreground': 'var(--foreground)',
  '--popover': 'oklch(0.22 0.008 50)',
  '--popover-foreground': 'var(--foreground)',
  '--primary': 'oklch(0.72 0.16 40)',
  '--primary-foreground': 'oklch(0.18 0.02 40)',
  '--secondary': 'oklch(0.25 0.008 50)',
  '--secondary-foreground': 'var(--foreground)',
  '--muted': 'oklch(0.24 0.007 50)',
  '--muted-foreground': 'oklch(0.68 0.012 55)',
  '--accent': 'oklch(0.28 0.03 40)',
  '--accent-foreground': 'oklch(0.9 0.05 45)',
  '--destructive': 'oklch(0.66 0.2 25)',
  '--border': 'oklch(0.29 0.008 50)',
  '--input': 'oklch(0.32 0.008 50)',
  '--ring': 'oklch(0.72 0.16 40 / 0.5)',
  '--sidebar': 'oklch(0.15 0.006 50)',
  '--sidebar-foreground': 'var(--foreground)',
  '--sidebar-border': 'oklch(0.26 0.008 50)',
  '--sidebar-accent': 'oklch(0.23 0.008 50)',
  '--success': 'oklch(0.72 0.15 155)',
  '--warning': 'oklch(0.8 0.14 80)',
  '--info': 'oklch(0.72 0.12 245)',
  '--plan': 'oklch(0.72 0.14 290)',
};

/** `--name: value` declarations of the first block whose selector is `selector`. */
function declarations(css, selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} block not found`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/^\s*(--[\w-]+):\s*(.+);/gm)].map((m) => [m[1], m[2]]));
}

async function sourceFiles(dir, exclude = () => false) {
  const out = [];
  for (const e of await fsp.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (exclude(rel)) continue;
    if (e.isDirectory()) out.push(...(await sourceFiles(rel, exclude)));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('the fallback :root and .dark tokens equal the pinned cc palette', async () => {
  const css = await read('frontend/src/cc-theme-fallback.css');
  assert.deepEqual(declarations(css, ':root'), LIGHT);
  assert.deepEqual(declarations(css, '.dark'), DARK);
});

const OWN_FILES = async () => [
  ...(await sourceFiles('frontend/src', (rel) => rel.includes(`components${path.sep}ui`) || rel.endsWith('cc-theme-fallback.css'))),
  'assets/page.css', 'src/pages.js',
];

test('every var(--x) the plugin uses is a pinned token, --cc-session-width, or a Tailwind --tw-* variable', async () => {
  const allowed = new Set([...Object.keys(LIGHT), '--cc-session-width']);
  const themeVars = new Set([...(await read('frontend/src/index.css')).matchAll(/^\s*(--(?:font|radius)-[\w-]+):/gm)].map((m) => m[1]));
  for (const file of await OWN_FILES()) {
    for (const m of (await read(file)).matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1];
      assert.ok(allowed.has(name) || name.startsWith('--tw-') || themeVars.has(name), `${file} uses ${name}`);
    }
  }
});

test('no literal colours outside the fallback and the copied components', async () => {
  const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(|\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/;
  for (const file of await OWN_FILES()) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    const hit = literal.exec(text);
    assert.equal(hit, null, `${file} has a literal colour: ${hit?.[0]}`);
  }
});

test('every --color-* in the @theme inline block maps to var(--<same name>)', async () => {
  const css = await read('frontend/src/index.css');
  const block = /@theme inline \{([\s\S]*?)\n\}/.exec(css)[1];
  const colours = [...block.matchAll(/^\s*--color-([\w-]+):\s*(.+);/gm)];
  assert.ok(colours.length > 0);
  for (const [, name, value] of colours) {
    assert.equal(value, `var(--${name})`, `--color-${name}`);
    assert.ok(`--${name}` in LIGHT, `--${name} is a pinned token`);
  }
});
