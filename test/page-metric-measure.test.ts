/**
 * A page's `total()` narrowed by a query, and one two references out, read
 * against a real database: the figure is the sum of exactly the rows the list
 * beside it shows. Both used to plan, pass `mistri check`, and then refuse at
 * runtime ("A 'sum' cannot be narrowed by a filter").
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { listView, metricView, type PageDef } from '../packages/engine/src/shared/page.js';

test('a narrowed or distant sum on a page is the sum of the rows its list reads', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-page-measure-'));
  const file = join(dir, 'payroll.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE department (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE employee (id INTEGER PRIMARY KEY, department_id INTEGER REFERENCES department(id), status TEXT, salary INTEGER);
    CREATE TABLE timesheet (id INTEGER PRIMARY KEY, employee_id INTEGER REFERENCES employee(id), hours INTEGER);
    INSERT INTO department VALUES (1, 'Kitchen'), (2, 'Front');
    INSERT INTO employee VALUES (1, 1, 'active', 50000), (2, 1, 'inactive', 70000), (3, 1, 'active', 20000), (4, 2, 'active', 99000);
    INSERT INTO timesheet VALUES (1, 1, 40), (2, 1, 38), (3, 3, 12), (4, 4, 40);
  `);
  db.close();
  const adapter = new SqliteAdapter(file, 'payroll');
  t.after(async () => {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const schema = await adapter.introspect();
  const page: PageDef = {
    id: 'department',
    name: 'Department',
    base: 'department',
    sections: [
      { kind: 'metric', fn: 'sum', from: 'employee', path: 'department_id', column: 'salary', filter: 'status = active' },
      { kind: 'list', from: 'employee', path: 'department_id', filter: 'status = active', columns: ['id', 'salary'] },
      { kind: 'metric', fn: 'sum', from: 'timesheet', path: 'employee_id.department_id', column: 'hours' },
      { kind: 'metric', fn: 'avg', from: 'employee', path: 'department_id', column: 'salary', filter: 'status = active' },
    ],
  };
  const measure = async (index: number) => {
    const built = metricView(schema, page, page.sections[index] as never, { id: 1 }, index);
    assert.equal(built.error, undefined);
    const { rows } = await adapter.runBreakdown(built.breakdown!);
    return Number(rows[0].value);
  };
  assert.equal(await measure(0), 70_000);
  const listed = await adapter.runView(listView(schema, page, page.sections[1] as never, { id: 1 }, 1).view!);
  assert.equal(
    listed.rows.reduce((sum, row) => sum + Number(row.salary), 0),
    70_000,
  );
  assert.equal(await measure(2), 90);
  assert.equal(await measure(3), 35_000);
});
