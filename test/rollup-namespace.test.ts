/**
 * The `rollup` namespace of `@mistriwork/mistri/app` — `rollup.count`, `sum`, `avg`, `min`, `max`, `latest` — and the
 * mean it adds: what the builders hand the parser, what the catalog serves and refuses for an `avg`, the statement it
 * compiles to, and the number a sqlite database gives back.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as dsl from '../packages/mistri/schema/app.mjs';
import { liveValues } from '../packages/mistri/src/shared/formLines.js';
import { appRollupRules, parseAppConfig, withRollups } from '../packages/mistri/src/shared/app.js';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const table = (id: string, columns: object[]) => ({ id, name: id, schema: '', isView: false, columns });
const schema = {
  label: 'Reviews',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    table('product', [key('id'), column('name', 'TEXT')]),
    table('review', [
      key('id'),
      column('product_id', 'INTEGER'),
      column('stars', 'INTEGER'),
      column('weight', 'NUMERIC'),
      column('body', 'TEXT'),
    ]),
  ],
  foreignKeys: [{ name: 'review_product', from: { table: 'review', columns: ['product_id'] }, to: { table: 'product', columns: ['id'] } }],
} as DatabaseSchema;

const app = (rollups: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Reviews',
      resources: { product: { rollups }, review: {} },
      views: { products: { kind: 'list', from: 'product' } },
      home: 'products',
      nav: ['products'],
    },
    'rollup namespace',
  );

test('the builders are one namespace, and the bare names are gone', () => {
  assert.deepEqual(Object.keys(dsl.rollup).sort(), ['avg', 'count', 'latest', 'max', 'min', 'sum']);
  assert.deepEqual(dsl.rollup.count('review', { query: 'stars > 3' }), { fn: 'count', from: 'review', query: 'stars > 3' });
  assert.deepEqual(dsl.rollup.sum('review', 'stars'), { fn: 'sum', from: 'review', column: 'stars' });
  assert.deepEqual(dsl.rollup.avg('review', 'stars', { whose: 'product_id' }), {
    fn: 'avg',
    from: 'review',
    column: 'stars',
    whose: 'product_id',
  });
  assert.deepEqual(dsl.rollup.latest('review', 'body', { sort: 'id' }), { fn: 'latest', from: 'review', column: 'body', sort: 'id' });
  for (const gone of ['count', 'sum', 'min', 'max', 'latest']) assert.equal((dsl as Record<string, unknown>)[gone], undefined, gone);
  assert.throws(() => (dsl.rollup as { stdev?: () => void }).stdev!(), TypeError);
});

test('an avg reads numbers, is a number even over whole ones, and has no second reference to cross', () => {
  const judged = appRollupRules(app({ mean: dsl.rollup.avg('review', 'stars'), heaviest: dsl.rollup.max('review', 'weight') }), schema);
  assert.deepEqual(judged.problems, []);
  assert.equal(judged.rules.get('product')!.mean.fn, 'avg');
  // A mean of whole numbers is not a whole number.
  assert.equal(judged.rules.get('product')!.mean.type, 'numeric');
  const text = appRollupRules(app({ mean: dsl.rollup.avg('review', 'body') }), schema).problems[0];
  assert.match(text, /"review.body" is TEXT; a avg reads numbers\./);
  assert.throws(() => app({ mean: dsl.rollup.avg('review', 'stars', { whose: 'a_id.product_id' }) }), /avg through two references/);
  assert.throws(() => app({ mean: (dsl.rollup.avg as (from: string) => unknown)('review') }), /needs a "column"/);
  assert.throws(
    () => app({ mean: { fn: 'median', from: 'review', column: 'stars' } }),
    /Use "count", "sum", "avg", "min", "max", "latest"/,
  );
});

test('an avg compiles to one AVG over the rows that point at the record, and is empty where there are none', () => {
  const served = withRollups(
    app({ mean: dsl.rollup.avg('review', 'stars', { query: 'stars > 1' }), weight: dsl.rollup.avg('review', 'weight') }),
    schema,
  );
  const view = withViewComputed(served, textToView(served, 'product show name, mean, weight sort id').view!);
  const { text, params } = compileView(served, view, ANSI_STYLE);
  // The query narrows the rows inside a scope the rollup reads; the mean is the statement's own, never summed over a count.
  assert.match(text, /\(SELECT AVG\("\w+"\."stars"\) FROM "_tw_scope\$1" "\w+" WHERE "\w+"\."product_id" = "product_0"\."id"\) AS "mean"/);
  assert.match(text, /\(SELECT AVG\("\w+"\."weight"\) FROM "review" "\w+" WHERE /);
  assert.doesNotMatch(text, /COALESCE\(AVG/);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE review (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES product(id), stars INTEGER, weight NUMERIC, body TEXT);
    INSERT INTO product VALUES (1, 'Kettle'), (2, 'Toaster'), (3, 'Fridge');
    INSERT INTO review VALUES (1, 1, 5, 1, 'a'), (2, 1, 4, 2, 'b'), (3, 1, 1, 3, 'c'), (4, 2, 2, NULL, 'd');`);
  const rows = db.prepare(text).all(...(params as never[])) as Array<Record<string, unknown>>;
  // Kettle: the 1-star review is out of the query, so (5 + 4) / 2; Toaster's one review is a 2; Fridge has none.
  assert.deepEqual(
    rows.map((row) => [row.name, row.mean, row.weight]),
    [
      ['Kettle', 4.5, 2],
      ['Toaster', 2, null],
      ['Fridge', null, null],
    ],
  );
  db.close();
});

test("a form's lines are averaged as the statement would: the rows that have a figure, and nothing over none", () => {
  const served = withRollups(app({ mean: dsl.rollup.avg('review', 'stars') }), schema);
  const product = served.tables.find((each) => each.id === 'product')!;
  const lines = (rows: Array<Record<string, string>>) => liveValues(served, product, ['mean'], {}, { review: rows });
  assert.deepEqual(lines([{ stars: '5' }, { stars: '4' }, { stars: '' }]), { mean: 4.5 });
  assert.deepEqual(lines([]), { mean: null });
});
