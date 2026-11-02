// Pins the process contract: `node server.js` honours PORT, binds loopback only, prints the manifest's readyWhen line,
// and with no store configured keeps the UI up while the API answers 503.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './_helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, 'conductor.plugin.json'), 'utf8'));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function run(t, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (new RegExp(manifest.backend.readyWhen).test(out)) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { port, out: () => out, child };
}

async function runToExit(t, env) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, PORT: String(port), ...env },
    });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('node server.js listens on 127.0.0.1:$PORT and prints the readyWhen line', async (t) => {
  const store = path.join(await tmp(t), 'store');
  const { port, out } = await run(t, { CONDUCTOR_PLUGIN_DATA_DIR: store });
  assert.ok(out().includes(`code-artifact listening on http://127.0.0.1:${port}`));
  assert.equal((await fetch(`http://127.0.0.1:${port}${manifest.backend.healthPath}`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/artifacts`)).status, 200);
  assert.ok((await fsp.stat(path.join(store, 'artifacts'))).isDirectory(), 'the store was created');
});

test('boot moves <PROJECTS_ROOT>/.code-artifact into the data dir before opening the store', async (t) => {
  const root = await tmp(t);
  const legacy = path.join(root, '.code-artifact');
  await fsp.mkdir(legacy);
  await fsp.writeFile(path.join(legacy, 'marker'), 'm');
  const data = path.join(root, '.code-conductor', 'plugins', 'data', 'code-artifact');
  const { out } = await run(t, { PROJECTS_ROOT: root, CONDUCTOR_PLUGIN_DATA_DIR: data });
  assert.equal(await fsp.readFile(path.join(data, 'marker'), 'utf8'), 'm');
  assert.ok((await fsp.stat(path.join(data, 'artifacts'))).isDirectory());
  await assert.rejects(fsp.stat(legacy));
  assert.ok(out().includes(`moved the store from ${legacy} to ${data}`));
});

test('a migration refusal exits 1 before listening, naming both paths, and moves nothing', async (t) => {
  const root = await tmp(t);
  const legacy = path.join(root, '.code-artifact');
  const data = path.join(root, 'data');
  await fsp.mkdir(legacy);
  await fsp.writeFile(path.join(legacy, 'marker'), 'm');
  await fsp.mkdir(data);
  await fsp.writeFile(path.join(data, 'keep'), 'k');
  const { code, out } = await runToExit(t, { PROJECTS_ROOT: root, CONDUCTOR_PLUGIN_DATA_DIR: data });
  assert.equal(code, 1);
  assert.ok(out.includes(legacy) && out.includes(data));
  assert.doesNotMatch(out, new RegExp(manifest.backend.readyWhen));
  assert.equal(await fsp.readFile(path.join(legacy, 'marker'), 'utf8'), 'm');
  assert.deepEqual(await fsp.readdir(data), ['keep']);
});

test('PROJECTS_ROOT without a data dir answers 503 and leaves the legacy store alone', async (t) => {
  const root = await tmp(t);
  const legacy = path.join(root, '.code-artifact');
  await fsp.mkdir(legacy);
  await fsp.writeFile(path.join(legacy, 'marker'), 'm');
  const { port } = await run(t, { PROJECTS_ROOT: root });
  const api = await fetch(`http://127.0.0.1:${port}/api/artifacts`);
  assert.equal(api.status, 503);
  assert.equal((await api.json()).code, 'STORE_UNCONFIGURED');
  assert.equal(await fsp.readFile(path.join(legacy, 'marker'), 'utf8'), 'm');
});

test('the server refuses connections on a non-loopback address', async (t) => {
  const store = path.join(await tmp(t), 'store');
  const { port } = await run(t, { CONDUCTOR_PLUGIN_DATA_DIR: store });
  const lan = Object.values((await import('node:os')).networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
  if (!lan) return t.skip('no non-loopback IPv4 interface');
  await assert.rejects(fetch(`http://${lan.address}:${port}/api/health`, { signal: AbortSignal.timeout(2000) }));
});

test('with CONDUCTOR_PLUGIN_DATA_DIR unset the API is 503 STORE_UNCONFIGURED and / still answers', async (t) => {
  const { port } = await run(t, {});
  const api = await fetch(`http://127.0.0.1:${port}/api/artifacts`);
  assert.equal(api.status, 503);
  assert.equal((await api.json()).code, 'STORE_UNCONFIGURED');
  const root = await fetch(`http://127.0.0.1:${port}/`);
  assert.ok([200, 503].includes(root.status), 'the UI route is served (503 text only while unbuilt)');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});
