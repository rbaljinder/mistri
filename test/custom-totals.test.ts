/**
 * A custom section's aggregate reads (`figures`): a count, sum, average, minimum or maximum the server measures,
 * where a component that counted the rows it had read was wrong past the 500 a read returns. Parsed and refused
 * on a page and on a dashboard, planned as the breakdown a page's own figures are, run on SQLite past 500 rows,
 * and answered to the component by position, not by the names the server gave the columns.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { MAX_CUSTOM_FIGURES } from '../packages/engine/src/shared/appComponents.js';
import { parseAppConfig, resolveViews, type AppDashboardView } from '../packages/mistri/src/shared/app.js';
import { totalFigure, totalGroups } from '../packages/mistri/src/shared/customTotals.js';
import { withBreakdownComputed } from '../packages/engine/src/shared/breakdown.js';
import { parsePagesConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';

const summary = { id: 'sales-summary', module: './widgets/SalesSummary.tsx', kind: 'section' };

const page = (figures: object, extra: object = {}): PageDef =>
  parsePagesConfig(
    {
      pages: [{ id: 'account', base: 'account', label: 'Account', sections: [{ kind: 'custom', component: summary, figures, ...extra }] }],
    },
    'fixture',
  )[0];

const section = (definition: PageDef) => definition.sections[0] as unknown as { aggregates?: Record<string, object> };

async function database(t: { after(run: () => void): void }, rows: number) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-totals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sales.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE sale (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), status TEXT NOT NULL,
      amount INTEGER NOT NULL);
    INSERT INTO account VALUES (1, 'Ada'), (2, 'Grace');`);
  const insert = db.prepare('INSERT INTO sale (account_id, status, amount) VALUES (?, ?, ?)');
  for (let i = 0; i < rows; i++) insert.run(i % 5 === 0 ? 2 : 1, i % 3 === 0 ? 'won' : 'open', 10);
  db.close();
  const adapter = new SqliteAdapter(file, 'sales');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect() };
}

test('a page section declares aggregate reads, which are parsed in the breakdown grammar and kept to a few', () => {
  const definition = page({
    all: { from: 'sale', measure: 'count', whose: 'account_id' },
    won: { from: 'sale', measure: 'sum amount', whose: 'account_id', query: 'status = won' },
    byStatus: { from: 'sale', measure: 'avg amount', by: 'status', whose: 'account_id', limit: 5 },
  });
  assert.deepEqual(section(definition).aggregates, {
    all: { from: 'sale', fn: 'count', path: 'account_id' },
    won: { from: 'sale', fn: 'sum', column: 'amount', path: 'account_id', filter: 'status = won' },
    byStatus: { from: 'sale', fn: 'avg', column: 'amount', by: 'status', path: 'account_id', limit: 5 },
  });
  assert.throws(() => page({ x: { from: 'sale' } }), /no "measure"/);
  assert.throws(() => page({ x: { from: 'sale', measure: 'sum' } }), /no "measure"/);
  assert.throws(() => page({ x: { from: 'sale', measure: 'median amount' } }), /no "measure"/);
  assert.throws(() => page({ x: { from: 'sale', measure: 'count', limit: 3 } }), /"limit" and no "by"/);
  assert.throws(() => page({ x: { from: 'sale', measure: 'count', by: 'status', limit: 501 } }), /from 1 to 500/);
  assert.throws(() => page({ x: { from: 'sale', measure: 'count', over: 'at' } }), /over/);
  const many = Object.fromEntries(Array.from({ length: MAX_CUSTOM_FIGURES + 1 }, (_, i) => [`t${i}`, { from: 'sale', measure: 'count' }]));
  assert.throws(() => page(many), new RegExp(`at most ${MAX_CUSTOM_FIGURES}`));
});

test('an aggregate read is judged against the catalog before a reader sees the section', async (t) => {
  const { schema } = await database(t, 1);
  assert.equal(
    validatePage(schema, page({ n: { from: 'sale', measure: 'sum amount', whose: 'account_id', by: 'status' } })).error,
    undefined,
  );
  assert.match(
    validatePage(schema, page({ n: { from: 'sale', measure: 'sum amunt' } })).error ?? '',
    /figures "n": "amunt" is not a column/,
  );
  assert.match(validatePage(schema, page({ n: { from: 'sal', measure: 'count' } })).error ?? '', /"sal" is not a table/);
  assert.match(validatePage(schema, page({ n: { from: 'sale', measure: 'count', by: 'stauts' } })).error ?? '', /figures "n"/);
  assert.match(validatePage(schema, page({ n: { from: 'sale', measure: 'count', by: 'status, amount' } })).error ?? '', /one key/);
  assert.match(validatePage(schema, page({ n: { from: 'sale', measure: 'count', whose: 'status' } })).error ?? '', /figures "n"/);
  assert.match(validatePage(schema, page({ n: { from: 'sale', measure: 'count', query: 'nope = 1' } })).error ?? '', /figures "n"/);
});

test('a total is planned as a breakdown over every row, anchored on the record, and counts past the 500 a read returns', async (t) => {
  const { adapter, schema } = await database(t, 1300);
  const definition = validatePage(
    schema,
    page(
      {
        all: { from: 'sale', measure: 'count', whose: 'account_id' },
        won: { from: 'sale', measure: 'sum amount', whose: 'account_id', query: 'status = won' },
        byStatus: { from: 'sale', measure: 'count', by: 'status', whose: 'account_id' },
        everyone: { from: 'sale', measure: 'max amount' },
      },
      { rows: { sales: { from: 'sale', whose: 'account_id', show: ['id'], limit: 500 } } },
    ),
  );
  assert.equal(definition.error, undefined);
  const [plan] = planPageSections(schema, definition, { id: 1 }, {}, new Date());
  assert.equal(plan.kind, 'custom');
  const aggregates = (plan as { aggregates: Record<string, { breakdown?: Parameters<typeof withBreakdownComputed>[1]; error?: string }> })
    .aggregates;
  assert.deepEqual(Object.keys(aggregates), ['all', 'won', 'byStatus', 'everyone']);
  for (const each of Object.values(aggregates)) assert.equal(each.error, undefined);
  const run = async (name: string) => (await adapter.runBreakdown!(withBreakdownComputed(schema, aggregates[name].breakdown!))).rows;

  // Account 1 owns 1040 of the 1300 sales: the figure is the count, where its `rows` read stops at 500.
  assert.equal(Number(totalFigure(await run('all'))), 1040);
  assert.equal(Number(totalFigure(await run('everyone'))), 10);
  const won = Number(totalFigure(await run('won')));
  assert.ok(won > 0 && won % 10 === 0 && won < 10_400);
  const groups = totalGroups(await run('byStatus'));
  assert.deepEqual(groups.map((group) => group.key).sort(), ['open', 'won']);
  assert.equal(
    groups.reduce((sum, group) => sum + Number(group.value), 0),
    1040,
  );
  assert.equal(aggregates.byStatus.breakdown!.limit, 100);
  assert.equal(aggregates.all.breakdown!.limit, 1);
});

test('an answer is read by position: one figure, or each group with its key, figure and name', () => {
  assert.equal(totalFigure([{ 'sum(net)': 12.5 }]), 12.5);
  assert.equal(totalFigure([{ value: '9007199254740993' }]), '9007199254740993', 'a wide number stays text');
  assert.equal(totalFigure([]), null);
  assert.equal(totalFigure(undefined), null);
  assert.equal(totalFigure([{ value: null }]), null);
  assert.deepEqual(
    totalGroups([
      { key_1: 4, value: 3, label: 'Ada' },
      { key_1: null, value: 1 },
    ]),
    [
      { key: 4, value: 3, label: 'Ada' },
      { key: null, value: 1 },
    ],
  );
  assert.deepEqual(totalGroups([{ status: 'open', count: 7 }]), [{ key: 'open', value: 7 }]);
});

const base = {
  name: 'Sales',
  resources: { sale: {} },
  views: { sales: { kind: 'list', from: 'sale' } },
  home: 'sales',
};

const dashboard = (figures: object) =>
  parseAppConfig(
    {
      ...base,
      views: {
        ...base.views,
        board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'custom', title: 'Summary', component: summary, figures }] },
      },
      nav: ['board', 'sales'],
    },
    'fixture',
  );

test('a dashboard section declares aggregate reads that follow the window and name only declared resources', async (t) => {
  const { schema } = await database(t, 1);
  const app = dashboard({
    open: { from: 'sale', measure: 'count', query: 'status = open', over: 'created_on' },
    total: { from: 'sale', measure: 'sum amount', by: 'status', limit: 10 },
  });
  const custom = (app.views.board as { sections: Array<{ aggregates?: object }> }).sections[0];
  assert.deepEqual(custom.aggregates, {
    open: { table: 'sale', measure: 'count', query: 'status = open', over: 'created_on' },
    total: { table: 'sale', measure: 'sum amount', by: 'status', limit: 10 },
  });
  assert.throws(() => dashboard({ x: { from: 'sale', measure: 'count', whose: 'account_id' } }), /whose/);
  assert.throws(() => dashboard({ x: { from: 'nothing', measure: 'count' } }), /nothing/);

  // The measure is judged in the grammar its number will run in, so a misspelled column is said before a reader sees it.
  const broken = resolveViews(dashboard({ n: { from: 'sale', measure: 'sum amunt', by: 'status' } }), schema).board as AppDashboardView;
  assert.match(broken.error ?? '', /figures "n".*"amunt" is not a column on sale/);
  assert.equal(
    (resolveViews(dashboard({ n: { from: 'sale', measure: 'sum amount' } }), schema).board as AppDashboardView).error,
    undefined,
  );
});

test('a custom section\'s old "totals" is refused with "figures", on a page and on a dashboard', () => {
  const old = { n: { from: 'sale', measure: 'count' } };
  assert.throws(
    () =>
      parsePagesConfig(
        { pages: [{ id: 'account', base: 'account', label: 'Account', sections: [{ kind: 'custom', component: summary, totals: old }] }] },
        'fixture',
      ),
    /has "totals", which is now "figures"/,
  );
  assert.throws(
    () =>
      parseAppConfig(
        {
          ...base,
          views: {
            ...base.views,
            board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'custom', title: 'S', component: summary, totals: old }] },
          },
          nav: ['board', 'sales'],
        },
        'fixture',
      ),
    /has "totals", which is now "figures"/,
  );
});
