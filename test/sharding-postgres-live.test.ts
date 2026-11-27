/**
 * Live PostgreSQL horizontal sharding integration suite (Phases 1–4):
 * - Real PostgreSQL `mistri.shard_*` control-plane directory provisioning,
 *   idempotency, `storeLayouts.ts` attestation, and two-pod `LISTEN/NOTIFY`
 *   (`mistri_shard_topology`) instant cache invalidation.
 * - Real PostgreSQL `TenantShardRouter` lifecycle (`openNewTenant`,
 *   `discoverAccountTenants`, `resolveHost`, `sandboxShardFor`,
 *   `TenantMovedError` retry, and `moveTenant`).
 * - Real 3-shard + control PostgreSQL cluster migrated via `resolveShardTargets`
 *   + `migrateUp` and booted end-to-end through `loadAppRuntimeResources` ->
 *   `openShardedAppSource` -> `ShardedAdapter` (self-routing IDs, PG lookup
 *   directory, reference/unsharded tables, single-shard ACID transactions,
 *   scatter k-way merge, bounded count, and 2-phase partial aggregates).
 *
 * Opt-in behind `TABLEWALK_TEST_PG` (matching `test/live.ts`); creates and
 * drops its own isolated databases on the target Postgres server.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { ShardedAdapter } from '@mistriwork/engine/adapters/shardedAdapter.js';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { migrateUp, migrationStatus } from '../packages/engine/src/server/migrate/runner.js';
import { resolveShardTargets } from '../packages/engine/src/server/migrate/target.js';
import { decodeVbucketInt64, decodeVbucketUlid } from '@mistriwork/engine/shared/sharding.js';
import {
  openPostgresShardDirectory,
  postgresShardDirectoryReady,
  provisionPostgresShardDirectory,
} from '../packages/mistri/src/adapters/sharding/postgresShardDirectory.js';
import { CachedShardDirectory, TenantMovedError } from '../packages/mistri/src/adapters/sharding/shardDirectory.js';
import { loadAppRuntimeResources, databaseOf } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { STORES } from '../packages/mistri/src/server/storeLayouts.js';
import { createTenantShardRouter } from '../packages/mistri/src/server/tenant/tenantShardRouter.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface PgClient extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

function dbUrl(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.href;
}

async function createTempDatabases(
  control: PgClient,
  prefix: string,
  names: readonly string[],
): Promise<{ readonly dbs: Record<string, { readonly name: string; readonly url: string }>; readonly dropAll: () => Promise<void> }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const created: string[] = [];
  const dbs: Record<string, { readonly name: string; readonly url: string }> = {};
  try {
    for (const key of names) {
      const name = `${prefix}_${key}_${suffix}`;
      await control.query(`CREATE DATABASE "${name}"`);
      created.push(name);
      dbs[key] = { name, url: dbUrl(LIVE!, name) };
    }
  } catch (error) {
    for (const name of created) {
      await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    throw error;
  }
  return {
    dbs,
    dropAll: async () => {
      for (const name of created) {
        await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      }
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test(
  'Live PG: shard-directory store provisioning, LISTEN/NOTIFY cache invalidation, and TenantShardRouter',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async () => {
    const pgMod = 'pg';
    const pg = (await import(pgMod)) as { default: { Client: new (options: unknown) => PgClient } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 15_000 });
    await control.connect();
    const { dbs, dropAll } = await createTempDatabases(control, 'tw_shdir', ['dir']);
    try {
      const dirUrl = dbs.dir!.url;
      const client = new pg.default.Client({ connectionString: dirUrl, statement_timeout: 15_000 });
      await client.connect();
      try {
        // Before provisioning, attestation returns false.
        assert.equal(await postgresShardDirectoryReady(client), false);
        const storeDef = STORES.find((s) => s.id === 'shard-directory');
        assert.ok(storeDef?.attest?.postgres);
        assert.equal(await storeDef.attest.postgres(client), false);

        // Provision twice: first creates, second is idempotent.
        const first = await provisionPostgresShardDirectory(dirUrl, {
          appId: 'live-app',
          sourceId: 'main',
          storeId: 'shard-dir-live',
          strategy: 'directory',
          buckets: 4096,
        });
        assert.equal(first.provisioned, true);
        assert.equal(first.version, 1);
        const second = await provisionPostgresShardDirectory(dirUrl, {
          appId: 'live-app',
          sourceId: 'main',
          storeId: 'shard-dir-live',
        });
        assert.equal(second.provisioned, false);

        // After provisioning, both direct ready check and storeLayouts attestation pass.
        assert.equal(await postgresShardDirectoryReady(client), true);
        assert.equal(await storeDef.attest.postgres(client), true);
      } finally {
        await client.end();
      }

      // Open two independent directory handles (Pod A writer, Pod B cached reader with LISTEN).
      const podA = await openPostgresShardDirectory(dirUrl);
      const podB = await openPostgresShardDirectory(dirUrl);
      let notifyCount = 0;
      const unsub = podB.onTopologyChange(() => {
        notifyCount++;
      });
      const cachedB = new CachedShardDirectory(podB, { ttlMs: 60_000 });
      try {
        await podA.registerShard({ shardId: 's0', label: 'US East 0', status: 'active', weight: 1 });
        await podA.registerShard({ shardId: 's1', label: 'US East 1', status: 'active', weight: 1 });
        await podA.placeTenant({ tenantId: 't_acme', shardId: 's0', status: 'active', displayName: 'Acme' });
        await podA.indexAccountTenant({ accountId: 'acct_1', tenantId: 't_acme', shardId: 's0', status: 'active' });
        await podA.upsertHost({
          host: 'acme.example.com',
          tenantId: 't_acme',
          shardId: 's0',
          app: 'live-app',
          kind: 'custom',
          status: 'active',
          primary: true,
        });

        // Prime Pod B cache with `t_acme -> s0`.
        assert.equal(await cachedB.shardForTenant('t_acme'), 's0');

        // Move `t_acme` on Pod A -> `NOTIFY mistri_shard_topology` invalidates Pod B's cache immediately.
        const beforeNotify = notifyCount;
        await podA.moveTenantPlacement('t_acme', 's1', 'active');
        const notified = await waitUntil(() => notifyCount > beforeNotify);
        assert.equal(notified, true, 'Pod B should receive LISTEN mistri_shard_topology notification');
        assert.equal(await cachedB.shardForTenant('t_acme'), 's1');

        // Exercise TenantShardRouter end-to-end against real PG directory.
        const cellData = new Map<string, Map<string, { rows: string[] }>>([
          ['s0', new Map()],
          ['s1', new Map([['t_acme', { rows: ['r1', 'r2'] }]])],
        ]);
        const router = createTenantShardRouter({
          directory: cachedB,
          openCell: async (shardId) => ({ shardId, store: cellData.get(shardId)! }),
        });
        try {
          const opened = await router.openNewTenant({ tenantId: 't_beta', displayName: 'Beta' }, async (cell) => {
            cell.store.set('t_beta', { rows: ['seed'] });
            return cell.shardId;
          });
          assert.ok(opened.shardId === 's0' || opened.shardId === 's1');
          assert.equal(await router.sandboxShardFor('t_beta'), opened.shardId);
          assert.equal((await router.discoverAccountTenants('acct_1')).length, 1);
          assert.equal((await router.resolveHost('acme.example.com'))?.shardId, 's1');

          // Move t_acme back from s1 to s0 with live hooks.
          const moved = await router.moveTenant('t_acme', 's0', {
            freezeOnSource: async () => {},
            unfreezeOnSource: async () => {},
            exportFromSource: async (cell, tid) => cell.store.get(tid)!,
            importToTarget: async (cell, tid, snap) => void cell.store.set(tid, { rows: [...snap.rows] }),
            activateOnTarget: async () => {},
            retireOnSource: async (cell, tid) => void cell.store.delete(tid),
          });
          assert.equal(moved.fromShardId, 's1');
          assert.equal(moved.toShardId, 's0');

          // Deterministic stale-cache test: open a separate listen:false cached router holding `t_acme -> s0`,
          // move `t_acme -> s1` on Pod A, hit stale `s0` -> TenantMovedError -> refreshes and retries on `s1`!
          const staleDir = await openPostgresShardDirectory(dirUrl, { listen: false });
          const staleRouter = createTenantShardRouter({
            directory: new CachedShardDirectory(staleDir, { ttlMs: 60_000 }),
            openCell: async (shardId) => ({ shardId }),
          });
          try {
            assert.equal(await staleRouter.resolveShard('t_acme'), 's0');
            await podA.moveTenantPlacement('t_acme', 's1', 'active');
            const visited: string[] = [];
            const landed = await staleRouter.forTenant('t_acme', async (cell, shardId) => {
              visited.push(shardId);
              if (shardId === 's0') throw new TenantMovedError('t_acme', 's0', 's1');
              return cell.shardId;
            });
            assert.deepEqual(visited, ['s0', 's1']);
            assert.equal(landed, 's1');
          } finally {
            await staleRouter.close();
            await staleDir.close();
          }
        } finally {
          await router.close();
        }
      } finally {
        unsub();
        await cachedB.close();
        await podA.close();
      }
    } finally {
      await dropAll();
      await control.end();
    }
  },
);

test(
  'Live PG: 3-shard + control cluster migrated via resolveShardTargets and served via loadAppRuntimeResources',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async () => {
    const pgMod = 'pg';
    const pg = (await import(pgMod)) as { default: { Client: new (options: unknown) => PgClient } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 15_000 });
    await control.connect();
    const { dbs, dropAll } = await createTempDatabases(control, 'tw_shapp', ['ctrl', 'dir', 's0', 's1', 's2']);
    const migDir = mkdtempSync(join(tmpdir(), 'mistri-sharded-mig-'));
    try {
      // 1. Provision control-plane lookup directory and register the 3 shards.
      await provisionPostgresShardDirectory(dbs.dir!.url, {
        appId: 'commerce-live',
        sourceId: 'main',
        storeId: 'commerce-dir',
        strategy: 'hash',
        buckets: 4096,
      });
      const dirStore = await openPostgresShardDirectory(dbs.dir!.url, { listen: false });
      try {
        await dirStore.registerShard({ shardId: 's0', label: 'Shard 0', status: 'active', weight: 1 });
        await dirStore.registerShard({ shardId: 's1', label: 'Shard 1', status: 'active', weight: 1 });
        await dirStore.registerShard({ shardId: 's2', label: 'Shard 2', status: 'active', weight: 1 });
      } finally {
        await dirStore.close();
      }

      // 2. Write a versioned SQL migration and apply it to all 3 shards via resolveShardTargets + migrateUp.
      writeFileSync(
        join(migDir, 'V1__commerce_schema.sql'),
        `
        CREATE TABLE orders (
          id text PRIMARY KEY,
          customer_id bigint NOT NULL,
          amount integer NOT NULL,
          region text NOT NULL
        );
        CREATE TABLE tickets (
          id text PRIMARY KEY,
          account_id text NOT NULL,
          subject text NOT NULL
        );
        CREATE TABLE legacy_invoices (
          id text PRIMARY KEY,
          customer_id bigint NOT NULL,
          total integer NOT NULL
        );
        CREATE TABLE countries (
          code text PRIMARY KEY,
          name text NOT NULL
        );
        INSERT INTO countries (code, name) VALUES ('US', 'United States'), ('DE', 'Germany');
        `,
        'utf8',
      );

      // Seed unsharded control-DB table on ctrl database.
      const ctrlClient = new pg.default.Client({ connectionString: dbs.ctrl!.url, statement_timeout: 15_000 });
      await ctrlClient.connect();
      try {
        await ctrlClient.query(`
          CREATE TABLE orders (id text PRIMARY KEY, customer_id bigint NOT NULL, amount integer NOT NULL, region text NOT NULL);
          CREATE TABLE tickets (id text PRIMARY KEY, account_id text NOT NULL, subject text NOT NULL);
          CREATE TABLE legacy_invoices (id text PRIMARY KEY, customer_id bigint NOT NULL, total integer NOT NULL);
          CREATE TABLE countries (code text PRIMARY KEY, name text NOT NULL);
          CREATE TABLE audit_batches (id integer PRIMARY KEY, note text NOT NULL);
        `);
      } finally {
        await ctrlClient.end();
      }

      // 3. Configure Registry with sharded PostgreSQL connection + directory URL.
      const registry = new Registry();
      const conn = registry.add({
        name: 'commerce-cluster',
        url: dbs.ctrl!.url,
        source: 'config',
        writable: true,
        migrations: { dir: migDir },
        shards: {
          strategy: 'hash',
          buckets: 4096,
          directory: dbs.dir!.url,
          nodes: [
            { id: 's0', url: dbs.s0!.url, pool: { read: 4, write: 2 } },
            { id: 's1', url: dbs.s1!.url, pool: { read: 4, write: 2 } },
            { id: 's2', url: dbs.s2!.url, pool: { read: 4, write: 2 } },
          ],
        },
      });

      try {
        // Fan-out migration across all 3 real PostgreSQL shards!
        const startupConfig = {
          connections: registry.configs(),
          services: [],
          views: [],
          queries: [],
          pages: [],
          layouts: [],
          savedPages: [],
          savedFilters: [],
        } as unknown as Parameters<typeof resolveShardTargets>[1];
        const resolved = await resolveShardTargets(registry, startupConfig, { schemas: [] });
        assert.equal(resolved.targets.length, 3);
        assert.equal(resolved.directoryUrl, dbs.dir!.url);
        for (const shardTarget of resolved.targets) {
          const up = await migrateUp(shardTarget);
          assert.equal(up.failure, undefined);
          assert.equal(up.applied.length, 1);
          const status = await migrationStatus(shardTarget);
          assert.equal(status.started, true);
          assert.equal(status.plan.pending.length, 0);
        }

        // 4. Define the App with `sources.main.sharding` and `resources.*.placement` and boot via loadAppRuntimeResources!
        const app = parseAppConfig(
          {
            name: 'Commerce Live',
            sources: {
              main: {
                connection: 'commerce-cluster',
                default: true,
                sharding: {
                  buckets: 4096,
                  groups: {
                    customer: { keyType: 'bigint', strategy: 'hash' },
                    account: { keyType: 'text', strategy: 'hash' },
                  },
                },
              },
            },
            resources: {
              orders: {
                access: 'write',
                placement: { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'vbucket-int64', scatter: 'bounded' },
              },
              tickets: {
                access: 'write',
                placement: { kind: 'sharded', group: 'account', key: 'account_id', id: 'vbucket-ulid', scatter: 'refuse' },
              },
              legacy_invoices: {
                access: 'write',
                placement: { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'directory', scatter: 'bounded' },
              },
              countries: {
                placement: { kind: 'reference', writable: false },
              },
              audit_batches: {
                access: 'write',
                placement: { kind: 'unsharded' },
              },
            },
            views: {
              orders: { kind: 'list', from: 'orders', label: 'Orders' },
            },
            nav: ['orders'],
          },
          'commerce-live.app.ts',
        );

        const runtime = await loadAppRuntimeResources(registry, app, conn.id);
        const sharded = databaseOf(runtime, conn.id) as ShardedAdapter;
        assert.ok(sharded && typeof sharded.transactionFor === 'function', 'loadAppRuntimeResources must wire ShardedAdapter');

        // 5. Insert 9 orders across customers -> spreads across all 3 real PG shards with vbucket-int64 IDs.
        const customers = [101, 202, 303, 404, 505, 606, 707, 808, 909];
        const insertedOrders: Array<{ id: string; customer_id: number; amount: number; shardId: string }> = [];
        for (let i = 0; i < customers.length; i++) {
          const customer_id = customers[i]!;
          const amount = (i + 1) * 100;
          const region = i % 2 === 0 ? 'us' : 'eu';
          const res = await runtime.adapter.insert!({
            table: 'orders',
            values: { customer_id, amount, region },
          });
          const id = String(res.key.id);
          const bucket = decodeVbucketInt64(id);
          assert.notEqual(bucket, undefined);
          const shardId = sharded.router.shardForBucket(bucket!);
          assert.equal(shardId, sharded.router.shardForKey(customer_id));
          insertedOrders.push({ id, customer_id, amount, shardId });
        }
        assert.equal(new Set(insertedOrders.map((o) => o.shardId)).size, 3);

        // 6. Point read & update by self-routing ID alone (0 extra RTTs, no customer_id needed).
        const firstOrder = insertedOrders[0]!;
        const pointRead = await runtime.adapter.query({
          table: 'orders',
          filter: { groups: [[{ column: 'id', op: '=', value: firstOrder.id }]] },
          limit: 10,
          offset: 0,
        });
        assert.equal(pointRead.rows.length, 1);
        assert.equal(Number(pointRead.rows[0]!.customer_id), firstOrder.customer_id);
        await runtime.adapter.update!({
          table: 'orders',
          key: { id: firstOrder.id },
          values: { amount: 150 },
        });
        firstOrder.amount = 150;

        // 7. vbucket-ulid auto ID + fail-closed scatter refusal on tickets.
        const ticket = await runtime.adapter.insert!({
          table: 'tickets',
          values: { account_id: 'acct-pg-1', subject: 'Billing question' },
        });
        const ticketId = String(ticket.key.id);
        assert.notEqual(decodeVbucketUlid(ticketId), undefined);
        const ticketRead = await runtime.adapter.query({
          table: 'tickets',
          filter: { groups: [[{ column: 'id', op: '=', value: ticketId }]] },
          limit: 10,
          offset: 0,
        });
        assert.equal(ticketRead.rows.length, 1);
        await assert.rejects(
          () => runtime.adapter.query({ table: 'tickets', limit: 10, offset: 0 }),
          (err: unknown) => err instanceof Refusal && /scatter-gather is refused/.test(err.message),
        );

        // 8. Real PG lookup directory (`id: 'directory'`) routes legacy PKs cleanly!
        await runtime.adapter.insert!({
          table: 'legacy_invoices',
          values: { id: 'INV-PG-100', customer_id: 303, total: 950 },
        });
        const inv = await runtime.adapter.query({
          table: 'legacy_invoices',
          filter: { groups: [[{ column: 'id', op: '=', value: 'INV-PG-100' }]] },
          limit: 10,
          offset: 0,
        });
        assert.equal(inv.rows.length, 1);
        assert.equal(Number(inv.rows[0]!.total), 950);

        // 9. Reference table read + write refusal; unsharded table routes to control DB.
        const countries = await runtime.adapter.query({ table: 'countries', limit: 10, offset: 0 });
        assert.equal(countries.rows.length, 2);
        await assert.rejects(
          () => runtime.adapter.insert!({ table: 'countries', values: { code: 'JP', name: 'Japan' } }),
          (err: unknown) => err instanceof Refusal && /read-only at runtime/.test(err.message),
        );
        await runtime.adapter.insert!({ table: 'audit_batches', values: { id: 7, note: 'pg-batch' } });
        assert.equal((await runtime.adapter.query({ table: 'audit_batches', limit: 10, offset: 0 })).rows.length, 1);

        // 10. Single-shard ACID transaction via transactionFor(shardKey) on real PostgreSQL!
        await assert.rejects(
          () =>
            sharded.transactionFor(202, async (tx) => {
              await tx.insert({ table: 'orders', values: { id: 'rollback-test', customer_id: 202, amount: 1, region: 'us' } });
              throw new Error('force rollback');
            }),
          /force rollback/,
        );
        assert.equal(await runtime.adapter.count('orders'), 9);

        // 11. Cross-shard scatter k-way merge + 2-phase partial aggregates (exact weighted avg across PG shards).
        const top3 = await runtime.adapter.query({
          table: 'orders',
          orderBy: [{ column: 'amount', direction: 'desc' }],
          limit: 3,
          offset: 0,
        });
        assert.deepEqual(
          top3.rows.map((r) => Number(r.amount)),
          [900, 800, 700],
        );

        const expectedTotal = insertedOrders.reduce((s, o) => s + o.amount, 0);
        const expectedAvg = expectedTotal / insertedOrders.length;
        const agg = await runtime.adapter.aggregate!({
          table: 'orders',
          measures: [
            { fn: 'count', name: 'cnt' },
            { fn: 'sum', column: 'amount', name: 'total' },
            { fn: 'avg', column: 'amount', name: 'mean' },
          ],
          limit: 10,
        });
        assert.equal(Number(agg.rows[0]!.cnt), 9);
        assert.equal(Number(agg.rows[0]!.total), expectedTotal);
        assert.ok(Math.abs(Number(agg.rows[0]!.mean) - expectedAvg) < 1e-9);

        const bd = await runtime.adapter.runBreakdown!({
          base: 'orders',
          by: [{ path: 'region' }],
          measures: [
            { fn: 'count', alias: 'cnt' },
            { fn: 'sum', path: 'amount', alias: 'total' },
            { fn: 'avg', path: 'amount', alias: 'mean' },
          ],
          orderBy: [{ name: 'region', direction: 'asc' }],
        });
        assert.equal(bd.rows.length, 2);
        assert.equal(
          bd.rows.reduce((s, r) => s + Number(r.total), 0),
          expectedTotal,
        );

        // Cross-shard median must still refuse fail-closed on real PG.
        await assert.rejects(
          () =>
            runtime.adapter.runBreakdown!({
              base: 'orders',
              by: [],
              measures: [{ fn: 'median', path: 'amount', alias: 'med' }],
            }),
          (err: unknown) => err instanceof Refusal && /median/.test(err.message),
        );
      } finally {
        await registry.closeAll();
      }
    } finally {
      rmSync(migDir, { recursive: true, force: true });
      await dropAll();
      await control.end();
    }
  },
);
