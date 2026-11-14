/**
 * Under the row-security backstop (docs/postgresql.md) the registry's adapter is the runtime role and reads no
 * tenant row, so the search indexer reads through the owner's (`readThrough`), and a non-tenant App or the
 * Workbench on such a connection refuses to start. No server: the "runtime" here is a database with no rows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';
import { assertAppsOffBackstop } from '../packages/mistri/src/server/cli/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { assertNoBackstop } from '../packages/mistri/src/server/tenant/tenantBackstopOwner.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { sqliteSearch } from '../packs/search-sqlite/src/index.js';

const connection = 'backstop-search';
const directory = mkdtempSync(join(tmpdir(), 'mistri-backstop-search-'));
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
  'tenant backstop search fixture',
);
const ddl = `CREATE TABLE item (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL);`;

let runtime: Registry, owner: Registry, provider: ReturnType<typeof sqliteSearch>;
before(() => {
  for (const [file, rows] of [
    ['runtime.db', ''],
    ['owner.db', `INSERT INTO item VALUES ('1', 'north', 'Granite slab'), ('2', 'south', 'Granite block');`],
  ]) {
    const db = new DatabaseSync(join(directory, file));
    db.exec(ddl + rows);
    db.close();
  }
  const open = (file: string) => {
    const registry = new Registry();
    registry.onWarning = () => {};
    registry.add({ id: connection, name: connection, url: join(directory, file), writable: true, source: 'config' });
    return registry;
  };
  runtime = open('runtime.db');
  owner = open('owner.db');
  provider = sqliteSearch([{ name: 'search', file: join(directory, 'search.db') }]);
  plugSearch(runtime, provider);
});
after(async () => {
  await indexerFor(runtime).settled();
  provider.close();
  await Promise.all([runtime.closeAll(), owner.closeAll()]);
  rmSync(directory, { recursive: true, force: true });
});

test("the indexer reads through the owner's adapter when one is registered, and the registry's otherwise", async () => {
  const indexer = indexerFor(runtime);
  const index = provider.index('search')!;
  const collection = 'mistri_depot_item';
  const asked = (tenant: string) => index.search(collection, 'granite', ['name'], 10, { field: 'mistri_tenant', value: tenant });
  const tenantColumns = { item: 'tenant' };

  // The registry's own adapter reads no row: a write removes the document, a reindex indexes nothing.
  await index.ensureCollection(collection, ['name']);
  await index.upsert(collection, { id: '1', name: 'Granite slab', mistri_tenant: 'north' });
  indexer.touched(app, { connection, resource: 'item', physical: 'item' }, { id: '1' }, 'tenant', tenantColumns, 'north');
  await indexer.settled();
  assert.deepEqual(await asked('north'), [], 'with no reader registered the registry finds no row and removes the document');

  const adapter = (await owner.open(connection)).adapter;
  indexer.readThrough(connection, () => adapter);
  indexer.touched(app, { connection, resource: 'item', physical: 'item' }, { id: '1' }, 'tenant', tenantColumns, 'north');
  await indexer.settled();
  assert.deepEqual(await asked('north'), ['1'], "read as the owner, the write keeps its row's document, under its tenant");
  assert.deepEqual(await asked('south'), []);

  const done = await indexer.reindex(app, connection, undefined, undefined, tenantColumns);
  assert.deepEqual(
    done.map((each) => each.indexed),
    [2],
  );
  assert.deepEqual(await asked('south'), ['2'], 'a reindex indexes every tenant, each document keeping its own');

  indexer.readThrough(connection, undefined);
  indexer.touched(app, { connection, resource: 'item', physical: 'item' }, { id: '2' }, 'tenant', tenantColumns, 'south');
  await indexer.settled();
  assert.deepEqual(await asked('south'), [], 'taken back, the registry is read again');
});

test('a connection under the backstop is refused to a non-tenant App and to the Workbench', () => {
  const registry = new Registry();
  registry.add({
    id: 'tenants',
    name: 'tenants',
    url: 'postgres://runtime@localhost/db',
    backstop: 'rls',
    owner: 'postgres://owner@localhost/db',
    source: 'config',
  });
  registry.add({ id: 'plain', name: 'plain', url: join(directory, 'runtime.db'), source: 'config' });
  assert.throws(
    () => assertNoBackstop(registry, 'the Workbench'),
    /connection "tenants" is under the row-security backstop \("backstop": "rls"\); only a tenant App reads through it — the Workbench would see none of its tenant rows\. Point it at the owner's URL instead, or remove "backstop"\./,
  );
  const bound = (scope: string) => [{ ...app, connection: scope }].map((each) => ({ app: each }) as never);
  assert.throws(() => assertAppsOffBackstop(bound('tenants'), registry), /a non-tenant App would see none of its tenant rows/);
  assert.doesNotThrow(() => assertAppsOffBackstop(bound('plain'), registry), 'an App on a connection without it starts');
  assert.doesNotThrow(() => assertNoBackstop(registry, 'the Workbench', ['plain']));
});
