/**
 * A card draws a column's display `subtitle` where it has room for a second line: under its title, its figure and
 * each of its properties, quiet and close under the value. A badge has one line, so it stays the value alone.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppCardsList } from '../../../../mistri/src/shared/app.js';

const vehicle: TableMeta = {
  id: 'vehicle',
  name: 'vehicle',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'trim', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'price', type: 'INTEGER', nullable: false, primaryKey: false },
    { name: 'terms', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'dealer', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'city', type: 'TEXT', nullable: true, primaryKey: false },
  ],
};
const subtitles: Record<string, string> = { title: 'trim', price: 'terms', dealer: 'city' };
vi.mock('../core.js', async () => ({
  primaryKey: (await import('../../../../engine/src/shared/schema.js')).primaryKey,
  api: vi.fn(),
  openRecord: vi.fn(),
  state: { activeConnection: 'market', schema: { foreignKeys: [] } },
  columnDisplay: (_table: string, column: string) => (subtitles[column] ? { subtitle: subtitles[column] } : null),
  columnLabel: () => null,
  findTable: () => vehicle,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
  refsFrom: () => [],
  quote: (await import('../../../../engine/src/shared/query.js')).quoteValue,
}));
vi.mock('../requestIdentity.js', () => ({ ownedBy: (connection: string | null) => (connection ? { connection } : {}) }));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span className="value">{String(value)}</span> }));
const { CardsList } = await import('./CardsList.js');

const rows = [
  { id: 1, title: '2021 Toyota Corolla', trim: 'LE', price: 14995, terms: 'or $289 a month', dealer: 'Bay Motors', city: 'Oakland' },
  { id: 2, title: '2019 Ford Focus', trim: null, price: 9495, terms: '', dealer: 'Hill Cars', city: null },
];

function draw(spec: AppCardsList) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CardsList table={vehicle} rows={rows} spec={spec} label="Vehicles" />
    </QueryClientProvider>,
  );
}
afterEach(cleanup);

test("a card's title, figure and properties draw their second lines; a row without one draws none", () => {
  draw({ kind: 'cards', primary: 'title', value: 'price', lines: ['dealer'] });
  const [first, second] = within(screen.getByRole('list', { name: 'Vehicles' })).getAllByRole('listitem');
  // Under the title, not in it: the button that opens the card is still named by the title alone.
  expect(within(first).getByRole('button', { name: '2021 Toyota Corolla' })).toBeInTheDocument();
  expect(first.querySelector('.cards-title + .cards-subtitle')?.textContent).toBe('LE');
  expect(first.querySelector('.cards-value .value-sub')?.textContent).toBe('or $289 a month');
  expect(first.querySelector('.cards-fact dd .value-sub')?.textContent).toBe('Oakland');
  expect(second.querySelector('.cards-subtitle, .value-sub')).toBeNull();
});

test('a badge has one line, so it is its value alone', () => {
  draw({ kind: 'cards', primary: 'id', badge: 'dealer' });
  const [first] = within(screen.getByRole('list', { name: 'Vehicles' })).getAllByRole('listitem');
  expect(first.querySelector('.cards-badge')?.textContent).toBe('Bay Motors');
  expect(first.querySelector('.value-sub')).toBeNull();
});
