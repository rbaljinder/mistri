/**
 * The rail's plain columns: a column with no vocabulary, flag, date or
 * reference shows as what its values are — a number with many values a
 * Min/Max range, with a few a checklist in its own order, text with a few a
 * checklist — judged once over the rows the view stands on; the name column
 * stays the search box; and every count stands on the view's standing
 * condition. Against a breakdown that answers like the server would.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const asked: string[] = [];
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const car: TableMeta = {
  id: 'car',
  name: 'car',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('title', 'TEXT'),
    col('make', 'TEXT'),
    col('price', 'INTEGER'),
    col('year', 'INTEGER'),
    col('status', 'TEXT', { allowed: ['listed', 'sold'] }),
  ] as TableMeta['columns'],
};

const many = (column: string, n: number) => ({
  columns: [column, 'count'],
  rows: Array.from({ length: n }, (_, i) => ({ [column]: 1000 * (i + 1), count: 1 })),
});

vi.mock('../core.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    state: { activeConnection: 'demo', page: 0, schema: { tables: [car], foreignKeys: [] } },
    findTable: (id: string) => (id === 'car' ? car : undefined),
    api: async (path: string, body: { text?: string }) => {
      if (path !== '/api/breakdown') return {};
      const text = String(body.text);
      asked.push(text);
      if (text.includes('by price')) return many('price', 40);
      if (text.includes('by year'))
        return {
          columns: ['year', 'count'],
          rows: [
            { year: 2021, count: 9 },
            { year: 2018, count: 2 },
            { year: 2019, count: 5 },
          ],
        };
      if (text.includes('by make'))
        return {
          columns: ['make', 'count'],
          rows: [
            { make: 'Toyota', count: 12 },
            { make: 'Honda', count: 7 },
          ],
        };
      if (text.includes('by status')) return { columns: ['status', 'count'], rows: [{ status: 'listed', count: 55 }] };
      return { columns: [], rows: [] };
    },
  };
});

const { FilterRail } = await import('./FilterRail.js');
const { boxesFor } = await import('./FilterBoxes.js');

const words: Record<string, string> = { title: 'Title', make: 'Make', price: 'Price', year: 'Year', status: 'Status' };

function draw(names: string[], refinement = '', props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <FilterRail table={car} boxes={boxesFor(car, names, (name) => words[name])} refinement={refinement} onChange={onChange} {...props} />
    </QueryClientProvider>,
  );
  return { onChange };
}

/* A plain column's facet is its name alone, busy, until its shape is known;
   the facet it then becomes is a new element, so wait for that one. */
const settled = (name: string) =>
  waitFor(() => {
    const group = screen.getByRole('group', { name });
    expect(group).not.toHaveAttribute('aria-busy');
    return group;
  });

beforeEach(() => {
  asked.length = 0;
});
afterEach(() => cleanup());

test('a number with many values is a Min/Max range in its currency, applied on Enter, one condition for both ends', async () => {
  const { onChange } = draw(['price'], '', { unitOf: (column: string) => (column === 'price' ? { currency: 'USD' } : undefined) });
  const price = await settled('Price');
  const min = within(price).getByLabelText('Min');
  expect(within(price).getAllByText('$')).toHaveLength(2);
  // Typed a digit at a time, it is not a question at every digit.
  fireEvent.change(min, { target: { value: '5,000' } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(min, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('price >= 5000');
  const max = within(price).getByLabelText('Max');
  fireEvent.change(max, { target: { value: '15000' } });
  fireEvent.blur(max);
  expect(onChange).toHaveBeenLastCalledWith('price between 5000 and 15000');
});

test('a range reads its ends back from the question, and Clear takes it out', async () => {
  const user = userEvent.setup();
  const { onChange } = draw(['price'], 'price between 5000 and 15000');
  const price = await settled('Price');
  expect(within(price).getByLabelText('Min')).toHaveValue('5000');
  expect(within(price).getByLabelText('Max')).toHaveValue('15000');
  await user.click(within(price).getByRole('button', { name: 'Clear Price' }));
  expect(onChange).toHaveBeenLastCalledWith('');
});

test('a number with a few values is a checklist in its own order; text with a few, the most first; the name column is the search', async () => {
  const user = userEvent.setup();
  const { onChange } = draw(['title', 'make', 'year']);
  const year = await settled('Year');
  expect(await within(year).findByRole('checkbox', { name: '2018 2' })).toBeInTheDocument();
  expect(
    within(year)
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('data-value')),
  ).toEqual(['2018', '2019', '2021']);
  const make = await settled('Make');
  expect(
    within(make)
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('data-value')),
  ).toEqual(['Toyota', 'Honda']);
  await user.click(within(make).getByRole('checkbox', { name: 'Honda 7' }));
  expect(onChange).toHaveBeenLastCalledWith('make = Honda');
  // The name is what a reader searches by: a contains box, never a checklist of every title.
  expect(screen.getByLabelText('Title')).toHaveAttribute('type', 'search');
});

test('the shape is judged over the rows the view stands on; every count stands on them too', async () => {
  draw(['make', 'status'], 'make = Toyota', { standing: 'status != sold' });
  await screen.findByRole('group', { name: 'Make' });
  await within(screen.getByRole('group', { name: 'Status' })).findByRole('checkbox', { name: 'Listed 55' });
  expect(asked).toContain('car status != sold count by make sort count desc');
  expect(asked).toContain('car status != sold and make = Toyota count by status sort count desc');
});

test('beside a list whose chips carry their own Clear all, the rail draws none', () => {
  draw(['status'], 'status = listed', { clearAll: false });
  expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
});
