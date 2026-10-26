/**
 * A column folded under the row's name is said with its head ("Phase Open"), except where the words the cell draws
 * already begin with it: tested against what is drawn, not the stored value, which a reference's label or a display
 * rule may say differently.
 */
import { expect, test } from 'vitest';
import { foldedOf } from './Grid.js';

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
