/**
 * Named PostgreSQL prepared statements on direct (session-mode) connections
 * (postgresPrepared.ts): 2-hit admission, bounded plan cap, DDL invalidation,
 * MISTRI_PG_PREPARED=off switch, and strict exclusion behind PgBouncer
 * transaction pooling.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  invalidatePreparedStatements,
  isRealPgClient,
  preparedClient,
  preparedClientStats,
  preparedStatementsEnabled,
  syncPreparedClient,
} from '../packages/engine/src/adapters/postgresPrepared.js';
import { PgConnectionManager, type PgQuery, type PgResult } from '../packages/engine/src/adapters/postgresPool.js';

interface RecordedCall {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly name?: string;
}

function fakePgClient() {
  const calls: RecordedCall[] = [];
  let nextError: Error | undefined;
  const client = {
    connection: { parsedStatements: {} as Record<string, string> },
    async query(
      request: string | { text: string; values?: unknown[]; name?: string },
      params?: unknown[],
    ): Promise<PgResult<Record<string, unknown>>> {
      if (typeof request === 'string') calls.push({ text: request, values: params });
      else calls.push({ text: request.text, values: request.values, name: request.name });
      if (nextError) {
        const err = nextError;
        nextError = undefined;
        throw err;
      }
      return { rows: [{ ok: 1 }], fields: [{ name: 'ok' }], rowCount: 1 };
    },
  };
  return {
    client: client as unknown as PgQuery,
    calls,
    failNext(error: Error) {
      nextError = error;
    },
  };
}

test('preparedClient uses 2-hit admission, ignores simple/multi-statement SQL, and reuses names across calls', async () => {
  const { client, calls } = fakePgClient();
  assert.equal(isRealPgClient(client), true);
  assert.equal(isRealPgClient({ query: async () => ({ rows: [], fields: [], rowCount: 0 }) }), false);
  const wrapped = preparedClient(client);

  // Simple protocol (no params) and multi-statement SQL are never named.
  await wrapped.query('BEGIN; LOCK TABLE t IN ACCESS SHARE MODE; SELECT 1');
  await wrapped.query('BEGIN; LOCK TABLE t IN ACCESS SHARE MODE; SELECT 1');
  await wrapped.query('SELECT 1', []);
  await wrapped.query('SELECT 1', []);
  assert.equal(
    calls.every((c) => c.name === undefined),
    true,
  );

  // 1st hit: unnamed; 2nd and 3rd hits: same prepared name.
  const sql = 'SELECT id FROM items WHERE tenant_id = $1';
  await wrapped.query(sql, ['t1']);
  await wrapped.query(sql, ['t2']);
  await wrapped.query(sql, ['t3']);
  assert.equal(calls[4]!.name, undefined, 'first hit runs unnamed');
  assert.equal(typeof calls[5]!.name, 'string', 'second hit allocates a prepared name');
  assert.equal(calls[6]!.name, calls[5]!.name, 'third hit reuses the same name');
  assert.equal(preparedClientStats(client).prepared, 1);

  // DDL invalidation triggers DEALLOCATE ALL on next idle sync and assigns a fresh prefix.
  invalidatePreparedStatements();
  await syncPreparedClient(client);
  assert.equal(calls.at(-1)!.text, 'DEALLOCATE ALL');
  assert.equal(preparedClientStats(client).prepared, 0);

  await wrapped.query(sql, ['t4']);
  await wrapped.query(sql, ['t5']);
  assert.equal(calls.at(-2)!.name, undefined, 're-warms after DEALLOCATE ALL');
  assert.notEqual(calls.at(-1)!.name, calls[5]!.name, 'new prefix avoids pg parsedStatements collision');
});

test('preparedClient bounds server-side plans at 256 and flushes cleanly on next idle checkout', async () => {
  const { client, calls } = fakePgClient();
  const wrapped = preparedClient(client);
  for (let i = 0; i < 260; i++) {
    const sql = `SELECT ${i} FROM items WHERE id = $1`;
    await wrapped.query(sql, [i]);
    await wrapped.query(sql, [i + 1]);
  }
  const stats = preparedClientStats(client);
  assert.equal(stats.prepared, 256);
  assert.equal(stats.needsReset, true);
  // No DEALLOCATE ALL was sent mid-checkout.
  assert.equal(
    calls.some((c) => c.text === 'DEALLOCATE ALL'),
    false,
  );

  await syncPreparedClient(client);
  assert.equal(calls.at(-1)!.text, 'DEALLOCATE ALL');
  assert.equal(preparedClientStats(client).prepared, 0);
  assert.equal(preparedClientStats(client).needsReset, false);
});

test('preparedClient invalidates globally on cached-plan error (0A000) and respects MISTRI_PG_PREPARED=off', async () => {
  assert.equal(preparedStatementsEnabled({}), true);
  assert.equal(preparedStatementsEnabled({ MISTRI_PG_PREPARED: 'off' }), false);
  assert.equal(preparedStatementsEnabled({ MISTRI_PG_PREPARED: '0' }), false);

  const a = fakePgClient();
  const b = fakePgClient();
  const wa = preparedClient(a.client);
  const wb = preparedClient(b.client);
  const sql = 'SELECT val FROM t WHERE id = $1';
  await wa.query(sql, [1]);
  await wa.query(sql, [2]);
  await wb.query(sql, [1]);
  await wb.query(sql, [2]);

  a.failNext(Object.assign(new Error('cached plan must not change result type'), { code: '0A000' }));
  await assert.rejects(() => wa.query(sql, [3]), /cached plan/);

  // Both client A and sibling client B flush on next idle sync.
  await syncPreparedClient(a.client);
  await syncPreparedClient(b.client);
  assert.equal(b.calls.at(-1)!.text, 'DEALLOCATE ALL');
});

const PG_URL = process.env.TABLEWALK_TEST_PG;
test(
  'live PostgreSQL: direct session pool prepares repeated queries, survives ALTER COLUMN TYPE DDL, and transaction pooler never prepares',
  { skip: !PG_URL },
  async () => {
    const direct = new PgConnectionManager(PG_URL!, undefined, undefined, { readers: 1, writers: 1, pooler: 'session' });
    const txPooled = new PgConnectionManager(PG_URL!, undefined, undefined, { readers: 1, writers: 1, pooler: 'transaction' });
    const table = `prep_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    try {
      await direct.withWriteClient(async (client) => {
        await client.query(`CREATE TABLE ${table} (id int PRIMARY KEY, val int NOT NULL)`);
        await client.query(`INSERT INTO ${table} (id, val) VALUES (1, 42)`);
      });

      const sql = `SELECT val FROM ${table} WHERE id = $1`;
      // Repeated reads on direct session pool should allocate a named prepared statement on pg_prepared_statements.
      let preparedCount = 0;
      await direct.withReadClient(async (client) => {
        await client.query(sql, [1]);
        await client.query(sql, [1]);
        const r = await client.query(sql, [1]);
        assert.equal(Number(r.rows[0]!.val), 42);
        const stmts = await client.query(`SELECT count(*)::int AS n FROM pg_prepared_statements WHERE name LIKE 'm%'`);
        preparedCount = Number(stmts.rows[0]!.n);
      });
      assert.ok(preparedCount >= 1, `expected at least 1 named prepared statement on direct pool, got ${preparedCount}`);

      // DDL altering column type + invalidation: next direct checkout flushes DEALLOCATE ALL and succeeds with new type.
      await direct.withWriteClient(async (client) => {
        await client.query(`ALTER TABLE ${table} ALTER COLUMN val TYPE text USING val::text`);
      });
      invalidatePreparedStatements();
      await direct.withReadClient(async (client) => {
        const r = await client.query(sql, [1]);
        assert.equal(r.rows[0]!.val, '42');
      });

      // Transaction-mode pooler must NEVER create named prepared statements.
      await txPooled.withReadClient(async (client) => {
        await client.query(sql, [1]);
        await client.query(sql, [1]);
        const stmts = await client.query(`SELECT count(*)::int AS n FROM pg_prepared_statements WHERE name LIKE 'm%'`);
        assert.equal(Number(stmts.rows[0]!.n), 0, 'transaction pooler must not allocate named prepared statements');
      });
    } finally {
      await direct
        .withWriteClient(async (client) => {
          await client.query(`DROP TABLE IF EXISTS ${table}`);
        })
        .catch(() => {});
      await direct.close();
      await txPooled.close();
    }
  },
);
