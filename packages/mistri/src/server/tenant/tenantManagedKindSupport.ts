/**
 * A support operator's managed transaction ("enter as dealer"): the dealer's
 * own rows, placed and keyed with the dealer the session is inside, exactly as
 * one of that dealer's own members would. What makes it different from a
 * member's is not a narrower set of operations — an operator holding a dealer
 * role does what that role does — but that every operation is recorded in the
 * same transaction (tenantWriteKindSupport.ts).
 *
 * Its evidence carries `realm: 'support'`, so it routes here and never to a
 * member's kind, and a member's evidence never routes here.
 */
import { tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { parseTenantSelector } from './tenantMembership.js';

export const supportManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'support',
  /** SupportMembershipEvidence's exact keys (tenantSupportLease.ts). */
  keys: Object.freeze([
    'realm',
    'appId',
    'accountId',
    'source',
    'deployment',
    'tenantId',
    'supportId',
    'membershipId',
    'membershipVersion',
    'tenantVersion',
    'parentId',
    'parentVersion',
    'platformVersion',
    'roles',
    'verifiedAt',
    'validUntil',
  ]),
  tenantOf: (evidence) => parseTenantSelector([evidence.tenantId as string]),
  identify: (evidence) => {
    tenantIdentifier(evidence.accountId, 1024);
    tenantIdentifier(evidence.membershipId, 1024);
    tenantIdentifier(evidence.supportId, 1024);
    tenantIdentifier(evidence.parentId, 1024);
  },
  allows: () => true,
});
