/**
 * A capability link's managed transaction: its tenant's rows, held to that tenant on every key. It updates or
 * removes the one record it names and never inserts, as a link in an App without tenants cannot create.
 */
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { parseTenantSelector } from './tenantMembership.js';
import { LINK_EVIDENCE_KEYS } from './tenantLinkModel.js';

export const linkManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'link',
  keys: LINK_EVIDENCE_KEYS,
  tenantOf: (evidence) => parseTenantSelector([evidence.tenantId as string]),
  // No account and no membership: the link's id, checked with its evidence, is the principal.
  identify: () => {},
  allows: (operation) => operation === 'update' || operation === 'remove',
});
