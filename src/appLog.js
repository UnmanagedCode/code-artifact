import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * An app's log is a file, never a pipe: a pipe whose reader is gone makes the app spin on EPIPE.
 * stdout and stderr of every process of a run share one O_APPEND fd on `file`.
 */

/** Moves the previous run's log to `file.1` and opens a fresh `file`; resolves to the fd (the caller closes it). */
export async function openRunLog(file) {
  try {
    await fsp.rename(file, `${file}.1`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return fs.openSync(file, 'a');
}

/** Appends one `[code-artifact] …` line, written by the host itself. */
export const note = (file, line) => fsp.appendFile(file, `[code-artifact] ${line}\n`);

/**
 * A rotation check for `file`, called on a timer: when the log exceeds `cap` bytes, its last `cap` bytes go to `file.1`
 * and it is truncated. A round where the app wrote between the stat and the read is skipped (the tail could be partial),
 * but at most `maxSkips` rounds in a row: an app that writes continuously is rotated anyway, with a possibly partial tail.
 * `afterStat` is a test seam that runs between the stat and the read.
 */
export function createRotator(file, cap, { maxSkips = 1, afterStat = async () => {} } = {}) {
  let skipped = 0;
  return async function rotate() {
    let size;
    try { size = (await fsp.stat(file)).size; } catch { return; }
    if (size <= cap) { skipped = 0; return; }
    await afterStat();
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(cap);
      const { bytesRead } = await handle.read(buf, 0, cap, size - cap);
      if ((await handle.stat()).size !== size && skipped < maxSkips) { skipped++; return; }
      await fsp.writeFile(`${file}.1`, buf.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    skipped = 0;
    await fsp.truncate(file, 0);
  };
}

/** The last `bytes` bytes of `file` as text; empty when there is no file yet. */
export async function readTail(file, bytes) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
  try {
    const { size } = await handle.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, size - len);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
