import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PgClient, PgPool, PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import {
  issuePostgresApiCommandToken,
  issuePostgresApiToken,
  revokePostgresApiToken,
} from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import {
  acquirePostgresApiCommandTokenObservation,
  acquirePostgresApiTokenObservation,
  captureAppAuthRuntime,
  createAppAuth,
  type AppAuthRuntime,
} from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const unavailable = { message: 'Native token observation is unavailable.' };
/* A store that cannot be reached, begun or committed is not a judgement about
   the credential: the owners answer it as 503, so it is its own error. */
const storeDown = { message: 'The API token store could not be read.' };
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

test(
  'genuine PostgreSQL token capabilities own transactions and drain retirement without granting authority',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client; Pool: { prototype: PgPool } } };
    const control = new pg.default.Client({ connectionString: LIVE }),
      name = `tw_token_binding_${randomUUID().replaceAll('-', '')}`;
    const directory = mkdtempSync(join(tmpdir(), 'tw-pg-token-binding-')),
      runtimes: AppAuthRuntime[] = [];
    let owned = false,
      db: Client | undefined;
    try {
      await control.connect();
      await control.query(`CREATE DATABASE "${name}"`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      await migratePostgresAuthStore(url.href);
      db = new pg.default.Client({ connectionString: url.href });
      await db.connect();
      await db.query(`INSERT INTO mistri.auth_user (id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
        VALUES ('account','Account','account@example.test',true,now(),now(),'reader',false)`);
      const app = parseTestApp(
        {
          id: 'app',
          name: 'App',
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
          auth: { store: url.href, roles: { reader: { read: true } } },
          api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
        },
        'fixture',
      );
      const open = async () => {
        const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
        const saved = names.map((name) => [name, process.env[name]] as const);
        process.env.BETTER_AUTH_SECRET = 'synthetic-native-pg-binding-secret-at-least-thirty-two-characters';
        delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
        delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
        try {
          const runtime = await createAppAuth(
            { app, path: join(directory, 'app.json'), dir: directory, pages: [], sources: {} },
            { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] },
          );
          runtimes.push(runtime);
          return runtime;
        } finally {
          for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      };
      const runtime = await open(),
        storeId = randomUUID();
      await t.test('core-only ordinary native auth works; explicit capability refuses without DDL', async () => {
        await assert.rejects(acquirePostgresApiTokenObservation(runtime, app, schema), unavailable);
        assert.ok(await captureAppAuthRuntime(runtime).lookupEligibleAccountRolesCurrent('account'));
        assert.equal((await db!.query("SELECT to_regclass('mistri.auth_api_token') AS table")).rows[0].table, null);
      });
      await provisionPostgresApiTokenStore(url.href, { appId: app.id, storeId, excludeConnections: [] });
      const issued = await issuePostgresApiToken(
        url.href,
        app,
        schema,
        {
          storeId,
          excludeConnections: [],
          subjectId: 'account',
          actorId: 'account',
          roles: ['reader'],
          label: 'Binding',
          expiresAt: Date.now() + 120000,
        },
        Date.now,
      );
      await t.test('command-capable acquisition observes command scope on the same genuine runtime and lifecycle', async () => {
        const commandApp = parseTestApp(
          {
            id: 'app',
            name: 'App',
            sources: { business: { connection: 'business', default: true } },
            resources: { item: { access: 'write' } },
            views: { items: { kind: 'list', from: 'item' } },
            home: 'items',
            auth: { store: url.href, roles: { reader: { read: true, commands: ['bump'] } } },
          },
          'command fixture',
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
        const evidence = { connectionFor: () => 'business', writableConnection: () => true, transactionalConnection: () => true };
        // The read acquisition still refuses a command-exposing App.
        await assert.rejects(acquirePostgresApiTokenObservation(runtime, commandApp, commandSchema), unavailable);
        const capability = await acquirePostgresApiCommandTokenObservation(runtime, commandApp, commandSchema, registry, evidence);
        try {
          const handle = await capability.observe(issued.token);
          assert.ok(capability.inspect(handle).operations.includes('command:bump'));
          let sent = 0;
          assert.deepEqual(
            await capability.handoff(issued.token, handle, () => {
              sent++;
            }),
            { stage: 'token-handoff', outcome: 'complete' },
          );
          assert.equal(sent, 1);
          await assert.rejects(capability.observe('not-a-token'), unavailable);
          // Command issuance checks operations against the combined catalog;
          // read issuance and malformed evidence refuse before any insert.
          const maintenance = { message: 'PostgreSQL API token maintenance is unavailable.' };
          const options = {
            storeId,
            excludeConnections: [],
            subjectId: 'account',
            actorId: 'account',
            roles: ['reader'],
            label: 'Command',
            expiresAt: Date.now() + 120000,
          };
          const scoped = await issuePostgresApiCommandToken(
            url.href,
            commandApp,
            commandSchema,
            registry,
            evidence,
            { ...options, operations: ['command:bump'] },
            Date.now,
          );
          assert.deepEqual(capability.inspect(await capability.observe(scoped.token)).operations, ['command:bump']);
          const broad = await issuePostgresApiCommandToken(url.href, commandApp, commandSchema, registry, evidence, options, Date.now);
          assert.deepEqual(capability.inspect(await capability.observe(broad.token)).operations, capability.inspect(handle).operations);
          await assert.rejects(
            issuePostgresApiToken(url.href, app, schema, { ...options, operations: ['command:bump'] }, Date.now),
            maintenance,
          );
          await assert.rejects(
            issuePostgresApiCommandToken(
              url.href,
              commandApp,
              commandSchema,
              registry,
              { ...evidence, transactionalConnection: () => false },
              options,
              Date.now,
            ),
            maintenance,
          );
          await assert.rejects(
            issuePostgresApiCommandToken(
              url.href,
              commandApp,
              commandSchema,
              registry,
              evidence,
              { ...options, operations: ['command:missing'] },
              Date.now,
            ),
            maintenance,
          );
          assert.equal((await db!.query('SELECT count(*)::int AS n FROM mistri.auth_api_token')).rows[0].n, 3);
        } finally {
          await capability.retire();
        }
        await assert.rejects(capability.observe(issued.token), unavailable);
      });
      await t.test('opaque handles are capability-local and retire independently of native auth', async () => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const foreign = await acquirePostgresApiTokenObservation(await open(), app, schema);
        const handle = await capability.observe(issued.token);
        assert.deepEqual(Object.keys(handle), []);
        assert.ok(Object.isFrozen(handle));
        assert.equal(capability.inspect(handle).authorization, 'pending');
        assert.throws(() => capability.inspect({ ...handle }), unavailable);
        assert.throws(() => foreign.inspect(handle), unavailable);
        await capability.retire();
        await capability.retire();
        assert.throws(() => capability.inspect(handle), unavailable);
        await assert.rejects(capability.observe(issued.token), unavailable);
        assert.ok(await captureAppAuthRuntime(runtime).lookupEligibleAccountRolesCurrent('account'));
        await foreign.retire();
      });
      await t.test('copies and malformed catalog getters refuse before acquisition; runtime closure invalidates handles', async () => {
        let getters = 0;
        const malformed = { ...app };
        Object.defineProperty(malformed, 'id', {
          enumerable: true,
          get() {
            getters++;
            return app.id;
          },
        });
        await assert.rejects(acquirePostgresApiTokenObservation(runtime, malformed, schema), unavailable);
        await assert.rejects(acquirePostgresApiTokenObservation({ ...runtime }, app, schema), unavailable);
        await assert.rejects(acquirePostgresApiTokenObservation(runtime, app, new Proxy(schema, {})), unavailable);
        assert.equal(getters, 0);
        const separate = await open(),
          capability = await acquirePostgresApiTokenObservation(separate, app, schema);
        const handle = await capability.observe(issued.token);
        separate.close();
        assert.throws(() => capability.inspect(handle), unavailable);
        await assert.rejects(capability.observe(issued.token), unavailable);
        await capability.retire();
      });
      await t.test('retirement while pool connect waits drains and releases lease without BEGIN', async (sub) => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const prototype = pg.default.Pool.prototype,
          connect = prototype.connect;
        let resume!: () => void,
          entered!: () => void,
          released = 0,
          began = 0;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const spy = sub.mock.method(prototype, 'connect', async function (this: PgPool) {
          const client = await connect.call(this),
            query = client.query,
            release = client.release;
          client.query = ((...args: Parameters<PgClient['query']>) => {
            if (String(args[0]) === 'BEGIN') began++;
            return Reflect.apply(query, client, args);
          }) as PgClient['query'];
          client.release = (destroy) => {
            released++;
            client.query = query;
            client.release = release;
            release.call(client, destroy);
          };
          entered();
          await hold;
          return client;
        });
        const observing = capability.observe(issued.token);
        void observing.catch(() => {});
        await waiting;
        let retired = false;
        const retiring = capability.retire().then(() => {
          retired = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(retired, false);
        resume();
        await assert.rejects(observing, unavailable);
        await retiring;
        spy.mock.restore();
        assert.equal(began, 0);
        assert.equal(released, 1);
      });
      await t.test('failed commit/rollback destroys client and never releases observation handle', async (sub) => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const handle = await capability.observe(issued.token);
        const prototype = pg.default.Pool.prototype,
          connect = prototype.connect;
        const releases: Array<boolean | Error | undefined> = [];
        const spy = sub.mock.method(prototype, 'connect', async function (this: PgPool) {
          const client = await connect.call(this),
            query = client.query,
            release = client.release;
          client.query = ((sql: unknown, values?: unknown[]) => {
            if (sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.reject(Error('private driver error'));
            return Reflect.apply(query, client, [sql, values]);
          }) as PgClient['query'];
          client.release = (destroy) => {
            releases.push(destroy);
            client.query = query;
            client.release = release;
            release.call(client, destroy);
          };
          return client;
        });
        // The commit fails, so nothing was decided about this token: the store
        // could not answer, which is what the API reports as 503.
        await assert.rejects(capability.observe(issued.token), storeDown);
        let calls = 0;
        assert.deepEqual(
          await capability.handoff(issued.token, handle, () => {
            calls++;
          }),
          { stage: 'token-handoff', outcome: 'uncertain' },
        );
        assert.equal(calls, 1);
        await assert.rejects(
          capability.handoff(issued.token, handle, () => {
            calls++;
          }),
          unavailable,
        );
        await capability.retire();
        spy.mock.restore();
        assert.deepEqual(releases, [true, true]);
      });
      await t.test('runtime closes during acquisition: late native lease is released without BEGIN', async (sub) => {
        const separate = await open(),
          prototype = pg.default.Pool.prototype,
          connect = prototype.connect;
        let released = 0,
          began = 0;
        const spy = sub.mock.method(prototype, 'connect', async function (this: PgPool) {
          const client = await connect.call(this),
            query = client.query,
            release = client.release;
          client.query = ((sql: unknown, values?: unknown[]) => {
            if (sql === 'BEGIN') began++;
            return Reflect.apply(query, client, [sql, values]);
          }) as PgClient['query'];
          client.release = (destroy) => {
            released++;
            client.query = query;
            client.release = release;
            release.call(client, destroy);
          };
          separate.close();
          return client;
        });
        await assert.rejects(acquirePostgresApiTokenObservation(separate, app, schema), unavailable);
        spy.mock.restore();
        assert.equal(released, 1);
        assert.equal(began, 0);
      });
      await t.test('handoff rejects foreign/async callbacks and consumes each expected handle once', async () => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const handle = await capability.observe(issued.token);
        let calls = 0;
        await assert.rejects(
          capability.handoff(issued.token, { ...handle }, () => {
            calls++;
          }),
          unavailable,
        );
        await assert.rejects(
          capability.handoff(issued.token, handle, async () => {
            calls++;
          }),
          unavailable,
        );
        const first = capability.handoff(issued.token, handle, () => {
          calls++;
        });
        await assert.rejects(
          capability.handoff(issued.token, handle, () => {
            calls++;
          }),
          unavailable,
        );
        assert.deepEqual(await first, { stage: 'token-handoff', outcome: 'complete' });
        assert.equal(calls, 1);
        assert.equal(capability.inspect(handle).version, '1'); // inspection semantics remain unchanged
        await capability.retire();
      });
      await t.test('handoff retains actual account and token locks until post-send commit', async (sub) => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const handle = await capability.observe(issued.token);
        const prototype = pg.default.Pool.prototype,
          connect = prototype.connect;
        let unblock!: () => void,
          committing!: () => void,
          calls = 0;
        const blocked = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const reached = new Promise<void>((resolve) => {
          committing = resolve;
        });
        const spy = sub.mock.method(prototype, 'connect', async function (this: PgPool) {
          const client = await connect.call(this),
            query = client.query,
            release = client.release;
          client.query = ((sql: unknown, values?: unknown[]) => {
            if (sql === 'COMMIT') {
              committing();
              return blocked.then(() => Reflect.apply(query, client, [sql, values]));
            }
            return Reflect.apply(query, client, [sql, values]);
          }) as PgClient['query'];
          client.release = (destroy) => {
            client.query = query;
            client.release = release;
            release.call(client, destroy);
          };
          return client;
        });
        const handoff = capability.handoff(issued.token, handle, () => {
          calls++;
        });
        try {
          await reached;
          assert.equal(calls, 1);
          for (const sql of [
            `UPDATE mistri.auth_user SET role=role WHERE id='account'`,
            `UPDATE mistri.auth_api_token SET label=label WHERE token_id='${issued.tokenId}'`,
          ]) {
            await db!.query('BEGIN');
            try {
              await db!.query("SET LOCAL lock_timeout='100ms'");
              await assert.rejects(db!.query(sql), { code: '55P03' });
            } finally {
              await db!.query('ROLLBACK');
            }
          }
        } finally {
          unblock();
        }
        assert.equal((await handoff).outcome, 'complete');
        spy.mock.restore();
        await capability.retire();
      });
      await t.test('expired and foreign observations never send; reentrant retirement is uncertain and drained', async (sub) => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const foreign = await acquirePostgresApiTokenObservation(runtime, app, schema);
        const handle = await capability.observe(issued.token);
        let calls = 0;
        await assert.rejects(
          foreign.handoff(issued.token, handle, () => {
            calls++;
          }),
          unavailable,
        );
        const expired = sub.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
        await assert.rejects(
          capability.handoff(issued.token, handle, () => {
            calls++;
          }),
          unavailable,
        );
        expired.mock.restore();
        assert.equal(calls, 0);
        let retiring: Promise<void> | undefined;
        assert.equal(
          (
            await capability.handoff(issued.token, handle, () => {
              calls++;
              retiring = capability.retire();
            })
          ).outcome,
          'uncertain',
        );
        await retiring;
        assert.equal(calls, 1);
        await foreign.retire();
      });
      await t.test('callback failure and invalid thenable return are uncertain, with no retries or getter invocation', async () => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema);
        let calls = 0,
          getters = 0;
        for (const send of [
          () => {
            calls++;
            throw Error('private send failure');
          },
          // Deliberately hostile thenable: handoff must not invoke its getter.
          () => {
            calls++;
            // oxlint-disable-next-line unicorn/no-thenable
            return Object.defineProperty({}, 'then', {
              get() {
                getters++;
                throw Error('private getter');
              },
            });
          },
        ]) {
          const handle = await capability.observe(issued.token);
          assert.deepEqual(await capability.handoff(issued.token, handle, send), { stage: 'token-handoff', outcome: 'uncertain' });
          await assert.rejects(capability.handoff(issued.token, handle, send), unavailable);
        }
        assert.equal(calls, 2);
        assert.equal(getters, 0);
        await capability.retire();
      });
      await t.test('inspection is explicitly nonfresh; new observation detects revocation', async () => {
        const capability = await acquirePostgresApiTokenObservation(runtime, app, schema),
          handle = await capability.observe(issued.token);
        await revokePostgresApiToken(
          url.href,
          { appId: app.id, storeId, excludeConnections: [], tokenId: issued.tokenId, expectedVersion: '1', actorId: 'account' },
          Date.now,
        );
        assert.equal(capability.inspect(handle).version, '1');
        let sent = false;
        await assert.rejects(
          capability.handoff(issued.token, handle, () => {
            sent = true;
          }),
          unavailable,
        );
        assert.equal(sent, false);
        await assert.rejects(capability.observe(issued.token), unavailable);
        await capability.retire();
      });
    } finally {
      for (const runtime of runtimes) runtime.close();
      await db?.end();
      if (owned) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
