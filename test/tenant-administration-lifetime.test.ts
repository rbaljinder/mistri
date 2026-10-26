import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { TransactionOutcomeUnknown, type TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import {
  openSqliteTenantAdministration,
  TenantAdministrationFailure,
  type AdministrationRequest,
  type TenantAdministrationOptions,
} from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { ADMINISTRATION_OPERATIONS, type AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantWriterReopen } from '../packages/mistri/src/server/tenant/tenantWriterLifecycle.js';
import { pausedTenantWriters } from '../packages/mistri/src/server/tenant/tenantWriterHealth.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

type Fixture = Awaited<ReturnType<typeof tenantAdministrationFixture>>;
const contexts = new WeakMap<Fixture, string>();
const context = (f: Fixture) => {
  const value = contexts.get(f);
  assert.ok(value);
  return value;
};
const request = (cookie = '') => ({ headers: { cookie } }) as IncomingMessage;
const input = (f: Fixture, tenantId = 'north', idempotencyKey = `create-${tenantId}`): AdministrationRequest => ({
  expectedAccount: f.users.operator.accountId,
  context: context(f),
  idempotencyKey,
  intent: { operation: 'createTenant', tenantId },
});
const policy = (f: Fixture, roles = ['reader', 'manager']): AdministrationPolicy => ({
  id: 'lifetime-operators',
  version: '1',
  maxMembershipLifetimeMs: 60_000,
  operators: [{ accountId: f.users.operator.accountId, tenants: ['north', 'south'], operations: ADMINISTRATION_OPERATIONS, roles }],
});
async function admit(f: Fixture, service: Awaited<ReturnType<typeof openSqliteTenantAdministration>>, incoming = f.users.operator.request) {
  const session = await service.open(incoming, { expectedAccount: f.users.operator.accountId });
  assert.ok(session);
  contexts.set(f, session.context);
}
async function open(f: Fixture, options: Partial<TenantAdministrationOptions> = {}, incoming = f.users.operator.request) {
  const service = await openSqliteTenantAdministration({
    path: f.path,
    binding: f.binding,
    auth: f.auth,
    policy: policy(f),
    deployment: 'lifetime-test',
    ...options,
  });
  f.addCleanup(() => service.retire());
  await admit(f, service, incoming);
  return service;
}
function safeFailure(outcome?: 'not_applied' | 'unknown') {
  return (error: unknown) => {
    assert.ok(error instanceof TenantAdministrationFailure);
    assert.equal(error.code, 'tenant_administration_unavailable');
    assert.equal(error.message, 'The administration operation could not be confirmed.');
    if (outcome) assert.equal(error.outcome, outcome);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'outcome']);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}
function image(f: Fixture) {
  return [TENANT_TABLES.tenant, TENANT_TABLES.membership, journal.receipt, 'business_record'].map((table) =>
    f.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
  );
}
function empty(f: Fixture) {
  assert.deepEqual(image(f).slice(0, 3), [[], [], []]);
  assert.deepEqual(structuredClone(image(f)[3]), [{ id: 'one', value: 'original' }]);
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Lifetime test barrier timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// These tests run serially in their own Node test process. Restore every patch
// before fixture cleanup or another service is opened.
async function withMaintenance(
  hooks: {
    before?: () => void | Promise<void>;
    beforeCommit?: (db: DatabaseSync) => void | Promise<void>;
    afterCommit?: (result: unknown) => void | Promise<void>;
  },
  work: () => Promise<void>,
) {
  const original = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  SqliteAdapter.prototype.runtimeMaintenanceTransaction = async function <T>(
    verify: (db: DatabaseSync) => void,
    run: (db: DatabaseSync, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    await hooks.before?.();
    const result = await original.call(this, verify, async (db, operations, assertCurrent) => {
      const value = await run(db, operations, assertCurrent);
      await hooks.beforeCommit?.(db);
      return value;
    });
    await hooks.afterCommit?.(result);
    return result as T;
  };
  try {
    await work();
  } finally {
    SqliteAdapter.prototype.runtimeMaintenanceTransaction = original;
  }
}
async function signIn(f: Fixture) {
  const signedIn = await f.callNative('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({
      email: 'operator@example.test',
      password: 'tenant-administration-operator-password-123',
    }),
  });
  assert.equal(signedIn.response.status, 200);
  const cookie = signedIn.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie);
  return request(cookie);
}
async function signOut(f: Fixture) {
  const response = await f.callNative('/api/auth/sign-out', { method: 'POST', headers: { cookie: f.users.operator.cookie }, body: '{}' });
  assert.equal(response.response.status, 200);
}

test('real native identity, expected account and explicit operator policy gate execute and status', async (t) => {
  const f = await tenantAdministrationFixture(t),
    service = await open(f);
  f.authDb.prepare('UPDATE "user" SET role = ? WHERE id = ?').run('admin', f.users.outsider.accountId);
  assert.equal((await f.auth.session(f.users.outsider.request))?.role, 'admin');
  const cases = [
    { incoming: request(), expectedAccount: f.users.operator.accountId },
    { incoming: request('better-auth.session_token=forged'), expectedAccount: f.users.operator.accountId },
    { incoming: f.users.target.request, expectedAccount: f.users.target.accountId },
    { incoming: f.users.outsider.request, expectedAccount: f.users.outsider.accountId },
    { incoming: f.users.operator.request, expectedAccount: f.users.target.accountId },
  ];
  for (const { incoming, expectedAccount } of cases)
    for (const method of ['execute', 'status'] as const)
      await assert.rejects(service[method](incoming, { ...input(f), expectedAccount }), safeFailure('not_applied'));
  empty(f);
  const accepted = await service.execute(f.users.operator.request, input(f));
  assert.equal(accepted.change.after.tenant.tenantId, 'north');
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()?.n, 0);
});

for (const invalidation of ['signout', 'account deletion'] as const) {
  test(`native ${invalidation} after service startup refuses current and historical access`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      service = await open(f);
    await service.execute(f.users.operator.request, input(f));
    const before = image(f);
    if (invalidation === 'signout') await signOut(f);
    else f.authDb.prepare('DELETE FROM "user" WHERE id = ?').run(f.users.operator.accountId);
    for (const method of ['execute', 'status'] as const) {
      await assert.rejects(service[method](f.users.operator.request, input(f)), safeFailure('not_applied'));
      await assert.rejects(service[method](f.users.operator.request, input(f, 'south')), safeFailure('not_applied'));
    }
    assert.deepEqual(image(f), before);
  });
}

test('same-account native relogin cannot replace the admitted session during an operation', async (t) => {
  const f = await tenantAdministrationFixture(t),
    service = await open(f);
  const relogged = await signIn(f),
    incoming = request(f.users.operator.cookie);
  const native = captureAppAuthRuntime(f.auth);
  assert.notEqual((await native.sessionInstance(incoming))?.sessionId, (await native.sessionInstance(relogged))?.sessionId);
  await withMaintenance(
    {
      before: () => {
        incoming.headers = relogged.headers;
      },
    },
    async () => {
      await assert.rejects(service.execute(incoming, input(f)), safeFailure('not_applied'));
    },
  );
  empty(f);
  await assert.rejects(service.execute(relogged, input(f)), safeFailure('not_applied'));
  await admit(f, service, relogged);
  assert.equal((await service.execute(relogged, input(f))).replayed, false);
});

test('admitted native session revocation after the last async proof refuses before COMMIT and rolls back', async (t) => {
  const f = await tenantAdministrationFixture(t),
    service = await open(f);
  const native = captureAppAuthRuntime(f.auth);
  const proof = await native.sessionInstance(f.users.operator.request);
  assert.ok(proof);
  let failure: unknown,
    revoked = false;
  await withMaintenance(
    {
      beforeCommit: (db) => {
        assert.equal(db.isTransaction, true);
        for (const table of [TENANT_TABLES.tenant, journal.receipt])
          assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n, 1);
        // The service callback has finished every async native proof; the adapter
        // still owes its synchronous owner fence and COMMIT on this real writer.
        const deleted = f.authDb.prepare('DELETE FROM session WHERE id = ? AND userId = ?').run(proof.sessionId, proof.identity.id);
        assert.equal(deleted.changes, 1);
        revoked = true;
      },
    },
    async () => {
      await assert.rejects(service.execute(f.users.operator.request, input(f)), (error) => {
        failure = error;
        return safeFailure()(error);
      });
    },
  );
  assert.equal(revoked, true);
  assert.equal(await native.sessionInstance(f.users.operator.request), null);
  assert.ok(failure instanceof TenantAdministrationFailure);
  assert.deepEqual(
    {
      outcome: failure.outcome,
      rows: image(f)
        .slice(0, 3)
        .map((rows) => rows.length),
    },
    { outcome: 'not_applied', rows: [0, 0, 0] },
    'revoked native proof must roll back tenant, membership and receipt (with its audit columns) before commit',
  );
  empty(f);
});

test('target native account deletion before commit rolls membership, receipt and audit back together', async (t) => {
  const f = await tenantAdministrationFixture(t),
    service = await open(f);
  await service.execute(f.users.operator.request, input(f));
  const before = image(f);
  const grant: AdministrationRequest = {
    expectedAccount: f.users.operator.accountId,
    context: context(f),
    idempotencyKey: 'grant-target',
    intent: {
      operation: 'grantMembership',
      tenantId: 'north',
      expectedTenantVersion: '1',
      accountId: f.users.target.accountId,
      roles: ['reader'],
      validUntil: Date.now() + 30_000,
    },
  };
  await withMaintenance(
    {
      beforeCommit: (db) => {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()?.n, 1);
        f.authDb.prepare('DELETE FROM "user" WHERE id = ?').run(f.users.target.accountId);
      },
    },
    async () => {
      await assert.rejects(service.execute(f.users.operator.request, grant), safeFailure('not_applied'));
    },
  );
  assert.deepEqual(image(f), before);
  assert.equal(captureAppAuthRuntime(f.auth).lookupAccount(f.users.target.accountId), null);
});

test('deadline starts synchronously at invocation and captures the configured lifetime', async (t) => {
  const f = await tenantAdministrationFixture(t),
    started = Date.now();
  let now = started;
  const options = {
    path: f.path,
    binding: f.binding,
    auth: f.auth,
    policy: policy(f),
    deployment: 'captured-clock',
    now: () => now,
    maxLifetimeMs: 100,
  };
  const service = await openSqliteTenantAdministration(options);
  f.addCleanup(() => service.retire());
  await admit(f, service);
  options.maxLifetimeMs = 300_000;
  options.now = () => started;
  const pending = service.execute(f.users.operator.request, input(f));
  now = started + 100;
  await assert.rejects(pending, safeFailure('not_applied'));
  empty(f);
});

for (const boundary of ['backward clock', 'exact deadline', 'native session deadline'] as const) {
  test(`${boundary} at the final writer fence rolls back staged metadata and journal rows`, async (t) => {
    const f = await tenantAdministrationFixture(t);
    const proof = await captureAppAuthRuntime(f.auth).sessionInstance(f.users.operator.request);
    assert.ok(proof);
    const started = boundary === 'native session deadline' ? proof.expiresAt - 50 : Date.now();
    let now = started;
    const service = await open(f, { now: () => now, maxLifetimeMs: 100 });
    await withMaintenance(
      {
        beforeCommit: (db) => {
          assert.equal(db.prepare(`SELECT count(*) AS n FROM "${journal.receipt}"`).get()?.n, 1);
          now = boundary === 'backward clock' ? started - 1 : boundary === 'exact deadline' ? started + 100 : proof.expiresAt;
        },
      },
      async () => {
        await assert.rejects(service.execute(f.users.operator.request, input(f)), safeFailure('not_applied'));
      },
    );
    empty(f);
  });
}

test('a queued operation retains its invocation deadline while waiting for the prior writer result', async (t) => {
  const f = await tenantAdministrationFixture(t),
    started = Date.now();
  let now = started,
    transactions = 0;
  const service = await open(f, { now: () => now, maxLifetimeMs: 100 });
  const committed = gate(),
    release = gate();
  await withMaintenance(
    {
      before: () => {
        transactions++;
      },
      afterCommit: async () => {
        committed.release();
        await bounded(release.wait);
      },
    },
    async () => {
      const first = assert.rejects(service.execute(f.users.operator.request, input(f)), safeFailure('unknown'));
      let second: Promise<void> | undefined;
      try {
        await bounded(committed.wait);
        now = started + 10;
        second = assert.rejects(service.execute(f.users.operator.request, input(f, 'south')), safeFailure('not_applied'));
        // Native SQLite proof settles through microtasks before the next event-loop turn.
        await turn();
        assert.equal(transactions, 1);
        now = started + 110;
        release.release();
        await bounded(Promise.all([first, second]));
        assert.equal(transactions, 1, 'expired queued operation must not open a writer transaction');
      } finally {
        release.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );
  assert.deepEqual(
    f.db
      .prepare(`SELECT id FROM "${TENANT_TABLES.tenant}"`)
      .all()
      .map((row) => row.id),
    ['north'],
  );
  await admit(f, service);
  assert.equal(await service.status(f.users.operator.request, input(f, 'south')), null);
});

test('retire drains active and queued work, refuses new calls and preserves borrowed native auth', async (t) => {
  const f = await tenantAdministrationFixture(t),
    service = await open(f);
  const staged = gate(),
    release = gate();
  let closed = false;
  await withMaintenance(
    {
      beforeCommit: async () => {
        staged.release();
        await bounded(release.wait);
      },
    },
    async () => {
      const first = assert.rejects(service.execute(f.users.operator.request, input(f)), safeFailure('not_applied'));
      let second: Promise<void> | undefined, retirement: Promise<void> | undefined;
      try {
        await bounded(staged.wait);
        second = assert.rejects(service.execute(f.users.operator.request, input(f, 'south')), safeFailure('not_applied'));
        await turn();
        retirement = service.retire();
        assert.equal(service.retire(), retirement);
        void retirement.then(() => {
          closed = true;
        });
        await turn();
        assert.equal(closed, false, 'retirement must wait for the retained transaction');
        for (const method of ['execute', 'status'] as const)
          await assert.rejects(service[method](f.users.operator.request, input(f)), safeFailure('not_applied'));
        release.release();
        await bounded(Promise.all([first, second, retirement]));
        assert.equal(closed, true);
      } finally {
        release.release();
        await Promise.allSettled([first, ...(second ? [second] : []), ...(retirement ? [retirement] : [])]);
      }
    },
  );
  empty(f);
  assert.equal((await f.auth.session(f.users.operator.request))?.id, f.users.operator.accountId);
  assert.equal((await (await open(f)).execute(f.users.operator.request, input(f))).replayed, false);
});

for (const failure of ['transaction acknowledgement', 'COMMIT acknowledgement', 'session release', 'deadline release'] as const) {
  test(`${failure} failure after commit reports unknown and a fresh service recovers the exact receipt`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      started = Date.now();
    let now = started,
      injected = false,
      writer: DatabaseSync | undefined;
    const service = await open(f, { now: () => now, maxLifetimeMs: 100 });
    const originalExec = DatabaseSync.prototype.exec;
    try {
      if (failure === 'COMMIT acknowledgement')
        DatabaseSync.prototype.exec = function (sql: string) {
          const result = originalExec.call(this, sql);
          if (this === writer && sql === 'COMMIT' && !injected) {
            injected = true;
            throw new Error('PRIVATE_COMMIT_ACKNOWLEDGEMENT');
          }
          return result;
        };
      await withMaintenance(
        {
          beforeCommit: (db) => {
            writer = db;
          },
          afterCommit: async () => {
            if (failure === 'COMMIT acknowledgement') return;
            injected = true;
            if (failure === 'transaction acknowledgement') throw new TransactionOutcomeUnknown(new Error('PRIVATE_POSTCOMMIT'));
            if (failure === 'session release') await signOut(f);
            if (failure === 'deadline release') now = started + 100;
          },
        },
        async () => {
          await assert.rejects(service.execute(f.users.operator.request, input(f)), safeFailure('unknown'));
        },
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(injected, true);
    await service.retire();
    const before = image(f),
      stored = f.db.prepare(`SELECT * FROM "${journal.receipt}"`).get();
    assert.ok(stored);
    assert.equal(before[0].length, 1);
    assert.equal(before[1].length, 0);
    assert.equal(before[2].length, 1);
    assert.equal(before[3].length, 1);
    const incoming = failure === 'session release' ? await signIn(f) : f.users.operator.request;
    const fresh = await open(f, { deployment: 'recovery-generation' }, incoming);
    const recovered = await fresh.status(incoming, input(f));
    assert.ok(recovered);
    assert.deepEqual(structuredClone(recovered), {
      receiptId: stored.id,
      requestId: stored.request_id,
      completedAt: stored.completed_at,
      change: JSON.parse(stored.result_json as string),
      replayed: true,
    });
    assert.deepEqual(await fresh.execute(incoming, input(f)), recovered);
    assert.deepEqual(image(f), before);
  });
}

test('an unknown outcome pauses the same service, which reopens and recovers the exact receipt without a restart', async (t) => {
  const backoff = { ...tenantWriterReopen };
  Object.assign(tenantWriterReopen, { firstMs: 20, maxMs: 40 });
  t.after(() => Object.assign(tenantWriterReopen, backoff));
  t.mock.method(console, 'error', () => {});
  const f = await tenantAdministrationFixture(t);
  const service = await open(f);
  let injected = false;
  await withMaintenance(
    {
      afterCommit: () => {
        if (injected) return;
        injected = true;
        throw new TransactionOutcomeUnknown(new Error('PRIVATE_POSTCOMMIT'));
      },
    },
    async () => {
      await assert.rejects(service.execute(f.users.operator.request, input(f)), safeFailure('unknown'));
    },
  );
  assert.equal(injected, true);
  // The request whose outcome is unknown keeps its refusal; readiness says the
  // administration store is closed until it has reopened and re-attested.
  assert.deepEqual(pausedTenantWriters(), [`${f.binding.appId}/administration`]);
  const stored = f.db.prepare(`SELECT * FROM "${journal.receipt}"`).get();
  assert.ok(stored);
  const before = image(f);
  let recovered: Awaited<ReturnType<typeof service.status>> | undefined;
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 20))) {
    recovered = await service.status(f.users.operator.request, input(f)).catch(() => undefined);
    if (recovered) break;
  }
  assert.ok(recovered, 'the same service reopens and serves again');
  assert.deepEqual(pausedTenantWriters(), []);
  assert.deepEqual(structuredClone(recovered), {
    receiptId: stored.id,
    requestId: stored.request_id,
    completedAt: stored.completed_at,
    change: JSON.parse(stored.result_json as string),
    replayed: true,
  });
  assert.deepEqual(await service.execute(f.users.operator.request, input(f)), recovered);
  const south = await service.execute(f.users.operator.request, input(f, 'south'));
  assert.equal(south.replayed, false);
  assert.equal(image(f)[2].length, before[2].length + 1);
});

test('restart reauthorizes historical membership receipts against the current role ceiling without disclosure', async (t) => {
  const f = await tenantAdministrationFixture(t),
    service = await open(f);
  await service.execute(f.users.operator.request, input(f));
  const grant: AdministrationRequest = {
    expectedAccount: f.users.operator.accountId,
    context: context(f),
    idempotencyKey: 'manager-grant',
    intent: {
      operation: 'grantMembership',
      tenantId: 'north',
      expectedTenantVersion: '1',
      accountId: f.users.target.accountId,
      roles: ['manager'],
      validUntil: Date.now() + 30_000,
    },
  };
  const accepted = await service.execute(f.users.operator.request, grant);
  const membership = accepted.change.after.membership;
  assert.ok(membership);
  const replace: AdministrationRequest = {
    expectedAccount: f.users.operator.accountId,
    context: context(f),
    idempotencyKey: 'reader-replacement',
    intent: {
      operation: 'replaceMembership',
      tenantId: 'north',
      expectedTenantVersion: '1',
      membershipId: membership.membershipId,
      expectedMembershipVersion: '1',
      roles: ['reader'],
      validUntil: membership.validUntil,
    },
  };
  const replaced = await service.execute(f.users.operator.request, replace);
  await service.retire();
  const before = image(f);
  // Preserve durable policy identity so refusal proves today's role ceiling,
  // rather than merely detecting a different intent/policy fingerprint.
  const narrowed = await open(f, { policy: policy(f, ['reader']), deployment: 'narrowed-generation' });
  // Both the grant's afterimage and replacement's beforeimage contain the role
  // removed from the ceiling, even though today's membership is only a reader.
  for (const historical of [grant, replace])
    for (const method of ['execute', 'status'] as const)
      await assert.rejects(narrowed[method](f.users.operator.request, { ...historical, context: context(f) }), safeFailure());
  assert.deepEqual(image(f), before);
  await narrowed.retire();
  const restored = await open(f, { deployment: 'restored-generation' });
  assert.deepEqual(structuredClone(await restored.status(f.users.operator.request, { ...grant, context: context(f) })), {
    ...structuredClone(accepted),
    replayed: true,
  });
  assert.deepEqual(structuredClone(await restored.status(f.users.operator.request, { ...replace, context: context(f) })), {
    ...structuredClone(replaced),
    replayed: true,
  });
  assert.deepEqual(image(f), before);
});
