/**
 * A tenant's request context: what a request asserts and the headers it
 * asserts it by, and the lease it was granted (whose own shape is below the
 * kit, which holds it in the session's identity: sessionLease.ts).
 */
import type { TenantContextReply } from '@mistriwork/engine/shared/sessionLease.js';
export { PLATFORM_TENANT_ID, type TenantContextReply } from '@mistriwork/engine/shared/sessionLease.js';

/** Browser-safe assertions and verified response ownership. None is a bearer
 * credential; session and membership evidence never belong in these DTOs. */
export interface TenantContextAssertion {
  readonly tabId: string;
  readonly expectedContext: string;
  readonly expectedRevision: number;
}
export type TenantContextRecovery = TenantContextReply | Readonly<{ tabId: string; status: 'inactive' }>;
/** One spelling for request assertions and verified response ownership. These
 * headers are preconditions, never authentication or membership credentials. */
export const TENANT_HTTP_HEADERS = Object.freeze({
  app: 'x-mistri-app',
  account: 'x-mistri-account',
  tenant: 'x-mistri-tenant',
  tab: 'x-mistri-tab',
  context: 'x-mistri-context',
  revision: 'x-mistri-lease-revision',
  realm: 'x-mistri-realm',
});
