import path from 'node:path';
import { Refusal } from './refusal.js';

export const DATA_DIR_ENV = 'CONDUCTOR_PLUGIN_DATA_DIR';
const FIX = `code-conductor sets ${DATA_DIR_ENV}; standalone, set it to an absolute directory path`;

/** The STORE_UNCONFIGURED refusal; `why` names what is wrong. */
export const storeUnconfigured = (why = 'no store is configured') => new Refusal('STORE_UNCONFIGURED', `${why}: ${FIX}`);

/** Root dir of the artifact store, from CONDUCTOR_PLUGIN_DATA_DIR only; resolved on every call so tests and late env changes apply. */
export function storeRoot() {
  const dir = process.env[DATA_DIR_ENV];
  if (!dir) throw storeUnconfigured(`${DATA_DIR_ENV} is not set`);
  if (!path.isAbsolute(dir)) throw storeUnconfigured(`${DATA_DIR_ENV} must be an absolute path, got ${JSON.stringify(dir)}`);
  return dir;
}

/** The conductor's base URL, or null when running standalone. */
export const ccUrl = () => process.env.CONDUCTOR_URL?.replace(/\/+$/, '') || null;
