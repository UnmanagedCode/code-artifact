// Pins store resolution: CONDUCTOR_PLUGIN_DATA_DIR only, absolute only, no legacy derivation and no override.
import test from 'node:test';
import assert from 'node:assert/strict';
import { storeRoot } from '../src/config.js';
import { Refusal } from '../src/refusal.js';

function withEnv(t, vars) {
  const keys = ['CONDUCTOR_PLUGIN_DATA_DIR', 'PROJECTS_ROOT', 'CODE_ARTIFACT_STORE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
}

function assertUnconfigured(extra) {
  assert.throws(() => storeRoot(), (e) => {
    assert.ok(e instanceof Refusal);
    assert.equal(e.code, 'STORE_UNCONFIGURED');
    assert.equal(e.status, 503);
    assert.match(e.message, /CONDUCTOR_PLUGIN_DATA_DIR/);
    if (extra) assert.ok(e.message.includes(extra));
    return true;
  });
}

test('storeRoot throws STORE_UNCONFIGURED when CONDUCTOR_PLUGIN_DATA_DIR is unset', (t) => {
  withEnv(t, {});
  assertUnconfigured();
});

test('storeRoot throws STORE_UNCONFIGURED when CONDUCTOR_PLUGIN_DATA_DIR is empty', (t) => {
  withEnv(t, { CONDUCTOR_PLUGIN_DATA_DIR: '' });
  assertUnconfigured();
});

test('storeRoot throws STORE_UNCONFIGURED when CONDUCTOR_PLUGIN_DATA_DIR is relative', (t) => {
  withEnv(t, { CONDUCTOR_PLUGIN_DATA_DIR: 'store' });
  assertUnconfigured('"store"');
});

test('storeRoot returns an absolute CONDUCTOR_PLUGIN_DATA_DIR as given', (t) => {
  withEnv(t, { CONDUCTOR_PLUGIN_DATA_DIR: '/some/abs/dir' });
  assert.equal(storeRoot(), '/some/abs/dir');
});

test('storeRoot ignores PROJECTS_ROOT and CODE_ARTIFACT_STORE', (t) => {
  withEnv(t, { PROJECTS_ROOT: '/tmp/ca-root', CODE_ARTIFACT_STORE: '/tmp/ca-store' });
  assertUnconfigured();
});
