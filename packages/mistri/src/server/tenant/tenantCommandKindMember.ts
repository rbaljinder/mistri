/**
 * A tenant member's commands: its own tenant's rows, every field but the
 * managed owner, and audit rows as the handler's journal gives them, since
 * every row it can reach is its own tenant's.
 */
import type { TenantCommandKind, TenantCommandPlace } from './tenantCommandKindContract.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';

export const memberCommandKind = Object.freeze<TenantCommandKind<TenantMembershipEvidence>>({
  realm: 'tenant',
  place: (principal) =>
    Object.freeze<TenantCommandPlace>({
      tenantId: principal.tenantId,
      writes: (rule, column) => (rule.kind === 'tenant' ? column !== rule.column : false),
      readsOwners: false,
      updates: true,
      removes: true,
      audit: (audit) => audit,
    }),
});
