import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mock = vi.hoisted(() => ({
  identity: { mode: 'authenticated', epoch: 1, accountId: 'alice', appId: 'app', tenantRequired: true },
  lease: { revision: 1, expiresAt: Date.now() + 60000 },
  active: true,
  state: { activeConnection: 'app' },
  api: vi.fn(),
  listeners: new Set<() => void>(),
  identityListeners: new Set<() => void>(),
}));
vi.mock('../../../kit/src/client/core.js', () => ({ state: mock.state, api: mock.api }));
vi.mock('../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mock.identity,
  captureTenantLease: () => mock.lease,
  tenantLeaseActive: () => mock.active,
  subscribeSessionIdentity: (listener: () => void) => {
    mock.identityListeners.add(listener);
    return () => mock.identityListeners.delete(listener);
  },
  subscribeTenantLease: (listener: () => void) => {
    mock.listeners.add(listener);
    return () => mock.listeners.delete(listener);
  },
}));
import { commandAvailable, useCommandAvailability } from './commandAvailability.js';
import { setAppRequestScope } from '../../../kit/src/client/requestIdentity.js';

const check = (id: number, command = 'assign') => ({ command, commandVersion: 1, key: { id } });
type Request = { checks: Array<{ command: string; commandVersion: number; keys: unknown[] }> };
const reply = (body: Request, available = true) => ({
  checks: body.checks.map((item) => ({
    command: item.command,
    commandVersion: item.commandVersion,
    available: item.keys.map(() => available),
  })),
});
beforeEach(() => {
  mock.identity = { mode: 'authenticated', epoch: 1, accountId: 'alice', appId: 'app', tenantRequired: true };
  mock.lease = { revision: 1, expiresAt: Date.now() + 60000 };
  mock.active = true;
  mock.state.activeConnection = 'app';
  mock.api.mockReset();
  mock.api.mockImplementation(async (_path: string, body: Request) => reply(body));
  setAppRequestScope(true);
});
afterEach(() => {
  cleanup();
});

test('many rows microtask-batch, duplicate keys coalesce, command and total-key limits split', async () => {
  const same = await Promise.all(Array.from({ length: 201 }, (_, i) => commandAvailable(check(i))));
  expect(same.every(Boolean)).toBe(true);
  expect(mock.api).toHaveBeenCalledTimes(2);
  expect(mock.api.mock.calls.map(([, body]) => body.checks[0].keys.length)).toEqual([200, 1]);
  mock.api.mockClear();
  await Promise.all([
    commandAvailable(check(1)),
    commandAvailable(check(1)),
    ...Array.from({ length: 16 }, (_, i) => commandAvailable(check(i, `c${i}`))),
  ]);
  expect(mock.api).toHaveBeenCalledTimes(2);
  const checks = mock.api.mock.calls.flatMap(([, body]) => body.checks);
  expect(checks.find((item) => item.command === 'assign').keys).toEqual([{ id: 1 }]);
  expect(mock.api.mock.calls.every(([, body]) => body.checks.length <= 16 && body.app === 'app')).toBe(true);
});

test('malformed or misaligned replies and transport errors fail closed', async () => {
  for (const response of [
    {},
    { checks: [] },
    { checks: [{ command: 'other', commandVersion: 1, available: [true] }] },
    { checks: [{ command: 'assign', commandVersion: 1, available: ['true'] }] },
    { checks: [{ command: 'assign', commandVersion: 1, available: [true, true] }] },
    { checks: Array(1) },
  ]) {
    mock.api.mockResolvedValueOnce(response);
    expect(await commandAvailable(check(1))).toBe(false);
  }
  mock.api.mockRejectedValueOnce(new Error('offline'));
  expect(await commandAvailable(check(1))).toBe(false);
});

/* One record's verbs travel in one request, and a refusal answers the request
   rather than the verb that caused it — which emptied whole action bars. Each
   command is asked again on its own, so only the unanswerable one hides. */
test('a command whose visibility cannot be answered hides only itself', async () => {
  mock.api.mockImplementation(async (_path: string, body: Request) => {
    if (body.checks.length > 1) throw new Error('the batch could not be answered');
    if (body.checks[0].command === 'bad') throw new Error('this command could not be answered');
    return reply(body);
  });
  expect(
    await Promise.all([commandAvailable(check(1, 'good')), commandAvailable(check(1, 'other')), commandAvailable(check(1, 'bad'))]),
  ).toEqual([true, true, false]);
  expect(mock.api.mock.calls.map((call) => (call[1] as Request).checks.map((item) => item.command))).toEqual([
    ['good', 'other', 'bad'],
    ['good'],
    ['other'],
    ['bad'],
  ]);
});

test('late account, connection, request-scope and lease changes cannot publish true', async () => {
  for (const change of [
    () => {
      mock.identity = { ...mock.identity, epoch: mock.identity.epoch + 1 };
    },
    () => {
      mock.state.activeConnection = 'other';
    },
    () => {
      setAppRequestScope(false);
    },
    () => {
      mock.active = false;
    },
    () => {
      mock.lease = { ...mock.lease, revision: 2 };
    },
  ]) {
    mock.state.activeConnection = 'app';
    mock.active = true;
    setAppRequestScope(true);
    let resolve!: (value: unknown) => void;
    mock.api.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = commandAvailable(check(1));
    await Promise.resolve();
    const body = mock.api.mock.calls.at(-1)![1];
    change();
    resolve(reply(body));
    expect(await result).toBe(false);
  }
});

function Probe({ surface }: { surface?: object }) {
  const available = useCommandAvailability([check(1)], true, surface);
  return <span>{available[0] ? 'visible' : 'hidden'}</span>;
}
test('same identity and lease object suspension hides true; write invalidation hides pending refetch', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  await screen.findByText('visible');
  const originalIdentity = mock.identity,
    originalLease = mock.lease;
  act(() => {
    mock.active = false;
    mock.listeners.forEach((listener) => listener());
  });
  expect(screen.getByText('hidden')).toBeTruthy();
  expect(mock.identity).toBe(originalIdentity);
  expect(mock.lease).toBe(originalLease);
  act(() => {
    mock.active = true;
    mock.listeners.forEach((listener) => listener());
  });
  await screen.findByText('visible');
  let resolve!: (value: unknown) => void;
  mock.api.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  for (let i = 0; i < 20; i++) client.setQueryData(['run', 'app', i], {});
  const before = mock.api.mock.calls.length;
  act(() => {
    void client.invalidateQueries({ queryKey: ['run'] });
  });
  await screen.findByText('hidden');
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(mock.api.mock.calls.length - before).toBe(1);
  await act(async () => {
    resolve(reply(mock.api.mock.calls.at(-1)![1], false));
  });
  expect(screen.getByText('hidden')).toBeTruthy();
});

test('same record in a replacement surface cannot reuse a late true response', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const responses: Array<() => void> = [];
  mock.api.mockImplementation(
    (_path: string, body: Request) =>
      new Promise((resolve) => {
        responses.push(() => resolve(reply(body)));
      }),
  );
  const first = {},
    next = {};
  const view = render(
    <QueryClientProvider client={client}>
      <Probe surface={first} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(responses).toHaveLength(1));
  view.rerender(
    <QueryClientProvider client={client}>
      <Probe surface={next} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(responses).toHaveLength(2));
  await act(async () => {
    responses[0]();
  });
  expect(screen.getByText('hidden')).toBeTruthy();
  await act(async () => {
    responses[1]();
  });
  await screen.findByText('visible');
});
