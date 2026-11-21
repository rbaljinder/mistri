/**
 * A phone's cards, from a field report: a card does not say its title again as a value (the record's label is a column,
 * and it is the title), and a clamped or stacked text keeps whole lines inside its card, never cut through one.
 */
import { readFileSync } from 'node:fs';
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
const subtitles: Record<string, string> = {};
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

const rows = [{ id: 1, title: '2021 Toyota Corolla', trim: 'LE', price: 14995, terms: '', dealer: 'Bay Motors', city: 'Oakland' }];

function draw(spec: AppCardsList) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CardsList table={vehicle} rows={rows} spec={spec} label="Vehicles" />
    </QueryClientProvider>,
  );
}
afterEach(cleanup);

test("the column a card is titled by is left out of the card's values", () => {
  draw({
    kind: 'cards',
    primary: 'title',
    value: 'title',
    badge: 'title',
    description: 'title',
    facts: ['title', 'trim'],
    lines: ['title', 'dealer'],
    footer: ['title', 'city'],
  });
  const [card] = within(screen.getByRole('list', { name: 'Vehicles' })).getAllByRole('listitem');
  expect(within(card).getAllByText('2021 Toyota Corolla')).toHaveLength(1);
  expect(card.querySelector('.cards-summary')?.textContent).toContain('LE');
  expect(card.querySelector('.cards-facts')?.textContent).toContain('Bay Motors');
  expect(card.querySelector('.cards-foot')?.textContent).toContain('Oakland');
});

test('a clamped description and a wrapped stacked cell are never shrunk below their lines', () => {
  /* happy-dom lays nothing out, so the rule is read from the sheets: an overflow-clipped flex item may shrink below its
     text and cut its last line through, so each is `flex: none` and takes the height of its whole lines. */
  const page = readFileSync('packages/kit/src/client/page.css', 'utf8');
  const features = readFileSync('packages/kit/src/client/features.css', 'utf8');
  expect(page).toMatch(/\.cards-description \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;[^}]*flex: none;/);
  expect(features).toMatch(/td\.has-more \.cell-main \{[^}]*white-space: normal;[^}]*flex: none;/);
});
