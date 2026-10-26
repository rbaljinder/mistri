/**
 * A searched field may follow a reference (`owner_id.name`): the document
 * keeps the referenced row's value, a text search of the record's own field
 * asks it too, and a write to the referenced row re-indexes every record
 * that copies it (appSearchRuntime.ts, the reverse step).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';
import { typesenseSearch } from '../packs/search-typesense/src/index.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';

const KEY = 'app-search-paths-key';
const connection = 'search-paths';
const appId = 'paths';
const directory = mkdtempSync(join(tmpdir(), 'tablewalk-search-paths-'));
const path = join(directory, 'desk.db');
let fake: FakeTypesense;
let registry: Registry;
let origin: string;
let server: ReturnType<typeof createApp>;
let db: DatabaseSync;

const raw = (fields: string[]) => ({
  id: appId,
  name: 'Paths',
  connection,
  resources: {
    ticket: { access: 'write', search: { connection: 'search', fields } },
    person: { access: 'write' },
  },
  views: { tickets: { kind: 'list', from: 'ticket' }, people: { kind: 'list', from: 'person' } },
  home: 'tickets',
  nav: ['tickets', 'people'],
});
const manifest = parseAppConfig(raw(['subject', 'requester.name']), 'paths fixture');

before(async () => {
  fake = await startFakeTypesense(KEY);
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, requester INTEGER REFERENCES person(id));
    INSERT INTO person VALUES (1, 'Ann Lee'), (2, 'Bo Diaz');
    INSERT INTO ticket VALUES (1, 'Printer on fire', 1), (2, 'VPN drops', 2), (3, 'New laptop', 1), (4, 'Orphan', NULL);
  `);
  clearJournal(connection);
  registry = new Registry();
  registry.onWarning = () => {};
  registry.add({ id: connection, name: 'Paths', url: path, writable: true, source: 'config' });
  plugSearch(registry, typesenseSearch([{ name: 'search', url: fake.url, insecure: true, auth: { apiKey: KEY } }]));
  const pages = parsePagesConfig({ pages: [] }, 'paths pages');
  const host: AppHost = { app: { path: '/paths/app.ts', app: manifest, pages, sources: {} }, pages: [] };
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
  return (await response.json()) as { rows: Array<Record<string, unknown>>; errors?: unknown[]; key?: Record<string, unknown> };
};
const subjects = (rows: Array<Record<string, unknown>>) => rows.map((row) => row.subject).sort();
const docs = () => fake.collections.get('mistri_paths_ticket')!.documents;

test('a path must follow a declared reference, one step, to a column that exists', async () => {
  const { schema } = await registry.open(connection);
  const problems = (fields: string[]) => resolveResources(parseAppConfig(raw(fields), 'paths'), schema).problems.join('\n');
  assert.equal(problems(['subject', 'requester.name']), '');
  assert.match(problems(['subject.name']), /"subject", which is not a reference of "ticket"/);
  assert.match(problems(['requester.email']), /"person" has no column "email"/);
  assert.match(problems(['requester.name.first']), /more than one reference/);
});

test("reindex copies the referenced row's value into each document", async () => {
  assert.deepEqual(await indexerFor(registry).reindex(manifest, connection), [{ resource: 'ticket', indexed: 4 }]);
  assert.deepEqual(docs().get('1'), { id: '1', subject: 'Printer on fire', requester__name: 'Ann Lee' });
  assert.deepEqual(docs().get('4'), { id: '4', subject: 'Orphan' });
});

test("the search box's text asks the record's paths too; a path asked by name asks it alone", async () => {
  assert.deepEqual(subjects((await post('/api/run', { q: 'ticket subject contains "ann"' })).rows), ['New laptop', 'Printer on fire']);
  const asked = fake.requests.filter((r) => r.path.includes('/documents/search')).at(-1)!;
  assert.match(asked.path, /query_by=subject%2Crequester__name/);
  assert.deepEqual(subjects((await post('/api/run', { q: 'ticket requester.name contains "bo"' })).rows), ['VPN drops']);
});

test('a write to the referenced row re-indexes every record that copies it', async () => {
  await post('/api/update', { table: 'person', key: { id: 1 }, values: { name: 'Ann Okafor' } });
  await indexerFor(registry).settled();
  assert.equal(docs().get('1')?.requester__name, 'Ann Okafor');
  assert.equal(docs().get('3')?.requester__name, 'Ann Okafor');
  assert.equal(docs().get('2')?.requester__name, 'Bo Diaz');
  // And the record's own write reads its reference afresh.
  await post('/api/update', { table: 'ticket', key: { id: 2 }, values: { requester: 1 } });
  await indexerFor(registry).settled();
  assert.equal(docs().get('2')?.requester__name, 'Ann Okafor');
});
