import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, resolveViews, type AppListView } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/**
 * A list view's `editable`: cells edited in place and a selection's "Set
 * field…". The parser refuses what the definition alone says can never be
 * offered — a presentation, a resource no reader may write, a column the
 * view does not show, one the resource's transitions give to its actions, a
 * file's own columns — and the catalog refuses a column that is not the
 * table's, the key, and a document or bytes. Each refusal names the fix.
 */
const parse = (
  view: Record<string, unknown>,
  resource: Record<string, unknown> = { access: 'write' },
  others: Record<string, unknown> = {},
) =>
  parseAppConfig(
    {
      name: 'Work',
      resources: { tasks: resource, ...others },
      views: { tasks: { kind: 'list', from: 'tasks', ...view } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'editable fixture',
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
        { name: 'meta', type: 'JSON', nullable: true, primaryKey: false },
        { name: 'data', type: 'BLOB', nullable: true, primaryKey: false },
      ],
    },
  ],
};
const problem = (view: Record<string, unknown>) => (resolveViews(parse(view), schema).tasks as { error?: string }).error;

test('editable round-trips as true or the columns named, trimmed', () => {
  assert.equal((parse({ editable: true }).views.tasks as AppListView).editable, true);
  assert.deepEqual((parse({ show: ['title', 'state'], editable: [' title ', 'state'] }).views.tasks as AppListView).editable, [
    'title',
    'state',
  ]);
  assert.equal((parse({ editable: false }).views.tasks as AppListView).editable, undefined);
  assert.equal(problem({ show: ['title', 'state'], editable: ['title', 'state'] }), undefined);
});

test('a shape that is not true or a list of columns is refused', () => {
  for (const value of ['yes', 1, [], [''], ['a.b'], [3]]) {
    assert.throws(() => parse({ editable: value }), /"editable" must be true \(every shown column the reader may write\) or a list/);
  }
  assert.throws(() => parse({ editable: ['title', 'title'] }), /"editable" that names one column twice/);
});

test('a grid only: a presentation, the split included, is refused', () => {
  assert.throws(
    () => parse({ editable: true, presentation: { kind: 'cards', primary: 'title' } }),
    /"editable" and a cards presentation; cells are edited in place on a grid/,
  );
  assert.throws(() => parse({ editable: true, split: {} }), /a split edits its record in the detail pane/);
});

test('a resource no reader may write offers no editable cells', () => {
  assert.throws(() => parse({ editable: true }, {}), /resources\.tasks is not access 'write'/);
});

test('a named column the view does not show is refused with the fix', () => {
  assert.throws(
    () => parse({ show: ['title'], editable: ['state'] }),
    /"editable" names "state", which the view does not show\. Add it to "show"/,
  );
  // A reference shown by its record's name is the reference, edited with a picker.
  assert.doesNotThrow(() => parse({ show: ['title', 'state.label'], editable: ['state'] }));
});

test('a column moved only through actions is never edited in place', () => {
  const resource = { access: 'write', machine: { column: 'state', states: { '0': { on: { close: 'done' } }, done: { final: true } } } };
  assert.throws(() => parse({ editable: ['state'] }, resource), /"editable" names "state", which the machine of resources\.tasks moves/);
  assert.doesNotThrow(() => parse({ editable: ['title'] }, resource));
});

test("a file's own columns change by uploading, not in a cell", () => {
  const resource = { access: 'write', file: { content: 'data', name: 'title' } };
  assert.throws(() => parse({ editable: ['title'] }, resource), /"editable" names "title", which holds resources\.tasks's file/);
});

test('the catalog refuses the key, a document, bytes and a column the table lacks', () => {
  assert.match(problem({ editable: ['missing'] })!, /editable: "missing" is not a column of "tasks"/);
  assert.match(problem({ editable: ['id'] })!, /editable names "id", the primary key/);
  assert.match(problem({ editable: ['meta'] })!, /editable names "meta", a JSON column, which has no editor in a cell/);
  assert.match(problem({ editable: ['data'] })!, /editable names "data", a BLOB column/);
});
