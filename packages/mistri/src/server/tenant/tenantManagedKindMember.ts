/**
 * A tenant member's managed transaction: its own tenant's rows, with the owner
 * injected on insert and held on every key. Its evidence carries no `realm`.
 */
import { tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { parseTenantSelector } from './tenantMembership.js';

export const memberManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'tenant',
  keys: Object.freeze([
    'appId',
    'accountId',
    'tenantId',
    'source',
    'deployment',
    'membershipId',
    'membershipVersion',
    'tenantVersion',
    'roles',
    'verifiedAt',
    'validUntil',
  ]),
  tenantOf: (evidence) => parseTenantSelector([evidence.tenantId as string]),
  identify: (evidence) => {
    tenantIdentifier(evidence.accountId, 1024);
    tenantIdentifier(evidence.membershipId, 1024);
  },
  allows: () => true,
});
