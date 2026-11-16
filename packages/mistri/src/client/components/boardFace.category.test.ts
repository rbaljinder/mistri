/** A board card's category on a reference: said by the record's name, coloured by its key. */
import { expect, test } from 'vitest';
import { cardCategory } from './boardFace.js';

test('a category that references another table is said by that record’s name, never by its key', () => {
  const byKey = cardCategory('order', 'category_id', 7);
  const named = cardCategory('order', 'category_id', 7, 'Grinders');
  expect(byKey?.label).toBe('7');
  expect(named?.label).toBe('Grinders');
  // The colour is the key's: renaming the category does not recolour its cards.
  expect(named?.color).toBe(byKey?.color);
  // No name read (a plain choice column): its own word, as before.
  expect(cardCategory('order', 'kind', 'express', 'express')?.label).toBe(cardCategory('order', 'kind', 'express')?.label);
});
