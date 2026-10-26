/** Two Apps' operations for the Console's Operations and Analytics rooms: a
 * real SQLite job store holding a dead job each, in-memory deliveries and
 * workflows, and a real analytics store. `depot` grants its `operator` every
 * operations word; `ledger` grants its `operator` jobs only. */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseAppConfig } from '../../packages/mistri/src/shared/app.js';
import { openSqliteJobStore } from '../../packages/mistri/src/adapters/jobs/jobStore.js';
import { provisionSqliteJobStore } from '../../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import type { JobStore } from '../../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import { EventDeliveryRefusal, type EventDeliveryInspection } from '../../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { jobQueueOperator, type DeliveryQueueOperator } from '../../packages/mistri/src/server/operations/queueOperator.js';
import type { WorkflowOperator } from '../../packages/mistri/src/server/workflows/workflowOperator.js';
import { WorkflowRefusal, type WorkflowInspection } from '../../packages/mistri/src/adapters/workflows/workflowStoreTypes.js';
import { openAnalyticsStore, provisionAnalyticsStore, type AnalyticsStore } from '../../packages/mistri/src/server/analytics/store.js';
import { consoleStoreStatuses, type ConsoleOperationsOwner } from '../../packages/mistri/src/server/console/operations.js';
import type { ConsoleOperationsBuilder } from './consoleHost.js';

const ROLES = ['clerk', 'operator'] as const;
function appDef(id: string, operations: readonly string[], analytics = false) {
  return parseAppConfig(
    {
      id,
      name: id === 'depot' ? 'Depot' : 'Ledger',
      auth: { signUp: 'invite', defaultRole: 'clerk', roles: { clerk: { read: true }, operator: { read: true, operations } } },
      resources: { items: {} },
      views: { items: { kind: 'list', from: 'items' } },
      home: 'items',
      ...(analytics
        ? {
            analytics: {
              collect: ['views'],
              events: { ordered: { fields: ['sku'] } },
              funnels: { checkout: { unit: 'subject', conversionWindow: '24 hours', steps: [{ view: 'items' }, { event: 'ordered' }] } },
            },
          }
        : {}),
    },
    `${id} App`,
  );
}

/** A job that ran out of its budget: dead, and so redrivable. */
async function deadJob(store: JobStore, job: string, now: number): Promise<string> {
  await store.enqueue(
    {
      job,
      version: 1,
      idempotencyKey: `${job}-first-attempt-key`,
      input: {},
      maxAttempts: 1,
      provenance: { appId: 'fixture', actorId: 'service:fixture' },
    },
    now,
  );
  const [claim] = await store.claim(now + 1);
  await store.fail(claim.id, claim.fence, now + 2, 'handler_error');
  return claim.id;
}

export interface ConsoleOperationsState {
  dead: Record<'depot' | 'ledger', string>;
  jobs: Record<'depot' | 'ledger', JobStore>;
  deliveries: EventDeliveryInspection[];
  redriven: { eventId: string; operator: string }[];
  workflow: { cancelled?: string; retried?: string };
}

export function consoleOperations(state: Partial<ConsoleOperationsState> = {}): {
  build: ConsoleOperationsBuilder;
  state: ConsoleOperationsState;
  close(): Promise<void>;
} {
  const opened: { close(): Promise<void> }[] = [];
  const full = state as ConsoleOperationsState;
  full.redriven = [];
  full.workflow = {};
  full.deliveries = [
    {
      eventId: 'evt-1',
      receiptId: 'r-1',
      ordinal: 1,
      state: 'failed',
      attempts: 3,
      maxAttempts: 3,
      redrives: 0,
      nextAt: 0,
      leaseUntil: null,
      lastCode: 'rejected',
    },
    {
      eventId: 'evt-2',
      receiptId: 'r-2',
      ordinal: 2,
      state: 'delivered',
      attempts: 1,
      maxAttempts: 3,
      redrives: 0,
      nextAt: 0,
      leaseUntil: null,
      lastCode: 'accepted',
    },
  ];
  const deliveries: DeliveryQueueOperator = Object.freeze({
    id: 'webhook:warehouse',
    kind: 'webhook' as const,
    name: 'warehouse',
    list: async (filter: { state?: string }) => full.deliveries.filter((row) => !filter.state || row.state === filter.state),
    attempts: async () => [],
    async redrive(eventId: string, operator: string) {
      const index = full.deliveries.findIndex((row) => row.eventId === eventId);
      if (index < 0) throw new EventDeliveryRefusal('not_found');
      if (full.deliveries[index].state !== 'failed') throw new EventDeliveryRefusal('not_redrivable');
      full.deliveries[index] = { ...full.deliveries[index], state: 'retry', redrives: full.deliveries[index].redrives + 1 };
      full.redriven.push({ eventId, operator });
      return full.deliveries[index];
    },
  });
  const instance: WorkflowInspection = {
    id: '00000000-0000-4000-8000-000000000001',
    workflow: 'restock',
    version: 1,
    key: 'sku-1',
    state: 'failed',
    currentStep: 'order',
    waitEvent: null,
    wakeAt: null,
    problem: 'handler_error',
    problemStep: 'order',
    createdAt: 0,
    updatedAt: 0,
  };
  const workflows: WorkflowOperator = {
    list: async () => [instance],
    steps: async () => [],
    actions: async () => [],
    async cancel(id, operator) {
      full.workflow.cancelled = `${id}:${operator}`;
      return { outcome: 'unchanged', state: 'failed' };
    },
    async retry(id, operator) {
      if (id !== instance.id) throw new WorkflowRefusal('not_found');
      full.workflow.retried = `${id}:${operator}`;
      return instance;
    },
  };
  const build: ConsoleOperationsBuilder = async ({ auth, dir }) => {
    const owners: ConsoleOperationsOwner[] = [];
    full.dead = {} as ConsoleOperationsState['dead'];
    full.jobs = {} as ConsoleOperationsState['jobs'];
    let analytics: AnalyticsStore | undefined;
    for (const id of ['depot', 'ledger'] as const) {
      const path = join(dir, `${id}-jobs.db`);
      new DatabaseSync(path).close();
      const policy = { namespace: id };
      provisionSqliteJobStore(path, policy);
      const store = openSqliteJobStore(path, policy);
      opened.push(store);
      full.jobs[id] = store;
      full.dead[id] = await deadJob(store, id === 'depot' ? 'restock' : 'reconcile', Date.now() - 60_000);
      const app = appDef(id, id === 'depot' ? ['jobs', 'deliveries', 'workflows', 'stores', 'analytics'] : ['jobs'], id === 'depot');
      if (id === 'depot') {
        const url = join(dir, 'depot-analytics.db');
        await provisionAnalyticsStore({ url, binding: { appId: 'depot', deploymentId: 'production' } });
        analytics = await openAnalyticsStore({ url, binding: { appId: 'depot', deploymentId: 'production' } });
        opened.push(analytics);
        const at = Date.now() - 3_600_000;
        await analytics.append([
          { occurredAt: at, environment: 'production', kind: 'view', name: 'items', unitKind: 'subject', unitId: 'subject-a' },
          { occurredAt: at + 1, environment: 'production', kind: 'view', name: 'items', unitKind: 'subject', unitId: 'subject-b' },
          {
            occurredAt: at + 2,
            environment: 'production',
            kind: 'event',
            name: 'ordered',
            unitKind: 'subject',
            unitId: 'subject-a',
            fields: { sku: 'secret-sku' },
          },
          { occurredAt: at + 3, environment: 'production', kind: 'view', name: 'items', unitKind: 'visitor', unitId: 'visitor-z' },
          { occurredAt: at + 4, environment: 'production', kind: 'view', name: 'items' },
          {
            occurredAt: at + 5,
            environment: 'production',
            kind: 'business',
            name: 'order.placed',
            unitKind: 'subject',
            unitId: 'subject-a',
            sourceEventId: 'src-1',
          },
        ]);
      }
      owners.push({
        appId: id,
        name: app.name,
        app: () => app,
        auth: auth(id, ROLES),
        jobs: jobQueueOperator(store, Date.now),
        ...(id === 'depot'
          ? {
              deliveries: [deliveries],
              workflows,
              analytics: () => analytics,
              stores: consoleStoreStatuses(() => [
                { name: 'jobs', url: path },
                { name: 'analytics', url: join(dir, 'depot-analytics.db') },
              ]),
            }
          : {}),
      });
    }
    return owners;
  };
  return {
    build,
    state: full,
    close: async () => {
      for (const owner of opened.splice(0)) await owner.close().catch(() => {});
    },
  };
}
