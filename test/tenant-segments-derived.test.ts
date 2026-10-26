/**
 * A segment over a computed column or a rollup, in a tenant App with the
 * platform realm, on both engines (G164).
 *
 * The authoring check judges each realm against its own projection of the App
 * (appTenancy.ts appForRealm). A tenant-owned resource was carried into the
 * platform realm's projection with its segments — the platform's lists of
 * these rows name them as tabs — but without the computed columns and rollups
 * those segments read, so `mistri check` refused `busy: 'tickets > 1'` and
 * `large: 'big = true'` as naming no column, though an ordinary App accepts
 * both and the served catalog reads them. Here both check in both realms, and
 * each list tab returns its rows: a tenant's rollup counts only that tenant's
 * child rows, even where another tenant's row points at its record, while the
 * platform realm counts across tenants, as it reads.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { tenantAuthoringProblems } from '../packages/mistri/src/server/tenant/tenantAuthoring.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import { tenantServedSchema } from '../packages/mistri/src/server/tenant/tenantServedSchema.js';
import { appForRealm } from '../packages/mistri/src/shared/appTenancy.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseViewQuery, withViewComputed, withViewLabels, type ViewDef } from '../packages/engine/src/shared/view.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const binding = () => ({ appId: 'desk', source: { id: 'business', connection: 'desk-db' }, storeId: 'store-segments-derived' });

/* North's account a-1 has two tickets; a-2 has one of north's and one of
   south's pointing at it (a single-column key across the boundary, on
   purpose), so a rollup that counted south's row would make a-2 busy too.
   South's s-1 has two of its own. */
const ROWS = `INSERT INTO db_account VALUES ('a-1', 'north', 'North one'), ('a-2', 'north', 'North two'), ('s-1', 'south', 'SOUTH_ACCOUNT');
  INSERT INTO db_ticket VALUES ('t-1', 'north', 'a-1', 2), ('t-2', 'north', 'a-1', 5), ('t-3', 'north', 'a-2', 9),
    ('t-4', 'south', 'a-2', 50), ('t-5', 'south', 's-1', 1), ('t-6', 'south', 's-1', 7);`;
const SCHEMA = {
  tables: ['db_ticket', 'db_account'],
  sqlite: `CREATE TABLE db_account(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL COLLATE BINARY, name TEXT NOT NULL);
    CREATE TABLE db_ticket(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL COLLATE BINARY,
      account_id TEXT REFERENCES db_account(id), amount INTEGER NOT NULL);
    ${ROWS}`,
  postgres: `CREATE TABLE public.db_account(id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.db_ticket(id text PRIMARY KEY, tenant_id text NOT NULL, account_id text REFERENCES public.db_account(id),
      amount integer NOT NULL);
    ${ROWS.replaceAll('INTO db_', 'INTO public.db_')}`,
};
const DATABASE = `tenant_seg_derived_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

/** A tenant's desk and the provider's list above it, each tab a segment over a rollup or a computed column. */
const app: AppDef = parseTestApp(
  {
    id: 'desk',
    name: 'Desk',
    sources: { business: { connection: 'desk-db', default: true } },
    auth: {
      rows: 'tenant',
      tenancy: { platform: { label: 'Provider' } },
      roles: { agent: { realm: 'tenant', read: ['account', 'ticket'] }, operator: { realm: 'platform', read: ['account', 'ticket'] } },
    },
    resources: {
      account: {
        owner: 'tenant',
        rollups: { tickets: { fn: 'count', from: 'ticket' } },
        segments: { busy: { query: 'tickets > 1' } },
      },
      ticket: {
        owner: 'tenant',
        computed: { big: { type: 'boolean', value: 'amount > 3' } },
        segments: { large: { query: 'big = true' } },
      },
    },
    views: {
      accounts: { kind: 'list', from: 'account', tabs: [{ segment: 'busy' }] },
      tickets: { kind: 'list', from: 'ticket', tabs: [{ segment: 'large' }] },
      book: { kind: 'list', from: 'account', realm: 'platform', tabs: [{ segment: 'busy' }] },
      queue: { kind: 'list', from: 'ticket', realm: 'platform', tabs: [{ segment: 'large' }] },
    },
    nav: [
      { id: 'desk', label: 'Desk', realm: 'tenant', children: ['accounts', 'tickets'] },
      { id: 'provider', label: 'Provider', realm: 'platform', children: ['book', 'queue'] },
    ],
    home: 'accounts',
  },
  'desk.ts',
);
const loaded: LoadedApp = { path: 'desk.ts', app, pages: [], sources: {} };

/** The text a view's one tab runs, as the App declares it. */
function tabQuery(view: string): string {
  const declared = app.views[view] as { tabs?: Array<{ query?: string }> };
  const query = declared.tabs?.[0]?.query;
  assert.ok(query, `view "${view}" has a tab with a query`);
  return query;
}

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, { ...SCHEMA, database: DATABASE });
  const closing: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    await Promise.allSettled(closing.map((source) => source.close()));
    await engine.close();
  });
  await engine.provisionStore(binding());
  await engine.maintenance(binding(), async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'grant-alice',
      status: 'active',
      roles: ['agent'],
      validUntil: 10_000,
      expectedVersion: null,
    });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'lee',
      membershipId: 'platform-lee',
      status: 'active',
      roles: ['operator'],
      validUntil: 10_000,
      expectedVersion: null,
    });
  });
  const resources = { account: engine.id('db_account'), ticket: engine.id('db_ticket') };
  const physicalSchema = await engine.physicalSchema();
  const catalog = appResourceCatalog(physicalSchema, resources);
  const owned = captureTenantOwnership({
    appId: 'desk',
    source: binding().source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { account: { kind: 'tenant', column: 'tenant_id' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
  });
  const source = await engine.openRead(owned, binding(), () => 100);
  closing.push(source);

  const lookup = { appId: 'desk', source: binding().source, accountId: 'alice', tenantId: 'north', deployment: 'generation-1' };
  const record = await engine.readMembership(binding(), lookup);
  assert.ok(record);
  const tenant: TenantMembershipEvidence = {
    ...lookup,
    membershipId: record.membershipId,
    membershipVersion: record.membershipVersion,
    tenantVersion: record.tenantVersion,
    roles: [...record.roles],
    verifiedAt: 50,
    validUntil: 1000,
  };
  const platformLookup = {
    realm: 'platform' as const,
    appId: 'desk',
    accountId: 'lee',
    source: binding().source,
    deployment: 'generation-1',
  };
  const platformRecord = await source.readPlatformMembership(platformLookup);
  assert.ok(platformRecord);
  const platform: PlatformMembershipEvidence = {
    ...platformLookup,
    membershipId: platformRecord.membershipId,
    membershipVersion: platformRecord.membershipVersion,
    platformVersion: platformRecord.platformVersion,
    roles: [...platformRecord.roles],
    verifiedAt: 50,
    validUntil: 1000,
  };

  const served = tenantServedSchema({ schema: owned.schema }, app, new Date('2026-10-13T12:00:00Z'));
  /** A list's tab as it runs: its text read against the served catalog, the view then rebuilt from that catalog's own
   * rollups and computed columns (withViewComputed), never the request's. */
  const tab = (schema: DatabaseSchema, base: string, view: string, columns: string[]): ViewDef => {
    const parsed = parseViewQuery(schema, base, tabQuery(view));
    assert.deepEqual(parsed.errors, [], `the tab of "${view}" reads in the served catalog`);
    return withViewComputed(
      schema,
      withViewLabels(schema, {
        id: view,
        name: view,
        base,
        columns: columns.map((path) => ({ path })),
        filter: parsed.filter,
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 100,
      }),
    );
  };
  return {
    owned,
    served,
    tab,
    tenantReads: () => source.scopeReads(tenant, { account: true, ticket: true }),
    platformReads: () => source.scopePlatformReads(platform, { account: true, ticket: true }),
  };
}

const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;

test("the platform realm's projection of a tenant resource carries what its segments read", () => {
  const platform = appForRealm(app, [], 'platform').app.resources!;
  assert.deepEqual(Object.keys(platform.account.rollups ?? {}), ['tickets']);
  assert.deepEqual(Object.keys(platform.ticket.computed ?? {}), ['big']);
  assert.deepEqual(Object.keys(platform.account.segments ?? {}), ['busy']);
  // Still a stub: nothing but the names its rows are read by crosses into the other realm.
  assert.equal(platform.account.form, undefined);
  assert.deepEqual(platform.account.actions, []);
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`segments over computed columns and rollups in a tenant App on ${dialect}`, { skip }, () => {
    test('check accepts a segment over a rollup and one over a computed column, in both realms', async (t) => {
      const { owned } = await fixture(t, dialect);
      assert.deepEqual(tenantAuthoringProblems(loaded, owned), []);
    });

    test("a tenant's tab over a rollup counts that tenant's rows alone", async (t) => {
      const { served, tab, tenantReads } = await fixture(t, dialect);
      const reads = await tenantReads();
      const seen = await reads.runView(tab(served, 'account', 'accounts', ['id', 'tickets']));
      // a-2 has one north ticket and one of south's pointing at it: busy only if south's row were counted.
      assert.deepEqual(
        plain(seen.rows).map((row) => [row.id, Number(row.tickets)]),
        [['a-1', 2]],
      );
      assert.doesNotMatch(JSON.stringify(seen), /SOUTH_|s-1/);
      // The rollup itself, read without the tab, still says one for a-2.
      const all = await reads.runView({ ...tab(served, 'account', 'accounts', ['id', 'tickets']), filter: { groups: [] } });
      assert.deepEqual(
        plain(all.rows).map((row) => [row.id, Number(row.tickets)]),
        [
          ['a-1', 2],
          ['a-2', 1],
        ],
      );
    });

    test("a tenant's tab over a computed column returns that tenant's matching rows", async (t) => {
      const { served, tab, tenantReads } = await fixture(t, dialect);
      const seen = await (await tenantReads()).runView(tab(served, 'ticket', 'tickets', ['id', 'big']));
      assert.deepEqual(
        plain(seen.rows).map((row) => [row.id, Boolean(row.big)]),
        [
          ['t-2', true],
          ['t-3', true],
        ],
      );
    });

    test('the platform realm runs the same tabs across every tenant', async (t) => {
      const { served, tab, platformReads } = await fixture(t, dialect);
      const reads = await platformReads();
      const accounts = await reads.runView(tab(served, 'account', 'book', ['id', 'tickets']));
      assert.deepEqual(
        plain(accounts.rows).map((row) => [row.id, Number(row.tickets)]),
        [
          ['a-1', 2],
          ['a-2', 2],
          ['s-1', 2],
        ],
      );
      const tickets = await reads.runView(tab(served, 'ticket', 'queue', ['id']));
      assert.deepEqual(
        plain(tickets.rows).map((row) => row.id),
        ['t-2', 't-3', 't-4', 't-6'],
      );
    });
  });
