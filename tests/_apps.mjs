// Helpers for tests that run real app processes: a fixture source, bounded polling, and raw upgrades.
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markedPids, pidAlive } from '../src/appProcs.js';
import { tmp, startApp, publish } from './_helpers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/app-server.cjs', import.meta.url));

/** Short timings so no test waits out a production delay; every wait below is polled against a deadline. */
export const TIMINGS = {
  graceMs: 300, shutdownGraceMs: 300, startTimeoutMs: 5000, installTimeoutMs: 10_000, probeMs: 25, logCheckMs: 50, logCapBytes: 4096,
};

/** `startApp` with the short timings. */
export const startApps = (t, opts = {}) => startApp(t, { ...opts, appTimings: { ...TIMINGS, ...opts.appTimings } });

/**
 * Writes an app source dir: `artifact.json` (`manifest`, or the string verbatim), the fixture server as `server.js`,
 * `fixture.json` (`fixture`), a `VERSION` file and any extra `files`. Resolves to the dir.
 */
export async function appSource(t, { manifest = { start: 'node server.js' }, fixture = {}, files = {}, version = '1', name = 'src' } = {}) {
  const dir = path.join(await tmp(t), name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(FIXTURE, path.join(dir, 'server.js'));
  await fsp.writeFile(path.join(dir, 'artifact.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  await fsp.writeFile(path.join(dir, 'fixture.json'), JSON.stringify(fixture));
  await fsp.writeFile(path.join(dir, 'VERSION'), version);
  for (const [rel, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

/** Publishes `appSource(t, opts)` and resolves to the publish result. */
export async function publishApp(t, app, opts = {}) {
  return publish(app, { path: await appSource(t, opts), title: opts.title ?? 'An app' });
}

/** Polls `fn` until it returns something truthy; fails with `what` and the last value after `timeout` ms. */
export async function waitFor(fn, { timeout = 8000, every = 20, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** Waits for the app's status; the failure message carries the last status and the log tail. */
export async function waitStatus(app, id, status, timeout = 8000) {
  let last;
  try {
    return await waitFor(async () => {
      last = (await app.get(`/api/apps/${id}`)).data;
      return last.status === status ? last : null;
    }, { timeout, what: `status ${status}` });
  } catch (e) {
    const log = (await app.get(`/api/apps/${id}/log`)).text;
    throw new Error(`${e.message}; last ${JSON.stringify(last)}; log:\n${log}`);
  }
}

/** Starts the app and waits until it runs. */
export async function runApp(app, id) {
  const res = await app.post(`/api/apps/${id}/start`, {});
  if (res.status !== 202) throw new Error(`start answered ${res.status}: ${res.text}`);
  return waitStatus(app, id, 'running');
}

/** Waits until `pid` is gone (a zombie counts as gone). */
export const pidGone = (pid) => waitFor(async () => !(await pidAlive(pid)), { what: `pid ${pid} to exit` });

/** The pids that carry this store's run marker. */
export async function markerPids(storeDir) {
  return (await markedPids(await fsp.realpath(storeDir))).map((m) => m.pid);
}

/** The pid the fixture recorded in `$DATA_DIR/<name>`. */
export async function recordedPid(storeDir, id, name = 'pid') {
  return Number(await waitFor(() => fsp.readFile(path.join(storeDir, 'artifacts', id, 'data', name), 'utf8').catch(() => null), { what: `${name} file` }));
}

/** An upgrade request: resolves `{status, headers, socket}`; the socket is the raw connection after the 101 (null otherwise). */
export function rawUpgrade(base, requestPath, headers = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: requestPath,
      headers: { Connection: 'Upgrade', Upgrade: 'fixture', ...headers },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, headers: res.headers, socket }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers, socket: null }); });
    req.on('error', reject);
    req.end();
  });
}

/** Writes `data` to a raw socket and resolves with the next chunk that comes back. */
export function echoOnce(socket, data) {
  return new Promise((resolve, reject) => {
    socket.once('data', (d) => resolve(d.toString()));
    socket.once('error', reject);
    socket.write(data);
  });
}

/** Resolves when the socket is closed by the far side (bounded). */
export const socketClosed = (socket) => waitFor(() => socket.destroyed || socket.readableEnded || null, { what: 'socket to close' });
