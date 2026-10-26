import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../packages/mistri/src/server/tenant/tenantInvitationChange.js';
import {
  captureInvitationChange,
  validateInvitationJournalPair,
  validateLinkedInvitationRevocation,
} from '../packages/mistri/src/server/tenant/tenantInvitationChange.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { AdministrationAudit, StoredAdministrationReceipt } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import type {
  InvitationChange,
  InvitationIntent,
  InvitationOperation,
  InvitationPair,
} from '../packages/mistri/src/shared/tenantInvitations.js';

const oldInvitation = '11111111-1111-4111-8111-111111111111';
const oldMembership = '22222222-2222-4222-8222-222222222222';
const newInvitation = '33333333-3333-4333-8333-333333333333';
const newMembership = '44444444-4444-4444-8444-444444444444';
const ceiling = ['manager', 'reader', 'writer'];
const operations: readonly InvitationOperation[] = ['issueInvitation', 'revokeInvitation', 'acceptInvitation', 'reissueInvitation'];

function pair(): InvitationPair {
  return {
    invitation: {
      invitationId: oldInvitation,
      membershipId: oldMembership,
      tenantId: 'north',
      accountId: 'recipient',
      inviterId: 'issuer',
      version: '9007199254740993',
      roles: ['reader', 'manager'],
      expectedTenantVersion: '7',
      policyId: 'invitations',
      policyVersion: 'v1',
      issuanceOperation: 'issueInvitation',
      createdAt: 100,
      redeemUntil: 200,
      validUntil: 300,
      status: 'pending',
    },
    membership: {
      membershipId: oldMembership,
      tenantId: 'north',
      accountId: 'recipient',
      status: 'invited',
      version: '19',
      roles: ['manager', 'reader'],
      validUntil: 300,
    },
  };
}
function terminated(before: InvitationPair, accepted = false): InvitationPair {
  return {
    invitation: {
      ...before.invitation,
      status: accepted ? 'accepted' : 'revoked',
      version: String(BigInt(before.invitation.version) + 1n),
    },
    membership: { ...before.membership, status: accepted ? 'active' : 'revoked', version: String(BigInt(before.membership.version) + 1n) },
  };
}
function fixture(operation: InvitationOperation): { change: InvitationChange; intent: InvitationIntent } {
  const before = pair(),
    tenant = { tenantId: 'north', status: 'active' as const, version: '7' };
  const expected = {
    tenantId: 'north',
    expectedTenantVersion: '7',
    invitationId: oldInvitation,
    expectedInvitationVersion: before.invitation.version,
    membershipId: oldMembership,
    expectedMembershipVersion: before.membership.version,
  };
  if (operation === 'issueInvitation' || operation === 'reissueInvitation') {
    const after: InvitationPair = {
      invitation: {
        ...before.invitation,
        invitationId: newInvitation,
        membershipId: newMembership,
        version: '1',
        issuanceOperation: operation,
        createdAt: 400,
        redeemUntil: 500,
        validUntil: 600,
        roles: ['writer', 'reader'],
      },
      membership: { ...before.membership, membershipId: newMembership, version: '1', roles: ['reader', 'writer'], validUntil: 600 },
    };
    const terms = { roles: ['reader', 'writer'], redeemUntil: 500, validUntil: 600 };
    return operation === 'issueInvitation'
      ? {
          change: { operation, tenant, before: null, after },
          intent: { operation, tenantId: 'north', expectedTenantVersion: '7', accountId: 'recipient', ...terms },
        }
      : { change: { operation, tenant, before, after, revoked: terminated(before) }, intent: { operation, ...expected, ...terms } };
  }
  return {
    change: { operation, tenant, before, after: terminated(before, operation === 'acceptInvitation') },
    intent: { operation, ...expected },
  };
}
function replace<T>(input: T, path: string, value: unknown, remove = false): T {
  const copy = structuredClone(input),
    keys = path.split('.');
  let target = copy as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  if (remove) delete target[keys.at(-1)!];
  else Object.defineProperty(target, keys.at(-1)!, { value, enumerable: true, configurable: true, writable: true });
  return copy;
}
const denied = (work: () => unknown) =>
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof TenantContextError);
    assert.equal(error.message, 'The tenant context could not be verified.');
    assert.equal('cause' in error, false);
    return true;
  });
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function paths(change: InvitationChange): string[] {
  return ['after', ...(change.before ? ['before'] : []), ...(change.revoked ? ['revoked'] : [])];
}
function journal(change: InvitationChange): { receipt: StoredAdministrationReceipt; audit: AdministrationAudit } {
  return {
    receipt: {
      actorId: change.operation === 'acceptInvitation' ? 'recipient' : 'issuer',
      tenantId: 'north',
      operation: change.operation,
      operationVersion: 1,
      idempotencyKey: 'attempt',
      id: 'receipt',
      fingerprint: 'fingerprint',
      resultJson: JSON.stringify(change),
      requestId: 'request',
      completedAt: '2026-09-08T00:00:00.000Z',
    },
    audit: {
      policyId: 'invitations',
      policyVersion: 'v1',
      deployment: 'deployment',
      sessionId: 'native-login',
      changeJson: JSON.stringify(change),
    },
  };
}

test('exports only the three pure validators', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'captureInvitationChange',
    'validateInvitationJournalPair',
    'validateLinkedInvitationRevocation',
  ]);
});

for (const operation of operations) {
  test(`${operation}: valid historical images are detached and recursively frozen`, () => {
    const { change, intent } = fixture(operation),
      captured = captureInvitationChange(change, intent, ceiling);
    frozen(captured);
    assert.notEqual(captured, change);
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), change);
    (change.after.invitation.roles as string[]).push('forged');
    assert.equal(captured.after.invitation.roles.includes('forged'), false);
  });

  test(`${operation}: every image requires exactly its own data fields`, () => {
    const { change, intent } = fixture(operation);
    const records = [
      ['', change],
      ['tenant', change.tenant],
      ...paths(change).flatMap((path) => {
        const value = change[path as 'after']!;
        return [
          [path, value],
          [`${path}.invitation`, value.invitation],
          [`${path}.membership`, value.membership],
        ];
      }),
    ] as [string, object][];
    for (const [path, record] of records) {
      const prefix = path ? `${path}.` : '';
      for (const key of Object.keys(record)) {
        denied(() => captureInvitationChange(replace(change, prefix + key, undefined, true), intent, ceiling));
        denied(() => captureInvitationChange(replace(change, prefix + key, undefined), intent, ceiling));
      }
      for (const key of ['token', 'digest', 'secret', 'then', '__proto__', 'extra']) {
        denied(() => captureInvitationChange(replace(change, prefix + key, 'forged'), intent, ceiling));
      }
    }
  });

  test(`${operation}: rejects mismatched tenant, account, IDs, roles and absolute expiry within every pair`, () => {
    const { change, intent } = fixture(operation);
    for (const path of paths(change)) {
      for (const [key, value] of Object.entries({
        tenantId: 'south',
        accountId: 'other',
        membershipId: newInvitation,
        roles: ['reader'],
        validUntil: 999,
      })) {
        denied(() => captureInvitationChange(replace(change, `${path}.membership.${key}`, value), intent, ceiling));
      }
      for (const [key, value] of Object.entries({
        tenantId: 'south',
        accountId: 'other',
        membershipId: newInvitation,
        roles: ['reader'],
        validUntil: 999,
      })) {
        denied(() => captureInvitationChange(replace(change, `${path}.invitation.${key}`, value), intent, ceiling));
      }
    }
    denied(() => captureInvitationChange(replace(change, 'tenant.version', '8'), intent, ceiling));
    denied(() => captureInvitationChange(replace(change, 'tenant.tenantId', 'south'), intent, ceiling));
    denied(() => captureInvitationChange(replace(change, 'operation', 'revokeMembership'), intent, ceiling));
  });

  test(`${operation}: rejects malformed UUIDs, revisions, string identities, times and role sets`, () => {
    const { change, intent } = fixture(operation);
    for (const path of paths(change)) {
      for (const key of ['invitation.invitationId', 'invitation.membershipId', 'membership.membershipId']) {
        for (const value of [
          'opaque',
          newInvitation.toUpperCase().replace('3333', 'ABCD'),
          newInvitation.replace('-4333-', '-7333-'),
          newInvitation.replace('-8333-', '-7333-'),
          '',
          null,
          1,
        ]) {
          denied(() => captureInvitationChange(replace(change, `${path}.${key}`, value), intent, ceiling));
        }
      }
      for (const key of ['invitation.version', 'invitation.expectedTenantVersion', 'membership.version']) {
        for (const value of [1, 1n, '', '0', '01', '+1', '-1', '1.0', '1e2', '1\n', '1'.repeat(129)]) {
          denied(() => captureInvitationChange(replace(change, `${path}.${key}`, value), intent, ceiling));
        }
      }
      for (const key of [
        'invitation.accountId',
        'invitation.inviterId',
        'invitation.policyId',
        'invitation.policyVersion',
        'membership.accountId',
      ]) {
        for (const value of ['', ' padded', 'padded ', '\u0000', '\uD800', 'é'.repeat(1024), null, 1]) {
          denied(() => captureInvitationChange(replace(change, `${path}.${key}`, value), intent, ceiling));
        }
      }
      for (const key of ['invitation.createdAt', 'invitation.redeemUntil', 'invitation.validUntil', 'membership.validUntil']) {
        for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
          denied(() => captureInvitationChange(replace(change, `${path}.${key}`, value), intent, ceiling));
        }
      }
      for (const key of ['invitation.roles', 'membership.roles']) {
        for (const value of [
          [],
          ['reader', 'reader'],
          [' reader'],
          ['\uD800'],
          ['x'.repeat(257)],
          ['é'.repeat(129)],
          [1],
          'reader',
          Array(257).fill('reader'),
        ]) {
          denied(() => captureInvitationChange(replace(change, `${path}.${key}`, value), intent, ceiling));
        }
      }
    }
  });

  test(`${operation}: validates exact intent and ceiling as inert data`, () => {
    const { change, intent } = fixture(operation);
    denied(() => captureInvitationChange(change, { ...intent, token: 'secret' } as unknown as InvitationIntent, ceiling));
    denied(() => captureInvitationChange(change, intent, ['reader']));
    denied(() => captureInvitationChange(change, intent, []));
    denied(() => captureInvitationChange(change, intent, ['reader', 'reader']));
    denied(() => captureInvitationChange(change, intent, [' reader']));
    for (const key of Object.keys(intent)) denied(() => captureInvitationChange(change, replace(intent, key, undefined, true), ceiling));
  });

  test(`${operation}: valid journal pair binds operation, target, actor and policy`, () => {
    const { change } = fixture(operation),
      { receipt, audit } = journal(change);
    validateInvitationJournalPair(receipt, audit);
    for (const [key, value] of Object.entries({ operation: 'grantMembership', tenantId: 'south', operationVersion: 2 })) {
      denied(() => validateInvitationJournalPair(replace(receipt, key, value), audit));
    }
    if (operation !== 'revokeInvitation') {
      denied(() => validateInvitationJournalPair({ ...receipt, actorId: 'other' }, audit));
      denied(() => validateInvitationJournalPair(receipt, { ...audit, policyId: 'other' }));
      denied(() => validateInvitationJournalPair(receipt, { ...audit, policyVersion: 'v2' }));
    } else
      validateInvitationJournalPair(
        { ...receipt, actorId: 'different-current-operator' },
        { ...audit, policyId: 'current-policy', policyVersion: 'v2' },
      );
  });
}

test('issue requires no previous pair, active tenant, initial versions and exact issuance terms', () => {
  const { change, intent } = fixture('issueInvitation');
  for (const [path, value] of Object.entries({
    before: pair(),
    'tenant.status': 'suspended',
    'after.invitation.version': '2',
    'after.membership.version': '2',
    'after.invitation.expectedTenantVersion': '6',
    'after.invitation.issuanceOperation': 'reissueInvitation',
    'after.invitation.redeemUntil': 501,
    'after.invitation.createdAt': 500,
  })) {
    denied(() => captureInvitationChange(replace(change, path, value), intent, ceiling));
  }
  denied(() => captureInvitationChange(change, replace(intent, 'accountId', 'other'), ceiling));
  denied(() => captureInvitationChange(change, replace(intent, 'roles', ['reader']), ceiling));
  denied(() => captureInvitationChange(change, replace(intent, 'validUntil', 601), ceiling));
});

for (const operation of ['revokeInvitation', 'acceptInvitation', 'reissueInvitation'] as const) {
  test(`${operation}: exact old IDs and revisions; cannot act on consumed or missing pairs`, () => {
    const { change, intent } = fixture(operation);
    for (const [key, value] of Object.entries({
      invitationId: newInvitation,
      membershipId: newMembership,
      expectedInvitationVersion: '3',
      expectedMembershipVersion: '3',
    })) {
      denied(() => captureInvitationChange(change, replace(intent, key, value), ceiling));
    }
    denied(() => captureInvitationChange(replace(change, 'before', null), intent, ceiling));
    denied(() => captureInvitationChange(replace(change, 'before', terminated(pair(), true)), intent, ceiling));
    denied(() => captureInvitationChange(replace(change, 'before', terminated(pair())), intent, ceiling));
  });

  test(`${operation}: terminating pair increments both revisions and preserves every other field`, () => {
    const { change, intent } = fixture(operation),
      target = operation === 'reissueInvitation' ? 'revoked' : 'after';
    const changes = {
      'invitation.invitationId': newInvitation,
      'invitation.version': '9007199254740993',
      'invitation.inviterId': 'other',
      'invitation.expectedTenantVersion': '8',
      'invitation.policyId': 'other',
      'invitation.policyVersion': 'v2',
      'invitation.createdAt': 99,
      'invitation.redeemUntil': 199,
      'invitation.issuanceOperation': 'reissueInvitation',
      'membership.version': '19',
    };
    for (const [path, value] of Object.entries(changes)) {
      denied(() => captureInvitationChange(replace(change, `${target}.${path}`, value), intent, ceiling));
    }
    for (const [key, value] of Object.entries({
      accountId: 'other',
      tenantId: 'south',
      roles: ['reader'],
      validUntil: 301,
      membershipId: newMembership,
    })) {
      const changed = replace(replace(change, `${target}.invitation.${key}`, value), `${target}.membership.${key}`, value);
      denied(() => captureInvitationChange(changed, intent, ceiling));
    }
  });
}

test('role order is set meaning across intent and every historical image', () => {
  for (const operation of operations) {
    const { change, intent } = fixture(operation);
    let reordered = change;
    for (const path of paths(change)) {
      const value = change[path as 'after'];
      reordered = replace(
        replace(reordered, `${path}.invitation.roles`, [...value.invitation.roles].reverse()),
        `${path}.membership.roles`,
        [...value.membership.roles].reverse(),
      );
    }
    captureInvitationChange(reordered, intent, [...ceiling].reverse());
  }
});

test('non-reissue always rejects revoked, even when explicitly undefined or null', () => {
  for (const operation of operations.filter((value) => value !== 'reissueInvitation')) {
    const { change, intent } = fixture(operation);
    for (const revoked of [undefined, null, terminated(pair())])
      denied(() => captureInvitationChange({ ...change, revoked }, intent, ceiling));
  }
});

test('revoke permits suspended/closed tenants and a later current tenant version', () => {
  const { change, intent } = fixture('revokeInvitation');
  for (const status of ['active', 'suspended', 'closed']) {
    const changed = replace(replace(change, 'tenant.status', status), 'tenant.version', '23');
    captureInvitationChange(changed, replace(intent, 'expectedTenantVersion', '23'), ceiling);
    const { receipt, audit } = journal(changed);
    validateInvitationJournalPair(receipt, { ...audit, policyId: 'new-policy' });
  }
});

test('accept requires active tenant at issuance version but has no freshness or current-inviter assumption', () => {
  const { change, intent } = fixture('acceptInvitation');
  for (const status of ['suspended', 'closed'])
    denied(() => captureInvitationChange(replace(change, 'tenant.status', status), intent, ceiling));
  denied(() => captureInvitationChange(replace(change, 'tenant.version', '8'), replace(intent, 'expectedTenantVersion', '8'), ceiling));
  // Ancient absolute expiries and a recipient who is also the inviter remain valid history.
  const historical = replace(replace(change, 'before.invitation.inviterId', 'recipient'), 'after.invitation.inviterId', 'recipient');
  captureInvitationChange(historical, intent, ceiling);
  const { receipt, audit } = journal(historical);
  validateInvitationJournalPair(receipt, audit);
});

test('reissue preserves old termination and requires new identities, account, terms and current issuance version', () => {
  const { change, intent } = fixture('reissueInvitation');
  for (const [path, value] of Object.entries({
    revoked: null,
    'after.invitation.invitationId': oldInvitation,
    'after.invitation.version': '2',
    'after.membership.version': '2',
    'after.invitation.issuanceOperation': 'issueInvitation',
    'after.invitation.expectedTenantVersion': '6',
    'after.invitation.redeemUntil': 501,
    'tenant.status': 'closed',
  })) {
    denied(() => captureInvitationChange(replace(change, path, value), intent, ceiling));
  }
  denied(() => captureInvitationChange(replace(change, 'revoked', undefined, true), intent, ceiling));
  for (const [key, value] of Object.entries({ membershipId: oldMembership, accountId: 'other', roles: ['reader'], validUntil: 601 })) {
    denied(() =>
      captureInvitationChange(
        replace(replace(change, `after.invitation.${key}`, value), `after.membership.${key}`, value),
        intent,
        ceiling,
      ),
    );
  }
  denied(() => captureInvitationChange(change, intent, ['reader', 'writer']));
  denied(() => captureInvitationChange(change, intent, ['reader', 'manager']));
  const current = replace(
    replace(replace(change, 'tenant.version', '23'), 'after.invitation.expectedTenantVersion', '23'),
    'after.invitation.policyVersion',
    'v2',
  );
  captureInvitationChange(current, replace(intent, 'expectedTenantVersion', '23'), ceiling);
  const { receipt, audit } = journal(current);
  validateInvitationJournalPair(receipt, { ...audit, policyVersion: 'v2' });
});

test('BigInt revisions preserve precision, accept the 128-digit boundary and reject increment overflow', () => {
  const { change, intent } = fixture('revokeInvitation');
  const beforeVersion = '9'.repeat(127) + '8',
    afterVersion = '9'.repeat(128);
  let changed = replace(replace(change, 'before.invitation.version', beforeVersion), 'after.invitation.version', afterVersion);
  changed = replace(replace(changed, 'before.membership.version', beforeVersion), 'after.membership.version', afterVersion);
  const expected = replace(replace(intent, 'expectedInvitationVersion', beforeVersion), 'expectedMembershipVersion', beforeVersion);
  captureInvitationChange(changed, expected, ceiling);
  for (const kind of ['invitation', 'membership']) {
    const overflow = replace(changed, `before.${kind}.version`, afterVersion);
    denied(() =>
      captureInvitationChange(
        overflow,
        replace(expected, kind === 'invitation' ? 'expectedInvitationVersion' : 'expectedMembershipVersion', afterVersion),
        ceiling,
      ),
    );
  }
  const issued = fixture('issueInvitation');
  captureInvitationChange(
    replace(replace(issued.change, 'tenant.version', afterVersion), 'after.invitation.expectedTenantVersion', afterVersion),
    replace(issued.intent, 'expectedTenantVersion', afterVersion),
    ceiling,
  );
});

test('canonical UUID and revision checks reject trailing newlines even when paired values agree', () => {
  const { change, intent } = fixture('issueInvitation');
  denied(() => captureInvitationChange(replace(change, 'after.invitation.invitationId', `${newInvitation}\n`), intent, ceiling));
  denied(() =>
    captureInvitationChange(
      replace(
        replace(change, 'after.invitation.membershipId', `${newMembership}\n`),
        'after.membership.membershipId',
        `${newMembership}\n`,
      ),
      intent,
      ceiling,
    ),
  );
  for (const version of ['7\n', '7\r', '7\r\n']) {
    denied(() =>
      captureInvitationChange(
        replace(replace(change, 'tenant.version', version), 'after.invitation.expectedTenantVersion', version),
        replace(intent, 'expectedTenantVersion', version),
        ceiling,
      ),
    );
  }
});

test('capture rejects getters, proxies, hooks, inherited data and hostile arrays before inspection', () => {
  const { change, intent } = fixture('issueInvitation');
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('private-hook-detail');
  };
  const proxy = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = Object.defineProperty({}, 'operation', { enumerable: true, get: hook });
  const sparse = Array(1),
    arrayGetter = Object.defineProperty(['reader'], '0', { enumerable: true, get: hook });
  // oxlint-disable-next-line unicorn/no-thenable -- Hostile input must not be assimilated.
  const thenable = { then: hook };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    proxy,
    revoked.proxy,
    getter,
    thenable,
    { toJSON: hook },
    { [Symbol.toPrimitive]: hook },
    Object.create(change),
    new Date(),
    cycle,
    Object.defineProperty({}, 'hidden', { value: 1 }),
    sparse,
    arrayGetter,
    Object.assign(['reader'], { extra: 'value' }),
  ]) {
    denied(() => captureInvitationChange(value, intent, ceiling));
    denied(() => captureInvitationChange({ ...change, after: value }, intent, ceiling));
    denied(() => captureInvitationChange(change, value as InvitationIntent, ceiling));
    denied(() => captureInvitationChange(change, intent, value as readonly string[]));
  }
  assert.equal(calls, 0);
});

test('journal rejects malformed envelopes/JSON, divergent images, secrets and structurally valid false transitions', () => {
  const { change } = fixture('reissueInvitation'),
    { receipt, audit } = journal(change);
  for (const key of Object.keys(receipt)) {
    denied(() => validateInvitationJournalPair(replace(receipt, key, undefined, true), audit));
    denied(() => validateInvitationJournalPair(replace(receipt, key, undefined), audit));
  }
  for (const key of Object.keys(audit)) denied(() => validateInvitationJournalPair(receipt, replace(audit, key, undefined, true)));
  for (const value of ['{', 'null', '[]', '1e999', '{}', ' '.repeat(65_537), JSON.stringify({ ...change, token: 'secret' })]) {
    denied(() => validateInvitationJournalPair({ ...receipt, resultJson: value }, audit));
    denied(() => validateInvitationJournalPair(receipt, { ...audit, changeJson: value }));
  }
  denied(() => validateInvitationJournalPair({ ...receipt, completedAt: '2026-09-08' }, audit));
  denied(() => validateInvitationJournalPair({ ...receipt, token: 'secret' } as StoredAdministrationReceipt, audit));
  denied(() => validateInvitationJournalPair(receipt, { ...audit, token: 'secret' } as AdministrationAudit));
  const falseChange = replace(change, 'revoked.invitation.inviterId', 'forged');
  denied(() =>
    validateInvitationJournalPair(
      { ...receipt, resultJson: JSON.stringify(falseChange) },
      { ...audit, changeJson: JSON.stringify(falseChange) },
    ),
  );
  denied(() =>
    validateInvitationJournalPair(receipt, { ...audit, changeJson: JSON.stringify(replace(change, 'after.invitation.createdAt', 401)) }),
  );
  // JSON property ordering is irrelevant; neither envelope wraps an InvitationResult.
  validateInvitationJournalPair(receipt, { ...audit, changeJson: JSON.stringify(Object.fromEntries(Object.entries(change).reverse())) });
  denied(() => validateInvitationJournalPair({ ...receipt, resultJson: JSON.stringify({ change, replayed: false }) }, audit));
});

test('journal captures typed arguments before invoking any accessor or coercion hook', () => {
  const { receipt, audit } = journal(fixture('issueInvitation').change);
  let calls = 0;
  const hook = () => {
    calls++;
    return 'private';
  };
  denied(() => validateInvitationJournalPair(Object.defineProperty({ ...receipt }, 'resultJson', { enumerable: true, get: hook }), audit));
  denied(() => validateInvitationJournalPair(receipt, Object.defineProperty({ ...audit }, 'changeJson', { enumerable: true, get: hook })));
  const proxy = new Proxy(receipt, { get: hook });
  denied(() => validateInvitationJournalPair(proxy, audit));
  assert.equal(calls, 0);
});

function linkedJournal() {
  const { change } = fixture('revokeInvitation'),
    { receipt, audit } = journal(change);
  const linked = {
    operation: 'revokeMembership',
    before: { tenant: { ...change.tenant }, membership: change.before!.membership },
    after: { tenant: { ...change.tenant }, membership: change.after.membership },
    invitation: { before: change.before!.invitation, after: change.after.invitation },
  };
  return {
    linked,
    receipt: { ...receipt, operation: 'revokeMembership', resultJson: JSON.stringify(linked) },
    audit: { ...audit, changeJson: JSON.stringify(linked) },
  };
}

test('linked direct revocation validates pending termination with independent operator and current policy', () => {
  const { linked, receipt, audit } = linkedJournal();
  validateLinkedInvitationRevocation(receipt, audit);
  for (const status of ['active', 'suspended', 'closed']) {
    let changed = replace(replace(linked, 'before.tenant.status', status), 'after.tenant.status', status);
    changed = replace(replace(changed, 'before.tenant.version', '23'), 'after.tenant.version', '23');
    validateLinkedInvitationRevocation(
      { ...receipt, actorId: 'different-operator', resultJson: JSON.stringify(changed) },
      { ...audit, policyId: 'administration', policyVersion: 'new-policy', changeJson: JSON.stringify(changed) },
    );
  }
});

test('unlinked direct revocation keeps historical validation outside this helper', () => {
  const { receipt, audit } = linkedJournal();
  // Older storage accepted JSON without the new operation-specific link shape.
  for (const value of [null, {}, [], { operation: 'revokeMembership', before: null, after: {} }]) {
    validateLinkedInvitationRevocation(
      { ...receipt, operationVersion: 2, resultJson: JSON.stringify(value) },
      { ...audit, changeJson: JSON.stringify({ historical: true }) },
    );
  }
});

test('linked direct revocation rejects one-sided, undefined, null or mismatched links', () => {
  const { linked, receipt, audit } = linkedJournal();
  for (const value of [
    replace(linked, 'invitation', undefined, true),
    replace(linked, 'invitation', null),
    replace(linked, 'invitation.after.inviterId', 'other'),
  ]) {
    denied(() => validateLinkedInvitationRevocation({ ...receipt, resultJson: JSON.stringify(value) }, audit));
    denied(() => validateLinkedInvitationRevocation(receipt, { ...audit, changeJson: JSON.stringify(value) }));
  }
});

test('linked direct revocation requires exact root, state and invitation images in both JSON documents', () => {
  const { linked, receipt, audit } = linkedJournal();
  const reject = (value: unknown) =>
    denied(() =>
      validateLinkedInvitationRevocation(
        { ...receipt, resultJson: JSON.stringify(value) },
        { ...audit, changeJson: JSON.stringify(value) },
      ),
    );
  const records: [string, object][] = [
    ['', linked],
    ['before', linked.before],
    ['after', linked.after],
    ['invitation', linked.invitation],
    ['invitation.before', linked.invitation.before],
    ['invitation.after', linked.invitation.after],
    ['before.tenant', linked.before.tenant],
    ['after.tenant', linked.after.tenant],
    ['before.membership', linked.before.membership],
    ['after.membership', linked.after.membership],
  ];
  for (const [path, record] of records) {
    const prefix = path ? `${path}.` : '';
    for (const key of Object.keys(record)) {
      if (!path && key === 'invitation') continue;
      reject(replace(linked, prefix + key, undefined, true));
    }
    for (const key of ['token', 'digest', 'extra', '__proto__']) reject(replace(linked, prefix + key, 'secret'));
  }
  for (const [path, value] of Object.entries({
    operation: 'replaceMembership',
    'after.tenant.version': '8',
    'after.tenant.status': 'closed',
    'invitation.after.version': '9007199254740993',
    'after.membership.version': '19',
    'invitation.before.status': 'accepted',
    'invitation.after.status': 'pending',
    'after.membership.status': 'active',
    'invitation.after.inviterId': 'different',
    'invitation.after.policyId': 'new-policy',
    'invitation.after.createdAt': 99,
    'invitation.after.invitationId': newInvitation,
    'invitation.after.redeemUntil': 199,
  }))
    reject(replace(linked, path, value));
  for (const [key, value] of Object.entries({ accountId: 'other', membershipId: newMembership, roles: ['reader'], validUntil: 301 })) {
    reject(replace(replace(linked, `invitation.after.${key}`, value), `after.membership.${key}`, value));
  }
});

test('linked direct revocation binds receipt target and version without imposing issuer identity', () => {
  const { receipt, audit } = linkedJournal();
  for (const [key, value] of Object.entries({
    operation: 'revokeInvitation',
    tenantId: 'south',
    operationVersion: 2,
    completedAt: 'yesterday',
    actorId: ' padded',
  })) {
    denied(() => validateLinkedInvitationRevocation(replace(receipt, key, value), audit));
  }
  validateLinkedInvitationRevocation({ ...receipt, actorId: 'other' }, audit);
});

test('linked direct revocation captures hostile arguments before inspection', () => {
  const { receipt, audit } = linkedJournal();
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('private');
  };
  denied(() =>
    validateLinkedInvitationRevocation(Object.defineProperty({ ...receipt }, 'resultJson', { enumerable: true, get: hook }), audit),
  );
  denied(() => validateLinkedInvitationRevocation(receipt, new Proxy(audit, { get: hook })));
  denied(() => validateLinkedInvitationRevocation(null as unknown as StoredAdministrationReceipt, audit));
  assert.equal(calls, 0);
});
