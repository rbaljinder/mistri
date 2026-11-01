/**
 * "There is always an administrator" holds against a change by two administrators at once
 * (packages/mistri/src/server/auth/accountAdministration.ts): the administrators' rows are locked inside the change's
 * transaction and counted, and a change that would leave none is refused with a 409.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountAdminRefusal,
  createAccountAdministration,
  type AccountAdminApi,
} from '../packages/mistri/src/server/auth/accountAdministration.js';
import type { AccountAuditStore } from '../packages/mistri/src/server/auth/accountAudit.js';

const user = (id: string, role: string, banned = false) => ({ id, email: `${id}@example.org`, name: id, role, banned });

function fixture(administratorsNow: () => ReturnType<typeof user>[]) {
  const calls: string[] = [];
  const locked: string[][] = [];
  const api = {
    getSession: async () => ({ user: { id: 'a' }, session: {} }),
    getUser: async () => user('b', 'admin'),
    listUsers: async () => ({ users: administratorsNow(), total: administratorsNow().length }),
    setRole: async () => void calls.push('setRole'),
    banUser: async () => void calls.push('banUser'),
  } as unknown as AccountAdminApi;
  const audit: AccountAuditStore = {
    transaction: (work) => work(),
    write: async () => undefined,
    lock: async (ids) => void locked.push([...ids]),
    read: async () => ({ entries: [], total: 0, offset: 0 }),
  };
  return { calls, locked, admin: createAccountAdministration(api, { passwords: true, audit }) };
}

const actor = { id: 'a', who: 'a@example.org' };
const roles = ['agent', 'admin'];

test('a change that would leave no active administrator is refused, before anything is changed', async () => {
  // The actor lost the role in the same moment: the target is the only administrator the store still shows.
  const { calls, locked, admin } = fixture(() => [user('b', 'admin')]);
  await assert.rejects(
    admin.change(new Headers(), actor, { operation: 'setRoles', accountId: 'b', roles: ['agent'] }, roles),
    (error) => error instanceof AccountAdminRefusal && error.status === 409,
  );
  await assert.rejects(
    admin.change(new Headers(), actor, { operation: 'deactivate', accountId: 'b' }, roles),
    (error) => error instanceof AccountAdminRefusal && error.status === 409,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(locked, [['b'], ['b']]);
});

test('with another active administrator the change goes through, the administrators locked in id order', async () => {
  const { calls, locked, admin } = fixture(() => [user('b', 'admin'), user('a', 'agent,admin')]);
  await admin.change(new Headers(), actor, { operation: 'setRoles', accountId: 'b', roles: ['agent'] }, roles);
  assert.deepEqual(calls, ['setRole']);
  assert.deepEqual(locked, [['a', 'b']]);
});
