import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { assertAppSearch, indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';
import { typesenseSearch } from '../packs/search-typesense/src/index.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';

/* Inside an App, a text filter on a field a resource declares searchable is
   asked of the search engine, and the rows still come from the database
   through the request's own adapter. Each test asserts what reached the
   engine (the fake keeps every request) as well as what came back. */
const KEY = 'app-search-key';
const connection = 'search-crm';
const appId = 'search-app';
const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-search-'));
const path = join(directory, 'crm.db');
let fake: FakeTypesense;
let registry: Registry;
let origin: string;
let server: ReturnType<typeof createApp>;
let db: DatabaseSync;

const manifest = parseAppConfig(
  {
    id: appId,
    name: 'Search CRM',
    connection,
    resources: {
      contact: { access: 'write', delete: true, search: { connection: 'search', fields: ['name', 'company'] } },
      note: {},
    },
    views: { contacts: { kind: 'list', from: 'contact', label: 'Contacts' }, notes: { kind: 'list', from: 'note', label: 'Notes' } },
    home: 'contacts',
    nav: ['contacts', 'notes'],
  },
  'search fixture',
);

before(async () => {
  fake = await startFakeTypesense(KEY);
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE contact (id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT, secret TEXT);
    INSERT INTO contact VALUES (1, 'Margot Fontaine', 'Stonebridge', 's1'), (2, 'Ada Stone', 'Harbor', 's2'), (3, 'Wei Iyer', 'Greywacke', 's3');
    CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO note VALUES (1, 'stone wall');
  `);
  clearJournal(connection);
  registry = new Registry();
  registry.onWarning = () => {};
  registry.add({ id: connection, name: 'Search CRM', url: path, writable: true, source: 'config' });
  plugSearch(registry, typesenseSearch([{ name: 'search', url: fake.url, insecure: true, auth: { apiKey: KEY } }]));
  const pages = parsePagesConfig({ pages: [{ label: 'Contact', base: 'contact' }] }, 'search pages');
  const host: AppHost = { app: { path: '/search/app.ts', app: manifest, pages, sources: {} }, pages: [] };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], pages });
  process.env.XDG_CONFIG_HOME = directory;
  server.listen(0, bound.host);
  await once(server, 'listening');
  origin = `http://${bound.host}:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await indexerFor(registry).settled();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await registry.closeAll();
  clearJournal(connection);
  db.close();
  await fake.close();
  rmSync(directory, { recursive: true, force: true });
});

const post = async (route: string, body: Record<string, unknown>) => {
  const response = await fetch(`${origin}${route}`, {
    signal: AbortSignal.timeout(5_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appId, ...body }),
  });
  assert.equal(response.status, 200);
  return { json: await response.json(), search: response.headers.get('x-mistri-search') };
};
const names = (rows: Array<Record<string, unknown>>) => rows.map((row) => row.name).sort();
const searchRequests = () => fake.requests.filter((r) => r.path.includes('/documents/search')).length;

test('the DSL takes { connection, fields } and refuses what it cannot index', () => {
  const app = (search: unknown) => () =>
    parseAppConfig(
      { id: 'x', name: 'X', resources: { contact: { search } }, views: { v: { kind: 'list', from: 'contact' } }, home: 'v', nav: ['v'] },
      'fixture',
    );
  assert.throws(app({ fields: ['name'] }), /"search" needs a "connection"/);
  assert.throws(app({ connection: 'search', fields: [] }), /"search" needs "fields"/);
  assert.throws(app({ connection: 'search', fields: ['owner.'] }), /"search" needs "fields"/);
  assert.throws(app({ connection: 'search', fields: ['name', 'name'] }), /names a field twice/);
  assert.throws(app({ connection: 'search', fields: ['name'], engine: 'x' }), /engine/);
});

test('startup refuses a search with no provider plugged in, and one through a connection the provider does not have', () => {
  assert.doesNotThrow(() => assertAppSearch([manifest], registry));
  assert.throws(() => assertAppSearch([manifest], new Registry()), /no search provider is plugged in\. Search providers are packs/);
  const other = new Registry();
  plugSearch(other, typesenseSearch([{ name: 'elsewhere', url: fake.url, insecure: true }]));
  assert.throws(() => assertAppSearch([manifest], other), /searches through "search", which the search provider does not have/);
});

test("reindex writes each record's declared fields, keyed by its primary key, and nothing else", async () => {
  assert.deepEqual(await indexerFor(registry).reindex(manifest, connection), [{ resource: 'contact', indexed: 3 }]);
  const docs = fake.collections.get('mistri_search_app_contact')!.documents;
  assert.deepEqual(docs.get('2'), { id: '2', name: 'Ada Stone', company: 'Harbor' });
  assert.ok([...docs.values()].every((doc) => !('secret' in doc)));
});

test('reindex pages in key order after the last key read, never by an offset', async () => {
  const { adapter } = await registry.open(connection);
  const query = adapter.query.bind(adapter);
  const asked: Array<Record<string, unknown>> = [];
  adapter.query = (request) => {
    asked.push(structuredClone(request) as unknown as Record<string, unknown>);
    return query(request);
  };
  try {
    assert.deepEqual(await indexerFor(registry).reindex(manifest, connection, undefined, 2), [{ resource: 'contact', indexed: 3 }]);
  } finally {
    adapter.query = query;
  }
  assert.equal(asked.length, 2, 'a full page of two, then the last one');
  assert.ok(
    asked.every((request) => request.offset === 0),
    'no page skips rows by offset',
  );
  assert.equal(asked[0].filter, undefined);
  assert.deepEqual(asked[1].filter, { groups: [[{ column: 'id', op: '>', value: 2 }]] });
});

test('a text filter on a searched field is asked of the engine; the rows, and their count, still come from the database', async () => {
  // Changed behind the index's back: the engine still knows the old name, the database the new one.
  db.exec("UPDATE contact SET name = 'Ada Rivers' WHERE id = 2");
  const before = searchRequests();
  const { json, search } = await post('/api/run', { q: 'contact name contains "stone"', exactCount: true });
  assert.equal(search, null);
  assert.deepEqual(json.errors, []);
  assert.deepEqual(names(json.rows), ['Ada Rivers']);
  assert.equal(json.total, 1);
  assert.ok(searchRequests() > before);
  db.exec("UPDATE contact SET name = 'Ada Stone' WHERE id = 2");
});

test('nothing matched is no rows, and a field the index does not hold, or a table with no search, never reaches the engine', async () => {
  assert.deepEqual((await post('/api/run', { q: 'contact name contains "zzz"' })).json.rows, []);
  const before = searchRequests();
  assert.deepEqual(names((await post('/api/run', { q: 'contact secret contains "s1"' })).json.rows), ['Margot Fontaine']);
  assert.equal((await post('/api/run', { q: 'note body contains "stone"' })).json.rows.length, 1);
  assert.equal(searchRequests(), before);
});

test("the App's writes keep the index in step: an insert, an update and a delete", async () => {
  const inserted = await post('/api/insert', { table: 'contact', values: { name: 'Zed Quill', company: 'Quarry' } });
  assert.deepEqual(inserted.json.errors ?? [], []);
  await indexerFor(registry).settled();
  assert.deepEqual(names((await post('/api/run', { q: 'contact company contains "quarry"' })).json.rows), ['Zed Quill']);
  const id = inserted.json.key.id;
  await post('/api/update', { table: 'contact', key: { id }, values: { name: 'Zed Marble' } });
  await indexerFor(registry).settled();
  assert.equal(fake.collections.get('mistri_search_app_contact')!.documents.get(String(id))?.name, 'Zed Marble');
  await post('/api/delete', { table: 'contact', key: { id }, confirm: true });
  await indexerFor(registry).settled();
  assert.equal(fake.collections.get('mistri_search_app_contact')!.documents.has(String(id)), false);
});

test('when the engine does not answer, the filter runs on the database and the reply says so', async () => {
  await fake.stop();
  const { json, search } = await post('/api/run', { q: 'contact name contains "stone"' });
  assert.equal(search, 'database');
  assert.deepEqual(names(json.rows), ['Ada Stone']);
  fake = await startFakeTypesense(KEY);
});
