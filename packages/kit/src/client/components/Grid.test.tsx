/**
 * The result grid, drawn and driven.
 *
 * What a cell says for each kind of value, what the header offers, what an
 * empty result is told, what a row does when clicked or entered, and what
 * an expanded row fetches. The filter menu and the sort rewrite are stood
 * in for: they are the vanilla client's and rewrite the walk's query.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { installShell } from '../shellMode.js';
import { columnKind, labelColumn as sharedLabel, primaryKey as sharedPk } from '../../../../engine/src/shared/schema.js';

const opened: unknown[] = [];
const openedFrom: unknown[] = [];
const peeked: unknown[] = [];
const sorted: unknown[] = [];
const menus: unknown[] = [];
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let entry: { kind: string; table: string; query: string } = { kind: 'table', table: 'invoice', query: 'invoice' };
let appMode = false;
/** Column → the App's display rule, per test. */
let displayRules: Record<string, unknown> = {};

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const customer: TableMeta = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('active', 'BOOLEAN'),
  ] as TableMeta['columns'],
};
const invoice: TableMeta = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  indexed: ['id', 'customer_id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('customer_id', 'INTEGER', { references: { table: 'customer', column: 'id' } }),
    col('total', 'NUMERIC'),
    col('paid', 'BOOLEAN'),
    col('issued_on', 'DATE'),
    col('memo', 'TEXT'),
  ] as TableMeta['columns'],
};
const line: TableMeta = {
  id: 'invoice_line',
  name: 'invoice_line',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('invoice_id', 'INTEGER', { references: { table: 'invoice', column: 'id' } }),
    col('sku', 'TEXT'),
  ] as TableMeta['columns'],
};
const tables: Record<string, TableMeta> = { customer, invoice, invoice_line: line };
const fks = [
  { name: 'line_invoice', from: { table: 'invoice_line', columns: ['invoice_id'] }, to: { table: 'invoice', columns: ['id'] } },
  { name: 'invoice_customer', from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
];

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: Object.values(tables), foreignKeys: fks } },
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/query') return { columns: ['id', 'invoice_id', 'sku'], rows: [{ id: 9, invoice_id: 1, sku: 'A-1' }] };
    if (path === '/api/count') return { count: 3, exact: true };
    return {};
  },
  findTable: (id: string) => tables[id],
  refsTo: (id: string) => fks.filter((f) => f.to.table === id),
  keyOf: (_table: TableMeta, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.memo ?? row.id),
  openRecord: (tableId: string, key: unknown, label: unknown, _how: string, from: unknown) => {
    opened.push([tableId, key, label]);
    openedFrom.push(from);
  },
  peekRecord: (...args: unknown[]) => peeked.push(args),
  go: (e: unknown) => opened.push(['go', e]),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: (v: unknown) => String(v),
  currentEntry: () => entry,
  prefersPages: () => appMode,
  emptyWord: () => (appMode ? '—' : 'null'),
  columnDisplay: (_table: string, name: string) => displayRules[name] ?? null,
  columnLabel: () => null,
  columnKind,
  labelColumn: sharedLabel,
  primaryKey: sharedPk,
  loadJson: () => ({}),
  saveJson: () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../../../../mistri/src/client/appState.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inAppMode: () => appMode,
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../thmenu.js', () => ({
  openFilterMenu: (...args: unknown[]) => menus.push(args),
  sortBy: (...args: unknown[]) => sorted.push(args),
}));

const { Grid } = await import('./Grid.js');

const rows = [
  {
    id: 1,
    customer_id: 4,
    total: 12345.5,
    paid: 1,
    issued_on: '2026-08-01T00:00:00',
    memo: 'Harbour Freight — first order of the season, shipped in two crates',
  },
  { id: 2, customer_id: null, total: '9223372036854775807', paid: 0, issued_on: '2026-08-02T00:00:00', memo: null },
];
const data = { table: 'invoice', columns: ['id', 'customer_id', 'total', 'paid', 'issued_on', 'memo'], rows, total: 2, ms: 1 };

test('readable read-only fields stay visible in the grid without editing controls', () => {
  const table = { ...invoice, columns: invoice.columns.map((c) => ({ ...c, writable: c.name === 'memo' })) };
  render(<Grid table={table} data={data} interactive={false} />);
  expect(screen.getByText('12,345.5')).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
});

test('an edited cell keeps its own cell, draws values in its dress, and F2 or Enter presses its editor', async () => {
  const pressed: string[] = [];
  const editCell = (row: Record<string, unknown>, column: string, draw: (next?: { value: unknown }) => React.ReactNode) =>
    column === 'total' ? (
      <button
        type="button"
        data-cell-edits=""
        data-cell-opens=""
        onClick={(e) => {
          e.stopPropagation();
          pressed.push(`${row.id}`);
        }}
      >
        {draw()}|{draw({ value: 7 })}
      </button>
    ) : undefined;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Grid table={invoice} data={data} editCell={editCell} />
    </QueryClientProvider>,
  );
  const cell = screen.getAllByRole('button', { name: /12,345.5/ })[0].closest('td')!;
  expect(cell).toHaveClass('cell-editable', 'align-right');
  expect(cell).toHaveTextContent('12,345.5|7');
  // Every other cell is drawn as before.
  expect(screen.getAllByText('Harbour Freight — first order of the season, shipped in two crates')[0].closest('td')).not.toHaveClass(
    'cell-editable',
  );
  await userEvent.click(cell.querySelector('button')!);
  expect(pressed).toEqual(['1']);
  expect(opened).toHaveLength(0);
  pressed.length = 0;
  // The click left the cursor on the cell; back into the grid, then the spreadsheet's edit key.
  document.querySelector<HTMLElement>('table')!.focus();
  await userEvent.keyboard('{F2}');
  expect(pressed).toEqual(['1']);
  await userEvent.keyboard('{Enter}');
  expect(pressed).toEqual(['1', '1']);
  expect(opened).toHaveLength(0);
});

test('a key the App names in its own words reads as that name, whole past 2^53, and a plain key stays a number', () => {
  const named = { ...invoice, labelTemplate: 'INV-{id}', keyLabel: true as const };
  const huge = { ...rows[0], id: '9007199254740993' };
  render(<Grid table={named} data={{ ...data, rows: [huge, rows[1]] }} interactive={false} />);
  expect(screen.getByText('INV-9007199254740993')).toBeVisible();
  expect(screen.getByText('INV-2')).toBeVisible();
  cleanup();
  // A noun-and-key name ("Invoice #{id}") is not the App's word for the key: no flag, the number.
  render(<Grid table={{ ...invoice, labelTemplate: 'Invoice #{id}' }} data={data} interactive={false} />);
  expect(screen.queryByText('Invoice #1')).toBeNull();
});

test('fit is the default, reserves the expander, and scroll restores native layout', () => {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Grid table={invoice} data={data} hide={['paid']} />
    </QueryClientProvider>,
  );
  expect(document.querySelector('table')).toHaveClass('grid-fit');
  expect(document.querySelectorAll('col')).toHaveLength(6);
  expect(document.querySelector('col')?.style.width).toBe('32px');
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <Grid table={invoice} data={data} sizing="scroll" />
    </QueryClientProvider>,
  );
  expect(document.querySelector('table')).not.toHaveClass('grid-fit');
  expect(document.querySelector('table')?.style.width).toBe('');
  expect(document.querySelector('colgroup')).toBeNull();
});

test('fit samples joined labels instead of raw keys', () => {
  render(
    <Grid
      data={{ columns: ['customer_id', 'label'], rows: [{ customer_id: 1, label: 'Harbour Shipping Co' }] }}
      hide={['label']}
      labels={{ customer_id: 'Customer' }}
      referenceLabels={{ customer_id: 'label' }}
      interactive={false}
    />,
  );
  expect(Number.parseInt(document.querySelector('col')!.style.width)).toBeGreaterThan(150);
});

test('fit follows container resizing and disconnects its observer when switched to scroll', () => {
  const callbacks: Array<() => void> = [];
  const disconnect = vi.fn();
  let width = 640.75;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        callbacks.push(() => callback([{ contentRect: { width } } as ResizeObserverEntry]));
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const computedStyle = window.getComputedStyle.bind(window);
  const measure = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = computedStyle(element);
    if (element.classList.contains('table-wrap'))
      return new Proxy(style, {
        get(target, key) {
          if (key === 'width') return `${width}px`;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    return style;
  });
  try {
    const props = {
      data: { columns: ['name', 'description'], rows: [{ name: 'Laptop', description: 'A long description of the managed service' }] },
      interactive: false,
    };
    const view = render(<Grid {...props} />);
    expect(document.querySelector('table')?.style.width).toBe('640px');
    width = 420.75;
    act(() => callbacks.forEach((callback) => callback()));
    expect(document.querySelector('table')?.style.width).toBe('420px');
    view.rerender(<Grid {...props} sizing="scroll" />);
    expect(disconnect).toHaveBeenCalled();
    expect(document.querySelector('colgroup')).toBeNull();
    view.unmount();
  } finally {
    measure.mockRestore();
    vi.unstubAllGlobals();
  }
});

test('a cell checked before resize still gets its full tooltip when later clipped', () => {
  render(<Grid data={{ columns: ['name'], rows: [{ name: 'Shipping' }] }} interactive={false} />);
  const cell = document.querySelector('td')!;
  Object.defineProperty(cell, 'clientWidth', { value: 100, configurable: true });
  Object.defineProperty(cell, 'scrollWidth', { value: 80, configurable: true });
  act(() => cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(cell.title).toBe('');
  Object.defineProperty(cell, 'clientWidth', { value: 50 });
  act(() => cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(cell.title).toBe('Shipping');
});

test('a line the cell clips inside itself (a name over its detail) gets its whole text on hover (G210)', () => {
  displayRules = { memo: { subtitle: 'customer_id' } };
  render(
    <Grid
      table={invoice}
      data={{ columns: ['memo', 'customer_id'], rows: [{ memo: 'A long monitoring summary that runs out', customer_id: 4 }] }}
      interactive={false}
    />,
  );
  const main = document.querySelector<HTMLElement>('td .cell-main')!;
  const cell = main.closest('td')!;
  // The cell itself does not overflow: the line inside it cuts its own text.
  Object.defineProperty(cell, 'clientWidth', { value: 100, configurable: true });
  Object.defineProperty(cell, 'scrollWidth', { value: 100, configurable: true });
  Object.defineProperty(main, 'clientWidth', { value: 40, configurable: true });
  Object.defineProperty(main, 'scrollWidth', { value: 90, configurable: true });
  act(() => main.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(main.title).toBe('A long monitoring summary that runs out');
  expect(cell.title).toBe('');
});

/** The cells of a row, by column — the expander column, when there is one, has no name. */
function cellsOf(row: number) {
  const names = [...document.querySelectorAll('thead th')].map((th) => th.querySelector('.th-sort')?.firstChild?.textContent?.trim() ?? '');
  const tds = [...document.querySelectorAll(`tbody tr[data-row="${row}"] td`)];
  return (name: string) => tds[names.indexOf(name)];
}

function draw(tree: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, tree));
}

beforeEach(() => {
  installShell({ inApp: () => appMode });
  opened.length = 0;
  openedFrom.length = 0;
  peeked.length = 0;
  sorted.length = 0;
  menus.length = 0;
  calls.length = 0;
  appMode = false;
  entry = { kind: 'table', table: 'invoice', query: 'invoice' };
});
afterEach(() => cleanup());

describe('cells', () => {
  test('a dotted boolean is a boolean and a joined key is not the base row key', () => {
    draw(
      <Grid
        table={invoice}
        data={{
          rows: [{ id: 1, 'customer_id.active': 0, 'customer_id.id': 10001 }],
          columns: ['id', 'customer_id.active', 'customer_id.id'],
        }}
        interactive={false}
      />,
    );
    expect(cellsOf(0)('customer_id.active')).toHaveTextContent('✗');
    expect(cellsOf(0)('customer_id.id')).toHaveTextContent('10001');
    expect(document.querySelectorAll('thead .pk')).toHaveLength(1);
  });
  test('joined labels keep the raw reference and row key without showing helper columns', async () => {
    const user = userEvent.setup();
    draw(
      <Grid
        table={invoice}
        data={{
          ...data,
          columns: [...data.columns, '__name'],
          rows: [
            { ...rows[0], __name: 'Harbour Freight' },
            { ...rows[1], __name: null },
          ],
        }}
        hide={['__name']}
        referenceLabels={{ customer_id: '__name' }}
        interactive={false}
      />,
    );
    const customerCell = cellsOf(0)('customer_id');
    expect(customerCell).toHaveTextContent('Harbour Freight');
    expect(customerCell).toHaveAttribute('data-ref-value', '4');
    expect(customerCell).toHaveAttribute('data-ref-table', 'customer');
    expect(customerCell).toHaveAttribute('title', 'Harbour Freight (4)');
    expect(customerCell).toHaveClass('align-left');
    expect(document.querySelector('thead')).not.toHaveTextContent('__name');
    expect(cellsOf(1)('customer_id')).toHaveTextContent('null');
    await user.click(cellsOf(0)('id'));
    expect(opened[0]).toEqual(['invoice', { id: 1 }, rows[0].memo]);
  });

  test('a missing label falls back to the original reference value', () => {
    draw(<Grid table={invoice} data={data} referenceLabels={{ customer_id: '__missing' }} interactive={false} />);
    expect(cellsOf(0)('customer_id')).toHaveTextContent('4');
    expect(cellsOf(0)('customer_id')).toHaveAttribute('data-ref-value', '4');
  });
  test('each kind of value is drawn by what it holds', () => {
    draw(<Grid table={invoice} data={data} />);
    const first = cellsOf(0);
    const second = cellsOf(1);
    // A number grouped, a flag as a mark, a midnight timestamp as its date — in the reader's words, the stored value kept in the title.
    expect(first('total')).toHaveTextContent('12,345.5');
    expect(first('total')).toHaveClass('num');
    expect(first('paid').querySelector('.yes')).toHaveTextContent('✓');
    expect(second('paid').querySelector('.no')).toHaveTextContent('✗');
    expect(first('issued_on')).toHaveTextContent('Aug 1, 2026');
    expect(first('issued_on')).toHaveAttribute('title', '2026-08-01T00:00:00');
    // A reference is marked for the peek, and a numeric key is a link into another table.
    expect(first('customer_id')).toHaveAttribute('data-ref-table', 'customer');
    expect(first('customer_id')).toHaveClass('reflink');
    // A null is the word, and never a link.
    expect(second('customer_id')).toHaveTextContent('null');
    expect(second('customer_id')).not.toHaveAttribute('data-ref-table');
    // A value past 2^53 is shown as it arrived, grouped by hand — never rounded.
    expect(second('total')).toHaveTextContent('9,223,372,036,854,775,807');
    // A long text is drawn whole, with no tooltip repeating it: only a clamped
    // value, or one its column clips (decided on hover), gets a title.
    expect(first('memo')).toHaveTextContent(String(rows[0].memo));
    expect(first('memo')).not.toHaveAttribute('title');
  });

  test("an App's disabled sort button gives no Workbench instruction", () => {
    appMode = true;
    draw(<Grid table={invoice} data={data} />);
    const total = screen.getByRole('button', { name: /^total/ });
    expect(total).toHaveAttribute('aria-disabled', 'true');
    expect(total.title).toMatch(/not indexed/);
    expect(total.title).not.toMatch(/query bar|statement/);
  });

  test('in an app the empty word is a dash', () => {
    appMode = true;
    draw(<Grid table={invoice} data={data} />);
    expect(document.querySelector('tbody tr[data-row="1"] td.null')).toHaveTextContent('—');
  });
});

describe('the header', () => {
  test('labels, relationship markers and the filter chevron have separate layout elements', () => {
    draw(<Grid table={invoice} data={data} />);
    const sort = screen.getByRole('button', { name: /^customer_id/ });
    const controls = sort.closest('.th-controls');
    expect(controls).not.toBeNull();
    expect(sort.querySelector('.th-label')).toHaveTextContent('customer_id');
    expect(sort.querySelector('.fk')).toHaveTextContent('→');
    const filter = within(controls as HTMLElement).getByRole('button', { name: 'Filter on customer_id' });
    expect(filter.querySelector('.th-filter-icon')).toHaveAttribute('aria-hidden', 'true');
    expect(filter).toHaveTextContent('');
    /* The sort, the column's two move buttons, and the filter chevron. */
    expect(controls?.children).toHaveLength(4);
  });

  test('sorts by clicking, adds a level by shift-clicking, and says why a column cannot be sorted', async () => {
    const user = userEvent.setup();
    entry = { kind: 'table', table: 'invoice', query: 'invoice sort id' };
    draw(<Grid table={invoice} data={{ ...data, order: { implicit: false, order: [] } }} />);
    const id = screen.getByRole('button', { name: /^id/ });
    expect(id.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await user.click(id);
    expect(sorted).toEqual([['id']]);
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('button', { name: /^customer_id/ }));
    await user.keyboard('{/Shift}');
    expect(sorted[1]).toEqual(['customer_id', 'asc', true]);
    // `total` is not indexed and the table is not known to be small.
    const total = screen.getByRole('button', { name: /^total/ });
    expect(total).toHaveAttribute('aria-disabled', 'true');
    expect(total.title).toMatch(/not indexed/);
    await user.click(total);
    expect(sorted).toHaveLength(2);
  });

  test('the filter control opens the column menu on the sample', async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Filter on total' }));
    expect(menus).toHaveLength(1);
    expect((menus[0] as unknown[])[2]).toBe('total');
  });

  test("in an App list the ⌄ is the App's short menu, and the Workbench keeps its own", async () => {
    const user = userEvent.setup();
    const { AppColumnMenuContext } = await import('./AppColumnMenu.js');
    const host = {
      current: {
        table: invoice,
        query: 'invoice',
        refinement: '',
        tabQuery: '',
        standing: '',
        listKey: 'invoices',
        boxFor: () => undefined,
        unitOf: () => undefined,
        apply: vi.fn(),
        navigate: vi.fn(),
        railFacet: () => null,
        Picker: () => null,
      },
    };
    draw(
      <AppColumnMenuContext.Provider value={host}>
        <Grid table={invoice} data={data} />
      </AppColumnMenuContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: /^Filter on/ })).toBeNull();
    // A column the header cannot sort (no index, a table of unknown size) offers no sort.
    await user.click(screen.getByRole('button', { name: 'memo column options' }));
    expect(
      within(await screen.findByRole('menu', {}, { timeout: 5000 }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Pin column']);
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'memo column options' })).toHaveFocus(), { timeout: 5000 });
    // A reference sorts by the name it is drawn by, in words, with no language beside them.
    await user.click(screen.getByRole('button', { name: 'customer_id column options' }));
    const menu = await screen.findByRole('menu', {}, { timeout: 5000 });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['A → Z', 'Z → A', 'Pin column']);
    expect(menu.textContent).not.toMatch(/sort |=/);
    expect(menus).toHaveLength(0);
    await user.click(within(menu).getByRole('menuitem', { name: 'Z → A' }));
    expect(host.current.navigate).toHaveBeenCalledWith('invoice sort customer_id.name desc', 'customer_id');
  });

  test('an embedded grid has labels, not controls', () => {
    draw(<Grid table={invoice} data={data} interactive={false} />);
    expect(screen.queryByRole('button', { name: /Filter on/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^id/ })).toHaveAttribute('aria-disabled', 'true');
  });

  test('over an API, a header filters and sorts only where the API documents it', () => {
    // An API's catalog says which columns its documented filters and sort values name (adapters/http).
    draw(<Grid table={{ ...invoice, filterable: ['customer_id'], sortable: ['issued_on'] }} data={data} />);
    expect(screen.getByRole('button', { name: 'Filter on customer_id' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filter on total' })).toBeNull();
    const total = screen.getByRole('button', { name: /^total/ });
    expect(total).toHaveAttribute('aria-disabled', 'true');
    expect(total.title).toMatch(/the API documents no sort by it/);
    expect(screen.getByRole('button', { name: /^issued_on/ })).toHaveAttribute('aria-disabled', 'false');
  });
});

describe('rows', () => {
  test('a row with its key opens its record, by click and by Enter', async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={data} />);
    await user.click(document.querySelector('tbody tr[data-row="1"] td')!);
    expect(opened[0]).toEqual(['invoice', { id: 2 }, '2']);
    const table = document.querySelector('table')!;
    expect(table).toHaveAttribute('role', 'grid');
    act(() => table.focus());
    await user.keyboard('{Enter}');
    expect(opened[1]).toEqual(['invoice', { id: 2 }, '2']);
  });

  test('Enter on a control in the grid presses the control, not the row last clicked', async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={data} />);
    // The cursor is put on a row the way a click puts it there.
    act(() => {
      document.querySelector('tbody tr[data-row="0"] td:last-child')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    screen.getByRole('button', { name: /^id/ }).focus();
    await user.keyboard('{Enter}');
    expect(sorted).toEqual([['id']]);
    const expander = within(document.querySelector('tbody tr[data-row="0"]')!).getByRole('button', {
      name: 'Show what points at this row',
    });
    expander.focus();
    await user.keyboard('{Enter}');
    expect(expander).toHaveAttribute('aria-expanded', 'true');
    expect(opened).toEqual([]);
  });

  test('Space glances at the row under the cursor; Enter opens it with the list the room hands it', async () => {
    const user = userEvent.setup();
    const list = { query: 'invoice', offset: 0, limit: 50, total: 2 };
    draw(<Grid table={invoice} data={{ ...data, limit: 50, offset: 0 }} list={list} />);
    act(() => {
      document.querySelector('tbody tr[data-row="1"] td:last-child')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    act(() => document.querySelector('table')!.focus());
    await user.keyboard(' ');
    const records = [
      { key: { id: 1 }, label: rows[0].memo },
      { key: { id: 2 }, label: '2' },
    ];
    expect(peeked).toEqual([['invoice', { id: 2 }, '2', records, list]]);
    expect(opened).toEqual([]);
    await user.keyboard('{Enter}');
    expect(openedFrom).toEqual([{ records, list }]);
  });

  test("a grid no room hands a list gives its rows only, and the row beside a split's detail is marked", async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={{ ...data, limit: 2, offset: 4 }} current={{ id: 2 }} />);
    expect(document.querySelector('tbody tr[data-row="1"]')).toHaveAttribute('aria-current', 'true');
    expect(document.querySelector('tbody tr[data-row="0"]')).not.toHaveAttribute('aria-current');
    await user.click(document.querySelector('tbody tr[data-row="0"] td')!);
    expect((openedFrom[0] as { list?: unknown }).list).toBeUndefined();
  });

  test('a projection without the key is inert, and says so with no cursor', () => {
    draw(<Grid table={invoice} data={{ ...data, columns: ['total', 'memo'] }} />);
    expect(document.querySelector('tbody tr.clickable')).toBeNull();
  });

  test('nothing to show says whether a filter did it', () => {
    draw(<Grid table={invoice} data={{ ...data, rows: [] }} />);
    expect(screen.getByText('This table is empty.')).toBeInTheDocument();
    cleanup();
    entry = { kind: 'table', table: 'invoice', query: 'invoice total > 1' };
    draw(<Grid table={invoice} data={{ ...data, rows: [] }} />);
    expect(screen.getByText('No rows match.')).toBeInTheDocument();
  });

  test('a long result is windowed and says so', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...rows[0], id: i + 1 }));
    draw(<Grid table={invoice} data={{ ...data, rows: many, total: 400 }} />);
    expect(screen.getByText('400 rows, drawn as you scroll.')).toBeInTheDocument();
    expect(document.querySelectorAll('tbody tr.virtual-spacer')).toHaveLength(2);
    expect(document.querySelectorAll('tbody tr[data-row]').length).toBeLessThan(400);
  });
});

describe('expanding a row', () => {
  test('fetches what points at it, once, and offers the rest', async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={data} />);
    const expander = within(document.querySelector('tbody tr[data-row="0"]')!).getByRole('button', {
      name: 'Show what points at this row',
    });
    await user.click(expander);
    // Opening the detail must not also open the row.
    expect(opened).toEqual([]);
    const detail = await screen.findByText('invoice_line');
    const section = detail.closest('.detail-section')!;
    expect(within(section as HTMLElement).getByText('via invoice_id')).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText('3')).toHaveClass('detail-count');
    expect(within(section as HTMLElement).getByText('A-1')).toBeInTheDocument();
    await user.click(within(section as HTMLElement).getByRole('button', { name: 'See all →' }));
    expect(opened[0]).toEqual(['go', { kind: 'table', table: 'invoice_line', query: 'invoice_line invoice_id = 1' }]);
    // Closing and reopening is free.
    await user.click(expander);
    await user.click(expander);
    await screen.findByText('invoice_line');
    expect(calls.filter((c) => c.path === '/api/query')).toHaveLength(1);
  });

  test('expand every row opens them all, in batches, and collapses them at once', async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Expand every row' }));
    await vi.waitFor(() => expect(document.querySelectorAll('tr.detail-row')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Collapse every row' }));
    expect(document.querySelectorAll('tr.detail-row')).toHaveLength(0);
  });

  test('is not offered where rows open as pages', () => {
    appMode = true;
    draw(<Grid table={invoice} data={data} />);
    expect(screen.queryByRole('button', { name: 'Show what points at this row' })).toBeNull();
  });
});

const { RowHosts, RowDecoration, RowHeadDecoration, useRowHosts } = await import('./RowHost.js');

describe('row hosts', () => {
  const keyFor = (id: unknown) => JSON.stringify([['id', String(id)]]);
  const hostOf = (id: unknown) => document.querySelector(`tbody tr[data-row-key='${keyFor(id)}'] > td.row-host:first-child`);
  const expanderOf = (id: unknown) => hostOf(id)?.querySelector<HTMLButtonElement>('button.expander') ?? null;

  test('every row the grid can name has one host, keyed by its key string, and the expander is in it', () => {
    draw(<Grid table={invoice} data={data} />);
    expect(document.querySelectorAll('tbody tr[data-row] > td.row-host')).toHaveLength(2);
    expect(hostOf(1)?.querySelectorAll('button.expander')).toHaveLength(1);
    expect(expanderOf(2)).toHaveAttribute('aria-label', 'Show what points at this row');
  });

  test('a 64-bit id stays a string in the row key', () => {
    draw(<Grid table={invoice} data={{ ...data, rows: [{ ...rows[1], id: '9223372036854775807' }] }} />);
    expect(document.querySelector('tbody tr[data-row]')).toHaveAttribute('data-row-key', '[["id","9223372036854775807"]]');
  });

  test('a refetch that reorders and drops rows keeps the survivors’ decorations mounted', () => {
    const client = new QueryClient();
    const tree = (list: Array<Record<string, unknown>>) => (
      <QueryClientProvider client={client}>
        <Grid table={invoice} data={{ ...data, rows: list }} />
      </QueryClientProvider>
    );
    const view = render(tree(rows));
    const second = expanderOf(2);
    view.rerender(tree([{ ...rows[0], id: 3, memo: 'third' }, rows[1]]));
    // The same button, never redrawn — its row moved to a new index around it.
    expect(expanderOf(2)).toBe(second);
    expect(hostOf(2)?.closest('tr')).toHaveAttribute('data-row', '1');
    expect(hostOf(1)).toBeNull();
    expect(expanderOf(3)).not.toBeNull();
  });

  test('toggling a row keeps the same expander, and the focus on it', async () => {
    const user = userEvent.setup();
    draw(<Grid table={invoice} data={data} />);
    const expander = expanderOf(1)!;
    await user.click(expander);
    await screen.findByText('invoice_line');
    expect(expanderOf(1)).toBe(expander);
    expect(expander).toHaveAttribute('aria-expanded', 'true');
    expect(expander).toHaveFocus();
    expect(opened).toEqual([]);
  });

  test('an open row stays open through a refetch that moves it, and is forgotten once it leaves', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (list: Array<Record<string, unknown>>) => (
      <QueryClientProvider client={client}>
        <Grid table={invoice} data={{ ...data, rows: list }} />
      </QueryClientProvider>
    );
    const view = render(tree(rows));
    const expander = expanderOf(2)!;
    await user.click(expander);
    await screen.findByText('invoice_line');
    // A sort that keeps it on the page: the row moves, open, its detail under it.
    view.rerender(tree([rows[1], rows[0]]));
    expect(expanderOf(2)).toBe(expander);
    expect(expander).toHaveAttribute('aria-expanded', 'true');
    expect(hostOf(2)?.closest('tr')?.nextElementSibling).toHaveClass('detail-row');
    expect(document.querySelectorAll('tr.detail-row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Expand every row' })).toBeInTheDocument();
    // Gone from the result, then back: a closed row, not a detail reopened from memory.
    view.rerender(tree([rows[0]]));
    view.rerender(tree(rows));
    expect(expanderOf(2)).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelectorAll('tr.detail-row')).toHaveLength(0);
  });

  test('a result without the key has no hosts and no expander column', () => {
    draw(<Grid table={invoice} data={{ ...data, columns: ['total', 'memo'] }} />);
    expect(document.querySelector('td.row-host')).toBeNull();
    expect(document.querySelector('.expander')).toBeNull();
    expect(document.querySelectorAll('col')).toHaveLength(2);
  });

  test('a presentation around the grid decorates every row, even with no expander of its own', async () => {
    const user = userEvent.setup();
    appMode = true;
    function Ticks() {
      return (
        <>
          {[...useRowHosts().keys()].map((key) => (
            <RowDecoration key={key} rowKey={key}>
              <input type="checkbox" aria-label={`Select ${key}`} />
            </RowDecoration>
          ))}
        </>
      );
    }
    draw(
      <RowHosts>
        <Grid table={invoice} data={data} />
        <Ticks />
      </RowHosts>,
    );
    expect(screen.queryByRole('button', { name: 'Show what points at this row' })).toBeNull();
    expect(document.querySelector('thead th.expander-cell')).not.toBeNull();
    expect(document.querySelectorAll('tbody tr[data-row] > td.row-host input[type=checkbox]')).toHaveLength(2);
    // A control in the host is not a click on the row: the row does not open.
    await user.click(screen.getByRole('checkbox', { name: `Select ${keyFor(2)}` }));
    expect(opened).toEqual([]);
  });

  test('the header row’s leading cell is a host of its own, over the rows’ column and not among their keys', () => {
    appMode = true;
    let keys: string[] = [];
    function All() {
      keys = [...useRowHosts().keys()];
      return (
        <RowHeadDecoration>
          <input type="checkbox" aria-label="Select all rows" />
        </RowHeadDecoration>
      );
    }
    draw(
      <RowHosts>
        <Grid table={invoice} data={data} />
        <All />
      </RowHosts>,
    );
    const head = screen.getByRole('checkbox', { name: 'Select all rows' }).closest('th');
    expect(head).toHaveClass('expander-cell', 'row-host');
    expect(head).toBe(document.querySelector('thead tr > th:first-child'));
    expect(keys).toEqual([keyFor(1), keyFor(2)]);
  });

  test('the rows a grid opens in place publish nowhere', async () => {
    const user = userEvent.setup();
    let seen: string[] = [];
    function Keys() {
      seen = [...useRowHosts().keys()];
      return null;
    }
    draw(
      <RowHosts>
        <Grid table={invoice} data={data} />
        <Keys />
      </RowHosts>,
    );
    await user.click(expanderOf(1)!);
    await screen.findByText('A-1');
    expect(seen.sort()).toEqual([keyFor(1), keyFor(2)].sort());
  });
});

describe('the building blocks under and beside the rows', () => {
  afterEach(() => {
    displayRules = {};
  });

  test('a totals row labels itself and says each sum, dressed like its column', () => {
    displayRules = { total: { format: 'money', currency: 'USD' } };
    render(<Grid table={invoice} data={data} totals={{ total: 21 }} interactive={false} />);
    const footer = document.querySelector('tfoot tr.grid-totals')!;
    expect(footer).toHaveTextContent('Total');
    // Money as the column says it: whole amounts keep no cents.
    expect(within(footer as HTMLElement).getByText(/^\$21(\.00)?$/)).toBeVisible();
  });

  test('a sum still being asked says so, and one past 2^53 is shown as the server sent it', () => {
    const view = render(<Grid table={invoice} data={data} totals={{ total: undefined }} interactive={false} />);
    expect(screen.getByLabelText('Summing')).toBeVisible();
    view.rerender(<Grid table={invoice} data={data} totals={{ total: '9223372036854775807' }} interactive={false} />);
    expect(document.querySelector('tfoot')).toHaveTextContent('9,223,372,036,854,775,807');
  });

  test('no rows, no totals row', () => {
    render(<Grid table={invoice} data={{ ...data, rows: [] }} totals={{ total: 0 }} interactive={false} />);
    expect(document.querySelector('tfoot')).toBeNull();
  });

  test('a second line says another column of the same row under the cell', () => {
    displayRules = { memo: { subtitle: 'customer_id' } };
    render(<Grid table={invoice} data={data} interactive={false} />);
    const stacked = document.querySelector('td .cell-stack')!;
    expect(stacked.querySelector('.cell-main')).toHaveTextContent('Harbour Freight');
    expect(stacked.querySelector('.cell-sub')).toHaveTextContent('4');
    expect(document.querySelectorAll('.cell-sub')).toHaveLength(1);
  });

  test('a name read through a reference takes its second line from that record, or has none', () => {
    // employee.name: { subtitle: 'title' }, shown on another table as employee_id.name.
    displayRules = { 'employee_id.name': { subtitle: 'title' } };
    const columns = ['employee_id.name', 'title'];
    const { unmount } = render(
      <Grid
        data={{ columns, rows: [{ 'employee_id.name': 'Quinn Davis', title: 'Host row title', 'employee_id.title': 'Line cook' }] }}
        hide={['employee_id.title']}
        interactive={false}
      />,
    );
    expect(document.querySelector('.cell-sub')).toHaveTextContent('Line cook');
    expect(document.querySelectorAll('.cell-sub')).toHaveLength(1);
    unmount();
    // Not fetched: left out, never the host row's own `title`.
    render(<Grid data={{ columns, rows: [{ 'employee_id.name': 'Quinn Davis', title: 'Host row title' }] }} interactive={false} />);
    expect(document.querySelector('.cell-sub')).toBeNull();
  });
});
