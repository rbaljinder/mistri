import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import { JOB_TABLES as tables } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import {
  JobRefusal,
  JobStoreUnavailable,
  type JobEnqueueInput,
  type JobPolicyInput,
} from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import {
  createJobRunner,
  JobCancelled,
  JobRejected,
  type JobAuthorizationRequest,
  type JobRunner,
} from '../packages/mistri/src/server/jobs/jobRunner.js';
import {
  defineJobHandler,
  defineJobHandlers,
  JobDefinitionError,
  type JobContext,
  type JobGrant,
} from '../packages/mistri/src/server/jobs/jobs.js';
import { jobEngines, type JobEngine } from './support/jobStoreEngines.js';

const policy: JobPolicyInput = {
  namespace: 'proof',
  maxAttempts: 3,
  leaseMs: 1_000,
  backoffMs: { base: 100, cap: 1_000 },
  maxInputBytes: 1_024,
  maxInFlight: 4,
};
const provenance = Object.freeze({
  appId: 'ledger',
  actorId: 'native-account-proof',
  tenantId: 'north',
  correlationId: 'request-1',
  causationId: 'event-9',
});
const request = (extra: Partial<JobEnqueueInput> = {}): JobEnqueueInput => ({
  job: 'remind',
  version: 1,
  idempotencyKey: 'idempotency-key-0001',
  input: { loanId: 7 },
  provenance,
  ...extra,
});
type Handler = (context: JobContext, input: { loanId: number }) => unknown;
const parse = (value: unknown) => {
  if (!value || typeof value !== 'object' || typeof (value as { loanId?: unknown }).loanId !== 'number') throw new Error('loanId required');
  return value as { loanId: number };
};
/** The disposable authorizer answers every attempt from `grants`, counting
 * calls, so the tests can prove that no attempt reuses an earlier grant. */
async function fixture(t: TestContext, engine: JobEngine) {
  const f = await engine.fixture(t, policy);
  const runners: JobRunner[] = [];
  t.after(async () => {
    for (const runner of runners) await runner.halt();
  });
  const clock = { now: 1_000 };
  const requests: JobAuthorizationRequest[] = [];
  let grants: (() => JobGrant | null)[] = [];
  const authorize = (value: JobAuthorizationRequest) => {
    requests.push(value);
    return (grants.shift() ?? grant)();
  };
  const grant = (ttl = 10_000): JobGrant => ({
    audience: 'mistri.jobs',
    job: 'remind',
    version: 1,
    appId: provenance.appId,
    expiresAt: clock.now + ttl,
  });
  const runner = (store: JobStore, handle: Handler, options: { attemptTimeoutMs?: number; version?: number } = {}) => {
    const registry = defineJobHandlers({ remind: defineJobHandler({ version: options.version ?? 1, input: { parse }, handle }) });
    const created = createJobRunner({ store, registry, authorize, now: () => clock.now, attemptTimeoutMs: options.attemptTimeoutMs ?? 50 });
    runners.push(created);
    return created;
  };
  return {
    ...f,
    clock,
    requests,
    runner,
    grant,
    setGrants: (next: (() => JobGrant | null)[]) => {
      grants = next;
    },
    effect: () => f.exec('UPDATE job_fixture_effects SET sent = sent + 1 WHERE id = 1'),
    sent: () => f.scalar('SELECT sent FROM job_fixture_effects WHERE id = 1'),
  };
}

/** Real time passing, without a timer the mocked clock would never fire. */
async function outlast(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const engine of jobEngines)
  describe(`job runner on ${engine.name}`, { skip: engine.skip }, () => {
    test('a fresh grant per attempt, validated input and unchanged provenance reach the handler; success is recorded once', async (t) => {
      // This proves the success contract, not database latency against a 50ms
      // wall clock. Timeout and lease recovery have their own real-timer cases.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request(), f.clock.now);
      const seen: JobContext[] = [];
      const cancels: boolean[] = [];
      const runner = f.runner(store, async (context, input) => {
        seen.push(context);
        cancels.push(await context.cancelRequested());
        assert.deepEqual(input, { loanId: 7 });
        await f.effect();
        return { sent: true };
      });
      const tick = await runner.tick();
      assert.equal(tick.status, 'ran');
      assert.equal(tick.expired, 0);
      assert.deepEqual(tick.outcomes, [{ id, job: 'remind', attempt: 1, state: 'succeeded', code: 'succeeded' }]);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.requests[0], { audience: 'mistri.jobs', jobId: id, job: 'remind', version: 1, provenance, attempt: 1 });
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].provenance, provenance);
      assert.equal(seen[0].jobId, id);
      assert.equal(seen[0].attempt, 1);
      assert.equal(seen[0].maxAttempts, 3);
      assert.equal(seen[0].now(), 1_000);
      assert.equal(seen[0].grant.expiresAt, 11_000);
      assert.deepEqual(cancels, [false]);
      assert.ok(Object.isFrozen(seen[0]));
      // The lease is over: the live view refuses rather than guessing.
      await assert.rejects(seen[0].cancelRequested(), (error: unknown) => error instanceof JobRefusal && error.code === 'fence_stale');
      assert.equal((await runner.tick()).status, 'idle');
      assert.equal(await f.sent(), 1);
      assert.equal((await store.inspect())[0].state, 'succeeded');
    });

    test('a revoked grant on the second attempt fails as not_authorized without calling the handler', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request(), f.clock.now);
      let calls = 0;
      const runner = f.runner(store, () => {
        calls++;
        throw new Error('transient secret-error-text');
      });
      f.setGrants([f.grant, () => null]);
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.state, o.code]),
        [['retry', 'handler_error']],
      );
      f.clock.now = 1_100;
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[2, 'failed', 'not_authorized']],
      );
      assert.equal(calls, 1);
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1].attempt, 2);
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['retry', 'handler_error'],
          ['failed', 'not_authorized'],
        ],
      );
      assert.doesNotMatch(JSON.stringify({ rows: await store.inspect(), attempts: await store.attempts(id) }), /secret-error-text/);
    });

    test('a throwing authorizer and a mismatched grant are both not_authorized', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      await store.enqueue(request(), f.clock.now);
      let calls = 0;
      const runner = f.runner(store, () => {
        calls++;
      });
      f.setGrants([
        () => {
          throw new Error('authorizer down');
        },
      ]);
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => o.code),
        ['not_authorized'],
      );
      await store.enqueue(request({ idempotencyKey: 'idempotency-key-0002' }), f.clock.now);
      f.setGrants([() => ({ ...f.grant(), appId: 'other-app' })]);
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => o.code),
        ['not_authorized'],
      );
      await store.enqueue(request({ idempotencyKey: 'idempotency-key-0003' }), f.clock.now);
      f.setGrants([() => ({ ...f.grant(), expiresAt: f.clock.now })]);
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => o.code),
        ['not_authorized'],
      );
      assert.equal(calls, 0);
      assert.equal((await store.inspect({ state: 'failed' })).length, 3);
    });

    test('invalid input fails permanently without running the handler', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request({ input: { loanId: 'seven' } }), f.clock.now);
      let calls = 0;
      const runner = f.runner(store, () => {
        calls++;
      });
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.state, o.code]),
        [['failed', 'input_invalid']],
      );
      assert.equal(calls, 0);
      assert.equal((await store.attempts(id)).length, 1);
      f.clock.now = 5_000;
      assert.equal((await runner.tick()).status, 'idle');
    });

    test('a handler error retries with the next attempt number and then succeeds', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request(), f.clock.now);
      const attempts: number[] = [];
      const runner = f.runner(store, async (context) => {
        attempts.push(context.attempt);
        if (context.attempt === 1) throw new Error('flaky');
        await f.effect();
      });
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[1, 'retry', 'handler_error']],
      );
      assert.equal((await runner.tick()).status, 'idle');
      f.clock.now = 1_100;
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[2, 'succeeded', 'succeeded']],
      );
      assert.deepEqual(attempts, [1, 2]);
      assert.equal(f.requests.length, 2);
      assert.equal(await f.sent(), 1);
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.attempt, row.outcome, row.code]),
        [
          [1, 'retry', 'handler_error'],
          [2, 'succeeded', 'succeeded'],
        ],
      );
    });

    test('JobRejected is terminal and a registry that no longer defines the version rejects too', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request(), f.clock.now);
      const runner = f.runner(store, () => {
        throw new JobRejected('duplicate reminder');
      });
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.state, o.code]),
        [['failed', 'rejected']],
      );
      f.clock.now = 9_000;
      assert.equal((await runner.tick()).status, 'idle');
      assert.equal((await store.attempts(id)).length, 1);
      await store.enqueue(request({ idempotencyKey: 'idempotency-key-0002', version: 2 }), f.clock.now);
      let calls = 0;
      const stale = f.runner(store, () => {
        calls++;
      });
      assert.deepEqual(
        (await stale.tick()).outcomes.map((o) => [o.state, o.code]),
        [['failed', 'rejected']],
      );
      assert.equal(calls, 0);
    });

    test('timeout records unknown, keeps the lease, and a later runner takes over as attempt 2 with the same job', async (t) => {
      const f = await fixture(t, engine);
      const a = await f.open();
      const { id } = await a.enqueue(request(), f.clock.now);
      const seen: [number, string][] = [];
      const handle: Handler = (context) =>
        new Promise((resolve, reject) => {
          seen.push([context.attempt, context.jobId]);
          if (context.attempt === 2) {
            void f.effect().then(() => resolve('done'), reject);
            return;
          }
          context.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const first = f.runner(a, handle, { attemptTimeoutMs: 20 });
      assert.deepEqual(
        (await first.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[1, 'unknown', 'timeout']],
      );
      assert.equal(first.status(), 'running');
      assert.equal((await a.inspect())[0].state, 'unknown');
      assert.equal((await a.inspect())[0].leaseUntil, 2_000);
      f.clock.now = 1_500;
      assert.equal((await first.tick()).status, 'idle');
      await first.halt();
      const b = await f.open();
      const second = f.runner(b, handle);
      f.clock.now = 2_000;
      assert.equal((await second.tick()).status, 'idle');
      f.clock.now = 2_100;
      const tick = await second.tick();
      assert.deepEqual(
        tick.outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[2, 'succeeded', 'succeeded']],
      );
      assert.deepEqual(seen, [
        [1, id],
        [2, id],
      ]);
      assert.equal(await f.sent(), 1);
      assert.deepEqual(
        f.requests.map((r) => r.attempt),
        [1, 2],
      );
      assert.deepEqual(
        (await b.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'timeout'],
          ['succeeded', 'succeeded'],
        ],
      );
    });

    test('halt mid-run aborts the signal, records unknown shutdown, resolves after the handler settles, and a second runner resumes', async (t) => {
      const f = await fixture(t, engine);
      const a = await f.open();
      const { id } = await a.enqueue(request(), f.clock.now);
      let release!: () => void, started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let signal: AbortSignal | undefined;
      const first = f.runner(a, (context) => {
        signal = context.signal;
        started();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const tick = first.tick();
      await ready;
      assert.equal((await first.tick()).status, 'busy');
      const halting = first.halt();
      let halted = false;
      void halting.then(() => {
        halted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(signal!.aborted, true);
      assert.equal(halted, false);
      assert.equal(first.status(), 'halting');
      release();
      await halting;
      assert.equal(halted, true);
      assert.equal(first.status(), 'halted');
      assert.deepEqual(
        (await tick).outcomes.map((o) => [o.state, o.code]),
        [['unknown', 'shutdown']],
      );
      assert.equal((await first.tick()).status, 'halted');
      const b = await f.open();
      let calls = 0;
      const second = f.runner(b, async (context) => {
        calls++;
        assert.equal(context.attempt, 2);
        await f.effect();
      });
      f.clock.now = 2_000;
      assert.equal((await second.tick()).status, 'idle');
      f.clock.now = 2_100;
      assert.deepEqual(
        (await second.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[2, 'succeeded', 'succeeded']],
      );
      assert.equal(calls, 1);
      assert.equal(await f.sent(), 1);
      assert.deepEqual(
        (await b.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'shutdown'],
          ['succeeded', 'succeeded'],
        ],
      );
    });

    test('halt before the handler starts is a plain retry, never an unknown', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request(), f.clock.now);
      let calls = 0;
      let authorizing!: () => void;
      const asked = new Promise<void>((resolve) => {
        authorizing = resolve;
      });
      const runner = f.runner(store, () => {
        calls++;
      });
      f.setGrants([
        () => {
          authorizing();
          return f.grant();
        },
      ]);
      const tick = runner.tick();
      await asked;
      await runner.halt();
      assert.deepEqual(
        (await tick).outcomes.map((o) => [o.state, o.code]),
        [['retry', 'shutdown']],
      );
      assert.equal(calls, 0);
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.outcome, row.code]),
        [['retry', 'shutdown']],
      );
    });

    test('a cancel requested during the run is visible in the context and honoured cooperatively', async (t) => {
      // Both attempts span several store transactions, the test's two cancels
      // among them, on the runner's one writer connection: on a starved host
      // that outlives the 50ms attempt timeout, and a timed-out attempt is
      // rightly unknown, not cancelled or succeeded. The timer is the test's,
      // and the second job's handler is held past it in real time so that
      // stays proven.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await fixture(t, engine);
      const store = await f.open();
      const stopping = await store.enqueue(request({ idempotencyKey: 'idempotency-key-stops', input: { loanId: 1 } }), f.clock.now);
      const finishing = await store.enqueue(request({ idempotencyKey: 'idempotency-key-finish', input: { loanId: 2 } }), f.clock.now);
      const observed: [number, boolean, boolean][] = [];
      const releases: (() => void)[] = [];
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const runner = f.runner(store, async (context, input) => {
        observed.push([input.loanId, await context.cancelRequested(), context.signal.aborted]);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) started();
        });
        if (input.loanId === 2) await outlast(100);
        if (await context.cancelRequested()) {
          observed.push([input.loanId, true, context.signal.aborted]);
          if (input.loanId === 1) throw new JobCancelled();
        }
        await f.effect();
      });
      const tick = runner.tick();
      await ready;
      assert.deepEqual(await store.cancel(stopping.id, f.clock.now), { outcome: 'requested', state: 'leased' });
      assert.deepEqual(await store.cancel(finishing.id, f.clock.now), { outcome: 'requested', state: 'leased' });
      for (const release of releases) release();
      const outcomes = (await tick).outcomes;
      assert.deepEqual(
        outcomes.map((o) => [o.id, o.state, o.code]),
        [
          [stopping.id, 'cancelled', 'cancelled'],
          [finishing.id, 'succeeded', 'succeeded'],
        ],
      );
      assert.deepEqual([...observed].sort(), [
        [1, false, false],
        [1, true, false],
        [2, false, false],
        [2, true, false],
      ]);
      assert.equal(await f.sent(), 1);
      assert.equal((await store.inspect({ state: 'succeeded' }))[0].cancelRequested, true);
      assert.equal((await store.inspect({ state: 'cancelled' }))[0].cancelRequested, true);
    });

    test('no grant is retained: authority that lapses during a slow handler makes the attempt unknown, and the next attempt asks again', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      const { id } = await store.enqueue(request(), f.clock.now);
      // Authority expires on the injected clock. Keep the independent attempt
      // timer still so a slow database cannot turn this into the timeout test.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const seen: JobGrant[] = [];
      const runner = f.runner(store, async (context) => {
        seen.push(context.grant);
        await f.effect();
        if (context.attempt === 1) f.clock.now += 100;
      });
      f.setGrants([() => f.grant(50)]);
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[1, 'unknown', 'not_authorized']],
      );
      assert.equal(await f.sent(), 1);
      assert.equal((await store.inspect())[0].state, 'unknown');
      f.clock.now = 2_000;
      assert.equal((await runner.tick()).status, 'idle');
      f.clock.now = 2_100;
      assert.deepEqual(
        (await runner.tick()).outcomes.map((o) => [o.attempt, o.state, o.code]),
        [[2, 'succeeded', 'succeeded']],
      );
      assert.equal(f.requests.length, 2);
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0].expiresAt, seen[1].expiresAt);
      assert.equal(seen[1].expiresAt, 12_100);
      assert.equal(await f.sent(), 2);
      assert.deepEqual(
        (await store.attempts(id)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'not_authorized'],
          ['succeeded', 'succeeded'],
        ],
      );
    });

    test('an uncooperative handler that outlives its lease halts this runner and leaves the job to expiry', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      await store.enqueue(request(), f.clock.now);
      let calls = 0;
      const runner = f.runner(
        store,
        () => {
          calls++;
          return new Promise(() => {});
        },
        { attemptTimeoutMs: 10 },
      );
      const tick = await runner.tick();
      assert.deepEqual(
        tick.outcomes.map((o) => [o.state, o.code]),
        [['unknown', 'timeout']],
      );
      assert.equal(runner.status(), 'halted');
      assert.equal((await runner.tick()).status, 'halted');
      assert.equal(calls, 1);
      f.clock.now = 2_000;
      assert.equal(await store.expireLeases(f.clock.now), 1);
      assert.equal((await store.inspect())[0].state, 'retry');
    });

    test('a store that cannot record an outcome halts the runner and keeps the lease', async (t) => {
      const f = await fixture(t, engine);
      const store = await f.open();
      await store.enqueue(request(), f.clock.now);
      const runner = f.runner(store, () => f.exec(`DROP TABLE "${tables.attempt}"`));
      assert.equal((await runner.tick()).status, 'unavailable');
      assert.equal(runner.status(), 'halted');
      await assert.rejects(store.inspect(), JobStoreUnavailable);
    });

    test('definitions and runner options are validated without invoking handlers', async (t) => {
      const f = await fixture(t, engine);
      assert.throws(() => defineJobHandler({ version: 0, input: { parse }, handle() {} }), JobDefinitionError);
      assert.throws(
        () => defineJobHandler({ version: 1, input: { parse: async () => ({}) } as never, handle() {} }).input.parse({}),
        JobDefinitionError,
      );
      assert.throws(() => defineJobHandler({ version: 1, input: { parse }, handle() {}, extra: 1 } as never), JobDefinitionError);
      assert.throws(
        () => defineJobHandlers({ '1st': defineJobHandler({ version: 1, input: { parse }, handle() {} }) }),
        JobDefinitionError,
      );
      assert.throws(() => defineJobHandlers({ remind: { version: 1, input: { parse }, handle() {} } }), JobDefinitionError);
      assert.throws(() => defineJobHandlers({}), JobDefinitionError);
      const registry = defineJobHandlers({ remind: defineJobHandler({ version: 1, input: { parse }, handle() {} }) });
      assert.equal(Object.getPrototypeOf(registry), null);
      assert.ok(Object.isFrozen(registry));
      const store = await f.open();
      assert.throws(() => createJobRunner({ store, registry, authorize: () => null, attemptTimeoutMs: 1_000 }), JobStoreUnavailable);
      assert.throws(
        () => createJobRunner({ store, registry: { remind: registry.remind }, authorize: () => null, attemptTimeoutMs: 10 }),
        JobStoreUnavailable,
      );
    });
  });
