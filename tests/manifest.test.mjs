// Pins the manifest: identity, flat tool schemas inside cc's validator subset, tool names equal the handler names, health path answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { PLUGIN_ID } from '../src/links.js';
import { createTools } from '../src/mcp.js';
import { KINDS } from '../src/kinds.js';
import { startApp } from './_helpers.mjs';

const manifest = JSON.parse(await fsp.readFile(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));
const ALLOWED_PROP_KEYS = new Set(['type', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'description']);

test('the manifest identifies the plugin for pluginApi 1', () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.pluginApi, 1);
  assert.match(manifest.id, /^[a-z][a-z0-9-]*$/);
});

test('every tool schema is flat and uses only the validator subset', () => {
  for (const tool of manifest.mcp.tools) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object', tool.name);
    for (const banned of ['$ref', 'oneOf', 'anyOf', 'allOf', 'not']) assert.ok(!JSON.stringify(schema).includes(`"${banned}"`), `${tool.name} uses ${banned}`);
    for (const [prop, def] of Object.entries(schema.properties ?? {})) {
      assert.ok(!('properties' in def), `${tool.name}.${prop} nests properties`);
      for (const key of Object.keys(def)) assert.ok(ALLOWED_PROP_KEYS.has(key), `${tool.name}.${prop} uses ${key}`);
      assert.ok(['string', 'integer'].includes(def.type), `${tool.name}.${prop}`);
    }
    for (const req of schema.required ?? []) assert.ok(req in schema.properties, `${tool.name} requires unknown ${req}`);
  }
});

test('kind enums equal the supported kinds', () => {
  for (const tool of manifest.mcp.tools) {
    const kind = tool.inputSchema.properties.kind;
    if (kind) assert.deepEqual(kind.enum, KINDS, tool.name);
  }
});

test('the manifest tool names equal the handler names', () => {
  assert.deepEqual(manifest.mcp.tools.map((t) => t.name).sort(), Object.keys(createTools({})).sort());
});

test('the declared healthPath and mcp endpoint exist on the server', async (t) => {
  const app = await startApp(t);
  assert.equal((await app.get(manifest.backend.healthPath)).status, 200);
  const res = await app.raw('POST', manifest.mcp.endpoint, { tool: 'list_artifacts', arguments: {}, caller: {} });
  assert.equal(res.status, 200);
  assert.ok(manifest.mcp.timeoutMs <= 120000);
});
