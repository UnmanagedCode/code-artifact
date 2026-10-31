import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Refusal } from './refusal.js';
import { CONTENT } from './ingest.js';
import { MOUNT, appBasePath } from './links.js';
import { createRotator, note, openRunLog } from './appLog.js';
import * as realProcs from './appProcs.js';

const { HAS_PROC, RUN_MARKER } = realProcs;

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
 * Lock order: ops takes a per-id lock here first (`exclusive`, `committing`), and the store's mutex only inside it;
 * nothing here calls into the store while holding the store's mutex, so there is no cycle.
 */
export function createAppHost({ store: storeOrGetter, storeDir = null, mount = MOUNT, timings = {}, procs = realProcs }) {
  const { freePort, killGroup, probe, reapMarked, spawnGroup } = procs; // `procs` is a test seam: fake processes
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

  /** Kills every process marked for `id` (every app when undefined); resolves how many were found, 0 without /proc or a store. */
  async function sweep(id, grace) {
    if (!HAS_PROC || !storeDir) return 0;
    const { reaped, survivors } = await reapMarked(await storeReal(), id, grace);
    if (survivors.length > 0) console.error(`code-artifact: ${survivors.length} marked process(es) survived the sweep: pid ${survivors.join(', ')}`);
    return reaped;
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
      await sweep(id, t.graceMs);
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
      await rmrf(marker); // first: a marker must always imply a complete run/
      await rmrf(run);
      await fsp.cp(path.join(st.versionDir(id, n), CONTENT), run, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      if (!alive(id, s)) return;
      if (version.app.install) {
        void logNote(id, `install v${n}: ${version.app.install}`);
        const result = await runInstall(id, s, version.app.install, run, envFor(id, s));
        if (s.pgid && !s.stopping) await killGroup(s.pgid, t.graceMs); // anything the install left running (a stop kills it itself)
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
    // Checked in the same synchronous step as states.set: shutdown() snapshots states after setting `closed`,
    // so a run is either in that snapshot or refused here, and nothing spawns after shutdown resolves.
    if (closed) {
      fs.closeSync(s.logFd);
      throw new Error('the app host is shut down');
    }
    states.set(id, s);
    const rotate = createRotator(st.logFile(id), t.logCapBytes);
    s.logTimer = setInterval(() => { rotate().catch(() => {}); }, t.logCheckMs);
    s.logTimer.unref();
    s.launching = launch(id, s, version, installed).catch((e) => fail(id, s, `internal error: ${e.message}`));
    return publicStatus(s);
  }

  /**
   * Stops an active run and waits for its processes to be gone; `grace` bounds the SIGTERM wait.
   * `sweep: false` leaves the marker sweep to the caller. The run always ends `stopped`, even if a step throws.
   */
  async function halt(id, s, grace, { sweep: doSweep = true } = {}) {
    s.stopping = true;
    try {
      // One kill per group: a launch that is stopping never spawns again, so a second pass would only double the wait.
      const group = s.pgid;
      if (group) await killGroup(group, grace);
      await s.launching;
      if (doSweep) await sweep(id, grace);
      await logNote(id, 'stopped');
    } finally {
      release(s);
      states.set(id, { status: 'stopped', version: null, error: null, since: new Date().toISOString() });
    }
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

    /**
     * Runs `commit` (the store write that adds a version) under the id's lock, then restarts an active app on the
     * new latest version; a stopped one stays stopped. Serialising with `exclusive` means a version delete cannot
     * interleave with the commit and unlink what the app runs.
     */
    committing: (id, commit) => locked(id, async () => {
      const result = await commit();
      const s = states.get(id);
      if (s && isActive(s)) {
        await stopLocked(id);
        await startLocked(id);
      }
      return result;
    }),

    /**
     * Runs `fn` under the id's lock, first stopping the app: always for `'any'`, or only when it runs version
     * `stopVersion` and `precondition` (evaluated under the lock) holds.
     */
    exclusive: (id, fn, { stopVersion = 'any', precondition = async () => true } = {}) => locked(id, async () => {
      const s = states.get(id);
      if (s && (stopVersion === 'any' || s.version === stopVersion) && (await precondition())) await stopLocked(id);
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

    /** Resolves once no Start/Stop is queued and every launch has run to `running`, `failed` or a stop: a test sync point. */
    async settled() {
      await Promise.all([...locks.values()]);
      await Promise.all([...states.values()].map((s) => s.launching));
    },

    /** Boot: kills what a crashed or SIGKILLed backend left behind. Apps do not come back. */
    async reapOrphans() {
      if (!storeDir) return;
      if (!HAS_PROC) {
        console.warn('code-artifact: no /proc here, so orphaned app processes are not reaped');
        return;
      }
      const n = await sweep(undefined, t.graceMs);
      if (n > 0) console.warn(`code-artifact: reaped ${n} orphaned app process(es)`);
    },

    /**
     * Stops every app; the backend is going away. After it resolves nothing is spawned and nothing marked runs.
     * Time: `shutdownGraceMs` for every group in parallel, up to 1 s more for a SIGKILLed group to vanish,
     * then a marker sweep for escaped descendants that sends SIGKILL at once (up to 1 s more).
     */
    async shutdown() {
      closed = true;
      const active = [...states].filter(([, s]) => isActive(s));
      await Promise.all(active.map(([id, s]) => halt(id, s, t.shutdownGraceMs, { sweep: false })
        .catch((e) => console.error(`code-artifact: stopping ${id} failed:`, e))));
      await sweep(undefined, 0);
    },
  };
}
