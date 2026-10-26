import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPresentationColumns, parseAppConfig, resolveViews, type AppListView } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { keyedPresentation } from './support/keyedPresentation.js';

/**
 * A board's rows and limits. `swimlanes` is another local column, whose
 * values are rows across the lanes; `limits` is a lane's work-in-progress
 * number, keyed by lane value. The parser takes the spelling — a column of
 * its own, whole numbers for lanes the board has — and the catalog judges
 * the columns. A board by a reference keeps the referenced keys as lanes.
 */
const board = { kind: 'board', by: 'state', lanes: ['new', 'done'], primary: 'title' } as const;
const parse = (presentation: object) =>
  parseAppConfig(
    {
      name: 'Work',
      resources: { tasks: {} },
      views: { tasks: keyedPresentation({ kind: 'list', from: 'tasks', presentation }) },
      home: 'tasks',
      nav: ['tasks'],
    },
    'board fixture',
  );
const schema: DatabaseSchema = {
  label: 'Work',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'tasks',
      name: 'tasks',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'state', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['new', 'done'] },
        { name: 'rank', type: 'REAL', nullable: true, primaryKey: false },
        { name: 'priority', type: 'TEXT', nullable: true, primaryKey: false, allowed: ['high', 'low'] },
        { name: 'sprint_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'sprints', column: 'id' } },
      ],
    },
  ],
};
const problem = (presentation: object) => (resolveViews(parse(presentation), schema).tasks as { error?: string }).error;

test('swimlanes and limits round-trip trimmed, and the row column is read with the card', () => {
  const view = parse({ ...board, swimlanes: ' priority ', limits: { new: 3, ' done ': 5 } }).views.tasks as AppListView;
  assert.deepEqual(view.presentation, { ...board, lanes: ['new', 'done'], swimlanes: 'priority', limits: { new: 3, done: 5 } });
  assert.deepEqual(listPresentationColumns({ ...board, lanes: ['new', 'done'], order: 'rank', swimlanes: 'priority' }), [
    'state',
    'title',
    'rank',
    'priority',
  ]);
  assert.equal(problem({ ...board, swimlanes: 'priority', limits: { new: 3 } }), undefined);
});

test('swimlanes is a local column of its own: not the lane, not the place', () => {
  for (const value of [null, 4, '', ' ', 'owner.name']) {
    assert.throws(() => parse({ ...board, swimlanes: value }), /presentation: "swimlanes" must name a local column/);
  }
  assert.throws(() => parse({ ...board, swimlanes: 'state' }), /"swimlanes" names "state", which is already the board's "by"/);
  assert.throws(
    () => parse({ ...board, order: 'rank', swimlanes: 'rank' }),
    /"swimlanes" names "rank", which is already the board's "order"/,
  );
  assert.throws(() => parse({ kind: 'queue', primary: 'title', swimlanes: 'priority' }), /presentation \(a queue\) has no "swimlanes"/);
});

test('limits are whole numbers from 1 to 999, for lanes the board has', () => {
  for (const value of [[], {}, 3, 'in_progress']) {
    assert.throws(() => parse({ ...board, limits: value }), /"limits" must be an object of lane values to whole numbers/);
  }
  for (const n of [0, 1.5, 1000, '3', null]) {
    assert.throws(() => parse({ ...board, limits: { new: n } }), /"limits\.new" must be a whole number from 1 to 999/);
  }
  assert.throws(() => parse({ ...board, limits: { gone: 2 } }), /"limits" names "gone", which is not one of its "lanes" \(new, done\)/);
  assert.throws(() => parse({ kind: 'queue', primary: 'title', limits: { new: 1 } }), /presentation \(a queue\) has no "limits"/);
});

test("the catalog judges the row column and, without authored lanes, the limits' lanes", () => {
  assert.match(problem({ ...board, swimlanes: 'missing' })!, /Board swimlanes: "missing" must be a local readable column/);
  assert.match(problem({ ...board, swimlanes: 'id' })!, /Board swimlanes must not be a primary key column/);
  assert.match(
    problem({ kind: 'board', by: 'state', primary: 'title', limits: { gone: 2 } })!,
    /Board limits "gone" are not in the declared vocabulary of "state"/,
  );
  // A board by a reference: its lanes are the referenced keys, which no vocabulary lists.
  assert.equal(
    problem({ kind: 'board', by: 'sprint_id', primary: 'title', order: 'rank', swimlanes: 'priority', limits: { 1: 4 } }),
    undefined,
  );
});

test('a sum is a local numeric column other than the lane; folded lanes are lanes the board has', () => {
  const view = parse({ ...board, sum: ' rank ', folded: [' done ', 'done'] }).views.tasks as AppListView;
  assert.deepEqual(view.presentation, { ...board, lanes: ['new', 'done'], sum: 'rank', folded: ['done'] });
  assert.equal(problem({ ...board, sum: 'rank', folded: ['done'] }), undefined);
  assert.throws(() => parse({ ...board, sum: 'owner.name' }), /presentation: "sum" must name a local column/);
  assert.throws(() => parse({ ...board, sum: 'state' }), /"sum" names "state", the board's "by"/);
  for (const value of [[], 'done', [''], [3]]) {
    assert.throws(() => parse({ ...board, folded: value }), /"folded" must be one to eight lane values/);
  }
  assert.throws(() => parse({ ...board, folded: ['gone'] }), /"folded" names "gone", which is not one of its "lanes" \(new, done\)/);
  assert.match(problem({ ...board, sum: 'title' })!, /Board sum: "title" is TEXT; a lane's sum adds numbers/);
  assert.match(
    problem({ kind: 'board', by: 'state', primary: 'title', folded: ['gone'] })!,
    /Board folded "gone" are not in the declared vocabulary of "state"/,
  );
});

test("a board's line may be a rollup or a computed number of the row, as a queue's may", async () => {
  const { withRollups } = await import('../packages/mistri/src/shared/appRollups.js');
  const app = parseAppConfig(
    {
      name: 'Work',
      resources: {
        tasks: {
          rollups: { open_subs: { fn: 'count', from: 'subs', query: 'done = 0' } },
          computed: { doubled: { type: 'number', value: 'rank * 2' } },
        },
        subs: {},
      },
      views: { tasks: keyedPresentation({ kind: 'list', from: 'tasks', presentation: { ...board, lines: ['open_subs'] } }) },
      home: 'tasks',
      nav: ['tasks'],
    },
    'board rollup fixture',
  );
  const subs = {
    id: 'subs',
    name: 'subs',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'task_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'tasks', column: 'id' } },
      { name: 'done', type: 'INTEGER', nullable: true, primaryKey: false },
    ],
  };
  const catalog = {
    ...schema,
    tables: [...schema.tables, subs],
    foreignKeys: [{ from: { table: 'subs', columns: ['task_id'] }, to: { table: 'tasks', columns: ['id'] } }],
  } as DatabaseSchema;
  const served = withRollups(app, catalog);
  assert.equal((resolveViews(app, served).tasks as { error?: string }).error, undefined);
  const computed = { ...app, views: { tasks: { ...app.views.tasks, presentation: { ...board, lines: ['doubled'] } } } } as typeof app;
  assert.equal((resolveViews(computed, served).tasks as { error?: string }).error, undefined);
  // Its own column still: a name that is neither is refused as before.
  assert.match(problem({ ...board, lines: ['open_subs'] })!, /Board lines\[0\]: "open_subs" must be a local readable column/);
});
