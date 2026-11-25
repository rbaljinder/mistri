/**
 * Entering a tenant in the request that asks whose tenants there are (`POST /api/tenant/enter`,
 * shared/tenantBoot.ts): discovery, and where the person is entered without being asked, the lease. The page's boot
 * on that lease is the boot's own branch (tenantHttp.ts), which this hands the lease to.
 *
 * Nothing here is a new proof: each step is the function its own route runs, in the order the page asked them, and
 * each refuses what that route refuses. Apart from tenantHttp.ts for its length alone.
 */
import type { IncomingMessage } from 'node:http';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { enteredTenant, type tenantEnterRequest } from '../../shared/tenantBoot.js';
import type { TenantContextAssertion, TenantContextReply } from '../../shared/tenantContext.js';
import type { VerifiedSessionInstance } from '../auth/auth.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import type { tenantSessionDiscovery } from './tenantDiscovery.js';
import type { TenantAddresses } from './tenantIntakeModel.js';
import type { TenantDiscovery } from './tenantRequestParts.js';

/** The entered tenant's own addresses, read in discovery's names message (tenantDiscovery.ts `TenantEntering`). */
export type AddressesAhead = { tenantId: string; read: Promise<TenantAddresses | undefined> };

interface TenantEntered {
  readonly found: TenantDiscovery;
  readonly whoami?: Record<string, unknown>;
  /** The tenant entered and the lease in it; neither where the answer is discovery's alone. */
  readonly sole?: string;
  readonly lease?: TenantContextReply;
  readonly addresses?: AddressesAhead;
}

export async function enterTenant(given: {
  readonly req: IncomingMessage;
  readonly asked: NonNullable<ReturnType<typeof tenantEnterRequest>>;
  readonly contexts: {
    resume(req: IncomingMessage, selectors: readonly string[], input: { tabId: string }): Promise<TenantContextReply>;
    open(req: IncomingMessage, selectors: readonly string[], input: Record<string, never>): Promise<TenantContextReply>;
    release(req: IncomingMessage, input: TenantContextAssertion): Promise<unknown>;
  };
  readonly discoverFor: ReturnType<typeof tenantSessionDiscovery>['discoverFor'];
  /** Who-am-I for the session discovery proved, as its own route says it; undefined where the host says none. */
  readonly whoami: (proof: VerifiedSessionInstance | null) => Promise<Record<string, unknown> | undefined>;
  readonly assertActive: () => void;
  /** Whether the request has gone (aborted, or its response destroyed). */
  readonly gone: () => boolean;
}): Promise<TenantEntered> {
  const { req, asked, contexts, discoverFor, assertActive } = given;
  /* A lease in `tenantId`, in the page's own order (client tenantBrowser.ts `contextFor`): this tab's kept
     context resumed where it is that tenant's, else a new one. A refusal is no lease: the page then asks to
     open one itself, and hears why in that route's words. */
  const leaseIn = async (tenantId: string): Promise<TenantContextReply | undefined> => {
    if (asked.kept?.tenantId === tenantId) {
      try {
        return await contexts.resume(req, [tenantId], { tabId: asked.kept.tabId });
      } catch {
        /* Gone, expired, or held by another page: a new one. */
      }
    }
    return contexts.open(req, [tenantId], {}).catch(() => undefined);
  };
  /* A lease the answer will not carry is let go at once, as a page leaving lets its own go. */
  const letGo = async (pending: Promise<TenantContextReply | undefined> | undefined) => {
    const lease = await pending;
    if (lease)
      await contexts.release(req, { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision }).catch(() => {});
  };
  /* The tenant the page has reason to expect — the link's, the one this tab kept, or else the one discovery's
     first snapshot finds — is opened beside the rest of discovery rather than after it: opening is its own
     admission, exactly what the page could ask of `/open` for any tenant without asking discovery first, and
     nothing of the tenant is read before discovery has answered that it is the person's one. Where it is not,
     the lease is let go unseen. */
  const named = asked.tenant ?? asked.kept?.tenantId;
  const onHost = getTenantHostIntent(req);
  const hint = onHost && named !== onHost.tenant ? undefined : named;
  let ahead = hint === undefined ? undefined : { tenantId: hint, lease: leaseIn(hint) };
  let found: TenantDiscovery;
  /* Who-am-I, said as its own route says it (tenantAuthenticatedHttp.ts `whoamiAnswer`): the page's first
     request is this one, and holds back every other until it knows whose session it is. A signed-out
     request is answered as who-am-I answers it, and the page draws the sign-in it always drew. */
  let who: Record<string, unknown> | undefined;
  let proof: VerifiedSessionInstance | null | undefined;
  /* The addresses of the tenant being entered, asked in the message that names the person's tenants rather than
     by the App payload on a snapshot of its own. Which tenant is the rule `ahead` follows: the one the page
     expects, else the only one found; and only ever one of the person's own, which discovery's first snapshot
     just read. Nothing of them is said until the boot is admitted to that tenant on its lease. */
  let addressesAhead: AddressesAhead | undefined;
  try {
    /* Named nowhere, the tenant is the one discovery's first snapshot finds, where it finds one. */
    found = await discoverFor(
      req,
      (ids) => {
        if (ahead === undefined && ids.length === 1) ahead = { tenantId: ids[0]!, lease: leaseIn(ids[0]!) };
      },
      (proved) => {
        proof = proved;
      },
      {
        tenant: (ids) => hint ?? (ids.length === 1 ? ids[0] : undefined),
        addresses: (tenantId, read) => {
          addressesAhead = { tenantId, read };
        },
      },
    );
    /* The session discovery proved is the one who-am-I says, not another look at the store. */
    who = proof === undefined ? undefined : await given.whoami(proof);
  } catch (error) {
    await letGo(ahead?.lease);
    throw error;
  }
  const sole =
    found.status === 'ready'
      ? enteredTenant(
          (found.memberships ?? []).map((member) => member.tenantId),
          found.platform === true,
          { named: asked.tenant, kept: asked.kept?.tenantId },
        )
      : undefined;
  if (ahead && ahead.tenantId !== sole) await letGo(ahead.lease);
  const lease = sole === undefined ? undefined : ahead?.tenantId === sole ? await ahead.lease : await leaseIn(sole);
  assertActive();
  if (lease && (lease.tenantId !== sole || lease.realm !== undefined || given.gone())) {
    await letGo(Promise.resolve(lease));
    return denyTenant();
  }
  const held: AddressesAhead | undefined = addressesAhead;
  return {
    found,
    ...(who ? { whoami: who } : {}),
    ...(lease ? { sole: sole!, lease } : {}),
    ...(lease && held?.tenantId === sole ? { addresses: held } : {}),
  };
}

/**
 * A reload's entry (`reenter`): the tab's kept context taken back (tenantContexts.ts `reclaim`), with no discovery
 * and no admission of its own, for the page's boot on it to be read at once. Undefined where it cannot be — signed
 * out, another account or session, a tab this host no longer holds (a restart, a deploy), one another page took
 * back, one past its grace — and the request is then entered as any other.
 *
 * What it trusts is the lease, as every request on a lease does, and no more: the boot that follows is admitted on
 * it as `/api/boot` is, its snapshot fencing the lease's evidence (membership and tenant versions, roles) against
 * the store before any read, and the caller sends nothing of it, and lets the context go, where that refuses. A
 * member removed, whose roles changed or whose tenant was suspended is refused there, as their next request on the
 * lease would be; signed out, the session check here refuses first.
 */
export async function reenterTenant(given: {
  readonly req: IncomingMessage;
  readonly asked: NonNullable<ReturnType<typeof tenantEnterRequest>>;
  readonly contexts: {
    reclaim(req: IncomingMessage, selectors: readonly string[], input: { tabId: string }): Promise<TenantContextReply>;
    release(req: IncomingMessage, input: TenantContextAssertion): Promise<unknown>;
  };
  /** The session check every tenant route makes (tenantDiscovery.ts `verified`). */
  readonly verified: (req: IncomingMessage) => Promise<VerifiedSessionInstance | null>;
  readonly whoami: (proof: VerifiedSessionInstance | null) => Promise<Record<string, unknown> | undefined>;
  readonly assertActive: () => void;
}): Promise<{ readonly accountId: string; readonly lease: TenantContextReply; readonly whoami?: Record<string, unknown> } | undefined> {
  const { req, asked, contexts } = given;
  const kept = asked.kept;
  if (!asked.reenter || !kept) return undefined;
  const onHost = getTenantHostIntent(req);
  if (onHost && onHost.tenant !== kept.tenantId) return undefined;
  const proof = await given.verified(req);
  if (!proof) return undefined;
  let lease: TenantContextReply;
  try {
    lease = await contexts.reclaim(req, [kept.tenantId], { tabId: kept.tabId });
  } catch {
    return undefined;
  }
  try {
    given.assertActive();
    if (
      lease.tenantId !== kept.tenantId ||
      lease.tabId !== kept.tabId ||
      lease.realm !== undefined ||
      lease.accountId !== proof.identity.id
    )
      return denyTenant();
    const who = await given.whoami(proof);
    return { accountId: proof.identity.id, lease, ...(who ? { whoami: who } : {}) };
  } catch (error) {
    await letGoOf(req, contexts, lease);
    throw error;
  }
}

/** A context taken back that the answer will not carry, let go again, as its page let it go. */
export async function letGoOf(
  req: IncomingMessage,
  contexts: { release(req: IncomingMessage, input: TenantContextAssertion): Promise<unknown> },
  lease: TenantContextReply,
): Promise<void> {
  await contexts.release(req, { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision }).catch(() => {});
}
