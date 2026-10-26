/**
 * Declared references under a tenant App: a soft key within the tenant's one
 * source (`item.person_ref` → `person.id`) rides into the tenant's scoped
 * catalog, and its join runs through the same tenant predicate as the rows
 * it starts from, so another tenant's row behind the key reads as nothing.
 * A reference into another source is refused when the App parses: nothing
 * outside the tenant's source is scoped by its membership.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = () => ({ appId: 'app', source: { id: 'business', connection: 'owned-source' }, storeId: 'store-refs' });
/* Keys are opaque text: the one column a tenant table may keep unique on its
   own (tenantPostgresCatalog.ts), and so the one a reference can be proven by. */
const SCHEMA = {
  tables: ['db_item', 'db_person'],
  sqlite: `CREATE TABLE db_person(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL COLLATE BINARY, name TEXT NOT NULL);
    CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL COLLATE BINARY, person_ref TEXT, title TEXT NOT NULL);
    INSERT INTO db_person VALUES ('p-1', 'north', 'North person'), ('p-2', 'south', 'SOUTH_PERSON');
    INSERT INTO db_item VALUES ('i-1', 'north', 'p-1', 'Mine'), ('i-2', 'north', 'p-2', 'Points south'), ('i-3', 'south', 'p-2', 'SOUTH_ITEM');`,
  postgres: `CREATE TABLE public.db_person(id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.db_item(id text PRIMARY KEY, tenant_id text NOT NULL, person_ref text, title text NOT NULL);
    INSERT INTO public.db_person VALUES ('p-1', 'north', 'North person'), ('p-2', 'south', 'SOUTH_PERSON');
    INSERT INTO public.db_item VALUES ('i-1', 'north', 'p-1', 'Mine'), ('i-2', 'north', 'p-2', 'Points south'), ('i-3', 'south', 'p-2', 'SOUTH_ITEM');`,
};
const DATABASE = `declared_refs_${randomUUID().replaceAll('-', '')}`;
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
  });
  const resources = { item: engine.id('db_item'), person: engine.id('db_person') };
  const physicalSchema = await engine.physicalSchema();
  const catalog = appResourceCatalog(physicalSchema, resources, [{ table: 'item', column: 'person_ref', to: 'person' }]);
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
  return { ownership, reads: await source.scopeReads(evidence, { item: true, person: true }) };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`declared references in a tenant source on ${dialect}`, { skip }, () => {
    test('the declared edge is in the tenant catalog, and its join keeps to the tenant', async (t) => {
      const { ownership, reads } = await fixture(t, dialect);
      assert.ok(
        ownership.schema.foreignKeys.some((fk) => fk.declared && fk.from.columns[0] === 'person_ref'),
        'carried by the scoped catalog',
      );
      const seen = await reads.runView({
        id: 'items',
        name: 'Items',
        base: 'item',
        columns: [{ path: 'id' }, { path: 'person_ref.name', alias: 'who' }],
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 100,
      });
      assert.deepEqual(
        seen.rows,
        [
          { id: 'i-1', who: 'North person' },
          { id: 'i-2', who: null },
        ],
        "another tenant's row behind the key is a LEFT JOIN's null",
      );
      assert.doesNotMatch(JSON.stringify(seen), /SOUTH_/);
      const probed = await reads.runView({
        id: 'probe',
        name: 'Probe',
        base: 'item',
        columns: [{ path: 'id' }],
        filter: { groups: [[{ path: 'person_ref.name', op: '=', value: 'SOUTH_PERSON' }]] },
        limit: 100,
      });
      assert.deepEqual(probed.rows, [], 'a filter through the edge cannot see across the boundary');
      const forged = await reads.runView({
        id: 'forged',
        name: 'Forged',
        base: 'item',
        columns: [{ path: 'id' }, { path: 'title' }],
        references: [
          { name: 'forged', from: { table: 'item', columns: ['title'] }, to: { table: 'person', columns: ['id'] }, declared: true },
        ],
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 100,
      });
      assert.deepEqual(
        forged.rows.map((row) => row.id),
        ['i-1', 'i-2'],
        "a request's edge is replaced by the catalog's own",
      );
      await assert.rejects(
        reads.runView({
          id: 'walk',
          name: 'Walk',
          base: 'item',
          columns: [{ path: 'title.name' }],
          limit: 100,
          references: [
            { name: 'forged', from: { table: 'item', columns: ['title'] }, to: { table: 'person', columns: ['id'] }, declared: true },
          ],
        }),
        'a path through a forged edge resolves to nothing',
      );
    });
  });

test('a tenant App refuses a reference into another source', () => {
  const manifest = (to: string) => ({
    id: 'app',
    name: 'Tenant app',
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Workshop', platform: { label: 'Head office' } },
      roles: { reader: { read: ['item', 'person'], realm: 'tenant' } },
    },
    sources: { business: { connection: 'db', default: true }, control: { connection: 'p', realm: 'platform' } },
    resources: {
      item: { owner: 'tenant', references: { person_ref: { to } } },
      person: { owner: 'tenant' },
      'control.plan': { owner: 'platform' },
    },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
  });
  assert.throws(() => parseAppConfig(manifest('control.plan'), 'tenant refs'), /in another source.*stays within one/);
  assert.doesNotThrow(() => parseAppConfig(manifest('person'), 'tenant refs'));
});
