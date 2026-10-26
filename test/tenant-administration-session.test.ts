import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import {
  openSqliteTenantAdministration,
  TenantAdministrationFailure,
  type AdministrationRequest,
  type TenantAdministration,
  type TenantAdministrationOptions,
} from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { ADMINISTRATION_OPERATIONS, type AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

type Fixture = Awaited<ReturnType<typeof tenantAdministrationFixture>>;
const methods = ['execute', 'status'] as const;
const request = (cookie = '') => ({ headers: { cookie } }) as IncomingMessage;
const owner = (f: Fixture) => ({ expectedAccount: f.users.operator.accountId });
const input = (f: Fixture, context: string, tenantId = 'north'): AdministrationRequest => ({
  ...owner(f),
  context,
  idempotencyKey: `create-${tenantId}`,
  intent: { operation: 'createTenant', tenantId },
});
function safe(error: unknown) {
  assert.ok(error instanceof TenantAdministrationFailure);
  assert.equal(error.outcome, 'not_applied');
  assert.equal(error.code, 'tenant_administration_unavailable');
  assert.equal(error.message, 'The administration operation could not be confirmed.');
  assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'outcome']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}
function image(f: Fixture) {
  return [TENANT_TABLES.tenant, TENANT_TABLES.membership, journal.receipt, 'business_record'].map((table) =>
    f.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
  );
}
function policy(f: Fixture, accounts = [f.users.operator.accountId]): AdministrationPolicy {
  return {
    id: 'session-operators',
    version: '1',
    maxMembershipLifetimeMs: 60_000,
    operators: accounts.map((accountId) => ({
      accountId,
      tenants: ['north', 'south'],
      operations: ADMINISTRATION_OPERATIONS,
      roles: ['reader', 'manager'],
    })),
  };
}
async function service(f: Fixture, options: Partial<TenantAdministrationOptions> = {}) {
  const result = await openSqliteTenantAdministration({
    path: f.path,
    binding: f.binding,
    auth: f.auth,
    policy: policy(f),
    deployment: 'session-tests',
    ...options,
  });
  f.addCleanup(result.retire);
  return result;
}
async function admit(f: Fixture, administration: TenantAdministration, incoming = f.users.operator.request) {
  const session = await administration.open(incoming, owner(f));
  assert.ok(session);
  return session;
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

test('open issues a frozen login context before tenant selection without granting business access', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f);
  const before = image(f),
    started = Date.now();
  const session = await admit(f, administration);
  const proof = await captureAppAuthRuntime(f.auth).sessionInstance(f.users.operator.request);
  assert.ok(proof);
  assert.deepEqual(Object.keys(session).sort(), ['accountId', 'appId', 'context', 'expiresAt', 'maxMembershipLifetimeMs']);
  assert.equal(session.appId, f.binding.appId);
  assert.equal(session.accountId, f.users.operator.accountId);
  assert.match(session.context, /^[0-9a-f-]{36}$/);
  assert.notEqual(session.context, proof.sessionId);
  assert.ok(session.expiresAt > started && session.expiresAt <= Date.now() + 300_000);
  assert.ok(session.expiresAt <= proof.expiresAt);
  assert.equal(session.maxMembershipLifetimeMs, policy(f).maxMembershipLifetimeMs);
  assert.ok(Object.isFrozen(session));
  assert.deepEqual(image(f), before);
  assert.equal(await administration.status(f.users.operator.request, input(f, session.context)), null);
});

test('ordinary native accounts return null even with global admin and business manager roles', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f);
  const session = await admit(f, administration);
  await administration.execute(f.users.operator.request, input(f, session.context));
  await administration.execute(f.users.operator.request, {
    ...input(f, session.context),
    idempotencyKey: 'outsider-manager',
    intent: {
      operation: 'grantMembership',
      tenantId: 'north',
      expectedTenantVersion: '1',
      accountId: f.users.outsider.accountId,
      roles: ['manager'],
      validUntil: Date.now() + 30_000,
    },
  });
  f.authDb.prepare('UPDATE user SET role=? WHERE id=?').run('admin', f.users.outsider.accountId);
  assert.equal((await f.auth.session(f.users.outsider.request))?.role, 'admin');
  const before = image(f);
  for (const user of [f.users.target, f.users.outsider]) {
    assert.equal(await administration.open(user.request, { expectedAccount: user.accountId }), null);
    for (const method of methods)
      await assert.rejects(administration[method](user.request, { ...input(f, session.context), expectedAccount: user.accountId }), safe);
  }
  assert.deepEqual(image(f), before);
});

test('open requires exact expected-account input and a current native login', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f),
    before = image(f);
  for (const incoming of [request(), request('better-auth.session_token=forged'), f.users.target.request])
    await assert.rejects(administration.open(incoming, owner(f)), safe);
  for (const invalid of [
    {},
    { expectedAccount: '' },
    { expectedAccount: f.users.target.accountId },
    { expectedAccount: ` ${f.users.operator.accountId}` },
    { ...owner(f), context: randomUUID() },
  ])
    await assert.rejects(administration.open(f.users.operator.request, invalid as ReturnType<typeof owner>), safe);
  assert.deepEqual(image(f), before);
  await admit(f, administration);
});

test('execute and status reject missing, forged, wrong-account and foreign-service contexts before disclosure', async (t) => {
  const f = await tenantAdministrationFixture(t);
  const options = { policy: policy(f, [f.users.operator.accountId, f.users.target.accountId]) };
  const administration = await service(f, options),
    foreign = await service(f, options);
  const session = await admit(f, administration),
    foreignSession = await admit(f, foreign);
  const targetSession = await administration.open(f.users.target.request, { expectedAccount: f.users.target.accountId });
  assert.ok(targetSession);
  await administration.execute(f.users.operator.request, input(f, session.context));
  const before = image(f);
  for (const tenantId of ['north', 'south']) {
    const valid = input(f, session.context, tenantId);
    const { context: _context, ...missing } = valid;
    for (const invalid of [
      missing,
      { ...valid, context: undefined },
      { ...valid, context: '' },
      { ...valid, context: randomUUID() },
      { ...valid, context: foreignSession.context },
      { ...valid, context: targetSession.context },
      { ...valid, expectedAccount: f.users.target.accountId },
    ])
      for (const method of methods)
        await assert.rejects(administration[method](f.users.operator.request, invalid as AdministrationRequest), safe);
    for (const incoming of [request(), f.users.target.request])
      for (const method of methods) await assert.rejects(administration[method](incoming, valid), safe);
    for (const method of methods) await assert.rejects(foreign[method](f.users.operator.request, valid), safe);
  }
  assert.deepEqual(image(f), before);
  assert.ok(await foreign.status(f.users.operator.request, input(f, foreignSession.context)));
});

for (const signOut of [false, true])
  test(`same-account relogin before submission rejects the old context (signout=${signOut})`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      administration = await service(f);
    const session = await admit(f, administration),
      original = input(f, session.context);
    const committed = await administration.execute(f.users.operator.request, original);
    const native = captureAppAuthRuntime(f.auth),
      proof = await native.sessionInstance(f.users.operator.request);
    assert.ok(proof);
    if (signOut) {
      const response = await f.callNative('/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie: f.users.operator.cookie },
        body: '{}',
      });
      assert.equal(response.response.status, 200);
    }
    const incoming = await signIn(f),
      freshProof = await native.sessionInstance(incoming);
    assert.ok(freshProof);
    assert.equal(freshProof.identity.id, proof.identity.id);
    assert.notEqual(freshProof.sessionId, proof.sessionId);
    if (!signOut) native.assertSessionCurrent(proof);
    const before = image(f);
    for (const tenantId of ['north', 'south'])
      for (const method of methods) await assert.rejects(administration[method](incoming, input(f, session.context, tenantId)), safe);
    assert.deepEqual(image(f), before);
    const fresh = await admit(f, administration, incoming);
    assert.notEqual(fresh.context, session.context);
    assert.equal((await administration.status(incoming, { ...original, context: fresh.context }))?.receiptId, committed.receiptId);
    assert.equal((await administration.execute(incoming, input(f, fresh.context, 'south'))).replayed, false);
  });

test('same-account cookie replacement between the two native opening proofs is rejected', async (t) => {
  const f = await tenantAdministrationFixture(t),
    incoming = request(f.users.operator.cookie),
    relogged = await signIn(f);
  let clocks = 0;
  const administration = await service(f, {
    now: () => {
      if (++clocks === 2) incoming.headers = relogged.headers;
      return Date.now();
    },
  });
  const before = image(f);
  await assert.rejects(administration.open(incoming, owner(f)), safe);
  assert.equal(clocks, 3);
  assert.deepEqual(image(f), before);
  await admit(f, administration, relogged);
});

test('open captures expectedAccount synchronously before native verification', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f);
  const opening = owner(f),
    pending = administration.open(f.users.operator.request, opening);
  opening.expectedAccount = f.users.target.accountId;
  const session = await pending;
  assert.equal(session?.accountId, f.users.operator.accountId);
  assert.ok(session);
  assert.equal((await administration.execute(f.users.operator.request, input(f, session.context))).replayed, false);
});

for (const method of methods)
  test(`${method} captures context, account and exact intent before caller mutation`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      administration = await service(f),
      session = await admit(f, administration);
    const original = input(f, session.context);
    if (method === 'status') await administration.execute(f.users.operator.request, original);
    const mutable = { ...original, intent: { operation: 'createTenant' as const, tenantId: 'north' } };
    const pending = administration[method](f.users.operator.request, mutable);
    mutable.expectedAccount = f.users.target.accountId;
    mutable.context = randomUUID();
    mutable.idempotencyKey = 'mutated-attempt';
    mutable.intent.tenantId = 'south';
    const result = await pending;
    assert.ok(result);
    assert.equal(result.change.after.tenant.tenantId, 'north');
    assert.equal(result.replayed, method === 'status');
    assert.equal((await administration.status(f.users.operator.request, original))?.receiptId, result.receiptId);
    assert.equal(await administration.status(f.users.operator.request, input(f, session.context, 'south')), null);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${journal.receipt}"`).get()?.n, 1);
  });

test('open, execute and status reject input accessors and proxies without invoking hooks', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f),
    session = await admit(f, administration);
  let hooks = 0;
  const getter = () => {
    hooks++;
    throw new Error('caller hook must not execute');
  };
  const opening = Object.defineProperty({}, 'expectedAccount', { enumerable: true, get: getter });
  await assert.rejects(administration.open(f.users.operator.request, opening as ReturnType<typeof owner>), safe);
  await assert.rejects(administration.open(f.users.operator.request, new Proxy(owner(f), { ownKeys: getter })), safe);
  const before = image(f);
  for (const method of methods) {
    for (const field of ['context', 'expectedAccount', 'idempotencyKey', 'intent']) {
      const hostile = Object.defineProperty({ ...input(f, session.context) }, field, { enumerable: true, get: getter });
      await assert.rejects(administration[method](f.users.operator.request, hostile), safe);
    }
    const nested = {
      ...input(f, session.context),
      intent: Object.defineProperty({ operation: 'createTenant' }, 'tenantId', { enumerable: true, get: getter }),
    } as AdministrationRequest;
    await assert.rejects(administration[method](f.users.operator.request, nested), safe);
    await assert.rejects(administration[method](f.users.operator.request, new Proxy(input(f, session.context), { ownKeys: getter })), safe);
  }
  assert.equal(hooks, 0);
  assert.deepEqual(image(f), before);
});

test('context expires exactly at its opening deadline and fresh admission recovers historical receipts', async (t) => {
  const f = await tenantAdministrationFixture(t),
    started = Date.now();
  let now = started;
  const administration = await service(f, { now: () => now, maxLifetimeMs: 100 });
  const session = await admit(f, administration),
    original = input(f, session.context);
  assert.equal(session.expiresAt, started + 100);
  const committed = await administration.execute(f.users.operator.request, original),
    before = image(f);
  now = session.expiresAt - 1;
  assert.equal((await administration.status(f.users.operator.request, original))?.receiptId, committed.receiptId);
  now++;
  for (const tenantId of ['north', 'south'])
    for (const method of methods)
      await assert.rejects(administration[method](f.users.operator.request, input(f, session.context, tenantId)), safe);
  assert.deepEqual(image(f), before);
  const fresh = await admit(f, administration);
  assert.equal(fresh.expiresAt, now + 100);
  assert.equal(
    (await administration.status(f.users.operator.request, { ...original, context: fresh.context }))?.receiptId,
    committed.receiptId,
  );
});

test('context lifetime is capped by the genuine native session deadline', async (t) => {
  const f = await tenantAdministrationFixture(t);
  const proof = await captureAppAuthRuntime(f.auth).sessionInstance(f.users.operator.request);
  assert.ok(proof);
  let now = proof.expiresAt - 50;
  const administration = await service(f, { now: () => now, maxLifetimeMs: 100 });
  const session = await admit(f, administration);
  assert.equal(session.expiresAt, proof.expiresAt);
  now = proof.expiresAt;
  for (const method of methods) await assert.rejects(administration[method](f.users.operator.request, input(f, session.context)), safe);
  await assert.rejects(administration.open(f.users.operator.request, owner(f)), safe);
});

for (const boundary of ['expiry', 'backward clock'] as const)
  test(`${boundary} during opening publishes no context`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      started = Date.now();
    let now = started;
    const administration = await service(f, { now: () => now, maxLifetimeMs: 100 }),
      before = image(f);
    const pending = administration.open(f.users.operator.request, owner(f));
    now = boundary === 'expiry' ? started + 100 : started - 1;
    await assert.rejects(pending, safe);
    assert.deepEqual(image(f), before);
    now = started + 101;
    await admit(f, administration);
  });

test('concurrent openings enforce sixteen contexts per account without evicting active contexts', async (t) => {
  const f = await tenantAdministrationFixture(t),
    started = Date.now();
  let now = started;
  const administration = await service(f, { now: () => now, maxLifetimeMs: 100 });
  const results = await Promise.allSettled(Array.from({ length: 17 }, () => administration.open(f.users.operator.request, owner(f))));
  const contexts: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      assert.ok(result.value);
      contexts.push(result.value.context);
    } else safe(result.reason);
  }
  assert.equal(contexts.length, 16);
  assert.equal(new Set(contexts).size, 16);
  for (const context of contexts) assert.equal(await administration.status(f.users.operator.request, input(f, context)), null);
  await assert.rejects(administration.open(f.users.operator.request, owner(f)), safe);
  assert.equal(await administration.open(f.users.outsider.request, { expectedAccount: f.users.outsider.accountId }), null);
  now = started + 100;
  const fresh = await admit(f, administration);
  assert.ok(!contexts.includes(fresh.context));
  for (const method of methods) await assert.rejects(administration[method](f.users.operator.request, input(f, contexts[0])), safe);
  assert.equal((await administration.execute(f.users.operator.request, input(f, fresh.context))).replayed, false);
});

test('the service-wide context bound spans real native accounts and releases expired capacity', async (t) => {
  const f = await tenantAdministrationFixture(t),
    native = captureAppAuthRuntime(f.auth);
  const users = Object.values(f.users).map((user) => ({ accountId: user.accountId, request: user.request }));
  // Sixty-four accounts at sixteen contexts each reach the service limit. Every
  // additional identity and cookie comes from the fixture's real native signup.
  for (let index = users.length; index < 65; index++) {
    const signedUp = await f.callNative('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        name: `capacity-${index}`,
        email: `capacity-${index}@example.test`,
        password: 'synthetic-capacity-password-123',
      }),
    });
    assert.equal(signedUp.response.status, 200);
    const cookie = signedUp.response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.ok(cookie);
    const incoming = request(cookie),
      proof = await native.sessionInstance(incoming);
    assert.ok(proof);
    assert.equal(proof.identity.id, (signedUp.body.user as { id: string }).id);
    users.push({ accountId: proof.identity.id, request: incoming });
  }
  const started = Date.now();
  let now = started;
  const administration = await service(f, {
    policy: policy(
      f,
      users.map((user) => user.accountId),
    ),
    now: () => now,
    maxLifetimeMs: 100,
  });
  const contexts = new Set<string>();
  for (const user of users.slice(0, 64)) {
    const opened = await Promise.all(
      Array.from({ length: 16 }, () => administration.open(user.request, { expectedAccount: user.accountId })),
    );
    for (const session of opened) {
      assert.ok(session);
      contexts.add(session.context);
    }
  }
  assert.equal(contexts.size, 1024);
  const extra = users[64],
    before = image(f);
  await assert.rejects(administration.open(extra.request, { expectedAccount: extra.accountId }), safe);
  assert.deepEqual(image(f), before);
  const firstContext = contexts.values().next().value;
  assert.ok(firstContext);
  assert.equal(await administration.status(f.users.operator.request, input(f, firstContext)), null);
  now = started + 100;
  const fresh = await administration.open(extra.request, { expectedAccount: extra.accountId });
  assert.ok(fresh);
  assert.ok(!contexts.has(fresh.context));
  const freshInput = { ...input(f, fresh.context), expectedAccount: extra.accountId };
  assert.equal((await administration.execute(extra.request, freshInput)).replayed, false);
  for (const method of methods) await assert.rejects(administration[method](f.users.operator.request, input(f, firstContext)), safe);
});

for (const at of [2, 3])
  test(`native session revocation at opening clock ${at} prevents context publication`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      native = captureAppAuthRuntime(f.auth);
    const proof = await native.sessionInstance(f.users.operator.request);
    assert.ok(proof);
    let clocks = 0;
    const administration = await service(f, {
        now: () => {
          if (++clocks === at) assert.equal(f.authDb.prepare('DELETE FROM session WHERE id=?').run(proof.sessionId).changes, 1);
          return Date.now();
        },
      }),
      before = image(f);
    await assert.rejects(administration.open(f.users.operator.request, owner(f)), safe);
    assert.equal(clocks, at);
    assert.equal(await native.sessionInstance(f.users.operator.request), null);
    assert.deepEqual(image(f), before);
    await admit(f, administration, await signIn(f));
  });

for (const at of [1, 2, 3])
  test(`aborted request at opening clock ${at} cannot receive a context`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      incoming = request(f.users.operator.cookie);
    let clocks = 0;
    const administration = await service(f, {
        now: () => {
          if (++clocks === at) incoming.aborted = true;
          return Date.now();
        },
      }),
      before = image(f);
    await assert.rejects(administration.open(incoming, owner(f)), safe);
    assert.ok(clocks >= at);
    assert.deepEqual(image(f), before);
    await admit(f, administration);
  });

test('aborted execute and status do not write or disclose a committed receipt', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f),
    session = await admit(f, administration);
  await administration.execute(f.users.operator.request, input(f, session.context));
  const before = image(f),
    incoming = request(f.users.operator.cookie);
  incoming.aborted = true;
  for (const tenantId of ['north', 'south'])
    for (const method of methods) await assert.rejects(administration[method](incoming, input(f, session.context, tenantId)), safe);
  assert.deepEqual(image(f), before);
});

for (const at of [2, 3])
  test(`retirement at opening clock ${at} drains the pending native admission before closing the writer`, async (t) => {
    const f = await tenantAdministrationFixture(t);
    let clocks = 0,
      retirement: Promise<void> | undefined,
      openingSettled = false,
      closes = 0;
    const administration = await service(f, {
      now: () => {
        if (++clocks === at) retirement = administration.retire();
        return Date.now();
      },
    });
    const originalClose = SqliteAdapter.prototype.close;
    SqliteAdapter.prototype.close = async function () {
      closes++;
      assert.equal(openingSettled, true, 'writer must stay open until admission settles');
      return originalClose.call(this);
    };
    try {
      const pending = administration.open(f.users.operator.request, owner(f));
      void pending.then(
        () => {
          openingSettled = true;
        },
        () => {
          openingSettled = true;
        },
      );
      await assert.rejects(pending, safe);
      assert.ok(retirement);
      assert.equal(administration.retire(), retirement);
      await retirement;
      assert.equal(closes, 1);
      await assert.rejects(administration.open(f.users.operator.request, owner(f)), safe);
      assert.equal(closes, 1);
    } finally {
      SqliteAdapter.prototype.close = originalClose;
    }
  });

test('immediate retirement rejects an already tracked opening and invalidates earlier contexts', async (t) => {
  const f = await tenantAdministrationFixture(t),
    administration = await service(f),
    session = await admit(f, administration);
  const before = image(f),
    pending = administration.open(f.users.operator.request, owner(f));
  const rejected = assert.rejects(pending, safe),
    retirement = administration.retire();
  assert.equal(administration.retire(), retirement);
  await Promise.all([rejected, retirement]);
  for (const method of methods) await assert.rejects(administration[method](f.users.operator.request, input(f, session.context)), safe);
  assert.deepEqual(image(f), before);
});
