/**
 * Where the browser still reads the language on its own.
 *
 * This file was test/mirrors.test.ts: the client could not import the
 * TypeScript the server runs on, so a handful of rules — what a row is
 * called, what counts as a date, how a record's columns group — existed
 * twice, and every mirrored function was run on both sides over the same
 * fixture tables to keep the copies honest. The copies are gone. The client
 * imports src/shared now (vite.config.ts is what makes that runnable), and a
 * test that compares a function with itself proves nothing.
 *
 * What remains is the client code that is *not* a copy and still has to
 * agree with the server: the filter bar's chip splitter against the parser,
 * the composer's path walker against the resolver, the export rewrite and
 * the quoting rule against a real parse, the completer's date offer against
 * the shared date test, and deep links against the entries core builds.
 * Each is a client reading of a rule the server owns, compared by what the
 * two conclude — which is the only comparison that catches a drift.
 *
 * Some client modules call `document` while they load, so a stub stands in
 * — see `stubDom` below.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  labelColumn,
  looksLikeDate,
  type ColumnMeta,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from '../packages/engine/src/shared/schema.js';
import { parseViewQuery, tryResolvePath } from '../packages/engine/src/shared/view.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';

/* ---------- fixtures ----------

   One schema, reused by every case below, so a table added because it broke
   one reading is immediately in front of all the others. Each entry is a shape
   that has actually caused a disagreement:

     invoice        — its only text column is a date, which is what labelColumn's
                      guard exists for
     keyed          — nothing but key columns; every "pick a readable column"
                      rule has to fall back
     invoice_line   — a composite-key child, so hop names have to be joined
     work_order     — twenty-one columns, above the grouping threshold, with an
                      audit column, a self-reference and a text timestamp
     note           — eleven columns, one below the threshold
     customer_view  — a view, which is read-only and still has to be labelled
*/

const col = (name: string, type: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});

const key = (name: string, type = 'INTEGER'): ColumnMeta => col(name, type, { primaryKey: true, nullable: false });

const meta = (name: string, columns: ColumnMeta[], extra: Partial<TableMeta> = {}): TableMeta => ({
  id: name,
  name,
  schema: 'main',
  isView: false,
  columns,
  indexed: columns.filter((c) => c.primaryKey).map((c) => c.name),
  ...extra,
});

const reference = { table: 'customer', column: 'id' };

const TABLES: TableMeta[] = [
  meta('customer', [key('id'), col('name', 'TEXT'), col('country_code', 'CHAR(2)')]),

  // Every text column here is a date. Without the guard in labelColumn this
  // table's rows are named by `invoice_date`.
  meta('invoice', [
    key('id'),
    col('customer_id', 'INTEGER', { references: reference }),
    col('invoice_date', 'TEXT'),
    col('due_on', 'TEXT'),
    col('total', 'NUMERIC'),
  ]),

  meta('keyed', [key('left_id'), key('right_id')]),

  meta('invoice_line', [
    key('invoice_id'),
    key('line_no'),
    col('sku', 'VARCHAR(40)'),
    col('quantity', 'INTEGER'),
    // A column named after a clause word. Unusual, not rare, and the reason
    // the clause splitter carries a "followed by an operator" rule — without
    // it `limit not in (1, 2)` is read as a limit clause.
    col('limit', 'INTEGER'),
  ]),

  meta('note', [
    key('id'),
    col('body', 'TEXT'),
    col('author', 'TEXT'),
    col('created_at', 'TIMESTAMP'),
    col('kind', 'TEXT'),
    col('pinned', 'BOOLEAN'),
    col('sys_updated_by', 'TEXT'),
    col('etag', 'TEXT'),
    col('locale', 'CHAR(5)'),
    col('length', 'INTEGER'),
    col('slug', 'TEXT'),
  ]),

  meta('work_order', [
    key('id'),
    col('number', 'TEXT'),
    col('customer_id', 'INTEGER', { references: reference }),
    col('parent_id', 'INTEGER', { references: { table: 'work_order', column: 'id' } }),
    col('status', 'TEXT'),
    col('priority', 'INTEGER'),
    col('summary', 'TEXT'),
    col('opened_on', 'TEXT'),
    // A text column named for a timestamp: a date by name, not by type.
    col('event_timestamp', 'TEXT'),
    col('closed_at', 'TIMESTAMP'),
    col('created_at', 'TIMESTAMP'),
    col('sys_updated_at', 'TIMESTAMP'),
    col('sys_created_by', 'TEXT'),
    col('version', 'INTEGER'),
    col('estimate', 'NUMERIC'),
    col('actual', 'NUMERIC'),
    col('site', 'TEXT'),
    col('bay', 'TEXT'),
    col('notes', 'TEXT'),
    col('external_ref', 'uuid'),
    col('payload', 'json'),
  ]),

  meta('customer_view', [col('id', 'INTEGER'), col('name', 'TEXT')], { isView: true }),

  /* The party pattern: employee has no name of its own — its one text column
     is a date — and the name lives one to-one hop away on party. */
  meta('party', [key('id'), col('display_name', 'TEXT'), col('kind', 'TEXT')]),
  meta('employee', [
    key('id'),
    col('party_id', 'INTEGER', { references: { table: 'party', column: 'id' }, nullable: false }),
    col('hired_on', 'TEXT'),
    col('active', 'INTEGER'),
  ]),
];

const FOREIGN_KEYS: ForeignKey[] = [
  {
    name: 'invoice_customer_fk',
    from: { table: 'invoice', columns: ['customer_id'] },
    to: { table: 'customer', columns: ['id'] },
  },
  {
    name: 'line_invoice_fk',
    from: { table: 'invoice_line', columns: ['invoice_id'] },
    to: { table: 'invoice', columns: ['id'] },
  },
  {
    name: 'wo_customer_fk',
    from: { table: 'work_order', columns: ['customer_id'] },
    to: { table: 'customer', columns: ['id'] },
  },
  // A self-reference: the reason paths need a depth cap at all.
  {
    name: 'wo_parent_fk',
    from: { table: 'work_order', columns: ['parent_id'] },
    to: { table: 'work_order', columns: ['id'] },
  },
  // A composite key, whose hop has no single column to be named by.
  {
    name: 'note_line_fk',
    from: { table: 'note', columns: ['id', 'length'] },
    to: { table: 'invoice_line', columns: ['invoice_id', 'line_no'] },
  },
  {
    name: 'employee_party_fk',
    from: { table: 'employee', columns: ['party_id'] },
    to: { table: 'party', columns: ['id'] },
  },
];

const SCHEMA: DatabaseSchema = {
  label: 'fixtures',
  dialect: 'sqlite',
  tables: TABLES,
  foreignKeys: FOREIGN_KEYS,
  readAt: new Date(0).toISOString(),
};

/* ---------- loading the client ----------

   Some client modules call `document` while they load — the composer waits
   for the page before attaching itself. None of what is tested below touches
   the DOM, so the stub only has to be enough to get through the import;
   anything it does not answer throws rather than passing quietly. */

function stubDom() {
  const node = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    hidden: false,
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
    append() {},
    remove() {},
    setAttribute() {},
    replaceChildren() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  (globalThis as Record<string, unknown>).document = {
    readyState: 'complete',
    body: node(),
    addEventListener() {},
    removeEventListener() {},
    createElement: node,
    createElementNS: node,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  (globalThis as Record<string, unknown>).window = {
    localStorage: undefined,
    location: { hash: '', href: 'http://localhost/' },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
}

type Client = {
  core: typeof import('../packages/kit/src/client/core.js');
  composer: typeof import('../packages/kit/src/client/composer.js');
  complete: typeof import('../packages/tablewalk/src/client/complete.js');
  exports: typeof import('../packages/kit/src/client/export.js');
  deeplink: typeof import('../packages/kit/src/client/deeplink.js');
  clauses: typeof import('../packages/kit/src/client/clauses.js');
};

let client: Client;

before(async () => {
  stubDom();
  client = {
    core: await import('../packages/kit/src/client/core.js'),
    composer: await import('../packages/kit/src/client/composer.js'),
    complete: await import('../packages/tablewalk/src/client/complete.js'),
    exports: await import('../packages/kit/src/client/export.js'),
    deeplink: await import('../packages/kit/src/client/deeplink.js'),
    clauses: await import('../packages/kit/src/client/clauses.js'),
  };
  /* The client reads one schema out of a module-level `state` rather than
     taking it as an argument — it only ever has one connection open — so the
     fixtures are installed there and every client call below reads them. */
  client.core.state.schema = SCHEMA;
});

const named = (id: string) => TABLES.find((t) => t.id === id)!;

/* ---------- query.ts: where one condition ends ---------- */

describe('how many conditions a filter holds', () => {
  /* The filter bar draws one chip per condition, using the client's
     `splitConditions`; the server decides what a condition *is*, in
     `splitTopLevel`. When those two disagree the bar does not merely look
     wrong — each chip carries a dismiss button that rewrites the query by
     index, so a miscount edits the wrong thing.

     It happened: `hired_on between 2026-08-17 and 2026-08-27` drew as two
     chips, because the server had tracked `between`'s `and` since the day it
     shipped and this copy never had. Dismissing either produced
     `hired_on between 2026-08-17` — not a condition, and an error.

     Compared by what each side concludes rather than by their internals,
     which is the only comparison that would have caught it. */
  /* Columns this fixture's `work_order` actually has — a condition on an
     unknown column is dropped by the parser, which would make the counts
     differ for a reason that has nothing to do with splitting. */
  const filters = [
    'priority > 1',
    'priority > 1 and status = open',
    'status = open and priority > 1 and summary contains fix',
    // the one that broke
    'opened_on between 2026-08-17 and 2026-08-27',
    'opened_on between 2026-08-17 and 2026-08-27 and status = open',
    'status = open and opened_on between 2026-08-17 and 2026-08-27',
    'estimate between 10 and 20 and priority between 1 and 5',
    // `and` inside a quoted value
    'summary = "a and b"',
    'summary = "a and b" and status = open',
    /* And the value that *is* the keyword. This was the second drift of the
       same kind: the browser cut the condition at that `and` and kept
       `summary contains`, losing the value, while the server read it whole.
       (`contains and and …` is a different thing — ambiguous on both sides,
       and pinned as such below.) */
    'summary contains and',
  ];

  test('every chip the bar draws is a condition on its own', () => {
    /* The property that matters, and the one that broke. A chip is not a
       label: it carries a dismiss button that rewrites the query, so each one
       has to be a condition the parser accepts by itself. `AND 2026-08-27`
       was not, and dismissing its neighbour left the range's other half
       behind as the whole filter.

       Counting conditions instead would not work — `between` is written once
       and compiles to two comparisons, so the parser's count is not the
       number of things the reader wrote. */
    for (const filter of filters) {
      for (const chip of client.clauses.splitConditions(filter)) {
        const parsed = parseQuery(`work_order ${chip}`, { schema: SCHEMA });
        assert.deepEqual(parsed.errors, [], `chip ${JSON.stringify(chip)} out of ${JSON.stringify(filter)}`);
      }
    }
  });

  test('and a range is one condition, not two', () => {
    assert.deepEqual(client.clauses.splitConditions('opened_on between 2026-08-17 and 2026-08-27'), [
      'opened_on between 2026-08-17 and 2026-08-27',
    ]);
    assert.deepEqual(client.clauses.splitConditions('estimate between 10 and 20 and status = open'), [
      'estimate between 10 and 20',
      'status = open',
    ]);
  });

  test('and a keyword that is the value stays in its condition', () => {
    assert.deepEqual(client.clauses.splitConditions('summary contains and'), ['summary contains and']);
  });

  test('while `and and` is ambiguous, and both sides read it the same way', () => {
    /* `summary contains and and status = open` has no honest reading without
       quotes: the splitter takes the *first* `and` as the separator, leaving
       `summary contains` with no value. The server does exactly the same and
       reports "Could not read \"summary contains\"" — checked by hand against
       a live connection, not assumed.

       Asserted because agreement is the property this file exists to protect,
       and because the alternative — teaching one side to look ahead — would
       make the two disagree about a string neither can read. Quoting the
       value (`contains "and"`) is the answer, and it works today. */
    const chips = client.clauses.splitConditions('summary contains and and status = open');
    assert.deepEqual(chips, ['summary contains', 'status = open']);

    const parsed = parseQuery('work_order summary contains and and status = open', { schema: SCHEMA });
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].message, /Could not read "summary contains"/);
  });
});

/* ---------- schema.ts: what a breadcrumb calls a row ---------- */

describe('the breadcrumb', () => {
  test('names a row by the column the server would have used', () => {
    /* rowLabel has no counterpart in shared/schema.ts — the server never
       renders a breadcrumb — so what is checked is the invariant that makes it
       correct: the text in the crumb is the value of the column the shared
       labelColumn picks, and falls back to the key when that value is empty.
       This is the assertion that failed while the client had its own
       labelColumn and that copy was reading dates. */
    const rows: Array<[string, Record<string, unknown>, string]> = [
      ['customer', { id: 4, name: 'Acme', country_code: 'AU' }, 'Acme'],
      ['invoice', { id: 1004, invoice_date: '2025-03-14', due_on: '2025-04-14' }, '1004'],
      // Nothing readable at all: the label column *is* a key column.
      ['keyed', { left_id: 1, right_id: 2 }, '1'],
      // And when even that is empty, the whole key, joined — a crumb reading
      // "(row)" would be a step in the trail you cannot recognise.
      ['keyed', { left_id: null, right_id: 2 }, '2'],
      ['customer', { id: 7, name: '' }, '7'],
      ['customer', { id: 7, name: null }, '7'],
    ];
    for (const [id, row, expected] of rows) {
      const table = named(id);
      assert.equal(client.core.rowLabel(table, row), expected, `${id} crumb`);

      const label = labelColumn(table);
      const value = label === undefined ? undefined : row[label];
      if (value !== null && value !== undefined && String(value) !== '') {
        assert.equal(client.core.rowLabel(table, row), String(value), `${id} uses the shared label column`);
      }
    }
  });

  test('walks to a name one identity hop away', () => {
    assert.equal(client.core.rowLabel(named('employee'), { id: 3, hired_on: '2024-01-01', 'party_id.display_name': 'Ada' }), 'Ada');
  });
});

/* ---------- view.ts: the composer's path walker ---------- */

describe('the composer', () => {
  test('resolves a path to the same final column the server does', () => {
    /* columnAt is deliberately stricter than resolvePath: it matches the
       column name exactly where the server also accepts a case-insensitive
       match, and it does not enforce the depth cap because the composer never
       offers a path past it. Both differences can only withhold a suggestion
       the server would have accepted, never propose one it would refuse — so
       the comparison is over paths where neither difference applies, and the
       two that do are asserted below rather than left implicit. */
    const paths = [
      'status',
      'customer_id.name',
      'parent_id.summary',
      'parent_id.customer_id.name',
      'id+length.sku',
      'customer_id.nope',
      'nope.name',
      'summary.name',
    ];
    for (const path of paths) {
      const mine = client.composer.columnAt('work_order', path) as ColumnMeta | null;
      const theirs = tryResolvePath(SCHEMA, 'work_order', path).resolved?.column ?? null;
      assert.equal(mine?.name ?? null, theirs?.name ?? null, `columnAt("${path}")`);
    }

    // The two documented asymmetries, pinned so a change to either is visible.
    assert.equal(client.composer.columnAt('work_order', 'STATUS'), null);
    assert.equal(tryResolvePath(SCHEMA, 'work_order', 'STATUS').resolved?.column.name, 'status');
    const deep = 'parent_id.parent_id.parent_id.parent_id.parent_id.status';
    assert.equal((client.composer.columnAt('work_order', deep) as ColumnMeta | null)?.name, 'status');
    assert.ok(tryResolvePath(SCHEMA, 'work_order', deep).error);
  });
});

/* ---------- query.ts: the export rewrite and the completer ---------- */

describe('the client readings of the query language', () => {
  test('rewriting the shown columns leaves the parsed query otherwise identical', () => {
    /* export.js carries its own CLAUSE_RE and its own rule that makes a
       clause word a column name instead. Rather than compare the regexes —
       which is how two copies come to look right and behave differently — the
       rewrite is put through the real parser: the filter, sort and limit must
       survive it untouched, and the column list must be exactly what was
       asked for. */
    const queries: Array<[string, string[]]> = [
      ['customer', ['id', 'name']],
      ['customer name contains a', ['id', 'name']],
      ['customer show name, country_code', ['id', 'name']],
      ['customer name contains a sort name limit 5', ['id', 'name']],
      ['customer name contains "show me" sort name', ['id', 'name']],
      ['invoice total > 10 order by total desc', ['id', 'total']],
      // A column literally named like a clause word, which is the whole reason
      // the "followed by an operator" rule exists on both sides.
      ['note slug = show', ['id', 'kind']],
      ['note kind in (show, sort)', ['id', 'kind']],
      ['note kind not in (show, sort)', ['id', 'kind']],
      ['invoice_line limit not in (1, 2)', ['sku', 'quantity']],
      ['invoice_line limit = 3 sort sku', ['sku', 'quantity']],
    ];
    for (const [query, names] of queries) {
      const before = parseQuery(query, { schema: SCHEMA });
      assert.ok(before.query, `fixture "${query}" does not parse: ${before.errors.map((e) => e.message)}`);
      const rewritten = client.exports.withColumns(query, names);
      const after = parseQuery(rewritten, { schema: SCHEMA });
      assert.ok(after.query, `"${rewritten}" no longer parses`);
      assert.deepEqual(after.query!.filter, before.query!.filter, `filter changed by "${query}"`);
      assert.deepEqual(after.query!.orderBy, before.query!.orderBy, `sort changed by "${query}"`);
      assert.equal(after.query!.limit, before.query!.limit, `limit changed by "${query}"`);
      assert.deepEqual(after.query!.columns, names, `columns wrong for "${query}"`);
    }
  });

  test('a column named after a clause word survives "not in"', () => {
    /* The one place the browser's copy was ahead of the shared original.
       export.js listed `not in` among the operators that turn a clause word
       back into a column name; shared/query.ts listed every other operator and
       not that one, so `limit not in (1, 2)` on a table with a column called
       `limit` was read as a limit clause and the condition disappeared —
       no error, an empty filter, and a full table returned as though it had
       matched. Fixed in shared/query.ts, and pinned here because a regex is
       exactly the kind of thing that gets rewritten from memory. */
    const parsed = parseQuery('invoice_line limit not in (1, 2)', { schema: SCHEMA });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.query!.filter.groups, [
      [
        { column: 'limit', op: '!=', value: 1 },
        { column: 'limit', op: '!=', value: 2 },
      ],
    ]);
  });

  test('the completer offers relative dates on exactly the date columns', () => {
    /* End to end through the suggester rather than at its date test, because
       the copy that had drifted was inside it. Every column of the wide
       fixture is typed into the bar and the suggestions inspected: an offer of
       `= last 30 days` has to line up with what shared/schema.ts calls a date,
       column by column. */
    for (const column of named('work_order').columns) {
      const text = `work_order ${column.name} `;
      const suggestions = client.complete.suggestionsFor(text, text.length) as Array<{ detail: string }>;
      const offersDates = suggestions.some((s) => s.detail === 'date range');
      assert.equal(
        offersDates,
        looksLikeDate(column),
        `work_order.${column.name} (${column.type}): completer ${offersDates ? 'offers' : 'withholds'} relative dates`,
      );
    }
  });
});

describe('the completer offers the rows that point here as the parser reads them', () => {
  /* `customer any …`: the tables offered after `any` are the ones the parser
     finds a reference from, `via` only where it needs one, and after `where`
     the child's own columns — never the record's, which the parser would
     refuse inside the child's condition. */
  const offered = (text: string) => (client.complete.suggestionsFor(text, text.length) as Array<{ value: string }>).map((s) => s.value);
  test('after any, the tables that point here; then where; then their columns', () => {
    const children = offered('customer any ');
    assert.deepEqual([...children].sort(), ['invoice', 'work_order']);
    for (const child of children) assert.deepEqual(parseViewQuery(SCHEMA, 'customer', `any ${child}`).errors, [], child);
    assert.deepEqual(offered('customer any invoice '), ['where']);
    const columns = offered('customer any invoice where ');
    assert.ok(columns.includes('total') && !columns.includes('name'), columns.join(', '));
    assert.deepEqual(parseViewQuery(SCHEMA, 'customer', `any invoice where ${columns[0]} is empty`).errors, []);
    // Out of the child's condition, the record's own columns again.
    assert.ok(offered('customer any invoice where total > 5 and ').includes('name'));
  });
});

/* ---------- the quoting round trip ---------- */

describe('a value the client quotes is the value the server binds', () => {
  /* The invariant that was missing, and its absence let three different
     quoting rules live in the client at once: `core.quote` and
     `composer.valueToText` escaped an embedded `"` as `\"`, `table.quoteValue`
     deleted it — and the server stripped the outer quotes without unescaping,
     so even the two that agreed produced a filter that matched nothing.

     Asserted through a real parse rather than against a copy of the unquoter,
     because a copy is how this class of bug is born. */
  const nasty = [
    'plain',
    'two words',
    'Harbour "HQ"',
    "O'Brien",
    'both " and \' quotes',
    'ends with a backslash \\',
    'a \\" backslash-quote pair',
    'comma, separated',
    'sort limit show',
    '= not a comparison',
    '  leading and trailing  ',
    'unicode — dash',
    '',
  ];

  for (const value of nasty) {
    test(`round trip: ${JSON.stringify(value)}`, () => {
      const query = `customer name = ${client.core.quote(value)}`;
      const parsed = parseQuery(query, { schema: SCHEMA });
      assert.ok(parsed.query, `"${query}" did not parse: ${parsed.errors.map((e) => e.message)}`);
      const condition = parsed.query!.filter!.groups[0][0];
      assert.equal(condition.value, value, `"${query}" bound the wrong value`);
    });
  }

  /* Every word the language gives a meaning to, inside a value and as the
     whole of one. `quote` used to leave any run of word characters, dots and
     hyphens bare, so a card photo's slug `2023-mazda-cx-5-select-lf1015` was
     refused for its `select` and every card on the page lost its picture; a
     row whose text was `me` or `today` would have matched the session or a
     date window instead of itself. Read with a session, so `me` has someone
     to mean. */
  const grammar = [
    'filter',
    'where',
    'show',
    'select',
    'sort',
    'order',
    'by',
    'limit',
    'and',
    'or',
    'not',
    'in',
    'is',
    'empty',
    'contains',
    'startswith',
    'endswith',
    'like',
    'between',
    'me',
    'today',
    'yesterday',
    'tomorrow',
    'asc',
    'desc',
    'true',
    'false',
    'yes',
    'no',
    'null',
    'id',
    'name',
  ];
  const shapes = (word: string) => [
    word,
    word.toUpperCase(),
    `2023-mazda-cx-5-${word}-lf1015`,
    `${word}-1`,
    `x-${word}`,
    `id.${word}`,
    `${word}.name`,
  ];
  test('a value carrying any word of the grammar reads back as itself, after = and inside in (…)', () => {
    const me = { email: 'someone@example.com' };
    for (const word of grammar) {
      for (const value of shapes(word)) {
        for (const query of [`customer name = ${client.core.quote(value)}`, `customer name in (${client.core.quote(value)}, other)`]) {
          const parsed = parseQuery(query, { schema: SCHEMA, me, now: new Date('2026-09-26T12:00:00Z') });
          assert.deepEqual(parsed.errors, [], `"${query}" was refused`);
          const [condition] = parsed.query!.filter.groups[0];
          assert.equal(parsed.query!.filter.groups[0].length, 1, `"${query}" read as more than one condition`);
          assert.deepEqual(
            condition.op === 'in' ? (condition.value as unknown[])[0] : condition.value,
            value,
            `"${query}" bound the wrong value`,
          );
        }
      }
    }
  });

  test('an embedded quote is escaped, not deleted', () => {
    /* `table.quoteValue` used to strip it: `Harbour "HQ"` became
       `"Harbour HQ"`, a filter for a customer that does not exist. Neither of
       the other two is exported, so the guard against them drifting apart
       again is the round trips above — every caller now uses this one
       function. */
    assert.equal(client.core.quote('Harbour "HQ"'), '"Harbour \\"HQ\\""');
    assert.equal(client.core.quote('trailing \\'), '"trailing \\\\"');
    assert.equal(client.core.quote('plain'), 'plain');
    assert.equal(client.core.quote('two words'), '"two words"');
  });
});

/* ---------- deep links, against the entries core builds ---------- */

describe('deep links', () => {
  test('build the same table view core does', () => {
    /* deeplink.js keeps its own `tableView` so it can import nothing and stay
       testable without a browser. It is compared through the round trip,
       since the copy itself is not exported: a hash written from core's entry
       must read back as the same entry. */
    const entry = client.core.tableView('invoice', 'invoice total > 10', 'rows');
    const hash = client.deeplink.hashFor('demo', [entry]);
    const back = client.deeplink.fromHash(hash, (id: string) => named(id)) as {
      stack: unknown[];
    };
    assert.deepEqual(back.stack, [entry]);

    // And a tab, which is the field the two copies could most easily disagree
    // about — core defaults it to 'rows', deeplink omits it when it is 'rows'.
    const diagram = client.core.tableView('invoice', 'invoice', 'diagram');
    assert.deepEqual(
      (
        client.deeplink.fromHash(client.deeplink.hashFor('demo', [diagram]), (id: string) => named(id)) as {
          stack: unknown[];
        }
      ).stack,
      [diagram],
    );
  });

  test('a query containing != survives the round trip', () => {
    /* The bug: `encodeURIComponent` leaves `!` alone — it is unreserved — and
       the parser found the tab with `lastIndexOf('!')`, so the `!` of `!=`
       was read as the separator. `invoice total != 0` came back as `invoice
       total ` with a tab of `%3D 0`: the condition silently gone, and a
       shared "unpaid invoices" link showing every invoice. Worse than a bad
       reload, `syncHash` re-stamps on every render, so the address bar was
       wrong for such a query even without one. */
    const entry = client.core.tableView('invoice', 'invoice total != 0', 'rows');
    const hash = client.deeplink.hashFor('demo', [entry]);
    assert.equal(hash.includes('!'), false, 'a literal ! survived into the hash');
    assert.deepEqual((client.deeplink.fromHash(hash, (id: string) => named(id)) as { stack: unknown[] }).stack, [entry]);
  });

  test('!= and a tab together still separate correctly', () => {
    const entry = client.core.tableView('invoice', 'invoice total != 0', 'diagram');
    assert.deepEqual(
      (
        client.deeplink.fromHash(client.deeplink.hashFor('demo', [entry]), (id: string) => named(id)) as {
          stack: unknown[];
        }
      ).stack,
      [entry],
    );
  });

  test('a link written before the fix still reads correctly', () => {
    /* Checking the suffix against the tabs that exist is what rescues the
       links already in people's bookmarks — and any link this app did not
       write. `%3D 0` is not a tab, so the segment has no tab and the whole of
       it is the query. */
    const stale = '#/demo/invoice%20total%20!=%200';
    const back = client.deeplink.fromHash(stale, (id: string) => named(id)) as {
      stack: Array<{ query: string; tab: string }>;
    };
    assert.equal(back.stack[0].query, 'invoice total != 0');
    assert.equal(back.stack[0].tab, 'rows');
  });

  test('a bang that is not a tab name is part of the query', () => {
    const entry = client.core.tableView('invoice', 'invoice reference != "a!b"', 'rows');
    assert.deepEqual(
      (
        client.deeplink.fromHash(client.deeplink.hashFor('demo', [entry]), (id: string) => named(id)) as {
          stack: unknown[];
        }
      ).stack,
      [entry],
    );
  });
});
