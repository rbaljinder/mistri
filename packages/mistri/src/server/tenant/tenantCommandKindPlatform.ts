/**
 * The platform realm's commands. The scope spans tenants: a platform row's
 * fields are writable and an owner never is, and each audit row the journal
 * commits names its target's owner as this transaction read it from the row.
 */
import type { TenantCommandKind, TenantCommandPlace } from './tenantCommandKindContract.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';

export const platformCommandKind = Object.freeze<TenantCommandKind<PlatformMembershipEvidence>>({
  realm: 'platform',
  place: () =>
    Object.freeze<TenantCommandPlace>({
      tenantId: undefined,
      writes: (rule, column) => (rule.kind === 'tenant' ? column !== rule.column : rule.kind === 'platform'),
      readsOwners: true,
      updates: true,
      removes: true,
      audit: (audit, stamped) => stamped(audit),
    }),
});
