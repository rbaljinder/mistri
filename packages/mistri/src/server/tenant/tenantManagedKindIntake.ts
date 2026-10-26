/**
 * Public intake's managed transaction: no membership, in exactly one place,
 * never a row placed anywhere its anchor does not name. Placed with a tenant
 * it inserts (the owner injected) and updates that tenant's rows its command
 * declares; triage only inserts the platform's own. Neither removes. A saved
 * form's step is the one exception, and only in its place: it updates and
 * removes its own draft's rows, which the executor's draft fence
 * (forms/savedForms.ts) found by the applicant's token and holds it to.
 */
import type { TenantManagedKind } from './tenantManagedKindContract.js';
import { INTAKE_EVIDENCE_KEYS } from './tenantIntakeModel.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';

export const intakeManagedKind = Object.freeze<TenantManagedKind>({
  realm: 'intake',
  keys: INTAKE_EVIDENCE_KEYS,
  // Triage is anchored on the platform: it has no tenant, and writes the platform's rows.
  tenantOf: (evidence) => (evidence.tenantId === PLATFORM_TENANT_ID ? undefined : parseTenantSelector([evidence.tenantId as string])),
  // A public submission has no account and no membership to identify.
  identify: () => {},
  allows: (operation, evidence) =>
    operation === 'insert' || evidence.drafting === true || (operation === 'update' && evidence.tenantId !== PLATFORM_TENANT_ID),
});
