import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { ID_RE } from './links.js';
import { CONTENT, RENDERED } from './ingest.js';
import { markdownPage, downloadPage, staticPage, appPage } from './pages.js';
import { plain, wrap } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Page assets: one source file each, so the server-rendered pages work while the UI is unbuilt.
const PAGE_ASSETS = {
  'page.css': [path.join(ROOT, 'assets'), 'page.css'],
  'fallback.css': [path.join(ROOT, 'frontend', 'src'), 'cc-theme-fallback.css'],
  'theme-init.js': [path.join(ROOT, 'frontend', 'public'), 'theme-init.js'],
  'nav.js': [path.join(ROOT, 'frontend', 'public'), 'nav.js'],
  'app-page.js': [path.join(ROOT, 'assets'), 'app-page.js'],
};
const PINNED_CACHE = 'private, max-age=31536000, immutable';

/** Decoded path segments of a raw (percent-encoded) sub-path, or null when any is unsafe. `dir` marks a trailing slash. */
function safeSegments(raw) {
  const parts = raw.split('/').slice(1); // raw starts with '/'
  const dir = parts[parts.length - 1] === '';
  if (dir) parts.pop();
  const segs = [];
  for (const part of parts) {
    let seg;
    try { seg = decodeURIComponent(part); } catch { return null; }
    if (seg === '' || seg.startsWith('.') || /[/\\\0]/.test(seg)) return null;
    segs.push(seg);
  }
  return { segs, dir };
}

const insideRoot = (root, p) => p === root || p.startsWith(root + path.sep);

/** A regular, non-symlink file at `rel` under `content` whose real path stays inside it; else null. */
async function regularFile(contentReal, content, rel) {
  try {
    const abs = path.join(content, rel);
    const st = await fsp.lstat(abs);
    if (!st.isFile()) return st.isDirectory() ? 'dir' : null;
    return insideRoot(contentReal, await fsp.realpath(abs)) ? 'file' : null;
  } catch {
    return null;
  }
}

async function serveStatic(res, next, content, sub) {
  const parsed = safeSegments(sub);
  if (!parsed) return plain(res, 404, 'Not found');
  let contentReal;
  try { contentReal = await fsp.realpath(content); } catch { return plain(res, 404, 'Not found'); }
  let rel = parsed.segs.join('/');
  let kind = rel === '' ? 'dir' : await regularFile(contentReal, content, rel);
  if (kind === 'dir' && !parsed.dir) {
    return res.redirect(301, `${sub.split('/').pop()}/`); // relative to the directory's own URL
  }
  if (kind === 'dir') {
    rel = rel ? `${rel}/index.html` : 'index.html';
    kind = await regularFile(contentReal, content, rel);
  } else if (parsed.dir) {
    kind = null;
  }
  if (kind !== 'file') return plain(res, 404, 'Not found');
  // The trusted stance: a static site runs as authored, so the plugin's own CSP is not applied to it.
  res.removeHeader('Content-Security-Policy');
  // A relative path with `root`: an absolute one makes dotfiles:'deny' refuse a store under a dot-directory.
  return res.sendFile(rel, { root: content, dotfiles: 'deny', cacheControl: false }, (err) => {
    if (err) next(err.status === 404 ? undefined : err);
  });
}

/** False for a sub-path that could climb out of the app's URL space: a `..` segment (also percent-encoded) or a backslash. */
function appSubOk(sub) {
  return sub.split('/').every((part) => {
    let seg;
    try { seg = decodeURIComponent(part); } catch { return false; }
    return seg !== '..' && !seg.includes('\\');
  });
}

/** The routes that serve published content: a/…, raw/…, dl/…, and the page assets. `apps` is the app host. */
export function contentRouter(getStore, apps) {
  const r = express.Router();

  r.get('/_page/:file', (req, res, next) => {
    const asset = Object.hasOwn(PAGE_ASSETS, req.params.file) ? PAGE_ASSETS[req.params.file] : null;
    if (!asset) return plain(res, 404, 'Not found');
    return res.sendFile(asset[1], { root: asset[0], dotfiles: 'deny' }, (err) => { if (err) next(err); });
  });

  r.get('/a/*', wrap(async (req, res, next) => {
    const m = /^\/a\/([^/]+)(\/.*)?$/.exec(req.path);
    if (!m || !ID_RE.test(m[1])) return plain(res, 404, 'Not found');
    const [, id, rest] = m;
    if (rest === undefined) return res.redirect(301, `${id}/`);
    const pinned = /^\/v\/([1-9][0-9]*)(\/.*)?$/.exec(rest);
    if (pinned && pinned[2] === undefined) return res.redirect(301, `${pinned[1]}/`);

    const store = getStore();
    const record = await store.get(id);
    if (!record) return plain(res, 404, 'Not found');
    const wanted = pinned ? Number(pinned[1]) : null;
    const version = wanted === null ? record.versions[record.versions.length - 1] : record.versions.find((v) => v.n === wanted);
    if (!version) return plain(res, 404, 'Not found');
    const sub = pinned ? pinned[2] : rest;
    const dir = store.versionDir(id, version.n);
    res.set('Cache-Control', pinned ? PINNED_CACHE : 'no-cache');

    // Relative path from this page back to the plugin root: one `../` per directory level of the URL.
    const prefix = '../'.repeat(req.path.split('/').length - 2);
    const ctx = { prefix, id, version, latest: !pinned };
    if (record.kind === 'static') {
      // The site itself is served raw and pinned; this page is the plugin-rendered wrapper around it.
      if (!safeSegments(sub)) return plain(res, 404, 'Not found');
      const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.type('html').send(staticPage({ ...ctx, frameSrc: `${prefix}raw/${id}/${version.n}${sub}${search}` }));
    }
    if (record.kind === 'app') {
      // The page shows live status, so even a pinned one is never cached; the app itself is served at app/<id>/.
      if (!appSubOk(sub)) return plain(res, 404, 'Not found');
      res.set('Cache-Control', 'no-cache');
      const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const latestN = record.versions[record.versions.length - 1].n;
      return res.type('html').send(appPage({
        ...ctx, latestN, state: apps.status(id), frameSrc: `${prefix}app/${id}${sub}${search}`,
      }));
    }
    if (sub !== '/') return plain(res, 404, 'Not found');
    if (record.kind === 'markdown') {
      const rendered = await fsp.readFile(path.join(dir, RENDERED), 'utf8');
      return res.type('html').send(markdownPage({ ...ctx, rendered }));
    }
    return res.type('html').send(downloadPage(ctx));
  }));

  // The static site's files, byte for byte, always pinned to a concrete version.
  r.get('/raw/*', wrap(async (req, res, next) => {
    const m = /^\/raw\/([^/]+)\/([1-9][0-9]*)(\/.*)?$/.exec(req.path);
    if (!m || !ID_RE.test(m[1])) return plain(res, 404, 'Not found');
    const [, id, n, rest] = m;
    if (rest === undefined) return res.redirect(301, `${n}/`);
    const store = getStore();
    const record = await store.get(id);
    if (record?.kind !== 'static' || !record.versions.some((v) => v.n === Number(n))) return plain(res, 404, 'Not found');
    res.set('Cache-Control', PINNED_CACHE);
    return serveStatic(res, next, path.join(store.versionDir(id, Number(n)), CONTENT), rest);
  }));

  r.get('/dl/:id/:n', wrap(async (req, res, next) => {
    const { id, n } = req.params;
    if (!ID_RE.test(id) || !/^[1-9][0-9]*$/.test(n)) return plain(res, 404, 'Not found');
    const store = getStore();
    const record = await store.get(id);
    const version = record?.versions.find((v) => v.n === Number(n));
    if (!version) return plain(res, 404, 'Not found');
    const content = path.join(store.versionDir(id, version.n), CONTENT);
    if (record.kind === 'static' || record.kind === 'app') {
      res.attachment(`${id}-v${version.n}.tar.gz`);
      res.type('application/gzip');
      const pack = tar.c({ gzip: true, portable: true, cwd: content }, ['.']);
      pack.on('error', (e) => { console.error('code-artifact: pack failed:', e); res.destroy(e); });
      res.on('close', () => pack.destroy());
      return pack.pipe(res);
    }
    res.attachment(version.file);
    // dotfiles:'allow': the stored name is ours, and a download may legitimately be a dotfile.
    return res.sendFile(version.file, { root: content, dotfiles: 'allow' }, (err) => { if (err) next(err.status === 404 ? undefined : err); });
  }));

  return r;
}
