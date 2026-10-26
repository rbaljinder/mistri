import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as model from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import {
  ADMINISTRATION_OPERATIONS,
  administrationFingerprint,
  administrationGrant,
  assertAdministrationRoles,
  captureAdministrationIntent,
  captureAdministrationPolicy,
  type AdministrationIntent,
  type AdministrationOperation,
  type AdministrationPolicy,
} from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';

const maximumLifetimeMs = 366 * 24 * 60 * 60 * 1000;
const policy = () => ({
  id: 'administrators',
  version: 'v1',
  maxMembershipLifetimeMs: 1000,
  operators: [
    { accountId: 'operator', tenants: ['north', 'south'], operations: [...ADMINISTRATION_OPERATIONS], roles: ['reader', 'manager'] },
  ],
});
const binding = (): TenantStoreBinding => ({ appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } });
const intents: readonly AdministrationIntent[] = [
  { operation: 'createTenant', tenantId: 'north' },
  { operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' },
  {
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: 'target',
    roles: ['reader', 'manager'],
    validUntil: 1500,
  },
  {
    operation: 'replaceMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: 'membership',
    expectedMembershipVersion: '2',
    roles: ['reader', 'manager'],
    validUntil: 1500,
  },
  {
    operation: 'revokeMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    membershipId: 'membership',
    expectedMembershipVersion: '2',
  },
  {
    operation: 'setTenantDecisions',
    tenantId: 'north',
    expectedTenantVersion: '1',
    provider: 'jev',
    enabled: true,
    consent: 'DPA-2026-014',
  },
];
const denied = (work: () => unknown) =>
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof TenantContextError);
    assert.equal(error.code, 'tenant_context_unavailable');
    assert.equal(error.message, 'The tenant context could not be verified.');
    assert.equal('cause' in error, false);
    return true;
  });
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reversed(child)]),
    );
  return value;
}

test('runtime API contains only the operation vocabulary and pure model functions', () => {
  assert.deepEqual(
    Object.keys(model).sort(),
    [
      'ADMINISTRATION_OPERATIONS',
      'DELEGABLE_ADMINISTRATION_OPERATIONS',
      'ROLELESS_ADMINISTRATION_OPERATIONS',
      'administrationFingerprint',
      'administrationGrant',
      'assertAdministrationRoles',
      'assertDelegatedTerms',
      'assistantSwitch',
      'captureAdministrationIntent',
      'captureAdministrationPolicy',
      'operatorGrant',
    ].sort(),
  );
  assert.deepEqual(ADMINISTRATION_OPERATIONS, [
    'createTenant',
    'setTenantStatus',
    'grantMembership',
    'replaceMembership',
    'revokeMembership',
    'setTenantAssistant',
    'setTenantDecisions',
    'cloneTenant',
    'importTenant',
  ]);
  assert.ok(Object.isFrozen(ADMINISTRATION_OPERATIONS));
});

test('policy and intent snapshots are detached and recursively frozen', () => {
  const input = policy(),
    captured = captureAdministrationPolicy(input);
  frozen(captured);
  input.operators[0].tenants.push('west');
  input.operators[0].roles[0] = 'owner';
  input.id = 'changed';
  assert.equal(captured.id, 'administrators');
  assert.deepEqual(captured.operators[0].tenants, ['north', 'south']);
  assert.deepEqual(captured.operators[0].roles, ['reader', 'manager']);
  for (const intent of intents) {
    const mutable = structuredClone(intent),
      snapshot = captureAdministrationIntent(mutable);
    frozen(snapshot);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), intent);
    if ('roles' in mutable) (mutable.roles as string[]).push('owner');
    Object.assign(mutable, { tenantId: 'west' });
    assert.equal(snapshot.tenantId, 'north');
    if ('roles' in snapshot) assert.deepEqual(snapshot.roles, ['reader', 'manager']);
  }
  assert.equal(captureAdministrationPolicy(Object.assign(Object.create(null), policy())).id, 'administrators');
});

for (const intent of intents)
  test(`${intent.operation} requires exactly its own fields`, () => {
    for (const key of Object.keys(intent)) {
      const missing = { ...intent } as Record<string, unknown>;
      delete missing[key];
      denied(() => captureAdministrationIntent(missing));
      denied(() => captureAdministrationIntent({ ...intent, [key]: undefined }));
    }
    for (const key of ['unknown', 'deployment', 'source', 'nativeRole', 'then', 'toJSON', '__proto__']) {
      denied(() => captureAdministrationIntent({ ...intent, [key]: 'forged' }));
    }
    const allFields = [...new Set(intents.flatMap((value) => Object.keys(value)))];
    for (const key of allFields.filter((key) => !Object.hasOwn(intent, key))) {
      denied(() => captureAdministrationIntent({ ...intent, [key]: 'extra' }));
    }
  });

test("setTenantDecisions names one lowercase provider and a switch the assistant's rules allow", () => {
  const base = {
    operation: 'setTenantDecisions',
    tenantId: 'north',
    expectedTenantVersion: '1',
    provider: 'jev',
    enabled: true,
    consent: 'DPA-1',
  };
  assert.equal(captureAdministrationIntent({ ...base }).operation, 'setTenantDecisions');
  assert.equal(captureAdministrationIntent({ ...base, enabled: false, consent: '' }).operation, 'setTenantDecisions');
  for (const provider of ['', 'Jev', 'jev2', 'jev-x', 'a'.repeat(33), 1, null, undefined])
    denied(() => captureAdministrationIntent({ ...base, provider }));
  denied(() => captureAdministrationIntent({ ...base, consent: '' }));
  denied(() => captureAdministrationIntent({ ...base, consent: ' padded' }));
  denied(() => captureAdministrationIntent({ ...base, enabled: 'yes' }));
});

test('policy requires exact top-level and operator rule shapes', () => {
  for (const key of Object.keys(policy())) {
    const missing = { ...policy() } as Record<string, unknown>;
    delete missing[key];
    denied(() => captureAdministrationPolicy(missing));
    denied(() => captureAdministrationPolicy({ ...policy(), [key]: undefined }));
  }
  for (const key of Object.keys(policy().operators[0])) {
    const missing = { ...policy().operators[0] } as Record<string, unknown>;
    delete missing[key];
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [missing] }));
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], [key]: undefined }] }));
  }
  for (const key of ['role', 'global', 'deployment', 'then', '__proto__']) {
    denied(() => captureAdministrationPolicy({ ...policy(), [key]: 'admin' }));
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], [key]: 'admin' }] }));
  }
});

test('shape capture refuses accessors, proxies and executable hooks without invoking them', () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('private-hook-detail');
  };
  const proxy = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = Object.defineProperty({}, 'operation', { enumerable: true, get: hook });
  const sparse: unknown[] = [];
  sparse.length = 1;
  const arrayGetter = Object.defineProperty(['reader'], '0', { enumerable: true, get: hook });
  const extraArray = Object.assign(['reader'], { extra: 'value' });
  // oxlint-disable-next-line unicorn/no-thenable -- Deliberately hostile input must never be assimilated.
  const thenable = { then: hook };
  const malformed: unknown[] = [
    null,
    undefined,
    [],
    1,
    'input',
    true,
    1n,
    Symbol('input'),
    hook,
    proxy,
    revoked.proxy,
    getter,
    new Date(),
    Object.create({ operation: 'createTenant' }),
    { toJSON: hook },
    thenable,
    { [Symbol.toPrimitive]: hook },
    Object.defineProperty({}, 'hidden', { value: 1 }),
  ];
  for (const value of malformed) {
    denied(() => captureAdministrationPolicy(value));
    denied(() => captureAdministrationIntent(value));
  }
  for (const value of [proxy, revoked.proxy, getter, sparse, arrayGetter, extraArray]) {
    denied(() => captureAdministrationPolicy({ ...policy(), operators: value }));
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], roles: value }] }));
    denied(() => captureAdministrationIntent({ ...intents[2], roles: value }));
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  denied(() => captureAdministrationPolicy(cyclic));
  denied(() => captureAdministrationIntent(cyclic));
  assert.equal(calls, 0);
});

test('identifiers obey shared canonical spelling and bounded lengths', () => {
  for (const value of ['', ' padded', 'padded ', 'line\nbreak', '\u0000', 1, null, 'x'.repeat(257)]) {
    denied(() => captureAdministrationPolicy({ ...policy(), id: value }));
    denied(() => captureAdministrationPolicy({ ...policy(), version: value }));
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], roles: [value] }] }));
  }
  for (const value of ['*', 'North', 'north/west', 'north%2fwest', '-north', '', 'north ', 'a'.repeat(129)]) {
    denied(() => captureAdministrationIntent({ ...intents[0], tenantId: value }));
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], tenants: [value] }] }));
  }
  assert.equal(captureAdministrationIntent({ ...intents[0], tenantId: 'a'.repeat(128) }).tenantId.length, 128);
  for (const field of ['accountId', 'membershipId']) {
    const intent = field === 'accountId' ? intents[2] : intents[3];
    captureAdministrationIntent({ ...intent, [field]: 'x'.repeat(1024) });
    for (const value of ['', ' padded', '\u007f', 'x'.repeat(1025), 1]) {
      denied(() => captureAdministrationIntent({ ...intent, [field]: value }));
      if (field === 'accountId')
        denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], accountId: value }] }));
    }
  }
  captureAdministrationPolicy({
    ...policy(),
    id: 'x'.repeat(256),
    version: 'x'.repeat(256),
    operators: [{ ...policy().operators[0], accountId: 'x'.repeat(1024), roles: ['x'.repeat(256)] }],
  });
});

test('revisions are positive canonical decimal strings up to 128 digits', () => {
  for (const intent of intents.filter((value) => value.operation !== 'createTenant')) {
    const fields = ['expectedTenantVersion', ...('expectedMembershipVersion' in intent ? ['expectedMembershipVersion'] : [])];
    for (const field of fields) {
      for (const value of [0, 1, 1n, '', '0', '01', '+1', '-1', '1.0', '1e2', ' 1', '1\n', '1'.repeat(129)]) {
        denied(() => captureAdministrationIntent({ ...intent, [field]: value }));
      }
      for (const value of ['1', '9007199254740993', '9'.repeat(128)]) {
        const captured = captureAdministrationIntent({ ...intent, [field]: value });
        assert.equal((captured as unknown as Record<string, unknown>)[field], value);
      }
    }
  }
});

test('policy lifetime, list counts and unique allowlists enforce both endpoints', () => {
  for (const value of [1, maximumLifetimeMs]) captureAdministrationPolicy({ ...policy(), maxMembershipLifetimeMs: value });
  for (const value of [0, -1, 1.5, maximumLifetimeMs + 1, Infinity, NaN, '1000']) {
    denied(() => captureAdministrationPolicy({ ...policy(), maxMembershipLifetimeMs: value }));
  }
  const entries = Array.from({ length: 256 }, (_, index) => ({ ...policy().operators[0], accountId: `account-${index}` }));
  captureAdministrationPolicy({ ...policy(), operators: entries });
  denied(() => captureAdministrationPolicy({ ...policy(), operators: [...entries, entries[0]] }));
  denied(() => captureAdministrationPolicy({ ...policy(), operators: [] }));
  for (const field of ['roles', 'tenants']) {
    const values = Array.from({ length: 256 }, (_, index) => `value-${index}`);
    captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], [field]: values }] });
    for (const invalid of [[], [...values, 'overflow'], ['same', 'same'], 'all']) {
      denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], [field]: invalid }] }));
    }
  }
  for (const operations of [[], ['createTenant', 'createTenant'], ['*'], ['admin'], ['toString']]) {
    denied(() => captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], operations }] }));
  }
  captureAdministrationPolicy({
    ...policy(),
    operators: [{ ...policy().operators[0], operations: ['createTenant', 'setTenantStatus'], roles: [] }],
  });
  for (const operation of ['grantMembership', 'replaceMembership', 'revokeMembership']) {
    denied(() =>
      captureAdministrationPolicy({ ...policy(), operators: [{ ...policy().operators[0], operations: [operation], roles: [] }] }),
    );
  }
});

test('intent role sets, expiry values, operation and status vocabularies are strict', () => {
  const allRoles = Array.from({ length: 256 }, (_, index) => `role-${index}`);
  for (const intent of [intents[2], intents[3]]) {
    captureAdministrationIntent({ ...intent, roles: allRoles, validUntil: Number.MAX_SAFE_INTEGER });
    for (const value of [[], ['reader', 'reader'], [...allRoles, 'overflow'], [' reader'], '*', [1]]) {
      denied(() => captureAdministrationIntent({ ...intent, roles: value }));
    }
    for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1500']) {
      denied(() => captureAdministrationIntent({ ...intent, validUntil: value }));
    }
  }
  for (const operation of ['*', 'toString', '__proto__', 'CreateTenant', 'deleteTenant', 1]) {
    denied(() => captureAdministrationIntent({ ...intents[0], operation }));
  }
  for (const status of ['active', 'suspended', 'closed']) captureAdministrationIntent({ ...intents[1], status });
  for (const status of ['invited', 'revoked', 'ACTIVE', '', 1]) denied(() => captureAdministrationIntent({ ...intents[1], status }));
});

test('grants require the exact operator, target and operation without combining rule ceilings', () => {
  const captured = captureAdministrationPolicy(policy());
  for (const operation of ADMINISTRATION_OPERATIONS) {
    const grant = administrationGrant(captured, 'operator', 'north', operation);
    assert.deepEqual(grant, captured.operators[0]);
    frozen(grant);
  }
  for (const accountId of ['target', 'admin', 'administrator', '*', 'Operator']) {
    denied(() => administrationGrant(captured, accountId, 'north', 'createTenant'));
  }
  for (const tenantId of ['west', '*', 'North']) denied(() => administrationGrant(captured, 'operator', tenantId, 'createTenant'));
  denied(() => administrationGrant(captured, 'operator', 'north', 'deleteTenant' as AdministrationOperation));
  const split = captureAdministrationPolicy({
    ...policy(),
    operators: [
      { accountId: 'operator', tenants: ['north'], operations: ['grantMembership'], roles: ['reader'] },
      { accountId: 'operator', tenants: ['north'], operations: ['replaceMembership'], roles: ['manager'] },
      { accountId: 'operator', tenants: ['south'], operations: ['createTenant'], roles: [] },
    ],
  });
  denied(() => administrationGrant(split, 'operator', 'north', 'createTenant'));
  denied(() => administrationGrant(split, 'operator', 'south', 'grantMembership'));
  const grant = administrationGrant(split, 'operator', 'north', 'grantMembership');
  assert.deepEqual(grant.roles, ['reader']);
  denied(() => assertAdministrationRoles(split, grant, ['reader', 'manager'], 1500, 1000));
});

test('overlapping operator target/operation ceilings refuse regardless of order or roles', () => {
  const first = policy().operators[0];
  for (const roles of [['reader'], ['owner'], [...first.roles]]) {
    const overlap = { ...first, tenants: ['south', 'west'], operations: ['grantMembership'], roles };
    for (const operators of [
      [first, overlap],
      [overlap, first],
    ]) {
      denied(() => captureAdministrationPolicy({ ...policy(), operators }));
      denied(() => administrationGrant({ ...policy(), operators } as AdministrationPolicy, 'operator', 'south', 'grantMembership'));
    }
  }
  for (const distinct of [{ accountId: 'another' }, { tenants: ['west'] }]) {
    captureAdministrationPolicy({ ...policy(), operators: [first, { ...first, ...distinct }] });
  }
});

test('role assertions reject forged, removed and stale policy ceilings', () => {
  const input = policy(),
    captured = captureAdministrationPolicy(input);
  const grant = administrationGrant(captured, 'operator', 'north', 'grantMembership');
  for (const change of [{ roles: ['owner'] }, { accountId: 'another' }, { tenants: ['west'] }, { operations: ['grantMembership'] }]) {
    denied(() =>
      assertAdministrationRoles(captured, { ...grant, ...change } as typeof grant, 'roles' in change ? ['owner'] : ['reader'], 1500, 1000),
    );
  }
  input.operators[0].roles = ['owner'];
  assertAdministrationRoles(captured, grant, ['reader'], 1500, 1000);
  denied(() => assertAdministrationRoles(input, grant, ['reader'], 1500, 1000));
  assertAdministrationRoles(
    captured,
    { ...grant, roles: [...grant.roles].reverse(), tenants: [...grant.tenants].reverse(), operations: [...grant.operations].reverse() },
    ['reader'],
    1500,
    1000,
  );
});

test('role assertion enforces nonempty canonical subsets and inclusive lifetime ceiling', () => {
  const captured = captureAdministrationPolicy(policy());
  const grant = administrationGrant(captured, 'operator', 'north', 'grantMembership');
  for (const roles of [['reader'], ['manager', 'reader']]) {
    for (const expiry of [1001, 2000]) assertAdministrationRoles(captured, grant, roles, expiry, 1000);
  }
  for (const roles of [[], ['owner'], ['reader', 'owner'], ['reader', 'reader'], [' reader']]) {
    denied(() => assertAdministrationRoles(captured, grant, roles, 1500, 1000));
  }
  for (const expiry of [999, 1000, 2001, 1500.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    denied(() => assertAdministrationRoles(captured, grant, ['reader'], expiry, 1000));
  }
  for (const now of [-1, 1000.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    denied(() => assertAdministrationRoles(captured, grant, ['reader'], 1500, now));
  }
  assertAdministrationRoles(captured, grant, ['reader'], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1000);
  denied(() => assertAdministrationRoles(captured, grant, ['reader'], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 999));
  const year = captureAdministrationPolicy({ ...policy(), maxMembershipLifetimeMs: maximumLifetimeMs });
  assertAdministrationRoles(year, year.operators[0], ['reader'], maximumLifetimeMs, 0);
  denied(() => assertAdministrationRoles(year, year.operators[0], ['reader'], maximumLifetimeMs + 1, 0));
});

test('fingerprints are SHA256 with operation version 1 and canonical object/role ordering', () => {
  for (const intent of intents) {
    const first = administrationFingerprint(policy(), binding(), intent);
    assert.match(first, /^[a-f0-9]{64}$/);
    const reordered = reversed(intent) as AdministrationIntent;
    if ('roles' in reordered) (reordered.roles as string[]).reverse();
    assert.equal(
      administrationFingerprint(reversed(policy()) as AdministrationPolicy, reversed(binding()) as TenantStoreBinding, reordered),
      first,
    );
  }
  const canonical =
    '{"binding":{"appId":"app","source":{"id":"business"},"storeId":"store"},' +
    '"intent":{"operation":"createTenant","tenantId":"north"},"operationVersion":1,' +
    '"policy":{"id":"administrators","version":"v1"}}';
  assert.equal(administrationFingerprint(policy(), binding(), intents[0]), createHash('sha256').update(canonical).digest('hex'));
});

test('fingerprints distinguish every intent field, policy identity and durable binding', () => {
  const hashes = intents.map((intent) => administrationFingerprint(policy(), binding(), intent));
  assert.equal(new Set(hashes).size, intents.length);
  const alternatives: Record<string, unknown> = {
    tenantId: 'south',
    expectedTenantVersion: '9007199254740993',
    accountId: 'another-account',
    membershipId: 'another-membership',
    expectedMembershipVersion: '3',
    roles: ['reader'],
    validUntil: 1501,
    status: 'closed',
  };
  for (const intent of intents) {
    const original = administrationFingerprint(policy(), binding(), intent);
    for (const [field, value] of Object.entries(alternatives).filter(([field]) => Object.hasOwn(intent, field))) {
      assert.notEqual(
        administrationFingerprint(policy(), binding(), { ...intent, [field]: value } as AdministrationIntent),
        original,
        field,
      );
    }
    for (const field of ['id', 'version']) {
      assert.notEqual(administrationFingerprint({ ...policy(), [field]: 'changed' }, binding(), intent), original);
    }
    for (const owner of [
      { ...binding(), appId: 'other-app' },
      { ...binding(), storeId: 'other-store' },
      { ...binding(), source: { id: 'other_source', connection: 'alias' } },
    ]) {
      assert.notEqual(administrationFingerprint(policy(), owner, intent), original);
    }
    assert.equal(
      administrationFingerprint(policy(), { ...binding(), source: { id: 'business', connection: 'new-deployment-alias' } }, intent),
      original,
    );
    assert.equal(
      administrationFingerprint(
        {
          ...policy(),
          maxMembershipLifetimeMs: 2000,
          operators: [...policy().operators].reverse().map((rule) => ({
            ...rule,
            tenants: [...rule.tenants].reverse(),
            roles: [...rule.roles].reverse(),
            operations: [...rule.operations].reverse(),
          })),
        },
        binding(),
        intent,
      ),
      original,
    );
  }
});

test('fingerprint and assertion entry points also refuse hooks without executing them', () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('private-hook-detail');
  };
  const proxy = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook });
  const captured = captureAdministrationPolicy(policy());
  denied(() => administrationGrant(proxy as AdministrationPolicy, 'operator', 'north', 'createTenant'));
  denied(() => assertAdministrationRoles(captured, proxy as AdministrationPolicy['operators'][number], ['reader'], 1500, 1000));
  denied(() => assertAdministrationRoles(captured, captured.operators[0], proxy as readonly string[], 1500, 1000));
  denied(() => administrationFingerprint(proxy as AdministrationPolicy, binding(), intents[0]));
  denied(() => administrationFingerprint(captured, proxy as TenantStoreBinding, intents[0]));
  denied(() => administrationFingerprint(captured, binding(), proxy as AdministrationIntent));
  denied(() => administrationFingerprint(captured, { ...binding(), source: proxy } as TenantStoreBinding, intents[0]));
  const accessor = Object.defineProperty({ ...binding().source }, 'connection', { enumerable: true, get: hook });
  denied(() => administrationFingerprint(captured, { ...binding(), source: accessor }, intents[0]));
  assert.equal(calls, 0);
});
