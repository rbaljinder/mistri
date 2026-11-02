/**
 * A command's aggregate in a tenant App: read through the tenant writer's
 * command transaction (tenantWriteSource.ts, tenantManagedTransaction.ts),
 * so it is bound by the member's tenant and, inside it, by the row policy and
 * the command's footprint, exactly as `query` and `count` are. Another
 * dealer's rows make no group and move no total; a row the policy hides moves
 * neither; a table answers what `count` answers of it; a column the tenant's
 * table does not have is refused. SQLite always, PostgreSQL live-gated
 * (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { TenantWriteFailure, type TenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = { appId: 'service', source: { id: 'business', connection: 'owned-business' }, storeId: 'aggregate-fixture' };
const SCHEMA = {
  tables: ['ag_deal', 'ag_tag', 'ag_dealer'],
  sqlite: `CREATE TABLE ag_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE ag_deal (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES ag_dealer(id), owner_id TEXT NOT NULL,
      stage TEXT NOT NULL, amount NUMERIC(18,2) NOT NULL);
    CREATE TABLE ag_tag (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES ag_dealer(id), name TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.ag_dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.ag_deal (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.ag_dealer(id), owner_id text NOT NULL,
      stage text NOT NULL, amount numeric(18,2) NOT NULL);
    CREATE TABLE public.ag_tag (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.ag_dealer(id), name text NOT NULL);`,
};
/* Alice's deals in north, Bob's in north (her policy hides them), and the south dealer's: each would change an answer. */
const ROWS = `
    INSERT INTO ag_dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO ag_deal VALUES
      ('n1', 'north', 'alice', 'open', 0.10), ('n2', 'north', 'alice', 'open', 0.20), ('n3', 'north', 'alice', 'won', 0.07),
      ('n4', 'north', 'alice', 'won', 100000000000000.00),
      ('n5', 'north', 'bob', 'lost', 50.00),
      ('s1', 'south', 'sam', 'open', 999.99), ('s2', 'south', 'sam', 'secret', -1000.00);
    INSERT INTO ag_tag VALUES ('t1', 'north', 'hot'), ('t2', 'south', 'cold');`;
const DATABASE = `command_aggregates_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const mine = { groups: [[{ column: 'owner_id', op: '=' as const, value: 'alice' }]] };
const ALICE: RowScope = { dealer: true, deal: mine, tag: true };
const FOOTPRINT = ['deal', 'tag'];
const refused = (error: unknown) => error instanceof TenantWriteFailure && error.outcome === 'not_applied';
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const byStage = {
  table: 'deal',
  by: [{ name: 'stage', column: 'stage' }],
  measures: [
    { name: 'n', fn: 'count' as const },
    { name: 'total', fn: 'sum' as const, column: 'amount' },
    { name: 'low', fn: 'min' as const, column: 'amount' },
  ],
  orderBy: [{ name: 'stage', direction: 'asc' as const }],
  limit: 100,
};
/* A number as the engine says it, compared as a number: SQLite's MIN is a bare number, PostgreSQL's numeric text. */
const amount = (value: unknown) => Number(value).toFixed(2);

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: TenantWriteSource[] = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  await engine.migrateCommandJournal();
  await engine.maintenance(owner, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      status: 'active',
      roles: ['staff'],
      validUntil: 10_000,
      expectedVersion: null,
    });
  });
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(['dealer', 'deal', 'tag'].map((logical) => [logical, engine.id(`ag_${logical}`)]));
  const catalog = appResourceCatalog(physicalSchema, resources);
  const tenant = { kind: 'tenant' as const, column: 'tenant_id' };
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: { dealer: { kind: 'platform' }, deal: tenant, tag: tenant },
    profile: 'dealer',
  });
  const writer = await engine.openWrite(ownership, owner, () => 1000);
  sources.push(writer);
  const lookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId: 'north', deployment: 'deployment-1' };
  const record = await engine.readMembership(owner, lookup);
  assert.ok(record);
  const alice: TenantMembershipEvidence = {
    ...lookup,
    membershipId: record.membershipId,
    membershipVersion: record.membershipVersion,
    tenantVersion: record.tenantVersion,
    roles: [...record.roles],
    verifiedAt: 1000,
    validUntil: 6000,
  };
  const command = <T>(work: (tx: WriteTransaction) => Promise<T>, rows: RowScope = ALICE, footprint: readonly string[] = FOOTPRINT) =>
    writer.commandTransaction(alice, rows, (tx) => work(tx), undefined, undefined, footprint) as Promise<T>;
  return { command };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant command's aggregate on ${dialect}`, { skip }, () => {
    test("another dealer's rows and a row the policy hides make no group and move no total", async (t) => {
      const f = await fixture(t, dialect);
      const { grouped, counted, rows } = await f.command(async (tx) => ({
        grouped: await tx.aggregate!(byStage),
        counted: await tx.count('deal'),
        rows: (await tx.query({ table: 'deal', limit: 100, offset: 0 })).rows.length,
      }));
      assert.equal(counted, 4);
      assert.equal(rows, 4);
      assert.deepEqual(
        plain(grouped.rows).map((row: Record<string, unknown>) => ({ ...row, n: Number(row.n), low: amount(row.low) })),
        [
          { stage: 'open', n: 2, total: '0.30', low: '0.10' },
          { stage: 'won', n: 2, total: '100000000000000.07', low: '0.07' },
        ],
      );
      // Widened to the whole tenant (the policy left out), Bob's deal is there; the south dealer's never are.
      const tenantWide = await f.command((tx) => tx.aggregate!({ ...byStage, measures: [{ name: 'n', fn: 'count' }] }), {
        ...ALICE,
        deal: true,
      });
      assert.deepEqual(
        plain(tenantWide.rows).map((row: Record<string, unknown>) => [row.stage, Number(row.n)]),
        [
          ['lost', 1],
          ['open', 2],
          ['won', 2],
        ],
      );
    });

    test("a table off the write footprint is read as count and query read it, and a hidden table's rows never", async (t) => {
      const f = await fixture(t, dialect);
      const tags = { table: 'tag', measures: [{ name: 'n', fn: 'count' as const }], limit: 1 };
      const offFootprint = await f.command(
        async (tx) => ({
          aggregated: Number((await tx.aggregate!(tags)).rows[0]!.n),
          counted: await tx.count('tag'),
          rows: (await tx.query({ table: 'tag', limit: 100, offset: 0 })).rows.length,
        }),
        ALICE,
        ['deal'],
      );
      assert.deepEqual(plain(offFootprint), { aggregated: 1, counted: 1, rows: 1 }, "north's one tag, never south's");
      // A table the row scope does not admit reads as no rows to all three.
      const hidden = await f.command(
        async (tx) => ({
          aggregated: Number((await tx.aggregate!(tags)).rows[0]!.n),
          counted: await tx.count('tag'),
        }),
        { dealer: true, deal: mine },
      );
      assert.deepEqual(plain(hidden), { aggregated: 0, counted: 0 });
      await assert.rejects(
        f.command((tx) => tx.aggregate!({ ...byStage, by: [{ name: 'k', column: 'tenant_id.name' }] })),
        refused,
      );
      await assert.rejects(
        f.command((tx) => tx.aggregate!({ ...byStage, measures: [{ name: 'n', fn: 'sum', column: 'nothing' }] })),
        refused,
      );
    });
  });
