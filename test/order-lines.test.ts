/**
 * Money in minor units, a new record's lines saved with it, and the live values a
 * form says (money.ts, formLines.ts, http/formLinesWrite.ts): the conversions
 * exact, the declarations judged against the catalog, the lines written in
 * the record's one transaction — each as its own write would be — and the
 * browser's figure the one the server's statement stores.
 *
 * The HTTP saves run on SQLite and, when `TABLEWALK_TEST_PG` names a server,
 * on PostgreSQL, each test in a database of its own: the single-App host, a
 * row-policy App (each line through the policy's writer, in its rows) and a
 * tenant App (each line stamped with the lease's tenant).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { parseAppConfig, resolveDisplay, withRollups, type AppDef } from '../packages/mistri/src/shared/app.js';
import { currencyDigits, minorFigure, minorToMajor, rowCurrency } from '../packages/engine/src/shared/money.js';
import { majorToMinor } from '../packages/engine/src/shared/moneyEntry.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { evaluateComputed } from '../packages/engine/src/shared/computedValue.js';
import { formLinesProblems, liveValues } from '../packages/mistri/src/shared/formLines.js';
import { importFields, readCell } from '../packages/mistri/src/shared/appImport.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { appAdvisories, type AppHost, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { indexerFor } from '../packages/mistri/src/server/app/appSearchRuntime.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import type { Identity, VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

describe('money in minor units', () => {
  test('each currency says its own decimals, exactly', () => {
    assert.deepEqual([currencyDigits('USD'), currencyDigits('jpy'), currencyDigits('KWD'), currencyDigits('XXQ')], [2, 0, 3, 2]);
    assert.equal(minorToMajor(1999, 'USD'), '19.99');
    assert.equal(minorToMajor(1999, 'JPY'), '1999');
    assert.equal(minorToMajor(1999, 'KWD'), '1.999');
    assert.equal(minorToMajor(-5, 'USD'), '-0.05');
    assert.equal(minorToMajor('-0', 'USD'), '0.00');
    /* Past 2^53 the adapter hands back text, and it stays exact. */
    assert.equal(minorToMajor('123456789012345678901', 'USD'), '1234567890123456789.01');
    assert.equal(minorToMajor(12.5, 'USD'), undefined);
    assert.equal(minorFigure(12.5, 'USD'), 0.125);
  });

  test('a typed figure is stored as cents, and more decimals than the currency has is refused, not rounded', () => {
    assert.equal(majorToMinor('19.99', 'USD'), 1999);
    assert.equal(majorToMinor('19.9', 'USD'), 1990);
    assert.equal(majorToMinor('.5', 'USD'), 50);
    assert.equal(majorToMinor('-3', 'USD'), -300);
    assert.equal(majorToMinor('19.999', 'USD'), undefined);
    assert.equal(majorToMinor('19.990', 'USD'), 1999);
    assert.equal(majorToMinor('1999', 'JPY'), 1999);
    assert.equal(majorToMinor('1.5', 'JPY'), undefined);
    assert.equal(majorToMinor('1.999', 'KWD'), 1999);
    assert.equal(majorToMinor('abc', 'USD'), undefined);
    assert.equal(majorToMinor(19.99, 'USD'), 1999);
  });

  test("a row's currency is its own column's code, else the rule's, else the App's", () => {
    const rule = { currency: 'EUR', currencyColumn: 'currency' };
    assert.equal(rowCurrency(rule, { currency: 'jpy' }, 'USD'), 'JPY');
    assert.equal(rowCurrency(rule, { currency: null }, 'USD'), 'EUR');
    assert.equal(rowCurrency({ currencyColumn: 'currency' }, {}, 'USD'), 'USD');
    /* A value read through a reference reads its currency through the same one. */
    assert.equal(rowCurrency(rule, { 'order_id.currency': 'GBP' }, 'USD', 'order_id.total'), 'GBP');
  });

  test('a CSV cell of a minor column is read as the figure and stored as cents', () => {
    const table = {
      id: 'sales_order',
      name: 'sales_order',
      schema: '',
      columns: [{ name: 'shipping', type: 'INTEGER', nullable: true, primaryKey: false }],
    } as TableMeta;
    const [field] = importFields(table, {}, undefined, (column) => (column === 'shipping' ? 'USD' : undefined));
    assert.equal(field.minor, 'USD');
    assert.deepEqual(readCell(field, '12.50', 'en-US'), { value: 1250 });
    assert.deepEqual(readCell(field, '1,234.5', 'en-US'), { value: 123450 });
    /* Where each row says its own currency, the row's figure is read in it: 1,500 yen is 1500. */
    const [byRow] = importFields(
      table,
      {},
      undefined,
      () => 'USD',
      () => 'currency',
    );
    assert.equal(byRow.minorBy, 'currency');
    assert.deepEqual(readCell(byRow, '1,500', 'en-US', 'JPY'), { value: 1500 });
    assert.deepEqual(readCell(byRow, '12.5', 'en-US', 'JPY'), { problem: '"12.5" has more decimals than JPY is written with.' });
    assert.deepEqual(readCell(byRow, '12.5', 'en-US'), { value: 1250 });
    assert.match((readCell(field, '1.234', 'en-US') as { problem: string }).problem, /more decimals than USD/);
  });
});

describe('the one evaluator', () => {
  const columns = new Set(['quantity', 'unit_price', 'note']);
  const evaluate = (text: string, row: Record<string, unknown>) =>
    evaluateComputed(
      parseComputed(text, (path) => columns.has(path)),
      { today: '2026-10-09', now: new Date('2026-10-09T12:00:00Z'), me: null },
      (path) => (row[path] ?? null) as never,
    );
  test('reads as SQL does: nothing in, nothing out; a division by zero is nothing; a condition on nothing is false', () => {
    assert.equal(evaluate('quantity * unit_price', { quantity: 3, unit_price: 250 }), 750);
    assert.equal(evaluate('quantity * unit_price', { quantity: 3, unit_price: null }), null);
    assert.equal(evaluate('unit_price / quantity', { quantity: 0, unit_price: 250 }), null);
    assert.equal(evaluate('quantity > 2', { quantity: null }), false);
    assert.equal(evaluate('quantity > 2 or unit_price > 100', { quantity: null, unit_price: 200 }), true);
  });
});

/* ---------- an order, its lines and its totals ---------- */

const ORDER_APP = {
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  ui: { currency: 'USD' },
  resources: {
    order_line: {
      access: 'write',
      delete: true,
      computed: { line_total: { type: 'number', value: 'quantity * unit_price' } },
      validation: [{ must: 'quantity > 0', message: 'Order at least one.' }],
      display: { unit_price: { format: 'money', minor: true } },
    },
    sales_order: {
      access: 'write',
      rollups: { subtotal: { fn: 'sum', from: 'order_line', column: 'line_total' }, lines: { fn: 'count', from: 'order_line' } },
      computed: { total: { type: 'number', value: 'subtotal + shipping' } },
      display: {
        shipping: { format: 'money', minor: true, currency: { column: 'currency' } },
        total: { format: 'money', minor: true, currency: { column: 'currency' } },
      },
      form: {
        show: ['customer', 'currency', 'shipping'],
        lines: [
          { label: 'Lines', from: 'order_line', whose: 'order_id', show: ['product', 'quantity', 'unit_price'], order: 'position', min: 1 },
        ],
        live: ['subtotal', 'total'],
      },
    },
  },
  views: { orders: { kind: 'list', from: 'sales_order' } },
  home: 'orders',
};

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const catalog = (): DatabaseSchema =>
  ({
    label: 'shop',
    dialect: 'sqlite',
    readAt: '2026-10-09T00:00:00Z',
    tables: [
      {
        id: 'sales_order',
        name: 'sales_order',
        schema: '',
        columns: [
          column('id', 'INTEGER', { primaryKey: true, nullable: false }),
          column('customer', 'TEXT', { nullable: false }),
          column('currency', 'TEXT'),
          column('shipping', 'INTEGER'),
        ],
      },
      {
        id: 'order_line',
        name: 'order_line',
        schema: '',
        columns: [
          column('id', 'INTEGER', { primaryKey: true, nullable: false }),
          column('order_id', 'INTEGER', { nullable: false, references: { table: 'sales_order', column: 'id' } }),
          column('position', 'INTEGER'),
          column('product', 'TEXT', { nullable: false }),
          column('quantity', 'INTEGER', { nullable: false }),
          column('unit_price', 'INTEGER', { nullable: false }),
        ],
      },
    ],
    foreignKeys: [
      {
        name: 'fk_line_order',
        from: { table: 'order_line', columns: ['order_id'] },
        to: { table: 'sales_order', columns: ['id'] },
        onDelete: 'cascade',
      },
    ],
  }) as unknown as DatabaseSchema;

const parsed = (patch: (app: typeof ORDER_APP) => void = () => {}): AppDef => {
  const app = structuredClone(ORDER_APP);
  patch(app);
  return parseAppConfig(app, 'shop');
};

describe('money in several currencies, added up', () => {
  test('a chart that adds up money each row says its own currency for is told to group by it, or keep to one', () => {
    const app = parsed((shop) => {
      (shop.views as Record<string, unknown>).sales = {
        kind: 'dashboard',
        label: 'Sales',
        sections: [
          { kind: 'chart', title: 'Shipping by customer', from: 'sales_order', measure: 'sum shipping', by: 'customer' },
          { kind: 'chart', title: 'By currency', from: 'sales_order', measure: 'sum shipping', by: 'customer, currency' },
          { kind: 'chart', title: 'Dollars', from: 'sales_order', measure: 'sum shipping', by: 'customer', query: 'currency = USD' },
          { kind: 'metric', title: 'Shipping', from: 'sales_order', measure: 'sum shipping' },
        ],
      };
      Object.assign(shop, { nav: ['sales'] });
    });
    const said = appAdvisories(
      { path: 'shop.ts', app, pages: [], sources: {} } as unknown as LoadedApp,
      withRollups(app, catalog()),
    ).filter((warning) => /currency/.test(warning));
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0], /chart "Shipping by customer" adds up sales_order\.shipping.*Group it by "currency" too/);
  });
});

describe('lines and live values, judged', () => {
  test('a well-formed order has nothing to say', () => {
    const app = parsed();
    assert.deepEqual(formLinesProblems(app, withRollups(app, catalog())), []);
    assert.deepEqual(resolveDisplay(app, withRollups(app, catalog())).warnings, []);
  });

  test('the parser refuses what no catalog could make right', () => {
    assert.throws(() => parsed((a) => ((a.resources.sales_order.form.lines[0] as Record<string, unknown>).show = [])), /form\.lines 1/);
    assert.throws(() => parsed((a) => ((a.resources.sales_order.form.lines[0] as Record<string, unknown>).max = 65)), /form\.lines 1/);
    assert.throws(() => parsed((a) => ((a.resources.sales_order.form as Record<string, unknown>).live = 'total')), /form\.live/);
    assert.throws(
      () => parsed((a) => ((a.resources.sales_order.display.shipping as Record<string, unknown>).currency = { name: 'x' })),
      /currency/,
    );
  });

  test('the catalog check names the line and the fix', () => {
    const judged = (patch: (app: typeof ORDER_APP) => void) => {
      const app = parsed(patch);
      return formLinesProblems(app, withRollups(app, catalog()));
    };
    const [notWritten] = judged((a) => {
      delete (a.resources.order_line as Record<string, unknown>).access;
      delete (a.resources.order_line as Record<string, unknown>).delete;
    });
    assert.match(notWritten, /form\.lines "Lines": the App does not write "order_line"/);
    assert.equal(validationCode(notWritten), 'form-lines');
    const [wrongWhose] = judged((a) => (a.resources.sales_order.form.lines[0].whose = 'position'));
    assert.match(wrongWhose, /"position" is not a reference from order_line to sales_order/);
    const shown = judged((a) => a.resources.sales_order.form.lines[0].show.push('order_id'));
    assert.match(shown.join('\n'), /shows "order_id", which the server fills/);
    /* A rollup reads its lines' unit price; a form that does not ask it cannot say the subtotal. */
    const [unasked] = judged((a) => (a.resources.sales_order.form.lines[0].show = ['product', 'quantity']));
    assert.match(unasked, /form\.live "subtotal" reads "unit_price", which the lines "Lines" do not ask/);
    assert.equal(validationCode(unasked), 'form-live');
    const [notLive] = judged((a) => a.resources.sales_order.form.live.push('customer'));
    assert.match(notLive, /form\.live "customer" is not a computed column or a rollup of sales_order/);
  });

  test('minor units over a decimal column, and a currency column that is not one, are said', () => {
    const schema = catalog();
    schema.tables[0].columns.find((c) => c.name === 'shipping')!.type = 'NUMERIC(10,2)';
    const warnings = resolveDisplay(parsed(), withRollups(parsed(), schema)).warnings.join('\n');
    assert.match(warnings, /minor units are a whole number of cents/);
    const misread = parsed((a) => (a.resources.sales_order.display.shipping.currency = { column: 'shipping' }));
    const [currency] = resolveDisplay(misread, withRollups(misread, catalog())).warnings;
    assert.match(currency, /the currency column "shipping" is not another text column/);
    assert.equal(validationCode(currency), 'money-minor');
  });
});

type Dialect = 'sqlite' | 'postgres';
type Row = Record<string, unknown>;
const LIVE = process.env.TABLEWALK_TEST_PG;
/* SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server — each test a database of its own, by UUID. */
const ENGINES: ReadonlyArray<{ dialect: Dialect; skip: false | string }> = [
  { dialect: 'sqlite', skip: false },
  { dialect: 'postgres', skip: liveSkip('postgres', LIVE) },
];
const serial = (dialect: Dialect) => (dialect === 'sqlite' ? 'INTEGER PRIMARY KEY' : 'SERIAL PRIMARY KEY');

/** A database of the test's own on the engine, and a control connection beside whatever serves it. */
interface Lab {
  /** A SQLite file's path or a PostgreSQL URL. */
  url: string;
  rows(sql: string): Promise<Row[]>;
}
async function lab(t: TestContext, dialect: Dialect, sql: string): Promise<Lab> {
  if (dialect === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-lines-'));
    const file = join(directory, 'shop.db');
    const db = new DatabaseSync(file);
    t.after(() => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${sql}`);
    return {
      url: file,
      rows: async (query) =>
        db
          .prepare(query)
          .all()
          .map((row) => ({ ...row })),
    };
  }
  const { url, drop } = await uuidPostgresDatabase('tw_order_lines');
  const control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(sql);
  return { url, rows: async (query) => (await control.query(query)).rows.map((row: Row) => ({ ...row })) };
}
const count = async (shop: Lab, sql: string) => Number((await shop.rows(sql))[0].n);

async function listen(t: TestContext, server: Server) {
  const bound = server.listen(0, '127.0.0.1');
  await once(bound, 'listening');
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function call(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}
const firstFields = (reply: { body: Record<string, unknown> }) => (reply.body.errors as Array<{ fields: unknown }>)[0].fields;

for (const { dialect, skip } of ENGINES)
  describe(`an order saved with its lines, over HTTP, on ${dialect}`, { skip }, () => {
    test('one transaction: the record, its lines, the stored total the one the form said', async (t) => {
      const shop = await lab(
        t,
        dialect,
        `CREATE TABLE sales_order (id ${serial(dialect)}, customer TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
          shipping INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE order_line (id ${serial(dialect)}, order_id INTEGER NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
          position INTEGER, product TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL);`,
      );
      const registry = new Registry();
      registry.add({ id: 'shop', name: 'Shop', url: shop.url, source: 'config', writable: true });
      t.after(() => registry.closeAll());
      const definition = parsed();
      const host: AppHost = { app: { path: 'shop.ts', app: definition, pages: [], sources: {} }, pages: [] };
      const origin = await listen(t, createApp({ registry, bound: { host: '127.0.0.1', port: 0 }, apps: [host], pages: [] }));
      const post = (path: string, body: object) => call(`${origin}${path}`, { app: 'shop', ...body });
      const lines = () => shop.rows('SELECT id, order_id, position, product, quantity, unit_price FROM order_line ORDER BY position');

      /* Each line's search document follows it, as the record's does. */
      const touched = t.mock.method(indexerFor(registry), 'touched');
      const draft = { customer: 'Ada', currency: 'USD', shipping: '500' };
      const rows = [
        { product: 'Kettle', quantity: '2', unit_price: '1999' },
        { product: 'Mug', quantity: '3', unit_price: '850' },
      ];
      const added = await post('/api/insert', {
        table: 'sales_order',
        values: draft,
        lines: { order_line: rows.map((values) => ({ values })) },
      });
      assert.equal(added.status, 200, added.text);
      const id = Number((added.body.key as { id: number }).id);
      assert.deepEqual(
        (await lines()).map((row) => [Number(row.order_id), row.position, row.product]),
        [
          [id, 1, 'Kettle'],
          [id, 2, 'Mug'],
        ],
      );

      assert.deepEqual(touched.mock.calls.map((call) => call.arguments[1].resource).sort(), ['order_line', 'order_line', 'sales_order']);

      /* The figure the form says is the figure the server stores. */
      const served = (await (await fetch(`${origin}/api/schema?app=shop`)).json()) as DatabaseSchema;
      const order = served.tables.find((table) => table.id === 'sales_order')!;
      const said = liveValues(served, order, ['subtotal', 'total'], draft, { order_line: rows });
      assert.deepEqual(said, { subtotal: 2 * 1999 + 3 * 850, total: 2 * 1999 + 3 * 850 + 500 });
      /* The total reads the subtotal, a rollup: the reader is held to both, and served both. */
      const read = await post('/api/view/run', {
        view: {
          id: 'v',
          name: 'v',
          base: 'sales_order',
          columns: [{ path: 'id' }, { path: 'subtotal' }, { path: 'total' }],
          filter: { groups: [[{ path: 'id', op: '=', value: id }]] },
        },
      });
      assert.equal(read.status, 200, read.text);
      const [stored] = read.body.rows as Row[];
      assert.deepEqual([Number(stored.subtotal), Number(stored.total)], [said.subtotal, said.total]);

      /* A line its validation refuses refuses the order: nothing is saved, and the line's field is named. */
      const before = await count(shop, 'SELECT count(*) AS n FROM sales_order');
      const refused = await post('/api/insert', {
        table: 'sales_order',
        values: { customer: 'Bo' },
        lines: {
          order_line: [
            { values: { product: 'Tray', quantity: '1', unit_price: '100' } },
            { values: { product: 'Lid', quantity: '0', unit_price: '50' } },
          ],
        },
      });
      assert.equal(refused.status, 200, refused.text);
      assert.equal(refused.body.outcome, 'rejected');
      /* The author's own sentence crosses with the line's field; the rule's condition and the values do not. */
      assert.deepEqual(firstFields(refused), [{ field: 'order_line[1].quantity', message: 'Order at least one.' }]);
      assert.equal(await count(shop, 'SELECT count(*) AS n FROM sales_order'), before);

      /* A save the App does not declare, or a line that sets what the save fills, is refused before anything is written. */
      const undeclared = await post('/api/insert', { table: 'order_line', values: {}, lines: { sales_order: [] } });
      assert.equal(undeclared.status, 400);
      const fills = await post('/api/insert', {
        table: 'sales_order',
        values: draft,
        lines: { order_line: [{ values: { ...rows[0], order_id: '9' } }] },
      });
      assert.match(String(fills.body.error), /sets "order_id", which the save fills/);
      const short = await post('/api/insert', { table: 'sales_order', values: draft, lines: { order_line: [] } });
      assert.match(String(short.body.error), /at least 1 lines/);
    });

    test('under a row policy: each line written as the principal could write it alone, and only in its own rows', async (t) => {
      const shop = await lab(
        t,
        dialect,
        `CREATE TABLE sales_order (id ${serial(dialect)}, desk INTEGER NOT NULL DEFAULT 1, customer TEXT NOT NULL);
        CREATE TABLE order_line (id ${serial(dialect)}, desk INTEGER NOT NULL DEFAULT 1,
          order_id INTEGER NOT NULL REFERENCES sales_order(id), position INTEGER, product TEXT NOT NULL, quantity INTEGER NOT NULL);
        INSERT INTO sales_order (desk, customer) VALUES (2, 'Desk two');
        INSERT INTO order_line (desk, order_id, position, product, quantity) VALUES (2, 1, 1, 'Theirs', 1);`,
      );
      const directory = mkdtempSync(join(tmpdir(), 'tablewalk-lines-policy-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const registry = new Registry();
      registry.add({ id: 'desk-shop', name: 'Desk shop', url: shop.url, source: 'config', writable: true });
      t.after(() => registry.closeAll());
      const app = parseAppConfig(
        {
          id: 'desk-shop',
          name: 'Desk shop',
          sources: { shop: { connection: 'desk-shop', default: true } },
          resources: {
            sales_order: {
              access: 'write',
              form: {
                show: ['customer'],
                lines: [{ label: 'Lines', from: 'order_line', whose: 'order_id', show: ['product', 'quantity'], order: 'position' }],
              },
            },
            order_line: { access: 'write', delete: true, validation: [{ must: 'quantity > 0', message: 'Order at least one.' }] },
          },
          auth: {
            rows: 'policy',
            roles: { clerk: { read: true, write: ['sales_order', 'order_line'] }, orders: { read: true, write: ['sales_order'] } },
          },
          views: { orders: { kind: 'list', from: 'sales_order' } },
          home: 'orders',
        },
        'desk shop',
      );
      const identity: { current: Identity } = { current: { id: 'desk-one', who: 'one@example.test', role: 'clerk' } };
      const host: AppHost = {
        app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
        pages: [],
        auth: {
          spec: app.auth!,
          store: join(directory, 'auth.db'),
          close() {},
          handler: async () => {},
          session: async () => identity.current,
        },
      };
      const file = join(directory, 'policy.mjs');
      writeFileSync(
        file,
        `export default { appId: 'desk-shop',
          resolveRows(principal) {
            const eq = { groups: [[{ column: 'desk', op: '=', value: principal.id === 'desk-two' ? 2 : 1 }]] };
            return { sales_order: eq, order_line: eq };
          },
          authorizeDeletedRecord: () => true,
        };`,
      );
      const policy = await loadHttpAppPolicy({ app, registry, file, verifySession: async () => identity.current });
      t.after(() => policy.retire());
      const origin = await listen(t, createApp({ registry, bound: { host: '127.0.0.1', port: 0 }, apps: [host], policy }));
      const post = (path: string, body: object) =>
        call(`${origin}${path}?app=desk-shop`, body, { 'x-mistri-account': identity.current.id });
      const lines = (order: number) =>
        shop.rows(`SELECT id, desk, position, product, quantity FROM order_line WHERE order_id = ${order} ORDER BY position`);

      const added = await post('/api/insert', {
        table: 'sales_order',
        values: { customer: 'Ada' },
        lines: { order_line: [{ values: { product: 'Kettle', quantity: '2' } }, { values: { product: 'Mug', quantity: '3' } }] },
      });
      assert.equal(added.status, 200, added.text);
      const id = Number((added.body.key as { id: number }).id);
      assert.deepEqual(
        (await lines(id)).map((row) => [row.desk, row.position, row.product]),
        [
          [1, 1, 'Kettle'],
          [1, 2, 'Mug'],
        ],
      );
      /* The rule's own sentence on the line's field, and nothing saved. */
      const orders = await count(shop, 'SELECT count(*) AS n FROM sales_order');
      const refused = await post('/api/insert', {
        table: 'sales_order',
        values: { customer: 'Bo' },
        lines: { order_line: [{ values: { product: 'Lid', quantity: '0' } }] },
      });
      assert.deepEqual(firstFields(refused), [{ field: 'order_line[0].quantity', message: 'Order at least one.' }], refused.text);
      assert.equal(await count(shop, 'SELECT count(*) AS n FROM sales_order'), orders);
      /* A line placed outside the principal's rows is refused as its own insert would be; nothing lands. */
      const outside = await post('/api/insert', {
        table: 'sales_order',
        values: { customer: 'Cy' },
        lines: { order_line: [{ values: { product: 'Elsewhere', quantity: '1', desk: '2' } }] },
      });
      assert.notEqual(outside.body.outcome ?? 'applied', 'applied', outside.text);
      assert.equal(await count(shop, 'SELECT count(*) AS n FROM sales_order'), orders);

      /* A role without the lines' grant is refused. */
      identity.current = { id: 'desk-one', who: 'one@example.test', role: 'orders' };
      const ungranted = await post('/api/insert', {
        table: 'sales_order',
        values: { customer: 'Di' },
        lines: { order_line: [{ values: { product: 'Kettle', quantity: '1' } }] },
      });
      assert.equal(ungranted.status, 403, ungranted.text);
      assert.equal(await count(shop, 'SELECT count(*) AS n FROM sales_order'), orders);
    });

    test("in a tenant App: each line stamped with the lease's tenant, and another tenant's order takes none", async (t) => {
      const binding = { appId: 'tenant-shop', source: { id: 'business', connection: 'tenant-shop-db' }, storeId: 'tenant-shop-store' };
      const shop = await lab(
        t,
        dialect,
        `CREATE TABLE sales_order (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, customer TEXT NOT NULL);
        CREATE TABLE order_line (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
          order_id TEXT NOT NULL REFERENCES sales_order(id), position INTEGER, product TEXT NOT NULL, quantity INTEGER NOT NULL);
        INSERT INTO sales_order VALUES ('s-1', 'south', 'South order');
        INSERT INTO order_line VALUES ('s-1-a', 'south', 's-1', 1, 'Theirs', 1);`,
      );
      if (dialect === 'sqlite') {
        provisionSqliteTenantStore(shop.url, binding);
        migrateSqliteCommandJournal(shop.url);
      } else {
        await migratePostgresTenantStore(shop.url, binding);
        await migratePostgresCommandJournal(shop.url);
      }
      const admin = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
        const operations = new TransactionOperations();
        if (dialect === 'sqlite') {
          const db = new DatabaseSync(shop.url);
          try {
            db.exec('BEGIN IMMEDIATE');
            await run(createSqliteTenantAdministration(db, operations, binding));
            await operations.finish();
            db.exec('COMMIT');
          } finally {
            db.close();
          }
          return;
        }
        const control = await pgClient(shop.url);
        try {
          await control.query('BEGIN');
          await run(createPostgresTenantAdministration(control, operations, binding));
          await operations.finish();
          await control.query('COMMIT');
        } finally {
          await control.end();
        }
      };
      await admin(async (store) => {
        for (const tenantId of ['north', 'south']) {
          await store.putTenant({ tenantId, status: 'active', expectedVersion: null });
          await store.putMembership({
            tenantId,
            accountId: 'ada',
            membershipId: `${tenantId}-ada`,
            status: 'active',
            roles: ['clerk'],
            validUntil: Date.now() + 3_600_000,
            expectedVersion: null,
          });
        }
      });
      const app = parseTestApp(
        {
          id: binding.appId,
          name: 'Tenant shop',
          sources: { business: { connection: binding.source.connection } },
          resources: {
            sales_order: {
              access: 'write',
              owner: 'tenant',
              form: {
                show: ['id', 'customer'],
                lines: [{ label: 'Lines', from: 'order_line', whose: 'order_id', show: ['id', 'product', 'quantity'], order: 'position' }],
              },
            },
            order_line: {
              access: 'write',
              owner: 'tenant',
              delete: true,
              validation: [{ must: 'quantity > 0', message: 'Order at least one.' }],
            },
          },
          auth: { rows: 'tenant', roles: { clerk: { read: true, write: ['sales_order', 'order_line'] } } },
          views: { orders: { kind: 'list', from: 'sales_order' } },
          home: 'orders',
        },
        'tenant-shop.ts',
      );
      const scope: RowScope = { sales_order: true, order_line: true };
      const policy = defineAppTenantPolicy({
        kind: 'tenant',
        appId: binding.appId,
        storeId: binding.storeId,
        ownership: { sales_order: { kind: 'tenant', column: 'tenant_id' }, order_line: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => scope,
        resolveRows: () => scope,
        authorizeDeletedRecord: () => true,
      });
      const enrollment = await createTenantEnrollment<IncomingMessage>({
        app,
        pages: [],
        policy,
        source: dialect === 'sqlite' ? { ...binding.source, existingPath: shop.url } : { ...binding.source, url: shop.url },
        deployment: 'tenant-shop-deployment',
        roles: ['clerk'],
        maxLifetimeMs: 300_000,
        verifySession: async () => ({ id: 'ada', who: 'ada@example.test' }),
      });
      t.after(() => enrollment.retire());
      const session: VerifiedSessionInstance = {
        identity: { id: 'ada', who: 'ada@example.test' },
        sessionId: 'tenant-shop-ada',
        expiresAt: Date.now() + 3_600_000,
      };
      const bound = { host: '127.0.0.1', port: 0 };
      const owner = createTenantHttpServer({ app, enrollment, bound, verifySessionInstance: () => session });
      t.after(() => owner.retire());
      const origin = await listen(t, owner.server);
      const lease = async (tenant: string) => {
        const opened = await call(`${origin}/api/tenant/context/open?app=${binding.appId}&tenant=${tenant}`, {});
        assert.equal(opened.status, 200, opened.text);
        const context = opened.body as { tabId: string; context: string; revision: number; accountId: string };
        return (path: string, body: object) =>
          call(`${origin}${path}?app=${binding.appId}&tenant=${tenant}`, body, {
            'x-mistri-tab': context.tabId,
            'x-mistri-context': context.context,
            'x-mistri-lease-revision': String(context.revision),
            'x-mistri-account': context.accountId,
          });
      };
      const north = await lease('north');
      const lines = (order: string) =>
        shop.rows(`SELECT id, tenant_id, position, product, quantity FROM order_line WHERE order_id = '${order}' ORDER BY position`);

      const added = await north('/api/insert', {
        table: 'sales_order',
        values: { id: 'n-1', customer: 'Ada' },
        lines: {
          order_line: [
            { values: { id: 'n-1-a', product: 'Kettle', quantity: '2' } },
            { values: { id: 'n-1-b', product: 'Mug', quantity: '3' } },
          ],
        },
      });
      assert.equal(added.status, 200, added.text);
      assert.deepEqual(
        (await lines('n-1')).map((row) => [row.tenant_id, row.position, row.product]),
        [
          ['north', 1, 'Kettle'],
          ['north', 2, 'Mug'],
        ],
      );
      /* The rule's own sentence on the line's field, and neither the order nor its other line saved. */
      const refused = await north('/api/insert', {
        table: 'sales_order',
        values: { id: 'n-2', customer: 'Bo' },
        lines: {
          order_line: [
            { values: { id: 'n-2-a', product: 'Tray', quantity: '1' } },
            { values: { id: 'n-2-b', product: 'Lid', quantity: '0' } },
          ],
        },
      });
      assert.deepEqual(firstFields(refused), [{ field: 'order_line[1].quantity', message: 'Order at least one.' }], refused.text);
      assert.equal(await count(shop, `SELECT count(*) AS n FROM sales_order WHERE id = 'n-2'`), 0);

      /* An update takes no lines: nothing of south's moves. */
      const theirs = await north('/api/update', {
        table: 'sales_order',
        key: { id: 's-1' },
        values: {},
        lines: { order_line: [{ values: { id: 's-1-z', product: 'Mine now', quantity: '1' } }] },
      });
      assert.notEqual(theirs.status, 200, theirs.text);
      assert.deepEqual(
        (await lines('s-1')).map((row) => row.product),
        ['Theirs'],
      );
    });
  });
