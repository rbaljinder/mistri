/**
 * The selection the queue and the grid share, driven without either: the
 * bar that appears only once something is chosen, the cap past which a
 * selection is a filter, a record that leaves the list leaving the
 * selection (and not coming back with it), the verbs stood down while a run
 * is going, the report that takes the focus and Dismiss that clears it, and
 * which actions are offered at all. The queue's own suite covers the writes,
 * `when`, confirmation and commands through a real list.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../../../mistri/src/shared/app.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  allowed: true,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false } as Record<string, unknown>,
  state: { activeConnection: 'desk', connections: [{ id: 'desk', writable: true }] },
}));
const table: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'locked', type: 'TEXT', nullable: true, primaryKey: false, writable: false },
  ],
};
vi.mock('../core.js', () => ({
  api: mocks.api,
  state: mocks.state,
  writeAllowed: () => mocks.allowed,
  findTable: () => table,
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  quote: (v: unknown) => String(v),
}));
vi.mock('../sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: mocks.refresh }));
vi.mock('../../../../mistri/src/client/commandAvailability.js', () => ({
  useCommandAvailability: (checks: unknown[]) => checks.map(() => true),
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => ({ grantedCommands: [] }) }));

const { useBulkSelection, offeredBulk } = await import('./useBulkSelection.js');
const { updateAttempts } = await import('../updateAttempts.js');
const { BULK_LIMIT } = await import('../bulkActions.js');

const close: AppAction = { id: 'close', label: 'Close', set: { status: 'closed' }, bulk: true };
const record = (id: number) => ({ id: `[["id","${id}"]]`, key: { id }, label: `Ticket ${id}`, row: { id, status: 'open' } });
type Picked = ReturnType<typeof record>;

/** The hook in a host of its own: its bar, and buttons standing in for a list's picks. */
function Host({ keyed, actions }: { keyed: Picked[]; actions: AppAction[] }) {
  const bulk = useBulkSelection({ table, keyed, actions });
  return (
    <>
      <output data-testid="selection">{bulk.selection.join('|')}</output>
      <output data-testid="offered">{String(bulk.offered)}</output>
      <button type="button" onClick={() => bulk.change(keyed.map((r) => r.id))}>
        pick all
      </button>
      <button type="button" onClick={() => bulk.change(keyed.slice(0, 2).map((r) => r.id))}>
        pick two
      </button>
      {bulk.bar}
      {bulk.dialogs}
    </>
  );
}
function draw(keyed: Picked[], actions: AppAction[] = [close]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (list: Picked[]) => (
    <QueryClientProvider client={client}>
      <Host keyed={list} actions={actions} />
    </QueryClientProvider>
  );
  const view = render(tree(keyed));
  return { redraw: (list: Picked[]) => view.rerender(tree(list)) };
}
const selection = () => screen.getByTestId('selection').textContent;
const toolbar = () => screen.queryByRole('toolbar', { name: 'Selected records' });

beforeEach(bridgeShell);

beforeEach(() => {
  mocks.api.mockReset();
  mocks.refresh.mockReset();
  mocks.allowed = true;
  mocks.state.activeConnection = 'desk';
  mocks.state.connections[0].writable = true;
  updateAttempts.reset();
});
afterEach(cleanup);

test('the bar appears only once something is chosen, and Clear selection takes it away', async () => {
  draw([1, 2, 3].map(record));
  expect(toolbar()).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'pick two' }));
  expect(toolbar()).toHaveTextContent('2 selected');
  await userEvent.click(within(toolbar()!).getByRole('button', { name: 'Clear selection' }));
  expect(selection()).toBe('');
  expect(toolbar()).toBeNull();
});

test('a selection past the limit is capped, and says so', async () => {
  draw(Array.from({ length: BULK_LIMIT + 5 }, (_, i) => record(i + 1)));
  await userEvent.click(screen.getByRole('button', { name: 'pick all' }));
  expect(selection()!.split('|')).toHaveLength(BULK_LIMIT);
  expect(screen.getByText(new RegExp(`limited to ${BULK_LIMIT}`))).toHaveAttribute('role', 'status');
  await userEvent.click(screen.getByRole('button', { name: 'pick two' }));
  expect(screen.queryByText(new RegExp(`limited to ${BULK_LIMIT}`))).toBeNull();
});

test('a record that leaves the list leaves the selection, and is not re-selected when it returns', async () => {
  const { redraw } = draw([1, 2, 3].map(record));
  await userEvent.click(screen.getByRole('button', { name: 'pick two' }));
  expect(selection()).toBe(`${record(1).id}|${record(2).id}`);
  redraw([2, 3].map(record));
  await waitFor(() => expect(selection()).toBe(record(2).id));
  redraw([1, 2, 3].map(record));
  expect(selection()).toBe(record(2).id);
});

test('while a run is going its verbs stand down; the report takes the focus and Dismiss clears it', async () => {
  let release!: () => void;
  mocks.api.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ affected: 1, applied: { status: 'closed' } });
      }),
  );
  draw([1, 2].map(record));
  await userEvent.click(screen.getByRole('button', { name: 'pick two' }));
  await userEvent.click(within(toolbar()!).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(toolbar()).toHaveAttribute('aria-busy', 'true'));
  expect(within(toolbar()!).getByRole('button', { name: 'Close' })).toBeDisabled();
  expect(within(toolbar()!).getByRole('button', { name: 'Clear selection' })).toBeDisabled();
  await act(async () => {
    release();
  });
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
  expect(mocks.api).toHaveBeenCalledWith('/api/update', expect.objectContaining({ expected: { status: 'open' } }));
  await act(async () => {
    release();
  });
  const report = await screen.findByText('Close: 2 applied.');
  await waitFor(() => expect(report.parentElement).toHaveFocus());
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Close: 2 applied.')).toBeNull();
  expect(selection()).toBe('');
});

test('only bulk updates over writable, non-key columns are offered, and only where the connection writes', () => {
  const offered = (actions: AppAction[], interactive = true) =>
    offeredBulk(table, actions, interactive, mocks.identity as never, 'desk').bulk.map((a) => a.label);
  const single: AppAction = { id: 'closeOne', label: 'Close one', set: { status: 'closed' } };
  const onKey: AppAction = { id: 'renumber', label: 'Renumber', set: { id: 9 }, bulk: true };
  const onLocked: AppAction = { id: 'lock', label: 'Lock', set: { locked: 'yes' }, bulk: true };
  expect(offered([close, single, onKey, onLocked])).toEqual(['Close']);
  expect(offered([close], false)).toEqual([]);
  mocks.allowed = false;
  expect(offered([close])).toEqual([]);
  mocks.allowed = true;
  mocks.state.connections[0].writable = false;
  expect(offered([close])).toEqual([]);
  mocks.state.connections[0].writable = true;
  expect(offeredBulk({ ...table, isView: true }, [close], true, mocks.identity as never, 'desk').bulk).toEqual([]);
});

test('a list with nothing to offer says so, and draws no bar whatever is picked', async () => {
  draw([1, 2].map(record), [{ id: 'closeOne', label: 'Close one', set: { status: 'closed' } }]);
  expect(screen.getByTestId('offered')).toHaveTextContent('false');
  await userEvent.click(screen.getByRole('button', { name: 'pick two' }));
  expect(toolbar()).toBeNull();
});
