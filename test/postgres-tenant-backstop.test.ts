/**
 * The row-security backstop against a real server (docs/postgresql.md): the pair of roles a tenant App starts
 * with is attested before anything is served, and a runtime role the pinned policy binds sees one tenant's rows
 * and cannot write another's, even where the engine's own scope was talked into allowing it.
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
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { assertPostgresRuntimeOwnsNone, attestPostgresBackstopRoles } from '../packages/mistri/src/server/tenant/tenantPostgresCatalog.js';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { openBackstopOwnerReader } from '../packages/mistri/src/server/tenant/tenantBackstopOwner.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { sqliteSearch } from '../packs/search-sqlite/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
      await server.query(`GRANT CONNECT ON DATABASE "${DATABASE}" TO ${Object.values(ROLE).join(', ')}`);
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
      for (const role of [ROLE.member, ROLE.bypass, ROLE.runtime, ROLE.owner]) await server.query(`DROP ROLE IF EXISTS ${role}`);
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
});
