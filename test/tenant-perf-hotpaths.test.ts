/**
 * Unit tests for multi-tenant performance hot-path fixes:
 * - createFlowTail forward pagination past 200 unsettled rows per tick
 * - LiveHub tenant-indexed fanout skipping authority() for unaffected tenants
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import { LiveHub, type LiveTap } from '../packages/mistri/src/server/live/liveHub.js';
import type { LiveStore } from '../packages/mistri/src/server/live/liveStore.js';
import { createFlowTail, type FlowChange } from '../packages/mistri/src/server/workflows/flowTail.js';

test('createFlowTail paginates forward past 200 unsettled rows in a single tick', async () => {
  const now = 1_700_000_000_000;
  const all: FlowChange[] = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1,
    at: now - 1_000, // all < 60s old (unsettled)
    workflow: 'order_flow',
    runAs: 'bot',
    byFlow: false,
    tenantId: `t-${index % 10}`,
    dispatch: { resource: 'order', event: 'created', key: { id: index + 1 } } as never,
  }));
  const enqueued: string[] = [];
  const jobs = {
    async enqueue(input: { idempotencyKey: string }) {
      enqueued.push(input.idempotencyKey);
    },
  } as unknown as JobStore;
  const reads: Array<{ after?: number; from?: string }> = [];
  const tail = createFlowTail({
    appId: 'shop',
    now: () => now,
    jobs,
    async read(query) {
      reads.push(query);
      const start = query.after ?? 0;
      return all.filter((row) => row.id > start).slice(0, 200);
    },
  });

  const didWork = await tail.tick();
  assert.equal(didWork, true);
  assert.equal(enqueued.length, 250, 'all 250 unsettled rows enqueued across 2 pages');
  assert.equal(reads.length, 2);
  assert.equal(reads[1]?.after, 200);
});

test('LiveHub only invokes authority() on subscribers of tenants whose rows changed', async () => {
  const changes: Array<{
    position: { id: string };
    change: {
      id: number;
      at: number;
      actor: string;
      entries: Array<{ table: string; kind: 'insert'; tenant: string; keys: Array<{ id: number }> }>;
    };
  }> = [];
  const store: LiveStore = {
    dialect: 'sqlite',
    ready: async () => true,
    head: async () => ({ id: String(changes.length) }),
    read: async (after, limit) => changes.filter((row) => Number(row.position.id) > Number(after.id)).slice(0, limit) as never,
    locate: async () => undefined,
    prune: async () => 0,
  };
  const hub = new LiveHub({ dialect: 'sqlite' } as Adapter, store, { pollMs: 60_000 });
  const calls = { a: 0, b: 0 };
  const received = { a: 0, b: 0 };
  const makeTap = (tenant: 'a' | 'b'): LiveTap => ({
    tenant,
    async authority() {
      calls[tenant] += 1;
      return {
        app: 'demo',
        actor: 'u1',
        tenant,
        tables: new Map([['item', { id: 'item', key: ['id'], columns: 'all', scope: true, fingerprint: 'fp' }]]),
      } as never;
    },
    receive(delivery) {
      if (delivery.tables.size) received[tenant] += 1;
    },
    placed() {},
    reset() {},
    fail() {},
  });
  const tapA = makeTap('a');
  const tapB = makeTap('b');
  try {
    await Promise.all([hub.attach(tapA), hub.attach(tapB)]);
    changes.push({
      position: { id: '1' },
      change: { id: 1, at: Date.now(), actor: 'other', entries: [{ table: 'item', kind: 'insert', tenant: 'a', keys: [{ id: 1 }] }] },
    });
    hub.wake(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.a, 1, 'tenant a subscriber checked authority');
    assert.equal(received.a, 1, 'tenant a subscriber received change');
    assert.equal(calls.b, 0, 'tenant b subscriber skipped authority() completely');
    assert.equal(received.b, 0, 'tenant b subscriber received nothing');
  } finally {
    hub.detach(tapA);
    hub.detach(tapB);
    await hub.close();
  }
});
