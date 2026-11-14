import { expect, test } from 'vitest';
import { type ListState, listStateFromWords, listStateToWords } from '../src/listState';

/* A list's place said as address words and read back: what Back, a reload and a pasted link all depend on. */
const FILTERS = ['building', 'beds'];
const FIRST: Partial<ListState> = { tab: 'all', sort: { column: 'code', descending: false } };
const read = (words: Record<string, string | undefined>) => listStateFromWords((word) => words[word], FILTERS);

test('an untouched list has a bare address', () => {
  const words = listStateToWords(
    { tab: 'all', search: '', filters: {}, sort: { column: 'code', descending: false }, page: 1 },
    FILTERS,
    FIRST,
  );
  expect(Object.values(words).filter((word) => word !== undefined)).toEqual([]);
});

test('a place survives the address', () => {
  const state: ListState = {
    tab: 'behind',
    search: 'birch',
    filters: { building: ['Birchwood Lofts', 'Aspen Court'], beds: ['Studio'] },
    sort: { column: 'rent', descending: true },
    page: 3,
  };
  const words = listStateToWords(state, FILTERS, FIRST);
  expect(words).toEqual({
    tab: 'behind',
    search: 'birch',
    sort: '-rent',
    page: '3',
    building: 'Birchwood Lofts,Aspen Court',
    beds: 'Studio',
  });
  expect(read(words)).toEqual(state);
});

test('a filter value holding a comma is still one value', () => {
  const words = listStateToWords({ tab: null, search: '', filters: { building: ['Lofts, North', 'a\\b'] }, sort: null, page: 1 }, FILTERS);
  expect(read(words).filters).toEqual({ building: ['Lofts, North', 'a\\b'] });
});

test('words that say nothing leave the list its defaults', () => {
  expect(read({ page: '0', sort: '', building: '' })).toEqual({});
  expect(read({ page: 'x' })).toEqual({});
});

test('the columns a reader chose ride in the address, and an untouched table says nothing', () => {
  const state: ListState = { tab: null, search: '', filters: {}, sort: null, page: 1, columns: ['code', 'rent', 'status'] };
  expect(listStateToWords(state, FILTERS).cols).toBe('code,rent,status');
  expect(read({ cols: 'code,rent,status' }).columns).toEqual(['code', 'rent', 'status']);
  expect(listStateToWords({ ...state, columns: null }, FILTERS).cols).toBeUndefined();
});
