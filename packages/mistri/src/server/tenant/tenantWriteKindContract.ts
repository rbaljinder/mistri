/**
 * What one kind of tenant writer transaction supplies. The engines in
 * tenantWriteSource.ts own the serial queue, the lifetime clock, catalog
 * attestation, the verified transaction and outcome classification; each kind
 * (one module per kind, listed in tenantWriteKinds.ts) owns what its evidence
 * means there: its source methods, its capture, the scope it runs over, its
 * fence on each engine, its journal owner and its managed transaction.
 */
import { recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import { AppValidationDenied } from '../app/appValidationDenied.js';
import { appError } from '../app/appErrors.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TransactionOperations, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { SupportAuditKey, SupportEntry } from './tenantSupportAuditContract.js';
import type { CommandJournal, CommandJournalPlatform, CommandJournalTenant } from '../../adapters/commands/commandJournalTypes.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { TenantStoreBinding } from './tenantStoreContract.js';

export class TenantWriteFailure extends Error {
  readonly code = 'tenant_write_unavailable';
  constructor(
    readonly outcome: 'not_applied' | 'unknown',
    /** The App's rules refusing the record (appValidation.ts), by field name with the rule's fixed sentence:
     * the one context a refused tenant write says, since it is the person's to fix and holds no value. */
    readonly fields?: readonly { field: string; message: string }[],
  ) {
    super('The tenant write could not be completed.');
    this.name = 'TenantWriteFailure';
  }
}
/* The writer's refusal is value-free on purpose: it says a write could not be
   completed and whether it was applied, and nothing about the database, the
   path or the row — every caller of a tenant writer is answered from it. But
   the error that caused it was being dropped at the throw, and a platform
   whose write path refuses without recording why has cost App authors days
   apiece on this release: `tenant_write_unavailable`, no cause, nothing to
   read. So the reason is recorded on the refusal the way a tenant admission
   refusal already records its own — symbol-keyed and non-enumerable, so
   `'cause' in error` stays false, JSON ignores it, and only an owner holding
   the reader (refusalCause) can see it. Nothing a caller receives
   changes. */
export const tenantWriteFailed = (outcome: 'not_applied' | 'unknown', cause: unknown): TenantWriteFailure =>
  recordRefusalCause(new TenantWriteFailure(outcome, outcome === 'not_applied' ? refusedFields(cause) : undefined), cause);

/** The fields the App's rules refused a record on, from the refusal or from a tenant refusal that already carries them. */
export function refusedFields(cause: unknown): TenantWriteFailure['fields'] {
  if (cause instanceof AppValidationDenied) return cause.fields.length ? appError(cause, 'write').fields : undefined;
  return cause instanceof TenantWriteFailure ? cause.fields : undefined;
}

/** Public intake's writer found, before the handler ran, that what resolution
 * read had moved — the address rotated, the tenant or the platform suspended.
 * Nothing was applied; the runtime resolves once more. */
export class TenantIntakeMoved extends TenantWriteFailure {
  constructor() {
    super('not_applied');
    this.name = 'TenantIntakeMoved';
  }
}

/** The admission lifetime every kind's evidence carries; the source's clock must stay within it. */
export interface TenantWriteEvidence {
  readonly verifiedAt: number;
  readonly validUntil: number;
}
export type TenantWriteRun<T> = (records: WriteTransaction, journal?: CommandJournal) => T | Promise<T>;
/**
 * Which operation of the host's ran, for a kind that records one. It is set by
 * the runtime that performed it — Undo says so because `undo()` is what called
 * — never by anything a request carries, so it is a fact about what happened
 * rather than a claim to be trusted. A kind that records nothing ignores it,
 * and absent it means an ordinary write.
 */
export type TenantWriteOperation = 'write' | 'undo';
/** The engine's one transaction, bound to a kind: what that kind's source methods call. */
type TenantWriteEnter<Evidence> = <T>(
  command: boolean,
  evidence: Evidence,
  rows: RowScope,
  run: TenantWriteRun<T>,
  assertActive?: () => void,
  operation?: TenantWriteOperation,
  footprint?: readonly string[],
) => Promise<T>;
/** The writer's own facts a fence reads, never a request's: its store binding,
 * its attested ownership and its lifetime check. */
export interface TenantWriteFence {
  readonly owner: TenantStoreBinding;
  readonly owned: TenantOwnershipSnapshot;
  live(): number;
}
/**
 * Where a kind records what its transaction did, on the transaction's own
 * handle, so the record and the business write are one commit or neither.
 *
 * The engine opens it in the verifier — the one place that holds the raw
 * handle — and hands it to `run`; the logical write path never sees a handle.
 * It runs on a queue of its own, NOT the managed transaction's: a refused
 * operation poisons the queue it ran on, so a failed append must be allowed
 * to fail this transaction through its own drain rather than break the
 * business facade's queue underneath the handler. For the same reason nothing
 * here catches an append: a caught failure would still surface at the drain.
 */
export interface TenantWriteSink {
  append(entry: SupportEntry): Promise<void>;
}
/**
 * What a source that records was opened with: the audit key, and which columns
 * each resource keeps as a keyed hash rather than as their value
 * (`resources.<r>.audit`). It is threaded from enrollment because the
 * redaction rule is the App's, and the ownership snapshot the engine holds
 * carries schema and ownership only. Absent, no sink is ever opened, so a
 * deployment without the key cannot write an unaudited support change: it
 * cannot write one at all.
 */
export interface TenantWriteAudit {
  readonly key: SupportAuditKey;
  readonly redact: Readonly<Record<string, 'values' | readonly string[]>>;
}
export interface TenantWriteKind<Evidence extends TenantWriteEvidence, Methods extends object> {
  /** The evidence's own `realm` data property that routes to this kind. A
   * tenant member's evidence has none, and routes to 'tenant'. */
  readonly realm: string;
  /** The source methods this kind answers. Each receives only its own realm's evidence. */
  methods(enter: TenantWriteEnter<Evidence>): Methods;
  /** Before the writer's queue: a throw here is not_applied, with no transaction. */
  capture(evidence: Evidence, rows: RowScope, owned: TenantOwnershipSnapshot): { readonly evidence: Evidence; readonly rows: RowScope };
  /** The logical scope the transaction runs over, composed from the evidence. */
  scope(owned: TenantOwnershipSnapshot, evidence: Evidence, rows: RowScope, allTrue: RowScope): RowScope;
  /** A command transaction's outer bound (scopedTransaction.ts ScopeBound): the
   * tenant's rows within the command's footprint, whatever the principal's own
   * rows narrow. A kind without one keeps every scoped check on its scope. */
  bound?(
    owned: TenantOwnershipSnapshot,
    evidence: Evidence,
    rows: RowScope,
    footprint: readonly string[] | undefined,
    allTrue: RowScope,
  ): RowScope | undefined;
  /** Inside BEGIN IMMEDIATE, on the writer's own handle: no second reader or connection. */
  sqliteFence(db: DatabaseSync, evidence: Evidence, fence: TenantWriteFence): void;
  /** On the writer's client, after the scope's tables are pinned; its locks hold to COMMIT. */
  postgresFence(client: PgQuery, evidence: Evidence, fence: TenantWriteFence): Promise<void>;
  /** Its fence reads only rows it locks FOR SHARE, held to COMMIT, and judges time only by the evidence's own lifetime:
   * a second pass in the same transaction, the rows still locked, needs only the lifetime (tenantWriteSource.ts). */
  readonly postgresFenceHeld?: true;
  /** The statements `postgresFence` sends on a transaction that keeps its store attested, exactly, to be sent ahead
   * behind the BEGIN (writeAhead.ts); a kind without it sends its fence in its turn. */
  postgresFenceAhead?(owner: TenantStoreBinding, evidence: Evidence): readonly (string | { text: string; values: readonly unknown[] })[];
  /** Open this kind's sink on the transaction's own handle, for a kind that
   * records what it did. Called once, inside the verifier, before the handler
   * runs; the engine drains the queue it is given before COMMIT. A kind
   * without a sink omits both, and `run` receives none. */
  sqliteSink?(
    db: DatabaseSync,
    evidence: Evidence,
    fence: TenantWriteFence,
    operations: TransactionOperations,
    audit: TenantWriteAudit,
  ): TenantWriteSink;
  postgresSink?(
    client: PgQuery,
    evidence: Evidence,
    fence: TenantWriteFence,
    operations: TransactionOperations,
    audit: TenantWriteAudit,
  ): TenantWriteSink;
  /** The provenance the command journal records, from the evidence alone. */
  journalOwner(owner: TenantStoreBinding, evidence: Evidence): CommandJournalTenant | CommandJournalPlatform;
  /** The managed transaction over the source's logical records. A kind that
   * declared a sink receives the one the engine opened for this transaction. */
  run<T>(
    owned: TenantOwnershipSnapshot,
    evidence: Evidence,
    records: WriteTransaction,
    journal: CommandJournal | undefined,
    command: boolean,
    run: TenantWriteRun<T>,
    sink?: TenantWriteSink,
    operation?: TenantWriteOperation,
  ): Promise<T>;
  /** For a kind whose fence rereads an anchor that can move after resolution:
   * a fence failure before the handler starts is this refusal instead. */
  moved?(): TenantWriteFailure;
}

/** A tenant's rows reference its profile (`tenancy.profile`) by their owner
 * column, so the writer's parent checks must see that one platform row: the
 * tenant's own profile, and nothing else of the platform realm. Reads never
 * see it; the command footprint and generic grants stay as they are. */
export function withOwnProfile(owned: TenantOwnershipSnapshot, scope: RowScope, tenantId: string): RowScope {
  const profile = owned.profile;
  if (profile === undefined) return scope;
  const columns = [
    ...new Set(
      owned.schema.foreignKeys
        .filter((fk) => fk.to.table === profile && owned.ownership[fk.from.table]?.kind === 'tenant')
        .map((fk) => fk.to.columns[0]),
    ),
  ];
  if (!columns.length) return scope;
  return { ...scope, [profile]: { groups: columns.map((column) => [{ column, op: '=' as const, value: tenantId }]) } };
}
