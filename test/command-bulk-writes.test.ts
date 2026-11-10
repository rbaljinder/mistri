/**
 * A handler's batch writes (commands/commandDb.ts): `db.<table>.insertMany(rows)` and `db.<table>.updateWhere(where,
 * changes)` each write their rows in one statement on SQLite, under the same checks a row-at-a-time write meets —
 * the footprint and its column ceiling, the stamps and the audit, one change per row; a row the database refuses
 * rolls the batch back whole. The statement is counted at the
 * adapter's batch methods, so a fall back to one write per row reads as a failure here, not a slow command.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';
import { sqliteAuditRows } from './support/commandTargets.js';

const clerk: Identity = { id: 'account-clerk', who: 'ada@example.test', role: 'clerk' };
type Row = Record<string, unknown>;
type Db = Record<string, { insertMany(rows: Row[]): Promise<Row[]>; updateWhere(where: Row, changes: Row): Promise<Row[]> }>;

/* Each batch statement the adapter runs, and how many rows it carried. */
const statements: { kind: 'insert' | 'update'; rows: number }[] = [];
const proto = SqliteAdapter.prototype as unknown as Record<string, (requests: readonly unknown[], handle: unknown) => unknown>;
const insertManyNow = proto.insertManyNow!;
const updateManyNow = proto.updateManyNow!;

let directory: string;
let db: DatabaseSync;
let connections: Registry;
let server: ReturnType<typeof createApp>;
let base: string;
let written: Row[] = [];

const handler = (run: (db: Db, shelf: number) => Promise<Row[]>) =>
  defineCommand({
    source: 'depot',
    target: 'shelf',
    write: ['bin'],
    track: 'audit',
    async handle(context: unknown) {
      const { db, record } = context as { db: Db; record: { id: number } };
      written = await run(db, record.id);
    },
  } as Parameters<typeof defineCommand>[0]);

before(async () => {
  proto.insertManyNow = function (requests, handle) {
    statements.push({ kind: 'insert', rows: requests.length });
    return insertManyNow.call(this, requests, handle);
  };
  proto.updateManyNow = function (requests, handle) {
    statements.push({ kind: 'update', rows: requests.length });
    return updateManyNow.call(this, requests, handle);
  };
  directory = mkdtempSync(join(tmpdir(), 'mistri-bulk-writes-'));
  const file = join(directory, 'depot.db');
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE shelf (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO shelf (id, name) VALUES (1, 'A'), (2, 'B');
    CREATE TABLE bin (id INTEGER PRIMARY KEY, shelf_id INTEGER NOT NULL REFERENCES shelf(id), sku TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0, note TEXT, counted_by TEXT);
    INSERT INTO bin (id, shelf_id, sku, qty) VALUES (90, 2, 'other', 4);`);
  migrateSqliteCommandJournal(file);
  clearJournal('depot-db');
  connections = new Registry();
  connections.add({ id: 'depot-db', name: 'Depot', url: file, writable: true, source: 'config' });
  const commands = ['restock', 'recount', 'scribble', 'scribbleOne', 'misstock'];
  const manifest = parseAppConfig(
    {
      id: 'depot',
      name: 'Depot',
      sources: { depot: { connection: 'depot-db', default: true } },
      resources: {
        shelf: { access: 'write', actions: Object.fromEntries(commands.map((command) => [command, { label: command, command }])) },
        bin: {
          access: 'write',
          fields: { read: ['id', 'shelf_id', 'sku', 'qty', 'note', 'counted_by'], write: ['shelf_id', 'sku', 'qty', 'counted_by'] },
        },
      },
      auth: { providers: ['email'], roles: { clerk: { read: true, commands } } },
      views: { shelves: { kind: 'list', from: 'shelf' } },
      home: 'shelves',
      nav: ['shelves'],
    },
    'bulk writes',
    { commands: catalogOf(Object.fromEntries(commands.map((command) => [command, { target: 'shelf' }]))) },
  );
  const registry = defineCommands({
    restock: handler((db, shelf) => db.bin!.insertMany(['x', 'y', 'z'].map((sku, at) => ({ shelf_id: shelf, sku, qty: at + 1 })))),
    recount: handler((db, shelf) => db.bin!.updateWhere({ shelf_id: shelf }, { qty: 0, counted_by: { auto: 'me' } })),
    scribble: handler((db, shelf) => db.bin!.insertMany([{ shelf_id: shelf, sku: 'w', note: 'not granted' }])),
    misstock: handler((db, shelf) =>
      db.bin!.insertMany([
        { shelf_id: shelf, sku: 'v' },
        { shelf_id: shelf, sku: null },
      ]),
    ),
    scribbleOne: handler(async (db, shelf) => [
      await (db.bin as unknown as { insert(row: Row): Promise<Row> }).insert({ shelf_id: shelf, sku: 'w', note: 'not granted' }),
    ]),
  });
  const pages = parsePagesConfig({ pages: [] }, 'bulk pages');
  const host: AppHost = {
    app: { app: manifest, path: '/private/depot/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/depot/auth.db', close() {}, handler: async () => {}, session: async () => clerk },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry: connections, bound, apps: [host], pages, commands: { appId: 'depot', registry } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  base = `http://${bound.host}:${bound.port}`;
});

after(async () => {
  proto.insertManyNow = insertManyNow;
  proto.updateManyNow = updateManyNow;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  db.close();
  await connections.closeAll();
  clearJournal();
  rmSync(directory, { recursive: true, force: true });
});

let requests = 0;
async function run(command: string): Promise<{ status: number; body: Row }> {
  const headers = { 'content-type': 'application/json', 'x-mistri-account': clerk.id };
  const prepared = (await fetch(`${base}/api/commands/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command, commandVersion: 1, key: { id: 1 } }),
  }).then((r) => r.json())) as { expectedVersion: number };
  const response = await fetch(`${base}/api/commands/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      command,
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: prepared.expectedVersion,
      idempotencyKey: `bulk-writes-request-${String(++requests).padStart(4, '0')}`,
      input: {},
    }),
  });
  return { status: response.status, body: (await response.json()) as Row };
}

const bins = () => db.prepare('SELECT id, shelf_id, sku, qty, note, counted_by FROM bin ORDER BY id').all() as Row[];
const changesOf = (receiptId: unknown) =>
  (
    db.prepare(`SELECT changes_json FROM ${sqliteAuditRows} a WHERE receipt_id = ?`).all(String(receiptId)) as { changes_json: string }[]
  ).flatMap((row) => JSON.parse(row.changes_json) as { operation: string; resource: string; key: Row; before?: Row; after?: Row }[]);

test('insertMany writes every row in one statement, in order, with an audit change for each', async () => {
  statements.length = 0;
  const { status, body } = await run('restock');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(statements, [{ kind: 'insert', rows: 3 }]);
  assert.deepEqual(
    written.map((row) => [row.sku, row.qty]),
    [
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ],
  );
  const stored = bins().filter((row) => row.shelf_id === 1);
  assert.deepEqual(
    stored.map((row) => row.sku),
    ['x', 'y', 'z'],
  );
  const changes = changesOf(body.receiptId);
  assert.deepEqual(
    changes.map((change) => [change.operation, change.resource, change.after?.sku]),
    [
      ['insert', 'bin', 'x'],
      ['insert', 'bin', 'y'],
      ['insert', 'bin', 'z'],
    ],
  );
});

test('updateWhere changes only the rows it matches, in one statement, each audited with its before image', async () => {
  statements.length = 0;
  const { status, body } = await run('recount');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(statements, [{ kind: 'update', rows: 3 }]);
  assert.deepEqual(
    written.map((row) => [row.sku, row.qty, row.counted_by]),
    [
      ['x', 0, 'ada@example.test'],
      ['y', 0, 'ada@example.test'],
      ['z', 0, 'ada@example.test'],
    ],
  );
  assert.deepEqual(
    bins().map((row) => [row.sku, row.qty]),
    [
      ['other', 4],
      ['x', 0],
      ['y', 0],
      ['z', 0],
    ],
  );
  const changes = changesOf(body.receiptId);
  assert.deepEqual(
    changes.map((change) => [change.operation, change.before?.qty, change.after?.qty]),
    [
      ['update', 1, 0],
      ['update', 2, 0],
      ['update', 3, 0],
    ],
  );
});

test('a batch meets the same column ceiling as one insert: a command writes its footprint whatever a role may edit', async () => {
  const batch = await run('scribble');
  const one = await run('scribbleOne');
  assert.equal(batch.status, one.status, JSON.stringify([batch.body, one.body]));
  assert.deepEqual(
    bins()
      .filter((row) => row.sku === 'w')
      .map((row) => row.note),
    ['not granted', 'not granted'],
  );
});

test('a row the database refuses rolls the whole batch back, and keeps no receipt', async () => {
  statements.length = 0;
  const before = bins();
  const receipts = db.prepare(`SELECT count(*) AS n FROM ${sqliteAuditRows} a`).get()!.n;
  const { status, body } = await run('misstock');
  assert.notEqual(status, 200, JSON.stringify(body));
  assert.deepEqual(statements, [{ kind: 'insert', rows: 2 }]);
  assert.deepEqual(bins(), before);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM ${sqliteAuditRows} a`).get()!.n, receipts);
});
