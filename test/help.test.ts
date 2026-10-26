/**
 * The examples the help panel and the empty state offer.
 *
 * The generator is a pure function of the schema and a few sampled rows
 * precisely so it can be tested here rather than by clicking: an example is a
 * link that runs a query, and one that does not parse is a landing page
 * teaching a language the tool does not speak.
 *
 * So every test below asks the same question in a different shape — does this
 * text survive the real compiler? The check mirrors what /api/run does with
 * the bar's contents, including the fall-through to a view, because a
 * dot-walked path is not a legal single-table query and is a perfectly good
 * one-line view.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDemoDatabase } from './make-demo-db.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { resolveOrder, findTable, type DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { buildExamples } from '../packages/kit/src/client/helpContent.js';

/* Made for this run and removed after it — never `.demo/`, where a
   developer's demo databases and credentials are. */
const DB_DIR = mkdtempSync(join(tmpdir(), 'tablewalk-help-'));
const DB_FILE = join(DB_DIR, 'test-help.db');
let adapter: SqliteAdapter;
let schema: DatabaseSchema;

before(async () => {
  makeDemoDatabase(DB_FILE);
  adapter = new SqliteAdapter(DB_FILE, 'help');
  schema = await adapter.introspect();
});

after(async () => {
  await adapter.close();
  rmSync(DB_DIR, { recursive: true, force: true });
});

/** What the server does with the query bar's text, minus the HTTP. */
async function run(text: string): Promise<{ errors: string[]; rows: unknown[] }> {
  const parsed = parseQuery(text, { schema });
  if (parsed.query && !parsed.errors.length) {
    const table = findTable(schema, parsed.query.table)!;
    const { order } = resolveOrder(table, parsed.query.orderBy);
    const result = await adapter.query({ ...parsed.query, orderBy: order, limit: parsed.query.limit ?? 20, offset: 0 });
    return { errors: [], rows: result.rows };
  }
  const asView = textToView(schema, text, { id: 'help', name: '' });
  if (asView.view && !asView.errors.length) {
    const result = await adapter.runView(asView.view);
    return { errors: [], rows: result.rows };
  }
  return {
    errors: [...parsed.errors, ...asView.errors].map((e) => e.message),
    rows: [],
  };
}

/** A sample of the shape the client fetches: the first few rows of a table. */
async function sample(tableId: string) {
  const table = findTable(schema, tableId)!;
  const { order } = resolveOrder(table, undefined);
  const { rows } = await adapter.query({ table: tableId, orderBy: order, limit: 5, offset: 0 });
  return { [tableId]: rows };
}

/* A schema with tables and not one foreign key. SQLite files like this are
   common — an export, a scratch database, anything CSV-shaped — and the
   dot-walk example is the one that cannot survive it. */
const FLAT: DatabaseSchema = {
  label: 'flat',
  dialect: 'sqlite',
  readAt: '2026-01-01T00:00:00.000Z',
  foreignKeys: [],
  tables: [
    {
      name: 'event',
      schema: '',
      id: 'event',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'kind', type: 'TEXT', nullable: true, primaryKey: false },
        { name: 'happened_at', type: 'DATE', nullable: true, primaryKey: false },
      ],
    },
  ],
};

describe('generated examples', () => {
  test('every example on the demo schema parses and runs', async () => {
    const { examples } = buildExamples(schema, await sample(buildExamples(schema).sampleTable!));
    assert.ok(Object.keys(examples).length >= 8, 'the demo schema should support most of the grammar');

    for (const [key, example] of Object.entries(examples)) {
      const { errors } = await run(example.query);
      assert.deepEqual(errors, [], `${key}: ${example.query}`);
    }
  });

  test('the three on the empty state return rows, not an empty grid', async () => {
    const { starters, sampleTable } = buildExamples(schema, await sample(buildExamples(schema).sampleTable!));
    assert.equal(starters.length, 3);
    assert.ok(sampleTable);

    for (const starter of starters) {
      const { errors, rows } = await run(starter.query);
      assert.deepEqual(errors, [], starter.query);
      /* Rows, not merely no errors. A filter built from a guessed value
         compiles perfectly and comes back empty, which is the failure this
         language exists to prevent — an empty result reads as an empty table
         rather than as a mistake. */
      assert.ok(rows.length > 0, `${starter.key} returned nothing: ${starter.query}`);
    }
  });

  test('the three are a filter, a walk and an order', async () => {
    const { starters } = buildExamples(schema, await sample('invoice'));
    assert.deepEqual(
      starters.map((s) => s.key),
      ['filter', 'dotwalk', 'sort'],
    );
    assert.match(starters[1].query, /\w+\.\w+/, 'the walk should follow at least one reference');
  });

  test('a walk crosses two references when the graph allows', () => {
    const { examples } = buildExamples(schema);
    // customer_id → customer, country_code → country: two hops, ending on a
    // column a person can read.
    assert.equal(examples.dotwalk.query.split('.').length, 3, examples.dotwalk.query);
  });

  test('sampled values are used, so a filter example matches something', async () => {
    const rows = await sample('customer');
    const { examples } = buildExamples(schema, rows);
    const value = String(rows.customer[0].country_code ?? '');
    assert.ok(examples.filter.query.includes(value) || examples.filter.query.includes('is not empty'), examples.filter.query);
  });

  test('without a sample, the examples still parse and run', async () => {
    const { examples } = buildExamples(schema);
    for (const [key, example] of Object.entries(examples)) {
      const { errors } = await run(example.query);
      assert.deepEqual(errors, [], `${key}: ${example.query}`);
    }
  });
});

describe('schemas that cannot support every example', () => {
  test('no foreign keys means no dot-walk example rather than a broken one', () => {
    const { examples, starters } = buildExamples(FLAT);
    assert.equal(examples.dotwalk, undefined);
    assert.equal(examples.dotfilter, undefined);
    // The empty state fills the gap rather than showing two of three.
    assert.deepEqual(
      starters.map((s) => s.key),
      ['filter', 'sort', 'table'],
    );
    for (const example of Object.values(examples)) {
      assert.match(example.query, /^event\b/);
      assert.doesNotMatch(example.query, /\w\.\w/, example.query);
    }
  });

  test('an empty schema produces nothing at all', () => {
    const empty = { ...FLAT, tables: [] };
    assert.deepEqual(buildExamples(empty), { sampleTable: null, examples: {}, starters: [] });
    assert.deepEqual(buildExamples(undefined as never).starters, []);
  });

  test('a table with no date column falls back to sorting by its label', () => {
    const undated: DatabaseSchema = {
      ...FLAT,
      tables: [{ ...FLAT.tables[0], columns: FLAT.tables[0].columns.slice(0, 3) }],
    };
    const { examples } = buildExamples(undated);
    assert.equal(examples.dates, undefined);
    assert.equal(examples.sort.query, 'event sort name limit 10');
  });

  test('the same schema always produces the same examples', () => {
    // An example that moves between reloads reads as a bug in the tool rather
    // than as a tour of the schema.
    assert.deepEqual(buildExamples(schema), buildExamples(schema));
  });
});
