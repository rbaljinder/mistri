/**
 * Account-bound invitations at startup and enrollment: the write opt-in they
 * share with administration, the engine pairing their final verifier needs,
 * and the preprovisioned linked storage enrollment attests.
 */
import { isPostgresAuthStore } from '../auth/authStore.js';
import { appAuthStore } from '../auth/auth.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { assertLinkedTenantInvitations } from './tenantInvitationLinks.js';
import { assertLinkedPostgresTenantInvitations } from './tenantInvitationLinksPostgres.js';
import { TenantStartupError } from './tenantStartupError.js';

// Issuance and acceptance write memberships and receipts, as administration does.
export const invitationWriteCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  stage: 'invitation connection write opt-in (writable: true)',
  run: ({ policy, connection }) => {
    if (policy.invitations !== undefined && connection.writable !== true) throw new TenantStartupError();
  },
});

// A SQLite source's final invitation verifier is synchronous; a postgres://
// auth store can only be read asynchronously, so the pair is refused.
export const invitationAuthStoreCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  stage: 'invitations on a SQLite source with a file-based authentication store',
  run: ({ policy, engine, loaded }) => {
    if (policy.invitations !== undefined && engine !== 'postgres' && isPostgresAuthStore(appAuthStore(loaded)))
      throw new TenantStartupError();
  },
});

export const invitationLinksHook = Object.freeze<TenantEnrollmentHook>({
  sqlite: (db, { policy, binding }) => {
    if (policy.invitations) assertLinkedTenantInvitations(db, binding);
  },
  postgres: async (client, { policy, binding }) => {
    if (policy.invitations) await assertLinkedPostgresTenantInvitations(client, binding);
  },
});
