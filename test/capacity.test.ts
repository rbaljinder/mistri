/**
 * The capacity section of the operator surface: collected from the registry
 * by position, never by name; sanitized in the support bundle as the HTTP
 * metrics are; its readiness check degraded while a pool is saturated; and
 * carried through the protected HTTP read and the diagnostics summary.
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { POOL_DURATION_BOUNDS_MS, type PoolRoleStats } from '../packages/engine/src/adapters/poolMetrics.js';
import { Registry, type ConnectionPoolStats } from '../packages/engine/src/server/connections.js';
import { shapeOnly } from '../packages/engine/src/server/shapeonly.js';
import { capacityCheck, collectCapacity } from '../packages/mistri/src/server/operations/capacity.js';
import {
  buildReadiness,
  buildSupportBundle,
  supportBundleJson,
  type CapacityPool,
} from '../packages/mistri/src/server/operations/operations.js';
import { RequestDiagnostics } from '../packages/engine/src/server/operations/diagnostics.js';
import { readOperationsHttp } from '../packages/mistri/src/server/operations/operationsHttp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const NOW = '2026-09-13T08:00:00.000Z';
const bucket = (at: number) => Array.from({ length: POOL_DURATION_BOUNDS_MS.length + 1 }, (_, i) => (i === at ? 1 : 0));

function stats(overrides: Partial<PoolRoleStats> = {}): PoolRoleStats {
  return {
    role: 'read',
    pooler: 'session',
    size: 4,
    open: 2,
    inUse: 1,
    waiting: 0,
    saturated: false,
    checkouts: 10,
    queued: 0,
    timedOut: 0,
    failed: 0,
    waitBuckets: bucket(0),
    holdBuckets: bucket(3),
    ...overrides,
  };
}

const report = (overrides: Partial<PoolRoleStats> = {}, position = 1): ConnectionPoolStats => ({
  ...stats(overrides),
  position,
  dialect: 'postgres',
});

function adapterWith(poolStats?: () => readonly PoolRoleStats[]): Adapter {
  return {
    dialect: 'postgres',
    introspect: async () => ({ dialect: 'postgres', tables: [] }),
    count: async () => 0,
    close: async () => {},
    ...(poolStats ? { poolStats } : {}),
  } as unknown as Adapter;
}

/* The registry opens adapters by dialling; these stand in for opened ones. */
function registryWith(adapters: Array<Adapter | undefined>): Registry {
  const registry = new Registry();
  const entries = (registry as unknown as { entries: Map<string, { adapter?: Adapter }> }).entries;
  adapters.forEach((adapter, i) => {
    const added = registry.add({
      name: `private-name-${i}`,
      url: `postgres://private-user:private-password@private-host/db${i}`,
      source: 'config',
    });
    entries.get(added.id)!.adapter = adapter;
  });
  return registry;
}

test('the registry reports open pools by position, never by name or URL', () => {
  const registry = registryWith([
    adapterWith(() => [stats(), stats({ role: 'write', size: 1 })]),
    undefined,
    adapterWith(),
    adapterWith(() => {
      throw new Error('private failure');
    }),
    adapterWith(() => [stats({ saturated: true, waiting: 3 })]),
  ]);
  const pools = registry.poolStats();
  assert.deepEqual(
    pools.map((pool) => [pool.position, pool.role, pool.dialect]),
    [
      [1, 'read', 'postgres'],
      [1, 'write', 'postgres'],
      [5, 'read', 'postgres'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(collectCapacity(registry)), /private/);
});

test('capacity carries the event loop and the pool bounds, and its check degrades only while a pool is saturated', () => {
  const calm = collectCapacity({ poolStats: () => [report()] });
  assert.ok(Number.isSafeInteger(calm.eventLoop.activeMs) && calm.eventLoop.activeMs >= 0);
  assert.ok(Number.isSafeInteger(calm.eventLoop.idleMs) && calm.eventLoop.idleMs >= 0);
  assert.deepEqual(calm.durationBoundsMs, POOL_DURATION_BOUNDS_MS);
  assert.deepEqual(capacityCheck(calm), { name: 'pools', state: 'ready', code: 'ok' });
  const busy = collectCapacity({ poolStats: () => [report(), report({ saturated: true }, 2)] });
  assert.deepEqual(capacityCheck(busy), { name: 'pools', state: 'degraded', code: 'pool_saturated' });
  assert.equal(capacityCheck(collectCapacity({ poolStats: () => [] })), undefined);
  const readiness = buildReadiness('app', [capacityCheck(busy)!], NOW);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.checks[0], { name: 'pools', state: 'degraded', code: 'pool_saturated' });
});

test('the support bundle keeps only the fixed capacity fields, bounded', () => {
  const forged = {
    ...report(),
    dialect: 'private-dialect',
    role: 'private-role',
    pooler: 'private-pooler',
    open: 'private',
    size: -3,
    waitBuckets: [1, 2],
    holdBuckets: Array(40).fill(1),
    url: 'postgres://private',
  } as unknown as CapacityPool;
  const bundle = buildSupportBundle({
    scope: 'app',
    checks: [],
    generatedAt: NOW,
    capacity: {
      eventLoop: { activeMs: 12.5, idleMs: 900 },
      durationBoundsMs: [7],
      pools: [forged, ...Array.from({ length: 80 }, (_, i) => report({}, i + 2))],
    },
  });
  const capacity = bundle.capacity!;
  assert.equal(capacity.pools.length, 64);
  assert.deepEqual(capacity.durationBoundsMs, POOL_DURATION_BOUNDS_MS);
  assert.deepEqual(capacity.eventLoop, { activeMs: 0, idleMs: 900 });
  const first = capacity.pools[0];
  assert.deepEqual([first.dialect, first.role, first.pooler, first.open, first.size], ['unknown', 'unknown', 'unknown', null, 0]);
  assert.deepEqual(first.waitBuckets, [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(first.holdBuckets.length, POOL_DURATION_BOUNDS_MS.length + 1);
  assert.equal(Object.isFrozen(first), true);
  const json = supportBundleJson(bundle);
  assert.doesNotMatch(json, /private/);
  assert.doesNotMatch(json, /"name"|"url"/);
  // Re-sanitized on serialization, so a structural forgery cannot smuggle a field through.
  const smuggled = supportBundleJson({ ...bundle, capacity: { ...capacity, pools: [{ ...first, leaked: 'private' }] } } as never);
  assert.doesNotMatch(smuggled, /private|leaked/);
  assert.equal('capacity' in buildSupportBundle({ scope: 'app', checks: [], generatedAt: NOW }), false);
});

test('the protected support read carries capacity, and readiness its pools check', async () => {
  const app = parseAppConfig(
    {
      id: 'ops',
      name: 'Operations',
      sources: { lending: { connection: 'private-db' } },
      resources: { loan: {} },
      auth: { roles: { operator: { read: true, operations: ['readiness', 'bundle'] } } },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
    },
    'capacity fixture',
  );
  const capacity = collectCapacity({ poolStats: () => [report({ saturated: true, waiting: 2 })] });
  const collect = () => ({ checks: [capacityCheck(capacity)!], capacity });
  const actor = { id: 'account-ops', roles: ['operator'] };
  const support = await readOperationsHttp({ app, action: 'support', actor, collect });
  if (!support.ok || support.action !== 'support') assert.fail('the support read should succeed');
  assert.deepEqual([support.value.capacity?.pools[0].waiting, support.value.capacity?.pools[0].saturated], [2, true]);
  const readiness = await readOperationsHttp({ app, action: 'readiness', actor, collect });
  if (!readiness.ok || readiness.action !== 'readiness') assert.fail('the readiness read should succeed');
  assert.equal(readiness.value.ready, false);
  assert.equal('capacity' in readiness.value, false);
});

test('each diagnostics summary carries the capacity it is given, and one that cannot be read is left out', () => {
  const diagnostics = new RequestDiagnostics(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  assert.equal('capacity' in diagnostics.snapshot(), false);
  diagnostics.watchCapacity(() => collectCapacity({ poolStats: () => [report({}, 3)] }));
  assert.equal(diagnostics.snapshot().capacity?.pools[0].position, 3);
  diagnostics.watchCapacity(() => {
    throw new Error('private');
  });
  assert.equal('capacity' in diagnostics.snapshot(), false);
});

test('a shape-only connection still reports its pools, which carry no row value', () => {
  assert.deepEqual(
    shapeOnly(
      adapterWith(() => [stats()]),
      'prod',
    ).poolStats?.(),
    [stats()],
  );
  assert.equal(shapeOnly(adapterWith(), 'plain').poolStats, undefined);
});
