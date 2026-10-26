import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { clearJournal, history, latestRevertible, recordWrite } from '../packages/engine/src/server/journal.js';
import type { HistoryDraft } from '../packages/engine/src/server/recordHistoryOperations.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  createTenantHistoryPartitions,
  TenantHistoryBusy,
  type TenantHistoryLease,
} from '../packages/mistri/src/server/tenant/tenantHistoryPartitions.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import type { TenantSourceIdentity } from '../packages/mistri/src/server/tenant/tenantSourceIdentity.js';

const identity: TenantSourceIdentity = {
  canonicalPath: '/private/owned.db',
  storeId: 'private-store',
  appId: 'app',
  source: { id: 'business', connection: 'private-connection' },
};
const principal: TenantMembershipEvidence = {
  appId: 'app',
  source: identity.source,
  deployment: 'deployment',
  tenantId: 'north',
  accountId: 'alice',
  membershipId: 'grant',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['editor', 'reviewer'],
  verifiedAt: 1000,
  validUntil: 2000,
};
const draft = (summary = 'Updated record'): HistoryDraft => ({
  kind: 'update',
  summary,
  revertible: true,
  steps: [{ table: 'item', key: { id: 'one' }, before: { name: 'Before' }, after: { name: 'After' }, exactFields: true }],
});
const plain = <T>(value: T): T => structuredClone(value);
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  return true;
}
function fixture(t: TestContext, input = plain(identity), deployment = 'deployment') {
  const owner = createTenantHistoryPartitions(input, deployment),
    leases: TenantHistoryLease[] = [];
  t.after(() => {
    for (const lease of leases) lease.release();
    owner.dispose();
  });
  const enter = (member = plain(principal)) => {
    const lease = owner.enter(member);
    leases.push(lease);
    return lease;
  };
  return { owner, enter };
}

test('frozen private lease reuses the existing journal with opaque bucket and captured attribution', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    input = draft();
  assert.ok(Object.isFrozen(f.owner));
  assert.ok(Object.isFrozen(lease));
  assert.match(lease.id, /^tenant-history:[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(f.owner).sort(), ['dispose', 'enter']);
  assert.deepEqual(Object.keys(lease).sort(), [
    'beginUndo',
    'failUndo',
    'finishUndo',
    'history',
    'id',
    'publish',
    'quarantine',
    'release',
    'resolve',
    'token',
  ]);
  const published = lease.publish({ ...input, by: 'forged', principal: 'mallory', app: 'other-app' });
  assert.equal(published.connection, lease.id);
  assert.equal(published.principal, 'alice');
  assert.equal(published.by, 'alice');
  assert.equal(published.app, 'app');
  assert.deepEqual(plain(history(lease.id, 50)), plain(lease.history()));
  assert.notEqual(published, history(lease.id)[0]);
  assert.ok(Object.isFrozen(published));
  assert.ok(Object.isFrozen(published.steps[0].before));
  input.steps[0].before!.name = 'Mutated';
  assert.equal(Reflect.set(published.steps[0].after!, 'name', 'Mutated'), false);
  assert.equal(Reflect.set(lease.history()[0], 'revertible', false), false);
  assert.equal(lease.history()[0].steps[0].before!.name, 'Before');
  assert.equal(lease.history()[0].steps[0].after!.name, 'After');
});

test('identity and principal capture survive caller mutation; admission clocks and role order do not reset history', (t) => {
  const input = plain(identity),
    member = plain(principal),
    f = fixture(t, input),
    lease = f.enter(member);
  const entry = lease.publish(draft());
  Reflect.set(input, 'storeId', 'new-store');
  Reflect.set(input.source, 'connection', 'new-connection');
  Reflect.set(member, 'accountId', 'mallory');
  Reflect.set(member.roles, '0', 'admin');
  assert.equal(lease.history()[0].principal, 'alice');
  lease.release();
  const next = f.enter({ ...principal, verifiedAt: 1500, validUntil: 3000, roles: [...principal.roles].reverse() });
  assert.equal(next.id, lease.id);
  assert.equal(next.history()[0].id, entry.id);
});

for (const field of ['tenantId', 'accountId', 'membershipId', 'membershipVersion', 'tenantVersion', 'roles'] as const) {
  test(`${field} partitions history, busy gates and expected Undo IDs`, (t) => {
    const f = fixture(t),
      a = f.enter(),
      entry = a.publish(draft());
    const changed = {
      ...principal,
      [field]: field === 'roles' ? ['admin'] : field.endsWith('Version') ? '2' : `${principal[field]}-other`,
    };
    const b = f.enter(changed);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(b.history(), []);
    const own = b.publish(draft('Other grant'));
    assert.throws(() => b.beginUndo(entry.id), safe);
    b.beginUndo(own.id);
    b.failUndo(own.id, true);
    assert.equal(a.history()[0].revertible, true);
    a.beginUndo(entry.id);
    a.failUndo(entry.id, false);
  });
}

for (const field of ['canonicalPath', 'storeId', 'appId', 'sourceId', 'connection', 'deployment'] as const) {
  test(`independent ${field} namespace cannot share a journal`, (t) => {
    const a = fixture(t),
      first = a.enter(),
      entry = first.publish(draft());
    const next = plain(identity);
    let deployment = 'deployment';
    if (field === 'sourceId') Reflect.set(next.source, 'id', 'other');
    else if (field === 'connection') Reflect.set(next.source, 'connection', 'other');
    else if (field === 'deployment') deployment = 'next-deployment';
    else Reflect.set(next, field, field === 'canonicalPath' ? '/private/copy.db' : 'other');
    const b = fixture(t, next, deployment),
      second = b.enter({ ...principal, appId: next.appId, source: next.source, deployment });
    assert.notEqual(first.id, second.id);
    assert.deepEqual(second.history(), []);
    assert.throws(() => second.beginUndo(entry.id), safe);
    b.owner.dispose();
    second.release();
    assert.equal(first.history()[0].id, entry.id);
  });
}

test('two owners with identical labels still have independent private lifecycle ownership', (t) => {
  const a = fixture(t),
    b = fixture(t),
    first = a.enter(),
    second = b.enter();
  const entry = first.publish(draft());
  second.publish(draft());
  assert.notEqual(first.id, second.id);
  second.release();
  b.owner.dispose();
  assert.equal(first.history()[0].id, entry.id);
});

test('opaque tuple components cannot collide through separator concatenation', (t) => {
  const f = fixture(t),
    a = f.enter({ ...principal, accountId: 'alice|grant', membershipId: 'next' });
  const b = f.enter({ ...principal, accountId: 'alice', membershipId: 'grant|next' });
  assert.notEqual(a.id, b.id);
});

test('same partition is busy until idempotent release; stale handles cannot change a new lease', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entry = lease.publish(draft());
  assert.throws(
    () => f.enter(),
    (error) => {
      assert.ok(error instanceof TenantHistoryBusy);
      assert.equal(error.code, 'tenant_history_busy');
      assert.equal(error.message, 'The tenant history is already in use.');
      assert.equal('cause' in error, false);
      return true;
    },
  );
  lease.release();
  lease.release();
  const next = f.enter();
  for (const call of [
    () => lease.history(),
    () => lease.publish(draft()),
    () => lease.beginUndo(entry.id),
    () => lease.finishUndo(entry.id),
    () => lease.failUndo(entry.id, false),
    () => lease.token(entry.id),
    () => lease.resolve('foreign'),
  ])
    assert.throws(call, safe);
  assert.doesNotThrow(lease.quarantine);
  assert.equal(next.history()[0].revertible, true);
});

test('Undo marks canonical newest entry pending, known rollback clears it and committed finish forgets it', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    older = lease.publish(draft('Older')),
    newest = lease.publish(draft('Newest'));
  assert.throws(() => lease.beginUndo(older.id), safe);
  lease.beginUndo(newest.id);
  assert.equal(history(lease.id)[0].undoState, 'pending');
  assert.equal(newest.undoState, undefined);
  assert.throws(() => lease.beginUndo(newest.id), safe);
  assert.throws(() => lease.finishUndo(older.id), safe);
  assert.throws(() => lease.failUndo(older.id, false), safe);
  assert.throws(() => lease.publish(draft()), TenantHistoryBusy);
  lease.failUndo(newest.id, false);
  assert.equal(history(lease.id)[0].undoState, undefined);
  assert.equal(lease.history().length, 2);
  lease.beginUndo(newest.id);
  lease.finishUndo(newest.id);
  assert.equal(lease.history()[0].id, older.id);
  assert.throws(() => lease.finishUndo(newest.id), safe);
  lease.beginUndo(older.id);
  lease.finishUndo(older.id);
  assert.deepEqual(lease.history(), []);
});

for (const barrier of [{ revertible: false }, { blocksUndo: true }, { undoState: 'unknown' as const }]) {
  test(`newest ${JSON.stringify(barrier)} cannot be bypassed with an older ID`, (t) => {
    const f = fixture(t),
      lease = f.enter(),
      older = lease.publish(draft('Visible older'));
    const newest = lease.publish({ ...draft('Hidden newest'), ...barrier });
    assert.throws(() => lease.beginUndo(older.id), safe);
    assert.throws(() => lease.beginUndo(newest.id), safe);
    if (!newest.undoState && !newest.blocksUndo) assert.equal(latestRevertible(lease.history())?.id, older.id);
  });
}

for (const action of ['unknown', 'release', 'quarantine'] as const) {
  test(`${action} during pending Undo preserves canonical uncertainty barriers`, (t) => {
    const f = fixture(t),
      lease = f.enter();
    lease.publish(draft('Older'));
    const newest = lease.publish(draft('Newest'));
    lease.beginUndo(newest.id);
    if (action === 'unknown') lease.failUndo(newest.id, true);
    if (action === 'release') lease.release();
    if (action === 'quarantine') lease.quarantine();
    assert.ok(history(lease.id, 50).every((entry) => entry.undoState === 'unknown' && !entry.revertible));
    assert.throws(() => lease.finishUndo(newest.id));
    assert.throws(() => lease.beginUndo(newest.id));
    lease.release();
    const next = f.enter();
    assert.equal(latestRevertible(next.history()), undefined);
  });
}

test('quarantine cannot consult a failing publication clock and affects only its owned bucket', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    other = f.enter({ ...principal, accountId: 'bob' });
  lease.publish(draft());
  other.publish(draft());
  const mocked = t.mock.method(Date.prototype, 'toISOString', () => {
    throw new Error('private-clock');
  });
  try {
    assert.throws(() => lease.publish(draft()));
    assert.doesNotThrow(lease.quarantine);
    assert.doesNotThrow(lease.quarantine);
  } finally {
    mocked.mock.restore();
  }
  assert.equal(lease.history()[0].undoState, 'unknown');
  assert.equal(other.history()[0].revertible, true);
});

test('dispose stops entry, clears idle owned buckets and defers busy cleanup without touching ordinary journals', (t) => {
  const f = fixture(t),
    idle = f.enter(),
    busy = f.enter({ ...principal, accountId: 'bob' });
  const outsider = `ordinary-test:${randomUUID()}`;
  t.after(() => clearJournal(outsider));
  recordWrite(outsider, draft());
  idle.publish(draft());
  const entry = busy.publish(draft());
  idle.release();
  busy.beginUndo(entry.id);
  f.owner.dispose();
  f.owner.dispose();
  assert.throws(() => f.enter(), safe);
  assert.deepEqual(history(idle.id), []);
  assert.equal(history(busy.id)[0].undoState, 'pending');
  busy.finishUndo(entry.id);
  busy.publish(draft('Accepted completion'));
  busy.release();
  assert.deepEqual(history(busy.id), []);
  assert.equal(history(outsider).length, 1);
  clearJournal(idle.id);
  clearJournal(busy.id);
});

test('journal keeps exactly the existing 50-entry depth and cannot Undo an evicted ID', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    first = lease.publish(draft('0'));
  for (let i = 1; i <= 60; i++) lease.publish(draft(String(i)));
  assert.equal(lease.history().length, 50);
  assert.equal(lease.history()[0].summary, '60');
  assert.equal(lease.history()[49].summary, '11');
  assert.throws(() => lease.beginUndo(first.id), safe);
});

test('1024-partition bound refuses new ownership without evicting existing history', (t) => {
  const f = fixture(t),
    first = f.enter(),
    entry = first.publish(draft());
  first.release();
  for (let i = 1; i < 1024; i++) f.enter({ ...principal, accountId: `account-${i}` }).release();
  assert.throws(() => f.enter({ ...principal, accountId: 'overflow' }), safe);
  const retained = f.enter();
  assert.equal(retained.history()[0].id, entry.id);
});

const malformed: Array<Partial<TenantMembershipEvidence>> = [
  { appId: 'other' },
  { source: { ...identity.source, id: 'Business' } },
  { source: { ...identity.source, connection: 'other' } },
  { deployment: 'other' },
  { tenantId: 'North' },
  { tenantId: 'north ' },
  { accountId: '' },
  { membershipId: '' },
  { membershipVersion: '0' },
  { membershipVersion: '01' },
  { membershipVersion: '1'.repeat(129) },
  { tenantVersion: '-1' },
  { roles: ['editor', 'editor'] },
  { roles: [''] },
  { roles: Array.from({ length: 257 }, (_, i) => `role-${i}`) },
  { verifiedAt: -1 },
  { verifiedAt: 1.5 },
  { verifiedAt: NaN },
  { validUntil: Infinity },
  { validUntil: 1000 },
  { validUntil: Number.MAX_SAFE_INTEGER + 1 },
];
for (const [index, patch] of malformed.entries())
  test(`malformed or mismatched principal ${index} refuses without taking a lease`, (t) => {
    const f = fixture(t);
    assert.throws(() => f.enter({ ...principal, ...patch }), safe);
    assert.ok(f.enter());
  });

test('strict principal and namespace shapes reject missing/extra data, proxies and getters without executing them', (t) => {
  const f = fixture(t);
  let calls = 0;
  const getter = {
    ...principal,
    get roles() {
      calls++;
      return [];
    },
  };
  const proxy = new Proxy(principal, {
    ownKeys() {
      calls++;
      return [];
    },
  });
  const revoked = Proxy.revocable(principal, {});
  revoked.revoke();
  for (const value of [
    null,
    undefined,
    [],
    {},
    { ...principal, tenant: 'north' },
    { ...principal, source: { ...principal.source, extra: true } },
    getter,
    proxy,
    revoked.proxy,
  ]) {
    assert.throws(() => f.owner.enter(value as TenantMembershipEvidence), safe);
  }
  for (const field of Object.keys(principal)) {
    const value = plain(principal);
    Reflect.deleteProperty(value, field);
    assert.throws(() => f.enter(value), safe);
  }
  const badIdentity = {
    ...identity,
    get storeId() {
      calls++;
      return 'store';
    },
  };
  for (const value of [
    badIdentity,
    new Proxy(identity, {
      ownKeys() {
        calls++;
        return [];
      },
    }),
    { ...identity, canonicalPath: 'relative.db' },
    { ...identity, storeId: '' },
    { ...identity, source: { ...identity.source, id: 'source.alias' } },
    { ...identity, extra: true },
  ]) {
    assert.throws(() => createTenantHistoryPartitions(value, 'deployment'), safe);
  }
  assert.throws(() => createTenantHistoryPartitions(identity, ''), safe);
  assert.equal(calls, 0);
});

test('malformed draft data and forged canonical fields never enter the journal', (t) => {
  const f = fixture(t),
    lease = f.enter();
  let calls = 0;
  const getter = {
    ...draft(),
    get steps() {
      calls++;
      return [];
    },
  };
  const proxy = new Proxy(draft(), {
    ownKeys() {
      calls++;
      return [];
    },
  });
  const values = [
    null,
    undefined,
    {},
    getter,
    proxy,
    { ...draft(), id: 1 },
    { ...draft(), at: 'forged' },
    { ...draft(), connection: 'other' },
    { ...draft(), undoState: 'pending' },
    { ...draft(), undoState: 'other' },
    { ...draft(), kind: 'other' },
    { ...draft(), revertible: 1 },
    { ...draft(), steps: [{ table: 'item', extra: true }] },
    { ...draft(), steps: [{ table: 'item', wholeRow: 'yes' }] },
    { ...draft(), summary: 'x'.repeat(1_048_577) },
  ];
  for (const input of values) {
    assert.throws(() => lease.publish(input as HistoryDraft));
    assert.deepEqual(lease.history(), []);
  }
  assert.equal(calls, 0);
  assert.ok(lease.publish(draft()));
});

test('noncanonical Undo IDs and unknown flag refuse without changing pending state', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entry = lease.publish(draft());
  for (const id of [0, -1, 1.5, NaN, Infinity, String(entry.id), {}, null]) {
    assert.throws(() => lease.beginUndo(id as number), safe);
    assert.equal(history(lease.id)[0].undoState, undefined);
  }
  assert.throws(() => lease.finishUndo(entry.id), safe);
  assert.throws(() => lease.failUndo(entry.id, false), safe);
  lease.beginUndo(entry.id);
  assert.throws(() => lease.failUndo(entry.id, 'false' as unknown as boolean), safe);
  assert.equal(history(lease.id)[0].undoState, 'pending');
  lease.failUndo(entry.id, false);
});

test('opaque tokens are stable across history copies, previews and renewed leases without exposing numeric IDs', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entry = lease.publish(draft());
  const token = lease.token(entry.id);
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(lease.resolve(token), entry.id);
  assert.equal(lease.token(lease.history()[0].id), token);
  assert.equal(lease.token(plain(lease.history())[0].id), token);
  assert.equal(lease.resolve(String(entry.id)), undefined);
  lease.release();
  const next = f.enter({ ...principal, verifiedAt: 1500, validUntil: 2500 });
  assert.equal(next.token(entry.id), token);
  assert.equal(next.resolve(token), entry.id);
});

test('foreign tokens never resolve even when buckets contain matching canonical numeric IDs', (t) => {
  const f = fixture(t),
    a = f.enter(),
    b = f.enter({ ...principal, tenantId: 'south' });
  const first = a.publish(draft()),
    second = b.publish(draft());
  // Simulate equal per-bucket IDs to prove lookup uses the opaque token map,
  // not numeric coincidence. Production journal IDs remain unchanged/global.
  history(b.id)[0].id = first.id;
  assert.notEqual(second.id, first.id);
  const north = a.token(first.id),
    south = b.token(first.id);
  assert.notEqual(north, south);
  assert.equal(a.resolve(south), undefined);
  assert.equal(b.resolve(north), undefined);
  assert.equal(a.resolve(north), first.id);
  assert.equal(b.resolve(south), first.id);
  assert.throws(() => a.token(second.id), safe);
  b.beginUndo(first.id);
  b.finishUndo(first.id);
  assert.equal(b.resolve(south), undefined);
  assert.equal(a.resolve(north), first.id);
});

test('tokens stay isolated across account, revision, deployment and source namespace owners', (t) => {
  const f = fixture(t),
    first = f.enter(),
    entry = first.publish(draft()),
    token = first.token(entry.id);
  const others = [
    f.enter({ ...principal, accountId: 'bob' }),
    f.enter({ ...principal, membershipVersion: '2' }),
    fixture(t, identity, 'next').enter({ ...principal, deployment: 'next' }),
    fixture(t, { ...identity, storeId: 'other-store' }).enter(),
  ];
  for (const other of others) {
    const own = other.publish(draft()),
      ownToken = other.token(own.id);
    assert.equal(other.resolve(token), undefined);
    assert.equal(first.resolve(ownToken), undefined);
    assert.throws(() => other.token(entry.id), safe);
  }
});

test('eviction trims both token directions while retained entries keep their tokens', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entries = Array.from({ length: 50 }, (_, i) => lease.publish(draft(String(i))));
  const tokens = entries.map((entry) => lease.token(entry.id));
  lease.publish(draft('Replacement'));
  assert.equal(lease.resolve(tokens[0]), undefined);
  assert.throws(() => lease.token(entries[0].id), safe);
  for (let i = 1; i < entries.length; i++) {
    assert.equal(lease.resolve(tokens[i]), entries[i].id);
    assert.equal(lease.token(entries[i].id), tokens[i]);
  }
});

test('pending and uncertain Undo retain stable tokens; only committed finish removes the reference', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entry = lease.publish(draft()),
    token = lease.token(entry.id);
  lease.beginUndo(entry.id);
  assert.equal(lease.token(entry.id), token);
  assert.equal(lease.resolve(token), entry.id);
  lease.failUndo(entry.id, false);
  assert.equal(lease.token(entry.id), token);
  lease.beginUndo(entry.id);
  lease.failUndo(entry.id, true);
  assert.equal(lease.resolve(token), entry.id);
  assert.throws(() => lease.beginUndo(entry.id), safe);
  const newer = lease.publish(draft('Newer')),
    newerToken = lease.token(newer.id);
  lease.beginUndo(newer.id);
  lease.finishUndo(newer.id);
  assert.equal(lease.resolve(newerToken), undefined);
  assert.throws(() => lease.token(newer.id), safe);
  assert.equal(lease.resolve(token), entry.id);
});

test('disposed buckets and new owners cannot recover old tokens; busy disposal drains its accepted lease', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entry = lease.publish(draft()),
    token = lease.token(entry.id);
  f.owner.dispose();
  assert.equal(lease.resolve(token), entry.id);
  lease.release();
  assert.throws(() => lease.resolve(token), safe);
  const fresh = fixture(t).enter();
  fresh.publish(draft());
  assert.equal(fresh.resolve(token), undefined);
});

test('token methods reject nonexistent/noncanonical IDs and never inspect hostile token objects', (t) => {
  const f = fixture(t),
    lease = f.enter(),
    entry = lease.publish(draft());
  let calls = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        calls++;
        throw new Error('private-token');
      },
      ownKeys() {
        calls++;
        return [];
      },
    },
  );
  for (const id of [0, -1, 1.5, NaN, Infinity, entry.id + 1, String(entry.id), hostile]) {
    assert.throws(() => lease.token(id as number), safe);
  }
  for (const token of ['', 'foreign', randomUUID(), entry.id, null, undefined, hostile]) {
    assert.equal(lease.resolve(token as string), undefined);
  }
  assert.equal(calls, 0);
});
