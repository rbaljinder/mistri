/** Native tests create/drop only their own random UUID-named database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import {
  issuePostgresApiToken,
  revokePostgresApiToken,
  inspectPostgresApiToken,
} from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { matchesApiTokenSecret } from '../packages/mistri/src/server/api/apiTokenSecret.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';
import { assertPostgresAuthStoreServerSeparation } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'PostgreSQL API token maintenance is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
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
const app = parseAppConfig(
  {
    id: 'app',
    name: 'App',
    resources: { item: {} },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { roles: { reader: { read: true }, dormant: { read: false } } },
    api: { version: 1, roles: ['reader', 'dormant'], resources: { item: { fields: ['id'] } } },
  },
  'PG token maintenance fixture',
);
test(
  'private PG maintenance holds native account facts through secret handoff',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const name = `tw_token_issue_${randomUUID().replaceAll('-', '')}`,
      writerName = randomUUID();
    let owned = false,
      db: Client | undefined;
    try {
      try {
        await control.connect();
      } catch {
        throw new Error('Maintenance fixture control connection failed');
      }
      await control.query(`CREATE DATABASE "${name}"`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      db = new pg.default.Client({ connectionString: url.href, statement_timeout: 10000, application_name: writerName });
      try {
        await db.connect();
      } catch {
        throw new Error('Maintenance fixture connection failed');
      }
      const c = db,
        binding = { appId: 'app', storeId: randomUUID() };
      assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name, name);
      await migratePostgresAuthStore(url.href);
      const options = {
        storeId: binding.storeId,
        excludeConnections: [],
        subjectId: 'subject',
        actorId: 'actor',
        roles: ['reader'],
        label: 'Automation',
        expiresAt: 2000,
      };
      const issue = (clock = () => 1000) => issuePostgresApiToken(url.href, app, schema, options, clock);
      const rows = async () => (await c.query('SELECT * FROM mistri.auth_api_token ORDER BY token_id')).rows;
      const revoke = (tokenId: string, expectedVersion = '1') =>
        revokePostgresApiToken(url.href, { ...binding, excludeConnections: [], tokenId, expectedVersion, actorId: 'actor' }, () => 1500);
      await t.test('core-only storage is not provisioned by maintenance', async () => {
        await assert.rejects(issue(), unavailable);
        assert.equal((await c.query("SELECT to_regclass('mistri.auth_api_token') AS relation")).rows[0].relation, null);
      });
      await provisionPostgresApiTokenStore(url.href, { ...binding, excludeConnections: [] });
      for (const [id, role] of [
        ['subject', 'reader,dormant'],
        ['actor', null],
      ]) {
        await c.query(
          `INSERT INTO mistri.auth_user (id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
        VALUES ($1,$1,$2,true,now(),now(),$3,false)`,
          [id, id + '@example.test', role],
        );
      }
      await t.test('digest-only exact scope, absent versus empty operations and dormant roles', async () => {
        const issued = await issue(),
          stored = (await rows()).find((row) => row.token_id === issued.tokenId)!;
        assert.ok(matchesApiTokenSecret('app', issued.tokenId, issued.token, stored.digest));
        assert.equal(stored.operations_json, null);
        assert.equal(stored.roles_json, '["reader"]');
        assert.ok(!JSON.stringify(stored).includes(issued.token));
        const dormant = await issuePostgresApiToken(url.href, app, schema, { ...options, roles: ['dormant'], operations: [] }, () => 1000);
        assert.equal((await rows()).find((row) => row.token_id === dormant.tokenId)?.operations_json, '[]');
        const operation = checkApiReadCatalog(app.api!, app, schema).operations[0].id;
        for (const change of [
          { roles: ['admin'] },
          { roles: ['reader', 'admin'] },
          { operations: ['missing'] },
          { roles: ['dormant'], operations: [operation] },
          { subjectId: 'missing' },
          { actorId: 'missing' },
        ]) {
          await assert.rejects(
            issuePostgresApiToken(url.href, app, schema, { ...options, ...change }, () => 1000),
            unavailable,
          );
        }
      });
      await t.test('clock rejects async/nonfinite/backwards and expiry after insertion rolls back', async () => {
        const before = (await rows()).length;
        for (const clock of [
          (() => Promise.resolve(1000)) as unknown as () => number,
          () => NaN,
          (() => {
            let n = 0;
            return () => (++n === 1 ? 1000 : 999);
          })(),
          (() => {
            let n = 0;
            return () => (++n === 3 ? 2000 : 1000);
          })(),
        ])
          await assert.rejects(issue(clock), unavailable);
        assert.equal((await rows()).length, before);
      });
      await t.test('binding and business connection separation refuse', async () => {
        await assert.rejects(
          issuePostgresApiToken(url.href, app, schema, { ...options, storeId: randomUUID() }, () => 1000),
          unavailable,
        );
        await assert.rejects(
          issuePostgresApiToken(url.href, app, schema, { ...options, excludeConnections: [{ url: url.href }] }, () => 1000),
          unavailable,
        );
        const otherName = `tw_token_excluded_${randomUUID().replaceAll('-', '')}`;
        await control.query(`CREATE DATABASE "${otherName}"`);
        try {
          const other = new URL(url);
          other.pathname = `/${otherName}`;
          await migratePostgresAuthStore(other.href);
          // Distinct owned database: URL separation passes, actual schema
          // reachability with these credentials must nevertheless refuse.
          await assert.rejects(
            issuePostgresApiToken(url.href, app, schema, { ...options, excludeConnections: [{ url: other.href }] }, () => 1000),
            unavailable,
          );
        } finally {
          await control.query(`DROP DATABASE "${otherName}"`);
        }
      });
      await t.test('a demotion committed while issuance waits on the account lock refuses', async () => {
        await c.query('BEGIN');
        await c.query(`UPDATE mistri.auth_user SET role=NULL WHERE id='subject'`);
        const before = (await rows()).length,
          pending = issue();
        void pending.catch(() => {});
        try {
          let blocked = false;
          for (let n = 0; n < 100 && !blocked; n++) {
            blocked =
              (
                await control.query(
                  `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
            AND query LIKE '%FOR UPDATE%'`,
                  [name],
                )
              ).rows.length > 0;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(blocked, 'issuance must wait on the current native account row');
          await c.query('COMMIT');
          await assert.rejects(pending, unavailable);
          assert.equal((await rows()).length, before);
        } finally {
          await c.query('ROLLBACK');
          await pending.catch(() => {});
          await c.query(`UPDATE mistri.auth_user SET role='reader,dormant' WHERE id='subject'`);
        }
      });
      await t.test('a ban started after account locks waits until issuance commits', async () => {
        const original = pg.default.Client.prototype.query;
        let writer: Promise<unknown> | undefined,
          observed = false,
          calls = 0;
        const mock = t.mock.method(pg.default.Client.prototype, 'query', function (this: Client, ...args: unknown[]) {
          const pending = Reflect.apply(original, this, args) as Promise<unknown>;
          if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO mistri."auth_api_token" ')) {
            return pending.then(async (value) => {
              for (let n = 0; n < 100 && !observed; n++) {
                observed =
                  (await control.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [writerName]))
                    .rows.length > 0;
                if (!observed) await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.ok(observed, 'native ban writer must be blocked by issuer row lock');
              return value;
            });
          }
          return pending;
        });
        try {
          await issue(() => {
            if (++calls === 2) {
              writer = c.query(`UPDATE mistri.auth_user SET banned=true WHERE id='subject'`);
              void writer.catch(() => {});
            }
            return 1000;
          });
          await writer;
          assert.ok(observed);
          await assert.rejects(issue(), unavailable);
        } finally {
          mock.mock.restore();
          await writer?.catch(() => {});
          await c.query(`UPDATE mistri.auth_user SET banned=false WHERE id='subject'`);
        }
      });
      await t.test('revoke is terminal after demotion without any App/API argument; concurrent CAS has one winner', async () => {
        const issued = await issue();
        await c.query(`UPDATE mistri.auth_user SET banned=true,role=NULL WHERE id='subject'`);
        const results = await Promise.allSettled([revoke(issued.tokenId), revoke(issued.tokenId)]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal((await rows()).find((row) => row.token_id === issued.tokenId)?.version, '2');
        await assert.rejects(revoke(issued.tokenId, '2'), unavailable);
        await c.query(`UPDATE mistri.auth_user SET banned=false,role='reader,dormant' WHERE id='subject'`);
      });
      await t.test('COMMIT uncertainty never hands off a secret or retries issuance', async () => {
        for (const committed of [false, true]) {
          const before = (await rows()).length,
            original = pg.default.Client.prototype.query,
            tokenId = randomUUID();
          let commits = 0;
          const mock = t.mock.method(pg.default.Client.prototype, 'query', function (this: Client, ...args: unknown[]) {
            if (args[0] === 'COMMIT') {
              commits++;
              return (committed ? (Reflect.apply(original, this, args) as Promise<unknown>) : Promise.resolve()).then(() => {
                throw new Error('PRIVATE uncertain commit');
              });
            }
            return Reflect.apply(original, this, args) as Promise<unknown>;
          });
          try {
            await assert.rejects(
              issuePostgresApiToken(url.href, app, schema, { ...options, tokenId }, () => 1000),
              unavailable,
            );
          } finally {
            mock.mock.restore();
          }
          assert.equal(commits, 1);
          assert.equal((await rows()).length, before + Number(committed));
          const inspected = await inspectPostgresApiToken(url.href, { ...binding, excludeConnections: [], tokenId });
          if (!committed) assert.equal(inspected, null);
          else {
            assert.equal(inspected?.record.id, tokenId);
            assert.equal(inspected?.version, '1');
            assert.deepEqual(Reflect.ownKeys(inspected!), ['record', 'version']);
            assert.ok(Object.isFrozen(inspected) && Object.isFrozen(inspected!.record));
            assert.equal(Object.hasOwn(inspected!.record, 'digest'), false);
            assert.deepEqual(await revoke(tokenId), { tokenId, version: '2' });
          }
        }
      });
      await t.test('chosen locator never overwrites; invalid locators refuse before connection', async () => {
        const tokenId = randomUUID();
        const issued = await issuePostgresApiToken(url.href, app, schema, { ...options, tokenId }, () => 1000);
        assert.equal(issued.tokenId, tokenId);
        const before = (await rows()).find((row) => row.token_id === tokenId);
        await assert.rejects(
          issuePostgresApiToken(url.href, app, schema, { ...options, tokenId }, () => 1000),
          unavailable,
        );
        assert.deepEqual(
          (await rows()).find((row) => row.token_id === tokenId),
          before,
        );
        await assert.rejects(
          inspectPostgresApiToken(url.href, { ...binding, appId: 'other', excludeConnections: [], tokenId }),
          unavailable,
        );
        let connections = 0;
        const mock = t.mock.method(pg.default.Client.prototype, 'connect', async () => {
          connections++;
          throw new Error('unexpected connection');
        });
        try {
          for (const invalid of [null, undefined, '', 'bad', tokenId.toUpperCase(), tokenId + '\n']) {
            await assert.rejects(
              issuePostgresApiToken(url.href, app, schema, { ...options, tokenId: invalid as string }, () => 1000),
              unavailable,
            );
            await assert.rejects(
              inspectPostgresApiToken(url.href, { ...binding, excludeConnections: [], tokenId: invalid as string }),
              unavailable,
            );
          }
          assert.equal(connections, 0);
        } finally {
          mock.mock.restore();
        }
      });
      await t.test(
        'limited native owner recovers a swallowed identity-probe permission failure',
        {
          skip:
            new URL(LIVE!).hostname !== '127.0.0.1' || new URL(LIVE!).port !== '55450'
              ? 'owned test-role creation is restricted to the disposable local PostgreSQL fixture'
              : false,
        },
        async () => {
          const suffix = randomUUID().replaceAll('-', ''),
            role = `tw_token_role_${suffix}`;
          const authName = `tw_token_limited_${suffix}`,
            businessName = `tw_token_business_${suffix}`;
          const password = randomUUID();
          let roleOwned = false,
            authOwned = false,
            businessOwned = false;
          let limited: Client | undefined;
          try {
            await control.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
            roleOwned = true;
            await control.query(`CREATE DATABASE "${authName}" OWNER "${role}"`);
            authOwned = true;
            await control.query(`CREATE DATABASE "${businessName}" OWNER "${role}"`);
            businessOwned = true;
            const authUrl = new URL(LIVE!);
            authUrl.pathname = `/${authName}`;
            authUrl.username = role;
            authUrl.password = password;
            const businessUrl = new URL(authUrl);
            businessUrl.pathname = `/${businessName}`;
            const adminUrl = new URL(LIVE!);
            adminUrl.pathname = `/${authName}`;
            const admin = new pg.default.Client({ connectionString: adminUrl.href, statement_timeout: 10000 });
            try {
              try {
                await admin.connect();
              } catch {
                throw new Error('Owned fixture admin connection failed');
              }
              assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, authName);
              // Function ACLs are database-local. This touches only the just-created
              // owned database, recovered completely by its exact DROP below.
              await admin.query('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC');
            } finally {
              await admin.end();
            }
            await migratePostgresAuthStore(authUrl.href);
            await provisionPostgresApiTokenStore(authUrl.href, {
              ...binding,
              excludeConnections: [{ url: businessUrl.href, name: 'captured-business', source: 'session' }],
            });
            limited = new pg.default.Client({ connectionString: authUrl.href, statement_timeout: 10000 });
            try {
              await limited.connect();
            } catch {
              throw new Error('Limited fixture connection failed');
            }
            await assert.rejects(
              limited.query('SELECT system_identifier::text AS system FROM pg_catalog.pg_control_system()'),
              (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '42501',
              'fixture must exercise genuine function permission denial',
            );
            for (const id of ['subject', 'actor'])
              await limited.query(
                `INSERT INTO mistri.auth_user
          (id,name,email,"emailVerified","createdAt","updatedAt",role,banned) VALUES ($1,$1,$2,true,now(),now(),'reader',false)`,
                [id, id + '@example.test'],
              );
            const excluded = [{ url: businessUrl.href }];
            await limited.query('BEGIN');
            // Existing autocommit-oriented helper intentionally uses unknown server
            // identity after permission denial; in a transaction this needs recovery.
            await assertPostgresAuthStoreServerSeparation(limited, excluded);
            await assert.rejects(
              limited.query('SELECT 1'),
              (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '25P02',
            );
            await limited.query('ROLLBACK');
            const issued = await issuePostgresApiToken(authUrl.href, app, schema, { ...options, excludeConnections: excluded }, () => 1000);
            const stored = (await limited.query('SELECT digest FROM mistri.auth_api_token WHERE token_id=$1', [issued.tokenId])).rows[0];
            assert.ok(matchesApiTokenSecret('app', issued.tokenId, issued.token, stored.digest));
            assert.deepEqual(
              await revokePostgresApiToken(
                authUrl.href,
                { ...binding, excludeConnections: excluded, tokenId: issued.tokenId, expectedVersion: '1', actorId: 'actor' },
                () => 1500,
              ),
              { tokenId: issued.tokenId, version: '2' },
            );
          } finally {
            await limited?.end();
            try {
              if (authOwned) await control.query(`DROP DATABASE "${authName}"`);
            } finally {
              try {
                if (businessOwned) await control.query(`DROP DATABASE "${businessName}"`);
              } finally {
                if (roleOwned) await control.query(`DROP ROLE "${role}"`);
              }
            }
          }
        },
      );
    } finally {
      t.mock.restoreAll();
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
