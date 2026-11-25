/**
 * Who the person proves to be, and which of this App's tenants they are in: the session check every tenant route makes
 * (enter, bootstrap, contexts), and the discovery `/api/tenant/bootstrap` answers and `/api/tenant/enter` starts from.
 * Apart from tenantHttp.ts because both of its callers there, and the contexts it builds, must read the one rule.
 */
import type { IncomingMessage } from 'node:http';
import { isPromise } from 'node:util/types';
import { captureTenantData, denyTenant, denyTenantFor, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { TENANT_HTTP_HEADERS as headers } from '../../shared/tenantContext.js';
import type { AppDef } from '../../shared/app.js';
import type { VerifiedSessionInstance } from '../auth/auth.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import type { captureTenantEnrollment } from './tenantEnrollment.js';
import type { TenantAddresses } from './tenantIntakeModel.js';
import type { TenantDiscovery } from './tenantRequestParts.js';
import { exposed } from './tenantWire.js';

type Proving = {
  /** The host's session check, as the App was given it. */
  readonly verify: (req: IncomingMessage) => VerifiedSessionInstance | null | Promise<VerifiedSessionInstance | null>;
  /** The account each accepted request was admitted for; a request missing here was never accepted. */
  readonly expectedAccounts: WeakMap<IncomingMessage, string | undefined>;
  /** Refuses once the server is retired. */
  readonly assertActive: () => void;
  readonly now: () => number;
  readonly enrollment: ReturnType<typeof captureTenantEnrollment<IncomingMessage>>['enrollment'];
  readonly app: Pick<AppDef, 'id'>;
};

/**
 * An arrival that may enter a tenant in the same request (`/api/tenant/enter`). `tenant` says which of the tenants
 * discovery's first snapshot found it would enter, if any; that tenant's own addresses are then read in the names'
 * message (tenantEnrollment.ts `marks`) and handed to `addresses`, still on their way: undefined where the read
 * failed. They are the arrival's to release only once it is admitted to that very tenant, where its App payload
 * would have read them.
 */
export interface TenantEntering {
  readonly tenant: (tenantIds: readonly string[]) => string | undefined;
  readonly addresses: (tenantId: string, read: Promise<TenantAddresses | undefined>) => void;
}

export function tenantSessionDiscovery({ verify, expectedAccounts, assertActive, now, enrollment, app }: Proving) {
  const verified = async (req: IncomingMessage): Promise<VerifiedSessionInstance | null> => {
    assertActive();
    const returned = verify(req);
    const value = isPromise(returned)
      ? // A session store that did not answer stays unavailable (503), never a lost context (403).
        ((await Promise.prototype.then.call(returned, captureTenantData, (error: unknown) =>
          denyTenantFor(error),
        )) as VerifiedSessionInstance | null)
      : captureTenantData(returned);
    assertActive();
    if (!expectedAccounts.has(req)) return denyTenant();
    const expected = expectedAccounts.get(req);
    if (value === null) {
      if (expected !== undefined) return denyTenant();
      return null;
    }
    tenantRecord(value, ['identity', 'sessionId', 'expiresAt']);
    tenantRecord(value.identity, ['id', 'who', 'role']);
    exposed(headers.account, value.identity.id);
    tenantIdentifier(value.sessionId, 1024);
    const instant = now();
    assertActive();
    if (
      typeof value.identity.who !== 'string' ||
      (value.identity.role !== undefined && typeof value.identity.role !== 'string') ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= instant
    )
      return denyTenant();
    if (expected !== undefined && expected !== value.identity.id) return denyTenant();
    return value;
  };
  /**
   * The person's tenants, each with what it is called and whether it is a sandbox: `/api/tenant/bootstrap`'s answer,
   * and the first part of `/api/tenant/enter`'s. The session is read before and after discovery and must be the same
   * session throughout, and still live once discovery has answered. `seen` is told the tenants discovery's first
   * snapshot found (tenantBootstrap.ts), to start what it would ask of them next beside the rest.
   */
  const discoverAll = async (
    req: IncomingMessage,
    seen?: (tenantIds: readonly string[]) => void,
    proved?: (proof: VerifiedSessionInstance | null) => void,
    entering?: TenantEntering,
  ): Promise<TenantDiscovery> => {
    const proof = await verified(req);
    proved?.(proof);
    let expiresAt = proof?.expiresAt;
    /* What each tenant is called, and which is a sandbox, asked of the tenants the first snapshot found beside the
       snapshots that confirm them, rather than after: two more round trips before the chooser could draw. Said only
       of the tenants discovery answers with, and asked again where those are not the ones asked. */
    let early: { ids: readonly string[]; marks: Promise<readonly [Readonly<Record<string, string>>, ReadonlySet<string>]> } | undefined;
    const apart = (ids: readonly string[]) =>
      Promise.all([
        enrollment.names(ids).catch((): Readonly<Record<string, string>> => ({}) /* ids only */),
        enrollment.sandboxes(ids),
      ] as const);
    /* The two in one message, with the entered tenant's addresses where the arrival enters one (`marks`): each on a
       snapshot of its own was two to six round trips of every page load. A message is one answer, so one part that
       cannot be read fails them all; each is then asked apart, as it was, and fails or is left out as it always did. */
    const marksOf = (ids: readonly string[], entered?: string) => {
      const read = enrollment.marks(ids, entered);
      if (entered !== undefined)
        entering!.addresses(
          entered,
          read.then(
            (marks) => marks.addresses,
            () => undefined,
          ),
        );
      return read.then(
        (marks) => [marks.names, marks.sandboxes] as const,
        () => apart(ids),
      );
    };
    const discovered = await enrollment.discover(
      req,
      async () => {
        const current = await verified(req);
        if (proof === null || current === null) {
          if (proof !== current) return denyTenant();
        } else {
          if (proof.identity.id !== current.identity.id || proof.sessionId !== current.sessionId) return denyTenant();
          expiresAt = Math.min(expiresAt!, current.expiresAt);
        }
      },
      (ids) => {
        if (ids.length) {
          let entered: string | undefined;
          try {
            entered = entering?.tenant(ids);
          } catch {
            /* The caller's own: the marks are asked as if it had named none. */
          }
          early = { ids, marks: marksOf(ids, entered !== undefined && ids.includes(entered) ? entered : undefined) };
          early.marks.catch(() => {});
        }
        seen?.(ids);
      },
    );
    const instant = now();
    assertActive();
    if (
      proof === null
        ? discovered.status !== 'signed_out'
        : instant >= expiresAt! ||
          discovered.status !== 'ready' ||
          discovered.accountId !== proof.identity.id ||
          discovered.appId !== app.id
    )
      return denyTenant();
    if (discovered.status !== 'ready' || !discovered.memberships.length) return discovered;
    /* Each choice with what the tenant is called, for the chooser and the
       bar: words for a person beside the id the choice still sends. A
       lookup that fails leaves the ids to speak for themselves. */
    const chosen = discovered.memberships.map((member) => member.tenantId);
    /* A sandbox says so to its members wherever its name is said.
       Unlike a name, this is not left out quietly: a sandbox read as live
       is the mistake the mark exists to prevent. */
    const asked =
      early && early.ids.length === chosen.length && early.ids.every((id, at) => id === chosen[at]) ? early.marks : marksOf(chosen);
    const [names, sandboxes] = await asked;
    assertActive();
    return {
      ...discovered,
      memberships: discovered.memberships.map((member) => ({
        ...member,
        ...(Object.hasOwn(names, member.tenantId) ? { name: names[member.tenantId] } : {}),
        ...(sandboxes.has(member.tenantId) ? { sandbox: true as const } : {}),
      })),
    };
  };
  /* On a tenant's own host the person is in that tenant alone: their sign-in there was pinned to it (auth/hostHandoff.ts),
     so the other tenants they belong to, and the platform realm, are not that host's to offer or to open ahead. */
  const discoverFor = async (
    req: IncomingMessage,
    seen?: (tenantIds: readonly string[]) => void,
    proved?: (proof: VerifiedSessionInstance | null) => void,
    entering?: TenantEntering,
  ): Promise<TenantDiscovery> => {
    const intent = getTenantHostIntent(req);
    if (!intent) return discoverAll(req, seen, proved, entering);
    const found = await discoverAll(
      req,
      seen && ((ids) => seen(ids.filter((id) => id === intent.tenant))),
      proved,
      entering && { ...entering, tenant: (ids) => entering.tenant(ids.filter((id) => id === intent.tenant)) },
    );
    if (found.status !== 'ready') return found;
    const { platform: _platform, ...rest } = found;
    return { ...rest, memberships: found.memberships.filter((member) => member.tenantId === intent.tenant) };
  };
  return { verified, discoverAll, discoverFor };
}
