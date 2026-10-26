import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { configureSuiteNavigation } from '../suiteNavigation.js';
import { establishSessionIdentity, lockSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import { SuiteAppPreference } from './SuiteAppPreference.js';

const apps = [
  { id: 'payday', name: 'Payroll', href: '/team/apps/payday/payday' },
  { id: 'benefits', name: 'Benefits', href: '/team/apps/benefits/benefits' },
];
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const preference = (defaultApp: string | null = null, revision = 0, accountId = 'account-a') => ({ accountId, defaultApp, revision });
function start(basePath = '/team', accountId = 'account-a') {
  establishSessionIdentity({ signedIn: true, accountId, appId: 'payday' });
  configureSuiteNavigation({ basePath });
}
function server(initial = preference(), post?: (body: { defaultApp: string | null; expectedRevision: number }) => Promise<Response>) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/apps')) return reply({ accountId: initial.accountId, apps });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      return post ? post(body) : reply(preference(body.defaultApp, body.expectedRevision + 1));
    }
    return reply(initial);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const choose = async (name: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Default App' }));
  await user.click(screen.getByRole('option', { name }));
};
afterEach(() => {
  cleanup();
  configureSuiteNavigation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('standalone Preferences do not render suite settings or fetch suite endpoints', () => {
  const fetch = server();
  const { container } = render(<SuiteAppPreference />);
  expect(container).toBeEmptyDOMElement();
  expect(fetch).not.toHaveBeenCalled();
});

test('reads the account preference, offers only authorized Apps and Ask each time, and never writes just by opening', async () => {
  const fetch = server(preference('payday', 3));
  start();
  render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Payroll'));
  expect(screen.getByText(/Saved to your account/)).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Default App' }));
  expect(screen.getAllByRole('option').map((option) => option.textContent?.replace('✓', ''))).toEqual([
    'Ask each time',
    'Payroll',
    'Benefits',
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toMatch(/^\/team\/api\/suite\/(apps|preferences)$/);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-mistri-account': 'account-a' },
    });
    expect(Object.keys(init.headers!)).toEqual(['x-mistri-account']);
  }
});

test.each([
  { label: 'Benefits', value: 'benefits' },
  { label: 'Ask each time', value: null },
])('saves $label with a strict account-scoped CAS body', async (choice) => {
  const fetch = server(preference('payday', 3));
  start();
  render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toBeEnabled());
  await choose(choice.label);
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save default App' }));
  expect(await screen.findByText('Default App saved to your account.')).toBeVisible();
  const [url, init] = fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
  expect(url).toBe('/team/api/suite/preferences');
  expect(JSON.parse(init.body as string)).toEqual({ defaultApp: choice.value, expectedRevision: 3 });
  expect(init).toMatchObject({
    credentials: 'same-origin',
    headers: { 'x-mistri-account': 'account-a', 'content-type': 'application/json' },
  });
  expect(Object.keys(init.headers!)).toEqual(['x-mistri-account', 'content-type']);
  expect(screen.getByRole('button', { name: 'Save default App' })).toBeDisabled();
});

test('CAS conflict retains the selection and requires refresh plus a new explicit save, without replay', async () => {
  let stored = preference('payday', 3),
    posts = 0;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/apps')) return reply({ accountId: 'account-a', apps });
    if (init.method === 'POST') {
      posts++;
      if (posts === 1) {
        stored = preference(null, 4);
        return reply({ error: 'private conflict detail' }, 409);
      }
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ defaultApp: 'benefits', expectedRevision: 4 });
      return reply(preference('benefits', 5));
    }
    return reply(stored);
  });
  vi.stubGlobal('fetch', fetch);
  start();
  render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toBeEnabled());
  await choose('Benefits');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Save default App' }));
  expect(await screen.findByText('Your preference changed elsewhere. Refresh before saving again.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Benefits');
  expect(screen.getByRole('button', { name: 'Save default App' })).toBeDisabled();
  expect(posts).toBe(1);
  await user.click(screen.getByRole('button', { name: 'Refresh preference' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Benefits');
  expect(posts).toBe(1);
  await user.click(screen.getByRole('button', { name: 'Save default App' }));
  expect(await screen.findByText('Default App saved to your account.')).toBeVisible();
  expect(posts).toBe(2);
});

test('an uncertain write retains the selection and cannot be replayed before a refresh', async () => {
  const fetch = server(preference(), async () => {
    throw new Error('private network details');
  });
  start();
  render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toBeEnabled());
  await choose('Benefits');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save default App' }));
  expect(await screen.findByText('Your change could not be confirmed. Refresh before saving again.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Benefits');
  expect(screen.getByRole('button', { name: 'Save default App' })).toBeDisabled();
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  expect(screen.queryByText(/private network/)).toBeNull();
});

test('a revoked stored default is not an authorized option and is not silently rewritten', async () => {
  const fetch = server(preference('revoked-app', 2));
  start();
  render(<SuiteAppPreference />);
  expect(await screen.findByText('Your selected App is no longer available. Choose another App.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save default App' })).toBeDisabled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Default App' }));
  expect(screen.queryByRole('option', { name: /revoked/ })).toBeNull();
  expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});

test('refresh after a refused write retains a newly revoked choice without offering or saving it', async () => {
  let revoked = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/apps')) return reply({ accountId: 'account-a', apps: revoked ? [apps[0]] : apps });
    if (init.method === 'POST') {
      revoked = true;
      return reply({}, 403);
    }
    return reply(preference('payday', 1));
  });
  vi.stubGlobal('fetch', fetch);
  start();
  render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toBeEnabled());
  await choose('Benefits');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Save default App' }));
  await user.click(screen.getByRole('button', { name: 'Refresh preference' }));
  expect(await screen.findByText('Your selected App is no longer available. Choose another App.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save default App' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Default App' }));
  expect(screen.queryByRole('option', { name: 'Benefits' })).toBeNull();
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('refresh with no local edit adopts the account preference changed elsewhere', async () => {
  let stored = preference('payday', 1);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => reply(url.endsWith('/apps') ? { accountId: 'account-a', apps } : stored)),
  );
  start();
  render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Payroll'));
  stored = preference('benefits', 2);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh preference' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Benefits'));
  expect(screen.getByRole('button', { name: 'Save default App' })).toBeDisabled();
});

test.each(['account', 'suite', 'sign-out', 'unmount'] as const)('%s change aborts and fences a delayed write', async (change) => {
  const pending = deferred();
  const fetch = server(preference(), () => pending.promise);
  start();
  const { unmount } = render(<SuiteAppPreference />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toBeEnabled());
  await choose('Benefits');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save default App' }));
  const [, writing] = fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
  act(() => {
    if (change === 'account') start('/team', 'account-b');
    else if (change === 'suite') configureSuiteNavigation({ basePath: '/other' });
    else if (change === 'sign-out') lockSessionIdentity();
    else unmount();
  });
  expect(writing.signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(reply(preference('benefits', 1)));
  });
  expect(screen.queryByText('Default App saved to your account.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull();
});

test('same-account sign-out and sign-in creates a new generation, ignoring old reads', async () => {
  const old = deferred();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/apps')) return reply({ accountId: 'account-a', apps });
      return ++reads === 1 ? old.promise : reply(preference('payday', 8));
    }),
  );
  start();
  render(<SuiteAppPreference />);
  act(() => {
    lockSessionIdentity();
    start();
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Payroll'));
  await act(async () => {
    old.resolve(reply(preference('benefits', 2)));
  });
  expect(screen.getByRole('button', { name: 'Default App' })).toHaveTextContent('Payroll');
});

test.each([preference(null, 0, 'other-account'), { accountId: 'account-a', defaultApp: null, revision: -1 }])(
  'refuses invalid preference metadata %j and offers refresh',
  async (initial) => {
    server(initial);
    start();
    render(<SuiteAppPreference />);
    expect(await screen.findByText('Your App preference could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Default App' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh preference' })).toBeEnabled();
  },
);
