/**
 * The explorer's table room, re-asked in place.
 *
 * The real walk, the real room, the real pager and the real grid, with only
 * the server stood in for. A page, a page size and a header's sort re-ask
 * the room's Query rather than starting the room over, so the grid is the
 * same element throughout, the previous rows stay on screen while the next
 * are fetched, and a decoration in a row keeps its own state for as long as
 * its row is in the result. Another table, or any other paint, is another
 * room.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

type Row = Record<string, unknown>;
const asked: Array<{ path: string } & Record<string, unknown>> = [];
let hold: Promise<void> | null = null;
let emptyAnswer: 'none' | 'empty' | 'error' = 'none';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const invoice = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('parity', 'INTEGER'), col('memo', 'TEXT')],
} as unknown as TableMeta;
const line = {
  id: 'invoice_line',
  name: 'invoice_line',
  schema: '',
  isView: false,
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('invoice_id', 'INTEGER', { references: { table: 'invoice', column: 'id' } }),
  ],
} as unknown as TableMeta;
const customer = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')],
} as unknown as TableMeta;
const schema = {
  tables: [invoice, line, customer],
  foreignKeys: [
    { name: 'line_invoice', from: { table: 'invoice_line', columns: ['invoice_id'] }, to: { table: 'invoice', columns: ['id'] } },
  ],
};
/* Sorted by parity, the evens come first: the first page of that sort keeps
   2, 4, 6, 8 and 10 from the first page of the table, and drops the rest. */
const invoices: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, parity: (i + 1) % 2, memo: `invoice ${i + 1}` }));

async function answer(path: string, body: Record<string, unknown>) {
  asked.push({ path, ...body });
  if (hold) await hold;
  if (path === '/api/query') return { columns: ['id', 'invoice_id'], rows: [{ id: 900, invoice_id: 1 }] };
  if (path === '/api/count') return { count: 1, exact: true };
  if (emptyAnswer === 'error') return { errors: [{ message: 'Invalid query.' }] };
  const q = String(body.q);
  const table = q.split(' ')[0];
  const source = table === 'customer' ? [{ id: 1, name: 'Ada' }] : invoices;
  const sort = /sort (\w+)( desc)?/.exec(q);
  const rows = sort
    ? [...source].sort((a, b) => (Number(a[sort[1]]) - Number(b[sort[1]])) * (sort[2] ? -1 : 1) || Number(a.id) - Number(b.id))
    : source;
  const offset = Number(body.offset);
  const limit = Number(body.limit);
  /* Unsorted, the list is in its key's order and pages by key as the server's does: after a row, before one, or from the end. */
  const id = (row: Row) => Number(row.id);
  const after = body.after as Row | undefined,
    before = body.before as Row | undefined;
  const page = sort
    ? rows.slice(offset, offset + limit)
    : after
      ? rows.filter((row) => id(row) > Number(after.id)).slice(0, limit)
      : before
        ? rows.filter((row) => id(row) < Number(before.id)).slice(-limit)
        : body.end
          ? rows.slice(-limit)
          : rows.slice(offset, offset + limit);
  const shown = emptyAnswer === 'empty' ? [] : page;
  const bounds = !sort && shown.length ? { first: { id: shown[0].id }, last: { id: shown.at(-1)!.id } } : undefined;
  return {
    table,
    columns: Object.keys(source[0]),
    rows: shown,
    ...(bounds ? { bounds } : {}),
    total: emptyAnswer === 'empty' ? 0 : source.length,
    exactTotal: true,
    ms: 1,
    errors: [],
    limit,
    offset,
  };
}

vi.mock('../../../../kit/src/client/core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../kit/src/client/core.js')>()),
  api: (path: string, body: Record<string, unknown>) => answer(path, body),
  showErrors: () => {},
  setExplain: () => {},
}));
vi.mock('../appState.js', () => ({ activeApp: () => null, appLoadError: () => '', inAppMode: () => false }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/dashboard.js', () => ({ dashboardEntry: () => null }));
vi.mock('../../../../kit/src/client/url.js', () => ({ syncHash: () => {} }));
vi.mock('../../../../kit/src/client/history.js', () => ({ recordQuery: () => {} }));
vi.mock('../../../../kit/src/client/filterbar.js', () => ({ deriveFilterNames: () => [], copyListView: () => {} }));
vi.mock('../../../../kit/src/client/page.js', () => ({ pagesFor: async () => [] }));
vi.mock('../../../../kit/src/client/connectionScope.js', () => ({ canUseDatabaseTools: () => true }));
vi.mock('./AppLanding.js', () => ({ AppLanding: () => null }));
vi.mock('../../../../kit/src/client/components/appListModel.js', () => ({ appListFor: () => null, appListQuery: () => '' }));
vi.mock('../../../../kit/src/client/components/BreakdownRoom.js', () => ({ BreakdownRoom: () => null }));
vi.mock('../../../../kit/src/client/components/Crumbs.js', () => ({ Crumbs: () => null }));
vi.mock('../../../../kit/src/client/components/dashboardModel.js', () => ({}));
vi.mock('../../../../kit/src/client/components/Landing.js', () => ({
  AppHomeLanding: () => null,
  LoadErrorNote: () => null,
  WorkbenchLanding: () => null,
}));
vi.mock('../../../../kit/src/client/components/PageRoom.js', () => ({ PageRoom: () => null }));
vi.mock('../../../../kit/src/client/components/Rooms.js', () => ({
  AppListRoom: () => null,
  DashboardRoom: () => null,
  RowRoom: () => null,
}));
vi.mock('../../../../kit/src/client/components/SavedViews.js', () => ({ SavedViewsSection: () => null }));
vi.mock('../../../../kit/src/client/components/Diagram.js', () => ({ NeighbourhoodDiagram: () => null }));
vi.mock('../../../../kit/src/client/components/FilterBoxes.js', () => ({ FilterBar: () => null }));
vi.mock('../../../../kit/src/client/components/NewRecordButton.js', () => ({ NewRowButton: () => null }));
vi.mock('../../../../kit/src/client/components/Export.js', () => ({ ExportControl: () => null }));
vi.mock('../../../../kit/src/client/components/RecordSummaries.js', () => ({ RecordSummaries: () => null }));
/* The listbox stood in by a native one: what is under test is what the
   pager does with a size, not how the size is chosen. */
vi.mock('../../../../kit/src/client/components/Dropdown.js', () => ({
  Dropdown: ({
    ariaLabel,
    value,
    items,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    items: Array<{ value: string; label: string }>;
    onChange: (v: string) => void;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

const core = await import('../../../../kit/src/client/core.js');
const { queryClient } = await import('../../../../kit/src/client/components/mount.js');
const { Content } = await import('../../../../kit/src/client/components/Content.js');
const { TableRoom } = await import('../../../../kit/src/client/components/TableRoom.js');
const { RowDecoration, RowHosts, useRowHosts } = await import('../../../../kit/src/client/components/RowHost.js');

const keyFor = (id: number) => JSON.stringify([['id', String(id)]]);
const rowOf = (id: number) => document.querySelector<HTMLTableRowElement>(`tbody tr[data-row-key='${keyFor(id)}']`);
const gridTable = () => document.querySelector('.result-table table');
const tallyOf = (id: number) => rowOf(id)?.querySelector<HTMLButtonElement>('td.row-host button.tally') ?? null;
const expanderOf = (id: number) => rowOf(id)?.querySelector<HTMLButtonElement>('td.row-host button.expander') ?? null;
const shownIds = () =>
  [...document.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row-key]')].map((tr) => JSON.parse(tr.dataset.rowKey!)[0][1]);

/** A decoration with a state of its own: how many times it was pressed. */
function Tally({ name }: { name: string }) {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      className="tally"
      aria-label={`Tally ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        setCount(count + 1);
      }}
    >
      {count}
    </button>
  );
}
function Tallies() {
  return (
    <>
      {[...useRowHosts().keys()].map((key) => (
        <RowDecoration key={key} rowKey={key}>
          <Tally name={key} />
        </RowDecoration>
      ))}
    </>
  );
}

async function draw() {
  render(
    <QueryClientProvider client={queryClient}>
      <RowHosts>
        <Content onHome={() => {}} />
        <Tallies />
      </RowHosts>
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(rowOf(1)).not.toBeNull());
}

/** Answers held until released: the in-between, where the previous page is still on screen. */
function holding(): () => Promise<void> {
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    hold = null;
    await act(async () => {
      release();
    });
  };
}

afterEach(() => cleanup());

beforeEach(() => {
  queryClient.clear();
  asked.length = 0;
  hold = null;
  emptyAnswer = 'none';
  core.setPageSize(10);
  core.state.activeConnection = 'demo';
  core.state.schema = schema;
  core.state.stack = [core.tableView('invoice')];
  core.state.page = 0;
  core.render();
});

describe('a sort from the header', () => {
  test('keeps the grid, and a decoration’s state on every row still on the page', async () => {
    const user = userEvent.setup();
    await draw();
    const table = gridTable();
    await user.click(tallyOf(2)!);
    await user.click(tallyOf(1)!);
    expect(tallyOf(2)).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: 'parity' }));
    expect(core.currentEntry()).toMatchObject({ query: 'invoice sort parity' });
    await vi.waitFor(() => expect(rowOf(20)).not.toBeNull());
    expect(shownIds()).toEqual(['2', '4', '6', '8', '10', '12', '14', '16', '18', '20']);
    expect(gridTable()).toBe(table);
    expect(tallyOf(2)).toHaveTextContent('1');
    expect(tallyOf(4)).toHaveTextContent('0');
    // Row 1 left the page, and its decoration with it.
    expect(rowOf(1)).toBeNull();
  });

  test('keeps an open row open, with its detail under it and the same expander', async () => {
    const user = userEvent.setup();
    await draw();
    const expander = expanderOf(4)!;
    await user.click(expander);
    const detail = await screen.findByText('invoice_line');
    expect(rowOf(4)!.nextElementSibling).toHaveClass('detail-row');

    await user.click(screen.getByRole('button', { name: 'parity' }));
    await vi.waitFor(() => expect(rowOf(20)).not.toBeNull());
    expect(expanderOf(4)).toBe(expander);
    expect(expander).toHaveAttribute('aria-expanded', 'true');
    expect(rowOf(4)!.nextElementSibling).toHaveClass('detail-row');
    // Its answer is refreshed where it stands, not pulled from under it.
    expect(screen.getByText('invoice_line')).toBe(detail);
    expect(within(rowOf(4)!.nextElementSibling as HTMLElement).queryByText('Looking…')).toBeNull();
  });
});

describe('paging', () => {
  test('a bigger page keeps the decorations on the rows it still holds', async () => {
    const user = userEvent.setup();
    await draw();
    const table = gridTable();
    await user.click(tallyOf(7)!);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rows per page' }), '20');
    await vi.waitFor(() => expect(rowOf(20)).not.toBeNull());
    expect(gridTable()).toBe(table);
    expect(tallyOf(7)).toHaveTextContent('1');
  });

  test('the previous page stays on screen while the next is fetched, then gives way in place', async () => {
    const user = userEvent.setup();
    await draw();
    const table = gridTable();
    const release = holding();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    // The rows, the head and the grid are the first page's; the pager says where it is going.
    expect(rowOf(1)).not.toBeNull();
    expect(screen.getByText('rows 1–10 of 25')).toBeInTheDocument();
    expect(document.querySelector('.result-table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(2);
    expect(screen.queryByRole('status', { name: 'Loading rows' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveFocus();

    await release();
    await vi.waitFor(() => expect(rowOf(11)).not.toBeNull());
    expect(rowOf(1)).toBeNull();
    expect(screen.getByText('rows 11–20 of 25')).toBeInTheDocument();
    expect(document.querySelector('.result-table')).not.toHaveAttribute('aria-busy');
    expect(gridTable()).toBe(table);
    // Row numbers for the keyboard are the page's own.
    expect(rowOf(11)).toHaveAttribute('aria-rowindex', '12');

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await vi.waitFor(() => expect(rowOf(1)).not.toBeNull());
    expect(gridTable()).toBe(table);
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(1);
    expect(asked.filter((a) => a.path === '/api/run').map((a) => a.offset)).toEqual([0, 10, 0]);
  });

  test('Next, Previous and Last step by key from the rows on screen; a typed page is an offset', async () => {
    const user = userEvent.setup();
    await draw();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await vi.waitFor(() => expect(rowOf(11)).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await vi.waitFor(() => expect(rowOf(21)).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await vi.waitFor(() => expect(rowOf(11)).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await vi.waitFor(() => expect(rowOf(1)).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Last page' }));
    await vi.waitFor(() => expect(rowOf(25)).not.toBeNull());
    expect(shownIds()).toEqual(['21', '22', '23', '24', '25']);
    const box = screen.getByRole('spinbutton', { name: 'Page number' });
    await user.clear(box);
    await user.type(box, '2');
    await vi.waitFor(() => expect(rowOf(11)).not.toBeNull());
    const runs = asked
      .filter((a) => a.path === '/api/run')
      .map(({ offset, limit, after, before, end }) => ({
        offset,
        limit,
        ...(after ? { after } : {}),
        ...(before ? { before } : {}),
        ...(end ? { end } : {}),
      }));
    expect(runs).toEqual([
      { offset: 0, limit: 10 },
      { offset: 10, limit: 10, after: { id: 10 } },
      { offset: 20, limit: 10, after: { id: 20 } },
      { offset: 10, limit: 10, before: { id: 21 } },
      // The first page is its own: read from the top, not before a row.
      { offset: 0, limit: 10 },
      { offset: 20, limit: 5, end: true },
      { offset: 10, limit: 10 },
    ]);
  });

  test('a new page is read from its top; a sort keeps the reader where they are', async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    const into = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      await draw();
      await user.click(screen.getByRole('button', { name: 'parity' }));
      await vi.waitFor(() => expect(rowOf(20)).not.toBeNull());
      expect(scrolled.filter((el) => el.classList.contains('result-head'))).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Next page' }));
      await vi.waitFor(() => expect(rowOf(1)).not.toBeNull());
      expect(scrolled.filter((el) => el.classList.contains('result-head'))).toHaveLength(1);
    } finally {
      into.mockRestore();
    }
  });

  test('the page box follows the page, and an emptied box waits for a number', async () => {
    const user = userEvent.setup();
    await draw();
    const box = screen.getByRole('spinbutton', { name: 'Page number' });
    await user.clear(box);
    expect(core.state.page).toBe(0);
    await user.type(box, '3');
    await vi.waitFor(() => expect(rowOf(21)).not.toBeNull());
    expect(box).toHaveValue(3);
    expect(box).toHaveFocus();
  });
});

describe('what still starts the room over', () => {
  test('another table: a new grid, and decorations from nothing', async () => {
    const user = userEvent.setup();
    await draw();
    const table = gridTable();
    await user.click(tallyOf(1)!);
    act(() => core.refine(() => core.go(core.tableView('customer'), 'replace')));
    await vi.waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(gridTable()).not.toBe(table);
    expect(tallyOf(1)).toHaveTextContent('0');
  });

  test('a plain paint — the one a write sends — re-asks from a new room', async () => {
    const user = userEvent.setup();
    await draw();
    const table = gridTable();
    await user.click(tallyOf(1)!);
    act(() => core.render());
    await vi.waitFor(() => expect(rowOf(1)).not.toBeNull());
    expect(gridTable()).not.toBe(table);
    expect(tallyOf(1)).toHaveTextContent('0');
    expect(asked.filter((a) => a.path === '/api/run')).toHaveLength(2);
  });
});

test('authored empty guidance waits for a successful result, not loading', async () => {
  emptyAnswer = 'empty';
  const release = holding();
  render(
    <QueryClientProvider client={queryClient}>
      <TableRoom entry={{ kind: 'table', table: 'invoice', query: 'invoice' }} chrome={false} empty={<p>No invoices yet</p>} />
    </QueryClientProvider>,
  );
  expect(screen.queryByText('No invoices yet')).toBeNull();
  await release();
  expect(await screen.findByText('No invoices yet')).toBeVisible();
});

test('a query failure does not show authored empty guidance', async () => {
  emptyAnswer = 'error';
  render(
    <QueryClientProvider client={queryClient}>
      <TableRoom entry={{ kind: 'table', table: 'invoice', query: 'invoice' }} chrome={false} empty={<p>No invoices yet</p>} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Fix the query above to see results.')).toBeVisible();
  expect(screen.queryByText('No invoices yet')).toBeNull();
});
