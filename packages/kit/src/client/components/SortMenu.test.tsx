/**
 * A list's Sort menu: the choice is the query's own sort clause, however it
 * is spaced; choosing one replaces the clause and keeps the rest of the
 * question; Default order takes it off; a sort no choice names lights none.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SortMenu, sortChoice, withSort } from './SortMenu.js';

const sorts = [
  { label: 'Lowest price', sort: 'price' },
  { label: 'Highest price', sort: 'price desc' },
  { label: 'Newest model year', sort: 'year desc, mileage' },
];
afterEach(cleanup);

test('the query’s own sort clause is the choice, an explicit asc and its spacing aside', () => {
  expect(sortChoice(sorts, 'vehicle status != sold')).toBe(-1);
  expect(sortChoice(sorts, 'vehicle status != sold sort price')).toBe(0);
  expect(sortChoice(sorts, 'vehicle status != sold sort price asc')).toBe(0);
  expect(sortChoice(sorts, 'vehicle sort price  desc')).toBe(1);
  expect(sortChoice(sorts, 'vehicle sort year desc,mileage')).toBe(2);
  // A sort the reader typed that no choice names lights none of them.
  expect(sortChoice(sorts, 'vehicle sort mileage')).toBe(-1);
});

test('choosing replaces the sort clause and keeps the rest; the default takes it off', () => {
  expect(withSort('vehicle status != sold show title, price', 'price desc')).toBe(
    'vehicle status != sold show title, price sort price desc',
  );
  expect(withSort('vehicle status != sold sort price show title', 'year desc')).toBe('vehicle status != sold show title sort year desc');
  expect(withSort('vehicle status != sold sort price', undefined)).toBe('vehicle status != sold');
});

test("where the view's own order is a choice, that choice is the default and is named", () => {
  const picked: string[] = [];
  render(<SortMenu sorts={sorts} sort="price" query="vehicle status != sold" onPick={(query) => picked.push(query)} />);
  expect(screen.getByText('Lowest price')).toBeInTheDocument();
  expect(screen.queryByText('Default order')).not.toBeInTheDocument();
  cleanup();
  // A view order no choice names keeps the plain default.
  render(<SortMenu sorts={sorts} sort="listed_on desc" query="vehicle status != sold" onPick={() => {}} />);
  expect(screen.getByText('Default order')).toBeInTheDocument();
});

test('the menu says the chosen order, and Default order when none is chosen', () => {
  render(<SortMenu sorts={sorts} query="vehicle sort price desc" onPick={() => {}} />);
  expect(screen.getByText('Highest price')).toBeInTheDocument();
  cleanup();
  render(<SortMenu sorts={sorts} query="vehicle status != sold" onPick={() => {}} />);
  expect(screen.getByText('Default order')).toBeInTheDocument();
});
