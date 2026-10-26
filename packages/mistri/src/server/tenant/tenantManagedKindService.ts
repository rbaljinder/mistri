/**
 * A service principal's managed transaction. In a tenant's realm it is a
 * member's: the event's tenant's rows, with the owner injected on insert and
 * held on every key. In the platform realm it is the platform's: its own rows,
 * and a tenant's updated by the row's key, never an owner set; the writer's
 * scope keeps even those to the event's tenant.
 */
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { parseTenantSelector } from './tenantMembership.js';
import { SERVICE_EVIDENCE_KEYS, SERVICE_PRINCIPAL } from './tenantServiceModel.js';

export const serviceManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'service',
  keys: SERVICE_EVIDENCE_KEYS,
  // The platform realm has no tenant of its own to place rows with.
  tenantOf: (evidence) =>
    evidence.place === 'tenant'
      ? parseTenantSelector([evidence.tenantId as string])
      : evidence.place === 'platform'
        ? undefined
        : denyTenant(),
  // No account and no membership: the principal is the jobs module's name.
  identify: (evidence) => {
    if (typeof evidence.principal !== 'string' || !SERVICE_PRINCIPAL.test(evidence.principal)) denyTenant();
  },
  allows: () => true,
});
