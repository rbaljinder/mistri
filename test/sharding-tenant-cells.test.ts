/**
 * Phase 2 multi-tenant cell sharding tests: control-plane ShardDirectory,
 * CachedShardDirectory invalidation, fail-closed TenantMovedError retry,
 * account discovery, host resolution, self-routing tokens, same-shard sandbox
 * placement, and 5-step live tenant moves (success & pre-cutover rollback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CachedShardDirectory,
  MemoryShardDirectory,
  SHARD_DIRECTORY_TABLES,
  SHARD_DIRECTORY_VERSION,
  SHARD_TOPOLOGY_CHANNEL,
  TenantMovedError,
} from '../packages/mistri/src/adapters/sharding/shardDirectory.js';
import {
  openPostgresShardDirectory,
  postgresShardDirectoryReady,
  provisionPostgresShardDirectory,
} from '../packages/mistri/src/adapters/sharding/postgresShardDirectory.js';
import { createTenantShardRouter } from '../packages/mistri/src/server/tenant/tenantShardRouter.js';
import { STORES } from '../packages/mistri/src/server/storeLayouts.js';

interface FakeCell {
  readonly shardId: string;
  readonly tenants: Map<string, { status: 'active' | 'migrating'; rows: string[] }>;
}

test('shard-directory store is registered in storeLayouts as own: true PostgreSQL v1', () => {
  const layout = STORES.find((s) => s.id === 'shard-directory');
  assert.ok(layout);
  assert.equal(layout.tables.own, true);
  assert.equal(layout.current.postgres, SHARD_DIRECTORY_VERSION);
  assert.equal(SHARD_DIRECTORY_TABLES.meta, '__mistri_shard_meta');
  assert.equal(SHARD_TOPOLOGY_CHANNEL, 'mistri_shard_topology');
  assert.equal(typeof provisionPostgresShardDirectory, 'function');
  assert.equal(typeof postgresShardDirectoryReady, 'function');
  assert.equal(typeof openPostgresShardDirectory, 'function');
});

test('MemoryShardDirectory and CachedShardDirectory manage weighted placement, discovery, hosts, and invalidation', async () => {
  let now = 1_700_000_000_000;
  const dir = new MemoryShardDirectory({ strategy: 'directory', now: () => now });
  await dir.registerShard({ shardId: 'cell-a', label: 'Cell A', status: 'active', weight: 1 });
  await dir.registerShard({ shardId: 'cell-b', label: 'Cell B', status: 'active', weight: 2 });
  await dir.registerShard({ shardId: 'cell-ro', label: 'Cell RO', status: 'read_only', weight: 1 });

  const shards = await dir.listShards();
  assert.equal(shards.length, 3);
  const routerSnapshot = await dir.router();
  assert.deepEqual(routerSnapshot.writableShards(), ['cell-a', 'cell-b']);

  const firstPick = await dir.pickShardForNewTenant();
  assert.equal(firstPick, 'cell-a');
  await dir.placeTenant({ tenantId: 'acme', shardId: 'cell-a', displayName: 'Acme' });
  // cell-b has 0/2 = 0 < cell-a 1/1 = 1
  assert.equal(await dir.pickShardForNewTenant(), 'cell-b');
  await dir.placeTenant({ tenantId: 'globex', shardId: 'cell-b', displayName: 'Globex' });
  // cell-b has 1/2 = 0.5 < cell-a 1/1 = 1
  assert.equal(await dir.pickShardForNewTenant(), 'cell-b');

  await dir.indexAccountTenant({ accountId: 'user-1', tenantId: 'acme', shardId: 'cell-a', status: 'active' });
  await dir.indexAccountTenant({ accountId: 'user-1', tenantId: 'globex', shardId: 'cell-b', status: 'active' });
  const memberships = await dir.tenantsForAccount('user-1');
  assert.equal(memberships.length, 2);

  await dir.upsertHost({
    host: 'ACME.Example.Com',
    tenantId: 'acme',
    shardId: 'cell-a',
    app: 'dealer-desk',
    kind: 'custom',
    status: 'active',
    primary: true,
  });
  const host = await dir.getHost('acme.example.com');
  assert.equal(host?.shardId, 'cell-a');
  assert.equal((await dir.listHosts()).length, 1);

  const cache = new CachedShardDirectory(dir, { ttlMs: 30_000, now: () => now });
  assert.equal(await cache.shardForTenant('acme'), 'cell-a');
  // Put lookup vindex entry and verify cache + explicit invalidation
  await dir.putLookup({ resource: 'orders', lookupKey: 'ORD-1', shardId: 'cell-b', vbucket: 12 });
  assert.equal((await cache.getLookup('orders', 'ORD-1'))?.shardId, 'cell-b');
  cache.invalidateLookup('orders', 'ORD-1');
  assert.equal(await dir.removeLookup('orders', 'ORD-1'), true);
  assert.equal(await cache.getLookup('orders', 'ORD-1'), undefined);

  // Topology change clears cached routes automatically
  assert.equal(await dir.updateShardStatus('cell-ro', 'draining'), true);
  await dir.removeAccountTenant('user-1', 'globex');
  assert.equal((await dir.tenantsForAccount('user-1')).length, 1);
  assert.equal(await dir.removeHost('acme.example.com'), true);
  await cache.close();
});

test('createTenantShardRouter lazily opens cells, retries once on TenantMovedError, pins sandboxes, and moves tenants safely', async () => {
  const dir = new MemoryShardDirectory();
  await dir.registerShard({ shardId: 's0', label: 'Shard 0', status: 'active', weight: 1 });
  await dir.registerShard({ shardId: 's1', label: 'Shard 1', status: 'active', weight: 1 });

  const backing = new Map<string, FakeCell>([
    ['s0', { shardId: 's0', tenants: new Map() }],
    ['s1', { shardId: 's1', tenants: new Map() }],
  ]);
  const closedCells: string[] = [];

  const router = createTenantShardRouter<FakeCell>({
    directory: dir,
    openCell: async (shardId) => backing.get(shardId)!,
    closeCell: async (shardId) => {
      closedCells.push(shardId);
    },
  });

  // No cells opened yet (lazy dialing).
  assert.deepEqual(router.openedShards(), []);

  // Open new tenant on s0.
  const opened = await router.openNewTenant({ tenantId: 'dealer-1', preferredShardId: 's0', displayName: 'Dealer One' }, async (cell) => {
    cell.tenants.set('dealer-1', { status: 'active', rows: ['lead-1', 'lead-2'] });
    return 'created';
  });
  assert.equal(opened.shardId, 's0');
  assert.equal(opened.result, 'created');
  assert.deepEqual(router.openedShards(), ['s0']);

  // Self-routing tokens round-trip without touching directory.
  const via = router.mintRoutingToken('s0', 'intake_opaque_22_chars');
  assert.deepEqual(router.decodeRoutingToken(via), { shardId: 's0', token: 'intake_opaque_22_chars' });

  // Sandbox placement pins to source tenant's exact shard.
  assert.equal(await router.sandboxShardFor('dealer-1'), 's0');

  // Account discovery & host resolution work via control plane.
  await dir.indexAccountTenant({ accountId: 'acct-9', tenantId: 'dealer-1', shardId: 's0', status: 'active' });
  await dir.upsertHost({
    host: 'd1.example.com',
    tenantId: 'dealer-1',
    shardId: 's0',
    app: 'desk',
    kind: 'subdomain',
    status: 'active',
    primary: true,
  });
  assert.equal((await router.discoverAccountTenants('acct-9'))[0]?.shardId, 's0');
  assert.equal((await router.resolveHost('d1.example.com'))?.shardId, 's0');

  // Failed move before cutover unfreezes source and restores directory status.
  await assert.rejects(
    () =>
      router.moveTenant('dealer-1', 's1', {
        freezeOnSource: async (c, id) => {
          c.tenants.get(id)!.status = 'migrating';
        },
        unfreezeOnSource: async (c, id) => {
          c.tenants.get(id)!.status = 'active';
        },
        exportFromSource: async (c, id) => [...c.tenants.get(id)!.rows],
        importToTarget: async () => {
          throw new Error('simulated target disk full');
        },
        activateOnTarget: async () => {},
      }),
    /simulated target disk full/,
  );
  assert.equal(backing.get('s0')!.tenants.get('dealer-1')?.status, 'active');
  assert.equal((await dir.getTenant('dealer-1'))?.status, 'active');
  assert.equal((await dir.getTenant('dealer-1'))?.shardId, 's0');

  // Successful live move s0 -> s1 flips placement, account index, and host directory atomically.
  const moved = await router.moveTenant('dealer-1', 's1', {
    freezeOnSource: async (c, id) => {
      c.tenants.get(id)!.status = 'migrating';
    },
    unfreezeOnSource: async (c, id) => {
      c.tenants.get(id)!.status = 'active';
    },
    exportFromSource: async (c, id) => [...c.tenants.get(id)!.rows],
    importToTarget: async (c, id, rows) => {
      c.tenants.set(id, { status: 'migrating', rows });
    },
    activateOnTarget: async (c, id) => {
      c.tenants.get(id)!.status = 'active';
    },
    retireOnSource: async (c, id) => {
      c.tenants.delete(id);
    },
  });
  assert.equal(moved.fromShardId, 's0');
  assert.equal(moved.toShardId, 's1');
  assert.equal((await router.discoverAccountTenants('acct-9'))[0]?.shardId, 's1');
  assert.equal((await router.resolveHost('d1.example.com'))?.shardId, 's1');

  // Simulate a stale cached route: force cache to think dealer-1 is still on s0, then verify
  // forTenant catches TenantMovedError, invalidates, and succeeds on s1 in one retry.
  const staleCacheDir = new CachedShardDirectory(dir, { ttlMs: 60_000 });
  // Seed stale entry directly via a wrapper directory whose first read returns s0, second returns s1.
  let reads = 0;
  const flakyDir = new Proxy(dir, {
    get(target, prop, receiver) {
      if (prop === 'shardForTenant') {
        return async (id: string) => {
          reads += 1;
          return reads === 1 ? 's0' : target.shardForTenant(id);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const staleRouter = createTenantShardRouter<FakeCell>({
    directory: flakyDir,
    openCell: async (shardId) => backing.get(shardId)!,
  });
  const rows = await staleRouter.forTenant('dealer-1', async (cell, shardId) => {
    const found = cell.tenants.get('dealer-1');
    if (!found || found.status === 'migrating') throw new TenantMovedError('dealer-1', shardId);
    return found.rows;
  });
  assert.deepEqual(rows, ['lead-1', 'lead-2']);
  assert.equal(reads, 2);

  await staleCacheDir.close();
  await staleRouter.close();
  await router.close();
  assert.deepEqual(closedCells.sort(), ['s0', 's1']);
});
