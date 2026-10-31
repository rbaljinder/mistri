import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { configureAppTargetLinks } from '../appTargetLinks.js';
import { establishSessionIdentity, lockSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';

const { go, openPalette } = vi.hoisted(() => ({ go: vi.fn(), openPalette: vi.fn() }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  go,
  // Nothing on the walk, and a walk that never moves.
  state: { stack: [] },
  subscribeWalk: () => () => {},
  loadJson: (_key: string, fallback: unknown) => fallback,
  saveJson: () => {},
  toast: vi.fn(),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1200, height: 800 }),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  pageView: (pageId: string) => ({ kind: 'page', pageId }),
}));
vi.mock('../../../../kit/src/client/palette.js', () => ({ openPalette }));
vi.mock('../../../../kit/src/client/components/appListModel.js', () => ({
  appListQuery: ({ table }: { table: string }) => table,
  currentNavIndex: () => -1,
}));

const { TopNav } = await import('./TopNav.js');
type Served = Parameters<typeof TopNav>[0]['app'];
/* Directory holds People and a nested Organization group holding Teams. */
const nested: Served = {
  views: { people: { table: 'people', label: 'People' }, teams: { table: 'teams', label: 'Teams' } },
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
  resources: {},
};
/* Compass's shape: groups one level deep, each holding rooms. */
const sectioned: Served = {
  views: {
    board: { label: 'Sales board', sections: [] },
    leads: { table: 'lead', label: 'Leads' },
    deals: { table: 'deal', label: 'Deals' },
    tasks: { table: 'task', label: 'Tasks' },
  },
  nav: [
    {
      group: 'sales',
      label: 'Sales',
      children: [
        { view: 'board', label: 'Sales board' },
        { view: 'leads', label: 'Leads' },
        { view: 'deals', label: 'Deals' },
      ],
    },
    { group: 'activity', label: 'Activity', children: [{ view: 'tasks', label: 'Tasks' }] },
  ],
  resources: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  configureAppTargetLinks(null);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function draw(phone = false, app: Served = nested) {
  const media = window.matchMedia('(max-width: 600px)');
  vi.spyOn(media, 'matches', 'get').mockReturnValue(phone);
  vi.spyOn(window, 'matchMedia').mockReturnValue(media);
  const host = document.createElement('nav');
  host.className = 'topnav';
  Object.defineProperty(host, 'clientWidth', { value: phone ? 360 : 1200, configurable: true });
  document.body.append(host);
  return render(<TopNav app={app} host={host} />, { container: host });
}

function targetApp(deep = false): Served {
  return {
    ...sectioned,
    id: 'source',
    nav: [
      { view: 'leads', label: 'Leads' },
      {
        group: 'targets',
        label: 'Other work',
        children: deep
          ? [{ group: 'nested', label: 'Nested', children: [{ label: 'Lender', to: { app: 'lender', kind: 'home' } }] }]
          : [{ label: 'Lender', to: { app: 'lender', kind: 'home' } }],
      },
    ],
  };
}
function allowTarget() {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'source' });
  configureAppTargetLinks({ appId: 'source', basePath: '/tools' });
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

test('desktop grouped target is a native menu anchor with no local current marker or navigation', async () => {
  const user = userEvent.setup();
  const fetcher = allowTarget();
  draw(false, targetApp());
  const trigger = await screen.findByRole('button', { name: 'Other work' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const anchor = await screen.findByRole('menuitem', { name: 'Lender' });
  expect(anchor.tagName).toBe('A');
  expect(anchor).toHaveAttribute('href', '/tools/work');
  expect(anchor).not.toHaveAttribute('data-table');
  expect(anchor).not.toHaveAttribute('aria-current');
  await vi.waitFor(() => expect(anchor).toHaveFocus());
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  act(() => anchor.dispatchEvent(click));
  expect(click.defaultPrevented).toBe(false);
  expect(go).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('a pending group can close and reopen without stale hrefs, then restores keyboard focus or prunes denial', async () => {
  const user = userEvent.setup();
  const fetcher = allowTarget();
  const { container } = draw(false, targetApp());
  await vi.waitFor(() => expect(container.querySelector('a.app-nav-target')).not.toBeNull());
  const trigger = screen.getByRole('button', { name: 'Other work' });
  const allowed = { ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) };
  let old!: (response: typeof allowed) => void;
  let fresh!: (response: typeof allowed) => void;
  fetcher
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          fresh = resolve;
        }),
    );
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('button', { name: 'Other work' })).toBe(trigger);
  expect(screen.getByRole('menu', { name: 'Other work' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(container.querySelector('a.app-nav-target')).toBeNull();
  const staleSignal = fetcher.mock.calls[1][1].signal as AbortSignal;
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard('{ArrowDown}');
  expect(staleSignal.aborted).toBe(true);
  await act(async () => old(allowed));
  expect(container.querySelector('a.app-nav-target')).toBeNull();
  await act(async () => fresh(allowed));
  const anchor = await screen.findByRole('menuitem', { name: 'Lender' });
  await vi.waitFor(() => expect(anchor).toHaveFocus());
  expect(screen.queryByRole('status')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);

  await user.keyboard('{Escape}');
  let deny!: (response: { ok: false }) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        deny = resolve;
      }),
  );
  await user.keyboard('{ArrowDown}');
  expect(container.querySelector('a.app-nav-target')).toBeNull();
  await act(async () => deny({ ok: false }));
  expect(screen.queryByRole('button', { name: 'Other work' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Lender' })).toBeNull();
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Leads' })).toHaveFocus());
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test('nested desktop menus retain their controls during refresh and focus the arriving anchor', async () => {
  const user = userEvent.setup();
  const fetcher = allowTarget();
  draw(false, targetApp(true));
  const trigger = await screen.findByRole('button', { name: 'Other work' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const nestedTrigger = await screen.findByRole('menuitem', { name: 'Nested' });
  await vi.waitFor(() => expect(nestedTrigger).toHaveFocus());
  let finish!: (response: unknown) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('button', { name: 'Other work' })).toBe(trigger);
  expect(screen.getByRole('menuitem', { name: 'Nested' })).toBe(nestedTrigger);
  expect(screen.queryByRole('menuitem', { name: 'Lender' })).toBeNull();
  await act(async () => finish({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) }));
  const anchor = await screen.findByRole('menuitem', { name: 'Lender' });
  await vi.waitFor(() => expect(anchor).toHaveFocus());
  expect(fetcher).toHaveBeenCalledTimes(3);
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(nestedTrigger).toHaveFocus());
});

test('a folded menu containing only target leaves remains open while their hrefs are pending', async () => {
  const user = userEvent.setup();
  const fetcher = allowTarget();
  const value = targetApp();
  value.nav = [{ label: 'Lender', to: { app: 'lender', kind: 'home' } }];
  const { container } = draw(true, value);
  await vi.waitFor(() => expect(container.querySelector('a.app-nav-target')).not.toBeNull());
  let finish!: (response: unknown) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const trigger = screen.getByRole('button', { name: 'Menu' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('button', { name: 'Menu' })).toBe(trigger);
  expect(screen.getByRole('menu', { name: 'Menu' })).toHaveAttribute('aria-busy', 'true');
  expect(container.querySelector('a.app-nav-target')).toBeNull();
  await act(async () => finish({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) }));
  await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Lender' })).toHaveFocus());
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([false, true])('folded target anchors work in sectioned/drill-in menus (nested=%s)', async (deep) => {
  const user = userEvent.setup();
  allowTarget();
  draw(true, targetApp(deep));
  // Wait for the availability projection before opening the folded menu.
  await vi.waitFor(() => expect(document.querySelector('button[aria-label="Other work"]')).not.toBeNull());
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  if (deep) {
    await user.click(screen.getByRole('menuitem', { name: 'Other work' }));
    await user.click(screen.getByRole('menuitem', { name: 'Nested' }));
  }
  const anchor = await screen.findByRole('menuitem', { name: 'Lender' });
  expect(anchor.tagName).toBe('A');
  expect(anchor).toHaveAttribute('href', '/tools/work');
  expect(go).not.toHaveBeenCalled();
});

test('denied external-only groups disappear while local navigation remains', async () => {
  const fetcher = allowTarget();
  fetcher.mockResolvedValue({ ok: false });
  draw(false, targetApp());
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Other work' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Leads' })).toBeInTheDocument();
});

test('an App without nav draws no menu: its one room, the home, is in no tree; the search stays', () => {
  for (const phone of [false, true]) {
    const { container, unmount } = draw(phone, { views: { tasks: { table: 'task', label: 'Tasks' } }, nav: [], resources: {} });
    expect(container.querySelectorAll('.tn-item, .tn-popitem, .tn-folded-group')).toHaveLength(0);
    expect(container.textContent).not.toContain('Tasks');
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Search (⌘K)' })).toBeInTheDocument();
    unmount();
  }
});

test('desktop caret menus keep their names, keyboard navigation and Escape focus return', async () => {
  const user = userEvent.setup();
  const { container } = draw();
  const trigger = screen.getByRole('button', { name: 'Directory' });
  expect(trigger.querySelector('svg')).toHaveClass('tn-caret');
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const people = await screen.findByRole('menuitem', { name: 'People' });
  await vi.waitFor(() => expect(people).toHaveFocus());
  await user.keyboard('{ArrowDown}{ArrowRight}');
  const teams = await screen.findByRole('menuitem', { name: 'Teams' });
  await vi.waitFor(() => expect(teams).toHaveFocus());
  expect(screen.getByRole('menuitem', { name: 'Organization' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  await user.keyboard('{Enter}');
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'teams', query: 'teams', view: 'teams' }, 'reset');
  await user.click(trigger);
  await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'People' })).toBeInTheDocument());
  await user.keyboard('{Escape}');
  await vi.waitFor(() => expect(trigger).toHaveFocus());
  expect(container.textContent).not.toMatch(/[▾›←]/);
});

test('phone drill-in and Back retain names, destination behavior and parent focus', async () => {
  const user = userEvent.setup();
  draw(true);
  const trigger = screen.getByRole('button', { name: 'Menu' });
  await user.click(trigger);
  let menu = screen.getByRole('menu', { name: 'Menu' });
  await user.click(within(menu).getByRole('menuitem', { name: 'Directory' }));
  // Base UI names the popup from its Menu trigger; the level also has a label.
  menu = screen.getByRole('menu', { name: 'Menu' });
  expect(menu).toHaveAttribute('aria-label', 'Directory');
  const back = within(menu).getByRole('menuitem', { name: 'Back Directory' });
  expect(back.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  await vi.waitFor(() => expect(back).toHaveFocus());
  await user.click(back);
  menu = screen.getByRole('menu', { name: 'Menu' });
  await vi.waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Directory' })).toHaveFocus());
  await user.keyboard('{Enter}');
  menu = screen.getByRole('menu', { name: 'Menu' });
  await user.click(within(menu).getByRole('menuitem', { name: 'People' }));
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'people', query: 'people', view: 'people' }, 'reset');
});

test.each([false, true])('search keeps its label, shortcut hint and palette action (phone=%s)', async (phone) => {
  const user = userEvent.setup();
  draw(phone);
  const search = screen.getByRole('button', { name: 'Search (⌘K)' });
  expect(search).toHaveTextContent('Search…');
  expect(search).toHaveTextContent('⌘K');
  search.focus();
  await user.keyboard('{Enter}');
  expect(openPalette).toHaveBeenCalledTimes(1);
  expect(search).toHaveFocus();
});

test('a content-constrained desktop header folds and restores navigation without losing its keyboard path', async () => {
  let measure = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(element: Element) {
        if (element.classList.contains('topnav')) measure = this.callback;
      }
      disconnect() {}
    },
  );
  const user = userEvent.setup();
  const { container } = draw();
  Object.defineProperty(container.querySelector('.tn-links'), 'scrollWidth', { value: 500 });
  const search = screen.getByRole('button', { name: 'Search (⌘K)' });
  screen.getByRole('button', { name: 'Directory' }).focus();
  await act(async () => {
    Object.defineProperty(container, 'clientWidth', { value: 300, configurable: true });
    measure();
  });
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus());
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'Directory' }));
  await user.click(screen.getByRole('menuitem', { name: 'People' }));
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'people', query: 'people', view: 'people' }, 'reset');
  screen.getByRole('button', { name: 'Menu' }).focus();
  await act(async () => {
    Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });
    measure();
  });
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Directory' })).toHaveFocus());
  expect(screen.getByRole('button', { name: 'Search (⌘K)' })).toBe(search);
});

test('folded, groups one level deep are labelled sections of one menu, every room a tap away', async () => {
  const user = userEvent.setup();
  draw(true, sectioned);
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  const menu = screen.getByRole('menu', { name: 'Menu' });
  expect(menu).toHaveClass('tn-folded-pop');
  expect(menu).not.toHaveClass('tn-drill-pop');
  expect([...menu.querySelectorAll('.tn-folded-label')].map((label) => label.textContent)).toEqual(['Sales', 'Activity']);
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Sales board', 'Leads', 'Deals', 'Tasks']);
  await user.click(within(menu).getByRole('menuitem', { name: 'Deals' }));
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'deal', query: 'deal', view: 'deals' }, 'reset');
});

test('an inline group draws its rooms in the bar as links of their own; folded, it is a section like any group', async () => {
  /* A portal's few places (G49): Sales stands in the bar as its rooms, Activity keeps its menu. */
  const portal: Served = {
    ...sectioned,
    nav: [{ ...(sectioned.nav[0] as object), inline: true } as Served['nav'][number], sectioned.nav[1]],
  };
  const user = userEvent.setup();
  const { container } = draw(false, portal);
  const strip = container.querySelector('.tn-links')!;
  expect([...strip.children].map((child) => child.textContent)).toEqual(['Sales board', 'Leads', 'Deals', 'Activity']);
  expect(within(strip as HTMLElement).queryByRole('button', { name: 'Sales' })).toBeNull();
  await user.click(within(strip as HTMLElement).getByRole('button', { name: 'Leads' }));
  expect(go).toHaveBeenCalledWith({ kind: 'table', table: 'lead', query: 'lead', view: 'leads' }, 'reset');
  cleanup();
  draw(true, portal);
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  const menu = screen.getByRole('menu', { name: 'Menu' });
  expect([...menu.querySelectorAll('.tn-folded-label')].map((label) => label.textContent)).toEqual(['Sales', 'Activity']);
});

test('folded, a group that nests another makes the menu a drill-in', async () => {
  const user = userEvent.setup();
  draw(true);
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  const menu = screen.getByRole('menu', { name: 'Menu' });
  expect(menu).toHaveClass('tn-drill-pop');
  expect(menu).not.toHaveClass('tn-folded-pop');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Directory']);
});

test('with nothing on the walk, the list the server served as home is lit, as a home dashboard is', () => {
  const lists: Served = {
    views: { leads: { table: 'lead', label: 'Leads' }, tasks: { table: 'task', label: 'Tasks' } },
    home: 'tasks',
    nav: [
      { view: 'leads', label: 'Leads' },
      { view: 'tasks', label: 'My tasks' },
    ],
    resources: {},
  };
  const { container, unmount } = draw(false, lists);
  expect(container.querySelector('.tn-wide [data-table="task"]')).toHaveAttribute('aria-current', 'true');
  expect(container.querySelector('.tn-wide [data-table="lead"]')).toHaveAttribute('aria-current', 'false');
  unmount();
  /* A dashboard home keeps its own light; no list is lit. */
  const board: Served = {
    views: { board: { label: 'Board', sections: [] }, tasks: { table: 'task', label: 'Tasks' } },
    home: 'board',
    nav: [
      { view: 'board', label: 'Board' },
      { view: 'tasks', label: 'Tasks' },
    ],
    resources: {},
  };
  const again = draw(false, board);
  expect(again.container.querySelector('.tn-wide [data-dash="dash-board"]')).toHaveAttribute('aria-current', 'true');
  expect(again.container.querySelector('.tn-wide [data-table="task"]')).toHaveAttribute('aria-current', 'false');
});
