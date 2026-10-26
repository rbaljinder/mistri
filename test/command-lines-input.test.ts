/**
 * A command's lines (`field.lines`): an order's items asked as the lines grid
 * asks them, and handed to the handler as typed rows it writes itself, in its
 * own transaction, under the command's grant rather than the table's. The
 * declaration is judged where it is written (one parser, browser and server),
 * against the catalog where the App loads, and each line's cells as their
 * columns' kinds where the command runs: a missing or mistyped cell is refused
 * by its path (`lines[1].quantity`), as is a line the handler refuses, and
 * nothing is written. Through the real HTTP routes of a single App.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { commandInputProblem } from '../packages/mistri/src/shared/command.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { CommandInputRefusal, commandInputProblems, readCommandInput } from '../packages/mistri/src/shared/commandInput.js';
import { lineCell } from '../packages/mistri/src/shared/commandLineCell.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { refuse } from '../packages/mistri/src/server/commands/commandErrors.js';
import { text } from '../packages/mistri/src/server/commands/commandShapes.js';

const lines = (options: object = {}) => ({ type: 'lines', from: 'order_line', show: ['product_id', 'quantity'], ...options });

test('lines are declared once: from, show, copy, min and max, never optional, public or in a group', () => {
  const [read] = parseCommandInput({ items: lines({ copy: { unit_price: 'product_id.price' }, min: 1 }) }, 'Command input');
  assert.deepEqual(read, {
    name: 'items',
    label: 'Items',
    type: 'lines',
    from: 'order_line',
    show: ['product_id', 'quantity'],
    copy: { unit_price: 'product_id.price' },
    min: 1,
    // Fifty lines unless it says fewer: a repeating group's ceiling.
    max: 50,
  });
  assert.equal(
    parseCommandInput({ items: lines({ description: 'Tax is added on save.' }) }, 'Command input')[0].help,
    'Tax is added on save.',
  );
  // A picker narrowed as a reference's is: what is offered, not what the handler accepts.
  const narrowed = parseCommandInput({ items: lines({ query: { product_id: 'price > 0' } }) }, 'Command input')[0];
  assert.deepEqual(narrowed.type === 'lines' && narrowed.query, {
    product_id: 'price > 0',
  });
  const refused: Array<[object, RegExp]> = [
    [lines({ optional: true }), /lines take no optional, default or when/],
    [lines({ default: 1 }), /lines take no optional, default or when/],
    [lines({ help: 'x' }), /\(a lines field\) has no "help"/],
    [lines({ show: [] }), /show names one to 12/],
    [lines({ show: ['quantity', 'quantity'] }), /show names one to 12/],
    [lines({ show: Array.from({ length: 13 }, (_, i) => `c${i}`) }), /dense list of at most 12/],
    [lines({ copy: { unit_price: 'customer_id.price' } }), /copied through "customer_id", which the line does not show/],
    [lines({ copy: { quantity: 'product_id.stock' } }), /is asked in show; a copied column is filled, not typed/],
    [lines({ copy: { unit_price: 'product_id.price.cents' } }), /is a reference the line shows and the column of the record it names/],
    [lines({ min: 3, max: 2 }), /min must not exceed max/],
    [lines({ max: 51 }), /max must be a whole number of lines up to 50/],
    [lines({ query: 'x' }), /query is an object of a shown reference/],
    [lines({ query: { customer_id: 'active = true' } }), /query "customer_id": names a column the line does not show/],
    [lines({ query: { product_id: 'id = record.product_id' } }), /a line has no one record to read it from/],
  ];
  for (const [raw, message] of refused) assert.throws(() => parseCommandInput({ items: raw }, 'Command input'), message);
  assert.throws(
    () => parseCommandInput({ items: lines() }, 'Command input', { publicForm: true }),
    /a public form may not read a directory/,
  );
  assert.throws(
    () => parseCommandInput({ group: { type: 'group', fields: { items: lines() } } }, 'Command input'),
    /lines are a field of the input itself, not one inside a group/,
  );
});

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: false, ...extra });
const product: TableMeta = {
  id: 'product',
  name: 'product',
  columns: [column('id', 'INTEGER', { primaryKey: true }), column('title', 'TEXT'), column('price', 'NUMERIC')],
} as TableMeta;
const line: TableMeta = {
  id: 'order_line',
  name: 'order_line',
  columns: [
    column('id', 'INTEGER', { primaryKey: true }),
    column('order_id', 'INTEGER', { references: { table: 'sales_order', column: 'id' } }),
    column('product_id', 'INTEGER', { references: { table: 'product', column: 'id' } }),
    column('quantity', 'INTEGER'),
    column('unit_price', 'NUMERIC'),
    column('gift', 'BOOLEAN'),
    column('size', 'TEXT', { allowed: ['S', 'M', 'L'] }),
    column('amount', 'NUMERIC', { writable: false }),
  ],
  computed: { amount: { type: 'number', expr: 'quantity * unit_price' } },
} as unknown as TableMeta;
const schema = { tables: [product, line], foreignKeys: [] } as unknown as DatabaseSchema;

test('each line is read as its columns: a cell given and of its kind, by its path', () => {
  const fields = parseCommandInput({ items: lines({ show: ['product_id', 'quantity', 'gift', 'size'], min: 1, max: 2 }) }, 'Command input');
  const cell = (table: string, name: string, value: string | number | boolean) =>
    lineCell(
      schema.tables.find((t) => t.id === table)!,
      name,
      value,
    );
  assert.deepEqual(readCommandInput(fields, { items: [{ product_id: '4', quantity: ' 2 ', gift: 'true', size: 'M' }] }, { cell }), {
    items: [{ product_id: 4, quantity: 2, gift: true, size: 'M' }],
  });
  const first = (input: object) => {
    try {
      readCommandInput(fields, input, { cell });
    } catch (error) {
      assert.ok(error instanceof CommandInputRefusal);
      return `${error.path} ${error.reason}`;
    }
    return 'read';
  };
  const whole = { product_id: 4, quantity: 1, gift: false, size: 'S' };
  assert.equal(first({ items: [] }), 'items too_few');
  assert.equal(first({ items: [whole, whole, whole] }), 'items too_many');
  assert.equal(first({ items: 'many' }), 'items shape');
  assert.equal(first({ items: [whole, { ...whole, quantity: '' }] }), 'items[1].quantity required');
  assert.equal(first({ items: [{ ...whole, quantity: 'lots' }] }), 'items[0].quantity type');
  assert.equal(first({ items: [{ ...whole, size: 'XL' }] }), 'items[0].size choice');
  assert.equal(first({ items: [{ ...whole, gift: 'perhaps' }] }), 'items[0].gift type');
  assert.equal(first({ items: [{ ...whole, quantity: { n: 1 } }] }), 'items[0].quantity type');
  // A column the line does not show is not the browser's to send: the price is the handler's to read.
  assert.equal(first({ items: [{ ...whole, unit_price: 1 }] }), 'items[0] shape');
  // Every problem at once, for the grid to mark each cell.
  assert.deepEqual(
    commandInputProblems(
      fields,
      {
        items: [
          { ...whole, product_id: '' },
          { ...whole, quantity: 'x' },
        ],
      },
      { cell },
    ).map((p) => p.path),
    ['items[0].product_id', 'items[1].quantity'],
  );
});

test('where the App loads, the lines name the rows of a resource, the columns a form writes, and a copy it can read', () => {
  const problem = (raw: object) => commandInputProblem(parseCommandInput({ items: raw }, 'Command input'), schema);
  assert.equal(problem(lines({ copy: { unit_price: 'product_id.price' } })), undefined);
  assert.match(problem(lines({ from: 'basket_line' }))!, /asks lines of "basket_line", which is not a resource the command writes/);
  assert.match(problem(lines({ show: ['product_id', 'qty'] }))!, /"qty" is not a column of order_line/);
  assert.match(problem(lines({ show: ['product_id', 'amount'] }))!, /"amount" is worked out, not written by a form/);
  // A reader who may not write the table still has the command's form: its catalog's `writable` is not the command's grant.
  const readOnly = { ...line, columns: line.columns.map((c) => ({ ...c, writable: false })) } as TableMeta;
  assert.equal(
    commandInputProblem(parseCommandInput({ items: lines() }, 'Command input'), { ...schema, tables: [product, readOnly] }),
    undefined,
  );
  assert.match(
    problem(lines({ show: ['quantity', 'size'], copy: { unit_price: 'size.price' } }))!,
    /copies "unit_price" through "size", which is not a reference/,
  );
  assert.match(
    problem(lines({ copy: { unit_price: 'product_id.cost' } }))!,
    /copies "unit_price" from "cost", which is not a column of product/,
  );
  assert.equal(problem(lines({ query: { product_id: 'price > 10' } })), undefined);
  assert.match(problem(lines({ query: { quantity: 'price > 10' } }))!, /narrows "quantity", which is not a reference of order_line/);
  assert.match(problem(lines({ query: { product_id: 'colour = red' } }))!, /query "product_id": /);
});

test('the lines are written by the command, so they are among its write', () => {
  const base = { source: 'shop', target: 'sales_order', targets: 'none' as const, output: text(), handle: async () => '' };
  assert.throws(
    () => defineCommand({ ...base, input: { items: field.lines('order_line', { show: ['product_id'] }) } }),
    /asks lines of "order_line"; declare it among the command's write/,
  );
  assert.doesNotThrow(() =>
    defineCommand({ ...base, write: ['order_line'], input: { items: field.lines('order_line', { show: ['product_id'] }) } }),
  );
});

test("a command takes an order's lines: typed for its handler, written in its transaction, refused by the cell", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-lines-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE product (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price NUMERIC NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE sales_order (id INTEGER PRIMARY KEY, total NUMERIC NOT NULL CHECK (total >= 0), note TEXT);
    CREATE TABLE order_line (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES sales_order(id),
      line_no INTEGER NOT NULL, product_id INTEGER NOT NULL REFERENCES product(id), quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC NOT NULL, amount NUMERIC NOT NULL);
    INSERT INTO product VALUES (1, 'Tee', 38, 1), (2, 'Scarf', 64, 1), (3, 'Old cap', 20, 0);`);
  migrateSqliteCommandJournal(file);
  clearJournal('shop-db');
  const connections = new Registry();
  connections.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const seen: unknown[] = [];
  const registry = defineCommands({
    placeOrder: defineCommand({
      source: 'shop',
      target: 'sales_order',
      targets: 'none',
      read: ['product'],
      write: ['order_line'],
      input: {
        items: field.lines('order_line', { show: ['product_id', 'quantity'], copy: { unit_price: 'product_id.price' }, min: 1 }),
        note: field.text({ optional: true }),
      },
      output: text(),
      async handle({ db: records }, input) {
        seen.push(input.items);
        let total = 0;
        const priced = [];
        for (const [i, item] of input.items.entries()) {
          // Typed as the rows are: the reference and the count arrive as numbers.
          const id: number = item.product_id;
          const quantity: number = item.quantity;
          const found = await records.product.find({ id });
          if (!found?.active) refuse(`${found?.title ?? 'That product'} is not for sale.`, { field: `items[${i}].product_id` });
          priced.push({ product_id: id, quantity, unit_price: Number(found.price), amount: quantity * Number(found.price) });
          total += quantity * Number(found.price);
        }
        const order = await records.sales_order.insert({ total, note: input.note ?? null });
        for (const [i, item] of priced.entries()) await records.order_line.insert({ order_id: order.id, line_no: i + 1, ...item });
        return `#${order.id}`;
      },
    }),
  });
  const manifest = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'shop-db', default: true } },
      resources: {
        product: {},
        // Within the App's write ceiling, as any table a command writes; the clerk below holds no
        // table write at all, only the command.
        order_line: { access: 'write' },
        sales_order: { access: 'write' },
      },
      auth: { providers: ['email'], roles: { clerk: { read: true, commands: ['placeOrder'] } } },
      views: {
        orders: { kind: 'list', from: 'sales_order' },
        'new-order': { kind: 'form', label: 'New order', command: 'placeOrder' },
      },
      home: 'orders',
      nav: ['orders', 'new-order'],
    },
    'lines inputs',
    { commands: appCommandCatalog(registry, { sources: { shop: { connection: 'shop-db', default: true } } }) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'lines pages');
  const who: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };
  const host: AppHost = {
    app: { app: manifest, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/shop/auth.db', close() {}, handler: async () => {}, session: async () => who },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: connections, bound, apps: [host], pages, commands: { appId: 'shop', registry } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  let requests = 0;
  const place = async (items: unknown) => {
    const response = await fetch(`http://${bound.host}:${bound.port}/api/commands/execute`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': who.id },
      body: JSON.stringify({
        command: 'placeOrder',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `lines-request-${String(++requests).padStart(4, '0')}`,
        input: { items },
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  try {
    // The form's command is served with its lines as declared, for the grid to draw.
    const served = manifest.views!['new-order'] as { command: { input: Array<{ name: string; type: string }> } };
    assert.deepEqual(
      served.command.input.map((input) => [input.name, input.type]),
      [
        ['items', 'lines'],
        ['note', 'text'],
      ],
    );
    const refusedAt = async (items: unknown, path: string) => {
      const sent = await place(items);
      assert.equal(sent.status, 400, `${path} ${JSON.stringify(sent.body)}`);
      assert.equal(sent.body.field, path, JSON.stringify(sent.body));
    };
    await refusedAt([], 'items');
    await refusedAt([{ product_id: 1, quantity: 'two' }], 'items[0].quantity');
    await refusedAt([{ product_id: 1, quantity: 1 }, { quantity: 1 }], 'items[1].product_id');
    // A line the handler refuses names its cell, and the whole order is rolled back with it.
    await refusedAt(
      [
        { product_id: 1, quantity: 1 },
        { product_id: 3, quantity: 1 },
      ],
      'items[1].product_id',
    );
    assert.deepEqual([count('sales_order'), count('order_line')], [0, 0]);

    const sent = await place([
      { product_id: '2', quantity: '3' },
      { product_id: 1, quantity: 1 },
    ]);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(
      (seen.at(-1) as object[]).map((row) => ({ ...row })),
      [
        { product_id: 2, quantity: 3 },
        { product_id: 1, quantity: 1 },
      ],
    );
    assert.deepEqual(
      db
        .prepare('SELECT line_no, product_id, quantity, unit_price, amount FROM order_line ORDER BY line_no')
        .all()
        .map((row) => ({ ...row })),
      [
        { line_no: 1, product_id: 2, quantity: 3, unit_price: 64, amount: 192 },
        { line_no: 2, product_id: 1, quantity: 1, unit_price: 38, amount: 38 },
      ],
    );
    assert.equal(Number(db.prepare('SELECT total FROM sales_order').get()!.total), 230);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
