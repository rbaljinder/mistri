import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommandKey, parseCommandRequest, CommandInputError } from '../packages/mistri/src/server/commands/commandPayload.js';
import { immutableCommandResult, validateHistoricalCommandOutput } from '../packages/mistri/src/server/commands/commandHistoricalOutput.js';

const envelope = (key: unknown) => ({
  command: 'update',
  commandVersion: 1,
  key,
  expectedVersion: 0,
  idempotencyKey: 'recovery_test_0001',
  input: null,
});
test('recovery keys share envelope rules and preserve historical scalar spelling', () => {
  for (const key of [{ id: '1' }, { id: 1 }, { part: 'a', id: 2.5 }, { id: '' }, { id: 'é'.repeat(512) }]) {
    const parsed = parseCommandKey(key);
    assert.deepEqual(parsed, parseCommandRequest(envelope(key)).key);
    assert.notEqual(parsed, key);
    assert.ok(Object.isFrozen(parsed));
  }
  assert.equal(parseCommandKey({ id: '1' }).id, '1');
  assert.deepEqual(parseCommandKey({}, true), parseCommandRequest(envelope({}), { creating: true }).key);
  for (const key of [
    {},
    [],
    null,
    { id: true },
    { id: Infinity },
    { id: 'é'.repeat(513) },
    { 'bad.column': 1 },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
  ]) {
    assert.throws(() => parseCommandKey(key), CommandInputError);
    assert.throws(() => parseCommandRequest(envelope(key)), CommandInputError);
  }
});
test('recovery key capture never invokes hostile descriptors or proxy traps', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
    },
  );
  for (const key of [getter, proxy, { id: undefined }, Object.fromEntries([['constructor', 1]])]) {
    assert.throws(() => parseCommandKey(key), CommandInputError);
  }
  assert.equal(calls, 0);
});
test('historical output is independently detached and deeply frozen', () => {
  let parsed: unknown;
  const result = validateHistoricalCommandOutput('{"a":{"list":[1]}}', {
    parse(value) {
      parsed = value;
      return value;
    },
  });
  assert.deepEqual(result, { a: { list: [1] } });
  assert.notEqual(result, parsed);
  assert.ok(Object.isFrozen(result));
  const nested = result as { a: { list: number[] } };
  assert.ok(Object.isFrozen(nested.a));
  assert.ok(Object.isFrozen(nested.a.list));
  assert.deepEqual(immutableCommandResult('{"a":1}'), { a: 1 });
});
test('historical output refuses projection, coercion, mutation and invalid canonical data', () => {
  for (const parse of [
    () => ({}),
    () => ({ id: '1' }),
    (value: unknown) => {
      (value as { id: number }).id = 2;
      return value;
    },
    () => undefined,
    () => {
      throw new Error('validator detail');
    },
  ]) {
    assert.throws(() => validateHistoricalCommandOutput('{"id":1}', { parse }));
  }
  for (const json of ['not json', '{"constructor":1}', JSON.stringify('x'.repeat(16383))]) {
    let calls = 0;
    assert.throws(() =>
      validateHistoricalCommandOutput(json, {
        parse(value) {
          calls++;
          return value;
        },
      }),
    );
    assert.equal(calls, 0);
  }
  assert.equal(validateHistoricalCommandOutput(JSON.stringify('x'.repeat(16382)), { parse: (value) => value }), 'x'.repeat(16382));
});

test('historical extraction preserves legacy parsed-JSON rather than raw-byte equality', () => {
  assert.deepEqual(validateHistoricalCommandOutput(' { "id": 0, "id": 1e0 } ', { parse: (value) => value }), { id: 1 });
});
