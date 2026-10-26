/**
 * A board ordered by a numeric column: lanes read in its order, and a move
 * writes as little as the numbers allow — one card between its neighbors,
 * or the lane renumbered when there is no number left between them.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppBoardList } from '../../../../engine/src/shared/listPresentations.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  allowed: true,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false },
  state: { activeConnection: 'tick', connections: [{ id: 'tick', writable: true }] },
}));
const table: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'rank', type: 'REAL', nullable: true, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: vi.fn(),
  state: mocks.state,
  toast: mocks.toast,
  writeAllowed: () => mocks.allowed,
  findTable: () => table,
  primaryKey,
  columnLabel: () => null,
  quote: (value: unknown) => String(value),
  columnDisplay: () => null,
  // The card menu's popup is placed on the zoom-aware ruler.
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
// The lane's "+" opens the New form; the form's module reaches the whole shell.
vi.mock('../../../../kit/src/client/insert.js', () => ({ openNewRecord: () => undefined }));
vi.mock('./sdk/commands.js', () => ({ recordCommand: () => undefined }));
const { BoardList } = await import('./BoardList.js');
const { placements } = await import('../../../../kit/src/client/components/placeOrder.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');

const spec: AppBoardList = { kind: 'board', by: 'status', lanes: ['new', 'done'], order: 'rank', primary: 'name' };
const rows = [
  { id: 1, name: 'Unplaced', status: 'new', rank: null },
  { id: 2, name: 'Last', status: 'new', rank: 3072 },
  { id: 3, name: 'First', status: 'new', rank: 1024 },
  { id: 4, name: 'Middle', status: 'new', rank: 2048 },
  { id: 5, name: 'Done one', status: 'done', rank: 1 },
];
function draw(data = rows) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BoardList table={table} rows={data} spec={spec} />
    </QueryClientProvider>,
  );
}
const updates = () => mocks.api.mock.calls.filter(([path]) => path === '/api/update').map(([, body]) => [body.key.id, body.values.rank]);
const laneTitles = (lane: string) =>
  within(screen.getByRole('heading', { level: 2, name: lane }).closest('section')!)
    .getAllByRole('button')
    .filter((button) => !button.getAttribute('aria-label')?.startsWith('Actions for'))
    .map((button) => button.getAttribute('aria-label'));
/** Take a place from a card's ⋯ menu. */
async function place(title: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}
/** Whether a card's ⋯ offers any place at all (its name may still be the reader's to edit). */
async function orderOffered(title: string) {
  const button = screen.queryByRole('button', { name: `Actions for ${title}` });
  if (!button) return false;
  await userEvent.click(button);
  await screen.findAllByRole('menuitem');
  const offered = screen.queryByRole('group', { name: 'Order' }) !== null;
  await userEvent.keyboard('{Escape}');
  return offered;
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.toast.mockReset();
  mocks.allowed = true;
  mocks.api.mockImplementation(async (_path: string, body: { values?: unknown }) => ({ affected: 1, applied: body.values }));
  table.columns[3] = { name: 'rank', type: 'REAL', nullable: true, primaryKey: false };
  updateAttempts.reset();
});
afterEach(cleanup);

test("a lane reads in its order column's order, with empty places last", () => {
  draw();
  expect(laneTitles('New')).toEqual(['First', 'Middle', 'Last', 'Unplaced']);
});

test('a move writes the one card, halfway between its new neighbors, and says where it went', async () => {
  draw(rows.filter((row) => row.rank !== null));
  await place('Last', 'Move up');
  await waitFor(() => expect(updates()).toEqual([[2, 1536]]));
  await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Moved “Last” to place 2 of 3 in New'));
  expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
});

test('Alt and an arrow key moves the card the menu would', async () => {
  draw(rows.filter((row) => row.rank !== null));
  screen.getByRole('button', { name: 'First' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
  await waitFor(() => expect(updates()).toEqual([[3, 2560]]));
});

test('with no number between the neighbors, the lane is numbered again, each card already on its number left alone', () => {
  const card = (id: string, position?: number) => ({ id, ...(position === undefined ? {} : { position }) });
  // Whole numbers side by side: nothing between 1 and 2.
  expect(placements(card('c', 9), [card('a', 1), card('b', 2)], 1, true)).toEqual([
    [card('a', 1), 1024],
    [card('c', 9), 2048],
    [card('b', 2), 3072],
  ]);
  // A fraction halves; a whole number floors, and an end takes a step past its neighbor.
  expect(placements(card('c', 9), [card('a', 1), card('b', 2)], 1, false)).toEqual([[card('c', 9), 1.5]]);
  expect(placements(card('c', 9), [card('a', 1024), card('b', 2048)], 2, true)).toEqual([[card('c', 9), 3072]]);
  expect(placements(card('c', 9), [card('a', 1024), card('b', 2048)], 0, true)).toEqual([[card('c', 9), 0]]);
  // A neighbor with no place yet: the lane is numbered, and a card already on its number is not written.
  expect(placements(card('c'), [card('a', 1024), card('b')], 1, false)).toEqual([
    [card('c'), 2048],
    [card('b'), 3072],
  ]);
});

test('a renumbered lane is several ordinary updates; a refused one stops the rest and is said', async () => {
  table.columns[3] = { name: 'rank', type: 'INTEGER', nullable: true, primaryKey: false };
  let written = 0;
  mocks.api.mockImplementation(async (_path: string, body: { values?: unknown }) => {
    if (++written === 2) throw Object.assign(new Error('Locked'), { status: 409 });
    return { affected: 1, applied: body.values };
  });
  draw([
    { id: 1, name: 'A', status: 'new', rank: 1 },
    { id: 2, name: 'B', status: 'new', rank: 2 },
    { id: 3, name: 'C', status: 'new', rank: 3 },
  ]);
  await place('C', 'Move up');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Locked', 'error'));
  expect(updates()).toEqual([
    [1, 1024],
    [3, 2048],
  ]);
});

test.each(['grant', 'connection', 'field', 'actions'])('%s denial offers no reordering', async (kind) => {
  if (kind === 'grant') mocks.allowed = false;
  if (kind === 'connection') mocks.state.connections[0].writable = false;
  if (kind === 'field') table.columns[3] = { ...table.columns[3], writable: false };
  if (kind === 'actions') table.columns[3] = { ...table.columns[3], changesBy: 'actions' };
  draw();
  expect(await orderOffered('First')).toBe(false);
  expect(screen.getByRole('button', { name: 'First' })).not.toHaveAttribute('data-draggable');
  // Still read in order: the order is the author's, whoever may change it.
  expect(laneTitles('New')).toEqual(['First', 'Middle', 'Last', 'Unplaced']);
  mocks.state.connections[0].writable = true;
});
