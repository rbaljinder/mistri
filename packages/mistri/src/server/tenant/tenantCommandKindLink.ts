/**
 * A capability link's commands in a tenant App. It writes its tenant's rows as a member's command would — never an
 * owner column, never a platform row — and the writer's scope has already narrowed those to the link's one record.
 */
import type { TenantCommandKind, TenantCommandPlace } from './tenantCommandKindContract.js';
import type { TenantLinkEvidence } from './tenantLinkModel.js';

export const linkCommandKind = Object.freeze<TenantCommandKind<TenantLinkEvidence>>({
  realm: 'link',
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
