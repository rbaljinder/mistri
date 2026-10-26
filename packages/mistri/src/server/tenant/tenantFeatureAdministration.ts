/**
 * Tenant administration at startup and enrollment. Its operators write
 * memberships and receipts, so it needs the connection's write opt-in; its
 * journal, which invitations share, is attested in the enrollment snapshot.
 */
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { assertSqliteTenantAdministrationJournal } from './tenantAdministrationJournal.js';
import { assertPostgresTenantAdministrationJournal } from './tenantAdministrationJournalPostgres.js';
import { TenantStartupError } from './tenantStartupError.js';

export const administrationWriteCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  stage: 'administration connection write opt-in (writable: true)',
  run: ({ policy, connection }) => {
    if (policy.administration !== undefined && connection.writable !== true) throw new TenantStartupError();
  },
});

export const administrationJournalHook = Object.freeze<TenantEnrollmentHook>({
  sqlite: (db, { policy, binding }) => {
    if (policy.administration || policy.invitations) assertSqliteTenantAdministrationJournal(db, binding);
  },
  postgres: async (client, { policy, binding }) => {
    if (policy.administration || policy.invitations) await assertPostgresTenantAdministrationJournal(client, binding);
  },
});
