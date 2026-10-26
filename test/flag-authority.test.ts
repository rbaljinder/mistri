import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import {
  createFlagAuthority,
  matchFlagCapabilities,
  normalizeFlagAuthorityCatalog,
  normalizeFlagRoleCapabilities,
  requiredFlagCapabilities,
  type FlagAuthorityOptions,
  type FlagMembershipObservation,
  type FlagRoleCapabilities,
} from '../packages/mistri/src/server/flags/authority.js';
import type { FlagAuthorizationRequest } from '../packages/mistri/src/server/flags/management.js';
import { FlagManagementDenied } from '../packages/mistri/src/server/flags/store.js';

const scope = { appId: 'target', environment: 'production', tenantId: null };
const entry = { actions: ['manage'] as const, environments: ['production'], owners: ['product'] };
const catalog = normalizeFlagAuthorityCatalog({
  flags: {
    feature: { type: 'boolean', default: false, owner: 'product', tenantManaged: true },
    other: { type: 'boolean', default: false, owner: 'security' },
    copy: { type: 'string', default: 'a', variants: ['a', 'b'], owner: 'product', tenantManaged: true },
  },
  roles: ['admin', 'manager', 'reader', 'oncall', 'experimenter', 'platform'],
  audiences: {},
  experiments: {
    copy: {
      version: 'v1',
      weights: [
        { value: 'a', weight: 50 },
        { value: 'b', weight: 50 },
      ],
    },
  },
});
const roleInput: Record<string, FlagRoleCapabilities> = {
  admin: {},
  manager: { flags: [entry] },
  reader: { flags: [{ ...entry, actions: ['view'] }] },
  oncall: { flags: [{ ...entry, actions: ['killswitch'] }] },
  experimenter: { experiments: [{ ...entry, actions: ['manage', 'decide'] }] },
  platform: { flags: [entry] },
};
const roles = normalizeFlagRoleCapabilities(roleInput, catalog, false);
const request = (
  operation: FlagAuthorizationRequest['operation'] = 'set',
  flagId = 'feature',
  tenantId: string | null = null,
): FlagAuthorizationRequest => ({
  scope: { ...scope, tenantId },
  flagId,
  operation,
  owner: catalog.flags[flagId].owner,
  requiredCapabilities: requiredFlagCapabilities(catalog, flagId, operation),
});

test('scoped capabilities AND every dimension within one entry; entries and declared roles are alternatives', () => {
  const match = (granted: readonly string[], input = request()) => matchFlagCapabilities(roles, granted, 'app', input);
  assert.ok(match(['manager']));
  for (const input of [
    { ...request(), scope: { ...scope, environment: 'staging' } },
    request('set', 'other'),
    request('view'),
    request('kill'),
    request('set', 'copy'),
  ])
    assert.equal(match(['manager'], input), false);
  assert.ok(match(['manager', 'reader'], request('view')));
  assert.ok(match(['manager', 'experimenter'], request('set', 'copy')));
  assert.ok(match(['manager', 'experimenter'], request('decide', 'copy')));
  assert.equal(match(['experimenter'], request('decide', 'copy')), false);
  for (const granted of [[], ['admin'], ['console'], ['root'], ['manager', 'unknown'], ['manager', 'manager'], [' manager']])
    assert.equal(match(granted), false);
  const split = normalizeFlagRoleCapabilities(
    {
      ...roleInput,
      manager: {
        flags: [
          { ...entry, environments: ['staging'] },
          { ...entry, owners: ['security'] },
        ],
      },
    },
    catalog,
    false,
  );
  assert.equal(matchFlagCapabilities(split, ['manager'], 'app', request()), false, 'cannot combine constraints from different entries');
  const ids = normalizeFlagRoleCapabilities({ ...roleInput, manager: { flags: [{ ...entry, ids: ['feature'] }] } }, catalog, false);
  assert.ok(matchFlagCapabilities(ids, ['manager'], 'app', request()));
  assert.equal(matchFlagCapabilities(ids, ['manager', 'experimenter'], 'app', request('set', 'copy')), false);
  assert.equal(match(['manager'], { ...request(), requiredCapabilities: [] }), false);
  assert.equal(match(['manager'], { ...request(), requiredCapabilities: ['flags.unknown'] as never }), false);
});

test('kill, view, experiment view and experiment decide are independent powers', () => {
  assert.ok(matchFlagCapabilities(roles, ['oncall'], 'app', request('kill', 'copy')));
  for (const operation of ['set', 'revert', 'view', 'experiment-view', 'decide'] as const)
    assert.equal(matchFlagCapabilities(roles, ['oncall'], 'app', request(operation, 'copy')), false);
  assert.equal(matchFlagCapabilities(roles, ['reader'], 'app', request('experiment-view', 'copy')), false);
  const viewer = normalizeFlagRoleCapabilities(
    { ...roleInput, reader: { experiments: [{ ...entry, actions: ['view'] }] } },
    catalog,
    false,
  );
  assert.ok(matchFlagCapabilities(viewer, ['reader'], 'app', request('experiment-view', 'copy')));
  assert.equal(matchFlagCapabilities(viewer, ['reader'], 'app', request('view', 'copy')), false);
  assert.throws(() => requiredFlagCapabilities(catalog, 'feature', 'decide'), FlagManagementDenied);
});

test('closed declarations reject wildcards, unknown/empty lists, malformed roles and scopes without salvaging subsets', () => {
  for (const bad of [
    [],
    [{ ...entry, actions: [] }],
    [{ ...entry, actions: ['manage', 'view', 'unknown'] }],
    [{ ...entry, actions: ['*'] }],
    [{ ...entry, environments: ['*'] }],
    [{ ...entry, owners: [] }],
    [{ ...entry, owners: ['product', 'missing'] }],
    [{ ...entry, ids: [] }],
    [{ ...entry, ids: ['other'] }],
    [{ ...entry, ids: ['missing'] }],
    [{ ...entry, owners: ['product', 'product'] }],
    [{ ...entry, extra: true }],
  ])
    assert.throws(() => normalizeFlagRoleCapabilities({ ...roleInput, manager: { flags: bad } }, catalog, false));
  for (const bad of [
    { ...roleInput, unknown: {} },
    { manager: roleInput.manager },
    { ...roleInput, manager: { realm: 'tenant', flags: [entry] } },
    { ...roleInput, manager: { flags: [entry], read: true } },
  ])
    assert.throws(() => normalizeFlagRoleCapabilities(bad, catalog, false));
  assert.throws(() => normalizeFlagRoleCapabilities(roleInput, catalog, true));
  assert.throws(() =>
    normalizeFlagRoleCapabilities(
      { ...roleInput, reader: { experiments: [{ ...entry, ids: ['feature'], actions: ['view'] }] } },
      catalog,
      false,
    ),
  );
  let hooks = 0;
  assert.throws(() =>
    normalizeFlagRoleCapabilities(
      {
        ...roleInput,
        manager: {
          get flags() {
            hooks++;
            return [entry];
          },
        },
      },
      catalog,
      false,
    ),
  );
  assert.equal(hooks, 0);
  const mutable = { ...roleInput, manager: { flags: [{ ...entry, environments: ['production'] }] } };
  const captured = normalizeFlagRoleCapabilities(mutable, catalog, false);
  mutable.manager.flags[0].environments[0] = 'staging';
  assert.ok(matchFlagCapabilities(captured, ['manager'], 'app', request()));
  assert.ok(Object.isFrozen(captured.manager.flags![0].environments));
});

/** A real private auth owner, with an owned SQLite fixture and signed cookie.
 * No listener or external service is needed for proof provenance tests. */
async function fixture(t: TestContext) {
  const { captureAppAuthRuntime, createAppAuth, createSuiteAppAuth } = await import('../packages/mistri/src/server/auth/auth.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-flag-authority-'));
  const secret = 'flag-authority-owned-test-secret-at-least-thirty-two-characters';
  const auth = await createAppAuth(
    {
      path: join(directory, 'app.ts'),
      dir: directory,
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'target',
          name: 'Target',
          resources: { item: {} },
          auth: { store: 'auth.db', signUp: 'open', roles: { manager: { read: true } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'flag fixture',
      ),
    },
    { baseURL: 'http://localhost:4111', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const db = new DatabaseSync(auth.store),
    binding = captureAppAuthRuntime(auth);
  t.after(() => {
    auth.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date().toISOString(),
    expires = new Date(Date.now() + 60_000).toISOString();
  db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
    'subject',
    'Flag User',
    'flags@example.test',
    1,
    now,
    now,
    'manager',
    0,
  );
  db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
    'session',
    'flag-test-token',
    'subject',
    expires,
    now,
    now,
  );
  const signature = createHmac('sha256', secret).update('flag-test-token').digest('base64');
  const incoming = {
    headers: { cookie: `mistri-target.session_token=${encodeURIComponent(`flag-test-token.${signature}`)}` },
  } as IncomingMessage;
  const proof = await binding.sessionInstance(incoming);
  assert.ok(proof);
  let active = true;
  const options: FlagAuthorityOptions = {
    appId: scope.appId,
    environment: scope.environment,
    catalog,
    roles,
    tenantApp: false,
    auth,
    assertCurrent() {
      if (!active) throw new Error('retired');
    },
  };
  return {
    auth,
    db,
    binding,
    proof,
    incoming,
    options,
    captureAppAuthRuntime,
    createSuiteAppAuth,
    retire() {
      active = false;
    },
  };
}

test('session proof is an opaque handle; native current roles, target binding and deployment guards are reobserved', async (t) => {
  const f = await fixture(t),
    authority = await createFlagAuthority(f.options);
  assert.throws(() => authority.forSession({ ...f.proof }));
  await assert.rejects(createFlagAuthority({ ...f.options, auth: { ...f.auth } }));
  await assert.rejects(createFlagAuthority({ ...f.options, appId: 'console' }));
  const authorize = authority.forSession(f.proof),
    admitted = await authorize(request());
  assert.ok(admitted);
  for (const bad of [
    { ...request(), scope: { ...scope, appId: 'console' } },
    { ...request(), scope: { ...scope, environment: 'staging' } },
    request('set', 'feature', 'tenant'),
    { ...request(), owner: 'security' },
    { ...request(), requiredCapabilities: [] },
    { ...request('set', 'copy'), requiredCapabilities: ['flags.manage'] },
  ])
    await assert.rejects(authorize(bad as FlagAuthorizationRequest));
  for (const value of ['reader', 'admin', 'manager,unknown']) {
    f.db.prepare('UPDATE user SET role=? WHERE id=?').run(value, 'subject');
    await assert.rejects(admitted.reobserve(), FlagManagementDenied);
  }
  f.db.prepare('UPDATE user SET role=? WHERE id=?').run('manager', 'subject');
  await admitted.reobserve();
  f.db.prepare('DELETE FROM session WHERE id=?').run('session');
  await assert.rejects(admitted.reobserve(), FlagManagementDenied);
  f.retire();
  await assert.rejects(authorize(request()));
});

test('Console/root proofs cannot substitute target-App projection; target grant revocation invalidates the handle', async (t) => {
  const f = await fixture(t);
  let revision = 1,
    granted = ['manager'];
  const child = (appId: string) =>
    f.createSuiteAppAuth(f.auth, {
      appId,
      spec: f.auth.spec,
      roles: catalog.roles,
      basePath: `/${appId}`,
      suiteBase: '',
      grant: () => ({ revision, roles: granted }),
    });
  const target = child('target'),
    consoleAuth = child('mistri-console');
  t.after(() => {
    target.close();
    consoleAuth.close();
  });
  const authority = await createFlagAuthority({ ...f.options, auth: target });
  assert.throws(() => authority.forSession(f.proof));
  const consoleProof = await f.captureAppAuthRuntime(consoleAuth).sessionInstance(f.incoming);
  assert.ok(consoleProof);
  assert.throws(() => authority.forSession(consoleProof));
  const targetProof = await f.captureAppAuthRuntime(target).sessionInstance(f.incoming);
  assert.ok(targetProof);
  const proof = await authority.forSession(targetProof)(request());
  assert.ok(proof);
  revision++;
  granted = [];
  await assert.rejects(proof.reobserve(), FlagManagementDenied);
});

test('tenant and platform authority require fresh exact target membership and realm; native roles never fill gaps', async (t) => {
  const f = await fixture(t);
  const tenantRoles = normalizeFlagRoleCapabilities(
    Object.fromEntries(Object.entries(roleInput).map(([id, role]) => [id, { ...role, realm: id === 'platform' ? 'platform' : 'tenant' }])),
    catalog,
    true,
  );
  let current = true;
  let member: FlagMembershipObservation['record'] = {
    appId: 'target',
    accountId: 'subject',
    tenantId: 'one',
    tenantStatus: 'active',
    tenantVersion: '1',
    membershipId: 'membership',
    membershipVersion: '1',
    status: 'active',
    roles: ['manager'],
    validUntil: Date.now() + 60_000,
  };
  let lookups = 0;
  const authority = await createFlagAuthority({
    ...f.options,
    roles: tenantRoles,
    tenantApp: true,
    observeMembership(scope, accountId) {
      assert.equal(scope.appId, 'target');
      assert.equal(accountId, 'subject');
      lookups++;
      return {
        record: member,
        assertCurrent() {
          if (!current) throw new Error('membership revoked');
        },
      };
    },
  });
  const authorize = authority.forSession(f.proof),
    tenant = request('set', 'feature', 'one');
  const proof = await authorize(tenant);
  assert.ok(proof);
  assert.equal(lookups, 1);
  await proof.reobserve();
  assert.equal(lookups, 2);
  await assert.rejects(authorize(request()), FlagManagementDenied);
  await assert.rejects(authorize(request('set', 'feature', 'two')), FlagManagementDenied);
  const original = member;
  for (const bad of [
    { ...original, roles: [] },
    { ...original, roles: ['platform'] },
    { ...original, roles: ['manager', 'unknown'] },
    { ...original, appId: 'console' },
    { ...original, accountId: 'other' },
    { ...original, tenantStatus: 'suspended' },
    { ...original, status: 'revoked' },
    { ...original, validUntil: Date.now() - 1 },
    { ...original, membershipVersion: 1 },
  ]) {
    member = bad as FlagMembershipObservation['record'];
    await assert.rejects(proof.reobserve(), FlagManagementDenied);
  }
  member = original;
  current = false;
  await assert.rejects(proof.reobserve(), FlagManagementDenied);
  current = true;
  member = {
    realm: 'platform',
    appId: 'target',
    accountId: 'subject',
    platformStatus: 'active',
    platformVersion: '1',
    membershipId: 'platform-membership',
    membershipVersion: '1',
    status: 'active',
    roles: ['platform'],
    validUntil: Date.now() + 60_000,
  };
  assert.ok(await authorize(request()));
  await assert.rejects(authorize(tenant), FlagManagementDenied);
});

test('membership owner final fence detects revocation during an asynchronous observation', async (t) => {
  const f = await fixture(t);
  let current = true;
  const tenantRoles = Object.fromEntries(Object.entries(roleInput).map(([id, role]) => [id, { ...role, realm: 'tenant' as const }]));
  const authority = await createFlagAuthority({
    ...f.options,
    roles: tenantRoles,
    tenantApp: true,
    async observeMembership() {
      const result: FlagMembershipObservation = {
        record: {
          appId: 'target',
          accountId: 'subject',
          tenantId: 'one',
          tenantStatus: 'active',
          tenantVersion: '1',
          membershipId: 'membership',
          membershipVersion: '1',
          status: 'active',
          roles: ['manager'],
          validUntil: Date.now() + 60_000,
        },
        assertCurrent() {
          if (!current) throw new Error('revoked');
        },
      };
      queueMicrotask(() => {
        current = false;
      });
      return result;
    },
  });
  await assert.rejects(authority.forSession(f.proof)(request('set', 'feature', 'one')), FlagManagementDenied);
});
