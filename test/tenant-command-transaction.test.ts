/**
 * A command transaction takes where its principal writes from the principal's
 * own `realm` (tenantCommandTransaction.ts). A tenant member's evidence has
 * none and reads as the tenant realm's; a realm no kind answers — a future
 * kind's, a misspelling, a value read through an accessor or a proxy — is
 * refused before anything else runs, never read as a tenant member's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import type { BusinessCommandAuthorization } from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import { runTenantCommandTransaction } from '../packages/mistri/src/server/tenant/tenantCommandTransaction.js';
import type { TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';

/** Nothing here may be reached: each throws the moment it is touched. */
const untouchable = <T extends object>(what: string): T =>
  new Proxy({} as T, {
    get: () => {
      throw new Error(`${what} was reached`);
    },
    has: () => {
      throw new Error(`${what} was reached`);
    },
    ownKeys: () => {
      throw new Error(`${what} was reached`);
    },
  });
const member = {
  appId: 'app',
  accountId: 'alice',
  tenantId: 'north',
  source: { id: 'business', connection: 'db' },
  deployment: 'd',
  membershipId: 'north-alice',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['staff'],
  verifiedAt: 1,
  validUntil: 2,
};

async function refused(principal: object) {
  let ran = false,
    sessions = 0;
  const scope = {
    principal,
    grants: untouchable('the grants'),
    session: async () => {
      sessions++;
    },
  };
  await assert.rejects(
    runTenantCommandTransaction(
      untouchable<TenantOwnershipSnapshot>('the ownership'),
      scope as never,
      untouchable<BusinessCommandAuthorization>('the authorization'),
      untouchable<WriteTransaction>('the transaction'),
      undefined,
      () => [],
      () => {
        ran = true;
      },
    ),
    AppAccessDenied,
  );
  assert.equal(ran, false, 'the handler never runs');
  assert.equal(sessions, 0, 'nothing is revalidated for a principal no kind answers');
}

test("a realm no command kind answers is refused, never read as a tenant member's", async () => {
  for (const realm of ['support', 'Platform', 'tenant ', '', 'constructor', '__proto__']) await refused({ ...member, realm });
  await refused({ ...member, realm: undefined });
  await refused({ ...member, realm: null });
  await refused({ ...member, realm: ['platform'] });
});

test('a realm read through an accessor, a proxy or a prototype is refused without evaluating it', async () => {
  let evaluated = 0;
  await refused(
    Object.defineProperty({ ...member }, 'realm', {
      enumerable: true,
      get: () => {
        evaluated++;
        return 'platform';
      },
    }),
  );
  await refused(Object.create({ realm: 'platform' }, Object.getOwnPropertyDescriptors(member)));
  await refused(new Proxy({ ...member, realm: 'platform' }, {}));
  await refused(new Proxy({ ...member }, {}));
  assert.equal(evaluated, 0);
});
