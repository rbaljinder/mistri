/**
 * The pools against a live PostgreSQL (TABLEWALK_TEST_PG).
 *
 * A small reader pool under concurrent reads queues, says so in its meters,
 * and still answers every read correctly; the same load on a larger pool
 * does not queue. And the transaction-mode path keeps its guarantees on a
 * server connection a previous transaction left dirty, which is exactly what
 * a transaction-mode pooler hands a client. No pooler is needed to prove
 * that: one client used for a write and then a read is the same event.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { transactionScoped } from '../packages/engine/src/adapters/postgresPooler.js';
import { POOL_DURATION_BOUNDS_MS } from '../packages/engine/src/adapters/poolMetrics.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { keepDatesAsText } from '../packages/engine/src/adapters/postgresDates.js';
import { stoppedReason } from '../packages/engine/src/adapters/statementControl.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { collectCapacity } from '../packages/mistri/src/server/operations/capacity.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);
/** Its own schema, named for this run, so nothing this file drops belongs to
 * anyone else — including another run of this file on the same server. */
const FIXTURE = `tablewalk_pool_fixture_${randomUUID().replaceAll('-', '')}`;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** Samples past `bound` milliseconds. */
const past = (values: readonly number[], bound: number) => sum(values.slice(POOL_DURATION_BOUNDS_MS.indexOf(bound) + 1));
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

interface RawClient extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

/** One physical connection of our own: the server connection a pooler would pass from client to client. */
async function rawClient(): Promise<RawClient> {
  const specifier = 'pg';
  type ClientClass = new (options: { connectionString: string }) => RawClient;
  const pg = (await import(specifier)) as { Client?: ClientClass; default?: { Client: ClientClass } };
  const Client = pg.Client ?? pg.default!.Client;
  const client = new Client({ connectionString: LIVE! });
  await client.connect();
  return client;
}

async function scalar(client: PgQuery, text: string): Promise<unknown> {
  const result = await client.query(text);
  return Object.values(result.rows[0] ?? {})[0];
}

before(async () => {
  if (skip) return;
  const setup = await rawClient();
  try {
    await setup.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
    await setup.query(`CREATE SCHEMA ${FIXTURE}`);
    await setup.query(`CREATE TABLE ${FIXTURE}.item (id integer PRIMARY KEY, name text NOT NULL)`);
    await setup.query(`INSERT INTO ${FIXTURE}.item SELECT n, 'item ' || n FROM generate_series(1, 20) AS n`);
  } finally {
    await setup.end();
  }
});

after(async () => {
  if (skip) return;
  const teardown = await rawClient();
  try {
    await teardown.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
  } finally {
    await teardown.end();
  }
});

async function concurrentReads(readers: number): Promise<{ elapsed: number; stats: ReturnType<PgConnectionManager['stats']>[number] }> {
  const manager = new PgConnectionManager(LIVE!, undefined, undefined, { readers });
  try {
    const read = await manager.read();
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        read.query(`SELECT id, name, pg_sleep(0.1)::text AS slept FROM ${FIXTURE}.item WHERE id = $1`, [i + 1]),
      ),
    );
    const elapsed = performance.now() - started;
    // Every read answered, and with its own row: a queued checkout is late, never wrong.
    assert.deepEqual(
      results.map((result) => [result.rows[0].id, result.rows[0].name]),
      Array.from({ length: 8 }, (_, i) => [i + 1, `item ${i + 1}`]),
    );
    return { elapsed, stats: manager.stats()[0] };
  } finally {
    await manager.close();
  }
}

test('a small reader pool under concurrent reads queues, says so, and answers every read correctly', { skip }, async () => {
  const small = await concurrentReads(2);
  assert.deepEqual(
    {
      size: small.stats.size,
      checkouts: small.stats.checkouts,
      queued: small.stats.queued,
      inUse: small.stats.inUse,
      waiting: small.stats.waiting,
      timedOut: small.stats.timedOut,
      failed: small.stats.failed,
    },
    { size: 2, checkouts: 8, queued: 6, inUse: 0, waiting: 0, timedOut: 0, failed: 0 },
  );
  // Eight 100 ms reads through two connections: four rounds, and the later checkouts waited for them.
  assert.ok(small.elapsed >= 350, `two connections serve eight 100 ms reads in about 400 ms, not ${Math.round(small.elapsed)}`);
  assert.ok(past(small.stats.waitBuckets, 50) >= 4, `waits: ${small.stats.waitBuckets.join(',')}`);
  // Each lease held its connection for the whole 100 ms statement: long holds, which is how a slow database reads.
  assert.equal(past(small.stats.holdBuckets, 50), 8);

  const large = await concurrentReads(8);
  assert.equal(large.stats.queued, 0);
  assert.ok(
    large.elapsed < small.elapsed,
    `eight connections (${Math.round(large.elapsed)} ms) beat two (${Math.round(small.elapsed)} ms)`,
  );
});

test("a connection's configured pool reaches the operator's capacity read, by position", { skip }, async () => {
  const registry = new Registry();
  registry.onWarning = () => {};
  try {
    const added = registry.add({ name: 'live', url: LIVE!, schemas: [FIXTURE], pool: { read: 2 }, source: 'config' });
    const { adapter } = await registry.open(added.id);
    const counts = await Promise.all(Array.from({ length: 6 }, () => adapter.count(`${FIXTURE}.item`)));
    assert.deepEqual(counts, Array(6).fill(20));
    const [pool] = collectCapacity(registry).pools;
    assert.deepEqual(
      [pool.position, pool.dialect, pool.role, pool.pooler, pool.size, pool.inUse],
      [1, 'postgres', 'read', 'session', 2, 0],
    );
    assert.ok(pool.checkouts >= 6);
  } finally {
    await registry.closeAll();
  }
});

test('a server connection a write left dirty is still read-only and capped when a read reuses it', { skip }, async () => {
  const raw = await rawClient();
  try {
    const pid = await scalar(raw, 'SELECT pg_backend_pid()');
    const writer = transactionScoped(raw, { role: 'write', capMs: 30_000, untrusted: false });
    await writer.query(`INSERT INTO ${FIXTURE}.item (id, name) VALUES (100, 'written')`);
    // How a previous client of the pooler might leave the server connection: writable by default, and no cap.
    await raw.query('SET default_transaction_read_only = off');
    await raw.query('SET statement_timeout = 0');

    const reader = transactionScoped(raw, { role: 'read', capMs: 300, untrusted: false });
    assert.deepEqual((await reader.query(`SELECT name FROM ${FIXTURE}.item WHERE id = 100`)).rows, [{ name: 'written' }]);
    await assert.rejects(reader.query(`UPDATE ${FIXTURE}.item SET name = 'changed' WHERE id = 100`), code('25006'));
    await assert.rejects(reader.query('CREATE TEMP TABLE leaked (x integer)'), code('25006'));
    await assert.rejects(reader.query('SELECT pg_sleep(2)'), code('57014'));
    // A caller's own BEGIN is read-only on a reader too, and still capped.
    await reader.query('BEGIN');
    await assert.rejects(reader.query(`DELETE FROM ${FIXTURE}.item WHERE id = 100`), code('25006'));
    await reader.query('ROLLBACK');
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assert.rejects(reader.query('SELECT pg_sleep(2)'), code('57014'));
    await reader.query('ROLLBACK');

    // Nothing either lease set outlived its transaction: the session is as the previous client left it.
    assert.equal(await scalar(raw, 'SHOW statement_timeout'), '0');
    assert.equal(await scalar(raw, 'SHOW default_transaction_read_only'), 'off');
    assert.equal(await scalar(raw, 'SELECT pg_backend_pid()'), pid);
    assert.equal(await scalar(raw, `SELECT name FROM ${FIXTURE}.item WHERE id = 100`), 'written');
  } finally {
    await raw.query(`DELETE FROM ${FIXTURE}.item WHERE id = 100`).catch(() => {});
    await raw.end();
  }
});

test("user-authored SQL leaves nothing on the server connection for the pooler's next client", { skip }, async () => {
  const raw = await rawClient();
  try {
    const before = await scalar(raw, 'SHOW application_name');
    const user = () => transactionScoped(raw, { role: 'write', capMs: 30_000, untrusted: true });
    await user().query('SELECT pg_advisory_lock(424242)', []);
    await user().query("SELECT set_config('application_name', 'leaked', false)", []);
    await user().query('PREPARE leaked AS SELECT 1', []);
    await user().query('LISTEN leaked_channel', []);
    await user().query('CREATE TEMP TABLE leaked (x integer)', []);
    // A statement that takes a lock and then fails: rolled back to its savepoint, so the lock can still be shed.
    await assert.rejects(user().query('SELECT pg_advisory_lock(7), 1/0', []), code('22012'));
    // The read path: the adapter's BEGIN READ ONLY, a lock taken inside, and its ROLLBACK.
    const reader = transactionScoped(raw, { role: 'read', capMs: 30_000, untrusted: true });
    await reader.query('BEGIN READ ONLY');
    await reader.query({ text: 'SELECT pg_advisory_lock(99)', values: [], rowMode: 'array' });
    await reader.query('ROLLBACK');

    assert.equal(await scalar(raw, "SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()"), 0);
    assert.equal(await scalar(raw, 'SHOW application_name'), before);
    assert.equal(await scalar(raw, 'SELECT count(*)::int FROM pg_prepared_statements'), 0);
    assert.equal(await scalar(raw, 'SELECT count(*)::int FROM pg_listening_channels()'), 0);
    assert.equal(await scalar(raw, "SELECT count(*)::int FROM pg_class WHERE relname = 'leaked' AND relpersistence = 't'"), 0);
  } finally {
    await raw.end();
  }
});

test('the adapter behind a transaction-mode pooler reads, writes, snapshots and caps as it does directly', { skip }, async () => {
  const manager = new PgConnectionManager(LIVE!, keepDatesAsText, undefined, { pooler: 'transaction', readers: 1 });
  const adapter = new PostgresAdapter(LIVE!, 'live pooled', [FIXTURE], manager);
  try {
    const schema = await adapter.introspect();
    assert.ok(schema.tables.some((table) => table.id === `${FIXTURE}.item`));
    const described = await adapter.readSnapshot((snapshot) => snapshot.describe());
    assert.equal(described.tables.length, schema.tables.length);
    await adapter.insert({ table: `${FIXTURE}.item`, values: { id: 200, name: 'pooled' } });
    assert.equal(await adapter.count(`${FIXTURE}.item`), 21);
    await adapter.remove({ table: `${FIXTURE}.item`, key: { id: 200 } });
    assert.equal(await adapter.count(`${FIXTURE}.item`), 20);
    // A user's statement past its cap is stopped by the transaction's own timeout.
    await assert.rejects(
      adapter.runSql({ text: 'SELECT pg_sleep(2)', limit: 10, timeoutMs: 200 }),
      (error) => stoppedReason(error) === 'timeout',
    );
    // The write path runs user SQL in a transaction of its own and commits it.
    const written = await adapter.runSql({ text: `UPDATE ${FIXTURE}.item SET name = 'renamed' WHERE id = 1`, limit: 10, write: true });
    assert.equal(written.affected, 1);
    assert.equal((await adapter.runSql({ text: `SELECT name FROM ${FIXTURE}.item WHERE id = 1`, limit: 10 })).rows[0][0], 'renamed');
    const stats = manager.stats();
    assert.deepEqual(
      stats.map((pool) => [pool.role, pool.pooler, pool.inUse]),
      [
        ['read', 'transaction', 0],
        ['write', 'transaction', 0],
      ],
    );
  } finally {
    await adapter.close();
  }
});
