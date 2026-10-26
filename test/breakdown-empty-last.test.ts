import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileBreakdown, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/**
 * `emptyLast`: the group of rows with no value (a null key) comes after every other, whatever the rest of the
 * order says — here a sprint's issues, with the unplanned ones in the group of no sprint.
 */
const col = (name: string, type: string, pk = false) => ({ name, type, primaryKey: pk, nullable: !pk });
const schema = {
  dialect: 'sqlite',
  tables: [
    { id: 'sprint', name: 'sprint', schema: '', isView: false, columns: [col('id', 'INTEGER', true), col('name', 'TEXT')] },
    { id: 'issue', name: 'issue', schema: '', isView: false, columns: [col('id', 'INTEGER', true), col('sprint_id', 'INTEGER')] },
  ],
  foreignKeys: [{ name: 'issue_sprint', from: { table: 'issue', columns: ['sprint_id'] }, to: { table: 'sprint', columns: ['id'] } }],
} as unknown as DatabaseSchema;

test('the empty group is last under a count sort, either way round', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE issue (id INTEGER PRIMARY KEY, sprint_id INTEGER)');
  // Five issues with no sprint (the biggest group), two in sprint 1, one in sprint 2.
  db.exec('INSERT INTO issue VALUES (1,NULL),(2,NULL),(3,NULL),(4,NULL),(5,NULL),(6,1),(7,1),(8,2)');
  const keys = (direction: 'asc' | 'desc') => {
    const def: BreakdownDef = {
      base: 'issue',
      by: [{ path: 'sprint_id' }],
      measures: [{ fn: 'count', alias: 'group_rows' }],
      orderBy: [
        { name: 'sprint_id', direction: 'asc', emptyLast: true },
        { name: 'group_rows', direction },
      ],
    };
    const compiled = compileBreakdown(schema, def, ANSI_STYLE);
    return (db.prepare(compiled.text).all(...(compiled.params as never[])) as Array<{ sprint_id: number | null }>).map((r) => r.sprint_id);
  };
  assert.deepEqual(keys('desc'), [1, 2, null]);
  assert.deepEqual(keys('asc'), [2, 1, null]);
});
