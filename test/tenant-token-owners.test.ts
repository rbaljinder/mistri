import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import type { AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { createTenantTokenService, TenantTokenRefusal } from '../packages/mistri/src/server/tenant/tenantTokenService.js';
import { SESSION_SECRET } from './appApiCli.js';

/* A member's API token is listed and ended by that member and by the tenant's
   administrator — whoever the administration policy lets end memberships —
   never by another member merely because their roles cover it. */

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tenant-token-owners-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const appDir = join(directory, 'depot'),
    authStore = join(directory, 'auth.db'),
    business = join(directory, 'business.db');
  new DatabaseSync(business).close();
  mkdirSync(appDir);
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'depot',
      name: 'Depot',
      auth: { providers: ['email'], store: authStore, rows: 'tenant', roles: { member: { read: true }, lead: { read: true } } },
      sources: { business: { connection: 'data' } },
      resources: { item: { physical: 'physical_item', owner: 'tenant' } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['member', 'lead'], resources: { item: { fields: ['id', 'name'], sorts: ['id'] } } },
    }),
  );
  const loaded = await loadApp(appDir);
  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  try {
    const auth = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
    t.after(() => auth.close());
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  }
  const native = new DatabaseSync(authStore);
  for (const id of ['alice', 'carol', 'dave'])
    native
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
  native.close();
  provisionSqliteApiTokenStore(authStore, { appId: 'depot', storeId: randomUUID(), exclusions: [captureAuthStoreExclusion(business)] });
  const catalog = { operations: [{ id: 'list:item', eligibleRoles: ['member', 'lead'] }] };
  const member = (accountId: string, roles: string[]): TenantMembershipEvidence =>
    ({
      appId: 'depot',
      accountId,
      tenantId: 'north',
      source: { id: 'business', connection: 'data' },
      deployment: 'd1',
      membershipId: `m-${accountId}`,
      membershipVersion: '1',
      tenantVersion: '1',
      roles,
      verifiedAt: 0,
      validUntil: Number.MAX_SAFE_INTEGER,
    }) as TenantMembershipEvidence;
  const alice = member('alice', ['member']),
    carol = member('carol', ['member', 'lead']),
    dave = member('dave', ['member', 'lead']);
  const service = (administration?: AdministrationPolicy) =>
    createTenantTokenService({ loaded, catalog, ...(administration ? { administration } : {}) });
  const plain = service();
  const aliceToken = await plain.issue(alice, { label: 'Alice reads', roles: ['member'] });
  const carolToken = await plain.issue(carol, { label: 'Carol reads', roles: ['member'] });
  return { service, alice, carol, dave, aliceToken, carolToken };
}

const ids = (tokens: { id: string }[]) => tokens.map((token) => token.id).sort();
const notFound = (error: unknown) => error instanceof TenantTokenRefusal && error.status === 404;

test("a member sees and ends only their own tokens, even where their roles cover another's", async (t) => {
  const { service, alice, carol, aliceToken, carolToken } = await fixture(t);
  const tokens = service();
  assert.deepEqual(ids(await tokens.list(alice)), [aliceToken.id]);
  assert.deepEqual(ids(await tokens.list(carol)), [carolToken.id]);
  await assert.rejects(tokens.revoke(carol, aliceToken.id), notFound);
  await assert.rejects(tokens.revoke(alice, carolToken.id), notFound);
  assert.equal((await tokens.list(alice))[0].revokedAt, null);
  await tokens.revoke(alice, aliceToken.id);
  assert.notEqual((await tokens.list(alice))[0].revokedAt, null);
});

test("the tenant's administrator sees and ends a member's token; the member still cannot end theirs", async (t) => {
  const { service, alice, carol, dave, aliceToken, carolToken } = await fixture(t);
  // carol administers by delegate rule; dave holds the same roles as a named operator elsewhere only.
  const tokens = service({
    id: 'depot-admin',
    version: 'v1',
    maxMembershipLifetimeMs: 600_000,
    operators: [{ accountId: 'dave', tenants: ['south'], operations: ['revokeMembership'], roles: [] }],
    delegates: [{ role: 'lead', operations: ['revokeMembership'], roles: ['member'] }],
  });
  assert.deepEqual(ids(await tokens.list(carol)), [aliceToken.id, carolToken.id].sort());
  assert.deepEqual(ids(await tokens.list(alice)), [aliceToken.id]);
  await assert.rejects(tokens.revoke(alice, carolToken.id), notFound);
  await tokens.revoke(carol, aliceToken.id);
  assert.notEqual((await tokens.list(alice))[0].revokedAt, null);

  // The same rule by name: an operator of this tenant administers it; of another, does not.
  const named = service({
    id: 'depot-admin',
    version: 'v1',
    maxMembershipLifetimeMs: 600_000,
    operators: [{ accountId: 'dave', tenants: ['north'], operations: ['revokeMembership'], roles: [] }],
  });
  assert.deepEqual(ids(await named.list(dave)), [aliceToken.id, carolToken.id].sort());
  assert.deepEqual(ids(await tokens.list(dave)), [aliceToken.id, carolToken.id].sort()); // dave is also a lead
  const withoutLead = { ...dave, roles: ['member'] } as TenantMembershipEvidence;
  assert.deepEqual(ids(await tokens.list(withoutLead)), []);
});
