// test-package: shared — holds the database browser and the App framework to one rule (scripts/test-owners.mjs).
/**
 * The test suite, on `node:test`. No framework, because a tool whose pitch is
 * "one command, no setup" should not need four dev dependencies to test.
 *
 * The suite runs against a real SQLite file built from source at startup, so
 * the adapter is exercised against an actual database rather than a mock of
 * one. Postgres coverage is opt-in through TABLEWALK_TEST_PG, since requiring
 * a running server to test a SQLite feature would be a bad trade.
 */
/* The suite must never touch the developer's real keychain — a locked one
   hangs it, an unlocked one collects test entries. Secrets go to the 0600
   file here, which is the same property asserted either way. */
process.env.MISTRI_NO_KEYCHAIN = '1';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
/* The credentials file falls back to the config home, and with no keychain
   (above) that is where a stored secret lands: never the developer's own. */
const configHome = mkdtempSync(join(tmpdir(), 'tablewalk-core-config-'));
process.env.XDG_CONFIG_HOME = configHome;
after(() => rmSync(configHome, { recursive: true, force: true }));
import { Registry, redact, loadConfig, saveConfig, storeSecret } from '../packages/engine/src/server/connections.js';
import { configLocations } from '../packages/engine/src/server/config/locations.js';
import {
  credentialsPath,
  expandEnv,
  hasInlinePassword,
  keychainDelete,
  readCredentials,
  resolveConnection,
  writeCredential,
} from '../packages/engine/src/server/auth/credentials.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  buildWhere,
  ANSI_STYLE,
  POSTGRES_STYLE,
  clampLimit,
  clampOffset,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type Filter,
} from '../packages/engine/src/adapters/adapter.js';
import { parseQuery, explain, dateWindow, columnKind } from '../packages/engine/src/shared/query.js';
import { fromHash, hashFor } from '../packages/kit/src/client/deeplink.js';
import { composeFilter } from '../packages/kit/src/client/compose.js';
import { SORT_SCAN_BELOW, sortableFromHeader } from '../packages/kit/src/client/columns.js';
import { planColumn } from '../packages/kit/src/client/columns.js';
import { textToView, viewToTextWithSchema } from '../packages/engine/src/shared/viewtext.js';
import { compileBreakdown, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { breakdownToText, looksLikeBreakdown, sectionFromText, textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import {
  referencesTo,
  referencesFrom,
  labelColumn,
  primaryKey,
  findTable,
  coerceForColumn,
  renderDDL,
  looksLikeDate,
  isJsonType,
} from '../packages/engine/src/shared/schema.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import {
  MAX_PATH_DEPTH,
  PathError,
  compileView,
  compileViewCount,
  parseViewQuery,
  parseViewsConfig,
  resolvePath,
  validateView,
  type ViewDef,
} from '../packages/engine/src/shared/view.js';
import { deriveTemplate, fieldPaths, isEmpty, resolveLists } from '../packages/engine/src/shared/recordview.js';

/* Every file this suite makes lives here, made for this run and removed after
   it — never `.demo/`, where a developer's demo databases and credentials are. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'tablewalk-core-'));
const DB_FILE = join(SCRATCH, 'test.db');
let adapter: SqliteAdapter;
let schema: DatabaseSchema;
/** A seeded database, for the tables that only exist with bulk data. */
let bigAdapter: SqliteAdapter;
let bigSchema: DatabaseSchema;
const BIG_FILE = join(SCRATCH, 'test-big.db');

/** Frozen clock, so every relative-date assertion is exact. */
const NOW = new Date(2026, 7, 22, 14, 30, 0); // 22 August 2026, a Saturday

before(async () => {
  makeDemoDatabase(DB_FILE);
  adapter = new SqliteAdapter(DB_FILE, 'demo');
  schema = await adapter.introspect();

  makeDemoDatabase(BIG_FILE);
  seedDemoDatabase(BIG_FILE, { scale: 20, seed: 5 });
  bigAdapter = new SqliteAdapter(BIG_FILE, 'big');
  bigSchema = await bigAdapter.introspect();
});

after(async () => {
  await adapter.close();
  await bigAdapter.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('introspection', () => {
  test('finds every table and the view', () => {
    const names = schema.tables.map((t) => t.name).sort();
    assert.deepEqual(names, ['country', 'customer', 'customer_totals', 'employee', 'invoice', 'invoice_line', 'product', 'shipment']);
    assert.equal(findTable(schema, 'customer_totals')?.isView, true);
    assert.equal(findTable(schema, 'customer')?.isView, false);
  });

  test('reads column types, nullability and primary keys', () => {
    const customer = findTable(schema, 'customer')!;
    const email = customer.columns.find((c) => c.name === 'email')!;
    assert.equal(email.nullable, true);
    assert.equal(email.primaryKey, false);
    const id = customer.columns.find((c) => c.name === 'id')!;
    assert.equal(id.primaryKey, true);
    assert.equal(columnKind(id.type), 'number');
  });

  test('knows a JSON column by its declared type, and a jsonpath is not one', () => {
    for (const type of ['json', 'jsonb', 'JSON', ' jsonb[]']) assert.equal(isJsonType(type), true, type);
    for (const type of ['text', 'jsonpath', 'bytea', undefined]) assert.equal(isJsonType(type), false, String(type));
  });

  test('collapses a composite primary key in declaration order', () => {
    assert.deepEqual(primaryKey(findTable(schema, 'invoice_line')!), ['invoice_id', 'line_no']);
  });

  test('collapses a composite foreign key into one edge', () => {
    // PRAGMA reports one row per column; two rows for one key must not become
    // two keys, or the reverse-reference panel double-counts.
    const edges = referencesTo(schema, 'invoice_line');
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0].from.columns, ['invoice_id', 'line_no']);
    assert.deepEqual(edges[0].to.columns, ['invoice_id', 'line_no']);
  });

  test('handles a self-referencing key without confusing the directions', () => {
    const out = referencesFrom(schema, 'employee');
    const back = referencesTo(schema, 'employee');
    assert.ok(out.some((fk) => fk.to.table === 'employee'));
    assert.ok(back.some((fk) => fk.from.table === 'employee'));
    // `invoice.sold_by` points at employee too, so the reverse map has two.
    assert.ok(back.some((fk) => fk.from.table === 'invoice'));
  });

  test('reads the vocabulary a CHECK pins on a column', () => {
    const status = findTable(schema, 'invoice')!.columns.find((c) => c.name === 'status')!;
    assert.deepEqual(status.allowed, ['draft', 'issued', 'paid', 'void']);
    /* Absent, not empty: "unconstrained" and "we could not read it" must stay
       distinguishable to anything presenting this to a user. */
    assert.equal(findTable(schema, 'invoice')!.columns.find((c) => c.name === 'total')!.allowed, undefined);
  });

  test('does not name rows after a column with a vocabulary', () => {
    /* `status` is the first text column on invoice and reads like a name.
       Six hundred invoices called "issued" identify nothing. */
    assert.equal(labelColumn(findTable(schema, 'invoice')!), 'id');
  });

  test('picks a readable label column over the primary key', () => {
    assert.equal(labelColumn(findTable(schema, 'customer')!), 'name');
    assert.equal(labelColumn(findTable(schema, 'employee')!), 'first_name');
    /* No name-ish column and nothing but dates: the key wins. Two invoices
       raised the same day are indistinguishable by date, so labelling them
       by it looks plausible and identifies nothing. */
    assert.equal(labelColumn(findTable(schema, 'invoice')!), 'id');
    assert.equal(looksLikeDate(findTable(schema, 'invoice')!.columns.find((c) => c.name === 'invoice_date')!), true);
    // A text column that is genuinely text is still preferred over the key.
    assert.equal(labelColumn(findTable(schema, 'product')!), 'name');
    /* An identifier spelled with its noun names the row, even as the key:
       a shipment is its tracking number, not the first text column, which
       here is the carrier's id. */
    const shipment = {
      id: 'shipment',
      name: 'shipment',
      schema: '',
      isView: false,
      columns: [
        { name: 'tracking_number', type: 'text', nullable: false, primaryKey: true },
        { name: 'carrier_id', type: 'text', nullable: false, primaryKey: false },
        { name: 'origin_city', type: 'text', nullable: true, primaryKey: false },
      ],
    };
    assert.equal(labelColumn(shipment), 'tracking_number');
  });
});

describe('the WHERE builder', () => {
  test('binds every value as a parameter, never as text', () => {
    const filter: Filter = {
      groups: [[{ column: 'name', op: '=', value: "Bobby'); DROP TABLE customer;--" }]],
    };
    const { text, params } = buildWhere(filter, ANSI_STYLE);
    assert.equal(text, ' WHERE "name" = ?');
    assert.deepEqual(params, ["Bobby'); DROP TABLE customer;--"]);
    // The critical property: the value is nowhere in the SQL string.
    assert.ok(!text.includes('DROP'));
  });

  test('numbers Postgres placeholders across the whole clause', () => {
    const filter: Filter = {
      groups: [
        [
          { column: 'a', op: '=', value: 1 },
          { column: 'b', op: 'in', value: [2, 3] },
        ],
      ],
    };
    const { text, params } = buildWhere(filter, POSTGRES_STYLE);
    assert.equal(text, ' WHERE "a" = $1 AND "b" IN ($2, $3)');
    assert.deepEqual(params, [1, 2, 3]);
  });

  test('escapes a quote inside an identifier rather than breaking out', () => {
    assert.equal(ANSI_STYLE.quote('weird"name'), '"weird""name"');
  });

  test('an empty IN matches nothing instead of everything', () => {
    const { text, params } = buildWhere({ groups: [[{ column: 'a', op: 'in', value: [] }]] }, ANSI_STYLE);
    assert.equal(text, ' WHERE 1 = 0');
    assert.deepEqual(params, []);
  });

  test('OR groups are parenthesised so precedence survives', () => {
    const filter: Filter = {
      groups: [
        [
          { column: 'a', op: '=', value: 1 },
          { column: 'b', op: '=', value: 2 },
        ],
        [{ column: 'c', op: '=', value: 3 }],
      ],
    };
    const { text } = buildWhere(filter, ANSI_STYLE);
    assert.equal(text, ' WHERE ("a" = ? AND "b" = ?) OR ("c" = ?)');
  });
});

describe('the query language', () => {
  const parse = (input: string) => parseQuery(input, { schema, now: NOW });

  test('a bare table name is a valid query', () => {
    const { query, errors } = parse('customer');
    assert.deepEqual(errors, []);
    assert.equal(query?.table, 'customer');
    assert.deepEqual(query?.filter.groups, []);
  });

  test('reads an implied filter with no keyword', () => {
    const { query, errors } = parse('customer active = true');
    assert.deepEqual(errors, []);
    assert.deepEqual(query?.filter.groups, [[{ column: 'active', op: '=', value: 1 }]]);
  });

  test('coerces a boolean against the column type', () => {
    // `active` is INTEGER in SQLite, so `true` has to become 1 or it matches
    // nothing — the exact silent-empty-result failure worth guarding.
    const { query } = parse('customer active = true');
    assert.equal(query?.filter.groups[0][0].value, 1);
    const num = parse('customer credit_limit > 1000');
    assert.equal(num.query?.filter.groups[0][0].value, 1000);
    assert.equal(typeof num.query?.filter.groups[0][0].value, 'number');
  });

  test('and / or / parentheses flatten to OR-of-ANDs', () => {
    const { query, errors } = parse('customer (active = true or credit_limit > 5000) and country_code = AU');
    assert.deepEqual(errors, []);
    assert.deepEqual(query?.filter.groups, [
      [
        { column: 'active', op: '=', value: 1 },
        { column: 'country_code', op: '=', value: 'AU' },
      ],
      [
        { column: 'credit_limit', op: '>', value: 5000 },
        { column: 'country_code', op: '=', value: 'AU' },
      ],
    ]);
  });

  test('quotes protect a value containing the word and', () => {
    const { query, errors } = parse('customer name = "Barnes and Noble"');
    assert.deepEqual(errors, []);
    assert.equal(query?.filter.groups.length, 1);
    assert.equal(query?.filter.groups[0][0].value, 'Barnes and Noble');
  });

  test('an unquoted multi-word value is an error, not an empty result', () => {
    const { errors } = parse('customer name = Dry Creek');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /quote it/);
    /* The fix is shown whole, and a column that holds no dates is not offered a date phrase. */
    assert.match(errors[0].message, /name = "Dry Creek"/);
    assert.doesNotMatch(errors[0].message, /date phrase/);
  });

  test('a mistyped column is caught with a suggestion', () => {
    const { errors } = parse('customer contry_code = AU');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Did you mean "country_code"/);
  });

  test('a mistyped table is caught with a suggestion', () => {
    const { errors } = parse('custmer active = true');
    assert.match(errors[0].message, /Did you mean "customer"/);
  });

  test('is empty and is not empty become NULL checks', () => {
    assert.deepEqual(parse('customer email is empty').query?.filter.groups, [[{ column: 'email', op: 'isNull' }]]);
    assert.deepEqual(parse('customer email is not empty').query?.filter.groups, [[{ column: 'email', op: 'isNotNull' }]]);
  });

  test('a clause word used as a column name stays a column name', () => {
    /* The bug this exists for: `sort` eaten as a clause turned a filter into
       a nonsense ORDER BY with no error at all. */
    const local = {
      ...schema,
      tables: [
        ...schema.tables,
        {
          name: 'report',
          schema: '',
          id: 'report',
          isView: false,
          columns: [
            { name: 'filter', type: 'TEXT', nullable: true, primaryKey: false },
            { name: 'sort', type: 'TEXT', nullable: true, primaryKey: false },
          ],
        },
      ],
    };
    const { query, errors } = parseQuery('report sort is empty', { schema: local, now: NOW });
    assert.deepEqual(errors, []);
    assert.deepEqual(query?.orderBy, []);
    assert.deepEqual(query?.filter.groups, [[{ column: 'sort', op: 'isNull' }]]);
  });

  test('in takes a list, with or without brackets', () => {
    const bare = parse('customer country_code in AU, NZ');
    assert.deepEqual(bare.query?.filter.groups, [[{ column: 'country_code', op: 'in', value: ['AU', 'NZ'] }]]);
    const bracketed = parse('customer country_code in (AU, NZ)');
    assert.deepEqual(bracketed.query?.filter.groups, bare.query?.filter.groups);
  });

  test('not in expands to a chain of !=', () => {
    const { query } = parse('customer country_code not in (AU, NZ)');
    assert.deepEqual(query?.filter.groups, [
      [
        { column: 'country_code', op: '!=', value: 'AU' },
        { column: 'country_code', op: '!=', value: 'NZ' },
      ],
    ]);
  });

  test('a date phrase becomes two bound day boundaries, not a literal', () => {
    const { query, errors } = parse('invoice invoice_date = last 30 days');
    assert.deepEqual(errors, []);
    const [lower, upper] = query!.filter.groups[0];
    assert.equal(lower.op, '>=');
    /* Bare days, no zero time: '2026-08-23' sorts before '2026-08-23
       00:00:00', so the bare bound is the day boundary for DATE and
       DATETIME text columns alike — the suffixed form miscounted every
       bare-DATE row that sat exactly on the boundary. */
    assert.equal(lower.value, '2026-07-23');
    assert.equal(upper.op, '<');
    assert.equal(upper.value, '2026-08-23');
  });

  test('a date phrase with a comparison takes the right edge of the window', () => {
    const after = parse('invoice invoice_date >= this month');
    assert.equal(after.query?.filter.groups[0][0].value, '2026-08-01');
    const before = parse('invoice invoice_date < this month');
    assert.equal(before.query?.filter.groups[0][0].value, '2026-08-01');
    // The inclusive side is half-open against the next day; see language.test.ts.
    const upTo = parse('invoice invoice_date <= this month');
    assert.equal(upTo.query?.filter.groups[0][0].op, '<');
    assert.equal(upTo.query?.filter.groups[0][0].value, '2026-09-01');
  });

  test('a quarter is the calendar quarter: this, last and next, across the year on either side (G181)', () => {
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const span = (phrase: string, now: Date) => {
      const window = dateWindow(phrase, now)!;
      return [day(window.start), day(window.end)];
    };
    // 22 August: the third quarter, from July to the first of October.
    assert.deepEqual(span('this quarter', NOW), ['2026-07-01', '2026-10-01']);
    assert.deepEqual(span('last quarter', NOW), ['2026-04-01', '2026-07-01']);
    assert.deepEqual(span('next quarter', NOW), ['2026-10-01', '2027-01-01']);
    // The year's first day and its last: a quarter before January is last year's fourth, after December next year's first.
    const first = new Date(2026, 0, 1, 0, 0, 0),
      last = new Date(2026, 11, 31, 23, 59, 59);
    assert.deepEqual(span('this quarter', first), ['2026-01-01', '2026-04-01']);
    assert.deepEqual(span('last quarter', first), ['2025-10-01', '2026-01-01']);
    assert.deepEqual(span('next quarter', last), ['2027-01-01', '2027-04-01']);
    assert.deepEqual(span('this quarter', last), ['2026-10-01', '2027-01-01']);
    // A quarter's last day and the next one's first.
    assert.deepEqual(span('this quarter', new Date(2026, 2, 31, 12)), ['2026-01-01', '2026-04-01']);
    assert.deepEqual(span('this quarter', new Date(2026, 3, 1, 0)), ['2026-04-01', '2026-07-01']);
    // In a condition it is a range, as a month is, in any case.
    const { query, errors } = parse('invoice invoice_date = This Quarter');
    assert.deepEqual(errors, []);
    assert.deepEqual(query!.filter.groups[0], [
      { column: 'invoice_date', op: '>=', value: '2026-07-01' },
      { column: 'invoice_date', op: '<', value: '2026-10-01' },
    ]);
    assert.equal(parse('invoice invoice_date < next quarter').query!.filter.groups[0][0].value, '2026-10-01');
    // No quarter but these three: a number of them is not a phrase the language reads.
    assert.equal(dateWindow('previous quarter', NOW), undefined);
  });

  test('`previous N` is the window just before `last N`, the same length, by construction', () => {
    /* `last 30 days` runs from thirty days ago to tomorrow: 31 calendar
       days, today included. The compare a metric derives must be exactly
       as long, or every delta carries a bias — 1% at 90 days, 100% at one. */
    const day = 86_400_000;
    for (const [unit, n] of [
      ['day', 1],
      ['day', 30],
      ['week', 2],
      ['month', 3],
      ['year', 1],
      ['hour', 12],
    ] as const) {
      const last = dateWindow(`last ${n} ${unit}s`, NOW)!;
      const previous = dateWindow(`previous ${n} ${unit}s`, NOW)!;
      assert.equal(previous.end.getTime(), last.start.getTime(), `previous ${n} ${unit}s ends where last begins`);
      const lastDays = Math.round((last.end.getTime() - last.start.getTime()) / day);
      const prevDays = Math.round((previous.end.getTime() - previous.start.getTime()) / day);
      /* Calendar months differ in length, so a month window is measured in
         calendar terms: its span in months-and-a-day matches; in days it
         may differ by the month lengths crossed. Fixed units match exactly. */
      if (unit === 'month' || unit === 'year') assert.ok(Math.abs(lastDays - prevDays) <= 3, `${unit}: ${lastDays} vs ${prevDays}`);
      else assert.equal(prevDays, lastDays, `previous ${n} ${unit}s is as long as last ${n} ${unit}s`);
    }
    const q = parse('invoice invoice_date = previous 30 days');
    assert.deepEqual(q.errors, []);
    assert.equal(q.query?.filter.groups[0][0].op, '>=');
    assert.equal(q.query?.filter.groups[0][1].op, '<');
    assert.equal(q.query?.filter.groups[0][1].value, dateWindow('last 30 days', NOW)!.start.toISOString().slice(0, 10));
  });

  test('an integer past 2^53 is bound as text, never rounded', () => {
    /* Number('9007199254740993') is 9007199254740992: a different row, or
       none, with nothing about it that looks wrong. The digits go to the
       database whole and its own type does the comparison. */
    const { query, errors } = parse('customer id = 9007199254740993');
    assert.deepEqual(errors, []);
    assert.equal(query?.filter.groups[0][0].value, '9007199254740993');
    // A safe integer is still a number.
    assert.equal(parse('customer id = 42').query?.filter.groups[0][0].value, 42);
  });

  test('weeks start on Monday', () => {
    // NOW is a Saturday; "this week" must reach back to the 17th, not the 16th.
    const w = dateWindow('this week', NOW)!;
    assert.equal(w.start.getDate(), 17);
    assert.equal(w.start.getDay(), 1);
  });

  test('sort, show and limit', () => {
    const { query, errors } = parse('invoice total > 100 sort total desc show id, total limit 5');
    assert.deepEqual(errors, []);
    assert.deepEqual(query?.orderBy, [{ column: 'total', direction: 'desc' }]);
    assert.deepEqual(query?.columns, ['id', 'total']);
    assert.equal(query?.limit, 5);
  });

  test('where and order by are accepted as aliases', () => {
    const a = parse('invoice where total > 100 order by total desc');
    const b = parse('invoice filter total > 100 sort total desc');
    assert.deepEqual(a.query, b.query);
  });

  test('limit is capped rather than trusted', () => {
    assert.equal(parse('customer limit 99999').query?.limit, 99999);
    assert.equal(parse(`customer limit ${MAX_LIMIT + 1}`).query?.limit, MAX_LIMIT);
  });

  test('a runaway OR expansion is refused, not built', () => {
    const wide = Array.from({ length: 8 }, () => '(active = true or active = false)').join(' and ');
    const { errors } = parse(`customer ${wide}`);
    assert.match(errors[0].message, /OR branches/);
  });

  test('a wildcard typed into a search is a character, not a wildcard', () => {
    /* `contains 50%` is a search for a percent sign. Sent raw it matches
       every row in the table and reports a hit on data that does not contain
       the value — a wrong answer with nothing about it that looks wrong. */
    const { text, params } = buildWhere({ groups: [[{ column: 'name', op: 'contains', value: '50% a_b' }]] }, ANSI_STYLE);
    assert.equal(text, ' WHERE "name" LIKE ? ESCAPE \'#\'');
    assert.deepEqual(params, ['%50#% a#_b%']);

    /* And the escape character itself, or it would be the same bug one
       level down. */
    assert.deepEqual(buildWhere({ groups: [[{ column: 'n', op: 'startsWith', value: '#1' }]] }, ANSI_STYLE).params, ['##1%']);
  });

  test('the preview shows the statement that will actually run', () => {
    const { query } = parse('customer name contains 50%');
    assert.match(explain(query!), /name LIKE '%50#%%' ESCAPE '#'/);
  });

  test('explain renders SQL for reading, while the filter stays structured', () => {
    const { query } = parse('customer name contains freight and active = true');
    const sql = explain(query!);
    assert.match(sql, /FROM customer/);
    assert.match(sql, /name LIKE '%freight%'/);
    // The executable path still carries the value as data.
    assert.equal(query!.filter.groups[0][0].value, 'freight');
  });

  test('explain escapes a quote in a displayed value', () => {
    const { query } = parse(`customer name = "O'Brien"`);
    assert.match(explain(query!), /'O''Brien'/);
  });
});

describe('running queries', () => {
  test('a parsed query round-trips through the adapter', async () => {
    const { query } = parseQuery('customer active = true sort name limit 10', { schema, now: NOW });
    const result = await adapter.query({ ...query!, limit: query!.limit ?? 50, offset: 0 });
    assert.equal(result.rows.length, 4);
    assert.equal(result.rows[0].name, 'Dry Creek Vineyards');
    assert.ok(result.sql.text.includes('?'));
  });

  test('a date filter selects the right rows against real data', async () => {
    const { query } = parseQuery('invoice invoice_date = last year', { schema, now: NOW });
    const result = await adapter.query({ ...query!, limit: 50, offset: 0 });
    // 2025 invoices: 1001, 1002, 1003.
    assert.deepEqual(result.rows.map((r) => r.id).sort(), [1001, 1002, 1003]);
  });

  test('an injection attempt is data, not syntax', async () => {
    const { query } = parseQuery(`customer name = "'; DROP TABLE customer; --"`, { schema, now: NOW });
    const result = await adapter.query({ ...query!, limit: 50, offset: 0 });
    assert.equal(result.rows.length, 0);
    // The table is still there, which is the actual assertion.
    assert.equal(await adapter.count('customer'), 5);
  });

  test('an unknown table is rejected before it reaches a statement', async () => {
    await assert.rejects(() => adapter.query({ table: 'customer; DROP TABLE country', limit: 1, offset: 0 }), /No table or view called/);
  });

  test('the adapter is genuinely read-only', () => {
    assert.throws(
      // Reaching past the query API entirely still fails, because the handle
      // itself was opened read-only.
      () => (adapter as unknown as { db: { exec(s: string): void } }).db.exec('DELETE FROM customer'),
      /readonly|read-only/i,
    );
  });

  test('counting honours the filter', async () => {
    assert.equal(await adapter.count('customer'), 5);
    assert.equal(await adapter.count('customer', { groups: [[{ column: 'active', op: '=', value: 1 }]] }), 4);
  });

  test('limit is clamped inside the adapter too', async () => {
    const result = await adapter.query({ table: 'invoice_line', limit: 999_999_999, offset: 0 });
    assert.match(result.sql.text, /LIMIT \? OFFSET \?/);
    assert.equal(result.sql.params[0], MAX_LIMIT);
  });

  test('a query with no limit is still bounded', async () => {
    /* The property that matters: there is no way to reach the database
       without a LIMIT, including by forgetting to pass one. */
    const result = await adapter.query({ table: 'invoice_line', limit: undefined as never, offset: 0 });
    assert.match(result.sql.text, /LIMIT \? OFFSET \?/);
    assert.equal(result.sql.params[0], DEFAULT_LIMIT);
  });

  test('a nonsense limit becomes the default, not LIMIT NaN', async () => {
    // Number('abc') is NaN, and NaN survived Math.min/Math.max to reach SQL
    // as a literal before the clamp existed.
    const result = await adapter.query({ table: 'invoice_line', limit: 'abc' as never, offset: 'x' as never });
    assert.equal(result.sql.params[0], DEFAULT_LIMIT);
    assert.equal(result.sql.params[1], 0);
    assert.ok(result.rows.length > 0);
  });

  test('a view queries like a table', async () => {
    const result = await adapter.query({ table: 'customer_totals', limit: 10, offset: 0 });
    assert.equal(result.rows.length, 5);
    const dry = result.rows.find((r) => r.name === 'Dry Creek Vineyards')!;
    assert.equal(dry.invoices, 2);
  });
});

describe('reverse references', () => {
  /** What the /api/references endpoint computes, exercised directly. */
  async function countBack(tableId: string, key: Record<string, string | number>) {
    const out: Record<string, number> = {};
    for (const fk of referencesTo(schema, tableId)) {
      const conditions = fk.to.columns.map((toCol, i) => ({
        column: fk.from.columns[i],
        op: '=' as const,
        value: key[toCol],
      }));
      if (conditions.some((c) => c.value === undefined)) continue;
      out[fk.from.table] = await adapter.count(fk.from.table, { groups: [conditions] });
    }
    return out;
  }

  test('counts what points at one row', async () => {
    assert.deepEqual(await countBack('customer', { id: 1 }), { invoice: 2 });
    assert.deepEqual(await countBack('country', { code: 'AU' }), { customer: 2 });
  });

  test('a composite key matches on every column, not just the first', async () => {
    // Invoice 1001 has two lines and both shipped; line 1 alone has one.
    assert.deepEqual(await countBack('invoice_line', { invoice_id: 1001, line_no: 1 }), { shipment: 1 });
    assert.deepEqual(await countBack('invoice_line', { invoice_id: 1004, line_no: 3 }), { shipment: 0 });
  });

  test('a self-reference counts direct reports', async () => {
    const back = await countBack('employee', { id: 2 });
    assert.equal(back.employee, 2); // Rina and Tom report to Miles
    assert.equal(back.invoice, 0); // Miles sold nothing himself
  });
});

describe('writing', () => {
  /* The write path is the one place a bug destroys data rather than merely
     showing the wrong thing, so each guard is asserted independently rather
     than trusting that the one in front of it held. */

  test('an insert returns the row as stored, defaults and key included', async () => {
    const result = await adapter.insert!({ table: 'customer', values: { name: 'Inserted Ltd' } });
    /* The database's answer, not an echo of the request: the key it
       assigned, the defaults it filled. */
    assert.equal(typeof result.key.id, 'number');
    assert.equal(result.row!.name, 'Inserted Ltd');
    assert.equal(result.row!.active, 1, 'the declared default arrived');
    assert.equal(result.row!.credit_limit, 0);
    assert.equal(result.row!.email, null);
    assert.match(result.sql.text, /INSERT OR ABORT INTO "customer"/);

    const back = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: result.key.id as number }]] },
      limit: 1,
      offset: 0,
    });
    assert.equal(back.rows[0].name, 'Inserted Ltd');

    /* Removed again: the update tests below assert exact counts against the
       fixture, and a row this test leaked would fail them for reasons that
       have nothing to do with updating. */
    await adapter.remove!({ table: 'customer', key: { id: result.key.id as number } });
  });

  test('a supplied text key is the key, not a suggestion', async () => {
    const result = await adapter.insert!({ table: 'country', values: { code: 'TV', name: 'Tuvalu' } });
    assert.deepEqual(result.key, { code: 'TV' });
    await adapter.remove!({ table: 'country', key: { code: 'TV' } });
  });

  test('an insert refuses what the schema can already see is wrong', async () => {
    await assert.rejects(() => adapter.insert!({ table: 'customer', values: {} }), /NOT NULL constraint failed: customer.name/);
    await assert.rejects(() => adapter.insert!({ table: 'customer', values: { nonesuch: 'x' } }), /no column called "nonesuch"/);
    await assert.rejects(() => adapter.insert!({ table: 'customer', values: { name: null } }), /NOT NULL and cannot be null/);
  });

  test('what only the database can refuse is left to it, in its words', async () => {
    /* A duplicate key is a constraint, and the engine names it. Asserted as
       a thrown non-Refusal so the endpoint's "200 with errors" mapping has
       the shape it expects. */
    await assert.rejects(
      () => adapter.insert!({ table: 'country', values: { code: 'AU', name: 'Again' } }),
      /UNIQUE constraint failed: country.code/,
    );
  });

  test('a profile of a large table samples, says so, and stays representative', async () => {
    /* The limits are the test's, not production's: five hundred rows stand in
       for five million, because the point under test is the switch and the
       arithmetic, not the constant. Every k-th rowid rather than the first N
       — the id range proves the sample reached the far end of the table. */
    /* The nulls land on every tenth row on purpose: periodic data is the
       adversary of periodic sampling, and a bare `rowid % k` stride once
       sampled exactly the null pattern and reported a column entirely
       empty. The hashed stride this asserts against cannot resonate. */
    const write = new DatabaseSync(DB_FILE);
    write.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, bucket TEXT)');
    const put = write.prepare('INSERT INTO big (id, bucket) VALUES (?, ?)');
    for (let i = 1; i <= 500; i += 1) put.run(i, i % 10 === 0 ? null : `b${i % 3}`);
    write.close();
    await adapter.close();
    adapter = new SqliteAdapter(DB_FILE, 'demo');

    const profiled = await adapter.profile!('big', { scanAtMost: 100, sampleSize: 50 });
    assert.equal(profiled.source, 'sample');
    assert.equal(profiled.rows, 500, 'the whole table is still counted');
    assert.ok(profiled.sampled! >= 25 && profiled.sampled! <= 90, `sampled ${profiled.sampled}`);
    const id = profiled.columns.find((c) => c.column === 'id')!;
    assert.ok(Number(id.max) > 400, 'the sample reached the end of the table, not the first N');
    const bucket = profiled.columns.find((c) => c.column === 'bucket')!;
    assert.ok(bucket.nullFrac! < 0.35, `a tenth of rows are null, and the sample must not resonate into all or none: ${bucket.nullFrac}`);

    const small = await adapter.profile!('big', { scanAtMost: 1000 });
    assert.equal(small.source, 'scan');
    assert.equal(small.sampled, undefined);

    const drop = new DatabaseSync(DB_FILE);
    drop.exec('DROP TABLE big');
    drop.close();
    await adapter.close();
    adapter = new SqliteAdapter(DB_FILE, 'demo');
  });

  test('updates exactly one row and reports it', async () => {
    const before = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
      limit: 1,
      offset: 0,
    });
    assert.equal(before.rows[0].credit_limit, 5000);

    const result = await adapter.update({ table: 'customer', key: { id: 1 }, values: { credit_limit: 7500 } });
    assert.equal(result.affected, 1);
    // The new value is a bound parameter, not text in the statement.
    assert.match(result.sql.text, /SET "credit_limit" = \?/);
    assert.deepEqual(result.sql.params, [7500, 1]);

    const after = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
      limit: 1,
      offset: 0,
    });
    assert.equal(after.rows[0].credit_limit, 7500);
    // And nothing else moved.
    assert.equal(await adapter.count('customer', { groups: [[{ column: 'credit_limit', op: '=', value: 7500 }]] }), 1);
  });

  test('writes NULL as NULL, not as an empty string', async () => {
    await adapter.update({ table: 'customer', key: { id: 1 }, values: { email: null } });
    assert.equal(await adapter.count('customer', { groups: [[{ column: 'email', op: 'isNull' }]] }), 2);
  });

  test('refuses a key that is not the whole primary key', async () => {
    await assert.rejects(
      () => adapter.update({ table: 'invoice_line', key: { invoice_id: 1001 }, values: { quantity: 99 } }),
      /needs exactly its primary key \(invoice_id, line_no\)/,
    );
  });

  test('refuses a non-key column smuggled in as the key', async () => {
    /* The dangerous case: `active = 1` matches four rows. Without the
       key-shape check this would have been an UPDATE across all of them. */
    await assert.rejects(
      () => adapter.update({ table: 'customer', key: { active: 1 } as never, values: { credit_limit: 0 } }),
      /needs exactly its primary key/,
    );
    assert.equal(await adapter.count('customer', { groups: [[{ column: 'credit_limit', op: '=', value: 0 }]] }), 1);
  });

  test('refuses to edit a primary key in place', async () => {
    await assert.rejects(() => adapter.update({ table: 'customer', key: { id: 1 }, values: { id: 999 } }), /part of the primary key/);
  });

  test('refuses a view as a view, as the Postgres adapter does, not as a table with no primary key', async () => {
    await assert.rejects(
      () => adapter.update({ table: 'customer_totals', key: { id: 1 }, values: { name: 'x' } }),
      /customer_totals is a view, so no single row can be identified/,
    );
  });

  test('refuses an unknown column', async () => {
    await assert.rejects(
      () => adapter.update({ table: 'customer', key: { id: 1 }, values: { nonesuch: 'x' } }),
      /no column called "nonesuch"/,
    );
  });

  test('refuses a key that matches no row', async () => {
    await assert.rejects(() => adapter.update({ table: 'customer', key: { id: 4242 }, values: { name: 'x' } }), /matches 0 rows, not 1/);
  });

  test('a composite key updates only the row it names', async () => {
    await adapter.update({ table: 'invoice_line', key: { invoice_id: 1001, line_no: 1 }, values: { quantity: 42 } });
    const rows = await adapter.query({
      table: 'invoice_line',
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

  test('the browsing connection stays read-only even after a write', () => {
    // The write goes through a second handle; the one every read uses must
    // still refuse, or "read-only browsing" was never true.
    assert.throws(() => (adapter as unknown as { db: { exec(s: string): void } }).db.exec('DELETE FROM customer'), /readonly|read-only/i);
  });
});

describe('the limit policy', () => {
  test('defaults when nothing usable is given', () => {
    for (const bad of [undefined, null, NaN, 'abc', {}, [], '']) {
      assert.equal(clampLimit(bad as never), DEFAULT_LIMIT, `clampLimit(${JSON.stringify(bad)})`);
    }
  });

  test('never exceeds the ceiling, however it is asked', () => {
    assert.equal(clampLimit(MAX_LIMIT + 1), MAX_LIMIT);
    assert.equal(clampLimit(Infinity), DEFAULT_LIMIT); // not finite: a default, not a ceiling
    assert.equal(clampLimit(1e12), MAX_LIMIT);
    assert.equal(clampLimit('250000'), MAX_LIMIT);
  });

  test('never drops below one, so a page always has room for a row', () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-5), 1);
    assert.equal(clampLimit(0.4), 1);
  });

  test('keeps a reasonable request intact', () => {
    assert.equal(clampLimit(20), 20);
    assert.equal(clampLimit(1500), 1500);
    assert.equal(clampLimit('75'), 75);
  });

  test('offsets are non-negative integers', () => {
    assert.equal(clampOffset(-1), 0);
    assert.equal(clampOffset(NaN), 0);
    assert.equal(clampOffset('abc'), 0);
    assert.equal(clampOffset(40), 40);
    assert.equal(clampOffset(7.9), 7);
  });

  test('the query language caps limit at the same ceiling', () => {
    const parse = (q: string) => parseQuery(q, { schema, now: NOW });
    assert.equal(parse('customer limit 999999999').query?.limit, MAX_LIMIT);
    assert.equal(parse('customer limit 20').query?.limit, 20);
    // No limit clause means the caller decides, not "unbounded".
    assert.equal(parse('customer').query?.limit, undefined);
  });
});

describe('connections', () => {
  /* A connection string is a credential. Everything the browser receives goes
     through the public view, so these tests are about what must NOT appear. */

  test('redaction keeps the password out, in every form', () => {
    assert.equal(redact('postgres://alice:hunter2@db.example.com:5432/appdb'), 'alice@db.example.com:5432/appdb');
    assert.equal(redact('postgres://bob@localhost/app'), 'bob@localhost/app');
    assert.equal(redact('postgres://localhost/app'), 'localhost/app');
    // Passwords with URL-significant characters must not slip through either.
    assert.ok(!redact('postgres://u:p%40ss%3Aword@h/db').includes('ss'));
    assert.ok(!redact('postgres://u:Ml12eHEz$p!H@host/db').includes('Ml12'));
  });

  test('a malformed URL redacts to nothing rather than falling through', () => {
    // The dangerous failure: a parse error returning the original string.
    const broken = 'postgres://user:secret@@@not a url';
    const shown = redact(broken);
    assert.ok(!shown.includes('secret'), `leaked: ${shown}`);
  });

  test('a file path shows its name, not the whole tree', () => {
    assert.equal(redact('/Users/someone/private/clients/acme.db'), 'acme.db');
    assert.equal(redact('.demo/demo.db'), 'demo.db');
  });

  test('the public view of a registry never carries a url', async () => {
    const registry = new Registry();
    registry.add({ name: 'secret one', url: 'postgres://u:topsecret@h/db', source: 'config' });
    registry.add({ name: 'demo', url: DB_FILE, source: 'config' });
    const json = JSON.stringify(registry.list());
    assert.ok(!json.includes('topsecret'), 'password reached the public view');
    assert.ok(!json.includes('postgres://'), 'raw url reached the public view');
    await registry.closeAll();
  });

  test('ids are unique even when names collide', () => {
    const registry = new Registry();
    const a = registry.add({ name: 'app', url: DB_FILE, source: 'config' });
    const b = registry.add({ name: 'app', url: DB_FILE, source: 'config' });
    assert.equal(a.id, 'app');
    assert.equal(b.id, 'app-2');
    // The first added becomes active, and adding a second must not steal it.
    assert.equal(registry.active, 'app');
  });

  test('connections stay closed until opened', async () => {
    const registry = new Registry();
    registry.add({ name: 'unreachable', url: 'postgres://nobody@127.0.0.1:1/none', source: 'config' });
    // Listing must not dial: a config naming eight databases should not mean
    // eight connection attempts at startup.
    assert.equal(registry.list()[0].connected, false);
    assert.equal(registry.list()[0].error, undefined);
    await registry.closeAll();
  });

  test('a failure is recorded and named, not swallowed', async () => {
    const registry = new Registry();
    registry.add({ name: 'missing', url: '/nonexistent/nope.db', source: 'config' });
    await assert.rejects(() => registry.open('missing'), /missing: /);
    // And the error survives on the entry so the sidebar can show it.
    assert.match(registry.list()[0].error ?? '', /.+/);
    await registry.closeAll();
  });

  test('opening twice reuses the connection', async () => {
    const registry = new Registry();
    registry.add({ name: 'demo', url: DB_FILE, source: 'config' });
    const first = await registry.open('demo');
    const second = await registry.open('demo');
    assert.equal(first.adapter, second.adapter, 'introspection ran twice');
    await registry.closeAll();
  });
});

describe('the config file', () => {
  const write = (name: string, body: string) => {
    const path = join(SCRATCH, name);
    writeFileSync(path, body);
    return path;
  };

  test('reads a valid file', async () => {
    const path = write('ok.json', JSON.stringify({ connections: [{ name: 'a', url: 'x.db' }] }));
    const loaded = await loadConfig(path, CONFIG_SECTIONS);
    assert.equal(loaded?.connections.length, 1);
    assert.equal(loaded?.connections[0].name, 'a');
  });

  test('a malformed file is an error, not a silent skip', async () => {
    /* Ignoring a config someone wrote is worse than refusing it: they would
       browse the wrong database and never know why their entry was missing. */
    const bad = write('bad.json', '{ not json');
    await assert.rejects(() => loadConfig(bad, CONFIG_SECTIONS), /not valid JSON/);

    const noArray = write('noarray.json', JSON.stringify({ connections: 'nope' }));
    await assert.rejects(() => loadConfig(noArray, CONFIG_SECTIONS), /needs a "connections" array/);

    const noUrl = write('nourl.json', JSON.stringify({ connections: [{ name: 'a' }] }));
    await assert.rejects(() => loadConfig(noUrl, CONFIG_SECTIONS), /has no "url"/);

    const noName = write('noname.json', JSON.stringify({ connections: [{ url: 'a.db' }] }));
    await assert.rejects(() => loadConfig(noName, CONFIG_SECTIONS), /has no "name"/);
  });

  test('a missing file is not an error when it was not asked for', async () => {
    assert.equal(await loadConfig(join(SCRATCH, 'absent.json'), CONFIG_SECTIONS).catch(() => 'threw'), 'threw');
    // But searching the default locations and finding nothing is fine.
    // Awaited: an un-awaited `doesNotReject` returns a promise nobody holds,
    // so the assertion floats free of the test and a failure here would have
    // surfaced as an unhandled rejection in whatever ran next.
    await assert.doesNotReject(() => loadConfig(undefined, CONFIG_SECTIONS));
  });
});

/**
 * The export serialisers.
 *
 * Loaded through a computed specifier because src/client is plain JavaScript
 * that the TypeScript programme deliberately does not include: a literal path
 * would be a compile error rather than a missing file. The serialisers take
 * columns and rows and return a string, so all of this runs without a DOM.
 */
const exportModule = await import(new URL('../packages/kit/src/client/export.js', import.meta.url).href);
const { csvField, toCsv, toJson } = exportModule;

/**
 * A minimal RFC 4180 reader, here only to prove the writer round-trips.
 *
 * Asserting on the exact bytes says the output looks right; parsing it back
 * says a spreadsheet will read the same values out — which is the property
 * that actually matters, and the one an off-by-one in the quoting breaks.
 * An unquoted empty field reads back as null, a quoted one as ''.
 */
function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let sawQuotes = false;
  let i = 0;
  const endField = () => {
    row.push(sawQuotes ? field : field === '' ? null : field);
    field = '';
    sawQuotes = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      sawQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      endField();
      rows.push(row);
      row = [];
      i += 2;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || sawQuotes || row.length) {
    endField();
    rows.push(row);
  }
  return rows;
}

describe('CSV export', () => {
  const one = (value: unknown) => csvField(value) as string;

  test('quotes a field containing a comma, a quote, a newline — or all three', () => {
    assert.equal(one('Harbour, Freight'), '"Harbour, Freight"');
    // Doubled, not backslash-escaped: RFC 4180 has no escape character.
    assert.equal(one('say "hi"'), '"say ""hi"""');
    assert.equal(one('line one\nline two'), '"line one\nline two"');
    // A lone CR splits a record just as surely as a CRLF does.
    assert.equal(one('line one\rline two'), '"line one\rline two"');
    assert.equal(one('a,"b"\nc'), '"a,""b""\nc"');
  });

  test('null and the empty string do not collapse into each other', () => {
    assert.equal(one(null), '');
    assert.equal(one(undefined), '');
    assert.equal(one(''), '""');

    const csv = toCsv(['a', 'b', 'c'], [{ a: null, b: '', c: 'x' }]) as string;
    assert.equal(csv, 'a,b,c\r\n,"",x\r\n');
    // And they survive being read back, which is the whole claim.
    assert.deepEqual(parseCsv(csv)[1], [null, '', 'x']);
  });

  test('a value a spreadsheet would run as a formula is neutralised', () => {
    // Prefixed with an apostrophe so Excel, Sheets and LibreOffice show the
    // text instead of evaluating it.
    assert.equal(one('=1+1'), "'=1+1");
    assert.equal(one('+1+1'), "'+1+1");
    assert.equal(one('-1+1'), "'-1+1");
    assert.equal(one('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(one("=cmd|' /c calc'!A1"), "'=cmd|' /c calc'!A1");
    // Prefixing and quoting are independent: this one needs both.
    assert.equal(one('=HYPERLINK("http://x","go")'), '"\'=HYPERLINK(""http://x"",""go"")"');
    // Leading tab and CR are skipped before the parse, so they hide a formula.
    assert.equal(one('\t=1+1'), "'\t=1+1");

    // But a negative number is a number. Prefixing every amount in a currency
    // column would corrupt the export to prevent nothing.
    assert.equal(one('-5'), '-5');
    assert.equal(one(-5), '-5');
    assert.equal(one('+1.5e3'), '+1.5e3');
    assert.equal(one(-0.25), '-0.25');
  });

  test('unicode and a very long value pass through unharmed', () => {
    assert.equal(one('Åsa Ødegård 北京 🌍'), 'Åsa Ødegård 北京 🌍');
    assert.equal(one('Ødegård, Åsa'), '"Ødegård, Åsa"');

    const long = 'x'.repeat(200_000);
    assert.equal(one(long), long);
    const longWithComma = `${'a'.repeat(100_000)},${'b'.repeat(100_000)}`;
    const written = one(longWithComma);
    assert.equal(written.length, longWithComma.length + 2);
    assert.deepEqual(parseCsv(`${written}\r\n`)[0], [longWithComma]);
  });

  test('an empty result set is headers and nothing else', () => {
    assert.equal(toCsv(['id', 'name'], []), 'id,name\r\n');
    assert.equal(toCsv(['id', 'name'], undefined), 'id,name\r\n');
    // A header is a field like any other and gets the same escaping.
    assert.equal(toCsv(['total, incl tax'], []), '"total, incl tax"\r\n');
  });

  test('rows are separated by CRLF and follow the column order given', () => {
    const csv = toCsv(
      ['b', 'a'],
      [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
    ) as string;
    assert.equal(csv, 'b,a\r\n2,1\r\n4,3\r\n');
    assert.equal(parseCsv(csv).length, 3);
  });

  test('non-string values are written as themselves, not as [object Object]', () => {
    assert.equal(one(0), '0');
    assert.equal(one(false), 'false');
    assert.equal(one(true), 'true');
    assert.equal(one({ tags: ['a', 'b'] }), '"{""tags"":[""a"",""b""]}"');
  });

  test('a column missing from a row is empty, not undefined', () => {
    assert.equal(toCsv(['a', 'b'], [{ a: 1 }]), 'a,b\r\n1,\r\n');
  });
});

describe('JSON export', () => {
  test('keeps null as null and the empty string as a string', () => {
    const text = toJson(['a', 'b'], [{ a: null, b: '' }]) as string;
    assert.deepEqual(JSON.parse(text), [{ a: null, b: '' }]);
  });

  test('every row carries every column, even one the row is missing', () => {
    // Left to JSON.stringify the key would vanish, and the JSON and CSV
    // exports of one result would disagree about the shape of a row.
    assert.deepEqual(JSON.parse(toJson(['a', 'b'], [{ a: 1 }]) as string), [{ a: 1, b: null }]);
  });

  test('an empty result set is an empty array', () => {
    assert.deepEqual(JSON.parse(toJson(['a'], []) as string), []);
  });

  test('unicode survives the round trip', () => {
    const value = 'Åsa Ødegård 北京 🌍';
    assert.deepEqual(JSON.parse(toJson(['n'], [{ n: value }]) as string), [{ n: value }]);
  });
});

describe('seeding', () => {
  /* Determinism is the point. The same scale must produce the same database,
     or a screenshot, a row count or a reported bug cannot be reproduced. */
  const A = join(SCRATCH, 'seed-a.db');
  const B = join(SCRATCH, 'seed-b.db');

  after(() => {
    rmSync(A, { force: true });
    rmSync(B, { force: true });
  });

  test('the same seed produces the same data', async () => {
    for (const file of [A, B]) {
      makeDemoDatabase(file);
      seedDemoDatabase(file, { scale: 40, seed: 7 });
    }
    const [a, b] = [new SqliteAdapter(A, 'a'), new SqliteAdapter(B, 'b')];
    const read = (adapter: SqliteAdapter) =>
      adapter.query({ table: 'customer', orderBy: [{ column: 'id', direction: 'asc' }], limit: 500, offset: 0 });
    const [rowsA, rowsB] = await Promise.all([read(a), read(b)]);
    assert.deepEqual(rowsA.rows, rowsB.rows);
    await Promise.all([a.close(), b.close()]);
  });

  test('a different seed produces different data', async () => {
    makeDemoDatabase(A);
    seedDemoDatabase(A, { scale: 40, seed: 7 });
    makeDemoDatabase(B);
    seedDemoDatabase(B, { scale: 40, seed: 8 });
    const [a, b] = [new SqliteAdapter(A, 'a'), new SqliteAdapter(B, 'b')];
    const read = (adapter: SqliteAdapter) =>
      adapter.query({ table: 'customer', orderBy: [{ column: 'id', direction: 'asc' }], limit: 500, offset: 0 });
    const [rowsA, rowsB] = await Promise.all([read(a), read(b)]);
    assert.notDeepEqual(rowsA.rows, rowsB.rows);
    await Promise.all([a.close(), b.close()]);
  });

  test('seeded data satisfies every foreign key', async () => {
    makeDemoDatabase(A);
    seedDemoDatabase(A, { scale: 60, seed: 3 });
    const db = new DatabaseSync(A, { readOnly: true });
    /* The generator picks manager_id from employees already inserted and
       customer_id from a live count, so a dangling reference means the
       generator is wrong rather than the data being merely odd. */
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(violations, [], `dangling references: ${JSON.stringify(violations).slice(0, 300)}`);
    db.close();
  });

  test('seeding leaves nulls to find', async () => {
    makeDemoDatabase(A);
    seedDemoDatabase(A, { scale: 200, seed: 11 });
    const a = new SqliteAdapter(A, 'a');
    // Null rendering and `is empty` need something to match, or the UI paths
    // that handle them are never exercised by the demo.
    assert.ok((await a.count('customer', { groups: [[{ column: 'email', op: 'isNull' }]] })) > 0);
    assert.ok((await a.count('customer', { groups: [[{ column: 'country_code', op: 'isNull' }]] })) > 0);
    assert.ok((await a.count('invoice', { groups: [[{ column: 'sold_by', op: 'isNull' }]] })) > 0);
    await a.close();
  });
});

describe('multi-column writes and type coercion', () => {
  test('several columns move in one statement', async () => {
    /* Three edits as three statements means three chances to fail half way,
       leaving a row in a state nobody asked for. */
    const result = await adapter.update({
      table: 'customer',
      key: { id: 3 },
      values: { name: 'Pennine Tools Ltd', credit_limit: 4500, active: 1 },
    });
    assert.equal(result.affected, 1);
    assert.equal((result.sql.text.match(/=\s*\?/g) ?? []).length, 4); // 3 SET + 1 WHERE
    assert.deepEqual(result.sql.params, ['Pennine Tools Ltd', 4500, 1, 3]);

    const after = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: 3 }]] },
      limit: 1,
      offset: 0,
    });
    assert.equal(after.rows[0].name, 'Pennine Tools Ltd');
    assert.equal(after.rows[0].credit_limit, 4500);
  });

  test('a string from a text box becomes a number for a numeric column', async () => {
    /* The bug this exists for: an <input> always yields a string, so editing
       a REAL column sent "17901" and stored text. SQLite's affinity usually
       rescues it and Postgres does not, but either way the stored value
       should be a number because the column says so. */
    const result = await adapter.update({
      table: 'customer',
      key: { id: 4 },
      values: { credit_limit: '8250.5' },
    });
    assert.equal(result.applied.credit_limit, 8250.5);
    assert.equal(typeof result.applied.credit_limit, 'number');
    assert.equal(typeof result.sql.params[0], 'number');

    const after = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: 4 }]] },
      limit: 1,
      offset: 0,
    });
    assert.equal(typeof after.rows[0].credit_limit, 'number');
  });

  test('unparseable input is passed through, not silently zeroed', () => {
    /* Storing 0 for "abc" gives the user a wrong number with no error; letting
       the database reject it gives them a real one. */
    assert.equal(coerceForColumn('REAL', 'abc'), 'abc');
    assert.equal(coerceForColumn('INTEGER', ''), null);
    assert.equal(coerceForColumn('INTEGER', '42'), 42);
    assert.equal(coerceForColumn('TEXT', '42'), '42');
    assert.equal(coerceForColumn('BOOLEAN', 'true'), true);
    assert.equal(coerceForColumn('BOOLEAN', 'no'), false);
    assert.equal(coerceForColumn('TEXT', null), null);
    // A number that arrives as a number is left alone.
    assert.equal(coerceForColumn('REAL', 12.5), 12.5);
  });

  test('emptying a NOT NULL column is refused before it reaches SQL', async () => {
    await assert.rejects(
      () => adapter.update({ table: 'customer', key: { id: 1 }, values: { name: null } }),
      /NOT NULL and cannot be emptied/,
    );
  });

  test('one bad column rejects the whole update, leaving nothing applied', async () => {
    const before = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: 5 }]] },
      limit: 1,
      offset: 0,
    });
    await assert.rejects(
      () =>
        adapter.update({
          table: 'customer',
          key: { id: 5 },
          values: { name: 'Changed', nonesuch: 'x' },
        }),
      /no column called "nonesuch"/,
    );
    // Validation happens before the statement is built, so the good column
    // must not have been written either.
    const after = await adapter.query({
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: '=', value: 5 }]] },
      limit: 1,
      offset: 0,
    });
    assert.equal(after.rows[0].name, before.rows[0].name);
  });

  test('an empty values object is refused', async () => {
    await assert.rejects(() => adapter.update({ table: 'customer', key: { id: 1 }, values: {} }), /Nothing to update/);
  });
});

describe('choosing export columns', () => {
  const { withColumns, orderColumns } = exportModule;
  const declared = ['id', 'name', 'email', 'active'];

  test('columns come out in declared order, whatever order they were ticked', () => {
    assert.deepEqual(orderColumns(['email', 'id', 'name'], declared), ['id', 'name', 'email']);
    // Two exports of one table should differ only where the data differs, so
    // the tick order must not reach the file.
    assert.deepEqual(orderColumns(['active', 'id'], declared), orderColumns(['id', 'active'], declared));
  });

  test('a duplicate is one column, and an unknown name sorts last', () => {
    assert.deepEqual(orderColumns(['name', 'name'], declared), ['name']);
    // A computed column on a view is not in the catalog but is still real.
    assert.deepEqual(orderColumns(['total', 'id'], declared), ['id', 'total']);
    assert.deepEqual(orderColumns(['b', 'a'], []), ['b', 'a']);
  });

  test('the chosen columns replace a show clause rather than joining it', () => {
    // Two `show` clauses concatenate in the parser as "email and name", which
    // is a column error rather than an export.
    assert.equal(withColumns('customer show email', ['id', 'name']), 'customer show id, name');
    assert.equal(withColumns('customer select email', ['id']), 'customer show id');
    assert.equal(withColumns('customer', ['id', 'name']), 'customer show id, name');
  });

  test('every other clause survives the rewrite', () => {
    assert.equal(
      withColumns('customer active = true show name sort name desc limit 50', ['id', 'name']),
      'customer active = true sort name desc limit 50 show id, name',
    );
    // And the rewritten text still parses to the columns asked for.
    const rewritten = withColumns('customer active = true show name sort name desc', ['id', 'email']);
    const parsed = parseQuery(rewritten, { schema, now: NOW });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.query?.columns, ['id', 'email']);
    assert.deepEqual(parsed.query?.orderBy, [{ column: 'name', direction: 'desc' }]);
    assert.equal(parsed.query?.filter.groups.length, 1);
  });

  test('an empty selection means every column, which is no show clause at all', () => {
    assert.equal(withColumns('customer show id, name', []), 'customer');
    assert.equal(withColumns('customer sort name show id', []), 'customer sort name');
  });

  test('a column called show is a filter, not a clause to cut from', () => {
    // The parser makes the same exception, and getting it wrong here would
    // silently drop the rest of the query from the export.
    assert.equal(withColumns('customer show = 3', ['id']), 'customer show = 3 show id');
  });

  test('a chosen column that is entirely null still gets its header', () => {
    // The reason a subset must be re-fetched rather than picked out of the
    // rows on screen: a column the query never selected is absent from every
    // row, and absent is not the same as empty.
    const rows = [
      { id: 1, email: null },
      { id: 2, email: null },
    ];
    assert.equal(toCsv(['id', 'email'], rows), 'id,email\r\n1,\r\n2,\r\n');
    assert.deepEqual(JSON.parse(toJson(['id', 'email'], rows) as string), rows);
  });

  test('the serialisers follow the column list, not the keys on the row', () => {
    const rows = [{ email: 'a@b.c', id: 7, name: 'Ann' }];
    assert.equal(toCsv(['id', 'name'], rows), 'id,name\r\n7,Ann\r\n');
    assert.deepEqual(JSON.parse(toJson(['id', 'name'], rows) as string), [{ id: 7, name: 'Ann' }]);
  });
});

/** The client's stack shape, for narrowing what the plain-JS module returns. */
type StackEntry = {
  kind: string;
  table: string;
  query?: string;
  tab?: string;
  key?: Record<string, string>;
  label?: string;
  /* A page entry carries the page it is of, and the root as text until the
     page resolves which column that value belongs to. */
  pageId?: string;
  rootBody?: string;
};

describe('deep links', () => {
  /* The URL is the navigation stack serialised, so these tests are really
     about one property: a link round-trips the whole walk, not just where it
     ended. Sending someone a dead end would defeat the point of the tool. */

  const find = (id: string) => findTable(schema, id);

  test('a table view round-trips', () => {
    const stack = [{ kind: 'table', table: 'customer', query: 'customer active = true', tab: 'rows' }];
    const hash = hashFor('demo', stack);
    const parsed = fromHash(hash, find) as { connection: string; stack: StackEntry[] };
    assert.equal(parsed?.connection, 'demo');
    assert.deepEqual(parsed?.stack, stack);
  });

  test('a whole walk round-trips, trail intact', () => {
    const stack = [
      { kind: 'table', table: 'customer', query: 'customer', tab: 'rows' },
      { kind: 'row', table: 'customer', key: { id: '1' }, label: '1' },
      { kind: 'table', table: 'invoice', query: 'invoice customer_id = 1', tab: 'rows' },
      { kind: 'row', table: 'invoice', key: { id: '1001' }, label: '1001' },
    ];
    const parsed = fromHash(hashFor('demo', stack), find) as { stack: StackEntry[] };
    assert.equal(parsed?.stack.length, 4);
    assert.deepEqual(
      parsed?.stack.map((e: { table: string }) => e.table),
      ['customer', 'customer', 'invoice', 'invoice'],
    );
    assert.deepEqual(parsed?.stack[3].key, { id: '1001' });
  });

  test('a composite key names its columns', () => {
    const stack = [
      { kind: 'table', table: 'invoice_line', query: 'invoice_line', tab: 'rows' },
      { kind: 'row', table: 'invoice_line', key: { invoice_id: '1001', line_no: '2' }, label: 'x' },
    ];
    const hash = hashFor('demo', stack);
    // Percent-encoded in the URL; what matters is that it decodes back.
    assert.match(decodeURIComponent(hash), /invoice_id=1001,line_no=2/);
    const parsed = fromHash(hash, find) as { stack: StackEntry[] };
    assert.deepEqual(parsed?.stack[1].key, { invoice_id: '1001', line_no: '2' });
  });

  test('a record link carries the related table it is open on', () => {
    /* The record view's rail is a tablist, and "look at its notes" is as
       worth sending on a record as it is on a page. */
    const stack = [
      { kind: 'table', table: 'invoice', query: 'invoice', tab: 'rows' },
      { kind: 'row', table: 'invoice', key: { id: '1001' }, label: 'INV-1001', tab: 'invoice_line_invoice_fk' },
    ];
    const parsed = fromHash(hashFor('demo', stack), find) as { stack: StackEntry[] };
    assert.deepEqual(parsed?.stack[1].key, { id: '1001' });
    assert.equal(parsed?.stack[1].tab, 'invoice_line_invoice_fk');
  });

  test('a key containing an exclamation mark is not read as a tab', () => {
    /* `encodeURIComponent` leaves `!` alone, so a value carrying one would
       write a second separator into its own segment — the same trap the
       query encoder already sidesteps. */
    const stack = [
      { kind: 'table', table: 'product', query: 'product', tab: 'rows' },
      { kind: 'row', table: 'product', key: { sku: 'SKU!42' }, label: 'x' },
    ];
    const parsed = fromHash(hashFor('demo', stack), find) as { stack: StackEntry[] };
    assert.deepEqual(parsed?.stack[1].key, { sku: 'SKU!42' });
    assert.equal(parsed?.stack[1].tab, undefined);
  });

  test('a page link carries the tab it is looking at, and the key beside it', () => {
    /* "Look at the parts tab" is a thing people send each other, and a link
       that always lands on the first tab loses the point of sending it. The
       tab rides with the page rather than after the key, because a key is
       arbitrary text and may contain a `!` while a page token never does. */
    const stack = [
      {
        kind: 'page',
        pageId: 'work-order-desk',
        table: 'work_order',
        key: { id: '1885' },
        label: 'WO-101885',
        tab: 'work_order_part',
      },
    ];
    const hash = hashFor('demo', stack);
    assert.match(decodeURIComponent(hash), /@work-order-desk!work_order_part~1885/);

    const parsed = fromHash(hash, find) as { stack: StackEntry[] };
    assert.equal(parsed?.stack[0].pageId, 'work-order-desk');
    assert.equal(parsed?.stack[0].tab, 'work_order_part');
    assert.equal(parsed?.stack[0].rootBody, '1885');
  });

  test('a page on its first tab writes no tab at all', () => {
    const hash = hashFor('demo', [{ kind: 'page', pageId: 'desk', table: 'x', key: { id: '2' }, label: '2' }]);
    assert.ok(!decodeURIComponent(hash).includes('!'), decodeURIComponent(hash));
  });

  test('a query with spaces, quotes and operators survives', () => {
    const query = 'customer name = "Barnes and Noble" and credit_limit > 500 sort name desc';
    const parsed = fromHash(hashFor('demo', [{ kind: 'table', table: 'customer', query, tab: 'rows' }]), find) as { stack: StackEntry[] };
    assert.equal(parsed?.stack[0].query, query);
  });

  test('a tab is carried, and rows is left implicit', () => {
    const withTab = hashFor('demo', [{ kind: 'table', table: 'customer', query: 'customer', tab: 'diagram' }]);
    assert.match(withTab, /!diagram$/);
    assert.equal((fromHash(withTab, find) as { stack: StackEntry[] })?.stack[0].tab, 'diagram');
    // The default tab adds nothing to the URL, keeping the common link short.
    const plain = hashFor('demo', [{ kind: 'table', table: 'customer', query: 'customer', tab: 'rows' }]);
    assert.ok(!plain.includes('!'));
    assert.equal((fromHash(plain, find) as { stack: StackEntry[] })?.stack[0].tab, 'rows');
  });

  test('a composer tab is read back, so a pasted link reopens the composer', () => {
    for (const tab of ['view', 'view:sales-by-country', `view+${encodeURIComponent('invoice show total').replace(/!/g, '%21')}`]) {
      const link = hashFor('demo', [{ kind: 'table', table: 'invoice', query: 'invoice', tab }]);
      const [entry] = (fromHash(link, find) as { stack: StackEntry[] }).stack;
      assert.deepEqual([entry.table, entry.query, entry.tab], ['invoice', 'invoice', tab], link);
    }
    // A question's own `!=` is still not a tab.
    assert.equal((fromHash('/demo/invoice%20status%20!%3D%20view', find) as { stack: StackEntry[] }).stack[0].tab, 'rows');
  });

  test('a row segment with no table before it is dropped, not guessed', () => {
    // Hand-edited or truncated URLs must degrade rather than throw.
    const parsed = fromHash('#/demo/~1001', find) as { stack: StackEntry[] };
    assert.deepEqual(parsed?.stack, []);
  });

  test('an unknown table is kept as typed rather than silently dropped', () => {
    /* The query still runs and produces a real "no table called…" error,
       which is more useful than a link that quietly opens something else. */
    const parsed = fromHash('#/demo/nosuchtable', find) as { stack: StackEntry[] };
    assert.equal(parsed?.stack[0].table, 'nosuchtable');
  });

  test('an empty or malformed hash restores nothing', () => {
    assert.equal(fromHash('', find), null);
    assert.equal(fromHash('#', find), null);
    assert.equal(fromHash('#/', find), null);
  });

  test('the App view that opened a list rides before its question, and a row read from it inherits it', () => {
    /* Two entries over one table ask the same question of the same rows; the
       entry's id is the only thing that says which room to draw. */
    const stack = [
      { kind: 'table', table: 'customer', query: 'customer active = true', tab: 'rows', view: 'inbox' },
      { kind: 'row', table: 'customer', key: { id: '1' }, label: '1', view: 'inbox' },
      { kind: 'row', table: 'customer', key: { id: '2' }, label: '2', view: 'inbox' },
    ];
    const hash = hashFor('demo', stack);
    assert.equal(hash, '/demo/inbox:customer%20active%20%3D%20true/~1/~2');
    const parsed = fromHash(hash, find) as { stack: Array<StackEntry & { view?: string }> };
    assert.deepEqual(
      parsed.stack.map((e) => [e.kind, e.table, e.query ?? e.key?.id, e.view]),
      [
        ['table', 'customer', 'customer active = true', 'inbox'],
        ['row', 'customer', '1', 'inbox'],
        ['row', 'customer', '2', 'inbox'],
      ],
    );
  });

  test('a link without a view key is read exactly as before, and a colon that is not one stays in the query', () => {
    const plain = fromHash('/demo/customer/~1', find) as { stack: Array<StackEntry & { view?: string }> };
    assert.equal('view' in plain.stack[0], false);
    assert.equal('view' in plain.stack[1], false);
    // Only an id followed by a table's name is an entry: the rest is typed text.
    const typed = fromHash('/demo/inbox:nosuchtable', find) as { stack: Array<StackEntry & { view?: string }> };
    assert.equal(typed.stack[0].query, 'inbox:nosuchtable');
    assert.equal('view' in typed.stack[0], false);
    // A row of another table does not inherit the list's entry.
    const across = fromHash('/demo/inbox:customer/~invoice:1001', find) as { stack: Array<StackEntry & { view?: string }> };
    assert.equal(across.stack[0].view, 'inbox');
    assert.equal('view' in across.stack[1], false);
    // An id outside the entry-id letters is never written into a link.
    assert.equal(
      hashFor('demo', [{ kind: 'table', table: 'customer', query: 'customer', tab: 'rows', view: 'Not An Id' }]),
      '/demo/customer',
    );
  });
});

describe('deep links across tables', () => {
  const find = (id: string) => findTable(schema, id);

  test('a row reached from another row names its table', () => {
    /* Following a foreign key puts two row entries in a row with different
       tables. Without the prefix the second one claims to belong to the
       first's table and the link restores the wrong row. */
    const stack = [
      { kind: 'table', table: 'invoice', query: 'invoice', tab: 'rows' },
      { kind: 'row', table: 'invoice', key: { id: '1001' }, label: '1001' },
      { kind: 'row', table: 'customer', key: { id: '1' }, label: '1' },
    ];
    const hash = hashFor('demo', stack);
    assert.match(decodeURIComponent(hash), /~customer:1$/);

    const parsed = fromHash(hash, find) as { stack: StackEntry[] };
    assert.equal(parsed.stack[1].table, 'invoice');
    assert.equal(parsed.stack[2].table, 'customer');
    assert.deepEqual(parsed.stack[2].key, { id: '1' });
  });

  test('the prefix is omitted when the table has not changed', () => {
    // The common case stays short: a row inside the table you were viewing.
    const hash = hashFor('demo', [
      { kind: 'table', table: 'customer', query: 'customer', tab: 'rows' },
      { kind: 'row', table: 'customer', key: { id: '1' }, label: '1' },
    ]);
    assert.match(hash, /~1$/);
    assert.equal((fromHash(hash, find) as { stack: StackEntry[] }).stack[1].table, 'customer');
  });

  test('a composite key is not mistaken for a table prefix', () => {
    /* `invoice_id=1001,line_no=2` contains no colon, but the check has to be
       robust to one appearing inside a value. */
    const hash = hashFor('demo', [
      { kind: 'table', table: 'invoice', query: 'invoice', tab: 'rows' },
      { kind: 'row', table: 'invoice_line', key: { invoice_id: '1001', line_no: '2' }, label: 'x' },
    ]);
    const parsed = fromHash(hash, find) as { stack: StackEntry[] };
    assert.equal(parsed.stack[1].table, 'invoice_line');
    assert.deepEqual(parsed.stack[1].key, { invoice_id: '1001', line_no: '2' });
  });

  test('a value containing a colon survives', () => {
    const hash = hashFor('demo', [
      { kind: 'table', table: 'customer', query: 'customer', tab: 'rows' },
      { kind: 'row', table: 'customer', key: { id: '12:30' }, label: 'x' },
    ]);
    const parsed = fromHash(hash, find) as { stack: StackEntry[] };
    assert.equal(parsed.stack[1].table, 'customer');
    assert.deepEqual(parsed.stack[1].key, { id: '12:30' });
  });
});

describe('DDL rendering', () => {
  test('a qualified name is two identifiers, not one with a dot', () => {
    /* Quoting "app.invoice_line" whole names a table that does not exist —
       valid SQL that looks right until it runs. SQLite has no schemas so this
       is only visible against Postgres, which is why it survived until the
       adapter was pointed at a real server. */
    const pg: DatabaseSchema = {
      label: 'pg',
      dialect: 'postgres',
      readAt: '',
      foreignKeys: [
        {
          name: 'line_invoice_fkey',
          from: { table: 'app.invoice_line', columns: ['invoice_id'] },
          to: { table: 'app.invoice', columns: ['id'] },
        },
      ],
      tables: [
        {
          id: 'app.invoice_line',
          name: 'invoice_line',
          schema: 'app',
          isView: false,
          columns: [
            { name: 'invoice_id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'line_no', type: 'integer', nullable: false, primaryKey: true },
          ],
        },
        {
          id: 'app.invoice',
          name: 'invoice',
          schema: 'app',
          isView: false,
          columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
        },
      ],
    };
    const ddl = renderDDL(pg, 'app.invoice_line');
    assert.match(ddl, /CREATE TABLE "app"\."invoice_line"/);
    assert.match(ddl, /REFERENCES "app"\."invoice"/);
    assert.ok(!ddl.includes('"app.invoice_line"'), 'qualified name quoted as one identifier');
  });

  test('an unqualified name stays a single identifier', () => {
    // SQLite has no schemas, and inventing one would be wrong.
    assert.match(renderDDL(schema, 'customer'), /CREATE TABLE "customer"/);
  });
});

describe('date columns', () => {
  test('a declared date type is a date', () => {
    const invoice = findTable(schema, 'invoice')!;
    assert.equal(columnKind(invoice.columns.find((c) => c.name === 'invoice_date')!.type), 'date');
  });

  test('a text column named like a date still gets date treatment', () => {
    /* SQLite has no date type, so `opened_on TEXT` is idiomatic rather than
       sloppy. Refusing relative-date filters on it would make the best part
       of the language unavailable exactly where it is most needed. */
    const asText = { name: 'opened_on', type: 'TEXT', nullable: true, primaryKey: false };
    assert.equal(looksLikeDate(asText), true);
    assert.equal(looksLikeDate({ ...asText, name: 'created_at' }), true);
    assert.equal(looksLikeDate({ ...asText, name: 'due_date' }), true);
    assert.equal(looksLikeDate({ ...asText, name: 'timestamp' }), true);
  });

  test('it does not guess on names that only look date-ish', () => {
    const text = (name: string) => ({ name, type: 'TEXT', nullable: true, primaryKey: false });
    assert.equal(looksLikeDate(text('name')), false);
    assert.equal(looksLikeDate(text('country_code')), false);
    assert.equal(looksLikeDate(text('status')), false);
    // A number named like a timestamp is an epoch; comparing it to a date
    // string would silently match nothing.
    assert.equal(looksLikeDate({ name: 'updated_at', type: 'INTEGER', nullable: true, primaryKey: false }), false);
  });

  test('relative-date filters work against a real date column', async () => {
    const { query, errors } = parseQuery('invoice invoice_date = last year', { schema, now: NOW });
    assert.deepEqual(errors, []);
    const result = await adapter.query({ ...query!, limit: 50, offset: 0 });
    assert.deepEqual(result.rows.map((r) => r.id).sort(), [1001, 1002, 1003]);
  });
});

describe('a 64-bit id is neither lost nor rounded', () => {
  /* `node:sqlite` throws outright on any integer past 2^53 unless the
     statement is told to read big integers — so a table with a Snowflake or
     Postgres-style id was unreadable, and the value that would have been
     "read" as a plain number is off by the digits JavaScript cannot hold. A
     browser whose whole promise is "click the row and follow the key" cannot
     round the key. */
  const FILE = join(SCRATCH, 'test-bigid.db');
  let big: SqliteAdapter;

  before(async () => {
    makeDemoDatabase(FILE);
    const d = new DatabaseSync(FILE);
    d.exec('CREATE TABLE snowflake (id INTEGER PRIMARY KEY, note TEXT)');
    d.exec("INSERT INTO snowflake VALUES (1, 'small')");
    d.exec("INSERT INTO snowflake VALUES (9007199254740993, 'just past 2^53')");
    d.exec("INSERT INTO snowflake VALUES (9223372036854775807, 'int64 max')");
    d.close();
    big = new SqliteAdapter(FILE, 'bigid');
    await big.introspect();
  });

  after(async () => {
    await big.close();
    rmSync(FILE, { force: true });
  });

  test('the read does not throw, and returns every row', async () => {
    const result = await big.query({ table: 'snowflake', limit: 100, offset: 0 });
    assert.equal(result.rows.length, 3);
  });

  test('a value past 2^53 is a string with all its digits', async () => {
    const result = await big.query({ table: 'snowflake', limit: 100, offset: 0 });
    const byNote = new Map(result.rows.map((r) => [r.note, r.id]));
    /* A string, because a number could not hold it — and the exact digits,
       because the point is that nothing was rounded. */
    assert.equal(byNote.get('int64 max'), '9223372036854775807');
    assert.equal(byNote.get('just past 2^53'), '9007199254740993');
  });

  test('an ordinary id stays a number, so the grid still formats it', async () => {
    const result = await big.query({ table: 'snowflake', limit: 100, offset: 0 });
    const small = result.rows.find((r) => r.note === 'small');
    assert.equal(typeof small?.id, 'number');
    assert.equal(small?.id, 1);
  });

  test('the big-id row can be found again by its key, which is what a click does', async () => {
    const filter: Filter = {
      groups: [[{ column: 'id', op: '=', value: '9223372036854775807' }]],
    };
    const found = await big.query({ table: 'snowflake', filter, limit: 2, offset: 0 });
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].note, 'int64 max');
    assert.equal(await big.count('snowflake', filter), 1);
  });

  test('a raw SELECT is safe too', async () => {
    const result = await big.runSql({ text: 'SELECT id FROM snowflake ORDER BY id DESC', limit: 100 });
    assert.deepEqual(result.rows[0], ['9223372036854775807']);
    assert.deepEqual(result.rows[2], [1]);
  });
});

describe('the record page and the grid agree about a value', () => {
  /* They had separate rules and the record's was looser: an unanchored
     `^(active|enabled|urgent|billable)` with no check on the value, so an
     integer column called `active_connections` was a boolean on the record
     page and a number in the grid. `active_connections = 3` read "✗ no" in
     one place and `3` two clicks away — the same value, the same schema, two
     answers, and no way for a reader to know which was the lie. */
  const plan = (name: string, type: string, value: unknown, extra: Record<string, unknown> = {}) =>
    planColumn({ name, type, nullable: true, primaryKey: false, ...extra } as never, name, [{ [name]: value }]);

  test('a flag column with a flag value is a boolean', () => {
    assert.equal(plan('active', 'INTEGER', 1).kind, 'boolean');
    assert.equal(plan('is_urgent', 'INTEGER', 0).kind, 'boolean');
  });

  test('a column that merely starts like a flag is not one', () => {
    // The exact case: it is a count of connections, not a yes or a no.
    assert.equal(plan('active_connections', 'INTEGER', 3).kind, 'number');
    assert.equal(plan('enabled_features', 'INTEGER', 7).kind, 'number');
  });

  test('a flag name with a value that is not 0 or 1 is not a boolean either', () => {
    /* `deleted` is on the flag list, but a `deleted` holding 3 is not a
       tri-state boolean — it is a number whose name is misleading, and
       rendering it "✗ no" would be the interface inventing a fact. */
    assert.equal(plan('deleted', 'INTEGER', 3).kind, 'number');
  });

  test('a declared boolean is one whatever it is called', () => {
    assert.equal(plan('anything', 'BOOLEAN', true).kind, 'boolean');
  });

  test('a key stays an identifier rather than a quantity', () => {
    // 1001 is invoice 1001, not "1,001" of something.
    assert.equal((plan('id', 'INTEGER', 1001, { primaryKey: true }) as { identifier?: boolean }).identifier, true);
  });
});

describe('the suite runs everything in it', () => {
  /* Where a test may live, and that the glob reaches every folder, is
     pinned by test/repo/structure.test.ts. */
  test('and the glob still finds the files that are there', () => {
    const root = new URL('.', import.meta.url).pathname;
    const found = readdirSync(root).filter((f) => f.endsWith('.test.ts'));
    /* A floor rather than an exact number: a suite that grows should not have
       to edit this, and a suite that suddenly finds two files has lost most
       of itself. */
    assert.ok(found.length >= 10, `only ${found.length} test files found`);
  });
});

describe('when the header may offer a sort', () => {
  /* A header click is a one-click action with no visible cost, so on a large
     unindexed column it must not quietly be a full scan. The rule used to be
     "indexed only", which is right on a table of millions and wrong on one of
     a hundred and seventy — there was no way to sort `employee.last_name` from
     the interface at all.

     Tested here rather than in the browser because no fixture in this repo has
     fifty thousand rows in it, so the large-table half is a branch e2e can
     never reach. */
  const table = (approxRows?: number) => ({ approxRows }) as { approxRows?: number };

  test('a small table sorts freely, index or no index', () => {
    assert.equal(sortableFromHeader(table(172)), true);
    assert.equal(sortableFromHeader(table(0)), true);
  });

  test('a large one does not', () => {
    assert.equal(sortableFromHeader(table(SORT_SCAN_BELOW)), false);
    assert.equal(sortableFromHeader(table(SORT_SCAN_BELOW + 1)), false);
    assert.equal(sortableFromHeader(table(4_000_000)), false);
  });

  test('and a table nobody could count is not assumed to be cheap', () => {
    /* `approxRows` is absent when the adapter does not report an estimate.
       "We did not look" is not "it is small". */
    assert.equal(sortableFromHeader(table(undefined)), false);
    assert.equal(sortableFromHeader(undefined), false);
  });
});

describe('filter composition', () => {
  /* Clicking values in a column menu must produce a query that means what the
     clicking meant. The naive append produces `status = a and status = b`,
     which matches nothing — a filter UI that silently empties the table is
     worse than no filter UI. */
  const compose = (query: string, column: string, condition: string) => composeFilter(query, 'work_order', column, condition);

  test('the first condition needs no joiner', () => {
    assert.equal(compose('work_order', 'status', 'status = open'), 'work_order status = open');
  });

  test('a clause word inside a quoted value is not a clause', () => {
    /* This file used to find the tail with its own regex, blind to quotes —
       so `summary = "sort me"` split at the `sort` inside the value:
       everything from that word became a clause, the condition was cut in
       half, and adding a filter destroyed the query it was added to. It uses
       the same splitter the query bar does now. */
    assert.equal(compose('work_order summary = "sort me"', 'status', 'status = open'), 'work_order summary = "sort me" and status = open');
    assert.equal(
      compose('work_order summary = "show and limit"', 'status', 'status = open'),
      'work_order summary = "show and limit" and status = open',
    );
  });

  test('an "and" inside a value does not split the condition', () => {
    /* A null check strips other conditions on the same column, and the strip
       split on `\s+and\s+` — taking `summary = "a and b"` apart in the middle
       of a value and leaving `b"` behind as a condition of its own. */
    assert.equal(compose('work_order summary = "a and b"', 'summary', 'summary is empty'), 'work_order summary is empty');
  });

  test('two values on one column fold into a list', () => {
    assert.equal(compose('work_order status = open', 'status', 'status = closed'), 'work_order status in (open, closed)');
    assert.equal(compose('work_order status in (open, closed)', 'status', 'status = held'), 'work_order status in (open, closed, held)');
  });

  test('the same value twice changes nothing', () => {
    assert.equal(compose('work_order status = open', 'status', 'status = open'), 'work_order status = open');
    assert.equal(compose('work_order status in (open, closed)', 'status', 'status = closed'), 'work_order status in (open, closed)');
  });

  describe('a multi-word value is never torn in half', () => {
    /* The bug, found by using it: the value was matched as `\S+` — one token,
       which is most values and not all of them. Picking a second period from
       the date menu matched only `this` of `this year`, folded that much into
       a list, and left the rest stranded outside it:

           employee hired_on in (this, last 7 days) year

       The parser cannot read that, so it came back as "0 rows" — a filter UI
       silently emptying the table, which is the one thing this module exists
       to prevent. */
    test('picking a second period replaces the first', () => {
      assert.equal(
        compose('work_order opened_on = this year', 'opened_on', 'opened_on = last 7 days'),
        'work_order opened_on = last 7 days',
      );
    });

    test('and never produces a list with a range in it', () => {
      const out = compose('work_order opened_on = this year', 'opened_on', 'opened_on = last 7 days');
      assert.ok(!out.includes('in ('), out);
      assert.ok(!/\)\s*year/.test(out), out);
    });

    test('a period does not join a list that already exists', () => {
      assert.equal(
        compose('work_order opened_on in (2024-01-01, 2024-02-01)', 'opened_on', 'opened_on = last 7 days'),
        'work_order opened_on = last 7 days',
      );
    });

    test('other conditions on other columns survive the replacement', () => {
      assert.equal(
        compose('work_order status = open and opened_on = this year', 'opened_on', 'opened_on = today'),
        'work_order status = open and opened_on = today',
      );
    });

    test('a quoted value with a space still folds, because a list can hold it', () => {
      assert.equal(
        compose('work_order title = "Sales Manager"', 'title', 'title = "Support Lead"'),
        'work_order title in ("Sales Manager", "Support Lead")',
      );
    });
  });

  test('a bracketed group is left whole', () => {
    assert.equal(
      compose('work_order (priority = 1 or priority = 2)', 'status', 'status = open'),
      'work_order (priority = 1 or priority = 2) and status = open',
    );
  });

  test('clauses written out of order come back in order, and keep their values', () => {
    assert.equal(compose('work_order limit 5 sort number', 'status', 'status = open'), 'work_order status = open sort number limit 5');
  });

  test('different columns combine with and', () => {
    assert.equal(compose('work_order status = open', 'priority', 'priority = 1'), 'work_order status = open and priority = 1');
  });

  test('a second value on the same column becomes in (…), not and', () => {
    // AND on one column is a contradiction; the language already has `in`.
    assert.equal(compose('work_order status = open', 'status', 'status = on_hold'), 'work_order status in (open, on_hold)');
  });

  test('a third value extends the existing list', () => {
    assert.equal(
      compose('work_order status in (open, on_hold)', 'status', 'status = cancelled'),
      'work_order status in (open, on_hold, cancelled)',
    );
  });

  test('picking the same value twice changes nothing', () => {
    assert.equal(compose('work_order status = open', 'status', 'status = open'), 'work_order status = open');
    assert.equal(compose('work_order status in (open, on_hold)', 'status', 'status = on_hold'), 'work_order status in (open, on_hold)');
  });

  test('clauses stay at the end, where the parser needs them', () => {
    /* Appending after `sort` would make the condition part of the sort clause
       and produce a column named "opened_on and priority = 1". */
    assert.equal(
      compose('work_order status = open sort opened_on desc', 'priority', 'priority = 1'),
      'work_order status = open and priority = 1 sort opened_on desc',
    );
    assert.equal(compose('work_order limit 50', 'status', 'status = open'), 'work_order status = open limit 50');
  });

  test('a null check replaces other conditions on that column', () => {
    // `closed_on is empty and closed_on = x` is a contradiction, not a refinement.
    assert.equal(
      compose('work_order closed_on = today and status = open', 'closed_on', 'closed_on is empty'),
      'work_order status = open and closed_on is empty',
    );
  });

  test('a null check on the only condition leaves a valid query', () => {
    assert.equal(compose('work_order closed_on = today', 'closed_on', 'closed_on is empty'), 'work_order closed_on is empty');
  });

  test('every composed query still parses', () => {
    const cases = [
      compose('work_order', 'status', 'status = open'),
      compose('work_order status = open', 'status', 'status = on_hold'),
      compose('work_order status = open sort opened_on desc', 'priority', 'priority = 1'),
      compose('work_order closed_on = today', 'closed_on', 'closed_on is empty'),
    ];
    for (const text of cases) {
      const { query, errors } = parseQuery(text, { schema: bigSchema, now: NOW });
      assert.deepEqual(errors, [], `${text} → ${JSON.stringify(errors)}`);
      assert.ok(query, text);
    }
  });
});

describe('credentials', () => {
  /* The property under test throughout: a stored connection should be able to
     name a secret without containing one. */
  const dir = join(SCRATCH, 'creds');
  const file = join(dir, 'credentials.json');

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('environment references expand', () => {
    const env = { PGPASS: 's3cret' } as NodeJS.ProcessEnv;
    assert.equal(expandEnv('postgres://app:${PGPASS}@db/appdb', env), 'postgres://app:s3cret@db/appdb');
    assert.equal(expandEnv('postgres://app:$PGPASS@db/appdb', env), 'postgres://app:s3cret@db/appdb');
    // A URL with nothing to expand is returned unchanged, not reconstructed.
    assert.equal(expandEnv('postgres://app@db/appdb', env), 'postgres://app@db/appdb');
  });

  test('an unset variable is an error, not an empty password', () => {
    /* Expanding to "" would send an empty password and fail with an
       authentication error that says nothing about the real cause. */
    assert.throws(() => expandEnv('postgres://app:${NOT_SET_ANYWHERE}@db/appdb', {}), /NOT_SET_ANYWHERE, which is not set/);
  });

  test('an inline password is detected so it can be warned about', () => {
    assert.equal(hasInlinePassword('postgres://app:pw@db/appdb'), true);
    assert.equal(hasInlinePassword('postgres://app@db/appdb'), false);
    assert.equal(hasInlinePassword('/path/to/file.db'), false);
  });

  test('a world-readable credentials file is refused, not read', async () => {
    /* What ssh does to private keys and psql does to .pgpass. It catches the
       realistic mistake: a file created correctly, then committed or synced
       with permissions that no longer match the intent. */
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ prod: 'hunter2' }), { mode: 0o644 });
    chmodSync(file, 0o644);
    await assert.rejects(() => readCredentials(file), /readable by others/);

    chmodSync(file, 0o600);
    assert.deepEqual(await readCredentials(file), { prod: 'hunter2' });
  });

  test('a missing credentials file is not an error', async () => {
    assert.deepEqual(await readCredentials(join(dir, 'absent.json')), {});
  });

  test('resolution prefers the environment over the file', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ prod: 'from-file' }), { mode: 0o600 });
    chmodSync(file, 0o600);
    process.env.TW_TEST_PASS = 'from-env';
    const resolved = await resolveConnection('prod', 'postgres://app:${TW_TEST_PASS}@db/appdb', {
      credentialsFile: file,
    });
    delete process.env.TW_TEST_PASS;
    assert.equal(resolved.source, 'environment');
    assert.match(resolved.url, /from-env/);
  });

  test('a password-less URL is filled from the file', async () => {
    /* A name nobody's keychain will already hold. `prod` was the obvious
       choice and the wrong one: the keychain is consulted before the file, so
       a developer with a real `prod` connection saved on their machine — the
       most likely name there is — failed this test for a reason that had
       nothing to do with the code. */
    const account = 'tablewalk-test-fromfile';
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ [account]: 'p@ss:word' }), { mode: 0o600 });
    chmodSync(file, 0o600);
    const resolved = await resolveConnection(account, 'postgres://app@db/appdb', { credentialsFile: file });
    assert.equal(resolved.source, 'file');
    // Percent-encoded, or a password containing : or @ would corrupt the URL.
    assert.equal(new URL(resolved.url).password, encodeURIComponent('p@ss:word'));
    assert.equal(decodeURIComponent(new URL(resolved.url).password), 'p@ss:word');
  });

  test('an inline password is used but reported', async () => {
    const resolved = await resolveConnection('x', 'postgres://app:literal@db/appdb', {
      credentialsFile: join(dir, 'absent.json'),
    });
    assert.equal(resolved.source, 'inline');
    assert.match(resolved.warning ?? '', /written into the URL/);
  });

  test('no password anywhere is not an error', async () => {
    // Peer auth, trust, and the driver's own ~/.pgpass are all legitimate.
    const resolved = await resolveConnection('x', 'postgres://app@db/appdb', {
      credentialsFile: join(dir, 'absent.json'),
    });
    assert.equal(resolved.source, 'none');
    assert.equal(resolved.warning, undefined);
  });

  test('a sqlite path resolves without touching any credential store', async () => {
    const resolved = await resolveConnection('demo', '.demo/demo.db');
    assert.equal(resolved.source, 'none');
    assert.equal(resolved.url, '.demo/demo.db');
  });

  test('a saved config never carries the password that was typed into it', async () => {
    /* The property `storeSecret` was written for, and which nothing enforced:
       it existed, its comment promised "the URL that gets written to disk
       never contains the password", and no code path called it. A connection
       added as `postgres://user:hunter2@host/db` put `hunter2` into the
       config file in plaintext — for whoever that file is later shared or
       committed with.

       Asserted on the file rather than on where the secret went, because the
       destination differs by platform (the keychain on macOS, a 0600
       credentials file elsewhere) and the property does not: the config is
       safe to share either way. */
    const name = 'tablewalk-test-secret';
    const target = join(dir, 'saved.json');
    const stored = await storeSecret(name, `postgres://app:hunter2@127.0.0.1:5432/appdb`);

    assert.ok(stored, 'a URL with a password has a secret to store');
    assert.equal(stored.url, 'postgres://app@127.0.0.1:5432/appdb', 'the user survives, the password does not');
    assert.ok(stored.stored === 'keychain' || stored.stored === 'file');

    await saveConfig(target, [
      {
        id: name,
        name,
        url: stored.url,
        source: 'session',
      } as never,
    ]);
    const written = readFileSync(target, 'utf8');
    assert.ok(!written.includes('hunter2'), written);
    assert.ok(written.includes('postgres://app@127.0.0.1:5432/appdb'));

    /* And it is still resolvable by name, which is the half that makes
       removing it from the URL safe rather than merely tidy. */
    const back = await resolveConnection(name, stored.url, { credentialsFile: credentialsPath() });
    assert.equal(back.url, 'postgres://app:hunter2@127.0.0.1:5432/appdb');

    await keychainDelete(name).catch(() => {});
  });

  test('an environment reference is left exactly where it is', async () => {
    /* The regression this nearly became. `${PROD_PASSWORD}` is not a secret
       to be moved — it is the absence of one, and the arrangement the docs
       recommend first. Storing it would put the literal characters into the
       keychain and strip the reference out of the URL, breaking the workflow
       in the course of trying to secure it.

       Both spellings, because `expandEnv` accepts both. */
    for (const url of ['postgres://app:${PROD_PASSWORD}@127.0.0.1:5432/appdb', 'postgres://app:$PROD_PASSWORD@127.0.0.1:5432/appdb']) {
      assert.equal(await storeSecret('tablewalk-test-env', url), undefined, url);
    }

    /* And a real password beside it still moves, so the guard is a
       distinction rather than an off switch. */
    const moved = await storeSecret('tablewalk-test-env', 'postgres://app:realpassword@127.0.0.1:5432/appdb');
    assert.ok(moved);
    assert.equal(moved.url, 'postgres://app@127.0.0.1:5432/appdb');
    await keychainDelete('tablewalk-test-env').catch(() => {});
  });

  test('writing a credential creates it 0600 from the start', async () => {
    const target = join(dir, 'written.json');
    await writeCredential('newconn', 'topsecret', target);
    /* Mode set at creation rather than chmod-ed after: between a default-mode
       write and the chmod there is a window where the secret is readable. */
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(await readCredentials(target), { newconn: 'topsecret' });
  });
});

describe('views as text', () => {
  /* The property that matters: a view rendered to text and read back is the
     same view. Without it the text form is decoration, and the composer stays
     the only way to express a view. */
  const roundTrip = (text: string) => {
    const parsed = textToView(bigSchema, text, { now: NOW });
    assert.deepEqual(parsed.errors, [], `${text} → ${JSON.stringify(parsed.errors)}`);
    const rendered = viewToTextWithSchema(bigSchema, parsed.view!);
    const again = textToView(bigSchema, rendered, { now: NOW });
    assert.deepEqual(again.errors, [], `${rendered} → ${JSON.stringify(again.errors)}`);
    assert.deepEqual(again.view, parsed.view, `\n--- first ---\n${text}\n--- rendered ---\n${rendered}`);
    return { view: parsed.view!, rendered };
  };

  test('a bare table is a view', () => {
    const { view } = roundTrip('work_order');
    assert.equal(view.base, 'work_order');
    assert.deepEqual(view.columns, []);
  });

  test('paths and aliases survive', () => {
    const { view } = roundTrip('work_order show reference, customer_id.name as customer');
    assert.deepEqual(view.columns, [{ path: 'reference' }, { path: 'customer_id.name', alias: 'customer' }]);
  });

  test('a multi-hop path survives', () => {
    const { view } = roundTrip('work_order show customer_id.country_code.name as country');
    assert.equal(view.columns[0].path, 'customer_id.country_code.name');
  });

  test('an aggregate names a table and a column, not a constraint', () => {
    const { view, rendered } = roundTrip('work_order count work_order_part via work_order_id as parts');
    assert.equal(view.aggregates?.length, 1);
    assert.equal(view.aggregates?.[0].fn, 'count');
    assert.equal(view.aggregates?.[0].alias, 'parts');
    /* The model stores a constraint name; the text must not, because nobody
       reads `work_order_part_work_order_id_fkey`. */
    assert.match(rendered, /count work_order_part via work_order_id as parts/);
    assert.ok(!rendered.includes('fk'), rendered);
  });

  test('a summing aggregate carries its column', () => {
    const { view } = roundTrip('work_order sum work_order_part.quantity via work_order_id as units');
    assert.equal(view.aggregates?.[0].fn, 'sum');
    assert.equal(view.aggregates?.[0].column, 'quantity');
  });

  test('two aggregates over the same child stay distinct', () => {
    const { view } = roundTrip(
      'work_order count work_order_part via work_order_id as parts sum work_order_part.quantity via work_order_id as units',
    );
    assert.equal(view.aggregates?.length, 2);
    assert.deepEqual(
      view.aggregates?.map((a) => a.alias),
      ['parts', 'units'],
    );
  });

  test('the two self-references are told apart', () => {
    /* work_order points at itself twice. A constraint keyed only by table
       would make "count of work_orders" ambiguous, and silently pick one. */
    const children = textToView(bigSchema, 'work_order count work_order via parent_id as children', { now: NOW });
    const superseded = textToView(bigSchema, 'work_order count work_order via supersedes_id as superseded', { now: NOW });
    assert.deepEqual(children.errors, []);
    assert.deepEqual(superseded.errors, []);
    assert.notEqual(children.view!.aggregates![0].via, superseded.view!.aggregates![0].via);
  });

  test('filters over paths survive, including or-groups', () => {
    const { view } = roundTrip('work_order where customer_id.country_code = AU and total_cost > 500');
    assert.equal(view.filter?.groups.length, 1);
    assert.equal(view.filter?.groups[0].length, 2);
    assert.equal(view.filter?.groups[0][0].path, 'customer_id.country_code');
  });

  test('null checks and in-lists survive', () => {
    const { view } = roundTrip('work_order where closed_on is empty and status in (open, on_hold)');
    const ops = view.filter!.groups[0].map((c) => c.op);
    assert.ok(ops.includes('isNull'));
    assert.ok(ops.includes('in'));
  });

  test('sort and limit survive', () => {
    const { view } = roundTrip('work_order sort total_cost desc limit 20');
    assert.deepEqual(view.orderBy, [{ path: 'total_cost', direction: 'desc' }]);
    assert.equal(view.limit, 20);
  });

  test('everything at once survives', () => {
    const { view } = roundTrip(
      'work_order show reference, customer_id.name as customer ' +
        'count work_order_part via work_order_id as parts ' +
        'where customer_id.country_code = AU and total_cost > 500 ' +
        'sort total_cost desc limit 20',
    );
    assert.equal(view.columns.length, 2);
    assert.equal(view.aggregates?.length, 1);
    assert.equal(view.filter?.groups[0].length, 2);
    assert.equal(view.limit, 20);
  });

  test('an unknown table is refused by name', () => {
    const { errors } = textToView(bigSchema, 'nosuchtable show a', { now: NOW });
    assert.match(errors[0].message, /No table called "nosuchtable"/);
  });

  test('an aggregate through a key that does not point back is refused', () => {
    /* The failure that silently produces zero: naming a column that is not a
       foreign key to this table. The error names what would have worked. */
    const { errors } = textToView(bigSchema, 'work_order count work_order_part via sku as parts', { now: NOW });
    assert.match(errors[0].message, /Nothing in work_order_part\.sku points at work_order/);
    assert.match(errors[0].message, /Try: /);
  });

  test('sum without a column is refused with the fix in the message', () => {
    const { errors } = textToView(bigSchema, 'work_order sum work_order_part via work_order_id', { now: NOW });
    assert.match(errors[0].message, /sum needs a column/);
    assert.match(errors[0].message, /work_order_part\.amount via work_order_id/);
  });

  test('a column that is not on the child table is refused', () => {
    const { errors } = textToView(bigSchema, 'work_order sum work_order_part.nope via work_order_id', { now: NOW });
    assert.match(errors[0].message, /"nope" is not a column on work_order_part/);
  });

  test('a column named like an aggregate is still a column', () => {
    /* `count` and `sum` are only clause words when followed by something and
       then `via`. Eating the word unconditionally would turn a filter on a
       column called `count` into a broken aggregate. */
    const local: DatabaseSchema = {
      ...bigSchema,
      tables: [
        ...bigSchema.tables,
        {
          id: 'tally',
          name: 'tally',
          schema: '',
          isView: false,
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
            { name: 'count', type: 'INTEGER', nullable: true, primaryKey: false },
            { name: 'sum', type: 'REAL', nullable: true, primaryKey: false },
          ],
        },
      ],
    };
    const parsed = textToView(local, 'tally where count > 3 and sum > 1.5', { now: NOW });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.view?.aggregates, undefined);
    assert.equal(parsed.view?.filter?.groups[0].length, 2);
  });

  test('a qualified table name is one table, not a table and a column', () => {
    /* `app.invoice_line` is a schema-qualified table; `work_order_part.quantity`
       is a table and a column. A dot cannot tell them apart, so the schema
       does. Splitting on the first dot — the obvious implementation — made
       `app.invoice_line` into a table called `app`, and the error named a
       table that does not exist. Only visible against a Postgres schema,
       which is why it survived the unit tests. */
    const pg: DatabaseSchema = {
      label: 'pg',
      dialect: 'postgres',
      readAt: '',
      foreignKeys: [
        {
          name: 'line_invoice_fkey',
          from: { table: 'app.invoice_line', columns: ['invoice_id'] },
          to: { table: 'app.invoice', columns: ['id'] },
        },
      ],
      tables: [
        {
          id: 'app.invoice',
          name: 'invoice',
          schema: 'app',
          isView: false,
          columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
        },
        {
          id: 'app.invoice_line',
          name: 'invoice_line',
          schema: 'app',
          isView: false,
          columns: [
            { name: 'invoice_id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'quantity', type: 'integer', nullable: false, primaryKey: false },
          ],
        },
      ],
    };

    const counted = textToView(pg, 'app.invoice count app.invoice_line via invoice_id as lines');
    assert.deepEqual(counted.errors, []);
    assert.equal(counted.view?.aggregates?.[0].via, 'app.invoice_line.invoice_id');
    assert.equal(counted.view?.aggregates?.[0].column, undefined);

    // And with a column on the end, the last dot separates it.
    const summed = textToView(pg, 'app.invoice sum app.invoice_line.quantity via invoice_id as units');
    assert.deepEqual(summed.errors, []);
    assert.equal(summed.view?.aggregates?.[0].column, 'quantity');

    // Round-trips back to the qualified form, not to `app`.
    assert.match(viewToTextWithSchema(pg, summed.view!), /sum app\.invoice_line\.quantity via invoice_id/);
  });

  test('a rendered view compiles to SQL', () => {
    /* The end-to-end property: text in, working statement out, on both
       dialects. Postgres numbers placeholders across the whole statement,
       which is exactly where a join builder gets it wrong. */
    const { view } = roundTrip(
      'work_order show reference, customer_id.name count work_order_part via work_order_id as parts ' +
        'where customer_id.country_code = AU sort total_cost desc limit 5',
    );
    for (const style of [ANSI_STYLE, POSTGRES_STYLE]) {
      const compiled = compileView(bigSchema, view, style);
      assert.match(compiled.text, /LEFT JOIN/);
      assert.match(compiled.text, /SELECT/);
      assert.ok(compiled.params.length >= 1, 'the filter value must be bound');
      // No value may appear in the statement text.
      assert.ok(!compiled.text.includes('AU'), compiled.text);
    }
  });
});

/* ---------- the view composer ----------

   Everything below exercises `packages/engine/src/shared/view.ts`: reference paths, the join
   planner, and the summaries that let a many-valued relationship be asked
   about without multiplying rows.

   Two things are checked against *both* dialects on purpose. Identifiers are
   quoted differently, and — the one that actually catches bugs — Postgres
   numbers placeholders $1..$n across the whole statement while SQLite writes
   `?`. A join builder is exactly where that goes wrong, because the JOIN
   clauses sit between the SELECT list and the WHERE clause and carry no
   parameters of their own. */

describe('reference paths', () => {
  test('a bare column is a path with no hops', () => {
    const resolved = resolvePath(schema, 'invoice', 'total');
    assert.equal(resolved.hops.length, 0);
    assert.equal(resolved.table.id, 'invoice');
    assert.equal(resolved.column.name, 'total');
  });

  test('one hop follows the foreign key', () => {
    const resolved = resolvePath(schema, 'invoice', 'customer_id.name');
    assert.deepEqual(resolved.hopNames, ['customer_id']);
    assert.equal(resolved.table.id, 'customer');
    assert.equal(resolved.column.name, 'name');
  });

  test('several hops chain', () => {
    const resolved = resolvePath(schema, 'invoice', 'customer_id.country_code.name');
    assert.deepEqual(resolved.hopNames, ['customer_id', 'country_code']);
    assert.equal(resolved.table.id, 'country');
  });

  test('an unknown hop names the segment that failed, not the whole path', () => {
    /* The segment is the point. `customer_id.country_code.nmae` is four words
       of which one is wrong, and an error repeating the whole path leaves you
       to find it yourself. */
    assert.throws(
      () => resolvePath(schema, 'invoice', 'customer_id.country_code.nmae'),
      (err: PathError) => {
        assert.equal(err.segment, 'nmae');
        assert.equal(err.index, 2);
        assert.match(err.message, /Did you mean "name"\?/);
        return true;
      },
    );
  });

  test('a real column that is not a reference gets its own sentence', () => {
    assert.throws(
      () => resolvePath(schema, 'invoice', 'total.name'),
      (err: PathError) => {
        assert.match(err.message, /"total" is a column on invoice, not a reference/);
        return true;
      },
    );
  });

  test('an unknown first segment lists what the table does reference', () => {
    assert.throws(
      () => resolvePath(schema, 'invoice', 'nope.name'),
      (err: PathError) => {
        assert.match(err.message, /customer_id/);
        return true;
      },
    );
  });

  test('a cycle terminates at the depth cap rather than hanging', () => {
    /* employee.manager_id points at employee, so the path space is infinite.
       Without a cap this is not a slow test, it is one that never returns. */
    const deep = `${'manager_id.'.repeat(MAX_PATH_DEPTH + 1)}last_name`;
    assert.throws(
      () => resolvePath(schema, 'employee', deep),
      (err: PathError) => {
        assert.match(err.message, new RegExp(`at most ${MAX_PATH_DEPTH} are allowed`));
        return true;
      },
    );
    // One hop under the cap still resolves, so the cap is a cap and not an
    // off-by-one that quietly forbids the last usable hop.
    const allowed = `${'manager_id.'.repeat(MAX_PATH_DEPTH)}last_name`;
    assert.equal(resolvePath(schema, 'employee', allowed).hops.length, MAX_PATH_DEPTH);
  });

  test('a composite key is named by its columns, or by its constraint', () => {
    const byColumns = resolvePath(schema, 'shipment', 'invoice_id+line_no.sku');
    assert.equal(byColumns.table.id, 'invoice_line');
    assert.equal(byColumns.column.name, 'sku');

    const constraint = referencesFrom(schema, 'shipment')[0].name;
    const byName = resolvePath(schema, 'shipment', `${constraint}.sku`);
    assert.equal(byName.table.id, 'invoice_line');
  });

  test('an empty segment is refused rather than silently skipped', () => {
    assert.throws(() => resolvePath(schema, 'invoice', 'customer_id..name'), /empty segment/);
  });
});

describe('breakdowns', () => {
  /**
   * The last hole in the query language: GROUP BY. Until now "how many
   * invoices per month" left the checked path for raw `sql`, which is exactly
   * where an agent stops being able to have its mistakes explained to it.
   *
   * These run the statement rather than reading it. A compiler that produces
   * plausible SQL and the wrong number is the failure worth catching, and the
   * demo fixture is small enough to know the answers by hand.
   */
  const by = (over: Partial<BreakdownDef> = {}): BreakdownDef => ({
    base: 'invoice',
    by: [{ path: 'status' }],
    measures: [{ fn: 'count' }],
    ...over,
  });

  test('counts by a column of the base table', async () => {
    const result = await adapter.runBreakdown!(by({ orderBy: [{ name: 'status', direction: 'asc' }] }));
    assert.deepEqual(result.columns, ['status', 'count']);
    /* Every invoice in the fixture is `issued` — a default nobody overrode —
       so one group holding all of them is the right answer and the total is
       the assertion that says so. */
    const total = await adapter.count('invoice');
    assert.equal(
      result.rows.reduce((n, r) => n + Number(r.count), 0),
      total,
    );
  });

  test('a key can walk references, and needs no join written by hand', async () => {
    /* The reason this is not just `GROUP BY` in the query language: the
       interesting groupings are on the other side of a foreign key. */
    const result = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'customer_id.country_code.name', alias: 'country' }],
      measures: [{ fn: 'count' }, { fn: 'sum', path: 'total', alias: 'billed' }],
      orderBy: [{ name: 'billed', direction: 'desc' }],
    });
    assert.deepEqual(result.columns, ['country', 'count', 'billed']);
    assert.match(result.sql.text, /LEFT JOIN "customer"/);
    assert.match(result.sql.text, /LEFT JOIN "country"/);

    // Every invoice is in exactly one group, including the ones whose walk
    // ends in a null — a LEFT JOIN keeps them, under a group called null.
    const total = await adapter.count('invoice');
    assert.equal(
      result.rows.reduce((n, r) => n + Number(r.count), 0),
      total,
    );
    assert.ok(
      result.rows.some((r) => r.country === null),
      'the unreachable ones are a group, not a silence',
    );
    // Sorted by the measure, which is the whole point of asking.
    const billed = result.rows.map((r) => Number(r.billed ?? 0));
    assert.deepEqual(
      billed,
      [...billed].sort((a, b) => b - a),
    );
  });

  test('a date key is cut down to a period, and the period is a label', async () => {
    const result = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'invoice_date', bucket: 'month' }],
      measures: [{ fn: 'count' }],
      orderBy: [{ name: 'month(invoice_date)', direction: 'asc' }],
    });
    const months = result.rows.map((r) => r['month(invoice_date)']);
    assert.ok(
      months.every((m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m as string)),
      months.join(', '),
    );
    // Sorting text sorts these correctly, which is why the label is `YYYY-MM`.
    assert.deepEqual(months, [...months].sort());
    assert.equal(result.resolved[0].type, 'text', 'a bucket makes a label, not a date');

    const quarters = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'invoice_date', bucket: 'quarter', alias: 'q' }],
      measures: [{ fn: 'count' }],
    });
    assert.ok(
      (quarters.rows.map((r) => r.q) as string[]).every((q) => /^\d{4}-Q[1-4]$/.test(q)),
      'quarters read as 2026-Q3',
    );
  });

  test('a bucket over a column that is not a date is refused, with the type named', () => {
    assert.throws(
      () => compileBreakdown(schema, by({ by: [{ path: 'status', bucket: 'month' }] }), ANSI_STYLE),
      /"status" is TEXT, so it cannot be grouped by month/,
    );
  });

  test('count skips nothing; count of a column skips its nulls', async () => {
    /* The difference is the whole reason both spellings exist. `sold_by` is
       null on one invoice, and COUNT(*) versus COUNT(sold_by) is how you ask
       "how many invoices" versus "how many were sold by somebody". */
    const result = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'status' }],
      measures: [
        { fn: 'count' },
        { fn: 'count', path: 'sold_by', alias: 'with_seller' },
        { fn: 'count', path: 'sold_by', distinct: true, alias: 'sellers' },
      ],
    });
    const row = result.rows[0];
    assert.ok(Number(row.count) > Number(row.with_seller), 'a null salesperson is not counted');
    assert.ok(Number(row.sellers) < Number(row.with_seller), 'and distinct counts people, not invoices');
  });

  test('a filter is the view filter, over paths, with every value bound', async () => {
    const result = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'customer_id.name', alias: 'customer' }],
      measures: [{ fn: 'count' }],
      filter: { groups: [[{ path: 'customer_id.country_code.name', op: '=', value: 'Australia' }]] },
    });
    assert.deepEqual(result.sql.params.slice(0, 1), ['Australia'], 'the value is a parameter, not text');
    assert.ok(!result.sql.text.includes('Australia'));
    assert.ok(result.rows.length > 0);
  });

  test('sorting names a column of the answer, and says so when it does not', () => {
    assert.throws(
      () => compileBreakdown(schema, by({ orderBy: [{ name: 'total', direction: 'desc' }] }), ANSI_STYLE),
      /Nothing called "total" is in this breakdown. It shows: status, count/,
    );
  });

  test('a measure that needs a column says so rather than compiling', () => {
    assert.throws(() => compileBreakdown(schema, by({ measures: [{ fn: 'sum' }] }), ANSI_STYLE), /`sum` needs a column/);
    assert.throws(
      () => compileBreakdown(schema, by({ measures: [{ fn: 'avg', path: 'total', distinct: true }] }), ANSI_STYLE),
      /`distinct` only means something with `count`/,
    );
  });

  test('every read is bounded, breakdowns included', () => {
    const compiled = compileBreakdown(schema, by({ limit: undefined }), ANSI_STYLE);
    assert.match(compiled.text, /LIMIT \? OFFSET \?$/);
    assert.equal(compiled.params.at(-2), DEFAULT_LIMIT);
    assert.equal(compileBreakdown(schema, by({ limit: 10_000_000 }), ANSI_STYLE).params.at(-2), MAX_LIMIT);
  });

  test('grouping is by the expression, never by the output name', () => {
    /* A bucketed key aliased to something a column could also be called is
       one identifier away from grouping by the wrong thing. */
    const compiled = compileBreakdown(
      schema,
      {
        base: 'invoice',
        by: [{ path: 'invoice_date', bucket: 'year', alias: 'status' }],
        measures: [{ fn: 'count' }],
      },
      ANSI_STYLE,
    );
    assert.match(compiled.text, /GROUP BY strftime\('%Y'/);
    assert.ok(!/GROUP BY "status"/.test(compiled.text));
  });

  test('two things to group by is a cross-tab; four is refused', () => {
    const two = compileBreakdown(
      schema,
      {
        base: 'invoice',
        by: [{ path: 'status' }, { path: 'invoice_date', bucket: 'year' }],
        measures: [{ fn: 'count' }],
      },
      ANSI_STYLE,
    );
    assert.equal(two.columns.filter((c) => c.kind === 'key').length, 2);
    assert.throws(
      () =>
        compileBreakdown(
          schema,
          by({
            by: [{ path: 'id' }, { path: 'status' }, { path: 'total' }, { path: 'invoice_date' }],
          }),
          ANSI_STYLE,
        ),
      /groups by at most 3 things; this one names 4/,
    );
  });

  test('counting the groups counts groups, not rows', async () => {
    const grouped = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'customer_id' }],
      measures: [{ fn: 'count' }],
    });
    const groups = await adapter.countBreakdown!({
      base: 'invoice',
      by: [{ path: 'customer_id' }],
      measures: [{ fn: 'count' }],
    });
    assert.equal(groups, grouped.rows.length);
    assert.ok(groups < (await adapter.count('invoice')), 'fewer groups than invoices, or nothing was grouped');
  });

  test('a breakdown of nothing still names its columns', async () => {
    const result = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'status' }],
      measures: [{ fn: 'count' }],
      filter: { groups: [[{ path: 'status', op: '=', value: 'no-such-status' }]] },
    });
    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.columns, ['status', 'count']);
  });
});

describe('breakdowns as text', () => {
  const parse = (text: string) => textToBreakdown(schema, text);

  test('the shortest one there is', () => {
    const { breakdown, errors } = parse('invoice count by status');
    assert.deepEqual(errors, []);
    assert.equal(breakdown!.base, 'invoice');
    assert.deepEqual(breakdown!.by, [{ path: 'status', bucket: undefined, alias: undefined }]);
    assert.deepEqual(breakdown!.measures, [{ fn: 'count' }]);
  });

  test('measures, periods, paths, names and the ordinary clauses, in one line', () => {
    const { breakdown, errors } = parse(
      'invoice where total > 100 count, sum total as billed by month invoice_date sort billed desc limit 12',
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      breakdown!.measures.map((m) => m.fn),
      ['count', 'sum'],
    );
    assert.equal(breakdown!.measures[1].alias, 'billed');
    assert.deepEqual(breakdown!.by, [{ path: 'invoice_date', bucket: 'month', alias: undefined }]);
    assert.deepEqual(breakdown!.orderBy, [{ name: 'billed', direction: 'desc' }]);
    assert.equal(breakdown!.limit, 12);
    // The filter is the ordinary language's, parsed by the ordinary parser.
    assert.deepEqual(breakdown!.filter?.groups, [[{ path: 'total', op: '>', value: 100 }]]);
  });

  test('what it parses to is what it compiles to, and it runs', async () => {
    /* The text form earns its place only if the thing it produces is the
       thing the compiler takes. Parsed, compiled, run, and the answer
       checked against the same question asked structurally. */
    const { breakdown } = parse('invoice count by customer_id.country_code.name as country sort count desc');
    const fromText = await adapter.runBreakdown!(breakdown!);
    const fromShape = await adapter.runBreakdown!({
      base: 'invoice',
      by: [{ path: 'customer_id.country_code.name', alias: 'country' }],
      measures: [{ fn: 'count' }],
      orderBy: [{ name: 'count', direction: 'desc' }],
    });
    assert.deepEqual(fromText.rows, fromShape.rows);
  });

  test('a bare measure with no `by` is one group: the whole answer', () => {
    assert.equal(looksLikeBreakdown('invoice count by status'), true);
    assert.equal(looksLikeBreakdown('invoice status = paid sort total desc'), false);
    /* `order by` is the sort clause, not the pivot — a line that only has
       that one is an ordinary query. */
    assert.equal(looksLikeBreakdown('invoice order by total desc'), false);
    /* "invoice sum total" is a number, not a mistake — the app home's
       metric cards ride on this, and it reads the same anywhere. A line
       with neither `by` nor a measure still gets the guidance. */
    const whole = parse('invoice status != paid sum total as owed');
    assert.deepEqual(whole.errors, []);
    assert.deepEqual(whole.breakdown!.by, []);
    assert.equal(whole.breakdown!.measures[0].alias, 'owed');
    assert.match(parse('invoice status = paid').errors[0].message, /needs `by`.*bare measure/);
  });

  test('filtering on the column you group by is allowed — the filter runs first', () => {
    /* Refused for a while: the plain key's output name shadowed its own
       base column, so `status = paid … by status` was "an aggregate
       result". A filter runs before the grouping exists; only names that
       are solely aggregate outputs (aliases, buckets, measures) shadow. */
    const { breakdown, errors } = parse('invoice status != void count by status');
    assert.deepEqual(errors, []);
    assert.ok(breakdown);
    // The measure alias still shadows: filtering on it is still refused.
    const bad = parse('invoice count as n by status sort n desc limit 3');
    assert.deepEqual(bad.errors, []);
    const worse = parse('invoice n > 5 count as n by status');
    assert.ok(worse.errors.length, 'a filter on a measure alias is still refused');
  });

  test('order by after the keys is the sort clause, not a second pivot', () => {
    const { breakdown, errors } = parse('invoice count by status order by count desc');
    assert.deepEqual(errors, []);
    assert.deepEqual(
      breakdown!.by.map((k) => k.path),
      ['status'],
    );
    assert.deepEqual(breakdown!.orderBy, [{ name: 'count', direction: 'desc' }]);
  });

  test('nothing to measure, and nothing to group by, are both said plainly', () => {
    assert.match(parse('invoice by status').errors[0].message, /Nothing to measure/);
    assert.match(parse('invoice count by').errors[0].message, /needs something after it/);
  });

  test('`show` is refused, because a breakdown’s columns are not chosen that way', () => {
    assert.match(parse('invoice show id count by status').errors[0].message, /`show` does not apply/);
  });

  test('an unknown path in the key is caught before anything runs', () => {
    const { breakdown, errors } = parse('invoice count by custommer_id.name');
    assert.equal(breakdown, undefined);
    assert.ok(errors.length);
    // The compiler is the one that resolves paths, so this is its error.
    assert.throws(
      () =>
        compileBreakdown(
          schema,
          {
            base: 'invoice',
            by: [{ path: 'custommer_id.name' }],
            measures: [{ fn: 'count' }],
          },
          ANSI_STYLE,
        ),
      /custommer_id/,
    );
  });

  test('it round-trips: written, read, written again', () => {
    for (const line of [
      'invoice count by status',
      'invoice count, sum total as billed by month invoice_date sort billed desc limit 12',
      'invoice count distinct sold_by as sellers by year invoice_date',
      'invoice where total > 100 count by customer_id.name as customer',
    ]) {
      const { breakdown, errors } = parse(line);
      assert.deepEqual(errors, [], line);
      assert.equal(breakdownToText(schema, breakdown!), line, `round trip: ${line}`);
    }
  });
});

describe('view compilation', () => {
  const view = (over: Partial<ViewDef> = {}): ViewDef => ({
    id: 'v',
    name: 'v',
    base: 'invoice',
    columns: [{ path: 'id' }],
    ...over,
  });

  test('joins are LEFT, never INNER', () => {
    /* The single most important property in this file. An INNER JOIN drops
       every base row whose foreign key is null — silently, and in a direction
       that reads as "the data is not there" rather than "the query is wrong".
       A composer that loses rows is worse than no composer. */
    const compiled = compileView(schema, view({ columns: [{ path: 'id' }, { path: 'sold_by.last_name' }] }), ANSI_STYLE);
    assert.match(compiled.text, /LEFT JOIN "employee"/);
    assert.ok(!/(?<!LEFT )\bJOIN\b/.test(compiled.text.replace(/LEFT JOIN/g, 'LEFT JOIN')));
    assert.ok(!compiled.text.includes('INNER JOIN'));
  });

  test('a null foreign key keeps the base row, with nulls beside it', async () => {
    /* Proved against the database rather than against the SQL text, because
       the text being right and the result being wrong is the failure that
       matters. Invoice 1006 has no salesperson; customer 5 has no country. */
    const result = await adapter.runView(
      view({
        base: 'invoice',
        columns: [{ path: 'id' }, { path: 'sold_by.last_name' }, { path: 'customer_id.country_code.name' }],
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 100,
      }),
    );
    /* Counted rather than hardcoded. The point of the assertion is that the
       joins drop nothing, and a literal turns that into a test of how many
       rows the fixture happens to have — it broke the moment a childless
       invoice was added for an unrelated reason. */
    const total = await adapter.count('invoice');
    assert.equal(result.rows.length, total, 'every invoice survives the joins');
    const orphan = result.rows.find((r) => r.id === 1006)!;
    assert.equal(orphan['sold_by.last_name'], null);
    assert.equal(orphan['customer_id.country_code.name'], null);
    // And a row with the reference present still resolves it, so the nulls
    // above are the join missing rather than the join being broken.
    assert.equal(result.rows.find((r) => r.id === 1001)!['sold_by.last_name'], 'Petrova');
  });

  test('two paths through the same table get two aliases, and never collide', () => {
    /* work_order references employee three separate times. A scheme keyed on
       the target table alone produces three joins all called "employee" and a
       statement that does not parse. */
    const compiled = compileView(
      bigSchema,
      {
        id: 'v',
        name: 'v',
        base: 'work_order',
        columns: [{ path: 'raised_by.last_name' }, { path: 'assigned_to.last_name' }, { path: 'approved_by.last_name' }],
      },
      ANSI_STYLE,
    );
    const aliases = compiled.joins.map((j) => j.alias);
    assert.equal(aliases.length, 3);
    assert.equal(new Set(aliases).size, 3, 'aliases are unique');
    assert.deepEqual(
      compiled.joins.map((j) => j.path),
      ['raised_by', 'assigned_to', 'approved_by'],
    );
  });

  test('the same path used twice reuses one join', () => {
    const compiled = compileView(
      schema,
      view({
        columns: [{ path: 'customer_id.name' }, { path: 'customer_id.email' }, { path: 'customer_id.name', alias: 'again' }],
        filter: { groups: [[{ path: 'customer_id.credit_limit', op: '>', value: 0 }]] },
        orderBy: [{ path: 'customer_id.name', direction: 'asc' }],
      }),
      ANSI_STYLE,
    );
    assert.equal(compiled.joins.length, 1, 'one customer join, not four');
    assert.equal((compiled.text.match(/LEFT JOIN/g) ?? []).length, 1);
  });

  test('compilation is deterministic', () => {
    const def = view({
      columns: [{ path: 'customer_id.country_code.name' }, { path: 'sold_by.last_name' }],
    });
    assert.equal(compileView(schema, def, ANSI_STYLE).text, compileView(schema, def, ANSI_STYLE).text);
  });

  test('a composite foreign key joins on every column', () => {
    /* Joining a two-column key on one column is a cross product wearing a
       join's clothes: it compiles, it runs, and it returns too many rows. */
    const compiled = compileView(
      schema,
      {
        id: 'v',
        name: 'v',
        base: 'shipment',
        columns: [{ path: 'id' }, { path: 'invoice_id+line_no.sku' }],
      },
      ANSI_STYLE,
    );
    const on = compiled.text.match(/LEFT JOIN "invoice_line" "[^"]+" ON (.+)/)![1];
    assert.match(on, /"invoice_id" = /);
    assert.match(on, /"line_no" = /);
    assert.match(on, / AND /);
  });

  test('a self-reference works, including two hops of the same table', async () => {
    const compiled = compileView(
      schema,
      {
        id: 'v',
        name: 'v',
        base: 'employee',
        columns: [{ path: 'last_name' }, { path: 'manager_id.last_name' }, { path: 'manager_id.manager_id.last_name' }],
        orderBy: [{ path: 'id', direction: 'asc' }],
      },
      ANSI_STYLE,
    );
    assert.equal(compiled.joins.length, 2);
    assert.equal(new Set([...compiled.joins.map((j) => j.alias), 'employee_0']).size, 3);

    const result = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'employee',
      columns: [{ path: 'id' }, { path: 'manager_id.last_name' }, { path: 'manager_id.manager_id.last_name' }],
      orderBy: [{ path: 'id', direction: 'asc' }],
      limit: 100,
    });
    // Rina reports to Miles, who reports to Ada.
    const rina = result.rows.find((r) => r.id === 3)!;
    assert.equal(rina['manager_id.last_name'], 'Okonkwo');
    assert.equal(rina['manager_id.manager_id.last_name'], 'Fraser');
    // Ada is at the top: both hops miss, and she is still in the result.
    const ada = result.rows.find((r) => r.id === 1)!;
    assert.equal(ada['manager_id.last_name'], null);
  });

  test('every value is a bound parameter; only identifiers are quoted in', () => {
    const nasty = "'; DROP TABLE customer; --";
    const compiled = compileView(
      schema,
      view({
        filter: { groups: [[{ path: 'customer_id.name', op: '=', value: nasty }]] },
      }),
      ANSI_STYLE,
    );
    assert.ok(!compiled.text.includes('DROP'), 'the value never reaches the statement');
    assert.ok(compiled.params.includes(nasty));
  });

  test('an unknown base table is refused before anything is quoted', () => {
    assert.throws(() => compileView(schema, view({ base: 'no_such_table' }), ANSI_STYLE), /No table called "no_such_table"/);
  });

  test('both dialects: sqlite writes ?, postgres numbers across the statement', () => {
    const def = view({
      columns: [{ path: 'id' }, { path: 'customer_id.country_code.name' }],
      filter: {
        groups: [
          [
            { path: 'customer_id.name', op: 'contains', value: 'Harbour' },
            { path: 'total', op: '>', value: 100 },
          ],
        ],
      },
      limit: 7,
    });

    const sqlite = compileView(schema, def, ANSI_STYLE);
    assert.equal((sqlite.text.match(/\?/g) ?? []).length, 4, 'two conditions, a limit and an offset');
    assert.deepEqual(sqlite.params, ['%Harbour%', 100, 7, 0]);

    const pg = compileView(schema, def, POSTGRES_STYLE);
    assert.deepEqual(pg.params, sqlite.params, 'the same values, in the same order');
    /* The numbering is what a join builder gets wrong: the JOIN clauses sit
       between the SELECT list and the WHERE clause and carry no parameters,
       so it is easy to count them as if they did. */
    const holes = [...pg.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(holes, [1, 2, 3, 4]);
    assert.match(pg.text, /LIMIT \$3 OFFSET \$4/);
  });

  test('a postgres table reference is two identifiers, not one with a dot', () => {
    const pgSchema: DatabaseSchema = {
      label: 'pg',
      dialect: 'postgres',
      readAt: '',
      foreignKeys: [
        {
          name: 'line_invoice_fkey',
          from: { table: 'app.invoice_line', columns: ['invoice_id'] },
          to: { table: 'app.invoice', columns: ['id'] },
        },
      ],
      tables: [
        {
          id: 'app.invoice_line',
          name: 'invoice_line',
          schema: 'app',
          isView: false,
          columns: [
            { name: 'invoice_id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'line_no', type: 'integer', nullable: false, primaryKey: true },
          ],
        },
        {
          id: 'app.invoice',
          name: 'invoice',
          schema: 'app',
          isView: false,
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'total', type: 'numeric', nullable: true, primaryKey: false },
          ],
        },
      ],
    };
    const compiled = compileView(
      pgSchema,
      {
        id: 'v',
        name: 'v',
        base: 'app.invoice_line',
        columns: [{ path: 'line_no' }, { path: 'invoice_id.total' }],
      },
      POSTGRES_STYLE,
    );
    assert.match(compiled.text, /FROM "app"\."invoice_line"/);
    assert.match(compiled.text, /LEFT JOIN "app"\."invoice"/);
    assert.ok(!compiled.text.includes('"app.invoice"'));
  });

  test('a column reached through a join is reported as nullable even when it is NOT NULL', () => {
    /* The join can produce no row at all, so the result may hold a null the
       column itself forbids. Claiming otherwise would have the UI render a
       real null as a bug. */
    const compiled = compileView(schema, view({ columns: [{ path: 'customer_id.name' }] }), ANSI_STYLE);
    assert.equal(findTable(schema, 'customer')!.columns.find((c) => c.name === 'name')!.nullable, false);
    assert.equal(compiled.columns[0].nullable, true);
  });

  test('two paths ending on the same name keep both columns', () => {
    const compiled = compileView(
      bigSchema,
      {
        id: 'v',
        name: 'v',
        base: 'work_order',
        columns: [
          { path: 'raised_by.last_name', alias: 'who' },
          { path: 'assigned_to.last_name', alias: 'who' },
        ],
      },
      ANSI_STYLE,
    );
    assert.deepEqual(
      compiled.columns.map((c) => c.name),
      ['who', 'who_2'],
    );
  });

  test('an empty column list means the base table, not SELECT *', () => {
    const compiled = compileView(schema, view({ columns: [] }), ANSI_STYLE);
    assert.ok(!compiled.text.includes('*'));
    assert.equal(compiled.columns.length, findTable(schema, 'invoice')!.columns.length);
  });

  test('there is no path to an unlimited view', () => {
    for (const limit of [undefined, 0, -5, Number.NaN, 10_000_000] as unknown[]) {
      const compiled = compileView(schema, view({ limit: limit as number }), ANSI_STYLE);
      assert.match(compiled.text, /LIMIT/);
      assert.ok(compiled.limit >= 1 && compiled.limit <= MAX_LIMIT);
    }
  });
});

describe('view summaries', () => {
  /* A LEFT JOIN to a has-many multiplies: one invoice with three lines
     becomes three rows. An aggregate is the one-row-per-record answer to the
     same question, and compiles to a correlated subquery so that adding a
     second one cannot inflate the first. */

  const lineFk = () => referencesTo(schema, 'invoice').find((fk) => fk.from.table === 'invoice_line')!.name;

  test('a count compiles to a correlated subquery and adds no parameters', () => {
    const compiled = compileView(
      schema,
      {
        id: 'v',
        name: 'v',
        base: 'invoice',
        columns: [{ path: 'id' }],
        aggregates: [{ fn: 'count', via: lineFk() }],
        filter: { groups: [[{ path: 'total', op: '>', value: 100 }]] },
      },
      POSTGRES_STYLE,
    );

    assert.match(compiled.text, /\(SELECT COUNT\(\*\) FROM "invoice_line"/);
    // The whole point of the shape: the subquery carries no values, so the
    // numbering the WHERE clause depends on is untouched by however many
    // summaries a view collects.
    assert.deepEqual(compiled.params, [100, DEFAULT_LIMIT, 0]);
    assert.deepEqual(
      [...compiled.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      [1, 2, 3],
    );
  });

  test('a summary does not change how many rows come back', async () => {
    const plain = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'invoice',
      columns: [{ path: 'id' }],
      limit: 100,
    });
    const summarised = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'invoice',
      columns: [{ path: 'id' }],
      aggregates: [
        { fn: 'count', via: lineFk() },
        { fn: 'sum', via: lineFk(), column: 'quantity' },
      ],
      limit: 100,
    });
    assert.equal(summarised.rows.length, plain.rows.length, 'still one row per invoice');
    // Invoice 1004 has three lines, of 2 + 1 + 2.
    const row = summarised.rows.find((r) => r.id === 1004)!;
    assert.equal(Number(row['count(invoice_line)']), 3);
    assert.equal(Number(row['sum(invoice_line.quantity)']), 5);
  });

  test('count is zero over no children; sum is null', async () => {
    /* Deliberately different, and deliberately not coerced. There genuinely
       are no lines, so counting them gives 0 — but their total is not 0, it
       is a number nobody has. COALESCE here would be a claim about money that
       was never made. */
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const [{ id: childless }] = db
      .prepare('SELECT id FROM invoice WHERE id NOT IN (SELECT invoice_id FROM invoice_line) LIMIT 1')
      .all() as unknown as Array<{ id: number }>;
    db.close();

    const result = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'invoice',
      columns: [{ path: 'id' }],
      aggregates: [
        { fn: 'count', via: lineFk() },
        { fn: 'sum', via: lineFk(), column: 'quantity' },
      ],
      filter: { groups: [[{ path: 'id', op: '=', value: childless }]] },
      limit: 5,
    });
    assert.equal(Number(result.rows[0]['count(invoice_line)']), 0);
    assert.equal(result.rows[0]['sum(invoice_line.quantity)'], null);
  });

  test('a summary over a composite key matches every column of it', async () => {
    const shipmentFk = referencesTo(schema, 'invoice_line')[0].name;
    const compiled = compileView(
      schema,
      {
        id: 'v',
        name: 'v',
        base: 'invoice_line',
        columns: [{ path: 'invoice_id' }, { path: 'line_no' }],
        aggregates: [{ fn: 'count', via: shipmentFk }],
      },
      ANSI_STYLE,
    );
    const where = compiled.text.match(/FROM "shipment" "[^"]+" WHERE ([^)]+)\)/)![1];
    assert.match(where, /"invoice_id" = /);
    assert.match(where, /"line_no" = /);

    const result = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'invoice_line',
      columns: [{ path: 'invoice_id' }, { path: 'line_no' }],
      aggregates: [{ fn: 'count', via: shipmentFk }],
      orderBy: [
        { path: 'invoice_id', direction: 'asc' },
        { path: 'line_no', direction: 'asc' },
      ],
      limit: 100,
    });
    // Line (1001, 1) has one shipment; line (1003, 1) has none. Matching on
    // invoice_id alone would give the second one a shipment it does not have.
    const first = result.rows.find((r) => r.invoice_id === 1001 && r.line_no === 1)!;
    const none = result.rows.find((r) => r.invoice_id === 1003 && r.line_no === 1)!;
    assert.equal(Number(first['count(shipment)']), 1);
    assert.equal(Number(none['count(shipment)']), 0);
  });

  test('a summary alias cannot collide with a join alias', () => {
    /* Both a LEFT JOIN over employee and a subquery over employee in one
       statement is a self-join nobody asked for — and the wrong answer rather
       than an error, which is worse. */
    const managed = referencesTo(bigSchema, 'employee').find((fk) => fk.from.table === 'employee')!;
    const compiled = compileView(
      bigSchema,
      {
        id: 'v',
        name: 'v',
        base: 'work_order',
        columns: [{ path: 'assigned_to.last_name' }, { path: 'raised_by.last_name' }],
        aggregates: [{ fn: 'count', via: managed.name, on: 'assigned_to' }],
      },
      ANSI_STYLE,
    );
    const aliases = [...compiled.text.matchAll(/"(employee_\d+|work_order_\d+)"/g)].map((m) => m[1]);
    const joinAliases = compiled.joins.map((j) => j.alias);
    const subAlias = compiled.text.match(/FROM "employee" "(employee_\d+)" WHERE/)![1];
    assert.ok(!joinAliases.includes(subAlias), 'the subquery has an alias of its own');
    assert.ok(aliases.length > 0);
  });

  test('a summary can hang off a joined table', async () => {
    const invoiceLines = referencesTo(schema, 'invoice').find((fk) => fk.from.table === 'invoice_line')!;
    const result = await adapter.runView({
      id: 'v',
      name: 'v',
      base: 'shipment',
      columns: [{ path: 'id' }],
      aggregates: [{ fn: 'count', via: invoiceLines.name, on: 'invoice_id+line_no.invoice_id' }],
      orderBy: [{ path: 'id', direction: 'asc' }],
      limit: 100,
    });
    // Shipment 1 is on invoice 1001, which has two lines.
    assert.equal(Number(result.rows[0]['count(invoice_id+line_no.invoice_id.invoice_line)']), 2);
  });

  test('a summary that does not resolve says what does point at the table', () => {
    assert.throws(
      () =>
        compileView(
          schema,
          {
            id: 'v',
            name: 'v',
            base: 'invoice',
            columns: [{ path: 'id' }],
            aggregates: [{ fn: 'count', via: 'not_a_constraint' }],
          },
          ANSI_STYLE,
        ),
      /Nothing called "not_a_constraint" points at invoice/,
    );
  });

  test('a sum without a column is refused rather than guessed at', () => {
    assert.throws(
      () =>
        compileView(
          schema,
          {
            id: 'v',
            name: 'v',
            base: 'invoice',
            columns: [{ path: 'id' }],
            aggregates: [{ fn: 'sum', via: lineFk() }],
          },
          ANSI_STYLE,
        ),
      /needs a column/,
    );
  });
});

describe('the view query language', () => {
  test('a filter over paths compiles to conditions on paths', () => {
    const parsed = parseViewQuery(
      bigSchema,
      'work_order',
      'assigned_to.last_name = Petrova and customer_id.country_code.name = Australia',
      NOW,
    );
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(
      parsed.filter.groups[0].map((c) => c.path),
      ['assigned_to.last_name', 'customer_id.country_code.name'],
    );
  });

  test('clauses work over paths too', () => {
    const parsed = parseViewQuery(schema, 'invoice', 'customer_id.name contains Harbour sort customer_id.name desc limit 5', NOW);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.orderBy, [{ path: 'customer_id.name', direction: 'desc' }]);
    assert.equal(parsed.limit, 5);
  });

  test('relative dates resolve through a path, as they do on a column', () => {
    const parsed = parseViewQuery(schema, 'invoice_line', 'invoice_id.invoice_date = last year', NOW);
    assert.deepEqual(parsed.errors, []);
    /* One phrase, two bound timestamps — the same two the query bar produces,
       because it is the same compiler. */
    assert.equal(parsed.filter.groups[0].length, 2);
    assert.deepEqual(
      parsed.filter.groups[0].map((c) => c.op),
      ['>=', '<'],
    );
  });

  test('a broken path is reported once, naming the segment', () => {
    const parsed = parseViewQuery(schema, 'invoice', 'customer_id.emial contains x', NOW);
    assert.equal(parsed.errors.length, 1, 'not also "customer_id.emial is not a column on invoice"');
    assert.match(parsed.errors[0].message, /"emial" is not a column on customer/);
    assert.match(parsed.errors[0].message, /Did you mean "email"\?/);
  });

  test('a dotted value is not mistaken for a path', () => {
    /* `email = ops@harbour.example` used to report a confident error about a
       table nobody mentioned. A dotted word only counts as a field where a
       field can go. */
    const parsed = parseViewQuery(schema, 'customer', 'email = ops@harbour.example', NOW);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.filter.groups[0][0].value, 'ops@harbour.example');
  });

  test('a quoted value is never scanned for paths', () => {
    const parsed = parseViewQuery(schema, 'customer', 'name = "Smith.Jones"', NOW);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.filter.groups[0][0].value, 'Smith.Jones');
  });

  test('an escaped quote does not end a quoted value for the path scan', () => {
    /* The view's path scan had a quote mask of its own that ended a value at
       `\"`, so the rest of the value was read as a condition on a path. */
    const parsed = parseViewQuery(schema, 'customer', 'name = "x \\" or Smith.Jones = y"', NOW);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.filter.groups[0][0].value, 'x " or Smith.Jones = y');
  });

  test('a path filter round-trips through the compiler as bound parameters', () => {
    const parsed = parseViewQuery(schema, 'invoice', 'customer_id.name = "O\'Brien"', NOW);
    const compiled = compileView(
      schema,
      {
        id: 'v',
        name: 'v',
        base: 'invoice',
        columns: [{ path: 'id' }],
        filter: parsed.filter,
      },
      ANSI_STYLE,
    );
    assert.ok(!compiled.text.includes('Brien'));
    assert.ok(compiled.params.includes("O'Brien"));
  });
});

describe('views in the config file', () => {
  const at = 'tablewalk.json';

  test('a well-formed views array is read', () => {
    const views = parseViewsConfig(
      {
        views: [
          {
            name: 'Australian invoices',
            base: 'invoice',
            columns: ['id', { path: 'customer_id.name', alias: 'customer' }],
            aggregates: [{ fn: 'count', via: 'invoice_line_fk_1' }],
            filter: { groups: [[{ path: 'customer_id.country_code.name', op: '=', value: 'Australia' }]] },
            orderBy: [{ path: 'id', direction: 'desc' }],
            limit: 50,
          },
        ],
      },
      at,
    );
    assert.equal(views.length, 1);
    assert.equal(views[0].id, 'config-australian-invoices');
    assert.equal(views[0].source, 'config');
    assert.deepEqual(views[0].columns[1], { path: 'customer_id.name', alias: 'customer' });
  });

  test('no views section is not an error', () => {
    assert.deepEqual(parseViewsConfig({ connections: [] }, at), []);
  });

  test('a malformed entry is an error naming it, never a silent skip', () => {
    /* Dropping a view someone wrote gives them a shorter list and no reason
       for it — the failure this whole tool argues against. */
    const cases: Array<[unknown, RegExp]> = [
      [{ views: {} }, /"views" must be an array/],
      [{ views: [null] }, /view 1 is not an object/],
      [{ views: [{ base: 'invoice' }] }, /view 1 has no "name"/],
      [{ views: [{ name: 'x' }] }, /has no "base"/],
      [{ views: [{ name: 'x', base: 'invoice', columns: 'id' }] }, /"columns" that is not an array/],
      [{ views: [{ name: 'x', base: 'invoice', columns: [{}] }] }, /column 1 has no "path"/],
      [{ views: [{ name: 'x', base: 'invoice', filter: [] }] }, /"filter" that is not an object/],
      [{ views: [{ name: 'x', base: 'invoice', filter: { groups: [[{ path: 'a', op: 'nope' }]] } }] }, /unknown operator "nope"/],
      [{ views: [{ name: 'x', base: 'invoice', orderBy: [{ path: 'a', direction: 'sideways' }] }] }, /not "asc" or "desc"/],
      [{ views: [{ name: 'x', base: 'invoice', limit: 'lots' }] }, /"limit" that is not a number/],
      [{ views: [{ name: 'x', base: 'invoice', aggregates: [{ via: 'x' }] }] }, /unknown "fn"/],
      [{ views: [{ name: 'x', base: 'invoice', aggregates: [{ fn: 'sum', via: 'x' }] }] }, /needs a "column"/],
      [
        {
          views: [
            { name: 'a', base: 'i', id: 'dup' },
            { name: 'b', base: 'i', id: 'dup' },
          ],
        },
        /repeats the id "dup"/,
      ],
    ];
    for (const [config, message] of cases) {
      assert.throws(() => parseViewsConfig(config, at), message, JSON.stringify(config));
    }
  });

  test('a config view naming a table this connection lacks reports why', () => {
    /* Listed with its reason rather than dropped: the endpoint returns every
       view, and a broken one says what is broken about it. */
    const [broken] = parseViewsConfig({ views: [{ name: 'x', base: 'nope', columns: ['a'] }] }, at);
    assert.match(validateView(schema, broken)!, /No table called "nope"/);
    const [fine] = parseViewsConfig({ views: [{ name: 'y', base: 'invoice', columns: ['id'] }] }, at);
    assert.equal(validateView(schema, fine), undefined);
  });
});

describe('where a config file may live', () => {
  test('an explicit --config path is used as given, whatever it is called', () => {
    assert.deepEqual(configLocations('/somewhere/else.json'), ['/somewhere/else.json']);
  });
});

describe('ordering a view by an aggregate alias', () => {
  test('the alias orders, and a name that is no alias is refused with the fix', async () => {
    const view: ViewDef = {
      id: 'v',
      name: 'v',
      base: 'customer',
      columns: [{ path: 'name' }],
      aggregates: [{ fn: 'count', via: 'invoice_fk_1', alias: 'invoices' }],
      orderBy: [{ path: 'invoices', direction: 'desc', alias: true }],
      limit: 5,
    };
    const result = await adapter.runView!(view, 0);
    const counts = result.rows.map((r) => Number((r as { invoices: number }).invoices));
    assert.deepEqual(
      counts,
      [...counts].sort((a, b) => b - a),
    );

    await assert.rejects(
      () => adapter.runView!({ ...view, orderBy: [{ path: 'invoicez', direction: 'desc', alias: true }] }, 0),
      /"invoicez" is not an aggregate alias/,
    );
  });
});

describe('counting a view', () => {
  test('the count is base rows, and a join never changes it', async () => {
    /* Only true because every join in a view is to-one. That is the property
       the whole design rests on: a view does not multiply, so counting it is
       counting the table it started from — which is what makes an exact total
       affordable next to a paged result. */
    const plain = await adapter.count('invoice');
    const joined = await adapter.countView({
      id: 'v',
      name: 'v',
      base: 'invoice',
      columns: [{ path: 'id' }, { path: 'sold_by.last_name' }, { path: 'customer_id.country_code.name' }],
    });
    assert.equal(joined, plain, 'nulls on either join drop nothing');
  });

  test('the count honours the filter but not the page', async () => {
    const view: ViewDef = {
      id: 'v',
      name: 'v',
      base: 'invoice',
      columns: [{ path: 'id' }],
      filter: { groups: [[{ path: 'customer_id.name', op: 'contains', value: 'Harbour' }]] },
      limit: 1,
    };
    const rows = await adapter.runView(view);
    const total = await adapter.countView(view);
    assert.equal(rows.rows.length, 1, 'the page is one row');
    assert.ok(total > 1, 'the count is not');
  });

  test('the counting statement binds its values too', () => {
    const fragment = compileViewCount(
      schema,
      {
        id: 'v',
        name: 'v',
        base: 'invoice',
        columns: [{ path: 'id' }],
        filter: { groups: [[{ path: 'customer_id.name', op: '=', value: "'; DROP TABLE customer; --" }]] },
      },
      POSTGRES_STYLE,
    );
    assert.ok(!fragment.text.includes('DROP'));
    assert.match(fragment.text, /COUNT\(\*\)/);
    assert.match(fragment.text, /LEFT JOIN/);
    assert.deepEqual(
      [...fragment.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      [1],
    );
  });
});

describe('a view written down, in the config file', () => {
  test('the text form is carried through to be expanded later', () => {
    /* A config file is read before any connection is open, so text that names
       tables cannot be resolved there. It travels as text and is expanded
       against a live schema — which is also what lets the same file be used
       against two databases and fail loudly against the wrong one. */
    const [view] = parseViewsConfig(
      {
        views: [{ name: 'AU work', text: 'invoice show id, customer_id.name as customer where total > 100' }],
      },
      'tablewalk.json',
    );
    assert.equal(view.base, 'invoice', 'the base is read off the front of the text');
    assert.match(view.text!, /^invoice show/);
    assert.deepEqual(view.columns, []);
  });

  test('text and base together is an error, not a silent winner', () => {
    assert.throws(
      () => parseViewsConfig({ views: [{ name: 'x', base: 'invoice', text: 'invoice show id' }] }, 'tablewalk.json'),
      /has both "text" and "base"/,
    );
  });

  test('an empty text is refused', () => {
    assert.throws(
      () => parseViewsConfig({ views: [{ name: 'x', text: '   ' }] }, 'tablewalk.json'),
      /"text" that is not a non-empty string/,
    );
  });
});

describe('record templates', () => {
  /* A record template is bound to a table, not a row: configure work_order
     once and every work order is laid out that way. That is the difference
     from a list view, and the reason it is worth configuring at all. */

  test('a derived template covers fields, references and children', () => {
    const template = deriveTemplate(bigSchema, 'work_order')!;
    assert.equal(template.base, 'work_order');

    const kinds = template.sections.map((s) => s.kind);
    assert.equal(kinds[0], 'fields', 'the record itself comes first');
    assert.ok(kinds.includes('list'), 'children are tables on the page');

    /* Every one of its own columns appears exactly once, across whichever
       blocks the grouping put them in. Asserting on the first block alone
       tested the shape of the grouping rather than its completeness — which
       is the thing that matters, since a column silently missing from a
       record page is invisible by definition. */
    const own = fieldPaths(template).filter((p) => !p.includes('.'));
    const expected = findTable(bigSchema, 'work_order')!.columns.map((c) => c.name);
    assert.deepEqual(own.slice().sort(), expected.slice().sort());
    assert.equal(new Set(own).size, own.length, 'no column appears twice');
  });

  test('a to-one reference becomes an inline block, not every column of it', () => {
    /* Pulling a customer's whole record into a work order buries the work
       order. A few columns say what the row is; the rest is a walk away. */
    const template = deriveTemplate(bigSchema, 'work_order')!;
    const customerBlock = template.sections.find(
      (s): s is Extract<typeof s, { kind: 'fields' }> => s.kind === 'fields' && (s.title ?? '').startsWith('customer'),
    )!;
    assert.ok(customerBlock, 'the customer is pulled in');
    assert.ok(customerBlock.paths.length <= 5, 'a summary, not the whole record');
    assert.ok(
      customerBlock.paths.every((p) => p.startsWith('customer_id.')),
      customerBlock.paths.join(),
    );
  });

  test('the two self-references become two distinct sections', () => {
    /* work_order points at itself twice. Keyed by constraint, both survive;
       keyed by table, one would silently replace the other. */
    const template = deriveTemplate(bigSchema, 'work_order')!;
    /* Matched on the resolved child table, not on the title's prefix:
       `work_order_note` and `work_order_part` both start with `work_order`,
       so a prefix test counts four sections and the assertion fails against
       correct code. */
    const { lists } = resolveLists(bigSchema, template);
    const selfLists = lists.filter((l) => l.child.id === 'work_order');
    assert.equal(selfLists.length, 2);
    assert.notEqual(selfLists[0].section.via, selfLists[1].section.via);
    assert.deepEqual(selfLists.map((l) => l.fk.from.columns[0]).sort(), ['parent_id', 'supersedes_id']);
  });

  test('a child list drops the joining column and the key', () => {
    /* In a table of one work order's parts every row has the same
       work_order_id, so a column of it is a column of one repeated value. */
    const template = deriveTemplate(bigSchema, 'work_order')!;
    const parts = resolveLists(bigSchema, template).lists.find((l) => l.child.id === 'work_order_part')!.section;
    assert.ok(!parts.columns.includes('work_order_id'), parts.columns.join());
    assert.ok(parts.columns.includes('sku') || parts.columns.includes('quantity'), parts.columns.join());
  });

  test('lists resolve to a real key, with the join columns paired', () => {
    const template = deriveTemplate(bigSchema, 'work_order')!;
    const { lists, errors } = resolveLists(bigSchema, template);
    assert.deepEqual(errors, []);
    assert.ok(lists.length >= 3);
    for (const list of lists) {
      assert.equal(list.join.length, list.fk.from.columns.length);
      for (const pair of list.join) {
        assert.ok(list.child.columns.some((c) => c.name === pair.childColumn));
      }
    }
  });

  test('a composite key pairs every column, not just the first', () => {
    const template = deriveTemplate(schema, 'invoice_line')!;
    const { lists } = resolveLists(schema, template);
    const shipment = lists.find((l) => l.child.name === 'shipment')!;
    assert.equal(shipment.join.length, 2);
    assert.deepEqual(shipment.join.map((j) => j.childColumn).sort(), ['invoice_id', 'line_no']);
  });

  test('a dropped constraint is reported, never silently skipped', () => {
    /* A section that quietly stops rendering looks exactly like a record with
       no rows in it, which is the failure this whole codebase keeps refusing. */
    const template = deriveTemplate(bigSchema, 'work_order')!;
    template.sections.push({ kind: 'list', via: 'no_such_constraint', columns: [] });
    const { errors } = resolveLists(bigSchema, template);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /nothing called "no_such_constraint" points at work_order/);
  });

  test('field paths are collected once across every block', () => {
    // A page with six reference blocks should be one query, not six.
    const template = deriveTemplate(bigSchema, 'work_order')!;
    const paths = fieldPaths(template);
    assert.equal(new Set(paths).size, paths.length, 'no duplicates');
    assert.ok(paths.includes('reference'));
    assert.ok(paths.some((p) => p.startsWith('customer_id.')));
  });

  test('a table with no relationships still gets a usable template', () => {
    const template = deriveTemplate(bigSchema, 'country')!;
    assert.equal(template.sections.filter((s) => s.kind === 'fields').length >= 1, true);
    assert.equal(isEmpty(template), false);
  });
});

/* ---------- connection strings, taken apart and put back ---------- */

import {
  DEFAULT_PORTS,
  buildConnectionUrl,
  isEnvReference,
  looksSchemeless,
  parseConnectionUrl,
  redactConnectionUrl,
} from '../packages/tablewalk/src/client/connurl.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

describe('a connection string and its parts', () => {
  /* The dialog offers both a URL box and a set of fields, and they have to be
     the same thing rather than two forms that disagree. The fiddly half is
     percent-encoding, which is where a password containing `@` becomes a
     connection to a host that does not exist. */

  const roundTrip = (url: string) => buildConnectionUrl(parseConnectionUrl(url));

  describe('a URL with its scheme missing', () => {
    /* The name tablewalk prints for a connection is its public URL form, so
       copying that and pasting it back is an ordinary thing to do — and with
       no `://` it lands in the file-path branch and fails with SQLite's
       "unable to open database file". */
    test('is spotted by the user@host that no file path has', () => {
      assert.equal(looksSchemeless('postgres@127.0.0.1/tablewalk'), true);
      assert.equal(looksSchemeless('root@127.0.0.1:3306/db'), true);
      assert.equal(looksSchemeless('user@host'), true);
    });

    test('and a real file path is left alone', () => {
      /* The whole risk of the check: a false positive here turns a working
         SQLite path into a warning telling somebody to break it. */
      assert.equal(looksSchemeless('./data/app.db'), false);
      assert.equal(looksSchemeless('/Users/dev/x.db'), false);
      assert.equal(looksSchemeless('C:/db/app.db'), false);
      assert.equal(looksSchemeless('app.db'), false);
      assert.equal(looksSchemeless(''), false);
    });

    test('and so is a URL that already has one', () => {
      assert.equal(looksSchemeless('postgres://a@b/c'), false);
      assert.equal(looksSchemeless('sqlite:///tmp/x.db'), false);
    });
  });

  test('an ordinary URL survives being taken apart and put back', () => {
    for (const url of ['postgres://app@db.internal/appdb', 'postgres://app:secret@db.internal:6543/appdb']) {
      assert.equal(roundTrip(url), url, url);
    }
  });

  test('a password with punctuation in it survives, which is the whole point', () => {
    /* Written straight into a template string, `p@ss:word` names the host
       `word@db.internal` and the failure reads as "could not connect" rather
       than "your password has an @ in it". */
    const parts = parseConnectionUrl('postgres://app:p%40ss%3Aword@db.internal/appdb');
    assert.equal(parts.password, 'p@ss:word');
    const rebuilt = buildConnectionUrl(parts);
    assert.equal(new URL(rebuilt).hostname, 'db.internal');
    assert.equal(decodeURIComponent(new URL(rebuilt).password), 'p@ss:word');
  });

  test('a default port is not shown, and not written back', () => {
    /* A port box reading 5432 on every Postgres connection is a box nobody
       reads, and one that has to be cleared to mean "the default". */
    assert.equal(parseConnectionUrl('postgres://app@db/appdb').port, '');
    assert.equal(parseConnectionUrl(`postgres://app@db:${DEFAULT_PORTS.postgres}/appdb`).port, '');
    assert.equal(parseConnectionUrl('postgres://app@db:6543/appdb').port, '6543');
    assert.equal(buildConnectionUrl({ driver: 'postgres', host: 'db', database: 'appdb' }), 'postgres://db/appdb');
  });

  test('query parameters are kept whole', () => {
    /* `?sslmode=require` is not decoration: losing it on a round trip through
       a form turns a verified connection into a plaintext one, silently. */
    const url = 'postgres://app@db/appdb?sslmode=require&application_name=tablewalk';
    assert.equal(parseConnectionUrl(url).params, 'sslmode=require&application_name=tablewalk');
    assert.equal(roundTrip(url), url);
  });

  test('a file path is a file path, not a URL with empty parts', () => {
    const parts = parseConnectionUrl('/var/data/app.sqlite');
    assert.equal(parts.driver, 'sqlite');
    assert.equal(parts.file, '/var/data/app.sqlite');
    assert.equal(parts.host, '', 'a file has no host to invent');
    assert.equal(roundTrip('/var/data/app.sqlite'), '/var/data/app.sqlite');
    assert.equal(parseConnectionUrl('sqlite:///var/data/app.sqlite').file, '/var/data/app.sqlite');
  });

  test('half a URL is the normal state of a box being typed in, not an error', () => {
    for (const partial of ['', 'postgres://', 'post', 'postgres://@']) {
      assert.doesNotThrow(() => parseConnectionUrl(partial), partial);
    }
    // And a set of parts with no host yet builds nothing rather than nonsense.
    assert.equal(buildConnectionUrl({ driver: 'postgres', host: '', database: 'appdb' }), '');
  });

  test('an environment reference survives the form that was meant to support it', () => {
    /* The arrangement the documentation recommends *first*, and the one the
       form quietly destroyed: `encodeURIComponent('${PROD_PASSWORD}')` is
       `%24%7BPROD_PASSWORD%7D`, which `expandEnv` does not match — so typing
       a reference into the password box produced a connection whose password
       was the literal characters of the reference, with nothing on screen to
       say so. */
    for (const password of ['${PROD_PASSWORD}', '$PGPASS']) {
      const url = buildConnectionUrl({ driver: 'postgres', host: 'db', database: 'appdb', user: 'app', password });
      assert.ok(url.includes(password), url);
      assert.ok(!url.includes('%24'), url);
    }

    /* Part literal, part reference — which people write — encodes the half
       that needs it and leaves the half that must not be touched. */
    const mixed = buildConnectionUrl({ driver: 'postgres', host: 'db', database: 'appdb', user: 'app', password: 'pre@fix-${TOKEN}' });
    assert.ok(mixed.includes('${TOKEN}'), mixed);
    assert.ok(mixed.includes('%40'), 'and the @ beside it is still encoded');

    // A password that merely looks like money is not a reference.
    assert.equal(isEnvReference('$100 and up'), false);
    assert.equal(isEnvReference('p@ss:word'), false);
    assert.equal(isEnvReference('${PROD_PASSWORD}'), true);
  });

  test('the preview shows a reference and hides a secret', () => {
    /* A reference names a variable and reveals nothing, and it is the part
       worth reading back carefully — dotting it out would remove the only way
       to notice the variable name is misspelled. */
    assert.equal(redactConnectionUrl('postgres://app:${PROD_PASSWORD}@db/appdb'), 'postgres://app:${PROD_PASSWORD}@db/appdb');
    assert.ok(!redactConnectionUrl('postgres://app:hunter2@db/appdb').includes('hunter2'));
  });

  test('the preview hides the password without hiding the rest', () => {
    const shown = redactConnectionUrl('postgres://app:hunter2@db.internal:6543/appdb');
    assert.ok(!shown.includes('hunter2'), shown);
    assert.ok(shown.includes('app'), 'the user is still legible');
    assert.ok(shown.includes('db.internal:6543'), 'and so is where it goes');
    assert.ok(shown.includes('••••'), shown);
    // Nothing to hide, nothing changed.
    assert.equal(redactConnectionUrl('postgres://app@db/appdb'), 'postgres://app@db/appdb');
    assert.equal(redactConnectionUrl('/var/data/app.sqlite'), '/var/data/app.sqlite');
  });
});

describe('sectionFromText: the workbench-to-config bridge', () => {
  test('the kind is read off the shape, and the conditions survive as typed', () => {
    const emit = (text: string) => sectionFromText(schema, text);
    assert.deepEqual(emit('invoice status = paid sum total as revenue by status'), {
      kind: 'breakdown',
      table: 'invoice',
      query: 'status = paid',
      measure: 'sum total as revenue',
      by: 'status',
    });
    assert.deepEqual(emit('invoice count by month invoice_date'), {
      kind: 'chart',
      table: 'invoice',
      by: 'month invoice_date',
    });
    assert.deepEqual(emit('invoice sum total by status, month invoice_date'), {
      kind: 'matrix',
      table: 'invoice',
      measure: 'sum total',
      by: 'status, month invoice_date',
    });
    assert.deepEqual(emit('invoice status = paid sum total'), {
      kind: 'metric',
      table: 'invoice',
      query: 'status = paid',
      measure: 'sum total',
    });
    assert.equal(emit('invoice staus = paid count by status'), null, 'a line with errors emits nothing');
  });
});
