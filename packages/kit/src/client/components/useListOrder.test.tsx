/**
 * A list kept in hand order (useListOrder.tsx), in every presentation that
 * can keep one: the three ways a row is put in place — Alt and an arrow, the
 * grip's menu, a drag — each the board's move (one row, halfway between its
 * new neighbors), and none offered while the rows are read another way or to
 * a reader who may not write the column.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { primaryKey, type ColumnMeta, type TableMeta } from '../../../../engine/src/shared/schema.js';
import { dragOnto, pressToDrag } from './dragTesting.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  refresh: vi.fn(),
  open: vi.fn(),
  allowed: true,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false },
  state: { activeConnection: 'tick', connections: [{ id: 'tick', writable: true }] },
}));
const position: ColumnMeta = { name: 'position', type: 'REAL', nullable: true, primaryKey: false };
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'completed', type: 'BOOLEAN', nullable: false, primaryKey: false },
    { ...position },
  ],
};
vi.mock('../core.js', () => ({
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  toast: mocks.toast,
  columnDisplay: () => null,
  writeAllowed: () => mocks.allowed,
  findTable: () => table,
  primaryKey,
  columnLabel: () => null,
  quote: (value: unknown) => String(value),
  // The grip's menu is placed on the zoom-aware ruler.
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  captureTenantLease: () => undefined,
  subscribeTenantLease: () => () => {},
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: mocks.refresh }));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => ({ grantedCommands: [] }) }));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span>{String(value)}</span> }));
const { Checklist } = await import('../../../../mistri/src/client/components/Checklist.js');
const { QueueList } = await import('../../../../mistri/src/client/components/QueueList.js');
const { CardsList } = await import('./CardsList.js');
const { GridOrder } = await import('./useListOrder.js');
const { RowHosts, rowKeyString, useRowHostScope } = await import('./RowHost.js');
const { updateAttempts } = await import('../updateAttempts.js');

const rows = [
  { id: 1, name: 'First', completed: false, position: 1024 },
  { id: 2, name: 'Second', completed: false, position: 2048 },
  { id: 3, name: 'Third', completed: false, position: 3072 },
];
const tight = rows.map((row, i) => ({ ...row, position: i + 1 }));
const live = { column: 'position', active: true, partial: false };
const checklist = { kind: 'checklist' as const, primary: 'name', checked: 'completed' };

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { ...render(<QueryClientProvider client={client}>{node}</QueryClientProvider>), invalidate };
}
const draw = (order = live, data = rows) => wrap(<Checklist table={table} rows={data} spec={checklist} order={order} />);
const updates = () =>
  mocks.api.mock.calls.filter(([path]) => path === '/api/update').map(([, body]) => [body.key.id, body.values.position]);
const button = (name: string) => screen.getByRole('button', { name });
const alt = (key: 'ArrowUp' | 'ArrowDown') => userEvent.keyboard(`{Alt>}{${key}}{/Alt}`);

beforeEach(bridgeShell);

beforeEach(() => {
  mocks.api.mockReset();
  mocks.toast.mockReset();
  mocks.refresh.mockReset();
  mocks.allowed = true;
  mocks.api.mockImplementation(async (_path: string, body: { values?: unknown }) => ({ affected: 1, applied: body.values }));
  mocks.state.connections[0].writable = true;
  table.columns[3] = { ...position };
  updateAttempts.reset();
});
afterEach(cleanup);

test('Alt+↓ on a focused row puts it after the next, halfway between its new neighbors, says so and keeps the focus', async () => {
  const { invalidate } = draw();
  expect(button('First')).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
  button('First').focus();
  await alt('ArrowDown');
  await waitFor(() => expect(updates()).toEqual([[1, 2560]]));
  expect(mocks.api).toHaveBeenCalledWith('/api/update', expect.objectContaining({ expected: { position: 1024 } }));
  await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Moved “First” to place 2 of 3'));
  expect(mocks.refresh).toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['run', 'tick'] });
  expect(button('First')).toHaveFocus();
  // A bare arrow is not a move.
  await userEvent.keyboard('{ArrowDown}');
  expect(updates()).toHaveLength(1);
});

test('the grip names each place the row can take; one taken from it writes the one row', async () => {
  draw();
  await userEvent.click(button('Reorder Third'));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Move up', 'Move to top']);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move to top' }));
  await waitFor(() => expect(updates()).toEqual([[3, 0]]));
});

/* happy-dom lays nothing out: each row is given a height, the size of the gap a lifted one opens. */
const tall = (height: number) => {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });
  return () =>
    own
      ? Object.defineProperty(HTMLElement.prototype, 'offsetHeight', own)
      : delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
};

test('a row dragged over another opens a gap there; Escape puts it back, and a drop takes the place', async () => {
  const untall = tall(40);
  draw();
  const item = (name: string) => button(name).closest('li')!;
  expect(item('Third')).toHaveAttribute('data-draggable', 'true');
  const drag = pressToDrag(button('Third'));
  drag.over(item('First'));
  // The rows from the landing place to the lifted one's slide down by its height; no rule is drawn.
  expect(item('First').style.translate).toBe('0 40px');
  expect(item('Second').style.translate).toBe('0 40px');
  expect(item('First')).not.toHaveAttribute('data-drop');
  expect(item('Third')).toHaveAttribute('data-lifted');
  drag.cancel();
  expect(item('First').style.translate).toBe('');
  expect(item('Third')).not.toHaveAttribute('data-lifted');
  untall();
  // Let go where it already stands: nothing to write.
  dragOnto(button('Second'), item('Second'));
  expect(updates()).toEqual([]);
  dragOnto(button('Third'), item('Second'));
  await waitFor(() => expect(updates()).toEqual([[3, 1536]]));
  expect(item('Second').style.translate).toBe('');
});

test('with no whole number left between two neighbors the rows are numbered again, 1,024 apart, one update each', async () => {
  table.columns[3] = { ...position, type: 'INTEGER' };
  draw(live, tight);
  button('Third').focus();
  await alt('ArrowUp');
  await waitFor(() =>
    expect(updates()).toEqual([
      [1, 1024],
      [3, 2048],
      [2, 3072],
    ]),
  );
});

test('on a page of a longer list a row is never renumbered with the pages it cannot see', async () => {
  table.columns[3] = { ...position, type: 'INTEGER' };
  draw({ ...live, partial: true }, tight);
  button('Third').focus();
  await alt('ArrowUp');
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/^There is no room left between those two on this page/), 'error'),
  );
  expect(updates()).toEqual([]);
});

test('the first write that does not apply stops the rest, and its refusal is said', async () => {
  table.columns[3] = { ...position, type: 'INTEGER' };
  let calls = 0;
  mocks.api.mockImplementation(async (path: string, body: { values?: unknown }) => {
    if (path === '/api/update' && ++calls === 2) throw Object.assign(new Error('Locked'), { status: 409 });
    return { affected: 1, applied: body.values };
  });
  draw(live, tight);
  button('Third').focus();
  await alt('ArrowUp');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Locked', 'error'));
  expect(updates()).toEqual([
    [1, 1024],
    [3, 2048],
  ]);
});

test.each(['sorted another way', 'grant', 'connection', 'field', 'actions'])('%s: no grip, no drag and no Alt+↑/↓', async (kind) => {
  if (kind === 'grant') mocks.allowed = false;
  if (kind === 'connection') mocks.state.connections[0].writable = false;
  if (kind === 'field') table.columns[3] = { ...position, writable: false };
  if (kind === 'actions') table.columns[3] = { ...position, changesBy: 'actions' };
  draw(kind === 'sorted another way' ? { ...live, active: false } : live);
  expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
  expect(button('First').closest('li')).not.toHaveAttribute('data-draggable');
  expect(button('First')).not.toHaveAttribute('aria-keyshortcuts');
  button('First').focus();
  await alt('ArrowDown');
  expect(updates()).toEqual([]);
});

test('a queue takes Alt+↓ as a move, and a bare arrow still moves the focus', async () => {
  wrap(<QueueList table={table} rows={rows} spec={{ kind: 'queue', primary: 'name' }} order={live} />);
  const option = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name}`) });
  option('First').focus();
  await alt('ArrowDown');
  // Drawn in its new place at once, before the write is answered, with the focus.
  expect(screen.getAllByRole('row').map((row) => row.textContent)).toEqual(['Second⠿Open', 'First⠿Open', 'Third⠿Open']);
  await waitFor(() => expect(updates()).toEqual([[1, 2560]]));
  // The row is what holds the focus in the selection grid, so it takes it back.
  await waitFor(() => expect(option('First')).toHaveFocus());
  // This fixture's server never keeps a number: read again, the queue is as it says, and the focus stays on the row.
  await waitFor(() => expect(screen.getAllByRole('row')[0]).toHaveTextContent(/^First/));
  expect(option('First')).toHaveFocus();
  await userEvent.keyboard('{ArrowDown}');
  expect(option('Second')).toHaveFocus();
  expect(button('Reorder Second')).toBeInTheDocument();
});

test('cards take their place the same way, from the card or its grip', async () => {
  wrap(<CardsList table={table} rows={rows} spec={{ kind: 'cards', primary: 'name' }} order={live} label="Tasks" />);
  expect(button('Reorder First')).toBeInTheDocument();
  button('Second').focus();
  await alt('ArrowDown');
  // After the last: a step past it.
  await waitFor(() => expect(updates()).toEqual([[2, 4096]]));
});

/* The grid draws its own rows; this one is only what GridOrder reads of it — a keyed row with a leading host. */
function FakeGrid({ data }: { data: typeof rows }) {
  const hosts = useRowHostScope()!;
  return (
    <table>
      <tbody>
        {data.map((row) => {
          const key = rowKeyString(table, row)!;
          return (
            <tr key={key} data-row-key={key}>
              <td className="row-host" ref={hosts.ref(key)} />
              <td>
                <button type="button">{row.name}</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

test('a grid row is dragged by the row, with its grip in the leading cell, and Alt+↑ on a cell moves it', async () => {
  wrap(
    <RowHosts>
      <GridOrder table={table} rows={rows} order={live} interactive>
        {(drawn) => <FakeGrid data={drawn as typeof rows} />}
      </GridOrder>
    </RowHosts>,
  );
  const row = (name: string) => button(name).closest('tr')!;
  expect(button('Reorder Second').closest('td')).toHaveClass('row-host');
  const untall = tall(32);
  const drag = pressToDrag(button('Third'));
  drag.over(row('First'));
  expect(row('First')).not.toHaveAttribute('data-drop');
  expect(row('First').style.translate).toBe('0 32px');
  drag.drop();
  untall();
  await waitFor(() => expect(updates()).toEqual([[3, 0]]));
  // A move is taken only once the last has landed and been said; the focus is back on its grip.
  await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Moved “Third” to place 1 of 3'));
  await waitFor(() => expect(button('Reorder Third')).toHaveFocus());
  button('Second').focus();
  await alt('ArrowUp');
  await waitFor(() =>
    expect(updates()).toEqual([
      [3, 0],
      [2, 0],
    ]),
  );
});
