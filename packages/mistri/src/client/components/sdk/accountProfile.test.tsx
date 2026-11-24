/* `useAccountProfile()`: reading, saving without redundant cache invalidation, requesting an email change,
   error reporting, switching signed-in accounts, and the empty embedded `noAccountProfileAccess` fallback. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { type AccountProfileAccess, noAccountProfileAccess } from '../../accountProfileTypes.js';
import { CHARTS_EXPORTS, PRIMITIVES_EXPORTS, VIEWS_EXPORTS } from '../../../shared/uiSdk.js';
import * as charts from './charts.js';
import { UiHostContext, type UiViewer } from './context.js';
import { fixtureHost, fixtures } from './fixture.js';
import { useAccountProfile } from './index.js';
import * as primitives from './primitives.js';
import * as views from './views.js';

const makeWrapper = (
  viewer?: Omit<UiViewer, 'roles'> & { roles?: readonly string[] },
  accountProfile?: AccountProfileAccess,
  existingClient?: QueryClient,
) => {
  const host = fixtureHost(
    fixtures({}),
    { look: 'mono', ...(viewer ? { viewer } : {}), ...(accountProfile ? { accountProfile } : {}) },
    [],
  );
  const client = existingClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <UiHostContext.Provider value={host}>{children}</UiHostContext.Provider>
    </QueryClientProvider>
  );
  return { Wrapper, client };
};

test('lazy UI host modules export the exact names the server SDK manifest serves', () => {
  expect(Object.keys(primitives).sort()).toEqual([...PRIMITIVES_EXPORTS].sort());
  expect(Object.keys(charts).sort()).toEqual([...CHARTS_EXPORTS].sort());
  expect(Object.keys(views).sort()).toEqual([...VIEWS_EXPORTS].sort());
});

test('useAccountProfile reads, saves once into cache without refetching, and requests email changes', async () => {
  const emailRequests: string[] = [];
  const read = vi.fn(async () => ({
    accountId: 'maya',
    appId: 'app',
    name: 'Maya',
    email: 'maya@example.test',
    providers: ['email'],
    emailChange: true as const,
  }));
  const save = vi.fn(async (name: string) => ({
    accountId: 'maya',
    appId: 'app',
    name,
    email: 'maya@example.test',
    providers: ['email'],
    emailChange: true as const,
  }));
  const changeEmail = vi.fn(async (next: string) => {
    emailRequests.push(next);
  });

  const { Wrapper } = makeWrapper({ signedIn: true, account: 'maya' }, { read, save, changeEmail });
  const { result } = renderHook(() => useAccountProfile(), { wrapper: Wrapper });

  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.isSaving).toBe(false);
  expect(result.current.profile).toMatchObject({ name: 'Maya', email: 'maya@example.test' });
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.save('Maya Lin');
  });
  await waitFor(() => expect(result.current.profile?.name).toBe('Maya Lin'));
  expect(result.current.isSaving).toBe(false);
  // Writing directly into the query cache avoids an extra network read after save.
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.changeEmail('maya.lin@example.test');
  });
  expect(emailRequests).toEqual(['maya.lin@example.test']);
});

test('useAccountProfile surfaces read, save, and changeEmail errors cleanly', async () => {
  const failingAccess: AccountProfileAccess = {
    read: async () => {
      throw new Error('Your profile could not be loaded.');
    },
    save: async () => {
      throw new Error('Name rejected.');
    },
    changeEmail: async () => {
      throw new Error('Email change unavailable.');
    },
  };
  const { Wrapper } = makeWrapper({ signedIn: true, account: 'maya' }, failingAccess);
  const { result } = renderHook(() => useAccountProfile(), { wrapper: Wrapper });

  await waitFor(() => expect(result.current.error?.message).toBe('Your profile could not be loaded.'));
  expect(result.current.profile).toBeNull();
  expect(result.current.isPending).toBe(false);
  expect(result.current.isSaving).toBe(false);

  await expect(result.current.save('Bad')).rejects.toThrow('Name rejected.');
  await expect(result.current.changeEmail('bad@example.test')).rejects.toThrow('Email change unavailable.');
});

test('useAccountProfile isolates cache entries when switching signed-in accounts or signing out', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = makeWrapper({ signedIn: true, account: 'maya' }, undefined, client);
  const mayaHook = renderHook(() => useAccountProfile(), { wrapper: first.Wrapper });
  await waitFor(() => expect(mayaHook.result.current.profile?.accountId).toBe('maya'));

  const second = makeWrapper({ signedIn: true, account: 'omar' }, undefined, client);
  const omarHook = renderHook(() => useAccountProfile(), { wrapper: second.Wrapper });
  await waitFor(() => expect(omarHook.result.current.profile?.accountId).toBe('omar'));
  expect(omarHook.result.current.profile?.email).toBe('omar@example.test');

  const signedOut = makeWrapper({ signedIn: false }, undefined, client);
  const guestHook = renderHook(() => useAccountProfile(), { wrapper: signedOut.Wrapper });
  expect(guestHook.result.current.profile).toBeNull();
  expect(guestHook.result.current.isPending).toBe(false);
});

test('embedded headless surfaces return null profile and refuse mutations through noAccountProfileAccess', async () => {
  const { Wrapper } = makeWrapper({ signedIn: true, account: 'maya' }, noAccountProfileAccess);
  const { result } = renderHook(() => useAccountProfile(), { wrapper: Wrapper });

  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.profile).toBeNull();
  expect(result.current.error).toBeNull();
  await expect(result.current.save('Maya')).rejects.toThrow('There is no account profile to change here.');
  await expect(result.current.changeEmail('maya@example.test')).rejects.toThrow('There is no account profile to change here.');
});

test('createAccountProfileAccess checks owner.appId across read, save, and changeEmail', async () => {
  const { createAccountProfileAccess } = await import('../../accountProfileAccess.js');
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  try {
    const access = createAccountProfileAccess(() => ({
      mode: 'authenticated',
      accountId: 'maya',
      appId: null,
      epoch: 1,
    }));
    expect(await access.read()).toBeNull();
    await expect(access.save('Maya Lin')).rejects.toThrow('There is no account profile to change here.');
    await expect(access.changeEmail('maya@example.test')).rejects.toThrow('There is no account profile to change here.');
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
