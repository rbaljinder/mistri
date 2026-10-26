/**
 * Scaffold and seed, over one small bike shop: the draft reads the shop's
 * life off its schema (a work order's states, the stamps they set, the
 * mechanics who sign in, what a bike is called, what a line costs), passes
 * `mistri check` and its design check as written, and `tablewalk seed`
 * then fills the database with rows the schema and the machine agree with —
 * the same rows for the same seed, parents before children, never over rows
 * already there, never through a read-only connection.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { scaffoldApp } from '../packages/mistri/src/server/scaffold.js';
import { seedDatabase, SeedRefusal } from '../packages/engine/src/server/seed/seed.js';
import { parseAppConfig, parseAppPages, withRollups } from '../packages/mistri/src/shared/app.js';
import { designLint, sayDesignFinding } from '../packages/mistri/src/server/app/designLint.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const ROOT = resolve('.');

const SHOP = `
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE mechanics (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)));
CREATE TABLE bikes (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), make TEXT NOT NULL, model TEXT NOT NULL, serial_number TEXT, color TEXT);
CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL UNIQUE, price NUMERIC NOT NULL, stock INTEGER NOT NULL DEFAULT 0);
CREATE TABLE work_orders (id INTEGER PRIMARY KEY, bike_id INTEGER NOT NULL REFERENCES bikes(id), customer_id INTEGER NOT NULL REFERENCES customers(id), mechanic_id INTEGER REFERENCES mechanics(id),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','ready','collected','cancelled')),
  is_rush INTEGER NOT NULL DEFAULT 0 CHECK (is_rush IN (0,1)), problem TEXT, labor_charge NUMERIC, due_on TEXT, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ready_at TEXT, completed_on TEXT);
CREATE TABLE work_order_part (id INTEGER PRIMARY KEY, work_order_id INTEGER NOT NULL REFERENCES work_orders(id), part_id INTEGER NOT NULL REFERENCES parts(id), quantity INTEGER NOT NULL DEFAULT 1, unit_price NUMERIC NOT NULL);
CREATE INDEX bikes_customer ON bikes(customer_id);
CREATE INDEX wo_bike ON work_orders(bike_id);
CREATE INDEX wo_customer ON work_orders(customer_id);
CREATE INDEX wo_mechanic ON work_orders(mechanic_id);
CREATE INDEX wop_wo ON work_order_part(work_order_id);
CREATE INDEX wop_part ON work_order_part(part_id);
`;

const dir = mkdtempSync(join(tmpdir(), 'tw-seed-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let made = 0;
/** A fresh, empty shop: its file and an adapter over it. */
function shop(): { file: string; adapter: Adapter } {
  const file = join(dir, `shop-${++made}.db`);
  const db = new DatabaseSync(file);
  db.exec(SHOP);
  db.close();
  return { file, adapter: connect(file, { schemas: [] }) };
}
const TODAY = new Date('2026-10-10T15:00:00Z');
const rowsOf = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

describe('the bike shop draft', async () => {
  const { adapter } = shop();
  const schema: DatabaseSchema = await adapter.introspect();
  await adapter.close();
  const { app, problems, files, recipe } = scaffoldApp(schema, { writable: true, connection: 'shop' });
  type Machine = { column: string; states: Record<string, { on?: Record<string, unknown>; final?: true }> };
  const resources = app.resources as Record<string, Record<string, unknown>>;

  test('the status vocabulary is a machine: a path forward, the final state last, and a cancel that asks first', () => {
    const machine = resources.work_orders.machine as Machine;
    assert.equal(machine.column, 'status');
    assert.deepEqual(Object.keys(machine.states), ['received', 'in_progress', 'ready', 'collected', 'cancelled']);
    assert.equal(machine.states.received.on!.start, 'in_progress');
    assert.equal(machine.states.in_progress.on!.markReady, 'ready');
    assert.deepEqual(machine.states.collected, { final: true });
    assert.deepEqual(machine.states.cancelled, { final: true });
    for (const open of ['received', 'in_progress', 'ready'])
      assert.deepEqual(machine.states[open].on!.cancel, { to: 'cancelled', confirm: true }, open);
  });

  test("stamps: the state's own (ready_at) is the platform's; the one its meaning names (completed_on) is the verb's", () => {
    const machine = resources.work_orders.machine as Machine;
    assert.deepEqual(machine.states.ready.on!.collect, { to: 'collected', set: { completed_on: { auto: 'now' } } });
    assert.ok(!JSON.stringify(machine).includes('ready_at'), 'written again it would restate the convention');
    const form = resources.work_orders.form as { groups: Array<{ fields: string[] }> };
    const asked = form.groups.flatMap((group) => group.fields);
    for (const stamp of ['ready_at', 'completed_on', 'status']) assert.ok(!asked.includes(stamp), `${stamp} is never typed`);
  });

  test('mechanics sign in by email, and their open work is their own queue', () => {
    const auth = app.auth as { me: unknown; defaultRole: string; roles: Record<string, { write: unknown }> };
    assert.deepEqual(auth.me, { from: 'mechanics', column: 'email' });
    assert.equal(auth.defaultRole, 'mechanic');
    assert.ok(!(auth.roles.mechanic.write as string[]).includes('mechanics'), 'a mechanic does not edit the staff list');
    assert.equal(auth.roles.admin.write, true);
    const mine = (app.views as Record<string, { label: string; query: string }>)['my-work-orders'];
    assert.equal(mine.label, 'My work orders');
    // The queue is a segment: the states are the machine's words, so the tabs are named for the work orders.
    assert.equal(mine.query, 'mine');
    assert.deepEqual(resources.work_orders.segments, {
      received_work_orders: { query: 'status = received', label: 'Received' },
      in_progress_work_orders: { query: 'status = in_progress', label: 'In progress' },
      ready_work_orders: { query: 'status = ready', label: 'Ready' },
      collected_work_orders: { query: 'status = collected', label: 'Collected' },
      cancelled_work_orders: { query: 'status = cancelled', label: 'Cancelled' },
      mine: 'mechanic_id = me and status is open',
      open: 'status is open',
    });
    assert.equal((app.nav as string[])[1], 'my-work-orders');
  });

  test('a record with no name of its own is named through its parents', () => {
    assert.equal(resources.bikes.recordLabel, '{customer_id.name} · {make} {model}');
    assert.equal(resources.work_orders.recordLabel, '{customer_id.name} · {bike_id.make} {bike_id.model}');
    assert.equal(resources.work_order_part.recordLabel, '{part_id.name} × {quantity}');
  });

  test("kinds: a line's total worked out, summed on its order, its price its part's", () => {
    const line = resources.work_order_part as { computed: Record<string, unknown>; form: { defaults: Record<string, unknown> } };
    assert.deepEqual(line.computed.line_total, { type: 'number', value: 'quantity * unit_price' });
    assert.deepEqual(line.form.defaults.unit_price, { from: 'part_id.price' });
    assert.ok(/parts_total: sum\('work_order_part', 'line_total'\)/.test(files['resources.ts']), files['resources.ts']);
    // Money, the flag, the due date and the people avatar are the runtime's conventions: the draft writes none of them.
    assert.ok(!/format: 'money'|relative|avatar|values: \{ 0:/.test(files['resources.ts']));
    assert.deepEqual((resources.work_orders as { types: unknown }).types, {
      due_on: 'date',
      received_at: 'datetime',
      ready_at: 'datetime',
      completed_on: 'date',
    });
  });

  test('the recipe is chosen and said, with why', () => {
    assert.equal(recipe.name, 'Service desk or ticketing');
    assert.match(files['README.md'], /## Recipe: Service desk or ticketing/);
    assert.match(files['README.md'], /received → in_progress → ready → collected/);
    assert.match(files['README.md'], /mistri seed/);
  });

  test('it validates clean, and the design check has nothing to say', () => {
    assert.deepEqual(problems, [], problems.join('; '));
    const parsed = parseAppConfig(app, 'the draft');
    assert.deepEqual(designLint(parsed, parseAppPages(app, 'the draft'), withRollups(parsed, schema)).map(sayDesignFinding), []);
  });
});

describe('scaffold, then check and seed, from the command line', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
  const { file } = shop();
  const config = join(dir, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'shop', url: file, writable: true }] }));
  const project = join(dir, 'shop-app');

  test('the draft passes check with no warning, and the design check too', () => {
    const out = run(['--config', config, '--scaffold-app', project]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Nearest recipe: Service desk or ticketing/);
    // Multi-tenant adoption is a key decision made now: the next steps say so.
    assert.match(out.stdout, /Going multi-tenant later \(auth.rows "tenant"\) needs text ids declared NOT NULL/);
    mkdirSync(join(project, 'node_modules'));
    mkdirSync(join(project, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(project, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    const check = run(['check', '--app', project, '--config', config, '--design']);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /validation\s+passed\s+Shop: ok/);
    assert.match(check.stdout, /design\s+passed\s+nothing to say/);
    assert.doesNotMatch(check.stdout + check.stderr, /warn/i);
  });

  test("seed fills it through the App's machine, says whom to sign in as, and will not seed it twice", () => {
    const out = run(['seed', '--app', project, '--config', config, '--seed', '3', '--rows', '20']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Seeded shop with \d+ rows \(--seed 3\)/);
    assert.match(out.stdout, /Sign in as [a-z]+\.[a-z]+@example\.com/);
    assert.ok(Number(rowsOf(file, 'SELECT count(*) AS n FROM work_orders')[0].n) >= 20, 'at least the rows asked for');
    assert.equal(rowsOf(file, 'SELECT count(*) AS n FROM mechanics')[0].n, 4, 'staff are fewer');
    const again = run(['seed', '--app', project, '--config', config]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already hold rows.*--append/);
  });

  test('a read-only connection is refused before anything is opened for writing', () => {
    const readOnly = join(dir, 'read-only.json');
    const { file: empty } = shop();
    writeFileSync(readOnly, JSON.stringify({ connections: [{ name: 'shop', url: empty }] }));
    const out = run(['seed', '--config', readOnly]);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /"shop" is read-only/);
    assert.equal(rowsOf(empty, 'SELECT count(*) AS n FROM customers')[0].n, 0);
    const bare = run(['seed', empty]);
    assert.equal(bare.status, 2, 'a database named on the command line is read-only');
  });
});

/** Seed a fresh shop in-process, with no App: its machine drafted from the schema. */
async function seeded(seed: number, rows = 30): Promise<string> {
  const { file, adapter } = shop();
  try {
    await seedDatabase(adapter, await adapter.introspect(), { rows, seed, today: TODAY });
  } finally {
    await adapter.close();
  }
  return file;
}
const dump = (file: string) =>
  ['customers', 'mechanics', 'bikes', 'parts', 'work_orders', 'work_order_part'].map((table) =>
    rowsOf(file, `SELECT * FROM ${table} ORDER BY id`),
  );

describe('tablewalk seed, on SQLite', () => {
  test('the same seed makes the same rows; another makes others', async () => {
    const [a, b, c] = [await seeded(11), await seeded(11), await seeded(12)];
    assert.deepEqual(dump(a), dump(b));
    assert.notDeepEqual(dump(a), dump(c));
  });

  test('parents come first: every reference points at a row, and a work order is its bike owner’s', async () => {
    const file = await seeded(5);
    for (const [child, column, parent] of [
      ['bikes', 'customer_id', 'customers'],
      ['work_orders', 'bike_id', 'bikes'],
      ['work_orders', 'customer_id', 'customers'],
      ['work_orders', 'mechanic_id', 'mechanics'],
      ['work_order_part', 'work_order_id', 'work_orders'],
      ['work_order_part', 'part_id', 'parts'],
    ]) {
      const orphans = rowsOf(
        file,
        `SELECT count(*) AS n FROM ${child} c WHERE c.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = c.${column})`,
      );
      assert.equal(orphans[0].n, 0, `${child}.${column}`);
    }
    const crossed = rowsOf(
      file,
      'SELECT count(*) AS n FROM work_orders w JOIN bikes b ON b.id = w.bike_id WHERE b.customer_id <> w.customer_id',
    );
    assert.equal(crossed[0].n, 0);
    const priced = rowsOf(
      file,
      'SELECT count(*) AS n FROM work_order_part l JOIN parts p ON p.id = l.part_id WHERE l.unit_price <> p.price',
    );
    assert.equal(priced[0].n, 0, "a line's price is its part's");
  });

  test('vocabularies, uniques and NOT NULL hold; names and emails read as people', async () => {
    const file = await seeded(8, 60);
    const statuses = new Set(rowsOf(file, 'SELECT DISTINCT status FROM work_orders').map((row) => row.status));
    for (const status of statuses) assert.ok(['received', 'in_progress', 'ready', 'collected', 'cancelled'].includes(status as string));
    assert.ok(statuses.size >= 4, [...statuses].join(', '));
    for (const [table, column] of [
      ['customers', 'email'],
      ['mechanics', 'email'],
      ['parts', 'sku'],
    ]) {
      const dupes = rowsOf(file, `SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL GROUP BY ${column} HAVING count(*) > 1`);
      assert.deepEqual(dupes, [], `${table}.${column}`);
    }
    const customer = rowsOf(file, 'SELECT name, email FROM customers LIMIT 1')[0];
    assert.match(String(customer.name), /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.match(String(customer.email), /^[a-z]+\.[a-z]+\d*@example\.com$/);
  });

  /* A shop's services — a name, a price, the minutes it takes, picked by every work order — were filled like a main
     table: 40 rows of "Bright widget". A lookup is a handful, each named, its price climbing with its tier; parts,
     kept in stock by a code, stay a main table. */
  test('a lookup table is a handful of named rows, not a main table of generic text', async () => {
    const file = join(dir, `lookup-${++made}.db`);
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC NOT NULL, minutes INTEGER);
      CREATE TABLE category (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT, unit_price NUMERIC NOT NULL, in_stock INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE work_order (id INTEGER PRIMARY KEY, package_id INTEGER REFERENCES service(id), category_id INTEGER REFERENCES category(id), complaint TEXT NOT NULL);
      CREATE TABLE work_order_part (id INTEGER PRIMARY KEY, work_order_id INTEGER NOT NULL REFERENCES work_order(id), part_id INTEGER NOT NULL REFERENCES part(id), quantity INTEGER NOT NULL);
    `);
    db.close();
    const adapter = connect(file, { schemas: [] });
    try {
      await seedDatabase(adapter, await adapter.introspect(), { rows: 40, seed: 3, today: TODAY });
    } finally {
      await adapter.close();
    }
    const services = rowsOf(file, 'SELECT name, price, minutes FROM service ORDER BY id');
    assert.deepEqual(
      services.map((row) => row.name),
      ['Basic service', 'Standard service', 'Premium service', 'Express service', 'Full service', 'Deluxe service'],
    );
    const prices = services.map((row) => Number(row.price));
    assert.deepEqual(
      prices,
      [...prices].sort((a, b) => a - b),
      'the price climbs with the tier',
    );
    assert.ok(services.every((row) => Number(row.minutes) > 0));
    assert.deepEqual(
      rowsOf(file, 'SELECT name FROM category ORDER BY id').map((row) => row.name),
      ['Maintenance', 'Repair', 'Inspection', 'Upgrade', 'Warranty', 'Accessories', 'Safety', 'Tuning'],
    );
    assert.equal(rowsOf(file, 'SELECT count(*) AS n FROM part')[0].n, 40, 'parts are a main table');
  });

  test('each state carries the stamps of the states it passed through, and no others', async () => {
    const file = await seeded(21, 80);
    const orders = rowsOf(file, 'SELECT status, received_at, ready_at, completed_on, due_on FROM work_orders');
    for (const order of orders) {
      const reachedReady = order.status === 'ready' || order.status === 'collected';
      // A cancelled order may have been ready first; any other has its ready stamp exactly when it got there.
      if (order.status !== 'cancelled') assert.equal(order.ready_at !== null, reachedReady, JSON.stringify(order));
      assert.equal(order.completed_on !== null, order.status === 'collected', JSON.stringify(order));
      if (order.ready_at) assert.ok(String(order.ready_at) >= String(order.received_at), JSON.stringify(order));
      if (order.completed_on) assert.ok(String(order.completed_on) >= String(order.ready_at).slice(0, 10), JSON.stringify(order));
    }
    // Most of the work is open, a third or so is done, a little is called off.
    const share = (status: string) => orders.filter((order) => order.status === status).length / orders.length;
    assert.ok(share('collected') > 0.2 && share('collected') < 0.55, String(share('collected')));
    assert.ok(share('cancelled') > 0 && share('cancelled') < 0.25, String(share('cancelled')));
  });

  test('dates fall across the windows a dashboard reads, and some open work is due today or overdue', async () => {
    const file = await seeded(4, 80);
    const day = (offset: number) => new Date(Date.UTC(2026, 9, 10) - offset * 86_400_000).toISOString().slice(0, 10);
    const received = rowsOf(file, 'SELECT received_at FROM work_orders').map((row) => String(row.received_at).slice(0, 10));
    assert.ok(
      received.every((at) => at >= day(90) && at <= day(0)),
      'within the quarter, never ahead',
    );
    assert.ok(
      received.some((at) => at >= day(7)),
      'some this week',
    );
    assert.ok(
      received.some((at) => at < day(30)),
      'some before the month',
    );
    const open = rowsOf(file, "SELECT due_on FROM work_orders WHERE status IN ('received', 'in_progress', 'ready')").map(
      (row) => row.due_on,
    );
    assert.ok(open.some((due) => due === day(0)) || open.some((due) => String(due) < day(0)), JSON.stringify(open));
    assert.ok(
      open.some((due) => String(due) < day(0)),
      'overdue',
    );
  });

  test('a table that holds rows is refused unless --append, before a row is written', async () => {
    const { file, adapter } = shop();
    try {
      const schema = await adapter.introspect();
      await seedDatabase(adapter, schema, { rows: 5, seed: 1, today: TODAY });
      const before = dump(file);
      await assert.rejects(seedDatabase(adapter, schema, { rows: 5, seed: 2, today: TODAY }), (error: unknown) => {
        assert.ok(error instanceof SeedRefusal);
        assert.match((error as Error).message, /customers \(5 rows\).*already hold rows/);
        return true;
      });
      assert.deepEqual(dump(file), before);
      await seedDatabase(adapter, schema, { rows: 5, seed: 2, today: TODAY, append: true });
      assert.equal(rowsOf(file, 'SELECT count(*) AS n FROM customers')[0].n, 10);
      const dupes = rowsOf(file, 'SELECT email FROM customers WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1');
      assert.deepEqual(dupes, [], 'appended rows never repeat a unique value already there');
    } finally {
      await adapter.close();
    }
  });
});

/* PostgreSQL, only where TABLEWALK_TEST_PG names a server: a scratch schema of its own, dropped after. */
const PG = process.env.TABLEWALK_TEST_PG;
describe('tablewalk seed, on PostgreSQL', { skip: PG ? false : 'TABLEWALK_TEST_PG is not set' }, () => {
  test('the shop fills, deterministically, with real dates and booleans', async () => {
    type Client = {
      connect(): Promise<void>;
      query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
      end(): Promise<void>;
    };
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const scratch = `tw_seed_${process.pid}`;
    const client = new pg.default.Client({ connectionString: PG });
    await client.connect();
    const ddl = SHOP.replace(/INTEGER PRIMARY KEY/g, 'SERIAL PRIMARY KEY')
      .replace(/created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/g, 'created_at TIMESTAMP NOT NULL DEFAULT now()')
      .replace(/received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/g, 'received_at TIMESTAMPTZ NOT NULL DEFAULT now()')
      .replace(/is_active INTEGER NOT NULL DEFAULT 1 CHECK \(is_active IN \(0,1\)\)/, 'is_active BOOLEAN NOT NULL DEFAULT true')
      .replace(/is_rush INTEGER NOT NULL DEFAULT 0 CHECK \(is_rush IN \(0,1\)\)/, 'is_rush BOOLEAN NOT NULL DEFAULT false')
      .replace(/due_on TEXT/, 'due_on DATE')
      .replace(/ready_at TEXT/, 'ready_at TIMESTAMPTZ')
      .replace(/completed_on TEXT/, 'completed_on DATE')
      .replace(/CREATE INDEX (\w+)/g, (_, name: string) => `CREATE INDEX ${scratch}_${name}`);
    const fill = async (seed: number) => {
      await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE; CREATE SCHEMA ${scratch}; SET search_path TO ${scratch};`);
      await client.query(ddl);
      const adapter = connect(PG!, { schemas: [scratch] });
      try {
        await seedDatabase(adapter, await adapter.introspect(), { rows: 15, seed, today: TODAY });
      } finally {
        await adapter.close();
      }
      const rows = await client.query(
        `SELECT status, is_rush, received_at, ready_at, completed_on, due_on FROM ${scratch}.work_orders ORDER BY id`,
      );
      return rows.rows;
    };
    try {
      const first = await fill(9);
      // A child table gets at least one row per parent (seed.ts), so more than the rows asked for.
      assert.ok(first.length >= 15, 'at least the rows asked for');
      assert.deepEqual(await fill(9), first);
      for (const order of first) {
        assert.equal(typeof order.is_rush, 'boolean');
        assert.equal(order.completed_on !== null, order.status === 'collected');
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
      await client.end();
    }
  });
});
