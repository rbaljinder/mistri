import type { CommandEventBatch, CommandEventManifest } from '../events/commandEventTypes.js';
import type { PublicPlacementAdmission, PublicPlacementOwner, PublicPlacementRun } from './publicPlacementTypes.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';

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
}

/** One target's row. A receipt has one per target, in request order: a
 * single-target command one, a multi-target command one for each key.
 * `owner` is the tenant that owns the target row, which the server reads
 * from the stored row: required in the platform realm ('' for a
 * platform-owned target), and in a tenant's realm, if given, that tenant. */
export interface CommandAudit {
  target: string;
  keyJson: string;
  changesJson: string;
  owner?: string;
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
