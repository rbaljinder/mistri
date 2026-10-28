/**
 * The durable job store contract, run unchanged on every engine: SQLite
 * always, PostgreSQL when `TABLEWALK_TEST_PG` names a disposable database
 * (see test/support/jobStoreEngines.ts). What only one engine can show —
 * file pinning on SQLite, catalog tampering, concurrent migrations,
 * SKIP LOCKED claimers and the database clock on PostgreSQL — lives beside
 * it: the SQLite block at the end, postgres-job-store.test.ts.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import {
  assertSqliteJobStore,
  JOB_TABLES as tables,
  provisionSqliteJobStore,
} from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import {
  captureJobPolicy,
  JOB_REDRIVE_LIMIT,
  JobRefusal,
  JobStoreUnavailable,
  type JobEnqueueInput,
  type JobPolicyInput,
} from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import { isRuntimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { jobEngines } from './support/jobStoreEngines.js';

const policy = (override: Partial<JobPolicyInput> = {}): JobPolicyInput => ({
  namespace: 'proof',
  maxAttempts: 3,
  leaseMs: 1_000,
  backoffMs: { base: 100, cap: 1_000 },
  maxInputBytes: 1_024,
  maxInFlight: 4,
  ...override,
});
const provenance = Object.freeze({ appId: 'ledger', actorId: 'native-account-proof', tenantId: 'north', correlationId: 'request-1' });
const request = (key = 'idempotency-key-0001', extra: Partial<JobEnqueueInput> = {}): JobEnqueueInput => ({
  job: 'remind',
  version: 1,
  idempotencyKey: key,
  input: { loanId: 7, note: 'secret-payload' },
  provenance,
  ...extra,
});
const refused = (code: string) => (error: unknown) => error instanceof JobRefusal && error.code === code;
const forged = '00000000-0000-4000-8000-000000000000';

test('policy capture refuses bad bounds and unknown options', () => {
  for (const bad of [
    { namespace: '1st' },
    { namespace: 'x', leaseMs: 999 },
    { namespace: 'x', maxAttempts: 33 },
    { namespace: 'x', extra: 1 },
  ]) {
    assert.throws(() => captureJobPolicy(bad as never), JobStoreUnavailable);
  }
});

test('every job table is reserved runtime state the App catalog hides', () => {
  for (const name of Object.values(tables)) assert.equal(isRuntimeTable(name), true, name);
});

for (const engine of jobEngines)
  describe(`job store contract on ${engine.name}`, { skip: engine.skip }, () => {
    test('provisioning is explicit, idempotent, attested and leaves business tables byte-identical', async (t) => {
      const f = await engine.fixture(t, policy(), false);
      const before = await f.business();
      await assert.rejects(f.open(), JobStoreUnavailable);
      assert.equal(await f.provision(), true);
      assert.equal(await f.provision(), false);
      assert.equal(await f.business(), before);
      const store = await f.open();
      await store.enqueue(request(), 1_000);
      await store.claim(1_000);
      assert.equal(await f.business(), before);
      assert.deepEqual(store.policy, captureJobPolicy(policy()));
      for (const altered of [policy({ maxAttempts: 4 }), policy({ backoffMs: { base: 100, cap: 2_000 } })]) {
        await assert.rejects(f.provision(altered), JobStoreUnavailable);
        await assert.rejects(f.open(altered), JobStoreUnavailable);
      }
      /* A SQLite file holds one namespace, so another is refused. PostgreSQL keeps one store per App (namespaced, version 2): another namespace is a new
       App's own store, provisioned beside this one and opened on its own, and this one is untouched. */
      const other = policy({ namespace: 'other' });
      if (engine.name === 'sqlite') {
        await assert.rejects(f.provision(other), JobStoreUnavailable);
        await assert.rejects(f.open(other), JobStoreUnavailable);
      } else {
        await assert.rejects(f.open(other), JobStoreUnavailable, 'an unprovisioned namespace is never opened');
        assert.equal(await f.provision(other), true);
        assert.equal(await f.provision(other), false);
        assert.deepEqual((await f.open(other)).policy, captureJobPolicy(other));
        assert.deepEqual((await f.open()).policy, captureJobPolicy(policy()));
        assert.equal(await f.business(), before);
      }
    });

    test('enqueue is idempotent for the same fingerprint and refuses a different one under the same key', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const first = await store.enqueue(request(), 1_000);
      assert.equal(first.replayed, false);
      assert.equal(first.runAt, 1_000);
      assert.deepEqual(await store.enqueue(request(), 1_001), { id: first.id, runAt: 1_000, replayed: true });
      for (const conflicting of [
        request('idempotency-key-0001', { input: { loanId: 8, note: 'secret-payload' } }),
        request('idempotency-key-0001', { version: 2 }),
        request('idempotency-key-0001', { provenance: { ...provenance, actorId: 'someone-else' } }),
      ])
        await assert.rejects(store.enqueue(conflicting, 1_002), refused('idempotency_conflict'));
      assert.equal((await store.enqueue(request('idempotency-key-0002'), 1_003)).replayed, false);
      assert.equal((await store.inspect()).length, 2);
      for (const bad of [
        request('short'),
        request('idempotency-key-0001', { job: '9lives' }),
        request('idempotency-key-0001', { runAt: undefined }),
        request('idempotency-key-0001', { maxAttempts: 4 }),
        { ...request(), unknown: 1 } as never,
        request('idempotency-key-0001', { provenance: { ...provenance, roles: ['admin'] } as never }),
      ])
        await assert.rejects(store.enqueue(bad, 1_004), refused('input_invalid'));
    });

    test('bounded input size refuses without writing', async (t) => {
      const store = await (await engine.fixture(t, policy({ maxInputBytes: 64 }))).open();
      await assert.rejects(
        store.enqueue(request('idempotency-key-0001', { input: { text: 'x'.repeat(100) } }), 1_000),
        refused('input_too_large'),
      );
      assert.equal((await store.inspect()).length, 0);
      assert.equal((await store.enqueue(request('idempotency-key-0001', { input: { text: 'x'.repeat(40) } }), 1_000)).replayed, false);
    });

    test('claims are due by timer then insertion, honour future timers, and carry frozen input and provenance', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const late = await store.enqueue(request('idempotency-key-late', { runAt: 2_000 }), 1_000);
      const first = await store.enqueue(request('idempotency-key-first', { runAt: 1_200 }), 1_001);
      const second = await store.enqueue(request('idempotency-key-second', { runAt: 1_200 }), 1_002);
      assert.deepEqual(await store.claim(1_100), []);
      const claims = await store.claim(1_500);
      assert.deepEqual(
        claims.map((claim) => claim.id),
        [first.id, second.id],
      );
      assert.equal(claims[0].attempt, 1);
      assert.equal(claims[0].deadline, 2_500);
      assert.equal(claims[0].maxAttempts, 3);
      assert.deepEqual(claims[0].input, { loanId: 7, note: 'secret-payload' });
      assert.deepEqual(claims[0].provenance, provenance);
      assert.ok(Object.isFrozen(claims[0]) && Object.isFrozen(claims[0].input) && Object.isFrozen(claims[0].provenance));
      assert.equal(await store.cancelRequested(claims[0].id, claims[0].fence), false);
      assert.deepEqual(await store.claim(1_999), []);
      assert.deepEqual(
        (await store.claim(2_000)).map((claim) => claim.id),
        [late.id],
      );
    });

    test('standing reads failure, the longest wait and the next moment due without reading a row', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      assert.deepEqual(await store.standing(1_000), { failed: false, waitingSince: null, next: null, at: 1_000 });
      await store.enqueue(request('idempotency-key-late', { runAt: 5_000 }), 1_000);
      await store.enqueue(request('idempotency-key-soon', { runAt: 1_200 }), 1_000);
      const before = await store.standing(1_100);
      assert.deepEqual(before, { failed: false, waitingSince: 1_200, next: 1_200, at: 1_100 });
      assert.ok(Object.isFrozen(before));
      // Due now: waiting, and no longer ahead; the later one is next.
      assert.deepEqual(await store.standing(1_300), { failed: false, waitingSince: 1_200, next: 5_000, at: 1_300 });
      // A held lease's end is a moment ahead: the host wakes for an expiry it would otherwise poll for.
      const [claim] = await store.claim(1_300);
      assert.deepEqual(await store.standing(1_300), { failed: false, waitingSince: 5_000, next: 2_300, at: 1_300 });
      await store.fail(claim.id, claim.fence, 1_400, 'rejected');
      assert.deepEqual(await store.standing(1_400), { failed: true, waitingSince: 5_000, next: 5_000, at: 1_400 });
    });

    test('claim leases at most the in-flight bound per namespace and the requested limit', async (t) => {
      const store = await (await engine.fixture(t, policy({ maxInFlight: 2 }))).open();
      for (let i = 0; i < 3; i++) await store.enqueue(request(`idempotency-key-000${i}`), 1_000);
      assert.equal((await store.claim(1_000, 1)).length, 1);
      const [second] = await store.claim(1_000, 8);
      assert.ok(second);
      assert.deepEqual(await store.claim(1_000, 8), []);
      await store.succeed(second.id, second.fence, 1_001);
      assert.equal((await store.claim(1_001, 8)).length, 1);
      assert.equal((await store.inspect({ state: 'leased' })).length, 2);
    });

    test('every mutation checks the fence and a stale fence changes nothing', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const { id } = await store.enqueue(request(), 1_000);
      const [claim] = await store.claim(1_000);
      const stale = (work: Promise<unknown>) => assert.rejects(work, refused('fence_stale'));
      await stale(store.succeed(id, forged, 1_001));
      await stale(store.fail(id, forged, 1_001, 'rejected'));
      await stale(store.retry(id, forged, 1_001, 'handler_error'));
      await stale(store.unknown(id, forged, 1_001, 'timeout'));
      await stale(store.cancelRequested(id, forged));
      assert.equal((await store.inspect())[0].state, 'leased');
      assert.equal((await store.attempts(id))[0].outcome, 'leased');
      await stale(store.succeed(id, claim.fence, 2_000));
      assert.equal((await store.succeed(id, claim.fence, 1_999)).state, 'succeeded');
      await stale(store.succeed(id, claim.fence, 1_999));
      await stale(store.retry(id, claim.fence, 1_999, 'handler_error'));
      await assert.rejects(store.succeed(forged, claim.fence, 1_999), refused('job_not_found'));
      // Only an operator's redrive may write 'redriven'.
      await assert.rejects(store.retry(id, claim.fence, 1_999, 'redriven'), JobStoreUnavailable);
    });

    test('retry follows the exponential backoff schedule and the ceiling turns the same code into failure', async (t) => {
      const store = await (await engine.fixture(t, policy({ maxAttempts: 5 }))).open();
      const { id } = await store.enqueue(request(), 1_000);
      let time = 1_000;
      for (const [attempt, delay] of [
        [1, 100],
        [2, 200],
        [3, 400],
        [4, 800],
      ] as const) {
        const [claim] = await store.claim(time);
        assert.equal(claim.attempt, attempt);
        const after = await store.retry(id, claim.fence, time, 'handler_error');
        assert.equal(after.state, 'retry');
        assert.equal(after.runAt, time + delay);
        assert.equal(after.lastCode, 'handler_error');
        assert.deepEqual(await store.claim(time + delay - 1), []);
        time += delay;
      }
      const [last] = await store.claim(time);
      assert.equal(last.attempt, 5);
      const failed = await store.retry(id, last.fence, time, 'handler_error');
      assert.equal(failed.state, 'failed');
      assert.equal(failed.lastCode, 'handler_error');
      assert.equal(failed.attempts, 5);
      assert.deepEqual(await store.claim(time + 10_000), []);
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['retry', 'handler_error'],
          ['retry', 'handler_error'],
          ['retry', 'handler_error'],
          ['retry', 'handler_error'],
          ['failed', 'handler_error'],
        ],
      );
      assert.deepEqual([...(await store.claim(time + 10_000, 4)), ...(await store.claim(time + 10_000))], []);
    });

    test('unknown keeps the lease until expiry, then a later claim re-leases the next attempt and retains the unknown row', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const { id } = await store.enqueue(request(), 1_000);
      const [claim] = await store.claim(1_000);
      const unknown = await store.unknown(id, claim.fence, 1_010, 'timeout');
      assert.equal(unknown.state, 'unknown');
      assert.equal(unknown.leaseUntil, 2_000);
      assert.equal(unknown.lastCode, 'timeout');
      assert.deepEqual(await store.claim(1_500), []);
      assert.deepEqual(await store.claim(2_000), []);
      const released = (await store.inspect())[0];
      assert.equal(released.state, 'retry');
      assert.equal(released.runAt, 2_100);
      assert.equal(released.lastCode, 'timeout');
      const [again] = await store.claim(2_100);
      assert.equal(again.id, id);
      assert.equal(again.attempt, 2);
      assert.notEqual(again.fence, claim.fence);
      assert.deepEqual(again.input, claim.input);
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.attempt, row.outcome, row.code]),
        [
          [1, 'unknown', 'timeout'],
          [2, 'leased', null],
        ],
      );
    });

    test('expired leases become retries with lease_expired, or failures at the ceiling', async (t) => {
      const store = await (await engine.fixture(t, policy({ maxAttempts: 2 }))).open();
      const { id } = await store.enqueue(request(), 1_000);
      await store.claim(1_000);
      assert.equal(await store.expireLeases(1_999), 0);
      assert.equal(await store.expireLeases(2_000), 1);
      const retry = (await store.inspect())[0];
      assert.equal(retry.state, 'retry');
      assert.equal(retry.lastCode, 'lease_expired');
      assert.equal(retry.runAt, 2_100);
      assert.equal(retry.leaseUntil, null);
      await store.claim(2_100);
      assert.equal(await store.expireLeases(3_100), 1);
      assert.equal((await store.inspect())[0].state, 'failed');
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'lease_expired'],
          ['unknown', 'lease_expired'],
        ],
      );
    });

    test('cancel ends waiting jobs outright and only asks a held lease to stop', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const scheduled = await store.enqueue(request('idempotency-key-sched', { runAt: 5_000 }), 1_000);
      assert.deepEqual(await store.cancel(scheduled.id, 1_001), { outcome: 'cancelled', state: 'cancelled' });
      assert.deepEqual(await store.cancel(scheduled.id, 1_002), { outcome: 'unchanged', state: 'cancelled' });
      assert.equal((await store.inspect({ job: 'remind', state: 'cancelled' }))[0].lastCode, 'cancelled');
      const retrying = await store.enqueue(request('idempotency-key-retry'), 1_003);
      const [first] = await store.claim(1_003);
      await store.retry(retrying.id, first.fence, 1_004, 'handler_error');
      assert.deepEqual(await store.cancel(retrying.id, 1_005), { outcome: 'cancelled', state: 'cancelled' });
      assert.deepEqual(await store.claim(1_105), []);
      const stopping = await store.enqueue(request('idempotency-key-stops'), 1_106);
      const [held] = await store.claim(1_106);
      assert.equal(await store.cancelRequested(held.id, held.fence), false);
      assert.deepEqual(await store.cancel(stopping.id, 1_107), { outcome: 'requested', state: 'leased' });
      assert.equal(await store.cancelRequested(stopping.id, held.fence), true);
      const stopped = await store.retry(stopping.id, held.fence, 1_108, 'handler_error');
      assert.equal(stopped.state, 'cancelled');
      assert.equal(stopped.lastCode, 'cancelled');
      assert.equal(stopped.cancelRequested, true);
      assert.deepEqual(
        (await store.attempts(stopping.id)).map((row) => [row.outcome, row.code]),
        [['failed', 'handler_error']],
      );
      const finishing = await store.enqueue(request('idempotency-key-finish'), 1_109);
      const [running] = await store.claim(1_109);
      await store.cancel(finishing.id, 1_110);
      const finished = await store.succeed(finishing.id, running.fence, 1_111, { sent: true });
      assert.equal(finished.state, 'succeeded');
      assert.equal(finished.cancelRequested, true);
      const declining = await store.enqueue(request('idempotency-key-declin'), 1_112);
      const [declined] = await store.claim(1_112);
      await store.cancel(declining.id, 1_113);
      assert.equal((await store.fail(declining.id, declined.fence, 1_114, 'cancelled')).state, 'cancelled');
      assert.deepEqual(
        (await store.attempts(declining.id)).map((row) => [row.outcome, row.code]),
        [['cancelled', 'cancelled']],
      );
      await assert.rejects(store.cancel(forged, 1_115), refused('job_not_found'));
    });

    test('wall-clock regression refuses mutation and does not shorten a lease', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const { id } = await store.enqueue(request(), 1_000);
      const [claim] = await store.claim(1_000);
      await assert.rejects(store.succeed(id, claim.fence, 999), JobStoreUnavailable);
      await assert.rejects(store.enqueue(request('idempotency-key-other'), 999), JobStoreUnavailable);
      await assert.rejects(store.expireLeases(999), JobStoreUnavailable);
      assert.equal((await store.inspect())[0].leaseUntil, 2_000);
      assert.equal((await store.inspect())[0].state, 'leased');
      assert.equal((await store.succeed(id, claim.fence, 1_000)).state, 'succeeded');
    });

    test('inspection is frozen, bounded, and carries no payload, provenance or error text', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const { id } = await store.enqueue(request(), 1_000);
      const [claim] = await store.claim(1_000);
      await store.retry(id, claim.fence, 1_001, 'handler_error');
      const rows = await store.inspect(),
        attempts = await store.attempts(id);
      assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0]) && Object.isFrozen(attempts) && Object.isFrozen(attempts[0]));
      assert.doesNotMatch(JSON.stringify({ rows, attempts }), /secret-payload|native-account|loanId|north|request-1|idempotency-key|fence/);
      assert.deepEqual(Object.keys(rows[0]).sort(), [
        'attempts',
        'cancelRequested',
        'createdAt',
        'id',
        'job',
        'lastCode',
        'leaseUntil',
        'maxAttempts',
        'redrives',
        'runAt',
        'state',
        'updatedAt',
        'version',
      ]);
      await assert.rejects(store.inspect({ state: 'bogus' as never }), JobStoreUnavailable);
      await assert.rejects(store.inspect({}, 129), JobStoreUnavailable);
      await assert.rejects(store.inspect({ payload: true } as never), JobStoreUnavailable);
      const [again] = await store.claim(1_101);
      await assert.rejects(store.succeed(id, again.fence, 1_102, { text: 'x'.repeat(2_000) }), refused('result_invalid'));
    });

    test('reopening the store preserves jobs, leases, attempts and idempotency', async (t) => {
      const f = await engine.fixture(t, policy());
      const a = await f.open();
      const { id } = await a.enqueue(request(), 1_000);
      const waiting = await a.enqueue(request('idempotency-key-later', { runAt: 3_000 }), 1_000);
      const [claim] = await a.claim(1_000);
      await a.close();
      await assert.rejects(a.inspect(), JobStoreUnavailable);
      const b = await f.open();
      assert.deepEqual(await b.enqueue(request(), 1_100), { id, runAt: 1_000, replayed: true });
      assert.equal((await b.inspect())[0].state, 'leased');
      assert.equal((await b.inspect())[0].leaseUntil, 2_000);
      await assert.rejects(b.succeed(id, claim.fence, 2_000), refused('fence_stale'));
      assert.equal(await b.expireLeases(2_000), 1);
      const [again] = await b.claim(2_100);
      assert.equal(again.id, id);
      assert.equal(again.attempt, 2);
      assert.deepEqual(again.input, claim.input);
      assert.deepEqual(again.provenance, provenance);
      assert.equal((await b.succeed(id, again.fence, 2_101)).state, 'succeeded');
      assert.deepEqual(
        (await b.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'lease_expired'],
          ['succeeded', 'succeeded'],
        ],
      );
      assert.deepEqual(
        (await b.claim(3_000)).map((row) => row.id),
        [waiting.id],
      );
      assert.equal(await f.scalar(`SELECT count(*) AS n FROM "${tables.attempt}"`), 3);
    });

    test('a removed reserved table cannot be treated as an empty queue', async (t) => {
      const f = await engine.fixture(t, policy());
      const store = await f.open();
      await store.enqueue(request(), 1_000);
      await f.exec(`DROP TABLE "${tables.attempt}"`);
      await assert.rejects(store.claim(1_001), JobStoreUnavailable);
      await assert.rejects(store.inspect(), JobStoreUnavailable);
    });

    test('redrive puts a failed job back with a fresh budget, records the operator, and stops at the cap', async (t) => {
      const store = await (await engine.fixture(t, policy({ maxAttempts: 2 }))).open();
      const { id } = await store.enqueue(request(), 1_000);
      await assert.rejects(store.redrive(id, 'operator-ada', 1_000), refused('not_redrivable'));
      let [claim] = await store.claim(1_000);
      await store.retry(id, claim.fence, 1_000, 'handler_error');
      [claim] = await store.claim(1_100);
      assert.equal((await store.retry(id, claim.fence, 1_100, 'handler_error')).state, 'failed');
      for (const bad of ['', ' operator', 'x'.repeat(129), 'operator ', 7]) {
        await assert.rejects(store.redrive(id, bad as never, 1_200), refused('operator_invalid'));
      }
      await assert.rejects(store.redrive(forged, 'operator-ada', 1_200), refused('job_not_found'));
      const redriven = await store.redrive(id, 'operator-ada', 1_200);
      assert.deepEqual(
        [redriven.state, redriven.attempts, redriven.maxAttempts, redriven.redrives, redriven.runAt, redriven.lastCode],
        ['retry', 3, 5, 1, 1_200, 'redriven'],
      );
      [claim] = await store.claim(1_200);
      assert.deepEqual([claim.attempt, claim.maxAttempts], [4, 5]);
      // Backoff starts over after a redrive rather than at the ceiling reached.
      assert.equal((await store.retry(id, claim.fence, 1_200, 'handler_error')).runAt, 1_300);
      [claim] = await store.claim(1_300);
      assert.equal((await store.retry(id, claim.fence, 1_300, 'handler_error')).state, 'failed');
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.attempt, row.outcome, row.code, row.operator, row.deadline === null]),
        [
          [1, 'retry', 'handler_error', null, false],
          [2, 'failed', 'handler_error', null, false],
          [3, 'redriven', 'redriven', 'operator-ada', true],
          [4, 'retry', 'handler_error', null, false],
          [5, 'failed', 'handler_error', null, false],
        ],
      );
      let time = 1_400;
      for (let redrive = 2; redrive <= JOB_REDRIVE_LIMIT; redrive++, time += 100) {
        assert.equal((await store.redrive(id, `operator-${redrive}`, time)).redrives, redrive);
        [claim] = await store.claim(time);
        assert.equal((await store.fail(id, claim.fence, time, 'rejected')).state, 'failed');
      }
      await assert.rejects(store.redrive(id, 'operator-ada', time), refused('redrive_limit'));
      const final = (await store.inspect())[0];
      assert.deepEqual([final.state, final.redrives, final.attempts], ['failed', JOB_REDRIVE_LIMIT, 9]);
      assert.doesNotMatch(JSON.stringify(await store.inspect()), /operator/);
    });

    test('redrive refuses succeeded, cancelled and held work, and takes an unknown job only after its lease', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const done = await store.enqueue(request('idempotency-key-done'), 1_000);
      let [claim] = await store.claim(1_000);
      await store.succeed(done.id, claim.fence, 1_001);
      await assert.rejects(store.redrive(done.id, 'operator-ada', 1_002), refused('not_redrivable'));
      const cancelled = await store.enqueue(request('idempotency-key-cancel'), 1_002);
      await store.cancel(cancelled.id, 1_002);
      await assert.rejects(store.redrive(cancelled.id, 'operator-ada', 1_003), refused('not_redrivable'));
      const unknown = await store.enqueue(request('idempotency-key-unknown'), 1_003);
      [claim] = await store.claim(1_003);
      await assert.rejects(store.redrive(unknown.id, 'operator-ada', 1_004), refused('not_redrivable'));
      await store.unknown(unknown.id, claim.fence, 1_005, 'timeout');
      // The handler may still be running under that lease.
      await assert.rejects(store.redrive(unknown.id, 'operator-ada', 1_500), refused('lease_held'));
      const redriven = await store.redrive(unknown.id, 'operator-ada', claim.deadline);
      assert.deepEqual([redriven.state, redriven.leaseUntil, redriven.redrives, redriven.maxAttempts], ['retry', null, 1, 5]);
      assert.deepEqual(
        (await store.attempts(unknown.id)).map((row) => [row.outcome, row.operator]),
        [
          ['unknown', null],
          ['redriven', 'operator-ada'],
        ],
      );
      [claim] = await store.claim(claim.deadline);
      assert.deepEqual([claim.id, claim.attempt], [unknown.id, 3]);
    });

    test('prune deletes succeeded jobs by age in bounded batches, history included, and nothing else', async (t) => {
      const store = await (await engine.fixture(t, policy())).open();
      const succeeded = [];
      for (let i = 0; i < 3; i++) {
        const job = await store.enqueue(request(`idempotency-key-done-${i}`), 1_000 + i);
        const [claim] = await store.claim(1_000 + i);
        await store.succeed(job.id, claim.fence, 1_000 + i);
        succeeded.push(job.id);
      }
      const failed = await store.enqueue(request('idempotency-key-failed'), 1_003);
      const [claim] = await store.claim(1_003);
      await store.fail(failed.id, claim.fence, 1_003, 'rejected');
      await store.enqueue(request('idempotency-key-waiting', { runAt: 99_000 }), 1_004);
      assert.deepEqual(await store.prune(5_000, 2_000), { pruned: 0, more: false });
      assert.deepEqual(await store.prune(1_000, 2_001, 2), { pruned: 1, more: false });
      assert.deepEqual(await store.prune(0, 2_002, 1), { pruned: 1, more: true });
      assert.deepEqual(await store.prune(0, 2_003, 1), { pruned: 1, more: true });
      assert.deepEqual(await store.prune(0, 2_004, 1), { pruned: 0, more: false });
      assert.deepEqual(
        (await store.inspect()).map((row) => row.state),
        ['failed', 'scheduled'],
      );
      for (const id of succeeded) assert.deepEqual(await store.attempts(id), []);
      // The idempotency key went with the row: the same request is new work.
      assert.equal((await store.enqueue(request('idempotency-key-done-0'), 2_005)).replayed, false);
      for (const [age, limit] of [
        [-1, 1],
        [0, 0],
        [0, 1_001],
      ])
        await assert.rejects(store.prune(age, 2_006, limit), JobStoreUnavailable);
    });

    test('a job at times runs one at a time: its slot and a manual run never hold leases together', async (t) => {
      const store = await (await engine.fixture(t, policy({ maxInFlight: 8 }))).open();
      const slot = (at: number) => `every-${String(at).padStart(16, '0')}`;
      const timed = (key: string, job = 'remind') => request(key, { job, runAt: 1_000 });
      const first = await store.enqueue(timed(slot(60_000)), 1_000);
      const manual = await store.enqueue(timed('manual-0000000000001000-abc'), 1_001);
      // Another job at times, an event's job of the same name and a tenant's slot are not held back.
      const other = await store.enqueue(timed(slot(60_000), 'close'), 1_002);
      const event = await store.enqueue(timed('event-key-0000000001'), 1_003);
      const tenant = await store.enqueue(timed(`${slot(60_000)}-${'a'.repeat(40)}`), 1_004);
      const claimed = await store.claim(1_500);
      assert.deepEqual(
        claimed.map((claim) => claim.id),
        [first.id, other.id, event.id, tenant.id],
      );
      // While the slot's run holds its lease, the manual run waits; once it ends, the manual run is claimed.
      assert.deepEqual(await store.claim(1_600), []);
      await store.succeed(claimed[0].id, claimed[0].fence, 1_700);
      assert.deepEqual(
        (await store.claim(1_800)).map((claim) => claim.id),
        [manual.id],
      );
    });
  });

describe('job store on SQLite only', () => {
  const file = (t: { after(run: () => void): void }) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-job-store-sqlite-')),
      path = join(directory, 'app.db');
    new DatabaseSync(path).close();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return { directory, path };
  };

  test('provisioning and opening never create a missing file', (t) => {
    const { directory } = file(t),
      absent = join(directory, 'absent.db');
    assert.throws(() => provisionSqliteJobStore(absent, policy()), JobStoreUnavailable);
    assert.throws(() => openSqliteJobStore(absent, policy()), JobStoreUnavailable);
    assert.equal(existsSync(absent), false);
  });

  for (const sql of [
    `CREATE TABLE __mistri_job_unexpected (id TEXT)`,
    `CREATE TABLE __MISTRI_JOB_lookalike (id TEXT)`,
    `CREATE TRIGGER extra AFTER UPDATE ON "${tables.job}" BEGIN SELECT 1; END`,
    `DROP INDEX __mistri_job_due`,
    `UPDATE "${tables.policy}" SET version=2`,
    `UPDATE "${tables.policy}" SET policy_json='{}'`,
  ])
    test(`changed reserved schema is refused: ${sql}`, (t) => {
      const { path } = file(t);
      provisionSqliteJobStore(path, policy());
      const db = new DatabaseSync(path);
      t.after(() => db.close());
      db.exec('PRAGMA ignore_check_constraints=ON');
      db.exec(sql);
      assert.throws(() => openSqliteJobStore(path, policy()), JobStoreUnavailable);
      assert.throws(() => provisionSqliteJobStore(path, policy()), JobStoreUnavailable);
    });

  test('a TEMP shadow or disabled foreign keys refuse attestation', (t) => {
    const { path } = file(t);
    provisionSqliteJobStore(path, policy());
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    t.after(() => db.close());
    assertSqliteJobStore(db, captureJobPolicy(policy()));
    db.exec(`CREATE TEMP TRIGGER shadow AFTER INSERT ON main."${tables.job}" BEGIN SELECT 1; END`);
    assert.throws(() => assertSqliteJobStore(db, captureJobPolicy(policy())), JobStoreUnavailable);
    db.exec('DROP TRIGGER temp.shadow');
    db.exec('PRAGMA foreign_keys=OFF');
    assert.throws(() => assertSqliteJobStore(db, captureJobPolicy(policy())), JobStoreUnavailable);
  });

  test('a history row written by hand cannot pass for an operator redrive', async (t) => {
    const { path } = file(t);
    provisionSqliteJobStore(path, policy());
    const store: JobStore = openSqliteJobStore(path, policy());
    t.after(() => store.close());
    const { id } = await store.enqueue(request(), 1_000);
    const [claim] = await store.claim(1_000);
    await store.fail(id, claim.fence, 1_000, 'rejected');
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    db.prepare(`INSERT INTO "${tables.attempt}" VALUES (?,2,NULL,1001,NULL,'redriven','redriven',1001,'intruder')`).run(id);
    db.prepare(`UPDATE "${tables.job}" SET state='retry',attempts=2,last_code='redriven' WHERE id=?`).run(id);
    await assert.rejects(store.inspect(), JobStoreUnavailable);
  });
});
