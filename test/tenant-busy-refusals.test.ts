/**
 * Slowness is never a refusal. A field report ran a tenant App at twelve users
 * on half a core: the pools queued past their two-second bound, and every
 * refused checkout (poolMetrics.ts, PoolBusy) was answered 403 "The tenant
 * context could not be verified", which tells the browser its tenant context
 * is gone. A pool that would not lend a connection decided nothing about the
 * person: it is the database not answering, a 503 to try again. And a denial
 * stays a denial, however it is recorded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POOL_BUSY_MESSAGE, PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import {
  databaseFault,
  databaseUnanswered,
  denyTenant,
  denyTenantFor,
  recordRefusalCause,
  TenantContextError,
  TenantUnavailableError,
} from '../packages/engine/src/server/evidence.js';
import { unansweredWrite } from '../packages/mistri/src/server/tenant/tenantWriteFault.js';
import { TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected a throw');
};

test('a refused checkout is the database not answering: unavailable, not a denial', () => {
  for (const why of ['queue_full', 'queue_timeout'] as const)
    for (const role of ['read', 'write'] as const) {
      const busy = new PoolBusy(role, why);
      assert.equal(databaseFault(busy), true);
      const refusal = thrown(() => denyTenantFor(busy));
      assert.ok(refusal instanceof TenantUnavailableError);
      // Still fails closed: every consumer that denies on a context error still does.
      assert.ok(refusal instanceof TenantContextError);
    }
});

test('a fault recorded beneath a failure is read through it; a denial beneath one stays a denial', () => {
  // A write that failed because the writer was reopening: value-free on top, unavailable beneath.
  const reopening = recordRefusalCause(new TenantWriteFailure('not_applied'), new TenantUnavailableError());
  assert.equal(databaseUnanswered(reopening), true);
  assert.ok(thrown(() => denyTenantFor(reopening)) instanceof TenantUnavailableError);
  // One that waited on a busy pool, under a wrapper of its own.
  const queued = recordRefusalCause(
    new TenantWriteFailure('not_applied'),
    new Error('wrapped', { cause: new PoolBusy('write', 'queue_timeout') }),
  );
  assert.ok(thrown(() => denyTenantFor(queued)) instanceof TenantUnavailableError);
  // A denial decided something: whatever lies beneath it, it is said as one.
  const denial = thrown(() => denyTenant(new PoolBusy('read', 'queue_timeout')));
  const denied = recordRefusalCause(new TenantWriteFailure('not_applied'), denial);
  assert.equal(databaseUnanswered(denied), false);
  const refusal = thrown(() => denyTenantFor(denied));
  assert.ok(refusal instanceof TenantContextError && !(refusal instanceof TenantUnavailableError));
  // And a plain failure with nothing recognized beneath it denies, as before.
  const plain = thrown(() => denyTenantFor(recordRefusalCause(new TenantWriteFailure('not_applied'), new Error('closed'))));
  assert.ok(plain instanceof TenantContextError && !(plain instanceof TenantUnavailableError));
});

/* A write the pool, or the person's own saves ahead of it (tenantHistoryPartitions.ts), held past its bound is the
   server busy: said in a single-database App's words and code, `server_busy`, with nothing applied. A database that
   did not answer keeps its own sentence. */
test('a tenant write refused as busy says server_busy; one the database did not answer says so', () => {
  const busy = unansweredWrite(
    '/api/update',
    recordRefusalCause(new TenantWriteFailure('not_applied'), new PoolBusy('write', 'queue_timeout')),
  );
  assert.equal(busy.status, 503);
  assert.equal(busy.code, 'server_busy');
  assert.deepEqual(busy.body, {
    error: POOL_BUSY_MESSAGE,
    code: 'server_busy',
    errors: [{ code: 'server_busy', message: POOL_BUSY_MESSAGE }],
    outcome: 'not_applied',
  });
  const dropped = unansweredWrite(
    '/api/delete',
    recordRefusalCause(new TenantWriteFailure('not_applied'), new Error('Connection terminated')),
  );
  assert.equal(dropped.code, 'temporarily_unavailable');
  assert.equal(dropped.body.deleted, false);
});
