import { act, cleanup, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { InsertRefusal, useRecordInsert, type InsertResponse, type InsertResult } from './useRecordInsert.js';
import { establishSessionIdentity, establishTenantSelection, lockSessionIdentity, requireTenantSelection } from '../sessionIdentity.js';
import { tenantMutationState } from '../../../../mistri/src/client/tenantMutationState.js';

function deferred<T = InsertResult>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(bridgeShell);

afterEach(() => {
  cleanup();
  lockSessionIdentity();
  vi.useRealTimers();
});

function selectTenant() {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  requireTenantSelection();
  establishTenantSelection({
    appId: 'app',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab-one',
    context: 'north-context',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
}

test('an immediate second submit sends no second request; success stays locked', async () => {
  const reply = deferred();
  const insert = vi.fn(() => reply.promise);
  const added = vi.fn();
  const pending = vi.fn();
  const { result } = renderHook(() => useRecordInsert(insert, added, pending));
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.submit({ name: 'Ada' });
    void result.current.submit({ name: 'Again' });
  });
  expect(insert).toHaveBeenCalledExactlyOnceWith({ name: 'Ada' });
  expect(result.current.phase).toBe('pending');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => {
    reply.resolve({ key: { id: 1 } });
    await saving;
  });
  expect(added).toHaveBeenCalledExactlyOnceWith({ key: { id: 1 } });
  await act(() => result.current.submit({ name: 'Again' }));
  expect(insert).toHaveBeenCalledTimes(1);
  expect(pending.mock.calls).toEqual([[true], [false]]);
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test('an acknowledged rejection permits a corrected attempt', async () => {
  const insert = vi
    .fn()
    .mockResolvedValueOnce({ errors: [{ message: 'Duplicate name' }], outcome: 'rejected' })
    .mockResolvedValueOnce({ key: { id: 2 } });
  const added = vi.fn();
  const { result } = renderHook(() => useRecordInsert(insert, added));
  await act(() => result.current.submit({ name: 'Ada' }));
  expect(result.current).toMatchObject({ phase: 'idle', problem: 'Duplicate name', locked: false });
  await act(() => result.current.submit({ name: 'Grace' }));
  expect(added).toHaveBeenCalledWith({ key: { id: 2 } });
});

test('a rejected App validation response exposes only bounded field diagnostics', async () => {
  const insert = vi.fn().mockResolvedValue({
    errors: [
      {
        message: 'The record does not satisfy the application rules.',
        fields: [
          { field: 'name', message: 'This value does not meet the application rules.' },
          { field: 'name', message: 'duplicate copy' },
          { field: 'status', message: 'This value does not meet the application rules.' },
          { field: 'ignored field', message: 'not mapped' },
        ],
      },
    ],
    outcome: 'rejected',
  });
  const { result } = renderHook(() => useRecordInsert(insert, vi.fn()));
  await act(() => result.current.submit({ name: 'Ada', status: 'new' }));
  expect(result.current).toMatchObject({ phase: 'idle', locked: false, problem: 'The record does not satisfy the application rules.' });
  expect(result.current.fieldErrors).toEqual([
    { field: 'name', message: 'This value does not meet the application rules.' },
    { field: 'status', message: 'This value does not meet the application rules.' },
  ]);
});

test('unknown outcomes never project field diagnostics', async () => {
  const insert = vi.fn().mockResolvedValue({
    errors: [{ message: 'Reconcile before retrying.', fields: [{ field: 'name', message: 'Do not show' }] }],
    outcome: 'unknown',
  });
  const { result } = renderHook(() => useRecordInsert(insert, vi.fn()));
  await act(() => result.current.submit({ name: 'Ada' }));
  expect(result.current.fieldErrors).toEqual([]);
  expect(result.current.phase).toBe('uncertain');
});

test.each([new InsertRefusal('View changed'), Object.assign(new Error('Read only'), { status: 403 })])(
  'a pre-insert refusal remains correctable: %s',
  async (error) => {
    const insert = vi.fn().mockRejectedValue(error);
    const { result } = renderHook(() => useRecordInsert(insert, vi.fn()));
    await act(() => result.current.submit({}));
    expect(result.current).toMatchObject({ phase: 'idle', problem: error.message, locked: false });
  },
);

test.each([new Error('Response lost'), Object.assign(new Error('Internal error'), { status: 500 })])(
  'an unconfirmed response locks further inserts: %s',
  async (error) => {
    const insert = vi.fn().mockRejectedValue(error);
    const added = vi.fn();
    const { result } = renderHook(() => useRecordInsert(insert, added));
    await act(() => result.current.submit({}));
    expect(result.current.phase).toBe('uncertain');
    expect(result.current.problem).toContain('The row may already exist');
    await act(() => result.current.submit({}));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(added).not.toHaveBeenCalled();
  },
);

test('timeout permits dismissal but not retry; a late acknowledgement still resolves a mounted form', async () => {
  vi.useFakeTimers();
  const reply = deferred();
  const insert = vi.fn(() => reply.promise);
  const added = vi.fn();
  const pending = vi.fn();
  const { result } = renderHook(() => useRecordInsert(insert, added, pending));
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.submit({});
  });
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(result.current).toMatchObject({ phase: 'uncertain', locked: true });
  expect(pending).toHaveBeenLastCalledWith(false);
  await act(() => result.current.submit({}));
  expect(insert).toHaveBeenCalledTimes(1);
  await act(async () => {
    reply.resolve({ key: { id: 3 } });
    await saving;
  });
  expect(added).toHaveBeenCalledExactlyOnceWith({ key: { id: 3 } });
  expect(vi.getTimerCount()).toBe(0);
});

test('unmount suppresses late navigation and releases the timeout and unload warning', async () => {
  vi.useFakeTimers();
  const reply = deferred();
  const added = vi.fn();
  const pending = vi.fn();
  const { result, unmount } = renderHook(() => useRecordInsert(() => reply.promise, added, pending));
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.submit({});
  });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
  await act(async () => {
    reply.resolve({ key: { id: 4 } });
    await saving;
  });
  expect(added).not.toHaveBeenCalled();
  expect(pending.mock.calls).toEqual([[true]]);
});

test('a malformed success is not permission to retry', async () => {
  const { result } = renderHook(() => useRecordInsert(async () => ({}) as InsertResult, vi.fn()));
  await act(() => result.current.submit({}));
  expect(result.current).toMatchObject({ phase: 'uncertain', locked: true });
});

test('a valid created key cannot override an explicit unknown outcome', async () => {
  const insert = vi.fn().mockResolvedValue({ key: { id: 'opaque-created-id' }, outcome: 'unknown' });
  const added = vi.fn();
  const { result } = renderHook(() => useRecordInsert(insert, added));
  await act(() => result.current.submit({ name: 'North item' }));
  expect(result.current).toMatchObject({ phase: 'uncertain', locked: true });
  expect(added).not.toHaveBeenCalled();
  await act(() => result.current.submit({ name: 'Another item' }));
  expect(insert).toHaveBeenCalledTimes(1);
});

test.each(['unknown', undefined] as const)('an ambiguous server failure is not permission to retry (%s)', async (outcome) => {
  const insert = vi.fn().mockResolvedValue({ errors: [{ message: 'Database connection lost' }], outcome });
  const { result } = renderHook(() => useRecordInsert(insert, vi.fn()));
  await act(() => result.current.submit({}));
  expect(result.current).toMatchObject({ phase: 'uncertain', locked: true });
  expect(result.current.problem).toContain('Database connection lost');
  await act(() => result.current.submit({}));
  expect(insert).toHaveBeenCalledTimes(1);
});

test('a navigation failure after acknowledgement never reopens submission', async () => {
  const insert = vi.fn().mockResolvedValue({ key: {} });
  const { result } = renderHook(() =>
    useRecordInsert(insert, () => {
      throw new Error('Navigation failed');
    }),
  );
  await act(() => result.current.submit({}));
  expect(result.current).toMatchObject({ phase: 'succeeded', locked: true });
  expect(result.current.problem).toContain('The row was added');
});

test('explicit unknown HTTP 403 cannot unlock creation or permit a second request', async () => {
  const insert = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('Acknowledgement could not be verified'), { status: 403, outcome: 'unknown' }));
  const added = vi.fn(),
    pending = vi.fn();
  const { result } = renderHook(() => useRecordInsert(insert, added, pending));
  await act(() => result.current.submit({ name: 'North item' }));
  expect(result.current).toMatchObject({ phase: 'uncertain', locked: true });
  expect(result.current.problem).toContain('The row may already exist');
  await act(() => result.current.submit({ name: 'Different item' }));
  expect(insert).toHaveBeenCalledTimes(1);
  expect(added).not.toHaveBeenCalled();
  expect(pending.mock.calls).toEqual([[true], [false]]);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
});

test.each(['not_applied', 'rejected'])('explicit %s creation refusal permits a corrected attempt even with HTTP 503', async (outcome) => {
  const insert = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('Definitely not created'), { status: 503, outcome }))
    .mockResolvedValueOnce({ key: { id: 'opaque-created-id' } });
  const added = vi.fn();
  const { result } = renderHook(() => useRecordInsert(insert, added));
  await act(() => result.current.submit({ name: 'First' }));
  expect(result.current).toMatchObject({ phase: 'idle', locked: false, problem: 'Definitely not created' });
  await act(() => result.current.submit({ name: 'Corrected' }));
  expect(insert).toHaveBeenCalledTimes(2);
  expect(added).toHaveBeenCalledExactlyOnceWith({ key: { id: 'opaque-created-id' } });
});

test.each([
  ['applied', false],
  ['rejected', false],
  ['not_applied', false],
  ['applied', true],
  ['rejected', true],
  ['not_applied', true],
] as const)('tenant insert %s settles its pending tracker (unmounted=%s)', async (outcome, unmounted) => {
  selectTenant();
  const reply = deferred<InsertResponse>();
  const added = vi.fn();
  const { result, unmount } = renderHook(() => useRecordInsert(() => reply.promise, added));
  let saving!: Promise<void>;
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  act(() => {
    saving = result.current.submit({ name: 'North' });
  });
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  if (unmounted) unmount();
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  await act(async () => {
    if (outcome === 'applied') reply.resolve({ key: { id: 'north-item' }, outcome: 'applied' });
    else if (outcome === 'rejected') reply.resolve({ errors: [{ message: 'Denied' }], outcome: 'rejected' });
    else reply.reject(Object.assign(new Error('Denied'), { outcome: 'not_applied', status: 503 }));
    await saving;
  });
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  expect(added).toHaveBeenCalledTimes(outcome === 'applied' && !unmounted ? 1 : 0);
});

test.each(['network', 'response'])('tenant insert %s uncertainty survives unmount and leaves no retry callback', async (fault) => {
  selectTenant();
  const reply = deferred<InsertResponse>();
  const added = vi.fn(),
    insert = vi.fn(() => reply.promise);
  const { result, unmount } = renderHook(() => useRecordInsert(insert, added));
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.submit({});
  });
  unmount();
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  await act(async () => {
    if (fault === 'network') reply.reject(new Error('Response lost'));
    else reply.resolve({ errors: [{ message: 'Unconfirmed' }], outcome: 'unknown' });
    await saving;
  });
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  expect(insert).toHaveBeenCalledOnce();
  expect(added).not.toHaveBeenCalled();
  lockSessionIdentity();
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});

test.each(['applied', 'rejected', 'unknown'] as const)(
  'late tenant insert %s cannot settle a new login attempt with the same context token',
  async (outcome) => {
    selectTenant();
    const oldReply = deferred<InsertResponse>(),
      newReply = deferred<InsertResponse>();
    const oldAdded = vi.fn();
    const old = renderHook(() => useRecordInsert(() => oldReply.promise, oldAdded));
    let oldSaving!: Promise<void>, newSaving!: Promise<void>;
    act(() => {
      oldSaving = old.result.current.submit({ name: 'Old' });
    });
    old.unmount();
    lockSessionIdentity();
    expect(tenantMutationState.hasUnresolved()).toBe(false);
    selectTenant();
    const current = renderHook(() => useRecordInsert(() => newReply.promise, vi.fn()));
    act(() => {
      newSaving = current.result.current.submit({ name: 'New' });
    });
    const revision = tenantMutationState.version();
    await act(async () => {
      if (outcome === 'applied') oldReply.resolve({ key: { id: 'old' } });
      else oldReply.resolve({ errors: [{ message: 'Old result' }], outcome });
      await oldSaving;
    });
    expect(tenantMutationState.hasUnresolved()).toBe(true);
    expect(tenantMutationState.version()).toBe(revision);
    expect(current.result.current.phase).toBe('pending');
    expect(oldAdded).not.toHaveBeenCalled();
    await act(async () => {
      newReply.resolve({ key: { id: 'new' } });
      await newSaving;
    });
    expect(tenantMutationState.hasUnresolved()).toBe(false);
  },
);

test('ordinary insert never enters the tenant tracker, including after an unknown response', async () => {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  const reply = deferred();
  const { result } = renderHook(() => useRecordInsert(() => reply.promise, vi.fn()));
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.submit({});
  });
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  await act(async () => {
    reply.reject(new Error('Response lost'));
    await saving;
  });
  expect(result.current.phase).toBe('uncertain');
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});
