/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { AppShell } from '../../../../mistri/src/shared/app.js';
import { configureAppTargetLinks } from '../../../../mistri/src/client/appTargetLinks.js';
import { establishSessionIdentity, lockSessionIdentity } from '../sessionIdentity.js';

const go = vi.fn();
const toast = vi.fn();
/* The server, as the counts see it: a reply per request, or a refusal. */
let answer: (path: string, body: Record<string, unknown>) => unknown = () => ({ count: 0, exact: true });
/* The rows of one paint ask together (`/api/counts`): answered here item by
   item as the single row's request would be, so each test says what it
   always said about one row's answer. */
const single = (text: string, countLimit: unknown): [string, Record<string, unknown>] =>
  text.includes(' ') ? ['/api/run', { q: text, limit: 1, countLimit }] : ['/api/count', { table: text, countLimit }];
const api = vi.fn(async (path: string, body: Record<string, unknown>) => {
  if (path === '/api/counts') {
    const results = (body.items as string[]).map((text) => {
      const [one, asked] = single(text, body.countLimit);
      const reply = answer(one, asked) as Record<string, unknown>;
      if (reply instanceof Error) throw reply;
      return one === '/api/run' ? reply : { total: reply.count, exactTotal: reply.exact, ...(reply.capped ? { cappedTotal: true } : {}) };
    });
    return { results };
  }
  const reply = answer(path, body);
  if (reply instanceof Error) throw reply;
  return reply;
});
/** What was asked, a batch said as the single requests it stands for. */
const asked = () =>
  api.mock.calls.flatMap(([path, body]) =>
    path === '/api/counts'
      ? (body.items as string[]).map((text) => single(text, body.countLimit))
      : [[path, body] as [string, Record<string, unknown>]],
  );
const listeners = new Set<() => void>();
let tick = 0;
const walk: { schema: unknown; stack: Array<Record<string, unknown>>; activeConnection: string } = {
  schema: {
    tables: [
      { id: 'customer', name: 'customer', isView: false, approxRows: 1200 },
      { id: 'invoice', name: 'invoice', isView: false, approxRows: 48000 },
      { id: 'customer_totals', name: 'customer_totals', isView: true },
    ],
  },
  stack: [],
  activeConnection: 'crm',
};
type Room = Record<string, unknown> & { label: string };
type Served = {
  id?: string;
  name: string;
  views: Record<string, Room>;
  nav: unknown[];
  resources: Record<string, unknown>;
  home?: string;
  ui?: { shell?: AppShell };
};
let app: Served | null = null;
/* A served App whose nav lists these rooms in order, keyed by their `key` or v0, v1, …; a dashboard's address is `dash-<key>`. */
const served = (name: string, rooms: Array<Room & { key?: string }>): Served => {
  const keyed = rooms.map(({ key, ...room }, i) => [key ?? `v${i}`, room] as const);
  return {
    name,
    resources: {},
    /* Every list says it is counted: these tests are of the counting, not of which lists are work
       (shared/menuCounts.ts, test/menu-counts.test.ts). */
    views: Object.fromEntries(keyed.map(([key, room]) => [key, 'table' in room && !('count' in room) ? { count: true, ...room } : room])),
    nav: keyed.map(([key, room]) => ({ view: key, label: room.label })),
    ui: { shell: { counts: true } },
  };
};

vi.mock('../core.js', () => ({
  state: walk,
  loadJson: (_key: string, fallback: unknown) => fallback,
  saveJson: () => {},
  currentEntry: () => walk.stack[walk.stack.length - 1],
  subscribeWalk: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  walkVersion: () => tick,
  go,
  toast,
  api,
  findTable: (id: string) => (walk.schema as { tables: Array<{ id: string }> }).tables.find((table) => table.id === id),
  tableView: (table: string, query?: string, tab?: string) => ({ kind: 'table', table, query: query ?? table, tab }),
  pageView: (pageId: string, table?: string, key?: unknown, label?: string) => ({ kind: 'page', pageId, table, key, label }),
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  activeApp: () => app,
  inAppMode: () => Boolean(app),
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('./appListModel.js', () => ({
  appListFor: (table: string, query: string) => ({ table, query: query.slice(table.length).trim() }),
  appListQuery: (spec: { table: string; query?: string }) => `${spec.table} ${spec.query ?? ''}`.trim(),
  currentNavIndex: (entries: Array<{ table: string; query?: string }>, tableId: string, query: string) => {
    const want = query.replace(/\s+/g, ' ').trim();
    let best = -1;
    let bestLen = -1;
    entries.forEach((entry, i) => {
      if (entry.table !== tableId) return;
      const navq = entry.query ?? '';
      const base = navq ? `${tableId} ${navq}` : tableId;
      const leads = navq ? want === base || want.startsWith(`${base} `) : true;
      if (leads && (navq ? base.length : 0) > bestLen) {
        best = i;
        bestLen = navq ? base.length : 0;
      }
    });
    return best;
  },
}));

const { Sidebar, identityInitials, moveSidebar, openSidebarChoice } = await import('./Sidebar.js');
const { setSidebarFilter, setSidebarGroupCollapsed, sidebarItems, tableRows } = await import('./sidebarModel.js');
const { countsChanged } = await import('./navCounts.js');
const { queryClient } = await import('./mount.js');

/* happy-dom's IntersectionObserver never reports. This one reports at
   once — every row on screen unless a test says otherwise — and again
   when a test moves a row in or out of view. */
let onScreen = true;
const observed = new Map<Element, (visible: boolean) => void>();
class Observer {
  callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
  constructor(callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    this.callback = callback;
  }
  observe(target: Element) {
    const report = (isIntersecting: boolean) => this.callback([{ target, isIntersecting }]);
    observed.set(target, report);
    report(onScreen);
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', Observer);

/* Store updates from outside React are wrapped, as the browser's event loop would. */
function tickWalk() {
  act(() => {
    tick += 1;
    for (const fn of listeners) fn();
  });
}
const filter = (text: string) => act(() => setSidebarFilter(text));
const move = (delta: number, host: HTMLElement) => act(() => moveSidebar(delta, host, null));

let client: QueryClient | undefined;
function draw(queries?: QueryClient, options: { tabNavigation?: boolean; onSelect?: () => void } = {}) {
  client = queries ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('ul');
  host.id = 'table-list';
  const sidebar = document.createElement('nav');
  sidebar.className = 'sidebar';
  const footer = document.createElement('div');
  footer.id = 'sidebar-app-footer';
  sidebar.append(host, footer);
  document.body.append(sidebar);
  render(createElement(QueryClientProvider, { client }, createElement(Sidebar, { host, ...options })), { container: host });
  return { host, sidebar, footer };
}

test('configured sidebar pins workspace identity outside the filtered menu, then clears without an App', () => {
  app = served('Payroll', [{ table: 'customer', label: 'People' }]);
  app.ui = { shell: { sidebar: { density: 'comfortable', footer: { title: 'Acme team', description: 'People & payroll' } } } };
  const { host, sidebar, footer } = draw();
  expect(sidebar.dataset.density).toBe('comfortable');
  expect(host).not.toHaveTextContent('Workbench');
  expect(footer).toHaveTextContent('Acme team');
  expect(footer).toHaveTextContent('People & payroll');
  // The mark says the name's words: "AT", not the first two letters "Ac".
  expect(footer.querySelector('.sidebar-identity-mark')).toHaveTextContent(/^AT$/);
  expect(identityInitials(' Payday demo workspace ')).toBe('PD');
  filter('no matches');
  expect(footer).toHaveTextContent('Acme team');
  expect(footer.querySelector('button')).toBeNull();
  app = null;
  tickWalk();
  expect(footer).toBeEmptyDOMElement();
  expect(sidebar).not.toHaveAttribute('data-density');
});

test('app navigation has no Workbench entry, with a pinned identity footer too', () => {
  app = served('Payroll', [{ table: 'customer', label: 'People' }]);
  app.ui = { shell: { sidebar: { footer: { title: 'Acme team' } } } };
  const { host, footer } = draw();
  expect(host).not.toHaveTextContent('Workbench');
  expect(footer).toHaveTextContent('Acme team');
  expect(footer.querySelector('button')).toBeNull();
  filter('Workbench');
  expect(host).toHaveTextContent('No matches.');
  expect(footer.querySelector('button')).toBeNull();
});

/** The number a row shows, or null when it shows none. */
const countOf = (host: HTMLElement, table: string, navq = '') =>
  host.querySelector(`button[data-table="${table}"][data-navq="${navq}"] .rows`)?.textContent ?? null;

afterEach(() => {
  cleanup();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
  vi.stubGlobal('IntersectionObserver', Observer);
  document.body.replaceChildren();
  walk.stack = [];
  app = null;
  setSidebarFilter('');
  go.mockReset();
  toast.mockReset();
  api.mockClear();
  answer = () => ({ count: 0, exact: true });
  onScreen = true;
  observed.clear();
  client?.clear();
  queryClient.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

function targetMenu() {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'source' });
  configureAppTargetLinks({ appId: 'source', basePath: '/tools' });
  app = { ...served('Source', [{ table: 'customer', label: 'People' }]), id: 'source' };
  app.nav.push({ group: 'external', label: 'Other work', children: [{ label: 'Lender', to: { app: 'lender', kind: 'home' } }] });
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

test('sidebar target participates in roving focus without counts/current/local navigation', async () => {
  targetMenu();
  const { host } = draw();
  const anchor = await within(host).findByRole('link', { name: 'Lender' });
  expect(anchor).toHaveAttribute('href', '/tools/work');
  expect(anchor).not.toHaveAttribute('aria-current');
  expect(anchor).not.toHaveAttribute('data-table');
  expect(anchor.querySelector('.rows')).toBeNull();
  within(host).getByRole('button', { name: 'People' }).focus();
  move(1, host);
  expect(anchor).toHaveFocus();
  expect(anchor).toHaveAttribute('tabindex', '0');
  await new Promise((resolve) => setTimeout(resolve, 140));
  expect(go).not.toHaveBeenCalled();
  expect(tableRows(sidebarItems(''))).toHaveLength(1);
});

test('mobile target is a normal tab stop and dismisses selection without intercepting modifiers', async () => {
  targetMenu();
  const onSelect = vi.fn();
  const { host } = draw(undefined, { tabNavigation: true, onSelect });
  const anchor = await within(host).findByRole('link', { name: 'Lender' });
  expect(anchor).toHaveAttribute('tabindex', '0');
  for (const ctrlKey of [true, false]) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey });
    act(() => anchor.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(go).not.toHaveBeenCalled();
});

test('a target-only filter commits the native anchor, while local rows still skim normally', async () => {
  targetMenu();
  const { host } = draw();
  const anchor = await within(host).findByRole('link', { name: 'Lender' });
  anchor.focus();
  move(-1, host);
  await waitFor(() => expect(go).toHaveBeenCalledWith(expect.objectContaining({ table: 'customer' }), 'replace'));
  go.mockClear();
  filter('Lender');
  const click = vi.fn();
  within(host).getByRole('link', { name: 'Lender' }).addEventListener('click', click);
  expect(openSidebarChoice()).toBe(true);
  expect(click).toHaveBeenCalledOnce();
  expect(go).not.toHaveBeenCalled();
});

test('revoked external leaf removes its sidebar heading on menu re-open', async () => {
  const fetcher = targetMenu();
  const { host } = draw();
  await within(host).findByRole('link', { name: 'Lender' });
  fetcher.mockResolvedValue({ ok: false });
  await act(async () => document.dispatchEvent(new Event('mistri:sidebar-fold')));
  expect(within(host).queryByRole('link')).toBeNull();
  expect(host).not.toHaveTextContent('Other work');
  expect(within(host).getByRole('button', { name: 'People' })).toBeInTheDocument();
});

test('nested groups remain separate headings and participate in filtering', () => {
  app = {
    name: 'Atlas',
    resources: {},
    views: { people: { table: 'customer', label: 'People' }, teams: { table: 'invoice', label: 'Teams' } },
    nav: [
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
  const { host } = draw();
  expect(Array.from(host.querySelectorAll('[role="heading"]')).map((node) => node.textContent)).toEqual(['Directory', 'Organization']);
  // The depth is the button's inset, so the current fill keeps the list's one edge.
  expect((host.querySelector('button[data-table="invoice"]')!.parentElement as HTMLElement).style.getPropertyValue('--nav-indent')).toBe(
    '24px',
  );
  filter('organization');
  expect(host.querySelector('button[data-table="customer"]')).toBeNull();
  expect(host.querySelector('button[data-table="invoice"]')).not.toBeNull();
  expect(Array.from(host.querySelectorAll('[role="heading"]')).map((node) => node.textContent)).toEqual(['Directory', 'Organization']);
});

test('nested groups fold in the model and DOM, while filter, rail and active rooms remain reachable', async () => {
  const user = userEvent.setup();
  app = {
    name: 'Foldable',
    resources: {},
    views: { people: { table: 'customer', label: 'People' }, teams: { table: 'invoice', label: 'Teams' } },
    nav: [
      {
        group: 'directory',
        label: 'Directory',
        children: [
          { view: 'people', label: 'People' },
          { group: 'fold-organization', label: 'Organization', children: [{ view: 'teams', label: 'Teams' }] },
        ],
      },
    ],
  };
  const { host } = draw();
  const toggle = host.querySelectorAll<HTMLButtonElement>('button.nav-group-fold')[1];
  expect(toggle).toHaveTextContent('Organization');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // The top-level Directory folds too: every headed section does.
  expect(host.querySelectorAll('.nav-group-fold')).toHaveLength(2);
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(host.querySelector('button[data-table="invoice"]')).toBeNull();
  expect(tableRows(sidebarItems('')).map((row) => row.table)).toEqual(['customer']);
  move(1, host);
  expect(host.querySelector('button[data-table="customer"]')).toHaveFocus();
  // Stop the keyboard skim timer before asserting independent navigation.
  await new Promise((resolve) => setTimeout(resolve, 130));
  filter('teams');
  expect(host.querySelector('button[data-table="invoice"]')).not.toBeNull();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  filter('');
  expect(host.querySelector('button[data-table="invoice"]')).toBeNull();
  act(() => {
    document.body.classList.add('sidebar-hidden');
    document.dispatchEvent(new Event('mistri:sidebar-fold'));
  });
  expect(host.querySelector('button[data-table="invoice"]')).not.toBeNull();
  expect(tableRows(sidebarItems('')).map((row) => row.table)).toEqual(['customer', 'invoice']);
  expect(host.querySelector('.nav-group-fold')).toBeNull();
  act(() => {
    document.body.classList.remove('sidebar-hidden');
    document.dispatchEvent(new Event('mistri:sidebar-fold'));
  });
  walk.stack = [{ kind: 'table', table: 'invoice', query: 'invoice', view: 'teams' }];
  tickWalk();
  expect(host.querySelector('button[data-table="invoice"]')).toHaveAttribute('aria-current', 'true');
  expect(host.querySelector('.nav-group-fold')).toHaveAttribute('aria-disabled', 'true');
  walk.stack = [];
  tickWalk();
  expect(host.querySelector('button[data-table="invoice"]')).toBeNull();
  act(() => setSidebarGroupCollapsed('fold-organization', false));
});

test('a top-level section folds without moving what is above it, and an App may start a rarely used one folded', async () => {
  const user = userEvent.setup();
  app = {
    name: 'Top folds',
    resources: {},
    views: {
      people: { table: 'customer', label: 'People' },
      teams: { table: 'invoice', label: 'Teams' },
      board: { label: 'Board', sections: [] },
    },
    nav: [
      { view: 'board', label: 'Board' },
      { group: 'work', label: 'Work', children: [{ view: 'people', label: 'People' }] },
      { group: 'admin', label: 'Admin', folded: true, children: [{ view: 'teams', label: 'Teams' }] },
    ],
  };
  const { host } = draw();
  const folds = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button.nav-group-fold'));
  // A room outside any group has no heading, so no chevron; each heading has one.
  expect(folds().map((fold) => [fold.textContent, fold.getAttribute('aria-expanded')])).toEqual([
    ['Work', 'true'],
    ['Admin', 'false'],
  ]);
  expect(host.querySelector('button[data-table="invoice"]')).toBeNull();
  const above = Array.from(host.querySelectorAll('#table-list > li, ul > li')).indexOf(
    host.querySelector('button[data-dash]')!.closest('li')!,
  );
  await user.click(folds()[0]);
  expect(host.querySelector('button[data-table="customer"]')).toBeNull();
  // Nothing above the folded heading moved: the rows before it are the same rows in the same places.
  expect(
    Array.from(host.querySelectorAll('#table-list > li, ul > li')).indexOf(host.querySelector('button[data-dash]')!.closest('li')!),
  ).toBe(above);
  await user.click(folds()[1]);
  expect(host.querySelector('button[data-table="invoice"]')).not.toBeNull();
  // The person's own choice is kept over the App's default, both ways.
  expect(JSON.parse(localStorage.getItem('mistri.sidebar-groups:["crm","Top folds"]')!).sort()).toEqual(['+admin', 'work']);
  await user.click(folds()[1]);
  await user.click(folds()[0]);
  expect(JSON.parse(localStorage.getItem('mistri.sidebar-groups:["crm","Top folds"]')!)).toEqual([]);
  expect(folds().map((fold) => fold.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  // A folded-by-default section still opens while it holds the current room.
  walk.stack = [{ kind: 'table', table: 'invoice', query: 'invoice', view: 'teams' }];
  tickWalk();
  expect(host.querySelector('button[data-table="invoice"]')).toHaveAttribute('aria-current', 'true');
  walk.stack = [];
  tickWalk();
});

/* G115: a footer group folds as every section does. Its heading is anchored at the foot, under its rows, so it opens
   upward: the gap above gives up what the rows take, and the heading stays where it was pressed. */
test('a footer group folds, opening upward from a heading anchored at the foot', async () => {
  const user = userEvent.setup();
  app = {
    name: 'Footer folds',
    resources: {},
    views: { people: { table: 'customer', label: 'People' }, teams: { table: 'invoice', label: 'Teams' } },
    nav: [
      { group: 'work', label: 'Work', children: [{ view: 'people', label: 'People' }] },
      { group: 'setup', label: 'Setup', placement: 'footer', folded: true, children: [{ view: 'teams', label: 'Teams' }] },
    ],
  };
  const { host } = draw();
  const folds = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button.nav-group-fold'));
  expect(folds().map((fold) => [fold.textContent, fold.getAttribute('aria-expanded')])).toEqual([
    ['Work', 'true'],
    ['Setup', 'false'],
  ]);
  expect(host.querySelector('button[data-table="invoice"]')).toBeNull();
  const heading = () => folds()[1].closest('li')!;
  // In the document the fold's button comes first, then what it shows; drawn, the heading is under its rows.
  expect(heading().previousElementSibling).toHaveClass('nav-foot-gap');
  await user.click(folds()[1]);
  const row = host.querySelector('button[data-table="invoice"]')!.closest('li')!;
  expect(folds()[1]).toHaveAttribute('aria-expanded', 'true');
  expect(Number(row.style.order)).toBeLessThan(Number(heading().style.order));
  expect(host.querySelector('.nav-foot-gap')).not.toHaveAttribute('style');
  expect(JSON.parse(localStorage.getItem('mistri.sidebar-groups:["crm","Footer folds"]')!)).toEqual(['+setup']);
});

test('a stored collapse reveals dashboard and form homes and survives labels changing', () => {
  localStorage.setItem('mistri.sidebar-groups:["crm","Stored groups"]', JSON.stringify(['work']));
  app = {
    name: 'Stored groups',
    resources: {},
    home: 'board',
    views: { board: { label: 'Board', sections: [] }, edit: { id: 'entry', label: 'Entry', command: 'submit' } },
    nav: [
      {
        group: 'top',
        label: 'Top',
        children: [
          {
            group: 'work',
            label: 'New label',
            children: [
              { view: 'board', label: 'Board' },
              { view: 'edit', label: 'Entry' },
            ],
          },
        ],
      },
    ],
  };
  const { host } = draw();
  expect(host.querySelector('button[data-dash]')).not.toBeNull();
  app.home = undefined;
  tickWalk();
  expect(host.querySelector('button[data-dash]')).toBeNull();
  app.home = 'edit';
  tickWalk();
  expect(host.querySelector('button[data-form]')).toHaveAttribute('aria-current', 'true');
  app.home = undefined;
  tickWalk();
  act(() => setSidebarGroupCollapsed('work', false));
  expect(JSON.parse(localStorage.getItem('mistri.sidebar-groups:["crm","Stored groups"]')!)).toEqual([]);
});

test('an App leaves live counts off by default and makes no count request', async () => {
  const fixture = served('Quiet', [{ table: 'invoice', label: 'Invoices' }]);
  delete fixture.ui;
  app = fixture;
  const { host } = draw();
  await act(async () => {});
  expect(host.querySelector('[data-table="invoice"] .rows')).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test('the workbench lists every table with its count, marks views, and lights the room on the walk', async () => {
  const user = userEvent.setup();
  walk.stack = [{ kind: 'table', table: 'invoice', query: 'invoice status = paid' }];
  tickWalk();
  const { host } = draw();
  const rows = host.querySelectorAll('button[data-table]');
  expect([...rows].map((b) => b.getAttribute('data-table'))).toEqual(['customer', 'invoice', 'customer_totals']);
  expect(rows[0].querySelector('.rows')).toHaveTextContent('1,200');
  expect(rows[2].querySelector('.view-tag')).toHaveTextContent('view');
  expect(rows[1]).toHaveAttribute('aria-current', 'true');
  expect(rows[1]).toHaveClass('active');
  expect(rows[0]).toHaveAttribute('aria-current', 'false');
  // Workbench rows carry no navq: one row per table, matched by table alone.
  expect(rows[0]).not.toHaveAttribute('data-navq');
  await user.click(rows[0]);
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'customer', query: 'customer', tab: 'rows' }, 'reset');
  // The workbench's numbers are the catalog's; it asks the server nothing.
  expect(api).not.toHaveBeenCalled();
});

for (const mode of ['workbench', 'app'] as const)
  test(`${mode} omits unknown row counts without hiding a known zero`, async () => {
    const previous = walk.schema;
    walk.schema = {
      tables: [
        { id: 'unknown', name: 'unknown', isView: false },
        { id: 'null_count', name: 'null_count', isView: false, approxRows: null },
        { id: 'empty', name: 'empty', isView: false, approxRows: 0 },
        { id: 'populated', name: 'populated', isView: false, approxRows: 48 },
      ],
    };
    if (mode === 'app') {
      app = served(
        'Atlas',
        ['unknown', 'null_count', 'empty', 'populated'].map((table) => ({ table, label: table })),
      );
      /* Live: a refusal and a reply without a number are both "no answer". */
      answer = (_path, body) =>
        (
          ({
            unknown: new Error('This role cannot read "unknown".'),
            null_count: { count: null },
            empty: { count: 0, exact: true },
            populated: { count: 48, exact: true },
          }) as Record<string, unknown>
        )[String(body.table)];
    }
    try {
      const { host } = draw();
      await waitFor(() => expect(host.querySelector('[data-table="populated"] .rows')).toHaveTextContent('48'));
      expect(host.querySelector('[data-table="unknown"] .rows')).toBeNull();
      expect(host.querySelector('[data-table="null_count"] .rows')).toBeNull();
      expect(host.querySelector('[data-table="empty"] .rows')).toHaveTextContent('0');
      // A row is named by its label; its count is said apart, as its description.
      const populated = within(host).getByRole('button', { name: 'populated' });
      expect(populated).toHaveAccessibleDescription('48');
      expect(within(host).getByRole('button', { name: 'unknown' })).toHaveAccessibleDescription('');
      // A count the role may not read is absent, not an error said in the menu.
      expect(toast).not.toHaveBeenCalled();
    } finally {
      walk.schema = previous;
    }
  });

test('the filter narrows the list and says when nothing matches', () => {
  const { host } = draw();
  filter('cust');
  expect([...host.querySelectorAll('button[data-table]')].map((b) => b.getAttribute('data-table'))).toEqual([
    'customer',
    'customer_totals',
  ]);
  filter('zzz');
  expect(host.querySelector('.note')).toHaveTextContent('No matches.');
});

test('an app shows its nav: groups, dashboards, modules with their conditions, missing entries kept, the toggle back', async () => {
  const user = userEvent.setup();
  app = {
    name: 'Field Ops',
    resources: {},
    views: {
      ops: { sections: [], label: 'Ops board' },
      // Both say they are counted: this test is of the counting (shared/menuCounts.ts decides what is work).
      invoices: { table: 'invoice', label: 'Invoices', count: true },
      unpaid: { table: 'invoice', label: 'Unpaid', query: 'status != paid', count: true },
      shipments: { table: 'shipment', label: 'Shipments', error: 'No table called shipment.' },
    },
    nav: [
      {
        group: 'operations',
        label: 'Operations',
        children: [
          { view: 'ops', label: 'Ops board' },
          { view: 'invoices', label: 'Invoices' },
          { view: 'unpaid', label: 'Unpaid' },
        ],
      },
      { group: 'directory', label: 'Directory', children: [{ view: 'shipments', label: 'Shipments' }] },
    ],
    home: 'ops',
    ui: { shell: { counts: true } },
  };
  answer = (path) => (path === '/api/count' ? { count: 48_123, exact: true } : { total: 7, exactTotal: true, errors: [] });
  const { host } = draw();
  expect([...host.querySelectorAll('.nav-group')].map((g) => g.textContent)).toEqual(['Operations', 'Directory']);
  // The server served the dashboard as this visitor's home, so its row is lit with nothing on the walk.
  expect(host.querySelector('[data-dash="dash-ops"]')).toHaveAttribute('aria-current', 'true');
  const rows = host.querySelectorAll('button[data-table]');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute('data-navq', '');
  expect(rows[1]).toHaveAttribute('data-navq', 'status != paid');
  /* Counts are live: not the catalog's 48,000 while the server is asked,
     then the server's answer — the module's for its own condition, sent
     as the text the list's tab badges send, parsed where the list's is. */
  expect(rows[0].querySelector('.rows')).toBeNull();
  await waitFor(() => expect(rows[0].querySelector('.rows')).toHaveTextContent('48,123'));
  await waitFor(() => expect(rows[1].querySelector('.rows')).toHaveTextContent('7'));
  expect(asked()).toEqual([
    ['/api/count', { table: 'invoice', countLimit: 10_000 }],
    ['/api/run', { q: 'invoice status != paid', limit: 1, countLimit: 10_000 }],
  ]);
  expect(host.querySelector('.nav-missing')).toHaveTextContent('Shipments');
  expect(host).not.toHaveTextContent('Workbench');

  // The module lights when its standing conditions lead the query, not the plain row.
  walk.stack = [{ kind: 'table', table: 'invoice', query: 'invoice status != paid sort id' }];
  tickWalk();
  expect(rows[1]).toHaveAttribute('aria-current', 'true');
  expect(rows[0]).toHaveAttribute('aria-current', 'false');
  expect(host.querySelector('[data-dash="dash-ops"]')).toHaveAttribute('aria-current', 'false');

  await user.click(rows[1]);
  expect(go).toHaveBeenCalledWith(
    { kind: 'table', table: 'invoice', query: 'invoice status != paid', tab: undefined, view: 'unpaid' },
    'reset',
  );
  await user.click(host.querySelector('.nav-missing')!);
  expect(toast).toHaveBeenCalledWith('No table called shipment.', 'error');
});

test('the arrow keys skim: the cursor moves at once, the preview follows a beat later, and the stale row steps back', () => {
  vi.useFakeTimers();
  walk.stack = [{ kind: 'table', table: 'customer', query: 'customer' }];
  const { host } = draw();
  // The paint after the list is drawn: from here the cursor is the current room.
  tickWalk();
  const rows = host.querySelectorAll('button[data-table]');
  move(1, host);
  expect(rows[1]).toHaveClass('active');
  expect(rows[0]).not.toHaveClass('active');
  // The room on screen is still customer: current and cursor differ, so the list skims.
  expect(rows[0]).toHaveAttribute('aria-current', 'true');
  expect(host).toHaveClass('skimming');
  expect(document.activeElement).toBe(rows[1]);
  expect(go).not.toHaveBeenCalled();
  vi.advanceTimersByTime(120);
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'invoice', query: 'invoice', tab: 'rows' }, 'replace');
  // The walk moves: cursor and current are the same row again.
  walk.stack = [{ kind: 'table', table: 'invoice', query: 'invoice' }];
  tickWalk();
  expect(host).not.toHaveClass('skimming');
  expect(host.querySelectorAll('button.active')).toHaveLength(1);
  expect(rows[1]).toHaveAttribute('aria-current', 'true');
  // Wraps rather than sticking at the end.
  move(1, host);
  move(1, host);
  expect(rows[0]).toHaveClass('active');
});

test('Enter in the filter opens the highlighted row, else the first, as a fresh start', () => {
  draw();
  filter('inv');
  expect(openSidebarChoice()).toBe(true);
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'invoice', query: 'invoice', tab: 'rows' }, 'reset');
  filter('zzz');
  expect(openSidebarChoice()).toBe(false);
});

test("an estimate wears the explorer's ~ and rounding, and says why on hover", async () => {
  app = served('Field Ops', [{ table: 'invoice', label: 'Invoices' }]);
  answer = () => ({ count: 2_400_113, exact: false });
  const { host } = draw();
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('~2.4M'));
  expect(host.querySelector('[data-table="invoice"] .rows')).toHaveAttribute('title', expect.stringContaining('statistics'));
});

test('past the bound a count is the bound and a +, in full and without the ~, and says so on hover', async () => {
  app = served('Field Ops', [
    { table: 'invoice', label: 'Invoices' },
    { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
  ]);
  answer = (path) =>
    path === '/api/count'
      ? { count: 10_000, exact: true, capped: true }
      : { total: 10_000, exactTotal: true, cappedTotal: true, errors: [] };
  const { host } = draw();
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('10,000+'));
  await waitFor(() => expect(countOf(host, 'invoice', 'status != paid')).toBe('10,000+'));
  expect(host.querySelector('[data-table="invoice"][data-navq=""] .rows')).toHaveAttribute(
    'title',
    expect.stringContaining('More than 10,000'),
  );
  // Every menu count asks for the bound, so the server never counts a whole large table for it.
  expect(asked().map(([, body]) => body.countLimit)).toEqual([10_000, 10_000]);
});

test('the rows of one paint ask in one request, and a batch refused is asked row by row', async () => {
  app = served('Field Ops', [
    { table: 'invoice', label: 'Invoices' },
    { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
  ]);
  answer = (path) => (path === '/api/count' ? { count: 12, exact: true } : { total: 4, errors: [] });
  const { host } = draw();
  await waitFor(() => expect([countOf(host, 'invoice'), countOf(host, 'invoice', 'status != paid')]).toEqual(['12', '4']));
  expect(api.mock.calls).toEqual([['/api/counts', { items: ['invoice', 'invoice status != paid'], countLimit: 10_000 }]]);
  cleanup();
  client?.clear();
  api.mockClear();
  api.mockImplementationOnce(async () => {
    throw Object.assign(new Error('No such endpoint'), { status: 404 });
  });
  const again = draw();
  await waitFor(() => expect([countOf(again.host, 'invoice'), countOf(again.host, 'invoice', 'status != paid')]).toEqual(['12', '4']));
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/counts', '/api/count', '/api/run']);
});

test('a count at the bound but not past it is exact: no +, no title', async () => {
  app = served('Field Ops', [{ table: 'invoice', label: 'Invoices' }]);
  answer = () => ({ count: 10_000, exact: true });
  const { host } = draw();
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('10,000'));
  expect(host.querySelector('[data-table="invoice"] .rows')).not.toHaveAttribute('title');
});

test('only rows on screen ask, each thing counted is asked once, and a filtered-out entry is never asked', async () => {
  app = served('Field Ops', [
    { table: 'invoice', label: 'Invoices' },
    // The same question under another name: one request answers both.
    { id: 'inbox', table: 'invoice', label: 'Inbox' },
    { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
    { table: 'customer', label: 'Customers' },
    // A view is not run to be counted.
    { table: 'customer_totals', label: 'Totals' },
  ]);
  answer = (path, body) => (path === '/api/count' ? { count: String(body.table).length, exact: true } : { total: 3, errors: [] });
  onScreen = false;
  const { host } = draw();
  await act(async () => {});
  expect(api).not.toHaveBeenCalled();
  // Scrolled into view: that row asks, and only that row.
  act(() => observed.get(host.querySelector('button[data-table="customer"]')!)!(true));
  await waitFor(() => expect(countOf(host, 'customer')).toBe('8'));
  expect(asked()).toEqual([['/api/count', { table: 'customer', countLimit: 10_000 }]]);
  for (const button of host.querySelectorAll('button[data-table]')) act(() => observed.get(button)?.(true));
  await waitFor(() => expect(countOf(host, 'invoice', 'status != paid')).toBe('3'));
  expect(
    asked()
      .map(([path, body]) => `${path} ${JSON.stringify(body)}`)
      .sort(),
  ).toEqual([
    '/api/count {"table":"customer","countLimit":10000}',
    '/api/count {"table":"invoice","countLimit":10000}',
    '/api/run {"q":"invoice status != paid","limit":1,"countLimit":10000}',
  ]);
  expect(host.querySelectorAll('button[data-table="invoice"][data-navq=""] .rows')).toHaveLength(2);
  expect(host.querySelector('button[data-table="customer_totals"] .rows')).toBeNull();

  cleanup();
  client?.clear();
  api.mockClear();
  onScreen = true;
  filter('Unpaid');
  const narrowed = draw();
  await waitFor(() => expect(countOf(narrowed.host, 'invoice', 'status != paid')).toBe('3'));
  expect(asked()).toEqual([['/api/run', { q: 'invoice status != paid', limit: 1, countLimit: 10_000 }]]);
});

test('a source that reports no totals is never asked for one', async () => {
  // An API (adapters/http) refuses a count; asking every two minutes would only log the refusal.
  const tables = (walk.schema as { tables: unknown[] }).tables;
  tables.push({ id: 'contacts', name: 'contacts', isView: false, countable: false });
  try {
    app = served('Desk', [
      { table: 'contacts', label: 'Contacts' },
      { table: 'contacts', label: 'Leads', query: 'status = lead' },
    ]);
    answer = () => ({ count: 9, exact: true });
    const { host } = draw();
    for (const button of host.querySelectorAll('button[data-table]')) act(() => observed.get(button)?.(true));
    await act(async () => {});
    expect(api).not.toHaveBeenCalled();
    expect(host.querySelector('button[data-table="contacts"] .rows')).toBeNull();
  } finally {
    tables.pop();
  }
});

test('coming back to the window asks again', async () => {
  app = served('Field Ops', [{ table: 'invoice', label: 'Invoices' }]);
  answer = () => ({ count: 48, exact: true });
  const { host } = draw();
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('48'));
  // Another session filed one more.
  answer = () => ({ count: 49, exact: true });
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('49'));
  expect(api).toHaveBeenCalledTimes(2);
});

test('a count on screen is asked again every two minutes while the page is visible, and not while it is hidden', async () => {
  vi.useFakeTimers();
  app = served('Field Ops', [{ table: 'invoice', label: 'Invoices' }]);
  answer = () => ({ count: 48, exact: true });
  const { host } = draw();
  /* Query hands a finished fetch to React on a timer of its own; the
     second step lets that land before the row is read. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
  };
  await advance(0);
  expect(countOf(host, 'invoice')).toBe('48');
  answer = () => ({ count: 49, exact: true });
  await advance(119_000);
  expect(countOf(host, 'invoice')).toBe('48');
  await advance(1_000);
  expect(countOf(host, 'invoice')).toBe('49');
  // A hidden tab asks nothing, however long it stays hidden.
  act(() => focusManager.setFocused(false));
  answer = () => ({ count: 50, exact: true });
  await advance(360_000);
  expect(api).toHaveBeenCalledTimes(2);
  expect(countOf(host, 'invoice')).toBe('49');
  // And showing it again asks at once.
  act(() => focusManager.setFocused(true));
  await advance(0);
  expect(countOf(host, 'invoice')).toBe('50');
});

test("this browser's own writes refresh the counts at once: bulk actions and commands through the count family, creates and deletes through countsChanged", async () => {
  app = served('Field Ops', [
    { table: 'invoice', label: 'Invoices' },
    { table: 'invoice', label: 'Unpaid', query: 'status != paid' },
  ]);
  let n = 10;
  answer = (path) => (path === '/api/count' ? { count: n, exact: true } : { total: n - 5, errors: [] });
  // The page's one client, which the write paths reach without a React tree.
  const { host } = draw(queryClient);
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('10'));
  await waitFor(() => expect(countOf(host, 'invoice', 'status != paid')).toBe('5'));
  n = 11;
  // A bulk action, a quick add, a checklist tick: the connection's count family.
  act(() => {
    void queryClient.invalidateQueries({ queryKey: ['count', 'crm'] });
  });
  await waitFor(() => expect([countOf(host, 'invoice'), countOf(host, 'invoice', 'status != paid')]).toEqual(['11', '6']));
  n = 12;
  // A command, an undo: everything but command preparation.
  act(() => {
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'command-prepare' });
  });
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('12'));
  n = 13;
  act(() => countsChanged('crm'));
  await waitFor(() => expect(countOf(host, 'invoice')).toBe('13'));
  // Another connection's write is not this list's news.
  const asked = api.mock.calls.length;
  act(() => countsChanged('elsewhere'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.mock.calls.length).toBe(asked);
});

test('a long Workbench list is drawn as it scrolls, and the keyboard still reaches every row', () => {
  const was = walk.schema;
  walk.schema = {
    tables: Array.from({ length: 300 }, (_, i) => ({
      id: `t${String(i).padStart(3, '0')}`,
      name: `t${String(i).padStart(3, '0')}`,
      isView: false,
    })),
  };
  try {
    const { host } = draw();
    const drawn = host.querySelectorAll('button[data-table]');
    expect(drawn.length).toBeGreaterThan(20);
    expect(drawn.length).toBeLessThan(100);
    // The rest is a spacer the height of the rows it stands for.
    expect(host.querySelector('li.sidebar-spacer:last-child')).not.toBeNull();
    // Up from the top wraps to the end of the list, which is drawn on the way.
    expect(host.querySelector('button[data-table="t298"]')).toBeNull();
    move(-1, host);
    const landed = host.querySelector<HTMLButtonElement>('button.active');
    expect(landed?.dataset.table).toBe('t298');
    expect(landed?.dataset.tableIndex).toBe('298');
    // Filtered below the threshold, the list is whole again.
    filter('t01');
    expect(host.querySelectorAll('button[data-table]')).toHaveLength(10);
    expect(host.querySelector('li.sidebar-spacer')).toBeNull();
  } finally {
    walk.schema = was;
  }
});

test('a nav entry with a color draws a dot in that series color in place of its icon', () => {
  app = served('Payroll', [
    { table: 'customer', label: 'People', icon: 'users' },
    { table: 'invoice', label: 'Bills', icon: 'receipt' },
  ]);
  app.nav = [
    { view: 'v0', label: 'People', color: 3 },
    { view: 'v1', label: 'Bills' },
  ];
  const { host } = draw();
  const rows = [...host.querySelectorAll('li')].filter((row) => row.textContent?.includes('People') || row.textContent?.includes('Bills'));
  const dot = rows.find((row) => row.textContent?.includes('People'))!.querySelector('.nav-dot');
  expect(dot).not.toBeNull();
  expect(dot).toHaveClass('nav-dot-c3');
  expect(rows.find((row) => row.textContent?.includes('People'))!.querySelector('svg.nav-icon')).toBeNull();
  // An entry without a color keeps its icon and has no dot.
  const bills = rows.find((row) => row.textContent?.includes('Bills'))!;
  expect(bills.querySelector('.nav-dot')).toBeNull();
  expect(bills.querySelector('svg.nav-icon')).not.toBeNull();
});
