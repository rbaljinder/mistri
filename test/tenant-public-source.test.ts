/**
 * Public reads at the tenant read source, on SQLite and on PostgreSQL when
 * TABLEWALK_TEST_PG names a server (tenantDialects.ts): an address resolves
 * to the one active tenant whose profile row holds it, or to nobody; a
 * visitor's reads see that tenant's rows only, whatever the callback asked;
 * and an address rotated or a tenant suspended after placement leaves every
 * later read with nothing. The HTTP half is tenant-public-reads.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantPublicEvidence } from '../packages/mistri/src/server/tenant/tenantPublicRead.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `public_reads_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'lot', source: { id: 'business', connection: 'business-db' }, storeId: 'public-source-store' };
const NORTH = 'north-public-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-public-BBBBBBBBBBBBBBBB',
  WEST = 'west-public-CCCCCCCCCCCCCCCCCC',
  SHARED = 'shared-public-DDDDDDDDDDDDDDD',
  UNKNOWN = 'unknown-public-FFFFFFFFFFFFFF',
  ROTATED = 'rotated-public-GGGGGGGGGGGGGG';

const SCHEMA = {
  tables: ['listing', 'make', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, public_address TEXT);
    CREATE TABLE make (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE listing (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), make_id TEXT REFERENCES make(id),
      title TEXT NOT NULL, published INTEGER NOT NULL);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, public_address text);
    CREATE TABLE public.make (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.listing (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), make_id text REFERENCES public.make(id),
      title text NOT NULL, published integer NOT NULL);`,
};
// `east` and `far` share one address, so it names nobody; `west` is suspended.
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}'), ('south', 'South Auto', '${SOUTH}'), ('west', 'West Wheels', '${WEST}'),
      ('east', 'East Cars', '${SHARED}'), ('far', 'Far Cars', '${SHARED}');
    INSERT INTO make VALUES ('toyota', 'Toyota');
    INSERT INTO listing VALUES ('n-1', 'north', 'toyota', 'North Corolla', 1), ('n-2', 'north', 'toyota', 'North Draft', 0),
      ('s-1', 'south', 'toyota', 'South Camry', 1);`;
const OWNERSHIP = {
  dealer: { kind: 'platform' },
  make: { kind: 'global', access: 'read-only' },
  listing: { kind: 'tenant', column: 'tenant_id' },
} as const;

async function sources(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  await engine.provisionStore(binding);
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south', 'west', 'east', 'far'])
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  await engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'west', status: 'suspended', expectedVersion: '1' }));
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(SCHEMA.tables.map((name) => [name, engine.id(name)]));
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: OWNERSHIP,
    profile: 'dealer',
  });
  const reader = await engine.openRead(ownership, binding, () => 1000);
  t.after(async () => {
    try {
      await reader.close();
    } finally {
      await engine.close();
    }
  });
  const lookup = (address: string | null, tenant: string | null = null) => ({
    appId: binding.appId,
    source: binding.source,
    deployment: 'd1',
    column: 'public_address',
    address,
    tenant,
  });
  const evidence = async (address: string): Promise<TenantPublicEvidence> => {
    const resolved = await reader.resolvePublic(lookup(address));
    assert.ok(resolved, address);
    return {
      realm: 'public',
      appId: binding.appId,
      source: binding.source,
      deployment: 'd1',
      ...resolved,
      column: 'public_address',
      address,
      verifiedAt: 1000,
      validUntil: 6000,
    };
  };
  const ids = async (reads: Awaited<ReturnType<typeof reader.bindPublicReads>>, table = 'listing') =>
    (await reads.query({ table, columns: ['id'], limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc' }] })).rows.map(
      (row) => row.id,
    );
  return { engine, reader, lookup, evidence, ids };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`public reads on ${dialect}`, { skip }, () => {
    test('an address resolves to the one active tenant whose row holds it, and anything else to nobody', async (t) => {
      const f = await sources(t, dialect);
      assert.deepEqual(
        { ...(await f.reader.resolvePublic(f.lookup(NORTH))) },
        { tenantId: 'north', tenantVersion: '1', platformVersion: '1' },
      );
      // A suspended tenant, an address two rows share, and one nobody holds: nobody.
      for (const address of [WEST, SHARED, UNKNOWN]) assert.equal(await f.reader.resolvePublic(f.lookup(address)), null, address);
      // A mapped host names its tenant, which must still be active.
      assert.equal((await f.reader.resolvePublic(f.lookup(null, 'south')))?.tenantId, 'south');
      assert.equal(await f.reader.resolvePublic(f.lookup(null, 'west')), null);
      // A malformed address, both placements or neither, and a column that is not the profile's text: refused.
      for (const bad of [f.lookup('north'), f.lookup(NORTH, 'north'), f.lookup(null), { ...f.lookup(NORTH), column: 'id' }])
        await assert.rejects(f.reader.resolvePublic(bad as never), TenantContextError, JSON.stringify(bad));
      await f.engine.maintenance(binding, (admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
      assert.equal(await f.reader.resolvePublic(f.lookup(NORTH)), null, 'a suspended platform places nobody');
    });

    test("a visitor reads its tenant's rows the callback allows and global rows; never another tenant's, the platform's, or past its tenant", async (t) => {
      const f = await sources(t, dialect);
      const north = await f.evidence(NORTH);
      const published = await f.reader.bindPublicReads(north, {
        listing: { groups: [[{ column: 'published', op: '=', value: 1 }]] },
        make: true,
      });
      assert.deepEqual(await f.ids(published), ['n-1']);
      assert.deepEqual(await f.ids(published, 'make'), ['toyota']);
      // A table the scope denies reads no row: the platform's profile, with every address in it.
      assert.deepEqual(await f.ids(published, 'dealer'), []);
      // A callback that asks for every row, or another tenant's by key in an `or`, still reads one tenant.
      const wide = await f.reader.bindPublicReads(north, {
        listing: { groups: [[{ column: 'published', op: '=', value: 0 }], [{ column: 'id', op: '=', value: 's-1' }]] },
        dealer: true,
      });
      assert.deepEqual(await f.ids(wide), ['n-2']);
      assert.deepEqual(await f.ids(wide, 'dealer'), [], 'a platform table is denied whatever the callback says');
      assert.equal(await (await f.reader.bindPublicReads(north, { listing: true })).count('listing'), 2);
      // Evidence naming a tenant the address does not: refused at the fence.
      const forged = await f.reader.bindPublicReads({ ...north, tenantId: 'south' }, { listing: true });
      await assert.rejects(f.ids(forged), TenantContextError);
    });

    test('a rotated address or a suspended tenant leaves every later read with nothing', async (t) => {
      const f = await sources(t, dialect);
      const north = await f.evidence(NORTH);
      const reads = await f.reader.bindPublicReads(north, { listing: true });
      assert.deepEqual(await f.ids(reads), ['n-1', 'n-2']);
      await f.engine.exec(`UPDATE dealer SET public_address = '${ROTATED}' WHERE id = 'north'`);
      await assert.rejects(f.ids(reads), TenantContextError);
      await assert.rejects(f.reader.assertPublicCurrent(north), TenantContextError);
      const rotated = await f.evidence(ROTATED);
      const again = await f.reader.bindPublicReads(rotated, { listing: true });
      assert.deepEqual(await f.ids(again), ['n-1', 'n-2']);
      await f.engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
      await assert.rejects(f.ids(again), TenantContextError);
    });
  });
