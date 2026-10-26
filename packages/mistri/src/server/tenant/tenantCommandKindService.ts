/**
 * A service principal's commands. A tenant command writes the event's
 * tenant's rows as a member's would. A platform command writes the platform's
 * rows and a tenant's non-owner fields as the platform realm does, but only
 * that one tenant's: every key must name it where the key names an owner, and
 * every audit row's owner, read from its target row, must be it or the
 * platform. The writer's scope already hides every other tenant's row; this
 * is the second, independent statement of the same invariant. The platform's
 * own time job has no tenant: every audit row's owner must be the platform.
 */
import type { CommandAudit } from '../../adapters/commands/commandJournalTypes.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantCommandKind, TenantCommandPlace } from './tenantCommandKindContract.js';
import type { TenantServiceEvidence } from './tenantServiceModel.js';

export const serviceCommandKind = Object.freeze<TenantCommandKind<TenantServiceEvidence>>({
  realm: 'service',
  place: (principal) =>
    principal.place === 'tenant'
      ? Object.freeze<TenantCommandPlace>({
          tenantId: principal.tenantId!,
          writes: (rule, column) => (rule.kind === 'tenant' ? column !== rule.column : false),
          readsOwners: false,
          updates: true,
          removes: true,
          audit: (audit) => audit,
        })
      : principal.place === 'platform'
        ? Object.freeze<TenantCommandPlace>({
            tenantId: principal.tenantId ?? undefined,
            // With no tenant (the platform's own time job) no tenant's column is written, whatever the scope holds.
            writes: (rule, column) =>
              rule.kind === 'tenant' ? principal.tenantId !== null && column !== rule.column : rule.kind === 'platform',
            readsOwners: true,
            updates: true,
            removes: true,
            audit: (audit, stamped) => {
              const rows = stamped(audit);
              const owners = (Array.isArray(rows) ? (rows as readonly CommandAudit[]) : [rows as CommandAudit]).map((entry) => entry.owner);
              if (owners.some((owner) => owner !== '' && owner !== principal.tenantId)) denyTenant();
              return rows;
            },
          })
        : denyTenant(),
});
