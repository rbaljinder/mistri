import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { openSqliteTenantAdministration, TenantAdministrationFailure } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import type { AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  ADMINISTRATION_OPERATIONS,
  type AdministrationIntent,
  type AdministrationMembershipImage,
  type AdministrationMembershipPageRequest,
  type AdministrationPageRequest,
} from '../packages/mistri/src/shared/tenantAdministration.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

type Fixture = Awaited<ReturnType<typeof tenantAdministrationFixture>>;
type Rule = Omit<AdministrationPolicy['operators'][number], 'accountId'>;
const defaults: readonly Rule[] = [
  { tenants: ['north', 'unborn'], operations: ['replaceMembership'], roles: ['reader'] },
  { tenants: ['north', 'unborn'], operations: ['revokeMembership'], roles: ['reader', 'manager'] },
  { tenants: ['north', 'south', 'unborn'], operations: ['createTenant', 'setTenantStatus'], roles: [] },
  { tenants: ['north'], operations: ['grantMembership'], roles: ['contributor'] },
];
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof TenantAdministrationFailure);
  assert.equal(error.code, 'tenant_administration_unavailable');
  assert.equal(error.outcome, 'not_applied');
  assert.equal(error.message, 'The administration operation could not be confirmed.');
  assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'outcome']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
async function open(f: Fixture, rules: readonly Rule[] = defaults) {
  const policy: AdministrationPolicy = {
    id: 'listing-operators',
    version: '1',
    maxMembershipLifetimeMs: 60_000,
    operators: rules.map((rule) => ({ ...rule, accountId: f.users.operator.accountId })),
  };
  const service = await openSqliteTenantAdministration({
    path: f.path,
    binding: f.binding,
    auth: f.auth,
    policy,
    deployment: 'listing-proof',
  });
  f.addCleanup(() => service.retire());
  const session = await service.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId });
  assert.ok(session);
  assert.equal(session.maxMembershipLifetimeMs, 60_000);
  const owner = { expectedAccount: session.accountId, context: session.context };
  const tenants = (page: Partial<AdministrationPageRequest> = {}) => service.tenants(f.users.operator.request, { ...owner, ...page });
  const memberships = (page: Partial<AdministrationMembershipPageRequest> = {}) =>
    service.memberships(f.users.operator.request, { ...owner, tenantId: 'north', operation: 'replaceMembership', ...page });
  let attempt = 0;
  const execute = (intent: AdministrationIntent) =>
    service.execute(f.users.operator.request, { ...owner, idempotencyKey: `listing-change-${++attempt}`, intent });
  return { service, session, owner, tenants, memberships, execute };
}
function tenant(f: Fixture, id = 'north', status = 'active', version = '1') {
  f.db.prepare(`INSERT INTO "${TENANT_TABLES.tenant}" (id,status,version,kind) VALUES (?,?,?,'tenant')`).run(id, status, version);
}
function member(f: Fixture, id: string, options: Partial<AdministrationMembershipImage> = {}) {
  const row: AdministrationMembershipImage = {
    membershipId: id,
    tenantId: 'north',
    accountId: `account-${id}`,
    status: 'active',
    version: '1',
    roles: ['reader'],
    validUntil: Date.now() + 30_000,
    ...options,
  };
  f.db
    .prepare(`INSERT INTO "${TENANT_TABLES.membership}"
    (id,tenant_id,account_id,status,version,roles_json,valid_until,kind) VALUES (?,?,?,?,?,?,?,'member')`)
    .run(row.membershipId, row.tenantId, row.accountId, row.status, row.version, JSON.stringify(row.roles), row.validUntil);
  return row;
}
function stored(f: Fixture) {
  return plain(
    [TENANT_TABLES.tenant, TENANT_TABLES.membership, journal.receipt, 'business_record'].map((table) =>
      f.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
    ),
  );
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}

test('zero-membership operator lists exact policy targets, absent targets and per-operation ceilings', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  tenant(f, 'south', 'suspended');
  tenant(f, 'private-tenant');
  const admin = await open(f);
  const before = stored(f),
    users = f.authDb.prepare('SELECT * FROM user ORDER BY id').all();
  const page = await admin.tenants();
  assert.deepEqual(plain(page), {
    items: [
      {
        tenantId: 'north',
        tenant: { tenantId: 'north', status: 'active', version: '1' },
        capabilities: [
          { operation: 'createTenant', roles: [] },
          { operation: 'setTenantStatus', roles: [] },
          { operation: 'grantMembership', roles: ['contributor'] },
          { operation: 'replaceMembership', roles: ['reader'] },
          { operation: 'revokeMembership', roles: ['reader', 'manager'] },
        ],
      },
      {
        tenantId: 'south',
        tenant: { tenantId: 'south', status: 'suspended', version: '1' },
        capabilities: [
          { operation: 'createTenant', roles: [] },
          { operation: 'setTenantStatus', roles: [] },
        ],
      },
      {
        tenantId: 'unborn',
        tenant: null,
        capabilities: [
          { operation: 'createTenant', roles: [] },
          { operation: 'setTenantStatus', roles: [] },
          { operation: 'replaceMembership', roles: ['reader'] },
          { operation: 'revokeMembership', roles: ['reader', 'manager'] },
        ],
      },
    ],
    next: null,
  });
  assert.deepEqual(plain(await admin.memberships({ tenantId: 'unborn' })), {
    tenant: null,
    operation: 'replaceMembership',
    roles: ['reader'],
    items: [],
    next: null,
  });
  frozen(page);
  assert.deepEqual(stored(f), before);
  assert.deepEqual(f.authDb.prepare('SELECT * FROM user ORDER BY id').all(), users);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()!.n, 0);
});

test('replace and revoke listings enforce the complete existing role set, never the union of grants', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  tenant(f, 'private-tenant');
  const reader = member(f, 'a-reader', { accountId: f.users.target.accountId });
  const manager = member(f, 'b-manager', { accountId: f.users.outsider.accountId, roles: ['manager'] });
  const mixed = member(f, 'c-mixed', { roles: ['reader', 'manager'] });
  member(f, 'd-grant-only', { roles: ['contributor'] });
  member(f, 'e-union', { roles: ['reader', 'contributor'] });
  member(f, 'f-outside', { roles: ['owner'] });
  member(f, 'g-other-tenant', { tenantId: 'private-tenant' });
  const admin = await open(f),
    before = stored(f);
  const replace = await admin.memberships(),
    revoke = await admin.memberships({ operation: 'revokeMembership' });
  assert.deepEqual(plain(replace), {
    tenant: { tenantId: 'north', status: 'active', version: '1' },
    operation: 'replaceMembership',
    roles: ['reader'],
    items: [reader],
    next: null,
  });
  assert.deepEqual(plain(revoke), {
    tenant: plain(replace.tenant),
    operation: 'revokeMembership',
    roles: ['reader', 'manager'],
    items: [reader, manager, mixed],
    next: null,
  });
  frozen(replace);
  frozen(revoke);
  assert.deepEqual(stored(f), before);
});

test('filtering precedes LIMIT and lookahead; hidden rows cannot truncate pages or leak a continuation', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  tenant(f, 'private-tenant');
  const admin = await open(f);
  for (let i = 0; i < 105; i++) member(f, `a-hidden-${String(i).padStart(3, '0')}`, { roles: ['manager'] });
  member(f, 'm-visible-1');
  member(f, 'm-visible-2');
  member(f, 'm-visible-3');
  member(f, 'm-visible-1a-hidden', { roles: ['reader', 'manager'] });
  member(f, 'z-hidden-tail', { roles: ['owner'] });
  member(f, 'z-hidden-invited', { status: 'invited' });
  member(f, 'z-hidden-revoked', { status: 'revoked' });
  member(f, 'z-hidden-tenant', { tenantId: 'private-tenant' });
  const first = await admin.memberships({ limit: 2 });
  assert.deepEqual(
    first.items.map((row) => row.membershipId),
    ['m-visible-1', 'm-visible-2'],
  );
  assert.equal(first.next, 'm-visible-2');
  const last = await admin.memberships({ after: first.next!, limit: 1 });
  assert.deepEqual(
    last.items.map((row) => row.membershipId),
    ['m-visible-3'],
  );
  assert.equal(last.next, null, 'hidden trailing rows must not produce a cursor');
  assert.deepEqual(Object.keys(last).sort(), ['items', 'next', 'operation', 'roles', 'tenant']);
  member(f, '0-more-hidden', { roles: ['owner'] });
  member(f, 'zz-more-hidden', { roles: ['owner'] });
  assert.deepEqual(await admin.memberships({ limit: 2 }), first);
  assert.deepEqual(await admin.memberships({ after: first.next!, limit: 1 }), last);
  assert.deepEqual((await admin.memberships({ after: 'z-hidden-tail', limit: 1 })).items, []);
});

test('tenant keyset pages use binary order, deduplicate policy targets and do not expose global rows', async (t) => {
  const f = await tenantAdministrationFixture(t);
  const ids = ['a_b', 'z', 'a0', '0', 'a-b', 'a'];
  for (const id of ['a0', 'a', 'z', '0-hidden', 'zz-hidden']) tenant(f, id);
  const admin = await open(f, [
    { tenants: ids, operations: ['createTenant'], roles: [] },
    { tenants: ['a', 'z'], operations: ['setTenantStatus'], roles: [] },
  ]);
  const expected = ['0', 'a', 'a-b', 'a0', 'a_b', 'z'],
    seen: string[] = [];
  let after: string | undefined;
  do {
    const page = await admin.tenants({ limit: 2, ...(after ? { after } : {}) });
    seen.push(...page.items.map((row) => row.tenantId));
    assert.equal(page.next, seen.length < expected.length ? page.items.at(-1)!.tenantId : null);
    after = page.next ?? undefined;
    assert.ok(seen.length <= expected.length, 'cursor must make progress');
  } while (after);
  assert.deepEqual(seen, expected);
  assert.deepEqual(
    (await admin.tenants({ after: 'a-absent', limit: 1 })).items.map((row) => row.tenantId),
    ['a-b'],
  );
  assert.deepEqual(plain(await admin.tenants({ after: 'z' })), { items: [], next: null });
});

test('membership keysets use SQLite binary order including case and Unicode, without skips or duplicates', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  // U+E000 sorts before U+10000 in UTF-8/BINARY, opposite JavaScript UTF-16 sort.
  const expected = ['A', 'Z', 'a', 'a-b', 'a_b', 'é', '\uE000', '\u{10000}'];
  for (const id of [...expected].reverse()) member(f, id);
  const admin = await open(f),
    seen: string[] = [];
  let after: string | undefined;
  do {
    const page = await admin.memberships({ limit: 3, ...(after ? { after } : {}) });
    seen.push(...page.items.map((row) => row.membershipId));
    assert.equal(page.next, seen.length < expected.length ? page.items.at(-1)!.membershipId : null);
    after = page.next ?? undefined;
    assert.ok(seen.length <= expected.length);
  } while (after);
  assert.deepEqual(seen, expected);
  assert.deepEqual(
    (await admin.memberships({ after: 'B', limit: 1 })).items.map((row) => row.membershipId),
    ['Z'],
  );
  assert.equal((await admin.memberships({ after: '\u{10000}' })).next, null);
  assert.deepEqual((await admin.memberships({ after: '\u{10000}' })).items, []);
});

for (const kind of ['tenants', 'memberships'] as const) {
  test(`${kind} enforce default, minimum and maximum limits with visible lookahead`, async (t) => {
    const f = await tenantAdministrationFixture(t),
      ids = Array.from({ length: 101 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    tenant(f);
    if (kind === 'memberships') for (const id of ids) member(f, id);
    const admin = await open(f, [{ tenants: kind === 'tenants' ? ids : ['north'], operations: ['replaceMembership'], roles: ['reader'] }]);
    for (const limit of [undefined, 1, 100]) {
      const page = await admin[kind](limit === undefined ? {} : { limit });
      assert.equal(page.items.length, limit ?? 20);
      assert.equal(page.next, ids[(limit ?? 20) - 1]);
    }
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity, '2', null, undefined, 2n])
      await assert.rejects(admin[kind]({ limit } as AdministrationPageRequest), safeFailure);
  });
}

for (const kind of ['tenants', 'memberships'] as const) {
  test(`${kind} page byte budget uses UTF-8 bytes and resumes at the last released visible key`, async (t) => {
    const f = await tenantAdministrationFixture(t);
    tenant(f);
    const ids = Array.from({ length: 45 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    const roles = Array.from({ length: 100 }, (_, i) => `${i}-${'界'.repeat(240)}`);
    if (kind === 'memberships') for (const id of ids) member(f, id, { roles });
    const admin = await open(f, [{ tenants: kind === 'tenants' ? ids : ['north'], operations: ['replaceMembership'], roles }]);
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await admin[kind]({ limit: 100, ...(after ? { after } : {}) });
      const bytes = page.items.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
      assert.ok(bytes <= 2_000_000);
      assert.ok(page.items.length > 0 && page.items.length < ids.length, 'byte bound, not row limit, splits the page');
      const keys = page.items.map((row) => ('membershipId' in row ? row.membershipId : row.tenantId));
      seen.push(...keys);
      assert.equal(page.next, seen.length < ids.length ? keys.at(-1) : null);
      if (page.next) assert.ok(bytes + Buffer.byteLength(JSON.stringify(page.items[0])) > 2_000_000);
      after = page.next ?? undefined;
      assert.ok(seen.length <= ids.length);
    } while (after);
    assert.deepEqual(seen, ids);
  });
}

test('listings preserve decimal-string revisions and publish current lifecycle state rather than historical receipts', async (t) => {
  const f = await tenantAdministrationFixture(t),
    revision = '900719925474099312345678901234567890';
  tenant(f, 'north', 'active', revision);
  const row = member(f, 'native-target', { accountId: f.users.target.accountId, version: revision });
  const admin = await open(f, [{ tenants: ['north'], operations: ADMINISTRATION_OPERATIONS, roles: ['reader', 'manager'] }]);
  const original = await admin.memberships();
  assert.equal(original.tenant!.version, revision);
  assert.equal(original.items[0].version, revision);
  const replaced = await admin.execute({
    operation: 'replaceMembership',
    tenantId: 'north',
    expectedTenantVersion: revision,
    membershipId: row.membershipId,
    expectedMembershipVersion: revision,
    roles: ['manager'],
    validUntil: Date.now() + 45_000,
  });
  const incremented = String(BigInt(revision) + 1n);
  assert.equal((await admin.memberships()).items[0].version, incremented);
  assert.equal((await admin.memberships()).tenant!.version, revision, 'tenant revision is not a roster revision');
  let current = revision;
  for (const status of ['suspended', 'active', 'closed'] as const) {
    await admin.execute({ operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: current, status });
    current = String(BigInt(current) + 1n);
    assert.deepEqual(plain((await admin.tenants()).items[0].tenant), { tenantId: 'north', status, version: current });
    assert.deepEqual((await admin.memberships({ operation: 'revokeMembership' })).tenant, (await admin.tenants()).items[0].tenant);
  }
  await admin.execute({
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: current,
    membershipId: row.membershipId,
    expectedMembershipVersion: incremented,
  });
  assert.deepEqual((await admin.memberships()).items, []);
  assert.deepEqual((await admin.memberships({ operation: 'revokeMembership' })).items, []);
  assert.equal(replaced.change.after.membership!.status, 'active');
  assert.equal(original.items[0].version, revision, 'a returned page is a detached image');
});

test('invited rows are revoke-only, revoked rows disappear, and expired active rows remain manageable', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  const expired = member(f, 'a-expired', { validUntil: 0 });
  const invited = member(f, 'b-invited', { status: 'invited', accountId: f.users.target.accountId });
  member(f, 'c-revoked', { status: 'revoked' });
  const admin = await open(f);
  assert.deepEqual(plain((await admin.memberships()).items), [expired]);
  assert.deepEqual(plain((await admin.memberships({ operation: 'revokeMembership' })).items), [expired, invited]);
  await admin.execute({
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: invited.membershipId,
    expectedMembershipVersion: '1',
  });
  assert.deepEqual(plain((await admin.memberships({ operation: 'revokeMembership' })).items), [expired]);
});

test('native/global/business roles do not authorize listings or reveal existence outside target and operation grants', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  tenant(f, 'private-tenant');
  member(f, 'outsider-manager', { accountId: f.users.outsider.accountId, roles: ['manager'] });
  f.authDb.prepare('UPDATE user SET role=? WHERE id=?').run('admin', f.users.outsider.accountId);
  const admin = await open(f),
    before = stored(f);
  assert.equal(await admin.service.open(f.users.outsider.request, { expectedAccount: f.users.outsider.accountId }), null);
  for (const incoming of [f.users.outsider.request, f.users.target.request, { headers: {} } as IncomingMessage]) {
    await assert.rejects(admin.service.tenants(incoming, admin.owner), safeFailure);
    await assert.rejects(
      admin.service.memberships(incoming, { ...admin.owner, tenantId: 'north', operation: 'revokeMembership' }),
      safeFailure,
    );
  }
  for (const tenantId of ['private-tenant', 'absent-private', 'south'])
    for (const operation of ['replaceMembership', 'revokeMembership'] as const)
      await assert.rejects(admin.memberships({ tenantId, operation }), safeFailure);
  await assert.rejects(admin.tenants({ expectedAccount: f.users.outsider.accountId }), safeFailure);
  assert.deepEqual(stored(f), before);
});

for (const kind of ['tenants', 'memberships'] as const) {
  test(`${kind} strictly capture reference inputs without executing accessors or accepting extra authority`, async (t) => {
    const f = await tenantAdministrationFixture(t);
    tenant(f);
    member(f, 'visible');
    const admin = await open(f),
      before = stored(f);
    const valid = kind === 'tenants' ? { ...admin.owner } : { ...admin.owner, tenantId: 'north', operation: 'replaceMembership' };
    const call = (value: unknown) =>
      kind === 'tenants'
        ? admin.service.tenants(f.users.operator.request, value as AdministrationPageRequest)
        : admin.service.memberships(f.users.operator.request, value as AdministrationMembershipPageRequest);
    const invalid: unknown[] = [
      null,
      [],
      'north',
      Object.create(valid),
      ...['expectedAccount', 'context'].flatMap((key) =>
        ['', null, undefined, 7, ' padded ', 'bad\u0000id'].map((value) => ({ ...valid, [key]: value })),
      ),
      ...['accountId', 'roles', 'path', 'source', 'storeId', 'count', 'offset'].map((key) => ({ ...valid, [key]: 'injected' })),
      ...['', undefined, null, 1, ' padded ', 'bad\nkey', 'x'.repeat(kind === 'tenants' ? 129 : 1025)].map((after) => ({
        ...valid,
        after,
      })),
      { ...valid, [Symbol('hidden')]: true },
    ];
    for (const key of ['expectedAccount', 'context']) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      invalid.push(missing);
    }
    let hooks = 0;
    invalid.push(
      Object.defineProperty({ ...valid }, 'limit', {
        enumerable: true,
        get() {
          hooks++;
          return 1;
        },
      }),
      Object.defineProperty({ ...valid }, 'hidden', { value: true }),
      new Proxy(valid, {
        ownKeys() {
          hooks++;
          return [];
        },
        get() {
          hooks++;
          return undefined;
        },
      }),
      {
        ...valid,
        toJSON() {
          hooks++;
          return valid;
        },
      },
    );
    if (kind === 'tenants') invalid.push(...['North', 'north/south', '%6eorth'].map((after) => ({ ...valid, after })));
    else {
      invalid.push(
        ...['North', 'north/south', '%6eorth', '', undefined].map((tenantId) => ({ ...valid, tenantId })),
        ...['grantMembership', 'createTenant', 'REPLACEMEMBERSHIP', '', undefined].map((operation) => ({ ...valid, operation })),
      );
      for (const key of ['tenantId', 'operation']) {
        const missing: Record<string, unknown> = { ...valid };
        delete missing[key];
        invalid.push(missing);
      }
    }
    for (const value of invalid) await assert.rejects(call(value), safeFailure);
    assert.equal(hooks, 0);
    assert.deepEqual(stored(f), before);
    const input = { ...valid, limit: 1 };
    const pending = call(input);
    input.context = 'changed-after-invocation';
    input.limit = 0;
    assert.equal((await pending).items.length, 1, 'the request is captured before the first await');
  });
}

// These serial tests use the actual writer and native verifier. Only the
// transaction return is intercepted, after metadata has already been buffered.
async function atRelease(t: TestContext, action: () => void | Promise<void>, work: () => Promise<void>) {
  const original = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  const mock = t.mock.method(SqliteAdapter.prototype, 'runtimeMaintenanceTransaction', async function <
    T,
  >(this: SqliteAdapter, verify: (db: DatabaseSync) => void, run: (db: DatabaseSync, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>): Promise<T> {
    const value = await original.call(this, verify, run);
    await action();
    return value as T;
  });
  try {
    await work();
  } finally {
    mock.mock.restore();
  }
}

for (const kind of ['tenants', 'memberships'] as const) {
  for (const invalidation of ['session revocation', 'retirement'] as const) {
    test(`${kind} suppress buffered metadata on ${invalidation} before release and refuse subsequent reads`, async (t) => {
      const f = await tenantAdministrationFixture(t);
      tenant(f);
      member(f, 'visible');
      const admin = await open(f),
        before = stored(f);
      const native = captureAppAuthRuntime(f.auth),
        proof = await native.sessionInstance(f.users.operator.request);
      assert.ok(proof);
      let injected = false,
        retirement: Promise<void> | undefined;
      await atRelease(
        t,
        () => {
          injected = true;
          if (invalidation === 'session revocation')
            assert.equal(f.authDb.prepare('DELETE FROM session WHERE id=?').run(proof.sessionId).changes, 1);
          else retirement = admin.service.retire();
        },
        async () => {
          await assert.rejects(admin[kind](), safeFailure);
        },
      );
      assert.ok(injected);
      await retirement;
      await assert.rejects(admin.tenants(), safeFailure);
      await assert.rejects(admin.memberships(), safeFailure);
      assert.deepEqual(stored(f), before);
      if (invalidation === 'retirement') assert.equal((await f.auth.session(f.users.operator.request))?.id, f.users.operator.accountId);
    });
  }
}

test('both listings reject a same-account replacement login until it opens its own administration session', async (t) => {
  const f = await tenantAdministrationFixture(t);
  tenant(f);
  member(f, 'visible');
  const admin = await open(f);
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
  const incoming = { headers: { cookie, origin: f.origin } } as IncomingMessage;
  await assert.rejects(admin.service.tenants(incoming, admin.owner), safeFailure);
  await assert.rejects(
    admin.service.memberships(incoming, { ...admin.owner, tenantId: 'north', operation: 'replaceMembership' }),
    safeFailure,
  );
  const fresh = await admin.service.open(incoming, { expectedAccount: f.users.operator.accountId });
  assert.ok(fresh);
  assert.notEqual(fresh.context, admin.owner.context);
  const owner = { expectedAccount: fresh.accountId, context: fresh.context };
  assert.equal((await admin.service.tenants(incoming, owner)).items.length, 3);
  assert.equal(
    (await admin.service.memberships(incoming, { ...owner, tenantId: 'north', operation: 'replaceMembership' })).items.length,
    1,
  );
});
