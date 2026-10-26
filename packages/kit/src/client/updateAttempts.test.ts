import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';
import { createUpdateAttempts, updateOwnerKey } from './updateAttempts.js';
import { establishSessionIdentity, establishTenantSelection, lockSessionIdentity, requireTenantSelection } from './sessionIdentity.js';
import { tenantMutationState } from '../../../mistri/src/client/tenantMutationState.js';

const owner = { connection: 'demo', table: 'customer', key: { id: 4 } };
const values = { name: 'Ada', active: true, email: null };
const success = { affected: 1, applied: values };
beforeEach(bridgeShell);

afterEach(() => {
  vi.useRealTimers();
  lockSessionIdentity();
});

test.each(['applied', 'rejected', 'unknown'])('reset retires late %s settlement without touching a new same-key owner', async (outcome) => {
  const attempts = createUpdateAttempts();
  let finish!: (value: unknown) => void, fail!: (value: unknown) => void;
  const old = attempts.run(
    owner,
    values,
    () =>
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  attempts.reset();
  expect(attempts.hasUnresolved()).toBe(false);
  let newer!: (value: unknown) => void;
  const pending = attempts.run(
    owner,
    { name: 'New tenant' },
    () =>
      new Promise((resolve) => {
        newer = resolve;
      }),
  );
  if (outcome === 'applied') finish(success);
  else if (outcome === 'rejected') fail(Object.assign(new Error('Old refusal'), { status: 403 }));
  else fail(new Error('Unknown old outcome'));
  await old;
  expect(attempts.get(owner)).toEqual({ phase: 'pending', values: { name: 'New tenant' }, message: '' });
  newer({ affected: 1, applied: { name: 'New tenant' } });
  await pending;
  expect(attempts.hasUnresolved()).toBe(false);
});

test('only a complete one-record acknowledgement unlocks success', async () => {
  const attempts = createUpdateAttempts();
  expect(await attempts.run(owner, values, async () => success)).toEqual({ kind: 'applied', applied: values });
  expect(attempts.get(owner)).toBeUndefined();
});

test('a column the server wrote of its own in the same row (a state stamp) still confirms the write', async () => {
  const attempts = createUpdateAttempts();
  const stamped = { ...values, approved_at: '2026-10-11 09:30:00' };
  expect(await attempts.run(owner, values, async () => ({ affected: 1, applied: stamped }))).toEqual({ kind: 'applied', applied: stamped });
  expect(attempts.get(owner)).toBeUndefined();
});

test('valid update fields cannot override an explicit unknown outcome', async () => {
  const attempts = createUpdateAttempts(() => true);
  const send = vi.fn().mockResolvedValue({ ...success, undoId: 'opaque-token', outcome: 'unknown' });
  expect((await attempts.run(owner, values, send)).kind).toBe('uncertain');
  expect(attempts.hasUnresolved()).toBe(true);
  expect((await attempts.run(owner, values, send)).kind).toBe('blocked');
  expect(send).toHaveBeenCalledTimes(1);
});

test('a save exposes only a valid acknowledged undo identity', async () => {
  const attempts = createUpdateAttempts();
  expect(await attempts.run(owner, values, async () => ({ ...success, undoId: 42 }))).toEqual({
    kind: 'applied',
    applied: values,
    undoId: 42,
  });
  for (const undoId of [undefined, null, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
    expect(await attempts.run(owner, values, async () => ({ ...success, undoId }))).toEqual({ kind: 'applied', applied: values });
  }
});

test.each([
  null,
  {},
  { applied: values },
  { affected: 0, applied: values },
  { affected: 2, applied: values },
  { affected: 1, applied: {} },
  { affected: 1, applied: { name: values.name } },
  { affected: 1, applied: { ...values, email: undefined } },
  { affected: 1, applied: { ...values, email: [] } },
  { affected: 1, applied: { ...values, email: NaN } },
  { errors: [] },
  { errors: [{ message: 'Something failed' }] },
  { errors: [{ message: 'Something failed' }], outcome: 'unknown' },
])('invalid or unconfirmed acknowledgement is retained without retry: %j', async (result) => {
  const attempts = createUpdateAttempts();
  expect((await attempts.run(owner, values, async () => result)).kind).toBe('uncertain');
  expect(attempts.get(owner)?.values).toEqual(values);
  const send = vi.fn();
  expect((await attempts.run(owner, values, send)).kind).toBe('blocked');
  expect(send).not.toHaveBeenCalled();
});

test.each([400, 401, 403, 404, 409, 422, 501])('an explicit HTTP %s refusal permits correction', async (status) => {
  const attempts = createUpdateAttempts();
  const result = await attempts.run(owner, values, async () => {
    throw Object.assign(new Error('Refused'), { status });
  });
  expect(result).toEqual({ kind: 'rejected', message: 'Refused' });
  expect(attempts.hasUnresolved()).toBe(false);
  expect((await attempts.run(owner, values, async () => success)).kind).toBe('applied');
});

test.each([undefined, 500, 502, 503, 504])('transport and HTTP %s failures never prove rejection', async (status) => {
  const attempts = createUpdateAttempts();
  const result = await attempts.run(owner, values, async () => {
    throw Object.assign(new Error('Lost response'), { status });
  });
  expect(result.kind).toBe('uncertain');
  expect(attempts.hasUnresolved()).toBe(true);
});

test('a structured server rejection permits correction', async () => {
  const attempts = createUpdateAttempts();
  expect(await attempts.run(owner, values, async () => ({ errors: [{ message: 'Constraint refused' }], outcome: 'rejected' }))).toEqual({
    kind: 'rejected',
    message: 'Constraint refused',
  });
  expect(attempts.hasUnresolved()).toBe(false);
});

test('pending and timed-out attempts stay single-flight; late acknowledgement settles the original only', async () => {
  vi.useFakeTimers();
  const attempts = createUpdateAttempts();
  let resolve!: (value: unknown) => void;
  const pending = attempts.run(
    owner,
    values,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  expect(attempts.get(owner)?.phase).toBe('pending');
  expect((await attempts.run(owner, values, vi.fn())).kind).toBe('blocked');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(attempts.get(owner)?.phase).toBe('uncertain');
  expect(attempts.get(owner)?.detail).toContain('may still complete');
  expect((await attempts.run(owner, values, vi.fn())).kind).toBe('blocked');
  const other = { ...owner, connection: 'other' };
  await attempts.run(other, values, async () => {
    throw Error('Offline');
  });
  resolve(success);
  expect((await pending).kind).toBe('applied');
  expect(attempts.get(owner)).toBeUndefined();
  expect(attempts.get(other)?.phase).toBe('uncertain');
});

test('record identity follows URL scalar strings and key order, but distinguishes connections', () => {
  expect(updateOwnerKey({ ...owner, key: { tenant: 1, id: 4 } })).toBe(updateOwnerKey({ ...owner, key: { id: 4, tenant: 1 } }));
  expect(updateOwnerKey(owner)).not.toBe(updateOwnerKey({ ...owner, connection: 'other' }));
  expect(updateOwnerKey(owner)).toBe(updateOwnerKey({ ...owner, key: { id: '4' } }));
});

test('tenant update accepts opaque acknowledgement tokens but never ordinary numeric IDs', async () => {
  const attempts = createUpdateAttempts(() => true);
  for (const undoId of ['opaque-token', '9007199254740993', 'x'.repeat(128)]) {
    expect(await attempts.run(owner, values, async () => ({ ...success, undoId }))).toEqual({ kind: 'applied', applied: values, undoId });
  }
  for (const undoId of [42, 0, null, '', ' invalid', 'invalid ', 'line\nbreak', 'x'.repeat(129)]) {
    expect(await attempts.run(owner, values, async () => ({ ...success, undoId }))).toEqual({ kind: 'applied', applied: values });
  }
});

test.each([true, false])('history-token mode is captured at dispatch, initially tenant=%s', async (initial) => {
  let tenant = initial;
  const mode = vi.fn(() => tenant),
    attempts = createUpdateAttempts(mode);
  let resolve!: (value: unknown) => void;
  const pending = attempts.run(
    owner,
    values,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  tenant = !initial;
  const undoId = initial ? 'opaque-token' : 42;
  resolve({ ...success, undoId });
  expect(await pending).toEqual({ kind: 'applied', applied: values, undoId });
  expect(mode).toHaveBeenCalledTimes(1);
});

test.each([true, false])('error-classification mode is captured before a callback change, initially tenant=%s', async (initial) => {
  let tenant = initial;
  const attempts = createUpdateAttempts(() => tenant);
  let reject!: (error: Error) => void;
  const pending = attempts.run(
    owner,
    values,
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  tenant = !initial;
  reject(Object.assign(new Error('Bare HTTP refusal'), { status: 403 }));
  expect((await pending).kind).toBe(initial ? 'uncertain' : 'rejected');
  expect(attempts.hasUnresolved()).toBe(initial);
});

test.each([true, false])('explicit unknown HTTP 403 retains the attempt and blocks retry (tenant=%s)', async (tenant) => {
  const attempts = createUpdateAttempts(() => tenant);
  const send = vi.fn().mockRejectedValue(Object.assign(new Error('No verified acknowledgement'), { status: 403, outcome: 'unknown' }));
  expect((await attempts.run(owner, values, send)).kind).toBe('uncertain');
  expect(attempts.get(owner)?.phase).toBe('uncertain');
  expect((await attempts.run(owner, values, send)).kind).toBe('blocked');
  expect(send).toHaveBeenCalledTimes(1);
});

test.each(['not_applied', 'rejected'])('tenant explicit %s permits correction independently of HTTP status', async (outcome) => {
  const attempts = createUpdateAttempts(() => true);
  expect(
    await attempts.run(owner, values, async () => {
      throw Object.assign(new Error('Definitely not changed'), { status: 503, outcome });
    }),
  ).toEqual({ kind: 'rejected', message: 'Definitely not changed' });
  expect(attempts.hasUnresolved()).toBe(false);
  expect((await attempts.run(owner, values, async () => success)).kind).toBe('applied');
});

function selectTenant(context = 'north-context') {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'demo' });
  requireTenantSelection();
  establishTenantSelection({
    appId: 'demo',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab-one',
    context,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}

test.each(['applied', 'rejected', 'unknown'] as const)(
  'tenant update %s settles the global tracker correctly even after subscriber unmount',
  async (outcome) => {
    selectTenant();
    const attempts = createUpdateAttempts(() => true);
    const unsubscribe = attempts.subscribe(vi.fn());
    let finish!: (value: unknown) => void;
    const pending = attempts.run(
      owner,
      values,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(tenantMutationState.hasUnresolved()).toBe(true);
    unsubscribe();
    finish(outcome === 'applied' ? success : { errors: [{ message: 'Not confirmed' }], outcome });
    expect((await pending).kind).toBe(outcome === 'unknown' ? 'uncertain' : outcome);
    expect(tenantMutationState.hasUnresolved()).toBe(outcome === 'unknown');
  },
);

test('timed-out tenant update remains globally unresolved until its original acknowledgment arrives', async () => {
  vi.useFakeTimers();
  selectTenant();
  const attempts = createUpdateAttempts(() => true);
  let finish!: (value: unknown) => void;
  const pending = attempts.run(
    owner,
    values,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(30000);
  expect(attempts.get(owner)?.phase).toBe('uncertain');
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  finish(success);
  await pending;
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});

test.each(['applied', 'unknown'] as const)('late %s update cannot clear the new same-account tenant tracker', async (outcome) => {
  selectTenant();
  const attempts = createUpdateAttempts(() => true);
  let oldFinish!: (value: unknown) => void, newFinish!: (value: unknown) => void;
  const old = attempts.run(
    owner,
    values,
    () =>
      new Promise((resolve) => {
        oldFinish = resolve;
      }),
  );
  lockSessionIdentity();
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  selectTenant();
  attempts.reset();
  const current = attempts.run(
    owner,
    values,
    () =>
      new Promise((resolve) => {
        newFinish = resolve;
      }),
  );
  oldFinish(outcome === 'applied' ? success : { errors: [{ message: 'Old unknown' }], outcome });
  await old;
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  expect(attempts.get(owner)?.phase).toBe('pending');
  newFinish(success);
  await current;
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});

test('ordinary pending update never enters the tenant tracker', async () => {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'demo' });
  const attempts = createUpdateAttempts();
  let finish!: (value: unknown) => void;
  const pending = attempts.run(
    owner,
    values,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  finish(success);
  await pending;
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});
