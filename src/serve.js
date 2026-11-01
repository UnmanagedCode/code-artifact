import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
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
  'report.js': [path.join(ROOT, 'assets'), 'report.js'],
  'relay.js': [path.join(ROOT, 'assets'), 'relay.js'],
};
const PINNED_CACHE = 'private, max-age=31536000, immutable';
// dl/ content is never a page: `sandbox` is the backstop if a browser renders an attachment (an SVG) top-level.
const DL_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

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

/** Relative path from a page at `reqPath` back to the plugin root: one `../` per directory level of the URL. */
const rootPrefix = (reqPath) => '../'.repeat(reqPath.split('/').length - 2);

// Leading UTF-8 BOM, whitespace and comments, then the doctype. A comment body cannot span `-->`, so a failed match stays linear.
const DOCTYPE_RE = /^(?:\xEF\xBB\xBF)?(?:\s|<!--(?:(?!-->)[\s\S])*-->)*<!doctype[^>]*>/i;
/** How much of an HTML file is read to place the report helper; a doctype that ends past it counts as none. The rest is streamed. */
export const DOCTYPE_SCAN_BYTES = 64 * 1024;

/**
 * Where the report helper's tag goes in a file that starts with `head`: after the doctype (before it would switch the page to
 * quirks mode), else after a UTF-8 BOM, else first; null for a UTF-16 document, which is served as is. The search runs on the
 * latin1 view (one char per byte), so the offset is a byte offset and no byte is re-encoded.
 */
function reportOffset(head) {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return null;
  const m = DOCTYPE_RE.exec(head.toString('latin1'));
  if (m) return m[0].length;
  return head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
}

/**
 * Sends the HTML file `abs` with `<script src="${src}">` spliced in at `reportOffset`, streaming everything past the scanned head.
 * Validators come from the file's stat and the served length; a matching conditional request gets a 304, a HEAD the headers only.
 * No Range support: offsets in the served body are not offsets in the file.
 */
async function sendHtml(req, res, abs, src) {
  let fh;
  try {
    fh = await fsp.open(abs, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return plain(res, 404, 'Not found'); // the version was deleted since the file was resolved
    throw e;
  }
  let streaming = false;
  try {
    const st = await fh.stat();
    const scan = Buffer.alloc(Math.min(st.size, DOCTYPE_SCAN_BYTES));
    const { bytesRead } = await fh.read(scan, 0, scan.length, 0);
    const at = reportOffset(scan.subarray(0, bytesRead));
    const tag = at === null ? Buffer.alloc(0) : Buffer.from(`<script src="${src}"></script>`);
    // The client may have left during the reads above, and its `close` has then already fired.
    if (res.destroyed) return;
    const length = st.size + tag.length;
    res.type(path.extname(abs));
    res.set({
      'Accept-Ranges': 'none',
      'Content-Length': String(length),
      ETag: `W/"${length.toString(16)}-${st.mtime.getTime().toString(16)}"`,
      'Last-Modified': st.mtime.toUTCString(),
    });
    if (req.fresh) {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      return res.status(304).end();
    }
    if (req.method === 'HEAD') return res.end();
    const head = scan.subarray(0, at ?? 0);
    res.write(Buffer.concat([head, tag]));
    const rest = fh.createReadStream({ start: head.length }); // closes `fh` when it ends or is destroyed
    streaming = true;
    return pipeline(rest, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('code-artifact: raw read failed:', err);
    });
  } finally {
    if (!streaming) await fh.close();
  }
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

/** Serves a static site's file at `sub`; an HTML file gets the report helper `reportSrc` injected. */
async function serveStatic(req, res, next, content, sub, reportSrc) {
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
  if (/\.html?$/i.test(rel)) return sendHtml(req, res, path.join(content, rel), reportSrc);
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

    const prefix = rootPrefix(req.path);
    const ctx = { prefix, id, project: record.project, version, latest: !pinned };
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

  // The static site's files, always pinned to a concrete version: byte for byte, except the report helper's tag in HTML.
  r.get('/raw/*', wrap(async (req, res, next) => {
    const m = /^\/raw\/([^/]+)\/([1-9][0-9]*)(\/.*)?$/.exec(req.path);
    if (!m || !ID_RE.test(m[1])) return plain(res, 404, 'Not found');
    const [, id, n, rest] = m;
    if (rest === undefined) return res.redirect(301, `${n}/`);
    const store = getStore();
    const record = await store.get(id);
    if (record?.kind !== 'static' || !record.versions.some((v) => v.n === Number(n))) return plain(res, 404, 'Not found');
    res.set('Cache-Control', PINNED_CACHE);
    return serveStatic(req, res, next, path.join(store.versionDir(id, Number(n)), CONTENT), rest, `${rootPrefix(req.path)}_page/report.js`);
  }));

  r.get('/dl/:id/:n', wrap(async (req, res, next) => {
    const { id, n } = req.params;
    if (!ID_RE.test(id) || !/^[1-9][0-9]*$/.test(n)) return plain(res, 404, 'Not found');
    const store = getStore();
    const record = await store.get(id);
    const version = record?.versions.find((v) => v.n === Number(n));
    if (!version) return plain(res, 404, 'Not found');
    res.set('Content-Security-Policy', DL_CSP);
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
