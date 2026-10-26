/**
 * What each realm of a two-realm tenant App is *offered*: the rooms, the menu,
 * the home and the pages a lease is served.
 *
 * This is a different question from what a lease may read, and 0.5.0 answered
 * it with the other one. The served payload was built from the whole App and
 * then had every room that would not resolve against the context's own catalog
 * dropped (`withoutBrokenViews`), which is a filter by table ownership wearing
 * the realm's clothes. Most of the time the two agree, and where they part the
 * disagreement is visible in a sidebar: the lender's rooms over its own tables
 * vanished from a dealership's menu because a dealership has no such tables,
 * while the lender's room over the *dealership's* own documents stayed — under
 * the lender's headings, answering with the dealership's own rows. In the other
 * direction nothing was filtered at all, because the platform realm's catalog
 * holds every table, so the lender drew the whole dealership menu.
 *
 * So the fixture is shaped to separate the two facts. `lead` is the
 * dealership's; `review_file` is the lender's. `portfolio` is the lender's room
 * over `lead` that names the ownership column, so the tenant catalog rejects it
 * anyway; `watchlist` is the lender's room over `lead` that names no such
 * column, so the tenant catalog accepts it happily — that is the room that
 * leaked, and it is the one worth asserting on. Both directions are asserted
 * here: neither realm's menu names one of the other's rooms, and each assertion
 * first checks that the table it hinges on *is* in the reader's catalog, so a
 * pass can never mean "filtered for the other reason".
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { parseAppConfig, physicalBindings, type AppDef } from '../packages/mistri/src/shared/app.js';
import type { AppNavNode, AppRealm } from '../packages/mistri/src/shared/appModel.js';
import { parseAppPages } from '../packages/mistri/src/shared/app.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { projectTenantMetadata } from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { tenantAuthoringSchema } from '../packages/mistri/src/server/tenant/tenantVisibleFields.js';

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-tenants' };

const SQL = `
  CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
  CREATE TABLE review_file (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES lead(id), note TEXT);`;

/** The whole App: two dealership rooms and three of the lender's, over both
 * kinds of table, with a page and a home rule in each realm. */
const manifest = () => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    review_file: { owner: 'platform' },
    lead: { owner: 'tenant' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: ['lead'], write: false }, manager: { realm: 'platform', read: true, write: false } },
  },
  views: {
    leads: { kind: 'list', from: 'lead', label: 'Leads', show: ['id', 'name'] },
    // Reads nothing at all, so no catalog can refuse it: its realm is the only thing that places it.
    board: { kind: 'dashboard', label: 'Dealership', sections: [{ kind: 'note', text: 'Today' }] },
    portfolio: { kind: 'list', from: 'lead', realm: 'platform', label: 'Portfolio', show: ['id', 'tenant_id', 'name'] },
    /* The lender's own room over the dealership's own table, naming no column a
       dealership cannot read. Nothing but its realm keeps it off a dealership's
       menu, which is why it is the room that leaked. */
    watchlist: { kind: 'list', from: 'lead', realm: 'platform', label: 'Watchlist', show: ['id', 'name'] },
    files: { kind: 'list', from: 'review_file', realm: 'platform', label: 'Review files', show: ['id', 'note'] },
  },
  pages: {
    lead: { base: 'lead', sections: [{ kind: 'fields', show: ['name'] }] },
    file: { base: 'review_file', realm: 'platform', sections: [{ kind: 'fields', show: ['note'] }] },
  },
  nav: [
    { id: 'work', label: 'Work', realm: 'tenant', children: ['leads', 'board'] },
    {
      id: 'lending',
      label: 'Lending',
      realm: 'platform',
      children: ['portfolio', { id: 'records', label: 'Review records', children: ['watchlist', 'files'] }],
    },
  ],
  home: [{ view: 'portfolio', roles: ['manager'] }, { view: 'leads' }],
});

const app = (): AppDef => parseAppConfig(manifest(), 'lending.ts');
const pagesOf = () => parseAppPages(manifest(), 'lending.ts');

function owned(t: TestContext, definition: AppDef): TenantOwnershipSnapshot {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SQL);
  const physical = readSqliteScopeCatalog(db).schema;
  const catalog = appResourceCatalog(physical, physicalBindings(definition, 'business'));
  return captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema: physical,
    schema: catalog.schema,
    resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
    ownership: { dealer: { kind: 'platform' }, review_file: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
    profile: 'dealer',
  });
}

/** The payload one lease is served, with that realm's own catalog and roles. */
function served(t: TestContext, realm: AppRealm) {
  const definition = app();
  const snapshot = owned(t, definition);
  const schema = tenantAuthoringSchema(snapshot, realm);
  const metadata = projectTenantMetadata(definition, pagesOf(), schema, undefined, realm === 'platform' ? ['manager'] : ['staff'], realm);
  return { schema, ...metadata };
}

/** Every label the menu draws, groups and rooms alike, flattened. */
const menu = (nav: readonly unknown[]): string[] =>
  (nav as AppNavNode[]).flatMap((node) => ('group' in node ? [node.label, ...menu(node.children)] : [(node as { label: string }).label]));

test("a dealership is offered its own rooms, and not one of the lender's — not even over its own table", (t) => {
  const { schema, app: payload, pages } = served(t, 'tenant');
  /* The hinge: `lead` is the dealership's own table and is in its catalog, so
     the lender's rooms over it resolve here. Only the realm keeps them out. */
  assert.ok(
    schema.tables.some((table) => table.id === 'lead'),
    'the dealership reads its own leads',
  );
  assert.equal(
    schema.tables.some((table) => table.id === 'review_file'),
    false,
    "and not the lender's file",
  );

  assert.deepEqual(Object.keys(payload.views).sort(), ['board', 'leads']);
  assert.deepEqual(menu(payload.nav), ['Work', 'Leads', 'Dealership']);
  for (const lenders of ['portfolio', 'watchlist', 'files']) {
    assert.equal(Object.hasOwn(payload.views, lenders), false, `the dealership is offered no room "${lenders}"`);
  }
  // The heading is gone with its rooms: an empty "Lending" would say as much.
  assert.equal(menu(payload.nav).includes('Lending'), false);
  assert.equal(menu(payload.nav).includes('Review records'), false);
  // The home is its own realm's, and so are its pages.
  assert.equal(payload.home, 'leads');
  assert.deepEqual(
    pages.map((page) => page.id),
    ['lead'],
  );
});

test("the lender is offered its own rooms, and not one of the dealership's", (t) => {
  const { schema, app: payload, pages } = served(t, 'platform');
  /* The platform realm's catalog holds every table, ownership column included,
     so nothing about a dealership's rooms fails to resolve here. This direction
     had no accidental filter at all. */
  for (const table of ['lead', 'review_file', 'dealer']) {
    assert.ok(
      schema.tables.some((entry) => entry.id === table),
      `the lender reads ${table}`,
    );
  }

  assert.deepEqual(Object.keys(payload.views).sort(), ['files', 'portfolio', 'watchlist']);
  assert.deepEqual(menu(payload.nav), ['Lending', 'Portfolio', 'Review records', 'Watchlist', 'Review files']);
  for (const dealers of ['leads', 'board']) {
    assert.equal(Object.hasOwn(payload.views, dealers), false, `the lender is offered no room "${dealers}"`);
  }
  assert.equal(menu(payload.nav).includes('Work'), false);
  assert.equal(payload.home, 'portfolio');
  assert.deepEqual(
    pages.map((page) => page.id),
    ['file'],
  );
});
