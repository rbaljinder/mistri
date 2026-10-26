/**
 * A relation an extension owns is the extension's, not the App's.
 *
 * PlanetScale preinstalls hypopg in every database; PostGIS brings
 * `spatial_ref_sys` to Neon and Supabase. The catalog description and its
 * digest both leave such relations out, or a tenant App refuses to start over
 * tables it never declared. Live and opt-in like postgres.test.ts: it works in
 * a database of this run's own, because an extension is per database.
 * `pg_stat_statements` creates two views without being preloaded.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { describePostgresCatalog, SYSTEM_SCHEMAS } from '../packages/engine/src/adapters/postgresCatalog.js';
import { postgresCatalogDigestOf, postgresCatalogDigestStatement } from '../packages/engine/src/adapters/postgresCatalogDigest.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { postgresPrivileges } from '../packages/engine/src/adapters/rolePrivileges.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const DATABASE = `tw_extension_${randomUUID().replaceAll('-', '')}`;
let url = '';

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(target: string): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: target, statement_timeout: 10_000 });
  await created.connect();
  return created;
}
const at = (name: string) => {
  const address = new URL(LIVE!);
  address.pathname = `/${name}`;
  return address.href;
};

describe('extension-owned relations on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  let db: Control;
  const source = { schemas: [] as string[], label: 'test', dialect: 'postgres' as const };
  const digest = async () =>
    postgresCatalogDigestOf(await db.query(postgresCatalogDigestStatement(SYSTEM_SCHEMAS.filter((name) => /^[a-z_]+$/.test(name)))));

  before(async () => {
    const admin = await client(LIVE!);
    try {
      await admin.query(`CREATE DATABASE "${DATABASE}"`);
    } finally {
      await admin.end();
    }
    url = at(DATABASE);
    db = await client(url);
    await db.query(`CREATE EXTENSION pg_stat_statements`);
    await db.query(`CREATE TABLE public.ordinary (id integer PRIMARY KEY, name text)`);
  });
  after(async () => {
    await db?.end();
    const admin = await client(LIVE!);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  test('the extension really has views here', async () => {
    const { rows } = await db.query(`SELECT c.relname FROM pg_class c WHERE c.relname = 'pg_stat_statements' AND c.relkind = 'v'`);
    assert.equal(rows.length, 1);
  });

  test('the description omits them and keeps an ordinary table', async () => {
    const schema = await describePostgresCatalog(db, source);
    const names = schema.tables.map((table) => table.name);
    assert.ok(names.includes('ordinary'), names.join(','));
    assert.ok(!names.some((name) => name.startsWith('pg_stat_statements')), names.join(','));
  });

  test('the digest ignores them and still moves for an ordinary change', async () => {
    const before = await digest();
    // A grant rewrites the view's pg_class row (a new xmin): invisible to the digest if the view is left out, as it is.
    await db.query(`GRANT SELECT ON public.pg_stat_statements_info TO PUBLIC`);
    assert.equal(await digest(), before);
    await db.query(`CREATE VIEW public.ordinary_view AS SELECT 1 AS one`);
    assert.notEqual(await digest(), before);
  });

  test("role privileges count only the App's tables", async () => {
    const privileges = await postgresPrivileges(db, [], SYSTEM_SCHEMAS);
    assert.equal(typeof privileges.superuser, 'boolean');
  });
});
