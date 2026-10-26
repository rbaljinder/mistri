/**
 * Rollups and record names under a tenant App. The catalog a context is
 * served (tenantServedSchema.ts) carries the App's rollups and label
 * templates, computed from the context's own catalog; the statement then
 * reads every child row and every named record through the context's scoped
 * relations (rowScope.ts). So a rollup counts this tenant's rows and no
 * other's, even where another tenant's row points at this tenant's record,
 * and a name read across a reference to another tenant's row is empty, never
 * that tenant's words. The fixture's keys point across the boundary on
 * purpose: single-column references, not the composite a sample would use.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { tenantServedSchema } from '../packages/mistri/src/server/tenant/tenantServedSchema.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { withViewComputed, withViewLabels, type ViewDef } from '../packages/engine/src/shared/view.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = () => ({ appId: 'app', source: { id: 'business', connection: 'owned-source' }, storeId: 'store-rollups' });
/* North's person p-1 has two of north's items and one of south's pointing at
   it; north's item i-4 points at south's person. */
const ROWS = `INSERT INTO db_person VALUES ('p-1', 'north', 'North person', 'staff'), ('p-2', 'south', 'SOUTH_PERSON', 'guest');
  INSERT INTO db_item VALUES ('i-1', 'north', 'p-1', 'First', 3), ('i-2', 'north', 'p-1', 'Second', 4),
    ('i-3', 'south', 'p-1', 'SOUTH_ITEM', 900), ('i-4', 'north', 'p-2', 'Points south', 5);`;
const SCHEMA = {
  tables: ['db_item', 'db_person'],
  sqlite: `CREATE TABLE db_person(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL COLLATE BINARY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('staff', 'guest')));
    CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL COLLATE BINARY,
      person_id TEXT REFERENCES db_person(id), title TEXT NOT NULL, amount INTEGER NOT NULL);
    ${ROWS}`,
  postgres: `CREATE TABLE public.db_person(id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('staff', 'guest')));
    CREATE TABLE public.db_item(id text PRIMARY KEY, tenant_id text NOT NULL, person_id text REFERENCES public.db_person(id),
      title text NOT NULL, amount integer NOT NULL);
    ${ROWS.replaceAll('INTO db_', 'INTO public.db_')}`,
};
const DATABASE = `tenant_rollups_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const app = parseAppConfig(
  {
    id: 'app',
    name: 'Tenant rollups',
    auth: { rows: 'tenant', roles: { reader: { read: ['item', 'person'] } } },
    sources: { business: { connection: 'owned-source', default: true } },
    resources: {
      person: {
        owner: 'tenant',
        recordLabel: '{name} ({kind})',
        display: { kind: { values: { staff: 'Staff', guest: 'Guest' } } },
        rollups: {
          items: { fn: 'count', from: 'item' },
          total: { fn: 'sum', from: 'item', column: 'amount' },
          large: { fn: 'count', from: 'item', query: 'amount > 3' },
        },
      },
      item: { owner: 'tenant', recordLabel: '{title} for {person_id.name}' },
    },
    views: { people: { kind: 'list', from: 'person' } },
    home: 'people',
  },
  'tenant rollups',
);

/* The provider's console: a computed column on a tenant's
   resource, read by the platform realm, a rollup summing one, and a rollup
   counting the rows one says are breaching (its `query`). */
const console_ = parseAppConfig(
  {
    id: 'app',
    name: 'Provider console',
    auth: {
      rows: 'tenant',
      tenancy: { platform: { label: 'Provider' } },
      roles: { reader: { realm: 'platform', read: ['item', 'person'] } },
    },
    sources: { business: { connection: 'owned-source', default: true } },
    resources: {
      person: {
        owner: 'tenant',
        rollups: {
          weight: { fn: 'sum', from: 'item', column: 'weighted' },
          breaching: { fn: 'count', from: 'item', query: 'breaching = true' },
        },
      },
      item: {
        owner: 'tenant',
        computed: { breaching: { type: 'boolean', value: 'amount > 3' }, weighted: { type: 'number', value: 'amount * 2' } },
      },
    },
    views: { people: { kind: 'list', from: 'person' } },
    home: 'people',
  },
  'provider console',
);

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, { ...SCHEMA, database: DATABASE });
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    await Promise.allSettled(sources.map((source) => source.close()));
    await engine.close();
  });
  await engine.provisionStore(owner());
  await engine.maintenance(owner(), async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'grant-1',
      status: 'active',
      roles: ['reader'],
      validUntil: 10_000,
      expectedVersion: null,
    });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'lee',
      membershipId: 'platform-lee',
      status: 'active',
      roles: ['reader'],
      validUntil: 10_000,
      expectedVersion: null,
    });
  });
  const resources = { item: engine.id('db_item'), person: engine.id('db_person') };
  const physicalSchema = await engine.physicalSchema();
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: 'app',
    source: owner().source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' }, person: { kind: 'tenant', column: 'tenant_id' } },
  });
  const source = await engine.openRead(ownership, owner(), () => 100);
  sources.push(source);
  const lookup = { appId: 'app', source: owner().source, accountId: 'alice', tenantId: 'north', deployment: 'generation-1' };
  const record = await engine.readMembership(owner(), lookup);
  assert.ok(record);
  const evidence: TenantMembershipEvidence = {
    ...lookup,
    membershipId: record.membershipId,
    membershipVersion: record.membershipVersion,
    tenantVersion: record.tenantVersion,
    roles: [...record.roles],
    verifiedAt: 50,
    validUntil: 1000,
  };
  const served = tenantServedSchema({ schema: ownership.schema }, app, new Date('2026-09-25T12:00:00Z'));
  // As the read route builds it: the served catalog's templates and rollups, never the request's.
  const view = (given: ViewDef) => withViewComputed(served, withViewLabels(served, given));
  const platformLookup = { realm: 'platform' as const, appId: 'app', accountId: 'lee', source: owner().source, deployment: 'generation-1' };
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
  const provider = tenantServedSchema({ schema: ownership.schema }, console_, new Date('2026-09-25T12:00:00Z'));
  return {
    served,
    view,
    reads: await source.scopeReads(evidence, { item: true, person: true }),
    provider: (given: ViewDef) => withViewComputed(provider, withViewLabels(provider, given)),
    platformReads: () => source.scopePlatformReads(platform, { item: true, person: true }),
  };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`rollups and record names in a tenant source on ${dialect}`, { skip }, () => {
    test("the served catalog carries the App's rollups and names, as the ordinary host's does", async (t) => {
      const { served } = await fixture(t, dialect);
      const person = served.tables.find((table) => table.id === 'person')!;
      assert.deepEqual(Object.keys(person.rollups ?? {}).sort(), ['items', 'large', 'total']);
      // The stored code is said as its word in the name: "staff" reads "Staff".
      assert.match(person.labelTemplate ?? '', /^\{name\} \(\{kind\|words:/);
      assert.match(served.tables.find((table) => table.id === 'item')!.labelTemplate ?? '', /\{person_id\.name\}/);
    });

    test("a rollup counts this tenant's child rows only, however many point here from another", async (t) => {
      const { view, reads } = await fixture(t, dialect);
      const seen = await reads.runView(
        view({
          id: 'people',
          name: 'People',
          base: 'person',
          columns: [{ path: 'id' }, { path: 'items' }, { path: 'total' }, { path: 'large' }, { path: '$label' }],
          orderBy: [{ path: 'id', direction: 'asc' }],
          limit: 100,
        }),
      );
      const rows = JSON.parse(JSON.stringify(seen.rows)) as Array<Record<string, unknown>>;
      // South's person is not north's to read at all; north's p-1 counts north's two items, not south's third.
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'p-1');
      assert.equal(Number(rows[0].items), 2);
      assert.equal(Number(rows[0].total), 7, "south's 900 is not in the sum");
      assert.equal(Number(rows[0].large), 1, "the rollup's own query narrows within the tenant's rows");
      assert.equal(rows[0].$label, 'North person (Staff)');
      assert.doesNotMatch(JSON.stringify(seen), /SOUTH_|900/);
    });

    test("a condition or a sort on a rollup cannot learn another tenant's rows", async (t) => {
      const { view, reads } = await fixture(t, dialect);
      for (const [op, value] of [
        ['>', 2],
        ['=', 3],
        ['>', 7],
      ] as const) {
        const probed = await reads.runView(
          view({
            id: 'probe',
            name: 'Probe',
            base: 'person',
            columns: [{ path: 'id' }],
            filter: { groups: [[{ path: op === '>' && value === 7 ? 'total' : 'items', op, value }]] },
            limit: 100,
          }),
        );
        assert.deepEqual(probed.rows, [], `items/total ${op} ${value} would only match with south's rows counted`);
      }
      // A request's own rollup is replaced by the catalog's (withViewComputed), so it cannot widen what is counted.
      const forged = await reads.runView(
        view({
          id: 'forged',
          name: 'Forged',
          base: 'person',
          columns: [{ path: 'id' }, { path: 'items' }],
          limit: 100,
          computed: { items: { fn: 'count', via: 'item.tenant_id', type: 'integer', on: '' } },
        }),
      );
      assert.equal(Number((forged.rows[0] as Record<string, unknown>).items), 2);
    });

    test("the platform realm reads a tenant resource's computed column, and a rollup of one, across tenants", async (t) => {
      const { provider, platformReads } = await fixture(t, dialect);
      const reads = await platformReads();
      const items = await reads.runView(
        provider({
          id: 'items',
          name: 'Items',
          base: 'item',
          columns: [{ path: 'id' }, { path: 'tenant_id' }, { path: 'breaching' }],
          filter: { groups: [[{ path: 'breaching', op: '=', value: true }]] },
          orderBy: [{ path: 'id', direction: 'asc' }],
          limit: 100,
        }),
      );
      const rows = JSON.parse(JSON.stringify(items.rows)) as Array<Record<string, unknown>>;
      assert.deepEqual(
        rows.map((row) => [row.id, row.tenant_id, !!row.breaching]),
        [
          ['i-2', 'north', true],
          ['i-3', 'south', true],
          ['i-4', 'north', true],
        ],
      );
      const people = await reads.runView(
        provider({
          id: 'people',
          name: 'People',
          base: 'person',
          columns: [{ path: 'id' }, { path: 'weight' }, { path: 'breaching' }],
          orderBy: [{ path: 'id', direction: 'asc' }],
          limit: 100,
        }),
      );
      // The platform reads every tenant's rows: p-1 sums north's 3 and 4 and south's 900, doubled; p-2 north's 5.
      // Breaching (amount > 3): p-1's 4 and 900, p-2's 5.
      assert.deepEqual(
        (JSON.parse(JSON.stringify(people.rows)) as Array<Record<string, unknown>>).map((row) => [
          row.id,
          Number(row.weight),
          Number(row.breaching),
        ]),
        [
          ['p-1', 1814, 2],
          ['p-2', 10, 1],
        ],
      );
    });

    test("a record name read across a reference to another tenant's row is empty, not that tenant's words", async (t) => {
      const { view, reads } = await fixture(t, dialect);
      const seen = await reads.runView(
        view({
          id: 'items',
          name: 'Items',
          base: 'item',
          columns: [{ path: 'id' }, { path: '$label' }, { path: 'person_id.$label', alias: 'who' }],
          orderBy: [{ path: 'id', direction: 'asc' }],
          limit: 100,
        }),
      );
      const rows = JSON.parse(JSON.stringify(seen.rows)) as Array<Record<string, unknown>>;
      assert.deepEqual(
        rows.map((row) => row.id),
        ['i-1', 'i-2', 'i-4'],
      );
      assert.equal(rows[0].$label, 'First for North person');
      assert.equal(rows[2].$label, 'Points south for ', "the other tenant's name is a scoped join's null, said as nothing");
      assert.equal(rows[2].who, null, 'a record the reference does not reach has no name, not " ()"');
      assert.equal(rows[0].who, 'North person (Staff)');
      assert.doesNotMatch(JSON.stringify(seen), /SOUTH_/);
      const searched = await reads.runView(
        view({
          id: 'search',
          name: 'Search',
          base: 'item',
          columns: [{ path: 'id' }],
          filter: { groups: [[{ path: '$label', op: 'contains', value: 'SOUTH_PERSON' }]] },
          limit: 100,
        }),
      );
      assert.deepEqual(searched.rows, [], 'a search on the name cannot see across the boundary');
    });
  });
