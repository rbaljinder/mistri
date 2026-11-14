/**
 * The row-security backstop against a real server (docs/postgresql.md): the pair of roles a tenant App starts
 * with is attested before anything is served, and a runtime role the pinned policy binds sees one tenant's rows
 * and cannot write another's, even where the engine's own scope was talked into allowing it; and what
 * `mistri migrate backstop` writes builds that same database, judged by the catalog check and by its own status.
 * tenant-backstop.test.ts proves the wiring without a server.
 *
 * Live and opt-in like postgres-tenant-store.test.ts: `TABLEWALK_TEST_PG` names a server whose role may create
 * databases and roles (BYPASSRLS among them), and `TABLEWALK_REQUIRE_LIVE=1` turns a missing server into a
 * failure. It works in a database of its own and roles named for this run, all dropped afterwards.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { createScopedReads } from '../packages/engine/src/adapters/scoped/scopedReads.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { backstopDrift, backstopPlan, backstopSql } from '../packages/mistri/src/server/tenant/tenantBackstop.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  assertPostgresRuntimeOwnsNone,
  attestPostgresBackstopRoles,
  attestPostgresTenantRelations,
} from '../packages/mistri/src/server/tenant/tenantPostgresCatalog.js';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { openBackstopOwnerReader } from '../packages/mistri/src/server/tenant/tenantBackstopOwner.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { sqliteSearch } from '../packs/search-sqlite/src/index.js';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
/* Roles are the server's, not a database's: named for this run, so two runs never drop each other's. */
const FIXTURE_ID = randomUUID().replaceAll('-', '');
const DATABASE = `tw_tenant_backstop_${FIXTURE_ID}`;
const ROLE = {
  owner: `mistri_bs_owner_${FIXTURE_ID}`,
  runtime: `mistri_bs_runtime_${FIXTURE_ID}`,
  member: `mistri_bs_member_${FIXTURE_ID}`,
  bypass: `mistri_bs_bypass_${FIXTURE_ID}`,
  /* Made by the backstop's own SQL, not by the setup. */
  planned: `mistri_bs_planned_${FIXTURE_ID}`,
};
const PASSWORD = randomBytes(18).toString('hex');
const ITEM = 'public.item';
const POLICY = `NULLIF(current_setting('mistri.tenant', true), '')`;

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
/** This run's database, as `role` when one is named, else as the server's own role. */
function urlOf(role?: string): string {
  const target = new URL(LIVE!);
  target.pathname = `/${DATABASE}`;
  if (role) {
    target.username = role;
    target.password = PASSWORD;
  }
  return target.href;
}
/** The recorded reason a refusal carries, for its message. */
const because = (pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof TenantContextError, String(error));
  const cause = refusalCause(error);
  assert.match(cause instanceof Error ? cause.message : String(cause), pattern);
  return true;
};
/** The SQLSTATE behind an error, however the engine wrapped it. */
function sqlState(error: unknown): string | undefined {
  for (let at: unknown = error, depth = 0; at && typeof at === 'object' && depth < 8; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    at = (at as { cause?: unknown }).cause ?? refusalCause(at);
  }
  return undefined;
}
const ownership = (...physical: string[]) =>
  ({
    resources: Object.fromEntries(physical.map((id, index) => [`r${index}`, id])),
    ownership: Object.fromEntries(physical.map((_, index) => [`r${index}`, { kind: 'tenant', column: 'tenant_id' }])),
  }) as unknown as TenantOwnershipSnapshot;
const tenantRows = (tenant: string): RowScope => ({ [ITEM]: { groups: [[{ column: 'tenant_id', op: '=', value: tenant }]] } });

describe('the row-security backstop on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  const opened: Control[] = [];
  const as = async (role?: string) => {
    const made = await client(urlOf(role));
    opened.push(made);
    return made;
  };

  before(async () => {
    const server = await client(LIVE!);
    try {
      await server.query(`CREATE DATABASE "${DATABASE}"`);
      await server.query(`CREATE ROLE ${ROLE.owner} LOGIN NOBYPASSRLS PASSWORD '${PASSWORD}'`);
      await server.query(`CREATE ROLE ${ROLE.runtime} LOGIN NOBYPASSRLS PASSWORD '${PASSWORD}'`);
      await server.query(`CREATE ROLE ${ROLE.member} LOGIN NOBYPASSRLS PASSWORD '${PASSWORD}' IN ROLE ${ROLE.owner}`);
      await server.query(`CREATE ROLE ${ROLE.bypass} LOGIN BYPASSRLS PASSWORD '${PASSWORD}'`);
      await server.query(`GRANT CONNECT ON DATABASE "${DATABASE}" TO ${[ROLE.owner, ROLE.runtime, ROLE.member, ROLE.bypass].join(', ')}`);
    } finally {
      await server.end();
    }
    const setup = await client(urlOf());
    try {
      for (const statement of [
        `CREATE TABLE ${ITEM} (id text PRIMARY KEY, tenant_id text NOT NULL, title text NOT NULL)`,
        `INSERT INTO ${ITEM} VALUES ('a-1', 'north', 'North one'), ('b-1', 'south', 'South one')`,
        `ALTER TABLE ${ITEM} OWNER TO ${ROLE.owner}`,
        `GRANT USAGE ON SCHEMA public TO ${ROLE.runtime}, ${ROLE.member}, ${ROLE.bypass}`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ITEM} TO ${ROLE.runtime}, ${ROLE.member}, ${ROLE.bypass}`,
        `ALTER TABLE ${ITEM} ENABLE ROW LEVEL SECURITY`,
        `CREATE POLICY mistri_tenant ON ${ITEM} AS PERMISSIVE FOR ALL TO ${ROLE.runtime}
           USING (tenant_id = ${POLICY}) WITH CHECK (tenant_id = ${POLICY})`,
        /* A table the runtime role owns: its owner is exempt from any policy on it. */
        `CREATE TABLE public.mine (id text PRIMARY KEY, tenant_id text NOT NULL)`,
        `ALTER TABLE public.mine OWNER TO ${ROLE.runtime}`,
      ])
        await setup.query(statement);
    } finally {
      await setup.end();
    }
  });
  after(async () => {
    while (opened.length)
      await opened
        .pop()!
        .end()
        .catch(() => {});
    const server = await client(LIVE!);
    try {
      await server.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      for (const role of [ROLE.planned, ROLE.member, ROLE.bypass, ROLE.runtime, ROLE.owner])
        await server.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await server.end();
    }
  });

  test('a runtime role that owns nothing and bypasses nothing is accepted beside its owner', async () => {
    const owner = await as(ROLE.owner);
    assert.deepEqual(await attestPostgresBackstopRoles(await as(ROLE.runtime), owner), { role: ROLE.runtime, ownerRole: ROLE.owner });
    await assertPostgresRuntimeOwnsNone(await as(ROLE.runtime), ownership(ITEM));
  });

  test('a runtime role the policy would not bind is refused before anything is served', async () => {
    const owner = await as(ROLE.owner);
    await assert.rejects(attestPostgresBackstopRoles(await as(ROLE.member), owner), because(/member of the owner role/));
    await assert.rejects(attestPostgresBackstopRoles(await as(ROLE.bypass), owner), because(/BYPASSRLS/));
    await assert.rejects(attestPostgresBackstopRoles(await as(ROLE.owner), owner), because(/connects as the owner/));
    const server = await as();
    const { rows } = await server.query('SELECT rolsuper AS super FROM pg_catalog.pg_roles WHERE rolname = current_user');
    if ((rows[0] as { super: boolean }).super) await assert.rejects(attestPostgresBackstopRoles(server, owner), because(/superuser/));
    await assert.rejects(
      assertPostgresRuntimeOwnsNone(await as(ROLE.runtime), ownership(ITEM, 'public.mine')),
      because(/owns public\.mine/),
    );
    await assert.rejects(assertPostgresRuntimeOwnsNone(await as(ROLE.member), ownership(ITEM)), because(/owns public\.item/));
  });

  test("a tenant reads its own rows and cannot write another's, even when the engine's scope would let it", async () => {
    const runtime = new PostgresAdapter(urlOf(ROLE.runtime), 'backstop runtime', ['public'], undefined, undefined, {
      rowSecurity: { role: ROLE.runtime },
    });
    const owner = new PostgresAdapter(urlOf(ROLE.owner), 'backstop owner', ['public'], undefined, undefined, {
      rowSecurity: { role: ROLE.runtime, bypass: true },
    });
    const ids = async (on: PostgresAdapter, tenant?: string | null) =>
      on.readSnapshot(
        async (snapshot) => (await snapshot.client.query(`SELECT id FROM ${ITEM} ORDER BY id`)).rows.map((row) => row.id),
        false,
        undefined,
        false,
        false,
        tenant,
      );
    try {
      assert.deepEqual(await ids(runtime, 'north'), ['a-1']);
      assert.deepEqual(await ids(runtime, 'south'), ['b-1']);
      assert.deepEqual(await ids(runtime, null), [], 'no tenant set, no row admitted');
      assert.deepEqual(await ids(owner), ['a-1', 'b-1'], 'the owner crosses tenants by design');

      await runtime.scopeTransaction(
        tenantRows('north'),
        (tx) => tx.insert({ table: ITEM, values: { id: 'a-2', tenant_id: 'north', title: 'North two' } }),
        undefined,
        { tenant: 'north' },
      );
      assert.deepEqual(await ids(runtime, 'north'), ['a-1', 'a-2'], 'the pinned policy is one the engine writes under');

      /* The engine's scope says south, the transaction's tenant is north: the database refuses on its own. */
      await assert.rejects(
        runtime.scopeTransaction(
          tenantRows('south'),
          (tx) => tx.insert({ table: ITEM, values: { id: 'b-2', tenant_id: 'south', title: 'Smuggled' } }),
          undefined,
          { tenant: 'north' },
        ),
        (error: unknown) => {
          assert.equal(sqlState(error), '42501', String(error));
          return true;
        },
      );
      assert.deepEqual(await ids(owner), ['a-1', 'a-2', 'b-1'], 'nothing of south was written');
    } finally {
      await Promise.all([runtime.close(), owner.close()]);
    }
  });
  test('the owner reader a profile or a reindex opens reads every tenant, outside a transaction', async () => {
    const registry = new Registry();
    registry.onWarning = () => {};
    registry.add({
      id: 'bs',
      name: 'bs',
      url: urlOf(ROLE.runtime),
      schemas: ['public'],
      source: 'config',
      backstop: 'rls',
      owner: urlOf(ROLE.owner),
    });
    registry.add({ id: 'plain', name: 'plain', url: urlOf(ROLE.owner), schemas: ['public'], source: 'config' });
    const reader = await openBackstopOwnerReader(registry, 'bs');
    try {
      assert.equal(await openBackstopOwnerReader(registry, 'plain'), undefined, 'without the backstop there is no second reader');
      assert.ok(reader, 'under the backstop the owner reader opens');
      const { rows } = await reader.query({
        table: ITEM,
        columns: ['id'],
        limit: 10,
        offset: 0,
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
      assert.deepEqual(
        rows.map((row) => (row as { id: string }).id).filter((id) => id === 'a-1' || id === 'b-1'),
        ['a-1', 'b-1'],
      );
    } finally {
      await Promise.all([registry.closeAll(), reader?.close()]);
    }
  });

  test("search indexing reads as the owner: a write keeps its row's document and a reindex indexes every tenant", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-backstop-search-'));
    const provider = sqliteSearch([{ name: 'search', file: join(directory, 'search.db') }]);
    const registry = new Registry();
    registry.onWarning = () => {};
    // The registry connects as the runtime role, which reads no tenant row with none set.
    registry.add({ id: 'bs', name: 'bs', url: urlOf(ROLE.runtime), schemas: ['public'], source: 'config' });
    plugSearch(registry, provider);
    const app = parseAppConfig(
      {
        id: 'depot',
        name: 'Depot',
        connection: 'bs',
        resources: { item: { access: 'write', search: { connection: 'search', fields: ['title'] } } },
        views: { items: { kind: 'list', from: 'item', label: 'Items' } },
        home: 'items',
        nav: ['items'],
      },
      'backstop search fixture',
    );
    const owner = new PostgresAdapter(urlOf(ROLE.owner), 'backstop search owner', ['public'], undefined, undefined, {
      rowSecurity: { role: ROLE.runtime, bypass: true },
    });
    const indexer = indexerFor(registry);
    const index = provider.index('search')!;
    const collection = 'mistri_depot_item';
    const asked = (tenant: string) => index.search(collection, 'one', ['title'], 10, { field: 'mistri_tenant', value: tenant });
    const target = { connection: 'bs', resource: 'item', physical: ITEM };
    const columns = { item: 'tenant_id' };
    try {
      await index.ensureCollection(collection, ['title']);
      await index.upsert(collection, { id: 'a-1', title: 'North one', mistri_tenant: 'north' });
      indexer.touched(app, target, { id: 'a-1' }, 'tenant_id', columns, 'north');
      await indexer.settled();
      assert.deepEqual(await asked('north'), [], 'through the runtime role the row is not found, and its document is removed');

      indexer.readThrough('bs', () => owner);
      indexer.touched(app, target, { id: 'a-1' }, 'tenant_id', columns, 'north');
      await indexer.settled();
      assert.deepEqual(await asked('north'), ['a-1'], "through the owner the write keeps the row's document");

      await indexer.reindex(app, 'bs', undefined, undefined, columns);
      assert.deepEqual(await asked('south'), ['b-1'], 'a reindex indexes every tenant, each document keeping its tenant');
    } finally {
      indexer.readThrough('bs', undefined);
      await indexer.settled();
      provider.close();
      await Promise.all([registry.closeAll(), owner.close()]);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /* ---- The command's output, applied to a real server ---- */

  const version = async () =>
    Number(((await (await as()).query(`SELECT current_setting('server_version_num') AS v`)).rows[0] as { v: string }).v);
  const FENCED = {
    resources: { note: 'bsx.note', memo: 'bsx.memo', lookup: 'bsx.lookup', ledger: 'bsx.ledger', audit: 'bsp.audit' },
    ownership: {
      note: { kind: 'tenant', column: 'owner_key' },
      memo: { kind: 'tenant', column: 'tenant_id' },
      lookup: { kind: 'global', access: 'read-only' },
      ledger: { kind: 'platform' },
      audit: { kind: 'platform' },
    },
  } as unknown as TenantOwnershipSnapshot;

  test('the SQL `backstop new` writes satisfies the catalog check on a text and a varchar owner column, and status agrees', async (t) => {
    if ((await version()) < 150000) return t.skip('the backstop needs PostgreSQL 15 or later');
    const admin = await as();
    for (const statement of [
      'DROP SCHEMA IF EXISTS bsx CASCADE',
      'DROP SCHEMA IF EXISTS bsp CASCADE',
      'DROP ROLE IF EXISTS bsx_group',
      'CREATE SCHEMA bsx',
      /* A platform table in a schema of its own: the plan grants nothing there, so status must still read it. */
      'CREATE SCHEMA bsp',
      'CREATE TABLE bsp.audit (id text PRIMARY KEY, body text)',
      'CREATE TABLE bsx.note (id text PRIMARY KEY, owner_key text NOT NULL, body text)',
      'CREATE TABLE bsx.memo (id serial PRIMARY KEY, tenant_id varchar(40) NOT NULL, body text)',
      'CREATE TABLE bsx.lookup (id text PRIMARY KEY, label text)',
      'CREATE TABLE bsx.ledger (id text PRIMARY KEY, tenant_id text)',
    ])
      await admin.query(statement);
    const plan = backstopPlan(FENCED, ROLE.planned, { storeTables: [], sequences: [{ id: 'bsx.memo_id_seq', of: 'bsx.memo' }] });
    const sql = backstopSql(plan);
    const judged = () => attestPostgresTenantRelations(admin, FENCED, { rowSecurity: { role: ROLE.planned } });
    assert.ok(
      (await backstopDrift(plan, admin)).some((line) => /does not exist/.test(line)),
      'before it is applied, the role is missing',
    );
    await admin.query(sql);
    await judged();
    assert.deepEqual(await backstopDrift(plan, admin), []);
    await admin.query(sql);
    await judged();
    assert.deepEqual(await backstopDrift(plan, admin), [], 'run again, it says the same');

    /* Each tamper is named by status; the catalog check refuses the ones that change the policy's shape (it reads no
       privilege); and the SQL puts back what it made. */
    const tamper: Array<{ name: string; make: string; unmake?: string; says: RegExp; refused: boolean }> = [
      {
        name: 'a second policy',
        make: 'CREATE POLICY sneaky ON bsx.note USING (true)',
        unmake: 'DROP POLICY sneaky ON bsx.note',
        says: /extra policy "sneaky"/,
        refused: true,
      },
      {
        name: 'USING (true)',
        make: 'ALTER POLICY mistri_tenant ON bsx.note USING (true)',
        says: /policy mistri_tenant on bsx\.note changed: USING true/,
        refused: true,
      },
      {
        name: 'a widened WITH CHECK',
        make: 'ALTER POLICY mistri_tenant ON bsx.memo WITH CHECK (true)',
        says: /on bsx\.memo changed: WITH CHECK true/,
        refused: true,
      },
      {
        name: 'the policy for PUBLIC',
        make: 'ALTER POLICY mistri_tenant ON bsx.memo TO PUBLIC',
        says: /on bsx\.memo changed: to PUBLIC/,
        refused: true,
      },
      {
        name: 'FORCE',
        make: 'ALTER TABLE bsx.note FORCE ROW LEVEL SECURITY',
        unmake: 'ALTER TABLE bsx.note NO FORCE ROW LEVEL SECURITY',
        says: /bsx\.note has FORCE ROW LEVEL SECURITY on/,
        refused: true,
      },
      {
        name: 'row security off',
        make: 'ALTER TABLE bsx.memo DISABLE ROW LEVEL SECURITY',
        says: /bsx\.memo has row security off/,
        refused: true,
      },
      {
        name: 'a dropped policy',
        make: 'DROP POLICY mistri_tenant ON bsx.note',
        says: /bsx\.note lacks the policy mistri_tenant/,
        refused: true,
      },
      {
        name: 'row security on a global table',
        make: 'ALTER TABLE bsx.lookup ENABLE ROW LEVEL SECURITY',
        unmake: 'ALTER TABLE bsx.lookup DISABLE ROW LEVEL SECURITY',
        says: /bsx\.lookup has row security on/,
        refused: true,
      },
      {
        name: 'a dropped grant',
        make: `REVOKE DELETE ON bsx.memo FROM ${ROLE.planned}`,
        says: /lacks DELETE on bsx\.memo/,
        refused: false,
      },
      {
        name: 'a dropped schema grant',
        make: `REVOKE USAGE ON SCHEMA bsx FROM ${ROLE.planned}`,
        says: /lacks USAGE on schema bsx/,
        refused: false,
      },
      {
        name: 'a dropped sequence grant',
        make: `REVOKE USAGE ON SEQUENCE bsx.memo_id_seq FROM ${ROLE.planned}`,
        says: /lacks USAGE, SELECT on sequence bsx\.memo_id_seq/,
        refused: false,
      },
      {
        name: 'a write grant on a read-only table',
        make: `REVOKE SELECT ON bsx.lookup FROM ${ROLE.planned}`,
        says: /lacks SELECT on bsx\.lookup/,
        refused: false,
      },
      {
        name: 'a grant on a platform table',
        make: `GRANT SELECT ON bsx.ledger TO ${ROLE.planned}`,
        unmake: `REVOKE SELECT ON bsx.ledger FROM ${ROLE.planned}`,
        says: /bsx\.ledger grants \S+ SELECT, which the plan does not/,
        refused: false,
      },
      {
        name: 'a platform table readable by PUBLIC',
        make: 'GRANT SELECT ON bsx.ledger TO PUBLIC',
        unmake: 'REVOKE SELECT ON bsx.ledger FROM PUBLIC',
        says: /bsx\.ledger grants PUBLIC SELECT, which the plan does not/,
        refused: false,
      },
      {
        name: 'a write grant on the read-only table',
        make: `GRANT INSERT ON bsx.lookup TO ${ROLE.planned}`,
        unmake: `REVOKE INSERT ON bsx.lookup FROM ${ROLE.planned}`,
        says: /bsx\.lookup grants \S+ INSERT, which the plan does not/,
        refused: false,
      },
      {
        name: 'a grant option on a writable table',
        make: `GRANT SELECT ON bsx.note TO ${ROLE.planned} WITH GRANT OPTION`,
        unmake: `REVOKE GRANT OPTION FOR SELECT ON bsx.note FROM ${ROLE.planned}`,
        says: /bsx\.note grants \S+ SELECT WITH GRANT OPTION, which the plan does not/,
        refused: false,
      },
      {
        name: 'TRUNCATE on a tenant table',
        make: `GRANT TRUNCATE ON bsx.memo TO ${ROLE.planned}`,
        unmake: `REVOKE TRUNCATE ON bsx.memo FROM ${ROLE.planned}`,
        says: /bsx\.memo grants \S+ TRUNCATE, which the plan does not/,
        refused: false,
      },
      {
        name: 'CREATE on the schema',
        make: `GRANT CREATE ON SCHEMA bsx TO ${ROLE.planned}`,
        unmake: `REVOKE CREATE ON SCHEMA bsx FROM ${ROLE.planned}`,
        says: /schema bsx grants \S+ CREATE, which the plan does not/,
        refused: false,
      },
      {
        name: 'a column grant on the read-only table',
        make: `GRANT UPDATE (label) ON bsx.lookup TO ${ROLE.planned}`,
        unmake: `REVOKE UPDATE (label) ON bsx.lookup FROM ${ROLE.planned}`,
        says: /bsx\.lookup column label grants \S+ UPDATE, which the plan does not/,
        refused: false,
      },
      {
        name: 'a write held through a group role',
        make: `CREATE ROLE bsx_group NOLOGIN; GRANT INSERT ON bsx.lookup TO bsx_group; GRANT bsx_group TO ${ROLE.planned}`,
        unmake: `REVOKE bsx_group FROM ${ROLE.planned}; DROP OWNED BY bsx_group; DROP ROLE bsx_group`,
        says: /bsx\.lookup grants \S+ through "bsx_group" INSERT, which the plan does not/,
        refused: false,
      },
      {
        name: 'a platform table in a schema the plan grants nothing on',
        make: `GRANT USAGE ON SCHEMA bsp TO ${ROLE.planned}; GRANT SELECT ON bsp.audit TO ${ROLE.planned}`,
        unmake: `REVOKE SELECT ON bsp.audit FROM ${ROLE.planned}; REVOKE USAGE ON SCHEMA bsp FROM ${ROLE.planned}`,
        says: /bsp\.audit grants \S+ SELECT, which the plan does not/,
        refused: false,
      },
      {
        name: 'UPDATE on a planned sequence',
        make: `GRANT UPDATE ON SEQUENCE bsx.memo_id_seq TO ${ROLE.planned}`,
        unmake: `REVOKE UPDATE ON SEQUENCE bsx.memo_id_seq FROM ${ROLE.planned}`,
        says: /bsx\.memo_id_seq grants \S+ UPDATE, which the plan does not/,
        refused: false,
      },
      {
        name: 'a planned sequence usable by PUBLIC',
        make: 'GRANT USAGE ON SEQUENCE bsx.memo_id_seq TO PUBLIC',
        unmake: 'REVOKE USAGE ON SEQUENCE bsx.memo_id_seq FROM PUBLIC',
        says: /bsx\.memo_id_seq grants PUBLIC USAGE, which the plan does not/,
        refused: false,
      },
    ];
    for (const each of tamper) {
      await admin.query(each.make);
      const found = await backstopDrift(plan, admin);
      assert.ok(
        found.some((line) => each.says.test(line)),
        `${each.name}: ${JSON.stringify(found)}`,
      );
      if (each.refused) await assert.rejects(judged(), () => true, `${each.name}: the catalog check refuses what status names`);
      else await judged();
      if (each.unmake) await admin.query(each.unmake);
      await admin.query(sql);
      assert.deepEqual(await backstopDrift(plan, admin), [], `${each.name}: the SQL puts back what it made`);
      await judged();
    }
    // Its tables would make a later App's resource names ambiguous.
    await admin.query('DROP SCHEMA bsx CASCADE');
    await admin.query('DROP SCHEMA bsp CASCADE');
  });

  test('with the application fence removed, the database holds: no foreign row, no foreign write, nothing deleted', async () => {
    const runtime = new PostgresAdapter(urlOf(ROLE.runtime), 'backstop fence-off', ['public'], undefined, undefined, {
      rowSecurity: { role: ROLE.runtime },
    });
    const owner = new PostgresAdapter(urlOf(ROLE.owner), 'backstop fence-off owner', ['public'], undefined, undefined, {
      rowSecurity: { role: ROLE.runtime, bypass: true },
    });
    /* The app fence is the engine's row scope, which here says `true` for every table: no tenant condition at all. */
    const unfenced: RowScope = { [ITEM]: true };
    const wholeOf = async (on: PostgresAdapter) =>
      on.readSnapshot(async (snapshot) => (await snapshot.client.query(`SELECT id, tenant_id, title FROM ${ITEM} ORDER BY id`)).rows);
    const reads = (tenant: string | null) =>
      runtime.readSnapshot(
        async (snapshot) => {
          const schema = await snapshot.describe();
          const scoped = createScopedReads(schema, unfenced, POSTGRES_STYLE, async (statement) => {
            const result = await snapshot.client.query(statement.text, statement.params);
            return { columns: result.fields.map((field) => field.name), rows: result.rows, ms: 0, sql: statement };
          });
          const south = { groups: [[{ column: 'tenant_id', op: '=' as const, value: 'south' }]] };
          return {
            ids: (
              await scoped.query({
                table: ITEM,
                columns: ['id', 'tenant_id'],
                limit: 100,
                offset: 0,
                orderBy: [{ column: 'id', direction: 'asc' }],
              })
            ).rows,
            all: await scoped.count(ITEM),
            foreign: await scoped.count(ITEM, south),
            raw: Number((await snapshot.client.query(`SELECT count(*) AS n FROM ${ITEM}`)).rows[0]!.n),
          };
        },
        false,
        undefined,
        false,
        false,
        tenant,
      );
    try {
      const before = await wholeOf(owner);
      const north = before.filter((row) => row.tenant_id === 'north');
      const south = before.filter((row) => row.tenant_id === 'south');
      assert.ok(north.length && south.length, 'both tenants hold rows');

      const asNorth = await reads('north');
      assert.deepEqual(
        asNorth.ids.map((row) => (row as { id: string }).id),
        north.map((row) => row.id),
        "with no tenant condition in the statement, the policy alone leaves north's rows",
      );
      assert.equal(asNorth.all, north.length);
      assert.equal(asNorth.foreign, 0, "a statement that asks for south's rows by name gets none");
      assert.equal(asNorth.raw, north.length);

      /* The engine's scope says nothing of tenants; the transaction is north's. */
      const asNorthWrite = (run: Parameters<typeof runtime.scopeTransaction>[1]) =>
        runtime.scopeTransaction(unfenced, run, undefined, { tenant: 'north' });
      for (const forged of [
        (tx: Parameters<Parameters<typeof runtime.scopeTransaction>[1]>[0]) =>
          tx.insert({ table: ITEM, values: { id: 'b-forged', tenant_id: 'south', title: 'Forged' } }),
        (tx: Parameters<Parameters<typeof runtime.scopeTransaction>[1]>[0]) =>
          tx.update({ table: ITEM, key: { id: north[0]!.id as string }, values: { tenant_id: 'south' } }),
      ])
        await assert.rejects(asNorthWrite(forged), (error: unknown) => {
          assert.equal(sqlState(error), '42501', String(error));
          return true;
        });
      /* Another tenant's row is not there to change or delete: the write finds nothing, or is refused, and changes nothing. */
      for (const reach of [
        (tx: Parameters<Parameters<typeof runtime.scopeTransaction>[1]>[0]) =>
          tx.update({ table: ITEM, key: { id: south[0]!.id as string }, values: { title: 'Taken over' } }),
        (tx: Parameters<Parameters<typeof runtime.scopeTransaction>[1]>[0]) =>
          tx.remove({ table: ITEM, key: { id: south[0]!.id as string } }),
      ])
        await asNorthWrite(reach).catch(() => {});
      assert.deepEqual(await wholeOf(owner), before, "nothing of south's was changed, added or deleted");
    } finally {
      await Promise.all([runtime.close(), owner.close()]);
    }
  });

  test('with no tenant set, the runtime role sees nothing and the engine says so', async () => {
    const runtime = new PostgresAdapter(urlOf(ROLE.runtime), 'backstop unset', ['public'], undefined, undefined, {
      rowSecurity: { role: ROLE.runtime },
    });
    try {
      const counted = (tenant: string | null | undefined) =>
        runtime.readSnapshot(
          async (snapshot) => Number((await snapshot.client.query(`SELECT count(*) AS n FROM ${ITEM}`)).rows[0]!.n),
          false,
          undefined,
          false,
          false,
          tenant,
        );
      assert.equal(await counted(null), 0, 'deliberately none: the policy matches no row');
      assert.ok((await counted('north')) > 0);
      await assert.rejects(
        counted(undefined),
        /without a tenant under the row-security backstop/,
        'a path that forgot its tenant fails loudly',
      );
      /* The role itself, outside the engine: an unset setting is no tenant. */
      const raw = await as(ROLE.runtime);
      assert.equal(Number((await raw.query(`SELECT count(*) AS n FROM ${ITEM}`)).rows[0]!.n), 0);
    } finally {
      await runtime.close();
    }
  });

  test('`migrate backstop new` plans from the App and its policy, and `status` finds no drift once it is applied', async (t) => {
    if ((await version()) < 150000) return t.skip('the backstop needs PostgreSQL 15 or later');
    const admin = await as();
    for (const statement of [
      /* A tenant App's database holds only its own tables, and the start names any other as unowned: the earlier
         tests' tables go, as this is the last test of the file. */
      'DROP TABLE IF EXISTS public.item, public.mine, public.bsc_note, public.bsc_tag CASCADE',
      'DROP SCHEMA IF EXISTS mistri CASCADE',
      'CREATE TABLE public.bsc_note (id text PRIMARY KEY, tenant_id text NOT NULL, title text)',
      'CREATE TABLE public.bsc_tag (id text PRIMARY KEY, owner_key varchar(40) NOT NULL, label text)',
      `CREATE SCHEMA mistri AUTHORIZATION ${ROLE.owner}`,
      'CREATE TABLE mistri.bsc_store (id serial PRIMARY KEY, tenant_id text, body text)',
      /* The owner role owns every table, as it does where it migrated them: it alone reads their columns, and it
         applies the migration. */
      `ALTER TABLE public.bsc_note OWNER TO ${ROLE.owner}`,
      `ALTER TABLE public.bsc_tag OWNER TO ${ROLE.owner}`,
      `ALTER TABLE mistri.bsc_store OWNER TO ${ROLE.owner}`,
      `ALTER SEQUENCE mistri.bsc_store_id_seq OWNER TO ${ROLE.owner}`,
    ])
      await admin.query(statement);
    const directory = mkdtempSync(join(tmpdir(), 'mistri-backstop-cli-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const app = join(directory, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(app, 'app.json'),
      JSON.stringify({
        id: 'bsc',
        name: 'Backstop fixture',
        auth: {
          providers: ['email'],
          signUp: 'open',
          store: './auth.db',
          rows: 'tenant',
          roles: { member: { read: true, write: ['note'] } },
        },
        sources: { business: { connection: 'bsc-db' } },
        resources: {
          note: {
            physical: 'public.bsc_note',
            owner: 'tenant',
            access: 'write',
            fields: { read: ['id', 'title'], write: ['id', 'title'] },
          },
          tag: { physical: 'public.bsc_tag', owner: 'tenant', fields: { read: ['id', 'label'] } },
        },
        views: { notes: { kind: 'list', from: 'note' }, tags: { kind: 'list', from: 'tag' } },
        home: 'notes',
        nav: ['notes', 'tags'],
      }),
    );
    const policy = join(app, 'policy.mjs');
    writeFileSync(
      policy,
      `export default { kind: 'tenant', appId: 'bsc', storeId: 'bsc-store',
  ownership: { note: { kind: 'tenant', column: 'tenant_id' }, tag: { kind: 'tenant', column: 'owner_key' } },
  resolveMembershipRows: () => ({ note: true, tag: true }), resolveRows: () => ({ note: true, tag: true }) };`,
    );
    const config = join(directory, 'mistri.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [{ name: 'bsc-db', url: urlOf(ROLE.runtime), owner: urlOf(ROLE.owner), backstop: 'rls', writable: true }],
      }),
    );
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const error = console.error;
      console.error = (line: string) => void out.push(String(line));
      try {
        const code = await runMigrate(
          ['backstop', ...argv, '--app', app, '--config', config, '--policy', policy],
          (line) => out.push(line),
          undefined,
          MIGRATE_APPS,
        );
        return { code, text: out.join('\n') };
      } finally {
        console.error = error;
      }
    };
    const before = await run('status');
    assert.equal(before.code, 2, before.text);
    assert.match(before.text, /bsc_note lacks the policy mistri_tenant|bsc_note has row security off/);

    await admin.query('ALTER TABLE public.bsc_tag ALTER COLUMN owner_key TYPE integer USING 0');
    const mistyped = await run('new');
    assert.notEqual(mistyped.code, 0, mistyped.text);
    assert.match(mistyped.text, /must be text or varchar.*public\.bsc_tag\.owner_key is integer/);
    await admin.query('ALTER TABLE public.bsc_tag ALTER COLUMN owner_key TYPE text USING owner_key::text');

    /* --runtime names the role outright; it agrees here with the one the URL signs in as. */
    const made = await run('new', '--runtime', ROLE.runtime);
    assert.equal(made.code, 0, made.text);
    assert.match(made.text, new RegExp(`fenced for "${ROLE.runtime}"`));
    const file = readdirSync(join(app, 'migrations')).find((name) => name.endsWith('tenant_backstop.sql'))!;
    assert.ok(file, made.text);
    const sql = readFileSync(join(app, 'migrations', file), 'utf8');
    assert.match(sql, new RegExp(`CREATE POLICY mistri_tenant ON "public"\\."bsc_tag"[^;]*"owner_key" = NULLIF`));
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE [^;]*"mistri"\."bsc_store"/);
    assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE "mistri"\."bsc_store_id_seq"/);
    assert.doesNotMatch(sql, /PASSWORD '(?!<secret>)/);

    await (await as(ROLE.owner)).query(sql);
    const after = await run('status');
    assert.equal(after.code, 0, after.text);
    assert.match(after.text, /matches the plan/);

    await admin.query('CREATE POLICY sneaky ON public.bsc_note USING (true)');
    const drifted = await run('status');
    assert.equal(drifted.code, 2);
    assert.match(drifted.text, /extra policy "sneaky"/);
    await admin.query('DROP POLICY sneaky ON public.bsc_note');
    await admin.query('DROP TABLE public.bsc_note, public.bsc_tag CASCADE');
    await admin.query('DROP SCHEMA mistri CASCADE');
  });
});
