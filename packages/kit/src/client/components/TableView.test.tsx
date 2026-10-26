import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const state = { page: 0 };
const mode = { app: false, more: true };
const gone = vi.fn();
const rendered = vi.fn();
const queued = vi.fn();
const entry = { kind: 'table' as const, table: 'invoice', query: 'invoice' };
const summarized = vi.fn();
const tables: Record<string, unknown> = {};

vi.mock('../core.js', () => ({
  PAGE_SIZES: [2, 20],
  state,
  go: gone,
  render: rendered,
  refine: (fn: () => unknown) => fn(),
  pageSize: () => 2,
  setPageSize: vi.fn(),
  currentEntry: () => entry,
  findTable: (id: string) => tables[id],
  prefersPages: () => true,
  beginNavigation: () => () => true,
  pageView: vi.fn(),
  tableView: vi.fn(),
}));
vi.mock('../filterbar.js', () => ({ copyListView: vi.fn() }));
vi.mock('../page.js', () => ({ pagesFor: vi.fn() }));
vi.mock('../thmenu.js', () => ({ sortBy: vi.fn() }));
vi.mock('../connectionScope.js', () => ({ canUseDatabaseTools: () => true }));
// QueueList reads the App's command grants through appnav.js, which would load the write stack.
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => null, inAppMode: () => mode.app }));
vi.mock('./NewRecordButton.js', () => ({ NewRowButton: () => null }));
vi.mock('./Export.js', () => ({ ExportControl: () => null }));
vi.mock('./Grid.js', () => ({ Grid: () => <div data-testid="grid" /> }));
vi.mock('./RecordSummaries.js', () => ({
  // Whether the table says more than the records do is RecordSummaries.test's to judge.
  tableSaysMore: () => mode.more,
  RecordSummaries: (props: unknown) => {
    summarized(props);
    return null;
  },
}));
vi.mock('./Dropdown.js', () => ({ Dropdown: () => null }));
vi.mock('../../../../mistri/src/client/components/QueueList.js', () => ({
  canShowQueue: () => true,
  QueueList: (props: unknown) => {
    queued(props);
    return <div data-testid="queue" />;
  },
}));

const { TableView } = await import('./TableView.js');
const { presentList } = await import('../../../../mistri/src/client/components/presentedList.js');
type Data = import('./TableView.js').TableViewProps['data'];

function draw(over: Partial<Data> = {}, query = entry.query) {
  const data: Data = { table: 'invoice', columns: ['id'], rows: [{ id: 1 }, { id: 2 }], ms: 7, ...over };
  return render(<TableView entry={{ ...entry, query }} data={data} chrome interactive={false} export={false} />);
}

beforeEach(bridgeShell);

afterEach(() => {
  cleanup();
  state.page = 0;
  mode.app = false;
  mode.more = true;
  gone.mockClear();
  rendered.mockClear();
  queued.mockClear();
});

describe('an App list pages quietly', () => {
  const drawApp = (over: Partial<Data> = {}, presentation?: import('./TableView.js').TableViewProps['presentation']) => {
    mode.app = true;
    const data: Data = {
      table: 'invoice',
      columns: ['id', 'subject'],
      rows: [
        { id: 1, subject: 'a' },
        { id: 2, subject: 'b' },
      ],
      ms: 7,
      ...over,
    };
    return render(
      <TableView
        entry={entry}
        data={data}
        chrome={false}
        interactive={false}
        export={false}
        presentation={presentation}
        present={presentList}
      />,
    );
  };

  test('a list that fits one page draws no pager', () => {
    const view = drawApp({ total: 2 });
    expect(view.container.querySelector('.pager')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  test('more than a page says where it is, with Previous and Next and nothing else', () => {
    const view = drawApp({ total: 5 });
    expect(view.container.querySelector('.pager-range')).toHaveTextContent('1–2 of 5');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'First page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Last page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Page number' })).not.toBeInTheDocument();
  });

  test('a queue pages as its grid does, where it drew the first page and no way on', async () => {
    const user = userEvent.setup();
    drawApp({ total: 5 }, { kind: 'queue', primary: 'subject' });
    expect(screen.getByTestId('queue')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(state.page).toBe(1);
  });
});

test('a readonly queue receives record navigation without becoming interactive', () => {
  const data: Data = { table: 'invoice', columns: ['id', 'subject'], rows: [{ id: 1, subject: 'Payroll ready' }], ms: 7 };
  render(
    <TableView
      entry={entry}
      data={data}
      chrome
      interactive={false}
      export={false}
      presentation={{ kind: 'queue', primary: 'subject', openLabel: 'Review payroll' }}
      present={presentList}
      recordNavigation
    />,
  );
  expect(screen.getByTestId('queue')).toBeInTheDocument();
  expect(queued).toHaveBeenCalledWith(
    expect.objectContaining({
      interactive: false,
      recordNavigation: true,
      spec: { kind: 'queue', primary: 'subject', openLabel: 'Review payroll' },
    }),
  );
});

describe('unknown totals', () => {
  test.each([
    { name: 'full first page', page: 0, count: 2, label: '2 rows shown', more: true },
    { name: 'partial first page', page: 0, count: 1, label: '1 row shown', more: false },
    { name: 'empty first page', page: 0, count: 0, label: '0 rows shown', more: false },
    { name: 'full later page', page: 2, count: 2, label: 'rows 5–6 shown', more: true },
    { name: 'partial later page', page: 2, count: 1, label: 'rows 5–5 shown', more: false },
    { name: 'empty later page', page: 2, count: 0, label: '0 rows shown', more: false },
  ])('$name reports only what is shown', ({ page, count, label, more }) => {
    state.page = page;
    draw({ rows: Array.from({ length: count }, (_, id) => ({ id })) });
    expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
    expect(screen.getByText('7 ms')).toBeInTheDocument();
    expect(screen.getByTestId('grid')).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(!more);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(page === 0);
    expect((screen.getByRole('button', { name: 'First page' }) as HTMLButtonElement).disabled).toBe(page === 0);
    expect(screen.getByText(`Page ${page + 1}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Last page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Page number' })).not.toBeInTheDocument();
    expect(document.querySelector('.stat-estimate')).toBeNull();
  });

  test('an estimate flag without a total does not invent an estimate', () => {
    draw({ exactTotal: false });
    expect(screen.getByText('2 rows shown')).toBeInTheDocument();
    expect(document.querySelector('.stat-estimate')).toBeNull();
  });

  test('full pages can advance and later empty pages can return', async () => {
    const user = userEvent.setup();
    const view = draw();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(state.page).toBe(1);
    expect(rendered).toHaveBeenCalledOnce();
    view.unmount();
    draw({ rows: [] });
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(state.page).toBe(0);
    expect(rendered).toHaveBeenCalledTimes(2);
  });

  test('explicit limits still suppress paging', () => {
    draw({}, 'invoice limit 2');
    expect(screen.getByText('2 rows shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });
});

describe('known totals', () => {
  test.each([false, true])('exactTotal=%s preserves the existing count presentation when known', (explicit) => {
    draw({ total: 5, ...(explicit ? { exactTotal: true } : {}) });
    expect(screen.getByText('rows 1–2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveAttribute('max', '3');
    expect(screen.getByRole('button', { name: 'Last page' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  });

  test('Last still navigates to the counted final page', async () => {
    const user = userEvent.setup();
    draw({ total: 5 });
    await user.click(screen.getByRole('button', { name: 'Last page' }));
    expect(state.page).toBe(2);
    expect(rendered).toHaveBeenCalledOnce();
  });

  test('a full counted final page cannot advance', () => {
    state.page = 1;
    draw({ total: 4 });
    expect(screen.getByText('rows 3–4 of 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled();
  });

  test.each([0, 1, 2])('a complete result retains its bare count: %i', (total) => {
    draw({ total, rows: Array.from({ length: total }, (_, id) => ({ id })) });
    expect(screen.getByText(`${total} row${total === 1 ? '' : 's'}`, { exact: true })).toBeInTheDocument();
    if (total === 0) expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });
});

describe('bounded totals', () => {
  test('say where counting stopped, offer the exact number, and name no last page', async () => {
    const user = userEvent.setup();
    draw({ total: 10_000, exactTotal: true, cappedTotal: true });
    await user.click(screen.getByRole('button', { name: 'rows 1–2 of 10,000+' }));
    expect(gone).toHaveBeenCalledWith({ ...entry, exactCount: true }, 'replace');
    expect(screen.queryByRole('button', { name: 'Last page' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  });
});

describe('estimated totals', () => {
  test('keeps the rounded estimate and exact-count action', async () => {
    const user = userEvent.setup();
    draw({ total: 2400113, exactTotal: false });
    await user.click(screen.getByRole('button', { name: 'rows 1–2 of ~2.4M' }));
    expect(gone).toHaveBeenCalledWith({ ...entry, exactCount: true }, 'replace');
    expect(screen.queryByRole('button', { name: 'Last page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Page number' })).not.toBeInTheDocument();
  });

  test('a low estimate still permits advancing a full page', () => {
    draw({ total: 1, exactTotal: false });
    expect(screen.getByRole('button', { name: '~1 rows' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  });

  test('a high estimate cannot advance a partial page', () => {
    draw({ total: 2400113, exactTotal: false, rows: [{ id: 1 }] });
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});

test("a phone's summaries say a reference by its record's name, as the grid beside them does", () => {
  tables.invoice = {
    id: 'invoice',
    name: 'invoice',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'account_id', type: 'TEXT', nullable: false, primaryKey: false },
    ],
  };
  try {
    const data: Data = {
      table: 'invoice',
      columns: ['id', 'account_id', '__account'],
      rows: [{ id: 1, account_id: 'north', __account: 'North Supply' }],
      ms: 7,
    };
    render(
      <TableView
        entry={entry}
        data={data}
        chrome={false}
        interactive={false}
        export={false}
        summaries
        hide={['__account']}
        referenceLabels={{ account_id: '__account' }}
      />,
    );
    expect(summarized).toHaveBeenCalledWith(
      expect.objectContaining({ referenceLabels: { account_id: '__account' }, columns: ['id', 'account_id'] }),
    );
  } finally {
    delete tables.invoice;
    summarized.mockClear();
  }
});

test("a phone's Records and Table tabs are offered only where the table says more than the records do", () => {
  tables.invoice = {
    id: 'invoice',
    name: 'invoice',
    schema: '',
    isView: false,
    columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
  };
  const data: Data = { table: 'invoice', columns: ['id'], rows: [{ id: 1 }], ms: 7 };
  const draw = () => render(<TableView entry={entry} data={data} chrome={false} interactive={false} export={false} summaries />);
  try {
    mode.more = false;
    const alone = draw();
    expect(screen.queryByRole('button', { name: 'Table' })).not.toBeInTheDocument();
    // Without the choice the phone says the records, never a hidden table.
    expect(alone.container.querySelector('.responsive-results')).toHaveClass('show-records');
    alone.unmount();
    mode.more = true;
    draw();
    expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Records' })).toBeInTheDocument();
  } finally {
    delete tables.invoice;
  }
});
