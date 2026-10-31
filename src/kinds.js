import { Refusal } from './refusal.js';
import { APP_MANIFEST } from './appManifest.js';

export const KINDS = ['markdown', 'static', 'download', 'app'];

const isHtml = (name) => /\.html?$/i.test(name);
const hasRoot = (info, name) => info.rootEntries.some((e) => e.name === name && !e.dir);

/** What a source looks like it is, before any explicit kind is applied. */
function infer(info) {
  if (info.type === 'file') {
    if (/\.md$/i.test(info.name)) return 'markdown';
    return isHtml(info.name) ? 'static' : 'download';
  }
  if (hasRoot(info, APP_MANIFEST)) return 'app';
  return hasRoot(info, 'index.html') ? 'static' : 'download';
}

function compatible(info, kind) {
  switch (kind) {
    case 'markdown': return info.type === 'file';
    case 'static': return info.type === 'file' ? isHtml(info.name) : hasRoot(info, 'index.html');
    case 'app': return info.type !== 'file' && hasRoot(info, APP_MANIFEST);
    default: return true; // download keeps any source
  }
}

/** The kind to publish `info` as: `explicit` when given, else inferred; refused when the source does not fit it. */
export function resolveKind(info, explicit) {
  if (explicit !== undefined && !KINDS.includes(explicit)) {
    throw new Refusal('INVALID_ARGUMENT', `kind must be one of ${KINDS.join(', ')}`);
  }
  const kind = explicit ?? infer(info);
  if (!compatible(info, kind)) {
    throw new Refusal('KIND_SOURCE_MISMATCH', `${info.name} (${info.type}) cannot be published as kind "${kind}"`);
  }
  return kind;
}

