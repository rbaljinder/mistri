/** A tenant App's index follows a deletion within the deleted row's tenant: tenants may share a key, and removing
 * one's document must leave the other's. The row is gone by the time the index looks, so the write names the tenant
 * (tenantWriteSource.ts), and core hands it to the provider as a scope (appSearchRuntime.ts). */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';
import { memorySearchProvider, MEMORY_SEARCH_CONNECTION } from '../packages/mistri/src/server/app/memorySearch.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { sqliteSearch } from '../packs/search-sqlite/src/index.js';
import { typesenseSearch } from '../packs/search-typesense/src/index.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';

const connection = 'tenant-search-remove';
const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-search-remove-'));
const tenantColumns = { item: 'tenant' };
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
  'tenant search remove fixture',
);

let db: DatabaseSync;
let registry: Registry;
let provider: ReturnType<typeof sqliteSearch>;
before(async () => {
  db = new DatabaseSync(join(directory, 'depot.db'));
  // Search needs a single-column key, but tenants kept in separate databases each have an item 1, and one index
  // holds both: the rows are gone from this table (the deletion already happened), the documents are not.
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL);`);
  registry = new Registry();
  registry.onWarning = () => {};
  registry.add({ id: connection, name: connection, url: join(directory, 'depot.db'), writable: true, source: 'config' });
  provider = sqliteSearch([{ name: 'search', file: join(directory, 'search.db') }]);
  plugSearch(registry, provider);
});
after(async () => {
  await indexerFor(registry).settled();
  provider.close();
  await registry.closeAll();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a deletion removes the deleted row's document within its tenant, and the other tenant's under the same key stays", async () => {
  const indexer = indexerFor(registry);
  const index = provider.index('search')!;
  const collection = 'mistri_depot_item';
  await index.ensureCollection(collection, ['name']);
  await index.upsert(collection, { id: '1', name: 'Granite slab', mistri_tenant: 'north' });
  await index.upsert(collection, { id: '1', name: 'Granite block', mistri_tenant: 'south' });
  const asked = (tenant: string) => index.search(collection, 'granite', ['name'], 10, { field: 'mistri_tenant', value: tenant });
  assert.deepEqual(await asked('north'), ['1']);
  assert.deepEqual(await asked('south'), ['1']);

  indexer.touched(app, { connection, resource: 'item', physical: 'item' }, { id: '1' }, 'tenant', tenantColumns, 'north');
  await indexer.settled();
  assert.deepEqual(await asked('north'), [], "north's document is gone");
  assert.deepEqual(await asked('south'), ['1'], "south's, under the same key, is not");

  // A removal that cannot say whose it was removes nothing: leaving a stale hit beats deleting another tenant's.
  indexer.touched(app, { connection, resource: 'item', physical: 'item' }, { id: '1' }, 'tenant', tenantColumns);
  await indexer.settled();
  assert.deepEqual(await asked('south'), ['1']);
  indexer.touched(app, { connection, resource: 'item', physical: 'item' }, { id: '1' }, 'tenant', tenantColumns, 'south');
  await indexer.settled();
  assert.deepEqual(await asked('south'), []);
});

test('a scoped remove on the memory index and on Typesense keeps a document that is another tenant’s', async () => {
  const memory = memorySearchProvider.index(MEMORY_SEARCH_CONNECTION)!;
  await memory.ensureCollection('c', ['name']);
  await memory.upsert('c', { id: '1', name: 'Granite', mistri_tenant: 'south' });
  await memory.remove('c', '1', { field: 'mistri_tenant', value: 'north' });
  assert.deepEqual(await memory.search('c', 'granite', ['name'], 10), ['1']);
  await memory.remove('c', '1', { field: 'mistri_tenant', value: 'south' });
  assert.deepEqual(await memory.search('c', 'granite', ['name'], 10), []);

  const fake: FakeTypesense = await startFakeTypesense('k');
  try {
    const index = typesenseSearch([{ name: 'search', url: fake.url, insecure: true, auth: { apiKey: 'k' } }]).index('search')!;
    await index.ensureCollection('c', ['name', 'mistri_tenant']);
    await index.upsert('c', { id: '1', name: 'Granite', mistri_tenant: 'south' });
    await index.remove('c', '1', { field: 'mistri_tenant', value: 'north' });
    assert.deepEqual(await index.search('c', 'granite', ['name'], 10), ['1']);
    await index.remove('c', '1', { field: 'mistri_tenant', value: 'south' });
    assert.deepEqual(await index.search('c', 'granite', ['name'], 10), []);
  } finally {
    await fake.close();
  }
});
