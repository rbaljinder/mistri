/**
 * openTenant: createTenant then issueInvitation under one request key, from the platform App's own screen. Its own module
 * beside tenantAdministration.ts, which hands it the pieces it needs (the journaled `run`, the sessions' read of a
 * tenant, the invitation owner) and is where it is answered at the door.
 */
import type { IncomingMessage } from 'node:http';
import { captureTenantData, denyTenant, tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import {
  OPEN_TENANT_KEY_CONFLICT,
  type AdministrationOpenTenantAttempt,
  type AdministrationOpenTenantResult,
  type AdministrationOwner,
} from '../../shared/tenantAdministration.js';
import type { AdministrationRequest, TenantAdministration } from './tenantAdministration.js';
import { exact } from './tenantAdministrationImages.js';
import { openingFingerprint } from './tenantAdministrationModel.js';
import { TenantInvitationFailure, type TenantInvitations } from './tenantInvitationOperations.js';
import type { TenantStoreBinding } from './tenantStore.js';

/** A reused opening key whose input differs. Nothing is applied; the door answers 409 naming the key. */
export class TenantOpenKeyConflict extends Error {
  readonly code = OPEN_TENANT_KEY_CONFLICT;
  constructor(readonly key: string) {
    super(`The key ${JSON.stringify(key)} already opened a tenant with a different input.`);
    this.name = 'TenantOpenKeyConflict';
  }
}
/** An opening's key claim, committed in createTenant's own transaction so the two never part. */
export interface OpeningClaim {
  readonly key: string;
  readonly fingerprint: string;
  readonly resultJson: string;
}

interface OpeningOptions {
  readonly owner: TenantStoreBinding;
  readonly invitations: TenantInvitations | undefined;
  readonly clock: () => number;
  /** The journaled administration operation, executing, with the opening's claim beside its receipt. */
  readonly run: (
    request: IncomingMessage,
    input: AdministrationRequest,
    claim: OpeningClaim,
  ) => Promise<{
    readonly replayed: boolean;
    readonly change: { readonly after: { readonly tenant: { readonly version: string } } };
  } | null>;
  /** The tenant's version now, read under the opener's own session. */
  readonly tenantVersion: (request: IncomingMessage, input: AdministrationOwner, tenantId: string) => Promise<string>;
  readonly fail: (outcome: 'not_applied' | 'unknown') => Error;
}

/* createTenant, then issueInvitation, each through its own owner and policy as when called alone. Their keys
   derive from the opening's, and the opening's key is claimed in createTenant's transaction with a fingerprint
   of the whole input: a retry finds both receipts or the first, and finishes; another input is refused. */
export function createTenantOpening(options: OpeningOptions): TenantAdministration['openTenant'] {
  const { owner, invitations, clock, run, tenantVersion, fail } = options;
  /* An opening's issuer session, one per administration context, reused while it lasts so a retry opens none. */
  const openingIssuers = new Map<string, { accountId: string; context: string; expiresAt: number }>();
  return async (request, input) => {
    let opening: AdministrationOpenTenantAttempt & AdministrationOwner, fingerprint: string;
    try {
      opening = captureTenantData(input);
      exact(opening, ['expectedAccount', 'context', 'key', 'profile', 'tenant', 'invitation']);
      tenantIdentifier(opening.expectedAccount, 1024);
      tenantIdentifier(opening.context);
      // Room for the step suffixes under the journal's 256 bytes.
      tenantIdentifier(opening.key, 200);
      tenantIdentifier(opening.profile, 1024);
      exact(opening.tenant, ['tenantId']);
      tenantIdentifier(opening.tenant.tenantId, 128);
      const asked = opening.invitation as Record<string, unknown>;
      exact(asked, ['roles', 'redeemUntil', 'validUntil'], ['accountId', 'email']);
      if (Object.hasOwn(asked, 'accountId') === Object.hasOwn(asked, 'email') || !Array.isArray(asked.roles)) return denyTenant();
      if (!invitations) return denyTenant();
      fingerprint = openingFingerprint(owner, opening);
    } catch {
      throw fail('not_applied');
    }
    const { expectedAccount, context, key } = opening;
    const tenantId = opening.tenant.tenantId;
    const created = (await run(
      request,
      { expectedAccount, context, idempotencyKey: `${key}:tenant`, intent: { operation: 'createTenant', tenantId } },
      { key, fingerprint, resultJson: JSON.stringify({ tenantId, profile: opening.profile }) },
    ))!;
    try {
      /* A replayed createTenant answers with the version it created; the tenant may have changed since (a retry after a
         reload), and the invitation is pinned to the version it is in now, not to the one it began as. */
      const version = created.replayed
        ? await tenantVersion(request, { expectedAccount, context }, tenantId)
        : created.change.after.tenant.version;
      const now = clock();
      for (const [held, entry] of openingIssuers) if (entry.expiresAt <= now) openingIssuers.delete(held);
      let issuer = openingIssuers.get(context);
      if (!issuer || issuer.accountId !== expectedAccount) {
        const session = (await invitations!.openIssuer(request, { expectedAccount })) ?? denyTenant();
        issuer = { accountId: session.accountId, context: session.context, expiresAt: session.expiresAt };
        openingIssuers.set(context, issuer);
      }
      const reply = await invitations!
        .execute(request, {
          expectedAccount,
          context: issuer.context,
          idempotencyKey: `${key}:invitation`,
          intent: { operation: 'issueInvitation', tenantId, expectedTenantVersion: version, ...opening.invitation },
        })
        .catch((error: unknown) => {
          // A session the invitation owner no longer holds is not reused by the retry.
          openingIssuers.delete(context);
          throw error;
        });
      return captureTenantData({
        tenantId,
        version,
        invitation: reply.token === undefined ? { result: reply.result } : { result: reply.result, token: reply.token },
      }) as AdministrationOpenTenantResult;
    } catch (error) {
      throw fail(error instanceof TenantInvitationFailure ? error.outcome : 'not_applied');
    }
  };
}
