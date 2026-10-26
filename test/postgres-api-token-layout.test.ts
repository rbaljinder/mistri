import { foldRelations } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  deparsedTextCheck,
  postgresApiTokenDdl,
  postgresApiTokenCatalog,
} from '../packages/mistri/src/adapters/auth/postgresApiTokenLayout.js';
import { foldConstraint } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import { describePostgresRelations } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { liveSkip } from './live.js';

const live = process.env.TABLEWALK_TEST_PG;
test('fixed token leaf has independent catalog copies and no caller-defined DDL', () => {
  const first = postgresApiTokenCatalog();
  assert.equal(first.find((table) => table.name === 'auth_api_token')!.columns.length, 19);
  first[0].constraints.push('foreign');
  assert.equal(postgresApiTokenCatalog()[0].constraints.includes('foreign'), false);
  assert.ok(Object.isFrozen(postgresApiTokenDdl()));
  // Every table is the runtime schema's, named with the sign-in store's prefix.
  assert.ok(postgresApiTokenDdl().every((ddl) => /^CREATE (TABLE|INDEX \w+ ON) mistri\."auth_/.test(ddl)));
});
test('the OAuth rows sit beside the token table, spelled as the token table was captured', () => {
  const catalog = postgresApiTokenCatalog();
  assert.deepEqual(
    catalog.map((table) => table.name),
    [
      'auth_api_token',
      'auth_api_token_meta',
      'auth_oauth_access',
      'auth_oauth_client',
      'auth_oauth_code',
      'auth_oauth_grant',
      'auth_oauth_refresh',
    ],
  );
  assert.ok(catalog[1].constraints.includes('CHECK ((version = 1))'));
  // The OAuth rows are written in the deparsed spelling, not captured: the helper reproduces the captured text checks.
  // The OAuth rows are written in the deparsed spelling, not captured: the helper reproduces v2's captured text checks.
  const captured = catalog[0].constraints.map(foldConstraint);
  for (const [name, max, nullable] of [
    ['app_id', 256, false],
    ['created_by', 3072, false],
    ['token_id', 36, false],
    ['revoked_by', 3072, true],
    ['tenant_id', 128, true],
    ['membership_version', 128, true],
  ] as const) {
    assert.ok(captured.includes(foldConstraint(deparsedTextCheck(name, max, nullable))), name);
  }
  assert.equal(postgresApiTokenDdl().length, 10);
});
test('fixed API token extension matches pinned native PostgreSQL catalog', { skip: liveSkip('postgres', live) }, async () => {
  const module = 'pg';
  const { Client } = (await import(module)).default;
  const control = new Client({ connectionString: live });
  await control.connect();
  // The only destructive target is the successfully created unique database.
  const owned = `tw_api_token_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let database: InstanceType<typeof Client> | undefined;
  try {
    await control.query(`CREATE DATABASE "${owned}"`);
    created = true;
    const url = new URL(live!);
    url.pathname = `/${owned}`;
    database = new Client({ connectionString: url.href });
    await database.connect();
    await database.query('CREATE SCHEMA mistri');
    await database.query('SET search_path = pg_catalog, mistri, pg_temp');
    for (const ddl of postgresApiTokenDdl()) await database.query(ddl);
    const actual = await describePostgresRelations(database as PgQuery, 'auth_');
    assert.deepEqual(actual, foldRelations(postgresApiTokenCatalog()));
    const id = randomUUID();
    await database.query(
      `INSERT INTO mistri.auth_api_token_meta(singleton,version,app_id,store_id,format)
      VALUES (1,1,'app',$1,'twa1')`,
      [randomUUID()],
    );
    const insert = `INSERT INTO mistri.auth_api_token(token_id,app_id,subject_kind,subject_id,label,
      roles_json,operations_json,created_at,created_by,expires_at,format,digest,version)
      VALUES ($1,'app','account',$2,'Label','["reader"]',$3,1,$2,8640000000000000,'twa1',$4,$5)`;
    const native = 'é'.repeat(1024);
    await database.query(insert, [id, native, null, 'a'.repeat(64), '9'.repeat(128)]);
    const observed = (await database.query('SELECT * FROM mistri.auth_api_token WHERE token_id=$1', [id])).rows[0];
    assert.equal(observed.subject_id, native);
    assert.equal(observed.operations_json, null);
    assert.equal(observed.version, '9'.repeat(128));
    await database.query('UPDATE mistri.auth_api_token SET operations_json=$1 WHERE token_id=$2', ['[]', id]);
    assert.equal(
      (await database.query('SELECT operations_json FROM mistri.auth_api_token WHERE token_id=$1', [id])).rows[0].operations_json,
      '[]',
    );
    for (const [column, value] of [
      ['created_at', -1],
      ['expires_at', '8640000000000001'],
      ['expires_at', 1],
      ['revoked_at', 2],
      ['roles_json', '[]'],
      ['roles_json', '{}'],
      ['operations_json', 'null'],
      ['version', '0'],
      ['version', '1'.repeat(129)],
      ['digest', 'A'.repeat(64)],
      ['format', 'twa2'],
      ['subject_id', ' padded '],
      ['label', 'a\n'],
      ['subject_kind', 'other'],
    ])
      await assert.rejects(database.query(`UPDATE mistri.auth_api_token SET ${column}=$1 WHERE token_id=$2`, [value, id]));
    // The token leaf references nothing outside itself: the token tables none at all, the OAuth rows only each other.
    const own = new Set(actual.map((table) => table.name));
    for (const table of actual)
      for (const rule of table.constraints.filter((constraint) => constraint.includes('FOREIGN KEY'))) {
        assert.ok(!table.name.startsWith('auth_api_token'), `${table.name}: ${rule}`);
        assert.ok(own.has(/REFERENCES (\w+)\(/.exec(rule)?.[1] ?? ''), `${table.name}: ${rule}`);
      }
  } finally {
    await database?.end();
    if (created) await control.query(`DROP DATABASE "${owned}"`);
    await control.end();
  }
});
