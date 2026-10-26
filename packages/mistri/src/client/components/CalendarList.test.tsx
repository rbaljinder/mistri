/**
 * The calendar list, drawn and driven: the month asked with the list's own
 * question, records on their days, a record opened like a board card, and a
 * phone's agenda.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppCalendarList } from '../../../../engine/src/shared/listPresentations.js';
import { dragOnto, pressToDrag } from '../../../../kit/src/client/components/dragTesting.js';
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  apply: vi.fn(),
  toast: vi.fn(),
  phone: false,
  found: undefined as TableMeta | undefined,
  inApp: false,
  rooms: [] as Array<{ kind: string; table: string; error?: string }>,
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
const blackout: TableMeta = {
  id: 'blackout',
  name: 'blackout',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'starts_on', type: 'DATE', nullable: false, primaryKey: false },
    { name: 'ends_on', type: 'DATE', nullable: false, primaryKey: false },
  ],
};
const employee: TableMeta = {
  id: 'employee',
  name: 'employee',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  primaryKey,
  findTable: (id?: string) => (id === 'employee' ? employee : id === 'blackout' ? blackout : (mocks.found ?? table)),
  toast: mocks.toast,
  writeAllowed: () => true,
  refsFrom: () => [{ from: { table: 'leave', columns: ['employee_id'] }, to: { table: 'employee', columns: ['id'] } }],
  columnLabel: (_table: string, column: string) => (column === 'ends' ? 'Last day' : null),
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../appState.js', () => ({ activeApp: () => (mocks.inApp ? {} : null), inAppMode: () => mocks.inApp }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/components/appRooms.js', () => ({
  appRooms: () => mocks.rooms,
  isListRoom: (room: { kind: string }) => room.kind === 'list',
}));
vi.mock('../../../../kit/src/client/requestIdentity.js', () => ({ ownedBy: () => ({}) }));
vi.mock('../../../../kit/src/client/clauses.js', () => ({ splitQuery: (text: string) => ({ filter: text.replace(/\s*sort .*$/, '') }) }));
vi.mock('../../../../kit/src/client/components/useMediaQuery.js', () => ({
  PHONE_QUERY: '(max-width: 600px)',
  useMediaQuery: () => mocks.phone,
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({ sessionIdentity: () => ({ epoch: 1 }) }));
vi.mock('../../../../kit/src/client/bulkActions.js', () => ({
  applyBulk: mocks.apply,
  bulkKey: (_t: TableMeta, key: Record<string, unknown>) => JSON.stringify(key),
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ col, value }: { col: { name: string }; value: unknown }) => <span data-column={col.name}>{String(value)}</span>,
}));
const { CalendarList } = await import('./CalendarList.js');
const { canShowCalendar } = await import('../../../../kit/src/client/components/presentationFit.js');
const spec: AppCalendarList = { kind: 'calendar', date: 'due_on', primary: 'subject', lines: ['status'] };
const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const month = (offset = 0) => {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const rows = [
  { id: 1, subject: 'Call Stonebridge', status: 'open', due_on: `${month()}-03` },
  { id: 2, subject: 'Send the renewal', status: 'open', due_on: `${month()}-03` },
  { id: 3, subject: 'Quarterly review', status: 'done', due_on: `${month()}-18` },
];
function draw(interactive = true, drawn: AppCalendarList = spec) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CalendarList
        table={table}
        spec={drawn}
        entry={{ kind: 'table', table: 'task', query: 'status = open sort due_on' }}
        interactive={interactive}
        label="Task calendar"
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.api.mockReset();
  mocks.open.mockReset();
  mocks.phone = false;
  mocks.apply.mockReset();
  mocks.toast.mockReset();
  mocks.found = undefined;
  mocks.inApp = false;
  mocks.rooms = [];
  mocks.state.connections = [{ id: 'crm', writable: true }];
  mocks.apply.mockImplementation(async () => ({ outcomes: [{ kind: 'applied', message: '' }] }));
  mocks.api.mockImplementation(async () => ({ rows, columns: ['id', 'due_on', 'subject', 'status'] }));
});
afterEach(cleanup);

test("the month is asked with the list's own question, and records land on their days", async () => {
  draw();
  const card = await screen.findByRole('button', { name: /Call Stonebridge/ });
  const q = String(mocks.api.mock.calls[0][1].q);
  expect(q).toMatch(/^task /);
  expect(q).toContain('status = open');
  expect(q).toContain(`due_on >= ${month()}-01`);
  expect(q).toContain(`due_on < ${month(1)}-01`);
  expect(q).toMatch(/sort due_on show /);
  // Two on the 3rd, one on the 18th: each card in its own day's cell.
  const third = card.closest('td')!;
  expect(within(third).getByRole('button', { name: /Send the renewal/ })).toBeInTheDocument();
  expect(within(third).getAllByText('open', { selector: '.calendar-card-line span' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: /Quarterly review/ }).closest('td')).not.toBe(third);
});

test("a title that is a reference is asked for its record's name and says it, not its key", async () => {
  mocks.api.mockImplementation(async () => ({
    rows: [{ id: 1, employee_id: 4, 'employee_id.name': 'Ana Diaz', due_on: `${month()}-05` }],
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CalendarList
        table={{ ...table, columns: [...table.columns, { name: 'employee_id', type: 'INTEGER', nullable: true, primaryKey: false }] }}
        spec={{ kind: 'calendar', date: 'due_on', primary: 'employee_id' }}
        referenceLabels={{ employee_id: 'employee_id.name' }}
        entry={{ kind: 'table', table: 'task', query: '' }}
        label="Leave"
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('button', { name: /Ana Diaz/ })).toBeInTheDocument();
  expect(String(mocks.api.mock.calls[0][1].q)).toMatch(/show .*employee_id\.name/);
});

test('a record opens the way a board card does, with the month as its records', async () => {
  draw();
  await userEvent.setup().click(await screen.findByRole('button', { name: /Quarterly review/ }));
  expect(mocks.open).toHaveBeenCalledWith('task', { id: 3 }, 'Quarterly review', 'push', {
    records: [
      { key: { id: 1 }, label: 'Call Stonebridge' },
      { key: { id: 2 }, label: 'Send the renewal' },
      { key: { id: 3 }, label: 'Quarterly review' },
    ],
  });
});

test('the next month is its own question', async () => {
  draw();
  await screen.findByRole('button', { name: /Call Stonebridge/ });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next month' }));
  await vi.waitFor(() => expect(String(mocks.api.mock.calls.at(-1)![1].q)).toContain(`due_on >= ${month(1)}-01`));
});

test('a phone reads the month as an agenda of the days that have records', async () => {
  mocks.phone = true;
  draw();
  await screen.findByRole('button', { name: /Call Stonebridge/ });
  expect(document.querySelector('.calendar-grid')).toBeNull();
  expect(document.querySelectorAll('.calendar-agenda > li')).toHaveLength(2);
});

test('a busy day shows three and says how many more, one press from the rest', async () => {
  mocks.api.mockImplementation(async () => ({
    rows: [1, 2, 3, 4, 5].map((id) => ({ id, subject: `Task ${id}`, status: 'open', due_on: `${month()}-09` })),
  }));
  draw();
  const more = await screen.findByRole('button', { name: /^2 more on / });
  const day = more.closest('td')!;
  expect(within(day).getAllByRole('button', { name: /^Task / })).toHaveLength(3);
  await userEvent.setup().click(more);
  expect(within(day).getAllByRole('button', { name: /^Task / })).toHaveLength(5);
  expect(within(day).queryByRole('button', { name: /more on/ })).toBeNull();
});

test('Alt and an arrow key move a record a day or a week, through the ordinary update', async () => {
  draw();
  const user = userEvent.setup();
  const card = await screen.findByRole('button', { name: /Quarterly review/ });
  expect(card).toHaveAttribute('data-draggable', 'true');
  card.focus();
  // A bare arrow is not a move.
  await user.keyboard('{ArrowRight}');
  expect(mocks.apply).not.toHaveBeenCalled();
  await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/^Moved “Quarterly review” to /), 'ok'));
  expect(mocks.apply).toHaveBeenLastCalledWith(
    { connection: 'crm', table: 'task' },
    { due_on: `${month()}-19` },
    [{ key: { id: 3 }, label: 'Quarterly review', expected: { due_on: `${month()}-18` } }],
    expect.any(Function),
  );
  // This fixture's server keeps no date: read again, the record is back on the 18th, where the next move starts.
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: /Quarterly review/ }).closest('td')).toHaveAttribute('data-date', `${month()}-18`),
  );
  const again = screen.getByRole('button', { name: /Quarterly review/ });
  expect(again).not.toHaveClass('is-moving');
  again.focus();
  await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
  await vi.waitFor(() =>
    expect(mocks.apply).toHaveBeenLastCalledWith(expect.anything(), { due_on: `${month()}-11` }, expect.anything(), expect.anything()),
  );
});

test('a record dropped on another day is due that day', async () => {
  draw();
  const card = await screen.findByRole('button', { name: /Quarterly review/ });
  const third = screen.getByRole('button', { name: /Call Stonebridge/ }).closest('td')!;
  const drag = pressToDrag(card);
  drag.over(third);
  expect(third).toHaveClass('is-over');
  drag.drop();
  expect(third).not.toHaveClass('is-over');
  await vi.waitFor(() =>
    expect(mocks.apply).toHaveBeenCalledWith(
      { connection: 'crm', table: 'task' },
      { due_on: `${month()}-03` },
      [{ key: { id: 3 }, label: 'Quarterly review', expected: { due_on: `${month()}-18` } }],
      expect.any(Function),
    ),
  );
});

test('on a phone a record is dropped on another day of the agenda; Escape keeps its day', async () => {
  mocks.phone = true;
  draw();
  const card = await screen.findByRole('button', { name: /Quarterly review/ });
  const third = screen.getByRole('button', { name: /Call Stonebridge/ }).closest<HTMLElement>('li[data-date]')!;
  const kept = pressToDrag(card);
  kept.over(third);
  expect(third).toHaveClass('is-over');
  kept.cancel();
  expect(third).not.toHaveClass('is-over');
  expect(mocks.apply).not.toHaveBeenCalled();
  dragOnto(card, third);
  await vi.waitFor(() =>
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), { due_on: `${month()}-03` }, expect.anything(), expect.anything()),
  );
});

test('a date that moves only through actions, or a connection that cannot write, offers no move', async () => {
  mocks.found = {
    ...table,
    columns: table.columns.map((column) => (column.name === 'due_on' ? { ...column, changesBy: 'actions' as const } : column)),
  };
  draw();
  const card = await screen.findByRole('button', { name: /Quarterly review/ });
  expect(card).not.toHaveAttribute('data-draggable');
  card.focus();
  await userEvent.setup().keyboard('{Alt>}{ArrowRight}{/Alt}');
  cleanup();
  mocks.found = undefined;
  mocks.state.connections = [{ id: 'crm', writable: false }];
  draw();
  expect(await screen.findByRole('button', { name: /Quarterly review/ })).not.toHaveAttribute('data-draggable');
  expect(mocks.apply).not.toHaveBeenCalled();
});

test('a table without a key is not drawn as a calendar', () => {
  expect(canShowCalendar(table, spec)).toBe(true);
  expect(canShowCalendar({ ...table, columns: table.columns.map((column) => ({ ...column, primaryKey: false })) }, spec)).toBe(false);
});

/* A range: a leave from its first day to its last, drawn across the days. */
const leave: TableMeta = {
  id: 'leave',
  name: 'leave',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'employee_id', type: 'INTEGER', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'starts', type: 'DATE', nullable: false, primaryKey: false },
    { name: 'ends', type: 'DATE', nullable: false, primaryKey: false },
  ],
};
const ranged: AppCalendarList = { kind: 'calendar', date: 'starts', end: 'ends', primary: 'employee_id.name', badge: 'status' };
/* Mondays of the month's grid rows: offset 1 is the second row, always inside the month. */
const mondayOf = (offset: number) => {
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * offset);
  return d;
};
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (d: Date, days: number) => {
  const out = new Date(d);
  out.setDate(d.getDate() + days);
  return out;
};
function drawLeave(rows: Array<Record<string, unknown>>) {
  mocks.found = leave;
  mocks.api.mockImplementation(async () => ({ rows }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CalendarList table={leave} spec={ranged} entry={{ kind: 'table', table: 'leave', query: 'sort starts' }} label="Who is out" />
    </QueryClientProvider>,
  );
}

test('a range is asked for the month it overlaps, and drawn as one bar per week it crosses', async () => {
  const wednesday = plus(mondayOf(1), 2);
  const tuesday = plus(mondayOf(2), 1);
  drawLeave([{ id: 1, 'employee_id.name': 'Jordan Brooks', status: 'approved', starts: isoOf(wednesday), ends: isoOf(tuesday) }]);
  const bars = await screen.findAllByRole('button', { name: /Jordan Brooks/ });
  const q = String(mocks.api.mock.calls[0][1].q);
  expect(q).toContain(`starts < ${month(1)}-01 and (ends >= ${month()}-01 or starts >= ${month()}-01)`);
  expect(q).toMatch(/show .*employee_id\.name/);
  // Wednesday to Sunday on one row, Monday and Tuesday on the next.
  expect(bars).toHaveLength(2);
  expect(bars[0]).toHaveClass('is-span', 'runs-after');
  expect(bars[0].style.getPropertyValue('--calendar-span')).toBe('5');
  expect(bars[1]).toHaveClass('is-span', 'runs-before');
  expect(bars[1].style.getPropertyValue('--calendar-span')).toBe('2');
  expect(bars[0].closest('td')).toHaveAttribute('data-date', isoOf(wednesday));
  // The days it runs through hold its lane, unseen by assistive tech.
  expect(document.querySelectorAll('.calendar-slot[aria-hidden="true"]')).toHaveLength(4 + 1);
  expect(within(bars[0]).getByText('approved', { selector: '[data-column="status"]' })).toBeInTheDocument();
  // In a day's cell the status is a dot before the name, its word kept for a reader and a hover; no line of its own.
  const mark = bars[0].querySelector('.calendar-card-title > .calendar-card-mark');
  expect(mark).toHaveAttribute('title', 'approved');
  expect(bars[0]).not.toHaveClass('has-line');
  expect(bars[0]).toHaveAccessibleName(/^approved\s*:\s*Jordan Brooks/);
});

test('a range moves whole: Alt and an arrow shift its first and last day together', async () => {
  const monday = mondayOf(1);
  drawLeave([{ id: 1, 'employee_id.name': 'Quinn Davis', status: 'pending', starts: isoOf(monday), ends: isoOf(plus(monday, 2)) }]);
  const bar = await screen.findByRole('button', { name: /Quinn Davis/ });
  bar.focus();
  await userEvent.setup().keyboard('{Alt>}{ArrowDown}{/Alt}');
  await vi.waitFor(() =>
    expect(mocks.apply).toHaveBeenCalledWith(
      { connection: 'crm', table: 'leave' },
      { starts: isoOf(plus(monday, 7)), ends: isoOf(plus(monday, 9)) },
      [{ key: { id: 1 }, label: 'Quinn Davis', expected: { starts: isoOf(monday), ends: isoOf(plus(monday, 2)) } }],
      expect.any(Function),
    ),
  );
});

test('on a phone a range is listed once, under its first day, with its dates', async () => {
  mocks.phone = true;
  const monday = mondayOf(1);
  drawLeave([{ id: 1, 'employee_id.name': 'Riley Chen', status: 'approved', starts: isoOf(monday), ends: isoOf(plus(monday, 4)) }]);
  const bar = await screen.findByRole('button', { name: /Riley Chen/ });
  expect(screen.getAllByRole('button', { name: /Riley Chen/ })).toHaveLength(1);
  expect(document.querySelectorAll('.calendar-agenda > li')).toHaveLength(1);
  expect(bar.querySelectorAll('.calendar-card-detail')).toHaveLength(1);
});

test('the month is one Tab stop: arrows move by day and week, Home and End to the week, Page Up and Down by month', async () => {
  draw();
  const user = userEvent.setup();
  const grid = await screen.findByRole('grid');
  await screen.findByRole('button', { name: /Quarterly review/ });
  const stops = [...grid.querySelectorAll('[tabindex="0"]')];
  // One day holds the Tab stop, and no card is a stop of its own.
  expect(stops).toHaveLength(1);
  expect(stops[0].tagName).toBe('TD');
  for (const card of grid.querySelectorAll('.calendar-card')) expect(card).toHaveAttribute('tabindex', '-1');
  const day = (date: string) => grid.querySelector<HTMLElement>(`td[data-date="${date}"]`)!;
  const focused = () => (document.activeElement as HTMLElement).dataset.date!;
  day(`${month()}-10`).focus();
  await user.keyboard('{ArrowRight}');
  expect(day(`${month()}-11`)).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(day(`${month()}-18`)).toHaveFocus();
  expect(day(`${month()}-18`)).toHaveAttribute('tabindex', '0');
  expect(day(`${month()}-10`)).toHaveAttribute('tabindex', '-1');
  await user.keyboard('{ArrowUp}{ArrowLeft}');
  expect(day(`${month()}-10`)).toHaveFocus();
  await user.keyboard('{Home}');
  expect(new Date(`${focused()}T00:00:00`).getDay()).toBe(1);
  await user.keyboard('{End}');
  expect(new Date(`${focused()}T00:00:00`).getDay()).toBe(0);
  day(`${month()}-18`).focus();
  await user.keyboard('{PageDown}');
  // The month turns with the focus, onto the same day of the next one.
  await vi.waitFor(() => expect(focused()).toBe(`${month(1)}-18`));
  await user.keyboard('{PageUp}');
  await vi.waitFor(() => expect(focused()).toBe(`${month()}-18`));
});

test('Enter goes into a day, Up and Down step through it, Escape comes back to the day', async () => {
  draw();
  const user = userEvent.setup();
  const grid = await screen.findByRole('grid');
  await screen.findByRole('button', { name: /Call Stonebridge/ });
  const day = grid.querySelector<HTMLElement>(`td[data-date="${month()}-03"]`)!;
  day.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: /Call Stonebridge/ })).toHaveFocus();
  expect(mocks.open).not.toHaveBeenCalled();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('button', { name: /Send the renewal/ })).toHaveFocus();
  // The day keeps the grid's Tab stop while the focus is inside it.
  expect(day).toHaveAttribute('tabindex', '0');
  await user.keyboard('{Enter}');
  expect(mocks.open).toHaveBeenCalledWith('task', { id: 2 }, 'Send the renewal', 'push', expect.anything());
  await user.keyboard('{Escape}');
  expect(day).toHaveFocus();
  // An empty day has nothing to go into; Enter leaves the focus where it is.
  const empty = grid.querySelector<HTMLElement>(`td[data-date="${month()}-05"]`)!;
  empty.focus();
  await user.keyboard('{Enter}');
  expect(empty).toHaveFocus();
});

const freeze = { from: 'blackout', start: 'starts_on', end: 'ends_on', labelColumn: 'name', tone: 'warn' as const };
const spans = [{ id: 9, name: 'Year-end freeze', starts_on: `${month()}-10`, ends_on: `${month()}-12` }];
function answerSpans() {
  mocks.api.mockImplementation(async (_path: string, body: { q: string }) =>
    body.q.startsWith('blackout')
      ? { rows: spans, columns: ['id', 'starts_on', 'ends_on', 'name'] }
      : { rows, columns: ['id', 'due_on', 'subject', 'status'] },
  );
}

test('a backdrop shades the days its spans cover, asked for the month on show, and names each where it starts', async () => {
  answerSpans();
  draw(true, { ...spec, backdrop: [freeze] });
  // Named where it starts, and again on a week's first day should the span run into the next week.
  const [label] = await screen.findAllByRole('button', { name: 'Year-end freeze' });
  const asked = mocks.api.mock.calls.map(([, body]) => (body as { q: string }).q).find((q) => q.startsWith('blackout'));
  expect(asked).toMatch(
    /^blackout starts_on < \d{4}-\d\d-\d\d and ends_on >= \d{4}-\d\d-\d\d sort starts_on show id, starts_on, ends_on, name$/,
  );
  const cell = (day: string) => document.querySelector<HTMLElement>(`td[data-date="${month()}-${day}"]`)!;
  expect(['10', '11', '12'].map((day) => cell(day).dataset.backdrop)).toEqual(['warn', 'warn', 'warn']);
  expect(cell('09').dataset.backdrop).toBeUndefined();
  expect(cell('13').dataset.backdrop).toBeUndefined();
  expect(label.closest('td')).toBe(cell('10'));
  expect(label.dataset.tone).toBe('warn');
  // The records still sit on their days, in front of it.
  expect(await screen.findByRole('button', { name: /Call Stonebridge/ })).toBeTruthy();
  await userEvent.setup().click(label);
  expect(mocks.open).toHaveBeenCalledWith('blackout', { id: 9 }, 'Year-end freeze', 'push');
});

test('a span opens its record only where the App has a view of its table, and is plain words otherwise', async () => {
  answerSpans();
  mocks.inApp = true;
  draw(true, { ...spec, backdrop: [freeze] });
  const [words] = await screen.findAllByText('Year-end freeze');
  expect(words.tagName).toBe('SPAN');
  expect(screen.queryByRole('button', { name: 'Year-end freeze' })).toBeNull();
  cleanup();
  mocks.rooms = [{ kind: 'list', table: 'blackout' }];
  draw(true, { ...spec, backdrop: [freeze] });
  expect((await screen.findAllByRole('button', { name: 'Year-end freeze' })).length).toBeGreaterThan(0);
});

test("a phone's agenda says a span on the day it starts, with its days, before that day's records", async () => {
  answerSpans();
  mocks.phone = true;
  draw(true, { ...spec, backdrop: [freeze] });
  const said = await screen.findByRole('button', { name: /^Year-end freeze, / });
  expect(said.closest('.calendar-agenda-backdrops')).toBeTruthy();
  expect(said.closest('li')?.querySelector('.calendar-agenda-day')).toBeTruthy();
});

test('a calendar with no backdrop asks for nothing more', async () => {
  draw();
  await screen.findByRole('button', { name: /Call Stonebridge/ });
  expect(mocks.api.mock.calls.every(([, body]) => !(body as { q: string }).q.startsWith('blackout'))).toBe(true);
  expect(document.querySelector('[data-backdrop], .calendar-backdrop')).toBeNull();
});

test("a line that is a reference draws the referenced record's name, not its key", async () => {
  mocks.found = { ...table, columns: [...table.columns, { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false }] };
  mocks.api.mockImplementation(async () => ({
    rows: [{ id: 1, subject: 'Tune-up', status: 'open', owner_id: 18, 'owner_id.name': 'Trek FX 3', due_on: `${month()}-03` }],
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CalendarList
        table={mocks.found}
        spec={{ ...spec, lines: ['owner_id'] }}
        entry={{ kind: 'table', table: 'task', query: '' }}
        referenceLabels={{ owner_id: 'owner_id.name' }}
      />
    </QueryClientProvider>,
  );
  const card = await screen.findByRole('button', { name: /Tune-up/ });
  expect(within(card).getByText('Trek FX 3')).toBeInTheDocument();
  expect(within(card).queryByText('18')).toBeNull();
});
