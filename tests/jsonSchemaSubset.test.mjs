// Pins that the test-side port of cc's output-schema validator rejects and reports what cc does, so the manifest and reply checks mean something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validate } from './_jsonSchemaSubset.mjs';

const closed = (properties = {}, extra = {}) => ({ type: 'object', additionalProperties: false, properties, ...extra });

test('checkSchema rejects keywords outside the subset', () => {
  assert.throws(() => checkSchema({ type: 'string', pattern: '^a' }), /keyword 'pattern'/);
  assert.throws(() => checkSchema({ $ref: '#/x' }), /keyword '\$ref'/);
});

test('checkSchema requires additionalProperties on every object schema, at any depth', () => {
  assert.throws(() => checkSchema({ type: 'object' }), /must state additionalProperties/);
  assert.throws(() => checkSchema(closed({ a: { type: 'object' } })), /properties\/a.*additionalProperties/);
  assert.throws(() => checkSchema({ type: 'array', items: { type: 'object' } }), /items.*additionalProperties/);
  assert.throws(() => checkSchema({ anyOf: [{ type: 'object' }] }), /anyOf\/0.*additionalProperties/);
  assert.throws(() => checkSchema({ type: ['object', 'null'] }), /additionalProperties/);
});

test('checkSchema rejects malformed structure', () => {
  assert.throws(() => checkSchema(closed({ a: { type: 'string' } }, { required: ['b'] })), /required 'b' is not a property/);
  assert.throws(() => checkSchema({ anyOf: [] }), /non-empty array/);
  assert.throws(() => checkSchema({ type: 'text' }), /unknown type 'text'/);
  assert.throws(() => checkSchema({ enum: 'a' }), /enum must be an array/);
});

test('checkSchema accepts type unions and a well-formed schema', () => {
  checkSchema({ type: ['string', 'null'] });
  checkSchema(closed({ a: { type: 'array', items: closed() }, b: { const: 'x' }, c: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, { required: ['a'] }));
});

test('validate reports type mismatches, and accepts an integer where number is declared', () => {
  assert.deepEqual(validate({ type: 'string' }, 5), ['$: expected string, got integer']);
  assert.deepEqual(validate({ type: ['string', 'null'] }, null), []);
  assert.deepEqual(validate({ type: 'number' }, 3), []);
  assert.deepEqual(validate({ type: 'integer' }, 3.5), ['$: expected integer, got number']);
});

test('validate checks const and enum', () => {
  assert.equal(validate({ const: 'a' }, 'b').length, 1);
  assert.deepEqual(validate({ const: 'a' }, 'a'), []);
  assert.equal(validate({ enum: ['a', 'b'] }, 'c').length, 1);
  assert.deepEqual(validate({ enum: ['a', 'b'] }, 'b'), []);
});

test('validate reports missing required and unexpected properties with their paths', () => {
  const s = closed({ a: { type: 'string' } }, { required: ['a'] });
  assert.deepEqual(validate(s, {}), ["$: missing required 'a'"]);
  assert.deepEqual(validate(s, { a: 'x', z: 1 }), ["$: unexpected property 'z'"]);
  assert.deepEqual(validate(s, { a: 1 }), ['$.a: expected string, got integer']);
});

test('validate applies a schema-valued additionalProperties and leaves an open object alone', () => {
  assert.deepEqual(validate({ type: 'object', additionalProperties: { type: 'integer' } }, { a: 1 }), []);
  assert.deepEqual(validate({ type: 'object', additionalProperties: { type: 'integer' } }, { a: 'x' }), ['$.a: expected integer, got string']);
  assert.deepEqual(validate({ type: 'object', additionalProperties: true }, { a: 'x' }), []);
});

test('validate reports array item errors by index', () => {
  assert.deepEqual(validate({ type: 'array', items: { type: 'string' } }, ['a', 2]), ['$[1]: expected string, got integer']);
});

test('validate reports an anyOf with no matching branch, and accepts a matching one', () => {
  const s = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  assert.deepEqual(validate(s, null), []);
  const errs = validate(s, 5);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /matches no anyOf branch/);
});

test('validate returns [] for a valid value', () => {
  assert.deepEqual(validate(closed({ a: { type: 'integer' } }, { required: ['a'] }), { a: 1 }), []);
});
