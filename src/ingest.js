import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { Refusal } from './refusal.js';
import { LIMITS } from './limits.js';
import { renderMarkdown } from './markdown.js';
import { APP_MANIFEST, readAppManifest } from './appManifest.js';

/** The directory under a staging dir that holds the served content. */
export const CONTENT = 'content';
/** The sanitized markdown body, beside `content/`. */
export const RENDERED = 'rendered.html';

const SAFE_TYPES = new Set(['File', 'OldFile', 'Directory']);
const unsafe = (rel, what) => new Refusal('UNSAFE_ENTRY', `${rel}: ${what}`);
const tooLarge = () => new Refusal('TOO_LARGE', 'source exceeds the size or file-count cap');

/**
 * Walks `root` with lstat. Refuses a symlink or any non-file, non-directory entry, and a name with a backslash.
 * Resolves to `{dirs, files: [{rel, size}], bytes}`; dirs come parents-first.
 */
export async function walkTree(root, limits = LIMITS) {
  const dirs = [];
  const files = [];
  let bytes = 0;
  const queue = [''];
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    for (const name of await fsp.readdir(path.join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (name.includes('\\')) throw unsafe(r, 'name contains a backslash');
      const st = await fsp.lstat(path.join(root, r));
      if (st.isDirectory()) {
        dirs.push(r);
        queue.push(r);
      } else if (st.isFile()) {
        files.push({ rel: r, size: st.size });
        bytes += st.size;
      } else {
        throw unsafe(r, 'symlinks and special files are not allowed');
      }
      if (bytes > limits.maxBytes || files.length + dirs.length > limits.maxFiles) throw tooLarge();
    }
  }
  return { dirs, files, bytes };
}

async function copyTree(from, to, walked) {
  await fsp.mkdir(to, { recursive: true });
  for (const d of walked.dirs) await fsp.mkdir(path.join(to, d));
  for (const f of walked.files) {
    await fsp.copyFile(path.join(from, f.rel), path.join(to, f.rel), constants.COPYFILE_EXCL);
  }
}

/** A root `v/<n>` would be shadowed by the pinned-version route. */
async function checkReserved(contentDir) {
  let children;
  try {
    children = await fsp.readdir(path.join(contentDir, 'v'));
  } catch {
    return;
  }
  if (children.some((c) => /^[0-9]+$/.test(c))) {
    throw new Refusal('RESERVED_PATH', 'a root v/<number> directory is reserved for pinned-version URLs; rename it');
  }
}

async function extractTarball(info, contentDir, limits) {
  await fsp.mkdir(contentDir, { recursive: true });
  try {
    await tar.x({
      file: info.path,
      cwd: contentDir,
      strip: info.strip,
      strict: true,
      filter: (_p, entry) => SAFE_TYPES.has(entry.type),
    });
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal('BAD_ARCHIVE', `cannot extract archive: ${e.message}`);
  }
  const walked = await walkTree(contentDir, limits); // refuses whatever the extraction left that is not a plain file or dir
  return walked;
}

/**
 * Copies `info`'s source into `stagingDir` as `content/` (plus `rendered.html` for markdown).
 * Resolves to `{bytes, files, file?, app?}`: `file` is the stored name for markdown and download, `app` the parsed manifest.
 * The source is never modified. On failure the caller removes `stagingDir`.
 */
export async function stageContent(info, kind, stagingDir, limits = LIMITS) {
  const contentDir = path.join(stagingDir, CONTENT);
  const copyFileTo = async (name) => {
    await fsp.mkdir(contentDir, { recursive: true });
    await fsp.copyFile(info.path, path.join(contentDir, name), constants.COPYFILE_EXCL);
  };

  if (kind === 'markdown') {
    if (info.size > limits.maxMarkdownBytes) throw new Refusal('TOO_LARGE', `markdown source exceeds ${limits.maxMarkdownBytes} bytes`);
    await copyFileTo(info.name);
    const text = await fsp.readFile(path.join(contentDir, info.name), 'utf8');
    await fsp.writeFile(path.join(stagingDir, RENDERED), renderMarkdown(text));
    return { bytes: info.size, files: 1, file: info.name };
  }

  if (kind === 'download') {
    if (info.type !== 'dir') {
      if (info.size > limits.maxBytes) throw tooLarge();
      await copyFileTo(info.name);
      return { bytes: info.size, files: 1, file: info.name };
    }
    const walked = await walkTree(info.path, limits);
    const file = `${info.name}.tar.gz`;
    await fsp.mkdir(contentDir, { recursive: true });
    await tar.c({ gzip: true, portable: true, file: path.join(contentDir, file), cwd: info.path }, ['.']);
    const { size } = await fsp.stat(path.join(contentDir, file));
    return { bytes: size, files: walked.files.length, file };
  }

  // static or app
  let walked;
  if (info.type === 'file') {
    if (info.size > limits.maxBytes) throw tooLarge();
    await copyFileTo('index.html');
    return { bytes: info.size, files: 1 };
  }
  if (info.type === 'dir') {
    walked = await walkTree(info.path, limits);
    await copyTree(info.path, contentDir, walked);
  } else {
    walked = await extractTarball(info, contentDir, limits);
  }
  if (kind === 'app') {
    const app = await readAppManifest(path.join(contentDir, APP_MANIFEST));
    return { bytes: walked.bytes, files: walked.files.length, app };
  }
  await checkReserved(contentDir);
  return { bytes: walked.bytes, files: walked.files.length };
}
