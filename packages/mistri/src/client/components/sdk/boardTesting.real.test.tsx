/**
 * `board` from `ui/testing`, against the real `<BoardList>` markup: the helpers a page test calls were proven on a
 * hand-written tree, and this holds that they find what the component actually draws.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../../shared/app.js';
import type { AppBoardList } from '../../../../../engine/src/shared/listPresentations.js';
import { board } from './testing.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  state: { activeConnection: 'tick', connections: [{ id: 'tick', writable: true }] },
}));
const table: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false, writable: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'owner', type: 'TEXT', nullable: true, primaryKey: false, writable: false },
  ],
};
vi.mock('../../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: vi.fn(),
  state: mocks.state,
  toast: vi.fn(),
  writeAllowed: () => true,
  findTable: () => table,
  primaryKey,
  columnLabel: () => null,
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  quote: (value: unknown) => String(value),
  columnDisplay: () => null,
  refsFrom: () => [],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../../kit/src/client/sessionIdentity.js', () => {
  const identity = { epoch: 1, mode: 'anonymous', tenantRequired: false };
  return {
    sessionIdentity: () => identity,
    captureSessionIdentity: () => identity,
    tenantLeaseActive: () => false,
    subscribeSessionIdentity: () => () => {},
    subscribeTenantLease: () => () => {},
  };
});
vi.mock('../BoardCardEditor.js', () => ({ default: () => null }));
vi.mock('../../../../../kit/src/client/insert.js', () => ({ openNewRecord: () => undefined }));
vi.mock('./commands.js', () => ({ recordCommand: () => undefined }));
const { BoardList } = await import('../BoardList.js');

const spec: AppBoardList = { kind: 'board', by: 'status', lanes: ['new', 'in_progress', 'done'], primary: 'name', lines: ['owner'] };
const rows = [
  { id: 1, name: 'Broken login', status: 'new', owner: 'Aster' },
  { id: 2, name: 'Slow export', status: 'in_progress', owner: null },
];
const start: AppAction = { id: 'start', label: 'Start', set: { status: 'in_progress' }, when: 'status = new' };

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string, body: { values?: unknown }) =>
    path === '/api/run' ? { rows: [{ id: 1 }], columns: ['id'] } : { affected: 1, applied: body.values },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BoardList table={table} rows={rows} spec={spec} actions={[start]} interactive label="Board" />
    </QueryClientProvider>,
  );
});
afterEach(cleanup);

test('board.lane and board.card find a lane by its title and a card, whose name carries its lines, by its title', () => {
  expect(board.lane('In progress')).toContainElement(board.card('Slow export'));
  expect(board.lane('New')).toContainElement(board.card('Broken login'));
  expect(() => board.card('Nothing')).toThrow();
});

test('board.move drops a card into a lane, and the board asks for the move the lane stands for', async () => {
  // A card is movable once the read of which moves it is offered has answered: its menu is the sign of that.
  await screen.findByRole('button', { name: 'Actions for Broken login' });
  board.move('Broken login', 'In progress');
  await waitFor(() =>
    expect(mocks.api.mock.calls.filter(([path]) => path === '/api/update').map(([, body]) => body.values)).toEqual([
      { status: 'in_progress' },
    ]),
  );
});
