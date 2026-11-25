/**
 * What an arrival asks before anyone is admitted, in fewer snapshots (tenantReadSource.ts): `readTenantMarks`, one
 * snapshot for the names of a person's tenants, which of them are sandboxes and the entered tenant's own addresses;
 * and `readMembershipsWithPlatform`, discovery's second look at the memberships with the platform's beside it.
 *
 * Each answers exactly what the reads it gathers answer alone, on SQLite and on PostgreSQL, and on PostgreSQL both
 * ways it is sent: in its turn on the snapshot, and as the one message that begins and ends it. A dialect matrix
 * (support/tenantDialects.ts), in a database of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import {
  provisionPostgresTenantSandboxes,
  provisionSqliteTenantSandboxes,
  SANDBOX_TABLES,
} from '../packages/mistri/src/server/tenant/tenantSandboxStore.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = { appId: 'lending', source: { id: 'business', connection: 'owned-business' }, storeId: 'marks-fixture' };
const SCHEMA = {
  tables: ['db_lead', 'db_dealer'],
  sqlite: `PRAGMA foreign_keys = ON;
    CREATE TABLE db_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
    CREATE TABLE db_lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES db_dealer(id), name TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.db_dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text);
    CREATE TABLE public.db_lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.db_dealer(id), name text NOT NULL);`,
};
/* North and south each hold an address of their own; east and west hold the same one, which is then no one's. */
const ROWS = `
    INSERT INTO db_dealer VALUES ('north', 'North Motors', 'north-door-0123456789abcdef'), ('south', 'South Auto', 'south-door-0123456789abcdef'),
      ('east', 'East Cars', 'shared-door-0123456789abcdef'), ('west', 'West Cars', 'shared-door-0123456789abcdef');`;

const DATABASE = `tenant_marks_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

/* `stored`: the sandbox store is there before the sources' catalog is read. SQLite's sources refuse a catalog that
   moved under them, so there it is never provisioned later. */
async function fixture(t: TestContext, dialect: TenantDialect, stored = false) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  const grant = { status: 'active' as const, validUntil: 10_000, expectedVersion: null };
  await engine.maintenance(owner, async (admin) => {
    for (const tenantId of ['north', 'south', 'east', 'west']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
    await admin.putMembership({ ...grant, tenantId: 'south', accountId: 'alice', membershipId: 'south-alice', roles: ['staff'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['manager'] });
  });
  const provision = async () => {
    if (dialect === 'sqlite') provisionSqliteTenantSandboxes(engine.path);
    else await provisionPostgresTenantSandboxes(engine.url);
  };
  if (stored) await provision();
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(
    [
      ['dealer', 'db_dealer'],
      ['lead', 'db_lead'],
    ].map(([logical, name]) => [logical, engine.id(name!)]),
  );
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: appResourceCatalog(physicalSchema, resources).schema,
    physicalSchema,
    resources,
    ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
    profile: 'dealer',
  });
  /** South is a sandbox of north; the store is provisioned first, where it was not. */
  const sandboxes = async () => {
    if (!stored) await provision();
    await engine.exec(
      `INSERT INTO ${runtimeTable(dialect, SANDBOX_TABLES.tenant)} (app, tenant_id, source_tenant_id, samples, created_at)
       VALUES ('${owner.appId}', 'south', 'north', 0, '2026-09-12T12:00:00.000Z')`,
    );
  };
  /** `trustFor`: how long a PostgreSQL catalog attestation stands; zero, every snapshot attests afresh and nothing rides its BEGIN. */
  const open = async (trustFor = 0) => {
    const source = await engine.openRead(ownership, owner, () => 1000, trustFor);
    sources.push(source);
    return source;
  };
  return { engine, open, sandboxes };
}

const names = { template: '{name}', tenants: ['north', 'south', 'gone'] };
const columns = { intake: 'intake_address' };
/** The marks as plain values, to compare. */
const said = (marks: Awaited<ReturnType<TenantReadSource['readTenantMarks']>>) => ({
  names: { ...marks.names },
  sandboxes: [...marks.sandboxes].sort(),
  ...(marks.addresses === undefined ? {} : { addresses: { ...marks.addresses } }),
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`an arrival's reads in fewer snapshots on ${dialect}`, { skip }, () => {
    /* Zero: asked in their turn. A minute: the second ask rides the message that begins its snapshot. */
    for (const trustFor of dialect === 'postgres' ? [0, 60_000] : [0])
      test(`the marks are what the names, the sandboxes and the addresses each answer alone, and name nothing that was not asked (trust ${trustFor} ms)`, async (t) => {
        const f = await fixture(t, dialect, dialect === 'sqlite');
        const source = await f.open(trustFor);
        const whole = { names, sandboxes: ['north', 'south'], addresses: { tenantId: 'north', columns } };
        /* No sandbox yet (on PostgreSQL, no store either): none of them is one, as `readSandboxes` says. */
        assert.deepEqual(said(await source.readTenantMarks(whole)), {
          names: { north: 'North Motors', south: 'South Auto' },
          sandboxes: [],
          addresses: { intake: 'north-door-0123456789abcdef' },
        });
        await f.sandboxes();
        /* More than once: with trust, the first attests the store on its snapshot and the next name it in their first message. */
        for (let asked = 0; asked < 3; asked += 1) {
          const marks = await source.readTenantMarks(whole);
          assert.deepEqual(said(marks), {
            names: { north: 'North Motors', south: 'South Auto' },
            sandboxes: ['south'],
            addresses: { intake: 'north-door-0123456789abcdef' },
          });
          assert.deepEqual({ ...marks.names }, { ...(await source.readTenantNames(names)) });
          assert.deepEqual([...marks.sandboxes], [...(await source.readSandboxes(['north', 'south']))]);
          assert.deepEqual({ ...marks.addresses }, { ...(await source.readTenantAddresses({ tenantId: 'north', columns })) });
        }
        /* Only what is asked: no sandboxes and no addresses unless named, and never another tenant's address. */
        assert.deepEqual(said(await source.readTenantMarks({ names })), {
          names: { north: 'North Motors', south: 'South Auto' },
          sandboxes: [],
        });
        assert.deepEqual(
          said(await source.readTenantMarks({ names: { ...names, tenants: ['south'] }, addresses: { tenantId: 'south', columns } })),
          {
            names: { south: 'South Auto' },
            sandboxes: [],
            addresses: { intake: 'south-door-0123456789abcdef' },
          },
        );
        /* An address two tenants hold is no one's, as it is asked alone. */
        assert.deepEqual(
          said(
            await source.readTenantMarks({
              names: { ...names, tenants: ['east'] },
              sandboxes: ['east'],
              addresses: { tenantId: 'east', columns },
            }),
          ),
          { names: { east: 'East Cars' }, sandboxes: [], addresses: {} },
        );
        /* A lookup its own read refuses is refused here: the platform is no tenant, and a column that is no address. */
        await assert.rejects(source.readTenantMarks({ names, addresses: { tenantId: '@platform', columns } }));
        await assert.rejects(source.readTenantMarks({ names, addresses: { tenantId: 'north', columns: { intake: 'id' } } }));
        await assert.rejects(source.readTenantMarks({ names, sandboxes: ["north' OR '1'='1"] }));
      });

    test(
      'a sandbox store that goes away fails the one message that named it, and the next ask reads the store afresh',
      { skip: dialect !== 'postgres' && 'PostgreSQL sends the marks as one message; SQLite reads them in its turn' },
      async (t) => {
        const f = await fixture(t, dialect);
        await f.sandboxes();
        const source = await f.open(60_000);
        const whole = { names, sandboxes: ['north', 'south'] };
        assert.deepEqual(said(await source.readTenantMarks(whole)).sandboxes, ['south']);
        assert.deepEqual(said(await source.readTenantMarks(whole)).sandboxes, ['south']);
        for (const table of Object.values(SANDBOX_TABLES)) await f.engine.exec(`DROP TABLE ${runtimeTable('postgres', table)}`);
        /* The message named a table that is gone: nothing of it is answered, the names neither (discovery then asks
           each apart, tenantDiscovery.ts). The store is forgotten with it. */
        await assert.rejects(source.readTenantMarks(whole));
        assert.deepEqual(said(await source.readTenantMarks(whole)), {
          names: { north: 'North Motors', south: 'South Auto' },
          sandboxes: [],
        });
      },
    );

    test("the memberships with the platform's are what each read answers alone, each for the account asked", async (t) => {
      const f = await fixture(t, dialect);
      for (const trustFor of dialect === 'postgres' ? [0, 60_000] : [0]) {
        const source = await f.open(trustFor);
        for (const accountId of ['alice', 'lee', 'nobody']) {
          const lookup = { appId: owner.appId, source: owner.source, accountId, deployment: 'deployment-1' };
          const platform = { realm: 'platform' as const, ...lookup };
          for (let asked = 0; asked < 2; asked += 1) {
            const both = await source.readMembershipsWithPlatform(lookup, platform);
            assert.deepEqual(both.memberships, await source.readMemberships(lookup));
            assert.deepEqual(both.platform, await source.readPlatformMembership(platform));
            assert.deepEqual(
              both.memberships.map((record) => record.tenantId),
              accountId === 'alice' ? ['north', 'south'] : [],
            );
            assert.equal(both.platform?.membershipId, accountId === 'lee' ? 'platform-lee' : undefined);
          }
        }
        /* One account's lookups only: the platform's read never answers for another account than the memberships'. */
        const mixed = await source.readMembershipsWithPlatform(
          { appId: owner.appId, source: owner.source, accountId: 'alice', deployment: 'deployment-1' },
          { realm: 'platform', appId: owner.appId, source: owner.source, accountId: 'lee', deployment: 'deployment-1' },
        );
        assert.equal(mixed.memberships.length, 2);
        assert.equal(mixed.platform?.accountId, 'lee');
      }
    });
  });
