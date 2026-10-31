import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { Refusal } from './refusal.js';
import { LIMITS } from './limits.js';

const TAR_RE = /\.(tar\.gz|tgz)$/i;
const SAFE_TYPES = new Set(['File', 'OldFile', 'Directory']);

/** The path segments of an archive entry name, or null when the name is unsafe. `.` and empty segments are dropped. */
export function entrySegments(name) {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const segs = name.split('/').filter((s) => s !== '' && s !== '.');
  return segs.includes('..') ? null : segs;
}

/**
 * Lists a tarball without extracting it, refusing anything the extraction must not see.
 * Resolves to `{rootEntries, strip}`; `strip` is 1 when the archive's sole root entry is a directory.
 */
async function listTarball(file, limits) {
  const entries = []; // {segs, dir}
  let bytes = 0;
  const parser = new tar.Parser({
    strict: true,
    onReadEntry(entry) {
      entry.resume(); // a bare Parser leaves the entry paused
      const fail = (code, msg) => parser.abort(new Refusal(code, msg));
      const segs = entrySegments(entry.path);
      if (!SAFE_TYPES.has(entry.type)) return fail('UNSAFE_ENTRY', `archive entry ${entry.path} is a ${entry.type}`);
      if (!segs) return fail('UNSAFE_ENTRY', `archive entry ${entry.path} has an unsafe path`);
      if (segs.length === 0) return;
      bytes += entry.size ?? 0;
      entries.push({ segs, dir: entry.type === 'Directory' });
      if (bytes > limits.maxBytes || entries.length > limits.maxFiles) fail('TOO_LARGE', 'archive exceeds the size or file-count cap');
    },
  });
  const source = fs.createReadStream(file);
  await new Promise((resolve, reject) => {
    parser.on('error', (e) => { source.destroy(); reject(e instanceof Refusal ? e : new Refusal('BAD_ARCHIVE', `not a readable tar.gz: ${e.message}`)); });
    parser.on('end', resolve);
    source.on('error', reject);
    source.pipe(parser);
  });

  // Names at depth `d` under the first `d` segments; an entry is a directory when it is one or has children.
  const level = (depth) => {
    const seen = new Map();
    for (const { segs, dir } of entries) {
      if (segs.length <= depth) continue;
      const name = segs[depth];
      seen.set(name, (seen.get(name) ?? false) || dir || segs.length > depth + 1);
    }
    return seen;
  };
  let strip = 0;
  let roots = level(0);
  if (roots.size === 1 && [...roots.values()][0]) {
    strip = 1;
    const top = [...roots.keys()][0];
    const inner = new Map();
    for (const { segs, dir } of entries) {
      if (segs[0] !== top || segs.length < 2) continue;
      inner.set(segs[1], (inner.get(segs[1]) ?? false) || dir || segs.length > 2);
    }
    roots = inner;
  }
  return {
    rootEntries: [...roots].map(([name, dir]) => ({ name, dir })),
    strip,
  };
}

/**
 * Describes the source at `absPath`. A tarball is listed (and so validated) only when `explicitKind`
 * leaves its contents relevant: no explicit kind, or `static`.
 */
export async function inspectSource(absPath, explicitKind, limits = LIMITS) {
  if (typeof absPath !== 'string' || absPath.includes('\0')) throw new Refusal('INVALID_ARGUMENT', 'path must be a string');
  if (!path.isAbsolute(absPath)) throw new Refusal('PATH_NOT_ABSOLUTE', `path must be absolute: ${absPath}`);
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Refusal('PATH_NOT_FOUND', `no such path: ${absPath}`);
    throw e;
  }
  const name = path.basename(absPath) || 'download';
  const info = { path: absPath, name, size: st.size, rootEntries: [], strip: 0 };
  if (st.isDirectory()) {
    const dirents = await fsp.readdir(absPath, { withFileTypes: true });
    return { ...info, type: 'dir', rootEntries: dirents.map((d) => ({ name: d.name, dir: d.isDirectory() })) };
  }
  if (!st.isFile()) throw new Refusal('UNSUPPORTED_SOURCE', `${absPath} is neither a regular file nor a directory`);
  if (!TAR_RE.test(name)) return { ...info, type: 'file' };
  if (explicitKind !== undefined && explicitKind !== 'static') return { ...info, type: 'tar' };
  const listing = await listTarball(absPath, limits);
  return { ...info, type: 'tar', rootEntries: listing.rootEntries, strip: listing.strip };
}
