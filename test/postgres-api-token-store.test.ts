/** Unique-owned native fixture; no supplied database tables are reset. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { createPostgresApiTokenStore } from '../packages/mistri/src/server/auth/postgresApiTokenStore.js';
import { captureStoredApiToken } from '../packages/mistri/src/server/api/apiTokenStorageContract.js';
import { liveSkip } from './live.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'PostgreSQL API token storage is unavailable.');
  return true;
};
const token = () => ({
  format: 'twa1',
  digest: 'ab'.repeat(32),
  version: '9007199254740993',
  record: {
    id: randomUUID(),
    appId: 'app',
    subject: { kind: 'account', id: 'account' },
    label: 'Automation',
    roles: ['reader'],
    createdAt: 100,
    createdBy: 'operator',
    expiresAt: 8640000000000000,
  },
});
async function transaction<T>(db: PgQuery, work: (operations: TransactionOperations) => Promise<T>) {
  await db.query('BEGIN');
  const operations = new TransactionOperations();
  try {
    const result = await work(operations);
    await operations.finish();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await operations.finish().catch(() => {});
    await db.query('ROLLBACK');
    throw error;
  }
}
test(
  'PG token rows retain exact identity and owner-held transaction fences',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const name = `tw_token_rows_${randomUUID().replaceAll('-', '')}`;
    let owned = false,
      db: Client | undefined;
    try {
      try {
        await control.connect();
      } catch {
        throw new Error('Token fixture control connection failed');
      }
      await control.query(`CREATE DATABASE "${name}"`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      db = new pg.default.Client({ connectionString: url.href, statement_timeout: 10000 });
      try {
        await db.connect();
      } catch {
        throw new Error('Token fixture connection failed');
      }
      const c = db,
        binding = { appId: 'app', storeId: randomUUID() };
      assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name, name);
      await migratePostgresAuthStore(url.href);
      await t.test('core-only and autocommit do not imply token storage; factory is inert', async () => {
        let calls = 0;
        const operations = new TransactionOperations();
        const store = createPostgresApiTokenStore(c, operations, binding, () => {
          calls++;
        });
        assert.equal(calls, 0);
        await assert.rejects(store.lookup(randomUUID()), unavailable);
        await operations.finish().catch(() => {});
        await assert.rejects(
          transaction(c, (ops) => createPostgresApiTokenStore(c, ops, binding, () => {}).lookup(randomUUID())),
          unavailable,
        );
      });
      await provisionPostgresApiTokenStore(url.href, { ...binding, excludeConnections: [] });
      await t.test('Unicode native IDs and maximum times roundtrip; large revision revoke is terminal', async () => {
        for (const nativeId of ['雪'.repeat(1024), '😀'.repeat(512)]) {
          const input = token();
          input.record.subject.id = nativeId;
          input.record.createdBy = nativeId;
          await transaction(c, async (ops) => {
            const store = createPostgresApiTokenStore(c, ops, binding, () => {});
            await store.insert(input);
            assert.deepEqual(await store.lookup(input.record.id), captureStoredApiToken(input));
            await store.revoke({
              tokenId: input.record.id,
              appId: 'app',
              expectedVersion: input.version,
              revokedAt: 200,
              revokedBy: nativeId,
            });
            const revoked = await store.lookup(input.record.id);
            assert.equal(revoked?.version, '9007199254740994');
            assert.equal(revoked?.record.revokedBy, nativeId);
          });
          await assert.rejects(
            transaction(c, (ops) =>
              createPostgresApiTokenStore(c, ops, binding, () => {}).revoke({
                tokenId: input.record.id,
                appId: 'app',
                expectedVersion: '9007199254740994',
                revokedAt: 201,
                revokedBy: nativeId,
              }),
            ),
            unavailable,
          );
        }
      });
      await t.test('wrong binding, foreign table/column grants and drift refuse', async () => {
        await assert.rejects(
          transaction(c, (ops) => createPostgresApiTokenStore(c, ops, { ...binding, appId: 'other' }, () => {}).lookup(randomUUID())),
          unavailable,
        );
        for (const privilege of ['SELECT', 'SELECT (digest)']) {
          await c.query(`GRANT ${privilege} ON mistri.auth_api_token TO PUBLIC`);
          try {
            await assert.rejects(
              transaction(c, (ops) => createPostgresApiTokenStore(c, ops, binding, () => {}).lookup(randomUUID())),
              unavailable,
            );
          } finally {
            await c.query(`REVOKE ${privilege} ON mistri.auth_api_token FROM PUBLIC`);
          }
        }
        await c.query('ALTER TABLE mistri.auth_api_token ADD COLUMN foreign_column text');
        try {
          await assert.rejects(
            transaction(c, (ops) => createPostgresApiTokenStore(c, ops, binding, () => {}).lookup(randomUUID())),
            unavailable,
          );
        } finally {
          await c.query('ALTER TABLE mistri.auth_api_token DROP COLUMN foreign_column');
        }
      });
      await t.test('retirement after individual attestor await or INSERT stops work and owner rolls back', async () => {
        for (const boundary of ['SAVEPOINT', 'INSERT INTO']) {
          const input = token();
          let retired = false,
            calls = 0;
          function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
          function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
          async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
            calls++;
            const result = typeof sql === 'string' ? await c.query(sql, values) : await c.query(sql);
            if ((typeof sql === 'string' ? sql : sql.text).startsWith(boundary)) retired = true;
            return result;
          }
          await assert.rejects(
            transaction(c, (ops) =>
              createPostgresApiTokenStore({ query }, ops, binding, () => {
                if (retired) throw new Error('retired');
              }).insert(input),
            ),
            unavailable,
          );
          if (boundary === 'SAVEPOINT') assert.equal(calls, 1, 'no subsequent attestor query after retirement');
          await transaction(c, async (ops) =>
            assert.equal(await createPostgresApiTokenStore(c, ops, binding, () => {}).lookup(input.record.id), null),
          );
        }
      });
      await t.test('queued work captures input before callbacks and cannot run after drain', async () => {
        const input = token(),
          expected = captureStoredApiToken(input);
        let escaped: ReturnType<typeof createPostgresApiTokenStore> | undefined;
        await transaction(c, async (ops) => {
          const store = createPostgresApiTokenStore(c, ops, binding, () => {});
          escaped = store;
          const inserting = store.insert(input);
          input.record.subject.id = 'changed';
          await inserting;
          assert.deepEqual(await store.lookup(expected.record.id), expected);
        });
        await assert.rejects(escaped!.lookup(expected.record.id), unavailable);
      });
    } finally {
      try {
        await db?.end();
      } finally {
        try {
          if (owned) await control.query(`DROP DATABASE "${name}"`);
        } finally {
          await control.end();
        }
      }
    }
  },
);
