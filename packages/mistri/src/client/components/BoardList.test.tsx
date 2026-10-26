import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../shared/app.js';
import type { AppBoardList } from '../../../../engine/src/shared/listPresentations.js';
import { dragOnto } from '../../../../kit/src/client/components/dragTesting.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  toast: vi.fn(),
  allowed: true,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false },
  state: { activeConnection: 'tick', connections: [{ id: 'tick', writable: true }] },
  display: {} as Record<string, { values?: Record<string, string> }>,
}));
/* The name and the owner are read-only here, so a card's ⋯ appears only for
   the moves it is offered — the edits have a test of their own below. */
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
    { name: 'rank', type: 'REAL', nullable: true, primaryKey: false },
    { name: 'priority', type: 'TEXT', nullable: true, primaryKey: false, allowed: ['high', 'low'] },
    { name: 'cycle_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'cycle', column: 'id' } },
  ],
};
const cycle: TableMeta = {
  id: 'cycle',
  name: 'cycle',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const tables: Record<string, TableMeta> = { ticket: table, cycle };
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  toast: mocks.toast,
  writeAllowed: () => mocks.allowed,
  findTable: (id: string) => tables[id],
  primaryKey,
  columnLabel: () => null,
  // The card menu's popup is placed on the zoom-aware ruler.
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  quote: (value: unknown) => String(value),
  columnDisplay: (_table: string, column: string) => mocks.display[column] ?? null,
  refsFrom: () => [],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
/* The editors are the record page's; here the card only has to ask for one and draw it. */
vi.mock('./BoardCardEditor.js', () => ({
  default: ({ column, onClose }: { column?: { name: string }; onClose: (reason: string) => void }) => (
    <div data-testid="card-editor">
      {column ? `editing ${column.name}` : 'saved'}
      <button type="button" onClick={() => onClose('saved')}>
        Stub save
      </button>
    </div>
  ),
}));
/* A machine's command verb runs through the SDK's pipeline; here it is recorded, and granted as the test says. */
const commands = vi.hoisted(() => ({
  granted: new Set<string>(),
  runs: [] as Array<{ id: string; key: unknown; input: unknown }>,
  // What the command's output says it did, when it says anything.
  said: undefined as string | undefined,
}));
// The lane's "+" opens the New form; the form's module reaches the whole shell.
vi.mock('../../../../kit/src/client/insert.js', () => ({ openNewRecord: () => undefined }));
vi.mock('./sdk/commands.js', () => ({
  recordCommand: (command: { id: string }) =>
    commands.granted.has(command.id)
      ? async (key: unknown, input: unknown) => {
          commands.runs.push({ id: command.id, key, input });
          return commands.said === undefined ? { status: 'applied' } : { status: 'applied', message: commands.said };
        }
      : undefined,
}));
const { BoardList } = await import('./BoardList.js');
const { canShowBoard } = await import('../../../../kit/src/client/components/presentationFit.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');

const spec: AppBoardList = { kind: 'board', by: 'status', lanes: ['new', 'in_progress', 'done'], primary: 'name', lines: ['owner'] };
const bigId = '9007199254740993';
const rows = [
  { id: bigId, name: 'Broken login', status: 'new', owner: 'Aster' },
  { id: 2, name: 'Slow export', status: 'in_progress', owner: null },
  { id: 3, name: 'Old thing', status: 'archived', owner: null },
];
const start: AppAction = { id: 'start', label: 'Start', set: { status: 'in_progress' }, when: 'status = new' };
const finish: AppAction = { id: 'finish', label: 'Finish', set: { status: 'done' } };
const keyRows = (...ids: unknown[]) => ({ rows: ids.map((id) => ({ id })), columns: ['id'] });

function draw(
  actions: AppAction[] = [start],
  options: { rows?: Array<Record<string, unknown>>; interactive?: boolean; label?: string; spec?: AppBoardList; query?: string } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const result = render(
    <QueryClientProvider client={client}>
      <BoardList
        table={table}
        rows={options.rows ?? rows}
        spec={options.spec ?? spec}
        actions={actions}
        interactive={options.interactive ?? true}
        label={options.label}
        query={options.query}
      />
    </QueryClientProvider>,
  );
  return { ...result, invalidate };
}
/** Answer the `when` read with these keys and every update as applied. */
function serve(matching: unknown[]) {
  mocks.api.mockImplementation(async (path: string, body: { values?: unknown }) =>
    path === '/api/run' ? keyRows(...matching) : { affected: 1, applied: body.values },
  );
}
const trigger = (title: string) => screen.findByRole('button', { name: `Actions for ${title}` });
/** The lanes a card's ⋯ offers, read and closed again. */
async function lanesFor(title: string) {
  await userEvent.click(await trigger(title));
  await screen.findAllByRole('menuitem');
  const group = screen.queryByRole('group', { name: 'Move to' });
  const names = group
    ? within(group)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    : [];
  await userEvent.keyboard('{Escape}');
  return names;
}
async function choose(title: string, item: string, user: { click: (element: Element) => Promise<void> } = userEvent) {
  await user.click(await trigger(title));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}
const updates = () => mocks.api.mock.calls.filter(([path]) => path === '/api/update').map(([, body]) => body.values);

beforeEach(() => {
  mocks.api.mockReset();
  mocks.open.mockReset();
  mocks.toast.mockReset();
  mocks.allowed = true;
  mocks.state.activeConnection = 'tick';
  mocks.state.connections[0].writable = true;
  mocks.identity = { epoch: 1, mode: 'anonymous', tenantRequired: false };
  table.columns[1].writable = false;
  table.columns[2].writable = undefined;
  table.columns[5].writable = undefined;
  updateAttempts.reset();
  mocks.display = {};
});
afterEach(cleanup);

test('lanes follow the authored order, said as words, and cards land in their lane; the rest are counted', () => {
  draw([], { label: 'Board' });
  expect(screen.getByRole('group', { name: 'Board' })).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['New', 'In progress', 'Done']);
  // The stored value stays the lane's title, as a tone chip keeps it.
  expect(screen.getByRole('heading', { level: 2, name: 'In progress' })).toHaveAttribute('title', 'in_progress');
  const lanes = screen.getAllByRole('heading', { level: 2 }).map((node) => node.closest('section')!);
  expect(within(lanes[0]).getByRole('button', { name: 'Broken login, Aster' })).toBeInTheDocument();
  expect(within(lanes[1]).getByRole('button', { name: 'Slow export' })).toBeInTheDocument();
  expect(within(lanes[2]).getByText('No records here.')).toBeInTheDocument();
  expect(screen.queryByText('Old thing')).toBeNull();
  expect(screen.getByText('1 record is in other states.')).toBeInTheDocument();
});

test("a title that is a reference is said by its record's name, not its key", () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <BoardList
        table={{ ...table, columns: [...table.columns, { name: 'assignee_id', type: 'INTEGER', nullable: true, primaryKey: false }] }}
        rows={[{ id: 7, name: 'x', status: 'new', owner: null, assignee_id: 4, 'assignee_id.name': 'Sprint 12' }]}
        spec={{ ...spec, primary: 'assignee_id', lines: [] }}
        referenceLabels={{ assignee_id: 'assignee_id.name' }}
        actions={[]}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Sprint 12' })).toBeInTheDocument();
  expect(screen.queryByText('4')).toBeNull();
});

test('a title read through a reference path is said by the name the row carries, and the card is shown only when it was fetched', () => {
  const client = new QueryClient();
  const through: AppBoardList = { ...spec, primary: 'cycle_id.name', lines: [] };
  render(
    <QueryClientProvider client={client}>
      <BoardList
        table={table}
        rows={[{ id: 7, name: 'x', status: 'new', owner: null, cycle_id: 3, 'cycle_id.name': 'Sprint 12' }]}
        spec={through}
        actions={[]}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Sprint 12' })).toBeInTheDocument();
  expect(screen.queryByText('3')).toBeNull();
  expect(canShowBoard(table, ['id', 'status', 'cycle_id.name'], through)).toBe(true);
  expect(canShowBoard(table, ['id', 'status'], through)).toBe(false);
});

test("a line and a footer fact that are references say their record's name, and a referenced title is not typed over", () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <BoardList
        table={table}
        rows={[{ id: 7, name: 'x', status: 'new', owner: null, cycle_id: 3, 'cycle_id.name': 'Sprint 12' }]}
        spec={{ ...spec, primary: 'cycle_id', lines: ['cycle_id'], footer: [{ column: 'cycle_id' }] }}
        referenceLabels={{ cycle_id: 'cycle_id.name' }}
        actions={[]}
      />
    </QueryClientProvider>,
  );
  const card = screen.getByRole('button', { name: /^Sprint 12/ });
  expect(within(card.closest('li') ?? card).getAllByText('Sprint 12').length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText('3')).toBeNull();
  expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
});

/* The list's server: a count of every lane in one breakdown, and each lane's
   cards as many as asked for. `counts` maps a lane value (null for none) to its size. */
function serveLanes(counts: Array<[string | null, number]>) {
  mocks.api.mockImplementation(async (path: string, body: { q?: string; limit?: number; text?: string }) => {
    if (path === '/api/breakdown') return { columns: ['status', 'count'], rows: counts.map(([status, count]) => ({ status, count })) };
    if (path === '/api/run') {
      const lane = /status is empty/.test(body.q ?? '') ? null : /status = (\w+)/.exec(body.q ?? '')?.[1];
      const size = counts.find(([status]) => status === lane)?.[1] ?? 0;
      return {
        rows: Array.from({ length: Math.min(size, body.limit ?? 0) }, (_, i) => ({
          id: `${lane}-${i}`,
          name: `${lane ?? 'none'} ${i}`,
          status: lane,
          owner: null,
        })),
      };
    }
    return {};
  });
}

test('given its question, a board counts each lane over the whole list and reads a lane a page at a time', async () => {
  serveLanes([
    ['new', 900],
    ['in_progress', 3],
    ['archived', 2],
  ]);
  draw([], { query: 'ticket status != closed show id, name, status, owner sort rank' });
  // One breakdown for every lane's count, under the list's own conditions and nothing of its order.
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith('/api/breakdown', expect.objectContaining({ text: 'ticket status != closed count by status' })),
  );
  // A lane's head counts the lane, not the page: 900, where twenty are drawn.
  expect(await screen.findByLabelText('900 items')).toBeInTheDocument();
  const lane = screen.getByRole('heading', { level: 2, name: 'New' }).closest('section')!;
  await waitFor(() => expect(within(lane).getAllByRole('button', { name: /^new \d+$/ })).toHaveLength(20));
  expect(mocks.api).toHaveBeenCalledWith(
    '/api/run',
    expect.objectContaining({ q: 'ticket status != closed and status = new show id, name, status, owner sort rank', limit: 20 }),
  );
  expect(screen.getByText('2 records are in other states.')).toBeInTheDocument();
  // Its next page is read in place.
  await userEvent.click(within(lane).getByRole('button', { name: 'Show 20 more' }));
  await waitFor(() => expect(within(lane).getAllByRole('button', { name: /^new \d+$/ })).toHaveLength(40));
});

test('records with no value have a lane of their own, and a board past its cap says so', async () => {
  const many: Array<[string | null, number]> = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((status, i) => [status, 20 - i]);
  serveLanes([...many, [null, 4]]);
  draw([], { query: 'ticket', spec: { ...spec, lanes: undefined } });
  await waitFor(() =>
    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'No status',
    ]),
  );
  expect(mocks.api).toHaveBeenCalledWith('/api/run', expect.objectContaining({ q: 'ticket status is empty' }));
  expect(await screen.findByText('12 records are in 1 more state: a board draws at most 8 lanes.')).toBeInTheDocument();
});

test('lanes fall back to the column vocabulary, then to the values seen', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const worded = { ...table, columns: table.columns.map((c) => (c.name === 'status' ? { ...c, allowed: ['open', 'closed'] } : c)) };
  render(
    <QueryClientProvider client={client}>
      <BoardList table={worded} rows={rows} spec={{ ...spec, lanes: undefined }} />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['Open', 'Closed']);
  expect(screen.getByText('3 records are in other states.')).toBeInTheDocument();
  cleanup();
  render(
    <QueryClientProvider client={client}>
      <BoardList table={table} rows={rows} spec={{ ...spec, lanes: undefined }} />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['New', 'In progress', 'Archived']);
  expect(screen.queryByText(/other states/)).toBeNull();
});

test('a lane behind a "when" is offered once the server vouches for the card, and a move is one update', async () => {
  serve([bigId]);
  const { invalidate } = draw();
  expect(await lanesFor('Broken login')).toEqual(['In progress']);
  expect(mocks.api).toHaveBeenCalledWith('/api/run', expect.objectContaining({ q: expect.stringContaining('status = new'), conn: 'tick' }));
  await choose('Broken login', 'In progress');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Start — done', 'ok'));
  const calls = mocks.api.mock.calls.filter(([path]) => path === '/api/update');
  expect(calls).toEqual([
    ['/api/update', { conn: 'tick', table: 'ticket', key: { id: bigId }, values: { status: 'in_progress' }, expected: { status: 'new' } }],
  ]);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['run', 'tick'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['count', 'tick'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['when', 'ticket'] });
});

test("a machine's command verb is a lane move for a reader granted it, run as its button would be, writing nothing itself", async () => {
  serve([2]);
  mocks.allowed = false;
  commands.granted = new Set(['advanceTicket']);
  commands.runs.length = 0;
  const advance = {
    id: 'advance',
    label: 'Advance',
    command: { id: 'advanceTicket', version: 1, target: 'ticket', input: [] },
    when: 'status = in_progress',
    move: { column: 'status', edges: [{ from: 'in_progress', to: 'done' }] },
  } as unknown as AppAction;
  draw([advance]);
  expect(await lanesFor('Slow export')).toEqual(['Done']);
  expect(screen.queryByRole('button', { name: 'Actions for Broken login' })).toBeNull();
  await choose('Slow export', 'Done');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Advance — done', 'ok'));
  expect(commands.runs).toEqual([{ id: 'advanceTicket', key: { id: 2 }, input: {} }]);
  expect(updates()).toEqual([]);
  cleanup();
  commands.granted = new Set();
  draw([advance]);
  await screen.findByText('Slow export');
  expect(screen.queryByRole('button', { name: 'Actions for Slow export' })).toBeNull();
  mocks.allowed = true;
});

test('a verb that leads each state elsewhere offers each card its own lane, and one told the column offers every end (G62)', async () => {
  serve([bigId, 2]);
  mocks.allowed = false;
  commands.granted = new Set(['advanceTicket', 'moveTicket']);
  commands.runs.length = 0;
  const advance = {
    id: 'advance',
    label: 'Advance',
    command: { id: 'advanceTicket', version: 1, target: 'ticket', input: [] },
    when: 'status in (new, in_progress)',
    move: {
      column: 'status',
      edges: [
        { from: 'new', to: 'in_progress' },
        { from: 'in_progress', to: 'done' },
      ],
    },
  } as unknown as AppAction;
  draw([advance]);
  expect(await lanesFor('Broken login')).toEqual(['In progress']);
  expect(await lanesFor('Slow export')).toEqual(['Done']);
  cleanup();
  // Several ends from "new": offered only because the command asks for the column, and told the lane dropped on.
  const move = {
    id: 'move',
    label: 'Move',
    command: { id: 'moveTicket', version: 1, target: 'ticket', input: [{ name: 'status', type: 'text' }] },
    when: 'status = new',
    move: {
      column: 'status',
      edges: [
        { from: 'new', to: 'in_progress' },
        { from: 'new', to: 'done' },
      ],
    },
  } as unknown as AppAction;
  serve([bigId]);
  draw([move]);
  expect(await lanesFor('Broken login')).toEqual(['In progress', 'Done']);
  await choose('Broken login', 'Done');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Move — done', 'ok'));
  expect(commands.runs).toEqual([{ id: 'moveTicket', key: { id: bigId }, input: { status: 'done' } }]);
  expect(updates()).toEqual([]);
  cleanup();
  // Told nothing, a verb with several ends is the handler's to pick: no lane is offered for it.
  serve([bigId]);
  draw([{ ...move, command: { ...(move as unknown as { command: object }).command, input: [] } } as unknown as AppAction]);
  await screen.findByText('Broken login');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.queryByRole('button', { name: 'Actions for Broken login' })).toBeNull();
  commands.granted = new Set();
  mocks.allowed = true;
});

test("a verb dropped on a lane says the command's own words when it said any, else that it is done", async () => {
  serve([bigId]);
  mocks.allowed = false;
  commands.granted = new Set(['advanceTicket']);
  commands.runs.length = 0;
  const advance = {
    id: 'advance',
    label: 'Advance',
    command: { id: 'advanceTicket', version: 1, target: 'ticket', input: [] },
    when: 'status = new',
    move: { column: 'status', edges: [{ from: 'new', to: 'in_progress' }] },
  } as unknown as AppAction;
  commands.said = 'Ticket #1 is with the on-call engineer';
  draw([advance]);
  await choose('Broken login', 'In progress');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Ticket #1 is with the on-call engineer', 'ok'));
  expect(mocks.toast).not.toHaveBeenCalledWith('Advance — done', 'ok');
  cleanup();
  mocks.toast.mockReset();
  commands.said = undefined;
  serve([bigId]);
  draw([advance]);
  await choose('Broken login', 'In progress');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Advance — done', 'ok'));
  expect(commands.runs).toHaveLength(2);
  commands.granted = new Set();
  mocks.allowed = true;
});

test("a lane is said by the column's display word, in its heading and in Move to", async () => {
  mocks.display = { status: { values: { new: 'Fresh', in_progress: 'Underway', done: 'Closed' } } };
  serve([bigId]);
  draw();
  expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['Fresh', 'Underway', 'Closed']);
  expect(await lanesFor('Broken login')).toEqual(['Underway']);
  await choose('Broken login', 'Underway');
  await waitFor(() => expect(updates()).toEqual([{ status: 'in_progress' }]));
});

test('a card the "when" does not match gets no such lane, and one with no lane gets no menu', async () => {
  serve([]);
  draw([start, finish]);
  expect(await lanesFor('Broken login')).toEqual(['Done']);
  expect(await trigger('Slow export')).toBeInTheDocument();
  cleanup();
  serve([]);
  draw([start]);
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/run', expect.anything()));
  // Settled, not merely still loading: the answer was "none", and the menu stays away.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
});

test('a lane with no move action is never offered, writable or not', async () => {
  serve([bigId, 2]);
  draw([finish]);
  expect(await lanesFor('Broken login')).toEqual(['Done']);
  expect(await lanesFor('Slow export')).toEqual(['Done']);
  expect(mocks.api).not.toHaveBeenCalledWith('/api/run', expect.anything());
});

test('the offered lanes are the actions that set exactly the lane column', async () => {
  serve([bigId, 2]);
  draw([
    { id: 'close', label: 'Close', set: { status: 'done', owner: null } },
    { id: 'own', label: 'Own', set: { owner: 'me' } },
    { id: 'park', label: 'Park', set: { status: 'parked' } },
    finish,
  ]);
  expect(await lanesFor('Broken login')).toEqual(['Done']);
});

test.each(['grant', 'connection', 'field', 'embedded'])('%s denial draws no move menu', async (kind) => {
  if (kind === 'grant') mocks.allowed = false;
  if (kind === 'connection') mocks.state.connections[0].writable = false;
  if (kind === 'field') table.columns[2].writable = false;
  draw([start, finish], { interactive: kind !== 'embedded' });
  expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  expect(mocks.api).not.toHaveBeenCalled();
});

test('a card opens its record with the exact key and the board as its set', async () => {
  mocks.allowed = false;
  draw([finish]);
  await userEvent.click(screen.getByRole('button', { name: 'Broken login, Aster' }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('ticket', { id: bigId }, 'Broken login', 'push', {
    records: [
      { key: { id: bigId }, label: 'Broken login' },
      { key: { id: 2 }, label: 'Slow export' },
    ],
  });
  cleanup();
  mocks.open.mockReset();
  draw([finish], { interactive: false });
  await userEvent.click(screen.getByRole('button', { name: 'Broken login, Aster' }));
  expect(mocks.open).not.toHaveBeenCalled();
});

test('a rejected write is said, and the card stays where it was', async () => {
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/api/run') return keyRows(bigId);
    throw Object.assign(new Error('Nope'), { status: 409 });
  });
  draw();
  await choose('Broken login', 'In progress');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Nope', 'error'));
  const lane = screen.getByRole('heading', { level: 2, name: 'New' }).closest('section')!;
  expect(within(lane).getByRole('button', { name: 'Broken login, Aster' })).toBeInTheDocument();
  expect(await trigger('Broken login')).toBeEnabled();
});

test('an unconfirmed write stays on the card as its own words', async () => {
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/api/run') return keyRows(bigId);
    throw new Error('Network lost');
  });
  draw();
  await choose('Broken login', 'In progress');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Broken login, Aster' })).toHaveTextContent('Update not confirmed'));
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('a confirming action asks first; Cancel writes nothing, the verb writes', async () => {
  serve([bigId]);
  const user = userEvent.setup();
  draw([{ ...finish, confirm: true }]);
  await choose('Broken login', 'Done', user);
  const dialog = screen.getByRole('dialog', { hidden: true });
  expect(dialog).toHaveAccessibleName('Finish?');
  expect(dialog).toHaveTextContent('Move "Broken login" to Done');
  await user.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(updates()).toEqual([]);
  await choose('Broken login', 'Done', user);
  await user.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Finish', hidden: true }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Finish — done', 'ok'));
  expect(updates()).toHaveLength(1);
});

test('a late reply from a retired session cannot refresh its successor', async () => {
  let resolve!: (value: unknown) => void;
  mocks.api.mockImplementation((path: string) =>
    path === '/api/run'
      ? Promise.resolve(keyRows(bigId))
      : new Promise((r) => {
          resolve = r;
        }),
  );
  const { invalidate } = draw();
  await choose('Broken login', 'In progress');
  await waitFor(() => expect(resolve).toBeDefined());
  mocks.identity = { ...mocks.identity, epoch: 2 };
  resolve({ affected: 1, applied: { status: 'in_progress' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(invalidate).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('a board requires the lane, primary and line columns and complete primary keys', () => {
  expect(canShowBoard(table, ['id', 'name', 'status', 'owner'], spec)).toBe(true);
  expect(canShowBoard(table, ['id', 'name', 'status'], spec)).toBe(false);
  expect(canShowBoard(table, ['id', 'name', 'status'], { ...spec, lines: undefined })).toBe(true);
  expect(canShowBoard(table, ['name', 'status', 'owner'], spec)).toBe(false);
  expect(
    canShowBoard({ ...table, columns: table.columns.map((c) => ({ ...c, primaryKey: false })) }, ['id', 'name', 'status', 'owner'], spec),
  ).toBe(false);
  // A board with rows needs its row column too.
  expect(canShowBoard(table, ['id', 'name', 'status', 'owner'], { ...spec, swimlanes: 'priority' })).toBe(false);
});

test("a reference column's lanes are the rows it points at, led by one for none; a move writes the reference", async () => {
  mocks.api.mockImplementation(async (path: string, body: { values?: unknown }) =>
    path === '/api/query'
      ? {
          rows: [
            { id: 1, name: 'Cycle 18' },
            { id: 2, name: 'Cycle 19' },
          ],
          columns: ['id', 'name'],
        }
      : { affected: 1, applied: body.values },
  );
  draw([], {
    spec: { kind: 'board', by: 'cycle_id', primary: 'name' },
    label: 'Planning',
    rows: [
      { id: 7, name: 'Planned', cycle_id: 1 },
      { id: 8, name: 'Loose', cycle_id: null },
    ],
  });
  await waitFor(() =>
    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['No cycle', 'Cycle 18', 'Cycle 19']),
  );
  expect(mocks.api).toHaveBeenCalledWith(
    '/api/query',
    expect.objectContaining({
      table: 'cycle',
      columns: ['id', 'name'],
      orderBy: [{ column: 'id', direction: 'asc' }],
      limit: 8,
      conn: 'tick',
    }),
  );
  const lane = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section')!;
  expect(within(lane('Cycle 18')).getByRole('button', { name: 'Planned' })).toBeInTheDocument();
  expect(within(lane('No cycle')).getByRole('button', { name: 'Loose' })).toBeInTheDocument();
  // An ordinary column: every other lane is the reader's, the key written as the number it is.
  expect(await lanesFor('Planned')).toEqual(['No cycle', 'Cycle 19']);
  /* The rows handed to the board never change, so once a move is saved and read again its card goes back to the lane
     its row names, a frame later. A menu opened in that frame lands on a card being moved and never opens, which
     timed this test out whenever the file ran at full speed: wait for the board to be still before the next move. */
  const back = (title: string, name: string) =>
    waitFor(() => expect(within(lane(name)).getByRole('button', { name: title })).toBeInTheDocument());
  await choose('Planned', 'Cycle 19');
  await waitFor(() => expect(updates()).toEqual([{ cycle_id: 2 }]));
  await back('Planned', 'Cycle 18');
  await choose('Loose', 'Cycle 18');
  await waitFor(() => expect(updates()).toEqual([{ cycle_id: 2 }, { cycle_id: 1 }]));
  await back('Loose', 'No cycle');
  await choose('Planned', 'No cycle');
  await waitFor(() => expect(updates()).toEqual([{ cycle_id: 2 }, { cycle_id: 1 }, { cycle_id: null }]));
  expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), 'error');
});

test("swimlanes: a row per value, a row move is one update of that column, and a row not the reader's says why", async () => {
  serve([]);
  const laned: AppBoardList = { ...spec, swimlanes: 'priority' };
  const data = [
    { id: 1, name: 'Alpha', status: 'new', owner: null, priority: 'high' },
    { id: 2, name: 'Bravo', status: 'done', owner: null, priority: 'low' },
    { id: 3, name: 'Charlie', status: 'new', owner: null, priority: null },
  ];
  draw([finish], { spec: laned, rows: data });
  expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['High', 'Low', 'No priority']);
  await choose('Alpha', 'Low');
  await waitFor(() => expect(updates()).toEqual([{ priority: 'low' }]));
  await choose('Charlie', 'High');
  await waitFor(() => expect(updates()).toEqual([{ priority: 'low' }, { priority: 'high' }]));
  cleanup();
  table.columns[5].writable = false;
  draw([finish], { spec: laned, rows: data });
  await userEvent.click(await trigger('Alpha'));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Done']);
  await userEvent.keyboard('{Escape}');
  screen.getByRole('button', { name: 'Alpha' }).focus();
  await userEvent.keyboard('{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}');
  expect(mocks.toast).toHaveBeenCalledWith('Priority is not yours to change here, so a card keeps its row.');
});

test("a limit says the lane's count over it, and warns past it", () => {
  draw([], { spec: { ...spec, limits: { new: 1, done: 2 } }, rows: [...rows, { id: 4, name: 'Also new', status: 'new', owner: null }] });
  const count = (lane: string) =>
    screen.getByRole('heading', { level: 2, name: lane }).closest('header')!.querySelector('.triage-lane-count')!;
  expect(count('New')).toHaveTextContent('2 / 1');
  expect(count('New')).toHaveClass('is-over');
  expect(count('Done')).toHaveTextContent('0 / 2');
  expect(count('In progress')).toHaveTextContent('1');
});

test('dropped before a card in another lane: the action moves it, then one update gives its place; a place that fails is said', async () => {
  const ordered: AppBoardList = { ...spec, order: 'rank' };
  const data = [
    { id: 1, name: 'Mover', status: 'new', owner: null, rank: 1024 },
    { id: 2, name: 'Standing', status: 'in_progress', owner: null, rank: 1024 },
  ];
  serve([1]);
  draw([start], { spec: ordered, rows: data });
  await trigger('Mover');
  dragOnto(screen.getByRole('button', { name: 'Mover' }), screen.getByRole('button', { name: 'Standing' }).closest('article')!);
  // The lane first, through its action alone; then the place, before the card it was dropped on.
  await waitFor(() => expect(updates()).toEqual([{ status: 'in_progress' }, { rank: 0 }]));
  await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Moved “Mover” to In progress, place 1'));
  cleanup();
  let calls = 0;
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string, body: { values?: unknown }) => {
    if (path === '/api/run') return keyRows(1);
    if (++calls === 2) throw Object.assign(new Error('Rank is locked'), { status: 409 });
    return { affected: 1, applied: body.values };
  });
  draw([start], { spec: ordered, rows: data });
  await trigger('Mover');
  dragOnto(screen.getByRole('button', { name: 'Mover' }), screen.getByRole('button', { name: 'Standing' }).closest('article')!);
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith('Moved to In progress, but its place was not saved: Rank is locked', 'error'),
  );
  expect(mocks.toast).toHaveBeenCalledWith('Start — done', 'ok');
});

test("F2 opens the card's field in place, under the card; a landed save leaves the bar and reads the rows again", async () => {
  table.columns[1].writable = undefined;
  const { invalidate } = draw([], { spec: { ...spec, lines: undefined } });
  const card = screen.getByRole('button', { name: 'Broken login' });
  expect(card).toHaveAttribute('aria-keyshortcuts', 'F2');
  card.focus();
  await userEvent.keyboard('{F2}');
  const editor = await screen.findByTestId('card-editor');
  expect(editor).toHaveTextContent('editing name');
  expect(card.closest('article')).toContainElement(editor);
  await userEvent.click(within(editor).getByRole('button', { name: 'Stub save' }));
  await waitFor(() => expect(screen.getByTestId('card-editor')).toHaveTextContent('saved'));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['run', 'tick'] });
  // The menu offers the same edit.
  await userEvent.click(await trigger('Broken login'));
  expect(
    within(screen.getByRole('group', { name: 'Edit' }))
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Name']);
});

/* A move is drawn before it is answered (optimisticMoves.ts): the card stands in its new lane at once, quiet while it
   saves, and goes back only if the write is refused. */
const laneOf = (name: string) => screen.getByRole('heading', { level: 2, name, hidden: true }).closest('section')!;
test('a moved card stands in its new lane before the write is answered, and a refusal puts it back with the reason', async () => {
  const answers: Array<(ok: boolean) => void> = [];
  mocks.api.mockImplementation((path: string, body: { values?: unknown }) => {
    if (path === '/api/run') return Promise.resolve(keyRows(bigId));
    return new Promise((resolve, reject) =>
      answers.push((ok) =>
        ok ? resolve({ affected: 1, applied: body.values }) : reject(Object.assign(new Error('Nope'), { status: 409 })),
      ),
    );
  });
  draw();
  await choose('Broken login', 'In progress');
  const card = within(laneOf('In progress')).getByRole('button', { name: 'Broken login, Aster' });
  expect(card.closest('.triage-card')).toHaveAttribute('aria-busy', 'true');
  expect(within(laneOf('New')).queryByRole('button', { name: 'Broken login, Aster' })).toBeNull();
  await waitFor(() => expect(answers).toHaveLength(1));
  answers[0](false);
  await waitFor(() => expect(within(laneOf('New')).getByRole('button', { name: 'Broken login, Aster' })).toBeInTheDocument());
  expect(mocks.toast).toHaveBeenCalledWith('Nope', 'error');
});

test('a move made while another saves waits its turn instead of being dropped', async () => {
  const answers: Array<() => void> = [];
  mocks.api.mockImplementation((path: string, body: { values?: unknown }) => {
    if (path === '/api/run') return Promise.resolve(keyRows(bigId, 2));
    return new Promise((resolve) => answers.push(() => resolve({ affected: 1, applied: body.values })));
  });
  draw([start, finish]);
  await choose('Broken login', 'In progress');
  await choose('Slow export', 'Done');
  expect(within(laneOf('Done')).getByRole('button', { name: /^Slow export/ })).toBeInTheDocument();
  await waitFor(() => expect(updates()).toEqual([{ status: 'in_progress' }]));
  answers[0]();
  await waitFor(() => expect(updates()).toEqual([{ status: 'in_progress' }, { status: 'done' }]));
  answers[1]();
  await waitFor(() =>
    expect(
      within(laneOf('Done'))
        .getByRole('button', { name: /^Slow export/ })
        .closest('.triage-card'),
    ).not.toHaveAttribute('aria-busy'),
  );
});

test('a move that asks first holds the card faded in its new lane, and Cancel puts it back', async () => {
  serve([bigId]);
  const user = userEvent.setup();
  draw([{ ...finish, confirm: true }]);
  await choose('Broken login', 'Done', user);
  expect(within(laneOf('Done')).getByRole('button', { name: 'Broken login, Aster', hidden: true }).closest('.triage-card')).toHaveClass(
    'is-asking',
  );
  await user.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));
  expect(within(laneOf('New')).getByRole('button', { name: 'Broken login, Aster' })).toBeInTheDocument();
  expect(updates()).toEqual([]);
});
