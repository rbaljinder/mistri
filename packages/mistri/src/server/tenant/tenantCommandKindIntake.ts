/**
 * Public intake's commands. Placed with a tenant, a submission writes that
 * tenant's rows as a member's command would: it inserts, and updates rows of
 * the tables its command declares under `write` — a routing rule's tally, a
 * counter — inside that tenant's scope and nowhere else. It never removes a
 * row, except a saved form's step, which changes its own draft's rows through
 * the executor's draft fence (forms/savedForms.ts) and nothing else. Triage writes the platform's own rows, as the platform realm
 * does, but reads no tenant's and writes no tenant's column at all: every row
 * it writes is the platform's, and so is every audit row's owner.
 */
import type { CommandAudit } from '../../adapters/commands/commandJournalTypes.js';
import type { TenantCommandKind, TenantCommandPlace } from './tenantCommandKindContract.js';
import type { TenantIntakeEvidence } from './tenantIntakeModel.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';

/** Triage inserts platform rows only, so each audit row's owner is the platform's: ''. */
const platformOwned = (audit: CommandAudit | readonly CommandAudit[]): CommandAudit | readonly CommandAudit[] =>
  Array.isArray(audit)
    ? (audit as readonly CommandAudit[]).map((entry) => ({ ...entry, owner: '' }))
    : { ...(audit as CommandAudit), owner: '' };

const triage = (drafting: boolean) =>
  Object.freeze<TenantCommandPlace>({
    tenantId: undefined,
    writes: (rule) => (rule.kind === 'tenant' ? false : rule.kind === 'platform'),
    readsOwners: true,
    updates: drafting,
    removes: drafting,
    audit: (audit) => platformOwned(audit),
  });

export const intakeCommandKind = Object.freeze<TenantCommandKind<TenantIntakeEvidence>>({
  realm: 'intake',
  place: (principal) =>
    principal.tenantId === PLATFORM_TENANT_ID
      ? triage(principal.drafting === true)
      : Object.freeze<TenantCommandPlace>({
          tenantId: principal.tenantId,
          writes: (rule, column) => (rule.kind === 'tenant' ? column !== rule.column : false),
          readsOwners: false,
          updates: true,
          removes: principal.drafting === true,
          audit: (audit) => audit,
        }),
});
