/** Refusals keep their identity and public contract when separated from execution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refuse as publicRefuse } from '../packages/mistri/src/server/commands.js';
import {
  BusinessCommandExecutionError,
  isBusinessCommandExecutionError,
  refuse,
  type RefusalCode,
} from '../packages/mistri/src/server/commands/commandErrors.js';
import * as execution from '../packages/mistri/src/server/commands/businessCommandExecution.js';

test('public and executor compatibility exports are the same refusal implementation', () => {
  assert.equal(publicRefuse, refuse);
  assert.equal(execution.refuse, refuse);
  assert.equal(execution.BusinessCommandExecutionError, BusinessCommandExecutionError);
  assert.equal(execution.isBusinessCommandExecutionError, isBusinessCommandExecutionError);
});

const messages: Record<RefusalCode, string> = {
  unauthenticated: 'Sign in to continue.',
  stale_account: 'The signed-in account changed. Reload before continuing.',
  invalid_input: 'The command input is invalid.',
  command_version_mismatch: 'This command version is unavailable. Keep the original request for reconciliation.',
  not_found: 'The record was not found.',
  ineligible_state: 'This record is not eligible for this command.',
  consumes_refused: 'There is not enough left of what this would use.',
  reviewer_unavailable: 'The selected reviewer is unavailable.',
  forbidden: 'This command is not available to this account.',
  idempotency_conflict: 'This request key was already used with different input.',
  duplicate_record: 'A record with this value already exists.',
  stale_record: 'The record has changed. Reload it before trying again.',
  row_locked: 'The record is locked by another transaction. Nothing was changed; retry in a moment.',
  cancelled: 'The command was cancelled.',
  temporarily_unavailable: 'The command could not be completed. Retry with the same request key.',
  invalid_result: 'The command did not produce a valid result.',
};

test('every handler refusal retains its fixed message and not-applied outcome', () => {
  for (const code of Object.keys(messages) as RefusalCode[]) {
    assert.throws(
      () => publicRefuse(code, 'applicant.email'),
      (error) => {
        assert.ok(error instanceof BusinessCommandExecutionError);
        assert.equal(error.code, code);
        assert.equal(error.message, messages[code]);
        assert.equal(error.name, 'BusinessCommandExecutionError');
        assert.equal(error.outcome, 'not_applied');
        assert.equal(error.field, 'applicant.email');
        return true;
      },
    );
  }
});

test('refusal details remain bounded and keys are detached without rounding large IDs', () => {
  const key = { id: '9007199254740993' };
  const error = new BusinessCommandExecutionError('stale_record', 'unknown', 'rows[1].stock', key);
  key.id = 'changed';
  assert.deepEqual(error.key, { id: '9007199254740993' });
  assert.ok(Object.isFrozen(error.key));
  assert.equal(error.outcome, 'unknown');
  assert.equal(error.field, 'rows[1].stock');
  for (const field of ['invalid field', 'name'.repeat(101), 'rows[1000].stock']) {
    assert.equal(new BusinessCommandExecutionError('invalid_input', 'not_applied', field).field, undefined);
  }
  const invalidKeys: Readonly<Record<string, string | number>>[] = [
    {},
    { id: Infinity },
    { id: 'x'.repeat(1025) },
    { 'bad key': 1 },
    new Proxy({ id: 1 }, {}),
  ];
  for (const invalid of invalidKeys) {
    assert.equal(new BusinessCommandExecutionError('not_found', 'not_applied', undefined, invalid).key, undefined);
  }
});

test('cross-package classification retains the registered symbol and rejects look-alikes', () => {
  const brand = Symbol.for('mistri.businessCommandExecutionError');
  class ForeignError extends Error {
    readonly [brand] = true;
    constructor(
      readonly code: string,
      readonly outcome: string,
    ) {
      super('another package copy');
    }
  }
  for (const outcome of ['not_applied', 'unknown']) {
    const error = new ForeignError('forbidden', outcome);
    assert.ok(!(error instanceof BusinessCommandExecutionError));
    assert.equal(isBusinessCommandExecutionError(error), true);
  }
  for (const error of [
    new ForeignError('unknown_code', 'not_applied'),
    new ForeignError('forbidden', 'applied'),
    Object.assign(new Error('look-alike'), { code: 'forbidden', outcome: 'not_applied' }),
    { [brand]: true, code: 'forbidden', outcome: 'not_applied' },
    null,
  ])
    assert.equal(isBusinessCommandExecutionError(error), false);
});

test('a handler may refuse in its own words: ineligible_state with the sentence as the message', () => {
  assert.throws(
    () => publicRefuse('Quinn has 0 h of Personal left.'),
    (error) => {
      assert.ok(error instanceof BusinessCommandExecutionError);
      assert.equal(error.code, 'ineligible_state');
      assert.equal(error.message, 'Quinn has 0 h of Personal left.');
      assert.equal(error.reason, 'Quinn has 0 h of Personal left.');
      assert.equal(error.outcome, 'not_applied');
      assert.equal(error.field, undefined);
      return true;
    },
  );
  // One line, trimmed; a key still names which of several targets it is about.
  assert.throws(
    () => publicRefuse('  Two\n  lines  ', { key: { id: 7 } }),
    (error) => {
      assert.ok(error instanceof BusinessCommandExecutionError);
      assert.equal(error.message, 'Two lines');
      assert.deepEqual(error.key, { id: 7 });
      return true;
    },
  );
  // A code keeps its fixed message and carries no reason.
  assert.throws(
    () => publicRefuse('ineligible_state'),
    (error) => {
      assert.ok(error instanceof BusinessCommandExecutionError);
      assert.equal(error.message, messages.ineligible_state);
      assert.equal(error.reason, undefined);
      return true;
    },
  );
});

test('a sentence about one answer names its input: invalid_input with the field and the sentence', () => {
  assert.throws(
    () => publicRefuse('Only $12.00 is left to refund.', { field: 'amount' }),
    (error) => {
      assert.ok(error instanceof BusinessCommandExecutionError);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.message, 'Only $12.00 is left to refund.');
      assert.equal(error.reason, 'Only $12.00 is left to refund.');
      assert.equal(error.field, 'amount');
      assert.equal(error.outcome, 'not_applied');
      return true;
    },
  );
  // A row of a repeated input is named by its place in the list.
  assert.throws(
    () => publicRefuse('Only 1 of TEE-M is left to return.', { field: 'lines[0].quantity' }),
    (error) => error instanceof BusinessCommandExecutionError && error.field === 'lines[0].quantity',
  );
  // A field that is not an input's path is the handler's bug, not a place to say it.
  for (const bad of ['', 'two words', 'a.b.c.d', 'x'.repeat(401)])
    assert.throws(
      () => publicRefuse('Not that.', { field: bad }),
      (error) => error instanceof TypeError && !(error instanceof BusinessCommandExecutionError),
    );
});

test("a mistyped code, an empty or an overlong reason is the handler's bug, not a sentence for the reader", () => {
  for (const bad of ['ineligble_state', '', '   ', 'x'.repeat(301)]) {
    assert.throws(
      () => publicRefuse(bad),
      (error) => error instanceof TypeError && !(error instanceof BusinessCommandExecutionError),
    );
  }
  // The platform's own refusals never take an unbounded reason either.
  assert.equal(
    new BusinessCommandExecutionError('forbidden', 'not_applied', undefined, undefined, 'x'.repeat(301)).message,
    messages.forbidden,
  );
  assert.equal(new BusinessCommandExecutionError('forbidden', 'not_applied', undefined, undefined, 'bad\u0007bell').reason, undefined);
});

test('a reason survives the cross-package classification and a malformed one is rejected', () => {
  const brand = Symbol.for('mistri.businessCommandExecutionError');
  const twin = Object.assign(new Error('Only 2 h left.'), {
    [brand]: true,
    code: 'ineligible_state',
    outcome: 'not_applied',
    reason: 'Only 2 h left.',
  });
  assert.equal(isBusinessCommandExecutionError(twin), true);
  assert.equal(
    isBusinessCommandExecutionError(
      Object.assign(new Error('x'), { [brand]: true, code: 'ineligible_state', outcome: 'not_applied', reason: 42 }),
    ),
    false,
  );
});
