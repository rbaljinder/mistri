import { randomUUID } from 'node:crypto';
import { isPromise, isProxy } from 'node:util/types';
import type { TenantContextAssertion, TenantContextRecovery, TenantContextReply } from '../../shared/tenantContext.js';
import type { VerifiedSessionInstance } from '../auth/auth.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { captureTenantCommandExecution, type TenantCommandExecutionOptions } from './tenantCommands.js';
import {
  bindPlatformDeploymentContext,
  bindTenantDeploymentContext,
  captureTenantDeployment,
  type TenantDeployment,
} from './tenantDeployment.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  recordRefusalCause,
  TenantContextError,
  TenantRequestFault,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import { PLATFORM_TENANT_ID, type PlatformMembershipEvidence } from './tenantPlatform.js';
import type { PlatformReadContext } from './tenantPlatformReadRuntime.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { TenantWriteFailure } from './tenantWriteSource.js';
import { refusedFields } from './tenantWriteKindContract.js';
import { narrowTenantInvocation, tenantInvocationAdmittedAgain, tenantInvocationGuard } from './tenantInvocation.js';
import {
  isSupportEvidence,
  markSupportRefusal,
  TenantSupportActive,
  TenantSupportUnavailable,
  type SupportAdmission,
  type SupportMembershipEvidence,
  type SupportTarget,
} from './tenantSupportLease.js';
import type { SupportReadContext } from './tenantSupportReadRuntime.js';
import { requireFreshAdmission } from './tenantAdmissionCache.js';
import { tenantAnswerProvenByCommit, tenantAnswerProvenByFence } from './tenantRequestRuntime.js';

interface TenantContextsOptions<Request> {
  readonly deployment: TenantDeployment<Request>;
  readonly verifySessionInstance: (request: Request) => VerifiedSessionInstance | null | Promise<VerifiedSessionInstance | null>;
  /** The support owner's fence. Without it no support lease can be opened. */
  readonly support?: SupportAdmission<Request>;
  readonly now?: () => number;
  readonly maxContexts?: number;
  readonly maxLifetimeMs?: number;
  /** Retain authority identity, not usable access, for sleeping/offline tabs. */
  readonly maxDormantMs?: number;
  /** How long a context its page let go waits for that tab's next page (RELEASE_GRACE). */
  readonly releaseGraceMs?: number;
}
/** Private host result; HTTP keeps its existing body and echoes verified owner
 * headers rather than exposing another universal transport envelope. */
interface TenantContextResult<T> {
  readonly context: TenantContextReply;
  readonly value: T;
}
/* Availability is a command family as prepare is, with prepare's options and failure classes; it is named apart
   only because it acts on nothing, so a fenced answer needs no second admission (below). */
type Family = 'read' | 'preview' | 'write' | 'availability' | 'prepare' | 'execute' | 'status';
const commandFamily = (family: Family): boolean =>
  family === 'availability' || family === 'prepare' || family === 'execute' || family === 'status';
/** A tab holds one lease: a tenant's, the platform realm's, or a support
 * session's inside one dealer. A support lease reads that dealer's rows through
 * its own read family, every read ledgered before a body is released; it acts
 * on nothing, so every other family refuses it with TenantSupportUnavailable,
 * and it never switches, renews or nests; its owner opens, resumes and ends it. */
type Principal = TenantMembershipEvidence | PlatformMembershipEvidence | SupportMembershipEvidence;
type Target = { readonly realm: 'tenant'; readonly selectors: readonly string[] } | { readonly realm: 'platform' } | SupportTarget;
interface Lease {
  readonly token: string;
  readonly realm: 'tenant' | 'platform' | 'support';
  readonly principal: Principal;
  window: LeaseWindow;
  receipt?: { readonly expectedRevision: number; readonly window: LeaseWindow };
  active: boolean;
  readonly pending: Set<Promise<void>>;
}
interface LeaseWindow {
  readonly revision: number;
  readonly expiresAt: number;
}
interface Tab {
  readonly id: string;
  readonly accountId: string;
  readonly sessionId: string;
  sessionExpiresAt: number;
  expiresAt: number;
  lease?: Lease;
  switching?: Promise<void>;
  /** Let go by its page (pagehide): kept only RELEASE_GRACE, for the same tab's next page to resume. */
  released?: boolean;
}
/* How long a released context waits for its tab's next page: a reload, or a
   link followed in the same tab, resumes it rather than opening another. */
const RELEASE_GRACE = 15_000;
const MOST_RELEASE_GRACE = 60_000;
type LeaseCode = 'tenant_lease_stale' | 'tenant_lease_expired';
export class TenantLeaseError extends TenantContextError {
  constructor(override readonly code: LeaseCode) {
    super();
    this.name = 'TenantLeaseError';
    this.message = 'The selected tenant lease must be renewed before continuing.';
  }
}
/**
 * Every one of an account's contexts is in use, a request in flight on each,
 * so none could be let go for a new page. Its own code and sentence, not the
 * opaque denial: it says nothing about the caller's authority, only that the
 * account is busy, and the operator hears it (tenantHttp.ts reports it).
 */
export class TenantContextsBusy extends TenantContextError {
  override readonly code: string = 'too_many_contexts';
  constructor() {
    super();
    this.name = 'TenantContextsBusy';
    this.message = 'Every tenant context this account holds is busy. Finish or close another tab, then try again.';
  }
}
const leaseFailures = new WeakMap<Error, LeaseCode>();
/** Preserve the operation family's outcome/class while exposing only a safe
 * lease category. Never infer it from a provider's arbitrary error properties. */
export function tenantLeaseFailureCode(error: unknown): LeaseCode | undefined {
  return error instanceof TenantLeaseError ? error.code : error instanceof Error ? leaseFailures.get(error) : undefined;
}
function token(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) denyTenant();
}
const platformEvidence = (value: Principal): value is PlatformMembershipEvidence =>
  (value as PlatformMembershipEvidence).realm === 'platform';
const supportEvidence = (value: Principal): value is SupportMembershipEvidence => (value as SupportMembershipEvidence).realm === 'support';
/** The same admission, in the same realm: evidence of two realms never matches. */
function same(a: Principal, b: Principal): boolean {
  const common =
    a.appId === b.appId &&
    a.accountId === b.accountId &&
    a.source.id === b.source.id &&
    a.source.connection === b.source.connection &&
    a.deployment === b.deployment &&
    a.membershipId === b.membershipId &&
    a.membershipVersion === b.membershipVersion &&
    a.roles.length === b.roles.length &&
    a.roles.every((role) => b.roles.includes(role));
  if (supportEvidence(a) || supportEvidence(b)) {
    return (
      supportEvidence(a) &&
      supportEvidence(b) &&
      common &&
      a.tenantId === b.tenantId &&
      a.supportId === b.supportId &&
      a.tenantVersion === b.tenantVersion &&
      a.parentId === b.parentId &&
      a.parentVersion === b.parentVersion &&
      a.platformVersion === b.platformVersion &&
      a.validUntil === b.validUntil
    );
  }
  if (platformEvidence(a) || platformEvidence(b)) {
    return platformEvidence(a) && platformEvidence(b) && common && a.platformVersion === b.platformVersion;
  }
  return common && a.tenantId === b.tenantId && a.tenantVersion === b.tenantVersion;
}
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  return isPromise(value)
    ? (Promise.prototype.then.call(
        value,
        (value: T) => captureTenantData(value),
        () => denyTenant(),
      ) as Promise<T>)
    : captureTenantData(value);
}
function assertion(input: TenantContextAssertion): TenantContextAssertion {
  const value = captureTenantData(input);
  tenantRecord(value, ['tabId', 'expectedContext', 'expectedRevision']);
  token(value.tabId);
  token(value.expectedContext);
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) return denyTenant();
  return value;
}
/** Capture a target before any wait: a tenant by its one canonical selector, or the platform realm. */
function captureTarget(target: Target): Target {
  if (target.realm === 'platform') return { realm: 'platform' };
  if (target.realm === 'support') {
    const value = captureTenantData(target);
    tenantRecord(value, ['realm', 'tenantId', 'supportId']);
    tenantIdentifier(value.supportId, 1024);
    return { realm: 'support', tenantId: parseTenantSelector([value.tenantId as string]), supportId: value.supportId };
  }
  const selectors = captureTenantData(target.selectors);
  parseTenantSelector(selectors);
  return { realm: 'tenant', selectors };
}
/** The tenant a lease names: its own, the dealer a support session is inside,
 * or the platform realm's reserved `@platform`. */
const tenantOf = (lease: Lease): string =>
  lease.realm === 'platform' ? PLATFORM_TENANT_ID : (lease.principal as TenantMembershipEvidence | SupportMembershipEvidence).tenantId;
const targetOf = (lease: Lease): Target =>
  lease.realm === 'platform'
    ? { realm: 'platform' }
    : lease.realm === 'support'
      ? {
          realm: 'support',
          tenantId: (lease.principal as SupportMembershipEvidence).tenantId,
          supportId: (lease.principal as SupportMembershipEvidence).supportId,
        }
      : { realm: 'tenant', selectors: [(lease.principal as TenantMembershipEvidence).tenantId] };

/** Private per-tab admission, not a tenant cookie or another deployment owner.
 * Switching retires one lease and drains whole operations; other tabs and the
 * shared source pair stay live. Authentication remains independently verified.
 * A tab's lease is a tenant's or the platform realm's; switching between the
 * two is a switch like any other, and a platform lease only reads: the
 * platform realm writes through its commands, never generic Save or Undo. */
export function createTenantContexts<Request>(options: TenantContextsOptions<Request>) {
  const raw = tenantOptions(options, [
    'deployment',
    'verifySessionInstance',
    'support',
    'now',
    'maxContexts',
    'maxLifetimeMs',
    'maxDormantMs',
    'releaseGraceMs',
  ]);
  const deployment = captureTenantDeployment(raw.deployment as TenantDeployment<Request>);
  if (
    typeof raw.verifySessionInstance !== 'function' ||
    isProxy(raw.verifySessionInstance) ||
    (raw.now !== undefined && (typeof raw.now !== 'function' || isProxy(raw.now)))
  )
    return denyTenant();
  const verify = raw.verifySessionInstance as TenantContextsOptions<Request>['verifySessionInstance'];
  let supportAdmit: SupportAdmission<Request>['admit'] | undefined;
  let supportHolds: SupportAdmission<Request>['holds'] | undefined;
  if (raw.support !== undefined) {
    const owner = tenantOptions(raw.support, ['admit', 'holds']);
    const admit = owner.admit,
      holds = owner.holds;
    if (typeof admit !== 'function' || isProxy(admit) || typeof holds !== 'function' || isProxy(holds)) return denyTenant();
    supportAdmit = admit as SupportAdmission<Request>['admit'];
    supportHolds = holds as SupportAdmission<Request>['holds'];
  }
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const maximum = raw.maxContexts ?? 1024,
    lifetime = raw.maxLifetimeMs ?? 300_000,
    dormant = raw.maxDormantMs ?? 1_800_000;
  const grace = raw.releaseGraceMs ?? RELEASE_GRACE;
  if (typeof grace !== 'number' || !Number.isSafeInteger(grace) || grace < 0 || grace > MOST_RELEASE_GRACE) return denyTenant();
  if (
    typeof maximum !== 'number' ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 1024 ||
    typeof lifetime !== 'number' ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 300_000 ||
    typeof dormant !== 'number' ||
    !Number.isSafeInteger(dormant) ||
    dormant < 0 ||
    dormant > 1_800_000
  )
    return denyTenant();
  const tabs = new Map<string, Tab>(),
    pending = new Set<Promise<void>>();
  // Bound one account's share of the default deployment tab budget; a lower
  // global ceiling still wins. Sessions and tenant/platform realms share it.
  // At the bound the account's oldest idle context makes way (open, below).
  const accountMaximum = Math.min(32, maximum),
    accountOpenings = new Map<string, number>();
  let retired = false,
    opening = 0,
    retirement: Promise<void> | undefined;
  const active = () => {
    if (retired) denyTenant();
  };
  const clock = () => {
    active();
    const value = now();
    active();
    return value;
  };
  const tracked = <T>(run: () => Promise<T>): Promise<T> => {
    try {
      active();
    } catch {
      return Promise.reject(new TenantWriteFailure('not_applied'));
    }
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    const result = (async () => {
      try {
        return await run();
      } finally {
        pending.delete(held);
        finish();
      }
    })();
    void result.catch(() => {});
    return result;
  };
  const control = <T>(run: () => Promise<T>): Promise<T> =>
    tracked(run).catch((error) => {
      if (error instanceof TenantLeaseError || error instanceof TenantSupportUnavailable || error instanceof TenantContextsBusy)
        throw error;
      return denyTenant();
    });
  /** A request naming this tab's support lease, by its own tab and context. */
  const onSupport = (tab: Tab | undefined, expectedContext: string) =>
    tab?.lease?.realm === 'support' && tab.lease.token === expectedContext;
  const session = async (request: Request): Promise<VerifiedSessionInstance> => {
    clock();
    const returned = delivered(verify(request)),
      value = isPromise(returned) ? await returned : returned;
    const instant = clock();
    tenantRecord(value, ['identity', 'sessionId', 'expiresAt']);
    tenantRecord(value.identity, ['id', 'who', 'role']);
    tenantIdentifier(value.identity.id, 1024);
    tenantIdentifier(value.sessionId, 1024);
    if (
      typeof value.identity.who !== 'string' ||
      (value.identity.role !== undefined && typeof value.identity.role !== 'string') ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= instant
    )
      return denyTenant();
    return value as unknown as VerifiedSessionInstance;
  };
  const belongs = (tab: Tab, proof: VerifiedSessionInstance) => {
    if (tab.accountId !== proof.identity.id || tab.sessionId !== proof.sessionId) denyTenant();
    tab.sessionExpiresAt = Math.min(tab.sessionExpiresAt, proof.expiresAt);
  };
  const generation = (tab: Tab, lease: Lease, principal?: Principal) => {
    const instant = clock();
    if (
      !lease.active ||
      tab.lease !== lease ||
      tab.switching ||
      instant >= tab.sessionExpiresAt ||
      /* A context its page let go serves that page's last requests, and nothing after its grace. */
      (tab.released && instant >= tab.expiresAt) ||
      (principal && (!same(lease.principal, principal) || principal.validUntil <= instant))
    )
      return denyTenant();
    return instant;
  };
  const live = (tab: Tab, lease: Lease, window = lease.window, principal?: Principal) => {
    if (generation(tab, lease, principal) >= window.expiresAt) throw new TenantLeaseError('tenant_lease_expired');
  };
  const retained = (tab: Tab, lease: Lease) => {
    if (generation(tab, lease) >= tab.expiresAt) return denyTenant();
  };
  const retainUntil = (tab: Tab, window: LeaseWindow) =>
    Math.min(Number.MAX_SAFE_INTEGER, window.expiresAt + dormant, tab.sessionExpiresAt);
  const reply = (tab: Tab, lease: Lease, window = lease.window): TenantContextReply =>
    captureTenantData({
      tabId: tab.id,
      context: lease.token,
      appId: lease.principal.appId,
      accountId: tab.accountId,
      tenantId: tenantOf(lease),
      ...(lease.realm === 'tenant' ? {} : { realm: lease.realm }),
      ...(lease.realm === 'support' ? { supportId: (lease.principal as SupportMembershipEvidence).supportId } : {}),
      ...window,
    });
  const candidate = async (request: Request, target: Target, initial?: { started: number; proof: VerifiedSessionInstance }) => {
    // The window set here is bounded by the evidence: never evidence kept from an earlier request.
    const admitted = requireFreshAdmission(request);
    try {
      return await admittedCandidate(request, target, initial);
    } finally {
      admitted();
    }
  };
  const admittedCandidate = async (request: Request, target: Target, initial?: { started: number; proof: VerifiedSessionInstance }) => {
    const started = initial?.started ?? clock();
    if (started > Number.MAX_SAFE_INTEGER - lifetime) return denyTenant();
    const proof = initial?.proof ?? (await session(request));
    let sessionExpiry = proof.expiresAt;
    if (target.realm === 'support') {
      // The support owner's fence, twice around a final session check, as a
      // tenant's issuer is: only evidence it minted, for this account.
      if (!supportAdmit) return denyTenant();
      const first = await supportAdmit(request, target);
      if (!isSupportEvidence(first) || first.accountId !== proof.identity.id || clock() >= started + lifetime) return denyTenant();
      const finalSession = await session(request);
      if (finalSession.identity.id !== proof.identity.id || finalSession.sessionId !== proof.sessionId) return denyTenant();
      const principal = await supportAdmit(request, target);
      if (!isSupportEvidence(principal) || !same(first, principal)) return denyTenant();
      const instant = clock(),
        expiresAt = Math.min(started + lifetime, principal.validUntil, sessionExpiry, finalSession.expiresAt);
      if (instant < principal.verifiedAt || instant >= expiresAt) return denyTenant();
      return {
        proof: finalSession,
        principal: principal as Principal,
        expiresAt,
        sessionExpiresAt: Math.min(sessionExpiry, finalSession.expiresAt),
      };
    }
    const guard = tenantInvocationGuard<Principal>(
      (member) => {
        if (clock() >= started + lifetime || member.accountId !== proof.identity.id) denyTenant();
      },
      async () => {
        const current = await session(request);
        if (current.identity.id !== proof.identity.id || current.sessionId !== proof.sessionId) return denyTenant();
        sessionExpiry = Math.min(sessionExpiry, current.expiresAt);
      },
    );
    // Admission in the target's own realm: a tenant's issuer, or the platform's.
    const admit = (narrowed: typeof guard): Promise<Principal> =>
      target.realm === 'platform'
        ? deployment.withPlatformContext(request, (context) => context.principal, narrowed)
        : deployment.withContext(request, target.selectors, (context) => context.principal, narrowed);
    // Compared with the second admission's only, and released by none: that admission's snapshot is its fence.
    const first = await admit(tenantInvocationAdmittedAgain(guard));
    const finalSession = await session(request);
    if (finalSession.identity.id !== proof.identity.id || finalSession.sessionId !== proof.sessionId) return denyTenant();
    const principal = await admit(
      narrowTenantInvocation<Principal>(guard, (member) => {
        if (!same(first, member)) denyTenant();
      }),
    );
    const instant = clock(),
      expiresAt = Math.min(started + lifetime, first.validUntil, principal.validUntil, sessionExpiry, finalSession.expiresAt);
    if (instant < principal.verifiedAt || instant >= expiresAt) return denyTenant();
    return { proof: finalSession, principal, expiresAt, sessionExpiresAt: Math.min(sessionExpiry, finalSession.expiresAt) };
  };
  const leaseFor = (value: Awaited<ReturnType<typeof candidate>>, realm: Lease['realm']): Lease => ({
    token: randomUUID(),
    realm,
    principal: value.principal,
    window: Object.freeze({ expiresAt: value.expiresAt, revision: 1 }),
    active: true,
    pending: new Set(),
  });
  /** A context nothing is using: no request in flight on its lease, no switch
   * under way. A support lease is its owner's to end, never evicted. */
  const evictable = (tab: Tab) => !tab.switching && !tab.lease?.pending.size && tab.lease?.realm !== 'support';
  const oldestIdle = (accountId: string): Tab | undefined => {
    let oldest: Tab | undefined;
    // The map keeps insertion order: the first idle one is the oldest.
    for (const tab of tabs.values()) {
      if (tab.accountId !== accountId || !evictable(tab)) continue;
      if (tab.released) return tab;
      oldest ??= tab;
    }
    return oldest;
  };
  const prune = () => {
    const instant = clock();
    for (const [id, tab] of tabs) {
      if (instant < Math.min(tab.expiresAt, tab.sessionExpiresAt) || tab.switching) continue;
      if (tab.lease) tab.lease.active = false;
      if (!tab.lease?.pending.size) tabs.delete(id);
    }
  };
  const execute = <T, A>(
    family: Family,
    request: Request,
    inputSelectors: readonly string[],
    inputAssertion: TenantContextAssertion,
    input: A,
    run: (
      bound: ReturnType<typeof bindTenantDeploymentContext<Request>>,
      selectors: readonly string[],
      captured: A,
      options: TenantCommandExecutionOptions | undefined,
      lease: TenantContextReply,
    ) => Promise<T>,
    options?: TenantCommandExecutionOptions,
  ): Promise<TenantContextResult<T>> => {
    let completed = false,
      invalidInput = false,
      leaseProblem: LeaseCode | undefined,
      commandOptions: ReturnType<typeof captureTenantCommandExecution> | undefined;
    return tracked(async () => {
      let captured: A;
      try {
        captured = captureTenantData(input);
        if (commandFamily(family)) commandOptions = captureTenantCommandExecution(options ?? {});
      } catch (error) {
        invalidInput = true;
        throw error;
      }
      const selectors = captureTenantData(inputSelectors),
        selected = parseTenantSelector(selectors),
        expected = assertion(inputAssertion);
      const tab = tabs.get(expected.tabId),
        lease = tab?.lease;
      // A support session reads its dealer's rows through its own read family,
      // which runs on the support owner's evidence and whose caller ledgers the
      // read before releasing a body. Everything that acts — Save, New, Delete,
      // Undo, a command — is refused here. The trail itself is built and proven
      // (tenantWriteKindSupport.ts); what is missing is this door, not the
      // record, so refusing is the only honest answer while nothing carries
      // support evidence into a write. A read never reaches this shared body: the transport
      // routes one by the lease's realm, because only it can ledger the read
      // once the body is in hand. One arriving here would be a read nothing
      // ledgered, so it is refused rather than quietly served.
      if (onSupport(tab, expected.expectedContext)) throw new TenantSupportUnavailable();
      // A tenant operation runs only on a tenant's lease; a platform lease reads through its own owner.
      if (!tab || !lease || lease.realm !== 'tenant' || expected.expectedContext !== lease.token || selected !== tenantOf(lease))
        return denyTenant();
      // Capture before authentication yields. A later renewal neither grants
      // this request a later deadline nor invalidates its admitted revision.
      const window = lease.window,
        matchingRevision = expected.expectedRevision === window.revision;
      const current = (principal?: TenantMembershipEvidence) => {
        try {
          live(tab, lease, window, principal);
        } catch (error) {
          leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
          throw error;
        }
      };
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      lease.pending.add(held);
      try {
        const proof = await session(request);
        belongs(tab, proof);
        generation(tab, lease);
        if (!matchingRevision) throw new TenantLeaseError('tenant_lease_stale');
        current();
        if (proof.expiresAt < window.expiresAt) return denyTenant();
        const guard = tenantInvocationGuard(
          (member) => current(member),
          async (member) => {
            const verified = await session(request);
            belongs(tab, verified);
            current(member);
            if (verified.expiresAt < window.expiresAt) return denyTenant();
          },
        );
        const bound = bindTenantDeploymentContext(deployment, guard);
        const returned = await run(bound, selectors, captured, commandOptions?.options, reply(tab, lease, window));
        completed = true;
        const value = captureTenantData(returned);
        const released = await session(request);
        belongs(tab, released);
        current();
        if (released.expiresAt < window.expiresAt) return denyTenant();
        // Fresh member evidence after final authentication, without allowing a
        // changed membership to reinterpret this already selected generation.
        // A read has it already: its runtime's release fence ran this lease's
        // own guard (this session, the generation, `same` evidence) and then
        // observed the membership in a fresh snapshot, after its last read.
        // Admitting again would only repeat both. Everything that acts is
        // fenced again here.
        // A committed write's answer is not: its transaction held the membership from BEGIN to COMMIT (tenantRequestRuntime.ts).
        // Nor is availability's, which acts on nothing: it is advice read in one snapshot, and its runtime's release
        // fence ran this lease's guard and observed the membership after it, as a read's does. Asking again was
        // a second admitted context and a third membership snapshot on every record page.
        if (family !== 'read' && !tenantAnswerProvenByCommit(request) && !(family === 'availability' && tenantAnswerProvenByFence(request)))
          await bound.withContext(request, selectors, () => undefined);
        current();
        return captureTenantData({ context: reply(tab, lease, window), value });
      } finally {
        lease.pending.delete(held);
        finish();
      }
    })
      .catch((error) => {
        leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
        // Refused before anything ran: never an unknown outcome.
        const supported = error instanceof TenantSupportUnavailable;
        const tagged = <T extends Error>(failure: T): T => {
          if (leaseProblem) leaseFailures.set(failure, leaseProblem);
          if (supported) markSupportRefusal(failure, error as TenantSupportUnavailable);
          return failure;
        };
        if (commandFamily(family)) {
          if (error instanceof BusinessCommandExecutionError) throw tagged(error);
          throw tagged(
            recordRefusalCause(
              new BusinessCommandExecutionError(
                invalidInput ? 'invalid_input' : 'forbidden',
                family !== 'prepare' && family !== 'availability' && !supported ? 'unknown' : 'not_applied',
              ),
              error,
            ),
          );
        }
        if (family === 'write' || family === 'preview') {
          const outcome =
            (completed && family === 'write') || (error instanceof TenantWriteFailure && error.outcome === 'unknown')
              ? 'unknown'
              : 'not_applied';
          /* The App's rules refusing the record travel on, by field name and fixed sentence (tenantWriteFailed):
             without them the transport could only answer a person's fixable draft as a denial. */
          throw tagged(
            recordRefusalCause(new TenantWriteFailure(outcome, outcome === 'not_applied' ? refusedFields(error) : undefined), error),
          );
        }
        if (supported) throw error;
        if (leaseProblem) throw new TenantLeaseError(leaseProblem);
        // The request's own fault, with the context revalidated (tenantReadRuntime.ts): the lease stands.
        if (error instanceof TenantRequestFault) throw error;
        /* Classified, not flattened: a database that could not answer stays
         unavailable (a 503 the browser retries), where a flat denial told it
         the tenant context was gone. The reason stays for the operator. */
        return denyTenantFor(error);
      })
      .finally(() => commandOptions?.close());
  };
  /** The platform lease's one family: a read, with the same revision, lifetime,
   * session bracketing and fresh final evidence as a tenant's read. */
  const readPlatform = <T>(
    request: Request,
    inputAssertion: TenantContextAssertion,
    run: (context: PlatformReadContext, lease: TenantContextReply) => T | Promise<T>,
  ): Promise<TenantContextResult<T>> => {
    let leaseProblem: LeaseCode | undefined;
    return tracked(async () => {
      const expected = assertion(inputAssertion);
      const tab = tabs.get(expected.tabId),
        lease = tab?.lease;
      if (onSupport(tab, expected.expectedContext)) throw new TenantSupportUnavailable();
      if (!tab || !lease || lease.realm !== 'platform' || expected.expectedContext !== lease.token) return denyTenant();
      const window = lease.window,
        matchingRevision = expected.expectedRevision === window.revision;
      const current = (principal?: PlatformMembershipEvidence) => {
        try {
          live(tab, lease, window, principal);
        } catch (error) {
          leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
          throw error;
        }
      };
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      lease.pending.add(held);
      try {
        const proof = await session(request);
        belongs(tab, proof);
        generation(tab, lease);
        if (!matchingRevision) throw new TenantLeaseError('tenant_lease_stale');
        current();
        if (proof.expiresAt < window.expiresAt) return denyTenant();
        const guard = tenantInvocationGuard<PlatformMembershipEvidence>(
          (member) => current(member),
          async (member) => {
            const verified = await session(request);
            belongs(tab, verified);
            current(member);
            if (verified.expiresAt < window.expiresAt) return denyTenant();
          },
        );
        const value = captureTenantData(
          await deployment.withPlatformContext(request, (context) => run(context, reply(tab, lease, window)), guard),
        );
        const released = await session(request);
        belongs(tab, released);
        current();
        if (released.expiresAt < window.expiresAt) return denyTenant();
        // Nothing more is asked of the source: the runtime's release fence ran
        // this lease's own guard (this session, the generation, `same`
        // evidence) and then observed the membership in a fresh snapshot,
        // after its last read, as a tenant's read does. Observing it once more
        // in a snapshot of its own would only repeat both.
        current();
        return captureTenantData({ context: reply(tab, lease, window), value });
      } finally {
        lease.pending.delete(held);
        finish();
      }
    }).catch((error) => {
      if (error instanceof TenantSupportUnavailable) throw error;
      leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
      if (leaseProblem) throw new TenantLeaseError(leaseProblem);
      return denyTenant();
    });
  };
  /** A support session's one family: a read inside the dealer it entered, with
   * the same revision, lifetime, session bracketing and fresh final evidence as
   * a tenant's read. It runs on the support owner's own evidence, which this
   * family never mints — the fence that admitted the session is the support row
   * itself. The session may look; nothing here acts, and the caller ledgers the
   * read before it releases a body. */
  const readSupport = <T>(
    request: Request,
    inputSelectors: readonly string[],
    inputAssertion: TenantContextAssertion,
    run: (context: SupportReadContext) => T | Promise<T>,
  ): Promise<TenantContextResult<T>> => {
    let leaseProblem: LeaseCode | undefined;
    return tracked(async () => {
      const selectors = captureTenantData(inputSelectors),
        selected = parseTenantSelector(selectors);
      const expected = assertion(inputAssertion);
      const tab = tabs.get(expected.tabId),
        lease = tab?.lease;
      // The named dealer must be the one this session entered: a support lease
      // reads that tenant's rows and no other's.
      if (!tab || !lease || lease.realm !== 'support' || expected.expectedContext !== lease.token || selected !== tenantOf(lease))
        return denyTenant();
      const principal = lease.principal as SupportMembershipEvidence;
      const window = lease.window,
        matchingRevision = expected.expectedRevision === window.revision;
      const current = (member?: SupportMembershipEvidence) => {
        try {
          live(tab, lease, window, member);
        } catch (error) {
          leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
          throw error;
        }
      };
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      lease.pending.add(held);
      try {
        const proof = await session(request);
        belongs(tab, proof);
        generation(tab, lease);
        if (!matchingRevision) throw new TenantLeaseError('tenant_lease_stale');
        current();
        if (proof.expiresAt < window.expiresAt) return denyTenant();
        const guard = tenantInvocationGuard<SupportMembershipEvidence>(
          (member) => current(member),
          async (member) => {
            const verified = await session(request);
            belongs(tab, verified);
            current(member);
            if (verified.expiresAt < window.expiresAt) return denyTenant();
          },
        );
        const value = captureTenantData(await deployment.withSupportContext(request, principal, run, guard));
        const released = await session(request);
        belongs(tab, released);
        current();
        if (released.expiresAt < window.expiresAt) return denyTenant();
        await deployment.withSupportContext(request, principal, () => undefined, guard);
        current();
        return captureTenantData({ context: reply(tab, lease, window), value });
      } finally {
        lease.pending.delete(held);
        finish();
      }
    }).catch((error) => {
      leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
      if (leaseProblem) throw new TenantLeaseError(leaseProblem);
      return denyTenant();
    });
  };
  /** A command or a generic edit on this tab's platform lease: a read's
   * revision, lifetime and session bracketing, with a command's option capture
   * and failure classes, or a write's as a tenant's are. */
  const commandPlatform = <T>(
    family: 'availability' | 'prepare' | 'execute' | 'status' | 'write' | 'preview',
    request: Request,
    inputAssertion: TenantContextAssertion,
    input: unknown,
    run: (
      bound: ReturnType<typeof bindPlatformDeploymentContext<Request>>,
      captured: unknown,
      options?: TenantCommandExecutionOptions,
    ) => Promise<T>,
    options?: TenantCommandExecutionOptions,
  ): Promise<TenantContextResult<T>> => {
    const editing = family === 'write' || family === 'preview';
    let leaseProblem: LeaseCode | undefined,
      invalidInput = false,
      completed = false,
      commandOptions: ReturnType<typeof captureTenantCommandExecution> | undefined;
    return tracked(async () => {
      let captured: unknown;
      try {
        captured = captureTenantData(input);
        if (!editing) commandOptions = captureTenantCommandExecution(options ?? {});
      } catch (error) {
        invalidInput = true;
        throw error;
      }
      const expected = assertion(inputAssertion);
      const tab = tabs.get(expected.tabId),
        lease = tab?.lease;
      // Platform commands and edits never run under support, not even later.
      if (onSupport(tab, expected.expectedContext)) throw new TenantSupportUnavailable();
      if (!tab || !lease || lease.realm !== 'platform' || expected.expectedContext !== lease.token) return denyTenant();
      const window = lease.window,
        matchingRevision = expected.expectedRevision === window.revision;
      const current = (principal?: PlatformMembershipEvidence) => {
        try {
          live(tab, lease, window, principal);
        } catch (error) {
          leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
          throw error;
        }
      };
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      lease.pending.add(held);
      try {
        const proof = await session(request);
        belongs(tab, proof);
        generation(tab, lease);
        if (!matchingRevision) throw new TenantLeaseError('tenant_lease_stale');
        current();
        if (proof.expiresAt < window.expiresAt) return denyTenant();
        // The tab check above is not enough: a live support session anywhere on
        // this account refuses the platform realm's commands, so an operator
        // inside a dealer cannot act as the platform in another tab at the same
        // time. The owner's answer fails closed, and it is asked only once a
        // genuine platform lease and login have been proved, so an unauthorized
        // caller never reaches its transaction.
        // A generic edit is held the same way: it acts as the platform too.
        // Availability is not asked: it acts on nothing, and the command it
        // advises on meets this refusal when it runs. The answer is a writer
        // transaction of its own, which put forty-odd statements and the one
        // writer in front of every record a lender opened.
        if (family !== 'availability' && supportHolds && (await supportHolds(request))) throw new TenantSupportActive();
        current();
        const guard = tenantInvocationGuard<PlatformMembershipEvidence>(
          (member) => current(member),
          async (member) => {
            const verified = await session(request);
            belongs(tab, verified);
            current(member);
            if (verified.expiresAt < window.expiresAt) return denyTenant();
          },
        );
        const bound = bindPlatformDeploymentContext(deployment, guard);
        const value = captureTenantData(await run(bound, captured, commandOptions?.options));
        completed = true;
        const released = await session(request);
        belongs(tab, released);
        current();
        if (released.expiresAt < window.expiresAt) return denyTenant();
        await bound.withContext(request, () => undefined);
        current();
        return captureTenantData({ context: reply(tab, lease, window), value });
      } finally {
        lease.pending.delete(held);
        finish();
      }
    })
      .catch((error) => {
        leaseProblem = tenantLeaseFailureCode(error) ?? leaseProblem;
        const supported = error instanceof TenantSupportUnavailable;
        if (editing) {
          // A write's classes, as a tenant's write says them (execute above).
          const outcome =
            (completed && family === 'write') || (error instanceof TenantWriteFailure && error.outcome === 'unknown')
              ? 'unknown'
              : 'not_applied';
          const refused = recordRefusalCause(
            new TenantWriteFailure(outcome, outcome === 'not_applied' ? refusedFields(error) : undefined),
            error,
          );
          if (leaseProblem) leaseFailures.set(refused, leaseProblem);
          if (supported) markSupportRefusal(refused, error as TenantSupportUnavailable);
          throw refused;
        }
        const failure =
          error instanceof BusinessCommandExecutionError
            ? error
            : new BusinessCommandExecutionError(
                invalidInput ? 'invalid_input' : 'forbidden',
                family !== 'prepare' && family !== 'availability' && !supported ? 'unknown' : 'not_applied',
              );
        if (leaseProblem) leaseFailures.set(failure, leaseProblem);
        if (supported) markSupportRefusal(failure, error as TenantSupportUnavailable);
        throw failure;
      })
      .finally(() => commandOptions?.close());
  };
  const body = <T>(value: T) => captureTenantData(value);
  const open = (request: Request, target: Target, input: Record<string, never>): Promise<TenantContextReply> =>
    control(async () => {
      tenantRecord(body(input), []);
      const chosen = captureTarget(target);
      const started = clock();
      if (started > Number.MAX_SAFE_INTEGER - lifetime) return denyTenant();
      // Do not reserve context capacity for an unverified caller. Keep this
      // first proof as candidate's authority, including its session identity.
      const proof = await session(request),
        accountId = proof.identity.id;
      prune();
      // At the account's limit an idle context makes way rather than the new
      // page being refused: a context whose page never let it go (a killed
      // mobile tab, a closed browser) used to hold its slot for its lease and
      // the dormant window, about 35 minutes, and every new page was refused
      // as a forged session. Only the openings this many idle contexts can
      // cover are reserved here; the eviction itself waits for admission
      // below, so a caller the membership refuses lets nothing go.
      let occupied = accountOpenings.get(accountId) ?? 0,
        idle = 0;
      for (const tab of tabs.values())
        if (tab.accountId === accountId) {
          occupied++;
          if (evictable(tab)) idle++;
        }
      // No provider, clock callback or await between the checks and reservation.
      if (tabs.size + opening >= maximum) return denyTenant();
      if (occupied - idle >= accountMaximum) throw new TenantContextsBusy();
      opening++;
      accountOpenings.set(accountId, (accountOpenings.get(accountId) ?? 0) + 1);
      try {
        const value = await candidate(request, chosen, { started, proof }),
          lease = leaseFor(value, chosen.realm),
          id = randomUUID();
        if (tabs.has(id)) return denyTenant();
        const tab: Tab = {
          id,
          accountId: value.proof.identity.id,
          sessionId: value.proof.sessionId,
          sessionExpiresAt: value.sessionExpiresAt,
          expiresAt: 0,
          lease,
        };
        tab.expiresAt = retainUntil(tab, lease.window);
        live(tab, lease);
        // Admitted: make room, synchronously with the insertion, by letting
        // the account's oldest idle contexts go (a released one first).
        let held = 0;
        for (const other of tabs.values()) if (other.accountId === accountId) held++;
        while (held >= accountMaximum) {
          const victim = oldestIdle(accountId);
          if (!victim) throw new TenantContextsBusy();
          if (victim.lease) victim.lease.active = false;
          tabs.delete(victim.id);
          held--;
        }
        tabs.set(id, tab);
        return reply(tab, lease);
      } finally {
        opening--;
        const remaining = accountOpenings.get(accountId)! - 1;
        if (remaining) accountOpenings.set(accountId, remaining);
        else accountOpenings.delete(accountId);
      }
    });
  const switchTo = (request: Request, target: Target, input: TenantContextAssertion): Promise<TenantContextReply> =>
    control(async () => {
      const chosen = captureTarget(target);
      const expected = assertion(input);
      const tab = tabs.get(expected.tabId),
        old = tab?.lease;
      // A support lease is left by exiting it, never by switching to another
      // tenant or the platform; nor is a support lease reached by switching.
      if (!tab || !old || old.token !== expected.expectedContext || old.realm === 'support' || chosen.realm === 'support')
        return denyTenant();
      belongs(tab, await session(request));
      if (expected.expectedRevision !== old.window.revision) throw new TenantLeaseError('tenant_lease_stale');
      const window = old.window;
      live(tab, old);
      const next = await candidate(request, chosen);
      belongs(tab, next.proof);
      live(tab, old); // CAS after target verification; a racing winner invalidates this check.
      if (old.window !== window) throw new TenantLeaseError('tenant_lease_stale');
      let finish!: () => void;
      tab.switching = new Promise<void>((resolve) => {
        finish = resolve;
      });
      old.active = false;
      try {
        await Promise.allSettled([...old.pending]);
        active();
        const confirmed = await candidate(request, chosen);
        belongs(tab, confirmed.proof);
        if (!same(next.principal, confirmed.principal)) return denyTenant();
        const lease = leaseFor(confirmed, chosen.realm);
        tab.lease = lease;
        tab.sessionExpiresAt = Math.min(tab.sessionExpiresAt, confirmed.sessionExpiresAt);
        tab.expiresAt = retainUntil(tab, lease.window);
        tab.switching = undefined;
        live(tab, lease);
        return reply(tab, lease);
      } catch (error) {
        tab.lease = undefined;
        throw error;
      } finally {
        tab.switching = undefined;
        finish();
      }
    });
  const renew = (request: Request, target: Target, input: TenantContextAssertion): Promise<TenantContextReply> =>
    control(async () => {
      const chosen = captureTarget(target),
        expected = assertion(input);
      const tab = tabs.get(expected.tabId),
        lease = tab?.lease;
      // A renewal keeps the lease's own realm and tenant; it never changes either.
      if (
        !tab ||
        !lease ||
        lease.token !== expected.expectedContext ||
        lease.realm !== chosen.realm ||
        (chosen.realm === 'tenant' && parseTenantSelector(chosen.selectors) !== tenantOf(lease))
      )
        return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      lease.pending.add(held);
      try {
        belongs(tab, await session(request));
        retained(tab, lease);
        const window = lease.window;
        const replay = lease.receipt?.expectedRevision === expected.expectedRevision && lease.receipt.window === window;
        if (expected.expectedRevision !== window.revision && !replay) throw new TenantLeaseError('tenant_lease_stale');
        const value = await candidate(request, chosen);
        belongs(tab, value.proof);
        retained(tab, lease);
        generation(tab, lease, value.principal);
        tab.sessionExpiresAt = Math.min(tab.sessionExpiresAt, value.sessionExpiresAt);
        retained(tab, lease);
        // Concurrent identical attempts share only the winning receipt. A
        // loser cannot issue another extension or damage a newer generation.
        if (lease.window !== window) {
          if (lease.receipt?.expectedRevision !== expected.expectedRevision || lease.receipt.window !== lease.window)
            throw new TenantLeaseError('tenant_lease_stale');
          if (value.expiresAt < lease.window.expiresAt) return denyTenant();
          return reply(tab, lease);
        }
        if (replay) {
          if (value.expiresAt < window.expiresAt) return denyTenant();
          // An expired exact receipt is metadata only. The browser remains
          // suspended and must request the next revision before accessing data.
          return reply(tab, lease, window);
        }
        if (window.revision >= Number.MAX_SAFE_INTEGER) return denyTenant();
        const next = Object.freeze({ revision: window.revision + 1, expiresAt: Math.min(value.expiresAt, tab.sessionExpiresAt) });
        if (generation(tab, lease, value.principal) >= Math.min(next.expiresAt, tab.expiresAt)) return denyTenant();
        if (lease.window !== window) throw new TenantLeaseError('tenant_lease_stale');
        lease.window = next;
        lease.receipt = Object.freeze({ expectedRevision: window.revision, window: next });
        tab.expiresAt = retainUntil(tab, next);
        live(tab, lease);
        return reply(tab, lease);
      } finally {
        lease.pending.delete(held);
        finish();
      }
    });
  /**
   * A page letting its context go (pagehide): its lease stays what it is, but
   * the context is kept only RELEASE_GRACE more, and counts against the
   * account's contexts no longer after that. Contexts used to stay a
   * half-hour after their page was gone, and an account that reloaded or
   * opened tabs through a morning met the 32-context limit as "The
   * selection was not confirmed".
   */
  const release = (request: Request, input: TenantContextAssertion): Promise<{ tabId: string; status: 'released' }> =>
    control(async () => {
      const expected = assertion(input);
      const tab = tabs.get(expected.tabId),
        lease = tab?.lease;
      if (!tab || !lease || lease.token !== expected.expectedContext || lease.realm === 'support') return denyTenant();
      belongs(tab, await session(request));
      if (tab.lease !== lease) return denyTenant();
      tab.released = true;
      tab.expiresAt = Math.min(tab.expiresAt, clock() + grace);
      return captureTenantData({ tabId: tab.id, status: 'released' as const });
    });
  /**
   * The same browser tab's next page taking back the context its last page
   * let go, for the tenant the reader chose again: the session proven, the
   * membership admitted afresh, and the context kept as long as a live one
   * is. Only a released context resumes, and only once: a context another
   * page still holds is never shared.
   */
  const resume = (request: Request, target: Target, input: { tabId: string }): Promise<TenantContextReply> =>
    control(async () => {
      const value = body(input);
      tenantRecord(value, ['tabId']);
      token(value.tabId);
      const chosen = captureTarget(target);
      const tab = tabs.get(value.tabId),
        lease = tab?.lease;
      if (
        !tab ||
        !tab.released ||
        !lease ||
        tab.switching ||
        !lease.active ||
        lease.realm !== chosen.realm ||
        (chosen.realm === 'tenant' && parseTenantSelector(chosen.selectors) !== tenantOf(lease))
      )
        return denyTenant();
      belongs(tab, await session(request));
      if (clock() >= Math.min(lease.window.expiresAt, tab.expiresAt)) return denyTenant();
      const current = await candidate(request, targetOf(lease));
      belongs(tab, current.proof);
      if (!tab.released || tab.lease !== lease || tab.switching || current.expiresAt < lease.window.expiresAt) return denyTenant();
      live(tab, lease, lease.window, current.principal);
      tab.released = false;
      tab.expiresAt = retainUntil(tab, lease.window);
      return reply(tab, lease);
    });
  return Object.freeze({
    release,
    resume: (request: Request, inputSelectors: readonly string[], input: { tabId: string }): Promise<TenantContextReply> =>
      resume(request, { realm: 'tenant', selectors: inputSelectors }, input),
    resumePlatform: (request: Request, input: { tabId: string }): Promise<TenantContextReply> =>
      resume(request, { realm: 'platform' }, input),
    open: (request: Request, inputSelectors: readonly string[], input: Record<string, never> = {}): Promise<TenantContextReply> =>
      open(request, { realm: 'tenant', selectors: inputSelectors }, input),
    /** Open this tab in the platform realm: admission by platform membership only. */
    openPlatform: (request: Request, input: Record<string, never> = {}): Promise<TenantContextReply> =>
      open(request, { realm: 'platform' }, input),
    switch: (request: Request, inputSelectors: readonly string[], input: TenantContextAssertion): Promise<TenantContextReply> =>
      switchTo(request, { realm: 'tenant', selectors: inputSelectors }, input),
    switchToPlatform: (request: Request, input: TenantContextAssertion): Promise<TenantContextReply> =>
      switchTo(request, { realm: 'platform' }, input),
    /** A new tab on a support session this login opened: admitted only through
     * the support owner's fence, and good for nothing but status and exit yet. */
    openSupport: (request: Request, target: { readonly tenantId: string; readonly supportId: string }): Promise<TenantContextReply> =>
      open(request, { realm: 'support', tenantId: target.tenantId, supportId: target.supportId }, {}),
    renew: (request: Request, inputSelectors: readonly string[], input: TenantContextAssertion): Promise<TenantContextReply> =>
      renew(request, { realm: 'tenant', selectors: inputSelectors }, input),
    renewPlatform: (request: Request, input: TenantContextAssertion): Promise<TenantContextReply> =>
      renew(request, { realm: 'platform' }, input),
    recover: (request: Request, input: { tabId: string }): Promise<TenantContextRecovery> =>
      control(async () => {
        const value = body(input);
        tenantRecord(value, ['tabId']);
        token(value.tabId);
        const tab = tabs.get(value.tabId);
        if (!tab) return denyTenant();
        belongs(tab, await session(request));
        await tab.switching;
        active();
        belongs(tab, await session(request));
        if (tab.switching) return denyTenant();
        const lease = tab.lease;
        const window = lease?.window;
        if (!lease || !lease.active || clock() >= lease.window.expiresAt) {
          if (lease) await Promise.allSettled([...lease.pending]);
          belongs(tab, await session(request));
          if (tab.switching || tab.lease !== lease || lease?.window !== window) return denyTenant();
          return captureTenantData({ tabId: tab.id, status: 'inactive' as const });
        }
        const current = await candidate(request, targetOf(lease));
        belongs(tab, current.proof);
        if (current.expiresAt < lease.window.expiresAt) return denyTenant();
        live(tab, lease, lease.window, current.principal);
        return reply(tab, lease);
      }),
    withContext<T>(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      run: (context: TenantReadContext, lease: TenantContextReply) => T | Promise<T>,
    ) {
      return execute('read', request, selectors, expected, undefined, (bound, captured, _input, _options, lease) =>
        bound.withContext(request, captured, (context) => run(context, lease)),
      );
    },
    /** A read on this tab's platform lease. */
    withPlatformContext<T>(
      request: Request,
      expected: TenantContextAssertion,
      run: (context: PlatformReadContext, lease: TenantContextReply) => T | Promise<T>,
    ) {
      return readPlatform(request, expected, run);
    },
    /** A read on this tab's support lease, inside the dealer it entered. Its
     * caller ledgers the read before releasing a body; a read that cannot be
     * ledgered is refused, never truncated. */
    withSupportContext<T>(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      run: (context: SupportReadContext) => T | Promise<T>,
    ) {
      return readSupport(request, selectors, expected, run);
    },
    /** The platform realm's commands, on this tab's platform lease. */
    preparePlatform(request: Request, expected: TenantContextAssertion, value: unknown, options?: TenantCommandExecutionOptions) {
      return commandPlatform(
        'prepare',
        request,
        expected,
        value,
        (bound, captured, options) => bound.prepare(request, captured, options),
        options,
      );
    },
    availabilityPlatform(request: Request, expected: TenantContextAssertion, value: unknown, options?: TenantCommandExecutionOptions) {
      return commandPlatform(
        'availability',
        request,
        expected,
        value,
        (bound, captured, options) => bound.availability(request, captured, options),
        options,
      );
    },
    executePlatform(request: Request, expected: TenantContextAssertion, value: unknown, options?: TenantCommandExecutionOptions) {
      return commandPlatform(
        'execute',
        request,
        expected,
        value,
        (bound, captured, options) => bound.execute(request, captured, options),
        options,
      );
    },
    statusPlatform(request: Request, expected: TenantContextAssertion, value: unknown, options?: TenantCommandExecutionOptions) {
      return commandPlatform(
        'status',
        request,
        expected,
        value,
        (bound, captured, options) => bound.status(request, captured, options),
        options,
      );
    },
    /** Generic Save, New and Delete on this tab's platform lease: the platform's own rows alone. */
    updatePlatform(request: Request, expected: TenantContextAssertion, value: Parameters<TenantDeployment<Request>['updatePlatform']>[1]) {
      return commandPlatform('write', request, expected, value, (bound, captured) =>
        bound.update(request, captured as Parameters<TenantDeployment<Request>['updatePlatform']>[1]),
      );
    },
    insertPlatform(request: Request, expected: TenantContextAssertion, value: Parameters<TenantDeployment<Request>['insertPlatform']>[1]) {
      return commandPlatform('write', request, expected, value, (bound, captured) =>
        bound.insert(request, captured as Parameters<TenantDeployment<Request>['insertPlatform']>[1]),
      );
    },
    removePlatform(request: Request, expected: TenantContextAssertion, value: Parameters<TenantDeployment<Request>['removePlatform']>[1]) {
      return commandPlatform('write', request, expected, value, (bound, captured) =>
        bound.remove(request, captured as Parameters<TenantDeployment<Request>['removePlatform']>[1]),
      );
    },
    previewRemovePlatform(
      request: Request,
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['previewRemovePlatform']>[1],
    ) {
      return commandPlatform('preview', request, expected, value, (bound, captured) =>
        bound.previewRemove(request, captured as Parameters<TenantDeployment<Request>['previewRemovePlatform']>[1]),
      );
    },
    update(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['update']>[2],
    ) {
      return execute('write', request, selectors, expected, value, (bound, selected, captured) =>
        bound.update(request, selected, captured),
      );
    },
    insert(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['insert']>[2],
    ) {
      return execute('write', request, selectors, expected, value, (bound, selected, captured) =>
        bound.insert(request, selected, captured),
      );
    },
    importRows(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['importRows']>[2],
    ) {
      return execute('write', request, selectors, expected, value, (bound, selected, captured) =>
        bound.importRows(request, selected, captured),
      );
    },
    remove(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['remove']>[2],
    ) {
      return execute('write', request, selectors, expected, value, (bound, selected, captured) =>
        bound.remove(request, selected, captured),
      );
    },
    previewRemove(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['previewRemove']>[2],
    ) {
      return execute('preview', request, selectors, expected, value, (bound, selected, captured) =>
        bound.previewRemove(request, selected, captured),
      );
    },
    preview(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['preview']>[2] = {},
    ) {
      return execute('preview', request, selectors, expected, value, (bound, selected, captured) =>
        bound.preview(request, selected, captured),
      );
    },
    undo(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: Parameters<TenantDeployment<Request>['undo']>[2],
    ) {
      return execute('write', request, selectors, expected, value, (bound, selected, captured) => bound.undo(request, selected, captured));
    },
    prepare(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: unknown,
      options?: TenantCommandExecutionOptions,
    ) {
      return execute(
        'prepare',
        request,
        selectors,
        expected,
        value,
        (bound, selected, captured, options) => bound.prepare(request, selected, captured, options),
        options,
      );
    },
    availability(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: unknown,
      options?: TenantCommandExecutionOptions,
    ) {
      return execute(
        'availability',
        request,
        selectors,
        expected,
        value,
        (bound, selected, captured, options) => bound.availability(request, selected, captured, options),
        options,
      );
    },
    execute(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: unknown,
      options?: TenantCommandExecutionOptions,
    ) {
      return execute(
        'execute',
        request,
        selectors,
        expected,
        value,
        (bound, selected, captured, options) => bound.execute(request, selected, captured, options),
        options,
      );
    },
    status(
      request: Request,
      selectors: readonly string[],
      expected: TenantContextAssertion,
      value: unknown,
      options?: TenantCommandExecutionOptions,
    ) {
      return execute(
        'status',
        request,
        selectors,
        expected,
        value,
        (bound, selected, captured, options) => bound.status(request, selected, captured, options),
        options,
      );
    },
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      for (const tab of tabs.values()) if (tab.lease) tab.lease.active = false;
      retirement = Promise.allSettled([...pending]).then(() => {
        tabs.clear();
      });
      void retirement.catch(() => {});
      return retirement;
    },
  });
}
