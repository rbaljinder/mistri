/* `useTeam()`: the tenant's members and invitations through the page's query cache, each action refreshing them, and
   an empty non-managing team outside a tenant App. `createTeamAccess` is held to the routes' own grants. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { fixtureHost, fixtures } from './fixture.js';
import { UiHostContext } from './context.js';
import { useTeam } from './team.js';
import type { TeamAccess, TeamRead } from '../../teamTypes.js';

const wrapperFor = (team?: TeamAccess) => {
  const host = fixtureHost(fixtures({}), { look: 'mono', ...(team ? { team } : {}) }, []);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <UiHostContext.Provider value={host}>{children}</UiHostContext.Provider>
    </QueryClientProvider>
  );
};

const read: TeamRead = {
  members: [{ id: 'm1', account: 'acct-eve', name: 'Eve', initials: 'E', email: 'eve@example.test', role: 'admin', you: true }],
  invitations: [{ id: 'i1', email: 'new@example.test', role: 'reader', expiresAt: 5 }],
  roles: ['admin', 'reader'],
  canManage: true,
  read: 'administration',
};

test('outside a tenant App the team is empty and manages nothing', async () => {
  const { result } = renderHook(() => useTeam(), { wrapper: wrapperFor() });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current).toMatchObject({ members: [], invitations: [], roles: [], canManage: false, read: 'none', error: null });
  await expect(result.current.invite('a@b.test', 'reader')).rejects.toThrow();
});

test('it says the team, and every action reaches the access and reads the team again', async () => {
  let reads = 0;
  const calls: string[] = [];
  const team: TeamAccess = {
    read: async () => (reads++, read),
    invite: async (email, role) => (calls.push(`invite ${email} ${role}`), { token: 't' }),
    changeRole: async (id, role) => void calls.push(`role ${id} ${role}`),
    remove: async (id) => void calls.push(`remove ${id}`),
    reissue: async (id) => (calls.push(`reissue ${id}`), {}),
    cancel: async (id) => void calls.push(`cancel ${id}`),
  };
  const { result } = renderHook(() => useTeam(), { wrapper: wrapperFor(team) });
  await waitFor(() => expect(result.current.members).toHaveLength(1));
  expect(result.current).toMatchObject({ canManage: true, roles: ['admin', 'reader'], isPending: false });
  expect(result.current.members[0]).toEqual(read.members[0]);
  expect(result.current.read).toBe('administration');
  const before = reads;
  await act(async () => {
    expect(await result.current.invite('new@example.test', 'reader')).toEqual({ token: 't' });
    await result.current.changeRole('m1', 'reader');
    await result.current.remove('m1');
    await result.current.reissue('i1');
    await result.current.cancel('i1');
  });
  expect(calls).toEqual(['invite new@example.test reader', 'role m1 reader', 'remove m1', 'reissue i1', 'cancel i1']);
  expect(reads).toBeGreaterThan(before);
});

test('a refused action rejects and still refreshes the team', async () => {
  let reads = 0;
  const team: TeamAccess = {
    read: async () => (reads++, read),
    invite: async () => Promise.reject(new Error('refused')),
    changeRole: async () => {},
    remove: async () => {},
    reissue: async () => ({}),
    cancel: async () => {},
  };
  const { result } = renderHook(() => useTeam(), { wrapper: wrapperFor(team) });
  await waitFor(() => expect(result.current.members).toHaveLength(1));
  const before = reads;
  await act(async () => {
    await expect(result.current.invite('x@y.test', 'reader')).rejects.toThrow('refused');
  });
  await waitFor(() => expect(reads).toBeGreaterThan(before));
});

afterEach(() => vi.restoreAllMocks());
