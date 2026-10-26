/**
 * A search engine holds every searched field of every record, whoever may
 * read it. A text filter is asked of it only for fields this reader may read
 * (appSearchRuntime.ts): a role without a field, or without the table a path
 * copies, never learns which rows hold a word there.
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
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';
import { typesenseSearch } from '../packs/search-typesense/src/index.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';

const KEY = 'app-search-grants-key';
const connection = 'search-grants';
const appId = 'grants';
const directory = mkdtempSync(join(tmpdir(), 'tablewalk-search-grants-'));
const path = join(directory, 'desk.db');
let fake: FakeTypesense;
let registry: Registry;
let origin: string;
let server: ReturnType<typeof createApp>;
let role = 'agent';

const manifest = parseAppConfig(
  {
    id: appId,
    name: 'Grants',
    connection,
    resources: {
      ticket: { access: 'write', search: { connection: 'search', fields: ['subject', 'note', 'requester.name'] } },
      person: {},
    },
    auth: {
      roles: {
        agent: { read: true, write: true },
        // Reads tickets without their note, and people by id alone.
        clerk: { read: true, fields: { ticket: { read: ['id', 'subject', 'requester'] }, person: { read: ['id'] } } },
      },
    },
    views: { tickets: { kind: 'list', from: 'ticket' }, people: { kind: 'list', from: 'person' } },
    home: 'tickets',
    nav: ['tickets', 'people'],
  },
  'grants fixture',
);

before(async () => {
  fake = await startFakeTypesense(KEY);
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, note TEXT, requester INTEGER REFERENCES person(id));
    INSERT INTO person VALUES (1, 'Ann Lee'), (2, 'Bo Diaz');
    INSERT INTO ticket VALUES (1, 'Printer on fire', 'severance pending', 1), (2, 'VPN drops', NULL, 2), (3, 'New laptop', NULL, 1);
  `);
  db.close();
  clearJournal(connection);
  registry = new Registry();
  registry.onWarning = () => {};
  registry.add({ id: connection, name: 'Grants', url: path, writable: true, source: 'config' });
  plugSearch(registry, typesenseSearch([{ name: 'search', url: fake.url, insecure: true, auth: { apiKey: KEY } }]));
  const pages = parsePagesConfig({ pages: [] }, 'grants pages');
  const host: AppHost = {
    app: { path: '/grants/app.ts', app: manifest, pages, sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: `account-${role}`, who: `${role}@example.test`, role }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], pages });
  process.env.XDG_CONFIG_HOME = directory;
  server.listen(0, bound.host);
  await once(server, 'listening');
  origin = `http://${bound.host}:${(server.address() as { port: number }).port}`;
  await indexerFor(registry).reindex(manifest, connection);
});

after(async () => {
  await indexerFor(registry).settled();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await registry.closeAll();
  clearJournal(connection);
  await fake.close();
  rmSync(directory, { recursive: true, force: true });
});

const run = async (q: string) => {
  const response = await fetch(`${origin}/api/run`, {
    signal: AbortSignal.timeout(5_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appId, q }),
  });
  const body = (await response.json()) as { rows?: Array<Record<string, unknown>>; errors?: unknown[]; error?: string };
  return {
    status: response.status,
    ids: (body.rows ?? []).map((row) => row.id).sort(),
    refused: Boolean(body.errors?.length || body.error),
  };
};
const searched = () => fake.requests.filter((request) => request.path.includes('/documents/search')).map((request) => request.path);

test('a reader with every field finds a ticket by its note and by its requester', async () => {
  role = 'agent';
  assert.deepEqual((await run('ticket note contains "severance"')).ids, [1]);
  assert.deepEqual((await run('ticket subject contains "ann"')).ids, [1, 3]);
});

test('a field this reader cannot read is never asked of the engine, by name or beside another', async () => {
  role = 'clerk';
  const before = searched().length;
  const note = await run('ticket note contains "severance"');
  assert.ok(note.refused || note.ids.length === 0, `the clerk learned which ticket's note says it: ${JSON.stringify(note)}`);
  const requester = await run('ticket requester.name contains "ann"');
  assert.ok(requester.refused || requester.ids.length === 0, `the clerk learned whose name it is: ${JSON.stringify(requester)}`);
  // The subject is theirs to search: a word in it finds it; a word only in a requester's name finds nothing.
  assert.deepEqual((await run('ticket subject contains "printer"')).ids, [1]);
  assert.deepEqual((await run('ticket subject contains "ann"')).ids, []);
  for (const asked of searched().slice(before)) assert.doesNotMatch(asked, /query_by=[^&]*(note|requester__name)/);
});
