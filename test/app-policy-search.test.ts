/**
 * Under a row policy every write goes through the policy's scoped writer
 * (scopedWrites.ts), not the ordinary write path. The search index follows
 * those writes as it follows any other: an insert, an update, a delete, a
 * record's lines and an import each leave the engine's documents in step
 * with the rows.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';
import { typesenseSearch } from '../packs/search-typesense/src/index.js';
import { plugSearch } from '../packages/mistri/src/server/app/searchProvider.js';

const KEY = 'app-policy-search-key';
const appId = 'desks';
const owner = 'policy-search-db';
const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-search-'));
const file = join(directory, 'desks.db');
const identity = { id: 'desk-one', who: 'one@example.test', role: 'editor' } as Identity;
let fake: FakeTypesense;
let registry: Registry;
let policy: HttpAppPolicy;
let server: ReturnType<typeof createApp>;
let origin: string;

const documents = (resource: string) => fake.collections.get(`mistri_${appId}_${resource}`)?.documents ?? new Map();

before(async () => {
  fake = await startFakeTypesense(KEY);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ticket(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL);
    CREATE TABLE step(id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES ticket(id), note TEXT NOT NULL);
    INSERT INTO ticket(desk, subject) VALUES (1, 'Existing');`);
  db.close();
  registry = new Registry();
  registry.onWarning = () => {};
  registry.add({ id: owner, name: owner, url: file, source: 'config', writable: true });
  plugSearch(registry, typesenseSearch([{ name: 'search', url: fake.url, insecure: true, auth: { apiKey: KEY } }]));
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Desks',
      sources: { main: { connection: owner, default: true } },
      resources: {
        ticket: {
          access: 'write',
          delete: true,
          import: true,
          search: { connection: 'search', fields: ['subject'] },
          form: { show: ['desk', 'subject'], lines: [{ label: 'Steps', from: 'step', whose: 'ticket', show: ['note'] }] },
        },
        step: { access: 'write', delete: true, search: { connection: 'search', fields: ['note'] } },
      },
      auth: { rows: 'policy', roles: { editor: { read: true, write: ['ticket', 'step'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'policy search fixture',
  );
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => identity },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { appId: ${JSON.stringify(appId)},
    authorizeDeletedRecord() { return true; },
    resolveRows() { return { ticket: { groups: [[{ column: 'desk', op: '=', value: 1 }]] }, step: { groups: [[{ column: 'id', op: '>', value: 0 }]] } }; } };`,
  );
  policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => identity });
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, bound, apps: [host], policy });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://${bound.host}:${address.port}`;
});

after(async () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await policy.retire();
  await registry.closeAll();
  await fake.stop();
  clearJournal();
  rmSync(directory, { recursive: true, force: true });
});

async function post(path: string, body: object) {
  const response = await fetch(`${origin}${path}?app=${appId}`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-mistri-account': identity.id },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("a scoped writer's insert, update and delete keep the index in step", async () => {
  // A step: no row refers to it, so the policy lets it be deleted.
  const inserted = await post('/api/insert', { table: 'step', values: { ticket: 1, note: 'Printer jam' } });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.json));
  const id = String(inserted.json.key.id);
  await indexerFor(registry).settled();
  assert.equal(documents('step').get(id)?.note, 'Printer jam');

  const updated = await post('/api/update', { table: 'step', key: { id: Number(id) }, values: { note: 'Printer fixed' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  await indexerFor(registry).settled();
  assert.equal(documents('step').get(id)?.note, 'Printer fixed');

  const removed = await post('/api/delete', { table: 'step', key: { id: Number(id) }, confirm: true });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  await indexerFor(registry).settled();
  assert.equal(documents('step').has(id), false);
});

test("a record's lines saved with it are indexed as records of their own", async () => {
  const inserted = await post('/api/insert', {
    table: 'ticket',
    values: { desk: 1, subject: 'Laptop' },
    lines: { step: [{ values: { note: 'Ordered the charger' } }] },
  });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.json));
  await indexerFor(registry).settled();
  assert.equal(documents('ticket').get(String(inserted.json.key.id))?.subject, 'Laptop');
  assert.deepEqual(
    [...documents('step').values()].map((doc) => doc.note),
    ['Ordered the charger'],
  );
});

test("an import's committed rows are indexed", async () => {
  const written = await post('/api/import', {
    table: 'ticket',
    csv: ['Desk,Subject', '1,Imported row'].join('\n'),
    mapping: ['desk', 'subject'],
    mode: 'commit',
  });
  assert.equal(written.json.outcome, 'applied', JSON.stringify(written.json));
  await indexerFor(registry).settled();
  assert.ok([...documents('ticket').values()].some((doc) => doc.subject === 'Imported row'));
});
