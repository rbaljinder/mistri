/**
 * A card's facts: its values said in one line under the figure, each after
 * a dot, each caption kept for assistive technology, an empty one left out;
 * and a line that names another record through a label path.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const vehicle: TableMeta = {
  id: 'vehicle',
  name: 'vehicle',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'price', type: 'INTEGER', nullable: false, primaryKey: false },
    { name: 'year', type: 'INTEGER', nullable: false, primaryKey: false },
    { name: 'mileage', type: 'INTEGER', nullable: true, primaryKey: false },
    { name: 'fuel', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
vi.mock('../core.js', () => ({
  api: vi.fn(async () => ({ rows: [] })),
  openRecord: vi.fn(),
  state: { activeConnection: 'market', schema: { foreignKeys: [] } },
  columnLabel: (_t: string, column: string) =>
    (({ 'dealer_id.name': 'Dealer', mileage: 'Miles' }) as Record<string, string>)[column] ?? null,
  findTable: () => undefined,
  refsFrom: () => [],
  columnDisplay: (_t: string, column: string) => (column === 'title' ? { masked: { prefix: 'ENC:' } } : null),
  keyOf: (_t: unknown, row: Record<string, unknown>) => ({ id: row.id }),
  quote: (value: string) => `"${value}"`,
}));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span className="value">{String(value)}</span> }));
vi.mock('../requestIdentity.js', () => ({ ownedBy: () => ({}) }));
const { CardsList } = await import('./CardsList.js');

afterEach(cleanup);

test('a card says its facts in one line, captions kept for assistive technology, an empty value left out', () => {
  const rows = [
    {
      id: 1,
      title: '2019 Tesla Model 3 Long Range',
      price: 12995,
      year: 2019,
      mileage: 85780,
      fuel: 'Electric',
      'dealer_id.name': 'Kingsway Auto Center',
    },
    { id: 2, title: '2021 Toyota Camry SE', price: 11995, year: 2021, mileage: null, fuel: 'Hybrid', 'dealer_id.name': 'Northgate Cars' },
  ];
  const client = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={client}>
      <CardsList
        table={vehicle}
        rows={rows}
        label="Vehicles"
        spec={{ kind: 'cards', primary: 'title', value: 'price', facts: ['year', 'mileage', 'fuel'], lines: ['dealer_id.name'] }}
      />
    </QueryClientProvider>,
  );
  const summaries = container.querySelectorAll('.cards-summary');
  expect(summaries[0]).toHaveTextContent('Year: 2019Miles: 85780Fuel: Electric');
  expect(summaries[0].querySelectorAll('.visually-hidden')).toHaveLength(3);
  expect(summaries[1].querySelectorAll('.cards-summary-item')).toHaveLength(2);
  // A line through a reference: its caption is the App's, its value the other record's.
  expect(screen.getAllByText('Dealer')).toHaveLength(2);
  expect(screen.getByText('Kingsway Auto Center')).toBeInTheDocument();
});

test('a fact with a word says it after its value, plural past one, and a masked title draws the placeholder', () => {
  const owned: TableMeta = {
    ...vehicle,
    columns: [...vehicle.columns, { name: 'owners', type: 'INTEGER', nullable: true, primaryKey: false }],
  };
  const rows = [
    { id: 1, title: 'ENC:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', price: 1, year: 2020, owners: 1 },
    { id: 2, title: 'Plain title', price: 1, year: 2021, owners: 3 },
  ];
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <CardsList
        table={owned}
        rows={rows}
        label="Vehicles"
        spec={{ kind: 'cards', primary: 'title', facts: ['year', 'owners'], factLabels: { owners: { one: 'owner' } } }}
      />
    </QueryClientProvider>,
  );
  const summaries = container.querySelectorAll('.cards-summary');
  expect(summaries[0]).toHaveTextContent('Year: 20201 owner');
  expect(summaries[1]).toHaveTextContent('3 owners');
  // The worded fact's word is its caption for everyone, so it carries no hidden one.
  expect(summaries[0].querySelectorAll('.visually-hidden')).toHaveLength(1);
  expect(screen.queryByText(/QUJD/)).toBeNull();
  expect(screen.getByRole('button', { name: 'ENC:••••••' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Plain title' })).toBeInTheDocument();
});
