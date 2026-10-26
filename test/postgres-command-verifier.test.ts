import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePostgresCommandVerifier } from '../packages/mistri/src/adapters/commands/postgresCommandTransaction.js';
import { CommandTransactionFailure } from '../packages/mistri/src/adapters/commands/commandJournal.js';

test('PG ordinary verifier captures callable identity without executing it or a proxy', async () => {
  let calls = 0;
  const captured = capturePostgresCommandVerifier(async () => {
    calls++;
  });
  assert.equal(calls, 0);
  await captured();
  assert.equal(calls, 1);
  const proxy = new Proxy(async () => {}, {
    apply() {
      calls++;
    },
  });
  assert.throws(() => capturePostgresCommandVerifier(proxy), CommandTransactionFailure);
  assert.equal(calls, 1);
  for (const input of [null, undefined, {}, 1]) {
    assert.throws(() => capturePostgresCommandVerifier(input as () => unknown), CommandTransactionFailure);
  }
});

test('PG ordinary verifier awaits rejection and refuses nonvoid results', async () => {
  const cause = new Error('private authority refusal');
  await assert.rejects(
    capturePostgresCommandVerifier(async () => {
      throw cause;
    })(),
    (error) => error === cause,
  );
  for (const value of [true, 1, null, 'yes', {}]) {
    await assert.rejects(capturePostgresCommandVerifier(async () => value)());
  }
  await capturePostgresCommandVerifier(() => undefined)();
});
