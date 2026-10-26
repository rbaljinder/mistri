/**
 * Column comparisons, `me` and record label templates on the engines an App
 * runs on: the statement text is judged per style in
 * query-column-values.test.ts, and only a real server says whether Postgres
 * and MySQL read it the same way — `CAST(x AS TEXT)` beside `CAST(x AS CHAR)`,
 * `||` beside `CONCAT`, an integer compared with an integer through a join.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MysqlAdapter } from '../packages/engine/src/adapters/mysql.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { withViewLabels } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { liveSkip } from './live.js';

/* The same rows on every engine: stock below its product's reorder level is
   rows 1 and 4, and Bolt's label reads the same wherever it is computed. */
async function proves(adapter: Adapter, schema: DatabaseSchema, product: string, stock: string) {
  const low = textToView(schema, `${stock} where on_hand < product_id.reorder_level sort id`).view!;
  assert.deepEqual(
    (await adapter.runView!(low)).rows.map((row) => Number(row.id)),
    [1, 4],
  );
  assert.equal(Number(await adapter.countView!(low)), 2);
  const counted = textToBreakdown(schema, `${stock} on_hand < product_id.reorder_level count`).breakdown!;
  assert.equal(Number((await adapter.runBreakdown!(counted)).rows[0].count), 2);

  const me = textToView(schema, `${stock} where product_id.owner = me sort id`, { me: { email: 'ada@x.test' } }).view!;
  assert.deepEqual(
    (await adapter.runView!(me)).rows.map((row) => Number(row.id)),
    [1, 2],
  );

  const served: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === product
        ? { ...table, labelTemplate: "{name} ({id}) O'Neil" }
        : table.id === stock
          ? { ...table, labelTemplate: '{product_id.name} × {on_hand}' }
          : table,
    ),
  };
  const labelled = withViewLabels(
    served,
    textToView(served, `${stock} show $label, product_id.$label where $label contains Bolt sort $label desc`).view!,
  );
  assert.deepEqual((await adapter.runView!(labelled)).rows, [
    { $label: 'Bolt × 4', 'product_id.$label': "Bolt (1) O'Neil" },
    { $label: 'Bolt × 20', 'product_id.$label': "Bolt (1) O'Neil" },
  ]);
}

const PG = process.env.TABLEWALK_TEST_PG;
describe('column comparisons, me and record labels on PostgreSQL', { skip: liveSkip('postgres', PG) }, () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const product = `tw_cv_product_${suffix}`;
  const stock = `tw_cv_stock_${suffix}`;
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
      await db.query(`CREATE TABLE public.${product} (id integer PRIMARY KEY, name text NOT NULL, owner text, reorder_level integer)`);
      await db.query(
        `CREATE TABLE public.${stock} (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES public.${product}(id), on_hand integer NOT NULL)`,
      );
      await db.query(
        `INSERT INTO public.${product} VALUES (1, 'Bolt', 'ada@x.test', 10), (2, 'Nut', 'bo@x.test', 5), (3, 'Washer', NULL, NULL)`,
      );
      await db.query(`INSERT INTO public.${stock} VALUES (1, 1, 4), (2, 1, 20), (3, 2, 5), (4, 2, 1), (5, 3, 0)`);
    } finally {
      await db.end();
    }
    adapter = new PostgresAdapter(PG!, 'column values');
  });
  after(async () => {
    await adapter?.close();
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.${stock}; DROP TABLE IF EXISTS public.${product}`);
    } finally {
      await db.end();
    }
  });

  test("the planner's statements read the same rows here", async () => {
    const schema = await adapter.introspect();
    const id = (name: string) => schema.tables.find((table) => table.name === name)!.id;
    await proves(adapter, schema, id(product), id(stock));
  });
});

const MY = process.env.TABLEWALK_TEST_MYSQL;
describe('column comparisons, me and record labels on MySQL', { skip: liveSkip('mysql', MY) }, () => {
  const DB = 'tablewalk_column_values';
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
      await db.query(
        `CREATE TABLE \`${DB}\`.product (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, owner VARCHAR(80), reorder_level INT)`,
      );
      await db.query(`CREATE TABLE \`${DB}\`.stock (id INT PRIMARY KEY, product_id INT NOT NULL, on_hand INT NOT NULL,
        FOREIGN KEY (product_id) REFERENCES \`${DB}\`.product(id))`);
      await db.query(
        `INSERT INTO \`${DB}\`.product VALUES (1, 'Bolt', 'ada@x.test', 10), (2, 'Nut', 'bo@x.test', 5), (3, 'Washer', NULL, NULL)`,
      );
      await db.query(`INSERT INTO \`${DB}\`.stock VALUES (1, 1, 4), (2, 1, 20), (3, 2, 5), (4, 2, 1), (5, 3, 0)`);
    } finally {
      await db.end();
    }
    const url = new URL(MY!);
    url.pathname = `/${DB}`;
    adapter = new MysqlAdapter(url.toString(), 'column values');
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

  test("the planner's statements read the same rows here", async () => {
    const schema = await adapter.introspect();
    const id = (name: string) => schema.tables.find((table) => table.name === name)!.id;
    await proves(adapter, schema, id('product'), id('stock'));
  });
});

/* SQLite runs the same proof without a server, so the three engines are held to one answer. */
test('and on SQLite, the same rows', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { SqliteAdapter } = await import('../packages/engine/src/adapters/sqlite.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-column-values-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'inv.db'));
  db.exec(`CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner TEXT, reorder_level INTEGER);
    CREATE TABLE stock (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product(id), on_hand INTEGER NOT NULL);
    INSERT INTO product VALUES (1, 'Bolt', 'ada@x.test', 10), (2, 'Nut', 'bo@x.test', 5), (3, 'Washer', NULL, NULL);
    INSERT INTO stock VALUES (1, 1, 4), (2, 1, 20), (3, 2, 5), (4, 2, 1), (5, 3, 0);`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'inv.db'), 'inv');
  t.after(() => adapter.close());
  await proves(adapter, await adapter.introspect(), 'product', 'stock');
});
