/**
 * The conventions an App is drawn by without saying them (displayDefaults.ts):
 * inferred per column, overridden concern by concern, warned when restated,
 * and the same set `check --design --fix` deletes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, resolveDisplay, resolveViews } from '../packages/mistri/src/shared/app.js';
import { appRestatedWarnings } from '../packages/mistri/src/shared/appWarnings.js';
import { columnCaption } from '../packages/engine/src/shared/columnCaption.js';
import { inferredDisplay, inferredReport, restatedDefaults } from '../packages/engine/src/shared/displayDefaults.js';
import { inferredFormDefaults } from '../packages/mistri/src/shared/formRules.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const col = (name: string, type: string, more: Partial<ColumnMeta> = {}): ColumnMeta =>
  ({ name, type, primaryKey: false, nullable: true, ...more }) as ColumnMeta;
const customer: TableMeta = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT', { nullable: false }),
    col('email', 'TEXT'),
    col('phone', 'TEXT'),
    col('website', 'TEXT'),
  ],
} as TableMeta;
const workOrder: TableMeta = {
  id: 'work_order',
  name: 'work_order',
  schema: '',
  isView: false,
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('customer_id', 'INTEGER', { references: { table: 'customer', column: 'id' } }),
    col('summary', 'TEXT', { nullable: false }),
    col('status', 'TEXT', { nullable: false, default: "'booked'", allowed: ['booked', 'in_progress', 'on_hold', 'done'] }),
    col('priority', 'TEXT', { allowed: ['LOW', 'HIGH_VALUE'] }),
    col('labor_charge', 'INTEGER'),
    col('parts_cost', 'NUMERIC'),
    col('progress', 'REAL'),
    col('model_year', 'INTEGER'),
    col('due_on', 'DATE'),
    col('duration_minutes', 'INTEGER'),
    col('is_rush', 'INTEGER'),
    col('ready_at', 'TEXT'),
    col('flagged_on', 'INTEGER'),
  ],
  computed: { total: { type: 'number', expr: {} as never, reads: ['labor_charge', 'parts_cost'] } },
} as unknown as TableMeta;
const schema = {
  tables: [customer, workOrder],
  foreignKeys: [{ from: { table: 'work_order', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } }],
} as unknown as DatabaseSchema;

test('each column is dressed by what its name, type and vocabulary say', () => {
  const rules = Object.fromEntries(Object.entries(inferredDisplay(workOrder)).map(([column, { rule }]) => [column, rule]));
  assert.deepEqual(rules, {
    status: { tone: { booked: 'neutral', in_progress: 'info', on_hold: 'warn', done: 'good' } },
    priority: { values: { LOW: 'Low', HIGH_VALUE: 'High value' } },
    labor_charge: { format: 'money' },
    parts_cost: { format: 'money' },
    progress: { format: 'percent', bar: true },
    model_year: { format: 'year' },
    due_on: { format: 'relative' },
    duration_minutes: { unit: 'min' },
    is_rush: { values: { 0: 'No', 1: 'Yes' } },
    // A figure made of money is money.
    total: { format: 'money' },
  });
  const person = Object.fromEntries(Object.entries(inferredDisplay(customer)).map(([column, { rule }]) => [column, rule]));
  assert.deepEqual(person, {
    name: { avatar: true, subtitle: 'email' },
    email: { format: 'email' },
    phone: { format: 'phone' },
    website: { format: 'url' },
  });
});

test('what the App says wins concern by concern, and an empty rule keeps the column as stored', () => {
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: {
        work_order: {
          display: {
            labor_charge: { currency: 'EUR', format: 'money' },
            status: { tone: { booked: 'info' } },
            progress: {},
            due_on: { icons: { '*': 'calendar' } },
          },
        },
        customer: {},
      },
      views: { orders: { kind: 'list', from: 'work_order' } },
      home: 'orders',
    },
    'shop',
  );
  const { display } = resolveDisplay(app, schema);
  assert.deepEqual(display['work_order.labor_charge'], { currency: 'EUR', format: 'money' });
  assert.deepEqual(display['work_order.status'], { tone: { booked: 'info' }, humanize: true });
  assert.deepEqual(display['work_order.progress'], {});
  // A key no concern owns leaves the inferred figure standing beside it.
  assert.deepEqual(display['work_order.due_on'], { format: 'relative', icons: { '*': 'calendar' } });
  assert.deepEqual(display['work_order.parts_cost'], { format: 'money' });
  // The browser reads a link and a year off the name itself; the server does not send them twice.
  assert.equal(display['customer.email'], undefined);
  assert.equal(display['work_order.model_year'], undefined);
  assert.deepEqual(display['customer.name'], { avatar: true, subtitle: 'email' });
});

test('a rule that says what the conventions say is restated, and is the deletion --fix makes', () => {
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: {
        work_order: {
          access: 'write',
          display: {
            labor_charge: { format: 'money' },
            parts_cost: { format: 'money', currency: 'EUR' },
            status: { tone: { booked: 'neutral', in_progress: 'info', on_hold: 'warn', done: 'good' }, icons: { done: 'check-circle' } },
          },
          form: { defaults: { status: 'booked', summary: 'New job' } },
        },
      },
      views: { orders: { kind: 'list', from: 'work_order' } },
      home: 'orders',
    },
    'shop',
  );
  assert.deepEqual(
    restatedDefaults(app, schema).map(({ resource, at, keys, whole }) => ({ resource, at, keys, whole })),
    [
      { resource: 'work_order', at: ['display', 'labor_charge'], keys: ['format'], whole: true },
      { resource: 'work_order', at: ['display', 'status'], keys: ['tone'], whole: false },
      { resource: 'work_order', at: ['defaults'], keys: ['status'], whole: false },
    ],
  );
  const warnings = appRestatedWarnings(app, schema).filter((warning) => warning.includes('which the platform infers'));
  assert.equal(warnings.length, 3, warnings.join('\n'));
  assert.match(
    warnings[0],
    /display "labor_charge" says format: "money", which the platform infers \(a number named like money\)\. Delete the rule\./,
  );
  // `check --defaults` prints each, and says where the App's own rule wins.
  const report = inferredReport(app, schema);
  assert.equal(report.find((row) => row.column === 'parts_cost')?.overridden, true);
  assert.equal(report.find((row) => row.column === 'progress')?.overridden, false);
});

test("a vocabulary's schema DEFAULT is the form's start; a clock is the database's", () => {
  assert.deepEqual(inferredFormDefaults(workOrder), { status: 'booked' });
  assert.deepEqual(
    inferredFormDefaults({
      columns: [col('stage', 'TEXT', { allowed: ['a', 'b'], default: "'b'::text" }), col('at', 'TEXT', { default: 'CURRENT_TIMESTAMP' })],
    }),
    { stage: 'b' },
  );
});

test('a moment is captioned by what happened: ready_at is Ready, a number keeps its suffix', () => {
  assert.equal(columnCaption({}, schema, 'work_order', 'ready_at'), 'Ready');
  assert.equal(columnCaption({}, schema, 'work_order', 'due_on'), 'Due');
  assert.equal(columnCaption({}, schema, 'work_order', 'flagged_on'), 'Flagged on');
});

test("a board, a queue and a calendar with no primary say the record's name", () => {
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: { work_order: { recordLabel: '{summary} · {status}' }, customer: {} },
      views: {
        board: { kind: 'list', from: 'work_order', board: { by: 'status' } },
        queue: { kind: 'list', from: 'work_order', presentation: { kind: 'queue' } },
        calendar: { kind: 'list', from: 'work_order', presentation: { kind: 'calendar', date: 'due_on' } },
        people: { kind: 'list', from: 'customer', presentation: { kind: 'queue', lines: ['email'] } },
      },
      home: 'board',
    },
    'shop',
  );
  const views = resolveViews(app, schema) as Record<string, { error?: string; presentation?: { primary?: string } }>;
  for (const key of ['board', 'queue', 'calendar', 'people']) assert.equal(views[key].error, undefined, key);
  assert.deepEqual(
    ['board', 'queue', 'calendar', 'people'].map((key) => views[key].presentation?.primary),
    ['summary', 'summary', 'summary', 'name'],
  );
});

test('a figure made of money is counted as its money is: cents in, cents out, in the currency every input shares', () => {
  const line = {
    id: 'order_line',
    name: 'order_line',
    schema: '',
    isView: false,
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('order_id', 'INTEGER', { references: { table: 'sale', column: 'id' } }),
      col('unit_price', 'INTEGER'),
      col('quantity', 'INTEGER'),
    ],
    computed: { line_total: { type: 'number', expr: {} as never, reads: ['unit_price', 'quantity'] } },
  } as unknown as TableMeta;
  const lineExpression = line.computed!.line_total!;
  const sale = {
    id: 'sale',
    name: 'sale',
    schema: '',
    isView: false,
    columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('shipping_fee', 'INTEGER')],
    rollups: {
      subtotal: { fn: 'sum', via: 'order_line.order_id', column: 'line_total', type: 'INTEGER', expression: lineExpression },
      priciest: { fn: 'max', via: 'order_line.order_id', column: 'unit_price', type: 'INTEGER' },
    },
    computed: { total: { type: 'number', expr: {} as never, reads: ['subtotal', 'shipping_fee'] } },
  } as unknown as TableMeta;
  const shop = { tables: [sale, line], foreignKeys: [] } as unknown as DatabaseSchema;
  const app = (lineRule: Record<string, unknown>, feeRule: Record<string, unknown> = { format: 'money', minor: true, currency: 'EUR' }) =>
    parseAppConfig(
      {
        id: 'shop',
        name: 'Shop',
        connection: 'shop',
        resources: { sale: { display: { shipping_fee: feeRule } }, order_line: { display: { unit_price: lineRule } } },
        views: { sales: { kind: 'list', from: 'sale' } },
        home: 'sales',
      },
      'shop',
    );
  const served = (lineRule: Record<string, unknown>, feeRule?: Record<string, unknown>) =>
    resolveDisplay(app(lineRule, feeRule), shop).display;
  const cents = served({ format: 'money', minor: true, currency: 'EUR' });
  // A price in cents times a quantity is cents; their sum, their most, and the order's total over it are cents too.
  assert.deepEqual(cents['order_line.line_total'], { format: 'money', minor: true, currency: 'EUR' });
  assert.deepEqual(cents['sale.subtotal'], { format: 'money', minor: true, currency: 'EUR' });
  assert.deepEqual(cents['sale.priciest'], { format: 'money', minor: true, currency: 'EUR' });
  assert.deepEqual(cents['sale.total'], { format: 'money', minor: true, currency: 'EUR' });
  // Inputs that disagree carry neither: a whole-dollar fee beside a subtotal in cents says nothing it cannot keep.
  const mixed = served({ format: 'money', minor: true, currency: 'EUR' }, { format: 'money' });
  assert.deepEqual(mixed['sale.subtotal'], { format: 'money', minor: true, currency: 'EUR' });
  assert.deepEqual(mixed['sale.total'], { format: 'money' });
  // A price kept as the figure itself stays so all the way up.
  assert.deepEqual(served({ format: 'money' }, { format: 'money' })['sale.subtotal'], { format: 'money' });
  // What the App writes on the figure still wins over what it is made of.
  const said = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: {
        sale: { display: { subtotal: { format: 'money' } } },
        order_line: { display: { unit_price: { format: 'money', minor: true } } },
      },
      views: { sales: { kind: 'list', from: 'sale' } },
      home: 'sales',
    },
    'shop',
  );
  assert.deepEqual(resolveDisplay(said, shop).display['sale.subtotal'], { format: 'money' });
});
