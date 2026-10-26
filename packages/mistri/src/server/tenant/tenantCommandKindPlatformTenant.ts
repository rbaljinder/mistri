/**
 * A platform command acting in one named tenant. It writes the platform's
 * rows as the platform realm does, and that tenant's rows as a member does:
 * every column but the owner, every key holding the tenant where it names an
 * owner. Each audit row's owner, read from its target row, must be that tenant
 * or the platform, and a command that creates its rows names the tenant on its
 * audit row, so the tenant's own audit reads what the platform did there. The
 * writer's scope already holds no other tenant's row; this is the second,
 * independent statement of the same invariant.
 */
import type { CommandAudit } from '../../adapters/commands/commandJournalTypes.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantCommandKind, TenantCommandPlace } from './tenantCommandKindContract.js';
import type { PlatformTenantEvidence } from './tenantPlatformTenant.js';

export const platformTenantCommandKind = Object.freeze<TenantCommandKind<PlatformTenantEvidence>>({
  realm: 'platform-tenant',
  place: (principal) =>
    Object.freeze<TenantCommandPlace>({
      tenantId: principal.tenantId,
      writes: (rule, column) => (rule.kind === 'tenant' ? column !== rule.column : rule.kind === 'platform'),
      readsOwners: true,
      updates: true,
      removes: true,
      creates: principal.tenantId,
      audit: (audit, stamped) => {
        const rows = stamped(audit);
        const owners = (Array.isArray(rows) ? (rows as readonly CommandAudit[]) : [rows as CommandAudit]).map((entry) => entry.owner);
        if (owners.some((owner) => owner !== '' && owner !== principal.tenantId)) denyTenant();
        return rows;
      },
    }),
});
