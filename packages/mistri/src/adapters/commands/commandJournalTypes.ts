import type { MakerKind, ProposalState, ReceiptActorKind } from './commandJournalSchema.js';
import type { CommandEventBatch, CommandEventManifest } from '../events/commandEventTypes.js';
import type { PublicPlacementAdmission, PublicPlacementOwner, PublicPlacementRun } from './publicPlacementTypes.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { TriggerAcceptance } from '@mistriwork/engine/adapters/storeHost.js';
import type { StagedFileRow, StagedLimits, StagedTake, TakenFile } from './commandStaging.js';
import type { ReadAuditRow } from '../readAudit/readAudit.js';

/** Portable contracts only; SQLite storage and migration live in commandJournal.ts. */
/** Bound by the private source owner, never supplied in receipt/lookup DTOs.
 * Execution provenance is not part of durable idempotency uniqueness. */
export interface CommandJournalTenant {
  readonly appId: string;
  readonly storeId: string;
  readonly sourceId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly tenantVersion: string;
  readonly roles: readonly string[];
  readonly deployment: string;
}

/** The platform realm's source owner: a platform membership in a tenant's
 * place. Its receipts share the store and source under realm `platform`,
 * with no tenant; each audit row names the owner of its target row. */
export interface CommandJournalPlatform {
  readonly realm: 'platform';
  readonly appId: string;
  readonly storeId: string;
  readonly sourceId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly membershipVersion: string;
  readonly platformVersion: string;
  readonly roles: readonly string[];
  readonly deployment: string;
}

/** An App-scope command's event source: the App's own event store, issued
 * by trusted startup code. Receipts keep the ordinary empty namespace, so
 * binding a journal to it changes no replay; only event batches carry it. */
export interface CommandJournalAppScope {
  readonly scope: 'app';
  readonly appId: string;
  readonly storeId: string;
  readonly sourceId: string;
}

export interface CommandReceiptScope {
  appId: string;
  actorId: string;
  commandId: string;
  commandVersion: number;
  idempotencyKey: string;
}

export interface StoredCommandReceipt extends CommandReceiptScope {
  id: string;
  fingerprint: string;
  resultJson: string;
  requestId: string;
  completedAt: string;
  /** Who the command ran for, by kind: a person when absent. Written, never read back into the receipt. */
  actorKind?: ReceiptActorKind;
  /** The proposal an approval ran this command from (commandProposals.ts). */
  proposalId?: string;
}

/** One target's row. A receipt has one per target, in request order: a
 * single-target command one, a multi-target command one for each key.
 * `owner` is the tenant that owns the target row, which the server reads
 * from the stored row: required in the platform realm ('' for a
 * platform-owned target), and in a tenant's realm, if given, that tenant.
 * `changesJson` is the target's first changes and `changesParts` the rest, in
 * order, each a JSON array text (commandAuditParts.ts); a target with few
 * changes has no parts. */
export interface CommandAudit {
  target: string;
  keyJson: string;
  changesJson: string;
  changesParts?: readonly string[];
  owner?: string;
}

/** One capability link as the journal keeps it (server/links/): its scope, expiry, uses left and revocation, never its
 * secret. Times are epoch milliseconds; `tenant` is '' outside a tenant. */
export interface CommandLinkRow {
  id: string;
  app: string;
  tenant: string;
  resource: string;
  rowKey: string;
  name: string;
  expiresAt: number;
  /** Null for a link with no use limit. */
  usesLeft: number | null;
  revokedAt: number | null;
  createdAt: number;
  createdBy: string;
  command: string;
  receipt: string;
  opens: number;
  lastOpenedAt: number | null;
  /** What the record was when the link was minted, where the App says (layout 4): a link whose record no longer
   * carries it names a different record that took the same key. Null, or absent on a mint, where none is kept. */
  rowStamp?: string | null;
}

/** One source a proposal or a provenance mark was made from: a record it read, a passage, a file, or a page. */
export interface ProposalEvidence {
  kind: 'record' | 'text' | 'file' | 'url';
  ref: string;
  label: string;
  quote?: string;
}

/** A command invocation a non-person maker prepared and a person decides (commandProposals.ts). Times are epoch
 * milliseconds; `tenant` is '' outside a tenant. */
export interface CommandProposalRow {
  id: string;
  app: string;
  tenant: string;
  command: string;
  /** The record key as canonical JSON, or null for a command that names none (a create). */
  target: string | null;
  input: Record<string, unknown>;
  actorKind: MakerKind;
  actor: string;
  model: string | null;
  modelVersion: string | null;
  costMicros: number | null;
  evidence: readonly ProposalEvidence[];
  reason: string;
  state: ProposalState;
  decidedBy: string | null;
  decidedAt: number | null;
  receiptId: string | null;
  createdAt: number;
  expiresAt: number;
}

/** What a conditional decision answered: decided now, unknown (or another command's), past its time, or decided before. */
export type ProposalDecision = 'decided' | 'missing' | 'expired' | 'taken';

/** A mark on a row (`field` null) or one of its fields that a non-person write made; unconfirmed until a person confirms. */
export interface ProvenanceRow {
  id: string;
  app: string;
  tenant: string;
  resource: string;
  rowKey: string;
  field: string | null;
  actorKind: MakerKind;
  actor: string;
  evidence: readonly ProposalEvidence[];
  createdAt: number;
  confirmedBy: string | null;
  confirmedAt: number | null;
}

export interface CommandJournal {
  /** Omission requires no associated event batch; a mismatch never permits regeneration. */
  find(scope: CommandReceiptScope, expectedManifest?: CommandEventManifest): Promise<StoredCommandReceipt | undefined>;
  /** Effects, receipt, audit and optional events share the owner's transaction.
   * A list is one audit row per target, stored with its position; an event
   * batch belongs to exactly one. */
  commit(receipt: StoredCommandReceipt, audit: CommandAudit | readonly CommandAudit[], eventBatch?: CommandEventBatch): Promise<void>;
  /** The next number of the App's sequence `name` (per `per`), in the owner's
   * transaction and this journal's namespace (commandSequences.ts). Absent
   * where the store keeps no sequences; a handler's nextNumber then refuses.
   * `start` is the least number this call may take: the handler's start, or
   * past the highest its rows already hold. */
  nextNumber?(appId: string, name: string, per: string, start: number): Promise<number>;
  /** Holds one file for a command, in the owner's transaction and this journal's namespace (commandStaging.ts),
   * unless its sender holds `most` already. Absent where the store holds no files; a form's files are then refused. */
  stage?(appId: string, row: StagedFileRow, most: StagedLimits, now: number): Promise<void>;
  /** Takes held files for the command running in the owner's transaction: every one, deleted, or none and refused
   * (StagedFileRefused). A rollback holds them again. */
  takeStaged?(appId: string, take: StagedTake): Promise<readonly TakenFile[]>;
  /** A command's own reads of an audited resource (route `command`), written in the owner's transaction to the read
   * audit of this database: kept with the command or rolled back with it. Absent where the store keeps no read audit;
   * a handler's audited read then fails its command (server/readAudit.ts auditCommandRead). */
  appendReadAudit?(rows: readonly ReadAuditRow[]): Promise<void>;
  /**
   * Whether a receipt under this scope is there, in one statement and taking
   * no lock: the check before a handler runs on the path that keeps receipts
   * without the receipt-first ceremony. A taken scope is then looked up in
   * full, and replayed, by the receipt-first path.
   */
  taken?(scope: CommandReceiptScope): Promise<boolean>;
  /**
   * The receipt and its audit rows, written unless the request's receipt is
   * already there — the replay check folded into the write. True when written; false when a receipt under the same scope was
   * committed first (or is being: the unique index waits for it), which the
   * caller answers as that receipt's replay. No events: a command that
   * records them keeps find-then-commit.
   */
  insert?(receipt: StoredCommandReceipt, audit: CommandAudit | readonly CommandAudit[]): Promise<boolean>;
  /**
   * Whether any receipt of this App's command at this version is kept, in
   * one statement: a receipt is a durable dependent of the command's
   * contract, which `mistri check` asks before it lets the contract change
   * at the same version (commandContracts.ts). Reads no receipt's contents.
   */
  kept?(appId: string, commandId: string, commandVersion: number): Promise<boolean>;
  /** Writes a capability link a command minted, in the owner's transaction: kept with the command or rolled back with
   * it. Absent where the store keeps no links; a handler's link() then refuses. */
  mintLink?(row: CommandLinkRow): Promise<void>;
  /** Revokes the live links of one row (of one declared name, or every name), in the owner's transaction. The count revoked. */
  revokeLinks?(appId: string, resource: string, rowKey: string, name: string | undefined, now: number): Promise<number>;
  /** How many links of one row still open, in the owner's transaction. */
  countLinks?(appId: string, resource: string, rowKey: string, now: number): Promise<number>;
  /** Opens a live link: one statement that takes a use (where it counts them) and records the open, so two opens of a
   * single-use link take it once. Undefined for a link that is unknown, revoked, expired or used up. */
  openLink?(appId: string, id: string, now: number): Promise<CommandLinkRow | undefined>;
  /** A live link, read without taking a use: what a run under an opened link checks. */
  readLink?(appId: string, id: string, now: number): Promise<CommandLinkRow | undefined>;
  /** Writes a proposal, in the owner's transaction. Absent where the store keeps none; proposing then refuses. */
  createProposal?(row: CommandProposalRow): Promise<void>;
  /** One proposal of this App, whatever its state. */
  readProposal?(appId: string, id: string): Promise<CommandProposalRow | undefined>;
  /** Proposals of the named commands (none named, none listed), newest first. */
  listProposals?(
    appId: string,
    query: { commands: readonly string[]; states?: readonly ProposalState[]; limit: number },
  ): Promise<CommandProposalRow[]>;
  /** Takes a proposal out of 'proposed' in one conditional statement, so of two decisions at once one decides. A
   * proposal found past its time is marked expired and answered so. */
  decideProposal?(
    appId: string,
    id: string,
    command: string,
    state: 'approved' | 'dismissed' | 'failed',
    by: string,
    now: number,
  ): Promise<ProposalDecision>;
  /** Names the receipt an approved proposal's run wrote, in that run's transaction. */
  settleProposal?(appId: string, id: string, receiptId: string): Promise<boolean>;
  /** Marks every proposal of this App past its time expired. The count marked. */
  expireProposals?(appId: string, now: number): Promise<number>;
  /** Writes a provenance mark, in the owner's transaction. */
  markProvenance?(row: ProvenanceRow): Promise<void>;
  /**
   * Confirms the unconfirmed marks of one row (one field and the row's own, or every mark where no field is named). The
   * count confirmed. `atCommit` is a caller that reads no count (a run settling what it wrote): a writer that pipelines
   * sends the statement with the transaction's COMMIT, in its round trip, and answers 0.
   */
  confirmProvenance?(
    appId: string,
    resource: string,
    rowKey: string,
    field: string | readonly string[] | undefined,
    by: string,
    now: number,
    atCommit?: boolean,
  ): Promise<number>;
  /** The unconfirmed marks of one row, oldest first; with no row, the resource's newest (For review lists them). */
  unconfirmedProvenance?(appId: string, resource: string, rowKey: string | null): Promise<ProvenanceRow[]>;
}

/*
 * What an adapter that hosts the command journal offers (the dialect classes,
 * and the App's facades over them), declared onto the engine's Adapter here:
 * the engine's interface names none of the App's command or placement types,
 * and every method is optional, so an adapter without the App framework is
 * whole without them.
 */
declare module '@mistriwork/engine/adapters/adapter.js' {
  interface Adapter {
    /** Same-source records and durable command receipt/audit, after explicit
     * migration. `events` binds the journal to the App's issued event source,
     * for a command that declares events; no request can supply it. */
    commandTransaction?<T>(
      run: (records: WriteTransaction, journal: CommandJournal) => Promise<T>,
      events?: CommandJournalAppScope,
    ): Promise<T>;

    /** Private runtime-only composition: scoped records, journal and fresh catalog
     * evidence share one physical transaction. The caller owns current command/
     * receipt authorization; never expose the journal to a business handler.
     * No fallback to separate scopeTransaction/commandTransaction calls.
     * `events`, as for commandTransaction: the App's issued event source, for a
     * command that declares events. */
    scopeCommandTransaction?<T>(
      scope: RowScope,
      run: (records: WriteTransaction, journal: CommandJournal, catalog: DatabaseSchema) => Promise<T>,
      events?: CommandJournalAppScope,
      /** The triggers the App names on the tables of `scope` (resources.<table>.triggers), by the same names `scope` uses. */
      triggers?: TriggerAcceptance,
    ): Promise<T>;

    /** Trusted source owner only: exact physical eligibility anchors are locked
     * and checked on the scoped insert-only writer before run. Separate journal
     * must be explicitly provisioned. The owner pins sourceIdentity and holds
     * its deployment lease through settlement; no raw writer/lock is exposed. */
    publicPlacementCommandTransaction?<T>(scope: RowScope, admission: PublicPlacementAdmission, run: PublicPlacementRun<T>): Promise<T>;
    /** Original-owner receipt-only read. Never executes or resolves a command. */
    publicPlacementReceipt?(owner: PublicPlacementOwner, submission: string): Promise<StoredCommandReceipt | undefined>;
  }
}
