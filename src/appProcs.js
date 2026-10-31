import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';

/** The OS layer under the app host: process groups, `/proc` scans and port probing. No app state lives here. */

/** The env var that marks a process as ours: `<artifact id>@<real path of the store root>`. */
export const RUN_MARKER = 'CODE_ARTIFACT_RUN';
export const HAS_PROC = fs.existsSync('/proc/self/stat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `cmd` with `/bin/sh -c` as the leader of a new process group; stdout and stderr go to `logFd`. */
export function spawnGroup(cmd, { cwd, env, logFd }) {
  return spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', logFd, logFd] });
}

/** `{state, ppid, pgrp}` from the text of a /proc/<pid>/stat. `comm` may hold spaces and parens. */
export function parseStat(text) {
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]) };
}

/** `parseStat` of a live /proc/<pid>/stat, or null when the process is gone. */
async function procStat(pid) {
  try {
    return parseStat(await fsp.readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Dead means gone, a zombie (`Z`) or being reaped (`X`): both are finished, though a container's PID 1 may be slow to collect them. */
export const isDead = (st) => st === null || st.state === 'Z' || st.state === 'X';

const numericPids = async () => (await fsp.readdir('/proc')).filter((n) => /^[0-9]+$/.test(n)).map(Number);

/** Alive means not dead (`isDead`): kill(pid, 0) succeeds on a zombie, and a container's PID 1 may never reap. */
export async function pidAlive(pid) {
  if (!HAS_PROC) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  const st = await procStat(pid);
  return !isDead(st);
}

/** True while any live process is in group `pgid`. */
export async function groupAlive(pgid) {
  if (!HAS_PROC) {
    try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  for (const pid of await numericPids()) {
    const st = await procStat(pid);
    if (st && st.pgrp === pgid && !isDead(st)) return true;
  }
  return false;
}

function signal(target, sig) {
  try { process.kill(target, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}

async function waitUntil(done, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
}

/** SIGTERMs group `pgid`, then SIGKILLs it after `graceMs`; resolves once it is gone (or one more second has passed). */
export async function killGroup(pgid, graceMs) {
  signal(-pgid, 'SIGTERM');
  if (await waitUntil(async () => !(await groupAlive(pgid)), graceMs)) return;
  signal(-pgid, 'SIGKILL');
  await waitUntil(async () => !(await groupAlive(pgid)), 1000);
}

/** `[{pid, id, pgrp}]` of every process whose marker names this store (and `id`, when given), found via /proc/<pid>/environ. */
export async function markedPids(storeReal, id) {
  if (!HAS_PROC) return [];
  const found = [];
  for (const pid of await numericPids()) {
    if (pid === process.pid) continue;
    let environ;
    try { environ = await fsp.readFile(`/proc/${pid}/environ`); } catch { continue; } // another uid, or gone
    for (const entry of environ.toString('latin1').split('\0')) {
      if (!entry.startsWith(`${RUN_MARKER}=`)) continue;
      const value = entry.slice(RUN_MARKER.length + 1);
      const at = value.indexOf('@');
      if (at < 0 || value.slice(at + 1) !== storeReal) break;
      const owner = value.slice(0, at);
      if (id !== undefined && owner !== id) break;
      const st = await procStat(pid);
      if (!isDead(st)) found.push({ pid, id: owner, pgrp: st.pgrp });
      break;
    }
  }
  return found;
}

/**
 * Kills every marked process and resolves `{reaped, survivors}`: how many distinct pids were seen, and the pids still live at
 * the deadline. Round one SIGTERMs, waiting `graceMs`; later rounds rescan and SIGKILL. It ends after two consecutive scans
 * find nothing live, because a process that was alive at one scan can spawn marked children the scan never saw, and a
 * SIGKILLed process cannot. Marked group leaders take their group with them. Worst case `graceMs` + 1 s.
 */
export async function reapMarked(storeReal, id, graceMs) {
  const deadline = Date.now() + graceMs + 1000;
  const seen = new Set();
  let clean = 0;
  let term = true;
  while (clean < 2 && Date.now() < deadline) {
    const marked = await markedPids(storeReal, id);
    if (marked.length === 0) { clean++; continue; }
    clean = 0;
    for (const m of marked) seen.add(m.pid);
    const leaders = new Set(marked.filter((m) => m.pgrp === m.pid).map((m) => m.pid));
    for (const m of marked) signal(leaders.has(m.pgrp) ? -m.pgrp : m.pid, term ? 'SIGTERM' : 'SIGKILL');
    const allGone = async () => {
      for (const m of marked) if (await pidAlive(m.pid)) return false;
      return true;
    };
    await waitUntil(allGone, term ? graceMs : Math.max(0, deadline - Date.now()));
    term = false;
  }
  const survivors = clean >= 2 ? [] : (await markedPids(storeReal, id)).map((m) => m.pid);
  return { reaped: seen.size, survivors };
}

/** A currently unused loopback port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const connects = (port, host) => new Promise((resolve) => {
  const s = net.connect({ port, host });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(500, () => done(false));
});

/** The loopback address that accepts a TCP connection on `port` (`127.0.0.1` preferred), or null. */
export async function probe(port) {
  const [v4, v6] = await Promise.all([connects(port, '127.0.0.1'), connects(port, '::1')]);
  if (v4) return '127.0.0.1';
  return v6 ? '::1' : null;
}
