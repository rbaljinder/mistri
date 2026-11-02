/**
 * An aggregate in a tenant App outside a command handler: a page's loader, a
 * row policy's read, an availability hook, in each realm's reader. It is read
 * through the same source `query` and `count` are (tenantReadSource.ts,
 * tenantPlatformSource.ts), so it is bound by the same tenant, the same row
 * scope and the same realm's fence: another tenant's rows make no group and
 * move no total, a forged page boundary reads no further than the page's own
 * scope, and each realm answers exactly what its `count` answers, or is
 * refused where its `count` is. SQLite always, PostgreSQL live-gated
 * (support/tenantDialects.ts). The command handler's twin is
 * tenant-command-aggregates.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import type { ScopedReads } from '../packages/engine/src/adapters/adapter.js';
import { advisoryRecords, type TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { count, sum } from '../packages/mistri/src/server/commands/commandDb.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { bindPublicReadRuntime } from '../packages/mistri/src/server/tenant/tenantPublicReadRuntime.js';
import { defineLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import type { TenantPublicEvidence } from '../packages/mistri/src/server/tenant/tenantPublicRead.js';
import { issueSupportEvidence, type SupportMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantSupportLease.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = { appId: 'service', source: { id: 'business', connection: 'owned-business' }, storeId: 'read-aggregate-fixture' };
const NORTH = 'north-public-AAAAAAAAAAAAAAAA';
const SCHEMA = {
  tables: ['ra_deal', 'ra_dealer'],
  sqlite: `CREATE TABLE ra_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, public_address TEXT);
    CREATE TABLE ra_deal (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES ra_dealer(id), owner_id TEXT NOT NULL,
      stage TEXT NOT NULL, amount NUMERIC(18,2) NOT NULL);`,
  postgres: `
    CREATE TABLE public.ra_dealer (id text PRIMARY KEY, name text NOT NULL, public_address text);
    CREATE TABLE public.ra_deal (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.ra_dealer(id), owner_id text NOT NULL,
      stage text NOT NULL, amount numeric(18,2) NOT NULL);`,
};
/* Alice's deals in north, Bob's in north (her policy hides them), and the south dealer's: each would change an answer. */
const ROWS = `
    INSERT INTO ra_dealer VALUES ('north', 'North Motors', '${NORTH}'), ('south', 'South Auto', NULL);
    INSERT INTO ra_deal VALUES
      ('n1', 'north', 'alice', 'open', 0.10), ('n2', 'north', 'alice', 'open', 0.20), ('n3', 'north', 'alice', 'won', 0.07),
      ('n4', 'north', 'alice', 'won', 100000000000000.00),
      ('n5', 'north', 'bob', 'lost', 50.00),
      ('s1', 'south', 'sam', 'open', 999.99), ('s2', 'south', 'sam', 'secret', -1000.00);`;
const DATABASE = `read_aggregates_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const mine = { groups: [[{ column: 'owner_id', op: '=' as const, value: 'alice' }]] };
const ALICE: RowScope = { dealer: true, deal: mine };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const byStage = {
  table: 'deal',
  by: [{ name: 'stage', column: 'stage' }],
  measures: [
    { name: 'n', fn: 'count' as const },
    { name: 'total', fn: 'sum' as const, column: 'amount' },
  ],
  orderBy: [{ name: 'stage', direction: 'asc' as const }],
  limit: 100,
};
const tally = (rows: unknown) => plain(rows).map((row: Record<string, unknown>) => ({ ...row, n: Number(row.n) }));
/** What a reader's `count` answers of a table, and what its aggregate's count answers: the same number, or both refused. */
async function parity(reads: ScopedReads, table: string, filter?: Parameters<ScopedReads['count']>[1]) {
  const asked = () => reads.aggregate!({ table, ...(filter ? { filter } : {}), measures: [{ name: 'n', fn: 'count' }], limit: 1 });
  const counted = await reads.count(table, filter).then(
    (n) => ({ n }),
    () => 'refused' as const,
  );
  const summed = await asked().then(
    (answer) => ({ n: Number(answer.rows[0]?.n) }),
    () => 'refused' as const,
  );
  assert.deepEqual(summed, counted, `${table}: the aggregate answers what the count answers`);
  return counted;
}

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    try {
      await Promise.allSettled(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  const validUntil = Date.now() + 3_600_000;
  await engine.maintenance(owner, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'lee',
      membershipId: 'platform-lee',
      status: 'active',
      roles: ['manager'],
      validUntil,
      expectedVersion: null,
    });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      status: 'active',
      roles: ['staff'],
      validUntil,
      expectedVersion: null,
    });
  });
  const supportId = randomUUID();
  await engine.exec(
    `INSERT INTO "${TENANT_TABLES.membership}" (id, tenant_id, account_id, status, version, roles_json,
    valid_until, kind, parent_id, parent_version, platform_version)
    VALUES (?, 'north', 'lee', 'active', '1', ?, ?, 'support', 'platform-lee', '1', '1')`,
    [supportId, JSON.stringify(['staff']), validUntil],
  );
  const physicalSchema = await engine.physicalSchema();
  const resources = { dealer: engine.id('ra_dealer'), deal: engine.id('ra_deal') };
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: { dealer: { kind: 'platform' }, deal: { kind: 'tenant', column: 'tenant_id' } },
    profile: 'dealer',
  });
  const source = await engine.openRead(ownership, owner, Date.now);
  sources.push(source);

  const memberLookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId: 'north', deployment: 'deployment-1' };
  const record = await engine.readMembership(owner, memberLookup);
  assert.ok(record);
  const alice: TenantMembershipEvidence = {
    ...memberLookup,
    membershipId: record.membershipId,
    membershipVersion: record.membershipVersion,
    tenantVersion: record.tenantVersion,
    roles: [...record.roles],
    verifiedAt: Date.now() - 1,
    validUntil,
  };
  const platformLookup = {
    realm: 'platform' as const,
    appId: owner.appId,
    accountId: 'lee',
    source: owner.source,
    deployment: 'deployment-1',
  };
  const platformRecord = await source.readPlatformMembership(platformLookup);
  assert.ok(platformRecord);
  const lee: PlatformMembershipEvidence = {
    ...platformLookup,
    membershipId: platformRecord.membershipId,
    membershipVersion: platformRecord.membershipVersion,
    platformVersion: platformRecord.platformVersion,
    roles: [...platformRecord.roles],
    verifiedAt: Date.now() - 1,
    validUntil,
  };
  const support: SupportMembershipEvidence = issueSupportEvidence({
    realm: 'support',
    appId: owner.appId,
    accountId: 'lee',
    source: owner.source,
    deployment: 'deployment-1',
    tenantId: 'north',
    supportId,
    membershipId: supportId,
    membershipVersion: '1',
    tenantVersion: '1',
    parentId: 'platform-lee',
    parentVersion: '1',
    platformVersion: '1',
    roles: ['staff'],
    verifiedAt: Date.now() - 1,
    validUntil,
  });
  const resolved = await source.resolvePublic({
    appId: owner.appId,
    source: owner.source,
    deployment: 'deployment-1',
    column: 'public_address',
    address: NORTH,
    tenant: null,
  });
  assert.ok(resolved);
  const visitor: TenantPublicEvidence = {
    realm: 'public',
    appId: owner.appId,
    source: owner.source,
    deployment: 'deployment-1',
    ...resolved,
    column: 'public_address',
    address: NORTH,
    verifiedAt: Date.now() - 1,
    validUntil,
  };
  /* The App as the public runtime reads it: a visitor's grant is the App's `public.read`, the address in the profile. */
  const app = parseAppConfig(
    {
      id: owner.appId,
      name: 'Read aggregates',
      sources: { business: { connection: owner.source.connection, default: true } },
      resources: {
        dealer: { owner: 'platform', physical: engine.id('ra_dealer') },
        deal: { owner: 'tenant', physical: engine.id('ra_deal') },
      },
      auth: {
        store: 'auth.db',
        rows: 'tenant',
        tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
        roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
        public: { read: ['deal'] },
      },
      views: { deals: { kind: 'list', from: 'deal' } },
      home: 'deals',
    },
    'read aggregates fixture',
  );
  return { source, alice, lee, support, visitor, schema: catalog.schema, app };
}

/** A page's loader run over a reader, as a tenant's page route runs one (http/pageLoad.ts). */
const loaded = async (f: Awaited<ReturnType<typeof fixture>>, reader: ScopedReads, load: Parameters<typeof defineLoader>[0]['load']) =>
  runPageLoader({
    name: 'tally',
    loader: defineLoader({ reads: ['deal'], load } as never) as never,
    reader: { query: reader.query, count: reader.count, aggregate: reader.aggregate },
    schema: f.schema,
    params: {},
    viewer: { roles: ['staff'] },
    now: new Date(),
  });

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant's aggregate outside a command on ${dialect}`, { skip }, () => {
    test("a page loader sums and groups only its own tenant's rows, under the member's row policy", async (t) => {
      const f = await fixture(t, dialect);
      const reads = await f.source.bindReads(f.alice, ALICE);
      const answer = (await loaded(f, reads, async ({ db }) => ({
        groups: await db.deal
          .where({})
          .groupBy('stage')
          .aggregate({ n: count(), total: sum('amount') })
          .limit(100),
        held: await db.deal.where({ stage: 'open' }).sum('amount'),
        counted: (await db.deal.where({}).aggregate({ n: count() })).n,
      }))) as { groups: unknown; held: string; counted: number };
      assert.equal(answer.counted, 4);
      assert.equal(answer.held, '0.30');
      assert.deepEqual(
        tally(answer.groups).sort((a: { stage: string }, b: { stage: string }) => a.stage.localeCompare(b.stage)),
        [
          { stage: 'open', n: 2, total: '0.30' },
          { stage: 'won', n: 2, total: '100000000000000.07' },
        ],
      );
    });

    test("a forged page boundary reads no further than the loader's own tenant and policy", async (t) => {
      const f = await fixture(t, dialect);
      const reads = await f.source.bindReads(f.alice, ALICE);
      // Past every north key and before the south dealer's: an unscoped page would hold s1 and s2, and its total 7 rows.
      const after = async (id: string) =>
        (await loaded(f, reads, async ({ db }) => ({
          page: await db.deal.where({}).page({ after: { id }, size: 100 }),
          rows: (await db.deal.where({}).aggregate({ n: count() })).n,
          held: await db.deal.where({}).groupBy('stage').aggregate({ n: count() }).limit(10),
        }))) as { page: { rows: Array<{ id: string }> }; rows: number; held: Array<{ stage: string }> };
      const forged = await after('n0');
      assert.deepEqual(forged.page.rows.map((row) => row.id).sort(), ['n1', 'n2', 'n3', 'n4']);
      assert.equal(forged.rows, 4);
      assert.deepEqual(forged.held.map((row) => row.stage).sort(), ['open', 'won'], "no 'secret' or 'lost' group");
      const beyond = await after('n9');
      assert.deepEqual(beyond.page.rows, [], "another tenant's keys are no page of this one");
      assert.equal(beyond.rows, 4, 'the page boundary moves no total');
    });

    test("a member's bound reader, its scoped reader and its batch answer one aggregate", async (t) => {
      const f = await fixture(t, dialect);
      const bound = await f.source.bindReads(f.alice, ALICE);
      const scoped = await f.source.scopeReads(f.alice, ALICE);
      const expected = [
        { stage: 'open', n: 2, total: '0.30' },
        { stage: 'won', n: 2, total: '100000000000000.07' },
      ];
      for (const reads of [bound, scoped]) assert.deepEqual(tally((await reads.aggregate!(byStage)).rows), expected);
      const batched = await f.source.withReads(f.alice, ALICE, async (reads) => ({
        grouped: await reads.aggregate!(byStage),
        counted: await reads.count('deal'),
        advised: await advisoryRecords(reads).aggregate!(byStage),
      }));
      assert.equal(batched.counted, 4);
      assert.deepEqual(tally(batched.grouped.rows), expected);
      assert.deepEqual(tally(batched.advised.rows), expected);
      // Another tenant's table and a column that is not the table's own answer as they do for a command.
      await assert.rejects(bound.aggregate!({ ...byStage, table: 'nowhere' }));
      await assert.rejects(bound.aggregate!({ ...byStage, by: [{ name: 'x', column: 'nope' }] }));
    });

    test("a support session answers what its count answers: the dealer it entered, nobody else's", async (t) => {
      const f = await fixture(t, dialect);
      const reads = await f.source.scopeSupportReads(f.support, { dealer: true, deal: true });
      assert.deepEqual(await parity(reads, 'deal'), { n: 5 });
      assert.deepEqual(await parity(reads, 'nowhere'), 'refused');
      const stages = await reads.aggregate!(byStage);
      assert.deepEqual(
        tally(stages.rows).map((row: { stage: string; n: number }) => [row.stage, row.n]),
        [
          ['lost', 1],
          ['open', 2],
          ['won', 2],
        ],
        "no 'secret' group: the south dealer's rows make none",
      );
    });

    test('the platform answers what its count answers, across the tenants it reads', async (t) => {
      const f = await fixture(t, dialect);
      for (const reads of [
        await f.source.bindPlatformReads(f.lee, { dealer: true, deal: true }),
        await f.source.scopePlatformReads(f.lee, { dealer: true, deal: true }),
      ]) {
        assert.deepEqual(await parity(reads, 'deal'), { n: 7 });
        assert.deepEqual(await parity(reads, 'nowhere'), 'refused');
        assert.equal((await reads.aggregate!({ ...byStage, by: [], orderBy: [] })).rows.length, 1);
      }
      // A table the platform's scope does not name reads no row, by either question.
      const narrow = await f.source.bindPlatformReads(f.lee, { dealer: true });
      assert.deepEqual(await parity(narrow, 'deal'), await narrow.count('deal').then((n) => ({ n })));
      const together = await f.source.withPlatformReads(f.lee, { dealer: true, deal: true }, (reads) => parity(reads, 'deal'));
      assert.deepEqual(together, { n: 7 });
    });

    test("a visitor answers what its count answers: its address's tenant, under the callback's rows", async (t) => {
      const f = await fixture(t, dialect);
      const open = { groups: [[{ column: 'stage', op: '=' as const, value: 'open' }]] };
      const reads = await f.source.bindPublicReads(f.visitor, { deal: open });
      assert.deepEqual(await parity(reads, 'deal'), { n: 2 });
      // The platform's profile is denied the visitor, so it has no rows to count or add up.
      assert.deepEqual(await parity(reads, 'dealer'), { n: 0 });
      assert.deepEqual(await parity(reads, 'nowhere'), 'refused');
      assert.deepEqual(tally((await reads.aggregate!(byStage)).rows), [{ stage: 'open', n: 2, total: '0.30' }]);
      // The runtime's own visitor context, which a public page's loader reads through: the same answer, tenant and all.
      const runtime = bindPublicReadRuntime({
        app: f.app,
        source: f.source,
        deployment: 'deployment-1',
        column: 'public_address',
        resolvePublicRows: () => ({ deal: open }),
        maxLifetimeMs: 60_000,
      });
      t.after(() => runtime.retire());
      const visited = await runtime.withContext({ address: NORTH }, async (context) => ({
        counted: await context.data.count('deal'),
        grouped: tally((await context.data.aggregate!(byStage)).rows),
      }));
      assert.equal(visited.counted, 2);
      assert.deepEqual(plain(visited.grouped), [{ stage: 'open', n: 2, total: '0.30' }]);
      // A table the visitor's count is refused (the platform's profile) refuses its aggregate: a refusal ends the context.
      const outcome = (ask: (data: ScopedReads) => Promise<unknown>) =>
        runtime
          .withContext({ address: NORTH }, (context) => ask(context.data))
          .then(
            () => 'answered',
            () => 'refused',
          );
      const counted = await outcome((data) => data.count('dealer'));
      assert.equal(
        await outcome((data) => data.aggregate!({ table: 'dealer', measures: [{ name: 'n', fn: 'count' }], limit: 1 })),
        counted,
      );
      assert.equal(counted, 'refused');
      // Evidence naming a tenant the address does not: refused at the fence, as a count is.
      const forged = await f.source.bindPublicReads({ ...f.visitor, tenantId: 'south' }, { deal: true });
      await assert.rejects(forged.aggregate!(byStage));
      await assert.rejects(forged.count('deal'));
    });
  });
