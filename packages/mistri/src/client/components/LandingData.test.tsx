/**
 * The landing's sections that read rows: a search that writes the list's
 * own conditions into the list's own address, a ceiling of round figures
 * for a price, and a view of cards asked with the list's question, sorted
 * and bounded.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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
    { name: 'make', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'model', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'body_type', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['Hatchback', 'SUV'] } as TableMeta['columns'][number],
    { name: 'price', type: 'INTEGER', nullable: false, primaryKey: false },
  ],
};
const vehicles = {
  id: 'vehicles',
  table: 'vehicle',
  label: 'Vehicles',
  query: 'status != sold',
  show: ['title', 'price'],
  presentation: { kind: 'cards', primary: 'title', value: 'price' },
  filters: ['make', 'model', 'body_type', 'price'],
};
const mocks = vi.hoisted(() => ({ api: vi.fn(), go: vi.fn(), state: { activeConnection: 'forecourt', page: 3 } }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  go: mocks.go,
  state: mocks.state,
  findTable: () => vehicle,
  columnLabel: (_t: string, column: string) => (({ body_type: 'Body' }) as Record<string, string>)[column] ?? null,
  columnDisplay: () => ({ format: 'money', currency: 'GBP' }),
  quote: (value: string) => (/^[\w.-]+$/.test(value) ? value : `"${value}"`),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query, tab: 'rows' }),
  pageView: (pageId: string) => ({ kind: 'page', pageId }),
}));
vi.mock('../appState.js', () => ({ activeApp: () => ({ views: { vehicles } }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/components/appRooms.js', () => ({
  viewRoom: (_app: unknown, key: string) => (key === 'vehicles' ? vehicles : undefined),
  isListRoom: () => true,
  dashPageId: (key: string) => `dash-${key}`,
}));
/* The list's own query plumbing: the question with its show clause, and back. */
vi.mock('../../../../kit/src/client/components/appListModel.js', () => ({
  specTabs: () => [{ label: 'All' }],
  appListQuery: () => 'vehicle status != sold show title, price, id',
  visibleQuestion: () => 'status != sold',
  wholeQuery: (_spec: unknown, typed: string) => `vehicle ${typed} show title, price, id`,
}));
vi.mock('../../../../kit/src/client/filterbar.js', () => ({
  equalsTail: (value: string) => `= ${value}`,
  withCondition: (text: string, column: string, tail: string) => `${text} and ${column} ${tail}`,
}));
vi.mock('../../../../kit/src/client/deeplink.js', () => ({
  hashFor: (connection: string, [entry]: Array<{ view?: string; query: string }>) =>
    `/${connection}/${entry.view}:${encodeURIComponent(entry.query)}`,
}));
vi.mock('../../../../kit/src/client/requestIdentity.js', () => ({ ownedBy: (connection: string) => ({ connection }) }));
vi.mock('../../../../kit/src/client/components/valueModel.js', () => ({
  dressFor: (_rule: unknown, n: number) => ({ text: `$${n.toLocaleString('en-US')}` }),
  choiceWord: (_rule: unknown, value: string) => value,
}));
vi.mock('../../../../kit/src/client/components/Dropdown.js', () => ({
  Dropdown: ({
    items,
    value,
    onChange,
    ariaLabel,
  }: {
    items: Array<{ value: string; label: string }>;
    value: string;
    onChange: (v: string) => void;
    ariaLabel: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('../../../../kit/src/client/components/CardsList.js', () => ({
  CardsList: ({ rows, label }: { rows: Array<{ title: string }>; label: string }) => (
    <ul aria-label={label}>
      {rows.map((row) => (
        <li key={row.title}>{row.title}</li>
      ))}
    </ul>
  ),
}));
const { LandingCards, LandingSearch, priceSteps } = await import('./LandingData.js');
const { viewLink } = await import('../../../../kit/src/client/components/viewLink.js');

function draw(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
beforeEach(() => {
  mocks.api.mockReset();
  mocks.go.mockReset();
  mocks.state.page = 3;
  mocks.api.mockImplementation(async (path: string, body: { text?: string; q?: string }) => {
    if (path === '/api/breakdown' && body.text?.endsWith('max price')) return { rows: [{ max: 47995 }] };
    if (path === '/api/breakdown' && body.text?.endsWith('count by make'))
      return {
        columns: ['make', 'count'],
        rows: [
          { make: 'Toyota', count: 3 },
          { make: 'Ford', count: 2 },
        ],
      };
    if (path === '/api/breakdown' && body.text?.endsWith('count by model')) {
      return { columns: ['model', 'count'], rows: Array.from({ length: 25 }, (_, i) => ({ model: `Model ${i}`, count: 1 })) };
    }
    if (path === '/api/run')
      return {
        rows: [
          { id: 1, title: '2021 Toyota Corolla' },
          { id: 2, title: '2019 Ford Focus' },
        ],
      };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

test('a most-you-would-pay is round figures up to the highest price', () => {
  expect(priceSteps(47995)).toEqual([4000, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000, 50000]);
  expect(priceSteps(900)).toEqual([75, 100, 150, 200, 250, 300, 400, 500, 750, 1000]);
  expect(priceSteps(0)).toEqual([]);
});

test('the search asks each field as the list would: a vocabulary or a short list is a choice, a long one is typed, a number is a ceiling', async () => {
  draw(
    <LandingSearch
      section={{
        kind: 'search',
        title: 'Search the forecourt',
        view: 'vehicles',
        filters: ['make', 'model', 'body_type', 'price'],
        submitLabel: 'Show vehicles',
      }}
    />,
  );
  const make = await screen.findByRole('combobox', { name: 'Make' });
  expect([...make.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Any', 'Ford', 'Toyota']);
  expect(screen.getByRole('searchbox', { name: 'Model' })).toBeInTheDocument();
  expect([...screen.getByRole('combobox', { name: 'Body' }).querySelectorAll('option')].map((option) => option.textContent)).toEqual([
    'Any',
    'Hatchback',
    'SUV',
  ]);
  const price = screen.getByRole('combobox', { name: 'Max price' });
  expect(price.querySelector('option')!.textContent).toBe('No limit');
  // A ceiling is a round figure, said without cents, in the rule's currency.
  expect(screen.getByRole('option', { name: '£20,000' })).toBeInTheDocument();
  // Each question is the list's own, narrowed by its standing conditions.
  expect(mocks.api).toHaveBeenCalledWith(
    '/api/breakdown',
    expect.objectContaining({ text: 'vehicle status != sold count by make', connection: 'forecourt' }),
  );
});

test('submitting opens the list with exactly the conditions its boxes would write, on its first page', async () => {
  draw(<LandingSearch section={{ kind: 'search', view: 'vehicles', filters: ['make', 'model', 'body_type', 'price'] }} />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Make' }), 'Toyota');
  await user.type(screen.getByRole('searchbox', { name: 'Model' }), 'Corolla Cross');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Max price' }), '20000');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(mocks.go).toHaveBeenCalledWith(
    {
      kind: 'table',
      table: 'vehicle',
      tab: 'rows',
      view: 'vehicles',
      query: 'vehicle status != sold and make = Toyota and model contains "Corolla Cross" and price <= 20000 show title, price, id',
    },
    'push',
  );
  expect(mocks.state.page).toBe(0);
});

test("a view section asks the list's question sorted and bounded, draws its cards, and links to the whole list", async () => {
  draw(<LandingCards section={{ kind: 'view', title: 'Recommended', view: 'vehicles', limit: 6, sort: 'price desc' }} />);
  expect(await screen.findByRole('list', { name: 'Recommended' })).toHaveTextContent('2021 Toyota Corolla');
  expect(mocks.api).toHaveBeenCalledWith(
    '/api/run',
    expect.objectContaining({ q: 'vehicle status != sold sort price desc show title, price, id', limit: 6, offset: 0 }),
  );
  const more = screen.getByRole('link', { name: 'See all vehicles' });
  expect(more.getAttribute('href')).toBe(`/forecourt/vehicles:${encodeURIComponent('vehicle status != sold show title, price, id')}`);
  await userEvent.setup().click(more);
  expect(mocks.go).toHaveBeenCalledWith(expect.objectContaining({ view: 'vehicles', table: 'vehicle' }), 'push');
});

test('a view the App does not serve has no link', () => {
  expect(viewLink('inquiries')).toBeUndefined();
});
