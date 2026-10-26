/**
 * The tenant read source, as a dialect matrix: every contract below runs on
 * SQLite and, live-gated by TABLEWALK_TEST_PG, on PostgreSQL
 * (support/tenantDialects.ts). Cases about a SQLite file — paths, TEMP
 * shadows, table kinds, the snapshot helpers — run on SQLite only, and the
 * PostgreSQL-only cases cover what that engine attests instead: collations,
 * ownership column types and other sessions' temporary tables.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test, type TestContext } from 'node:test';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { readSqliteReadCatalog, readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { TenantMembershipEvidence, TenantMembershipLookup } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  captureTenantReadSource,
  openPostgresTenantReadSource,
  openSqliteTenantReadSource,
  type TenantReadSource,
} from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import {
  assertSqliteTenantMembershipSnapshot,
  readSqliteTenantMembership,
  readSqliteTenantMembershipSnapshot,
  TENANT_TABLES as tables,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  assertPostgresTenantMembershipSnapshot,
  readPostgresTenantMembership,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import { CATALOG } from './support/statements.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import {
  CASE_INSENSITIVE,
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  TENANT_DIALECTS,
  type TenantDialect,
} from './support/tenantDialects.js';
import { runtimeName } from '../packages/engine/src/shared/runtimeTables.js';

const owner = () => ({ appId: 'app', source: { id: 'business', connection: 'owned-source' }, storeId: 'store-1' });
const lookup = (): TenantMembershipLookup => ({
  appId: 'app',
  source: owner().source,
  accountId: 'alice',
  tenantId: 'north',
  deployment: 'generation-1',
});
const grant = () => ({
  tenantId: 'north',
  accountId: 'alice',
  membershipId: 'grant-1',
  status: 'active' as const,
  roles: ['reviewer'],
  validUntil: 10_000,
  expectedVersion: null,
});
const allow: RowScope = { item: true, person: true, note: true, country: true };
const view = (patch: Partial<ViewDef> = {}): ViewDef => ({
  id: 'items',
  name: 'Items',
  base: 'item',
  columns: [{ path: 'id' }],
  orderBy: [{ path: 'id', direction: 'asc' }],
  limit: 100,
  ...patch,
});
const breakdown = (patch: Partial<BreakdownDef> = {}): BreakdownDef => ({
  base: 'item',
  by: [{ path: 'status' }],
  measures: [
    { fn: 'count', alias: 'n' },
    { fn: 'sum', path: 'amount', alias: 'total' },
  ],
  orderBy: [{ name: 'status', direction: 'asc' }],
  limit: 100,
  ...patch,
});
const secret = 'PRIVATE_READ_SOURCE_SENTINEL';
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
/** Hold the first source data statement and observe the second. The control
 * connection never uses PgConnectionManager, so only tenant-source readers
 * reach this wrapper. */
function postgresDataBarrier(t: TestContext) {
  const first = deferred(),
    second = deferred(),
    release = deferred();
  let calls = 0;
  const original = PgConnectionManager.prototype.withReadClient;
  const mock = t.mock.method(PgConnectionManager.prototype, 'withReadClient', function <
    T,
  >(this: PgConnectionManager, run: (client: PgQuery) => Promise<T>, destroyAfter = false, drainCancelled = false): Promise<T> {
    const lease = original.bind(this) as <Result>(
      callback: (client: PgQuery) => Promise<Result>,
      destroy?: boolean,
      drain?: boolean,
    ) => Promise<Result>;
    return lease(
      (client) =>
        run(
          Object.freeze({
            query: ((text: string, values?: unknown[]) => {
              const data = text.includes('FROM "public"."db_item"');
              if (!data) return client.query(text, values);
              calls += 1;
              if (calls === 1) {
                first.resolve();
                return release.promise.then(() => client.query(text, values));
              }
              if (calls === 2) second.resolve();
              return client.query(text, values);
            }) as PgQuery['query'],
          }),
        ),
      destroyAfter,
      drainCancelled,
    );
  });
  return { first: first.promise, second: second.promise, release: release.resolve, restore: () => mock.mock.restore() };
}
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  return true;
}
const denied = (work: () => unknown) => assert.rejects(async () => work(), safe);

/* The same rows on both engines. SQLite folds the ownership columns with
   NOCASE/RTRIM so only COLLATE BINARY separates 'North' and 'north ' from
   'north'; PostgreSQL's ownership columns are plain text, where they are
   simply other values. Either way exactly three items are north's. */
const SCHEMA = {
  tables: ['db_note', 'db_item', 'db_person', 'db_country', 'unknown_business'],
  sqlite: `PRAGMA foreign_keys = ON;
    CREATE TABLE db_country(code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_person(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE RTRIM, name TEXT NOT NULL);
    CREATE TABLE db_item(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL COLLATE NOCASE,
      owner_id INTEGER REFERENCES db_person(id), country_code TEXT REFERENCES db_country(code),
      status TEXT NOT NULL, amount INTEGER NOT NULL, huge INTEGER, payload BLOB, enabled BOOLEAN);
    CREATE TABLE db_note(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE NOCASE, item_id INTEGER REFERENCES db_item(id), amount INTEGER);
    INSERT INTO db_country VALUES ('us','USA'), ('ca','Canada');
    INSERT INTO db_person VALUES (1,'north','Visible'), (2,'North','Hidden case'), (3,'north ','Hidden padding'), (4,'south','Hidden south');
    INSERT INTO db_item VALUES (1,'north',1,'us','open',10,9007199254740993,X'00ff',1),
      (2,'north',2,'ca','closed',20,1,NULL,0), (3,'North',1,'us','open',900,1,NULL,1),
      (4,'north ',1,'us','open',900,1,NULL,1), (5,'south',4,'us','open',900,1,NULL,1),
      (6,'north',3,'us','closed',30,1,NULL,1);
    INSERT INTO db_note VALUES (1,'north',1,5), (2,'North',1,900), (3,'north ',1,900), (4,'south',1,900), (5,'north',3,800);`,
  postgres: `
    CREATE TABLE public.db_country(code text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.db_person(id integer PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.db_item(id integer PRIMARY KEY, tenant_id text NOT NULL,
      owner_id integer REFERENCES public.db_person(id), country_code text REFERENCES public.db_country(code),
      status text NOT NULL, amount integer NOT NULL, huge bigint, payload bytea, enabled boolean);
    CREATE TABLE public.db_note(id integer PRIMARY KEY, tenant_id text NOT NULL, item_id integer REFERENCES public.db_item(id), amount integer);
    INSERT INTO public.db_country VALUES ('us','USA'), ('ca','Canada');
    INSERT INTO public.db_person VALUES (1,'north','Visible'), (2,'North','Hidden case'), (3,'north ','Hidden padding'), (4,'south','Hidden south');
    INSERT INTO public.db_item VALUES (1,'north',1,'us','open',10,9007199254740993,decode('00ff','hex'),true),
      (2,'north',2,'ca','closed',20,1,NULL,false), (3,'North',1,'us','open',900,1,NULL,true),
      (4,'north ',1,'us','open',900,1,NULL,true), (5,'south',4,'us','open',900,1,NULL,true),
      (6,'north',3,'us','closed',30,1,NULL,true);
    INSERT INTO public.db_note VALUES (1,'north',1,5), (2,'North',1,900), (3,'north ',1,900), (4,'south',1,900), (5,'north',3,800);`,
};

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `read_source_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, { ...SCHEMA, database: DATABASE });
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    await Promise.allSettled(sources.map((source) => source.close()));
    await engine.close();
  });
  const administer = (run: (admin: TenantStoreAdministration) => Promise<void>) => engine.maintenance(owner(), run);
  await engine.provisionStore(owner());
  await administer(async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: null });
    await admin.putMembership(grant());
    await admin.putMembership({ ...grant(), tenantId: 'south', membershipId: 'grant-2' });
  });
  const resources = {
    item: engine.id('db_item'),
    person: engine.id('db_person'),
    note: engine.id('db_note'),
    country: engine.id('db_country'),
  };
  const physicalSchema = await engine.physicalSchema();
  const logical = mapScopeCatalog(physicalSchema, new Map(Object.entries(resources).map(([id, name]) => [name, id])));
  const ownership = captureTenantOwnership({
    appId: 'app',
    source: owner().source,
    physicalSchema,
    schema: { ...logical, tables: logical.tables.map((table) => ({ ...table, name: table.id, schema: '' })) },
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      person: { kind: 'tenant', column: 'tenant_id' },
      note: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
  const open = async (now: () => number = () => 100, expected: TenantOwnershipSnapshot = ownership, trustFor?: number) => {
    const source = await engine.openRead(expected, owner(), now, trustFor);
    sources.push(source);
    return source;
  };
  const evidence = async (query = lookup()): Promise<TenantMembershipEvidence> => {
    const record = await engine.readMembership(owner(), query);
    assert.ok(record);
    return {
      ...query,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      tenantVersion: record.tenantVersion,
      roles: [...record.roles],
      verifiedAt: 50,
      validUntil: 1000,
    };
  };
  const count = async (sql: string) => Number((await engine.get(`SELECT CAST(count(*) AS INTEGER) AS n FROM ${sql}`))?.n);
  return { engine, dialect, resources, ownership, open, evidence, administer, count };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`tenant read source on ${dialect}`, { skip }, () => {
    const postgres = dialect === 'postgres';

    test('genuine source is frozen, pinned and exposes only ownership, admission checks, scoped reads and close', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      assert.equal(captureTenantReadSource(source), source);
      assert.equal(Object.isFrozen(source), true);
      assert.equal(Object.isFrozen(source.ownership), true);
      /* `assertSupportCurrent`/`scopeSupportReads` (0.5.0): the support session's
       pair, beside the member's and the platform realm's. Fenced on the support
       row rather than a membership, reading the dealer's own scope.
       `readTenantNames`: what the chooser calls each tenant, from its profile row.
       `readDueTimers`: a machine timer's due records across the active tenants, each with its row's tenant.
       `assertPublicCurrent`/`bindPublicReads`/`resolvePublic`: a public page's reads; `readTenantAddresses`: a tenant's
       own addresses (G75); `readSandboxes`/`readSandboxClocks`: which tenants are sandboxes, and their clocks (G47). */
      assert.deepEqual(Object.keys(source).sort(), [
        'assertCurrent',
        'assertPlatformCurrent',
        'assertPublicCurrent',
        'assertSupportCurrent',
        'bindPlatformReads',
        'bindPublicReads',
        'bindReads',
        'close',
        'ownership',
        'readActiveTenants',
        'readBranding',
        'readBrandingLogo',
        'readDueTimers',
        'readInbox',
        'readMembership',
        'readMemberships',
        'readPlatformMembership',
        'readRecordActivity',
        'readRecordHistory',
        'readSandboxClocks',
        'readSandboxes',
        'readServiceAnchors',
        'readTenantAddresses',
        'readTenantNames',
        'resolveIntake',
        'resolvePublic',
        'scopePlatformReads',
        'scopeReads',
        'scopeSupportReads',
        'withPlatformReads',
        'withReads',
      ]);
      /* Frozen and checked, so the source may keep the caller's own snapshot rather than a copy of it (G118):
         what it holds is the same declaration, and nobody can change it. */
      assert.deepEqual(source.ownership, f.ownership);
      assert.equal(
        Reflect.set(source, 'readMembership', () => assert.fail('substitution')),
        false,
      );
      const reads = await source.scopeReads(await f.evidence(), allow);
      assert.equal(Object.isFrozen(reads), true);
      assert.deepEqual(Object.keys(reads).sort(), ['count', 'countBreakdown', 'countView', 'query', 'runBreakdown', 'runView']);
      assert.equal('db' in source || 'transaction' in source || 'runSql' in reads || 'scopeReads' in reads, false);
    });

    test('source capture refuses forged, inherited, accessor, revoked and wrapped instances without executing traps', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let traps = 0;
      const trap = (): never => {
        traps++;
        throw new Error(secret);
      };
      const revoked = Proxy.revocable(source, {});
      revoked.revoke();
      for (const value of [
        null,
        {},
        { ...source },
        Object.create(source),
        Object.defineProperty({}, 'ownership', { get: trap }),
        revoked.proxy,
        new Proxy(source, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }),
      ]) {
        await denied(() => captureTenantReadSource(value as TenantReadSource));
      }
      assert.equal(traps, 0);
    });

    test('source agrees with the ordinary adapter introspection, dropping only engine internals', async (t) => {
      const f = await fixture(t, dialect),
        physicalSchema = await f.engine.introspect();
      const logical = appResourceCatalog(physicalSchema, f.resources);
      const owned = captureTenantOwnership({ ...f.ownership, physicalSchema, schema: logical.schema });
      const source = await f.open(() => 100, owned);
      assert.equal(
        source.ownership.physicalSchema.tables.some((table) => table.id.startsWith('sqlite_')),
        false,
      );
      assert.equal(
        source.ownership.physicalSchema.tables.some((table) => table.id === f.engine.id(tables.membership)),
        // PostgreSQL keeps the runtime tables in a schema the catalog never lists.
        dialect !== 'postgres',
      );
      assert.equal(await (await source.scopeReads(await f.evidence(), allow)).count('item'), 3);
    });

    test('six logical methods retain exact tenant predicates for rows, counts, joins and reverse aggregates', async (t) => {
      const f = await fixture(t, dialect),
        reads = await (await f.open()).scopeReads(await f.evidence(), allow);
      const result = await reads.query({
        table: 'item',
        columns: ['id', 'huge', 'payload'],
        limit: 100,
        offset: 0,
        orderBy: [{ column: 'id', direction: 'asc' }],
      });
      // int8 — a bigint column, and every count and integer sum — arrives from
      // PostgreSQL as its exact decimal text, never a rounded number.
      const big = (value: number) => (postgres ? String(value) : value);
      assert.deepEqual(result.rows, [
        { id: 1, huge: '9007199254740993', payload: '<2 bytes>' },
        { id: 2, huge: big(1), payload: null },
        { id: 6, huge: big(1), payload: null },
      ]);
      assert.equal(await reads.count('item'), 3);
      assert.equal(await reads.count('person'), 1);
      assert.equal(await reads.count('item', { groups: [[{ column: 'enabled', op: '=', value: true }]] }), 2);
      const via = f.ownership.schema.foreignKeys.find((fk) => fk.from.table === 'note')!.name;
      const def = view({
        columns: [{ path: 'id' }, { path: 'owner_id.name', alias: 'owner' }, { path: 'country_code.name', alias: 'country' }],
        aggregates: [{ fn: 'count', via, alias: 'notes' }],
      });
      const seen = await reads.runView(def);
      assert.deepEqual(seen.rows, [
        { id: 1, owner: 'Visible', country: 'USA', notes: big(1) },
        { id: 2, owner: null, country: 'Canada', notes: big(0) },
        { id: 6, owner: null, country: 'USA', notes: big(0) },
      ]);
      assert.ok(seen.joins.every((join) => ['item', 'person', 'country', 'note'].includes(join.table)));
      assert.equal(await reads.countView(def), 3);
      assert.deepEqual((await reads.runBreakdown(breakdown())).rows, [
        { status: 'closed', n: big(2), total: big(50) },
        { status: 'open', n: big(1), total: big(10) },
      ]);
      assert.equal(await reads.countBreakdown(breakdown()), 2);
    });

    /* A column the database computes from its row reads like any other under the tenant's predicate, as it does
       under a row policy: the table is not refused for holding one, and the catalog says nothing writes it. */
    test('a tenant table with a generated column is read, the column described as one nothing writes', async (t) => {
      const f = await fixture(t, dialect);
      await f.engine.exec(
        postgres
          ? `CREATE TABLE public.db_line(id integer PRIMARY KEY, tenant_id text NOT NULL, net integer NOT NULL,
               gross integer GENERATED ALWAYS AS (net * 2) STORED);
             INSERT INTO public.db_line(id, tenant_id, net) VALUES (1,'north',21), (2,'south',900)`
          : `CREATE TABLE db_line(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE NOCASE, net INTEGER NOT NULL,
               gross INTEGER GENERATED ALWAYS AS (net * 2) STORED, half INTEGER AS (net / 2));
             INSERT INTO db_line(id, tenant_id, net) VALUES (1,'north',21), (2,'south',900)`,
      );
      const physicalSchema = await f.engine.physicalSchema();
      const resources = { ...f.resources, line: f.engine.id('db_line') };
      const logical = mapScopeCatalog(physicalSchema, new Map(Object.entries(resources).map(([id, name]) => [name, id])));
      const owned = captureTenantOwnership({
        ...f.ownership,
        physicalSchema,
        resources,
        schema: { ...logical, tables: logical.tables.map((table) => ({ ...table, name: table.id, schema: '' })) },
        ownership: { ...f.ownership.ownership, line: { kind: 'tenant', column: 'tenant_id' } },
      });
      const line = owned.schema.tables.find((table) => table.id === 'line')!;
      assert.equal(line.columns.find((column) => column.name === 'gross')?.writable, false);
      assert.notEqual(line.columns.find((column) => column.name === 'net')?.writable, false);
      const reads = await (await f.open(() => 100, owned)).scopeReads(await f.evidence(), { ...allow, line: true });
      const computed = postgres ? ['gross'] : ['gross', 'half'];
      const rows = await reads.query({ table: 'line', columns: ['id', 'net', ...computed], limit: 10, offset: 0 });
      assert.deepEqual(rows.rows, [postgres ? { id: 1, net: 21, gross: 42 } : { id: 1, net: 21, gross: 42, half: 10 }]);
      assert.equal(await reads.count('line', { groups: [[{ column: 'gross', op: '=', value: 42 }]] }), 1);
    });

    test('source reapplies tenant ceilings to all-true input and intersects every caller OR branch', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      const rows: RowScope = {
        ...allow,
        item: { groups: [[{ column: 'status', op: '=', value: 'open' }], [{ column: 'amount', op: '>', value: 25 }]] },
      };
      const reads = await source.scopeReads(await f.evidence(), rows);
      assert.deepEqual(
        (await reads.query({ table: 'item', columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' }] })).rows,
        [{ id: 1 }, { id: 6 }],
      );
      const none = await source.scopeReads(await f.evidence(), {});
      assert.equal(await none.count('item'), 0);
      assert.equal(await none.count('country'), 0);
      const deniedParent = await source.scopeReads(await f.evidence(), { ...allow, person: false });
      assert.deepEqual((await deniedParent.runView(view({ columns: [{ path: 'owner_id.name', alias: 'owner' }] }))).rows, [
        { owner: null },
        { owner: null },
        { owner: null },
      ]);
    });

    for (const id of [
      'db_item',
      'business.item',
      'owned-source.item',
      tables.membership,
      'sqlite_sequence',
      secret,
      ...(postgres ? ['public.db_item', `public.${tables.membership}`] : []),
    ]) {
      test(`physical/private/source alias ${id} never becomes a logical reader grant`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          reads = await source.scopeReads(await f.evidence(), allow);
        await denied(() => reads.count(id));
        await denied(async () => source.scopeReads(await f.evidence(), { ...allow, [id]: true }));
      });
    }

    if (!postgres)
      test('existing-file construction refuses a missing file or a directory without creating either', async (t) => {
        const f = await fixture(t, dialect),
          directory = join(f.engine.path, '..'),
          missing = join(directory, 'missing.db');
        await denied(() => openSqliteTenantReadSource(missing, f.ownership, owner()));
        await denied(() => openSqliteTenantReadSource(directory, f.ownership, owner()));
        assert.equal(existsSync(missing), false);
      });

    if (postgres)
      test('a URL naming no database refuses, and a non-PostgreSQL URL is never dialled', async (t) => {
        const f = await fixture(t, dialect),
          absent = new URL(f.engine.url);
        absent.pathname = '/mistri_tenant_absent_database';
        await denied(() => openPostgresTenantReadSource(absent.toString(), f.ownership, owner()));
        await denied(() => openPostgresTenantReadSource(f.engine.path || 'business.db', f.ownership, owner()));
      });

    test('construction refuses wrong namespace and wrong-source inputs, and a missing store, without migration', async (t) => {
      const f = await fixture(t, dialect);
      for (const changed of [
        { ...owner(), appId: 'other' },
        { ...owner(), storeId: 'other' },
        { ...owner(), source: { ...owner().source, id: 'other' } },
        { ...owner(), source: { ...owner().source, connection: 'other' } },
      ]) {
        await denied(() => f.engine.openRead(f.ownership, changed));
      }
      await f.engine.exec(`DROP TABLE "${tables.membership}"`);
      await denied(() => f.open());
      assert.deepEqual(await f.engine.layout(tables.membership), []);
    });

    test('actual catalog mismatch at construction cannot adopt a different business schema', async (t) => {
      const f = await fixture(t, dialect);
      await f.engine.exec('ALTER TABLE db_item ADD COLUMN private_extra TEXT');
      await denied(() => f.open());
      assert.deepEqual(await f.engine.all('SELECT private_extra FROM db_item WHERE 1 = 0'), []);
    });

    for (const [name, sql] of [
      ['business column', 'ALTER TABLE db_item ADD COLUMN private_extra TEXT'],
      ['unknown table', 'CREATE TABLE unknown_business(id INTEGER)'],
      [
        'private dependency',
        postgres
          ? 'CREATE TABLE mistri.future(id INTEGER, item_id INTEGER REFERENCES public.db_item(id))'
          : 'CREATE TABLE __mistri_future(id INTEGER, item_id INTEGER REFERENCES db_item(id))',
      ],
      [
        'store trigger',
        postgres
          ? `CREATE TRIGGER hidden AFTER UPDATE ON "${tables.meta}" FOR EACH ROW EXECUTE FUNCTION tablewalk_fixture_noop()`
          : `CREATE TRIGGER hidden AFTER UPDATE ON "${tables.meta}" BEGIN SELECT '${secret}'; END`,
      ],
      // PostgreSQL reads a store's binding when a source opens (postgresStoreFence.ts): below.
      ...(postgres ? [] : ([['store namespace', `UPDATE "${tables.meta}" SET store_id = 'other'`]] as const)),
      ['store DDL', `ALTER TABLE "${tables.membership}" ADD COLUMN extra TEXT`],
      ...(postgres
        ? [
            ['policy column collation', `ALTER TABLE db_item ALTER COLUMN status TYPE text COLLATE ${CASE_INSENSITIVE}`],
            ['business trigger', 'CREATE TRIGGER hidden AFTER UPDATE ON db_note FOR EACH ROW EXECUTE FUNCTION tablewalk_fixture_noop()'],
            ['business index', 'CREATE INDEX hidden ON db_item (status)'],
          ]
        : []),
    ] as const)
      test(`every pinned read reattests ${name} changes made on a separate writer`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          member = await f.evidence(),
          reads = await source.scopeReads(member, allow);
        await f.engine.exec(sql);
        await denied(() => source.readMembership(lookup()));
        await denied(() => source.assertCurrent(member));
        await denied(() => source.scopeReads(member, allow));
        await denied(() => reads.query({ table: 'item', limit: 100, offset: 0 }));
        await denied(() => reads.count('item'));
        await denied(() => reads.runView(view()));
        await denied(() => reads.countView(view()));
        await denied(() => reads.runBreakdown(breakdown()));
        await denied(() => reads.countBreakdown(breakdown()));
      });

    /* PostgreSQL attests a snapshot from a digest of the catalog rows its full
     attestation reads, and repeats the full one only when the digest moves
     (tenantPostgresCatalog.ts). Every case here first primes that digest with
     a read, then changes one thing the full attestation would refuse, and
     must be refused on the next snapshot: a digest that missed the change
     would read on through a catalog nobody attested. Each undoes what the
     fixture's reset does not. */
    if (postgres)
      for (const [name, sql, undo] of [
        ['column default', `ALTER TABLE db_item ALTER COLUMN status SET DEFAULT 'open'`, ''],
        ['column rename', 'ALTER TABLE db_note RENAME COLUMN amount TO total', ''],
        [
          'table in another schema',
          'CREATE SCHEMA tenant_elsewhere; CREATE TABLE tenant_elsewhere.hidden(id integer)',
          'DROP SCHEMA IF EXISTS tenant_elsewhere CASCADE',
        ],
        ['view', 'CREATE VIEW db_item_view AS SELECT id FROM db_item', ''],
        ['row security', 'ALTER TABLE db_item ENABLE ROW LEVEL SECURITY', ''],
        ['row policy', 'CREATE POLICY hidden ON db_item USING (true)', ''],
        ['store grant to PUBLIC', `GRANT SELECT ON "${tables.membership}" TO PUBLIC`, ''],
      ] as const)
        test(`a cached catalog attestation still refuses a ${name} made after it`, async (t) => {
          const f = await fixture(t, dialect),
            source = await f.open(),
            member = await f.evidence();
          const reads = await source.scopeReads(member, allow);
          assert.equal(await reads.count('item'), 3, 'primed: a read attested from the digest');
          try {
            await f.engine.exec(sql);
            await denied(() => reads.count('item'));
            await denied(() => source.assertCurrent(member));
            await denied(() => source.readMembership(lookup()));
          } finally {
            if (undo) await f.engine.exec(undo);
          }
        });

    /* A store's binding is data, not catalog: PostgreSQL reads it when a source
       opens, not in every snapshot. A source open before the change reads on; the
       next one to open refuses. */
    if (postgres)
      for (const [name, sql] of [
        ['namespace', `UPDATE "${tables.meta}" SET store_id = 'other'`],
        ['meta binding', `UPDATE "${tables.meta}" SET app_id = 'other'`],
      ] as const)
        test(`a store ${name} changed after a source opened is refused by the next source to open`, async (t) => {
          const f = await fixture(t, dialect),
            source = await f.open(),
            member = await f.evidence();
          await f.engine.exec(sql);
          await source.assertCurrent(member);
          await denied(() => f.open());
        });

    if (postgres)
      test('a cached catalog attestation reads without describing the catalog again, and redescribes once after unrelated DDL', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          member = await f.evidence();
        const reads = await source.scopeReads(member, allow);
        const seen: string[] = [];
        const watch = f.engine.intercept(t, {
          match: (statement) => {
            seen.push(statement.sql);
            return false;
          },
        });
        const described = () => seen.filter((sql) => /information_schema\.columns/.test(sql)).length;
        try {
          assert.equal(await reads.count('item'), 3);
          await source.assertCurrent(member);
          assert.equal(described(), 0, 'an unchanged catalog is not described again');
          assert.equal(seen.filter((sql) => /SAVEPOINT mistri_tenant_store/.test(sql)).length, 0, 'nor is the store attested again');
          // Not authority, and not a reason to refuse: ANALYZE updates pg_class in place.
          await f.engine.exec("ANALYZE db_item; COMMENT ON TABLE db_item IS 'still the same table'");
          assert.equal(await reads.count('item'), 3);
          assert.equal(described(), 0, 'ANALYZE and a comment leave the digest where it was');
          // A function and a type move the digest, and pass the full attestation that sends the next read to.
          await f.engine.exec(`CREATE FUNCTION public.tenant_unrelated() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        CREATE TYPE public.tenant_mood AS ENUM ('calm')`);
          assert.equal(await reads.count('item'), 3);
          assert.equal(described(), 1, 'described once after the digest moved');
          assert.equal(await reads.count('item'), 3);
          assert.equal(described(), 1, 'and attested from the digest again after that');
        } finally {
          watch.restore();
          await f.engine.exec('DROP FUNCTION IF EXISTS public.tenant_unrelated(); DROP TYPE IF EXISTS public.tenant_mood');
        }
      });

    if (postgres)
      test('a refused catalog change, reverted, reads again: the digest never remembers a refusal', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          member = await f.evidence();
        const reads = await source.scopeReads(member, allow);
        await f.engine.exec('CREATE INDEX hidden ON db_item (status)');
        await denied(() => reads.count('item'));
        await f.engine.exec('DROP INDEX hidden');
        assert.equal(await reads.count('item'), 3);
      });

    /* The digest walks every catalog row, and read in every snapshot it was
     three quarters of a tenant database's statement time. So an
     attestation stands for `trustFor` (five seconds when a server opens the
     source): a snapshot begun within it asks the catalog nothing, and the
     first one after it reads the digest again, which refuses what the full
     attestation would. */
    if (postgres) {
      test('within the trust window a warm read asks the catalog nothing', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(undefined, undefined, 60_000),
          member = await f.evidence();
        const reads = await source.scopeReads(member, allow);
        assert.equal(await reads.count('item'), 3, 'attested once');
        const seen: string[] = [];
        const watch = f.engine.intercept(t, {
          match: (statement) => {
            seen.push(statement.sql);
            return false;
          },
        });
        try {
          assert.equal(await reads.count('item'), 3);
          await source.assertCurrent(member);
          assert.equal((await source.readMembership(lookup()))?.membershipId, 'grant-1');
          assert.ok(seen.length > 0, 'the reads were seen');
          assert.deepEqual(
            seen.filter((sql) => CATALOG.test(sql)),
            [],
            'no catalog statement: the snapshots begin with the LOCK alone',
          );
        } finally {
          watch.restore();
        }
      });

      test('after the trust window a change made within it is refused', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(undefined, undefined, 150),
          member = await f.evidence();
        const reads = await source.scopeReads(member, allow);
        assert.equal(await reads.count('item'), 3);
        await f.engine.exec('ALTER TABLE db_item ENABLE ROW LEVEL SECURITY');
        await new Promise((done) => setTimeout(done, 200));
        await denied(() => reads.count('item'));
        await denied(() => source.assertCurrent(member));
      });

      test('a read that fails on a column that moved forgets the attestation at once, within the window', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(undefined, undefined, 60_000),
          member = await f.evidence();
        const reads = await source.scopeReads(member, allow);
        const request = {
          table: 'note',
          columns: ['id', 'amount'],
          limit: 10,
          offset: 0,
          orderBy: [{ column: 'id', direction: 'asc' as const }],
        };
        await reads.query(request);
        await f.engine.exec('ALTER TABLE db_note RENAME COLUMN amount TO total');
        await assert.rejects(() => reads.query(request));
        await denied(() => reads.count('item'));
      });
    }

    test(
      postgres
        ? "another session's temporary tables are not part of the pinned source"
        : 'a separate connection TEMP schema cannot shadow the pinned source',
      async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          member = await f.evidence();
        await f.engine.exec(
          postgres
            ? `CREATE TEMP TABLE db_item AS SELECT * FROM public.db_item;
      CREATE TEMP TABLE "${runtimeName('postgres', tables.membership)}"(id text)`
            : `CREATE TEMP TABLE DB_ITEM AS SELECT * FROM main.db_item;
      CREATE TEMP TABLE "${tables.membership}"(id TEXT);
      CREATE TEMP TRIGGER hostile AFTER UPDATE ON main."${tables.meta}" BEGIN SELECT 1; END`,
        );
        assert.equal((await source.readMembership(lookup()))?.membershipId, 'grant-1');
        assert.equal(await (await source.scopeReads(member, allow)).count('item'), 3);
        if (postgres) assert.equal((await f.open()).ownership.appId, 'app', 'a fresh source opens beside them too');
      },
    );

    test('membership revision, revocation, regrant identity and case changes invalidate retained readers', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        member = await f.evidence(),
        reads = await source.scopeReads(member, allow);
      for (const patch of [
        { accountId: 'Alice' },
        { tenantId: 'North' },
        { membershipId: 'Grant-1' },
        { membershipVersion: '2' },
        { tenantVersion: '2' },
        { roles: ['manager'] },
        { deployment: '' },
      ]) {
        await denied(() => source.assertCurrent({ ...member, ...patch }));
      }
      await f.administer(async (admin) => {
        await admin.putMembership({ ...grant(), status: 'revoked', expectedVersion: '1' });
      });
      assert.equal(await source.readMembership(lookup()), null);
      await denied(() => reads.count('item'));
      await f.administer(async (admin) => {
        await admin.putMembership({ ...grant(), membershipId: 'reinvited' });
      });
      await denied(() => source.assertCurrent(member));
      await source.assertCurrent(await f.evidence());
    });

    /* bindReads is scopeReads without the snapshot that checks the membership
     first. What must not change is that no row is read on evidence the
     reading snapshot did not find current. */
    test('bindReads opens no snapshot, reads what scopeReads reads, and every read revalidates the membership', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        member = await f.evidence();
      const snapshots: string[] = [];
      const watch = f.engine.intercept(t, {
        match: (statement) => {
          snapshots.push(statement.sql);
          return false;
        },
      });
      const lazy = await source.bindReads(member, allow);
      assert.equal(snapshots.length, 0, 'binding reads nothing');
      watch.restore();
      const eager = await source.scopeReads(member, allow);
      const request = { table: 'item', columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' as const }] };
      assert.deepEqual((await lazy.query(request)).rows, (await eager.query(request)).rows);
      assert.equal(await lazy.count('item'), 3);
      // Bound on a membership that is then revoked: the next read refuses.
      await f.administer(async (admin) => {
        await admin.putMembership({ ...grant(), status: 'revoked', expectedVersion: '1' });
      });
      await denied(() => lazy.count('item'));
      await denied(() => lazy.query(request));
      // Bound on evidence already stale: the reader is handed out, and reads nothing.
      const stale = await source.bindReads(member, allow);
      await denied(() => stale.count('item'));
      await denied(() => source.bindReads({ ...member, tenantId: 'North' }, allow).then((reads) => reads.count('item')));
    });

    /* withReads is several reads in one snapshot, for availability's advice
     (tenantCommandAvailability.ts): the membership revalidated once in it,
     the same tenant scope, nothing read after it returns, and the caller's
     own refusal kept as its own. */
    test('withReads reads in one snapshot under the tenant scope, revalidated once, and nothing after it', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        member = await f.evidence();
      const request = { table: 'item', columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' as const }] };
      const eager = await source.scopeReads(member, allow);
      const snapshots: string[] = [];
      const watch = f.engine.intercept(t, {
        match: (statement) => {
          if (/^\s*BEGIN/i.test(statement.sql)) snapshots.push(statement.sql);
          return false;
        },
      });
      let escaped: Awaited<ReturnType<typeof source.scopeReads>> | undefined;
      const read = await source.withReads(member, allow, async (reads) => {
        escaped = reads;
        return { rows: (await reads.query(request)).rows, count: await reads.count('item'), notes: await reads.count('note') };
      });
      watch.restore();
      if (postgres) assert.equal(snapshots.length, 1, 'one snapshot for every read in the batch');
      assert.deepEqual(read.rows, (await eager.query(request)).rows);
      assert.equal(read.count, 3);
      assert.equal(read.notes, await eager.count('note'));
      await denied(() => escaped!.count('item'));
      // The caller's own error is its own, not the source's refusal.
      const own = new Error('the caller refused');
      await assert.rejects(
        source.withReads(member, allow, async () => {
          throw own;
        }),
        (error) => error === own,
      );
      // Revoked, or another tenant's spelling: the batch reads nothing.
      await denied(() => source.withReads({ ...member, tenantId: 'North' }, allow, (reads) => reads.count('item')));
      await f.administer(async (admin) => {
        await admin.putMembership({ ...grant(), status: 'revoked', expectedVersion: '1' });
      });
      let ran = false;
      await denied(() =>
        source.withReads(member, allow, async (reads) => {
          ran = true;
          return reads.count('item');
        }),
      );
      assert.equal(ran, false, 'the work is not run on evidence the snapshot did not find current');
    });

    if (postgres)
      test('PostgreSQL source detaches its ownership declaration before later reads', async (t) => {
        const f = await fixture(t, dialect);
        const supplied = structuredClone(f.ownership);
        const source = await f.open(() => 100, supplied);
        /* These are the caller's former declaration, never a mutable policy that
       a source may adopt after it passed construction. */
        Reflect.set(supplied.resources, 'item', 'public.db_person');
        Reflect.set(supplied.ownership, 'item', { kind: 'global', access: 'read-only' });
        Reflect.set(supplied.physicalSchema.tables[0], 'schema', 'other');
        const reads = await source.scopeReads(await f.evidence(), allow);
        assert.equal(await reads.count('item'), 3, 'the captured tenant policy still fences the source');
      });

    test('source snapshots inputs and never mix tenant rows', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        north = await f.evidence(),
        south = await f.evidence({ ...lookup(), tenantId: 'south' });
      const rows: RowScope = { ...allow },
        requested = { ...north };
      const pending = source.scopeReads(requested, rows);
      requested.tenantId = 'south';
      Reflect.set(rows, 'item', false);
      const northReads = await pending,
        southReads = await source.scopeReads(south, allow);
      const request = { table: 'item', columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' as const }] };
      const first = northReads.query(request);
      request.table = tables.membership;
      request.columns.push(secret);
      assert.deepEqual((await first).rows, [{ id: 1 }, { id: 2 }, { id: 6 }]);
      assert.deepEqual(
        await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? northReads.count('item') : southReads.count('item')))),
        [1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3],
      );
    });

    if (postgres)
      test('independent PostgreSQL reads lease separate snapshots instead of waiting behind one source reader', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          reads = await source.scopeReads(await f.evidence(), allow);
        const barrier = postgresDataBarrier(t);
        const first = reads.query({ table: 'item', columns: ['id'], limit: 100, offset: 0 });
        try {
          await barrier.first;
          const second = reads.count('item');
          await barrier.second;
          barrier.release();
          assert.deepEqual((await first).rows, [{ id: 1 }, { id: 2 }, { id: 6 }]);
          assert.equal(await second, 3);
        } finally {
          barrier.release();
          barrier.restore();
        }
      });

    if (postgres)
      test('close drains an in-flight PostgreSQL snapshot before ending its reader pool', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          reads = await source.scopeReads(await f.evidence(), allow);
        const barrier = postgresDataBarrier(t);
        const reading = reads.query({ table: 'item', columns: ['id'], limit: 100, offset: 0 });
        try {
          await barrier.first;
          const closing = source.close();
          let closed = false;
          void closing.then(() => {
            closed = true;
          });
          await Promise.resolve();
          assert.equal(closed, false, 'the pool stays open while its leased snapshot is blocked');
          await denied(() => reads.count('item'));
          barrier.release();
          await denied(() => reading);
          await closing;
          assert.equal(closed, true);
        } finally {
          barrier.release();
          barrier.restore();
        }
      });

    test('close stops admission synchronously, drains queued calls, and invalidates retained methods', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        member = await f.evidence(),
        reads = await source.scopeReads(member, allow);
      const pending = [source.assertCurrent(member), source.readMembership(lookup()), reads.count('item'), reads.runView(view())];
      const closing = source.close();
      assert.equal(source.close(), closing);
      const settled = await Promise.allSettled(pending);
      assert.ok(settled.every((result) => result.status === 'rejected' && safe(result.reason)));
      await closing;
      await denied(() => source.scopeReads(member, allow));
      await denied(() => reads.count('item'));
      await denied(() => source.readMembership(lookup()));
    });

    test('close between snapshot completion and queued promise delivery suppresses the buffered result', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let closing: Promise<void> | undefined;
      const pending = source.readMembership(lookup());
      queueMicrotask(() =>
        queueMicrotask(() => {
          closing = source.close();
        }),
      );
      await denied(() => pending);
      await closing;
    });

    test('reentrant clock closure drains the executing snapshot and releases no data', async (t) => {
      const f = await fixture(t, dialect);
      let source!: TenantReadSource,
        closing: Promise<void> | undefined,
        retire = false;
      source = await f.open(() => {
        if (retire) closing = source.close();
        return 100;
      });
      const reads = await source.scopeReads(await f.evidence(), allow);
      let closingClock = false;
      // Statements a source sends after its clock hook starts retirement, not the
      // metadata reads that legitimately preceded that hook in the snapshot, nor
      // the transaction's own end.
      const watch = f.engine.intercept(t, { match: (statement) => closingClock && !/^(BEGIN|COMMIT|ROLLBACK)\b/.test(statement.sql) });
      try {
        const closingSource = await f.open(() => {
          closingClock = true;
          closing = closingSource.close();
          return 100;
        });
        await denied(async () => closingSource.assertCurrent(await f.evidence()));
        await closing;
        assert.equal(watch.calls, 0);
        closingClock = false;
        retire = true;
        await denied(() => reads.count('item'));
        await closing;
      } finally {
        watch.restore();
      }
      await denied(async () => source.assertCurrent(await f.evidence()));
    });

    /* On PostgreSQL a ROLLBACK that cannot be sent is a connection the server
       ended (a failover, a pooler, an idle timeout): the read is refused, its
       pool replaced, and the source answers the next read. Retiring it there
       refused every request of the process until a restart. A SQLite file is
       this process's own, and its reader still retires. */
    test(
      postgres
        ? 'failed snapshot rollback refuses that read alone; the source replaces its pool and answers the next'
        : 'failed snapshot rollback retires and closes the owned source before any later read',
      async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          reads = await source.scopeReads(await f.evidence(), allow);
        const fault = f.engine.intercept(t, { match: (statement) => statement.sql === 'ROLLBACK', fault: 'before' });
        try {
          await denied(() => reads.query({ table: 'item', columns: [secret], limit: 100, offset: 0 }));
          assert.equal(fault.calls, 1);
          if (postgres) {
            fault.restore();
            assert.equal(await reads.count('item'), 3);
            await denied(() => reads.query({ table: 'item', columns: [secret], limit: 100, offset: 0 }));
          } else await denied(() => reads.count('item'));
          await source.close();
        } finally {
          fault.restore();
        }
        await denied(() => reads.count('item'));
        assert.equal(await f.count('db_item'), 6);
      },
    );

    for (const time of [1000, NaN, Infinity, -1, 49, 100.5])
      test(`source refuses expired or invalid queued clock ${String(time)}`, async (t) => {
        const f = await fixture(t, dialect);
        let now = 100;
        const source = await f.open(() => now),
          reads = await source.scopeReads(await f.evidence(), allow);
        const pending = reads.count('item');
        now = time;
        await denied(() => pending);
      });

    test('hostile source inputs execute no getters or proxy traps and cannot break later reads', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        member = await f.evidence(),
        reads = await source.scopeReads(member, allow);
      let calls = 0;
      const fail = (): never => {
        calls++;
        throw new Error(secret);
      };
      await denied(() => source.readMembership(new Proxy(lookup(), { get: fail, ownKeys: fail, getPrototypeOf: fail })));
      await denied(() => source.assertCurrent(Object.defineProperty({ ...member }, 'roles', { get: fail, enumerable: true })));
      await denied(() => source.scopeReads(member, new Proxy(allow, { get: fail, ownKeys: fail, getPrototypeOf: fail })));
      await denied(() =>
        reads.query(new Proxy({ table: 'item', limit: 100, offset: 0 }, { get: fail, ownKeys: fail, getPrototypeOf: fail })),
      );
      assert.equal(calls, 0);
      assert.equal(await reads.count('item'), 3);
    });

    if (!postgres) {
      test('read-only scanner exposes no writable authority and preserves writer trigger restrictions', async (t) => {
        const f = await fixture(t, dialect),
          db = f.engine.sqlite(),
          readonly = new DatabaseSync(f.engine.path, { readOnly: true });
        try {
          readonly.exec('BEGIN');
          const catalog = readSqliteReadCatalog(readonly);
          assert.equal('writable' in catalog, false);
          assert.equal(
            catalog.schema.tables.some((table) => table.id.startsWith('sqlite_')),
            false,
          );
          assert.equal(
            catalog.schema.tables.some((table) => table.id === tables.membership),
            true,
          );
          assert.equal(
            catalog.schema.tables.some((table) => 'approxRows' in table),
            false,
          );
          readonly.exec('COMMIT');
          assert.throws(() => readonly.exec("UPDATE db_item SET status = 'write'"), /readonly/i);
          readonly.exec('CREATE TEMP TABLE DB_ITEM(id INTEGER); BEGIN');
          assert.equal(readSqliteReadCatalog(readonly).readable.has('db_item'), false);
          readonly.exec('COMMIT');
          db.exec('CREATE TRIGGER blocked AFTER UPDATE ON db_item BEGIN SELECT 1; END; BEGIN IMMEDIATE');
          assert.equal(readSqliteScopeCatalog(db).writable.has('db_item'), false);
          db.exec('COMMIT');
        } finally {
          readonly.close();
        }
      });

      test('snapshot store helpers require an existing transaction and never finish a borrowed one', async (t) => {
        const f = await fixture(t, dialect),
          db = f.engine.sqlite(),
          member = await f.evidence();
        await denied(() => readSqliteTenantMembershipSnapshot(db, owner(), lookup()));
        await denied(() => assertSqliteTenantMembershipSnapshot(db, owner(), member, () => 100));
        db.exec('BEGIN');
        try {
          assert.equal(readSqliteTenantMembershipSnapshot(db, owner(), lookup())?.membershipId, 'grant-1');
          assertSqliteTenantMembershipSnapshot(db, owner(), member, () => 100);
          await denied(() => readSqliteTenantMembership(db, owner(), lookup()));
          assert.equal(db.isTransaction, true);
        } finally {
          db.exec('ROLLBACK');
        }
      });

      test('the source keeps its opened file rather than reopening a replacement path for requests', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          member = await f.evidence();
        renameSync(f.engine.path, join(f.engine.path, '..', 'original.db'));
        const replacement = new DatabaseSync(f.engine.path);
        replacement.exec('CREATE TABLE unrelated(id INTEGER)');
        replacement.close();
        assert.equal((await source.readMembership(lookup()))?.membershipId, 'grant-1');
        assert.equal(await (await source.scopeReads(member, allow)).count('item'), 3);
      });

      for (const kind of ['virtual', 'shadow'] as const)
        test(`mapped ${kind} table refuses without dropping its physical evidence`, async (t) => {
          const f = await fixture(t, dialect),
            db = f.engine.sqlite();
          const table = kind === 'virtual' ? 'search' : 'search_data';
          db.exec('CREATE VIRTUAL TABLE search USING fts5(tenant_id, body)');
          db.exec('BEGIN');
          const physicalSchema = readSqliteReadCatalog(db).schema;
          assert.equal(readSqliteReadCatalog(db).readable.has(table), false);
          db.exec('COMMIT');
          // A global mapping avoids type-affinity/nullability refusal masking the
          // source's independent table-kind attestation for virtual/shadow metadata.
          const resources = { ...f.resources, unsupported: table };
          const mapped = mapScopeCatalog(physicalSchema, new Map(Object.entries(resources).map(([id, name]) => [name, id])));
          const owned = captureTenantOwnership({
            ...f.ownership,
            physicalSchema,
            resources,
            schema: {
              ...mapped,
              tables: mapped.tables.map((table) => ({ ...table, name: table.id, schema: '' })),
            },
            ownership: { ...f.ownership.ownership, unsupported: { kind: 'global', access: 'read-only' } },
          });
          await denied(() => f.open(() => 100, owned));
        });
    }

    test('pinned definitions refuse a policy-column case-folding collation invisible to catalog authority', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        member = await f.evidence();
      const reads = await source.scopeReads(member, { ...allow, item: { groups: [[{ column: 'status', op: '=', value: 'OPEN' }]] } });
      assert.equal(await reads.count('item'), 0);
      if (postgres) await f.engine.exec(`ALTER TABLE db_item ALTER COLUMN status TYPE text COLLATE ${CASE_INSENSITIVE}`);
      else {
        const original = (await f.engine.get('SELECT sql FROM main.sqlite_schema WHERE name = ?', ['db_item']))?.sql;
        assert.equal(typeof original, 'string');
        const replacement = (original as string).replace('status TEXT NOT NULL', 'status TEXT NOT NULL COLLATE NOCASE');
        assert.notEqual(replacement, original);
        await f.engine.exec(
          'PRAGMA foreign_keys = OFF; CREATE TEMP TABLE saved_items AS SELECT * FROM main.db_item; DROP TABLE main.db_item',
        );
        await f.engine.exec(replacement);
        await f.engine.exec('INSERT INTO main.db_item SELECT * FROM saved_items; DROP TABLE saved_items; PRAGMA foreign_keys = ON');
      }
      assert.ok((await f.count("db_item WHERE status = 'OPEN'")) > 0);
      await denied(() => source.assertCurrent(member));
      await denied(() => source.readMembership(lookup()));
      await denied(() => reads.count('item'));
    });

    if (postgres) {
      test('an ownership column under a nondeterministic collation refuses the source', async (t) => {
        const f = await fixture(t, dialect);
        await f.engine.exec(`ALTER TABLE db_person ALTER COLUMN tenant_id TYPE text COLLATE ${CASE_INSENSITIVE}`);
        await denied(() => f.open());
      });

      for (const type of ['character(8)', 'integer USING 0'])
        test(`an ownership column of type ${type.split(' ')[0]} refuses ownership capture and the source`, async (t) => {
          const f = await fixture(t, dialect);
          await f.engine.exec(`ALTER TABLE db_person ALTER COLUMN tenant_id TYPE ${type}`);
          const physicalSchema = await f.engine.physicalSchema();
          assert.throws(
            () =>
              captureTenantOwnership({
                ...f.ownership,
                physicalSchema,
                schema: mapScopeCatalog(physicalSchema, new Map(Object.entries(f.resources).map(([id, name]) => [name, id]))),
              }),
            TenantContextError,
          );
          await denied(() => f.open());
        });

      test('PostgreSQL snapshot store helpers refuse outside a transaction and never finish a borrowed one', async (t) => {
        const f = await fixture(t, dialect),
          session = await f.engine.session(),
          member = await f.evidence();
        await denied(() => readPostgresTenantMembership(session, owner(), lookup()));
        await denied(() => assertPostgresTenantMembershipSnapshot(session, owner(), member, () => 100));
        await session.query('BEGIN');
        try {
          assert.equal((await readPostgresTenantMembership(session, owner(), lookup()))?.membershipId, 'grant-1');
          await assertPostgresTenantMembershipSnapshot(session, owner(), member, () => 100);
          assert.equal((await session.query('SELECT 1 AS open')).rows[0].open, 1, 'the borrowed transaction is still usable');
        } finally {
          await session.query('ROLLBACK');
        }
      });
    }
  });
