/**
 * The cards presentation, drawn and driven: a card per record with its
 * title, figure, facts and badge; a picture from a column or from a related
 * file resource asked once for the page; a placeholder where there is none;
 * and the whole card one button that opens the record.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppCardsList } from '../../../../mistri/src/shared/app.js';
import type { ListOrder } from './useListOrder.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  state: { activeConnection: 'market', schema: { foreignKeys: [] as unknown[] } },
}));
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
    { name: 'fuel', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'highlight', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'photo_url', type: 'TEXT', nullable: true, primaryKey: false },
  ],
};
const photo: TableMeta = {
  id: 'vehicle_photo',
  name: 'vehicle_photo',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'vehicle_id', type: 'INTEGER', nullable: false, primaryKey: false },
    { name: 'position', type: 'INTEGER', nullable: false, primaryKey: false },
  ],
};
vi.mock('../core.js', async () => ({
  primaryKey: (await import('../../../../engine/src/shared/schema.js')).primaryKey,
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  // Fuel maps its values to icons, as a card's icon column does (cardsProblem).
  columnDisplay: (_table: string, column: string) =>
    column === 'fuel' ? { icons: { Hybrid: 'leaf' } } : column === 'highlight' ? { values: { 'One owner': 'Single owner' } } : null,
  columnLabel: (_table: string, column: string) => (({ fuel: 'Fuel type' }) as Record<string, string>)[column] ?? null,
  findTable: (id: string) => (id === 'vehicle_photo' ? photo : vehicle),
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
  refsFrom: () => [],
  // The real rule, not a copy of it: a copy is what hid a slug carrying `select`.
  quote: (await import('../../../../engine/src/shared/query.js')).quoteValue,
}));
vi.mock('../requestIdentity.js', () => ({ ownedBy: (connection: string | null) => (connection ? { connection } : {}) }));
/* The value's own dress is Value's business, tested there; here it is its text. */
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span className="value">{String(value)}</span> }));
const { CardsList, cardImageAddress } = await import('./CardsList.js');
const { canShowCards } = await import('./cardsModel.js');

const rows = [
  {
    id: 1,
    title: '2021 Toyota Corolla',
    price: 14995,
    year: 2021,
    fuel: 'Hybrid',
    highlight: 'One owner',
    photo_url: 'https://images.example.test/1.png',
  },
  { id: 2, title: '2019 Ford Focus', price: 9495, year: 2019, fuel: 'Gas', highlight: null, photo_url: 'javascript:alert(1)' },
];
const byColumn: AppCardsList = {
  kind: 'cards',
  primary: 'title',
  value: 'price',
  badge: 'highlight',
  lines: ['year', 'fuel'],
  image: 'photo_url',
};
const byFile: AppCardsList = {
  kind: 'cards',
  primary: 'title',
  value: 'price',
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
};

function draw(spec: AppCardsList, interactive = true, recordNavigation = false, order?: ListOrder) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CardsList
        table={vehicle}
        rows={rows}
        spec={spec}
        interactive={interactive}
        recordNavigation={recordNavigation}
        order={order}
        label="Vehicles"
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.api.mockReset();
  mocks.open.mockReset();
  mocks.state.schema.foreignKeys = [
    { from: { table: 'vehicle_photo', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } },
  ];
});
afterEach(cleanup);

test('a card per record: the title as its one button, the figure, each fact under its caption, the badge only where there is one', () => {
  draw(byColumn);
  const list = screen.getByRole('list', { name: 'Vehicles' });
  const cards = within(list).getAllByRole('listitem');
  expect(cards).toHaveLength(2);
  const first = within(cards[0]);
  expect(first.getByRole('button', { name: '2021 Toyota Corolla' })).toBeInTheDocument();
  expect(first.getByText('14995', { selector: '.cards-value .value' })).toBeInTheDocument();
  // The caption is the App's word where it has one, the humanised column otherwise.
  expect(first.getByText('Fuel type', { selector: 'dt' })).toBeInTheDocument();
  expect(first.getByText('Year', { selector: 'dt' })).toBeInTheDocument();
  expect(first.getByText('One owner')).toBeInTheDocument();
  expect(cards[1].querySelector('.cards-badge')).toBeNull();
  expect(within(cards[1]).getAllByRole('button')).toHaveLength(1);
});

test('a picture from a column is drawn when it is https or on this server, the first row first; anything else is the placeholder', () => {
  draw(byColumn);
  const [first, second] = screen.getAllByRole('listitem');
  const image = first.querySelector('img')!;
  expect(image).toHaveAttribute('src', 'https://images.example.test/1.png');
  // The first row is the page's largest paint: asked for at once, and first.
  expect(image).toHaveAttribute('loading', 'eager');
  expect(image).toHaveAttribute('fetchpriority', 'high');
  expect(image).not.toHaveAttribute('srcset');
  expect(image).toHaveAttribute('alt', '');
  expect(second.querySelector('img')).toBeNull();
  expect(second.querySelector('.cards-placeholder')).not.toBeNull();
  expect(cardImageAddress('/api/file?key=1')).toBe('/api/file?key=1');
  for (const refused of [
    '//evil.example/1.png',
    'http://example.test/1.png',
    'data:image/png;base64,AA',
    'javascript:alert(1)',
    42,
    null,
  ]) {
    expect(cardImageAddress(refused)).toBeUndefined();
  }
});

test('a picture from a file resource: one question for the page, the first file of each record by the sort, drawn inline', async () => {
  mocks.api.mockResolvedValue({
    rows: [
      { id: 11, vehicle_id: 1 },
      { id: 12, vehicle_id: 1 },
      { id: 21, vehicle_id: 2 },
    ],
  });
  draw(byFile);
  await vi.waitFor(() => expect(screen.getAllByRole('listitem')[1].querySelector('img')).not.toBeNull());
  expect(mocks.api).toHaveBeenCalledTimes(1);
  const [path, body] = mocks.api.mock.calls[0];
  expect(path).toBe('/api/run');
  expect(body.q).toBe('vehicle_photo vehicle_id in (1, 2) sort vehicle_id, position asc show id, vehicle_id');
  expect(body.connection).toBe('market');
  const [first, second] = screen
    .getAllByRole('listitem')
    .map((card) => new URL(card.querySelector('img')!.getAttribute('src')!, 'http://x'));
  expect(first.pathname).toBe('/api/file');
  expect(first.searchParams.get('table')).toBe('vehicle_photo');
  expect(JSON.parse(first.searchParams.get('key')!)).toEqual({ id: 11 });
  expect(first.searchParams.get('inline')).toBe('1');
  // The thumbnail, with the file made at the widths a card is drawn at for the browser to choose (`w=`, server imageVariants.ts).
  expect(first.searchParams.get('variant')).toBe('thumb');
  const image = screen.getAllByRole('listitem')[0].querySelector('img')!;
  const candidates = image.getAttribute('srcset')!.split(', ');
  expect(candidates.map((candidate) => candidate.split(' ')[1])).toEqual(['320w', '480w', '640w', '960w']);
  const full = new URL(candidates[2].replace(/ 640w$/, ''), 'http://x');
  expect(full.searchParams.get('variant')).toBeNull();
  expect(full.searchParams.get('w')).toBe('640');
  expect(JSON.parse(full.searchParams.get('key')!)).toEqual({ id: 11 });
  expect(JSON.parse(second.searchParams.get('key')!)).toEqual({ id: 21 });
});

test('a picture from a file resource survives keys that carry words of the query language', async () => {
  /* A dealer's slugs are words: `select` in a trim level, `limit` and `show`
     in a model name. Left bare they were read as clauses, the page's one
     photo question was refused, and every card lost its picture. */
  const slugs = ['2023-mazda-cx-5-select-lf1015', 'ford-show-limit-2', 'me', 'today'];
  const slugged: TableMeta = {
    ...vehicle,
    columns: vehicle.columns.map((column) => (column.name === 'id' ? { ...column, type: 'TEXT' } : column)),
  };
  const slugPhoto: TableMeta = {
    ...photo,
    columns: photo.columns.map((column) => (column.name === 'vehicle_id' ? { ...column, type: 'TEXT' } : column)),
  };
  mocks.api.mockResolvedValue({ rows: slugs.map((slug, i) => ({ id: i + 1, vehicle_id: slug })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CardsList table={slugged} spec={byFile} label="Vehicles" rows={slugs.map((id) => ({ ...rows[0], id }))} />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(screen.getAllByRole('listitem')[3].querySelector('img')).not.toBeNull());
  const { parseQuery } = await import('../../../../engine/src/shared/query.js');
  const asked = parseQuery(mocks.api.mock.calls[0][1].q, {
    schema: { label: 'm', dialect: 'sqlite', foreignKeys: [], readAt: '', tables: [slugged, slugPhoto] },
    me: { email: 'a@example.com' },
  });
  expect(asked.errors).toEqual([]);
  expect(asked.query!.filter.groups).toEqual([[{ column: 'vehicle_id', op: 'in', value: slugs }]]);
});

test('the whole card opens its record, from the mouse or the keyboard, with the page as its records', async () => {
  draw(byColumn);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '2019 Ford Focus' }));
  expect(mocks.open).toHaveBeenCalledWith('vehicle', { id: 2 }, '2019 Ford Focus', 'push', {
    records: [
      { key: { id: 1 }, label: '2021 Toyota Corolla' },
      { key: { id: 2 }, label: '2019 Ford Focus' },
    ],
  });
  // From the top of the page, the first card is the first tab stop.
  (document.activeElement as HTMLElement | null)?.blur();
  await user.tab();
  expect(screen.getByRole('button', { name: '2021 Toyota Corolla' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(mocks.open).toHaveBeenLastCalledWith('vehicle', { id: 1 }, '2021 Toyota Corolla', 'push', expect.anything());
});

test('drawn read-only, a card is not a button', () => {
  draw(byColumn, false);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('2021 Toyota Corolla')).toBeInTheDocument();
});

test('a read-only card may still open its record without enabling ordering', async () => {
  draw(byColumn, false, true, { column: 'rank', active: true, partial: false });
  await userEvent.setup().click(screen.getByRole('button', { name: '2021 Toyota Corolla' }));
  expect(mocks.open).toHaveBeenCalledWith('vehicle', { id: 1 }, '2021 Toyota Corolla', 'push', expect.anything());
  expect(screen.queryByRole('button', { name: /reorder/i })).toBeNull();
});

test('avatar media frames the existing image as a decorative portrait and falls back to deterministic title initials', () => {
  draw({ kind: 'cards', primary: 'title', image: 'photo_url', media: 'avatar' });
  const [first, second] = screen.getAllByRole('listitem');
  const image = first.querySelector('.cards-media.cards-avatar img')!;
  expect(image).toHaveAttribute('alt', '');
  expect(second.querySelector('.cards-avatar-mark')).toHaveTextContent('2F');
  fireEvent.error(image);
  expect(first.querySelector('.cards-avatar-mark')).toHaveTextContent('2T');
});

test('avatar cards need no image column and keep a single accessible record target', () => {
  draw({ kind: 'cards', primary: 'title', media: 'avatar', badge: 'highlight' });
  const first = screen.getAllByRole('listitem')[0];
  expect(first.querySelector('.cards-avatar-mark')).toHaveTextContent('2T');
  expect(first.querySelector('.cards-avatar-mark')).toHaveAttribute('aria-hidden', 'true');
  expect(first.querySelector('img')).toBeNull();
  expect(first.querySelector('.cards-body .cards-badge')).toHaveTextContent('One owner');
  expect(within(first).getAllByRole('button')).toHaveLength(1);
  expect(mocks.api).not.toHaveBeenCalled();
});

test('cards without an authored image have no media well and keep their badge in the text', () => {
  draw({ kind: 'cards', primary: 'title', badge: 'highlight' });
  const first = screen.getAllByRole('listitem')[0];
  expect(first.querySelector('.cards-media')).toBeNull();
  expect(first.querySelector('.cards-card')).not.toHaveClass('has-media');
  expect(first.querySelector('.cards-body > .cards-badge')).toHaveTextContent('One owner');
});

test('cards stand in for the grid only when the answer carries every column they read', () => {
  expect(canShowCards(vehicle, ['id', 'title', 'price', 'highlight', 'year', 'fuel', 'photo_url'], byColumn)).toBe(true);
  expect(canShowCards(vehicle, ['id', 'title', 'price'], byColumn)).toBe(false);
  expect(canShowCards(vehicle, ['title', 'price'], byFile)).toBe(false);
  expect(canShowCards(undefined, ['id', 'title'], byFile)).toBe(false);
});

test("a card title that is a reference is said by its record's name where the list fetched one", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const withDealer: TableMeta = {
    ...vehicle,
    columns: [...vehicle.columns, { name: 'dealer_id', type: 'INTEGER', nullable: true, primaryKey: false }],
  };
  render(
    <QueryClientProvider client={client}>
      <CardsList
        table={withDealer}
        rows={[{ ...rows[0], dealer_id: 7, 'dealer_id.name': 'Liberty Ford' }]}
        spec={{ kind: 'cards', primary: 'dealer_id' }}
        referenceLabels={{ dealer_id: 'dealer_id.name' }}
        interactive={false}
        label="Vehicles"
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText('Liberty Ford')).toBeInTheDocument();
  expect(screen.queryByText('7')).toBeNull();
});

test('a description is said under the title without a caption, its whole text in the title attribute, and left out where the row has none', () => {
  draw({ kind: 'cards', primary: 'title', description: 'highlight' });
  const [first, second] = within(screen.getByRole('list', { name: 'Vehicles' })).getAllByRole('listitem');
  const said = first.querySelector('.cards-description');
  expect(said?.textContent).toBe('One owner');
  expect(said?.getAttribute('title')).toBe('One owner');
  // Straight under the title, and never under a caption.
  expect(first.querySelector('.cards-title + .cards-description')).toBe(said);
  expect(first.querySelector('dt')).toBeNull();
  expect(second.querySelector('.cards-description')).toBeNull();
});

test('a card wears the icon its icon column maps the value to, named for assistive technology; an unmapped value draws none', () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <CardsList table={vehicle} rows={rows} spec={{ kind: 'cards', primary: 'title', icon: 'fuel' }} />
    </QueryClientProvider>,
  );
  const [hybrid, gas] = screen.getAllByRole('heading', { level: 3 });
  expect(within(hybrid).getByRole('img', { name: 'Hybrid' }).classList.contains('cards-icon')).toBe(true);
  expect(within(gas).queryByRole('img')).toBeNull();
  expect(canShowCards(vehicle, ['id', 'title'], { kind: 'cards', primary: 'title', icon: 'fuel' })).toBe(false);
});

test('a card drawn through a reference: the car a saved row points at, its title and price, and its photo found by that car', async () => {
  const saved: TableMeta = {
    id: 'saved',
    name: 'saved',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
      { name: 'vehicle_id', type: 'INTEGER', nullable: false, primaryKey: false },
    ],
  };
  mocks.state.schema.foreignKeys.push({ from: { table: 'saved', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } });
  mocks.api.mockResolvedValue({
    rows: [
      { id: 21, vehicle_id: 2 },
      { id: 11, vehicle_id: 1 },
    ],
  });
  const spec: AppCardsList = {
    kind: 'cards',
    primary: 'vehicle_id.title',
    value: 'vehicle_id.price',
    image: { about: 'vehicle_id', from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CardsList
        table={saved}
        spec={spec}
        label="Saved cars"
        rows={[
          { id: 7, vehicle_id: 1, 'vehicle_id.title': '2021 Toyota Corolla', 'vehicle_id.price': 14995 },
          { id: 8, vehicle_id: 2, 'vehicle_id.title': '2019 Ford Focus', 'vehicle_id.price': 9495 },
        ]}
      />
    </QueryClientProvider>,
  );
  const [first, second] = screen.getAllByRole('listitem');
  expect(first).toHaveTextContent('2021 Toyota Corolla');
  expect(first).toHaveTextContent('14995');
  await vi.waitFor(() => expect(second.querySelector('img')).not.toBeNull());
  // Asked by the cars' keys, not the saved rows'.
  expect(mocks.api.mock.calls[0][1].q).toBe('vehicle_photo vehicle_id in (1, 2) sort vehicle_id, position asc show id, vehicle_id');
  const key = (card: HTMLElement) =>
    JSON.parse(new URL(card.querySelector('img')!.getAttribute('src')!, 'http://x').searchParams.get('key')!);
  expect(key(first)).toEqual({ id: 11 });
  expect(key(second)).toEqual({ id: 21 });
});

test('an icon tile leads the card in the mark the value wears, and the foot stands on every card under its values', () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <CardsList
        table={vehicle}
        rows={rows}
        spec={{ kind: 'cards', primary: 'title', icon: 'fuel', media: 'icon', footer: ['price', 'highlight'] }}
      />
    </QueryClientProvider>,
  );
  const [hybrid, gas] = screen.getAllByRole('listitem');
  // The tile holds its place on a card whose value has no mark, so the titles line up.
  expect(hybrid.querySelector('.cards-tile [role="img"]')?.getAttribute('aria-label')).toBe('Hybrid');
  expect(gas.querySelector('.cards-tile')).not.toBeNull();
  expect(gas.querySelector('.cards-tile [role="img"]')).toBeNull();
  expect(within(hybrid).getByRole('heading', { level: 3 }).querySelector('.cards-icon')).toBeNull();
  expect([...hybrid.querySelectorAll('.cards-foot-item')].map((item) => item.textContent)).toEqual([
    'Price: 14995',
    'Highlight: One owner',
  ]);
  expect([...gas.querySelectorAll('.cards-foot-item')].map((item) => item.textContent)).toEqual(['Price: 9495']);
});

// A field report from the user's own App: a card drew an enum title raw where the grid drew the rule's words.
test("a card titles each record by its column's display rule, as the grid does", () => {
  draw({ kind: 'cards', primary: 'highlight' });
  const first = screen.getAllByRole('listitem')[0];
  expect(within(first).getByRole('button', { name: 'Single owner' })).toBeInTheDocument();
  expect(within(first).queryByText('One owner')).not.toBeInTheDocument();
  // A row with no value is untitled, and a value the rule has no words for stays the value.
  expect(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: /untitled/i })).toBeInTheDocument();
});
