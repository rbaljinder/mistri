/**
 * A grid's own arrangement, and the bulk selection it already had.
 *
 * Column order and widths (gridArrange.ts, Grid.tsx): the reader moves a
 * column a step at a time and drags or steps its width, and the cells
 * follow the heads. Bulk selection is not re-proved here: GridSelection
 * already proves it — row boxes, select all, the mixed state and the
 * per-record writes (GridSelection.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { columnKind, type TableMeta } from '../../../../engine/src/shared/schema.js';

import { applyColumnOrder, applyColumnWidths, clampColumnWidth, columnResizeStep, moveColumn } from './gridArrange.js';

describe('gridArrange', () => {
  test('an order drops columns no longer drawn and appends columns it never named', () => {
    expect(applyColumnOrder(['id', 'name', 'active'], ['name', 'gone'])).toEqual(['name', 'id', 'active']);
    expect(applyColumnOrder(['id', 'name'], null)).toEqual(['id', 'name']);
  });

  test('a move steps one place, and stands at either edge or for an unknown column', () => {
    expect(moveColumn(['id', 'name', 'active'], 'name', 'left')).toEqual(['name', 'id', 'active']);
    expect(moveColumn(['id', 'name', 'active'], 'name', 'right')).toEqual(['id', 'active', 'name']);
    expect(moveColumn(['id', 'name'], 'id', 'left')).toEqual(['id', 'name']);
    expect(moveColumn(['id', 'name'], 'name', 'right')).toEqual(['id', 'name']);
    expect(moveColumn(['id', 'name'], 'gone', 'left')).toEqual(['id', 'name']);
  });

  test('a width never goes below its floor, and a dragged width stands in place of its fitted one', () => {
    expect(clampColumnWidth(20)).toBe(48);
    expect(clampColumnWidth(120.4)).toBe(120);
    expect(applyColumnWidths([100, 120, 80], ['id', 'name', 'active'], { name: 200 })).toEqual([100, 200, 80]);
  });

  test('an arrow key steps a little, and a shifted one steps further', () => {
    expect(columnResizeStep(false)).toBe(16);
    expect(columnResizeStep(true)).toBe(64);
  });
});

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const ticket: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('active', 'BOOLEAN'),
  ] as TableMeta['columns'],
};
const tables: Record<string, TableMeta> = { ticket };

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: Object.values(tables), foreignKeys: [] } },
  api: async () => ({}),
  findTable: (id: string) => tables[id],
  refsTo: () => [],
  keyOf: (_table: TableMeta, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  openRecord: vi.fn(),
  peekRecord: vi.fn(),
  go: vi.fn(),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: (v: unknown) => String(v),
  currentEntry: () => ({ kind: 'table', table: 'ticket', query: 'ticket' }),
  prefersPages: () => false,
  emptyWord: () => 'null',
  columnDisplay: () => null,
  columnLabel: () => null,
  columnKind,
  labelColumn: (t: TableMeta) => t.columns.find((c) => c.name === 'name')?.name,
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  loadJson: vi.fn((): Record<string, unknown> => ({})),
  saveJson: () => {},
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  viewportScale: () => 1,
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ inAppMode: () => false }));
beforeEach(bridgeShell);
vi.mock('../thmenu.js', () => ({ openFilterMenu: vi.fn(), sortBy: vi.fn() }));

const { Grid } = await import('./Grid.js');
const { loadJson } = await import('../core.js');

const rows = [
  { id: 1, name: 'Printer', active: 1 },
  { id: 2, name: 'VPN', active: 0 },
];
const data = { table: 'ticket', columns: ['id', 'name', 'active'], rows, total: 2, ms: 1 };

function draw(options: { sizing?: 'fit' | 'scroll'; interactive?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Grid table={ticket} data={data} sizing={options.sizing} interactive={options.interactive} />
    </QueryClientProvider>,
  );
}

/** The heads' order, read off each head's sort button — the first button in the head. */
function headerOrder(): string[] {
  return screen.getAllByRole('columnheader').map((head) => within(head).getAllByRole('button')[0]!.textContent ?? '');
}

/** The first row's cells, in the order they are drawn. */
function firstRowCells(): string[] {
  const row = document.querySelector('tbody tr[data-row="0"]') ?? document.querySelector('tbody tr')!;
  return [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
}

function colWidths(): number[] {
  return [...document.querySelectorAll('col')].map((col) => Number.parseInt(col.style.width, 10));
}

afterEach(() => {
  cleanup();
  vi.mocked(loadJson).mockImplementation(() => ({}));
});

test('move buttons reorder columns, and the cells follow the heads', async () => {
  draw();
  expect(headerOrder()[0]).toMatch(/^id/);
  expect(headerOrder()[1]).toMatch(/^name/);
  expect(firstRowCells()[0]).toBe('1');
  expect(firstRowCells()[1]).toBe('Printer');
  expect(screen.getByRole('button', { name: 'Move id left' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move active right' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Move name left' }));
  expect(headerOrder()[0]).toMatch(/^name/);
  expect(headerOrder()[1]).toMatch(/^id/);
  expect(firstRowCells()[0]).toBe('Printer');
  expect(firstRowCells()[1]).toBe('1');

  fireEvent.click(screen.getByRole('button', { name: 'Move name right' }));
  expect(headerOrder()[0]).toMatch(/^id/);
  expect(headerOrder()[1]).toMatch(/^name/);
});

test('Alt+arrows move a column from its head', () => {
  draw();
  const sort = screen.getByRole('button', { name: 'name' });
  fireEvent.keyDown(sort, { key: 'ArrowLeft', altKey: true });
  expect(headerOrder()[0]).toMatch(/^name/);
  expect(headerOrder()[1]).toMatch(/^id/);
  fireEvent.keyDown(sort, { key: 'ArrowRight', altKey: true });
  expect(headerOrder()[0]).toMatch(/^id/);
});

test('arrow keys on a resizer widen and narrow its column', () => {
  draw();
  const resizer = screen.getByRole('separator', { name: 'Resize name column' });
  const before = colWidths()[1]!;
  expect(resizer).toHaveAttribute('aria-valuenow', String(before));
  fireEvent.keyDown(resizer, { key: 'ArrowRight' });
  expect(colWidths()[1]).toBe(before + 16);
  expect(resizer).toHaveAttribute('aria-valuenow', String(before + 16));
  fireEvent.keyDown(resizer, { key: 'ArrowRight', shiftKey: true });
  expect(colWidths()[1]).toBe(before + 80);
  fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
  expect(colWidths()[1]).toBe(before + 64);
});

test('a pointer drag widens a column, and a double-click restores its fitted width', () => {
  draw();
  const resizer = screen.getByRole('separator', { name: 'Resize name column' });
  const before = colWidths()[1]!;
  fireEvent.pointerDown(resizer, { clientX: 100, button: 0, pointerType: 'mouse' });
  fireEvent.pointerMove(resizer, { clientX: 140 });
  fireEvent.pointerUp(resizer);
  expect(colWidths()[1]).toBe(before + 40);
  fireEvent.doubleClick(resizer);
  expect(colWidths()[1]).toBe(before);
});

test('a scrolled grid takes a colgroup only once a width is dragged', () => {
  draw({ sizing: 'scroll' });
  expect(document.querySelector('table')).not.toHaveClass('grid-fit');
  expect(document.querySelector('colgroup')).toBeNull();
  const resizer = screen.getByRole('separator', { name: 'Resize name column' });
  expect(resizer).not.toHaveAttribute('aria-valuenow');
  fireEvent.keyDown(resizer, { key: 'ArrowRight' });
  expect(document.querySelector('table')).toHaveClass('grid-fit');
  expect(document.querySelector('colgroup')).not.toBeNull();
  expect(resizer).toHaveAttribute('aria-valuenow');
});

test('a grid that may not interact offers no arrangement controls', () => {
  draw({ interactive: false });
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.queryByRole('button', { name: /Move .* (left|right)/ })).toBeNull();
});

test("the move arrows are drawn by the stylesheet, so a head's text is its label", () => {
  draw();
  for (const head of screen.getAllByRole('columnheader')) expect(head.textContent).not.toMatch(/[‹›]/);
  expect(screen.getAllByRole('columnheader').map((head) => head.textContent)).toEqual(
    expect.arrayContaining([expect.stringMatching(/^name/)]),
  );
  // Still reachable, by name, and kept in the head's controls rather than a row of their own.
  const left = screen.getByRole('button', { name: 'Move name left' });
  expect(left.closest('.th-controls')).not.toBeNull();
  expect(left).toHaveClass('th-move-left');
});

/** The heads' column names (a key's badge and a sort arrow trail the label inside the sort button). */
const columnNames = () => headerOrder().map((label) => ['id', 'name', 'active'].find((name) => label.startsWith(name))!);

test('a column does not move across the pinned boundary, by button or by keyboard', () => {
  // The key and the name are pinned: they lead, and the cells beside them scroll.
  vi.mocked(loadJson).mockImplementation(() => ({ demo: { ticket: ['id', 'name'] } }));
  draw();
  expect(columnNames()).toEqual(['id', 'name', 'active']);
  // Within the block a move is fine; across its edge it is refused.
  expect(screen.getByRole('button', { name: 'Move name right' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move active left' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move name left' })).not.toBeDisabled();
  fireEvent.keyDown(screen.getByRole('button', { name: 'name' }), { key: 'ArrowRight', altKey: true });
  fireEvent.keyDown(screen.getByRole('button', { name: 'active' }), { key: 'ArrowLeft', altKey: true });
  expect(columnNames()).toEqual(['id', 'name', 'active']);
  fireEvent.click(screen.getByRole('button', { name: 'Move name left' }));
  expect(columnNames()).toEqual(['name', 'id', 'active']);
});
