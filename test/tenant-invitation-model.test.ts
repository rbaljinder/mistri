import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertInvitationTerms,
  captureInvitationIntent,
  captureInvitationPolicy,
  invitationFingerprint,
  invitationGrant,
  type InvitationPolicy,
} from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  INVITATION_ISSUER_OPERATIONS,
  type InvitationIntent,
  type InvitationIssuerOperation,
} from '../packages/mistri/src/shared/tenantInvitations.js';

const day = 24 * 60 * 60 * 1000;
const invitationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const membershipId = '11111111-2222-4333-9444-555555555555';
const policy = () => ({
  id: 'inviters',
  version: 'v1',
  maxMembershipLifetimeMs: 1000,
  maxRedemptionLifetimeMs: 100,
  maxPendingPerTenant: 10,
  operators: [
    { accountId: 'operator', tenants: ['north', 'south'], operations: [...INVITATION_ISSUER_OPERATIONS], roles: ['reader', 'manager'] },
  ],
});
const binding = (): TenantStoreBinding => ({ appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } });
const common = { tenantId: 'north', expectedTenantVersion: '1' };
const pair = { invitationId, membershipId, expectedInvitationVersion: '2', expectedMembershipVersion: '3' };
const terms = { roles: ['reader', 'manager'], redeemUntil: 1100, validUntil: 2000 };
const intents: readonly InvitationIntent[] = [
  { operation: 'issueInvitation', ...common, accountId: 'recipient', ...terms },
  { operation: 'revokeInvitation', ...common, ...pair },
  { operation: 'reissueInvitation', ...common, ...pair, ...terms },
  { operation: 'acceptInvitation', ...common, ...pair },
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

test('invitation policy and all four intents are detached recursively frozen data', () => {
  assert.deepEqual(INVITATION_ISSUER_OPERATIONS, ['issueInvitation', 'revokeInvitation', 'reissueInvitation']);
  assert.ok(Object.isFrozen(INVITATION_ISSUER_OPERATIONS));
  const input = policy(),
    captured = captureInvitationPolicy(input);
  frozen(captured);
  input.operators[0].roles.push('owner');
  input.operators[0].tenants.push('west');
  input.maxPendingPerTenant = 100;
  input.maxRedemptionLifetimeMs = 999;
  assert.deepEqual(captured.operators[0].roles, ['reader', 'manager']);
  assert.deepEqual(captured.operators[0].tenants, ['north', 'south']);
  assert.equal(captured.maxPendingPerTenant, 10);
  assert.equal(captured.maxRedemptionLifetimeMs, 100);
  for (const intent of intents) {
    const mutable = structuredClone(intent),
      snapshot = captureInvitationIntent(mutable);
    frozen(snapshot);
    Object.assign(mutable, { tenantId: 'west', redeemUntil: 9999 });
    if ('roles' in mutable) (mutable.roles as string[]).push('owner');
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), intent);
    assert.deepEqual(captureInvitationIntent(Object.assign(Object.create(null), intent)), snapshot);
  }
});

for (const intent of intents)
  test(`${intent.operation} requires its exact fields and excludes credential/authority goop`, () => {
    for (const key of Object.keys(intent)) {
      const missing = { ...intent } as Record<string, unknown>;
      delete missing[key];
      denied(() => captureInvitationIntent(missing));
      denied(() => captureInvitationIntent({ ...intent, [key]: undefined }));
    }
    const extras = [
      'token',
      'secret',
      'tokenDigest',
      'digest',
      'policyId',
      'policyVersion',
      'inviterId',
      'recipientId',
      'provider',
      'emailVerified',
      'context',
      'deployment',
      'idempotencyKey',
      'then',
      'toJSON',
      '__proto__',
      ...intents.flatMap((value) => Object.keys(value)).filter((key) => !Object.hasOwn(intent, key)),
    ];
    for (const key of new Set(extras)) {
      denied(() => captureInvitationIntent({ ...intent, [key]: 'forged' }));
      denied(() => invitationFingerprint(policy(), binding(), { ...intent, [key]: 'forged' } as InvitationIntent));
    }
  });

test('policy and operator shapes require every field and reject implicit administrative authority', () => {
  const rule = policy().operators[0];
  for (const [value, capture] of [
    [policy(), (input: unknown) => captureInvitationPolicy(input)],
    [rule, (input: unknown) => captureInvitationPolicy({ ...policy(), operators: [input] })],
  ] as const) {
    for (const key of Object.keys(value)) {
      const missing = { ...value } as Record<string, unknown>;
      delete missing[key];
      denied(() => capture(missing));
      denied(() => capture({ ...value, [key]: undefined }));
    }
    for (const key of ['nativeRole', 'admin', 'global', 'token', '__proto__', 'maxLifetimeMs']) {
      denied(() => capture({ ...value, [key]: 'forged' }));
    }
  }
  for (const operations of [[], ['issueInvitation', 'issueInvitation'], ['acceptInvitation'], ['grantMembership'], ['*'], ['toString']]) {
    denied(() => captureInvitationPolicy({ ...policy(), operators: [{ ...rule, operations }] }));
  }
});

test('redemption, membership and pending-count ceilings have independent inclusive bounds', () => {
  for (const [field, maximum] of [
    ['maxMembershipLifetimeMs', 366 * day],
    ['maxRedemptionLifetimeMs', 7 * day],
    ['maxPendingPerTenant', 10_000],
  ] as const) {
    for (const value of [1, maximum]) captureInvitationPolicy({ ...policy(), [field]: value });
    for (const value of [0, -1, 1.5, maximum + 1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      denied(() => captureInvitationPolicy({ ...policy(), [field]: value }));
    }
  }
});

test('bounded nonempty unique role, tenant and operator lists refuse overflow', () => {
  const rule = policy().operators[0];
  const values = Array.from({ length: 256 }, (_, index) => `value-${index}`);
  const operators = values.map((accountId) => ({ ...rule, accountId }));
  captureInvitationPolicy({ ...policy(), operators });
  for (const invalid of [[], [...operators, { ...rule, accountId: 'overflow' }]]) {
    denied(() => captureInvitationPolicy({ ...policy(), operators: invalid }));
  }
  for (const field of ['roles', 'tenants']) {
    captureInvitationPolicy({ ...policy(), operators: [{ ...rule, [field]: values }] });
    for (const value of [[], ['same', 'same'], [...values, 'overflow'], '*', [1]]) {
      denied(() => captureInvitationPolicy({ ...policy(), operators: [{ ...rule, [field]: value }] }));
      if (field === 'roles')
        for (const intent of [intents[0], intents[2]]) {
          denied(() => captureInvitationIntent({ ...intent, roles: value }));
        }
    }
  }
  for (const intent of [intents[0], intents[2]]) captureInvitationIntent({ ...intent, roles: values });
});

test('capture rejects goop, nested getters, proxies and coercion hooks without executing them', () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('private-hook-detail');
  };
  const proxy = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const accessor = Object.defineProperty({}, 'operation', { enumerable: true, get: hook });
  const arrayGetter = Object.defineProperty(['reader'], '0', { enumerable: true, get: hook });
  const sparse: unknown[] = [];
  sparse.length = 1;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  // oxlint-disable-next-line unicorn/no-thenable -- Hostile data must never be assimilated.
  const thenable = { then: hook };
  for (const value of [
    null,
    undefined,
    1,
    'input',
    true,
    1n,
    Symbol('input'),
    hook,
    [],
    new Date(),
    proxy,
    revoked.proxy,
    accessor,
    Object.create(intents[0]),
    { toJSON: hook },
    thenable,
    { [Symbol.toPrimitive]: hook },
    Object.defineProperty({}, 'hidden', { value: 1 }),
    cyclic,
  ]) {
    denied(() => captureInvitationPolicy(value));
    denied(() => captureInvitationIntent(value));
  }
  for (const value of [
    proxy,
    revoked.proxy,
    arrayGetter,
    sparse,
    Object.assign(['reader'], { extra: 1 }),
    Object.defineProperty(['reader'], '0', { enumerable: false }),
  ]) {
    denied(() => captureInvitationPolicy({ ...policy(), operators: value }));
    denied(() => captureInvitationPolicy({ ...policy(), operators: [{ ...policy().operators[0], roles: value }] }));
    for (const intent of [intents[0], intents[2]]) denied(() => captureInvitationIntent({ ...intent, roles: value }));
    denied(() => assertInvitationTerms(policy(), 'operator', 'north', 'issueInvitation', value as string[], 1100, 2000, 1000));
  }
  const getterIntent = Object.defineProperty({ ...intents[0] }, 'accountId', { enumerable: true, get: hook });
  denied(() => captureInvitationIntent(getterIntent));
  denied(() => invitationGrant(proxy as InvitationPolicy, 'operator', 'north', 'issueInvitation'));
  denied(() => invitationFingerprint(proxy as InvitationPolicy, binding(), intents[0]));
  denied(() => invitationFingerprint(policy(), proxy as TenantStoreBinding, intents[0]));
  denied(() => invitationFingerprint(policy(), binding(), proxy as InvitationIntent));
  denied(() => invitationFingerprint(policy(), { ...binding(), source: proxy } as TenantStoreBinding, intents[0]));
  const source = Object.defineProperty({ ...binding().source }, 'connection', { enumerable: true, get: hook });
  denied(() => invitationFingerprint(policy(), { ...binding(), source }, intents[0]));
  assert.equal(calls, 0);
});

test('identifier limits count UTF-8 bytes and refuse lone surrogates without discarding valid Unicode', () => {
  for (const value of [
    '',
    ' padded',
    'padded ',
    'line\nbreak',
    '\u0000',
    '\u007f',
    '\ud800',
    '\udfff',
    'x\ud800y',
    'x'.repeat(257),
    'é'.repeat(129),
    '😀'.repeat(65),
    1,
    null,
  ]) {
    denied(() => captureInvitationPolicy({ ...policy(), id: value }));
    denied(() => captureInvitationPolicy({ ...policy(), version: value }));
    denied(() => captureInvitationIntent({ ...intents[0], roles: [value] }));
  }
  for (const value of ['é'.repeat(128), '😀'.repeat(64)]) {
    captureInvitationPolicy({ ...policy(), id: value, version: value });
    captureInvitationIntent({ ...intents[0], roles: [value] });
  }
  for (const value of ['x'.repeat(1024), 'é'.repeat(512), '😀'.repeat(256)]) {
    captureInvitationIntent({ ...intents[0], accountId: value });
    captureInvitationPolicy({ ...policy(), operators: [{ ...policy().operators[0], accountId: value }] });
  }
  for (const value of ['x'.repeat(1025), 'é'.repeat(513), '😀'.repeat(257), '\ud800', '\udfff', ' recipient', '\n']) {
    denied(() => captureInvitationIntent({ ...intents[0], accountId: value }));
    denied(() => captureInvitationPolicy({ ...policy(), operators: [{ ...policy().operators[0], accountId: value }] }));
  }
  for (const value of ['*', 'North', 'north/west', 'north%2fwest', '-north', 'a'.repeat(129), '\ud800']) {
    for (const intent of intents) denied(() => captureInvitationIntent({ ...intent, tenantId: value }));
    denied(() => captureInvitationPolicy({ ...policy(), operators: [{ ...policy().operators[0], tenants: [value] }] }));
  }
  captureInvitationIntent({ ...intents[0], tenantId: 'a'.repeat(128) });
});

test('all revisions preserve canonical positive decimal strings through 128 digits', () => {
  for (const intent of intents)
    for (const field of ['expectedTenantVersion', 'expectedInvitationVersion', 'expectedMembershipVersion'].filter((key) =>
      Object.hasOwn(intent, key),
    )) {
      for (const value of ['1', '9007199254740993', '9'.repeat(128)]) {
        assert.equal((captureInvitationIntent({ ...intent, [field]: value }) as unknown as Record<string, unknown>)[field], value);
      }
      for (const value of [0, 1, 1n, '', '0', '01', '+1', '-1', '1.0', '1e2', ' 1', '1 ', '1'.repeat(129), '١', '\ud800']) {
        denied(() => captureInvitationIntent({ ...intent, [field]: value }));
      }
    }
});

test('revision validation refuses trailing line terminators on every CAS field', () => {
  for (const intent of intents)
    for (const field of ['expectedTenantVersion', 'expectedInvitationVersion', 'expectedMembershipVersion'].filter((key) =>
      Object.hasOwn(intent, key),
    )) {
      for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        denied(() => captureInvitationIntent({ ...intent, [field]: `1${suffix}` }));
      }
    }
});

test('invitation and reserved membership identities require canonical lowercase v4 UUIDs', () => {
  for (const intent of intents.slice(1))
    for (const field of ['invitationId', 'membershipId']) {
      for (const variant of ['8', '9', 'a', 'b'])
        captureInvitationIntent({ ...intent, [field]: `aaaaaaaa-bbbb-4ccc-${variant}ddd-eeeeeeeeeeee` });
      for (const value of [
        '',
        1,
        invitationId.toUpperCase(),
        ` ${invitationId}`,
        `${invitationId} `,
        invitationId.replace('-4ccc-', '-7ccc-'),
        invitationId.replace('-8ddd-', '-cddd-'),
        invitationId.replaceAll('-', ''),
        '00000000-0000-0000-0000-000000000000',
        '\ud800',
      ]) {
        denied(() => captureInvitationIntent({ ...intent, [field]: value }));
      }
    }
});

test('UUID validation refuses trailing line terminators on both pair identities', () => {
  for (const intent of intents.slice(1))
    for (const field of ['invitationId', 'membershipId']) {
      for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        denied(() => captureInvitationIntent({ ...intent, [field]: `${invitationId}${suffix}` }));
      }
    }
});

test('capture preserves absolute terms independently of current freshness and rejects malformed times', () => {
  for (const intent of [intents[0], intents[2]]) {
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      const captured = captureInvitationIntent({ ...intent, redeemUntil: value, validUntil: value });
      assert.ok('redeemUntil' in captured);
      assert.equal(captured.redeemUntil, value);
      assert.equal(captured.validUntil, value);
    }
    for (const field of ['redeemUntil', 'validUntil'])
      for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1100', null])
        denied(() => captureInvitationIntent({ ...intent, [field]: value }));
    denied(() => captureInvitationIntent({ ...intent, redeemUntil: 2001, validUntil: 2000 }));
  }
  for (const operation of ['accept', 'IssueInvitation', 'grantMembership', '*', 'toString', '__proto__', 1]) {
    denied(() => captureInvitationIntent({ ...intents[0], operation }));
  }
});

test('grants and terms enforce exact account, tenant and operation without unioning role ceilings', () => {
  const split = captureInvitationPolicy({
    ...policy(),
    operators: [
      { accountId: 'operator', tenants: ['north'], operations: ['issueInvitation'], roles: ['reader'] },
      { accountId: 'operator', tenants: ['north'], operations: ['reissueInvitation'], roles: ['manager'] },
      { accountId: 'operator', tenants: ['south'], operations: ['revokeInvitation'], roles: ['owner'] },
    ],
  });
  for (const [operation, role] of [
    ['issueInvitation', 'reader'],
    ['reissueInvitation', 'manager'],
  ] as const) {
    const grant = invitationGrant(split, 'operator', 'north', operation);
    frozen(grant);
    assert.deepEqual(grant.roles, [role]);
    assertInvitationTerms(split, 'operator', 'north', operation, [role], 1100, 2000, 1000);
    for (const roles of [['reader', 'manager'], ['owner']]) {
      denied(() => assertInvitationTerms(split, 'operator', 'north', operation, roles, 1100, 2000, 1000));
    }
  }
  for (const account of ['recipient', 'admin', 'administrator', 'Operator', '*']) {
    denied(() => invitationGrant(split, account, 'north', 'issueInvitation'));
  }
  denied(() => invitationGrant(split, 'operator', 'south', 'issueInvitation'));
  denied(() => invitationGrant(split, 'operator', 'north', 'revokeInvitation'));
  denied(() => invitationGrant(split, 'operator', 'west', 'issueInvitation'));
  denied(() => invitationGrant(split, 'operator', 'north', 'acceptInvitation' as InvitationIssuerOperation));
});

test('overlapping grants refuse independent of ordering while disjoint operation grants remain valid', () => {
  const first = policy().operators[0];
  for (const roles of [['reader'], ['owner']]) {
    const overlap = { ...first, tenants: ['south', 'west'], operations: ['reissueInvitation'] as InvitationIssuerOperation[], roles };
    for (const operators of [
      [first, overlap],
      [overlap, first],
    ]) {
      denied(() => captureInvitationPolicy({ ...policy(), operators }));
      denied(() => invitationGrant({ ...policy(), operators }, 'operator', 'north', 'issueInvitation'));
    }
  }
  for (const distinct of [{ accountId: 'another' }, { tenants: ['west'] }]) {
    captureInvitationPolicy({ ...policy(), operators: [first, { ...first, ...distinct }] });
  }
});

test('terms recheck narrowed or removed current grants without mutating captured policy', () => {
  const input = policy(),
    captured = captureInvitationPolicy(input);
  input.operators[0].roles = ['reader'];
  assertInvitationTerms(captured, 'operator', 'north', 'reissueInvitation', ['manager'], 1100, 2000, 1000);
  denied(() => assertInvitationTerms(input, 'operator', 'north', 'reissueInvitation', ['manager'], 1100, 2000, 1000));
  input.operators[0].operations = ['issueInvitation'];
  denied(() => assertInvitationTerms(input, 'operator', 'north', 'reissueInvitation', ['reader'], 1100, 2000, 1000));
});

test('absolute terms enforce inclusive independent ceilings and strict expiry after queue delay', () => {
  for (const operation of ['issueInvitation', 'reissueInvitation'] as const) {
    for (const [redeemUntil, validUntil] of [
      [1001, 1001],
      [1100, 2000],
      [1100, 1100],
    ]) {
      assertInvitationTerms(policy(), 'operator', 'north', operation, ['manager', 'reader'], redeemUntil, validUntil, 1000);
    }
    for (const [redeemUntil, validUntil, now] of [
      [1000, 2000, 1000],
      [999, 2000, 1000],
      [1101, 2000, 1000],
      [1100, 2001, 1000],
      [1100, 1099, 1000],
      [1100, 2000, 1100],
      [1100, 2000, 2000],
    ]) {
      denied(() => assertInvitationTerms(policy(), 'operator', 'north', operation, ['reader'], redeemUntil, validUntil, now));
    }
    for (const roles of [[], ['reader', 'reader'], ['owner'], [' reader']]) {
      denied(() => assertInvitationTerms(policy(), 'operator', 'north', operation, roles, 1100, 2000, 1000));
    }
    for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      denied(() => assertInvitationTerms(policy(), 'operator', 'north', operation, ['reader'], 1100, 2000, value));
      denied(() => assertInvitationTerms(policy(), 'operator', 'north', operation, ['reader'], value, 2000, 1000));
      denied(() => assertInvitationTerms(policy(), 'operator', 'north', operation, ['reader'], 1100, value, 1000));
    }
  }
  const now = Number.MAX_SAFE_INTEGER - 1000;
  assertInvitationTerms(policy(), 'operator', 'north', 'issueInvitation', ['reader'], now + 100, Number.MAX_SAFE_INTEGER, now);
  denied(() =>
    assertInvitationTerms(policy(), 'operator', 'north', 'issueInvitation', ['reader'], now + 100, Number.MAX_SAFE_INTEGER, now + 1),
  );
});

test('fingerprint has a versioned invitation domain and canonical namespace, policy and intent encoding', () => {
  const canonical =
    '{"binding":{"appId":"app","sourceId":"business","storeId":"store"},' +
    '"domain":"mistri:tenant-invitation-attempt:v1","intent":{"accountId":"recipient",' +
    '"expectedTenantVersion":"1","operation":"issueInvitation","redeemUntil":1100,' +
    '"roles":["manager","reader"],"tenantId":"north","validUntil":2000},"policy":{"id":"inviters","version":"v1"}}';
  assert.equal(invitationFingerprint(policy(), binding(), intents[0]), createHash('sha256').update(canonical).digest('hex'));
  for (const intent of intents) {
    const original = invitationFingerprint(policy(), binding(), intent),
      reordered = reversed(intent) as InvitationIntent;
    if ('roles' in reordered) (reordered.roles as string[]).reverse();
    assert.match(original, /^[a-f0-9]{64}$/);
    assert.equal(
      invitationFingerprint(reversed(policy()) as InvitationPolicy, reversed(binding()) as TenantStoreBinding, reordered),
      original,
    );
  }
});

test('fingerprints bind every intent field and stable owner identity but exclude deployment aliases and policy ordering', () => {
  assert.equal(new Set(intents.map((intent) => invitationFingerprint(policy(), binding(), intent))).size, 4);
  const changes = {
    tenantId: 'south',
    expectedTenantVersion: '9007199254740993',
    accountId: 'another',
    invitationId: membershipId,
    membershipId: invitationId,
    expectedInvitationVersion: '9007199254740993',
    expectedMembershipVersion: '4',
    roles: ['reader'],
    redeemUntil: 1099,
    validUntil: 1999,
  };
  for (const intent of intents) {
    const original = invitationFingerprint(policy(), binding(), intent);
    for (const [field, value] of Object.entries(changes).filter(([field]) => Object.hasOwn(intent, field))) {
      assert.notEqual(invitationFingerprint(policy(), binding(), { ...intent, [field]: value } as InvitationIntent), original, field);
    }
    for (const field of ['id', 'version'])
      assert.notEqual(invitationFingerprint({ ...policy(), [field]: 'changed' }, binding(), intent), original);
    for (const owner of [
      { ...binding(), appId: 'other' },
      { ...binding(), storeId: 'other' },
      { ...binding(), source: { id: 'other', connection: 'alias' } },
    ]) {
      assert.notEqual(invitationFingerprint(policy(), owner, intent), original);
    }
    assert.equal(invitationFingerprint(policy(), { ...binding(), source: { id: 'business', connection: 'new-alias' } }, intent), original);
    const reordered = {
      ...policy(),
      maxMembershipLifetimeMs: 2000,
      maxRedemptionLifetimeMs: 200,
      maxPendingPerTenant: 20,
      operators: policy().operators.map((rule) => ({
        ...rule,
        tenants: [...rule.tenants].reverse(),
        operations: [...rule.operations].reverse(),
        roles: [...rule.roles].reverse(),
      })),
    };
    assert.equal(invitationFingerprint(reordered, binding(), intent), original);
  }
});

test('fingerprint validates exact namespace shapes and all identifiers even when alias is excluded from digest', () => {
  for (const [value, wrap] of [
    [binding(), (input: unknown) => input],
    [binding().source, (input: unknown) => ({ ...binding(), source: input })],
  ] as const) {
    for (const field of Object.keys(value)) {
      const missing = { ...value } as Record<string, unknown>;
      delete missing[field];
      for (const invalid of [missing, { ...value, [field]: undefined }, { ...value, [field]: '\ud800' }]) {
        denied(() => invitationFingerprint(policy(), wrap(invalid) as TenantStoreBinding, intents[0]));
      }
    }
    for (const key of ['deployment', 'token', '__proto__']) {
      denied(() => invitationFingerprint(policy(), wrap({ ...value, [key]: 'goop' }) as TenantStoreBinding, intents[0]));
    }
  }
  for (const id of ['business-source', '1business', 'business/source', 'business\n', 'é']) {
    denied(() => invitationFingerprint(policy(), { ...binding(), source: { id, connection: 'alias' } }, intents[0]));
  }
});
