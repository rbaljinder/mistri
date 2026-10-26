/**
 * The lease a session's requests carry once a tenant is chosen, as the
 * client's session identity holds it (client sessionIdentity.ts): who it is
 * for, and the platform realm's reserved id that its shape is checked
 * against when it is adopted. Below the kit because the kit's session
 * identity checks it; the tenancy that issues one, and the headers a
 * request asserts it by, are the App framework's (tenantContext.ts, which
 * says these again for its own readers).
 */
export interface TenantContextOwner {
  readonly tabId: string;
  readonly context: string;
  readonly appId: string;
  readonly accountId: string;
  /** The selected tenant. In the platform realm it is the reserved
      `@platform`, which no `?tenant=` selector can name. */
  readonly tenantId: string;
  /** Present only for a lease in the platform realm, which reads across
      tenants, or for a support session's lease inside one dealer (its
      `tenantId`), which may read that dealer's rows — every read ledgered —
      and writes nothing; a tenant's lease carries no realm. */
  readonly realm?: 'platform' | 'support';
  /** The support session this lease is inside. Present only under
      `realm: 'support'`, and only the id the caller opened the session with:
      it names the row each ledgered read is recorded against. */
  readonly supportId?: string;
}
export interface TenantContextReply extends TenantContextOwner {
  readonly revision: number;
  readonly expiresAt: number;
}
/** The platform realm's reserved context id. It fails every tenant selector,
 * so only `?realm=platform` reaches it. */
export const PLATFORM_TENANT_ID = '@platform';
