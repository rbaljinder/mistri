import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { commandOperations, type CommandOwner } from './commandState.js';
import {
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
} from '../../../kit/src/client/sessionIdentity.js';
import { tenantMutationState } from './tenantMutationState.js';

const owner: CommandOwner = {
  connection: 'loans',
  target: 'loan_application',
  command: 'assignReviewer',
  commandVersion: 1,
  key: { id: '9007199254740993' },
};
beforeEach(() => {
  establishSessionIdentity({ signedIn: true, accountId: 'manager', appId: 'loans' });
});
afterEach(() => {
  lockSessionIdentity();
});

test('a captured envelope cannot drift after edits, duplicate starts, or retries', async () => {
  const input = { reviewer: 7, reason: 'North desk' };
  const key = { id: '9007199254740993' };
  const operation = commandOperations.start({ ...owner, key }, 3, input);
  input.reviewer = 8;
  key.id = '2';
  expect(Object.isFrozen(operation.envelope)).toBe(true);
  expect(Object.isFrozen(operation.envelope.input)).toBe(true);
  expect(Object.isFrozen(operation.envelope.key)).toBe(true);
  const send = vi.fn().mockRejectedValue(new Error('lost'));
  await commandOperations.send(operation, 'execute', send, vi.fn());
  expect(commandOperations.start(owner, 4, { reviewer: 9 })).toBe(operation);
  expect(commandOperations.start({ ...owner, commandVersion: 2 }, 4, { reviewer: 9 })).toBe(operation);
  commandOperations.forget(owner);
  expect(commandOperations.get(owner)).toBe(operation);
  await commandOperations.send(operation, 'execute', send, vi.fn());
  expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
  expect(operation.envelope).toMatchObject({ expectedVersion: 3, key: owner.key, input: { reviewer: 7, reason: 'North desk' } });
});

test('a refusal after uncertain delivery cannot prove the first request was not applied', async () => {
  const operation = commandOperations.start(owner, 3, { reviewer: 7 });
  await commandOperations.send(
    operation,
    'execute',
    async () => {
      throw new Error('lost');
    },
    vi.fn(),
  );
  await commandOperations.send(
    operation,
    'execute',
    async () => ({ code: 'forbidden', message: 'Denied.', outcome: 'not_applied' }),
    vi.fn(),
  );
  expect(operation.phase).toBe('unknown');
  expect(commandOperations.start(owner, 4, { reviewer: 9 })).toBe(operation);
});

test('a mismatched success remains unknown and never refreshes another command or record', async () => {
  const operation = commandOperations.start(owner, 3, { reviewer: 7 });
  const applied = vi.fn();
  await commandOperations.send(
    operation,
    'execute',
    async () => ({
      status: 'applied',
      command: 'assignReviewer',
      commandVersion: 2,
      resource: owner.target,
      key: owner.key,
      receiptId: 'receipt',
    }),
    applied,
  );
  expect(operation.phase).toBe('unknown');
  expect(applied).not.toHaveBeenCalled();
});

test('a session lock drops private state and stale dispatch cannot use the new account', async () => {
  const operation = commandOperations.start(owner, 3, { reviewer: 7 });
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'manager', appId: 'loans' });
  expect(commandOperations.get(owner)).toBeUndefined();
  const request = vi.fn();
  await commandOperations.send(operation, 'execute', request, vi.fn());
  expect(request).not.toHaveBeenCalled();
});

test('an otherwise matching applied receipt cannot override an explicit unknown outcome', async () => {
  const operation = commandOperations.start(owner, 3, { reviewer: 7 });
  const applied = vi.fn();
  await commandOperations.send(
    operation,
    'execute',
    async () => ({
      status: 'applied',
      outcome: 'unknown',
      command: owner.command,
      commandVersion: owner.commandVersion,
      resource: owner.target,
      key: owner.key,
      receiptId: 'receipt',
      result: { reviewer: 7 },
    }),
    applied,
  );
  expect(operation.phase).toBe('unknown');
  expect(applied).not.toHaveBeenCalled();
  expect(commandOperations.start(owner, 4, { reviewer: 9 })).toBe(operation);
});

function selectTenant() {
  requireTenantSelection();
  establishTenantSelection({
    appId: 'loans',
    accountId: 'manager',
    tenantId: 'north',
    tabId: 'tab-one',
    context: 'same-context',
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}
const receipt = () => ({
  status: 'applied',
  command: owner.command,
  commandVersion: owner.commandVersion,
  resource: owner.target,
  key: owner.key,
  receiptId: 'opaque-receipt',
  result: { reviewer: 7 },
});

test.each(['applied', 'not_applied', 'unknown'] as const)(
  'tenant command %s tracks dispatch beyond subscriber unmount',
  async (outcome) => {
    selectTenant();
    const operation = commandOperations.start(owner, 3, { reviewer: 7 });
    expect(tenantMutationState.hasUnresolved()).toBe(false);
    const unsubscribe = commandOperations.subscribe(vi.fn());
    let finish!: (value: unknown) => void;
    const pending = commandOperations.send(
      operation,
      'execute',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      vi.fn(),
    );
    expect(tenantMutationState.hasUnresolved()).toBe(true);
    unsubscribe();
    finish(outcome === 'applied' ? receipt() : { message: 'Execution refused', outcome });
    await pending;
    expect(operation.phase).toBe(outcome === 'applied' ? 'success' : outcome === 'not_applied' ? 'error' : 'unknown');
    expect(tenantMutationState.hasUnresolved()).toBe(outcome === 'unknown');
  },
);

test('tenant command unknown survives refusal/status absence and settles only on a verified receipt, retaining its envelope', async () => {
  selectTenant();
  const operation = commandOperations.start(owner, 3, { reviewer: 7 });
  const envelope = operation.envelope;
  await commandOperations.send(
    operation,
    'execute',
    async () => {
      throw new Error('Lost response');
    },
    vi.fn(),
  );
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  await commandOperations.send(operation, 'execute', async () => ({ message: 'Not sent this time', outcome: 'not_applied' }), vi.fn());
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  await commandOperations.send(operation, 'status', async () => ({ status: 'not_found', outcome: 'unknown' }), vi.fn());
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  commandOperations.forget(owner);
  expect(commandOperations.get(owner)).toBe(operation);
  expect(operation.envelope).toBe(envelope);
  const request = vi.fn(async () => receipt());
  await commandOperations.send(operation, 'status', request, vi.fn());
  expect(request).toHaveBeenCalledWith('/api/commands/status', envelope);
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  expect(operation.phase).toBe('success');
});

test.each(['applied', 'unknown'] as const)(
  'late tenant command %s cannot settle a new same-account attempt after security lock',
  async (outcome) => {
    selectTenant();
    const old = commandOperations.start(owner, 3, { reviewer: 7 });
    let oldFinish!: (value: unknown) => void, newFinish!: (value: unknown) => void;
    const oldPending = commandOperations.send(
      old,
      'execute',
      () =>
        new Promise((resolve) => {
          oldFinish = resolve;
        }),
      vi.fn(),
    );
    lockSessionIdentity();
    expect(tenantMutationState.hasUnresolved()).toBe(false);
    establishSessionIdentity({ signedIn: true, accountId: 'manager', appId: 'loans' });
    selectTenant();
    const current = commandOperations.start(owner, 3, { reviewer: 7 });
    const pending = commandOperations.send(
      current,
      'execute',
      () =>
        new Promise((resolve) => {
          newFinish = resolve;
        }),
      vi.fn(),
    );
    oldFinish(outcome === 'applied' ? receipt() : { message: 'Old unknown', outcome });
    await oldPending;
    expect(tenantMutationState.hasUnresolved()).toBe(true);
    expect(current.phase).toBe('pending');
    newFinish(receipt());
    await pending;
    expect(tenantMutationState.hasUnresolved()).toBe(false);
  },
);
