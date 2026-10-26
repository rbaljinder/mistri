/**
 * Several Apps on one PostgreSQL database, a suite's intended deployment:
 * each keeps its own event store, delivery store, job namespace and workflow
 * store beside the others, and one App's binding never attests as another's. Discovery reading
 * only its own App's batches is held end to end by suite-keystone.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { CommandEventStoreUnavailable } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { EventDeliveryUnavailable } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import {
  assertPostgresCommandEventStore,
  provisionPostgresCommandEventStore,
} from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import { provisionPostgresEventDeliveryStore } from '../packages/mistri/src/adapters/events/postgresEventDeliveryStore.js';
import { migratePostgresJobStore, openPostgresJobStore } from '../packages/mistri/src/adapters/jobs/postgresJobStore.js';
import { JobStoreUnavailable } from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { openPostgresWorkflowStore } from '../packages/mistri/src/adapters/workflows/postgresWorkflowStore.js';
import { migratePostgresWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStoreSchema.js';
import { WorkflowRefusal, WorkflowStoreUnavailable } from '../packages/mistri/src/adapters/workflows/workflowStoreTypes.js';
import { createWorkflowOperator } from '../packages/mistri/src/server/workflows/workflowOperator.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const source = (appId: string) => ({ appId, storeId: `app:${appId}`, sourceId: 'business' });
const destination = (appId: string, destinationId: string) => ({
  source: source(appId),
  serviceId: 'jobs',
  destinationId,
  routes: [{ scope: 'app' as const, commandId: 'assign', commandVersion: 1, manifest: [{ name: 'shared.event', version: 1 }] }],
  limits: { maxAttempts: 3, leaseMs: 100, timeoutMs: 20, backoffMs: 10, maxBackoffMs: 20, maxRetained: 64, scanBatch: 8 },
});

test(
  'two Apps on one PostgreSQL database each provision and attest their own event, delivery and job stores',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
  },
  async (t) => {
    const owned = await uuidPostgresDatabase('shared_stores');
    t.after(() => owned.drop());
    await migratePostgresCommandJournal(owned.url);
    assert.deepEqual(await provisionPostgresCommandEventStore(owned.url, source('lender')), { version: 1, provisioned: true });
    assert.deepEqual(await provisionPostgresCommandEventStore(owned.url, source('leads')), { version: 1, provisioned: true });
    assert.deepEqual(await provisionPostgresCommandEventStore(owned.url, source('leads')), { version: 1, provisioned: false });
    // An App's row is its own: the same App bound to another store or source is refused, unchanged.
    await assert.rejects(
      provisionPostgresCommandEventStore(owned.url, { ...source('leads'), storeId: 'elsewhere' }),
      CommandEventStoreUnavailable,
    );
    const client = await pgClient(owned.url);
    try {
      await assertPostgresCommandEventStore(client, source('lender'));
      await assertPostgresCommandEventStore(client, source('leads'));
      await assert.rejects(assertPostgresCommandEventStore(client, source('dealer')), CommandEventStoreUnavailable);
      assert.deepEqual((await client.query('SELECT app_id, store_id FROM mistri."event_meta" ORDER BY app_id')).rows, [
        { app_id: 'leads', store_id: 'app:leads' },
        { app_id: 'lender', store_id: 'app:lender' },
      ]);
    } finally {
      await client.end();
    }

    // Deliveries: a meta row per App, and sixteen destinations per App, not per database.
    for (let i = 0; i < 16; i++)
      assert.equal((await provisionPostgresEventDeliveryStore(owned.url, destination('lender', `lender-${i}`))).destinationAdded, true);
    await assert.rejects(provisionPostgresEventDeliveryStore(owned.url, destination('lender', 'lender-16')), EventDeliveryUnavailable);
    const leads = await provisionPostgresEventDeliveryStore(owned.url, destination('leads', 'leads-0'));
    assert.deepEqual(leads, { version: 1, provisioned: true, destinationAdded: true });
    // One destination id is one App's: another App naming it is a shared id, refused.
    await assert.rejects(provisionPostgresEventDeliveryStore(owned.url, destination('leads', 'lender-0')), EventDeliveryUnavailable);

    // Jobs: a namespace per App, each with its own bounds.
    const policy = (namespace: string, maxAttempts = 3) => ({
      namespace,
      maxAttempts,
      leaseMs: 5_000,
      backoffMs: { base: 100, cap: 1_000 },
      maxInputBytes: 1_024,
      maxInFlight: 1,
    });
    assert.deepEqual(await migratePostgresJobStore(owned.url, policy('lender')), { version: 1, migrated: true });
    assert.deepEqual(await migratePostgresJobStore(owned.url, policy('leads', 5)), { version: 1, migrated: true });
    await assert.rejects(migratePostgresJobStore(owned.url, policy('lender', 5)), JobStoreUnavailable);
  },
);

/* The workflow store, one per App on a shared database (security review H1):
   an App's operator, signals and wakes reach its own instances only. */
const jobPolicy = (namespace: string) => ({
  namespace,
  maxAttempts: 3,
  leaseMs: 5_000,
  backoffMs: { base: 100, cap: 1_000 },
  maxInputBytes: 1_024,
  maxInFlight: 1,
});

test(
  "two Apps on one PostgreSQL database never list, cancel, retry or wake each other's workflow instances",
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
  },
  async (t) => {
    const owned = await uuidPostgresDatabase('shared_workflows');
    t.after(() => owned.drop());
    for (const app of ['lender', 'leads']) {
      await migratePostgresJobStore(owned.url, jobPolicy(app));
      assert.deepEqual(await migratePostgresWorkflowStore(owned.url, app), { version: 1, migrated: true });
    }
    assert.deepEqual(await migratePostgresWorkflowStore(owned.url, 'leads'), { version: 1, migrated: false });
    const manager = new PgConnectionManager(owned.url);
    const a = await openPostgresWorkflowStore(manager, 'lender'),
      b = await openPostgresWorkflowStore(manager, 'leads');
    const jobsA = await openPostgresJobStore(manager, jobPolicy('lender'), { clock: 'caller' });
    t.after(async () => {
      await a.close();
      await b.close();
      await jobsA.close();
      await manager.close();
    });
    // An App with no row of its own is not handed another's store.
    await assert.rejects(openPostgresWorkflowStore(manager, 'dealer'), WorkflowStoreUnavailable);

    // The same workflow, key and start event in both: each App's own instance.
    const start = { workflow: 'review', version: 1, key: '"7"', eventId: 'start-7', startJson: '{"id":7}' };
    const ia = (await a.start(start, 1))!,
      ib = (await b.start(start, 1))!;
    assert.equal(ia.created && ib.created, true);
    assert.notEqual(ia.id, ib.id);
    for (const [store, id] of [
      [a, ia.id],
      [b, ib.id],
    ] as const) {
      const begun = (await store.begin(id, 2))!;
      assert.deepEqual(
        await store.suspend(id, begun.instance.epoch, { step: 'wait', event: { name: 'funded', version: 1 }, wakeAt: null, seenSeq: 0 }, 3),
        { epoch: begun.instance.epoch + 1 },
      );
    }
    // A's fact wakes A's wait only, and B never reads it.
    assert.deepEqual(
      await a.signal({ workflow: 'review', eventId: 'fund-1', name: 'funded', version: 1, payloadJson: '{"from":"lender"}' }, 4),
      [ia.id],
    );
    assert.deepEqual(await b.signals('review', 'funded', 1, 0), []);
    assert.equal((await a.signals('review', 'funded', 1, 0)).length, 1);
    // The same event id in B is B's own signal, not a duplicate of A's.
    assert.deepEqual(
      await b.signal({ workflow: 'review', eventId: 'fund-1', name: 'funded', version: 1, payloadJson: '{"from":"leads"}' }, 5),
      [ib.id],
    );
    assert.deepEqual(
      (await b.signals('review', 'funded', 1, 0)).map((signal) => signal.payloadJson),
      ['{"from":"leads"}'],
    );

    // A's operator sees, cancels and retries A's instances only.
    assert.deepEqual(
      (await a.inspect()).map((row) => row.id),
      [ia.id],
    );
    assert.deepEqual(await a.steps(ib.id), []);
    await assert.rejects(a.cancel(ib.id, 'ops', 6), (error: unknown) => error instanceof WorkflowRefusal && error.code === 'not_found');
    const runB = (await b.begin(ib.id, 7))!;
    assert.equal(await b.finish(ib.id, runB.instance.epoch, { state: 'failed', problem: 'step_failed', problemStep: null }, 8), true);
    const operatorA = createWorkflowOperator({ workflows: a, jobs: jobsA, appId: 'lender', now: () => 9 });
    await assert.rejects(operatorA.retry(ib.id, 'ops'), (error: unknown) => error instanceof WorkflowRefusal && error.code === 'not_found');
    await assert.rejects(
      operatorA.cancel(ib.id, 'ops'),
      (error: unknown) => error instanceof WorkflowRefusal && error.code === 'not_found',
    );
    assert.deepEqual(await jobsA.inspect(), [], "nothing of B's was enqueued in A's job store");
    assert.equal((await b.inspect({ state: 'failed' })).length, 1, "B's instance is as B left it");
    assert.deepEqual(await operatorA.actions(ib.id), []);

    // Within its own App the operator acts, and is kept in the history.
    assert.equal((await operatorA.cancel(ia.id, 'ops@lender')).outcome, 'cancelled');
    assert.deepEqual(
      (await a.actions(ia.id)).map((row) => [row.action, row.operator, row.at]),
      [['cancel', 'ops@lender', 9]],
    );
    assert.deepEqual(await b.actions(ia.id), []);
    // Pruning is per App too.
    assert.deepEqual(await b.prune(0, 1_000), { pruned: 0, more: false });
    assert.deepEqual(await a.prune(0, 1_000), { pruned: 1, more: false });
    assert.equal((await b.inspect()).length, 1);
  },
);
