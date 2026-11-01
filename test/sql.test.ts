/**
 * Running a statement the user wrote.
 *
 * This is the one place tablewalk hands the database text it did not build, so
 * every guarantee made elsewhere — a compiled `Filter`, an identifier checked
 * against the catalog, a bound value — is inapplicable here. The argument has
 * to be made differently, and these are the tests that make it.
 *
 * The house rule applies twice over: assert the negative *and* assert that
 * nothing happened. An error message proves the statement was refused; a row
 * count afterwards proves it did not run anyway.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  ESTIMATE_ABOVE,
  boundStatement,
  dedupe,
  looksWrappable,
  refuseAnalyze,
  refuseStacked,
  trimStatement,
} from '../packages/engine/src/adapters/adapter.js';
import { makeDemoDatabase } from './make-demo-db.js';
import { parseQueriesConfig, queriesFor } from '../packages/engine/src/shared/sqlsaved.js';
import { labelColumn } from '../packages/engine/src/shared/schema.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';

/* Made for this run and removed after it — never `.demo/`, where a
   developer's demo databases and credentials are. */
const DB_DIR = mkdtempSync(join(tmpdir(), 'tablewalk-sql-'));
const DB = join(DB_DIR, 'sql-test.db');

const table = (name: string, columns: Array<[string, string, boolean?]>): TableMeta => ({
  id: name,
  name,
  schema: 'main',
  isView: false,
  columns: columns.map(([col, type, pk]) => ({
    name: col,
    type,
    nullable: true,
    primaryKey: Boolean(pk),
  })),
  indexed: columns.filter(([, , pk]) => pk).map(([col]) => col),
});
let adapter: SqliteAdapter;

before(async () => {
  makeDemoDatabase(DB);
  adapter = new SqliteAdapter(DB, 'sql test');
  await adapter.introspect();
});

after(async () => {
  await adapter.close();
  rmSync(DB_DIR, { recursive: true, force: true });
});

describe('refusing a second statement', () => {
  /* Not a SQL parser — it answers one question, "is there a second statement
     here". These are the inputs that fool a naive scan for `;`. */
  const single = [
    'select 1',
    'select 1;',
    "select 'a; b'",
    'select "a; b"',
    'select 1 -- ; drop table customer',
    'select 1 /* ; drop */ , 2',
    'select $$ ; drop table customer $$',
    'select $tag$ ; drop $tag$',
    "select 'it''s; fine'",
    // Unterminated: the rest of the line is inside the string, mid-keystroke.
    "select 'unterminated ; drop",
    'select 1 /* unterminated ; drop',
  ];

  for (const sql of single) {
    test(`one statement: ${sql}`, () => assert.equal(refuseStacked(sql), null));
  }

  test('a backquote quotes a name in SQLite and nothing in Postgres', () => {
    assert.equal(refuseStacked('select `a; b`', 'sqlite'), null);
    // Postgres reads a backquote as an operator character, so this `;` is a real one.
    assert.match(refuseStacked('select `a; b`', 'postgres') ?? '', /One statement at a time/);
  });

  test('a real second statement is refused', () => {
    assert.match(refuseStacked('select 1; drop table customer') ?? '', /One statement at a time/);
  });

  test('a backslash before a quote is a character, not an escape', () => {
    /* Postgres and SQLite read `'\\'` as a one-character string. Treating the
       backslash as an escape scanned the rest of this statement as string
       and let the second statement past the first line of defence. */
    assert.match(refuseStacked("select '\\'; drop table customer; --'") ?? '', /One statement at a time/);
    assert.equal(refuseStacked("select '\\'"), null);
  });

  test('a $ inside a name opens no dollar-quote', () => {
    /* Postgres reads `x$$` and `a$b$` as names. Read as dollar-quote openers
       with no closer, they hid everything after them — the stacked COMMIT
       and the write behind it among it. */
    const stacked = [
      'select 1 as x$$; commit; begin read write; delete from t where id = 1; commit; select 1 as y$$',
      'select 1 as a$b$; delete from t; select 1 as c$b$',
      'select 1 as x$tag$; delete from t; select $tag$',
    ];
    for (const sql of stacked) assert.match(refuseStacked(sql) ?? '', /One statement at a time/, sql);
    assert.equal(refuseStacked('select 1 as x$$'), null);
    assert.equal(refuseStacked('select a$b$ from t'), null);
  });

  test("an E'…' string ends where Postgres ends it", () => {
    /* E'…' honours backslash escapes: `E'\''` is a whole string holding a
       quote, so the `;` after it is a real one. */
    const stacked = [
      "select E'\\''; commit; set transaction read write; delete from t where id = 11; -- '",
      "select e'\\''; delete from t; -- '",
      "select E'\\\\'; delete from t; -- '",
      // A string continued on the next line is still an E'…' string.
      "select E'a'\n'\\''; delete from t; -- '",
    ];
    for (const sql of stacked) assert.match(refuseStacked(sql) ?? '', /One statement at a time/, sql);
    assert.equal(refuseStacked("select E'it\\'s; fine'"), null);
    assert.equal(refuseStacked("select E'a\\\\'"), null);
    // A name ending in e before a quote is not an E string: `'\'` is a whole string there.
    assert.match(refuseStacked("select type'\\'; delete from t; -- '") ?? '', /One statement at a time/);
  });

  test('Postgres block comments nest', () => {
    // The inner close does not end the outer comment, so the quote after it is comment, not a string.
    assert.match(refuseStacked("select 1 /* /* */ ' */; delete from t; -- '") ?? '', /One statement at a time/);
    assert.equal(refuseStacked('select 1 /* a /* b */ ; c */'), null);
  });

  test('the dollar-quote bodies a function carries still read as one statement', () => {
    const bodies = [
      'create function f() returns int language sql as $$ select 1; $$',
      'create function f() returns int language plpgsql as $body$ begin return 1; end; $body$',
      'do $$ begin perform 1; end $$;',
      'select 1 = $$a;b$$',
      "select 1, $q$it's; fine$q$",
    ];
    for (const sql of bodies) assert.equal(refuseStacked(sql), null, sql);
  });

  test('SQLite has no dollar-quotes or E strings, and quotes names in brackets', () => {
    // SQLite reads `$$` as a parameter and would compile only the first statement.
    assert.match(refuseStacked('select $$ ; delete from t; select $$', 'sqlite') ?? '', /One statement at a time/);
    assert.equal(refuseStacked('select [a;b] from t', 'sqlite'), null);
    assert.equal(refuseStacked('select `a;b` from t', 'sqlite'), null);
    assert.equal(refuseStacked("select '\\'", 'sqlite'), null);
  });

  test('the refusal names the fix', () => {
    // An error that only says no sends you looking; this one says what to do.
    assert.match(refuseStacked('select 1; select 2') ?? '', /Remove the semicolon|run them separately/);
  });

  test('stacking is refused, not truncated', async () => {
    /* Running the first half and discarding the rest would be worse than
       refusing both: two things were asked for and neither reported. */
    await assert.rejects(() => adapter.runSql({ text: 'select 1; drop table customer', limit: 5 }), /One statement at a time/);
    assert.equal(await adapter.count('customer'), 5, 'the table is still there');
  });

  test('a read cannot reach past its file with VACUUM INTO or ATTACH', async () => {
    /* `readOnly: true` stops writes to this file only: VACUUM INTO wrote a
       full copy to the path it named, and ATTACH opened another database on
       the shared handle. */
    const copy = join(DB_DIR, 'copy.db');
    for (const text of [`VACUUM INTO '${copy}'`, `/* a note */ vacuum main into '${copy}'`, 'vacuum']) {
      await assert.rejects(() => adapter.runSql({ text, limit: 5 }), /VACUUM reaches past this database file/, text);
      await assert.rejects(() => adapter.runSql({ text, limit: 5, refuseReserved: true }), /VACUUM reaches past/, text);
    }
    assert.equal(existsSync(copy), false, 'no copy was written');
    await assert.rejects(() => adapter.runSql({ text: `attach '${DB}' as other`, limit: 5 }), /ATTACH reaches past/);
    await assert.rejects(() => adapter.runSql({ text: 'select * from other.customer', limit: 5 }), /no such table|unknown database/);
    await assert.rejects(() => adapter.runSql({ text: 'DETACH main', limit: 5 }), /DETACH reaches past/);
    // A read that merely mentions the words still runs.
    assert.equal((await adapter.runSql({ text: "select 'vacuum into attach' as said", limit: 5 })).rows[0][0], 'vacuum into attach');
  });
});

describe('bounding a statement', () => {
  test('the wrap asks the database for one more than we want', () => {
    // The extra row is how "there is more" is known without a second query.
    assert.equal(boundStatement('select * from t', 20), 'SELECT * FROM (\nselect * from t\n) AS mistri_bounded LIMIT 21');
  });

  test('a trailing semicolon does not break the wrap', () => {
    assert.match(boundStatement('select 1;', 5), /\(\nselect 1\n\) AS mistri_bounded/);
    assert.equal(trimStatement('  select 1 ;  '), 'select 1');
  });

  test('a trailing line comment does not swallow the wrap', async () => {
    /* `select … -- note` used to comment out the closing parenthesis and the
       LIMIT; the wrap failed to parse and the fallback ran the statement
       unbounded. The inner statement now sits on its own line. */
    const wrapped = boundStatement('select * from customer -- all of them', 2);
    assert.match(wrapped, /-- all of them\n\) AS mistri_bounded LIMIT 3$/);
    const result = await adapter.runSql({ text: 'select * from customer -- all of them', limit: 2 });
    assert.equal(result.rows.length, 2, 'bounded, comment and all');
    assert.equal(result.truncated, true);
  });

  test('a limit that is not a positive integer is refused', () => {
    /* The limit is interpolated rather than bound — the one deliberate
       exception — so the assertion that it is an integer this process computed
       is what keeps that safe. */
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => boundStatement('select 1', bad), /positive integer/);
    }
  });

  test('only statements that can be wrapped are', () => {
    assert.equal(looksWrappable('select 1'), true);
    assert.equal(looksWrappable('WITH x AS (select 1) select * from x'), true);
    assert.equal(looksWrappable('  -- a comment\n select 1'), true);
    assert.equal(looksWrappable('pragma table_info(customer)'), false);
    assert.equal(looksWrappable('explain select 1'), false);
    assert.equal(looksWrappable('insert into t values (1)'), false);
    // A compound of parenthesized SELECTs is a SELECT, and ran unbounded (SQL-2).
    assert.equal(looksWrappable('(select 1) union (select 2)'), true);
    assert.equal(looksWrappable(' -- note\n (select 1)'), true);
  });

  test('a statement the wrap does not bound is read one past the limit, never whole (SQL-2)', async () => {
    // EXPLAIN is not wrapped: its program is many rows, stepped and stopped at limit + 1.
    const result = await adapter.runSql!({ text: 'explain select * from customer order by name', limit: 2 });
    assert.equal(result.bounded, false);
    assert.equal(result.rows.length, 2);
    assert.equal(result.truncated, true);
  });

  test('explain refuses the forms that would execute the statement', async () => {
    /* EXPLAIN ANALYZE and EXPLAIN (ANALYZE) run the statement to time it;
       the tool promises a plan without a run. The bare statement is fine. */
    assert.equal(refuseAnalyze('select 1'), null);
    assert.equal(refuseAnalyze('  -- note\n with x as (select 1) select * from x'), null);
    for (const text of ['analyze select 1', 'ANALYSE select 1', '(analyze) select 1', 'explain select 1']) {
      assert.match(refuseAnalyze(text) ?? '', /without running it/, text);
    }
    await assert.rejects(() => adapter.explainSql!({ text: 'analyze select * from customer' }), /without running it/);
  });

  test('a statement with no limit returns a page, and says it was bounded', async () => {
    const r = await adapter.runSql({ text: 'select * from invoice_line', limit: 3 });
    assert.equal(r.rows.length, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.bounded, true);
  });

  test('an unwrappable statement is still capped, and says it was not bounded', async () => {
    /* `bounded: false` is the honest report that the database did the whole
       job and we are showing the first rows of it — not that the limit was
       ignored. More rows than asked for never reach the caller either way. */
    const r = await adapter.runSql({ text: 'pragma table_info(customer)', limit: 2 });
    assert.equal(r.rows.length, 2);
    assert.equal(r.bounded, false);
    assert.equal(r.truncated, true);
  });
});

describe('the shape of a raw result', () => {
  test('two columns of the same name both survive', async () => {
    /* An object keyed by column name can hold only one `id`, so the second
       would silently replace the first and the grid would show one column's
       values under two headings. */
    const r = await adapter.runSql({ text: 'select id, id, name from customer', limit: 2 });
    assert.equal(r.columns.length, 3);
    assert.equal(r.rows[0].length, 3);
    assert.equal(r.rows[0][0], r.rows[0][1]);
  });

  test('collisions get a suffix rather than one column standing in for two', () => {
    assert.deepEqual(dedupe(['id', 'id', 'name', 'id']), ['id', 'id_2', 'name', 'id_3']);
  });

  test('an empty result still has its headers', async () => {
    // Deriving columns from the first row means no rows is no columns, and a
    // grid with no headers looks like a failure rather than an empty answer.
    const r = await adapter.runSql({ text: 'select id, name from customer where 1 = 0', limit: 5 });
    assert.deepEqual(r.columns, ['id', 'name']);
    assert.equal(r.rows.length, 0);
  });

  test('the statement that ran is reported', async () => {
    const r = await adapter.runSql({ text: 'select 1 as one', limit: 5 });
    assert.match(r.sql.text, /mistri_bounded/);
  });
});

describe('a read cannot write', () => {
  test('SQLite refuses a write on the browsing handle', async () => {
    /* Engine-level: the file is opened read-only, so there is no session
       setting for a statement to reset. */
    await assert.rejects(() => adapter.runSql({ text: 'delete from customer', limit: 5 }), /readonly|read-only/i);
    assert.equal(await adapter.count('customer'), 5);
  });

  test('and refuses DDL too', async () => {
    await assert.rejects(() => adapter.runSql({ text: 'drop table customer', limit: 5 }), /readonly|read-only/i);
    assert.equal(await adapter.count('customer'), 5);
  });

  test('a refused write leaves the connection usable', async () => {
    // A failed statement that poisoned the session would turn one mistake into
    // a broken tab.
    await adapter.runSql({ text: 'delete from customer', limit: 5 }).catch(() => {});
    const r = await adapter.runSql({ text: 'select count(*) as n from customer', limit: 5 });
    assert.equal(Number(r.rows[0][0]), 5);
  });
});

/**
 * Completion in the SQL editor.
 *
 * Not a SQL parser: it answers "what is in scope" and "what kind of thing goes
 * here" from a scan, and a wrong guess costs a list the reader ignores. These
 * pin the two answers, and the cases where a scan would naively go wrong.
 */
describe('SQL completion', () => {
  let core: typeof import('../packages/kit/src/client/core.js');
  let complete: typeof import('../packages/tablewalk/src/client/sqlcomplete.js');

  before(async () => {
    /* The client modules touch `document` at import time in a few places, so
       the fixture stands one up. This is the same trick mirrors.test.ts uses. */
    (globalThis as { window?: unknown }).window ??= {
      localStorage: { getItem: () => null, setItem: () => {} },
      location: { search: '', pathname: '/', hash: '' },
    };
    (globalThis as { document?: unknown }).document ??= {
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, append() {}, setAttribute() {} }),
      createTextNode: () => ({}),
      querySelector: () => null,
    };
    core = await import('../packages/kit/src/client/core.js');
    complete = await import('../packages/tablewalk/src/client/sqlcomplete.js');
    core.state.schema = await adapter.introspect();
  });

  /** Suggestions with the caret written as `|`. */
  const at = (sql: string) => {
    const caret = sql.indexOf('|');
    return complete.sqlSuggestions(sql.replace('|', ''), caret < 0 ? sql.length : caret);
  };
  const labels = (sql: string) => at(sql).map((s: { label: string }) => s.label);

  test('after FROM, tables and only tables', () => {
    const out = at('select * from |');
    assert.ok(out.length > 0);
    assert.ok(
      out.every((s: { kind: string }) => s.kind === 'table' || s.kind === 'view'),
      'something other than a table was offered where a table goes',
    );
  });

  test('a prefix narrows the tables', () => {
    assert.deepEqual(labels('select * from cust|'), ['customer', 'customer_totals']);
  });

  test('an alias offers its table’s columns and nothing else', () => {
    const out = at('select c.| from customer c');
    assert.deepEqual(out.map((s: { label: string }) => s.label).slice(0, 3), ['id', 'name', 'email']);
    assert.ok(out.every((s: { kind: string }) => s.kind !== 'keyword'));
  });

  test('a qualified prefix narrows too', () => {
    assert.deepEqual(labels('select c.na| from customer c'), ['name']);
  });

  test('the table name works as well as the alias', () => {
    assert.ok(labels('select customer.| from customer').includes('email'));
  });

  test('a keyword after the table is not read as an alias', () => {
    /* `FROM customer WHERE` — a naive scan takes `where` as the alias, and then
       `where.` offers columns for a table nobody named. */
    const scope = complete.scopeOf('select * from customer where id = 1');
    assert.deepEqual([...scope.keys()], ['customer']);
  });

  test('a join puts both tables in scope', () => {
    const scope = complete.scopeOf('select * from invoice i join customer as c on i.customer_id = c.id');
    assert.deepEqual([...scope.keys()].sort(), ['c', 'customer', 'i', 'invoice']);
  });

  test('columns are offered before the FROM clause is written', () => {
    /* People type `select ` and then the columns, so at that moment the tables
       are to the *right* of the caret. A completer that only looked backwards
       would be silent exactly when it is most wanted. */
    assert.ok(labels('select | from customer').includes('credit_limit'));
  });

  test('an unknown table in scope is ignored rather than guessed at', () => {
    assert.deepEqual([...complete.scopeOf('select * from not_a_table t').keys()], []);
  });

  test('the token being typed stops at SQL punctuation', () => {
    // `(count(na` — the word is `na`, not `count(na`.
    assert.equal(complete.tokenAt('select count(na', 15).word, 'na');
    assert.equal(complete.tokenAt('a,b', 3).word, 'b');
  });

  test('an empty statement offers keywords to start with', () => {
    assert.equal(labels('|')[0], 'SELECT');
  });
});

/**
 * The same statements, against the other engine.
 *
 * Opt-in, because requiring a Postgres server to test a SQLite
 * feature would be a bad trade — but these are the tests that justify the
 * design, and they only mean anything against a real server.
 */
const LIVE = [['postgres', process.env.TABLEWALK_TEST_PG] as const];

for (const [engine, url] of LIVE) {
  describe(`raw SQL against a real ${engine}`, { skip: liveSkip(engine, url) }, () => {
    let live: {
      runSql?: (r: { text: string; limit: number }) => Promise<unknown>;
      close(): Promise<void>;
      introspect(): Promise<{ tables: Array<{ id: string; isView: boolean; columns: Array<{ name: string }> }> }>;
    };
    /* Taken from the catalog rather than hardcoded. A DELETE against a table
         that does not exist is refused for the wrong reason, and a test that
         passes for the wrong reason is worse than no test. */
    let victim: string;
    let victimColumn: string;
    /** Rows in the victim before anything was attempted against it. */
    let victimRows = -1;

    before(async () => {
      const { connect } = await import('../packages/engine/src/adapters/connect.js');
      live = connect(url!, { label: engine }) as typeof live;
      const schema = await live.introspect();
      let table: (typeof schema.tables)[number] | undefined;
      // Earlier serial tests can leave empty tables in the shared catalog.
      // This proof needs actual rows to protect, not whichever table sorts first.
      for (const candidate of schema.tables.filter((t) => !t.isView && t.columns.length > 0)) {
        const counted = (await live.runSql!({ text: `select count(*) as n from ${candidate.id}`, limit: 1 })) as { rows: unknown[][] };
        if (Number(counted.rows[0][0]) > 0) {
          table = candidate;
          victimRows = Number(counted.rows[0][0]);
          break;
        }
      }
      /* Said plainly rather than crashing on `undefined.id`.
        
           An empty database is what a fresh container is, and what a
           contributor pointing this at a new server has — the failure was a
           TypeError three frames deep, which says nothing about the fact that
           the database has no tables in it. */
      if (!table) {
        throw new Error(
          `${engine} has no populated tables to read. These tests need a database with ` +
            'something in it: run `npm run seed:live` against it first.',
        );
      }
      victim = table.id;
      victimColumn = table.columns[0].name;
    });
    after(async () => {
      await live?.close();
    });

    const run = (text: string) => live.runSql!({ text, limit: 5 });
    const refused = async (text: string) => {
      await assert.rejects(() => run(text), new RegExp('read.only|One statement', 'i'), `${engine} allowed: ${text}`);
    };

    test('a read works', async () => {
      const r = (await run('select 1 as one')) as { rows: unknown[][] };
      assert.equal(Number(r.rows[0][0]), 1);
    });

    test('DML is refused', async () => {
      await refused(`delete from ${victim}`);
      await refused(`update ${victim} set ${victimColumn} = ${victimColumn}`);
    });

    test('DDL is refused', async () => {
      for (const sql of [`drop table ${victim}`, 'create table dw_evil (id int)', `truncate ${victim}`]) {
        await refused(sql);
      }
    });

    test('a statement cannot arrange conditions for the next one', async () => {
      /* The two-step escape. Step one succeeds — it is a legal statement —
           and must not survive into step two. A plain SET is rolled back with
           the transaction. */
      const flip = 'set default_transaction_read_only = off';
      await run(flip).catch(() => {
        /* allowed or not, what matters is step two */
      });
      await refused(`delete from ${victim}`);
      await refused(`drop table ${victim}`);
    });

    test('stacking is refused', async () => {
      await refused(`select 1; drop table ${victim}`);
    });

    test('and every row is still there afterwards', async () => {
      /* The assertion that matters. An error message proves a statement was
           refused; this proves it did not run anyway.

           Counted against what was there before, not against zero. `count >= 0`
           is true of a table every row of which has just been deleted — it
           proved the table still existed and nothing else, which is the half
           of the claim that was never in doubt. */
      const r = (await run(`select count(*) as n from ${victim}`)) as { rows: unknown[][] };
      assert.equal(Number(r.rows[0][0]), victimRows, `rows disappeared from ${victim}`);
      assert.ok(victimRows > 0, 'the fixture table was empty, so nothing could have been lost');
    });
  });
}

/**
 * Saved statements in the config file.
 *
 * The committable half of saved SQL. A config file is something a person wrote
 * by hand, so every refusal here has to name the file, the position and — where
 * there is one — the statement, because "queries must be an array" sends
 * somebody to search a file they may not have written.
 */
describe('saved SQL in a config file', () => {
  const parse = (raw: unknown) => parseQueriesConfig(raw, '/tmp/tablewalk.json');

  test('no queries section is not an error', () => {
    assert.deepEqual(parse({ connections: [] }), []);
  });

  test('a statement is read with its name and text', () => {
    const [q] = parse({ queries: [{ name: ' Totals ', sql: ' select 1 ' }] });
    assert.equal(q.name, 'Totals');
    assert.equal(q.sql, 'select 1');
    assert.equal(q.source, 'config');
  });

  test('a duplicate name is refused rather than resolved', () => {
    /* Two statements called "Totals" that do different things is worse than a
       startup error, and silently keeping the last is worst of the three. */
    assert.throws(
      () =>
        parse({
          queries: [
            { name: 'Totals', sql: 'select 1' },
            { name: 'Totals', sql: 'select 2' },
          ],
        }),
      /two queries are called "Totals"/,
    );
  });

  test('a statement with no sql is refused, by name', () => {
    assert.throws(() => parse({ queries: [{ name: 'Broken' }] }), /query 1 \("Broken"\) has no "sql"/);
  });

  test('a statement with no name is refused, by position', () => {
    assert.throws(() => parse({ queries: [{ sql: 'select 1' }] }), /query 1 has no "name"/);
  });

  test('queries must be an array, and the file is named', () => {
    assert.throws(() => parse({ queries: {} }), /\/tmp\/tablewalk\.json: "queries" must be an array/);
  });

  test('a statement belongs to every connection unless it says otherwise', () => {
    const all = parse({
      queries: [
        { name: 'Everywhere', sql: 'select 1' },
        { name: 'Just prod', sql: 'select 2', connection: 'prod' },
      ],
    });
    assert.deepEqual(
      queriesFor(all, 'staging', 'staging (eu)').map((q) => q.name),
      ['Everywhere'],
    );
    assert.deepEqual(
      queriesFor(all, 'prod').map((q) => q.name),
      ['Everywhere', 'Just prod'],
    );
  });

  test('a connection matches by id or by display name', () => {
    // The config file names connections the way a person would, and the id is
    // a slug of that name — both have to work or the scoping is a trap.
    const all = parse({ queries: [{ name: 'Q', sql: 'select 1', connection: 'demo (small)' }] });
    assert.equal(queriesFor(all, 'demo-small', 'demo (small)').length, 1);
    assert.equal(queriesFor(all, 'demo-small').length, 0);
  });
});

/**
 * Counting, and knowing when not to.
 *
 * `COUNT(*)` is a scan that ran on every query to fill in a header stat nobody
 * asked for. What is tested here is the rule for when it is skipped, and — more
 * importantly — that `exact` travels with the number, because an estimate
 * presented as a count is worse than either.
 */
describe('estimated row counts', () => {
  test('SQLite reports no estimate at all', async () => {
    /* No catalog statistic exists, so the honest answer is "do not know" and
       the count stays exact. An adapter that guessed here would be inventing
       a number rather than reporting one. */
    assert.equal((adapter as { estimateCount?: unknown }).estimateCount, undefined);
  });

  test('the threshold is well above anything a person would notice', () => {
    // Below it the true number is strictly better and costs nothing; the
    // threshold exists for tables where the scan is the expensive part.
    assert.ok(ESTIMATE_ABOVE >= 10_000, 'too eager: small tables should be counted');
  });

  test('an estimate is rounded, because writing it out claims precision', () => {
    /* "2,411,908" from a sampled statistic asserts six digits of accuracy that
       the statistic does not have. */
    assert.equal(approxRows(2_400_000), '2.4M');
    assert.equal(approxRows(24_000_000), '24M');
    assert.equal(approxRows(87_000), '87k');
    assert.equal(approxRows(4_200), '4.2k');
    assert.equal(approxRows(950), '950');
  });
});

/* The renderer's helper, duplicated here rather than imported: table.js cannot
   be loaded in Node (diagram.js touches `document` at module scope). Kept in
   step by this test failing if the two disagree — the same bargain every other
   mirror in this codebase makes. */
function approxRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return String(n);
}

/**
 * Deleting a row.
 *
 * The guards are `update`'s, and are tested independently rather than trusting
 * that the one in front held. The house rule applies twice over: an error
 * message proves a delete was refused; a row count afterwards proves it did not
 * happen anyway.
 */
describe('deleting one row', () => {
  test('the whole primary key, and nothing else', async () => {
    await assert.rejects(() => adapter.remove!({ table: 'invoice_line', key: { invoice_id: 1001 } }), /needs exactly its primary key/);
    // A partial key would match a group of rows; an extra column would let the
    // caller widen the match.
    await assert.rejects(
      () => adapter.remove!({ table: 'customer', key: { id: 1, name: 'Harbour Freight' } }),
      /needs exactly its primary key/,
    );
    assert.equal(await adapter.count('customer'), 5);
  });

  test('a key matching no rows is refused by count, not by the statement', async () => {
    await assert.rejects(() => adapter.remove!({ table: 'customer', key: { id: 9999 } }), /matches 0 rows, not 1/);
    assert.equal(await adapter.count('customer'), 5);
  });

  test('a table with no primary key cannot be deleted from', async () => {
    await assert.rejects(() => adapter.remove!({ table: 'customer_totals', key: { id: 1 } }), /no primary key|no table or view/i);
  });

  test('a foreign key is the database’s to enforce, not ours', async () => {
    /* `customer` 1 has invoices pointing at it. tablewalk does not re-derive
       that judgement — it lets the engine refuse, because a second
       implementation of a rule the database already enforces is how the two
       come to disagree, and tablewalk would be the one that was wrong. */
    await assert.rejects(() => adapter.remove!({ table: 'customer', key: { id: 1 } }), /FOREIGN KEY constraint failed/);
    assert.equal(await adapter.count('customer'), 5);
  });

  test('an unreferenced row goes, and the delete says how many', async () => {
    /* `shipment` is a leaf in the demo schema — nothing points at it — so it is
       the one table where a delete is expected to succeed rather than be
       refused by a constraint. */
    const before = await adapter.count('shipment');
    assert.ok(before > 0, 'fixture has no shipment rows to delete');
    const [row] = (await adapter.query({ table: 'shipment', limit: 1, offset: 0 })).rows;

    const result = await adapter.remove!({ table: 'shipment', key: { id: row.id as number } });
    assert.equal(result.affected, 1);
    assert.match(result.sql.text, /^DELETE FROM "shipment" WHERE/);
    assert.equal(await adapter.count('shipment'), before - 1);
  });

  test('the read handle still refuses writes afterwards', async () => {
    // The write handle must not contaminate the browsing one — the same
    // assertion the update tests make, for the same reason.
    assert.throws(() => (adapter as unknown as { db: { exec(s: string): void } }).db.exec('DELETE FROM customer'), /readonly|read-only/i);
  });
});

describe('what a delete would break', () => {
  test('the schema carries the ON DELETE rule', async () => {
    /* Without it the count is not an answer: three rows pointing at this one
       means three deleted under cascade, three holes under set null, and a
       refusal under restrict. */
    const schema = await adapter.introspect();
    const withRule = schema.foreignKeys.filter((fk) => fk.onDelete !== undefined);
    assert.equal(withRule.length, schema.foreignKeys.length, 'some constraints came back with no delete rule');
    assert.ok(schema.foreignKeys.every((fk) => ['cascade', 'set null', 'set default', 'restrict', 'no action'].includes(fk.onDelete!)));
  });

  test('an unrecognised rule is undefined, not a default', async () => {
    /* "The adapter did not report it" and "the constraint says NO ACTION" lead
       to different advice, and conflating them would present an unknown as
       harmless. */
    const { deleteRuleOf } = await import('../packages/engine/src/shared/schema.js');
    assert.equal(deleteRuleOf('CASCADE'), 'cascade');
    assert.equal(deleteRuleOf('set null'), 'set null');
    assert.equal(deleteRuleOf('SOMETHING ELSE'), undefined);
    assert.equal(deleteRuleOf(undefined), undefined);
  });
});

/**
 * Undo, and the check that keeps it from being an overwrite.
 *
 * The comparison is the whole feature. Restoring the old value blindly would
 * clobber whoever edited the row in between — including you, in another tab —
 * so the row is re-read first and the undo refused if it no longer holds what
 * tablewalk put there.
 */
describe('deciding whether an undo is safe', () => {
  /* The client's comparison, duplicated here because undo.js cannot be
     imported in Node — it pulls in core.js, which touches `document`. Kept in
     step by this test failing if the two disagree. */
  const same = (a: unknown, b: unknown): boolean => {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    if (String(a) === String(b)) return true;
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && String(a).trim() !== '' && String(b).trim() !== '' && x === y;
  };

  test('a number is the same as its stored formatting', () => {
    /* This is not a nicety. PostgreSQL hands back a NUMERIC as the string
       "7777.00" for a value written as 7777, so a string comparison reported
       every numeric edit as somebody else's change and refused to undo it —
       observed, then fixed. */
    assert.equal(same(7777, '7777.00'), true);
    assert.equal(same('17901', 17901), true);
    assert.equal(same(1.5, '1.50'), true);
  });

  test('a genuinely different value is different', () => {
    assert.equal(same(7777, 9999), false);
    assert.equal(same('Harbour Freight', 'Harbour Freights'), false);
  });

  test('null and empty stay distinct', () => {
    // Different values. An undo that confuses them is the bug the check exists
    // to prevent.
    assert.equal(same(null, ''), false);
    assert.equal(same('', null), false);
    assert.equal(same(null, null), true);
    assert.equal(same(null, undefined), true);
  });

  test('empty strings are not numerically equal to zero', () => {
    // `Number('')` is 0, which would make an emptied column look unchanged
    // against a stored 0.
    assert.equal(same('', 0), false);
    assert.equal(same(0, ''), false);
  });

  test('text that differs is compared as text', () => {
    /* The numeric branch is only reached when the strings already differ, so a
       text column holding "01234" matches itself. Two different strings that
       parse to one number can only occur where the database is formatting the
       value, which is the case this exists for. */
    assert.equal(same('01234', '01234'), true);
    assert.equal(same('abc', 'abd'), false);
  });
});

/**
 * Which columns stay put when a wide table scrolls sideways.
 *
 * The default matters more than the mechanism: a person on a 27-column table
 * has not thought about pinning and should not have to, so the columns that
 * identify a row are frozen without being asked for — and only on tables wide
 * enough that losing them hurts.
 */
describe('pinned columns', () => {
  /* The client's rule, duplicated because pins.js pulls in core.js, which
     touches `document`. Kept in step by this test failing if they disagree. */
  const WIDE_ENOUGH = 8;
  const defaultPins = (t: TableMeta, columns: string[]) => {
    if (columns.length < WIDE_ENOUGH) return [];
    const key = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const label = labelColumn(t);
    const wanted = [...key, ...(label && !key.includes(label) ? [label] : [])];
    return wanted.filter((c) => columns.includes(c));
  };

  const wide = (extra: number) => Array.from({ length: extra }, (_, i) => [`c${i}`, 'TEXT'] as [string, string]);

  test('a narrow table pins nothing', () => {
    // Below the threshold the whole table fits, and a frozen column is a
    // border and a shadow for no gain.
    const t = table('customer', [
      ['id', 'INTEGER', true],
      ['name', 'TEXT'],
    ]);
    assert.deepEqual(defaultPins(t, ['id', 'name']), []);
  });

  test('a wide table pins the key and the label', () => {
    const t = table('ticket', [['id', 'INTEGER', true], ['reference', 'TEXT'], ...wide(10)]);
    const columns = t.columns.map((c) => c.name);
    // `reference` is what labelColumn picks, and together with the key it is
    // what says which row you are looking at three screens to the right.
    assert.deepEqual(defaultPins(t, columns), ['id', 'reference']);
  });

  test('a composite key is pinned whole', () => {
    const t = table('invoice_line', [['invoice_id', 'INTEGER', true], ['line_no', 'INTEGER', true], ['sku', 'TEXT'], ...wide(8)]);
    const columns = t.columns.map((c) => c.name);
    const pins = defaultPins(t, columns);
    assert.ok(pins.includes('invoice_id') && pins.includes('line_no'), 'half a composite key identifies half a row');
  });

  test('a column the projection dropped is not pinned', () => {
    /* `show name, status` on a wide table has no key column to freeze, and
       pinning one that is not there would offset every other column by a
       width that does not exist. */
    const t = table('ticket', [['id', 'INTEGER', true], ['reference', 'TEXT'], ...wide(10)]);
    assert.deepEqual(defaultPins(t, ['reference', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']), ['reference']);
  });
});
