import fsp from 'node:fs/promises';
import { Refusal } from './refusal.js';

/** The file at an app source's root that declares how to run it. */
export const APP_MANIFEST = 'artifact.json';
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const PREFIX_MODES = ['strip', 'keep'];

const KEYS = ['start', 'install', 'prefix'];
const invalid = (msg) => new Refusal('APP_MANIFEST_INVALID', `${APP_MANIFEST}: ${msg}`);

function command(obj, key, required) {
  const v = obj[key];
  if (v === undefined) {
    if (required) throw invalid(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length < 1 || v.length > 4096) throw invalid(`${key} must be a string of 1-4096 characters`);
  if (key === 'start' && v.trim() === '') throw invalid('start must not be blank');
  return v;
}

/** Parses and validates the manifest (a Buffer or string) into `{start, install?, prefix}`; `prefix` is always filled in. */
export function parseAppManifest(input) {
  if (Buffer.byteLength(input) > MAX_MANIFEST_BYTES) throw invalid(`larger than ${MAX_MANIFEST_BYTES} bytes`);
  let text = input;
  if (typeof input !== 'string') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { throw invalid('not valid UTF-8'); }
  }
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw invalid(`not valid JSON (${e.message})`); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw invalid('must be a JSON object');
  for (const k of Object.keys(obj)) if (!KEYS.includes(k)) throw invalid(`unknown key ${JSON.stringify(k)}; allowed: ${KEYS.join(', ')}`);
  const start = command(obj, 'start', true);
  const install = command(obj, 'install', false);
  const prefix = obj.prefix ?? 'strip';
  if (!PREFIX_MODES.includes(prefix)) throw invalid(`prefix must be one of ${PREFIX_MODES.join(', ')}`);
  return { start, ...(install !== undefined ? { install } : {}), prefix };
}

/** Reads and parses the manifest file at `file`, refusing an oversized one before reading it. */
export async function readAppManifest(file) {
  if ((await fsp.stat(file)).size > MAX_MANIFEST_BYTES) throw invalid(`larger than ${MAX_MANIFEST_BYTES} bytes`);
  return parseAppManifest(await fsp.readFile(file));
}
