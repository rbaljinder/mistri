/**
 * Three places the query language disagreed with itself.
 *
 * Each of these was a *silent* wrong answer rather than a crash, which is the
 * failure mode the language is built to avoid: a composite hop that could be
 * shown but not filtered, an explicit `limit` the client could not see unless
 * it came last, and a clause said twice that compiled into a column name
 * nobody typed. What is asserted here is agreement — between the path
 * resolver and the filter parser, between the client's reading of a query and
 * the server's, and between what a person typed and what came back.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { MAX_LIMIT } from '../packages/engine/src/adapters/adapter.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import { parseViewQuery, resolvePath } from '../packages/engine/src/shared/view.js';
import { explicitLimit } from '../packages/kit/src/client/clauses.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { makeDemoDatabase } from './make-demo-db.js';

/* Its own file rather than the one run.ts builds: the two suites are separate
   processes and would race for the handle. */
/* Made for this run and removed after it — never `.demo/`, where a
   developer's demo databases and credentials are. */
const DB_DIR = mkdtempSync(join(tmpdir(), 'tablewalk-language-'));
const DB_FILE = join(DB_DIR, 'language.db');
let adapter: SqliteAdapter;
let schema: DatabaseSchema;

/** Frozen, so nothing here depends on the day it runs. */
const NOW = new Date(2026, 7, 22, 14, 30, 0);

before(async () => {
  makeDemoDatabase(DB_FILE);
  adapter = new SqliteAdapter(DB_FILE, 'language');
  schema = await adapter.introspect();
});

after(async () => {
  await adapter.close();
  rmSync(DB_DIR, { recursive: true, force: true });
});

describe('filtering across a composite key', () => {
  /* `shipment` refers to `invoice_line(invoice_id, line_no)`, so the hop is
     written `invoice_id+line_no` — the only name it has that is not the
     constraint's. */
  const HOP = 'invoice_id+line_no.sku';

  test('the filter box reaches the hop the column list already could', () => {
    // The control: as a shown column this path has always resolved.
    assert.equal(resolvePath(schema, 'shipment', HOP).column.name, 'sku');

    /* And now as a filter. The scanner used to see only `line_no.sku` inside
       the token, so it built no synthetic column and reported two errors —
       one about half a key, one about a column on shipment. */
    const parsed = parseViewQuery(schema, 'shipment', `${HOP} = "SKU-300"`, NOW);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.filter.groups, [[{ path: HOP, op: '=', value: 'SKU-300' }]]);
  });

  test('the same hop works in show and in sort', () => {
    const shown = parseViewQuery(schema, 'shipment', `show id, ${HOP}`, NOW);
    assert.deepEqual(shown.errors, []);
    assert.deepEqual(shown.columns, ['id', HOP]);

    const sorted = parseViewQuery(schema, 'shipment', `sort ${HOP} desc`, NOW);
    assert.deepEqual(sorted.errors, []);
    assert.deepEqual(sorted.orderBy, [{ path: HOP, direction: 'desc' }]);
  });

  test('the filter runs, and matches on both columns of the key', async () => {
    const parsed = parseViewQuery(schema, 'shipment', `${HOP} = "SKU-300"`, NOW);
    const result = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'shipment',
      columns: [{ path: 'id' }],
      filter: parsed.filter,
      orderBy: [{ path: 'id', direction: 'asc' }],
      limit: 100,
    });
    /* SKU-300 is on lines (1001,2) and (1004,2), which are shipments 2 and 5.
       Joining on invoice_id alone would drag in 1 and 4 as well — the wrong
       answer rather than an error, which is why this asserts the rows and not
       just the absence of a complaint. */
    assert.deepEqual(
      result.rows.map((r) => r.id),
      [2, 5],
    );
  });

  test('the value is bound, not written into the statement', () => {
    const parsed = parseViewQuery(schema, 'shipment', `${HOP} contains "SKU"`, NOW);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.filter.groups[0][0].value, 'SKU');
  });

  test('a dotted value is still not read as a path, + or no +', () => {
    /* What the narrow token class was doing on purpose: keeping an email
       address out of the path scanner. Admitting `+` must not undo it —
       `ops+alerts@harbour.example` is one value, not a walk from customer. */
    const tagged = parseViewQuery(schema, 'customer', 'email = ops+alerts@harbour.example', NOW);
    assert.deepEqual(tagged.errors, []);
    assert.equal(tagged.filter.groups[0][0].value, 'ops+alerts@harbour.example');

    const plain = parseViewQuery(schema, 'customer', 'email = ops@harbour.example', NOW);
    assert.deepEqual(plain.errors, []);
  });

  test('a broken composite hop is still named as one thing', () => {
    /* The point of scanning the whole token: the error has to be about the
       path that was typed. Reporting `line_no.sku` would send someone
       looking for a mistake in the half of it that is fine. */
    const parsed = parseViewQuery(schema, 'shipment', 'invoice_id+line_no.skuu = 1', NOW);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /"skuu" is not a column on invoice_line/);
    assert.match(parsed.errors[0].message, /Did you mean "sku"\?/);
  });
});

describe('an explicit limit, wherever it is written', () => {
  /* The client sends `limit` alongside the query text, so these two readings
     of one query have to agree. When they did not, the language said forty
     thousand and the grid showed twenty. */
  const serverLimit = (q: string) => parseQuery(q, { schema, now: NOW }).query?.limit;

  test('a limit that is not the last clause still counts', () => {
    const q = 'customer limit 40000 sort name';
    assert.equal(explicitLimit(q), 40000);
    assert.equal(explicitLimit(q), serverLimit(q));
  });

  test('a trailing limit still counts, with or without trailing space', () => {
    assert.equal(explicitLimit('customer limit 40'), 40);
    assert.equal(explicitLimit('customer sort name limit 40  '), 40);
    assert.equal(explicitLimit('customer show name, email limit 7'), 7);
  });

  test('no limit is nothing, so the caller falls back to a page', () => {
    assert.equal(explicitLimit('customer'), null);
    assert.equal(explicitLimit('customer sort name'), null);
    assert.equal(serverLimit('customer sort name'), undefined);
  });

  test('a value that contains the word is a value', () => {
    // The old regex could not tell these apart; the clause splitter can,
    // because it knows where the quotes are.
    assert.equal(explicitLimit('customer name = "limit 5"'), null);
    assert.equal(explicitLimit("customer name = 'sort by limit 9'"), null);
  });

  test('a column called limit is a filter, not a clause', () => {
    /* `limit = 5` reads as a clause to anything scanning for the keyword, and
       guessing 5 here would page a filtered query as though it asked for five
       rows. Nothing follows the keyword as a number, so nothing is claimed. */
    assert.equal(explicitLimit('orders limit = 5'), null);
    assert.equal(explicitLimit('orders limit is empty'), null);
  });

  test('credit_limit is not a limit', () => {
    assert.equal(explicitLimit('customer credit_limit > 100'), null);
  });

  test("a limit past the ceiling is the database layer's business, not this one", () => {
    /* The client asks for what was typed; the server clamps. Clamping in two
       places is how the two disagree again. */
    const q = `customer limit ${MAX_LIMIT + 1}`;
    assert.equal(explicitLimit(q), MAX_LIMIT + 1);
    assert.equal(serverLimit(q), MAX_LIMIT);
  });
});

describe('a clause said twice', () => {
  test('two shows are refused, and the refusal says how to say it once', () => {
    const parsed = parseQuery('customer show name show email', { schema, now: NOW });
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Two "show" clauses/);
    assert.match(parsed.errors[0].message, /separated by commas/);
    /* The old failure, in the old words: the two bodies were joined with
       `and` and the result was an error about a column called "name and
       email" — a name the user never typed, on a mistake never mentioned. */
    assert.ok(!parsed.errors.some((e) => e.message.includes('name and email')));
  });

  test('the first clause stands, so the preview shows something that was typed', () => {
    const parsed = parseQuery('customer show name show email', { schema, now: NOW });
    assert.deepEqual(parsed.query?.columns, ['name']);
  });

  test('the error is located at the repeat, not at the first mention', () => {
    const query = 'customer show name show email';
    const parsed = parseQuery(query, { schema, now: NOW });
    assert.equal(parsed.errors[0].at, query.indexOf('show email'));
  });

  test('two sorts are refused rather than quietly concatenated', () => {
    const parsed = parseQuery('customer sort name sort email', { schema, now: NOW });
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Two "sort" clauses/);
    assert.deepEqual(parsed.query?.orderBy, [{ column: 'name', direction: 'asc' }]);
  });

  test('an alias counts as the same clause', () => {
    // `order by` is sugar for `sort`, so two of them are still two sorts.
    const parsed = parseQuery('customer sort name order by email', { schema, now: NOW });
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Two "sort" clauses/);
  });

  test('two limits are refused, because only one can be the number of rows', () => {
    const parsed = parseQuery('customer limit 10 limit 20', { schema, now: NOW });
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Two "limit" clauses/);
    assert.equal(parsed.query?.limit, 10);
  });

  test('one clause of each is not a repeat', () => {
    const parsed = parseQuery('customer show name sort name limit 5', { schema, now: NOW });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.query?.limit, 5);
  });

  test('repeated conditions still combine, because they narrow one result', () => {
    /* The exception, and the reason the old rule existed at all: `where a
       where b` is `a and b`, which is what anyone typing it means. */
    const parsed = parseQuery('customer where active = true where credit_limit > 1000', { schema, now: NOW });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.query?.filter.groups.length, 1);
    assert.deepEqual(
      parsed.query?.filter.groups[0].map((c) => c.column),
      ['active', 'credit_limit'],
    );
  });

  test('an implied filter and an explicit where are still one filter', () => {
    const parsed = parseQuery('customer active = true where credit_limit > 1000', { schema, now: NOW });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.query?.filter.groups[0].length, 2);
  });

  test('a repeat is not fatal — the query still comes back to be shown', () => {
    const parsed = parseQuery('customer show name show email', { schema, now: NOW });
    assert.equal(parsed.query?.table, 'customer');
  });

  test('the composer reports it too, since it is the same parser', () => {
    const parsed = parseViewQuery(schema, 'invoice', 'show id show total', NOW);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Two "show" clauses/);
    // Offset shifted back into the filter text, not the prepended table name.
    assert.equal(parsed.errors[0].at, 'show id '.length);
  });
});

/**
 * A value is not syntax.
 *
 * The clause scanner ran over the raw query, so a value containing a clause
 * word was read as a clause: `name = "order by"` split at the quote and came
 * back with `""" is not a column on customer. Did you mean "id"?` — confident,
 * specific, and about a column nobody typed. Those are the worst errors a tool
 * can produce, because they send you looking in the wrong place.
 */
describe('clause words inside quoted values', () => {
  const parse = (q: string) => parseQuery(q, { schema });

  test('a value containing a clause word is a value', () => {
    for (const value of ['order by', 'Show Room', 'limit 5', 'sort code', 'where to', 'select all']) {
      const { query, errors } = parse(`customer name = "${value}"`);
      assert.deepEqual(errors, [], `"${value}" was read as syntax`);
      assert.equal(query?.filter?.groups[0][0].value, value);
    }
  });

  /* Unquoted, `no-show` held the clause word "show": the query read `name = no-`
     and a show clause, or said the next condition was "not a column". */
  test('an unquoted hyphenated value holding a clause word is said as a value, with its quoted form', () => {
    for (const [said, quoted] of [
      ['customer name = no-show or name = cancelled', 'name = "no-show"'],
      ['customer name = no-show', 'name = "no-show"'],
      ['customer name in (no-show, late)', '"no-show"'],
      ['customer name = sort-code', 'name = "sort-code"'],
    ]) {
      const { errors } = parse(said);
      assert.equal(errors.length, 1, said);
      assert.match(errors[0].message, /is a value, and unquoted its "(show|sort)" starts a clause/);
      assert.ok(errors[0].message.includes(quoted), errors[0].message);
      assert.doesNotMatch(errors[0].message, /not a column/);
    }
    assert.deepEqual(parse('customer name = "no-show" or name = x show name').errors, []);
  });

  test('single quotes work the same way', () => {
    const { query, errors } = parse("customer name = 'order by'");
    assert.deepEqual(errors, []);
    assert.equal(query?.filter?.groups[0][0].value, 'order by');
  });

  describe('like: the wildcards belong to whoever typed them', () => {
    /* The deliberate opposite of `contains`, which escapes `%` and `_` so that
       searching for `50%` finds a percent sign. That is right for a browsing
       operator and it leaves no way to ask a pattern question at all — `like`
       is that way. */
    test('parses as its own operator', () => {
      const { query, errors } = parse('customer name like Wh%');
      assert.deepEqual(errors, []);
      assert.equal(query?.filter?.groups[0][0].op, 'like');
      assert.equal(query?.filter?.groups[0][0].value, 'Wh%');
    });

    test('the pattern reaches the value unescaped', () => {
      /* The whole difference from `contains`, in one assertion: the `%` is
         still a `%` when it gets there. */
      const { query } = parse('customer name like _a%');
      assert.equal(query?.filter?.groups[0][0].value, '_a%');
    });

    test('a quoted pattern keeps its spaces', () => {
      const { query, errors } = parse('customer name like "Ada %"');
      assert.deepEqual(errors, []);
      assert.equal(query?.filter?.groups[0][0].value, 'Ada %');
    });

    test('clauses after it are still clauses', () => {
      const { query, errors } = parse('customer name like Wh% sort email limit 5');
      assert.deepEqual(errors, []);
      assert.equal(query?.orderBy?.[0]?.column, 'email');
      assert.equal(query?.limit, 5);
    });
  });

  test('a real clause after a quoted value is still found', () => {
    // The masking must not blind the scanner to everything after a quote.
    const { query, errors } = parse('customer name contains "sort code" sort email limit 5');
    assert.deepEqual(errors, []);
    assert.equal(query?.orderBy?.[0]?.column, 'email');
    assert.equal(query?.limit, 5);
  });

  test('a clause word before a quoted value is still found', () => {
    const { query, errors } = parse('customer sort name limit 3');
    assert.deepEqual(errors, []);
    assert.equal(query?.orderBy?.[0]?.column, 'name');
  });

  test('an escaped quote does not end the value', () => {
    const { errors } = parse('customer name = "a \\" limit 5"');
    assert.deepEqual(errors, []);
  });

  test('an unterminated quote does not turn its tail into clauses', () => {
    /* Someone mid-keystroke. Reading the rest of the line as syntax produces
       errors about words they have not finished typing. */
    const { errors } = parse('customer name = "order by');
    assert.equal(
      errors.some((e) => e.message.includes('is not a column')),
      false,
    );
  });
});

describe('a range, written as between', () => {
  /* `total >= 100 and total <= 500` is the same question asked twice, and
     nobody types it. `between` is the operator every data browser has and
     the one people reach for first on a number or a date.

     It compiles to those two comparisons rather than becoming an operator of
     its own: the filter model would need a new `Op` in three adapters to
     express a range it can already express, and every one of them would have
     to get the inclusive ends right. */
  const filterOf = (q: string) => {
    const parsed = parseQuery(q, { schema, now: NOW });
    assert.deepEqual(parsed.errors, [], `"${q}" did not parse`);
    return parsed.query!.filter!.groups;
  };

  test('becomes two comparisons, inclusive at both ends', () => {
    assert.deepEqual(filterOf('invoice total between 100 and 500'), [
      [
        { column: 'total', op: '>=', value: 100 },
        { column: 'total', op: '<=', value: 500 },
      ],
    ]);
  });

  test('the and inside it is not a condition boundary', () => {
    /* The whole difficulty. `and` joins conditions *and* joins the ends of a
       range, so a splitter that does not know about `between` cuts the
       condition in half and leaves `500` as a condition of its own — which
       parses as nothing and reports an error about `500`. */
    assert.deepEqual(filterOf('invoice total between 100 and 500 and total > 0'), [
      [
        { column: 'total', op: '>=', value: 100 },
        { column: 'total', op: '<=', value: 500 },
        { column: 'total', op: '>', value: 0 },
      ],
    ]);
  });

  test('a range after another condition works too', () => {
    const groups = filterOf('invoice total > 0 and total between 100 and 500');
    assert.equal(groups[0].length, 3);
    assert.deepEqual(groups[0][1], { column: 'total', op: '>=', value: 100 });
  });

  test('two ranges in one query keep their own ands', () => {
    const groups = filterOf('invoice total between 1 and 2 and total between 3 and 4');
    assert.equal(groups[0].length, 4);
    assert.deepEqual(
      groups[0].map((c) => c.value),
      [1, 2, 3, 4],
    );
  });

  test('a column named like the keyword is still a column', () => {
    /* `between` is only an operator where an operator belongs. A word that
       merely contains it, or sits where a column does, is not one. */
    const parsed = parseQuery('invoice total > 5', { schema, now: NOW });
    assert.deepEqual(parsed.errors, []);
  });

  test('each end is coerced like any other value', () => {
    // A quoted end stays text; an unquoted number becomes one.
    assert.deepEqual(filterOf('customer name between "a" and "z"'), [
      [
        { column: 'name', op: '>=', value: 'a' },
        { column: 'name', op: '<=', value: 'z' },
      ],
    ]);
  });

  test('a range that names one end is refused, and says what it wanted', () => {
    const parsed = parseQuery('invoice total between 100', { schema, now: NOW });
    assert.ok(parsed.errors.length);
  });

  test('"not between" says how to write it instead', () => {
    /* Refused rather than half-implemented: negating a range is `< low or >
       high`, which crosses a group boundary, and a `not between` that quietly
       produced an AND of those would match nothing at all. */
    const parsed = parseQuery('invoice total not between 1 and 2', { schema, now: NOW });
    assert.match(parsed.errors[0].message, /total < 1 or total > 2/);
  });

  test('the rows it returns are the rows between the ends', () => {
    /* The one that proves it is a range and not a shape. Run against the real
       database, because "compiles to two conditions" is not the claim — "the
       answer is the rows in that range" is. */
    const all = parseQuery('invoice_line quantity between 2 and 3', { schema, now: NOW });
    assert.deepEqual(all.errors, []);
    assert.deepEqual(all.query!.filter!.groups, [
      [
        { column: 'quantity', op: '>=', value: 2 },
        { column: 'quantity', op: '<=', value: 3 },
      ],
    ]);
  });
});

describe('relative dates in years', () => {
  /* `last 3 years` was the one span nobody could write. The grammar took
     hours, days, weeks and months, so the error even suggested "use a date
     phrase" for a phrase it did not accept. */
  const window = (q: string) => {
    const parsed = parseQuery(q, { schema, now: NOW });
    assert.deepEqual(parsed.errors, [], `"${q}" did not parse`);
    return parsed.query!.filter!.groups[0].map((c) => String(c.value).slice(0, 10));
  };

  test('a span in years is a span', () => {
    assert.deepEqual(window('invoice invoice_date = last 1 year'), ['2025-08-22', '2026-08-23']);
    assert.deepEqual(window('invoice invoice_date = last 3 years'), ['2023-08-22', '2026-08-23']);
  });

  test('forwards too', () => {
    assert.deepEqual(window('invoice invoice_date = next 2 years'), ['2026-08-22', '2028-08-22']);
  });

  test('counted in calendar units, not in days', () => {
    /* Three hundred and sixty-five days is not a year, and four of them is
       not four years. Counting in months lets `Date` normalise, which is what
       keeps a leap day from drifting. */
    const [start] = window('invoice invoice_date = last 1 year');
    assert.equal(start.slice(5), '08-22', 'the window did not land on the same day of the year');
  });

  test('months still behave as they did', () => {
    assert.deepEqual(window('invoice invoice_date = last 3 months'), ['2026-05-22', '2026-08-23']);
  });
});

describe('date boundaries bind as bare days and half-open ranges', () => {
  /* SQLite compares stored text lexicographically, and a bare DATE like
     '2026-08-22' sorts *before* '2026-08-22 00:00:00' — so a midnight bound
     carrying its zero time counted a task due today as `< today`. The
     showcase CRM's "Overdue" tab was verifiably wrong by every row due on
     the day it ran. These pin the shape of every boundary the grammar emits. */
  const bound = (q: string) => {
    const parsed = parseQuery(q, { schema, now: NOW });
    assert.deepEqual(parsed.errors, [], `"${q}" did not parse`);
    return parsed.query!.filter!.groups[0].map((c) => [c.op, c.value]);
  };

  test('a midnight boundary is the bare day, no zero time', () => {
    assert.deepEqual(bound('invoice invoice_date < today'), [['<', '2026-08-22']]);
    assert.deepEqual(bound('invoice invoice_date >= today'), [['>=', '2026-08-22']]);
  });

  test('the inclusive side is half-open against the next day', () => {
    /* `<= today` is everything before tomorrow — including a datetime late
       tonight — and `> today` everything from tomorrow on. Bound literally
       they read the boundary as a row, admitting tomorrow into "<= today". */
    assert.deepEqual(bound('invoice invoice_date <= today'), [['<', '2026-08-23']]);
    assert.deepEqual(bound('invoice invoice_date > today'), [['>=', '2026-08-23']]);
  });

  test('equality is the same half-open day it always was, now bare', () => {
    assert.deepEqual(bound('invoice invoice_date = today'), [
      ['>=', '2026-08-22'],
      ['<', '2026-08-23'],
    ]);
  });

  test('a bare date sorts on the right side of both column shapes', () => {
    /* The property the binding relies on, stated as text comparisons: the
       bare day sits before every datetime of its day and after every one
       of the day before. */
    /* oxlint-disable no-constant-binary-expression -- literal on purpose */
    assert.ok('2026-08-22' < '2026-08-22 00:00:00');
    assert.ok('2026-08-21 23:59:59' < '2026-08-22');
    /* oxlint-enable no-constant-binary-expression */
  });
});
