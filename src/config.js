import path from 'node:path';
import { Refusal } from './refusal.js';

/** Root dir of the artifact store; resolved on every call so tests and late env changes apply. */
export function storeRoot() {
  if (process.env.CODE_ARTIFACT_STORE) return process.env.CODE_ARTIFACT_STORE;
  if (process.env.PROJECTS_ROOT) return path.join(process.env.PROJECTS_ROOT, '.code-artifact');
  throw new Refusal('STORE_UNCONFIGURED', 'set CODE_ARTIFACT_STORE or PROJECTS_ROOT');
}

/** The conductor's base URL, or null when running standalone. */
export const ccUrl = () => process.env.CONDUCTOR_URL?.replace(/\/+$/, '') || null;
