import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { configureSuiteNavigation } from '../suiteNavigation.js';
import { configureAppTargetLinks } from '../appTargetLinks.js';
import {
  captureSessionIdentity,
  establishSessionIdentity,
  lockSessionIdentity,
  requireTenantSelection,
} from '../../../../kit/src/client/sessionIdentity.js';
import { SuiteAppSwitcher, type AppSwitcherConfig, type AppSwitcherLocal } from './SuiteAppSwitcher.js';
import { AccountControl } from './AccountControl.js';

const authorized: AppSwitcherConfig = { placement: 'navbar', apps: 'authorized' };
const grouped: AppSwitcherConfig = {
  placement: 'navbar',
  label: 'Explore your work',
  groups: [
    {
      label: 'People and pay',
      links: [
        { label: 'Payroll home', to: { app: 'payday', kind: 'home' } },
        { label: 'Benefit enrollment', to: { app: 'benefits', kind: 'view', view: 'enrollment' } },
      ],
    },
    { label: 'Administration', links: [{ label: 'Manage accounts', to: { app: 'restricted', kind: 'home' } }] },
  ],
};

const apps = [
  { id: 'payday', name: 'Payroll', href: '/team/apps/payday/payday' },
  { id: 'benefits', name: 'Benefits', href: '/team/apps/benefits/benefits' },
];
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const listing = (items = apps, accountId = 'account-a') => reply({ accountId, apps: items });
function start(basePath = '/team', accountId = 'account-a') {
  establishSessionIdentity({ signedIn: true, accountId, appId: 'payday' });
  configureSuiteNavigation({ basePath });
  configureAppTargetLinks({ basePath, appId: 'payday' });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  configureSuiteNavigation();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('standalone Apps have no suite control or suite requests', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  establishSessionIdentity({ signedIn: true, accountId: 'account-a', appId: 'payday' });
  const { container } = render(<SuiteAppSwitcher config={authorized} />);
  expect(container).toBeEmptyDOMElement();
  expect(fetch).not.toHaveBeenCalled();
});

function standalone(): AppSwitcherLocal {
  establishSessionIdentity({ signedIn: true, accountId: 'account-a', appId: 'payday' });
  return {
    owner: captureSessionIdentity(),
    app: {
      id: 'payday',
      views: { payroll: { table: 'pay', path: 'work', label: 'Payroll' } },
      resources: { pay: {} },
      home: 'payroll',
      nav: [],
    },
    schema: {
      label: 'data',
      dialect: 'sqlite',
      readAt: '',
      foreignKeys: [],
      tables: [
        { id: 'pay', name: 'pay', schema: '', isView: false, columns: [{ name: 'id', type: 'text', nullable: false, primaryKey: true }] },
      ],
    },
  };
}
const localGroups: AppSwitcherConfig = {
  placement: 'navbar',
  groups: [
    {
      label: 'Payroll',
      links: [
        { label: 'Home', to: { app: 'payday', kind: 'home' } },
        { label: 'Payroll list', to: { app: 'payday', kind: 'view', view: 'payroll' } },
        { label: 'Pay record', to: { app: 'payday', kind: 'record', resource: 'pay', key: { id: 'a/b' } } },
      ],
    },
    {
      label: 'Unavailable',
      links: [
        { label: 'Foreign', to: { app: 'benefits', kind: 'home' } },
        { label: 'Other tenant', to: { app: 'payday', kind: 'home', tenant: { kind: 'tenant', id: 'north' } } },
      ],
    },
  ],
};

test('standalone grouped menus use checked canonical local routes and prune foreign or tenant-hinted groups', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<SuiteAppSwitcher config={localGroups} local={standalone()} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Switch App' }));
  expect(await screen.findByRole('menuitem', { name: 'Home' })).toHaveAttribute('href', '/payday');
  expect(screen.getByRole('menuitem', { name: 'Payroll list' })).toHaveAttribute('href', '/payday/work');
  expect(screen.getByRole('menuitem', { name: 'Pay record' })).toHaveAttribute('href', '/payday/work/a%2Fb');
  expect(screen.queryByText('Unavailable')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['account', 'selection', 'lock'] as const)('standalone grouped payload cannot survive %s retirement', async (change) => {
  const local = standalone();
  const { rerender } = render(<SuiteAppSwitcher config={localGroups} local={local} />);
  await screen.findByRole('button', { name: 'Switch App' });
  act(() => {
    if (change === 'account') establishSessionIdentity({ signedIn: true, accountId: 'account-b', appId: 'payday' });
    else if (change === 'selection') requireTenantSelection();
    else lockSessionIdentity();
  });
  rerender(<SuiteAppSwitcher config={localGroups} local={local} />);
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Switch App' })).toBeNull();
  expect(screen.queryByRole('menuitem')).toBeNull();
});

test('a new standalone access projection retires the previous menu synchronously', async () => {
  const local = standalone();
  const { rerender } = render(<SuiteAppSwitcher config={localGroups} local={local} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Switch App' }));
  await screen.findByRole('menuitem', { name: 'Pay record' });
  rerender(<SuiteAppSwitcher config={localGroups} local={{ ...local, app: { ...local.app, resources: {}, views: {} } }} />);
  expect(screen.queryByRole('menuitem')).toBeNull();
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Switch App' })).toBeNull();
});

test.each([{ items: [] }, { items: [apps[0]] }])(
  'does not offer a switcher without multiple authorized Apps: $items',
  async ({ items }) => {
    const fetch = vi.fn().mockResolvedValue(listing(items));
    vi.stubGlobal('fetch', fetch);
    start();
    const { container } = render(<SuiteAppSwitcher config={authorized} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('loads only authorized Apps at the server base and uses ordinary full-document anchors without preference writes', async () => {
  const fetch = vi.fn().mockImplementation(async () => listing());
  vi.stubGlobal('fetch', fetch);
  start();
  const user = userEvent.setup();
  render(<SuiteAppSwitcher config={authorized} />);
  await user.click(await screen.findByRole('button', { name: 'Switch App' }));
  const item = await screen.findByRole('menuitem', { name: 'Benefits' });
  expect(item.tagName).toBe('A');
  expect(item).toHaveAttribute('href', apps[1].href);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Payroll', 'Benefits']);
  expect(item.querySelector('button')).toBeNull();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  fireEvent(item, click);
  expect(click.defaultPrevented).toBe(false);
  for (const [url, options] of fetch.mock.calls) {
    expect(url).toBe('/team/api/suite/apps');
    expect(options).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-mistri-account': 'account-a' },
    });
    expect(Object.keys(options.headers)).toEqual(['x-mistri-account']);
    expect(options.body).toBeUndefined();
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a single explicitly authored destination stays available', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => listing()),
  );
  start();
  render(<SuiteAppSwitcher config={{ placement: 'navbar', apps: ['benefits'] }} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Switch App' }));
  expect(await screen.findByRole('menuitem', { name: 'Benefits' })).toHaveAttribute('href', apps[1].href);
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
});

test('the compact switcher supports keyboard opening, arrow navigation and Escape focus return', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => listing()),
  );
  start();
  const user = userEvent.setup();
  render(<SuiteAppSwitcher config={authorized} />);
  const trigger = await screen.findByRole('button', { name: 'Switch App' });
  trigger.focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('menuitem', { name: 'Payroll' });
  await user.keyboard('{ArrowDown}');
  expect(screen.getAllByRole('menuitem')).toContain(document.activeElement);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('opening and window focus remove old links while refreshing, and revoked access removes the switcher', async () => {
  const opened = deferred(),
    focused = deferred();
  const fetch = vi.fn().mockResolvedValueOnce(listing()).mockReturnValueOnce(opened.promise).mockReturnValueOnce(focused.promise);
  vi.stubGlobal('fetch', fetch);
  start();
  const user = userEvent.setup();
  render(<SuiteAppSwitcher config={authorized} />);
  await user.click(await screen.findByRole('button', { name: 'Switch App' }));
  expect(screen.queryByRole('menuitem')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Checking available Apps');
  await act(async () => {
    opened.resolve(listing());
  });
  expect(screen.getByRole('menuitem', { name: 'Benefits' })).toBeVisible();
  fireEvent(window, new Event('focus'));
  expect(screen.queryByRole('menuitem')).toBeNull();
  await act(async () => {
    focused.resolve(listing([apps[0]]));
  });
  expect(screen.queryByRole('button', { name: 'Switch App' })).toBeNull();
  expect(screen.queryByRole('menuitem')).toBeNull();
});

test('a stale refresh that ignores abort cannot restore revoked links', async () => {
  const old = deferred(),
    newer = deferred();
  const fetch = vi.fn().mockResolvedValueOnce(listing()).mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
  vi.stubGlobal('fetch', fetch);
  start();
  const user = userEvent.setup();
  render(<SuiteAppSwitcher config={authorized} />);
  await user.click(await screen.findByRole('button', { name: 'Switch App' }));
  fireEvent(window, new Event('focus'));
  expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => {
    newer.resolve(listing([apps[0]]));
    old.resolve(listing());
  });
  expect(screen.queryByRole('button', { name: 'Switch App' })).toBeNull();
});

test('failed refresh clears links and offers explicit retry without technical details', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(listing())
    .mockRejectedValueOnce(new Error('private session detail'))
    .mockImplementation(async () => listing());
  vi.stubGlobal('fetch', fetch);
  start();
  const user = userEvent.setup();
  render(<SuiteAppSwitcher config={authorized} />);
  await user.click(await screen.findByRole('button', { name: 'Switch App' }));
  expect(screen.queryByRole('menuitem', { name: 'Benefits' })).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Apps could not be refreshed.');
  expect(screen.queryByText(/private session/)).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Refresh Apps' }));
  expect(await screen.findByRole('menuitem', { name: 'Benefits' })).toBeVisible();
});

test.each(['account', 'suite', 'sign-out', 'unmount'] as const)(
  '%s change fences delayed discovery and aborts the native request',
  async (change) => {
    const pending = deferred();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async () => listing([], 'account-b'));
    vi.stubGlobal('fetch', fetch);
    start();
    const { unmount } = render(<SuiteAppSwitcher config={authorized} />);
    act(() => {
      if (change === 'account') start('/team', 'account-b');
      else if (change === 'suite') configureSuiteNavigation({ basePath: '/other' });
      else if (change === 'sign-out') lockSessionIdentity();
      else unmount();
    });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(listing());
    });
    expect(screen.queryByRole('button', { name: 'Switch App' })).toBeNull();
  },
);

test('tenant context changes preserve the captured native account and do not add tenant headers', async () => {
  const pending = deferred();
  const fetch = vi.fn().mockReturnValue(pending.promise);
  vi.stubGlobal('fetch', fetch);
  start();
  render(<SuiteAppSwitcher config={authorized} />);
  act(() => {
    requireTenantSelection();
  });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
  await act(async () => {
    pending.resolve(listing());
  });
  expect(screen.getByRole('button', { name: 'Switch App' })).toBeVisible();
  expect(Object.keys(fetch.mock.calls[0][1].headers)).toEqual(['x-mistri-account']);
});

test('rejects a response owned by another account', async () => {
  const fetch = vi.fn().mockResolvedValue(listing(apps, 'account-b'));
  vi.stubGlobal('fetch', fetch);
  start();
  const { container } = render(<SuiteAppSwitcher config={authorized} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

test.each(['//evil.test/app', 'https://evil.test/app', '/\\evil.test', '/app\nnext'])('refuses unsafe backend href %j', async (href) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing([apps[0], { ...apps[1], href }])));
  start();
  const { container } = render(<SuiteAppSwitcher config={authorized} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

test('root-suite metadata is explicit and StrictMode replay retires the first request', async () => {
  const old = deferred();
  const fetch = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockImplementation(async () => listing());
  vi.stubGlobal('fetch', fetch);
  start('');
  render(
    <StrictMode>
      <SuiteAppSwitcher config={authorized} />
    </StrictMode>,
  );
  await screen.findByRole('button', { name: 'Switch App' });
  expect(fetch.mock.calls[0][0]).toBe('/api/suite/apps');
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => {
    old.resolve(listing([]));
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch App' })).toBeVisible());
});

test('suite metadata alone authors no switcher, navbar, or background discovery', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  start();
  const { container } = render(<SuiteAppSwitcher />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
  expect(fetch).not.toHaveBeenCalled();
  render(<AccountControl who="Reader" />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Account: Reader' }));
  expect(screen.queryByRole('button', { name: 'Switch App' })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test('explicit App IDs intersect current server authorization and keep the configured label', async () => {
  const third = { id: 'inventory', name: 'Inventory', href: '/team/inventory/' };
  const fetch = vi.fn().mockImplementation(async () => listing([...apps, third]));
  vi.stubGlobal('fetch', fetch);
  start();
  render(<SuiteAppSwitcher config={{ placement: 'navbar', label: 'My workspace', apps: ['benefits', 'inventory', 'not-granted'] }} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'My workspace' }));
  await screen.findByRole('menuitem', { name: 'Benefits' });
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Benefits', 'Inventory']);
  expect(screen.queryByRole('menuitem', { name: 'Payroll' })).toBeNull();
  expect(screen.queryByText('not-granted')).toBeNull();
});

function checkedFetch() {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { target } = JSON.parse(init.body as string);
    return target.app === 'restricted' ? reply({}, 403) : reply({ accountId: 'account-a', href: `/checked/${target.app}/${target.kind}` });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('authored mega menu resolves every literal target, prunes denied links and empty groups, and keeps native anchors', async () => {
  const fetch = checkedFetch();
  start();
  render(<SuiteAppSwitcher config={grouped} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Explore your work' }));
  const group = await screen.findByRole('group', { name: 'People and pay' });
  expect(
    within(group)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Payroll home', 'Benefit enrollment']);
  expect(screen.queryByRole('group', { name: 'Administration' })).toBeNull();
  expect(screen.queryByText('Manage accounts')).toBeNull();
  expect(group.closest('.suite-switcher-mega')).not.toBeNull();
  const link = within(group).getByRole('menuitem', { name: 'Benefit enrollment' });
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', '/checked/benefits/view');
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  fireEvent(link, click);
  expect(click.defaultPrevented).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(6);
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toBe('/team/api/suite/links/resolve');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-mistri-account': 'account-a' },
    });
    expect(JSON.parse(init.body as string).sourceApp).toBe('payday');
    expect(Object.keys(init.headers!)).toEqual(['content-type', 'x-mistri-account']);
  }
});

test('long authored labels stay accessible, with keyboard navigation and Escape returning to their disclosure', async () => {
  checkedFetch();
  start();
  const label = 'Explore all the people, payroll and benefits workspaces available to your account';
  render(<SuiteAppSwitcher config={{ ...grouped, label }} />);
  const trigger = await screen.findByRole('button', { name: label });
  expect(trigger).toHaveTextContent(label);
  expect(trigger).toHaveClass('suite-switcher-trigger');
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('menuitem', { name: 'Benefit enrollment' });
  await user.keyboard('{End}');
  expect(screen.getByRole('menuitem', { name: 'Benefit enrollment' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('opening a grouped menu clears the previous grant until each target is rechecked', async () => {
  const held = deferred();
  let reopening = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { target } = JSON.parse(init.body as string);
      if (reopening) {
        await held.promise;
        return reply({}, 403);
      }
      return reply({ accountId: 'account-a', href: `/checked/${target.app}` });
    }),
  );
  start();
  render(<SuiteAppSwitcher config={grouped} />);
  const trigger = await screen.findByRole('button', { name: 'Explore your work' });
  reopening = true;
  await userEvent.setup().click(trigger);
  expect(screen.queryByRole('menuitem')).toBeNull();
  expect(screen.queryByRole('group')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Checking available Apps');
  await act(async () => {
    held.resolve(reply({}));
  });
  expect(screen.queryByRole('button', { name: 'Explore your work' })).toBeNull();
});

test.each(['deny', 'error', 'unsafe'] as const)('all %s group results leave no disclosure or empty authored headings', async (outcome) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (outcome === 'error') throw new Error('private failure');
      return outcome === 'deny' ? reply({}, 403) : reply({ accountId: 'account-a', href: '//external.test' });
    }),
  );
  start();
  const { container } = render(<SuiteAppSwitcher config={grouped} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

test('record-bound runtime values are never sent from an authored static group', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  start();
  const config = {
    placement: 'navbar',
    groups: [
      {
        label: 'Invalid',
        links: [{ label: 'Record', to: { app: 'payday', kind: 'record', resource: 'note', key: { id: { column: 'id' } } } }],
      },
    ],
  } as unknown as AppSwitcherConfig;
  const { container } = render(<SuiteAppSwitcher config={config} />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['scope', 'tenant-pending', 'sign-out', 'unmount'] as const)(
  'group %s change fences a delayed checked response even if fetch ignores abort',
  async (change) => {
    const pending = deferred(),
      next = deferred();
    let count = 0;
    const fetch = vi.fn().mockImplementation(() => (++count <= 3 ? pending.promise : next.promise));
    vi.stubGlobal('fetch', fetch);
    start();
    const { unmount } = render(<SuiteAppSwitcher config={grouped} />);
    const signals = fetch.mock.calls.map((call) => call[1].signal as AbortSignal);
    act(() => {
      if (change === 'scope') configureAppTargetLinks({ basePath: '/new-suite', appId: 'payday' });
      else if (change === 'tenant-pending') requireTenantSelection();
      else if (change === 'sign-out') lockSessionIdentity();
      else unmount();
    });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    // Only old-generation requests receive availability; any new requests remain pending.
    await act(async () => {
      pending.resolve(reply({ accountId: 'account-a', href: '/old-grant' }));
    });
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Explore your work' })).toBeNull();
  },
);

test('configuration replacement immediately retires old availability and ignores delayed authoring results', async () => {
  const old = deferred();
  let delay = false;
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { target } = JSON.parse(init.body as string);
    if (delay && target.app === 'payday') return old.promise;
    return reply({ accountId: 'account-a', href: `/checked/${target.app}` });
  });
  vi.stubGlobal('fetch', fetch);
  start();
  const first: AppSwitcherConfig = {
    placement: 'navbar',
    label: 'Work',
    groups: [{ label: 'Old group', links: [{ label: 'Old link', to: { app: 'payday', kind: 'home' } }] }],
  };
  const next: AppSwitcherConfig = {
    placement: 'navbar',
    label: 'Work',
    groups: [{ label: 'New group', links: [{ label: 'New link', to: { app: 'benefits', kind: 'home' } }] }],
  };
  const tree = render(<SuiteAppSwitcher config={first} />);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Work' });
  delay = true;
  await user.click(screen.getByRole('button', { name: 'Work' }));
  tree.rerender(<SuiteAppSwitcher config={next} />);
  expect(screen.queryByRole('menuitem', { name: 'Old link' })).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Work' }));
  await screen.findByRole('menuitem', { name: 'New link' });
  await act(async () => {
    old.resolve(reply({ accountId: 'account-a', href: '/stale' }));
  });
  expect(screen.queryByText('Old group')).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'New link' })).toHaveAttribute('href', '/checked/benefits');
});

test('account placement draws grouped links directly in the existing account menu and refreshes each opening', async () => {
  const fetch = checkedFetch();
  start();
  render(<AccountControl who="Reader" appSwitcher={{ ...grouped, placement: 'account' }} accountProfile />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Explore your work' })).toBeNull();
  const user = userEvent.setup(),
    account = screen.getByRole('button', { name: 'Account: Reader' });
  await user.click(account);
  await screen.findByRole('menuitem', { name: 'Payroll home' });
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('group', { name: 'Explore your work' })).toHaveClass('suite-switcher-account');
  expect(screen.getByRole('menuitem', { name: 'Your profile' })).toBeVisible();
  expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Explore your work' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(account).toHaveFocus();
  const before = fetch.mock.calls.length;
  await user.click(account);
  await screen.findByRole('menuitem', { name: 'Payroll home' });
  expect(fetch.mock.calls.length).toBe(before + 3);
});

test('navbar configuration is not duplicated into the account popup', async () => {
  checkedFetch();
  start();
  render(<AccountControl who="Reader" appSwitcher={grouped} />);
  await screen.findByRole('button', { name: 'Explore your work' });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Account: Reader' }));
  expect(screen.queryByRole('menuitem', { name: 'Payroll home' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Explore your work' })).toHaveLength(1);
});
