/**
 * Audited support sessions ("enter as dealer"): the one owner that opens,
 * exits and reports them, and the fence a support lease is admitted through.
 *
 * Opening is admission, so it is strict. A genuine native login, created no
 * more than five minutes ago, is re-observed before COMMIT; the caller's live
 * platform membership must hold a policy grant naming the dealer (an active
 * one) and the one dealer role asked for, with no role unioned from anywhere
 * else. In ONE administration transaction on this owner's own writer it then
 * closes the account's previous support session (supersession), inserts the
 * support membership, opens its audit chain and commits an `openSupport`
 * receipt; any failure rolls all of it back. A session lasts the least of
 * thirty minutes, the native session's expiry and the parent membership's
 * validity, and nothing renews it.
 *
 * Exit and status need the same native login, not a fresh one: status never
 * renews, and an expired session is never revived to exit. Status is also
 * where an expired session is closed, with end reason `expired` — it already
 * holds the locks and has read the row, and no authority is revived by
 * ending one. A lost acknowledgement is recovered by status with the exact
 * attempt; a replay never mints a second support id. A restart resumes a live
 * session only for the very native session that opened it.
 *
 * What this module mints is evidence, not access: the lease it admits carries
 * no authority of its own, and every business read and write re-derives what
 * it may do from that evidence (tenantContexts.ts), recording the answer
 * before releasing it.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { isPromise, isProxy } from 'node:util/types';
import { TransactionOutcomeUnknown, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import type { AppDef } from '../../shared/app.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import {
  SUPPORT_LIFETIME_MS,
  SUPPORT_OPENING_AGE_MS,
  SUPPORT_REFUSAL_CODES,
  type SupportExitIntent,
  type SupportExitReply,
  type SupportOpenIntent,
  type SupportReceiptView,
  type SupportSessionView,
  type SupportStatusReply,
} from '../../shared/tenantSupport.js';
import { nativeAccountEmailOf } from '../auth/authAccounts.js';
import {
  captureAppAuthRuntime,
  captureNativeDisplayName,
  captureNativeSignInAge,
  captureNativeStepUpProvider,
  type AppAuthRuntime,
  type VerifiedSessionInstance,
} from '../auth/auth.js';
import { assertAuthStoreSeparation, captureAuthStoreExclusion } from '../auth/authStoreSeparation.js';
import { assertSqliteTenantAdministrationJournal, createSqliteTenantAdministrationJournal } from './tenantAdministrationJournal.js';
import type { TenantAdministrationJournal } from './tenantAdministrationJournalContract.js';
import {
  assertPostgresTenantAdministrationJournal,
  createPostgresTenantAdministrationJournal,
} from './tenantAdministrationJournalPostgres.js';
import { identifier } from './tenantAdministrationJournalValidation.js';
import { captureTenantData, denyTenant, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { binding as storeBinding, nextRevision, time, type TenantStoreBinding } from './tenantStoreContract.js';
import { assertSqliteSupportAudit, createSqliteSupportAuditOwner, readSqliteSupportLog } from './tenantSupportAudit.js';
import {
  keyId,
  SUPPORT_DETAIL_BYTES,
  type SupportAuditKey,
  type SupportAuditOwner,
  type SupportEntry,
  type SupportLogRows,
  type SupportSession,
} from './tenantSupportAuditContract.js';
import { assertPostgresSupportAudit, createPostgresSupportAuditOwner, readPostgresSupportLog } from './tenantSupportAuditPostgres.js';
import {
  captureSupportChange,
  captureSupportIntent,
  captureSupportPolicy,
  supportFingerprint,
  supportGranted,
  type SupportChange,
  type SupportPair,
  type SupportPolicy,
} from './tenantSupportChange.js';
import { issueSupportEvidence, type SupportMembershipEvidence, type SupportTarget } from './tenantSupportLease.js';
import type { SupportMembershipObservation } from './tenantSupportMembership.js';
import { observePostgresSupportMembership } from './tenantSupportMembershipPostgres.js';
import { observeSqliteSupportMembership } from './tenantSupportMembershipSqlite.js';
import { createSqliteSupportFacts, supportText, type SupportFacts, type SupportMember } from './tenantSupportTransaction.js';
import { createPostgresSupportFacts } from './tenantSupportTransactionPostgres.js';

interface TenantSupportOptions {
  /** Exactly one: the SQLite business file, or the PostgreSQL source's URL. */
  readonly path?: string;
  readonly url?: string;
  readonly binding: TenantStoreBinding;
  /** Borrowed genuine native runtime; the host retires this owner before closing it. */
  readonly auth: AppAuthRuntime;
  readonly app: AppDef;
  readonly policy: SupportPolicy;
  readonly key: SupportAuditKey;
  readonly deployment: string;
  readonly now?: () => number;
}
interface SupportRequest<I> {
  readonly expectedAccount: string;
  readonly idempotencyKey: string;
  readonly intent: I;
}
export interface SupportStatusRequest {
  readonly expectedAccount: string;
  readonly attempt?: { readonly idempotencyKey: string; readonly intent: SupportOpenIntent | SupportExitIntent };
}
/** What the server knows; the HTTP layer adds a resumed lease. */
type SupportStatus = Omit<SupportStatusReply, 'context'>;
/** An opening's or an exit's receipt; the HTTP layer adds an opening's lease. */
type SupportOutcome = SupportExitReply;
export interface TenantSupport {
  status(request: IncomingMessage, input: SupportStatusRequest): Promise<SupportStatus>;
  open(request: IncomingMessage, input: SupportRequest<SupportOpenIntent>): Promise<SupportOutcome>;
  exit(request: IncomingMessage, input: SupportRequest<SupportExitIntent>): Promise<SupportOutcome>;
  /** The support lease's fence: support row, parent, `@platform`, dealer and
   * the audit session of this very native login. Evidence, not access. */
  admit(request: IncomingMessage, target: SupportTarget): Promise<SupportMembershipEvidence>;
  /** Whether the signed-in account is inside a dealer now. Fails closed: any
   * doubt answers true, so the caller refuses what support never allows. */
  holds(request: IncomingMessage): Promise<boolean>;
  /**
   * Record one read a support session made, in a short fenced writer
   * transaction of this owner's own. The caller holds the answer and has not
   * released it: this resolves only once the entry is committed, so a caller
   * that awaits it before writing its response cannot release a body the log
   * does not mention. A rejection is the instruction to release nothing.
   *
   * A `read` entry names no resource, operation or record key — the store's
   * own rule for every kind that is not a write — so what was read is said in
   * the detail, and a description that will not fit is refused rather than
   * trimmed to fit.
   */
  ledgerRead(request: IncomingMessage, input: SupportReadRequest): Promise<void>;
  /** Stored support history: one dealer's when `tenantId` names it, every
   * dealer's when it is null. The caller must already have established who may
   * read it — this filters, it does not authorize. */
  readLog(request: IncomingMessage, tenantId: string | null): Promise<SupportLogRows>;
  /** Every dealer's history with the operators' current addresses, for the
   * lender's audit view alone. Composes; does not authorize. */
  readAudit(request: IncomingMessage): Promise<{ rows: SupportLogRows; emails: Readonly<Record<string, string | null>> }>;
  retire(): Promise<void>;
}
/** What one support read is recorded as: the session it belongs to, and a
 * description of what the request asked and what it returned. The description
 * is the caller's summary, not rows: a log of what an operator looked at, not
 * a second copy of the dealer's data. */
export interface SupportReadRequest {
  readonly tenantId: string;
  readonly supportId: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

type Code = typeof SUPPORT_REFUSAL_CODES.refused | typeof SUPPORT_REFUSAL_CODES.signInRequired;
export class TenantSupportFailure extends Error {
  constructor(
    readonly code: Code,
    readonly outcome: 'not_applied' | 'unknown',
  ) {
    super(
      code === SUPPORT_REFUSAL_CODES.signInRequired
        ? 'Sign in again to enter a dealer: opening support needs a sign-in from the last five minutes.'
        : 'The support session could not be confirmed.',
    );
    this.name = 'TenantSupportFailure';
  }
}
const refused = (outcome: 'not_applied' | 'unknown' = 'not_applied') => new TenantSupportFailure(SUPPORT_REFUSAL_CODES.refused, outcome);
/** A request's whole budget. Nothing a support request does takes longer. */
const REQUEST_MS = 60_000;
const utf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const sorted = (values: readonly (string | null | undefined)[]) =>
  [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort(utf8);
const iso = (at: number) => new Date(at).toISOString();

type Session = DatabaseSync | PgQuery;
interface Store {
  transact<T>(
    final: () => void | Promise<void>,
    work: (session: Session, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
  ): Promise<T>;
  facts(session: Session, operations: TransactionOperations, active: () => void): SupportFacts;
  journal(session: Session, operations: TransactionOperations, active: () => void): TenantAdministrationJournal;
  audit(session: Session, operations: TransactionOperations, active: () => void): SupportAuditOwner;
  observe(
    session: Session,
    lookup: { supportId: string; accountId: string; tenantId: string; at: number },
  ): Promise<SupportMembershipObservation>;
  /** Stored history for one tenant, or every tenant when `tenantId` is null.
   * A read: it appends nothing and verifies no chain. */
  log(session: Session, tenantId: string | null): Promise<SupportLogRows>;
  close(): Promise<void>;
}

/** The business file on this owner's own writer, never native auth's file. The
 * store, journal and audit are attested at BEGIN and again before COMMIT, and
 * the final native check runs after every storage check, synchronously. */
async function openSqliteStore(
  path: string,
  owner: TenantStoreBinding,
  key: SupportAuditKey,
  authStore: string,
  assertAuth: () => void,
): Promise<Store> {
  const excluded = captureAuthStoreExclusion(path);
  assertAuthStoreSeparation(authStore, excluded);
  assertAuth();
  const writer = new SqliteAdapter(excluded.path, 'Private tenant support');
  const attest = (db: DatabaseSync) => {
    assertAuth();
    assertAuthStoreSeparation(authStore, excluded);
    assertSqliteTenantAdministrationJournal(db, owner);
    assertSqliteSupportAudit(db, owner, key);
  };
  try {
    await writer.runtimeMaintenanceTransaction(attest, async () => {});
    const sqlite = (session: Session) => session as DatabaseSync;
    return Object.freeze<Store>({
      transact: (final, work) =>
        writer.runtimeMaintenanceTransaction((db) => {
          attest(db);
          if (final() !== undefined) return denyTenant();
        }, work),
      facts: (session, operations, active) => createSqliteSupportFacts(sqlite(session), operations, active),
      journal: (session, operations, active) => createSqliteTenantAdministrationJournal(sqlite(session), operations, owner, active),
      audit: (session, operations, active) => createSqliteSupportAuditOwner(sqlite(session), operations, owner, key, active),
      observe: async (session, lookup) => observeSqliteSupportMembership(sqlite(session), owner, lookup),
      log: async (session, tenantId) => readSqliteSupportLog(sqlite(session), tenantId),
      close: () => writer.close(),
    });
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

/** The PostgreSQL source on this owner's own writer. Storage attestation
 * precedes the final native observation, which may await the auth store. */
async function openPostgresStore(url: string, owner: TenantStoreBinding, key: SupportAuditKey, assertAuth: () => void): Promise<Store> {
  assertAuth();
  const writer = new PostgresAdapter(url, 'Private tenant support');
  const attest = async (client: PgQuery) => {
    assertAuth();
    await assertPostgresTenantAdministrationJournal(client, owner);
    await assertPostgresSupportAudit(client, owner, key);
    assertAuth();
  };
  try {
    await writer.runtimeMaintenanceTransaction(attest, async () => {});
    const pg = (session: Session) => session as PgQuery;
    return Object.freeze<Store>({
      transact: (final, work) =>
        writer.runtimeMaintenanceTransaction(async (client) => {
          await attest(client);
          await final();
        }, work),
      facts: (session, operations, active) => createPostgresSupportFacts(pg(session), operations, active),
      journal: (session, operations, active) => createPostgresTenantAdministrationJournal(pg(session), operations, owner, active),
      audit: (session, operations, active) => createPostgresSupportAuditOwner(pg(session), operations, owner, key, active),
      observe: (session, lookup) => observePostgresSupportMembership(pg(session), owner, lookup),
      log: (session, tenantId) => readPostgresSupportLog(pg(session), tenantId),
      close: () => writer.close(),
    });
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

const OPTION_KEYS = ['path', 'url', 'binding', 'auth', 'app', 'policy', 'key', 'deployment', 'now'];

export async function openTenantSupport(options: TenantSupportOptions): Promise<TenantSupport> {
  let store: Store | undefined;
  try {
    const raw = tenantOptions(options, OPTION_KEYS);
    if ((raw.path === undefined) === (raw.url === undefined)) return denyTenant();
    const owner = storeBinding(raw.binding as TenantStoreBinding);
    const app = captureTenantData(raw.app as AppDef),
      policy = captureSupportPolicy(raw.policy);
    const runtime = raw.auth as AppAuthRuntime;
    const auth = captureAppAuthRuntime(runtime),
      age = captureNativeSignInAge(runtime),
      names = captureNativeDisplayName(runtime);
    const stepUp = captureNativeStepUpProvider(runtime);
    const key = raw.key as SupportAuditKey;
    keyId(key);
    identifier(raw.deployment);
    const deployment = raw.deployment;
    const roles = app.auth?.roles ?? {};
    // The same ceilings startup states: platform roles open, tenant roles are held.
    if (
      app.id !== owner.appId ||
      app.id !== auth.appId ||
      app.auth?.rows !== 'tenant' ||
      !app.auth.tenancy?.platform ||
      policy.grants.some(
        (grant) =>
          !Object.hasOwn(roles, grant.platformRole) ||
          roles[grant.platformRole].realm !== 'platform' ||
          grant.dealerRoles.some((role) => !Object.hasOwn(roles, role) || roles[role].realm === 'platform'),
      )
    )
      return denyTenant();
    const now = raw.now === undefined ? Date.now : raw.now;
    if (typeof now !== 'function' || isProxy(now)) return denyTenant();
    const engine = raw.path !== undefined ? 'sqlite' : 'postgres';
    // SQLite's final verifier is synchronous and cannot await a PostgreSQL auth store.
    if (engine === 'sqlite' && (!auth.synchronous || !age.synchronous)) return denyTenant();
    const passwordSignIn = !app.auth.providers || app.auth.providers.includes('email');
    const opened = (store =
      engine === 'sqlite'
        ? await openSqliteStore(supportText(raw.path, 32768), owner, key, runtime.store, auth.assertCurrent)
        : await openPostgresStore(supportText(raw.url, 32768), owner, key, auth.assertCurrent));

    let retired = false,
      retirement: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const clock = (): number => {
      if (retired) return denyTenant();
      auth.assertCurrent();
      const instant: unknown = now();
      if (isPromise(instant)) void Promise.prototype.then.call(instant, undefined, () => {});
      time(instant);
      if (retired) return denyTenant();
      return instant;
    };
    const tracked = <T>(work: () => Promise<T>): Promise<T> => {
      if (retired) return Promise.reject(refused());
      const promise = Promise.resolve().then(work);
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    const retire = (): Promise<void> => {
      if (!retirement) {
        retired = true;
        retirement = Promise.allSettled([...pending]).then(() => opened.close());
        void retirement.catch(() => {});
      }
      return retirement;
    };

    /** One request's native login and its liveness fence. No caller claim
     * stands in: the proof is the native runtime's own, re-read each check. */
    const login = async (request: IncomingMessage, expectedAccount?: string) => {
      const started = clock();
      const proof = await auth.sessionInstance(request);
      if (!proof || (expectedAccount !== undefined && proof.identity.id !== expectedAccount)) return denyTenant();
      let last = started;
      const live = (): number => {
        const instant = clock();
        auth.assertSessionCurrent(proof);
        if (request.aborted || instant < last || instant >= proof.expiresAt || instant - started > REQUEST_MS) return denyTenant();
        last = instant;
        return instant;
      };
      const observe = async () => {
        live();
        if (!auth.synchronous) {
          await auth.observeSession(proof);
          live();
        }
      };
      live();
      return { proof, live, observe };
    };
    type Login = Awaited<ReturnType<typeof login>>;
    /** The final native check, after storage attestation and drain, before
     * COMMIT: synchronous on a file auth store, as SQLite requires. */
    const final =
      ({ live, proof }: Login, opening: boolean) =>
      (): void | Promise<void> => {
        if (auth.synchronous) {
          const instant = live();
          if (opening)
            (age as { observeRecent(p: VerifiedSessionInstance, a: number, m: number): void }).observeRecent(
              proof,
              instant,
              SUPPORT_OPENING_AGE_MS,
            );
          return;
        }
        return (async () => {
          live();
          await auth.observeSession(proof);
          if (opening) {
            const observed = age.observeRecent(proof, live(), SUPPORT_OPENING_AGE_MS);
            if (isPromise(observed)) await observed;
            // Never reuse a pre-await clock: the five minutes may pass in the query.
            age.assertAge(proof, live(), SUPPORT_OPENING_AGE_MS);
          }
          live();
        })();
      };

    const pairOf = (row: SupportMember, session: SupportPair['session']): SupportPair => {
      if (row.kind !== 'support' || row.status === 'invited') return denyTenant();
      return captureTenantData({
        membership: {
          membershipId: row.id,
          tenantId: row.tenantId,
          accountId: row.accountId,
          kind: 'support' as const,
          version: row.version,
          status: row.status,
          roles: [...row.roles],
          validUntil: row.validUntil,
          parentId: row.parentId!,
          parentVersion: row.parentVersion!,
          platformVersion: row.platformVersion!,
        },
        session,
      });
    };
    const closed = (pair: SupportPair, at: string, endReason: 'exit' | 'superseded'): SupportPair =>
      captureTenantData({
        membership: { ...pair.membership, status: 'revoked' as const, version: nextRevision(pair.membership.version) },
        session: { ...pair.session, endedAt: at, endReason },
      });
    const entry = (
      kind: SupportEntry['kind'],
      at: string,
      requestId: string,
      actorId: string,
      versions: Pick<SupportEntry, 'tenantVersion' | 'supportMembershipVersion' | 'parentMembershipVersion' | 'platformVersion'>,
      detail: Record<string, unknown> = {},
    ): SupportEntry => ({
      kind,
      at,
      requestId,
      actorId,
      ...versions,
      resource: null,
      operation: null,
      keyJson: null,
      detailJson: JSON.stringify(detail),
      commandReceiptId: null,
    });
    /** A support row and its verified audit header must say the same thing. */
    const matches = (row: SupportMember, session: SupportPair['session']) =>
      row.kind === 'support' &&
      session.id === row.id &&
      session.tenantId === row.tenantId &&
      session.accountId === row.accountId &&
      session.dealerRole === row.roles[0] &&
      session.parentMembershipId === row.parentId &&
      session.parentMembershipVersion === row.parentVersion &&
      session.platformVersion === row.platformVersion &&
      session.validUntil === row.validUntil;
    /** `fenced` is false once the parent, `@platform` or the dealer no longer
     * holds: the lease is refused then, so the session is not called active. */
    const view = (pair: SupportPair, session: SupportPair['session'], instant: number, fenced = true): SupportSessionView => {
      const { membership } = pair;
      const state =
        session.endedAt !== null || membership.status === 'revoked' || !fenced
          ? 'ended'
          : instant >= membership.validUntil
            ? 'expired'
            : 'active';
      return captureTenantData({
        supportId: membership.membershipId,
        version: membership.version,
        tenantId: membership.tenantId,
        dealerRole: session.dealerRole,
        operatorName: session.operatorName,
        reason: session.reason,
        openedAt: session.openedAt,
        validUntil: membership.validUntil,
        remainingMs: Math.max(0, membership.validUntil - instant),
        state,
      });
    };
    /** Historical receipts are storage, not authority: each named session's
     * verified header must match the change, and the session is this login's. */
    const verified = async (audit: SupportAuditOwner, change: SupportChange, proof: VerifiedSessionInstance, active: () => void) => {
      const pairs = change.operation === 'openSupport' && change.replaced ? [change.after, change.replaced.after] : [change.after];
      const headers = new Map<string, SupportPair['session']>();
      for (const pair of [...pairs].sort((a, b) => utf8(a.session.id, b.session.id))) {
        const header = await audit.readHeader(pair.session.id);
        active();
        if (!header || header.session.accountId !== proof.identity.id) return denyTenant();
        const { endedAt: _a, endReason: _b, ...fixed } = header.session,
          { endedAt, endReason, ...expected } = pair.session;
        if (
          !isDeepStrictEqual(captureTenantData(fixed), captureTenantData(expected)) ||
          (endedAt !== null && (header.session.endedAt !== endedAt || header.session.endReason !== endReason))
        )
          return denyTenant();
        headers.set(pair.session.id, header.session as SupportPair['session']);
      }
      if (change.after.session.nativeSessionId !== proof.sessionId && change.operation === 'openSupport') return denyTenant();
      return headers.get(change.after.session.id)!;
    };
    const receiptView = (
      change: SupportChange,
      receipt: { id: string; completedAt: string },
      header: SupportPair['session'],
      instant: number,
    ): SupportReceiptView =>
      captureTenantData({
        operation: change.operation,
        receiptId: receipt.id,
        completedAt: receipt.completedAt,
        session: view(change.after, header, instant),
      });
    const failure = (error: unknown, applied: boolean): TenantSupportFailure => {
      if (error instanceof TenantSupportFailure) return error;
      return refused(applied || error instanceof TransactionOutcomeUnknown ? 'unknown' : 'not_applied');
    };
    const attemptInput = <I>(input: SupportRequest<I>, operation: 'openSupport' | 'exitSupport') => {
      const value = captureTenantData(input);
      tenantRecord(value, ['expectedAccount', 'idempotencyKey', 'intent']);
      if (Object.keys(value).length !== 3) return denyTenant();
      supportText(value.expectedAccount);
      identifier(value.idempotencyKey);
      const intent = captureSupportIntent(value.intent);
      if (intent.operation !== operation) return denyTenant();
      return { expectedAccount: value.expectedAccount, idempotencyKey: value.idempotencyKey, intent } as SupportRequest<I>;
    };

    /** Shared by open and exit: the exact receipt first, under its own scope. */
    const mutate = (
      request: IncomingMessage,
      attempt: SupportRequest<SupportOpenIntent | SupportExitIntent>,
      apply: (context: {
        facts: SupportFacts;
        audit: SupportAuditOwner;
        journal: TenantAdministrationJournal;
        login: Login;
        active: () => void;
        scope: Parameters<TenantAdministrationJournal['read']>[0];
        fingerprint: string;
      }) => Promise<SupportOutcome>,
    ) =>
      tracked(async () => {
        let applied = false;
        try {
          const own = await login(request, attempt.expectedAccount);
          const opening = attempt.intent.operation === 'openSupport';
          if (opening) {
            // Opening only: the native login itself must be recent. A later
            // exit or status needs the same login, not a recent one.
            try {
              age.assertAge(own.proof, own.live(), SUPPORT_OPENING_AGE_MS);
            } catch {
              throw new TenantSupportFailure(SUPPORT_REFUSAL_CODES.signInRequired, 'not_applied');
            }
          }
          await own.observe();
          const fingerprint = supportFingerprint({
            binding: owner,
            deployment,
            actorId: own.proof.identity.id,
            nativeSessionId: own.proof.sessionId,
            policy,
            intent: attempt.intent,
          });
          const scope = {
            actorId: own.proof.identity.id,
            tenantId: attempt.intent.tenantId,
            operation: attempt.intent.operation,
            operationVersion: 1,
            idempotencyKey: attempt.idempotencyKey,
          };
          const result = await opened.transact(final(own, opening), async (session, operations, assertCurrent) => {
            const active = () => {
              own.live();
              assertCurrent();
            };
            const outcome = await apply({
              facts: opened.facts(session, operations, active),
              audit: opened.audit(session, operations, active),
              journal: opened.journal(session, operations, active),
              login: own,
              active,
              scope,
              fingerprint,
            });
            applied = !outcome.replayed;
            return outcome;
          });
          await own.observe();
          return result;
        } catch (error) {
          throw failure(error, applied);
        }
      });
    const replay = async (
      journal: TenantAdministrationJournal,
      audit: SupportAuditOwner,
      own: Login,
      active: () => void,
      scope: Parameters<TenantAdministrationJournal['read']>[0],
      fingerprint: string,
      intent: SupportOpenIntent | SupportExitIntent,
    ) => {
      const stored = await journal.read(scope);
      active();
      if (!stored) return null;
      if (stored.fingerprint !== fingerprint) return denyTenant();
      const change = captureSupportChange(JSON.parse(stored.resultJson), intent);
      const header = await verified(audit, change, own.proof, active);
      return { receipt: receiptView(change, stored, header, own.live()), replayed: true };
    };

    const open = (request: IncomingMessage, input: SupportRequest<SupportOpenIntent>): Promise<SupportOutcome> => {
      let attempt: SupportRequest<SupportOpenIntent>;
      try {
        attempt = attemptInput(input, 'openSupport');
      } catch {
        return Promise.reject(refused());
      }
      const intent = attempt.intent;
      return mutate(request, attempt, async ({ facts, audit, journal, login: own, active, scope, fingerprint }) => {
        const again = await replay(journal, audit, own, active, scope, fingerprint, intent);
        if (again) return again;
        const accountId = own.proof.identity.id;
        const platform = await facts.platform();
        if (!platform || platform.status !== 'active') return denyTenant();
        const parentId = await facts.parentLocator(accountId);
        if (!parentId) return denyTenant();
        const previous = (await facts.supportLocators(accountId))[0];
        // Parents, then dealers, then support rows, each in byte order.
        const parents = new Map<string, SupportMember | null>();
        for (const id of sorted([parentId, previous?.parentId])) parents.set(id, await facts.member(id));
        const dealers = new Map<string, Awaited<ReturnType<SupportFacts['tenant']>>>();
        for (const id of sorted([intent.tenantId, previous?.tenantId])) dealers.set(id, await facts.tenant(id));
        const old = previous ? await facts.member(previous.id) : null;
        const instant = own.live(),
          parent = parents.get(parentId),
          dealer = dealers.get(intent.tenantId);
        if (
          !parent ||
          parent.kind !== 'member' ||
          parent.tenantId !== PLATFORM_TENANT_ID ||
          parent.accountId !== accountId ||
          parent.status !== 'active' ||
          instant >= parent.validUntil
        )
          return denyTenant();
        // One grant, matched whole: this platform role, this dealer, this dealer role.
        if (!dealer || dealer.status !== 'active' || !supportGranted(policy, parent.roles, intent.tenantId, intent.dealerRole))
          return denyTenant();
        const operatorName = names.displayName(own.proof);
        const requestId = randomUUID(),
          receiptId = randomUUID(),
          supportId = randomUUID();
        const openedAt = iso(instant);
        const validUntil = Math.min(instant + SUPPORT_LIFETIME_MS, own.proof.expiresAt, parent.validUntil);
        if (validUntil <= instant) return denyTenant();
        let replaced: { before: SupportPair; after: SupportPair } | null = null;
        if (previous) {
          // Supersession: the account's earlier session, whatever its dealer,
          // login or state, is closed in this same transaction. Cleanup, not
          // admission: its old parent and dealer need only be what it named.
          const oldParent = parents.get(previous.parentId!),
            oldDealer = dealers.get(previous.tenantId);
          if (
            !old ||
            !isDeepStrictEqual(old, previous) ||
            !oldParent ||
            oldParent.kind !== 'member' ||
            oldParent.tenantId !== PLATFORM_TENANT_ID ||
            oldParent.accountId !== accountId ||
            !oldDealer
          )
            return denyTenant();
          const header = await audit.readHeader(old.id);
          active();
          if (!header || header.session.endedAt !== null || !matches(old, header.session as SupportPair['session'])) return denyTenant();
          const before = pairOf(old, header.session as SupportPair['session']);
          await audit.audit.append(
            old.id,
            entry(
              'exit',
              openedAt,
              requestId,
              accountId,
              {
                tenantVersion: oldDealer.version,
                supportMembershipVersion: old.version,
                parentMembershipVersion: old.parentVersion!,
                platformVersion: old.platformVersion!,
              },
              { endReason: 'superseded' },
            ),
          );
          await facts.revokeSupport(old.id, old.version);
          replaced = { before, after: closed(before, openedAt, 'superseded') };
        }
        await facts.insertSupport({
          id: supportId,
          tenantId: intent.tenantId,
          accountId,
          role: intent.dealerRole,
          validUntil,
          parentId,
          parentVersion: parent.version,
          platformVersion: platform.version,
        });
        const session: SupportSession = {
          id: supportId,
          tenantId: intent.tenantId,
          accountId,
          operatorName,
          dealerRole: intent.dealerRole,
          parentMembershipId: parentId,
          parentMembershipVersion: parent.version,
          platformVersion: platform.version,
          reason: intent.reason,
          openedAt,
          validUntil,
          nativeSessionId: own.proof.sessionId,
          deployment,
          policyId: policy.id,
          policyVersion: policy.version,
          openReceiptId: receiptId,
        };
        await audit.audit.open(
          session,
          entry('open', openedAt, requestId, accountId, {
            tenantVersion: dealer.version,
            supportMembershipVersion: '1',
            parentMembershipVersion: parent.version,
            platformVersion: platform.version,
          }),
        );
        const inserted = {
          id: supportId,
          tenantId: intent.tenantId,
          accountId,
          kind: 'support' as const,
          status: 'active' as const,
          version: '1',
          roles: [intent.dealerRole],
          validUntil,
          parentId,
          parentVersion: parent.version,
          platformVersion: platform.version,
        };
        const change = captureSupportChange(
          { operation: 'openSupport', after: pairOf(inserted, { ...session, endedAt: null, endReason: null }), replaced },
          intent,
        );
        const resultJson = JSON.stringify(change);
        await journal.commit(
          { ...scope, id: receiptId, fingerprint, requestId, completedAt: openedAt, resultJson },
          { policyId: policy.id, policyVersion: policy.version, deployment, sessionId: own.proof.sessionId, changeJson: resultJson },
        );
        return {
          receipt: receiptView(change, { id: receiptId, completedAt: openedAt }, change.after.session, own.live()),
          replayed: false,
        };
      });
    };

    const exit = (request: IncomingMessage, input: SupportRequest<SupportExitIntent>): Promise<SupportOutcome> => {
      let attempt: SupportRequest<SupportExitIntent>;
      try {
        attempt = attemptInput(input, 'exitSupport');
      } catch {
        return Promise.reject(refused());
      }
      const intent = attempt.intent;
      return mutate(request, attempt, async ({ facts, audit, journal, login: own, active, scope, fingerprint }) => {
        const again = await replay(journal, audit, own, active, scope, fingerprint, intent);
        if (again) return again;
        const accountId = own.proof.identity.id;
        if (!(await facts.platform())) return denyTenant();
        const located = (await facts.supportLocators(accountId)).find((row) => row.id === intent.supportId);
        if (!located || located.tenantId !== intent.tenantId) return denyTenant();
        const parent = await facts.member(located.parentId!),
          dealer = await facts.tenant(located.tenantId);
        const row = await facts.member(located.id);
        const instant = own.live();
        // Ending one's own session needs no grant, active parent or active
        // dealer, only that they are what the session named. An expired
        // session is not revived to be exited.
        if (
          !row ||
          !isDeepStrictEqual(row, located) ||
          !parent ||
          parent.kind !== 'member' ||
          parent.tenantId !== PLATFORM_TENANT_ID ||
          parent.accountId !== accountId ||
          !dealer ||
          row.version !== intent.expectedSupportVersion ||
          row.status !== 'active' ||
          instant >= row.validUntil
        )
          return denyTenant();
        const header = await audit.readHeader(row.id);
        active();
        if (
          !header ||
          header.session.endedAt !== null ||
          header.session.nativeSessionId !== own.proof.sessionId ||
          !matches(row, header.session as SupportPair['session'])
        )
          return denyTenant();
        const before = pairOf(row, header.session as SupportPair['session']);
        const requestId = randomUUID(),
          receiptId = randomUUID(),
          endedAt = iso(own.live());
        await audit.audit.append(
          row.id,
          entry(
            'exit',
            endedAt,
            requestId,
            accountId,
            {
              tenantVersion: dealer.version,
              supportMembershipVersion: row.version,
              parentMembershipVersion: row.parentVersion!,
              platformVersion: row.platformVersion!,
            },
            { endReason: 'exit' },
          ),
        );
        await facts.revokeSupport(row.id, row.version);
        const change = captureSupportChange({ operation: 'exitSupport', before, after: closed(before, endedAt, 'exit') }, intent);
        const resultJson = JSON.stringify(change);
        await journal.commit(
          { ...scope, id: receiptId, fingerprint, requestId, completedAt: endedAt, resultJson },
          { policyId: policy.id, policyVersion: policy.version, deployment, sessionId: own.proof.sessionId, changeJson: resultJson },
        );
        return { receipt: receiptView(change, { id: receiptId, completedAt: endedAt }, change.after.session, own.live()), replayed: false };
      });
    };

    const status = (request: IncomingMessage, input: SupportStatusRequest): Promise<SupportStatus> => {
      let expectedAccount: string, attempt: SupportStatusRequest['attempt'];
      try {
        const value = captureTenantData(input);
        tenantRecord(value, ['expectedAccount', 'attempt']);
        supportText(value.expectedAccount);
        expectedAccount = value.expectedAccount;
        if (Object.hasOwn(value, 'attempt')) {
          const inner = captureTenantData(value.attempt);
          tenantRecord(inner, ['idempotencyKey', 'intent']);
          if (Object.keys(inner).length !== 2) return Promise.reject(refused('unknown'));
          identifier(inner.idempotencyKey);
          attempt = { idempotencyKey: inner.idempotencyKey, intent: captureSupportIntent(inner.intent) };
        }
      } catch {
        return Promise.reject(refused('unknown'));
      }
      return tracked(async () => {
        try {
          const own = await login(request, expectedAccount);
          await own.observe();
          const accountId = own.proof.identity.id;
          let signInRequired = false;
          try {
            age.assertAge(own.proof, own.live(), SUPPORT_OPENING_AGE_MS);
          } catch {
            signInRequired = true;
          }
          const result = await opened.transact(final(own, false), async (session, operations, assertCurrent) => {
            const active = () => {
              own.live();
              assertCurrent();
            };
            const facts = opened.facts(session, operations, active),
              audit = opened.audit(session, operations, active);
            let recovered: SupportReceiptView | null | undefined;
            if (attempt) {
              // Its own receipt scope first; never another attempt's.
              const journal = opened.journal(session, operations, active);
              const fingerprint = supportFingerprint({
                binding: owner,
                deployment,
                actorId: accountId,
                nativeSessionId: own.proof.sessionId,
                policy,
                intent: attempt.intent,
              });
              recovered =
                (
                  await replay(
                    journal,
                    audit,
                    own,
                    active,
                    {
                      actorId: accountId,
                      tenantId: attempt.intent.tenantId,
                      operation: attempt.intent.operation,
                      operationVersion: 1,
                      idempotencyKey: attempt.idempotencyKey,
                    },
                    fingerprint,
                    attempt.intent,
                  )
                )?.receipt ?? null;
            }
            const platform = await facts.platform();
            const parentId = await facts.parentLocator(accountId);
            const located = (await facts.supportLocators(accountId))[0];
            const parents = new Map<string, SupportMember | null>();
            for (const id of sorted([parentId, located?.parentId])) parents.set(id, await facts.member(id));
            const dealer = located ? await facts.tenant(located.tenantId) : null;
            const row = located ? await facts.member(located.id) : null;
            let current: SupportSessionView | null = null;
            if (located) {
              if (!row || !isDeepStrictEqual(row, located)) return denyTenant();
              const header = await audit.readHeader(row.id);
              active();
              if (!header || !matches(row, header.session as SupportPair['session'])) return denyTenant();
              const at = own.live();
              let over = header.session.endedAt !== null;
              /* An expired session has an owner: this call. Status already holds
                 the locks in the order every support fence takes, has just read
                 this row and its header, and is what the banner polls, so a
                 session cannot outlive its thirty minutes waiting for a
                 scheduler. It closes any expired session of THIS ACCOUNT,
                 whichever login opened it: the row admits nothing past its
                 validUntil, and leaving it active only hides the account's next
                 opening behind a supersession. `expired` is the clock's reason;
                 `superseded` stays what a new opening does to a live session.
                 No receipt: there is no operator intent and no idempotency key
                 here, and the chain's own exit entry is the durable record. A
                 dealer that has gone is left alone — its version could not be
                 recorded faithfully, and the fence already refuses the lease. */
              if (!over && at >= row.validUntil && dealer) {
                const endedAt = iso(at);
                await audit.audit.append(
                  row.id,
                  entry(
                    'exit',
                    endedAt,
                    randomUUID(),
                    row.accountId,
                    {
                      tenantVersion: dealer.version,
                      supportMembershipVersion: row.version,
                      parentMembershipVersion: row.parentVersion!,
                      platformVersion: row.platformVersion!,
                    },
                    { endReason: 'expired' },
                  ),
                );
                active();
                await facts.revokeSupport(row.id, row.version);
                over = true;
              }
              // Another login's session is not this login's to resume.
              if (header.session.nativeSessionId === own.proof.sessionId) {
                const parent = parents.get(row.parentId!);
                const fenced =
                  !over &&
                  platform?.status === 'active' &&
                  platform.version === row.platformVersion &&
                  parent?.kind === 'member' &&
                  parent.status === 'active' &&
                  parent.version === row.parentVersion &&
                  at < parent.validUntil &&
                  dealer?.status === 'active';
                current = view(pairOf(row, header.session as SupportPair['session']), header.session as SupportPair['session'], at, fenced);
              }
            }
            const parent = parentId ? parents.get(parentId) : null,
              instant = own.live();
            const choices = new Map<string, Set<string>>();
            if (
              platform?.status === 'active' &&
              parent &&
              parent.kind === 'member' &&
              parent.tenantId === PLATFORM_TENANT_ID &&
              parent.accountId === accountId &&
              parent.status === 'active' &&
              instant < parent.validUntil
            ) {
              const grants = policy.grants.filter((grant) => parent.roles.includes(grant.platformRole));
              // Unlocked and advisory: opening rechecks the dealer under its lock.
              const active = grants.length ? await facts.activeTenants(1000) : [];
              for (const grant of grants) {
                for (const tenantId of active) {
                  if (grant.tenants !== 'all' && !grant.tenants.includes(tenantId)) continue;
                  const roles = choices.get(tenantId) ?? new Set<string>();
                  for (const role of grant.dealerRoles) roles.add(role);
                  choices.set(tenantId, roles);
                }
              }
            }
            return {
              session: current,
              recovered,
              choices: [...choices.keys()]
                .sort(utf8)
                .slice(0, 200)
                .map((tenantId) => ({ tenantId, roles: [...choices.get(tenantId)!].sort(utf8) })),
            };
          });
          await own.observe();
          // A login an identity provider opened is confirmed there, afresh; never by a password.
          const provider = signInRequired ? stepUp.provider(own.proof) : undefined;
          return captureTenantData({
            session: result.session,
            choices: result.choices,
            signInRequired,
            passwordSignIn: passwordSignIn && provider === undefined,
            ...(provider ? { reauthenticate: provider } : {}),
            ...(provider && app.auth?.providers?.includes(`saml:${provider}`) ? { reauthenticateKind: 'saml' as const } : {}),
            ...(attempt ? { recovered: result.recovered ?? null } : {}),
          });
        } catch (error) {
          throw failure(error, true);
        }
      });
    };

    const admit = (request: IncomingMessage, input: SupportTarget): Promise<SupportMembershipEvidence> => {
      let target: SupportTarget;
      try {
        const value = captureTenantData(input);
        tenantRecord(value, ['realm', 'tenantId', 'supportId']);
        if (value.realm !== 'support') return denyTenant();
        supportText(value.tenantId, 128);
        supportText(value.supportId);
        target = value as unknown as SupportTarget;
      } catch {
        return Promise.reject(refused());
      }
      return tracked(async () => {
        try {
          const own = await login(request);
          await own.observe();
          const evidence = await opened.transact(final(own, false), async (session, operations, assertCurrent) => {
            const active = () => {
              own.live();
              assertCurrent();
            };
            const at = own.live();
            const observed = await opened.observe(session, {
              supportId: target.supportId,
              accountId: own.proof.identity.id,
              tenantId: target.tenantId,
              at,
            });
            active();
            const header = await opened.audit(session, operations, active).readHeader(target.supportId);
            active();
            const fixed = header?.session;
            if (
              !fixed ||
              fixed.endedAt !== null ||
              fixed.nativeSessionId !== own.proof.sessionId ||
              fixed.accountId !== observed.accountId ||
              fixed.tenantId !== observed.tenantId ||
              observed.roles.length !== 1 ||
              fixed.dealerRole !== observed.roles[0] ||
              fixed.parentMembershipId !== observed.parentId ||
              fixed.parentMembershipVersion !== observed.parentVersion ||
              fixed.platformVersion !== observed.platformVersion ||
              fixed.validUntil !== observed.supportValidUntil ||
              fixed.policyId !== policy.id ||
              fixed.policyVersion !== policy.version
            )
              return denyTenant();
            return issueSupportEvidence({
              realm: 'support',
              appId: owner.appId,
              accountId: observed.accountId,
              source: { id: owner.source.id, connection: owner.source.connection },
              deployment,
              tenantId: observed.tenantId,
              supportId: observed.supportId,
              membershipId: observed.supportId,
              membershipVersion: observed.supportVersion,
              tenantVersion: observed.tenantVersion,
              parentId: observed.parentId,
              parentVersion: observed.parentVersion,
              platformVersion: observed.platformVersion,
              roles: [...observed.roles],
              verifiedAt: at,
              validUntil: observed.validUntil,
            });
          });
          await own.observe();
          if (own.live() >= evidence.validUntil) return denyTenant();
          return evidence;
        } catch {
          throw refused();
        }
      });
    };

    /* The read ledger. Its fence is the one `admit` takes, in the same lock
       order, because a read is recorded against the very session that made it:
       an operator whose parent was revoked, whose dealer went inactive or whose
       own row moved has no session to record against, and is refused.

       It commits before it resolves. That is the whole point: a caller awaits
       this with the answer in hand and releases nothing until it settles, so a
       read that could not be recorded is a read whose body is never sent. */
    const ledgerRead = (request: IncomingMessage, input: SupportReadRequest): Promise<void> => {
      let asked: SupportReadRequest;
      try {
        const value = captureTenantData(input);
        tenantRecord(value, ['tenantId', 'supportId', 'detail']);
        supportText(value.tenantId, 128);
        supportText(value.supportId);
        tenantRecord(value.detail);
        asked = value as unknown as SupportReadRequest;
        /* Bounded here, before the entry is built, so an oversized or
           unserialisable description is refused for what it is rather than
           surfacing later as a storage size accident. The store's own limit
           still guards the row; this refuses earlier and more plainly. */
        const said = JSON.stringify(asked.detail);
        if (typeof said !== 'string' || Buffer.byteLength(said, 'utf8') > SUPPORT_DETAIL_BYTES.read) return Promise.reject(refused());
      } catch {
        return Promise.reject(refused());
      }
      return tracked(async () => {
        try {
          const own = await login(request);
          await own.observe();
          await opened.transact(final(own, false), async (session, operations, assertCurrent) => {
            const active = () => {
              own.live();
              assertCurrent();
            };
            const at = own.live();
            const observed = await opened.observe(session, {
              supportId: asked.supportId,
              accountId: own.proof.identity.id,
              tenantId: asked.tenantId,
              at,
            });
            active();
            const audit = opened.audit(session, operations, active);
            const header = await audit.readHeader(asked.supportId);
            active();
            const fixed = header?.session;
            if (
              !fixed ||
              fixed.endedAt !== null ||
              fixed.nativeSessionId !== own.proof.sessionId ||
              fixed.accountId !== observed.accountId ||
              fixed.tenantId !== observed.tenantId ||
              observed.roles.length !== 1 ||
              fixed.dealerRole !== observed.roles[0] ||
              fixed.parentMembershipId !== observed.parentId ||
              fixed.parentMembershipVersion !== observed.parentVersion ||
              fixed.platformVersion !== observed.platformVersion ||
              fixed.validUntil !== observed.supportValidUntil ||
              fixed.policyId !== policy.id ||
              fixed.policyVersion !== policy.version
            )
              return denyTenant();
            // A read names no resource, operation or key: the store's rule for
            // every kind that is not a write. What was read is in the detail.
            await audit.audit.append(asked.supportId, {
              kind: 'read',
              at: iso(own.live()),
              requestId: randomUUID(),
              actorId: observed.accountId,
              tenantVersion: observed.tenantVersion,
              supportMembershipVersion: observed.supportVersion,
              parentMembershipVersion: observed.parentVersion,
              platformVersion: observed.platformVersion,
              resource: null,
              operation: null,
              keyJson: null,
              detailJson: JSON.stringify(asked.detail),
              commandReceiptId: null,
            });
            active();
          });
          await own.observe();
        } catch {
          throw refused();
        }
      });
    };

    const holds = (request: IncomingMessage): Promise<boolean> =>
      tracked(async () => {
        try {
          const proof = await auth.sessionInstance(request);
          if (!proof) return false;
          const own = await login(request, proof.identity.id);
          return await opened.transact(final(own, false), async (session, operations, assertCurrent) => {
            const active = () => {
              own.live();
              assertCurrent();
            };
            const located = await opened.facts(session, operations, active).supportLocators(own.proof.identity.id);
            return located.some((row) => own.live() < row.validUntil);
          });
        } catch {
          return true;
        }
      });

    /**
     * Stored support history, for a reader whose right to it the caller has
     * already established. `tenantId` is that proof made concrete: the caller
     * passes the tenant its own lease admitted it to, never a tenant named in
     * a request, and the filter is applied in SQL. Passing null reads every
     * dealer's, which only the platform realm's audit view may ask for.
     *
     * The native login is re-checked here as every other owner operation
     * re-checks it, so a log cannot be read by a session that has since gone.
     * It appends nothing: reading a log is not itself a support event.
     */
    const readLog = (request: IncomingMessage, tenantId: string | null): Promise<SupportLogRows> => {
      if (tenantId !== null) supportText(tenantId, 128);
      return tracked(async () => {
        try {
          const own = await login(request);
          await own.observe();
          const rows = await opened.transact(final(own, false), async (session) => {
            own.live();
            return opened.log(session, tenantId);
          });
          await own.observe();
          return rows;
        } catch {
          throw refused();
        }
      });
    };
    /**
     * Every dealer's stored history, with the operators' addresses, for the
     * lender's own audit view. The email is looked up now rather than recorded
     * then: the audit session deliberately keeps the display name only, so
     * that the record a dealer reads cannot carry an address.
     *
     * The caller must already have established that this reader holds the
     * platform realm's `supportAudit`; this composes, it does not authorize.
     */
    const readAudit = (request: IncomingMessage): Promise<{ rows: SupportLogRows; emails: Readonly<Record<string, string | null>> }> =>
      tracked(async () => {
        const rows = await readLog(request, null);
        const emails: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
        try {
          for (const accountId of new Set(rows.sessions.map((row) => row.accountId))) {
            emails[accountId] = await nativeAccountEmailOf(runtime, accountId);
          }
        } catch {
          throw refused();
        }
        return { rows, emails };
      });
    return Object.freeze({ status, open, exit, admit, holds, ledgerRead, readLog, readAudit, retire });
  } catch {
    try {
      await store?.close();
    } catch {
      /* Nothing was published. */
    }
    throw refused();
  }
}
