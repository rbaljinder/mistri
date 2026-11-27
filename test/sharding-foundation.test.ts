/**
 * Phase 1 sharding foundation tests: virtual buckets, self-routing IDs,
 * ShardRouter topologies, sharded ConnectionConfig parsing/saving, per-shard
 * RYW replica freshness, shard-aware pool defaults & budgets, composite PK
 * child includes / declared references, and multi-shard migration targets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignDefaultBuckets,
  createShardRouter,
  decodeSelfRoutingToken,
  decodeVbucketInt64,
  decodeVbucketUlid,
  DEFAULT_SHARD_BUCKETS,
  encodeSelfRoutingToken,
  encodeVbucketInt64,
  encodeVbucketUlid,
  isBucketCount,
  isShardId,
  vbucketOf,
  VBUCKET_INT64_EPOCH_MS,
} from '@mistriwork/engine/shared/sharding.js';
import { loadConfig, Registry, saveConfig } from '@mistriwork/engine/server/connections.js';
import { CACHE_SECTIONS } from '@mistriwork/engine/server/cacheService.js';
import {
  FRESH_READ_MS,
  lagTolerantReads,
  noteWrite,
  readsAs,
  replicaReadWanted,
  ReplicaSet,
} from '@mistriwork/engine/adapters/replicas.js';
import { freshCookie, readFreshness } from '@mistriwork/engine/server/http/readRouting.js';
import { shardPoolDefaults } from '@mistriwork/engine/adapters/postgresPool.js';
import { shardedProcessConnections } from '@mistriwork/engine/adapters/connectionBudget.js';
import { parseChildIncludes, runChildIncludes } from '../packages/engine/src/server/viewIncludeExec.js';
import { shapeIncludedRows, splitInclude } from '@mistriwork/engine/shared/viewInclude.js';
import { declaredEdge } from '@mistriwork/engine/shared/declaredReferences.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { resolveShardTargets } from '@mistriwork/engine/server/migrate/target.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

test('vbucketOf is deterministic and spreads sequential keys across buckets', () => {
  assert.equal(isShardId('shard-01_a'), true);
  assert.equal(isShardId('bad shard'), false);
  assert.equal(isBucketCount(DEFAULT_SHARD_BUCKETS), true);
  assert.equal(isBucketCount(0), false);
  assert.equal(isBucketCount(5000), false);

  const b1 = vbucketOf('tenant-alpha');
  const b2 = vbucketOf('tenant-alpha');
  assert.equal(b1, b2);
  assert.ok(b1 >= 0 && b1 < DEFAULT_SHARD_BUCKETS);

  const seen = new Set<number>();
  for (let i = 1; i <= 500; i++) seen.add(vbucketOf(i, 64));
  assert.equal(seen.size, 64);
});

test('vbucket-int64 and vbucket-ulid IDs round-trip their virtual bucket and preserve ordering', () => {
  const now = VBUCKET_INT64_EPOCH_MS + 1_000_000;
  const id0 = encodeVbucketInt64(0, now, 0);
  const idMax = encodeVbucketInt64(4095, now, 1023);
  const idAuto1 = encodeVbucketInt64(777, now + 5);
  const idAuto2 = encodeVbucketInt64(777, now + 5);
  assert.equal(decodeVbucketInt64(id0), 0);
  assert.equal(decodeVbucketInt64(idMax), 4095);
  assert.equal(decodeVbucketInt64(idAuto1), 777);
  assert.equal(decodeVbucketInt64(idAuto2), 777);
  assert.ok(BigInt(idAuto2) > BigInt(idAuto1));
  assert.equal(decodeVbucketInt64('not-an-id'), undefined);
  assert.equal(decodeVbucketInt64(-5), undefined);

  const u1 = encodeVbucketUlid(42, now);
  const u2 = encodeVbucketUlid(4095, now + 10);
  assert.equal(decodeVbucketUlid(u1), 42);
  assert.equal(decodeVbucketUlid(u2), 4095);
  assert.equal(decodeVbucketUlid('invalid'), undefined);

  const tok = encodeSelfRoutingToken('shard-2', 'abc123.def');
  assert.equal(tok, 's.shard-2.abc123.def');
  assert.deepEqual(decodeSelfRoutingToken(tok), { shardId: 'shard-2', token: 'abc123.def' });
  assert.equal(decodeSelfRoutingToken('plain-token'), undefined);
});

test('createShardRouter handles hash, split buckets, range, list, and rejects invalid topologies', () => {
  const defaults = assignDefaultBuckets(['s0', 's1', 's2', 's3'], 4096);
  assert.deepEqual(defaults.get('s0'), [[0, 1023]]);
  assert.deepEqual(defaults.get('s3'), [[3072, 4095]]);

  const hashRouter = createShardRouter({
    strategy: 'hash',
    buckets: 4096,
    shards: [
      { id: 's0', buckets: [[0, 2047]] },
      { id: 's1', buckets: [[2048, 3071]], status: 'read_only' },
      { id: 's2', buckets: [[3072, 4095]] },
    ],
  });
  assert.equal(hashRouter.shardForBucket(0), 's0');
  assert.equal(hashRouter.shardForBucket(2500), 's1');
  assert.equal(hashRouter.shardForBucket(4095), 's2');
  assert.deepEqual(hashRouter.writableShards(), ['s0', 's2']);
  assert.equal(hashRouter.node('s1')?.status, 'read_only');

  const idForS2 = encodeVbucketInt64(3500, VBUCKET_INT64_EPOCH_MS + 5000, 1);
  assert.equal(hashRouter.shardForId(idForS2, 'vbucket-int64'), 's2');
  const ulidForS0 = encodeVbucketUlid(100, VBUCKET_INT64_EPOCH_MS + 5000);
  assert.equal(hashRouter.shardForId(ulidForS0, 'vbucket-ulid'), 's0');

  const grouped = hashRouter.shardsForKeys(['acct-1', 'acct-2', 'acct-3', 'acct-4']);
  const totalGrouped = [...grouped.values()].reduce((sum, items) => sum + items.length, 0);
  assert.equal(totalGrouped, 4);

  const rangeRouter = createShardRouter({
    strategy: 'range',
    shards: [
      { id: 'low', range: { max: 1000 } },
      { id: 'high', range: { min: 1000 } },
    ],
  });
  assert.equal(rangeRouter.shardForKey(500), 'low');
  assert.equal(rangeRouter.shardForKey(1000), 'high');

  const listRouter = createShardRouter({
    strategy: 'list',
    shards: [
      { id: 'us', values: ['us-east', 'us-west'] },
      { id: 'eu', values: ['eu-central'] },
    ],
  });
  assert.equal(listRouter.shardForKey('us-west'), 'us');
  assert.equal(listRouter.shardForKey('eu-central'), 'eu');
  assert.throws(() => listRouter.shardForKey('ap-south'), /No shard owns list key/);

  assert.throws(
    () =>
      createShardRouter({
        strategy: 'hash',
        buckets: 8,
        shards: [
          { id: 's0', buckets: [[0, 4]] },
          { id: 's1', buckets: [[4, 7]] },
        ],
      }),
    /assigned to both/,
  );
  assert.throws(
    () =>
      createShardRouter({
        strategy: 'hash',
        buckets: 8,
        shards: [
          { id: 's0', buckets: [[0, 3]] },
          { id: 's1', buckets: [[5, 7]] },
        ],
      }),
    /Virtual bucket 4 has no owning shard/,
  );
});

test('loadConfig and saveConfig validate and preserve PostgreSQL shards topology while refusing SQLite shards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-shards-cfg-'));
  try {
    const file = join(dir, 'mistri.json');
    writeFileSync(
      file,
      JSON.stringify({
        connections: [
          {
            name: 'orders',
            url: 'postgres://app@control:5432/orders',
            writable: true,
            shards: {
              strategy: 'hash',
              buckets: 4096,
              directory: 'postgres://app@control:5432/directory',
              nodes: [
                {
                  id: 's0',
                  url: 'postgres://app@shard0:5432/orders',
                  replicas: ['postgres://reader@shard0-ro:5432/orders'],
                  pool: { read: 4, write: 2, minIdle: 0 },
                },
                {
                  id: 's1',
                  url: 'postgres://app@shard1:5432/orders',
                  listen: 'postgres://app@shard1-direct:5432/orders',
                },
              ],
            },
          },
        ],
      }),
    );

    const loaded = await loadConfig(file, CACHE_SECTIONS);
    assert.ok(loaded);
    assert.equal(loaded.connections.length, 1);
    const conn = loaded.connections[0]!;
    assert.equal(conn.shards?.strategy, 'hash');
    assert.equal(conn.shards?.buckets, 4096);
    assert.equal(conn.shards?.directory, 'postgres://app@control:5432/directory');
    assert.equal(conn.shards?.nodes.length, 2);
    assert.deepEqual(conn.shards?.nodes[0]?.pool, { read: 4, write: 2, minIdle: 0 });

    const savedPath = join(dir, 'saved.json');
    const registry = new Registry();
    registry.add({ ...conn, source: 'config' });
    await saveConfig(savedPath, registry.configs());
    const reloaded = await loadConfig(savedPath, CACHE_SECTIONS);
    assert.deepEqual(reloaded?.connections[0]?.shards, conn.shards);

    // SQLite sharding must be refused loudly in v1.
    const badFile = join(dir, 'sqlite-shards.json');
    writeFileSync(
      badFile,
      JSON.stringify({
        connections: [
          {
            name: 'local',
            url: './local.db',
            shards: { nodes: [{ id: 's0', url: 'postgres://app@shard0:5432/app' }] },
          },
        ],
      }),
    );
    await assert.rejects(() => loadConfig(badFile, CACHE_SECTIONS), /sharding is supported on PostgreSQL only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-shard RYW replica freshness isolates writes to the shard written', async () => {
  // Instantiate one ReplicaSet so replicasConfigured becomes true.
  const set = new ReplicaSet(['replica-pool']);
  assert.equal(set.healthy(0), true);

  let now = 1_700_000_000_000;
  const headers: Record<string, string | string[]> = {};
  const response = {
    headersSent: false,
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
      return this;
    },
  } as unknown as Parameters<typeof readFreshness>[1];

  const ctx1 = readFreshness({ headers: {} }, response, '/', () => now);
  readsAs(ctx1, () => {
    lagTolerantReads(() => {
      assert.equal(replicaReadWanted(now, 's0'), true);
      assert.equal(replicaReadWanted(now, 's1'), true);
      noteWrite(now, 's0');
      assert.equal(replicaReadWanted(now, 's0'), false);
      assert.equal(replicaReadWanted(now, 's1'), true);
    });
  });

  const setCookie = headers['set-cookie'];
  assert.ok(typeof setCookie === 'string' && setCookie.includes(`${freshCookie()}=s0:${now}`));

  // Next request carries that cookie: s0 stays on primary, s1 still uses replicas.
  const cookieHeader = setCookie.split(';')[0]!;
  const ctx2 = readFreshness({ headers: { cookie: cookieHeader } }, response, '/', () => now + 2_000);
  readsAs(ctx2, () => {
    lagTolerantReads(() => {
      assert.equal(replicaReadWanted(now + 2_000, 's0'), false);
      assert.equal(replicaReadWanted(now + 2_000, 's1'), true);
      // Past FRESH_READ_MS, s0 returns to replicas too.
      assert.equal(replicaReadWanted(now + FRESH_READ_MS + 1, 's0'), true);
    });
  });

  // Bearer token callers also isolate RYW per shard.
  const bearerCtx = readFreshness({ headers: { authorization: 'Bearer test-shard-token' } }, response, '/', () => now);
  readsAs(bearerCtx, () => {
    lagTolerantReads(() => {
      noteWrite(now, 's0');
      assert.equal(replicaReadWanted(now + 500, 's0'), false);
      assert.equal(replicaReadWanted(now + 500, 's1'), true);
    });
  });
});

test('shardPoolDefaults and shardedProcessConnections scale down per-shard defaults', () => {
  const single = shardPoolDefaults(1, {}, 4);
  const sharded16 = shardPoolDefaults(16, {}, 4);
  assert.ok(sharded16.readers < single.readers);
  assert.ok(sharded16.writers <= single.writers);
  assert.equal(sharded16.minIdle, 0);

  const explicit = shardPoolDefaults(16, { read: 12, write: 5, minIdle: 1 }, 4);
  assert.deepEqual(explicit, { readers: 12, writers: 5, minIdle: 1 });

  const total = shardedProcessConnections(
    [
      { readers: 4, writers: 2, listen: true },
      { readers: 4, writers: 2, listen: true },
    ],
    { directory: true, directoryListen: true },
  );
  // Each shard: (4 + 2 + 1) + 1 = 8 -> 16; directory: (1 + 1 + 1) + 1 = 4 -> total 20.
  assert.equal(total, 20);
});

test('runChildIncludes and shapeIncludedRows support composite primary keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-composite-include-'));
  const file = join(dir, 'composite.db');
  const { DatabaseSync } = await import('node:sqlite');
  const seedDb = new DatabaseSync(file);
  seedDb.exec(`
    CREATE TABLE orders (
      customer_id INTEGER NOT NULL,
      id INTEGER NOT NULL,
      total INTEGER NOT NULL,
      PRIMARY KEY (customer_id, id)
    );
    CREATE TABLE order_lines (
      customer_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL,
      sku TEXT NOT NULL,
      PRIMARY KEY (customer_id, order_id, line_no)
    );
    INSERT INTO orders VALUES (10, 1, 100), (20, 1, 200);
    INSERT INTO order_lines VALUES (10, 1, 1, 'SKU-A'), (10, 1, 2, 'SKU-B'), (20, 1, 1, 'SKU-C');
  `);
  seedDb.close();
  const adapter = new SqliteAdapter(file);
  try {
    const schema = await adapter.introspect();
    const parsed = parseChildIncludes({ lines: { from: 'order_lines', by: ['customer_id', 'order_id'], show: ['line_no', 'sku'] } });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const parentRows = [
      { customer_id: 10, id: 1, total: 100 },
      { customer_id: 20, id: 1, total: 200 },
    ];
    const parentView = {
      id: 'orders',
      name: 'Orders',
      base: 'orders',
      columns: [{ path: 'customer_id' }, { path: 'id' }, { path: 'total' }],
    };
    const res = await runChildIncludes(
      adapter,
      schema,
      'orders',
      parentView,
      ['customer_id', 'id', 'total'],
      parentRows,
      parsed.specs,
      new Date(),
      {},
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;

    const split = splitInclude({ lines: { from: 'order_lines', by: ['customer_id', 'order_id'], show: ['line_no', 'sku'] } });
    assert.equal(split.hasChildren, true);
    const shaped = shapeIncludedRows(parentRows, split.parents, res.included, ['customer_id', 'id'], undefined) as Array<
      Record<string, unknown>
    >;
    assert.equal((shaped[0]!.lines as unknown[]).length, 2);
    assert.equal((shaped[1]!.lines as unknown[]).length, 1);
    assert.equal((shaped[1]!.lines as Array<Record<string, unknown>>)[0]!.sku, 'SKU-C');

    // Composite declared reference against composite PK also validates cleanly.
    const edge = declaredEdge(
      schema,
      { table: 'order_lines', column: 'order_id', columns: ['customer_id', 'order_id'], to: 'orders' },
      'orders.lines',
    );
    assert.deepEqual(edge.from.columns, ['customer_id', 'order_id']);
    assert.deepEqual(edge.to.columns, ['customer_id', 'id']);
    assert.equal(edge.declared, true);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveShardTargets fans out across configured shards and supports single-shard selection', async () => {
  const registry = new Registry();
  registry.add({
    name: 'orders',
    url: 'postgres://app@control:5432/orders',
    writable: true,
    source: 'config',
    shards: {
      strategy: 'hash',
      buckets: 4096,
      directory: 'postgres://app@control:5432/directory',
      nodes: [
        { id: 's0', url: 'postgres://app@shard0:5432/orders' },
        { id: 's1', url: 'postgres://app@shard1:5432/orders' },
      ],
    },
  });
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
  const all = await resolveShardTargets(registry, startupConfig, { connection: 'orders', schemas: [] });
  assert.equal(all.targets.length, 2);
  assert.equal(all.targets[0]?.shardId, 's0');
  assert.equal(all.targets[1]?.shardId, 's1');
  assert.equal(all.directoryUrl, 'postgres://app@control:5432/directory');

  const single = await resolveShardTargets(registry, startupConfig, { connection: 'orders', schemas: [] }, undefined, undefined, 's1');
  assert.equal(single.targets.length, 1);
  assert.equal(single.targets[0]?.shardId, 's1');

  await assert.rejects(
    () => resolveShardTargets(registry, startupConfig, { connection: 'orders', schemas: [] }, undefined, undefined, 'missing'),
    /has no shard "missing"/,
  );
});

// Keep schema type referenced so strict unused checks stay clean.
void (undefined as unknown as DatabaseSchema);
