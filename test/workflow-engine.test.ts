/**
 * Durable workflows, at the engine (Q0 Proof 2): the cases a loan decision
 * goes through, driven on a controlled clock over a real workflow store, on
 * SQLite and, when `TABLEWALK_TEST_PG` names a server, PostgreSQL. The host
 * seams (jobs, receipts, delivery) are workflow-host.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { WorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStoreContract.js';
import {
  migratePostgresWorkflowStore,
  provisionSqliteWorkflowStore,
} from '../packages/mistri/src/adapters/workflows/workflowStoreSchema.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import { openPostgresWorkflowStore } from '../packages/mistri/src/adapters/workflows/postgresWorkflowStore.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { defineEvent } from '../packages/mistri/src/server/commands/businessEvents.js';
import { bool, number, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createWorkflowDriver } from '../packages/mistri/src/server/testing/workflows.js';
import { defineWorkflow, StepRefused, type WorkflowApi } from '../packages/mistri/src/server/workflows.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

interface Applied {
  id: string;
  amount: number;
}
interface Decided {
  id: string;
  approved: boolean;
}
const Applied = defineEvent('loan.applied', shape({ id: text(), amount: number() }));
const Decided = defineEvent('loan.decided', shape({ id: text(), approved: bool() }));

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
const workflow = (run: (w: WorkflowApi, start: Applied) => Promise<unknown>) =>
  defineWorkflow({ runAs: 'underwriter', start: { event: Applied, key: (event) => event.id }, listens: [Decided], run });

/** Decide automatically under a score, refer to a person above it. */
const underwrite = workflow(async (w, start) => {
  const { score } = await w.call<{ score: number }>(
    'score',
    'bureau',
    { path: '/score', body: { id: start.id } },
    { retry: { attempts: 4, backoff: '1 second' } },
  );
  if (score >= 700) return w.run('approve', 'approveLoan', { target: start.id });
  await w.run('refer', 'referLoan', { target: start.id });
  const decision = await w.waitFor('decision', Decided, { match: (event) => event.id === start.id, timeout: '2 days' });
  if (decision === null) return w.run('lapse', 'lapseLoan', { target: start.id });
  return w.run(decision.approved ? 'approve' : 'decline', decision.approved ? 'approveLoan' : 'declineLoan', { target: start.id });
});
const commands = () => ({
  approveLoan: () => ({ ok: 'approved' }),
  declineLoan: () => ({ ok: 'declined' }),
  referLoan: () => ({ ok: 'referred' }),
  lapseLoan: () => ({ ok: 'lapsed' }),
  remindLoan: () => ({ ok: 'reminded' }),
});

function suite(name: string, skip: false | string, open: () => Promise<{ store?: WorkflowStore; done?: () => Promise<void> }>) {
  describe(`workflows on ${name}`, { skip }, () => {
    const drivers: Awaited<ReturnType<typeof createWorkflowDriver>>[] = [];
    const done: (() => Promise<void>)[] = [];
    after(async () => {
      for (const driver of drivers) await driver.close();
      for (const fn of done) await fn();
    });
    const make = async (declared: ReturnType<typeof workflow>, extra: Partial<Parameters<typeof createWorkflowDriver>[0]> = {}) => {
      const opened = await open();
      if (opened.done) done.push(opened.done);
      const driver = await createWorkflowDriver({
        workflow: { loan: declared },
        commands: commands(),
        calls: { bureau: () => ({ score: 720 }) },
        ...(opened.store ? { store: opened.store } : {}),
        ...extra,
      });
      drivers.push(driver);
      return driver;
    };
    const only = async (driver: Awaited<ReturnType<typeof make>>) => {
      const instances = await driver.instances();
      assert.equal(instances.length, 1);
      return instances[0];
    };

    test('a high score approves at once, once, and a repeated event starts nothing new', async () => {
      const driver = await make(underwrite);
      await driver.emit(Applied, { id: 'L-1', amount: 5_000 }, 'evt-a');
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('approveLoan'), 1);
      await driver.emit(Applied, { id: 'L-1', amount: 5_000 }, 'evt-a');
      assert.equal((await driver.instances()).length, 1);
      assert.equal(driver.executed('approveLoan'), 1);
    });

    test('a referral waits for the decision and finishes on it', async () => {
      const driver = await make(underwrite, { calls: { bureau: () => ({ score: 500 }) } });
      await driver.emit(Applied, { id: 'L-2', amount: 9_000 });
      const waiting = await only(driver);
      assert.equal(waiting.state, 'waiting');
      assert.equal(waiting.currentStep, 'decision');
      assert.equal(driver.executed('referLoan'), 1);
      await driver.emit(Decided, { id: 'someone-else', approved: true });
      assert.equal((await only(driver)).state, 'waiting', 'a decision for another loan does not match');
      await driver.emit(Decided, { id: 'L-2', approved: false });
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('declineLoan'), 1);
      assert.equal(driver.executed('approveLoan'), 0);
    });

    test('a referral nobody decides lapses at its timeout, not before', async () => {
      const driver = await make(underwrite, { calls: { bureau: () => ({ score: 500 }) } });
      await driver.emit(Applied, { id: 'L-3', amount: 9_000 });
      await driver.advance(2 * DAY - 1);
      assert.equal((await only(driver)).state, 'waiting');
      await driver.advance(1);
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('lapseLoan'), 1);
    });

    test('a reminder loop: each silent day sends one, and the decision ends it', async () => {
      const reminding = workflow(async (w, start) => {
        for (let day = 1; day <= 3; day++) {
          const decision = await w.waitFor(['decision', day], Decided, { timeout: '1 day' });
          if (decision) return w.run('settle', 'approveLoan', { target: start.id });
          await w.run(['remind', day], 'remindLoan', { target: start.id });
        }
        return w.run('lapse', 'lapseLoan', { target: start.id });
      });
      const driver = await make(reminding);
      await driver.emit(Applied, { id: 'L-4', amount: 1 });
      await driver.advance(DAY);
      await driver.advance(DAY);
      assert.equal(driver.executed('remindLoan'), 2);
      await driver.emit(Decided, { id: 'L-4', approved: true });
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('remindLoan'), 2);
      assert.equal(driver.executed('approveLoan'), 1);
    });

    test('a provider that fails twice is asked again after its back-off, then succeeds', async () => {
      let tries = 0;
      const driver = await make(underwrite, {
        calls: {
          bureau: () => {
            if (++tries <= 2) throw Object.assign(new Error('down'), { code: 'http_503' });
            return { score: 800 };
          },
        },
      });
      await driver.emit(Applied, { id: 'L-5', amount: 1 });
      assert.equal((await only(driver)).state, 'waiting', 'backing off, not failed');
      await driver.advance(1_000);
      assert.equal(tries, 2);
      await driver.advance(2_000);
      assert.equal(tries, 3);
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('approveLoan'), 1);
    });

    test('a provider that never answers exhausts its attempts and the instance fails at that step', async () => {
      const driver = await make(underwrite, {
        calls: {
          bureau: () => {
            throw new Error('down');
          },
        },
      });
      await driver.emit(Applied, { id: 'L-6', amount: 1 });
      // Each try is one wake-up: the back-off is 1s, then 2s, then 4s.
      for (const wait of [1_000, 2_000, 4_000]) {
        assert.equal((await only(driver)).state, 'waiting');
        await driver.advance(wait);
      }
      const failed = await only(driver);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.problemStep, 'score');
      assert.equal(driver.executed('call:bureau'), 4);
    });

    test('a decision that arrives before the wait is not lost', async () => {
      const early = workflow(async (w, start) => {
        await w.sleep('review', '1 hour');
        const decision = await w.waitFor('decision', Decided, { timeout: '2 days' });
        return decision ? w.run('settle', 'approveLoan', { target: start.id }) : w.run('lapse', 'lapseLoan', { target: start.id });
      });
      const driver = await make(early);
      await driver.emit(Applied, { id: 'L-7', amount: 1 });
      await driver.emit(Decided, { id: 'L-7', approved: true });
      assert.equal((await only(driver)).state, 'waiting', 'still asleep');
      await driver.advance(HOUR);
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('approveLoan'), 1);
      assert.equal(driver.executed('lapseLoan'), 0);
    });

    test('a decision from before the instance began is not its own', async () => {
      const driver = await make(underwrite, { calls: { bureau: () => ({ score: 500 }) } });
      await driver.emit(Decided, { id: 'L-8', approved: true });
      await driver.emit(Applied, { id: 'L-8', amount: 1 });
      assert.equal((await only(driver)).state, 'waiting');
    });

    test('a process killed after a command committed resumes without running the command twice', async () => {
      const driver = await make(underwrite);
      driver.killDuring('approve');
      await driver.emit(Applied, { id: 'L-9', amount: 1 });
      assert.equal(driver.executed('approveLoan'), 1);
      assert.equal((await only(driver)).state, 'running', 'the advance died with the step unrecorded');
      const id = (await only(driver)).id;
      assert.equal(await driver.resume(id), 'completed');
      assert.equal(driver.executed('approveLoan'), 1, 'the receipt answered the second ask');
      assert.equal((await only(driver)).state, 'completed');
    });

    test('a refused step fails the instance at once; retrying runs from that step, and cancelling ends a waiting one', async () => {
      let open = false;
      const driver = await make(underwrite, {
        commands: {
          ...commands(),
          approveLoan: () => {
            if (!open) throw new StepRefused('approve', 'limit_exceeded');
            return { ok: 'approved' };
          },
        },
      });
      await driver.emit(Applied, { id: 'L-10', amount: 1 });
      const failed = await only(driver);
      assert.deepEqual([failed.state, failed.problemStep, failed.problem], ['failed', 'approve', 'step_refused']);
      assert.equal((await driver.steps(failed.id)).find((step) => step.name === 'approve')?.errorCode, 'limit_exceeded');
      await driver.advance(HOUR);
      assert.equal(driver.executed('call:bureau'), 1, 'a refusal is not retried');
      open = true;
      await driver.retry(failed.id);
      assert.equal((await only(driver)).state, 'completed');
      assert.equal(driver.executed('call:bureau'), 1, 'the steps before the refusal were kept');
      await assert.rejects(driver.retry(failed.id), /retry|not/i);

      const other = await make(underwrite, { calls: { bureau: () => ({ score: 500 }) } });
      await other.emit(Applied, { id: 'L-11', amount: 1 });
      const waiting = await only(other);
      assert.deepEqual(await other.cancel(waiting.id), { outcome: 'cancelled', state: 'cancelled' });
      await other.emit(Decided, { id: 'L-11', approved: true });
      await other.advance(3 * DAY);
      assert.equal((await only(other)).state, 'cancelled');
      assert.equal(other.executed('approveLoan') + other.executed('lapseLoan'), 0);
      assert.equal((await other.cancel(waiting.id)).outcome, 'unchanged');
    });

    test('a new code version that adds a step after the recorded ones continues the instance', async () => {
      const opened = await open();
      if (opened.done) done.push(opened.done);
      const store = opened.store;
      const before = workflow(async (w, start) => {
        await w.run('refer', 'referLoan', { target: start.id });
        await w.waitFor('decision', Decided, { timeout: '2 days' });
        return w.run('approve', 'approveLoan', { target: start.id });
      });
      const after_ = workflow(async (w, start) => {
        await w.run('refer', 'referLoan', { target: start.id });
        await w.waitFor('decision', Decided, { timeout: '2 days' });
        await w.run('notify', 'remindLoan', { target: start.id });
        return w.run('approve', 'approveLoan', { target: start.id });
      });
      const first = await createWorkflowDriver({ workflow: { loan: before }, commands: commands(), ...(store ? { store } : {}) });
      drivers.push(first);
      await first.emit(Applied, { id: 'L-12', amount: 1 });
      const id = (await only(first)).id;
      const second = await createWorkflowDriver({ workflow: { loan: after_ }, commands: commands(), store: first.store });
      drivers.push(second);
      await second.emit(Decided, { id: 'L-12', approved: true });
      await second.resume(id);
      assert.equal((await only(second)).state, 'completed');
      assert.equal(second.executed('remindLoan'), 1);
      assert.equal(second.executed('approveLoan'), 1);
    });

    test('a new code version that changes a recorded step diverges the instance, and runs nothing', async () => {
      const opened = await open();
      if (opened.done) done.push(opened.done);
      const before = workflow(async (w, start) => {
        await w.run('refer', 'referLoan', { target: start.id });
        await w.sleep('review', '1 hour');
        return w.run('approve', 'approveLoan', { target: start.id });
      });
      const changed = workflow(async (w, start) => {
        await w.run('refer', 'declineLoan', { target: start.id });
        await w.sleep('review', '1 hour');
        return w.run('approve', 'approveLoan', { target: start.id });
      });
      const first = await createWorkflowDriver({
        workflow: { loan: before },
        commands: commands(),
        ...(opened.store ? { store: opened.store } : {}),
      });
      drivers.push(first);
      await first.emit(Applied, { id: 'L-13', amount: 1 });
      const id = (await only(first)).id;
      const second = await createWorkflowDriver({ workflow: { loan: changed }, commands: commands(), store: first.store });
      drivers.push(second);
      assert.equal(await second.resume(id), 'diverged');
      const diverged = await only(second);
      assert.deepEqual([diverged.state, diverged.problemStep], ['diverged', 'refer']);
      assert.equal(second.executed('declineLoan'), 0);
      assert.equal(second.executed('approveLoan'), 0);
    });

    test("a call that would replace the connection's credential, or say what no request can, fails at once and is never sent", async () => {
      for (const [id, request] of [
        ['L-h1', { path: '/score', headers: { Authorization: 'Bearer someone-elses' } }],
        ['L-h2', { path: '/score', headers: { host: 'internal.example' } }],
        ['L-h3', { path: '/score', headers: { 'x-trace': 'line\r\nbreak' } }],
        ['L-h4', { path: '/score', method: 'TRACE' }],
        ['L-h5', { path: '/../admin' }],
      ] as const) {
        let sent = 0;
        const driver = await make(
          workflow(async (w) => w.call('score', 'bureau', request as never)),
          { calls: { bureau: () => (sent++, { score: 720 }) } },
        );
        await driver.emit(Applied, { id, amount: 1 });
        const failed = await only(driver);
        assert.deepEqual([failed.state, failed.problem], ['failed', 'workflow_error'], id);
        assert.equal(sent, 0, `${id}: nothing went out`);
      }
      // A header of the call's own, and the Idempotency-Key a provider names differently, still go.
      let headers: unknown;
      const driver = await make(
        workflow(async (w) => w.call('score', 'bureau', { path: '/score', headers: { 'X-Trace': 'abc', 'Idempotency-Key': 'k-1' } })),
        { calls: { bureau: (request: { headers?: unknown }) => ((headers = request.headers), { score: 720 }) } },
      );
      await driver.emit(Applied, { id: 'L-h6', amount: 1 });
      assert.equal((await only(driver)).state, 'completed');
      assert.deepEqual(headers, { 'X-Trace': 'abc', 'Idempotency-Key': 'k-1' });
    });

    test("a workflow's own error is kept by its name and code, never its message", async () => {
      const cases = [
        ['L-e1', Object.assign(new Error('card 4242 secret-token'), { code: 'ECONNRESET' }), { name: 'Error', code: 'ECONNRESET' }],
        ['L-e2', new TypeError('secret-token is not a function'), { name: 'TypeError' }],
        ['L-e3', Object.assign(new RangeError('x'), { code: 'a sentence with secret-token' }), { name: 'RangeError' }],
        ['L-e4', Object.assign(new Error('x'), { code: 23505 }), { name: 'Error', code: '23505' }],
        ['L-e5', 'secret-token', undefined],
        ['L-e6', Object.assign(new Error('x'), { name: 'secret token, said as a name' }), undefined],
      ] as const;
      for (const [id, thrown, kept] of cases) {
        const driver = await make(
          workflow(async () => {
            throw thrown;
          }),
        );
        await driver.emit(Applied, { id, amount: 1 });
        const failed = await only(driver);
        assert.deepEqual([failed.state, failed.problem, failed.problemError], ['failed', 'workflow_error', kept], id);
        assert.doesNotMatch(JSON.stringify(failed), /secret/, id);
      }
    });
  });
}

suite('SQLite', false, async () => ({}));
let url: string | undefined;
suite('PostgreSQL', liveSkip('postgres', LIVE_PG), async () => {
  url ??= await ownedPostgresDatabase();
  await migratePostgresWorkflowStore(url, 'engine');
  const control = await pgControl(url);
  // One instance per key is the store's rule, so each test starts from nothing.
  await control.query(
    `TRUNCATE ${['signal', 'action', 'step', 'instance'].map((name) => runtimeTable('postgres', `__mistri_workflow_${name}`)).join(', ')}`,
  );
  await control.end();
  const manager = new PgConnectionManager(url);
  const store = await openPostgresWorkflowStore(manager, 'engine');
  return {
    store,
    done: async () => {
      await store.close();
      await manager.close();
    },
  };
});

test('a store that cannot record the end aborts the advance rather than ending the process', { timeout: 20_000 }, async (t) => {
  /* The end of an advance is written where nothing awaits it. A rejected
     write there — a dropped connection, a failover — was an unhandled
     rejection, which ends a Node process, and the advance never returned. */
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-workflow-finish-'));
  const file = join(directory, 'workflows.db');
  writeFileSync(file, '');
  provisionSqliteWorkflowStore(file);
  const real = openSqliteWorkflowStore(file);
  let refused = 0;
  const store: WorkflowStore = {
    ...real,
    finish: async () => {
      refused += 1;
      throw new Error('Connection terminated unexpectedly');
    },
  };
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', note);
  const driver = await createWorkflowDriver({
    workflow: { loan: underwrite },
    commands: commands(),
    calls: { bureau: () => ({ score: 720 }) },
    store,
  });
  t.after(async () => {
    process.off('unhandledRejection', note);
    await driver.close();
    await real.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // Resolving at all is the advance returning: it used to hang on a promise nothing settled.
  await driver.emit(Applied, { id: 'L-finish', amount: 5_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(refused >= 1, 'the end was attempted');
  assert.deepEqual(unhandled, []);
  const [instance] = await driver.instances();
  assert.notEqual(instance.state, 'completed', 'an end the store refused is not recorded as one');
});
