/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import type { QueryKey } from '@tanstack/react-query';

type Room = Record<string, unknown> & { label: string };
type Served = {
  name: string;
  views: Record<string, Room>;
  nav: unknown[];
  resources: Record<string, unknown>;
  home?: string;
  ui?: { shell?: { rail?: boolean; counts?: boolean } };
};
let app: Served | null = null;
/* A served App whose nav lists these rooms in order, keyed v0, v1, … (a dashboard's address is `dash-<key>`),
   and the home the server served, when it served one. */
const served = (name: string, rooms: Room[], inNav = true, home?: string): Served => ({
  name,
  resources: {},
  /* Every list says it is counted: these tests are of the counting, not of which lists are work (shared/menuCounts.ts,
     test/menu-counts.test.ts). */
  views: Object.fromEntries(rooms.map((room, i) => [`v${i}`, 'table' in room && !('count' in room) ? { count: true, ...room } : room])),
  nav: inNav ? rooms.map((room, i) => ({ view: `v${i}`, label: room.label })) : [],
  ...(home === undefined ? {} : { home }),
  ui: { shell: { counts: true } },
});
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  activeApp: () => app,
  inAppMode: () => Boolean(app),
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);

const { state } = await import('../core.js');
const { currentDashView, currentSidebarIndex, rowCount, sidebarItems, tableRows, railed, setSidebarGroupCollapsed } =
  await import('./sidebarModel.js');
const { countsChanged, navCountKey } = await import('./navCounts.js');
const { queryClient } = await import('./mount.js');
const { captureRecordWriteRefresh } = await import('../recordWriteRefresh.js');
const { establishSessionIdentity } = await import('../sessionIdentity.js');

const schema = {
  tables: [
    { id: 'customer', name: 'customer', isView: false, approxRows: 1200, columns: [{ name: 'id', primaryKey: true }] },
    { id: 'invoice', name: 'invoice', isView: false, approxRows: 48000, columns: [{ name: 'id', primaryKey: true }] },
    { id: 'customer_totals', name: 'customer_totals', isView: true, columns: [] },
  ],
};

beforeEach(() => {
  queryClient.clear();
  state.schema = schema;
  state.activeConnection = 'crm';
  establishSessionIdentity({ signedIn: false });
});
afterEach(() => {
  app = null;
  queryClient.clear();
});

test('App sidebars default to an icon rail; explicit false and the standalone browser opt out', () => {
  expect(railed()).toBe(false);
  app = served('Example', []);
  expect(railed()).toBe(true);
  app.ui = { shell: { rail: false } };
  expect(railed()).toBe(false);
  app.ui = { shell: { rail: true } };
  expect(railed()).toBe(true);
  app = null;
  expect(railed()).toBe(false);
});

test('App sidebar counts are opt-in while the standalone browser keeps catalog estimates', () => {
  app = served('Quiet', [{ table: 'invoice', label: 'Invoices' }]);
  delete app.ui;
  expect(tableRows(sidebarItems(''))[0]).toMatchObject({ count: null });
  expect(tableRows(sidebarItems(''))[0].counted).toBeUndefined();
  app.ui = { shell: { counts: true } };
  expect(tableRows(sidebarItems(''))[0].counted).toEqual({ table: 'invoice', condition: '' });
  app = null;
  expect(tableRows(sidebarItems(''))[1]?.count).toBe(48000);
});

test('an app row asks for what its view stands for, condition included; the standalone browser keeps the snapshot', () => {
  app = served('Field Ops', [
    { sections: [], label: 'Ops board' },
    { table: 'invoice', label: 'Invoices' },
    { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
    { table: 'customer_totals', label: 'Totals' },
    { table: 'shipment', label: 'Shipments', error: 'No table called shipment.' },
  ]);
  const rows = tableRows(sidebarItems(''));
  expect(rows.map((row) => [row.label, row.counted, row.count])).toEqual([
    ['Invoices', { table: 'invoice', condition: '' }, null],
    ['Unpaid', { table: 'invoice', condition: 'status != paid' }, null],
    // Counting a view runs it; the menu does not.
    ['Totals', undefined, null],
  ]);
  app = null;
  const bench = tableRows(sidebarItems(''));
  expect(bench.map((row) => [row.table, row.counted, row.count])).toEqual([
    ['customer', undefined, 1200],
    ['invoice', undefined, 48000],
    ['customer_totals', undefined, null],
  ]);
});

test("a list whose tab shows a saved form's drafts is counted as the server says, drafts left out", () => {
  app = served('Lending', [
    {
      table: 'invoice',
      label: 'Applications',
      countQuery: 'status != in_progress',
      tabs: [
        { label: 'Submitted', query: 'status != in_progress and status = submitted' },
        { label: 'In progress', query: 'status = in_progress' },
      ],
    },
  ]);
  expect(tableRows(sidebarItems(''))[0].counted).toEqual({ table: 'invoice', condition: 'status != in_progress' });
});

test('an App without nav lists no menu rows: its one room, the home, is in no menu, and nothing claims "No matches"', () => {
  app = served('Tick', [{ table: 'invoice', label: 'Tasks' }], false);
  expect(sidebarItems('')).toEqual([]);
  expect(sidebarItems('tas')).toEqual([{ kind: 'note', text: 'No matches.' }]);
});

test('a list the server served as home leaves every dashboard row unlit on the landing', () => {
  app = served(
    'Field Ops',
    [
      { sections: [], label: 'Ops board' },
      { table: 'invoice', label: 'Invoices' },
    ],
    true,
    'v1',
  );
  expect(currentDashView()).toBeNull();
  app = served(
    'Field Ops',
    [
      { sections: [], label: 'Ops board' },
      { table: 'invoice', label: 'Invoices' },
    ],
    true,
    'v0',
  );
  expect(currentDashView()).toBe('v0');
});

test("on the landing, the row of the list the server served as home is lit the way a home dashboard's is", () => {
  app = served(
    'Field Ops',
    [
      { sections: [], label: 'Ops board' },
      { table: 'invoice', label: 'Invoices' },
      { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
    ],
    true,
    'v2',
  );
  let items = sidebarItems('');
  expect(tableRows(items)[currentSidebarIndex(items)]?.label).toBe('Unpaid');
  expect(currentDashView()).toBeNull();
  /* A dashboard home keeps its own light, and no list row is lit. */
  app = served(
    'Field Ops',
    [
      { sections: [], label: 'Ops board' },
      { table: 'invoice', label: 'Invoices' },
    ],
    true,
    'v0',
  );
  items = sidebarItems('');
  expect(currentSidebarIndex(items)).toBe(-1);
  expect(currentDashView()).toBe('v0');
  /* Nothing is guessed: with no home served, even a one-room App lights nothing, and so does a public home. */
  app = served('Field Ops', [{ table: 'invoice', label: 'Invoices' }]);
  expect([currentSidebarIndex(sidebarItems('')), currentDashView()]).toEqual([-1, null]);
  app = served(
    'Field Ops',
    [
      { sections: [], label: 'Ops board' },
      { table: 'invoice', label: 'Invoices' },
    ],
    true,
    'welcome',
  );
  expect([currentSidebarIndex(sidebarItems('')), currentDashView()]).toEqual([-1, null]);
  /* Once the walk has somewhere, the walk decides; in the standalone browser no App lights anything. */
  app = served(
    'Field Ops',
    [
      { table: 'invoice', label: 'Invoices' },
      { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
    ],
    true,
    'v1',
  );
  state.stack = [{ kind: 'table', table: 'invoice', query: 'invoice' }];
  try {
    expect(tableRows(sidebarItems(''))[currentSidebarIndex(sidebarItems(''))]?.label).toBe('Invoices');
  } finally {
    state.stack = [];
  }
  app = null;
  expect(currentSidebarIndex(sidebarItems(''))).toBe(-1);
});

test("the menu follows nav: headings over groups, rooms under the menu's word, a group's own label keeping its rooms", () => {
  app = {
    name: 'Atlas',
    resources: {},
    views: {
      people: { table: 'customer', label: 'Customers' },
      teams: { table: 'invoice', label: 'Invoices' },
      totals: { table: 'customer_totals', label: 'Totals' },
    },
    nav: [
      { view: 'totals', label: 'Totals' },
      {
        group: 'directory',
        label: 'Directory',
        children: [
          { view: 'people', label: 'People' },
          { group: 'organization', label: 'Organization', children: [{ view: 'teams', label: 'Teams' }] },
        ],
      },
    ],
  };
  expect(sidebarItems('').map((item) => [item.kind, 'label' in item ? item.label : '', item.depth ?? 0])).toEqual([
    ['table', 'Totals', 0],
    ['group', 'Directory', 0],
    ['table', 'People', 1],
    ['group', 'Organization', 1],
    ['table', 'Teams', 2],
  ]);
  /* The row's own words: the menu's. The room it opens is the view's, under its own label. */
  expect(tableRows(sidebarItems('')).find((row) => row.label === 'People')?.entry).toMatchObject({
    id: 'people',
    label: 'People',
    table: 'customer',
  });
  expect(sidebarItems('organ').map((item) => ('label' in item ? item.label : ''))).toEqual(['Directory', 'Organization', 'Teams']);
  expect(sidebarItems('customer').map((item) => ('label' in item ? item.label : ''))).toEqual(['Totals', 'Directory', 'People']);
});

test('group preferences are scoped and tolerate malformed or blocked storage', () => {
  const nested = (name: string): Served => ({
    name,
    resources: {},
    views: { invoice: { table: 'invoice', label: 'Invoices' } },
    nav: [
      { group: 'top', label: 'Top', children: [{ group: 'detail', label: 'Detail', children: [{ view: 'invoice', label: 'Invoices' }] }] },
    ],
  });
  app = nested('Group scope one');
  localStorage.setItem('mistri.sidebar-groups:["crm","Group scope one"]', '{bad JSON');
  expect(tableRows(sidebarItems(''))).toHaveLength(1);
  setSidebarGroupCollapsed('detail', true);
  expect(tableRows(sidebarItems(''))).toHaveLength(0);
  app = nested('Group scope two');
  expect(tableRows(sidebarItems(''))).toHaveLength(1);
  app = nested('Group scope one');
  expect(tableRows(sidebarItems(''))).toHaveLength(0);
  state.activeConnection = 'other';
  expect(tableRows(sidebarItems(''))).toHaveLength(1);
  const get = vi.fn(() => {
    throw new Error('blocked');
  });
  const set = vi.fn(() => {
    throw new Error('blocked');
  });
  vi.stubGlobal('localStorage', { getItem: get, setItem: set });
  try {
    app = nested('Blocked group storage');
    expect(tableRows(sidebarItems(''))).toHaveLength(1);
    setSidebarGroupCollapsed('detail', true);
    expect(tableRows(sidebarItems(''))).toHaveLength(0);
    setSidebarGroupCollapsed('detail', false);
    expect(tableRows(sidebarItems(''))).toHaveLength(1);
    expect(get).toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('the live answer replaces the snapshot, an estimate is marked, and no answer is blank rather than zero', () => {
  app = served('Field Ops', [{ table: 'invoice', label: 'Invoices' }]);
  const [row] = tableRows(sidebarItems(''));
  // Not the catalog's 48,000 while the server has not answered.
  expect(rowCount(row, undefined)).toBeNull();
  expect(rowCount(row, { count: 48_123, exact: true })).toBe('48,123');
  expect(rowCount(row, { count: 0, exact: true })).toBe('0');
  expect(rowCount(row, { count: 2_400_113, exact: false })).toBe('~2.4M');
  expect(rowCount(row, { count: 61_000, exact: false })).toBe('~61K');
  // The server stopped at the bound: a floor, counted, in full — never the estimate's ~.
  expect(rowCount(row, { count: 10_000, exact: true, capped: true })).toBe('10,000+');
  expect(rowCount(row, { count: 10_000, exact: true })).toBe('10,000');
  // Refused, failed, or a reply with no number in it.
  expect(rowCount(row, null)).toBeNull();
  app = null;
  const [customer] = tableRows(sidebarItems(''));
  expect(rowCount(customer, undefined)).toBe('1,200');
  expect(rowCount(customer, { count: 5, exact: true })).toBe('1,200');
});

test("every refresh this browser's writes already make reaches the menu's counts, and only on their connection", async () => {
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const seed = () => {
    queryClient.clear();
    const at = (key: QueryKey) => {
      queryClient.setQueryData(key, { count: 1, exact: true });
      return queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    };
    return {
      mine: [
        at(navCountKey('crm', { table: 'invoice', condition: '' })),
        at(navCountKey('crm', { table: 'customer', condition: 'name contains a' })),
      ],
      other: at(navCountKey('elsewhere', { table: 'invoice', condition: '' })),
    };
  };
  const writes: Array<[string, () => void | Promise<unknown>]> = [
    ['a record save (write.js, the record modal)', () => captureRecordWriteRefresh('invoice', { id: 1 })()],
    ['a bulk action, a quick add, a checklist tick', () => queryClient.invalidateQueries({ queryKey: ['count', 'crm'] })],
    ['a create or a delete', () => countsChanged('crm')],
  ];
  for (const [path, write] of writes) {
    const { mine, other } = seed();
    await write();
    await settle();
    expect(
      mine.map((query) => query.state.isInvalidated),
      path,
    ).toEqual([true, true]);
    expect(other.state.isInvalidated, path).toBe(false);
  }
  // A tab badge's key (['count', connection, query]) never shares an entry with a menu count.
  expect(navCountKey('crm', { table: 'invoice', condition: '' })).not.toEqual(['count', 'crm', 'invoice']);
});
