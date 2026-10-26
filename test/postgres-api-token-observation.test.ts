import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { issuePostgresApiToken } from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { observePostgresAccountToken } from '../packages/mistri/src/server/auth/postgresApiTokenObservation.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { captureApiTokenCommandContext } from '../packages/mistri/src/server/auth/apiTokenCommandContext.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'PostgreSQL API token observation is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
const app = parseTestApp(
  {
    id: 'app',
    name: 'App',
    resources: { item: {} },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { roles: { reader: { read: true } } },
    api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
  },
  'PG observation fixture',
);
const schema: DatabaseSchema = {
  label: 'PG',
  dialect: 'postgres',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }],
    },
  ],
};
async function transaction<T>(client: PgQuery, run: (ops: TransactionOperations) => Promise<T>) {
  await client.query('BEGIN');
  const ops = new TransactionOperations();
  try {
    const result = await run(ops);
    await ops.finish();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await ops.finish().catch(() => {});
    await client.query('ROLLBACK');
    throw error;
  }
}
test(
  'borrowed PG observation locks current facts without granting authority',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const module = 'pg',
      pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const name = `tw_token_observe_${randomUUID().replaceAll('-', '')}`;
    let owned = false,
      db: Client | undefined,
      observer: Client | undefined;
    try {
      try {
        await control.connect();
      } catch {
        throw new Error('Observation fixture control connection failed');
      }
      await control.query(`CREATE DATABASE "${name}"`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      db = new pg.default.Client({ connectionString: url.href, statement_timeout: 3000 });
      observer = new pg.default.Client({ connectionString: url.href, statement_timeout: 3000 });
      try {
        await db.connect();
        await observer.connect();
      } catch {
        throw new Error('Observation fixture connection failed');
      }
      const c = db,
        d = observer,
        storeId = randomUUID();
      assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name, name);
      await migratePostgresAuthStore(url.href);
      await provisionPostgresApiTokenStore(url.href, { appId: 'app', storeId, excludeConnections: [] });
      for (const id of ['subject', 'other'])
        await c.query(
          `INSERT INTO mistri.auth_user
      (id,name,email,"emailVerified","createdAt","updatedAt",role,banned) VALUES ($1,$1,$2,true,now(),now(),'reader',false)`,
          [id, id + '@example.test'],
        );
      const options = {
        storeId,
        excludeConnections: [],
        subjectId: 'subject',
        actorId: 'subject',
        roles: ['reader'],
        label: 'Observe',
        expiresAt: 2000,
      };
      const first = await issuePostgresApiToken(url.href, app, schema, options, () => 1000);
      const second = await issuePostgresApiToken(url.href, app, schema, { ...options, operations: [] }, () => 1000);
      const input = { app, schema, storeId, assertCurrent: () => {} };
      const observe = (credential: unknown = first.token, clock = () => 1500) =>
        transaction(d, (ops) => observePostgresAccountToken(d, ops, input, credential, clock));
      // Before any subtest revokes or bans: these reuse the two issued tokens.
      await t.test('a command catalog widens eligible scope as on SQLite; read-only callers are unchanged', async () => {
        const commandApp = parseTestApp(
          {
            id: 'app',
            name: 'App',
            sources: { business: { connection: 'business', default: true } },
            resources: { item: { access: 'write' } },
            views: { items: { kind: 'list', from: 'item' } },
            home: 'items',
            auth: { roles: { reader: { read: true, commands: ['bump'] } } },
          },
          'PG command observation fixture',
        );
        // Attached in code: active App files cannot declare command exposure yet.
        commandApp.api = parseTestApi(
          {
            version: 1,
            roles: ['reader'],
            resources: { item: { fields: ['id'] } },
            commands: [{ id: 'bump', version: 1, target: 'item', input: {} }],
          },
          ['reader'],
        )!;
        const commandSchema: DatabaseSchema = {
          ...schema,
          tables: [
            {
              ...schema.tables[0],
              columns: [...schema.tables[0].columns, { name: 'revision', type: 'integer', primaryKey: false, nullable: false }],
            },
          ],
        };
        const registry = defineCommands({
          bump: defineCommand({
            source: 'business',
            target: 'item',
            input: {},
            output: shape({ ok: bool() }),
            handle() {
              return { ok: true };
            },
          }),
        });
        const context = captureApiTokenCommandContext(commandApp, commandSchema, registry, {
          connectionFor: () => 'business',
          writableConnection: () => true,
          transactionalConnection: () => true,
        });
        const commandInput = { app: context.app, schema: context.schema, storeId, assertCurrent: () => {} };
        const withCommands = (credential: unknown) =>
          transaction(d, (ops) => observePostgresAccountToken(d, ops, commandInput, credential, () => 1500, context.catalog));
        const widened = await withCommands(first.token);
        assert.ok(widened.operations.includes('command:bump'), JSON.stringify(widened.operations));
        assert.deepEqual((await withCommands(second.token)).operations, []);
        // Without the catalog a command-exposing App still refuses, and the
        // read-only App still sees no command operation.
        await assert.rejects(
          transaction(d, (ops) => observePostgresAccountToken(d, ops, commandInput, first.token, () => 1500)),
          unavailable,
        );
        assert.ok(!(await observe()).operations.some((id) => id.startsWith('command:')));
      });
      await t.test('credential verified, narrowed immutable facts only, no autocommit or stale owner', async () => {
        const result = await observe(),
          empty = await observe(second.token);
        assert.equal(result.stage, 'token-observation');
        assert.equal(result.authorization, 'pending');
        assert.deepEqual(result.roles, ['reader']);
        assert.ok(result.operations.length > 0);
        assert.deepEqual(empty.operations, []);
        assert.deepEqual(result.subject, empty.subject);
        assert.notEqual(result.tokenId, empty.tokenId);
        assert.ok(Object.isFrozen(result) && Object.isFrozen(result.roles));
        assert.equal(Object.hasOwn(result, 'digest'), false);
        assert.ok(!JSON.stringify(result).includes(first.token));
        for (const token of ['bad', first.token.slice(0, 42) + (first.token[42] === 'A' ? 'B' : 'A') + first.token.slice(43)])
          await assert.rejects(observe(token), unavailable);
        const noTx = new TransactionOperations();
        await assert.rejects(
          observePostgresAccountToken(d, noTx, input, first.token, () => 1500),
          unavailable,
        );
        await noTx.finish().catch(() => {});
        await assert.rejects(
          transaction(d, (ops) => observePostgresAccountToken(d, ops, { ...input, storeId: randomUUID() }, first.token, () => 1500)),
          unavailable,
        );
      });
      await t.test('native demotion, ban and token revocation each refuse on the next observation', async () => {
        for (const [change, restore] of [
          ["UPDATE mistri.auth_user SET role=NULL WHERE id='subject'", "UPDATE mistri.auth_user SET role='reader' WHERE id='subject'"],
          ["UPDATE mistri.auth_user SET banned=true WHERE id='subject'", "UPDATE mistri.auth_user SET banned=false WHERE id='subject'"],
          [
            "UPDATE mistri.auth_api_token SET revoked_at=1400,revoked_by='subject'",
            'UPDATE mistri.auth_api_token SET revoked_at=NULL,revoked_by=NULL',
          ],
        ]) {
          await c.query(change);
          try {
            await assert.rejects(observe(), unavailable);
          } finally {
            await c.query(restore);
          }
        }
      });
      await t.test('final clock rejects expired, backwards and asynchronous observations', async () => {
        for (const clock of [
          () => 2000,
          () => 999,
          (() => {
            let calls = 0;
            return () => (++calls === 1 ? 1500 : 1499);
          })(),
          (() => {
            let calls = 0;
            return () => (++calls === 1 ? 1500 : 2000);
          })(),
          (() => Promise.resolve(1500)) as unknown as () => number,
        ])
          await assert.rejects(observe(first.token, clock), unavailable);
      });
      await t.test('subject changed after discovery and post-await retirement cannot publish', async () => {
        for (const kind of ['subject', 'retire'] as const) {
          let retired = false,
            injected = false;
          function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
          function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
          async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
            const text = typeof sql === 'string' ? sql : sql.text;
            if (!injected && text.startsWith('SELECT id FROM')) {
              injected = true;
              if (kind === 'subject')
                await c.query("UPDATE mistri.auth_api_token SET subject_id='other' WHERE token_id=$1", [first.tokenId]);
            }
            const result = typeof sql === 'string' ? await d.query(sql, values) : await d.query(sql);
            if (kind === 'retire' && injected) retired = true;
            return result;
          }
          try {
            await assert.rejects(
              transaction(d, (ops) =>
                observePostgresAccountToken(
                  { query },
                  ops,
                  {
                    ...input,
                    assertCurrent: () => {
                      if (retired) throw new Error('retired');
                    },
                  },
                  first.token,
                  () => 1500,
                ),
              ),
              unavailable,
            );
            assert.ok(injected);
          } finally {
            await c.query("UPDATE mistri.auth_api_token SET subject_id='subject' WHERE token_id=$1", [first.tokenId]);
          }
        }
      });
      await t.test('account-before-token ordering lets actor-equals-subject revoker finish without deadlock', async () => {
        await c.query('BEGIN');
        await c.query(`SELECT id FROM mistri.auth_user WHERE id='subject' FOR UPDATE`);
        const pending = observe();
        void pending.catch(() => {});
        try {
          let blocked = false;
          for (let n = 0; n < 100 && !blocked; n++) {
            blocked =
              (
                await control.query(
                  `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
            AND query LIKE 'SELECT id FROM%FOR SHARE'`,
                  [name],
                )
              ).rows.length > 0;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(blocked, 'observation waits on account without holding token SHARE');
          await c.query("UPDATE mistri.auth_api_token SET revoked_at=1400,revoked_by='subject' WHERE token_id=$1", [first.tokenId]);
          await c.query('COMMIT');
          await assert.rejects(pending, unavailable);
        } finally {
          await c.query('ROLLBACK');
          await pending.catch(() => {});
          await c.query('UPDATE mistri.auth_api_token SET revoked_at=NULL,revoked_by=NULL WHERE token_id=$1', [first.tokenId]);
        }
      });
      await t.test('successful observation retains row locks until its caller ends the transaction', async () => {
        await d.query('BEGIN');
        const ops = new TransactionOperations();
        await observePostgresAccountToken(d, ops, input, first.token, () => 1500);
        await ops.finish();
        let updated = false;
        const pending = c.query("UPDATE mistri.auth_user SET banned=true WHERE id='subject'").then(() => {
          updated = true;
        });
        try {
          let blocked = false;
          for (let n = 0; n < 100 && !blocked; n++) {
            blocked =
              (
                await control.query(
                  `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
            AND query LIKE 'UPDATE%SET banned=true%'`,
                  [name],
                )
              ).rows.length > 0;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(blocked);
          assert.equal(updated, false);
          await d.query('ROLLBACK');
          await pending;
          assert.equal(updated, true);
        } finally {
          await d.query('ROLLBACK');
          await pending.catch(() => {});
          await c.query("UPDATE mistri.auth_user SET banned=false WHERE id='subject'");
        }
      });
    } finally {
      try {
        await observer?.end();
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
