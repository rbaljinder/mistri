/**
 * Phase 3 & 4 non-tenant horizontal sharding tests:
 * - End-to-end 3-shard + control-shard `ShardedAdapter` over real SQLite files
 * - Single-shard routing, vbucket-int64 / vbucket-ulid auto ID synthesis,
 *   unsharded URL point reads/updates/deletes without passing shard key
 * - Read-only reference tables, unsharded control tables, opt-in lookup directory
 * - Cross-shard transaction & shard-key mutation refusals, single-shard ACID tx
 * - Scatter-gather policy enforcement, k-way merge ordering, bounded counts,
 *   2-phase partial-aggregate pushdown (count/sum/min/max/weighted avg),
 *   and refusal of cross-shard median / non-shard-key COUNT(DISTINCT)
 * - App DSL parsing, `validateAppSharding`, `withFillsKeys`, and `shardedSearchFilter`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { createShardedAdapter } from '@mistriwork/engine/adapters/shardedAdapter.js';
import { createShardRouter, decodeVbucketInt64, decodeVbucketUlid } from '@mistriwork/engine/shared/sharding.js';
import { coLocatedJoinColumns, isCrossGroupEdge, type TableShardPlacement } from '@mistriwork/engine/shared/shardPlan.js';
import { MemoryShardDirectory } from '../packages/mistri/src/adapters/sharding/shardDirectory.js';
import {
  parseResourcePlacement,
  parseSourceSharding,
  shardedSearchFilter,
  validateAppSharding,
} from '../packages/mistri/src/shared/appSharding.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { withFillsKeys } from '../packages/mistri/src/shared/appKeyFill.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

const SCHEMA_SQL = `
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    region TEXT NOT NULL,
    amount INTEGER NOT NULL
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    subject TEXT NOT NULL
  );
  CREATE TABLE legacy_invoices (
    id TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    total INTEGER NOT NULL
  );
  CREATE TABLE countries (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE audit_batches (
    id INTEGER PRIMARY KEY,
    note TEXT NOT NULL
  );
  INSERT INTO countries VALUES ('US', 'United States'), ('DE', 'Germany');
`;

function createShardDb(file: string): SqliteAdapter {
  const seed = new DatabaseSync(file);
  seed.exec(SCHEMA_SQL);
  seed.close();
  return new SqliteAdapter(file);
}

test('ShardedAdapter executes single-shard writes/reads, self-routing IDs, scatter merge, and 2-phase partial aggregates across 3 shards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-sharded-adapter-'));
  try {
    const router = createShardRouter({
      strategy: 'hash',
      buckets: 4096,
      shards: [{ id: 's0' }, { id: 's1' }, { id: 's2' }],
    });
    const lookupDir = new MemoryShardDirectory({ strategy: 'hash' });
    await lookupDir.registerShard({ shardId: 's0', label: 'S0', status: 'active', weight: 1 });
    await lookupDir.registerShard({ shardId: 's1', label: 'S1', status: 'active', weight: 1 });
    await lookupDir.registerShard({ shardId: 's2', label: 'S2', status: 'active', weight: 1 });

    const controlAdapter = createShardDb(join(dir, 'control.db'));
    const placements: Record<string, TableShardPlacement> = {
      orders: { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'vbucket-int64', scatter: 'bounded' },
      tickets: { kind: 'sharded', group: 'account', key: 'account_id', id: 'vbucket-ulid', scatter: 'refuse' },
      legacy_invoices: { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'directory', scatter: 'refuse' },
      countries: { kind: 'reference', writable: false },
      audit_batches: { kind: 'unsharded' },
    };

    const sharded = createShardedAdapter({
      router,
      openShard: async (shardId) => createShardDb(join(dir, `${shardId}.db`)),
      control: controlAdapter,
      placements,
      lookup: lookupDir,
      defaultScatter: 'refuse',
    });

    try {
      // 1. Insert orders across multiple customers so rows land across all 3 shards with synthesized vbucket-int64 IDs.
      const orderIds: Array<{ id: string; customer_id: number; shardId: string; amount: number }> = [];
      const customerIds = [101, 202, 303, 404, 505, 606, 707, 808, 909];
      for (let i = 0; i < customerIds.length; i++) {
        const cid = customerIds[i]!;
        const amount = (i + 1) * 100;
        const region = i % 2 === 0 ? 'us' : 'eu';
        const inserted = await sharded.insert!({
          table: 'orders',
          values: { customer_id: cid, region, amount },
        });
        const id = String(inserted.key.id);
        const bucket = decodeVbucketInt64(id);
        assert.notEqual(bucket, undefined);
        const expectedShard = router.shardForKey(cid);
        assert.equal(router.shardForBucket(bucket!), expectedShard);
        orderIds.push({ id, customer_id: cid, shardId: expectedShard, amount });
      }
      // Verify all 3 shards received data.
      assert.equal(new Set(orderIds.map((o) => o.shardId)).size, 3);

      // 2. Point lookup, update, and delete by self-routing ID alone (NO customer_id in query/key!).
      const sample = orderIds[0]!;
      const found = await sharded.query({
        table: 'orders',
        filter: { groups: [[{ column: 'id', op: '=', value: sample.id }]] },
        limit: 10,
        offset: 0,
      });
      assert.equal(found.rows.length, 1);
      assert.equal(found.rows[0]!.customer_id, sample.customer_id);

      const updated = await sharded.update!({
        table: 'orders',
        key: { id: sample.id },
        values: { amount: 150 },
      });
      assert.equal(updated.affected, 1);
      sample.amount = 150;

      // Mutating shard key in place must be refused.
      await assert.rejects(
        () =>
          sharded.update!({
            table: 'orders',
            key: { id: sample.id },
            values: { customer_id: 99999 },
          }),
        (err: unknown) => err instanceof Refusal && /Cannot change shard key/.test(err.message),
      );

      // 3. vbucket-ulid auto ID synthesis + scatter: 'refuse' enforcement on tickets.
      const ticketRes = await sharded.insert!({
        table: 'tickets',
        values: { account_id: 'acct-west', subject: 'Cannot sign in' },
      });
      const ticketId = String(ticketRes.key.id);
      assert.notEqual(decodeVbucketUlid(ticketId), undefined);
      // Reading by self-routing ULID succeeds without account_id.
      const ticketRead = await sharded.query({
        table: 'tickets',
        filter: { groups: [[{ column: 'id', op: '=', value: ticketId }]] },
        limit: 10,
        offset: 0,
      });
      assert.equal(ticketRead.rows.length, 1);
      // Unfiltered scatter on tickets is refused fail-closed.
      await assert.rejects(
        () => sharded.query({ table: 'tickets', limit: 10, offset: 0 }),
        (err: unknown) => err instanceof Refusal && /scatter-gather is refused/.test(err.message),
      );

      // 4. Reference tables are readable and refuse writes; unsharded tables route to control shard.
      const countries = await sharded.query({ table: 'countries', limit: 10, offset: 0 });
      assert.equal(countries.rows.length, 2);
      await assert.rejects(
        () => sharded.insert!({ table: 'countries', values: { code: 'FR', name: 'France' } }),
        (err: unknown) => err instanceof Refusal && /read-only at runtime/.test(err.message),
      );
      await sharded.insert!({ table: 'audit_batches', values: { id: 1, note: 'batch-1' } });
      assert.equal((await sharded.query({ table: 'audit_batches', limit: 10, offset: 0 })).rows.length, 1);

      // 5. Opt-in directory lookup vindex routes legacy PKs cleanly.
      await sharded.insert!({ table: 'legacy_invoices', values: { id: 'INV-42', customer_id: 303, total: 500 } });
      const invRead = await sharded.query({
        table: 'legacy_invoices',
        filter: { groups: [[{ column: 'id', op: '=', value: 'INV-42' }]] },
        limit: 10,
        offset: 0,
      });
      assert.equal(invRead.rows.length, 1);
      assert.equal(invRead.rows[0]!.total, 500);
      await sharded.update!({ table: 'legacy_invoices', key: { id: 'INV-42' }, values: { total: 650 } });
      assert.equal((await sharded.remove!({ table: 'legacy_invoices', key: { id: 'INV-42' } })).affected, 1);

      // 6. Unanchored transaction refuses; transactionFor(shardKey) runs single-shard ACID transaction.
      await assert.rejects(
        () => sharded.transaction!(async () => 'nope'),
        (err: unknown) => err instanceof Refusal && /unanchored transaction/.test(err.message),
      );
      const txShard = await sharded.transactionFor(202, async (tx, shardId) => {
        const rows = await tx.query({
          table: 'orders',
          filter: { groups: [[{ column: 'customer_id', op: '=', value: 202 }]] },
          limit: 10,
          offset: 0,
        });
        assert.equal(rows.rows.length, 1);
        return shardId;
      });
      assert.equal(txShard, router.shardForKey(202));

      // 7. Phase 4 scatter-gather query k-way merge + offset + bounded count.
      const top3 = await sharded.query({
        table: 'orders',
        orderBy: [{ column: 'amount', direction: 'desc' }],
        limit: 3,
        offset: 0,
      });
      assert.deepEqual(
        top3.rows.map((r) => r.amount),
        [900, 800, 700],
      );
      const page2 = await sharded.query({
        table: 'orders',
        orderBy: [{ column: 'amount', direction: 'desc' }],
        offset: 3,
        limit: 3,
      });
      assert.deepEqual(
        page2.rows.map((r) => r.amount),
        [600, 500, 400],
      );
      assert.equal(await sharded.count('orders'), 9);
      assert.equal(await sharded.count('orders', undefined, 5), 6); // bounded count cap + 1

      // 8. Phase 4 two-phase partial-aggregate pushdown (count, sum, min, max, weighted avg across shards!).
      const expectedTotal = orderIds.reduce((s, o) => s + o.amount, 0);
      const expectedAvg = expectedTotal / orderIds.length;
      const bd = await sharded.runBreakdown!({
        base: 'orders',
        by: [{ path: 'region' }],
        measures: [
          { fn: 'count', alias: 'cnt' },
          { fn: 'sum', path: 'amount', alias: 'total' },
          { fn: 'min', path: 'amount', alias: 'lo' },
          { fn: 'max', path: 'amount', alias: 'hi' },
          { fn: 'avg', path: 'amount', alias: 'mean' },
        ],
        orderBy: [{ name: 'region', direction: 'asc' }],
      });
      assert.equal(bd.rows.length, 2);
      const totalAcrossGroups = bd.rows.reduce((s, r) => s + Number(r.total), 0);
      assert.equal(totalAcrossGroups, expectedTotal);

      const agg = await sharded.aggregate!({
        table: 'orders',
        measures: [
          { fn: 'count', name: 'cnt' },
          { fn: 'sum', column: 'amount', name: 'total' },
          { fn: 'avg', column: 'amount', name: 'mean' },
        ],
        limit: 10,
      });
      assert.equal(agg.rows[0]!.cnt, 9);
      assert.equal(agg.rows[0]!.total, expectedTotal);
      assert.ok(Math.abs(Number(agg.rows[0]!.mean) - expectedAvg) < 1e-9);

      // 9. Non-decomposable cross-shard aggregates (`median`, non-shard-key `COUNT(DISTINCT)`) refuse loudly.
      await assert.rejects(
        () =>
          sharded.runBreakdown!({
            base: 'orders',
            by: [],
            measures: [{ fn: 'median', path: 'amount', alias: 'med' }],
          }),
        (err: unknown) => err instanceof Refusal && /median/.test(err.message),
      );
      await assert.rejects(
        () =>
          sharded.runBreakdown!({
            base: 'orders',
            by: [],
            measures: [{ fn: 'count', distinct: true, path: 'region', alias: 'regions' }],
          }),
        (err: unknown) => err instanceof Refusal && /COUNT\(DISTINCT region\)/.test(err.message),
      );
    } finally {
      await sharded.close();
      await controlAdapter.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appSharding parses DSL, validates constraints/rollups/warnings, extends fillsKey, and builds shard-targeted search filters', () => {
  const sharding = parseSourceSharding(
    {
      buckets: 4096,
      groups: {
        customer: { keyType: 'bigint', strategy: 'hash' },
        merchant: { keyType: 'text', strategy: 'hash' },
      },
    },
    'sources.main',
  );
  const orderPlacement = parseResourcePlacement(
    { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'vbucket-int64', scatter: 'bounded' },
    'resources.orders',
  );
  const linePlacement = parseResourcePlacement(
    { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'composite' },
    'resources.order_lines',
  );
  const merchantPlacement = parseResourcePlacement({ kind: 'sharded', group: 'merchant', key: 'id' }, 'resources.merchants');
  const countryPlacement = parseResourcePlacement({ kind: 'reference', writable: false }, 'resources.countries');

  // Co-location & stitched-edge classification.
  assert.equal(isCrossGroupEdge(orderPlacement, linePlacement), false);
  assert.deepEqual(coLocatedJoinColumns(orderPlacement, linePlacement), ['customer_id', 'customer_id']);
  assert.equal(isCrossGroupEdge(orderPlacement, countryPlacement), false);
  assert.equal(isCrossGroupEdge(orderPlacement, merchantPlacement), true);

  const schema: DatabaseSchema = {
    dialect: 'postgres',
    label: 'test',
    readAt: '2026-01-01T00:00:00.000Z',
    tables: [
      {
        id: 'orders',
        name: 'orders',
        schema: 'public',
        isView: false,
        columns: [
          { name: 'id', type: 'text', primaryKey: true, nullable: false },
          { name: 'customer_id', type: 'bigint', primaryKey: false, nullable: false },
          { name: 'order_no', type: 'text', primaryKey: false, nullable: false },
        ],
        unique: ['order_no'],
      },
      {
        id: 'merchants',
        name: 'merchants',
        schema: 'public',
        isView: false,
        columns: [
          { name: 'id', type: 'text', primaryKey: true, nullable: false },
          { name: 'name', type: 'text', primaryKey: false, nullable: false },
        ],
      },
      {
        id: 'countries',
        name: 'countries',
        schema: 'public',
        isView: false,
        columns: [
          { name: 'code', type: 'text', primaryKey: true, nullable: false },
          { name: 'name', type: 'text', primaryKey: false, nullable: false },
        ],
      },
    ],
    foreignKeys: [],
  };

  // Validate errors & warnings.
  const check = validateAppSharding(
    {
      sources: { main: { connection: 'db', default: true, sharding } },
      resources: {
        orders: {
          placement: orderPlacement,
          rollups: { merchant_count: { from: 'merchants', fn: 'count' } },
          noOverlap: [{ by: ['order_no'], from: 'starts_at', to: 'ends_at' }],
        },
        merchants: { placement: merchantPlacement },
        countries: { placement: countryPlacement, access: 'write' },
      },
      views: {
        orders_list: { kind: 'list', table: 'orders', label: 'Orders', suggest: ['order_no'] } as never,
      },
    },
    schema,
  );
  assert.ok(check.errors.some((e) => /unique constraint on "orders\.order_no" omits shard key/.test(e)));
  assert.ok(check.errors.some((e) => /noOverlap rule must include shard key/.test(e)));
  assert.ok(check.errors.some((e) => /rollup "merchant_count".*another shard group/.test(e)));
  assert.ok(check.errors.some((e) => /reference table cannot declare access "write"/.test(e)));
  assert.ok(check.warnings.some((w) => /"suggest" on sharded resource "orders"/.test(w)));

  // withFillsKeys marks non-tenant sharded vbucket-int64/ulid tables as fillsKey: true.
  const filled = withFillsKeys({ resources: { orders: { placement: orderPlacement } } }, schema);
  assert.equal(filled.tables.find((t) => t.id === 'orders')?.fillsKey, true);
  assert.equal(filled.tables.find((t) => t.id === 'merchants')?.fillsKey, undefined);

  // shardedSearchFilter groups hits by shard key so hydration avoids full-cluster scatter.
  const filter = shardedSearchFilter(
    [
      { id: '1', shardKey: 10 },
      { id: '2', shardKey: 10 },
      { id: '3', shardKey: 20 },
    ],
    'customer_id',
    'id',
  );
  assert.equal(filter.groups.length, 2);
  assert.deepEqual(filter.groups[0], [
    { column: 'customer_id', op: '=', value: 10 },
    { column: 'id', op: 'in', value: ['1', '2'] },
  ]);
  assert.deepEqual(filter.groups[1], [
    { column: 'customer_id', op: '=', value: 20 },
    { column: 'id', op: '=', value: '3' },
  ]);
});

test('parseAppConfig parses sources.<name>.sharding and resources.<name>.placement end to end', () => {
  const app = parseAppConfig(
    {
      name: 'Commerce',
      sources: {
        main: {
          connection: 'commerce-cluster',
          default: true,
          sharding: {
            buckets: 4096,
            groups: {
              customer: { keyType: 'bigint', strategy: 'hash' },
            },
          },
        },
      },
      resources: {
        orders: {
          access: 'write',
          placement: { kind: 'sharded', group: 'customer', key: 'customer_id', id: 'vbucket-int64', scatter: 'bounded' },
        },
        countries: {
          placement: { kind: 'reference', writable: false },
        },
      },
      views: {
        orders: { kind: 'list', from: 'orders', label: 'Orders' },
      },
      nav: ['orders'],
    },
    'commerce.app.ts',
  );
  assert.equal(app.sources?.main?.sharding?.buckets, 4096);
  assert.equal(app.sources?.main?.sharding?.groups.customer?.keyType, 'bigint');
  assert.deepEqual(app.resources?.orders?.placement, {
    kind: 'sharded',
    group: 'customer',
    key: 'customer_id',
    id: 'vbucket-int64',
    scatter: 'bounded',
  });
  assert.deepEqual(app.resources?.countries?.placement, { kind: 'reference', writable: false });
});
