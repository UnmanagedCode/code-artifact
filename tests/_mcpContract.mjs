// The MCP reply contract as cc enforces it: a refusal is {error, code, details?} in either format; a json success is exactly
// {structured} matching the tool's manifest outputSchema; a text success is {text} (a string).
import fsp from 'node:fs/promises';
import assert from 'node:assert/strict';
import { checkSchema, validate } from './_jsonSchemaSubset.mjs';

export const manifest = JSON.parse(await fsp.readFile(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));
export const SCHEMAS = Object.fromEntries(manifest.mcp.tools.map((t) => [t.name, t.outputSchema]));
for (const schema of Object.values(SCHEMAS)) checkSchema(schema);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const subset = (keys, allowed) => keys.every((k) => allowed.includes(k));

/** Asserts a reply obeys the contract. Only status 200 is checked: 400 is the envelope's own fault. */
export function checkReply(tool, format, status, body) {
  if (status !== 200) return;
  assert.ok(isPlainObject(body), `${tool}: reply is not an object`);
  if ('error' in body) {
    assert.ok(subset(Object.keys(body), ['error', 'code', 'details']), `${tool}: refusal keys ${Object.keys(body)}`);
    assert.equal(typeof body.error, 'string', `${tool}: refusal error`);
    assert.match(body.code, /^[A-Z][A-Z0-9_]*$/, `${tool}: refusal code`);
    if ('details' in body) assert.ok(isPlainObject(body.details), `${tool}: refusal details`);
    return;
  }
  if (format === 'json') {
    assert.deepEqual(Object.keys(body), ['structured'], `${tool}: json reply keys`);
    assert.ok(isPlainObject(body.structured), `${tool}: structured is not an object`);
    const errors = validate(SCHEMAS[tool], body.structured);
    assert.deepEqual(errors, [], `${tool}: structured does not match its outputSchema:\n${errors.join('\n')}`);
    return;
  }
  assert.ok(subset(Object.keys(body), ['text', 'meta']), `${tool}: text reply keys ${Object.keys(body)}`);
  assert.equal(typeof body.text, 'string', `${tool}: text reply`);
}
