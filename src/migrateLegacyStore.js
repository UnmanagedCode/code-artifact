// One-shot, idempotent boot move of the legacy artifact store (<PROJECTS_ROOT>/.code-artifact) into the plugin data dir.
// This is the only code that names the legacy path. A refusal never moves or changes store data, but it may leave the
// empty parent dirs it created, and an empty target it removed stays removed.
// Delete this file and its server.js call once no install keeps a legacy store.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const LEGACY_DIRNAME = '.code-artifact';
const RESTART = 'then restart code-artifact';

/** Moves the legacy store to `dataDir`. Returns 'no-root' | 'absent' | 'same' | 'moved'; throws Error{code:'ESTOREMIGRATE'} on refusal. */
export async function migrateLegacyStore({ env, dataDir, rename = fsp.rename, log = console }) {
  if (!env.PROJECTS_ROOT) return 'no-root';
  const legacy = path.join(path.resolve(env.PROJECTS_ROOT), LEGACY_DIRNAME);
  const target = path.resolve(dataDir);
  if (legacy === target) return 'same';

  const refuse = (reason, fix, cause) => Object.assign(
    new Error(`code-artifact: cannot move the store ${legacy} to ${target}: ${reason}; ${fix}`, { cause }),
    { code: 'ESTOREMIGRATE' },
  );
  const lstatOrNull = async (p) => {
    try { return await fsp.lstat(p); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw refuse(`cannot inspect ${p}: ${e.message}`, `fix its permissions, ${RESTART}`, e);
    }
  };

  const legacyStat = await lstatOrNull(legacy);
  if (!legacyStat) return 'absent';
  if (!legacyStat.isDirectory()) throw refuse(`${legacy} is not a directory`, `move or remove it, ${RESTART}`);

  const targetStat = await lstatOrNull(target);
  if (targetStat) {
    if (!targetStat.isDirectory()) throw refuse(`${target} exists and is not a directory`, `move or remove it, ${RESTART}`);
    let entries;
    try { entries = await fsp.readdir(target); } catch (e) {
      throw refuse(`cannot read ${target}: ${e.message}`, `fix its permissions, ${RESTART}`, e);
    }
    if (entries.length) {
      throw refuse(`${target} is not empty, so nothing was moved`,
        `keep one: delete ${legacy} to use ${target} as is, or delete ${target} to move ${legacy} on the next start`);
    }
    try { await fsp.rmdir(target); } catch (e) {
      throw refuse(`cannot replace the empty ${target}: ${e.message}`, `fix its permissions, ${RESTART}`, e);
    }
  }

  const parent = path.dirname(target);
  try { await fsp.mkdir(parent, { recursive: true, mode: 0o755 }); } catch (e) {
    throw refuse(`cannot create ${parent}: ${e.message}`, `create it or fix its permissions, ${RESTART}`, e);
  }

  try { await rename(legacy, target); } catch (e) {
    if (e.code === 'EXDEV') {
      throw refuse('they are on different filesystems, so nothing was moved',
        `with code-artifact stopped, run \`mv '${legacy}' '${target}'\` (keeps modes), then restart code-artifact`, e);
    }
    throw refuse(e.message, `move it yourself, ${RESTART}`, e);
  }
  log.log(`code-artifact: moved the store from ${legacy} to ${target}`);
  return 'moved';
}
