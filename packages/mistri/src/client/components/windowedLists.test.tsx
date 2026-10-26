/**
 * Cards, a queue and a checklist on a long page: past a hundred rows
 * only the rows around the viewport are drawn, between two spacers, while
 * the page they were handed — and so a queue's selection — stays whole. At
 * or under it every row is drawn, exactly as before (useRowWindow.ts).
 */
import { afterEach, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../shared/app.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  identity: { epoch: 1 },
  state: { activeConnection: 'desk', connections: [{ id: 'desk', writable: true }], schema: { foreignKeys: [] as unknown[] } },
}));
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'done', type: 'BOOLEAN', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', async () => ({
  primaryKey: (await import('../../../../engine/src/shared/schema.js')).primaryKey,
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  toast: vi.fn(),
  columnDisplay: () => null,
  columnLabel: () => null,
  findTable: () => table,
  refsFrom: () => [],
  writeAllowed: () => true,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
  quote: (value: string) => value,
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: () => ({ top: 0, bottom: 40, left: 0, right: 400, width: 400, height: 40 }),
}));
vi.mock('../../../../kit/src/client/requestIdentity.js', () => ({
  ownedBy: (connection: string | null) => (connection ? { connection } : {}),
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: vi.fn() }));
vi.mock('../commandAvailability.js', () => ({ useCommandAvailability: (checks: unknown[]) => checks.map(() => true) }));
vi.mock('../appState.js', () => ({ activeApp: () => ({ grantedCommands: [] }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));
const { CardsList } = await import('../../../../kit/src/client/components/CardsList.js');
const { QueueList } = await import('./QueueList.js');
const { Checklist } = await import('./Checklist.js');
const { WINDOW_THRESHOLD } = await import('../../../../kit/src/client/components/useRowWindow.js');
const { BULK_LIMIT } = await import('../../../../kit/src/client/bulkActions.js');

const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Task ${i + 1}`, done: false, status: 'open' }));
const draw = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
afterEach(cleanup);

test('every page size up to a hundred draws whole; the largest (250) is windowed', () => {
  expect(WINDOW_THRESHOLD).toBe(100);
});

test('cards: a thousand-card page draws a bounded window between spacers; a page at the threshold draws every card', () => {
  const spec = { kind: 'cards' as const, primary: 'name' };
  draw(<CardsList table={table} rows={page(1000)} spec={spec} />);
  const drawn = document.querySelectorAll('.cards-item').length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(100);
  expect(document.querySelector('.cards-spacer')).not.toBeNull();
  cleanup();
  draw(<CardsList table={table} rows={page(WINDOW_THRESHOLD)} spec={spec} />);
  expect(document.querySelectorAll('.cards-item')).toHaveLength(WINDOW_THRESHOLD);
  expect(document.querySelector('.cards-spacer')).toBeNull();
});

test('checklist: a thousand rows draw a bounded window; a short page draws them all', () => {
  const spec = { kind: 'checklist' as const, primary: 'name', checked: 'done' };
  draw(<Checklist table={table} rows={page(1000)} spec={spec} />);
  const drawn = document.querySelectorAll('.checklist-row').length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(100);
  expect(screen.getByRole('checkbox', { name: 'Complete Task 1' })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Complete Task 1000' })).toBeNull();
  cleanup();
  draw(<Checklist table={table} rows={page(12)} spec={spec} />);
  expect(document.querySelectorAll('.checklist-row')).toHaveLength(12);
  expect(document.querySelector('.checklist-spacer')).toBeNull();
});

test('a plain queue windows its rows too', () => {
  draw(<QueueList table={table} rows={page(1000)} spec={{ kind: 'queue', primary: 'name' }} interactive={false} recordNavigation />);
  const drawn = document.querySelectorAll('.queue-list > .queue-row').length;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(100);
  expect(document.querySelector('.queue-spacer')).not.toBeNull();
});

test('a selecting queue draws a window, and select-all still reads the whole page, not the drawn rows', () => {
  const close: AppAction = { id: 'close', label: 'Close', set: { status: 'closed' }, bulk: true };
  draw(<QueueList table={table} rows={page(1000)} spec={{ kind: 'queue', primary: 'name' }} actions={[close]} />);
  const rows = screen.getAllByRole('row');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(100);
  // Each drawn row still says where it stands in the whole page.
  expect(rows[0]).toHaveAttribute('aria-rowindex', '1');
  expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '1000');
  // One tab stop, on a drawn row.
  expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
  fireEvent.keyDown(rows[0], { key: 'a', ctrlKey: true });
  // The bulk cap is the selection's own rule, unchanged: past it, the cap and its note.
  expect(screen.getByText(`${Math.min(1000, BULK_LIMIT)} selected`)).toBeInTheDocument();
});
