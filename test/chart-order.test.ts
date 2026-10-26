import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileBreakdown } from '../packages/engine/src/shared/breakdown.js';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import { chartPlan, parsePagesConfig, sectionConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

/**
 * A chart's categories in the order they have of their own: a date or a step runs from the first, a bar for each row
 * runs in the order the rows were made (a sprint's name, not the biggest sprint first), a vocabulary is left to the
 * client; `sort` says it outright.
 */
const col = (name: string, type = 'TEXT', extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const id: ColumnMeta = { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true };
const meta = (tableId: string, columns: ColumnMeta[]): TableMeta => ({ id: tableId, name: tableId, schema: '', isView: false, columns });
const schema: DatabaseSchema = {
  label: 'cadence',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    meta('project', [id, col('name')]),
    meta('sprint', [
      id,
      col('project_id', 'INTEGER'),
      col('name'),
      col('starts_on', 'DATE'),
      col('priority', 'INTEGER'),
      col('state', 'TEXT', { allowed: ['planned', 'active', 'done'] }),
      col('completed_points', 'INTEGER'),
    ]),
  ],
  foreignKeys: [{ name: 'sprint_project', from: { table: 'sprint', columns: ['project_id'] }, to: { table: 'project', columns: ['id'] } }],
};
const chart = (extra: Record<string, unknown>) => ({
  kind: 'chart' as const,
  from: 'sprint',
  path: 'project_id',
  by: 'name',
  fn: 'sum' as const,
  column: 'completed_points',
  shape: 'bar' as const,
  ...extra,
});
const plan = (extra: Record<string, unknown>) => {
  const page: PageDef = { id: 'p', name: 'Project', base: 'project', sections: [chart(extra)] as never };
  return { page, built: chartPlan(schema, page, page.sections[0] as never, { id: 1 }, 0) };
};

test('a bar for each row runs in the order the rows were made; a date or a step from the first; a vocabulary is the client’s', () => {
  const rows = plan({}).built.def!;
  assert.deepEqual(rows.orderBy, [{ name: 'order_1', direction: 'asc' }]);
  assert.deepEqual(rows.measures.at(-1), { fn: 'min', path: 'id', alias: 'order_1' });
  assert.deepEqual(plan({ by: 'starts_on' }).built.def!.orderBy, [{ name: 'key_1', direction: 'asc' }]);
  assert.deepEqual(plan({ by: 'priority' }).built.def!.orderBy, [{ name: 'key_1', direction: 'asc' }]);
  // A vocabulary's order is the client's (it knows the allowed values and the display rule), so the query stays by value.
  assert.deepEqual(plan({ by: 'state' }).built.def!.orderBy, [{ name: 'value', direction: 'desc' }]);
  // A line runs along its key, as it did.
  assert.deepEqual(plan({ shape: 'line', by: 'month starts_on' }).built.def!.orderBy, [{ name: 'key_1', direction: 'asc' }]);
});

test('sort says it outright: value, category, or a column of the rows', () => {
  assert.deepEqual(plan({ sort: 'value' }).built.def!.orderBy, [{ name: 'value', direction: 'desc' }]);
  assert.deepEqual(plan({ by: 'state', sort: 'category' }).built.def!.orderBy, [{ name: 'value', direction: 'desc' }]);
  assert.deepEqual(plan({ by: 'priority', sort: 'category' }).built.def!.orderBy, [{ name: 'key_1', direction: 'asc' }]);
  const column = plan({ sort: 'starts_on desc' });
  assert.deepEqual(column.built.def!.orderBy, [{ name: 'order_1', direction: 'desc' }]);
  assert.deepEqual(column.built.def!.measures.at(-1), { fn: 'max', path: 'starts_on', alias: 'order_1' });
  assert.equal(validatePage(schema, column.page).error, undefined);
  assert.match(validatePage(schema, plan({ sort: 'nope' }).page).error!, /"sort" names "nope", which is not a column on sprint/);
});

test('sort is read, spelled back, and refused where it orders nothing', () => {
  const read = (extra: Record<string, unknown>) =>
    parsePagesConfig(
      {
        pages: [
          {
            label: 'Project',
            base: 'project',
            sections: [
              { kind: 'chart', from: 'sprint', whose: 'project_id', by: 'name', shape: 'bar', measure: 'sum completed_points', ...extra },
            ],
          },
        ],
      },
      'pages',
    )[0];
  const page = read({ sort: ' starts_on  desc ' });
  assert.equal((page.sections[0] as { sort?: string }).sort, 'starts_on desc');
  assert.equal((sectionConfig(page.sections[0]) as { sort?: string }).sort, 'starts_on desc');
  assert.equal((read({ sort: 'category' }).sections[0] as { sort?: string }).sort, 'category');
  assert.throws(() => read({ shape: 'line', sort: 'value' }), /orders the categories of a bar chart or a donut/);
  assert.throws(() => read({ sort: 'starts_on, name' }), /more than one column or a path/);
  assert.throws(() => read({ sort: 'a.b' }), /more than one column or a path/);
});

test('the order is the query’s: the rows come back in creation order, and the extra column is the drawing’s to drop', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sprint (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, completed_points INTEGER)');
  // Sprint 3 delivered the most, sprint 1 the least: by value they would read 3, 2, 1.
  db.exec("INSERT INTO sprint VALUES (1,1,'S1',5),(2,1,'S2',20),(3,1,'S3',40),(4,2,'Other',99)");
  const def = plan({}).built.def!;
  const compiled = compileBreakdown(schema, def, ANSI_STYLE);
  const answer = db.prepare(compiled.text).all(...(compiled.params as never[])) as Array<Record<string, unknown>>;
  assert.deepEqual(
    answer.map((r) => r.key_1),
    ['S1', 'S2', 'S3'],
  );
});
