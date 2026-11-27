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
import { KeyRows } from '../packages/engine/src/adapters/scoped/keyRows.js';
import { createFlowTail, type FlowChange } from '../packages/mistri/src/server/workflows/flowTail.js';
import { tenantHttpBinding } from '../packages/mistri/src/server/tenant/tenantWire.js';

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

test('KeyRows answers in-memory guards for isNull, isNotNull, in, !=, and numeric range operators while falling back on non-matches', async () => {
  const schema = {
    label: 'test',
    dialect: 'postgres' as const,
    readAt: '2026-01-01T00:00:00Z',
    tables: [
      {
        id: 'public.item',
        name: 'item',
        schema: 'public',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'status', type: 'text', primaryKey: false, nullable: false },
          { name: 'balance', type: 'integer', primaryKey: false, nullable: false },
          { name: 'active', type: 'boolean', primaryKey: false, nullable: false },
          { name: 'closed_at', type: 'text', primaryKey: false, nullable: true },
        ],
      },
    ],
    foreignKeys: [],
  };
  const scope = { 'public.item': true as const };
  const keyRows = new KeyRows(() => 1);
  keyRows.keep(
    scope,
    schema.tables[0]!,
    { groups: [[{ column: 'id', op: '=', value: 7 }]] },
    Promise.resolve([{ id: 7, status: 'open', balance: 500, active: true, closed_at: null }]),
  );
  let dbCalls = 0;
  const wrapped = keyRows.over(
    {
      query: async (_request: Parameters<Adapter['query']>[0]) => {
        dbCalls += 1;
        return { columns: ['id'], rows: [], ms: 0, sql: { text: 'SELECT', params: [] } };
      },
    },
    scope,
    schema,
    () => ({ text: 'SELECT', params: [] }),
    (row) => row,
    false,
  );
  // All matching guards hit in-memory (0 DB calls):
  for (const cond of [
    { column: 'status', op: 'in' as const, value: ['draft', 'open'] },
    { column: 'balance', op: '>=' as const, value: 500 },
    { column: 'balance', op: '>' as const, value: 100 },
    { column: 'balance', op: '<=' as const, value: 500 },
    { column: 'balance', op: '<' as const, value: 900 },
    { column: 'balance', op: '!=' as const, value: 0 },
    { column: 'active', op: '!=' as const, value: false },
    { column: 'closed_at', op: 'isNull' as const },
    { column: 'status', op: 'isNotNull' as const },
  ]) {
    const res = await wrapped.query({
      table: 'public.item',
      columns: ['id', 'status'],
      limit: 1,
      offset: 0,
      filter: { groups: [[{ column: 'id', op: '=', value: 7 }, cond]] },
    });
    assert.equal(res.rows.length, 1, `in-memory hit for ${cond.op}`);
  }
  assert.equal(dbCalls, 0, 'all proven guard reads skipped the database');
  // Non-matching or ambiguous guards fall back to the database:
  await wrapped.query({
    table: 'public.item',
    columns: ['id'],
    limit: 1,
    offset: 0,
    filter: {
      groups: [
        [
          { column: 'id', op: '=', value: 7 },
          { column: 'balance', op: '>' as const, value: 999 },
        ],
      ],
    },
  });
  await wrapped.query({
    table: 'public.item',
    columns: ['id'],
    limit: 1,
    offset: 0,
    filter: {
      groups: [
        [
          { column: 'id', op: '=', value: 7 },
          { column: 'closed_at', op: 'isNotNull' as const },
        ],
      ],
    },
  });
  assert.equal(dbCalls, 2, 'unproven guards fall back to database evaluation');
});

test('tenantHttpBinding returns identical frozen Bound on unchanged config and still rejects mutation', () => {
  const mutable = { host: '127.0.0.1', port: 3000, allowedHosts: ['app.example.com'] };
  const read = tenantHttpBinding(mutable);
  const first = read();
  const second = read();
  assert.equal(first, second, 'fast path reuses frozen Bound instance when unchanged');
  mutable.allowedHosts.push('evil.example.com');
  assert.throws(() => read(), 'mutated allowedHosts is still refused');

  const frozen = Object.freeze({ host: '127.0.0.1', port: 3000, allowedHosts: Object.freeze(['app.example.com']) });
  const readFrozen = tenantHttpBinding(frozen);
  assert.equal(readFrozen(), readFrozen());
});
