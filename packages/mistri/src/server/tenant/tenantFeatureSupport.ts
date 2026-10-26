/**
 * Audited support sessions ("enter as dealer") at startup and enrollment. A
 * support policy grants platform-realm roles the right to enter dealers as
 * one of this App's tenant-realm roles; it writes memberships, receipts and
 * an audit chain, so it needs the write opt-in, the administration journal,
 * the support audit store and its key (`MISTRI_AUDIT_KEY`, kept apart
 * from sign-in's secret). Its final native check is synchronous on SQLite,
 * so a SQLite source cannot pair with a PostgreSQL authentication store.
 */
import { appAuthStore } from '../auth/auth.js';
import { isPostgresAuthStore } from '../auth/authStore.js';
import type { AppDef } from '../../shared/app.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import { assertSqliteTenantAdministrationJournal } from './tenantAdministrationJournal.js';
import { assertPostgresTenantAdministrationJournal } from './tenantAdministrationJournalPostgres.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantStartupError } from './tenantStartupError.js';
import { assertSqliteSupportAudit } from './tenantSupportAudit.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from './tenantSupportAuditContract.js';
import { assertPostgresSupportAudit } from './tenantSupportAuditPostgres.js';

/** Platform roles open a session; the dealer roles it may hold are tenant
 * roles. A grant naming anything else could never be used, or would let a
 * platform role act as one inside a dealer. */
function supportCeilingHolds(app: AppDef, policy: AppTenantPolicy): boolean {
  const support = policy.support;
  if (!support) return true;
  const roles = app.auth?.roles ?? {};
  if (!app.auth?.tenancy?.platform) return false;
  return support.grants.every(
    (grant) =>
      Object.hasOwn(roles, grant.platformRole) &&
      roles[grant.platformRole].realm === 'platform' &&
      grant.dealerRoles.every((role) => Object.hasOwn(roles, role) && roles[role].realm !== 'platform'),
  );
}

/** Each refusal names its own stage; tenantFeatures.ts spreads them in this order. */
export const SUPPORT_STARTUP_CHECKS: readonly TenantStartupCheck[] = Object.freeze([
  Object.freeze<TenantStartupCheck>({
    phase: 'policy',
    stage: 'support connection write opt-in (writable: true)',
    run: ({ policy, connection }) => {
      if (policy.support !== undefined && connection.writable !== true) throw new TenantStartupError();
    },
  }),
  Object.freeze<TenantStartupCheck>({
    phase: 'policy',
    stage: "support grants (the platform realm, its platform roles and this App's tenant-realm dealer roles)",
    run: ({ app, policy }) => {
      if (!supportCeilingHolds(app, policy)) throw new TenantStartupError();
    },
  }),
  Object.freeze<TenantStartupCheck>({
    phase: 'policy',
    stage: 'support on a SQLite source with a file-based authentication store',
    run: ({ policy, engine, loaded, environment = process.env }) => {
      if (policy.support !== undefined && engine !== 'postgres' && isPostgresAuthStore(appAuthStore(loaded, environment)))
        throw new TenantStartupError();
    },
  }),
  Object.freeze<TenantStartupCheck>({
    phase: 'policy',
    /* `mistri check` attests the stores as a start does, and the support audit's is attested under its key: a check
       without the key cannot say whether the deployment's key is the one the store was set up with. */
    stage:
      `the support audit key: ${SUPPORT_AUDIT_KEY_VARIABLE} must be a secret of at least 32 bytes, for mistri check as for a start, ` +
      'because both verify the support audit store was set up with it',
    run: ({ policy, environment = process.env }) => {
      if (policy.support === undefined) return;
      try {
        supportAuditKey(environment[SUPPORT_AUDIT_KEY_VARIABLE] ?? '');
      } catch {
        throw new TenantStartupError();
      }
    },
  }),
]);

/** Provisioned before startup, attested here, never created. */
export const supportHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ app, policy }) => {
    if (!supportCeilingHolds(app, policy)) denyTenant();
  },
  sqlite: (db, { policy, binding, supportAuditKey: key }) => {
    if (!policy.support) return;
    assertSqliteTenantAdministrationJournal(db, binding);
    assertSqliteSupportAudit(db, binding, key ?? denyTenant());
  },
  postgres: async (client, { policy, binding, supportAuditKey: key }) => {
    if (!policy.support) return;
    await assertPostgresTenantAdministrationJournal(client, binding);
    await assertPostgresSupportAudit(client, binding, key ?? denyTenant());
  },
});
