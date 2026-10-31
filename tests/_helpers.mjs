import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as tar from 'tar';
import { createServer } from '../server.js';

/** A fresh temp dir, removed when the test ends. */
export async function tmp(t, prefix = 'ca-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes `{ 'a/b.txt': 'content' }` under `root`; a trailing-slash key makes a directory. */
export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (rel.endsWith('/')) { await fsp.mkdir(abs, { recursive: true }); continue; }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return root;
}

/** A directory fixture in its own temp dir. */
export async function fixtureDir(t, files, name = 'src') {
  const base = await tmp(t);
  return writeTree(path.join(base, name), files);
}

/** A single-file fixture. */
export async function fixtureFile(t, name, content) {
  const base = await tmp(t);
  const file = path.join(base, name);
  await fsp.writeFile(file, content);
  return file;
}

/** A .tar.gz of `dir`'s contents (or of `dir` itself under its own name with `wrap`). */
export async function packDir(t, dir, { name = 'a.tgz', wrap = false } = {}) {
  const out = path.join(await tmp(t), name);
  if (wrap) await tar.c({ gzip: true, file: out, cwd: path.dirname(dir) }, [path.basename(dir)]);
  else await tar.c({ gzip: true, file: out, cwd: dir }, ['.']);
  return out;
}

function header({ name, type = '0', linkname = '', size = 0, mode = 0o644 }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257);
  h.write('00', 263);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** A raw .tar.gz with arbitrary entries: [{name, type: '0' file | '5' dir | '2' symlink | '1' hardlink | '3' chardev, linkname, data}]. */
export async function rawTarball(t, entries, name = 'raw.tgz') {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    parts.push(header({ ...e, size: e.type === '0' || e.type === undefined ? data.length : 0 }));
    if ((e.type ?? '0') === '0') {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  const file = path.join(await tmp(t), name);
  await fsp.writeFile(file, zlib.gzipSync(Buffer.concat(parts)));
  return file;
}

/** A fake conductor: `/api/projects/:name/location` and `/api/instances`. */
export async function fakeCc(t, { projects = [], instances = [], status } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (status) { res.statusCode = status; return res.end('{}'); }
    const loc = /^\/api\/projects\/([^/]+)\/location$/.exec(req.url);
    res.setHeader('content-type', 'application/json');
    if (loc) {
      const ok = projects.includes(decodeURIComponent(loc[1]));
      res.statusCode = ok ? 200 : 404;
      return res.end(JSON.stringify(ok ? { name: loc[1] } : { error: 'nope', code: 'PROJECT_UNKNOWN' }));
    }
    if (req.url === '/api/instances') return res.end(JSON.stringify(instances));
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

/** An unused loopback URL: a cc that is down. */
export async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

/** The backend on port 0 with its own temp store. Returns `{base, storeDir, get, post, del, mcp}`. */
export async function startApp(t, { ccUrl = null, limits, distDir, storeDir, unconfigured = false } = {}) {
  const dir = unconfigured ? null : (storeDir ?? path.join(await tmp(t), 'store'));
  const server = await createServer({ storeDir: dir, ccUrl, limits, ...(distDir && { distDir }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'content-type': 'application/json' };
  const send = async (method, url, body, headers = json) => {
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text, headers: res.headers };
  };
  return {
    base, storeDir: dir,
    get: (url) => send('GET', url),
    post: (url, body) => send('POST', url, body),
    del: (url) => send('DELETE', url, undefined),
    mcp: (tool, args, caller = { sessionId: 'sess-1', project: 'proj-a' }) => send('POST', '/api/mcp', { tool, arguments: args, caller }),
    raw: send,
  };
}

/** Publishes through the MCP endpoint and returns the result, failing on an error. */
export async function publish(app, args, caller) {
  const { data } = await app.mcp('publish_artifact', args, caller);
  if (data.error) throw new Error(data.error);
  return data.result;
}
