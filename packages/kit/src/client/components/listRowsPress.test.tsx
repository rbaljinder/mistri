import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bridgeShell } from '../../../../../test/shellBridge.js';

/* A press on a menu entry begins the list's first reads; the room the click opens finds them and asks nothing more. */
const request = vi.fn();
vi.mock('../core.js', () => ({
  $: () => null,
  api: request,
  findTable: () => undefined,
  go: vi.fn(),
  tableView: vi.fn(),
  pageSize: () => 25,
  setExplain: vi.fn(),
  showErrors: vi.fn(),
  setRecordMutationPendingProbe: vi.fn(),
  registerSurfaceMutationPendingProbe: vi.fn(),
  columnLabel: () => null,
  state: { page: 0, activeConnection: 'demo' },
}));
vi.mock('../history.js', () => ({ recordQuery: vi.fn() }));
vi.mock('../nested.js', () => ({ resetNested: vi.fn() }));
vi.mock('../filterbar.js', () => ({ deriveFilterNames: () => [], squeeze: (text: string) => text.replace(/\s+/g, ' ').trim() }));
vi.mock('../connectionScope.js', () => ({ canUseDatabaseTools: () => true }));
vi.mock('./Diagram.js', () => ({ NeighbourhoodDiagram: () => null }));
vi.mock('./FilterBoxes.js', () => ({ FilterBar: () => null }));
vi.mock('./TableView.js', () => ({
  ViewTabs: () => null,
  isApiConnection: () => false,
  GridCellEdit: Object.assign(() => null, { ready: async () => {}, here: () => true }),
  TableView: ({ data }: { data: { rows: unknown[] } }) => <div data-testid="rows">{data.rows.length}</div>,
}));
/* The list's own model is the App's: a spec whose first tab's question is its query, with tabs when it says so. */
vi.mock('./appListModel.js', () => ({
  appListQuery: (spec: { query: string; tabs?: Array<{ query: string }> }, index = 0) => `${spec.query}${spec.tabs?.[index]?.query ?? ''}`,
  shownTabs: (spec: { tabs?: unknown[] }) => spec.tabs ?? [],
}));
vi.mock('./AppList.js', () => ({
  badgeQuestions: (spec: { query: string; tabs?: Array<{ query: string }>; tabCounts?: boolean }, _table: string, gridTab: number) =>
    spec.tabCounts === true ? (spec.tabs ?? []).flatMap((tab, i) => (i === gridTab ? [] : [`${spec.query}${tab.query}`])) : [],
  tabCountsRead: (items: string[]) => ({
    queryKey: ['count', 'demo', 'tabs', items],
    queryFn: async () => request('/api/counts', { items }),
  }),
}));

const { TableRoom } = await import('./TableRoom.js');
const { prefetchList } = await import('./listRowsPress.js');
const { savedViewsKey } = await import('./myViews.js');

const reply = { table: 'invoice', columns: ['id'], rows: [{ id: 1 }], ms: 1, errors: [], resolved: [], joinCount: 0, limit: 25, offset: 0 };
const spec = { table: 'invoice', query: 'invoice show id', label: 'Invoices', id: 'invoices' };
const clients: QueryClient[] = [];
const fresh = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
};
const tick = () => new Promise((done) => setTimeout(done, 0));
const rowReads = () => request.mock.calls.filter(([path]) => path === '/api/run');

beforeEach(bridgeShell);
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.clearAllMocks();
});

test('a press reads the list once, and the room it opens takes that read rather than asking again, in flight or landed', async () => {
  for (const landed of [false, true]) {
    const client = fresh();
    let answer!: () => void;
    request.mockReset();
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(reply);
          if (landed) answer();
        }),
    );
    /* Each pass its own question: what a press read is remembered for a moment (pressedReads.ts). */
    const query = `invoice show id${landed ? ' limit 25' : ''}`;
    prefetchList({ ...spec, query } as never, client);
    prefetchList({ ...spec, query } as never, client); // Enter after the press: the same read.
    await tick();
    expect(rowReads()).toHaveLength(1);
    expect(rowReads()[0]![1]).toMatchObject({ q: query, limit: 25, offset: 0, exactCount: false });
    render(
      <QueryClientProvider client={client}>
        <TableRoom entry={{ kind: 'table', table: 'invoice', query }} />
      </QueryClientProvider>,
    );
    if (!landed) answer();
    expect(await screen.findByTestId('rows')).toHaveTextContent('1');
    expect(rowReads(), landed ? 'landed before the click' : 'in flight at the click').toHaveLength(1);
    cleanup();
  }
});

test('a list with tabs reads its badges beside its rows only when tabCounts is enabled and saved views are known', async () => {
  const tabbed = { ...spec, tabs: [{ query: '' }, { query: ' status = open' }] };
  request.mockImplementation(async (path: string) => (path === '/api/counts' ? { results: [{ total: 3 }] } : reply));
  const defaultOff = fresh();
  defaultOff.setQueryData(savedViewsKey(), { filters: {}, store: 'shared' });
  prefetchList({ ...tabbed, query: 'invoice show id order status' } as never, defaultOff);
  await tick();
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/run']);
  request.mockClear();
  const optedIn = { ...tabbed, tabCounts: true };
  const unknown = fresh();
  prefetchList({ ...optedIn, query: 'invoice show id order name' } as never, unknown);
  await tick();
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/run']);
  request.mockClear();
  const known = fresh();
  known.setQueryData(savedViewsKey(), { filters: {}, store: 'shared' });
  prefetchList({ ...optedIn, query: 'invoice show id order id' } as never, known);
  await tick();
  expect(request.mock.calls.map(([path]) => path).sort()).toEqual(['/api/counts', '/api/run']);
  expect(request.mock.calls.find(([path]) => path === '/api/counts')![1]).toEqual({ items: ['invoice show id order id status = open'] });
});

test('a board, a grouped list and an entry in error are left to ask on mount', () => {
  const client = fresh();
  for (const odd of [{ presentation: { kind: 'board' } }, { asBoard: {} }, { group: 'status' }, { error: 'broken' }])
    prefetchList({ ...spec, ...odd, id: `odd-${Object.keys(odd)[0]}` } as never, client);
  expect(request).not.toHaveBeenCalled();
});
