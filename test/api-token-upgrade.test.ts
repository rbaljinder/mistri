/**
 * The API token store's upgrade, version 1 to 2 (a token's row scope: `api.scopes`, `--scope`, `$scope`), as an
 * operator meets it: a database holding the committed version 1 fixture with a token and the OAuth access row that
 * names it, `upgradeStores` (what `mistri migrate stores up` calls) taking it forward, both rows kept, the result the
 * layout a fresh store has, and provisioning — which attests an existing store — accepting it where it refused the old one.
 *
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server where the role may create databases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { STORES, storeIsCurrent, storeStatuses, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import { API_TOKEN_STORE_VERSION } from '../packages/mistri/src/adapters/auth/postgresApiTokenLayout.js';
import {
  ENGINES,
  LIVE,
  PROVISION,
  applyFixture,
  describeUrl,
  fixtureFiles,
  scratch,
  withoutBeneath,
  type Engine,
} from './support/storeLayouts.js';

const layouts = STORES.filter((store) => store.id === 'api-tokens');

async function withDb<T>(url: string, work: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await openMigrationDb(url, [], false);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

const names = (engine: Engine) =>
  engine === 'sqlite'
    ? {
        token: '"__mistri_api_token"',
        meta: '"__mistri_api_token_meta"',
        client: '"__mistri_oauth_client"',
        grant: '"__mistri_oauth_grant"',
        access: '"__mistri_oauth_access"',
      }
    : {
        token: 'mistri.auth_api_token',
        meta: 'mistri.auth_api_token_meta',
        client: 'mistri.auth_oauth_client',
        grant: 'mistri.auth_oauth_grant',
        access: 'mistri.auth_oauth_access',
      };

const TOKEN = '6f1c2a4e-8b3d-4c5e-9a7f-1b2c3d4e5f60';
const CHILD = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CLIENT = 'twc1.1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';
const GRANT = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b';
const DIGEST = 'a'.repeat(64);

async function seed(db: MigrationDb, engine: Engine) {
  const { token, client, grant, access } = names(engine);
  await db.run(
    `INSERT INTO ${token} (token_id, app_id, subject_kind, subject_id, label, roles_json, created_at, created_by, expires_at, format, digest, version)
     VALUES (?, 'layout', 'account', 'acct-1', 'ci', '["reader"]', 1000, 'acct-1', 2000, 'twa1', ?, '1')`,
    [TOKEN, DIGEST],
  );
  await db.run(`INSERT INTO ${client} (client_id, redirect_uris_json, created_at) VALUES (?, '["https://example.com/cb"]', 1000)`, [
    CLIENT,
  ]);
  await db.run(
    `INSERT INTO ${grant} (grant_id, client_id, subject, app_id, version, roles_json, created_at, expires_at) VALUES (?, ?, 'acct-1', 'layout', 1, '["reader"]', 1000, 2000)`,
    [GRANT, CLIENT],
  );
  await db.run(`INSERT INTO ${access} (token_id, grant_id, app_id, version) VALUES (?, ?, 'layout', 1)`, [TOKEN, GRANT]);
}

const insertChild = (db: MigrationDb, engine: Engine, scope: { name: string | null; key: string | null; parent: string | null }) =>
  db.run(
    `INSERT INTO ${names(engine).token} (token_id, app_id, subject_kind, subject_id, label, roles_json, created_at, created_by, expires_at, format, digest, version, scope_name, scope_key, scope_parent_id)
     VALUES (?, 'layout', 'account', 'acct-1', 'scoped', '["reader"]', 1000, 'acct-1', 2000, 'twa1', ?, '1', ?, ?, ?)`,
    [CHILD, 'b'.repeat(64), scope.name, scope.key, scope.parent],
  );

for (const engine of ENGINES)
  test(
    `${engine}: a version 1 API token store with a token and its OAuth access upgrades in place to version 2, both kept, and provisioning accepts it`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const { token, meta, access } = names(engine);
      const where = await scratch(engine, 'tokens_up'),
        fresh = await scratch(engine, 'tokens_fresh');
      try {
        const v1 = fixtureFiles('api-tokens', engine).find((file) => file.version === 1)!;
        await applyFixture(engine, where.url, readFileSync(v1.path, 'utf8'));
        await withDb(where.url, async (db) => {
          await seed(db, engine);
          const [status] = await storeStatuses(db, layouts);
          assert.equal(status.found, 1);
          assert.deepEqual(status.pending, [1]);
        });
        // Provisioning attests an existing store; it refuses version 1 and never upgrades it itself.
        await assert.rejects(PROVISION['api-tokens'][engine]!(where.url));

        const done = await withDb(where.url, (db) => upgradeStores(db, where.url, layouts));
        assert.deepEqual(done.failed, []);
        assert.deepEqual(
          done.applied.map((each) => [each.id, each.from, each.to]),
          [['api-tokens', 1, 2]],
        );
        await PROVISION['api-tokens'][engine]!(where.url);

        await PROVISION['api-tokens'][engine]!(fresh.url);
        assert.deepEqual(
          withoutBeneath('api-tokens', engine, await describeUrl(where.url)),
          withoutBeneath('api-tokens', engine, await describeUrl(fresh.url)),
        );

        await withDb(where.url, async (db) => {
          assert.deepEqual(
            (
              await db.all<{ token_id: string; label: string; scope_name: string | null }>(
                `SELECT token_id, label, scope_name FROM ${token}`,
              )
            ).map((row) => [row.token_id, row.label, row.scope_name]),
            [[TOKEN, 'ci', null]],
            'the token kept, unscoped',
          );
          assert.deepEqual(
            (await db.all<{ token_id: string; grant_id: string }>(`SELECT token_id, grant_id FROM ${access}`)).map((row) => [
              row.token_id,
              row.grant_id,
            ]),
            [[TOKEN, GRANT]],
            'its OAuth access kept',
          );
          assert.deepEqual(
            (await db.all<{ version: number }>(`SELECT version FROM ${meta}`)).map((row) => Number(row.version)),
            [API_TOKEN_STORE_VERSION],
          );
          // A scoped token's parent is indexed, as a fresh store has it.
          assert.deepEqual(
            (
              await db.all<{ name: string }>(
                engine === 'sqlite'
                  ? `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = '__mistri_api_token' AND name LIKE '%scope_parent'`
                  : `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'mistri' AND tablename = 'auth_api_token' AND indexname LIKE '%scope_parent_idx'`,
              )
            ).length,
            1,
          );
          // A scope is its name and key together, and only a scoped token has a parent.
          await assert.rejects(insertChild(db, engine, { name: 'clinic', key: null, parent: null }));
          await assert.rejects(insertChild(db, engine, { name: null, key: null, parent: TOKEN }));
          await assert.rejects(insertChild(db, engine, { name: 'bad name', key: '7', parent: null }));
          await insertChild(db, engine, { name: 'clinic', key: '7', parent: TOKEN });
          // The access row still goes with its token (SQLite's connection is asked to enforce keys).
          if (engine === 'sqlite') await db.run('PRAGMA foreign_keys = ON');
          await db.run(`DELETE FROM ${token} WHERE token_id = ?`, [TOKEN]);
          assert.equal((await db.all(`SELECT 1 FROM ${access}`)).length, 0);
          assert.ok(storeIsCurrent((await storeStatuses(db, layouts))[0]));
        });
        assert.deepEqual((await withDb(where.url, (db) => upgradeStores(db, where.url, layouts))).applied, []);
      } finally {
        await where.drop();
        await fresh.drop();
      }
    },
  );

// The version pin on the meta table was created unnamed, so its name is the server's to choose: the upgrade finds it by
// what it checks. A store whose pin carries another name (one a restore or another tool renamed) upgrades all the same.
test(
  'postgres: a version 1 store whose meta version check has another name upgrades, and the pin is the named one',
  { skip: liveSkip('postgres', LIVE) },
  async () => {
    const where = await scratch('postgres', 'tokens_renamed');
    try {
      const v1 = fixtureFiles('api-tokens', 'postgres').find((file) => file.version === 1)!;
      await applyFixture('postgres', where.url, readFileSync(v1.path, 'utf8'));
      await withDb(where.url, async (db) => {
        await db.run('ALTER TABLE mistri.auth_api_token_meta DROP CONSTRAINT auth_api_token_meta_version_check');
        await db.run('ALTER TABLE mistri.auth_api_token_meta ADD CONSTRAINT restored_pin CHECK (version = 1)');
      });
      const done = await withDb(where.url, (db) => upgradeStores(db, where.url, layouts));
      assert.deepEqual(done.failed, []);
      await withDb(where.url, async (db) => {
        const pins = await db.all<{ conname: string }>(
          `SELECT conname FROM pg_constraint WHERE conrelid = 'mistri.auth_api_token_meta'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\\mversion\\M'`,
        );
        assert.deepEqual(
          pins.map((row) => row.conname),
          ['auth_api_token_meta_version_check'],
        );
      });
      await PROVISION['api-tokens'].postgres!(where.url);
    } finally {
      await where.drop();
    }
  },
);
