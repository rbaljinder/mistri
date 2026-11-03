/**
 * A grouped grid (a list view's `group`): the rows arrive in their group's order and each run of one value stands
 * under a head — a hairline row with the value, how many rows the group holds over the whole list and each `totals`
 * column's subtotal under its column. A head folds its group away and opens it again, and the keyboard's cursor
 * steps over a folded group's rows rather than stopping on rows that are not drawn.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn as sharedLabel, primaryKey as sharedPk } from '../../../../engine/src/shared/schema.js';
import type { GridGroup } from './Grid.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const deal: TableMeta = {
  id: 'deal',
  name: 'deal',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('stage', 'TEXT'),
    col('amount', 'INTEGER'),
  ] as TableMeta['columns'],
};

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: [deal], foreignKeys: [] } },
  api: async () => ({}),
  findTable: () => deal,
  refsTo: () => [],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => ({ id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name),
  openRecord: () => {},
  peekRecord: () => {},
  go: () => {},
  currentEntry: () => ({ kind: 'table', table: 'deal', query: 'deal' }),
  prefersPages: () => true,
  emptyWord: () => '—',
  columnDisplay: () => null,
  columnLabel: () => null,
  columnKind,
  labelColumn: sharedLabel,
  primaryKey: sharedPk,
  loadJson: () => ({}),
  saveJson: () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
}));
vi.mock('../thmenu.js', () => ({ openFilterMenu: () => {}, sortBy: () => {} }));

const { Grid } = await import('./Grid.js');

afterEach(cleanup);

/* A page of five deals in stage order; the heads' figures are the whole list's (a breakdown), not this page's. */
const data = {
  table: 'deal',
  columns: ['id', 'name', 'stage', 'amount'],
  rows: [
    { id: 1, name: 'Acme renewal', stage: 'negotiation', amount: 1200 },
    { id: 2, name: 'Birch upgrade', stage: 'negotiation', amount: 800 },
    { id: 3, name: 'Cedar pilot', stage: 'proposal', amount: 500 },
    { id: 4, name: 'Delta seats', stage: 'proposal', amount: 300 },
    { id: 5, name: 'Elm audit', stage: null, amount: 100 },
  ],
};
const heads: Record<string, { count: number; amount: number }> = {
  negotiation: { count: 7, amount: 9100 },
  proposal: { count: 2, amount: 800 },
};
const group: GridGroup = {
  column: 'stage',
  head: (value) => {
    const known = typeof value === 'string' ? heads[value] : undefined;
    return {
      label: value === null ? 'No stage' : String(value)[0].toUpperCase() + String(value).slice(1),
      ...(known ? { count: known.count, sums: { amount: known.amount } } : {}),
    };
  },
};

const headRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLTableRowElement>('tbody tr.grid-group-head')];
const dataRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row]')];

test('a head stands over each run of one value, with its whole count and each subtotal under the column it sums', () => {
  const { container } = render(<Grid table={deal} data={data} hide={['id']} group={group} totals={{ amount: 10000 }} />);
  const body = [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((row) =>
    row.classList.contains('grid-group-head') ? `head:${row.querySelector('.grid-group-name')?.textContent}` : `row:${row.dataset.row}`,
  );
  expect(body).toEqual(['head:Negotiation', 'row:0', 'row:1', 'head:Proposal', 'row:2', 'row:3', 'head:No stage', 'row:4']);
  const [negotiation, , none] = headRows(container);
  // Seven, though two are on this page: the head counts the group, not the page.
  expect(negotiation.querySelector('.grid-group-count')?.textContent).toBe('7');
  // The value spans the columns before the first subtotal; the subtotal stands in the amount column's place.
  const cells = [...negotiation.children] as HTMLTableCellElement[];
  expect(cells[0].colSpan).toBe(2);
  expect(cells[1].classList.contains('grid-group-sum')).toBe(true);
  expect(cells[1].textContent).toContain('9,100');
  // A group the breakdown did not count still has its head, without figures.
  expect(none.querySelector('.grid-group-count')).toBeNull();
  // The footer's total is the list's, as before.
  expect(container.querySelector('tfoot .grid-totals')?.textContent).toContain('10,000');
});

test('a head folds its group away and opens it again, and says which it is', () => {
  const { container } = render(<Grid table={deal} data={data} hide={['id']} group={group} />);
  const toggle = headRows(container)[0].querySelector('button')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(headRows(container)[0].classList.contains('is-folded')).toBe(true);
  expect(dataRows(container).map((row) => row.dataset.row)).toEqual(['2', '3', '4']);
  // Its head stays, so the group can be opened again.
  expect(headRows(container)).toHaveLength(3);
  fireEvent.click(toggle);
  expect(dataRows(container).map((row) => row.dataset.row)).toEqual(['0', '1', '2', '3', '4']);
});

test("the keyboard's cursor steps over a folded group's rows, down and back up", () => {
  const { container } = render(<Grid table={deal} data={data} hide={['id']} group={group} />);
  // Fold the proposals: rows 2 and 3 are not drawn.
  fireEvent.click(headRows(container)[1].querySelector('button')!);
  const table = container.querySelector('table')!;
  fireEvent.focus(table);
  const at = () => (document.activeElement?.closest('tr[data-row]') as HTMLElement | null)?.dataset.row;
  expect(at()).toBe('0');
  fireEvent.keyDown(table, { key: 'ArrowDown' });
  expect(at()).toBe('1');
  fireEvent.keyDown(table, { key: 'ArrowDown' });
  expect(at()).toBe('4');
  fireEvent.keyDown(table, { key: 'ArrowUp' });
  expect(at()).toBe('1');
});

test('an ungrouped grid draws no heads', () => {
  const { container } = render(<Grid table={deal} data={data} hide={['id']} />);
  expect(headRows(container)).toHaveLength(0);
  expect(dataRows(container)).toHaveLength(5);
});
