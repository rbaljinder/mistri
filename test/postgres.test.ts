/**
 * The Postgres adapter, against a real server.
 *
 * Five hundred and sixty lines with no test that constructed it. The suite
 * ran Postgres statements through `/api/sql` and through the shared compiler,
 * which proves the *language* works on Postgres and says nothing about the
 * things only this file does: reading a catalog that has schemas in it,
 * collapsing a composite foreign key into one edge, estimating a row count
 * from `reltuples`, and the read-only transaction that makes raw SQL safe.
 *
 * The live half is opt-in through `TABLEWALK_TEST_PG` — requiring a server
 * to test a SQLite feature would make
 * the suite something people stop running. CI sets it, and
 * `TABLEWALK_REQUIRE_LIVE=1` there turns a missing server into a failure
 * rather than a silent skip.
 *
 *   TABLEWALK_TEST_PG=postgres://postgres:pw@127.0.0.1:5432/tablewalk npm test
 *
 * Everything is built into a schema of its own and dropped afterwards, so
 * nothing here belongs to anyone else — but this file does write, which is
 * why it will not touch a database it was not explicitly pointed at.
 */
import { randomUUID } from 'node:crypto';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { postgresRowEstimate } from '../packages/engine/src/adapters/postgresCatalogRows.js';
import type { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { WriteConflict } from '../packages/engine/src/adapters/adapter.js';
import { connect } from '../packages/engine/src/adapters/connect.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';
import { findValue } from '../packages/tablewalk/src/server/mcp.js';
import { deleteGraph, insertGraph } from '../packages/tablewalk/src/server/graph.js';
import { changeImpact } from '../packages/tablewalk/src/server/changeimpact.js';
import { autoKey, isRequired } from '../packages/engine/src/shared/form.js';
import { clearJournal, lastRevertible, recordWrite, revert, summarise } from '../packages/engine/src/server/journal.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

test('Postgres catalog estimates preserve unknown values and a known zero', () => {
  for (const value of [-1, '-1', null, undefined, '', ' ', NaN, Infinity, 'invalid', false]) {
    assert.equal(postgresRowEstimate(value), undefined, `Unknown estimate: ${String(value)}`);
  }
  assert.equal(postgresRowEstimate(0), 0);
  assert.equal(postgresRowEstimate('0'), 0);
  assert.equal(postgresRowEstimate(48), 48);
  assert.equal(postgresRowEstimate('48.4'), 48);
  assert.equal(postgresRowEstimate(48.8), 49);
});

/** Its own schema, named for this run, so nothing this file drops belongs to
 * anyone else — including another run of this file on the same server. */
const FIXTURE = `tablewalk_pg_fixture_${randomUUID().replaceAll('-', '')}`;

/* Statements the fixture is built from. Read this to read the tests. */
const SETUP = [
  `DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`,
  `CREATE SCHEMA ${FIXTURE}`,
  `CREATE TABLE ${FIXTURE}.country (
     code char(2) PRIMARY KEY,
     name text NOT NULL
   )`,
  `COMMENT ON TABLE ${FIXTURE}.country IS 'Places money comes from'`,
  `CREATE TABLE ${FIXTURE}.customer (
     id integer PRIMARY KEY,
     name text NOT NULL,
     email text,
     active boolean NOT NULL DEFAULT true,
     credit_limit numeric(10,2),
     country_code char(2) REFERENCES ${FIXTURE}.country (code) ON DELETE SET NULL,
     updated_at timestamp
   )`,
  `COMMENT ON COLUMN ${FIXTURE}.customer.credit_limit IS 'In their own currency'`,
  /* Composite, so "one edge per constraint" has something to be wrong about. */
  `CREATE TABLE ${FIXTURE}.invoice_line (
     invoice_id integer NOT NULL,
     line_no integer NOT NULL,
     product text,
     quantity integer NOT NULL,
     PRIMARY KEY (invoice_id, line_no)
   )`,
  `CREATE TABLE ${FIXTURE}.shipment (
     id integer PRIMARY KEY,
     invoice_id integer,
     line_no integer,
     CONSTRAINT shipment_line FOREIGN KEY (invoice_id, line_no)
       REFERENCES ${FIXTURE}.invoice_line (invoice_id, line_no) ON DELETE CASCADE
   )`,
  /* A self-reference: the direction of a key that points at its own table is
     the thing a naive join gets backwards. */
  `CREATE TABLE ${FIXTURE}.employee (
     id integer PRIMARY KEY,
     first_name text NOT NULL,
     manager_id integer REFERENCES ${FIXTURE}.employee (id) ON DELETE RESTRICT
   )`,
  /* No primary key at all, which an update has to refuse rather than guess at. */
  `CREATE TABLE ${FIXTURE}.eventlog (id integer NOT NULL, note text)`,
  /* Both ways Postgres pins a column's vocabulary, which it reports through
     two unrelated catalogs: a real enum type, and the far commoner text
     column with a CHECK. The second is stored rewritten — `= ANY (ARRAY[...])`
     — so reading it back is not the same problem as reading it. */
  `CREATE TYPE ${FIXTURE}.ticket_state AS ENUM ('open','held','closed')`,
  `CREATE TABLE ${FIXTURE}.ticket (
     id integer PRIMARY KEY,
     state ${FIXTURE}.ticket_state NOT NULL DEFAULT 'open',
     priority text CHECK (priority IN ('low','high')),
     note text,
     size integer CHECK (size > 0)
   )`,
  /* The default shape of a modern Postgres schema, and the one a text sweep
     used to lose whole: a uuid primary key beside an array column. Postgres
     has no LIKE operator for either, and both read as text to a naive type
     check. */
  `CREATE TABLE ${FIXTURE}.account (
     id uuid PRIMARY KEY,
     name text NOT NULL,
     tags text[]
   )`,
  `INSERT INTO ${FIXTURE}.account VALUES
     ('3f8c1e42-9b21-4c7a-8f0e-2d5a6b7c8d90','Nakamura Holdings',ARRAY['vip']),
     ('7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d','Pennine Tools Ltd',NULL)`,
  /* A key the database assigns, which is how most rows are actually created
     and the one case a re-read by key cannot cover. ALWAYS rather than BY
     DEFAULT so "the engine's own refusal" has something to refuse. */
  `CREATE TABLE ${FIXTURE}.note (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     body text NOT NULL,
     tag text DEFAULT 'plain'
   )`,
  `CREATE TABLE ${FIXTURE}.assigned_defaults (
     id bigserial PRIMARY KEY,
     sequence bigint GENERATED BY DEFAULT AS IDENTITY,
     token uuid NOT NULL DEFAULT gen_random_uuid(),
     created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE ${FIXTURE}.composite_identity (
     tenant integer NOT NULL,
     id integer GENERATED BY DEFAULT AS IDENTITY,
     PRIMARY KEY (tenant, id)
   )`,
  `CREATE VIEW ${FIXTURE}.customer_totals AS
     SELECT c.id, c.name FROM ${FIXTURE}.customer c`,
  `INSERT INTO ${FIXTURE}.country VALUES ('AU','Australia'), ('NZ','New Zealand'), ('GB','United Kingdom')`,
  `INSERT INTO ${FIXTURE}.customer VALUES
     (1,'Dry Creek Vineyards','orders@drycreek.example',true,5000.00,'AU','2026-08-01 09:00:00'),
     (2,'Harbour Freight Co',NULL,true,12000.00,'AU','2026-08-02 09:00:00'),
     (3,'Pennine Tools','sales@pennine.example',true,4500.00,'GB','2026-07-30 09:00:00'),
     (4,'Kiwi Cellars','hello@kiwicellars.example',true,8250.50,'NZ','2026-07-29 09:00:00'),
     (5,'Dormant Ltd','old@dormant.example',false,100.00,NULL,'2026-01-01 09:00:00')`,
  `INSERT INTO ${FIXTURE}.employee VALUES (1,'Miles',NULL), (2,'Rina',1), (3,'Tom',1)`,
  `INSERT INTO ${FIXTURE}.invoice_line VALUES (1001,1,'Barrel',1), (1001,2,'Cork',2), (1004,3,'Spanner',5)`,
  `INSERT INTO ${FIXTURE}.shipment VALUES (1,1001,1)`,
  `ANALYZE ${FIXTURE}.customer`,
  `ANALYZE ${FIXTURE}.note`,
] as const;

describe('the Postgres adapter, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let adapter: PostgresAdapter;
  let schema: DatabaseSchema;
  const at = (name: string) => `${FIXTURE}.${name}`;
  const table = (name: string) => schema.tables.find((t) => t.id === at(name))!;

  before(async () => {
    /* Built through `pg` directly rather than through the adapter: the
       adapter cannot create a schema, which is the point of it. */
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => any }; Client?: new (c: unknown) => any };
    const Client = (pg.Client ?? pg.default?.Client)!;
    const setup = new Client({ connectionString: LIVE });
    await setup.connect();
    for (const statement of SETUP) await setup.query(statement);
    await setup.end();

    adapter = new PostgresAdapter(LIVE!, 'pg-fixture', [FIXTURE]);
    schema = await adapter.introspect();
  });

  after(async () => {
    await adapter?.close().catch(() => {});
    const specifier = 'pg';
    const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => any }; Client?: new (c: unknown) => any };
    const Client = (pg.Client ?? pg.default?.Client)!;
    const teardown = new Client({ connectionString: LIVE });
    await teardown.connect();
    await teardown.query(`DROP SCHEMA IF EXISTS ${FIXTURE} CASCADE`);
    await teardown.end();
  });

  /* ---------- the catalog ---------- */

  describe('reading the catalog', () => {
    test('an unanalyzed relation has no count; analyzed empty and populated relations retain theirs', () => {
      assert.equal(table('eventlog').approxRows, undefined);
      assert.equal(table('note').approxRows, 0);
      assert.equal(table('customer').approxRows, 5);
    });

    test('finds every table and the view, qualified by schema', () => {
      assert.deepEqual(
        schema.tables.map((t) => t.id).sort(),
        [
          'account',
          'assigned_defaults',
          'composite_identity',
          'country',
          'customer',
          'customer_totals',
          'employee',
          'eventlog',
          'invoice_line',
          'note',
          'shipment',
          'ticket',
        ]
          .map(at)
          .sort(),
      );
    });

    test('reads a column vocabulary from both catalogs it can live in', () => {
      const ticket = schema.tables.find((t) => t.id === at('ticket'))!;
      const column = (name: string) => ticket.columns.find((c) => c.name === name)!;
      assert.deepEqual(column('state').allowed, ['open', 'held', 'closed'], 'the enum type');
      assert.deepEqual(column('priority').allowed, ['low', 'high'], 'the check, as Postgres rewrote it');
      assert.equal(column('note').allowed, undefined, 'nothing constrains it');
      /* A check that is not a vocabulary must report none rather than a
         guess: `size > 0` is a rule about a number, not a list of values. */
      assert.equal(column('size').allowed, undefined);
    });

    test('distinguishes manual keys, identity modes, sequence defaults and composite identities', () => {
      assert.equal(autoKey(table('customer')), null);
      assert.equal(isRequired(table('customer').columns[0], null), true);
      assert.equal(table('note').columns[0].identity, 'always');
      assert.equal(autoKey(table('note')), 'id');
      assert.equal(autoKey(table('assigned_defaults')), 'id');
      assert.equal(table('assigned_defaults').columns[0].identity, undefined, 'serial is a declared default, not an identity');
      assert.equal(table('assigned_defaults').columns[1].identity, 'by-default');
      assert.equal(isRequired(table('assigned_defaults').columns[1], null), false);
      assert.equal(autoKey(table('composite_identity')), null);
      assert.equal(isRequired(table('composite_identity').columns[0], null), true);
      assert.equal(isRequired(table('composite_identity').columns[1], null), false);
    });

    test('only the schemas it was pointed at', () => {
      /* The connection names one schema, and `public` exists in every
         Postgres database — a scoped connection that quietly included it
         would show tables the person browsing did not ask for. */
      assert.ok(schema.tables.every((t) => t.id.startsWith(`${FIXTURE}.`)));
    });

    test('reads types, nullability, comments and keys', () => {
      const customer = table('customer');
      const byName = new Map(customer.columns.map((c) => [c.name, c]));

      assert.equal(byName.get('id')!.primaryKey, true);
      assert.equal(byName.get('id')!.nullable, false);
      assert.equal(byName.get('name')!.nullable, false);
      assert.equal(byName.get('email')!.nullable, true);
      assert.match(byName.get('credit_limit')!.type, /numeric/i);
      assert.equal(byName.get('credit_limit')!.comment, 'In their own currency');
      assert.match(byName.get('active')!.type, /bool/i);
    });

    test('a table comment is read', () => {
      assert.equal(table('country').comment, 'Places money comes from');
    });

    test('a view is marked as one', () => {
      assert.equal(table('customer_totals').isView, true);
      assert.equal(table('customer').isView, false);
    });

    test('collapses a composite primary key in declaration order', () => {
      assert.deepEqual(
        table('invoice_line')
          .columns.filter((c) => c.primaryKey)
          .map((c) => c.name),
        ['invoice_id', 'line_no'],
      );
    });

    test('collapses a composite foreign key into one edge', () => {
      /* Two rows in the catalog, one relationship. Read naively it becomes
         two half-edges, each comparing one column of a two-column key —
         which matches every row that shares it. */
      const edges = schema.foreignKeys.filter((fk) => fk.from.table === at('shipment'));
      assert.equal(edges.length, 1);
      assert.deepEqual(edges[0].from.columns, ['invoice_id', 'line_no']);
      assert.deepEqual(edges[0].to.columns, ['invoice_id', 'line_no']);
      assert.equal(edges[0].to.table, at('invoice_line'));
    });

    test('two reads of one database describe it identically', async () => {
      /* The catalog queries carry no order of their own, so the server may
         return a table's two foreign keys either way round, its indexed
         columns in any order, and its checks in any order — and a snapshot
         taken twice then differs for no reason anyone changed. Every one of
         those queries is ordered now; this is what that buys. */
      const again = await adapter.introspect();
      assert.deepEqual(again.foreignKeys, schema.foreignKeys);
      assert.deepEqual(
        again.tables.map((t) => [t.id, t.indexed]),
        schema.tables.map((t) => [t.id, t.indexed]),
      );
      assert.deepEqual(
        again.tables.map((t) => t.columns.map((c) => c.allowed)),
        schema.tables.map((t) => t.columns.map((c) => c.allowed)),
      );
      // A second adapter reads the same database the same way.
      const other = new PostgresAdapter(LIVE!, 'pg-fixture-again', [FIXTURE]);
      try {
        const fresh = await other.introspect();
        assert.deepEqual(fresh.foreignKeys, schema.foreignKeys);
        assert.deepEqual(
          fresh.tables.map((t) => [t.id, t.indexed]),
          schema.tables.map((t) => [t.id, t.indexed]),
        );
      } finally {
        await other.close().catch(() => {});
      }
      /* Each key here leaves a different table, so what these pin is the order
         of the list as a whole. The case that actually flipped was a table with
         two keys — the tenant store's membership row, pointing at its tenant
         and at its parent membership — which the tenant suites read. */
      assert.equal(schema.foreignKeys.length >= 3, true);
      assert.equal(new Set(schema.foreignKeys.map((fk) => fk.name)).size, schema.foreignKeys.length);
    });

    test('a self-referencing key keeps its directions straight', () => {
      const edge = schema.foreignKeys.find((fk) => fk.from.table === at('employee'))!;
      assert.equal(edge.to.table, at('employee'));
      assert.deepEqual(edge.from.columns, ['manager_id']);
      assert.deepEqual(edge.to.columns, ['id']);
    });

    test('reads what a delete would do, in words rather than in codes', () => {
      /* Postgres stores this as a single char — `a`, `c`, `r`, `n`, `d` —
         and the delete panel needs to say what will happen. A code shown to
         a person is a code they have to look up. */
      const rules = new Map(schema.foreignKeys.map((fk) => [fk.name, fk.onDelete]));
      assert.equal(rules.get('shipment_line'), 'cascade');
      assert.equal(
        [...rules.values()].some((r) => r === 'set null'),
        true,
        `no "set null" rule was read: ${[...rules.values()].join(', ')}`,
      );
      assert.equal(
        [...rules.values()].some((r) => r === 'restrict'),
        true,
      );
    });

    test('a keyless table is still browsable', () => {
      const log = table('eventlog');
      assert.ok(log);
      assert.equal(
        log.columns.every((c) => !c.primaryKey),
        true,
      );
    });
  });

  /* ---------- reading ---------- */

  describe('reading rows', () => {
    test('rows come back with their headers, filtered and ordered', async () => {
      const result = await adapter.query({
        table: at('customer'),
        columns: ['id', 'name'],
        filter: { groups: [[{ column: 'active', op: '=', value: true }]] },
        orderBy: [{ column: 'id', direction: 'desc' }],
        limit: 2,
        offset: 0,
      });
      assert.deepEqual(result.columns, ['id', 'name']);
      assert.deepEqual(
        result.rows.map((r) => r.id),
        [4, 3],
      );
    });

    test('a search ignores case here, exactly as it does on SQLite', async () => {
      /* Postgres LIKE is case-sensitive and SQLite's is not. `contains` is a
         browsing operator — someone typing a name means it however it is
         capitalised — so the same query returning a row on one engine and
         nothing on the other is the tool disagreeing with itself. */
      const found = async (value: string) =>
        (
          await adapter.query({
            table: at('customer'),
            columns: ['id'],
            filter: { groups: [[{ column: 'name', op: 'contains', value }]] },
            limit: 5,
            offset: 0,
          })
        ).rows.map((r) => r.id);

      assert.deepEqual(await found('Harbour'), [2]);
      assert.deepEqual(await found('harbour'), [2], 'lowercase finds the same row');
      assert.deepEqual(await found('HARBOUR'), [2]);
    });

    test('`like` hands the wildcards to whoever typed them', async () => {
      /* The deliberate opposite of `contains`, and the one operator whose
         whole behaviour is engine-specific text: it compiles to `ILIKE` here
         and `LIKE` on the others, so "it works" proved on SQLite proved
         nothing about this. */
      const matching = async (pattern: string) =>
        (
          await adapter.query({
            table: at('customer'),
            columns: ['id'],
            filter: { groups: [[{ column: 'name', op: 'like', value: pattern }]] },
            limit: 10,
            offset: 0,
          })
        ).rows.map((r) => r.id);

      assert.deepEqual(await matching('Harbour%'), [2], 'a prefix');
      assert.deepEqual(await matching('%Cellars'), [4], 'a suffix');
      assert.deepEqual((await matching('%e%')).length > 1, true, 'a run in the middle');
      /* `_` is one character: `Kiwi Cellars` matches, `Harbour Freight Co`
         does not, and neither would if the underscore had been escaped. */
      assert.deepEqual(await matching('Kiwi_Cellars'), [4]);

      /* Case, which is the ILIKE half. Postgres LIKE would return nothing
         here and the tool would disagree with itself across engines. */
      assert.deepEqual(await matching('harbour%'), [2], 'and it ignores case, as `contains` does');
    });

    test('`like` can still ask for a literal percent, through the escape', async () => {
      /* The pattern is passed through rather than escaped, which is the point
         — so the escape character is the only way back to a literal, and the
         statement declares one. */
      await adapter.insert!({ table: at('country'), values: { code: 'PC', name: '50% off' } });
      const found = await adapter.query({
        table: at('country'),
        columns: ['code'],
        filter: { groups: [[{ column: 'name', op: 'like', value: '%50#%%' }]] },
        limit: 5,
        offset: 0,
      });
      assert.deepEqual(
        found.rows.map((r) => r.code),
        ['PC'],
      );
      await adapter.remove!({ table: at('country'), key: { code: 'PC' } });
    });

    test('a wildcard in the value is a character, not a wildcard', async () => {
      const matched = await adapter.query({
        table: at('customer'),
        columns: ['id'],
        /* Unescaped this is "match everything" and would return all five
           rows while claiming they contain a percent sign. */
        filter: { groups: [[{ column: 'name', op: 'contains', value: '%' }]] },
        limit: 10,
        offset: 0,
      });
      assert.deepEqual(matched.rows, []);
    });

    test('a value sweep survives the default shape of a Postgres schema', async () => {
      /* The reported failure: `account` has a uuid key and a text[] column,
         both of which read as text to a naive type check and neither of
         which Postgres will LIKE. The thrown statement took the whole table
         with it — its genuine `name` column included — while the answer
         claimed to have searched it. A confident wrong "not found". */
      const found = await findValue(adapter, schema, 'pg-fixture', 'Nakamura');
      const matches = found.matches as Array<{ table: string; columns: string[] }>;
      const account = matches.find((m) => m.table === at('account'));
      assert.ok(account, 'the row was found in the uuid-keyed table');
      assert.deepEqual(account!.columns, ['name']);
      assert.equal(found.failed, undefined, 'and nothing was quietly unreadable');
    });

    test('a whole uuid is matched by equality, since it cannot be matched by LIKE', async () => {
      const found = await findValue(adapter, schema, 'pg-fixture', '3F8C1E42-9B21-4C7A-8F0E-2D5A6B7C8D90');
      const matches = found.matches as Array<{ table: string; columns: string[]; key?: Record<string, unknown> }>;
      /* Dropping uuid columns from the sweep would be the safe fix and would
         miss the commonest primary key there now is — the id someone pasted
         out of a log is exactly what they are searching for. */
      assert.deepEqual(
        matches.map((m) => m.columns),
        [['id']],
      );
      assert.equal(matches[0].key?.id, '3f8c1e42-9b21-4c7a-8f0e-2d5a6b7c8d90');
    });

    test('a partial uuid is not guessed at', async () => {
      const found = await findValue(adapter, schema, 'pg-fixture', '3f8c1e42');
      assert.deepEqual(found.matches, []);
      assert.equal(found.failed, undefined, 'refused, not failed');
    });

    test('an empty result still names its columns', async () => {
      /* A grid with no headers cannot say *which* columns had nothing in
         them, and "no rows" with no shape reads as a broken query. */
      const result = await adapter.query({
        table: at('customer'),
        columns: ['id', 'name'],
        filter: { groups: [[{ column: 'id', op: '=', value: -1 }]] },
        limit: 5,
        offset: 0,
      });
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.columns, ['id', 'name']);
    });

    test('a timestamp is the text the server stores, not a shifted instant', async () => {
      /* The value in the column is what the database holds. Handing it
         through a `Date` and back reinterprets it in the process's timezone,
         so a row written at 09:00 reads 19:00 to someone in Sydney. */
      const result = await adapter.query({
        table: at('customer'),
        columns: ['updated_at'],
        filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
        limit: 1,
        offset: 0,
      });
      assert.match(String(result.rows[0].updated_at), /^2026-08-01[ T]09:00/);
    });

    test('a count is a count', async () => {
      assert.equal(await adapter.count(at('customer')), 5);
      assert.equal(await adapter.count(at('customer'), { groups: [[{ column: 'active', op: '=', value: false }]] }), 1);
    });

    test('an estimate is a number, or nothing, and never a lie', async () => {
      /* Read from `reltuples`, which is -1 on a table the planner has never
         analysed. Returning that as a count would put "-1 rows" on screen;
         returning nothing lets the caller fall back to counting. */
      const estimate = await adapter.estimateCount(at('customer'));
      assert.ok(estimate === undefined || estimate >= 0, `estimate was ${estimate}`);
    });

    test('an estimate for a table that is not there says which table', async () => {
      /* It throws rather than answering `undefined`, which is right: an
         unknown table is the caller's mistake, and the endpoints in front of
         this now check the schema before asking. What matters is that the
         message names the table rather than surfacing a catalog error. */
      await assert.rejects(() => adapter.estimateCount(`${FIXTURE}.nonesuch`), /nonesuch/);
    });
  });

  /* ---------- the read-only guarantee ---------- */

  describe('what a statement cannot do', () => {
    const run = (text: string) => adapter.runSql!({ text, limit: 5 });

    test('timeout_ms lowers the cap for one statement, and only that one', async () => {
      /* pg_sleep(1) against a 200ms cap: the engine interrupts and names the
         timeout. The next statement runs untouched, because SET LOCAL died
         with its transaction. */
      await assert.rejects(() => adapter.runSql!({ text: 'SELECT pg_sleep(1)', limit: 5, timeoutMs: 200 }), /statement timeout/i);
      const fine = await adapter.runSql!({ text: 'SELECT 1 AS one', limit: 5 });
      assert.equal((fine.rows![0] as unknown[])[0], 1);
    });
    const refused = (text: string) => assert.rejects(() => run(text), /read.only|One statement/i, `postgres allowed: ${text}`);

    test('a read works', async () => {
      const result = await run(`select id, name from ${FIXTURE}.customer order by id limit 2`);
      assert.deepEqual(result.columns, ['id', 'name']);
      assert.equal(result.rows.length, 2);
    });

    test('two output columns of the same name both survive', async () => {
      /* `rowMode: 'array'` exists for this. Read into objects, the second
         `id` overwrites the first and a column silently disappears. */
      const result = await run(`select id, id from ${FIXTURE}.customer limit 1`);
      assert.equal(result.columns.length, 2);
      assert.equal(result.rows[0].length, 2);
    });

    test('a write is refused', async () => {
      await refused(`delete from ${FIXTURE}.customer`);
      await refused(`update ${FIXTURE}.customer set name = 'x'`);
      await refused(`insert into ${FIXTURE}.country values ('ZZ','Zedland')`);
    });

    test('so is DDL', async () => {
      await refused(`drop table ${FIXTURE}.shipment`);
      await refused(`create table ${FIXTURE}.sneaky (id int)`);
    });

    test('a statement cannot arrange conditions for the next one', async () => {
      /* The escape the transaction exists to close. `SET
         default_transaction_read_only = off` is a legal statement; inside a
         `BEGIN READ ONLY` it cannot promote the transaction it is in, and
         the ROLLBACK afterwards discards it so the next statement starts
         where this one did. */
      await run('set default_transaction_read_only = off').catch(() => {});
      await refused(`delete from ${FIXTURE}.customer`);
    });

    test('stacking is refused', async () => {
      await refused(`select 1; drop table ${FIXTURE}.shipment`);
    });

    test('and every row is still there afterwards', async () => {
      // An error proves a statement was refused; this proves it did not run.
      assert.equal(await adapter.count(at('customer')), 5);
      assert.equal(await adapter.count(at('country')), 3);
      assert.ok(schema.tables.some((t) => t.id === at('shipment')));
    });
  });

  /* ---------- writing ---------- */

  /**
   * The write path, which until now did not exist on this engine.
   *
   * Postgres was read-only build-wide: `update`, `insert` and `remove` were
   * simply absent, so the record editor, the insert form and the write MCP
   * tools all answered "postgres connections are read-only in this build" —
   * on the engine most of this tool's users point it at.
   *
   * Every guard is asserted independently rather than trusting the one in
   * front of it. This is the one place a bug destroys data rather than
   * showing the wrong thing, and a guard that is only reached when another
   * fails is a guard nobody has tested.
   */
  describe('writing', () => {
    const read = async (name: string, key: Record<string, string | number>) => {
      const result = await adapter.query({
        table: at(name),
        filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
        limit: 1,
        offset: 0,
      });
      return result.rows[0];
    };

    test('conditional updates check scalar originals and NULL in the write itself', async () => {
      const key = { id: 4 };
      const original = await read('customer', key);
      try {
        await adapter.update!({ table: at('customer'), key, values: { name: 'Guarded', email: null } });
        const result = await adapter.update!({
          table: at('customer'),
          key,
          values: { name: 'Guarded next', email: 'next@example.test' },
          expected: { name: 'Guarded', email: null },
        });
        assert.equal(result.affected, 1);
        await assert.rejects(
          adapter.update!({
            table: at('customer'),
            key,
            values: { name: 'Overwrite', email: null },
            expected: { name: 'guarded next', email: 'next@example.test' },
          }),
          WriteConflict,
        );
        assert.equal((await read('customer', key)).name, 'Guarded next');
        assert.equal((await read('customer', key)).email, 'next@example.test');
        assert.equal(
          (await adapter.update!({ table: at('customer'), key, values: { name: 'Guarded next' }, expected: { name: 'Guarded next' } }))
            .affected,
          1,
        );
      } finally {
        await adapter.update!({
          table: at('customer'),
          key,
          values: { name: original.name as string, email: original.email as string | null },
        });
      }
    });

    test('updates exactly one row, with every value bound', async () => {
      assert.equal((await read('customer', { id: 1 })).credit_limit, '5000.00');

      const result = await adapter.update!({
        table: at('customer'),
        key: { id: 1 },
        values: { credit_limit: 7500 },
      });
      assert.equal(result.affected, 1);
      /* Numbered placeholders, and the numbering continues across the SET
         into the WHERE — the one thing this differs from the other two
         adapters, and the one thing that silently writes the wrong row if it
         is off by one. */
      assert.match(result.sql.text, /SET "credit_limit" = \$1/);
      assert.match(result.sql.text, /"id" = \$2/);
      assert.deepEqual(result.sql.params, [7500, 1]);

      assert.equal((await read('customer', { id: 1 })).credit_limit, '7500.00');
      // And nothing else moved.
      assert.equal(await adapter.count(at('customer'), { groups: [[{ column: 'credit_limit', op: '=', value: 7500 }]] }), 1);
    });

    test('several columns move in one statement, coerced to their types', async () => {
      const result = await adapter.update!({
        table: at('customer'),
        key: { id: 3 },
        values: { name: 'Pennine Tools Ltd', credit_limit: '4500.25', active: 'false' },
      });
      assert.equal(result.affected, 1);
      // Everything arrives from a text box as a string; the column decides.
      assert.equal(result.applied.credit_limit, 4500.25);
      assert.equal(typeof result.applied.credit_limit, 'number');
      assert.equal(result.applied.active, false);
      assert.equal((await read('customer', { id: 3 })).name, 'Pennine Tools Ltd');
    });

    test('writes NULL as NULL, not as an empty string', async () => {
      await adapter.update!({ table: at('customer'), key: { id: 4 }, values: { email: null } });
      assert.equal(await adapter.count(at('customer'), { groups: [[{ column: 'email', op: 'isNull' }]] }), 2);
    });

    test('a write that changes nothing still reports the row it matched', async () => {
      /* Postgres counts rows matched rather than rows whose bytes changed.
         Reporting 0 here would tell someone their save failed when it did
         exactly what they asked. */
      const again = await adapter.update!({
        table: at('customer'),
        key: { id: 2 },
        values: { name: 'Harbour Freight Co' },
      });
      assert.equal(again.affected, 1);
    });

    test('a composite key updates only the row it names', async () => {
      await adapter.update!({
        table: at('invoice_line'),
        key: { invoice_id: 1001, line_no: 1 },
        values: { quantity: 42 },
      });
      const rows = await adapter.query({
        table: at('invoice_line'),
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

    test('refuses a key that is not the whole primary key', async () => {
      await assert.rejects(
        () => adapter.update!({ table: at('invoice_line'), key: { invoice_id: 1001 }, values: { quantity: 99 } }),
        /needs exactly its primary key \(invoice_id, line_no\)/,
      );
    });

    test('refuses a non-key column smuggled in as the key', async () => {
      /* The dangerous case: `active = true` matches most of the table.
         Without the key-shape check this is an UPDATE across all of them. */
      await assert.rejects(
        () => adapter.update!({ table: at('customer'), key: { active: true } as never, values: { credit_limit: 0 } }),
        /needs exactly its primary key/,
      );
    });

    test('refuses to edit a primary key in place', async () => {
      await assert.rejects(() => adapter.update!({ table: at('customer'), key: { id: 1 }, values: { id: 99 } }), /part of the primary key/);
    });

    test('refuses a view, and a table with no primary key', async () => {
      await assert.rejects(() => adapter.update!({ table: at('customer_totals'), key: { id: 1 }, values: { name: 'x' } }), /is a view/);
      await assert.rejects(() => adapter.update!({ table: at('eventlog'), key: { id: 1 }, values: { note: 'x' } }), /no primary key/);
    });

    test('refuses an unknown column, and an empty update', async () => {
      await assert.rejects(
        () => adapter.update!({ table: at('customer'), key: { id: 1 }, values: { nope: 'x' } }),
        /no column called "nope"/,
      );
      await assert.rejects(() => adapter.update!({ table: at('customer'), key: { id: 1 }, values: {} }), /Nothing to update/);
    });

    test('refuses emptying a NOT NULL column', async () => {
      await assert.rejects(
        () => adapter.update!({ table: at('customer'), key: { id: 1 }, values: { name: null } }),
        /NOT NULL and cannot be emptied/,
      );
    });

    test('refuses a key that matches no row', async () => {
      /* The pre-flight count runs on the read-only handle, so the check that
         decides whether to write cannot itself write. */
      await assert.rejects(
        () => adapter.update!({ table: at('customer'), key: { id: 9999 }, values: { name: 'x' } }),
        /matches 0 rows, not 1/,
      );
    });

    test('an insert returns the row as stored, key and defaults included', async () => {
      const result = await adapter.insert!({ table: at('note'), values: { body: 'first' } });
      // The key is the database's to assign, and only the returned row knows it.
      assert.equal(typeof result.key.id, 'string', 'a bigint comes back as text, not a lossy number');
      assert.ok(Number(result.key.id) > 0);
      // RETURNING * rather than a re-read: the default is filled in the answer.
      assert.equal(result.row?.tag, 'plain');
      assert.equal(result.row?.body, 'first');
      assert.match(result.sql.text, /RETURNING \*/);
      assert.deepEqual(result.sql.params, ['first']);
    });

    test('default-only inserts return server-generated values and composite identities return the full key', async () => {
      const defaults = await adapter.insert({ table: at('assigned_defaults'), values: {} });
      assert.ok(defaults.key.id);
      assert.ok(defaults.row?.sequence);
      assert.match(String(defaults.row?.token), /^[a-f\d-]{36}$/i);
      assert.ok(defaults.row?.created_at);
      assert.match(defaults.sql.text, /DEFAULT VALUES RETURNING/);
      const composite = await adapter.insert({ table: at('composite_identity'), values: { tenant: 7 } });
      assert.deepEqual(Object.keys(composite.key).sort(), ['id', 'tenant']);
      assert.equal(composite.key.tenant, 7);
      assert.ok(composite.key.id);
    });

    test('an insert can supply its own key where the table has one to supply', async () => {
      const result = await adapter.insert!({ table: at('country'), values: { code: 'ZZ', name: 'Zedland' } });
      assert.deepEqual(result.key, { code: 'ZZ' });
      assert.equal(await adapter.count(at('country')), 4);
    });

    test('the database refuses in its own words, not in a paraphrase', async () => {
      /* Completeness is deliberately not pre-checked: a missing NOT NULL
         column with no default is the database's refusal to make, and its
         message names the column better than a guess would. */
      await assert.rejects(() => adapter.insert!({ table: at('note'), values: { tag: 'orphan' } }), /body/i);
      /* And a value for a key the database always assigns. Postgres says
         "cannot insert a non-DEFAULT value into column" — pinned as written,
         because the point of this test is that the words reaching the user
         are the engine's and not ours. */
      await assert.rejects(
        () => adapter.insert!({ table: at('note'), values: { id: 1, body: 'mine' } }),
        /non-DEFAULT value into column "id"/,
      );
      // And a reference that points at nothing.
      await assert.rejects(
        () =>
          adapter.insert!({
            table: at('customer'),
            values: { id: 900, name: 'Nowhere Ltd', country_code: 'XX' },
          }),
        /foreign key|violates/i,
      );
    });

    test('an insert refuses a view and an unknown column', async () => {
      await assert.rejects(() => adapter.insert!({ table: at('customer_totals'), values: { name: 'x' } }), /is a view/);
      await assert.rejects(() => adapter.insert!({ table: at('note'), values: { nope: 'x' } }), /no column called "nope"/);
    });

    test('a delete removes exactly the row it names', async () => {
      const result = await adapter.remove!({ table: at('country'), key: { code: 'ZZ' } });
      assert.equal(result.affected, 1);
      assert.match(result.sql.text, /DELETE FROM .*"country"/);
      assert.equal(await adapter.count(at('country')), 3);
    });

    test('a delete refuses a partial key, a view, and a key matching no row', async () => {
      await assert.rejects(
        () => adapter.remove!({ table: at('invoice_line'), key: { invoice_id: 1001 } }),
        /needs exactly its primary key/,
      );
      await assert.rejects(() => adapter.remove!({ table: at('customer_totals'), key: { id: 1 } }), /is a view/);
      await assert.rejects(() => adapter.remove!({ table: at('country'), key: { code: 'ZZ' } }), /matches 0 rows, not 1/);
    });

    test('a constraint that fires is the database refusing, not us', async () => {
      /* `employee.manager_id` is ON DELETE RESTRICT, and Miles manages two
         people. Deciding whether a row *should* go is not the adapter's job —
         what references it is answered a layer up, where the schema is in
         hand, and the engine has the last word either way. */
      /* PostgreSQL 18 reworded the message ("violates RESTRICT setting of
         foreign key constraint"); the constraint's name is the stable part. */
      await assert.rejects(
        () => adapter.remove!({ table: at('employee'), key: { id: 1 } }),
        /foreign key constraint "employee_manager_id_fkey"/i,
      );
      assert.equal(await adapter.count(at('employee')), 3);
    });

    test('raw SQL writes only when the request says so', async () => {
      const written = await adapter.runSql!({
        text: `UPDATE ${FIXTURE}.customer SET credit_limit = 1 WHERE id = 5 RETURNING id, credit_limit`,
        limit: 5,
        write: true,
      });
      assert.equal(written.affected, 1);
      // RETURNING is worth showing: a write can answer as well as act.
      assert.deepEqual(written.columns, ['id', 'credit_limit']);
      assert.equal(written.rows[0][0], 5);
      // Never wrapped in a bounding subquery — that is a different statement.
      assert.equal(written.bounded, false);

      // The same text without the flag is still refused, on the read handle.
      await assert.rejects(
        () => adapter.runSql!({ text: `UPDATE ${FIXTURE}.customer SET credit_limit = 2 WHERE id = 5`, limit: 5 }),
        /read.only/i,
      );
      assert.equal((await read('customer', { id: 5 })).credit_limit, '1.00');
    });

    test('a graph of rows lands as one thing, or not at all', async () => {
      /* The adapter's half of the fixture story. `insertGraph` is engine-
         agnostic; what is Postgres's here is the transaction underneath it,
         which is the only part that can actually fail to be atomic. */
      const made = await insertGraph(adapter, schema, [
        { table: at('country'), as: 'zz', values: { code: 'ZZ', name: 'Zedland' } },
        { table: at('customer'), as: 'c', values: { id: 800, name: 'Graph Ltd', country_code: { ref: 'zz', column: 'code' } } },
        /* A bare name, resolved the way every other write tool resolves one —
           and resolved to *this* schema, not to `public`. */
        { table: 'note', as: 'n', values: { body: 'about the graph' } },
      ]);
      assert.equal(made.rowsWritten, 3);
      assert.equal(made.inserted[1].row?.country_code, 'ZZ');
      // A key the database assigned, referable because the row came back.
      assert.ok(Number(made.inserted[2].key.id) > 0);
      assert.deepEqual(
        made.teardown.map((r) => r.table),
        [at('note'), at('customer'), at('country')],
      );

      // And the whole thing goes away again, in one call, children first.
      const gone = await deleteGraph(adapter, schema, made.teardown);
      assert.equal(gone.rowsDeleted, 3);
      assert.equal(await adapter.count(at('country')), 3);
    });

    test('a graph that fails part way leaves nothing behind', async () => {
      const before = await adapter.count(at('country'));
      await assert.rejects(
        () =>
          insertGraph(adapter, schema, [
            { table: at('country'), values: { code: 'YY', name: 'Wyeland' } },
            { table: at('customer'), values: { id: 801, name: 'Doomed Ltd', country_code: 'YY' } },
            // A reference to a country that does not exist: the engine refuses.
            { table: at('customer'), values: { id: 802, name: 'Also Doomed', country_code: 'XX' } },
          ]),
        /Row 3 \(.*customer\)[\s\S]*Nothing was written/,
      );
      assert.equal(await adapter.count(at('country')), before, 'the first row went back too');
      assert.equal(await adapter.count(at('customer'), { groups: [[{ column: 'id', op: '=', value: 801 }]] }), 0);
    });

    test('an unrelated write cannot land inside somebody else\u2019s transaction', async () => {
      /* Node is single-threaded and `await` is not: two requests arriving
         together interleave at every await point, so without a queue this
         update would be swept up by the rollback below — a write that
         succeeded, said so, and then did not happen. Both are started before
         either is awaited, which is what a pipelining client does. */
      const graph = insertGraph(adapter, schema, [
        { table: at('country'), values: { code: 'QQ', name: 'Quland' } },
        { table: at('country'), values: { code: 'AU', name: 'Duplicate' } }, // the key already exists
      ]).catch((err: Error) => err);
      const edit = adapter.update!({ table: at('customer'), key: { id: 4 }, values: { name: 'Kiwi Cellars Ltd' } });

      assert.ok((await graph) instanceof Error, 'the graph failed, as it was meant to');
      assert.equal((await edit).affected, 1);
      assert.equal((await read('customer', { id: 4 })).name, 'Kiwi Cellars Ltd', 'the edit survived the rollback');
      assert.equal(await adapter.count(at('country')), 3, 'and the graph left nothing');
    });

    test('the browsing connection stays read-only after a write', async () => {
      /* Every write above went through a second connection. The one every
         read uses must still refuse, or "read-only browsing" was never true
         — it was only true until somebody edited a cell. */
      await assert.rejects(
        () =>
          (adapter as unknown as { connections: PgConnectionManager }).connections.withReadClient((client) =>
            client.query(`DELETE FROM ${FIXTURE}.customer`),
          ),
        /read.only/i,
      );
      assert.equal(await adapter.count(at('customer')), 5);
    });
  });

  /* ---------- asked before the change, and undone after it ---------- */

  describe('change_impact, against a real Postgres', () => {
    /* Written and proven on SQLite, where a synchronous driver hands back a
       whole catalog and `PRAGMA index_list` answers what is indexed. Postgres
       answers all of that differently — `pg_index`, schema-qualified names,
       delete rules read from `information_schema` — so "it works" was a claim
       about one engine and this is the other. */

    test('names what points at a table, with the rule and the numbers', async () => {
      /* `customer.country_code` references `country` ON DELETE SET NULL, which
         is the interesting direction: the rule is read from
         `information_schema` on Postgres and from a pragma on SQLite, and a
         count without its rule is not an answer. */
      const impact = await changeImpact(adapter, schema, at('country'), 'code');
      assert.equal(impact.table, at('country'));
      assert.equal(impact.rows, 3);

      const customers = impact.referencedBy.find((d) => d.table === at('customer'));
      assert.ok(customers, 'customer points at country');
      /* Schema-qualified on Postgres, which a SQLite test cannot exercise: a
         bare `customer` would have matched nothing. */
      assert.ok(customers.table.startsWith(`${FIXTURE}.`), customers.table);
      assert.deepEqual(customers.columns, ['country_code']);
      assert.equal(customers.onDelete, 'set null');
      assert.equal(customers.rows, 5);
      assert.ok(
        impact.notes.some((n) => /is set null on delete: 5 rows in .*customer would survive with a hole/.test(n)),
        impact.notes.join('\n'),
      );
    });

    test('counts the nulls that decide whether NOT NULL can land', async () => {
      /* `customer.country_code` has one null — Dormant Ltd. The whole point of
         the tool is that this number is right, because it is the one that
         makes a migration fail at the worst moment. */
      const impact = await changeImpact(adapter, schema, at('customer'), 'country_code');
      assert.equal(impact.columnFacts?.nullable, true);
      assert.equal(impact.columnFacts?.nulls, 1);
      assert.ok(
        impact.notes.some((n) => /1 of 5 rows hold null, so NOT NULL would be refused/.test(n)),
        impact.notes.join('\n'),
      );
    });

    test('and says nothing about an index it could not read', async () => {
      /* `indexed` is absent when the adapter does not report indexes, and the
         rule is that absence never becomes a claim. Postgres does report
         them, so this asserts the shape rather than the value: whatever it
         says, it must not say "no index" when it does not know. */
      const impact = await changeImpact(adapter, schema, at('customer'), 'id');
      for (const dep of impact.referencedBy) {
        assert.ok(dep.indexed === undefined || typeof dep.indexed === 'boolean');
        if (dep.indexed === undefined) {
          assert.ok(!impact.notes.some((n) => n.includes(`No index leads on ${dep.table}`)));
        }
      }
    });
  });

  describe('the write journal, against a real Postgres', () => {
    /* The journal reverses a write by calling `update`, `insert` and `remove`
       on the adapter — so on Postgres it is exercising numbered parameters, a
       `RETURNING *` read-back and a separate writable handle, none of which
       SQLite has. This is a *write* path: being wrong here destroys data
       rather than mis-displaying it, which is why it does not ship on the
       strength of one engine. */
    const CONN = 'pg-journal';

    /* Its own copy rather than reaching into the `writing` block's: a helper
       shared across describes is a helper that has to outlive whichever one
       is deleted first. */
    const read = async (name: string, key: Record<string, string | number>) => {
      const result = await adapter.query({
        table: at(name),
        filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
        limit: 1,
        offset: 0,
      });
      return result.rows[0] as Record<string, unknown>;
    };

    before(() => clearJournal(CONN));
    after(() => clearJournal(CONN));

    test('an update is put back, and the row is the witness', async () => {
      const before2 = await read('customer', { id: 3 });
      const result = await adapter.update!({
        table: at('customer'),
        key: { id: 3 },
        values: { email: 'wrong@example.com' },
      });
      const steps = [
        {
          table: at('customer'),
          key: { id: 3 },
          before: { email: before2.email },
          after: { ...result.applied },
        },
      ];
      recordWrite(CONN, { kind: 'update', summary: summarise('update', steps), revertible: true, steps });

      assert.equal((await read('customer', { id: 3 })).email, 'wrong@example.com');
      const undone = await revert(adapter, CONN, lastRevertible(CONN)!);
      assert.equal(undone.reverted, true, JSON.stringify(undone.errors));
      assert.equal((await read('customer', { id: 3 })).email, before2.email);
    });

    test('an insert is undone by removing what it added, by the key Postgres assigned', async () => {
      /* `note.id` is GENERATED ALWAYS AS IDENTITY: the key is the database's
         to give, and undoing the insert is only possible because the journal
         records what it gave back. */
      /* Counted relative to whatever the earlier blocks left behind, rather
         than assuming an empty table — these run in file order against one
         database. */
      const before2 = await adapter.count(at('note'));
      const inserted = await adapter.insert!({ table: at('note'), values: { body: 'undo me' } });
      const steps = [{ table: at('note'), key: inserted.key, after: { ...inserted.row } }];
      recordWrite(CONN, { kind: 'insert', summary: summarise('insert', steps), revertible: true, steps });

      assert.equal(await adapter.count(at('note')), before2 + 1);
      assert.ok(Object.keys(inserted.key).length, 'Postgres gave the row a key to find it by');

      const undone = await revert(adapter, CONN, lastRevertible(CONN)!);
      assert.equal(undone.reverted, true, JSON.stringify(undone.errors));
      assert.equal(await adapter.count(at('note')), before2, 'and the row Postgres numbered is gone');
    });

    test('a delete is undone by putting the whole row back', async () => {
      await adapter.insert!({ table: at('country'), values: { code: 'ZY', name: 'Zedyard' } });
      const row = await read('country', { code: 'ZY' });
      await adapter.remove!({ table: at('country'), key: { code: 'ZY' } });
      const steps = [{ table: at('country'), key: { code: 'ZY' }, before: { ...row } }];
      recordWrite(CONN, { kind: 'delete', summary: summarise('delete', steps), revertible: true, steps });

      const undone = await revert(adapter, CONN, lastRevertible(CONN)!);
      assert.equal(undone.reverted, true, JSON.stringify(undone.errors));
      const back = await read('country', { code: 'ZY' });
      assert.equal(back.name, 'Zedyard', 'values and all');
      await adapter.remove!({ table: at('country'), key: { code: 'ZY' } });
    });

    test('a row that moved on is refused, and left alone', async () => {
      const result = await adapter.update!({
        table: at('customer'),
        key: { id: 4 },
        values: { email: 'ours@example.com' },
      });
      const steps = [
        {
          table: at('customer'),
          key: { id: 4 },
          before: { email: 'hello@kiwicellars.example' },
          after: { ...result.applied },
        },
      ];
      recordWrite(CONN, { kind: 'update', summary: summarise('update', steps), revertible: true, steps });

      // Somebody else, outside this session.
      await adapter.update!({ table: at('customer'), key: { id: 4 }, values: { email: 'theirs@example.com' } });

      const refused = await revert(adapter, CONN, lastRevertible(CONN)!);
      assert.equal(refused.reverted, false);
      assert.match(refused.errors![0], /has changed since/);
      assert.equal((await read('customer', { id: 4 })).email, 'theirs@example.com', 'the newer value survived');
      await adapter.update!({ table: at('customer'), key: { id: 4 }, values: { email: 'hello@kiwicellars.example' } });
    });
  });

  /* ---------- lifecycle ---------- */

  describe('grouping', () => {
    test('counts by a column, and by a period, in Postgres\u2019s own spelling', async () => {
      const byCountry = await adapter.runBreakdown!({
        base: at('customer'),
        by: [{ path: 'country_code.name', alias: 'country' }],
        measures: [{ fn: 'count' }, { fn: 'sum', path: 'credit_limit', alias: 'credit' }],
        orderBy: [{ name: 'count', direction: 'desc' }],
      });
      assert.deepEqual(byCountry.columns, ['country', 'count', 'credit']);
      assert.match(byCountry.sql.text, /LEFT JOIN .*country/);
      // Every customer is in exactly one group, the null-country one included.
      assert.equal(
        byCountry.rows.reduce((n, r) => n + Number(r.count), 0),
        await adapter.count(at('customer')),
      );

      /* The one part of a breakdown no two engines spell alike. Postgres uses
         `to_char`, and the point of putting it in the style is that the label
         it produces is the same string SQLite produces. */
      const byMonth = await adapter.runBreakdown!({
        base: at('customer'),
        by: [{ path: 'updated_at', bucket: 'month' }],
        measures: [{ fn: 'count' }],
        orderBy: [{ name: 'month(updated_at)', direction: 'asc' }],
      });
      assert.match(byMonth.sql.text, /to_char\(/);
      const months = byMonth.rows.map((r) => r['month(updated_at)']);
      assert.ok(
        months.every((m) => /^\d{4}-\d{2}$/.test(String(m))),
        months.join(', '),
      );
      assert.deepEqual(months, [...months].sort(), 'the label sorts as text, which is why it is one');

      const quarters = await adapter.runBreakdown!({
        base: at('customer'),
        by: [{ path: 'updated_at', bucket: 'quarter', alias: 'q' }],
        measures: [{ fn: 'count' }],
      });
      assert.ok((quarters.rows.map((r) => r.q) as string[]).every((q) => /^\d{4}-Q[1-4]$/.test(q)));
    });

    test('every value is bound, and the placeholders are numbered across the statement', async () => {
      const result = await adapter.runBreakdown!({
        base: at('customer'),
        by: [{ path: 'country_code' }],
        measures: [{ fn: 'count' }],
        filter: { groups: [[{ path: 'name', op: 'contains', value: 'e' }]] },
      });
      assert.ok(!result.sql.text.includes("'e'"));
      assert.match(result.sql.text, /\$1/);
      assert.match(result.sql.text, /LIMIT \$2 OFFSET \$3/);
    });

    test('counting the groups counts groups', async () => {
      const def = {
        base: at('customer'),
        by: [{ path: 'country_code' }],
        measures: [{ fn: 'count' as const }],
      };
      assert.equal(await adapter.countBreakdown!(def), (await adapter.runBreakdown!(def)).rows.length);
    });
  });

  describe('the connection', () => {
    test('a discarded pooled client is replaced on the next checkout', async () => {
      const own = new PostgresAdapter(LIVE!, 'reconnect', [FIXTURE]);
      try {
        const { connections } = own as unknown as { connections: PgConnectionManager };
        const previous = await connections.withReadClient(async (client) => {
          await client.query('SELECT 1');
          return client;
        }, true);
        await connections.withReadClient(async (client) => {
          assert.notEqual(client, previous);
          await client.query('SELECT 1');
        });
        assert.equal((await own.introspect()).tables.length > 0, true);
      } finally {
        await own.close();
      }
    });

    test('closing twice is not an error', async () => {
      const own = new PostgresAdapter(LIVE!, 'closes', [FIXTURE]);
      await own.introspect();
      await own.close();
      await own.close();
    });
  });

  test('a postgres:// URL picks this adapter', () => {
    assert.ok(connect('postgres://user@host/db') instanceof PostgresAdapter);
    assert.ok(connect('postgresql://user@host/db') instanceof PostgresAdapter);
  });
});
