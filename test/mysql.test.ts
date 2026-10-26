/**
 * The MySQL adapter.
 *
 * Two halves. The first needs nothing installed and no server: how the dialect
 * quotes an identifier, how a filter compiles, and which adapter a URL picks.
 * The second is the real thing — a MySQL server, a schema created from source,
 * and every claim the adapter makes about it checked against what the server
 * actually does.
 *
 * The live half is opt-in through TABLEWALK_TEST_MYSQL, the same trade the
 * Postgres coverage in run.ts makes: requiring a running server to test a
 * SQLite feature would be a bad bargain, and a suite that fails on a laptop
 * with no MySQL on it is a suite people stop running.
 *
 *   docker run --rm -d -p 33061:3306 -e MYSQL_ROOT_PASSWORD=tablewalk mysql:8
 *   TABLEWALK_TEST_MYSQL=mysql://root:tablewalk@127.0.0.1:33061/mysql npm test
 *
 * The database named in that URL is never written to. The fixture lives in its
 * own database, created and dropped by this file, because a test that drops
 * tables in whatever schema someone pointed it at is a test that eventually
 * eats something real.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MYSQL_STYLE, buildWhere, DEFAULT_LIMIT, MAX_LIMIT, WriteConflict, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { changeImpact } from '../packages/tablewalk/src/server/changeimpact.js';
import { clearJournal, lastRevertible, recordWrite, revert, summarise } from '../packages/engine/src/server/journal.js';
import { MysqlAdapter } from '../packages/engine/src/adapters/mysql.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  defaultOrder,
  findTable,
  primaryKey,
  referencesFrom,
  referencesTo,
  type DatabaseSchema,
} from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import { liveSkip } from './live.js';
import { autoKey, isRequired } from '../packages/engine/src/shared/form.js';

describe('the MySQL dialect', () => {
  test('quotes with backticks and doubles an embedded one', () => {
    assert.equal(MYSQL_STYLE.quote('invoice'), '`invoice`');
    // A table called `weird`name` is a syntax error unless the backtick is
    // doubled, which is MySQL's only escape for an identifier.
    assert.equal(MYSQL_STYLE.quote('weird`name'), '`weird``name`');
    assert.equal(MYSQL_STYLE.quote('a`b`c'), '`a``b``c`');
  });

  test('binds every value as a parameter, never as text', () => {
    const filter: Filter = {
      groups: [[{ column: 'name', op: '=', value: "Bobby'); DROP TABLE customer;--" }]],
    };
    const { text, params } = buildWhere(filter, MYSQL_STYLE);
    assert.equal(text, ' WHERE `name` = ?');
    assert.deepEqual(params, ["Bobby'); DROP TABLE customer;--"]);
    // The critical property: the value is nowhere in the SQL string.
    assert.ok(!text.includes('DROP'));
  });

  test('placeholders stay positional, unlike Postgres', () => {
    const filter: Filter = {
      groups: [
        [
          { column: 'a', op: '=', value: 1 },
          { column: 'b', op: 'in', value: [2, 3] },
        ],
      ],
    };
    const { text, params } = buildWhere(filter, MYSQL_STYLE);
    assert.equal(text, ' WHERE `a` = ? AND `b` IN (?, ?)');
    assert.deepEqual(params, [1, 2, 3]);
  });

  test('an empty IN matches nothing, and OR groups keep their parentheses', () => {
    assert.equal(buildWhere({ groups: [[{ column: 'a', op: 'in', value: [] }]] }, MYSQL_STYLE).text, ' WHERE 1 = 0');
    const filter: Filter = {
      groups: [
        [
          { column: 'a', op: '=', value: 1 },
          { column: 'b', op: 'contains', value: 'x' },
        ],
        [{ column: 'c', op: 'isNull' }],
      ],
    };
    const { text, params } = buildWhere(filter, MYSQL_STYLE);
    assert.equal(text, " WHERE (`a` = ? AND `b` LIKE ? ESCAPE '#') OR (`c` IS NULL)");
    assert.deepEqual(params, [1, '%x%']);
  });
});

describe('choosing an adapter', () => {
  /* Construction only: none of these dial anything, which is the point —
     naming eight databases in a config must not mean eight connections. */

  test('a mysql:// URL picks the MySQL adapter', () => {
    const adapter = connect('mysql://user:secret@db.example.com:3306/shop');
    assert.ok(adapter instanceof MysqlAdapter);
    assert.equal(adapter.dialect, 'mysql');
  });

  test('mariadb:// picks it too, since it is the same protocol and catalog', () => {
    assert.ok(connect('mariadb://user@localhost/shop') instanceof MysqlAdapter);
    assert.ok(connect('MySQL://user@localhost/shop') instanceof MysqlAdapter);
  });

  test('the other dialects are untouched by the new case', (t) => {
    assert.ok(connect('postgres://localhost/app') instanceof PostgresAdapter);
    /* A real file, because the SQLite adapter opens its handle in the
       constructor — which is itself the read-only guarantee, so it is not
       something to work around. */
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-mysql-'));
    const file = join(dir, 'app.db');
    new DatabaseSync(file).close();
    const adapters = [connect(file), connect(`sqlite:${file}`)];
    t.after(async () => {
      await Promise.all(adapters.map((adapter) => adapter.close()));
      rmSync(dir, { recursive: true, force: true });
    });
    for (const adapter of adapters) assert.ok(adapter instanceof SqliteAdapter);
  });

  test('an unknown scheme still says what is supported, MySQL included', () => {
    assert.throws(() => connect('oracle://host/db'), /mysql:\/\//);
  });
});

/* ---------- live coverage ---------- */

const LIVE = process.env.TABLEWALK_TEST_MYSQL;
/** Its own database, so nothing this file drops belongs to anyone else. */
const FIXTURE_DB = 'tablewalk_mysql_fixture';

function fixtureUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${FIXTURE_DB}`;
  return url.toString();
}

/** Statements the fixture is built from. Read this to read the tests. */
const FIXTURE = [
  `CREATE TABLE assigned_defaults (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, status VARCHAR(20) NOT NULL DEFAULT 'new', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE composite_identity (id BIGINT NOT NULL AUTO_INCREMENT, tenant INT NOT NULL, PRIMARY KEY(id, tenant))`,
  `CREATE TABLE opaque_key (id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()), sequence BIGINT NOT NULL AUTO_INCREMENT UNIQUE)`,
  `CREATE TABLE large_identity (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY) AUTO_INCREMENT=9007199254740993`,
  `CREATE TABLE country (
     code CHAR(2) NOT NULL PRIMARY KEY,
     name VARCHAR(60) NOT NULL
   )`,
  `CREATE TABLE customer (
     id INT NOT NULL PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     email VARCHAR(120),
     active TINYINT(1) NOT NULL DEFAULT 1,
     credit_limit DECIMAL(10,2),
     country_code CHAR(2),
     updated_at DATETIME,
     CONSTRAINT customer_country FOREIGN KEY (country_code) REFERENCES country (code)
   ) COMMENT 'People who owe us money'`,
  /* A composite index, so "only the leading column" has something to be wrong
     about: `active` leads it and `name` does not. */
  `CREATE INDEX customer_active_name ON customer (active, name)`,
  `CREATE TABLE employee (
     id INT NOT NULL PRIMARY KEY,
     first_name VARCHAR(40) NOT NULL,
     manager_id INT,
     CONSTRAINT employee_manager FOREIGN KEY (manager_id) REFERENCES employee (id)
   )`,
  `CREATE TABLE invoice (
     id INT NOT NULL PRIMARY KEY,
     customer_id INT NOT NULL,
     invoice_date DATE,
     total DECIMAL(10,2),
     CONSTRAINT invoice_customer FOREIGN KEY (customer_id) REFERENCES customer (id)
   )`,
  `CREATE TABLE invoice_line (
     invoice_id INT NOT NULL,
     line_no INT NOT NULL,
     product VARCHAR(40),
     quantity INT NOT NULL,
     PRIMARY KEY (invoice_id, line_no),
     CONSTRAINT invoice_line_invoice FOREIGN KEY (invoice_id) REFERENCES invoice (id)
   )`,
  `CREATE TABLE shipment (
     id INT NOT NULL PRIMARY KEY,
     invoice_id INT,
     line_no INT,
     CONSTRAINT shipment_line FOREIGN KEY (invoice_id, line_no)
       REFERENCES invoice_line (invoice_id, line_no)
   )`,
  /* No primary key at all: InnoDB gives it a hidden clustered key that cannot
     be named in a WHERE clause, which is exactly what an update must refuse. */
  `CREATE TABLE eventlog (id INT NOT NULL, note VARCHAR(50))`,
  /* MySQL writes a vocabulary into the declared type rather than into a
     constraint, so this is a different read from the other two engines and
     needs its own fixture. */
  `CREATE TABLE ticket (
     id INT PRIMARY KEY,
     state ENUM('open','held','closed') NOT NULL DEFAULT 'open',
     note VARCHAR(50)
   )`,
  `CREATE VIEW customer_totals AS
     SELECT c.id, c.name, COUNT(i.id) AS invoices
       FROM customer c LEFT JOIN invoice i ON i.customer_id = c.id
      GROUP BY c.id, c.name`,
  `INSERT INTO country VALUES ('AU','Australia'), ('NZ','New Zealand'), ('GB','United Kingdom')`,
  `INSERT INTO customer VALUES
     (1,'Dry Creek Vineyards','orders@drycreek.example',1,5000.00,'AU','2026-08-01 09:00:00'),
     (2,'Harbour Freight Co',NULL,1,12000.00,'AU','2026-08-02 09:00:00'),
     (3,'Pennine Tools','sales@pennine.example',1,4500.00,'GB','2026-07-30 09:00:00'),
     (4,'Kiwi Cellars','hello@kiwicellars.example',1,8250.50,'NZ','2026-07-29 09:00:00'),
     (5,'Dormant Ltd','old@dormant.example',0,100.00,NULL,'2026-01-01 09:00:00')`,
  `INSERT INTO employee VALUES (1,'Miles',NULL), (2,'Rina',1), (3,'Tom',1)`,
  `INSERT INTO invoice VALUES
     (1001,1,'2025-03-14',250.00), (1002,1,'2025-06-02',75.50),
     (1003,2,'2025-11-20',900.00), (1004,3,'2026-02-11',120.00)`,
  `INSERT INTO invoice_line VALUES
     (1001,1,'Barrel',1), (1001,2,'Cork',2), (1004,3,'Spanner',5)`,
  `INSERT INTO shipment VALUES (1,1001,1)`,
] as const;

describe(
  'the MySQL adapter, against a real server',
  {
    skip: liveSkip('mysql', LIVE),
  },
  () => {
    let adapter: MysqlAdapter;
    let schema: DatabaseSchema;
    /** Fully qualified, because that is how the adapter names things. */
    const id = (name: string) => `${FIXTURE_DB}.${name}`;

    before(async () => {
      const specifier = 'mysql2/promise';
      const mysql = (await import(specifier)) as {
        createConnection: (c: Record<string, unknown>) => Promise<{
          query(sql: string): Promise<unknown>;
          end(): Promise<void>;
        }>;
      };
      const admin = await mysql.createConnection({ uri: LIVE!, multipleStatements: false });
      await admin.query(`DROP DATABASE IF EXISTS \`${FIXTURE_DB}\``);
      await admin.query(`CREATE DATABASE \`${FIXTURE_DB}\``);
      await admin.query(`USE \`${FIXTURE_DB}\``);
      for (const statement of FIXTURE) await admin.query(statement);
      await admin.end();

      adapter = new MysqlAdapter(fixtureUrl(LIVE!), 'fixture');
      schema = await adapter.introspect();
    });

    after(async () => {
      await adapter?.close();
      const specifier = 'mysql2/promise';
      const mysql = (await import(specifier)) as {
        createConnection: (c: Record<string, unknown>) => Promise<{
          query(sql: string): Promise<unknown>;
          end(): Promise<void>;
        }>;
      };
      const admin = await mysql.createConnection({ uri: LIVE! });
      await admin.query(`DROP DATABASE IF EXISTS \`${FIXTURE_DB}\``);
      await admin.end();
    });

    describe('introspection', () => {
      test('a generated 64-bit key is returned exactly, without Number rounding', async () => {
        const result = await adapter.insert({ table: id('large_identity'), values: {} });
        assert.equal(result.key.id, '9007199254740993');
        assert.equal(result.row?.id, '9007199254740993');
      });
      test('generated composite keys are complete and unrelated auto-increments never masquerade as a key', async () => {
        const composite = findTable(schema, id('composite_identity'))!;
        assert.equal(autoKey(composite), null);
        assert.equal(isRequired(composite.columns[0], null), false);
        const result = await adapter.insert({ table: composite.id, values: { tenant: 8 } });
        assert.ok(result.key.id);
        assert.equal(result.key.tenant, 8);
        assert.equal(result.row?.tenant, 8);
        const opaque = await adapter.insert({ table: id('opaque_key'), values: {} });
        assert.deepEqual(opaque.key, {});
        assert.equal(opaque.row, undefined);
      });
      test('AUTO_INCREMENT is catalog metadata, not a property of every integer key', async () => {
        const manual = findTable(schema, id('customer'))!;
        const generated = findTable(schema, id('assigned_defaults'))!;
        assert.equal(autoKey(manual), null);
        assert.equal(isRequired(manual.columns[0], null), true);
        assert.equal(autoKey(generated), 'id');
        assert.equal(generated.columns[0].identity, 'by-default');
        const result = await adapter.insert({ table: generated.id, values: {} });
        assert.ok(result.key.id);
        assert.equal(result.row?.status, 'new');
        assert.ok(result.row?.created_at);
        assert.deepEqual(result.applied, {});
      });
      test('finds every table and the view, qualified by database', () => {
        assert.deepEqual(
          schema.tables.map((t) => t.id).sort(),
          [
            id('country'),
            id('customer'),
            id('customer_totals'),
            id('employee'),
            id('eventlog'),
            id('invoice'),
            id('invoice_line'),
            id('shipment'),
            id('ticket'),
            id('assigned_defaults'),
            id('composite_identity'),
            id('opaque_key'),
            id('large_identity'),
          ].sort(),
        );
        /* An ENUM column says what it accepts, and saying so is the
           difference between a filter that returns rows and one that returns
           nothing because 'OPEN' was capitalised. */
        const ticket = findTable(schema, id('ticket'))!;
        assert.deepEqual(ticket.columns.find((c) => c.name === 'state')!.allowed, ['open', 'held', 'closed']);
        assert.equal(ticket.columns.find((c) => c.name === 'note')!.allowed, undefined);
        /* The database *is* the schema in MySQL, so it is what qualifies a
           table — the same shape Postgres produces for `public.customer`. */
        const customer = findTable(schema, id('customer'))!;
        assert.equal(customer.schema, FIXTURE_DB);
        assert.equal(customer.name, 'customer');
        assert.equal(customer.isView, false);
        assert.equal(findTable(schema, id('customer_totals'))?.isView, true);
      });

      test('reads types, nullability, comments and keys', () => {
        const customer = findTable(schema, id('customer'))!;
        assert.equal(customer.comment, 'People who owe us money');
        const email = customer.columns.find((c) => c.name === 'email')!;
        assert.equal(email.nullable, true);
        assert.equal(email.primaryKey, false);
        assert.equal(email.type, 'varchar(120)');
        const key = customer.columns.find((c) => c.name === 'id')!;
        assert.equal(key.primaryKey, true);
        assert.equal(key.type, 'int');
        // The declared type verbatim: MySQL has no boolean, and calling this
        // one would promise something the column does not do.
        assert.equal(customer.columns.find((c) => c.name === 'active')!.type, 'tinyint(1)');
        assert.equal(customer.columns.find((c) => c.name === 'credit_limit')!.type, 'decimal(10,2)');
        assert.equal(customer.columns.find((c) => c.name === 'updated_at')!.type, 'datetime');
        assert.equal(findTable(schema, id('invoice'))!.columns.find((c) => c.name === 'invoice_date')!.type, 'date');
      });

      test('a view carries no comment of its own', () => {
        // MySQL writes the literal word VIEW into TABLE_COMMENT for a view,
        // which is a fact about the kind, not a caption someone wrote.
        assert.equal(findTable(schema, id('customer_totals'))!.comment, undefined);
      });

      test('collapses a composite primary key in declaration order', () => {
        assert.deepEqual(primaryKey(findTable(schema, id('invoice_line'))!), ['invoice_id', 'line_no']);
      });

      test('collapses a composite foreign key into one edge', () => {
        // KEY_COLUMN_USAGE reports one row per column; two rows for one key
        // must not become two keys, or the reverse-reference panel doubles.
        const edges = referencesTo(schema, id('invoice_line'));
        assert.equal(edges.length, 1);
        assert.deepEqual(edges[0].from.columns, ['invoice_id', 'line_no']);
        assert.deepEqual(edges[0].to.columns, ['invoice_id', 'line_no']);
        assert.equal(edges[0].from.table, id('shipment'));
      });

      test('a column knows what it points at', () => {
        const customer = findTable(schema, id('customer'))!;
        assert.deepEqual(customer.columns.find((c) => c.name === 'country_code')!.references, {
          table: id('country'),
          column: 'code',
        });
      });

      test('handles a self-referencing key without confusing the directions', () => {
        const out = referencesFrom(schema, id('employee'));
        const back = referencesTo(schema, id('employee'));
        assert.ok(out.some((fk) => fk.to.table === id('employee')));
        assert.ok(back.some((fk) => fk.from.table === id('employee')));
      });

      test('reports only the leading column of each index, key included', () => {
        const indexed = new Set(findTable(schema, id('customer'))!.indexed);
        assert.ok(indexed.has('id'), 'the primary key is an index and must be reported');
        assert.ok(indexed.has('active'), 'leads customer_active_name');
        /* `name` is the second column of that index, and an ORDER BY cannot be
           satisfied by it — reporting it would invite a full sort of the table
           on a default nobody asked for. */
        assert.ok(!indexed.has('name'));
        assert.ok(!indexed.has('email'));
        // A foreign key gets an index in InnoDB whether you ask or not.
        assert.ok(new Set(findTable(schema, id('invoice'))!.indexed).has('customer_id'));
      });

      test('a view reports no indexes, which is not the same as not looking', () => {
        // Empty means "looked, found none"; absent would mean the adapter did
        // not look, and `defaultOrder` reads the difference.
        assert.deepEqual(findTable(schema, id('customer_totals'))!.indexed, []);
        assert.notEqual(findTable(schema, id('customer_totals'))!.indexed, undefined);
      });

      test('the default order leans on an index rather than a full sort', () => {
        // `updated_at` is not indexed here, so the key wins — the whole point
        // of gating that preference on `indexed`.
        assert.deepEqual(defaultOrder(findTable(schema, id('customer'))!), [{ column: 'id', direction: 'desc' }]);
        assert.deepEqual(defaultOrder(findTable(schema, id('invoice_line'))!), [
          { column: 'invoice_id', direction: 'asc' },
          { column: 'line_no', direction: 'asc' },
        ]);
      });

      test('approxRows is a number for a table and absent for a view', () => {
        // InnoDB's estimate is sampled and can be badly wrong, so what is
        // asserted is its shape, not its value.
        assert.equal(typeof findTable(schema, id('customer'))!.approxRows, 'number');
        assert.equal(findTable(schema, id('customer_totals'))!.approxRows, undefined);
      });

      test('a keyless table is still browsable', () => {
        assert.deepEqual(primaryKey(findTable(schema, id('eventlog'))!), []);
      });
    });

    describe('reading', () => {
      test('a search escapes its wildcards, and the ESCAPE clause parses here', async () => {
        /* MySQL treats a backslash as an escape inside string literals, which
           is why the escape character is `#` — this is the test that would
           have caught choosing the conventional one. */
        const like = async (value: string) =>
          (
            await adapter.query({
              table: id('customer'),
              columns: ['id'],
              filter: { groups: [[{ column: 'name', op: 'contains', value }]] },
              limit: 10,
              offset: 0,
            })
          ).rows.map((r) => r.id);

        assert.deepEqual(await like('harbour'), [2], 'and case is folded, as on the other engines');
        assert.deepEqual(await like('%'), [], 'a percent sign is a character to look for');
      });

      test('rows come back with their headers, filtered and ordered', async () => {
        const result = await adapter.query({
          table: id('customer'),
          filter: { groups: [[{ column: 'active', op: '=', value: 1 }]] },
          orderBy: [{ column: 'name', direction: 'asc' }],
          limit: 10,
          offset: 0,
        });
        assert.equal(result.rows.length, 4);
        assert.equal(result.rows[0].name, 'Dry Creek Vineyards');
        assert.match(result.sql.text, /FROM `tablewalk_mysql_fixture`\.`customer`/);
        assert.match(result.sql.text, /ORDER BY `name` ASC/);
      });

      test('an unqualified name means the database the connection is in', async () => {
        const result = await adapter.query({ table: 'customer', limit: 2, offset: 0 });
        assert.equal(result.rows.length, 2);
        assert.match(result.sql.text, /`tablewalk_mysql_fixture`\.`customer`/);
      });

      test('an empty result still renders its headers', async () => {
        const result = await adapter.query({
          table: id('customer'),
          filter: { groups: [[{ column: 'id', op: '=', value: 4242 }]] },
          columns: ['id', 'name'],
          limit: 5,
          offset: 0,
        });
        assert.equal(result.rows.length, 0);
        assert.deepEqual(result.columns, ['id', 'name']);
      });

      test('a DATETIME is the text the server stores, not a shifted instant', async () => {
        const result = await adapter.query({
          table: id('customer'),
          filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
          limit: 1,
          offset: 0,
        });
        // A JS Date here would be read in the local zone and written back as
        // UTC, showing 08:00 or 10:00 for a column with no zone at all.
        assert.equal(result.rows[0].updated_at, '2026-08-01 09:00:00');
        assert.equal(result.rows[0].credit_limit, '5000.00'); // exact, not float
      });

      test('a date filter selects the right rows against real data', async () => {
        const result = await adapter.query({
          table: id('invoice'),
          filter: {
            groups: [
              [
                { column: 'invoice_date', op: '>=', value: '2025-01-01' },
                { column: 'invoice_date', op: '<', value: '2026-01-01' },
              ],
            ],
          },
          limit: 50,
          offset: 0,
        });
        assert.deepEqual(result.rows.map((r) => r.id).sort(), [1001, 1002, 1003]);
      });

      test('an injection attempt is data, not syntax', async () => {
        const result = await adapter.query({
          table: id('customer'),
          filter: { groups: [[{ column: 'name', op: '=', value: "'; DROP TABLE customer; --" }]] },
          limit: 50,
          offset: 0,
        });
        assert.equal(result.rows.length, 0);
        // The table is still there, which is the actual assertion.
        assert.equal(await adapter.count(id('customer')), 5);
      });

      test('an unknown table is rejected before it reaches a statement', async () => {
        await assert.rejects(
          () => adapter.query({ table: 'customer`; DROP TABLE country; --', limit: 1, offset: 0 }),
          /No table or view called/,
        );
        // Nor can a name reach a database this session never opened.
        await assert.rejects(() => adapter.query({ table: 'mysql.user', limit: 1, offset: 0 }), /No table or view called/);
      });

      test('every read is bounded, including one that forgot to ask', async () => {
        const asked = await adapter.query({ table: id('invoice_line'), limit: 999_999_999, offset: 0 });
        assert.match(asked.sql.text, /LIMIT \? OFFSET \?$/);
        assert.equal(asked.sql.params[0], String(MAX_LIMIT));

        const forgot = await adapter.query({
          table: id('invoice_line'),
          limit: undefined as never,
          offset: 0,
        });
        assert.match(forgot.sql.text, /LIMIT \? OFFSET \?$/);
        assert.equal(forgot.sql.params[0], String(DEFAULT_LIMIT));

        const nonsense = await adapter.query({
          table: id('invoice_line'),
          limit: 'abc' as never,
          offset: 'x' as never,
        });
        assert.equal(nonsense.sql.params[0], String(DEFAULT_LIMIT));
        assert.equal(nonsense.sql.params[1], '0');
        assert.ok(nonsense.rows.length > 0);
      });

      test('the row count really limits, bound as digits rather than written in', async () => {
        /* mysql2 sends every JS number as a DOUBLE, which MySQL refuses for a
           LIMIT — so this fails outright rather than over-fetching if the
           string binding is dropped. */
        const page = await adapter.query({
          table: id('invoice'),
          orderBy: [{ column: 'id', direction: 'asc' }],
          limit: 2,
          offset: 1,
        });
        assert.deepEqual(
          page.rows.map((r) => r.id),
          [1002, 1003],
        );
        assert.deepEqual(page.sql.params.slice(-2), ['2', '1']);
      });

      test('counting honours the filter', async () => {
        assert.equal(await adapter.count(id('customer')), 5);
        assert.equal(await adapter.count(id('customer'), { groups: [[{ column: 'active', op: '=', value: 1 }]] }), 4);
        assert.equal(await adapter.count(id('customer'), { groups: [[{ column: 'email', op: 'isNull' }]] }), 1);
      });

      test('a view queries like a table', async () => {
        const result = await adapter.query({ table: id('customer_totals'), limit: 10, offset: 0 });
        assert.equal(result.rows.length, 5);
        const dry = result.rows.find((r) => r.name === 'Dry Creek Vineyards')!;
        assert.equal(Number(dry.invoices), 2);
      });
    });

    describe('running a view', () => {
      const view: ViewDef = {
        id: 'v1',
        name: 'invoices with their customer',
        base: `${FIXTURE_DB}.invoice`,
        columns: [{ path: 'id' }, { path: 'total' }, { path: 'customer_id.name', alias: 'customer' }],
        filter: { groups: [[{ path: 'customer_id.country_code', op: '=', value: 'AU' }]] },
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 10,
      };

      test('a joined view runs and resolves its columns', async () => {
        const result = await adapter.runView(view);
        assert.deepEqual(result.columns, ['id', 'total', 'customer']);
        assert.deepEqual(
          result.rows.map((r) => r.customer),
          ['Dry Creek Vineyards', 'Dry Creek Vineyards', 'Harbour Freight Co'],
        );
        // The join is real: the predicate addresses the customer's country.
        assert.match(result.sql.text, /LEFT JOIN `tablewalk_mysql_fixture`\.`customer`/);
        assert.ok(result.sql.params.includes('AU'));
      });

      test('a view is bounded too, with its row counts bound as digits', async () => {
        const result = await adapter.runView(view, 1);
        assert.match(result.sql.text, /LIMIT \? OFFSET \?/);
        assert.deepEqual(result.sql.params.slice(-2), ['10', '1']);
        assert.equal(result.rows.length, 2);
      });

      test('counting a view ignores the page', async () => {
        assert.equal(await adapter.countView(view), 3);
      });
    });

    describe('grouping', () => {
      test('counts by a column, and by a period, in MySQL\u2019s own spelling', async () => {
        const byCountry = await adapter.runBreakdown!({
          base: id('customer'),
          by: [{ path: 'country_code.name', alias: 'country' }],
          measures: [{ fn: 'count' }, { fn: 'sum', path: 'credit_limit', alias: 'credit' }],
          orderBy: [{ name: 'count', direction: 'desc' }],
        });
        assert.deepEqual(byCountry.columns, ['country', 'count', 'credit']);
        assert.equal(
          byCountry.rows.reduce((n, r) => n + Number(r.count), 0),
          await adapter.count(id('customer')),
          'every customer is in exactly one group',
        );

        /* `DATE_FORMAT` here, `to_char` on Postgres, `strftime` on SQLite —
           and the same label out of all three, which is the whole reason the
           bucket lives in the style rather than in the compiler. */
        const byMonth = await adapter.runBreakdown!({
          base: id('customer'),
          by: [{ path: 'updated_at', bucket: 'month' }],
          measures: [{ fn: 'count' }],
          orderBy: [{ name: 'month(updated_at)', direction: 'asc' }],
        });
        assert.match(byMonth.sql.text, /DATE_FORMAT\(/);
        const months = byMonth.rows.map((r) => r['month(updated_at)']);
        assert.ok(
          months.every((m) => /^\d{4}-\d{2}$/.test(String(m))),
          months.join(', '),
        );

        /* MySQL has no quarter format specifier, so this one is built rather
           than formatted — and has to land on the same `2026-Q3`. */
        const quarters = await adapter.runBreakdown!({
          base: id('customer'),
          by: [{ path: 'updated_at', bucket: 'quarter', alias: 'q' }],
          measures: [{ fn: 'count' }],
        });
        assert.ok((quarters.rows.map((r) => r.q) as string[]).every((q) => /^\d{4}-Q[1-4]$/.test(q)));
      });

      test('the row count is bound as a number, not as a string', async () => {
        /* mysql2 binds a number as a string over the prepared protocol, and
           `LIMIT '20'` is a syntax error — the same trap a view's LIMIT
           already fell into once. */
        const result = await adapter.runBreakdown!({
          base: id('customer'),
          by: [{ path: 'country_code' }],
          measures: [{ fn: 'count' }],
          limit: 2,
        });
        assert.ok(result.rows.length <= 2);
        assert.equal(
          (await adapter.countBreakdown!({
            base: id('customer'),
            by: [{ path: 'country_code' }],
            measures: [{ fn: 'count' }],
          })) >= result.rows.length,
          true,
        );
      });
    });

    describe('the read-only connection', () => {
      /* The claim is "the browsing connection cannot write". It is worth
         reaching past the query API to check, because everything else in the
         adapter only proves that the statements it builds are reads. */
      const browsing = () => (adapter as unknown as { client: { query(sql: string): Promise<unknown> } }).client;

      test('refuses a write reached past the query API', async () => {
        await assert.rejects(() => browsing().query(`DELETE FROM \`${FIXTURE_DB}\`.\`customer\``), /read only|read-only/i);
        await assert.rejects(() => browsing().query(`UPDATE \`${FIXTURE_DB}\`.\`customer\` SET name = 'x'`), /read only|read-only/i);
        assert.equal(await adapter.count(id('customer')), 5);
      });

      test('refuses DDL as well as DML', async () => {
        await assert.rejects(() => browsing().query(`DROP TABLE \`${FIXTURE_DB}\`.\`shipment\``), /read only|read-only/i);
        await assert.rejects(() => browsing().query(`CREATE TABLE \`${FIXTURE_DB}\`.\`sneaky\` (id INT)`), /read only|read-only/i);
        assert.ok(findTable(await adapter.introspect(), id('shipment')));
      });

      test('a stacked statement is a syntax error, not a second statement', async () => {
        await assert.rejects(
          () => browsing().query(`SELECT 1; DROP TABLE \`${FIXTURE_DB}\`.\`shipment\``),
          /You have an error in your SQL syntax|read only|read-only/i,
        );
      });
    });

    describe('explaining and profiling', () => {
      test('explain answers the plan without executing', async () => {
        const explained = await adapter.explainSql!({
          text: `SELECT * FROM \`${FIXTURE_DB}\`.\`customer\` WHERE id = ?`,
          params: [1],
        });
        assert.ok(explained.plan.length >= 1, 'the plan has at least one line');
        assert.match(explained.plan.join('\n'), /customer/, 'the plan names the table');
      });

      test('profile scans small tables and samples big ones, saying which', async () => {
        const scanned = await adapter.profile!(id('customer'));
        assert.equal(scanned.source, 'scan');
        assert.ok(scanned.rows! >= 1);
        const email = scanned.columns.find((c) => c.column === 'email');
        assert.ok(email, 'every column is profiled');

        const sampled = await adapter.profile!(id('customer'), { scanAtMost: 1, sampleSize: 2 });
        assert.equal(sampled.source, 'sample');
        assert.ok(typeof sampled.sampled === 'number');
      });
    });

    describe('writing', () => {
      /* The write path is the one place a bug destroys data rather than merely
         showing the wrong thing, so each guard is asserted independently
         rather than trusting that the one in front of it held. */

      const read = async (table: string, key: Record<string, string | number>) => {
        const result = await adapter.query({
          table,
          filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
          limit: 1,
          offset: 0,
        });
        return result.rows[0];
      };

      test('conditional updates check scalar originals and NULL without case-insensitive matches', async () => {
        const key = { id: 4 };
        const table = id('customer');
        const original = await read(table, key);
        try {
          await adapter.update({ table, key, values: { name: 'Guarded', email: null } });
          const result = await adapter.update({
            table,
            key,
            values: { name: 'Guarded next', email: 'next@example.test' },
            expected: { name: 'Guarded', email: null },
          });
          assert.equal(result.affected, 1);
          await assert.rejects(
            adapter.update({
              table,
              key,
              values: { name: 'Overwrite', email: null },
              expected: { name: 'guarded next', email: 'next@example.test' },
            }),
            WriteConflict,
          );
          assert.equal((await read(table, key)).name, 'Guarded next');
          assert.equal((await read(table, key)).email, 'next@example.test');
          assert.equal(
            (await adapter.update({ table, key, values: { name: 'Guarded next' }, expected: { name: 'Guarded next' } })).affected,
            1,
          );
        } finally {
          await adapter.update({ table, key, values: { name: original.name as string, email: original.email as string | null } });
        }
      });

      test('updates exactly one row and reports it', async () => {
        assert.equal((await read(id('customer'), { id: 1 })).credit_limit, '5000.00');

        const result = await adapter.update({
          table: id('customer'),
          key: { id: 1 },
          values: { credit_limit: 7500 },
        });
        assert.equal(result.affected, 1);
        // The new value is a bound parameter, not text in the statement.
        assert.match(result.sql.text, /SET `credit_limit` = \?/);
        assert.deepEqual(result.sql.params, [7500, 1]);

        assert.equal((await read(id('customer'), { id: 1 })).credit_limit, '7500.00');
        // And nothing else moved.
        assert.equal(await adapter.count(id('customer'), { groups: [[{ column: 'credit_limit', op: '=', value: 7500 }]] }), 1);
      });

      test('several columns move in one statement', async () => {
        const result = await adapter.update({
          table: id('customer'),
          key: { id: 3 },
          values: { name: 'Pennine Tools Ltd', credit_limit: '4500.25', active: 1 },
        });
        assert.equal(result.affected, 1);
        assert.equal((result.sql.text.match(/=\s*\?/g) ?? []).length, 4); // 3 SET + 1 WHERE
        // Coerced against the declared type: an <input> always yields a string.
        assert.equal(result.applied.credit_limit, 4500.25);
        assert.equal(typeof result.applied.credit_limit, 'number');
        assert.equal((await read(id('customer'), { id: 3 })).name, 'Pennine Tools Ltd');
      });

      test('writes NULL as NULL, not as an empty string', async () => {
        await adapter.update({ table: id('customer'), key: { id: 4 }, values: { email: null } });
        assert.equal(await adapter.count(id('customer'), { groups: [[{ column: 'email', op: 'isNull' }]] }), 2);
      });

      test('a write that changes nothing still reports the row it matched', async () => {
        /* MySQL counts rows whose bytes changed unless the client asks for
           matched rows instead. Reporting 0 here would tell the user their
           save failed when it did exactly what they asked. */
        const first = await adapter.update({
          table: id('customer'),
          key: { id: 2 },
          values: { name: 'Harbour Freight Co' },
        });
        assert.equal(first.affected, 1);
      });

      test('refuses a key that is not the whole primary key', async () => {
        await assert.rejects(
          () => adapter.update({ table: id('invoice_line'), key: { invoice_id: 1001 }, values: { quantity: 99 } }),
          /needs exactly its primary key \(invoice_id, line_no\)/,
        );
      });

      test('refuses a non-key column smuggled in as the key', async () => {
        /* The dangerous case: `active = 1` matches four rows. Without the
           key-shape check this would have been an UPDATE across all of them. */
        await assert.rejects(
          () => adapter.update({ table: id('customer'), key: { active: 1 } as never, values: { credit_limit: 0 } }),
          /needs exactly its primary key/,
        );
        assert.equal(await adapter.count(id('customer'), { groups: [[{ column: 'credit_limit', op: '=', value: 0 }]] }), 0);
      });

      test('refuses to edit a primary key in place', async () => {
        await assert.rejects(
          () => adapter.update({ table: id('customer'), key: { id: 1 }, values: { id: 999 } }),
          /part of the primary key/,
        );
      });

      test('refuses a view and a table with no primary key', async () => {
        await assert.rejects(() => adapter.update({ table: id('customer_totals'), key: { id: 1 }, values: { name: 'x' } }), /is a view/);
        await assert.rejects(() => adapter.update({ table: id('eventlog'), key: { id: 1 }, values: { note: 'x' } }), /no primary key/);
      });

      test('refuses an unknown column, leaving the good one unapplied', async () => {
        const before = await read(id('customer'), { id: 5 });
        await assert.rejects(
          () =>
            adapter.update({
              table: id('customer'),
              key: { id: 5 },
              values: { name: 'Changed', nonesuch: 'x' },
            }),
          /no column called "nonesuch"/,
        );
        assert.equal((await read(id('customer'), { id: 5 })).name, before.name);
      });

      test('refuses a key that matches no row', async () => {
        await assert.rejects(
          () => adapter.update({ table: id('customer'), key: { id: 4242 }, values: { name: 'x' } }),
          /matches 0 rows, not 1/,
        );
      });

      test('refuses emptying a NOT NULL column, and an empty update', async () => {
        await assert.rejects(
          () => adapter.update({ table: id('customer'), key: { id: 1 }, values: { name: null } }),
          /NOT NULL and cannot be emptied/,
        );
        await assert.rejects(() => adapter.update({ table: id('customer'), key: { id: 1 }, values: {} }), /Nothing to update/);
      });

      test('a composite key updates only the row it names', async () => {
        await adapter.update({
          table: id('invoice_line'),
          key: { invoice_id: 1001, line_no: 1 },
          values: { quantity: 42 },
        });
        const rows = await adapter.query({
          table: id('invoice_line'),
          filter: { groups: [[{ column: 'invoice_id', op: '=', value: 1001 }]] },
          orderBy: [{ column: 'line_no', direction: 'asc' }],
          limit: 10,
          offset: 0,
        });
        assert.deepEqual(
          rows.rows.map((r) => r.quantity),
          [42, 2],
        );
      });

      test('`like` hands the wildcards to whoever typed them', async () => {
        /* MySQL's LIKE is case-insensitive by collation rather than by
           operator — there is no ILIKE to reach for — so the same query has
           to behave the same way here for a reason entirely unlike the one
           that makes it work on Postgres. Which is exactly why proving it on
           SQLite proved nothing. */
        const matching = async (pattern: string) =>
          (
            await adapter.query({
              table: id('customer'),
              columns: ['id'],
              filter: { groups: [[{ column: 'name', op: 'like', value: pattern }]] },
              limit: 10,
              offset: 0,
            })
          ).rows.map((r) => r.id);

        const prefix = await matching('Dry%');
        assert.equal(prefix.length, 1, 'a prefix matches one row');
        assert.deepEqual(await matching('dry%'), prefix, 'and case does not change the answer');
        /* `_` is one character, and is not escaped away. */
        assert.deepEqual(await matching('Dry_Creek%'), prefix);
        assert.deepEqual(await matching('Dry__Creek%'), [], 'two underscores are two characters');
      });

      describe('change_impact, against a real MySQL', () => {
        test('names what points at a table, with the rule and the numbers', async () => {
          const impact = await changeImpact(adapter, schema, id('country'), 'code');
          const customers = impact.referencedBy.find((d) => d.table === id('customer'));
          assert.ok(customers, 'customer points at country');
          assert.deepEqual(customers.columns, ['country_code']);
          /* Qualified by database on MySQL, which is what a schema is here. */
          assert.ok(customers.table.startsWith(`${FIXTURE_DB}.`), customers.table);
          assert.equal(typeof customers.rows, 'number');
        });

        test('counts the nulls that decide whether NOT NULL can land', async () => {
          const impact = await changeImpact(adapter, schema, id('customer'), 'email');
          assert.equal(impact.columnFacts?.nullable, true);
          assert.equal(typeof impact.columnFacts?.nulls, 'number');
          /* Whichever way it comes out, the sentence has to match the number
             rather than be written from a guess. */
          const nulls = impact.columnFacts!.nulls!;
          const said = impact.notes.find((n) => /NOT NULL/.test(n));
          assert.ok(said, impact.notes.join('\n'));
          if (nulls > 0) assert.match(said, new RegExp(`^${nulls} of`));
          else assert.match(said, /^No row/);
        });
      });

      describe('the write journal, against a real MySQL', () => {
        /* MySQL has no RETURNING: an insert is an `insertId` plus a read-back,
           and an update applies through a second connection. The journal
           reverses all of that by calling the same three methods, so this is
           the engine where "undo" is least like the one it was written on. */
        const CONN = 'my-journal';
        const read = async (name: string, key: Record<string, string | number>) => {
          const result = await adapter.query({
            table: id(name),
            filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
            limit: 1,
            offset: 0,
          });
          return result.rows[0] as Record<string, unknown>;
        };

        before(() => clearJournal(CONN));
        after(() => clearJournal(CONN));

        test('an update is put back, and the row is the witness', async () => {
          const was = await read('customer', { id: 2 });
          const result = await adapter.update({
            table: id('customer'),
            key: { id: 2 },
            values: { email: 'wrong@example.com' },
          });
          const steps = [
            {
              table: id('customer'),
              key: { id: 2 },
              before: { email: was.email ?? null },
              after: { ...result.applied },
            },
          ];
          recordWrite(CONN, { kind: 'update', summary: summarise('update', steps), revertible: true, steps });

          assert.equal((await read('customer', { id: 2 })).email, 'wrong@example.com');
          const undone = await revert(adapter, CONN, lastRevertible(CONN)!);
          assert.equal(undone.reverted, true, JSON.stringify(undone.errors));
          assert.equal((await read('customer', { id: 2 })).email ?? null, was.email ?? null);
        });

        test('an insert is undone by removing what it added', async () => {
          const before2 = await adapter.count(id('country'));
          const inserted = await adapter.insert({ table: id('country'), values: { code: 'ZW', name: 'Zedwood' } });
          const steps = [{ table: id('country'), key: inserted.key, after: { ...inserted.row } }];
          recordWrite(CONN, { kind: 'insert', summary: summarise('insert', steps), revertible: true, steps });

          assert.equal(await adapter.count(id('country')), before2 + 1);
          const undone = await revert(adapter, CONN, lastRevertible(CONN)!);
          assert.equal(undone.reverted, true, JSON.stringify(undone.errors));
          assert.equal(await adapter.count(id('country')), before2);
        });

        test('a delete is undone by putting the whole row back', async () => {
          await adapter.insert({ table: id('country'), values: { code: 'ZX', name: 'Zedex' } });
          const row = await read('country', { code: 'ZX' });
          await adapter.remove({ table: id('country'), key: { code: 'ZX' } });
          const steps = [{ table: id('country'), key: { code: 'ZX' }, before: { ...row } }];
          recordWrite(CONN, { kind: 'delete', summary: summarise('delete', steps), revertible: true, steps });

          const undone = await revert(adapter, CONN, lastRevertible(CONN)!);
          assert.equal(undone.reverted, true, JSON.stringify(undone.errors));
          assert.equal((await read('country', { code: 'ZX' })).name, 'Zedex', 'values and all');
          await adapter.remove({ table: id('country'), key: { code: 'ZX' } });
        });

        test('a row that moved on is refused, and left alone', async () => {
          const result = await adapter.update({
            table: id('customer'),
            key: { id: 3 },
            values: { email: 'ours@example.com' },
          });
          const steps = [
            {
              table: id('customer'),
              key: { id: 3 },
              before: { email: 'before@example.com' },
              after: { ...result.applied },
            },
          ];
          recordWrite(CONN, { kind: 'update', summary: summarise('update', steps), revertible: true, steps });

          await adapter.update({ table: id('customer'), key: { id: 3 }, values: { email: 'theirs@example.com' } });

          const refused = await revert(adapter, CONN, lastRevertible(CONN)!);
          assert.equal(refused.reverted, false);
          assert.match(refused.errors![0], /has changed since/);
          assert.equal((await read('customer', { id: 3 })).email, 'theirs@example.com');
        });
      });

      test('the browsing connection stays read-only after a write', async () => {
        // The write went through a second connection; the one every read uses
        // must still refuse, or "read-only browsing" was never true.
        await assert.rejects(
          () =>
            (adapter as unknown as { client: { query(sql: string): Promise<unknown> } }).client.query(
              `DELETE FROM \`${FIXTURE_DB}\`.\`customer\``,
            ),
          /read only|read-only/i,
        );
      });
    });
  },
);
