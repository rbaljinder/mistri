import { parseTestApp } from './support/commandCatalog.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteLiveChange, readSqliteLiveChanges } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';

/* Orders and their lines, written only through `place`, a command that creates
   an order with up to three lines. A file holds one line per row; consecutive
   rows that agree on the order number are one order, one run of the command.
   A check tries each run in a transaction that is always rolled back; a commit
   runs the same inputs, each run its own transaction. */
const sessions: Record<string, Identity> = {
  clerk: { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' },
};
const placeInput = {
  number: { label: 'Order number', type: 'text' },
  customer: { label: 'Customer', type: 'reference', from: 'customer', by: 'id', labelColumn: 'name' },
  lines: {
    label: 'Lines',
    type: 'group',
    repeat: { max: 3 },
    fields: {
      sku: { label: 'Item code', type: 'text' },
      quantity: { label: 'Quantity', type: 'number', integer: true },
    },
  },
} as const;
const placeRef = { id: 'place', version: 1, target: 'sales_order', targets: 'none', input: placeInput };
const chargeRef = { id: 'charge', version: 1, target: 'sales_order', targets: 'none', input: placeInput };

function definition(command: object = placeRef) {
  const id = (command as { id: string }).id;
  return parseTestApp(
    {
      id: 'orders',
      name: 'Orders',
      live: true,
      sources: { sales: { connection: 'order-db' } },
      resources: {
        sales_order: { access: 'write', import: { command, match: ['number'], group: ['number'] } },
        customer: { recordLabel: 'name', address: 'code' },
        order_line: { access: 'write' },
      },
      auth: { roles: { clerk: { read: true, commands: [id] } } },
      views: { orders: { kind: 'list', from: 'sales_order' } },
      home: 'orders',
      nav: ['orders'],
    },
    'grouped command import fixture',
  );
}

type Order = { number: string; customer?: string | number; lines: { sku: string; quantity: number }[] };

async function fixture(
  run: (f: { post: (body: object) => Promise<{ status: number; body: any }>; db: DatabaseSync; calls: Order[] }) => Promise<void>,
  options: { provider?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-import-runs-'));
  const file = join(directory, 'orders.db');
  const db = new DatabaseSync(file);
  // Customer 2 is named what customer 1's code says: the code, the natural key, is read first.
  db.exec(`CREATE TABLE customer(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE sales_order(id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer INTEGER NOT NULL REFERENCES customer(id),
      version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE order_line(id INTEGER PRIMARY KEY, sales_order INTEGER NOT NULL REFERENCES sales_order(id), sku TEXT NOT NULL,
      quantity INTEGER NOT NULL);
    INSERT INTO customer VALUES (1, 'NORTH', 'Acme North'), (2, 'SOUTH', 'NORTH');
    INSERT INTO sales_order(id, number, customer) VALUES (1, 'SO-1', 1);
    INSERT INTO order_line(sales_order, sku, quantity) VALUES (1, 'BOLT', 4);`);
  migrateSqliteCommandJournal(file);
  provisionSqliteLiveChange(file);
  const registry = new Registry();
  registry.add({ id: 'order-db', name: 'Orders', url: file, writable: true, source: 'config' });
  const app = definition(options.provider ? chargeRef : placeRef);
  const calls: Order[] = [];
  const handler = {
    target: 'sales_order',
    targets: 'none' as const,
    input: placeInput,
    source: 'sales',
    read: ['customer'],
    write: ['sales_order', 'order_line'],
    output: { parse: (value: unknown) => value as { id: number } },
    async handle({ tx }: any, input: any) {
      calls.push(input);
      const made = await tx.insert({ table: 'sales_order', values: { number: input.number, customer: Number(input.customer) } });
      for (const line of input.lines) {
        if (line.sku === 'RECALLED') refuse('RECALLED is withdrawn from sale.');
        await tx.insert({ table: 'order_line', values: { sales_order: Number(made.key.id), sku: line.sku, quantity: line.quantity } });
      }
      return { id: Number(made.key.id) };
    },
  };
  const commands = defineCommands(
    options.provider
      ? { charge: defineCommand({ ...handler, integrations: { stripe: ['charge'] }, lookup: async () => ({}) } as never) }
      : { place: defineCommand(handler as never) },
  );
  const host: AppHost = {
    app: { app, path: '/private/orders/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/orders/auth.db',
      close() {},
      handler: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'orders', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  try {
    await run({
      db,
      calls,
      post: async (body) => {
        const response = await fetch(`${base}/api/import?app=orders`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', cookie: 'session=clerk' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const sheet = (lines: string[], mode: 'check' | 'commit' = 'check', extra: object = {}) => ({
  table: 'sales_order',
  view: 'orders',
  csv: ['Number,Customer,Item code,Quantity', ...lines].join('\n'),
  mapping: ['number', 'customer', 'lines.sku', 'lines.quantity'],
  mode,
  ...extra,
});

/* Every row of every table in the file: the business tables, receipts, journal, provenance, sequences, staged files, live changes. */
function snapshot(db: DatabaseSync) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(
    tables.map((name) => [
      name,
      db
        .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
}

const orders = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT o.number, o.customer,
         (SELECT group_concat(sku || 'x' || quantity, ' ') FROM (SELECT sku, quantity FROM order_line WHERE sales_order = o.id ORDER BY id)) AS lines
       FROM sales_order o ORDER BY o.id`,
    )
    .all()
    .map((row) => ({ ...row }));

test('consecutive rows that agree on the order number are one order, and a commit creates each with its lines', async () => {
  await fixture(async ({ post, db, calls }) => {
    const run = await post(sheet(['SO-2,NORTH,NUT,10', 'SO-2,NORTH,BOLT,5', 'SO-3,Acme North,WASHER,1'], 'commit'));
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.outcome, 'applied', JSON.stringify(run.body));
    assert.equal(run.body.applied, 3);
    assert.deepEqual(
      run.body.runs.map((r: any) => [r.rows, r.outcome]),
      [
        [[1, 2], 'create'],
        [[3], 'create'],
      ],
    );
    // "NORTH" is customer 1's code before it is customer 2's name; "Acme North" is a name only.
    assert.deepEqual(
      calls.map((call) => [call.number, call.customer, call.lines.map((line) => ({ ...line }))]),
      [
        [
          'SO-2',
          1,
          [
            { sku: 'NUT', quantity: 10 },
            { sku: 'BOLT', quantity: 5 },
          ],
        ],
        ['SO-3', 1, [{ sku: 'WASHER', quantity: 1 }]],
      ],
    );
    assert.deepEqual(orders(db), [
      { number: 'SO-1', customer: 1, lines: 'BOLTx4' },
      { number: 'SO-2', customer: 1, lines: 'NUTx10 BOLTx5' },
      { number: 'SO-3', customer: 1, lines: 'WASHERx1' },
    ]);
  });
});

test('a run is refused whole: a record its key finds, a repeat of an earlier run, a disagreeing cell, one row too many', async () => {
  await fixture(async ({ post, calls }) => {
    const checked = await post(
      sheet([
        'SO-1,NORTH,NUT,1', // 1: SO-1 is on file already
        'SO-4,NORTH,NUT,1', // 2: a run of its own
        'SO-5,NORTH,NUT,1', // 3–4: the second row names another customer
        'SO-5,SOUTH,BOLT,2',
        'SO-6,NORTH,A,1', // 5–8: four lines, and an order takes three
        'SO-6,NORTH,B,1',
        'SO-6,NORTH,C,1',
        'SO-6,NORTH,D,1',
        'SO-4,NORTH,BOLT,1', // 9: SO-4 again, not beside its first run: never reordered, so a second order
      ]),
    );
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.outcome, 'checked');
    assert.equal(checked.body.ready, 1);
    const said = Object.fromEntries(checked.body.refused.map((r: any) => [r.row, r.problems.map((p: any) => p.message).join(' | ')]));
    assert.match(said[1], /^Order number SO-1 finds a record already; this import creates records\.$/);
    assert.match(said[4], /^This disagrees with row 3, which starts its run; a run's rows say "Customer" alike\.$/);
    assert.match(said[3], /^Not imported: row 4 of its run is refused\.$/);
    assert.match(said[5], /^This run has 4 rows; "Lines" takes at most 3\. Split it\.$/);
    assert.match(said[6], /^Not imported: row 5 of its run is refused\.$/);
    assert.match(said[9], /^Row 2 creates this record already; each record is imported once\.$/);
    assert.equal(said[2], undefined);
    assert.deepEqual(
      checked.body.runs.map((r: any) => [r.rows, r.outcome]),
      [
        [[1], 'refused'],
        [[2], 'create'],
        [[3, 4], 'refused'],
        [[5, 6, 7, 8], 'refused'],
        [[9], 'refused'],
      ],
    );
    // Only the ready run was tried.
    assert.deepEqual(
      calls.map((call) => call.number),
      ['SO-4'],
    );
  });
});

test('a dry run tries each run and rolls it back: no row, receipt, journal entry or live change stays', async () => {
  await fixture(async ({ post, db, calls }) => {
    const before = snapshot(db);
    assert.ok(Object.keys(before).some((name) => name.includes('receipt')));
    assert.ok(Object.keys(before).some((name) => name.includes('live_change')));
    const lines = [
      'SO-2,NORTH,NUT,10',
      'SO-2,NORTH,BOLT,5',
      'SO-3,NORTH,WASHER,1',
      'SO-4,SOUTH,NUT,2',
      'SO-5,SOUTH,BOLT,1',
      'SO-6,NORTH,NUT,3',
      'SO-6,NORTH,RECALLED,1', // row 7: the handler refuses it, inside the trial
      'SO-7,NORTH,NUT,1',
    ];
    const checked = await post(sheet(lines));
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.outcome, 'checked');
    assert.equal(checked.body.ready, 6);
    assert.deepEqual(
      checked.body.refused.map((r: any) => [r.row, r.problems.map((p: any) => p.message).join(' | ')]),
      [
        [6, 'RECALLED is withdrawn from sale.'],
        [7, 'Not imported: row 6 of its run is refused.'],
      ],
    );
    assert.deepEqual(checked.body.runs[0], { rows: [1, 2], outcome: 'create', writes: { sales_order: 1, order_line: 2 }, problems: [] });
    assert.equal(checked.body.runs[4].outcome, 'refused');
    assert.deepEqual(checked.body.runs[4].rows, [6, 7]);
    assert.equal(calls.length, 6, 'every ready run was tried');
    assert.deepEqual(snapshot(db), before, 'the trial left every table as it found it');

    // The commit runs what the check tried; this time each run's writes, receipt and live change stay.
    const committed = await post(sheet(lines, 'commit'));
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    // The commit runs the handler again: the run it refused in the trial it refuses now, and only that run.
    assert.equal(committed.body.outcome, 'partial');
    assert.deepEqual(
      committed.body.refused.map((r: any) => r.row),
      [6, 7],
    );
    assert.equal(committed.body.applied, 6);
    assert.deepEqual(
      orders(db).map((row) => row.number),
      ['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5', 'SO-7'],
    );
    assert.ok(readSqliteLiveChanges(db, '0', 100).length > 0, 'a commit is seen live');
    const after = snapshot(db);
    const receipts = Object.keys(after).find((name) => name.endsWith('_receipt'))!;
    assert.equal(after[receipts].length, 5);
  });
});

test('a command that calls a provider is checked without running, and says so', async () => {
  await fixture(
    async ({ post, db, calls }) => {
      const before = snapshot(db);
      const checked = await post(sheet(['SO-2,NORTH,NUT,10', 'SO-2,NORTH,BOLT,5']));
      assert.equal(checked.status, 200, JSON.stringify(checked.body));
      assert.deepEqual(checked.body.runs, [
        { rows: [1, 2], outcome: 'create', writes: {}, problems: [{ message: 'Checked without running: calls a provider.' }], ran: false },
      ]);
      assert.equal(checked.body.ready, 2);
      assert.deepEqual(calls, [], 'neither its lookup nor its handler ran');
      assert.deepEqual(snapshot(db), before);
    },
    { provider: true },
  );
});
