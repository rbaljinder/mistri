import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiCommandRequestError, readApiCommandHeaders } from '../packages/mistri/src/server/api/apiCommandHeaders.js';

const key = 'owner-attempt-0000001';
const code = (expected: string) => (error: unknown) => error instanceof ApiCommandRequestError && error.code === expected;

test('one target: a strong canonical revision and one request key', () => {
  assert.deepEqual(readApiCommandHeaders(['Host', 'x', 'If-Match', '"3"', 'Idempotency-Key', key], 'one'), {
    expectedVersion: 3,
    idempotencyKey: key,
  });
  assert.deepEqual(readApiCommandHeaders(['if-match', '"0"', 'IDEMPOTENCY-KEY', key], 'one'), { expectedVersion: 0, idempotencyKey: key });
  assert.equal(readApiCommandHeaders(['If-Match', '"9007199254740990"', 'Idempotency-Key', key], 'one').expectedVersion, 9007199254740990);
  assert.throws(() => readApiCommandHeaders(['Idempotency-Key', key], 'one'), code('precondition_required'));
  assert.throws(() => readApiCommandHeaders(['If-Match', '"3"'], 'one'), code('idempotency_key_required'));
  for (const tag of ['3', 'W/"3"', '*', '"3", "4"', '"03"', '"-1"', '"3.0"', '" 3"', '"9007199254740991"', '"1e3"', '']) {
    assert.throws(() => readApiCommandHeaders(['If-Match', tag, 'Idempotency-Key', key], 'one'), code('invalid_request'), tag);
  }
});

test('request keys, duplicates and malformed header lists refuse without guessing', () => {
  for (const value of ['short', 'x'.repeat(129), 'owner attempt 00000001', 'owner-attempt-00000é1']) {
    assert.throws(() => readApiCommandHeaders(['If-Match', '"1"', 'Idempotency-Key', value], 'one'), code('invalid_request'), value);
  }
  for (const headers of [
    ['If-Match', '"1"', 'if-match', '"1"', 'Idempotency-Key', key],
    ['If-Match', '"1"', 'Idempotency-Key', key, 'idempotency-key', key],
    ['If-Match', '"1"', 'Idempotency-Key', `${key}\r\nX: y`],
    ['bad name', 'x'],
    ['If-Match'],
    'If-Match: "1"',
  ])
    assert.throws(() => readApiCommandHeaders(headers, 'one'), code('invalid_request'));
});

test('many targets carry revisions in the body; recovery takes its key from the path', () => {
  assert.deepEqual(readApiCommandHeaders(['Idempotency-Key', key], 'many'), { idempotencyKey: key });
  assert.throws(() => readApiCommandHeaders(['If-Match', '"1"', 'Idempotency-Key', key], 'many'), code('invalid_request'));
  assert.throws(() => readApiCommandHeaders([], 'many'), code('idempotency_key_required'));
  assert.deepEqual(readApiCommandHeaders(['Host', 'x'], 'recover'), {});
  for (const headers of [
    ['Idempotency-Key', key],
    ['If-Match', '"1"'],
  ]) {
    assert.throws(() => readApiCommandHeaders(headers, 'recover'), code('invalid_request'));
  }
  assert.ok(Object.isFrozen(readApiCommandHeaders(['Idempotency-Key', key], 'many')));
});

test('prepare needs no execution headers and rejects them when supplied', () => {
  assert.deepEqual(readApiCommandHeaders([], 'prepare'), {});
  for (const headers of [
    ['If-Match', '"1"'],
    ['Idempotency-Key', 'prepare-request-0001'],
  ])
    assert.throws(() => readApiCommandHeaders(headers, 'prepare'), { code: 'invalid_request' });
});
