/* `useOpenTenant()`: the platform command runs under a key derived from the request key, then the administration door's
   openTenant under the request key itself; a retry after a failure between them sends the same keys again. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { fixtureHost, fixtures } from './fixture.js';
import { UiHostContext, type UiCommandHandle, type UiCommandOptions, type UiHost } from './context.js';

const administration = vi.hoisted(() => ({
  openAdministration: vi.fn(),
  openTenant: vi.fn(),
}));
vi.mock('../../tenantAdministration.js', () => administration);
vi.mock('@mistriwork/kit/client/sessionIdentity.js', async (load) => ({
  ...(await load<object>()),
  captureAccountIdentity: () => ({ mode: 'authenticated', accountId: 'acct-1', appId: 'clinics' }),
}));

const { profileAttempt, useOpenTenant } = await import('./openTenant.js');

const runs: { key: unknown; input: unknown; options: UiCommandOptions | undefined }[] = [];
const wrapper = ({ children }: { children: React.ReactNode }) => {
  const base = fixtureHost(fixtures({}), { look: 'mono', viewer: { signedIn: true, account: 'acct-1' } }, []);
  const handle: UiCommandHandle = {
    ...base.command('createProfile'),
    label: 'Create profile',
    granted: true,
    run: async (key, input, options) => (runs.push({ key, input, options }), { status: 'applied', output: { id: 41 } }),
  };
  const host: UiHost = { ...base, command: () => handle };
  const client = new QueryClient();
  return (
    <QueryClientProvider client={client}>
      <UiHostContext.Provider value={host}>{children}</UiHostContext.Provider>
    </QueryClientProvider>
  );
};

const session = { appId: 'clinics', accountId: 'acct-1', context: 'ctx', expiresAt: Date.now() + 600_000, maxMembershipLifetimeMs: 1 };
const opened = { tenantId: 'clinic-7', version: '1', invitation: { result: { receiptId: 'r1' }, token: 'tok' } };
const request = {
  key: 'open-clinic-7-0001',
  input: { name: 'North Clinic' },
  tenant: { tenantId: 'clinic-7' },
  invitation: { email: 'owner@example.test', roles: ['owner'], redeemUntil: 2, validUntil: 3 },
};

beforeEach(() => {
  runs.length = 0;
  administration.openAdministration.mockReset().mockResolvedValue(session);
  administration.openTenant.mockReset();
});

test('the profile key is a UUID named by the request key: the same on every retry, another for another key', async () => {
  const first = await profileAttempt('open-clinic-7-0001');
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await profileAttempt('open-clinic-7-0001')).toBe(first);
  expect(await profileAttempt('open-clinic-7-0002')).not.toBe(first);
});

test('a failure after the profile step is completed by a retry under the same keys', async () => {
  administration.openTenant.mockRejectedValueOnce(new Error('The change is unconfirmed.')).mockResolvedValueOnce(opened);
  const { result } = renderHook(() => useOpenTenant('createProfile'), { wrapper });

  let first: unknown;
  await act(async () => void (first = await result.current.open(request)));
  expect(first).toBeNull();
  expect(result.current).toMatchObject({ isPending: false, result: null });
  expect(result.current.error?.message).toBe('The change is unconfirmed.');

  let second: unknown;
  await act(async () => void (second = await result.current.open(request)));
  expect(second).toEqual(opened);
  expect(result.current).toMatchObject({ isPending: false, error: null, result: opened });

  const attempt = await profileAttempt(request.key);
  expect(runs).toEqual([
    { key: {}, input: request.input, options: { attempt, quiet: true } },
    { key: {}, input: request.input, options: { attempt, quiet: true } },
  ]);
  const sent = { key: request.key, profile: '41', tenant: request.tenant, invitation: request.invitation };
  expect(administration.openTenant.mock.calls.map((call) => call[2])).toEqual([sent, sent]);
});

test('a key the server would refuse is said before anything runs', async () => {
  const { result } = renderHook(() => useOpenTenant('createProfile'), { wrapper });
  await act(async () => void (await result.current.open({ ...request, key: 'short' })));
  expect(result.current.error).toBeInstanceOf(TypeError);
  expect(runs).toEqual([]);
  expect(administration.openTenant).not.toHaveBeenCalled();
});

test('an account the door does not open for opens nothing after the profile', async () => {
  administration.openAdministration.mockResolvedValue(null);
  const { result } = renderHook(() => useOpenTenant('createProfile'), { wrapper });
  await act(async () => void (await result.current.open(request)));
  expect(result.current.error?.message).toBe('This account cannot open tenants.');
  expect(administration.openTenant).not.toHaveBeenCalled();
});
