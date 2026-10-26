/**
 * A money column kept in minor units, in the rail: the checklist names a value as the cards do ($1,795, not the
 * stored 179500) and a range's boxes read and take major amounts. The question underneath stays in the stored unit,
 * so an address, a chip and a saved view mean the same thing whichever way they were reached.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const unit: TableMeta = {
  id: 'unit',
  name: 'unit',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('rent', 'INTEGER')] as TableMeta['columns'],
};
const rule = { format: 'money', minor: true, currency: 'USD' };
/* Two values: a checklist. Many: a range. */
let rows: number[] = [179500, 225000];

vi.mock('../core.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    state: { activeConnection: 'demo', page: 0, schema: { tables: [unit], foreignKeys: [] } },
    findTable: (id: string) => (id === 'unit' ? unit : undefined),
    columnDisplay: (_table: string, column: string) => (column === 'rent' ? rule : null),
    api: async (path: string) =>
      path === '/api/breakdown' ? { columns: ['rent', 'count'], rows: rows.map((rent) => ({ rent, count: 1 })) } : {},
  };
});

const { FilterRail } = await import('./FilterRail.js');
const { boxesFor } = await import('./FilterBoxes.js');

function draw(refinement = '') {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FilterRail
        table={unit}
        boxes={boxesFor(unit, ['rent'], () => 'Asking rent')}
        refinement={refinement}
        unitOf={() => ({ currency: 'USD' })}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
  return { onChange };
}
const settled = () =>
  waitFor(() => {
    const group = screen.getByRole('group', { name: 'Asking rent' });
    expect(group).not.toHaveAttribute('aria-busy');
    return group;
  });

afterEach(() => cleanup());

test('a checklist of rents names each as the cards do, and ticking one asks for the stored value', async () => {
  rows = [179500, 225000];
  const user = userEvent.setup();
  const { onChange } = draw();
  const group = await settled();
  const box = await within(group).findByRole('checkbox', { name: '$1,795 1' });
  expect(within(group).getByRole('checkbox', { name: '$2,250 1' })).toBeInTheDocument();
  await user.click(box);
  expect(onChange).toHaveBeenLastCalledWith('rent = 179500');
});

test('a range reads its ends in the major unit and takes them in it, the question staying in minor units', async () => {
  rows = Array.from({ length: 40 }, (_, i) => 100000 * (i + 1));
  const { onChange } = draw('rent between 100000 and 200050');
  const group = await settled();
  expect(within(group).getByLabelText('Min')).toHaveValue('1000');
  expect(within(group).getByLabelText('Max')).toHaveValue('2000.50');
  const min = within(group).getByLabelText('Min');
  fireEvent.change(min, { target: { value: '1,795' } });
  fireEvent.keyDown(min, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('rent between 179500 and 200050');
});
