/**
 * `index-missing` (checkIndexes.ts): the App's declared access paths against
 * the database's own index list. The matching is a pure function of the
 * catalog and the index list, so the rules are held on hand-made ones; one
 * block reads a real PostgreSQL's `pg_index` (TABLEWALK_TEST_PG, a disposable
 * server) and one run of the command holds the wiring: the step, the flag and
 * the SQLite note.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { indexFindings, readPgIndexes, SMALL_TABLE_ROWS, type PgIndex } from '../packages/mistri/src/server/build/checkIndexes.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const col = (name: string, type = 'integer') => ({
  name,
  type,
  nullable: true,
  primaryKey: name === 'id',
});
const table = (name: string, columns: Array<[string, string?]>, approxRows?: number): TableMeta =>
  ({
    id: `public.${name}`,
    name,
    schema: 'public',
    isView: false,
    columns: columns.map(([c, t]) => col(c, t)),
    ...(approxRows === undefined ? {} : { approxRows }),
  }) as TableMeta;
const schema = (rows = 50_000): DatabaseSchema =>
  ({
    dialect: 'postgres',
    tables: [
      table('customer', [['id'], ['name', 'text']], rows),
      table('invoice', [['id'], ['customer_id'], ['tenant_id'], ['issued_on', 'date'], ['status', 'text']], rows),
    ],
    foreignKeys: [
      {
        name: 'invoice_customer',
        from: { table: 'public.invoice', columns: ['customer_id'] },
        to: { table: 'public.customer', columns: ['id'] },
      },
    ],
  }) as unknown as DatabaseSchema;
const index = (tableName: string, columns: Array<string | null>, more: Partial<PgIndex> = {}): PgIndex => ({
  table: `public.${tableName}`,
  columns,
  btree: true,
  trigram: [],
  ...more,
});
const app = (views: Record<string, unknown> = {}, resources: Record<string, unknown> = { customer: {}, invoice: {} }) =>
  ({
    id: 'billing',
    name: 'Billing',
    resources,
    views,
    nav: [],
  }) as unknown as AppDef;
const primaries = [index('customer', ['id']), index('invoice', ['id'])];
const said = (found: ReturnType<typeof indexFindings>) =>
  found.map((finding) => `${finding.severity} ${finding.declaration} ${finding.columns.join(',')}`);

describe('indexFindings', () => {
  test('a foreign key a related list reads by is flagged with the line that adds the index', () => {
    const found = indexFindings({
      app: app(),
      pages: [],
      schema: schema(),
      indexes: primaries,
    });
    assert.deepEqual(said(found), ['warning resources.invoice customer_id']);
    assert.equal(found[0]!.table, 'invoice');
    assert.equal(found[0]!.fix, 'CREATE INDEX IF NOT EXISTS idx_invoice_customer_id ON invoice (customer_id);');
    assert.match(
      found[0]!.message,
      /resources\.invoice: a record of customer lists its invoice by customer_id \(invoice, about 50,000 rows\)/,
    );
  });

  test('an index on the column is not flagged', () => {
    assert.deepEqual(
      indexFindings({
        app: app(),
        pages: [],
        schema: schema(),
        indexes: [...primaries, index('invoice', ['customer_id'])],
      }),
      [],
    );
  });

  test('a multi-column index counts when the needed columns are its leading ones, and only then', () => {
    const led = [...primaries, index('invoice', ['customer_id', 'issued_on'])];
    assert.deepEqual(indexFindings({ app: app(), pages: [], schema: schema(), indexes: led }), []);
    const second = [...primaries, index('invoice', ['issued_on', 'customer_id'])];
    assert.deepEqual(
      said(
        indexFindings({
          app: app(),
          pages: [],
          schema: schema(),
          indexes: second,
        }),
      ),
      ['warning resources.invoice customer_id'],
    );
    const expression = [...primaries, index('invoice', [null, 'customer_id'])];
    assert.equal(
      indexFindings({
        app: app(),
        pages: [],
        schema: schema(),
        indexes: expression,
      }).length,
      1,
      'an expression leads nothing',
    );
  });

  test('a small table is information, a large one a warning', () => {
    const small = indexFindings({
      app: app(),
      pages: [],
      schema: schema(SMALL_TABLE_ROWS - 1),
      indexes: primaries,
    });
    assert.deepEqual(said(small), ['info resources.invoice customer_id']);
    const large = indexFindings({
      app: app(),
      pages: [],
      schema: schema(SMALL_TABLE_ROWS),
      indexes: primaries,
    });
    assert.deepEqual(said(large), ['warning resources.invoice customer_id']);
  });

  test("a list's default sort is read in order, and its fixed filter by its columns", () => {
    const views = {
      open: {
        table: 'invoice',
        sort: 'issued_on desc, status',
        filterBar: 'none',
      },
    };
    const withKey = [...primaries, index('invoice', ['customer_id'])];
    assert.deepEqual(
      said(
        indexFindings({
          app: app(views),
          pages: [],
          schema: schema(),
          indexes: withKey,
        }),
      ),
      ['warning views.open.sort issued_on,status'],
    );
    assert.deepEqual(
      indexFindings({
        app: app(views),
        pages: [],
        schema: schema(),
        indexes: [...withKey, index('invoice', ['issued_on', 'status'])],
      }),
      [],
    );
    assert.equal(
      indexFindings({
        app: app(views),
        pages: [],
        schema: schema(),
        indexes: [...withKey, index('invoice', ['status', 'issued_on'])],
      }).length,
      1,
      'a sort needs its columns in order',
    );
    const filtered = {
      open: {
        table: 'invoice',
        query: "status = 'open'",
        sort: 'issued_on',
        filterBar: 'none',
      },
    };
    assert.deepEqual(
      said(
        indexFindings({
          app: app(filtered),
          pages: [],
          schema: schema(),
          indexes: withKey,
        }),
      ),
      ['warning views.open.query status,issued_on'],
      'the index to add is the filter column, then the sort',
    );
    assert.deepEqual(
      indexFindings({
        app: app(filtered),
        pages: [],
        schema: schema(),
        indexes: [...withKey, index('invoice', ['status'])],
      }),
      [],
    );
  });

  test("a tenant's ownership column is flagged, and satisfied by an index it leads", () => {
    const owners = { invoice: 'tenant_id' };
    const withKey = [...primaries, index('invoice', ['customer_id'])];
    assert.deepEqual(
      said(
        indexFindings({
          app: app(),
          pages: [],
          schema: schema(),
          indexes: withKey,
          owners,
        }),
      ),
      ['warning resources.invoice tenant_id'],
    );
    assert.deepEqual(
      indexFindings({
        app: app(),
        pages: [],
        schema: schema(),
        indexes: [...withKey, index('invoice', ['tenant_id', 'issued_on'])],
        owners,
      }),
      [],
    );
  });

  test("a search box's contains wants a trigram index, which a resource's search provider makes unnecessary", () => {
    const views = { customers: { table: 'customer' } };
    const withKey = [...primaries, index('invoice', ['customer_id'])];
    const found = indexFindings({
      app: app(views),
      pages: [],
      schema: schema(),
      indexes: withKey,
    });
    assert.deepEqual(said(found), ['warning views.customers.search name']);
    assert.match(
      found[0]!.fix,
      /CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX IF NOT EXISTS idx_customer_name_trgm ON customer USING gin \(name gin_trgm_ops\);/,
    );
    const trigram = [...withKey, index('customer', ['name'], { btree: false, trigram: ['name'] })];
    assert.deepEqual(
      indexFindings({
        app: app(views),
        pages: [],
        schema: schema(),
        indexes: trigram,
      }),
      [],
    );
    const provider = app(views, {
      customer: { search: { connection: 'typesense', fields: ['name'] } },
      invoice: {},
    });
    assert.deepEqual(
      indexFindings({
        app: provider,
        pages: [],
        schema: schema(),
        indexes: withKey,
      }),
      [],
    );
  });

  test('a finding is said once however many declarations ask', () => {
    const views = {
      a: { table: 'invoice', sort: 'issued_on', filterBar: 'none' },
      b: { table: 'invoice', sort: 'issued_on', filterBar: 'none' },
    };
    const withKey = [...primaries, index('invoice', ['customer_id'])];
    assert.equal(
      indexFindings({
        app: app(views),
        pages: [],
        schema: schema(),
        indexes: withKey,
      }).length,
      1,
    );
  });
});

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);

describe('index-missing against a real PostgreSQL', { skip }, () => {
  test('pg_index says which foreign keys, sorts and searches nothing leads, on tables of their size', async () => {
    const database = await uuidPostgresDatabase('idxcheck');
    const control = await pgClient(database.url);
    const adapter = new PostgresAdapter(database.url);
    try {
      await control.query(`
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE TABLE customer (id integer PRIMARY KEY, name text NOT NULL);
        CREATE TABLE invoice (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES customer, issued_on date, status text);
        CREATE TABLE line (id integer PRIMARY KEY, invoice_id integer NOT NULL REFERENCES invoice, sku text);
        CREATE INDEX line_invoice ON line (invoice_id, sku);
        INSERT INTO customer SELECT n, 'c' || n FROM generate_series(1, 20) n;
        INSERT INTO invoice SELECT n, 1 + n % 20, current_date, 'open' FROM generate_series(1, 20000) n;
        INSERT INTO line SELECT n, 1 + n % 20000, 's' FROM generate_series(1, 30) n;
        ANALYZE`);
      const catalog = await adapter.introspect();
      const indexes = await readPgIndexes(adapter);
      assert.ok(indexes, 'the role may read pg_index');
      assert.ok(indexes.some((i) => i.table === 'public.line' && i.columns.join() === 'invoice_id,sku'));
      const resources = { customer: {}, invoice: {}, line: {} };
      const views = {
        invoices: { table: 'invoice', sort: 'issued_on', filterBar: 'none' },
        customers: { table: 'customer' },
      };
      const found = indexFindings({
        app: app(views, resources),
        pages: [],
        schema: catalog,
        indexes,
      });
      assert.deepEqual(said(found).sort(), [
        'info views.customers.search name',
        'warning resources.invoice customer_id',
        'warning views.invoices.sort issued_on',
      ]);

      await control.query(`
        CREATE INDEX ON invoice (customer_id);
        CREATE INDEX ON invoice (issued_on);
        CREATE INDEX ON customer USING gin (name gin_trgm_ops)`);
      const after = await readPgIndexes(adapter);
      assert.deepEqual(
        indexFindings({
          app: app(views, resources),
          pages: [],
          schema: catalog,
          indexes: after!,
        }),
        [],
      );
    } finally {
      await adapter.close();
      await control.end();
      await database.drop();
    }
  });
});

describe('mistri check indexes step', () => {
  const ROOT = resolve('.');
  const work = mkdtempSync(join(tmpdir(), 'tablewalk-check-indexes-'));
  after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  const dir = join(work, 'app');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'app.ts'),
    "export default { id: 'billing', name: 'Billing', resources: { customer: {}, invoice: {} }, views: { invoices: { kind: 'list', from: 'invoice' } }, home: 'invoices' };\n",
  );
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), 'check', '--app', dir, ...args],
        {
          cwd: ROOT,
          env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') },
          timeout: 180_000,
          killSignal: 'SIGKILL',
        },
        (error, out, err) =>
          done({
            code: (error as { code?: number } | null)?.code ?? 0,
            out,
            err,
          }),
      );
    });
  type Report = {
    steps: Array<{ step: string; status: string; detail: string }>;
    problems: Array<{
      code: string;
      step: string;
      severity: string;
      path?: string;
      fix?: string;
    }>;
  };

  test('SQLite is skipped with one note, and --no-index-check leaves the step out', async () => {
    const db = join(work, 'billing.db');
    spawnSync(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]);
         d.exec('CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE invoice (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer, issued_on TEXT)')`,
        db,
      ],
      { encoding: 'utf8' },
    );
    const text = (await run([db])).out;
    assert.equal(text.match(/^ {2}indexes: /gm)?.length, 1, text);
    assert.match(text, /indexes: skipped, PostgreSQL only/);
    assert.doesNotMatch(text, /^ {2}indexes +(passed|skipped)/m, 'a step of SQLite would change every count of steps');
    const ran = JSON.parse((await run([db, '--json'])).out) as Report;
    assert.ok(!ran.steps.some((s) => s.step === 'indexes'));
    assert.ok(!ran.problems.some((p) => p.code === 'index-missing'));
    assert.doesNotMatch((await run([db, '--no-index-check'])).out, /^ {2}indexes/m);
  });

  test('PostgreSQL names the missing index in the report, and --no-index-check skips it', { skip }, async () => {
    const database = await uuidPostgresDatabase('idxrun');
    const control = await pgClient(database.url);
    try {
      await control.query(`
        CREATE TABLE customer (id integer PRIMARY KEY, name text);
        CREATE TABLE invoice (id integer PRIMARY KEY, customer_id integer REFERENCES customer, issued_on date);
        INSERT INTO invoice SELECT n, NULL, current_date FROM generate_series(1, 12000) n;
        ANALYZE`);
      const ran = JSON.parse((await run(['--db', database.url, '--json'])).out) as Report;
      assert.equal(ran.steps.find((s) => s.step === 'indexes')?.status, 'passed');
      const found = ran.problems.filter((p) => p.code === 'index-missing');
      assert.ok(
        found.some((p) => p.severity === 'warning' && p.path === 'resources.invoice' && /ON invoice \(customer_id\)/.test(p.fix ?? '')),
        JSON.stringify(found),
      );
      const skipped = JSON.parse((await run(['--db', database.url, '--no-index-check', '--json'])).out) as Report;
      assert.ok(!skipped.steps.some((s) => s.step === 'indexes'));
      assert.ok(!skipped.problems.some((p) => p.code === 'index-missing'));
    } finally {
      await control.end();
      await database.drop();
    }
  });
});
