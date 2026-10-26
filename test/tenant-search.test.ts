/** Search on a tenant App: one collection for the App, every document with
 * its tenant, every question asked within the reader's tenant, and every key
 * it answers read back through the reader's own adapter.
 *
 * In process, over SQLite and the Typesense double (test/support/fakeTypesense.ts)
 * plugged in as the search provider: the reindex fills the index with each
 * row's tenant; a filter is asked of the engine (a row renamed behind the
 * index's back is still found by its indexed name, which the database alone
 * would not do); north's search never names south's records, even when they
 * match; a document planted in north's slice with south's key still shows
 * north nothing of south's; and the index follows a write with its tenant.
 * The engine's own filter is proved against a real one in services-live.test.ts. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { Adapter, QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import { indexerFor, tenantSearchAdapter } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { typesenseSearch } from '../packs/search-typesense/src/index.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';

const KEY = 'tenant-search-key';
const connection = 'tenant-search-depot';
const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-search-'));
const path = join(directory, 'depot.db');
const tenantColumns = { item: 'tenant' };
let fake: FakeTypesense;
let registry: Registry;
let db: DatabaseSync;

const app = parseAppConfig(
  {
    id: 'depot',
    name: 'Depot',
    connection,
    resources: { item: { access: 'write', search: { connection: 'search', fields: ['name'] } } },
    views: { items: { kind: 'list', from: 'item', label: 'Items' } },
    home: 'items',
    nav: ['items'],
  },
  'tenant search fixture',
);

before(async () => {
  fake = await startFakeTypesense(KEY);
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE item (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO item VALUES ('north-1', 'north', 'Granite slab'), ('north-2', 'north', 'Marble tile'),
      ('south-1', 'south', 'Granite block'), ('south-2', 'south', 'Slate roof');
  `);
  registry = new Registry();
  registry.onWarning = () => {};
  registry.add({ id: connection, name: connection, url: path, writable: true, source: 'config' });
  plugSearch(registry, typesenseSearch([{ name: 'search', url: fake.url, insecure: true, auth: { apiKey: KEY } }]));
});

after(async () => {
  await indexerFor(registry).settled();
  await registry.closeAll();
  db.close();
  await fake.close();
  rmSync(directory, { recursive: true, force: true });
});

/* A tenant context's reader, as the tenant host hands one over: frozen, and
   reading only its tenant's rows whatever it is asked. */
function readerOf(adapter: Adapter, tenant: string): Adapter {
  return Object.freeze({
    query: (request: QueryRequest) =>
      adapter.query({
        ...request,
        filter: {
          groups: (request.filter?.groups ?? [[]]).map((group) => [...group, { column: 'tenant', op: '=' as const, value: tenant }]),
        },
      }),
  }) as unknown as Adapter;
}

const searchAs = async (tenant: string, text: string) => {
  const { adapter, schema } = await registry.open(connection);
  const reader = tenantSearchAdapter(readerOf(adapter, tenant), { registry, app, schema, tenantId: tenant, tenantColumns });
  const read = await reader.query({
    table: 'item',
    filter: { groups: [[{ column: 'name', op: 'contains', value: text }]] },
    limit: 50,
    offset: 0,
  });
  return read.rows.map((row) => String(row.id)).sort();
};

test("a tenant App's search asks one index within the reader's tenant, follows its writes, and never shows another tenant's rows", async () => {
  // The operator fills the index; each document keeps its row's tenant.
  assert.deepEqual(await indexerFor(registry).reindex(app, connection, undefined, undefined, tenantColumns), [
    { resource: 'item', indexed: 4 },
  ]);
  const docs = fake.collections.get('mistri_depot_item')!.documents;
  assert.equal(docs.get('north-1')?.mistri_tenant, 'north');

  assert.deepEqual(await searchAs('north', 'granite'), ['north-1']);
  assert.deepEqual(await searchAs('south', 'granite'), ['south-1']);
  assert.ok(fake.requests.some((request) => decodeURIComponent(request.path).includes('filter_by=mistri_tenant:=`north`')));

  // The engine answered, not the database: renamed behind the index, north-1 is still found by what it was.
  db.exec(`UPDATE item SET name = 'Basalt slab' WHERE id = 'north-1'`);
  assert.deepEqual(await searchAs('north', 'granite'), ['north-1']);

  // A document planted in north's slice under south's key is still read as north reads: nothing of south's.
  docs.set('south-2', { id: 'south-2', name: 'Granite planted', mistri_tenant: 'north' });
  assert.deepEqual(await searchAs('north', 'granite'), ['north-1']);

  // The index follows a write, its document keeping its row's tenant.
  db.exec(`INSERT INTO item VALUES ('north-3', 'north', 'Granite kerb')`);
  indexerFor(registry).touched(app, { connection, resource: 'item', physical: 'item' }, { id: 'north-3' }, 'tenant', tenantColumns);
  await indexerFor(registry).settled();
  assert.equal(docs.get('north-3')?.mistri_tenant, 'north');
  assert.deepEqual(await searchAs('north', 'kerb'), ['north-3']);
  assert.deepEqual(await searchAs('south', 'kerb'), []);
});
