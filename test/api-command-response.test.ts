/** Pure command wire shapes: the design's receipt envelopes and problem table. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiTransportProblem,
  commandProblem,
  projectApiCommandAnswer,
  REFUSAL_STATUS,
} from '../packages/mistri/src/server/api/apiCommandResponse.js';

test('pre-owner transport problems have fixed titles and never an outcome', () => {
  for (const [code, status] of [
    ['invalid_request', 400],
    ['idempotency_key_required', 400],
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['method_not_allowed', 405],
    ['precondition_required', 428],
    ['rate_limited', 429],
    ['temporarily_unavailable', 503],
  ] as const) {
    const problem = apiTransportProblem(code);
    assert.equal(problem.status, status);
    assert.equal(problem.value.status, status);
    assert.equal(problem.value.code, code);
    assert.equal(problem.value.type, `urn:mistri:problem:${code}`);
    assert.equal('outcome' in problem.value, false);
    assert.ok(Object.isFrozen(problem) && Object.isFrozen(problem.value));
  }
});

const applied = {
  status: 'applied',
  receiptId: 'receipt-1',
  command: 'edit',
  commandVersion: 1,
  resource: 'item',
  key: { id: 1 },
  result: { ok: true },
};

test('execution answers a receipt and result, marking a replay with its header', () => {
  assert.deepEqual(projectApiCommandAnswer('execute', { ...applied, replayed: false }), {
    status: 200,
    headers: {},
    value: { receipt: { id: 'receipt-1', status: 'applied', replayed: false }, result: { ok: true } },
  });
  const replay = projectApiCommandAnswer('execute', { ...applied, replayed: true });
  assert.deepEqual(replay.headers, { 'idempotent-replayed': 'true' });
  assert.deepEqual(replay.value, { receipt: { id: 'receipt-1', status: 'applied', replayed: true }, result: { ok: true } });
  assert.ok(Object.isFrozen(replay) && Object.isFrozen(replay.headers));
});

test('recovery answers the normalized receipt, or 404 with an unknown outcome', () => {
  const { key: _key, ...stored } = applied;
  assert.deepEqual(projectApiCommandAnswer('recover', { ...stored, targets: [{ id: 1 }], recovered: true }), {
    status: 200,
    headers: {},
    value: { receipt: { id: 'receipt-1', status: 'applied', recovered: true }, targets: [{ id: 1 }], result: { ok: true } },
  });
  assert.deepEqual(projectApiCommandAnswer('recover', { status: 'not_found', outcome: 'unknown' }), {
    status: 404,
    headers: {},
    value: {
      type: 'urn:mistri:problem:not_found',
      title: 'The record was not found.',
      status: 404,
      code: 'not_found',
      outcome: 'unknown',
    },
  });
  // The owner supplies its API's key encoding; stored spellings do not leak through.
  assert.deepEqual(
    projectApiCommandAnswer('recover', { ...stored, targets: [{ id: 1 }], recovered: true }, (key) => ({
      id: String((key as { id: number }).id),
    })).value,
    { receipt: { id: 'receipt-1', status: 'applied', recovered: true }, targets: [{ id: '1' }], result: { ok: true } },
  );
});

test('any other internal shape refuses instead of being guessed', () => {
  for (const [mode, raw] of [
    ['execute', null],
    ['execute', []],
    ['execute', { ...applied }],
    ['execute', { ...applied, replayed: 'no' }],
    ['execute', { ...applied, receiptId: '', replayed: false }],
    ['execute', { ...applied, status: 'pending', replayed: false }],
    ['execute', { status: 'not_found', outcome: 'unknown' }],
    ['recover', { status: 'not_found', outcome: 'not_applied' }],
    ['recover', { ...applied, recovered: true }],
    ['recover', { ...applied, targets: [], recovered: true }],
    ['recover', { ...applied, targets: [{ id: 1 }] }],
  ] as const) {
    assert.throws(() => projectApiCommandAnswer(mode, raw), { outcome: 'unknown' }, JSON.stringify(raw));
  }
});

test('the refusal table is the design table, and titles are the platform messages', () => {
  assert.deepEqual(
    { ...REFUSAL_STATUS },
    {
      forbidden: 403,
      not_found: 404,
      command_version_mismatch: 410,
      invalid_input: 422,
      consumes_refused: 422,
      stale_record: 409,
      duplicate_record: 409,
      ineligible_state: 409,
      idempotency_conflict: 409,
      invalid_result: 500,
      row_locked: 503,
      temporarily_unavailable: 503,
    },
  );
  assert.deepEqual(commandProblem('stale_record', 'not_applied', 'reason', { id: 4 }), {
    type: 'urn:mistri:problem:stale_record',
    title: 'The record has changed. Reload it before trying again.',
    status: 409,
    code: 'stale_record',
    outcome: 'not_applied',
    field: 'reason',
    key: { id: 4 },
  });
  // An invalid field path is dropped by the class's own check, never echoed.
  assert.equal('field' in commandProblem('invalid_input', 'not_applied', 'bad path!'), false);
});
