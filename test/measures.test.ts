/**
 * The measures beyond one aggregate: `median`, a ratio (one measure over
 * another) and computed measures — aggregates and numbers joined by
 * `+ - * /`. Parsed and written back, compiled, run on SQLite and on a live
 * PostgreSQL, and refused where the dialect has no median. A metric's
 * target read from data is judged at load in the metric's own words.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { compileBreakdown, withBreakdownComputed } from '../packages/engine/src/shared/breakdown.js';
import { breakdownToText, textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { MYSQL_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseAppConfig, resolveViews, withRollups, type AppDashboardView } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';

const SEED = `INSERT INTO {deal} (id, stage, amount, won, closed) VALUES
  (1, 'won', 100, 100, true), (2, 'won', 300, 300, true), (3, 'lost', 200, 0, true), (4, 'open', 400, 0, false),
  (5, 'open', 1000, 0, false)`;

const schemaOf = (dialect: string): DatabaseSchema =>
  ({
    dialect,
    tables: [
      {
        id: 'deal',
        name: 'deal',
        columns: [
          { name: 'id', type: 'integer', pk: true },
          { name: 'stage', type: 'text' },
          { name: 'amount', type: 'numeric' },
          { name: 'won', type: 'numeric' },
        ],
      },
    ],
    foreignKeys: [],
  }) as unknown as DatabaseSchema;

test('a computed measure parses, writes back and compiles in its own order', () => {
  const schema = schemaOf('postgres');
  const parsed = textToBreakdown(schema, 'deal stage != lost sum won / sum amount as rate, sum amount - sum won by stage sort rate desc');
  assert.deepEqual(parsed.errors, []);
  const [rate, open] = parsed.breakdown!.measures;
  assert.deepEqual(rate, { fn: 'sum', path: 'won', steps: [{ op: '/', term: { fn: 'sum', path: 'amount' } }], alias: 'rate' });
  assert.deepEqual(open.steps, [{ op: '-', term: { fn: 'sum', path: 'won' } }]);
  assert.equal(
    breakdownToText(schema, parsed.breakdown!),
    'deal where stage != lost sum won / sum amount as rate, sum amount - sum won by stage sort rate desc',
  );
  const sql = compileBreakdown(schema, parsed.breakdown!, POSTGRES_STYLE).text;
  assert.match(sql, /\(SUM\("deal_0"\."won"\) \/ NULLIF\(1\.0 \* SUM\("deal_0"\."amount"\), 0\)\) AS "rate"/);
  assert.match(sql, /\(SUM\("deal_0"\."amount"\) - SUM\("deal_0"\."won"\)\) AS "sum\(amount\) - sum\(won\)"/);
  // A number is a term; a condition's trailing number is never read as a measure.
  assert.deepEqual(textToBreakdown(schema, 'deal count * 100 / count').breakdown!.measures[0].steps, [
    { op: '*', term: 100 },
    { op: '/', term: { fn: 'count' } },
  ]);
  assert.equal(textToBreakdown(schema, 'deal amount > 5 count').breakdown!.measures[0].fn, 'count');
});

/* An App whose deals say whether each is won: a computed yes-or-no over the deal's own stage. */
const wonApp = (deal: string) =>
  parseAppConfig(
    {
      id: 'deals',
      name: 'Deals',
      resources: { [deal]: { computed: { is_won: { type: 'boolean', value: "stage = 'won'" } } } },
      views: { deals: { kind: 'list', from: deal } },
      home: 'deals',
    },
    'measures fixture',
  );

test('an average of a yes-or-no is read as 0 and 1 on PostgreSQL, which has no avg(boolean)', () => {
  const schema = withRollups(wonApp('deal'), schemaOf('postgres'));
  const parsed = textToBreakdown(schema, 'deal avg is_won * 100 as won_rate, sum is_won as won');
  assert.deepEqual(parsed.errors, []);
  const { text: _text, ...def } = parsed.breakdown!;
  const sql = compileBreakdown(schema, withBreakdownComputed(schema, def), POSTGRES_STYLE).text;
  assert.match(sql, /\(AVG\(CAST\(\(+CASE WHEN [^]*? THEN TRUE ELSE FALSE END\)+ AS INTEGER\)\) \* 100\) AS "won_rate"/);
  assert.match(sql, /SUM\(CAST\([^]*? AS INTEGER\)\) AS "won"/);
});

test("median is PostgreSQL's, and refused on SQLite and MySQL with the reason", () => {
  assert.deepEqual(textToBreakdown(schemaOf('postgres'), 'deal median amount by stage').errors, []);
  for (const [dialect, word] of [
    ['sqlite', 'SQLite'],
    ['mysql', 'MySQL'],
  ] as const) {
    const { errors } = textToBreakdown(schemaOf(dialect), 'deal sum won / median amount');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, new RegExp(`\`median\` is not available on ${word}: it has no median aggregate`));
  }
  const def = textToBreakdown(schemaOf('postgres'), 'deal median amount').breakdown!;
  assert.throws(() => compileBreakdown(schemaOf('mysql'), def, MYSQL_STYLE), /not available on MySQL/);
});

test('a structured breakdown from a request names its function and period by word: SQL in either is refused, never written', () => {
  // `/api/breakdown` takes a `def` as well as text; an App reader's scope and grants are compiled around what it says.
  const injected = '(SELECT 42)+sum';
  for (const def of [
    { base: 'deal', by: [], measures: [{ fn: injected, path: 'amount' }] },
    { base: 'deal', by: [], measures: [{ fn: 'count', steps: [{ op: '+', term: { fn: injected, path: 'amount' } }] }] },
    { base: 'deal', by: [{ path: 'stage', bucket: "day', 'x') --" }], measures: [{ fn: 'count' }] },
  ]) {
    for (const [dialect, style] of [
      ['postgres', POSTGRES_STYLE],
      ['mysql', MYSQL_STYLE],
    ] as const) {
      assert.throws(() => compileBreakdown(schemaOf(dialect), def as never, style), /is not a measure|is not a period/);
    }
  }
});

test("a metric's target from data is judged in the metric's words at load", () => {
  const column = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema = {
    label: 'Deals',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'deal',
        name: 'deal',
        schema: '',
        isView: false,
        columns: [column('id', 'INTEGER', true), column('stage'), column('won', 'NUMERIC')],
      },
      { id: 'quota', name: 'quota', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('amount', 'NUMERIC')] },
    ],
  } as unknown as DatabaseSchema;
  const served = (target: unknown) => {
    const parsed = parseAppConfig(
      {
        name: 'Deals',
        resources: { deal: {}, quota: {} },
        views: {
          deals: { kind: 'list', from: 'deal', show: ['stage'] },
          overview: {
            kind: 'dashboard',
            label: 'Overview',
            sections: [{ kind: 'metric', title: 'Won', from: 'deal', measure: 'sum won', target }],
          },
        },
        home: 'deals',
        nav: ['deals', 'overview'],
      },
      'measures fixture',
    );
    return resolveViews(parsed, schema).overview as AppDashboardView;
  };
  const ok = served({ from: 'quota', measure: 'sum amount' });
  assert.equal(ok.error, undefined, ok.error);
  assert.deepEqual(ok.sections[0].target, { table: 'quota', measure: 'sum amount' });
  // An unwritten table and measure are the metric's.
  assert.deepEqual(served({ query: 'stage = won' }).sections[0].target, { table: 'deal', query: 'stage = won', measure: 'sum won' });
  assert.match(served({ from: 'quota', measure: 'sum nothing' }).error ?? '', /Section "Won" target: .*nothing/);
  assert.match(served({ from: 'quota', measure: 'median amount' }).error ?? '', /target: `median` is not available on SQLite/);
  assert.throws(() => served({ from: 'quota', bogus: 1 }), /"bogus"/);
  assert.throws(() => served({ from: 'nowhere' }), /"target", "from" names "nowhere"/);
  assert.throws(() => served('a lot'), /not a number, or the "from", "query" and "measure"/);
});

const n = (value: unknown) => (value === null ? null : Number(value));

async function proves(adapter: Adapter, schema: DatabaseSchema, deal: string, median: boolean) {
  const rows = async (text: string) => {
    const parsed = textToBreakdown(schema, text.replace('{deal}', deal));
    assert.deepEqual(parsed.errors, [], text);
    const { text: _text, ...def } = parsed.breakdown!;
    return (await adapter.runBreakdown!(withBreakdownComputed(schema, def))).rows;
  };
  const [whole] = await rows('{deal} sum won / sum amount as rate, count * 100 / count as hundred, sum amount - sum won as open');
  // A yes-or-no averages as 0 and 1 on every engine, computed or stored.
  const app = withRollups(wonApp(schema.tables.find((table) => table.id === deal)!.name), schema);
  const parsed = textToBreakdown(app, `${deal} avg is_won * 100 as won_rate, avg closed as closed_rate, sum is_won as won`);
  assert.deepEqual(parsed.errors, []);
  const { text: _text, ...wonDef } = parsed.breakdown!;
  const [rate] = (await adapter.runBreakdown!(withBreakdownComputed(app, wonDef))).rows;
  assert.equal(n(rate.won_rate), 40);
  assert.equal(n(rate.closed_rate), 0.6);
  assert.equal(n(rate.won), 2);
  assert.equal(n(whole.rate), 0.2);
  assert.equal(n(whole.hundred), 100);
  assert.equal(n(whole.open), 1600);
  // A zero divisor is an empty answer, never an error; integer counts do not divide to zero.
  const byStage = await rows('{deal} sum won / sum won as self, count / 3 as third by stage sort stage');
  assert.deepEqual(
    byStage.map((row) => [row.stage, row.self === null ? null : n(row.self)]),
    [
      ['lost', null],
      ['open', null],
      ['won', 1],
    ],
  );
  assert.ok(Math.abs(Number(byStage[0].third) - 1 / 3) < 1e-9);
  if (median) {
    const medians = await rows('{deal} median amount by stage sort stage');
    assert.deepEqual(
      medians.map((row) => [row.stage, n(row['median(amount)'])]),
      [
        ['lost', 200],
        ['open', 700],
        ['won', 200],
      ],
    );
  }
}

test('measures on SQLite: the same numbers', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { SqliteAdapter } = await import('../packages/engine/src/adapters/sqlite.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-measures-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'deal.db'));
  db.exec(`CREATE TABLE deal (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, amount INTEGER NOT NULL, won INTEGER NOT NULL,
    closed INTEGER NOT NULL CHECK (closed IN (0, 1)));
    ${SEED.replace('{deal}', 'deal')};`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'deal.db'), 'deal');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  assert.match(textToBreakdown(schema, 'deal median amount').errors[0]?.message ?? '', /not available on SQLite/);
  await proves(adapter, schema, 'deal', false);
});

const PG = process.env.TABLEWALK_TEST_PG;
describe('measures on PostgreSQL', { skip: liveSkip('postgres', PG) }, () => {
  const name = `tw_measure_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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
      await db.query(
        `CREATE TABLE public.${name} (id integer PRIMARY KEY, stage text NOT NULL, amount integer NOT NULL, won integer NOT NULL,
          closed boolean NOT NULL)`,
      );
      await db.query(SEED.replace('{deal}', `public.${name}`));
    } finally {
      await db.end();
    }
    adapter = new PostgresAdapter(PG!, 'measures');
  });
  after(async () => {
    await adapter?.close();
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.${name}`);
    } finally {
      await db.end();
    }
  });

  test('the same numbers, and a median', async () => {
    const schema = await adapter.introspect();
    await proves(adapter, schema, schema.tables.find((table) => table.name === name)!.id, true);
  });
});
