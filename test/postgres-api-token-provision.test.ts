import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import {
  POSTGRES_AUTH_PREFIX,
  assertPostgresAuthStore,
  migratePostgresAuthStore,
  withPostgresAuthModels,
} from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { describePostgresRelations } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import { postgresApiTokenDdl } from '../packages/mistri/src/adapters/auth/postgresApiTokenLayout.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { accountAuditPlugin } from '../packages/mistri/src/server/auth/accountAudit.js';
import { identityStorePlugin } from '../packages/mistri/src/server/auth/identityStore.js';
import { liveSkip } from './live.js';

const live = process.env.TABLEWALK_TEST_PG;
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'PostgreSQL API token storage could not be provisioned.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};

test(
  'explicit PG extension preserves the native layout, owns its full layout, and recovers idempotently',
  {
    skip: liveSkip('postgres', live),
  },
  async (t) => {
    const module = 'pg',
      { Client } = (await import(module)).default;
    const control = new Client({ connectionString: live });
    await control.connect();
    const owned = `tw_token_provision_${randomUUID().replaceAll('-', '')}`;
    let created = false,
      db: InstanceType<typeof Client> | undefined;
    try {
      await control.query(`CREATE DATABASE "${owned}"`);
      created = true;
      const url = new URL(live!);
      url.pathname = `/${owned}`;
      const connection = url.href,
        binding = { appId: 'app', storeId: randomUUID(), excludeConnections: [] };
      db = new Client({ connectionString: connection });
      await db.connect();
      const catalog = () => describePostgresRelations(db as PgQuery, POSTGRES_AUTH_PREFIX);
      await assert.rejects(provisionPostgresApiTokenStore(connection, binding), unavailable);
      assert.deepEqual(await catalog(), []);
      assert.equal((await migratePostgresAuthStore(connection)).migrated, true);
      const core = await catalog();
      /* The v3 layout: Better Auth's own tables, the store's meta and the deployment tables; the identity
         tables (the IdP session index, the SCIM directory) come with the same bring-up and are counted apart,
         as the SQLite twin counts them (sqlite-auth-store-layout.test.ts). */
      const identity = core.filter((table) => /^auth_(idp_session|scim_)/.test(table.name));
      assert.deepEqual([core.length - identity.length, identity.length], [6, 8]);

      await t.test('required captured exclusions and actual server separation precede token DDL', async () => {
        await assert.rejects(
          provisionPostgresApiTokenStore(connection, { appId: binding.appId, storeId: binding.storeId } as typeof binding),
          unavailable,
        );
        await assert.rejects(
          provisionPostgresApiTokenStore(connection, { ...binding, excludeConnections: [{ url: connection }] }),
          unavailable,
        );
        assert.deepEqual(await catalog(), core);
        const otherName = `tw_token_provision_excluded_${randomUUID().replaceAll('-', '')}`;
        await control.query(`CREATE DATABASE "${otherName}"`);
        try {
          const otherUrl = new URL(connection);
          otherUrl.pathname = `/${otherName}`;
          await migratePostgresAuthStore(otherUrl.href);
          // URL-only separation permits different database names; the live
          // schema-reachability check must refuse before creating token tables.
          await assert.rejects(
            provisionPostgresApiTokenStore(connection, { ...binding, excludeConnections: [{ url: otherUrl.href }] }),
            unavailable,
          );
          assert.deepEqual(await catalog(), core);
        } finally {
          await control.query(`DROP DATABASE "${otherName}"`);
        }
      });

      await t.test('concurrent matching provision serializes to one creation and one no-op', async () => {
        const results = await Promise.all([
          provisionPostgresApiTokenStore(connection, binding),
          provisionPostgresApiTokenStore(connection, binding),
        ]);
        assert.deepEqual(results.map((result) => result.migrated).sort(), [false, true]);
        assert.ok(results.every((result) => result.version === 1 && result.storeId === binding.storeId));
        assert.equal((await catalog()).length, core.length + 7);
        assert.deepEqual(
          (await catalog()).filter((table) => !table.name.startsWith('auth_api_token') && !table.name.startsWith('auth_oauth_')),
          core,
        );
        assert.deepEqual(await migratePostgresAuthStore(connection), { version: 1, migrated: false });
        await db!.query('BEGIN');
        try {
          await assertPostgresAuthStore(db as PgQuery);
        } finally {
          await db!.query('ROLLBACK');
        }
      });

      await t.test('wrong App/store binding does not repair existing metadata', async () => {
        const before = (await db!.query('SELECT * FROM mistri.auth_api_token_meta')).rows;
        for (const wrong of [
          { ...binding, appId: 'other' },
          { ...binding, storeId: randomUUID() },
        ])
          await assert.rejects(provisionPostgresApiTokenStore(connection, wrong), unavailable);
        assert.deepEqual((await db!.query('SELECT * FROM mistri.auth_api_token_meta')).rows, before);
        assert.equal((await provisionPostgresApiTokenStore(connection, binding)).migrated, false);
      });

      await t.test('extended layout remains a native Better Auth no-op and cookies survive restart', async () => {
        const { Pool } = (await import(module)).default;
        const pool = new Pool({ connectionString: connection, options: '-c search_path=mistri', max: 1 });
        const { admin } = await import('better-auth/plugins');
        const { getMigrations } = await import('better-auth/db/migration');
        const keys = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
        const environment = keys.map((key) => [key, process.env[key]] as const);
        let runtime: AppAuthRuntime | undefined;
        const server = createServer((req, res) => {
          if (!runtime) {
            res.writeHead(503);
            res.end();
            return;
          }
          void runtime.handler(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        });
        try {
          process.env.BETTER_AUTH_SECRET = 'synthetic-token-extension-secret-at-least-thirty-two-characters';
          delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
          delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const origin = `http://127.0.0.1:${address.port}`;
          const planned = await getMigrations(
            withPostgresAuthModels({
              database: pool,
              emailAndPassword: { enabled: true },
              plugins: [admin({ defaultRole: 'user' }), accountAuditPlugin(), identityStorePlugin()],
              secret: process.env.BETTER_AUTH_SECRET,
              baseURL: origin,
              telemetry: { enabled: false },
            }) as never,
          );
          assert.deepEqual([planned.toBeCreated, planned.toBeAdded], [[], []]);
          const loaded = {
            path: '/synthetic/app.ts',
            dir: '/synthetic',
            pages: [],
            sources: {},
            app: parseAppConfig(
              {
                id: 'app',
                name: 'Extension compatibility',
                auth: { store: connection, signUp: 'open' },
                resources: { item: {} },
                views: { items: { kind: 'list', from: 'item' } },
                home: 'items',
              },
              'fixture',
            ),
          };
          const start = () => createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
          const call = async (path: string, body: Record<string, unknown>) => {
            const response = await fetch(origin + path, {
              method: 'POST',
              signal: AbortSignal.timeout(5000),
              headers: { origin, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            const json = await response.json();
            assert.equal(response.status, 200);
            return {
              json,
              cookie: response.headers
                .getSetCookie()
                .map((value) => value.split(';')[0])
                .join('; '),
            };
          };
          runtime = await start();
          const signup = await call('/api/auth/sign-up/email', {
            name: 'Compatibility user',
            email: 'extension@example.test',
            password: 'synthetic-password-12345',
          });
          assert.ok(signup.cookie);
          const request = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
          const identity = await runtime.session(request(signup.cookie));
          assert.equal(identity?.id, signup.json.user.id);
          runtime.close();
          runtime = undefined;
          runtime = await start();
          assert.equal((await runtime.session(request(signup.cookie)))?.id, identity?.id);
          const signin = await call('/api/auth/sign-in/email', {
            email: 'extension@example.test',
            password: 'synthetic-password-12345',
          });
          assert.ok(signin.cookie);
          assert.equal((await runtime.session(request(signin.cookie)))?.id, identity?.id);
          assert.deepEqual((await db!.query('SELECT singleton,version FROM mistri.auth_meta')).rows, [{ singleton: 1, version: 1 }]);
          assert.equal((await db!.query('SELECT count(*)::int AS n FROM mistri.auth_api_token')).rows[0].n, 0);
          assert.equal((await provisionPostgresApiTokenStore(connection, binding)).migrated, false);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          runtime?.close();
          await pool.end();
          for (const [key, value] of environment) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      });

      await t.test('foreign column grants and extra indexes refuse unchanged', async () => {
        await db!.query('GRANT SELECT(digest) ON mistri.auth_api_token TO PUBLIC');
        try {
          await assert.rejects(provisionPostgresApiTokenStore(connection, binding), unavailable);
        } finally {
          await db!.query('REVOKE SELECT(digest) ON mistri.auth_api_token FROM PUBLIC');
        }
        await db!.query('CREATE INDEX private_extra ON mistri.auth_api_token(app_id)');
        try {
          await assert.rejects(provisionPostgresApiTokenStore(connection, binding), unavailable);
          assert.ok(
            (await catalog()).find((table) => table.name === 'auth_api_token')!.indexes.some((index) => index.includes('private_extra')),
          );
        } finally {
          await db!.query('DROP INDEX mistri.private_extra');
        }
      });

      // Only the UUID-owned disposable fixture's extension is removed here;
      // the native core remains intact for rollback and interrupted-reply tests.
      await db.query(
        'DROP TABLE mistri.auth_oauth_access, mistri.auth_oauth_refresh, mistri.auth_oauth_code, mistri.auth_oauth_grant, mistri.auth_oauth_client, mistri.auth_api_token, mistri.auth_api_token_meta',
      );
      await t.test('partial extension is refused, not completed', async () => {
        await db!.query(postgresApiTokenDdl()[0]);
        try {
          await assert.rejects(provisionPostgresApiTokenStore(connection, binding), unavailable);
          assert.equal((await catalog()).length, core.length + 1);
        } finally {
          await db!.query('DROP TABLE mistri.auth_api_token_meta');
        }
      });

      await t.test('injected failures roll back both extension tables and metadata', async () => {
        const original = Client.prototype.query;
        for (const point of [postgresApiTokenDdl()[1], 'COMMIT']) {
          const stub = t.mock.method(Client.prototype, 'query', function (this: unknown, ...args: unknown[]) {
            if (args[0] === point) return Promise.reject(new Error('PRIVATE_INJECTED_FAILURE'));
            return Reflect.apply(original, this, args);
          });
          try {
            await assert.rejects(provisionPostgresApiTokenStore(connection, binding), unavailable);
          } finally {
            stub.mock.restore();
          }
          assert.deepEqual(await catalog(), core);
        }
      });

      await t.test('lost successful commit reply is recovered as already provisioned', async () => {
        const original = Client.prototype.query;
        const stub = t.mock.method(Client.prototype, 'query', function (this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args);
          return args[0] === 'COMMIT'
            ? Promise.resolve(result).then(() => {
                throw new Error('PRIVATE_LOST_COMMIT_REPLY');
              })
            : result;
        });
        try {
          await assert.rejects(provisionPostgresApiTokenStore(connection, binding), unavailable);
        } finally {
          stub.mock.restore();
        }
        assert.equal((await provisionPostgresApiTokenStore(connection, binding)).migrated, false);
        assert.deepEqual(
          (await catalog()).filter((table) => !table.name.startsWith('auth_api_token') && !table.name.startsWith('auth_oauth_')),
          core,
        );
      });
    } finally {
      t.mock.restoreAll();
      await db?.end();
      if (created) await control.query(`DROP DATABASE "${owned}"`);
      await control.end();
    }
  },
);
