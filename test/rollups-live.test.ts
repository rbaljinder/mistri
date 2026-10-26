/**
 * Rollups (rollups.ts) on the engines an App runs on: the same purchase
 * orders, the same statements, the same numbers — shown, filtered, sorted,
 * counted, read through a reference, narrowed by the rollup's own query
 * (whose values bind in a CTE ahead of the outer filter's, where `?`
 * placeholders are positional), and under a row scope on the child, which
 * must narrow the number exactly as it narrows the rows — and the same
 * rollups as a breakdown's measure, key and condition, and a vendor's rollup
 * of its orders' rollups (two hops), each level narrowed by the scope.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MysqlAdapter } from '../packages/engine/src/adapters/mysql.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { withRollups } from '../packages/mistri/src/shared/appRollups.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { withBreakdownComputed } from '../packages/engine/src/shared/breakdown.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { liveSkip } from './live.js';

const SEED = [
  `INSERT INTO {vendor} VALUES (1, 'Acme'), (2, 'Brio')`,
  `INSERT INTO {po} VALUES (1, 'PO-1', 'open', 1), (2, 'PO-2', 'open', 1), (3, 'PO-3', 'closed', 2)`,
  `INSERT INTO {line} VALUES (1, 1, 2, 10, 'open', 'north'), (2, 1, 1, 30, 'done', 'north'), (3, 1, 5, 5, 'open', 'south'),
    (4, 2, 1, 100, 'open', 'north')`,
  `INSERT INTO {receipt} VALUES (1, 1), (2, 2), (3, 3)`,
];

const app = (po: string, line: string, vendor: string) =>
  ({
    resources: {
      [po]: {
        rollups: {
          lines: { fn: 'count', from: line },
          total: { fn: 'sum', from: line, column: 'amount' },
          biggest: { fn: 'max', from: line, column: 'amount' },
          open_lines: { fn: 'count', from: line, query: "state = 'open' and qty > 1" },
        },
      },
      [vendor]: {
        rollups: {
          // Rollups of the orders' rollups: two hops, to the lines.
          lines: { fn: 'sum', from: po, column: 'lines' },
          open_value: { fn: 'sum', from: po, column: 'total', query: "status = 'open'" },
          // Straight through two references to the lines: the largest, the smallest, and the newest by quantity.
          top_line: { fn: 'max', from: line, column: 'amount', whose: 'po_id.vendor_id' },
          least_line: { fn: 'min', from: line, column: 'amount', whose: 'po_id.vendor_id' },
          busiest_tenant: { fn: 'latest', from: line, column: 'tenant', by: 'qty', whose: 'po_id.vendor_id' },
        },
      },
    },
  }) as unknown as AppDef;

/* Numbers come back as the driver reads them (a bigint count as text on
   Postgres, a DECIMAL sum as text on MySQL); the proof is about which. */
const n = (value: unknown) => (value === null ? null : Number(value));

async function proves(adapter: Adapter, raw: DatabaseSchema, po: string, line: string, receipt: string, vendor: string) {
  const schema = withRollups(app(po, line, vendor), raw);
  assert.ok(schema.tables.find((table) => table.id === vendor)!.rollups!.lines.of, 'a rollup of a rollup is served');
  const grouped = async (text: string, reader: Pick<Adapter, 'runBreakdown'> = adapter) => {
    const parsed = textToBreakdown(schema, text);
    assert.deepEqual(parsed.errors ?? [], [], text);
    const { text: _text, ...def } = parsed.breakdown!;
    return (await reader.runBreakdown!(withBreakdownComputed(schema, def))).rows;
  };
  const run = async (text: string, reader: Pick<Adapter, 'runView' | 'countView'> = adapter) => {
    const parsed = textToView(schema, text);
    assert.deepEqual(parsed.errors, [], text);
    const view = withViewComputed(schema, parsed.view!);
    return { rows: (await reader.runView!(view)).rows, count: Number(await reader.countView!(view)) };
  };

  const listed = await run(`${po} show number, lines, total, biggest, open_lines sort number`);
  assert.deepEqual(
    listed.rows.map((row) => [row.number, n(row.lines), n(row.total), n(row.biggest), n(row.open_lines)]),
    [
      ['PO-1', 3, 45, 30, 2],
      ['PO-2', 1, 100, 100, 0],
      ['PO-3', 0, 0, null, 0],
    ],
  );

  // A filter and a sort on a rollup, beside an ordinary condition with a value of its own.
  const big = await run(`${po} show number where total > 40 and status = open sort total desc`);
  assert.deepEqual(
    big.rows.map((row) => row.number),
    ['PO-2', 'PO-1'],
  );
  assert.equal(big.count, 2);
  const none = await run(`${po} show number where lines = 0`);
  assert.deepEqual(
    none.rows.map((row) => row.number),
    ['PO-3'],
  );
  const narrowed = await run(`${po} show number, open_lines where open_lines >= 1 and number != 'PO-9' sort number`);
  assert.deepEqual(
    narrowed.rows.map((row) => [row.number, n(row.open_lines)]),
    [['PO-1', 2]],
  );

  // Through a reference: a receipt shows its order's total.
  const receipts = await run(`${receipt} show id, po_id.total where po_id.lines > 0 sort id`);
  assert.deepEqual(
    receipts.rows.map((row) => [n(row.id), n(row['po_id.total'])]),
    [
      [1, 45],
      [2, 100],
    ],
  );

  // Two hops: a vendor's lines are its orders' line counts summed, its open value their open orders' totals.
  const vendors = await run(`${vendor} show name, lines, open_value sort name`);
  assert.deepEqual(
    vendors.rows.map((row) => [row.name, n(row.lines), n(row.open_value)]),
    [
      ['Acme', 4, 145],
      ['Brio', 0, 0],
    ],
  );
  /* The newest of all the vendor's lines, not the newest of each order's newest: PO-2's one line has quantity 1,
     PO-1's south line 5, and the south line is the answer on every engine. */
  const reach = await run(`${vendor} show name, top_line, least_line, busiest_tenant sort name`);
  assert.deepEqual(
    reach.rows.map((row) => [row.name, n(row.top_line), n(row.least_line), row.busiest_tenant]),
    [
      ['Acme', 100, 5, 'south'],
      ['Brio', null, null, null],
    ],
  );
  assert.deepEqual(
    (await run(`${vendor} show name where busiest_tenant = 'south'`)).rows.map((row) => row.name),
    ['Acme'],
  );
  const busy = await run(`${vendor} show name where lines > 1`);
  assert.deepEqual(
    busy.rows.map((row) => row.name),
    ['Acme'],
  );

  // A rollup as a breakdown's measure, its key, its condition, and through a reference.
  const byStatus = await grouped(`${po} sum total by status sort status`);
  assert.deepEqual(
    byStatus.map((row) => [row.status, n(row['sum(total)'])]),
    [
      ['closed', 0],
      ['open', 145],
    ],
  );
  const whole = await grouped(`${po} open_lines >= 1 sum lines`);
  assert.deepEqual(
    whole.map((row) => n(row['sum(lines)'])),
    [3],
  );
  const byLines = await grouped(`${po} count by lines sort lines`);
  assert.deepEqual(
    byLines.map((row) => [n(row.lines), n(row.count)]),
    [
      [0, 1],
      [1, 1],
      [3, 1],
    ],
  );
  const throughRef = await grouped(`${receipt} sum po_id.total by po_id.status sort po_id.status`);
  assert.deepEqual(
    throughRef.map((row) => [row['po_id.status'], n(row['sum(po_id.total)'])]),
    [
      ['closed', 0],
      ['open', 145],
    ],
  );
  const twoHops = await grouped(`${vendor} sum open_value by name sort name`);
  assert.deepEqual(
    twoHops.map((row) => [row.name, n(row['sum(open_value)'])]),
    [
      ['Acme', 145],
      ['Brio', 0],
    ],
  );

  // A row scope on the child narrows the number as it narrows the rows — at every level, and in a breakdown.
  if (adapter.scopeReads) {
    const north = await adapter.scopeReads({
      [vendor]: true,
      [po]: true,
      [line]: { groups: [[{ column: 'tenant', op: '=', value: 'north' }]] },
    });
    const scoped = await run(`${po} show number, lines, total, open_lines where total > 0 sort number`, north);
    assert.deepEqual(
      scoped.rows.map((row) => [row.number, n(row.lines), n(row.total), n(row.open_lines)]),
      [
        ['PO-1', 2, 40, 1],
        ['PO-2', 1, 100, 0],
      ],
    );
    assert.equal(scoped.count, 2);
    const scopedVendors = await run(`${vendor} show name, lines, open_value sort name`, north);
    assert.deepEqual(
      scopedVendors.rows.map((row) => [row.name, n(row.lines), n(row.open_value)]),
      [
        ['Acme', 3, 140],
        ['Brio', 0, 0],
      ],
    );
    // The scope narrows the rows a two-hop latest, max and min read, as it narrows a sum's.
    const scopedReach = await run(`${vendor} show name, top_line, least_line, busiest_tenant sort name`, north);
    assert.deepEqual(
      scopedReach.rows.map((row) => [row.name, n(row.top_line), n(row.least_line), row.busiest_tenant]),
      [
        ['Acme', 100, 10, 'north'],
        ['Brio', null, null, null],
      ],
    );
    const scopedGroups = await grouped(`${po} sum total by status sort status`, north);
    assert.deepEqual(
      scopedGroups.map((row) => [row.status, n(row['sum(total)'])]),
      [
        ['closed', 0],
        ['open', 140],
      ],
    );
  }
}

const tables = (prefix: string) => ({
  vendor: `${prefix}vendor`,
  po: `${prefix}po`,
  line: `${prefix}po_line`,
  receipt: `${prefix}receipt`,
});
const seed = (names: { vendor: string; po: string; line: string; receipt: string }) =>
  SEED.map((sql) =>
    sql.replace('{vendor}', names.vendor).replace('{po}', names.po).replace('{line}', names.line).replace('{receipt}', names.receipt),
  );

const PG = process.env.TABLEWALK_TEST_PG;
describe('rollups on PostgreSQL', { skip: liveSkip('postgres', PG) }, () => {
  const names = tables(`tw_rollup_${randomUUID().replaceAll('-', '').slice(0, 10)}_`);
  let adapter: PostgresAdapter;
  type Client = { connect(): Promise<void>; query(text: string): Promise<unknown>; end(): Promise<void> };
  const client = async (): Promise<Client> => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client?: new (o: { connectionString: string }) => Client;
      default?: { Client: new (o: { connectionString: string }) => Client };
    };
    const Made = pg.Client ?? pg.default!.Client;
    const made = new Made({ connectionString: PG! });
    await made.connect();
    return made;
  };
  before(async () => {
    const db = await client();
    try {
      await db.query(`CREATE TABLE public.${names.vendor} (id integer PRIMARY KEY, name text NOT NULL)`);
      await db.query(`CREATE TABLE public.${names.po} (id integer PRIMARY KEY, number text NOT NULL, status text NOT NULL,
        vendor_id integer NOT NULL REFERENCES public.${names.vendor}(id))`);
      await db.query(`CREATE TABLE public.${names.line} (id integer PRIMARY KEY, po_id integer NOT NULL REFERENCES public.${names.po}(id),
        qty integer NOT NULL, amount numeric(12,2) NOT NULL, state text NOT NULL, tenant text NOT NULL)`);
      await db.query(`CREATE TABLE public.${names.receipt} (id integer PRIMARY KEY, po_id integer REFERENCES public.${names.po}(id))`);
      for (const sql of seed({
        vendor: `public.${names.vendor}`,
        po: `public.${names.po}`,
        line: `public.${names.line}`,
        receipt: `public.${names.receipt}`,
      }))
        await db.query(sql);
    } finally {
      await db.end();
    }
    adapter = new PostgresAdapter(PG!, 'rollups');
  });
  after(async () => {
    await adapter?.close();
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.${names.receipt}; DROP TABLE IF EXISTS public.${names.line}; DROP TABLE IF EXISTS public.${names.po};
        DROP TABLE IF EXISTS public.${names.vendor}`);
    } finally {
      await db.end();
    }
  });

  test('the same numbers here', async () => {
    const schema = await adapter.introspect();
    const id = (name: string) => schema.tables.find((table) => table.name === name)!.id;
    await proves(adapter, schema, id(names.po), id(names.line), id(names.receipt), id(names.vendor));
  });
});

const MY = process.env.TABLEWALK_TEST_MYSQL;
describe('rollups on MySQL', { skip: liveSkip('mysql', MY) }, () => {
  const DB = 'tablewalk_rollups';
  type Admin = { query(sql: string): Promise<unknown>; end(): Promise<void> };
  const admin = async (): Promise<Admin> => {
    const specifier = 'mysql2/promise';
    const mysql = (await import(specifier)) as { createConnection: (c: Record<string, unknown>) => Promise<Admin> };
    return mysql.createConnection({ uri: MY! });
  };
  let adapter: MysqlAdapter;
  before(async () => {
    const db = await admin();
    try {
      await db.query(`DROP DATABASE IF EXISTS \`${DB}\``);
      await db.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
      await db.query(`CREATE TABLE \`${DB}\`.vendor (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)`);
      await db.query(`CREATE TABLE \`${DB}\`.po (id INT PRIMARY KEY, number VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL,
        vendor_id INT NOT NULL, FOREIGN KEY (vendor_id) REFERENCES \`${DB}\`.vendor(id))`);
      await db.query(`CREATE TABLE \`${DB}\`.po_line (id INT PRIMARY KEY, po_id INT NOT NULL, qty INT NOT NULL, amount DECIMAL(12,2) NOT NULL,
        state VARCHAR(20) NOT NULL, tenant VARCHAR(20) NOT NULL, FOREIGN KEY (po_id) REFERENCES \`${DB}\`.po(id))`);
      await db.query(`CREATE TABLE \`${DB}\`.receipt (id INT PRIMARY KEY, po_id INT, FOREIGN KEY (po_id) REFERENCES \`${DB}\`.po(id))`);
      for (const sql of seed({ vendor: `\`${DB}\`.vendor`, po: `\`${DB}\`.po`, line: `\`${DB}\`.po_line`, receipt: `\`${DB}\`.receipt` }))
        await db.query(sql);
    } finally {
      await db.end();
    }
    const url = new URL(MY!);
    url.pathname = `/${DB}`;
    adapter = new MysqlAdapter(url.toString(), 'rollups');
  });
  after(async () => {
    await adapter?.close();
    const db = await admin();
    try {
      await db.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    } finally {
      await db.end();
    }
  });

  test('the same numbers here', async () => {
    const schema = await adapter.introspect();
    const id = (name: string) => schema.tables.find((table) => table.name === name)!.id;
    await proves(adapter, schema, id('po'), id('po_line'), id('receipt'), id('vendor'));
  });
});

/* SQLite runs the same proof without a server, so the three engines are held to one answer. */
test('rollups on SQLite: the same numbers', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { SqliteAdapter } = await import('../packages/engine/src/adapters/sqlite.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rollups-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'po.db'));
  db.exec(`CREATE TABLE vendor (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE po (id INTEGER PRIMARY KEY, number TEXT NOT NULL, status TEXT NOT NULL, vendor_id INTEGER NOT NULL REFERENCES vendor(id));
    CREATE TABLE po_line (id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES po(id), qty INTEGER NOT NULL,
      amount NUMERIC NOT NULL, state TEXT NOT NULL, tenant TEXT NOT NULL);
    CREATE TABLE receipt (id INTEGER PRIMARY KEY, po_id INTEGER REFERENCES po(id));
    ${seed(tables('')).join(';\n')};`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'po.db'), 'po');
  t.after(() => adapter.close());
  await proves(adapter, await adapter.introspect(), 'po', 'po_line', 'receipt', 'vendor');
});
