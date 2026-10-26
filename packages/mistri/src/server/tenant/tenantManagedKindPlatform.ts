/**
 * The platform realm's managed transaction: the same lifetime and queue over
 * its own rows and a tenant's. It inserts and removes only platform rows,
 * updates a tenant's by the row's own key, and never sets an owner: placing a
 * new row with a tenant is not the platform realm's to do. It has no tenant of
 * its own to place rows with or hold keys to. Without a command — a staff
 * member's Save, New or Delete — it writes its own rows alone.
 */
import { tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { PLATFORM_EVIDENCE_KEYS } from './tenantPlatform.js';

export const platformManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'platform',
  keys: PLATFORM_EVIDENCE_KEYS,
  tenantOf: () => undefined,
  identify: (evidence) => {
    tenantIdentifier(evidence.accountId, 1024);
    tenantIdentifier(evidence.membershipId, 1024);
  },
  allows: () => true,
  uncommanded: 'platform-rows',
});
