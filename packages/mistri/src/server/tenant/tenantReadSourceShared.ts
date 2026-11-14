// What a tenant read source is, whichever dialect serves it: the interface, the lookups both sources answer the same
// way (names, intake resolution, sandbox rows, email switch), the refusal checks run before a batch, and the probe that
// captures a source for the admission checks. The PostgreSQL source (tenantReadSource.ts) and the SQLite one
// (tenantReadSourceSqlite.ts) are built on it.
import { type SandboxRecord } from './tenantSandboxStore.js';
import { Refusal, type AggregateRequest, type ScopedReads, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  recordRefusalCause,
  TenantContextError,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import {
  parseTenantSelector,
  type TenantMembershipEvidence,
  type TenantMembershipLookup,
  type TenantMembershipRecord,
} from './tenantMembership.js';
import { type TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { PlatformMembershipEvidence, PlatformMembershipLookup, PlatformMembershipRecord } from './tenantPlatform.js';
import { type TenantServiceEvidence } from './tenantServiceModel.js';
import { type TenantPublicEvidence, type TenantPublicLookup, type TenantPublicResolution } from './tenantPublicRead.js';
import type { SupportMembershipEvidence } from './tenantSupportLease.js';
import { provideTenantSourceProbe } from './tenantSourceIdentity.js';
import { type TenantMembershipListLookup } from './tenantStore.js';
import {
  type TenantAddresses,
  type TenantAddressesLookup,
  type TenantProfileLookup,
  type ActiveTenant,
  type ActiveTenantsQuery,
  type TenantIntakeEvidence,
  type TenantIntakeLookup,
  type TenantIntakeTenantLookup,
  type TenantIntakeResolution,
} from './tenantIntakeModel.js';
import type { TenantValue } from '@mistriwork/engine/shared/queryOperands.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { type TenantLinkEvidence, type TenantLinkLookup, type TenantLinkResolution } from './tenantLinkModel.js';
import { type DueTimer, type DueTimersQuery } from './tenantDueTimers.js';
import { TENANT_NAMES_MAX, tenantNamePlan, type TenantNamePlan } from './tenantNames.js';
import { type RecordActivityQuery, type RecordHistoryQuery, type StoredRecordChange } from '../../adapters/history/recordHistory.js';
import { type InboxQuery, type StoredNotice } from '../../adapters/inbox/inbox.js';

import {
  type BrandingLogoQuery,
  type BrandingQuery,
  type StoredBranding,
  type StoredBrandingLogo,
} from '../../adapters/branding/branding.js';

/** One person's email switch in one inbox: the same names an inbox read takes. */
export interface EmailSwitchQuery {
  readonly app: string;
  readonly recipient: string;
}
export function assertEmailSwitchQuery(query: EmailSwitchQuery): void {
  tenantRecord(query, ['app', 'recipient']);
  if (typeof query.app !== 'string' || !query.app || typeof query.recipient !== 'string' || !query.recipient)
    throw new Refusal('Invalid notification read.');
}

/** Private pinned source, not a public credential or session/deployment issuer. */
/** A discovery's tenants, as a sandbox lookup takes them: tenant ids, at most a discovery's worth. */
export function sandboxLookup(tenants: unknown): readonly string[] {
  if (!Array.isArray(tenants) || tenants.length > 256) return denyTenant();
  return Object.freeze(tenants.map((id) => parseTenantSelector([id])));
}

export interface TenantReadSource {
  readonly ownership: TenantOwnershipSnapshot;
  readMembership(lookup: TenantMembershipLookup): Promise<TenantMembershipRecord | null>;
  readMemberships(lookup: TenantMembershipListLookup): Promise<readonly TenantMembershipRecord[]>;
  assertCurrent(evidence: TenantMembershipEvidence): Promise<void>;
  scopeReads(evidence: TenantMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** The reader `scopeReads` binds, composed by the same rule, without the
   * snapshot `scopeReads` checks the membership in first. Nothing is read
   * until an operation runs, and every operation revalidates the evidence in
   * its own snapshot before its SQL, so no row is read on evidence that
   * snapshot did not find current. For an owner that also revalidates before
   * it releases anything (tenantReadRuntime.ts). */
  bindReads(evidence: TenantMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** Several reads in one snapshot: the evidence revalidated once at its start,
   * then every operation `work` asks for on that same snapshot, one after
   * another, and none once it has returned. The snapshot is the fence each of
   * `bindReads`' operations has, shared: what they read is one state, and it is
   * the state the membership was found current in. For an answer that is only
   * advice — which commands a record offers — and that its command asks again
   * when it runs (tenantCommandAvailability.ts). */
  withReads<T>(evidence: TenantMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>): Promise<T>;
  /** `work`, with every operation of `bindReads`' readers for this evidence that it asks, while it runs, on one
   * snapshot: opened at the first of them, the evidence revalidated in it once, held until `work` has returned and
   * every read begun on it has settled, then ended. A composed record page, a page's boot, a post-write refresh asked
   * many reads of one context at once, and each took a snapshot of its own — its BEGIN, its LOCK and its membership,
   * its COMMIT, and a reader of the pool beside the others (tenantReadRuntime.ts `together`). What they read is then
   * one state, the one the membership was found current in, as `withReads`' is. A read that wants a replica, and any
   * asked once `work` has returned, takes its own snapshot as before. Where reads are not pooled (SQLite), `work`. */
  together<T>(evidence: TenantMembershipEvidence, work: () => Promise<T>): Promise<T>;
  /** `together`, and where its snapshot was opened and the catalog's attestation stands, the release fence in the
   * message that ends it (PostgresReadSnapshot.finish): once `work` has returned and every read on the snapshot has
   * settled, its COMMIT and this evidence's membership in a fresh snapshot of its own, one round trip where the
   * COMMIT and assertCurrent's own snapshot were three. A membership that no longer holds refuses. `fenced` says
   * whether it rode; where it did not — nothing was read, the attestation was due, `work` failed, SQLite — the
   * caller fences as before. */
  togetherFenced<T>(evidence: TenantMembershipEvidence, work: () => Promise<T>): Promise<{ value: T; fenced: boolean }>;
  /** The platform realm's twins: its membership, its revalidation, and reads
   * under the platform scope (across tenants, unnamed tables denied). */
  readPlatformMembership(lookup: PlatformMembershipLookup): Promise<PlatformMembershipRecord | null>;
  assertPlatformCurrent(evidence: PlatformMembershipEvidence): Promise<void>;
  scopePlatformReads(evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** `scopePlatformReads` without its snapshot, as `bindReads` is `scopeReads`
   * without one: every operation revalidates the platform membership in its
   * own snapshot before its SQL, for an owner that fences again before it
   * releases anything (tenantPlatformReadRuntime.ts). */
  bindPlatformReads(evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** `withReads` for the platform realm, under the platform scope. */
  withPlatformReads<T>(evidence: PlatformMembershipEvidence, rows: RowScope, work: (reads: ScopedReads) => T | Promise<T>): Promise<T>;
  /** A support session's twins ("enter as dealer"): its revalidation, and reads
   * under the dealer's own scope. The fence is the support row itself, with its
   * parent platform membership, `@platform` and the dealer — never a member
   * membership, which an operator inside a dealer does not have. The scope is
   * the dealer's, composed by the same rule a member's is, so a session can
   * never read more than that one rule allows. */
  assertSupportCurrent(evidence: SupportMembershipEvidence): Promise<void>;
  scopeSupportReads(evidence: SupportMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  /** Public intake's resolution, in one snapshot: the active tenant whose
   * profile row alone holds the address, else the platform when it is active.
   * Reads the profile by the policy's column only; admits nobody. */
  resolveIntake(lookup: TenantIntakeLookup): Promise<TenantIntakeResolution>;
  /** A token's public verb's placement, in one snapshot: the token's own
   * tenant when it and the platform are both active, else refused — never
   * triage, and never another tenant, whatever the request says. */
  resolveIntakeByTenant(lookup: TenantIntakeTenantLookup): Promise<TenantIntakeResolution>;
  /** A visitor's placement, in one snapshot: the active tenant whose profile
   * row alone holds the address (or the mapped host's tenant, when active),
   * with `@platform` active too; else null, whatever the reason, so no
   * address is answered differently from another. Admits nobody. */
  resolvePublic(lookup: TenantPublicLookup): Promise<TenantPublicResolution | null>;
  /** A visitor's placement re-resolved in a snapshot of its own: the release fence. */
  assertPublicCurrent(evidence: TenantPublicEvidence): Promise<void>;
  /** Reads under a visitor's scope (tenantPublicRead.ts composePublicReadScope),
   * as `bindReads` is a member's: every operation re-resolves the address in
   * its own snapshot and requires the same tenant at the same versions before
   * its SQL, so a rotated address or a suspended tenant reads nothing more. */
  bindPublicReads(evidence: TenantPublicEvidence, rows: RowScope): Promise<ScopedReads>;
  /** Reads for a public command's lookup in a tenant's intake (tenantIntake.ts): the submission read as the
   * visitor it is (tenantPublicRead.ts intakeVisitor), under the same scope and the same fence as
   * `bindPublicReads`. Triage is refused: it lands in no tenant, so no tenant's rows are its to look up. */
  bindIntakeReads(evidence: TenantIntakeEvidence, rows: RowScope): Promise<ScopedReads>;
  /** Reads under a tenant service's scope (tenantServiceModel.ts composeServiceScope), as `bindReads` is a
   * member's: the source recomposes the scope from the evidence (never a caller's predicate), and every
   * operation re-reads the service anchors in its own snapshot and requires the same tenant and platform at
   * the same versions, inside the attempt's window. A platform place is refused: it runs outside any tenant. */
  bindServiceReads(evidence: TenantServiceEvidence, rows: RowScope): Promise<ScopedReads>;
  /** A capability link's placement, in one snapshot: the live link by this App and its id alone — the one read a
   * tenant App's shared door makes before it knows the tenant — with its tenant and `@platform` each active; else
   * null, whatever the reason. Admits nobody: the door checks the token or session against the tenant it names. */
  resolveLink(lookup: TenantLinkLookup): Promise<TenantLinkResolution | null>;
  /** Reads under a link's scope (tenantLinkModel.ts composeLinkScope): its one record within its tenant. Every
   * operation re-reads the anchors and the link row in its own snapshot and requires the same tenant at the same
   * versions, inside the request's window, with the link still live: a revoke or a suspension reads nothing more. */
  bindLinkReads(evidence: TenantLinkEvidence, rows: RowScope): Promise<ScopedReads>;
  /** What these tenants are called: each one's profile row said by the App's
   * template for that resource (tenantNames.ts), for the ids a caller already
   * holds. Reads the profile's key and the name's columns only; admits nobody. */
  readTenantNames(lookup: TenantNamesLookup): Promise<Readonly<Record<string, string>>>;
  /** A tenant's own intake and public addresses, by the policy's columns, in
   * one snapshot: each only when its profile row holds one of an
   * address's shape that resolves back to this tenant alone. For the tenant's
   * own lease to show; admits nobody. */
  readTenantAddresses(lookup: TenantAddressesLookup): Promise<TenantAddresses>;
  /** The columns of a tenant's profile row its members read (`auth.tenancy.shared`), by column, once per request:
   * the platform's own read of the row (as the names and addresses are), no App resource read and no grant. Those
   * columns and nothing else of the row; a missing row reads as every column null. Admits nobody. */
  readTenantProfile(lookup: TenantProfileLookup): Promise<Readonly<Record<string, TenantValue>>>;
  /** A job attempt's anchors, in one snapshot: the named tenant's row and
   * `@platform`, each its version while active, else null. With no tenant
   * (the platform's own time job), `@platform` alone. Admits nobody. */
  readServiceAnchors(tenantId: string | null): Promise<Readonly<{ tenantVersion: string | null; platformVersion: string | null }>>;
  /** The tenants active now, by id: whom a job at times per tenant runs for.
   * Given `zone`, a shared profile column, each also carries that column off
   * its row (null where it has none): the zone its slots keep. Each attempt is
   * admitted again on its own tenant's row. Admits nobody. */
  readActiveTenants(options?: ActiveTenantsQuery): Promise<readonly ActiveTenant[]>;
  /** A machine timer's due records across the active tenants, a page at a
   * time, each with the tenant its owner column names, read off the row here
   * (tenantDueTimers.ts). A plan, as readActiveTenants is: each run is
   * admitted again on its own tenant's row. Admits nobody. */
  readDueTimers(query: DueTimersQuery): Promise<readonly DueTimer[]>;
  /** The sandboxes whose dev clock reads ahead (tenantSandboxClock.ts), none where the store was never
   * provisioned: which tenants' timers the sweep also reads on their own clock. A live tenant has no row
   * there, so none is ever among them. Admits nobody. */
  readSandboxClocks(): Promise<readonly SandboxRecord[]>;
  /** Which of these tenants are sandboxes, for discovery to mark them to their members: none where the
   * store was never provisioned. Admits nobody. */
  readSandboxes(tenants: readonly string[]): Promise<ReadonlySet<string>>;
  /** One record's stored history, by its store key — a tenant-owned record's
   * carries its owner (adapters/history/recordHistory.ts). Admits nobody: the
   * caller has read the record in the reader's own context first. */
  readRecordHistory(query: RecordHistoryQuery): Promise<StoredRecordChange[]>;
  /** A dashboard feed's stored rows (recordActivity.ts). Admits nobody: the
   * caller names the context's own tenant in `owners`, or none for the
   * platform realm, and reads each record the rows name in that context. */
  readRecordActivity(query: RecordActivityQuery): Promise<StoredRecordChange[]>;
  /** One person's notices in one inbox (tenantInbox.ts). Admits nobody: the caller names the lease's own inbox. */
  readInbox(query: InboxQuery): Promise<StoredNotice[]>;
  /** Whether one person asked an inbox for no email: the outbox's switch, read on the reader (inboxMail.ts). */
  readEmailOff(query: EmailSwitchQuery): Promise<boolean>;
  /** One tenant's saved branding in one App, or null (adapters/branding). */
  readBranding(query: BrandingQuery): Promise<StoredBranding | null>;
  /** One logo of an App by the hash of its bytes. */
  readBrandingLogo(query: BrandingLogoQuery): Promise<StoredBrandingLogo | null>;
  close(): Promise<void>;
}

/** The tenant an address names, when that tenant is active, else the platform.
 * The platform's own row first: while it is not active nothing is taken,
 * whatever the address, so no address is answered differently from another. */
export function intakeResolution(tenantId: string | undefined, anchor: (id: string) => string | null): TenantIntakeResolution {
  const platform = anchor(PLATFORM_TENANT_ID);
  if (platform === null) return denyTenant();
  const version = tenantId === undefined ? null : anchor(tenantId);
  return tenantId !== undefined && version !== null
    ? { tenantId, tenantVersion: version, platformVersion: platform }
    : { tenantId: PLATFORM_TENANT_ID, tenantVersion: platform, platformVersion: platform };
}

/** The token's tenant when it and the platform are both active; refused otherwise, as no token is triaged. */
export function intakeResolutionByTenant(tenantId: string, anchor: (id: string) => string | null): TenantIntakeResolution {
  const platform = anchor(PLATFORM_TENANT_ID);
  const version = platform === null ? null : anchor(tenantId);
  if (platform === null || version === null) return denyTenant();
  return { tenantId, tenantVersion: version, platformVersion: platform };
}

/** The profile's record-name template, as the App's catalog serves it, and the tenants to name. */
export interface TenantNamesLookup {
  readonly template: string | undefined;
  readonly tenants: readonly string[];
}
/** The lookup's plan and its ids, or undefined when there is nothing to read. */
export function namesLookup(
  owned: TenantOwnershipSnapshot,
  lookup: TenantNamesLookup,
): { plan: TenantNamePlan; tenants: string[] } | undefined {
  const value = captureTenantData(lookup);
  if (
    !Array.isArray(value.tenants) ||
    value.tenants.length > TENANT_NAMES_MAX ||
    (value.template !== undefined && typeof value.template !== 'string')
  )
    return denyTenant();
  const tenants = [...new Set(value.tenants.filter((id) => id !== PLATFORM_TENANT_ID))];
  for (const id of tenants) parseTenantSelector([id]);
  const plan = tenantNamePlan(owned, value.template);
  return plan && tenants.length ? { plan, tenants } : undefined;
}

export const sources = new WeakSet<TenantReadSource>();

/** Only frozen factory objects can supply source authority. WeakSet lookup does
 * not inspect properties, so lookalikes, getters and proxies never execute. */
export function captureTenantReadSource(input: TenantReadSource): TenantReadSource {
  if (!sources.has(input)) return denyTenant();
  return input;
}
provideTenantSourceProbe('read', captureTenantReadSource);

/** A batch's reads in the shape a command's records take, for the one caller
 * that asks a command's questions without its transaction (availability): it
 * reads, and every way of writing refuses. */
export function advisoryRecords(reads: ScopedReads): WriteTransaction {
  const refuse = async (): Promise<never> => {
    throw new Refusal('Availability reads; it never writes.');
  };
  return Object.freeze<WriteTransaction>({
    query: (request) => reads.query(request),
    count: (table, filter) => reads.count(table, filter),
    ...(reads.aggregate ? { aggregate: (request: AggregateRequest) => reads.aggregate!(request) } : {}),
    insert: refuse,
    update: refuse,
    remove: refuse,
  });
}

/* A read refused before it ran — its arguments not plain data, the source
   closed — is one fixed sentence to its caller, and keeps why for the
   operator (refusalReport.ts), where a fresh denial in its place said
   nothing on stderr at all. */
export const refusedBefore = (error: unknown): Promise<never> => Promise.reject(recordRefusalCause(new TenantContextError(), error));

/** The reader a batch is handed (`withReads`): each operation's arguments
 * captured, run on the batch's snapshot as it is asked, and refused once the
 * batch has returned. Asked together, they leave together: the PostgreSQL
 * reader pipelines, so the `when` of every command a record offers is one
 * round trip, where one after another each was its own (SQLite runs them in
 * turn on its one handle either way). The first failure is every later
 * operation's, as one transaction's is. A database failure is mapped where
 * it happens, so what `work` itself throws stays its own; `own` hears which
 * that was. */
export async function readBatch<T>(
  bound: ScopedReads,
  active: () => void,
  work: (reads: ScopedReads) => T | Promise<T>,
  own: (error: unknown) => void,
): Promise<T> {
  const running = new Set<Promise<unknown>>();
  let failure: { error: unknown } | undefined;
  const operations = {
    finish: async () => {
      await Promise.allSettled([...running]);
      if (failure) throw failure.error;
    },
  };
  let open = true;
  const run = <A extends unknown[], R>(args: A, call: (...captured: A) => Promise<R>): Promise<R> => {
    let captured: A;
    try {
      if (!open) throw recordRefusalCause(new TenantContextError(), "A batch's read was asked after the batch had returned.");
      active();
      captured = captureTenantData(args);
    } catch (error) {
      return refusedBefore(error);
    }
    if (failure) return Promise.reject(failure.error);
    const operation = (async () => {
      try {
        const result = await call(...captured);
        active();
        return result;
      } catch (error) {
        try {
          return denyTenantFor(error);
        } catch (mapped) {
          failure ??= { error: mapped };
          throw mapped;
        }
      }
    })();
    running.add(operation);
    void operation.then(
      () => running.delete(operation),
      () => running.delete(operation),
    );
    return operation;
  };
  const reads = Object.freeze<ScopedReads>({
    query: (request) => run([request] as [typeof request], (value) => bound.query(value)),
    count: (table, filter, limit) =>
      run([table, filter, limit] as [typeof table, typeof filter, typeof limit], (id, value, boundLimit) =>
        bound.count(id, value, boundLimit),
      ),
    runView: (view, offset) =>
      run([view, offset] as [typeof view, typeof offset], (value, boundOffset) => bound.runView(value, boundOffset)),
    countView: (view, limit) =>
      run([view, limit] as [typeof view, typeof limit], (value, boundLimit) => bound.countView(value, boundLimit)),
    runBreakdown: (breakdown, offset) =>
      run([breakdown, offset] as [typeof breakdown, typeof offset], (value, boundOffset) => bound.runBreakdown(value, boundOffset)),
    countBreakdown: (breakdown, limit) =>
      run([breakdown, limit] as [typeof breakdown, typeof limit], (value, boundLimit) => bound.countBreakdown(value, boundLimit)),
    /* A sum or a group, captured and run on the batch's snapshot as `count` is. */
    ...(bound.aggregate
      ? { aggregate: (request: AggregateRequest) => run([request] as [typeof request], (value) => bound.aggregate!(value)) }
      : {}),
  });
  let result: T;
  try {
    result = await work(reads);
  } catch (error) {
    open = false;
    own(error);
    await operations.finish().catch(() => {});
    throw error;
  }
  open = false;
  await operations.finish();
  return result;
}
