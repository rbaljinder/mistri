import { afterEach, expect, test } from 'vitest';
import { type Column, DataTable } from '../src/DataTable';
import { clear, draw, focus, key } from './testing';

afterEach(clear);

type Charge = { id: string; amount: number };
const ROWS: Charge[] = Array.from({ length: 2000 }, (_, at) => ({ id: `CH-${at + 1}`, amount: at % 7 }));
const COLUMNS: Column<Charge>[] = [
  { id: 'id', header: 'Charge', primary: true, cell: (charge) => charge.id },
  {
    id: 'amount',
    header: 'Amount',
    cell: (charge) => charge.amount,
    total: (rows) => rows.reduce((sum, charge) => sum + charge.amount, 0),
  },
];
const table = (height?: string) => (
  <DataTable
    label="Charges"
    columns={COLUMNS}
    rows={ROWS}
    rowKey={(charge) => charge.id}
    rowName={(charge) => charge.id}
    onOpen={() => {}}
    height={height}
  />
);
const drawn = () => [...document.querySelectorAll<HTMLElement>('tbody tr[data-key]')];

/* What a pointer scrolls and a browser measures is run in a real browser (the README says what it found); here,
   where nothing has a size, the table still draws a window of its rows and not all of them. */
test('a table with a height of its own draws a window of its rows, and says how many it has', () => {
  draw(table('30rem'));
  expect(drawn().length).toBeLessThan(60);
  expect(drawn().length).toBeGreaterThan(0);
  expect(document.querySelector('[data-slot="data-table"]')?.getAttribute('aria-rowcount')).toBe('2001');
  expect(drawn()[0]?.getAttribute('aria-rowindex')).toBe('2');
});

test('a table with no height draws every row, as before', () => {
  draw(table());
  expect(drawn().length).toBe(2000);
  expect(document.querySelector('[data-slot="data-table"]')?.hasAttribute('aria-rowcount')).toBe(false);
});

test('a total is over every row, drawn or not, and stands at the foot', () => {
  draw(table('30rem'));
  expect([...document.querySelectorAll('tfoot td')].map((cell) => cell.textContent)).toEqual(['Total', '5995']);
});

test('the keyboard goes to the end of the rows, past the ones that are not drawn', () => {
  draw(table('30rem'));
  const first = drawn()[0]!.querySelector('a')!;
  focus(first);
  key(first, 'End', { ctrlKey: true });
  expect(document.activeElement?.closest('tr')?.getAttribute('data-key')).toBe('CH-2000');
  key(document.activeElement!, 'ArrowUp');
  expect(document.activeElement?.closest('tr')?.getAttribute('data-key')).toBe('CH-1999');
});
