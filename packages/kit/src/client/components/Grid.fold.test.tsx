/**
 * A column folded under the row's name is said with its head ("Phase Open"), except where the words the cell draws
 * already begin with it: tested against what is drawn, not the stored value, which a reference's label or a display
 * rule may say differently.
 */
import { expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { foldedOf } from './Grid.js';
import { TotalsRow } from './GridTotals.js';

type More = Parameters<typeof foldedOf>[0][number];

const text = { kind: 'text' } as More['plan'];
const folded = (column: object, record: Record<string, unknown>) =>
  foldedOf([{ name: 'phase', head: 'Phase', meta: undefined, plan: text, display: null, label: undefined, ...column } as More], record);

test('a head the drawn words already begin with is not said twice', () => {
  expect(folded({ label: 'phase.name' }, { phase: 4, 'phase.name': 'Phase 4' })[0]!.head).toBe('');
  expect(folded({ display: { values: { p4: 'Phase four' } } }, { phase: 'p4' })[0]!.head).toBe('');
});

test('a head the drawn words do not begin with is kept', () => {
  expect(folded({}, { phase: 'Open' })[0]!.head).toBe('Phase');
  expect(folded({ display: { values: { p4: 'Four' } } }, { phase: 'p4' })[0]!.head).toBe('Phase');
});

/* A totalled column folded under the row's name has no cell to stand its sum in: the footer says it beside its caption. */
const footer = (columns: string[], away: { name: string; head: string }[]) => {
  render(
    <table>
      <tfoot>
        <TotalsRow columns={columns} totals={{ quoted_fee: 12340, guests: 301 }} label="Total" away={away} table={undefined} />
      </tfoot>
    </table>,
  );
  const cells = [...document.querySelectorAll('tr.grid-totals td')] as HTMLTableCellElement[];
  document.body.replaceChildren();
  return cells.map((cell) => [cell.colSpan, cell.textContent]);
};

test('a totals row says each sum under its column while the column is drawn', () => {
  expect(footer(['title', 'status', 'guests', 'quoted_fee'], [])).toEqual([
    [1, 'Total'],
    [1, ''],
    [1, '301'],
    [1, '12,340'],
  ]);
});

test('a totalled column folded away is still summed, in the caption with its head', () => {
  // A field report: at 1280 beside the side menu the fee folded under the title and the row said "Total" over nothing.
  expect(footer(['title', 'status', 'guests'], [{ name: 'quoted_fee', head: 'Quoted fee' }])).toEqual([
    [2, 'Total Quoted fee 12,340'],
    [1, '301'],
  ]);
  expect(
    footer(
      ['title', 'status'],
      [
        { name: 'guests', head: 'Guests' },
        { name: 'quoted_fee', head: 'Quoted fee' },
      ],
    ),
  ).toEqual([[2, 'Total Guests 301 Quoted fee 12,340']]);
});
