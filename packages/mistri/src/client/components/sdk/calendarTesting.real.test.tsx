/**
 * `calendar` from `ui/testing`, against the real `<CalendarList>` markup: a month's grid with its events on their days.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../../test/shellBridge.js';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../../engine/src/shared/schema.js';
import type { AppCalendarList } from '../../../../../engine/src/shared/listPresentations.js';
import { calendar } from './testing.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  apply: vi.fn(),
  state: { activeConnection: 'crm', connections: [{ id: 'crm', writable: true }] },
}));
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'subject', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'due_on', type: 'DATE', nullable: false, primaryKey: false },
  ],
};
vi.mock('../../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: vi.fn(),
  state: mocks.state,
  primaryKey,
  findTable: () => table,
  toast: vi.fn(),
  writeAllowed: () => true,
  refsFrom: () => [],
  columnLabel: () => null,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../appState.js', () => ({ activeApp: () => null, inAppMode: () => false }));
beforeEach(bridgeShell);
vi.mock('../../../../../kit/src/client/components/appRooms.js', () => ({ appRooms: () => [], isListRoom: () => false }));
vi.mock('../../../../../kit/src/client/requestIdentity.js', () => ({ ownedBy: () => ({}) }));
vi.mock('../../../../../kit/src/client/clauses.js', () => ({ splitQuery: (text: string) => ({ filter: text }) }));
vi.mock('../../../../../kit/src/client/components/useMediaQuery.js', () => ({
  PHONE_QUERY: '(max-width: 600px)',
  useMediaQuery: () => false,
}));
vi.mock('../../../../../kit/src/client/sessionIdentity.js', () => ({ sessionIdentity: () => ({ epoch: 1 }) }));
vi.mock('../../../../../kit/src/client/bulkActions.js', () => ({
  applyBulk: mocks.apply,
  bulkKey: (_t: TableMeta, key: Record<string, unknown>) => JSON.stringify(key),
}));
vi.mock('../../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));
const { CalendarList } = await import('../CalendarList.js');

const spec: AppCalendarList = { kind: 'calendar', date: 'due_on', primary: 'subject', lines: ['status'] };
const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const rows = [
  { id: 1, subject: 'Call Stonebridge', status: 'open', due_on: `${month}-03` },
  { id: 3, subject: 'Quarterly review', status: 'done', due_on: `${month}-18` },
];

beforeEach(() => {
  mocks.api.mockReset();
  mocks.apply.mockReset();
  mocks.apply.mockImplementation(async () => ({ outcomes: [{ kind: 'applied', message: '' }] }));
  mocks.api.mockImplementation(async () => ({ rows, columns: ['id', 'due_on', 'subject', 'status'] }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CalendarList table={table} spec={spec} entry={{ kind: 'table', table: 'task', query: '' }} interactive label="Task calendar" />
    </QueryClientProvider>,
  );
});
afterEach(cleanup);

test('calendar.event finds an event by its title and calendar.day the cell it falls on', async () => {
  await screen.findByRole('button', { name: /Call Stonebridge/ });
  expect(calendar.day(`${month}-03`)).toContainElement(calendar.event('Call Stonebridge'));
  expect(calendar.day(`${month}-18`)).toContainElement(calendar.event('Quarterly review'));
  expect(calendar.day(`${month}-18`)).not.toContainElement(calendar.event('Call Stonebridge'));
  expect(() => calendar.event('Nothing')).toThrow();
});
