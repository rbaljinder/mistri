import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPresentationColumns, parseAppConfig, resolveViews, type AppListView } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { keyedPresentation } from './support/keyedPresentation.js';

/**
 * A board's `order`: a numeric local column holding each card's place. The
 * parser takes it like `by`, the catalog judges it — a number, not the key,
 * not the lane column — and a column the resource moves only through its
 * actions is refused, since a place is the reader's to change.
 */
const board = { kind: 'board', by: 'state', lanes: ['new', 'done'], primary: 'title' } as const;
const parse = (presentation: object, resource: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Work',
      resources: { tasks: resource },
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
        { name: 'note', type: 'TEXT', nullable: true, primaryKey: false },
      ],
    },
  ],
};
const problem = (presentation: object) => (resolveViews(parse(presentation), schema).tasks as { error?: string }).error;

test('order round-trips trimmed, and is read with the card', () => {
  const view = parse({ ...board, order: ' rank ' }).views.tasks as AppListView;
  assert.deepEqual(view.presentation, { ...board, lanes: ['new', 'done'], order: 'rank' });
  assert.deepEqual(listPresentationColumns({ ...board, lanes: ['new', 'done'], order: 'rank' }), ['state', 'title', 'rank']);
  assert.equal(problem({ ...board, order: 'rank' }), undefined);
});

test('order is a local column, refused by name like by', () => {
  for (const value of [null, 4, '', ' ', 'owner.rank']) {
    assert.throws(() => parse({ ...board, order: value }), /presentation: "order" must name a local column/);
  }
  assert.throws(() => parse({ kind: 'queue', primary: 'title', order: 'rank' }), /presentation \(a queue\) has no "order"/);
});

test('the catalog judges order: readable, a number, not the key, not the lane', () => {
  assert.match(problem({ ...board, order: 'missing' })!, /Board order: "missing" must be a local readable column/);
  assert.match(problem({ ...board, order: 'note' })!, /Board order: "note" is TEXT; a card's place in its lane is a number/);
  assert.match(problem({ ...board, order: 'id' })!, /Board order must not be a primary key column/);
});

test('a column the resource moves only through its actions cannot be a place', () => {
  const resource = { access: 'write', machine: { column: 'rank', states: { '0': { on: { bump: '1' } }, '1': { final: true } } } };
  assert.throws(() => parse({ ...board, order: 'rank' }, resource), /"order" names "rank", which the machine of resources\.tasks moves/);
  assert.doesNotThrow(() =>
    parse(
      { ...board, lanes: undefined, order: 'rank' },
      { ...resource, machine: { column: 'state', states: { open: { on: { close: 'done' } }, done: { final: true } } } },
    ),
  );
});
