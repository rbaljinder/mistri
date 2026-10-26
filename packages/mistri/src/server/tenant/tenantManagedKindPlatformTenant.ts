/**
 * A platform command's managed transaction in one named tenant: the platform
 * realm's own rows, as a platform command writes them, and that tenant's rows,
 * placed with its owner and held to it on every key, as a member's are. The
 * tenant is the evidence's, which the runtime read from the request's input
 * and the writer fenced; the handler never names it.
 */
import { tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_EVIDENCE_KEYS } from './tenantPlatformTenant.js';

export const platformTenantManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'platform-tenant',
  keys: PLATFORM_TENANT_EVIDENCE_KEYS,
  tenantOf: (evidence) => parseTenantSelector([evidence.tenantId as string]),
  identify: (evidence) => {
    tenantIdentifier(evidence.accountId, 1024);
    tenantIdentifier(evidence.membershipId, 1024);
  },
  allows: () => true,
  platformRows: true,
});
