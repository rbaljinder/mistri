/**
 * A shown column's second line is fetched from the table its value was read
 * from: `employee_id.name` on a timesheet fetches `employee_id.title`, never
 * the timesheet's own `title`.
 */
import { expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, references?: { table: string; column: string }) => ({
  name,
  type: 'TEXT',
  nullable: true,
  primaryKey: name === 'id',
  ...(references ? { references } : {}),
});
const employee: TableMeta = {
  id: 'employee',
  name: 'employee',
  schema: '',
  isView: false,
  columns: [col('id'), col('name'), col('title')],
};
const timesheet: TableMeta = {
  id: 'timesheet',
  name: 'timesheet',
  schema: '',
  isView: false,
  columns: [col('id'), col('title'), col('employee_id', { table: 'employee', column: 'id' })],
};
vi.mock('../../../../kit/src/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../kit/src/client/core.js')>()),
  state: {
    schema: {
      tables: [employee, timesheet],
      foreignKeys: [
        { name: 'timesheet_employee', from: { table: 'timesheet', columns: ['employee_id'] }, to: { table: 'employee', columns: ['id'] } },
      ],
    },
  },
}));
vi.mock('../appState.js', () => ({
  activeApp: () => ({
    resources: {
      employee: { display: { name: { subtitle: 'title' } } },
      timesheet: {},
    },
  }),
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);

const { subtitleColumns, appListQuery } = await import('../../../../kit/src/client/components/appListModel.js');

test('a name read through a reference fetches its second line through the same reference', () => {
  expect(subtitleColumns('timesheet', ['employee_id.name', 'title'])).toEqual(['employee_id.title']);
  expect(subtitleColumns('employee', ['name'])).toEqual(['title']);
  // A path the schema cannot follow asks for nothing.
  expect(subtitleColumns('timesheet', ['manager_id.name'])).toEqual([]);
});

test("a card's title, figure and properties and a board card's title read their second line with the row; a badge does not", () => {
  type Spec = Parameters<typeof appListQuery>[0];
  const shown = (presentation: Record<string, unknown>) =>
    appListQuery({ table: 'employee', presentation } as unknown as Spec)
      .match(/show (.*?)(?: limit|$)/)?.[1]
      .split(', ') ?? [];
  expect(shown({ kind: 'cards', primary: 'name' })).toContain('title');
  expect(shown({ kind: 'cards', primary: 'id', value: 'name' })).toContain('title');
  expect(shown({ kind: 'cards', primary: 'id', lines: ['name'] })).toContain('title');
  expect(shown({ kind: 'board', by: 'id', primary: 'name' })).toContain('title');
  expect(shown({ kind: 'cards', primary: 'id', badge: 'name' })).not.toContain('title');
});
