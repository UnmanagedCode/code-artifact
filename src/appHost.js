import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Refusal } from './refusal.js';
import { CONTENT } from './ingest.js';
import { MOUNT, appBasePath } from './links.js';
import { note, openRunLog, rotateIfOver } from './appLog.js';
import { HAS_PROC, RUN_MARKER, freePort, killGroup, probe, reapMarked, spawnGroup } from './appProcs.js';

/** Timings in ms (and the log cap in bytes); tests inject shorter ones. */
export const APP_TIMINGS = Object.freeze({
  graceMs: 3000, // SIGTERM → SIGKILL; cc's own grace for the backend is 3 s
  shutdownGraceMs: 2000, // the whole backend shutdown must fit inside cc's grace
  startTimeoutMs: 60_000,
  installTimeoutMs: 15 * 60_000,
  probeMs: 200,
  logCheckMs: 10_000,
  logCapBytes: 1024 * 1024,
});

const ACTIVE = new Set(['installing', 'starting', 'running']);
const rmrf = (p) => fsp.rm(p, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fsp.access(p).then(() => true, () => false);
const exitText = (code, sig) => (sig ? `killed by ${sig}` : `exited with code ${code}`);

/**
 * Owns the processes of every app artifact: one per artifact, always the latest version, state in memory only.
 * `store` is a Store or a function returning one; `storeDir` (may be null) scopes the orphan sweep.
 *
 * Lock order: ops takes a per-id lock here first, or the store's mutex first and then calls `restartIfActive`;
 * nothing here calls into the store while holding the store's mutex, so there is no cycle.
 */
export function createAppHost({ store: storeOrGetter, storeDir = null, mount = MOUNT, timings = {} }) {
  const t = { ...APP_TIMINGS, ...timings };
  const getStore = () => (typeof storeOrGetter === 'function' ? storeOrGetter() : storeOrGetter);
  const states = new Map(); // id → run state; replaced (never mutated back to active) on each Start
  const locks = new Map();
  const bootedAt = new Date().toISOString();
  let closed = false;
  let storeRealPromise = null;
  const storeReal = () => (storeRealPromise ??= fsp.realpath(storeDir));

  const isActive = (s) => ACTIVE.has(s.status) && !s.stopping;
  // A run's callbacks act only while it is still the current run, not stopping and not already failed.
  const alive = (id, s) => states.get(id) === s && !s.stopping && s.status !== 'failed';
  const publicStatus = (s) => (s
    ? { status: s.status, version: s.version, error: s.error, since: s.since }
    : { status: 'stopped', version: null, error: null, since: bootedAt });

  function locked(id, fn) {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  const logNote = (id, line) => note(getStore().logFile(id), line).catch(() => {});

  /** Clears a run's timers and closes its log fd; idempotent. */
  function release(s) {
    clearInterval(s.logTimer);
    if (s.logFd !== null) {
      try { fs.closeSync(s.logFd); } catch { /* already closed */ }
      s.logFd = null;
    }
  }

  function fail(id, s, message) {
    if (!alive(id, s)) return;
    s.status = 'failed';
    s.error = message;
    s.since = new Date().toISOString();
    void logNote(id, `failed: ${message}`);
    release(s);
    s.cleanup = (async () => {
      if (s.pgid) await killGroup(s.pgid, t.graceMs);
      if (HAS_PROC && storeDir) await reapMarked(await storeReal(), id, t.graceMs);
    })().catch((e) => console.error(`code-artifact: cleanup of ${id} failed:`, e));
  }

  /** The env of an install (no PORT) or a start (PORT set by the caller). */
  const envFor = (id, s) => {
    const env = { ...process.env, BASE_PATH: s.basePath, DATA_DIR: getStore().dataDir(id), [RUN_MARKER]: s.marker };
    delete env.PORT; // the backend's own
    return env;
  };

  /** Runs the install command in its own group; resolves `{ok}` or `{ok:false, reason}`. */
  function runInstall(id, s, cmd, cwd, env) {
    return new Promise((resolve) => {
      let timedOut = false;
      const child = spawnGroup(cmd, { cwd, env, logFd: s.logFd });
      s.child = child;
      s.pgid = child.pid;
      const timer = setTimeout(() => {
        timedOut = true;
        void killGroup(child.pid, t.graceMs);
      }, t.installTimeoutMs);
      timer.unref();
      child.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: `install could not start: ${e.message}` }); });
      child.once('exit', (code, sig) => {
        clearTimeout(timer);
        const reason = timedOut ? 'install timed out' : `install ${exitText(code, sig)}`;
        resolve({ ok: code === 0 && !timedOut, reason });
      });
    });
  }

  async function launch(id, s, version, installed) {
    const st = getStore();
    const n = version.n;
    const run = st.runDir(id, n);
    const marker = st.installedMarker(id, n);
    await fsp.mkdir(st.dataDir(id), { recursive: true });
    if (!installed) {
      await rmrf(run);
      await fsp.cp(path.join(st.versionDir(id, n), CONTENT), run, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      if (!alive(id, s)) return;
      if (version.app.install) {
        void logNote(id, `install v${n}: ${version.app.install}`);
        const result = await runInstall(id, s, version.app.install, run, envFor(id, s));
        if (s.pgid) await killGroup(s.pgid, t.graceMs); // anything the install left running
        s.pgid = null;
        if (!alive(id, s)) return;
        if (!result.ok) return fail(id, s, result.reason);
      }
      await fsp.writeFile(marker, '');
    }

    const port = await freePort();
    if (!alive(id, s)) return;
    s.port = port;
    s.status = 'starting';
    s.since = new Date().toISOString();
    const env = { ...envFor(id, s), PORT: String(port) };
    void logNote(id, `start v${n} on port ${port}: ${version.app.start}`);
    const child = spawnGroup(version.app.start, { cwd: run, env, logFd: s.logFd });
    s.child = child;
    s.pgid = child.pid;
    child.once('error', (e) => fail(id, s, `could not start: ${e.message}`));
    child.once('exit', (code, sig) => {
      if (!alive(id, s)) return;
      fail(id, s, s.status === 'starting' ? `${exitText(code, sig)} before listening on port ${port}` : exitText(code, sig));
    });

    const deadline = Date.now() + t.startTimeoutMs;
    while (alive(id, s) && s.status === 'starting') {
      const host = await probe(port);
      if (!alive(id, s) || s.status !== 'starting') return;
      if (host) {
        s.host = host;
        s.status = 'running';
        s.since = new Date().toISOString();
        void logNote(id, `running v${n} on ${host}:${port}`);
        return;
      }
      if (Date.now() >= deadline) return fail(id, s, `did not listen on port ${port} within ${t.startTimeoutMs / 1000}s`);
      await sleep(t.probeMs);
    }
  }

  async function startLocked(id) {
    if (closed) throw new Error('the app host is shut down');
    const st = getStore();
    const record = await st.get(id);
    if (!record) throw new Refusal('ARTIFACT_UNKNOWN', `no artifact ${id}`);
    if (record.kind !== 'app') throw new Refusal('NOT_AN_APP', `artifact ${id} is a ${record.kind}, not an app`);
    const prev = states.get(id);
    if (prev && isActive(prev)) return publicStatus(prev);
    await prev?.cleanup;
    const marker = `${id}@${await storeReal()}`;
    const version = record.versions[record.versions.length - 1];
    const installed = (await exists(st.installedMarker(id, version.n))) && (await exists(st.runDir(id, version.n)));
    const s = {
      status: installed ? 'starting' : 'installing', version: version.n, error: null, since: new Date().toISOString(),
      stopping: false, child: null, pgid: null, port: null, host: null, logFd: null, logTimer: null, launching: null, cleanup: null,
      marker, prefix: version.app.prefix, basePath: appBasePath(id, mount),
    };
    s.logFd = await openRunLog(st.logFile(id));
    s.logTimer = setInterval(() => { rotateIfOver(st.logFile(id), t.logCapBytes).catch(() => {}); }, t.logCheckMs);
    s.logTimer.unref();
    states.set(id, s);
    s.launching = launch(id, s, version, installed).catch((e) => fail(id, s, `internal error: ${e.message}`));
    return publicStatus(s);
  }

  /** Stops an active run and waits for its processes to be gone; `grace` bounds the SIGTERM wait. */
  async function halt(id, s, grace) {
    s.stopping = true;
    if (s.pgid) await killGroup(s.pgid, grace);
    await s.launching;
    if (s.pgid) await killGroup(s.pgid, grace);
    if (HAS_PROC && storeDir) await reapMarked(await storeReal(), id, grace);
    await logNote(id, 'stopped');
    release(s);
    states.set(id, { status: 'stopped', version: null, error: null, since: new Date().toISOString() });
  }

  async function stopLocked(id) {
    const s = states.get(id);
    if (s && s.status === 'failed') {
      await s.cleanup;
      states.set(id, { status: 'stopped', version: null, error: null, since: new Date().toISOString() });
    } else if (s && isActive(s)) {
      await halt(id, s, t.graceMs);
    }
    return publicStatus(states.get(id));
  }

  return {
    status: (id) => publicStatus(states.get(id)),
    activeVersion: (id) => {
      const s = states.get(id);
      return s && isActive(s) ? s.version : null;
    },
    start: (id) => locked(id, () => startLocked(id)),
    stop: (id) => locked(id, () => stopLocked(id)),

    /** After an update: an active app restarts on the new latest version; a stopped one stays stopped. */
    restartIfActive: (id) => locked(id, async () => {
      const s = states.get(id);
      if (!s || !isActive(s)) return publicStatus(s);
      await stopLocked(id);
      return startLocked(id);
    }),

    /** Runs `fn` under the id's lock, first stopping the app: always for `'any'`, or only when it runs version `stopVersion`. */
    exclusive: (id, fn, { stopVersion = 'any' } = {}) => locked(id, async () => {
      const s = states.get(id);
      if (s && (stopVersion === 'any' || s.version === stopVersion)) await stopLocked(id);
      const result = await fn();
      if (stopVersion === 'any') states.delete(id);
      return result;
    }),

    /** Whether `id` is an app artifact: `'app'`, `'other'` or `'none'`. */
    async kindOf(id) {
      const record = await getStore().get(id);
      if (!record) return 'none';
      return record.kind === 'app' ? 'app' : 'other';
    },

    /** Where to proxy to, or null unless the app is running. */
    target(id) {
      const s = states.get(id);
      if (!s || s.status !== 'running' || s.stopping) return null;
      return { host: s.host, port: s.port, basePath: s.basePath, prefix: s.prefix, mount };
    },

    /** Boot: kills what a crashed or SIGKILLed backend left behind. Apps do not come back. */
    async reapOrphans() {
      if (!storeDir) return;
      if (!HAS_PROC) {
        console.warn('code-artifact: no /proc here, so orphaned app processes are not reaped');
        return;
      }
      const n = await reapMarked(await storeReal(), undefined, t.graceMs);
      if (n > 0) console.warn(`code-artifact: reaped ${n} orphaned app process(es)`);
    },

    /** Stops every app within `shutdownGraceMs`; the backend is going away. */
    async shutdown() {
      closed = true;
      const active = [...states].filter(([, s]) => isActive(s));
      await Promise.all(active.map(([id, s]) => halt(id, s, t.shutdownGraceMs).catch((e) => console.error(`code-artifact: stopping ${id} failed:`, e))));
      if (storeDir && HAS_PROC) await reapMarked(await storeReal(), undefined, t.shutdownGraceMs);
    },
  };
}
