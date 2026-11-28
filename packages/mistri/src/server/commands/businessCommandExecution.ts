import { commandVisitorAudit } from '../experiments/commandVisitor.js';
import { chosenContext, type Chosen } from '../app/appChoices.js';
import { appTime } from '@mistriwork/engine/server/http/clock.js';
import { createHash, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { inWriteLanes, recordLane } from '@mistriwork/engine/adapters/writeLanes.js';
import { withSnapshotRead } from '@mistriwork/engine/adapters/snapshotRead.js';
import { collectLockedBefores, withWriteAhead, type WriteAhead } from '@mistriwork/engine/adapters/writeAhead.js';
import {
  gathered,
  isWriteConflict,
  TransactionOperations,
  type AggregateRequest,
  type CteRequest,
  type InsertRequest,
  type InsertResult,
  type QueryResult,
  type UpdateRequest,
  type UpdateResult,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { cteTables } from '@mistriwork/engine/shared/cte.js';
import { CommandTransactionFailure, TrialRolledBack } from '../../adapters/commands/commandJournal.js';
import {
  AUDIT_PART_ENTRIES,
  AUDIT_TARGET_ENTRIES,
  AUDIT_TARGET_ENTRIES_MOST,
  type ReceiptActorKind,
} from '../../adapters/commands/commandJournalSchema.js';
import type { ProposalEvidence } from '../../adapters/commands/commandJournalTypes.js';
import { scopedAudit, splitAudit } from '../../adapters/commands/commandAuditParts.js';
import { EffectBodyTooLarge, EffectProjectionRefused, type CommandEventBatch } from '../../adapters/events/commandEventTypes.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { hasAppScopeCommandEventOwner, hasTenantCommandEventOwner, type BusinessCommandBinding } from './businessCommandAccess.js';
import {
  AUDIT_REDACTED,
  commandEventSlots,
  DraftRefusal,
  getCommandEvents,
  judgeDraft,
  parseRegisteredInput,
  registeredLookup,
  registeredAvailability,
  type BusinessCommandActor,
} from './businessCommands.js';
import { canonicalKey, createCommandDb, cteOf, keyFilter, normalizeRow, type UntypedRow, type WriteTable } from './commandDb.js';
import { carryServerRequest } from '@mistriwork/engine/server/serverRequests.js';
import { auditCommandRead, ReadAuditFailed, type CommandReadAudit, type ReadAuditSink } from '../readAudit.js';
import { assertReadAuditRow, type ReadAuditRow } from '../../adapters/readAudit/readAudit.js';
import { FLOW_TELL, flowCommandOf } from './flowCommandBrand.js';
import { compileWhen, failingCondition, recordPartHolds, type DerivedFailure, whenHolds, whenPerson } from './commandWhen.js';
import { whenRefusalSentence } from './commandSaying.js';
import { bindRecord, readsRecord, readsTarget, withheldAnswer, withheldOptions, type BoundCondition } from '../../shared/commandDraft.js';
import { mayReadTargetColumn } from './commandActorColumns.js';
import { rowRevision } from './commandRevision.js';
import { NO_OUTPUT } from './commandShapes.js';
import { preparesInitial } from './commandPrepareNeeds.js';
import { zoneDay, zoned, zonedTransaction } from './currentZone.js';
import { asMaker, claimProposal, settleProvenance, targetWrites } from './commandProvenance.js';
import { createLookupSources, lookupResult } from './commandLookup.js';
import { lookupHeldBy } from './commandLookupHold.js';
import { lookupSourceFiles } from './commandLookupFiles.js';
import { immutableCommandResult as immutableResult, validateHistoricalCommandOutput } from './commandHistoricalOutput.js';
import { COMMAND_INPUT_LIMITS } from '../../shared/command.js';
import { CommandInputRefusal } from '../../shared/commandInput.js';
import { lineCell } from '../../shared/commandLineCell.js';
import { definedAnswerBreak, sourcedChoiceBreak } from './commandDefined.js';
import { memberBreak } from './commandMembers.js';
import { projectCommandEvents, resolveCommandEffects } from './businessEvents.js';
import { effectProjectionDb } from './commandEffects.js';
import { snapshot as snapshotCanonicalJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  canonicalCommandJson,
  CommandInputError,
  commandKeyText,
  commandRequestBody,
  commandTargetList,
  parseCommandEnvelope,
  type CommandKey,
} from './commandPayload.js';
import { captureTenantData, recordRefusalCause, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import {
  BusinessCommandExecutionError,
  carryErrorOwnership,
  carryRefusalKeep,
  isBusinessCommandExecutionError,
  refusalKeep,
  refusalReason,
  type RefusalKeepDb,
} from './commandErrors.js';
import { rethrowCommandFailure } from './commandFailure.js';
import { commandLocale } from './commandLocale.js';
import { attributeAction, currentWriteAttribution } from '@mistriwork/engine/adapters/writeAttribution.js';
import { evaluateCommandAvailability } from './commandAvailability.js';
import { writeFailureKind } from '@mistriwork/engine/server/constraints.js';
import { placeFile, type FileScope, type PlacedFile } from '../files/fileStorage.js';
import { lookupFileReader, stagedOwner, takeHeldFiles } from './stagedFiles.js';
import type { CommandFileRule } from './businessCommandAuthorization.js';
import { openSavedDraft, type SavedDraftRun } from '../forms/savedForms.js';
import { currentSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { enterInFlightCommand } from './commandCoalescing.js';
import { observeCommandExecution } from './commandTracing.js';
import {
  AUDIT_TARGET_BYTES,
  auditRefusal,
  developerError,
  fileInsert,
  footprintFailure,
  projectBeforeRow,
  readBatchBeforeImages,
  resolveBeforeImage,
  withoutRevealed,
} from './commandWriteGuards.js';
import { handlerNextNumber } from '../../adapters/commands/commandSequences.js';
import { handlerLinks, mintQueued } from '../links/linkMint.js';
import { bindMoments, commandConstant, machineInsert, machineUpdate } from './commandWriteStamps.js';
import { assertWriteNotFrozen, rowFrozen } from './commandFrozen.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { commandFlagEnabled, commandFlagsReader, executeWithCommandFlags, type CommandFlags } from './commandFlags.js';

// Keep existing internal imports compatible; handlers and metadata use the leaf directly.
export { BusinessCommandExecutionError, isBusinessCommandExecutionError, refuse } from './commandErrors.js';
export { effectiveTrack, type CommandDoor, type CommandHandlerDoor } from './commandTrack.js';
import { effectiveTrack, handlerDoorOf, type CommandDoor, type CommandHandlerDoor, type CommandTrack } from './commandTrack.js';
import { integrationCalls } from '../integrations/integrationRuntime.js';
import { tellWrites } from './commandWrites.js';

export type { RefusalCode } from './commandErrors.js';

export interface BusinessCommandResult {
  status: 'applied';
  receiptId: string;
  command: string;
  commandVersion: number;
  resource: string;
  /** The first target: for the single-target envelope, the only one. */
  key: Readonly<Record<string, string | number>>;
  /** Present when the request named its targets as `keys`: all of them, in its order. */
  keys?: readonly Readonly<Record<string, string | number>>[];
  result: unknown;
  replayed: boolean;
}

interface ExecutionOptions {
  /** Host-issued immutable reader for this admitted request/attempt. Never body or actor data. */
  flags?: CommandFlags;
  /** Trusted job metadata: a queued timer belongs to one stay in one state. */
  timer?: Readonly<{ column?: string; state?: string; since: string; enteredAt: string; when?: string }>;
  signal?: AbortSignal;
  /** Generated by the server's request diagnostics, never a body field. */
  requestId?: string;
  now?: () => Date;
  /** Exact authorized receipt lookup; it never invokes the handler. */
  statusOnly?: boolean;
  /** A saved form's step, from its route: the application it runs in is found here, in its transaction (savedForms.ts). */
  draft?: SavedDraftRun;
  /**
   * Which door the request came through, which decides what the command
   * persists by default (`track`, below). Absent — a tenant's realm, an
   * owner that composes its own journal — the command keeps what it always
   * kept: a receipt and a full audit, found before the handler runs.
   */
  door?: CommandDoor;
  /**
   * The door the handler is told (`door` on its context) where `door` does not
   * say it: a tenant's realm, a public form, an import. Absent, it is `door`'s
   * own (`ui-idempotent` is the screen), else the screen.
   */
  entry?: CommandHandlerDoor;
  /**
   * Behavior analytics (src/server/analytics/): told once per admitted request
   * how it came out, `ran` or `refused`, with the command id. A replay of a
   * committed receipt is not told again. It never receives input or output,
   * and it must not throw into the command: a failure there is the caller's.
   * Absent, the App's registered recorder (`registerCommandAnalytics`) is used.
   */
  analytics?: (event: CommandAnalyticsEvent) => void;
  /** Files the host received for this run, beside the input (an inbound email's attachments, an inbound endpoint's
      `files`): the handler's `files`. */
  files?: readonly import('./businessCommands.js').CommandFile[];
  /** Files a callback delivered in its own body, by the ids its input names them with in a `field.files` (stagedFiles.ts
      `delivered`): the host has checked each as an upload is. */
  delivered?: ReadonlyMap<string, import('./businessCommands.js').CommandFile>;
  /** A public form's visitor token, from their own cookie: whose held files (stagedFiles.ts) a submission may take. */
  visitor?: string;
  /**
   * The locale the caller resolved for whoever asked (readerLocale.ts `requestLocale`, a tenant's default for a job):
   * the handler's `ctx.locale` once clamped to the App's catalogs. Absent, it is the App's own. Never input.
   */
  locale?: string;
  /**
   * The App's `choose` as the browser door proved it for this request (app/appChoices.ts): the handler's `ctx.chosen`
   * and what `chosen.<name>` in its where reads. Absent at every other door, where nothing is chosen. Never input.
   */
  chosen?: Chosen;
  /**
   * The proposal an approval runs this command from (proposals.ts): its receipt names it. Server-set when a
   * person approves, never input.
   */
  proposalId?: string;
  /**
   * Who made the run when no person did and the principal alone does not say: the assistant, or a decision applied
   * on its own. Server-set; a job and a workflow are read off the door, and nothing passes `agent`.
   */
  maker?: 'assistant' | 'decision';
  /**
   * The maker's own name on what its run wrote (proposals.ts `ProvenanceMark`): `job:<id>`, `decision:<name>`, a flow's.
   * Absent, the kind alone names it. Server-set.
   */
  makerActor?: string;
  /** What the maker read to write what it wrote, kept on its provenance marks. Server-set, never input. */
  evidence?: readonly ProposalEvidence[];
}

/** Who a receipt ran for, by kind: the principal's kind, a service told apart by the door it came through. */
function receiptActorKind(actor: BusinessCommandActor, door: CommandDoor | undefined, maker: ExecutionOptions['maker']): ReceiptActorKind {
  if (maker) return maker;
  if (actor.kind === 'service') return door === 'job' ? 'job' : door === 'workflow' ? 'flow' : 'service';
  return actor.kind ?? 'person';
}

/** A run an AI or a machine made: the makers a command with `approval: 'ai'` hears only as proposals. */
function madeByNoPerson(actor: BusinessCommandActor, door: CommandDoor | undefined, maker?: ExecutionOptions['maker']): boolean {
  const kind = receiptActorKind(actor, door, maker);
  return kind === 'assistant' || kind === 'job' || kind === 'decision' || kind === 'flow';
}

interface CommandAnalyticsEvent {
  readonly command: string;
  readonly outcome: 'ran' | 'refused';
  /** The signed-in account's id; null for a public or service principal, who are nobody to follow. */
  readonly unit: string | null;
}
const commandRecorders = new Map<string, (event: CommandAnalyticsEvent) => void>();
/** The behavior-analytics recorder for one App's commands, whichever door they came through. Returns its unregister. */
export function registerCommandAnalytics(appId: string, record: (event: CommandAnalyticsEvent) => void): () => void {
  commandRecorders.set(appId, record);
  return () => {
    if (commandRecorders.get(appId) === record) commandRecorders.delete(appId);
  };
}

/* The fresh path found the request's receipt already taken: a delivery of the
   same request committed first. The transaction rolls back and the request is
   answered as that receipt's replay. */
class ReceiptTaken extends Error {}

export type BusinessCommandStatus = BusinessCommandResult | { status: 'not_found'; outcome: 'unknown' };

/**
 * A command run as a trial (`trialBusinessCommand`): the handler ran and its transaction rolled back, with the rows
 * it would write counted by table; or it was not run at all, because it calls a provider whose call cannot be taken
 * back.
 */
type CommandTrial =
  | { status: 'trial'; ran: true; writes: Readonly<Record<string, number>>; result: unknown }
  | { status: 'trial'; ran: false; reason: 'provider' };

/**
 * Run a command as `executeBusinessCommand` would, under the same grants, lease and row policy, in a transaction
 * that is always rolled back: no receipt, no journal entry (its idempotency key stays unspent), no effects queued
 * and nothing started after a commit. A command that calls a provider (`integrations`) is not run: its call would
 * go out. A refusal is thrown as the command would throw it. What an import's check says (app/appImport.ts).
 */
export async function trialBusinessCommand(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: Omit<ExecutionOptions, 'statusOnly' | 'proposalId' | 'analytics'> = {},
): Promise<CommandTrial> {
  return (await executeObserved(binding, actor, rawRequest, { ...options, trial: true })) as CommandTrial;
}

type RunOptions = ExecutionOptions & { trial?: true };

/**
 * Execute trusted server TypeScript within one database transaction, SQLite
 * or PostgreSQL, whichever the source's `commandTransaction` opens. Session
 * verification belongs to the caller; business eligibility and conditional
 * revision checks belong to the handler. This is not an HTTP endpoint.
 */
export async function executeBusinessCommand(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: ExecutionOptions & { statusOnly: true },
): Promise<BusinessCommandStatus>;
export async function executeBusinessCommand(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options?: ExecutionOptions & { statusOnly?: false },
): Promise<BusinessCommandResult>;
export async function executeBusinessCommand(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  given: ExecutionOptions = {},
): Promise<BusinessCommandStatus> {
  // A trial is asked for by name (trialBusinessCommand), never carried in on options spread from elsewhere.
  const { trial: _trial, ...options } = given as RunOptions;
  const recorder = options.analytics ?? (options.statusOnly ? undefined : commandRecorders.get(actor.appId));
  if (recorder && !options.statusOnly) {
    const { analytics: _own, ...rest } = options;
    const unit = actor.kind ? null : actor.id;
    const named = rawRequest && typeof rawRequest === 'object' ? (rawRequest as { command?: unknown }).command : undefined;
    const command = typeof named === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(named) ? named : undefined;
    try {
      const result = (await executeObserved(binding, actor, rawRequest, rest)) as BusinessCommandResult;
      if (command && !result.replayed) recorder({ command, outcome: 'ran', unit });
      return result;
    } catch (error) {
      if (command && isBusinessCommandExecutionError(error)) recorder({ command, outcome: 'refused', unit });
      throw error;
    }
  }
  return executeObserved(binding, actor, rawRequest, options) as Promise<BusinessCommandStatus>;
}

function executeObserved(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: RunOptions,
): Promise<BusinessCommandStatus | CommandTrial> {
  return observeCommandExecution(rawRequest, options.statusOnly === true, () => executeUntraced(binding, actor, rawRequest, options));
}

async function executeUntraced(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: RunOptions = {},
): Promise<BusinessCommandStatus | CommandTrial> {
  const trial = options.trial === true;
  let transactionStarted = false;
  const scoped = binding.scoped === true;
  // What a refusal may name: only a key the request itself listed, and only
  // when it listed several. A write conflict on a target row is remembered so
  // a handler that rethrows it as stale_record still says which record moved.
  let requestKeys: readonly CommandKey[] = [];
  let conflictKey: CommandKey | undefined;
  /* The handler's own mistake found under a scoped refusal (footprintReference): the transaction rethrows the
     refusal it saw first, so the mistake is kept here and said in its place. */
  let footprintFault: unknown;
  /* The locale the handler is served in, once authorized: what a refusal naming a message (`refuse(msg(…))`) is
     said in, wherever its error is rebuilt below. Before that nothing has run that could name one. */
  let sayRefusal: (ref: import('@mistriwork/engine/shared/appMessages.js').AppMessageRef) => string | undefined = () => undefined;
  const refusedKey = (key: unknown): CommandKey | undefined => {
    if (requestKeys.length < 2 || !key) return undefined;
    const text = commandKeyText(key);
    return requestKeys.find((candidate) => commandKeyText(candidate) === text);
  };
  // A refused retry may refer to an earlier commit. Only a successful lookup
  // establishing absence allows this scoped invocation to prove not_applied.
  let priorOutcomeUnknown = scoped;
  // Set once the request is read: a fresh path that keeps receipts, whose refusals are looked up (below).
  let tracked = false;
  // Whether this command reads one snapshot (snapshotRead.ts), for the refusal its conflict is said as.
  let snapshot = false;
  // The most changes one target's audit takes: the command's own `maxChanges`, else the platform's default.
  let changeCap = AUDIT_TARGET_ENTRIES;
  /* Objects a handler's insertFile put in a bucket (files/fileStorage.ts):
     deleted when the transaction is known to have rolled back, and left for
     the sweep when its outcome is unknown. */
  const placedFiles: PlacedFile[] = [];
  /* Each file a handler's insertFile stored, by its table and its bytes: a held file taken for the handler must be one. */
  const storedFiles: Array<[string, Uint8Array]> = [];
  /* Started after the transaction has committed, and dropped with a failed attempt (a retried one makes its own). */
  const afterCommit: Array<() => void> = [];
  /* The parsed input, kept for a refusal: the field a broken constraint names is marked only when the input has it. */
  let given: unknown;
  /* Runs a refusal's keep (refuse(code, { keep })), once the command and its lanes are known. */
  let keepRefused: ((keep: (db: RefusalKeepDb) => Promise<unknown>) => Promise<void>) | undefined;
  /* Resolves or rejects any retry coalesced onto this in-flight idempotent execution. */
  let settleInFlight: ((result?: BusinessCommandResult, error?: unknown) => void) | undefined;
  try {
    // Only the actor's own declared kind, or the binding's word that a
    // signed-in form runs the command, decides whether an empty key is
    // admitted; the authorizer then proves the principal whole or refuses it.
    const publicActor = !!actor && typeof actor === 'object' && Object.getOwnPropertyDescriptor(actor, 'kind')?.value === 'public';
    const creates = (command: string): boolean => (binding.creates ? binding.creates(command) === true : publicActor);
    const request = parseCommandEnvelope(rawRequest, { creating: creates });
    const creating = creates(request.command);
    // Named in a refusal's recorded reason, where an inner write's own `request` shadows this one.
    const commandId = request.command;
    const list = commandTargetList(request);
    requestKeys = list.keys;
    const authorized = binding.authorize(request.command, actor);
    if (!authorized || typeof authorized !== 'object' || isProxy(authorized)) throw new AppAccessDenied();
    const locale = commandLocale(authorized.words, options.locale);
    sayRefusal = (ref) => authorized.words?.say(locale, ref);
    // The authorizer already refuses this; the executor says it again because
    // it is the one boundary a handler's public flag is trusted at. A
    // signed-in form's command is never public and names no key.
    if (
      creating &&
      (list.expectedVersions[0] !== 0 ||
        (publicActor
          ? authorized.command.public !== true || authorized.actor.kind !== 'public' || authorized.keyColumns.length !== 0
          : // A signed-in form's, or a job's that runs at its times (`every`), never a public principal's.
            authorized.command.public === true ||
            (authorized.actor.kind !== undefined && authorized.actor.kind !== 'service') ||
            authorized.keyColumns.length !== 0))
    )
      throw new AppAccessDenied();
    /* A public visitor acting on an existing record (`public: true, targets: 'one'`) names exactly one record. */
    if (
      !creating &&
      publicActor &&
      (authorized.command.public !== true ||
        authorized.command.targets !== 'one' ||
        authorized.actor.kind !== 'public' ||
        list.multi ||
        list.keys.length !== 1)
    )
      throw new AppAccessDenied();
    /* A link's holder runs on the one record the link was minted for, and on nothing else: the authorizer proved the
       command is the link's, and the key the request names is held to the link's here, where the target is read. */
    if (
      authorized.actor.kind === 'link' &&
      (creating || list.multi || list.keys.length !== 1 || commandKeyText(list.keys[0]) !== authorized.actor.link?.key)
    )
      throw new AppAccessDenied();
    if (scoped && (typeof authorized.assertTarget !== 'function' || typeof authorized.assertResult !== 'function'))
      throw new AppAccessDenied();
    const { command } = authorized;
    /* `approval: 'ai'`: what no person made runs only from a proposal a person approved. Every maker's own door
       proposes instead (a job, jobCommands.ts; a decision, decideHost.ts; a flow, workflowHost.ts; the assistant, its
       `run` tool); this is the backstop for one that does not. */
    if (command.approval === 'ai' && options.proposalId === undefined && madeByNoPerson(authorized.actor, options.door, options.maker))
      throw new BusinessCommandExecutionError(
        'forbidden',
        'not_applied',
        undefined,
        undefined,
        'This command runs only once a person approves it.',
      );
    snapshot = command.snapshot === true;
    changeCap = command.maxChanges ?? AUDIT_TARGET_ENTRIES;
    const flags = commandFlagsReader(options.flags);
    const flagEnabled = commandFlagEnabled(command, flags);
    // A command's events and its effects, which are recorded as events.
    const events = getCommandEvents(command);
    /* What this request persists (V2). Events, a status lookup and a door
       that did not say keep the journal exactly as it was: the receipt is
       found first, and the audit keeps every change. Otherwise the command's
       track decides, and a receipt, when kept, is written with its audit in
       one statement that is also the replay check (journal.insert). */
    const declared =
      options.door === undefined || events || options.statusOnly
        ? undefined
        : /* A signed-in form creates a record from a submission the page may
         send twice (a reload after a lost answer), and a second row is not
         what the person asked for: the submission is a retry key, so it
         keeps a receipt as a request with an Idempotency-Key does. */
          effectiveTrack(command.track ?? binding.track, options.door === 'ui' && creating ? 'ui-idempotent' : options.door);
    /* A row-policy command that keeps receipts keeps the receipt-first path:
       its replay is judged against what the principal may see now (a target
       or a result dependency hidden since conceals the receipt), which is a
       lookup before the handler, not after it. The App API, the one door
       that needs receipts on every request, serves no row-policy App. */
    const track: CommandTrack | undefined = scoped && declared !== 'none' ? undefined : declared;
    const auditing = track === undefined || track === 'audit';
    tracked = track === 'receipts' || track === 'audit';
    // What this request keeps, on its span: the observer says it per command (`journal`: receipt first, full audit).
    currentSpan()?.setAttribute('mistri.command.track', track ?? 'journal');
    // Capture trusted namespace before invoking validators or waiting on a
    // writer. Evidence revisions/deployment do not belong in idempotency input.
    const receiptOwnerDescriptor = Object.getOwnPropertyDescriptor(authorized, 'receiptOwner');
    if (!receiptOwnerDescriptor && 'receiptOwner' in authorized) throw new AppAccessDenied();
    let receiptOwner: Readonly<{ storeId: string; sourceId: string; tenantId: string }> | undefined;
    const resource = authorized.resource;
    if (receiptOwnerDescriptor) {
      if (!('value' in receiptOwnerDescriptor)) throw new AppAccessDenied();
      if (receiptOwnerDescriptor.value !== undefined) {
        const owner = captureTenantData(receiptOwnerDescriptor.value);
        tenantRecord(owner, ['storeId', 'sourceId', 'tenantId']);
        tenantIdentifier(owner.storeId);
        tenantIdentifier(owner.sourceId, 128);
        tenantIdentifier(owner.tenantId, 128);
        tenantIdentifier(resource, 256);
        if (
          Buffer.byteLength(owner.storeId, 'utf8') > 256 ||
          [...owner.storeId].some((character) => {
            const point = character.codePointAt(0)!;
            return point >= 0xd800 && point <= 0xdfff;
          })
        )
          throw new AppAccessDenied();
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(owner.sourceId) ||
          owner.sourceId !== command.source ||
          !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(owner.tenantId)
        )
          throw new AppAccessDenied();
        receiptOwner = owner as typeof receiptOwner;
      }
    }
    /* Whose files this run's bucket objects are: a new one is filed under it, and one a row names is read only from it. */
    const fileScope: FileScope = { app: authorized.actor.appId, ...(receiptOwner ? { tenant: receiptOwner.tenantId } : {}) };
    // A tenant command emits through the tenant runtime's binding, an
    // App-scope command only through a binding given the issued App source.
    if (events && !(receiptOwner ? hasTenantCommandEventOwner(binding) : hasAppScopeCommandEventOwner(binding)))
      throw new AppAccessDenied();
    // Never reinterpret a retained retry under a newly deployed handler version.
    if (request.commandVersion !== command.version) throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
    // A command that names one record refuses a list, whatever its length.
    // A `many` command takes either envelope; one key behaves as it always did.
    const many = command.targets === 'many';
    if (list.multi && !many) throw new CommandInputError('keys');
    for (const key of list.keys) {
      /* `key`, and never which column of it. The name would be safe from the
         caller's side — it comes from the catalog, never from the key that
         arrived — but a key column is not always the caller's business: under
         a scoped or tenant invocation the ownership column is the platform's,
         supplied by the runtime and hidden from the App, and a refusal that
         named it would disclose how rows are owned. So the member is named
         and its columns are not (tenant-commands pins this). */
      if (authorized.keyColumns.length !== Object.keys(key).length || authorized.keyColumns.some((column) => !Object.hasOwn(key, column)))
        throw new CommandInputError('key');
    }
    if (!authorized.commandTransaction) throw new BusinessCommandExecutionError('temporarily_unavailable');
    const signal = options.signal ?? new AbortController().signal;
    /* A scoped write refused: was it a reference the command's footprint cannot prove (footprintReference)? Under a
       row policy any refusal may be — the scoped writer says an unread parent as a row out of scope. Under a tenant,
       a row its place refuses (its ownership column, the platform's) stays forbidden. */
    const unproved = (error: unknown) =>
      scoped &&
      (!authorized.receiptOwner ||
        (!(error instanceof AppAccessDenied) && !(isBusinessCommandExecutionError(error) && error.code === 'forbidden')));
    const checkCancelled = () => {
      if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    };
    checkCancelled();
    const now = options.now ?? (() => appTime());
    const requestId = options.requestId ?? randomUUID();
    // A job attempt names itself `job:<jobId>:<attempt>`; colons are its separators.
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(requestId)) throw new CommandInputError('requestId');
    let input: unknown;
    /* A `keep: 'handler'` value, whole: held here, in this call's memory, for the handler's input and nothing else —
       the fingerprint, the journal, the audit and events all hold its hash. */
    const revealed: Record<string, string> = {};
    try {
      // A public submission is held to the tighter bound before anything reads it.
      if (publicActor) canonicalCommandJson(request.input, COMMAND_INPUT_LIMITS.publicInputBytes);
      // The declaration's parser, then the command's own rules; what they
      // return is the input the fingerprint and the handler see.
      const validated = parseRegisteredInput(
        command,
        request.input,
        Object.freeze({ actor: authorized.actor, commandId: request.command, version: command.version }),
        {
          publicForm: publicActor,
          reveal: (name, value) => {
            revealed[name] = value;
          },
          now: now(),
          ...(authorized.currency ? { currency: authorized.currency } : {}),
          // A line's cells are read as their columns' kinds, so a handler's lines are typed as its rows are.
          cell: (table, column, value) => {
            const meta = authorized.catalog?.[table]?.meta;
            return meta ? lineCell(meta, column, value) : 'shape';
          },
        },
      );
      input = parseCommandEnvelope(commandRequestBody(request, JSON.parse(canonicalCommandJson(validated))), { creating }).input;
      given = input;
    } catch (error) {
      // The declaration names the field it refused, nested paths included; a
      // validate that refuses with the platform's own invalid_input keeps the
      // field it named; any other failure is the fixed refusal.
      if (error instanceof CommandInputRefusal)
        throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.path || undefined);
      if (error instanceof DraftRefusal)
        throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.path, undefined, error.said);
      if (isBusinessCommandExecutionError(error) && error.code === 'invalid_input') throw error;
      throw new CommandInputError(error instanceof CommandInputError ? error.field : 'input');
    }
    // One target is fingerprinted exactly as the single-key envelope always
    // was, so `keys: [k]` and `key: k` are one operation; several are the
    // ordered list with its aligned revisions.
    const targets =
      list.keys.length === 1
        ? { key: list.keys[0], expectedVersion: list.expectedVersions[0] }
        : { keys: list.keys, expectedVersions: list.expectedVersions };
    const fingerprint = createHash('sha256')
      .update(
        canonicalCommandJson({
          command: request.command,
          commandVersion: command.version,
          source: command.source,
          target: command.target,
          ...targets,
          input,
          ...(receiptOwner ? { receiptOwner, resource } : {}),
          ...(events ? { eventManifest: events.expectation, eventSlots: [...commandEventSlots(command)] } : {}),
        }),
      )
      .digest('hex');
    const scope = {
      appId: authorized.actor.appId,
      actorId: authorized.actor.id,
      commandId: request.command,
      commandVersion: command.version,
      idempotencyKey: request.idempotencyKey,
    };
    /* A trial is a first attempt that never commits: it neither reads a receipt nor runs for a proposal. A command
       that calls a provider is answered unrun, before lookup, since a call that went out cannot be rolled back. */
    if (trial && (options.statusOnly || options.proposalId !== undefined)) throw new AppAccessDenied();
    if (trial && Object.keys(command.integrations ?? {}).length) return { status: 'trial', ran: false, reason: 'provider' };
    const answer = (receiptId: string, result: unknown, replayed: boolean): BusinessCommandResult => ({
      status: 'applied',
      receiptId,
      command: request.command,
      commandVersion: request.commandVersion,
      resource: receiptOwner ? resource : authorized.resource,
      key: list.keys[0],
      ...(list.multi ? { keys: list.keys.map((key) => Object.freeze({ ...key })) } : {}),
      result,
      replayed,
    });
    if (!options.statusOnly && !trial && options.proposalId === undefined && track !== 'none' && !scoped) {
      const inFlightKey = JSON.stringify([
        receiptOwner ?? null,
        scope.appId,
        scope.actorId,
        scope.commandId,
        scope.commandVersion,
        scope.idempotencyKey,
      ]);
      const flight = enterInFlightCommand<BusinessCommandResult>(binding, inFlightKey, fingerprint, signal);
      if (flight.kind === 'attached') return await flight.promise;
      if (flight.kind === 'leader') settleInFlight = flight.settle;
    }
    // Lookup: the App's other sources, read before the transaction opens, with
    // the target as it stands now. Nothing here refuses yet: the transaction
    // first looks for the request's receipt, so a replay answers as it always
    // did, and only a first attempt hears that its lookup failed.
    const lookupRun = options.statusOnly || !flagEnabled ? undefined : registeredLookup(command);
    let lookup: unknown, lookupFailure: BusinessCommandExecutionError | undefined;
    /* Targets the lookup's read already wrote to the read audit: the transaction's read of the same row is not a
       second line. */
    const lookupAudited = new Set<string>();
    /* A record its command's machine or `when` plainly refuses as it stands holds the lookup back, so no outside call
       goes out for a command the transaction then refuses (commandWhen.ts plainlyFails). The transaction judges again
       and says why; one that admits the record after all (it moved between the two reads) is refused as stale, since
       the handler would run without its lookup. A `when` naming `me` reads the person here too, through the lookup's
       reader (`own`), so another person's record holds the lookup as well; the transaction reads them again. */
    let lookupHeld = false;
    /* The file bytes lookup read (`files.read`, a source's `readFile`): the handler's readFile starts its budget there,
       so the command's every file read shares one bound. */
    let lookupFiles: ReturnType<typeof lookupFileReader> | undefined;
    if (lookupRun) {
      const reader = authorized.lookup;
      const table = authorized.catalog?.[command.target];
      if (!reader || !table) throw new AppAccessDenied();
      /* A lookup's reads of audited resources — its sources' and the target as it stands — are written as the
         handler's are, under this command; one the audit refuses fails the lookup, so the command, as any lookup failure. */
      const audited = authorized.audited;
      // A trial writes no read audit: it is rolled back, and its reads are said again by the run it previews.
      const lookupQuery: typeof reader.query =
        audited?.lookups.size && !trial
          ? async (source, local, read) => {
              const result = await reader.query(source, local, read);
              const found = audited.lookups.get(source)?.get(local);
              if (found)
                await auditCommandRead(authorized.readAudit, request.command, {
                  ...found,
                  keys: reader.catalogs[source]?.[local]?.key ?? [],
                  groups: read.filter?.groups,
                  sort: read.orderBy,
                  offset: read.offset,
                  rows: result.rows,
                });
              return result;
            }
          : reader.query;
      const targetAudit = audited?.tables.get(command.target);
      try {
        const before: UntypedRow[] = [];
        if (command.targets !== 'none' && !creating) {
          for (const key of list.keys) {
            const exact = canonicalKey(table, key);
            const row = exact ? await reader.target(exact) : undefined;
            if (exact && targetAudit && !trial) {
              await auditCommandRead(authorized.readAudit, request.command, {
                ...targetAudit,
                keys: table.key,
                groups: keyFilter(exact).groups,
                rows: row ? [row] : [],
              });
              lookupAudited.add(commandKeyText(exact));
            }
            if (!row) throw new BusinessCommandExecutionError('not_found', 'not_applied', undefined, key);
            before.push(normalizeRow(table, row) as UntypedRow);
          }
        }
        const stood = command.targets === 'none' || creating ? {} : many ? { records: Object.freeze(before) } : { record: before[0] };
        /* The files the form attached, read and left held for the handler; only this sender's, a public form's
           visitor by their cookie (stagedFiles.ts: within the one budget the handler's readFile shares). */
        lookupFiles = lookupFileReader(command.fields, input, authorized.commandTransaction, {
          appId: authorized.actor.appId,
          command: request.command,
          owner: stagedOwner(publicActor ? actor : authorized.actor, options.visitor),
          now: () => now().getTime(),
        });
        lookupHeld = !options.statusOnly && (await lookupHeldBy(authorized, command, table, before, reader.own, now));
        const value = lookupHeld
          ? undefined
          : await zoned(authorized.timezone, lookupRun)(
              Object.freeze({
                actor: authorized.actor,
                requestId,
                commandId: request.command,
                version: command.version,
                source: command.source,
                signal,
                now,
                flags,
                locale,
                sources: createLookupSources({
                  catalogs: reader.catalogs,
                  query: lookupQuery,
                  now,
                  readFile: lookupSourceFiles(reader, lookupQuery, fileScope, lookupFiles.budget),
                }),
                files: lookupFiles.files,
                // Each call keyed by this request, so a replay re-running lookup is answered from the call's record.
                integrations: integrationCalls({
                  appId: scope.appId,
                  tenant: receiptOwner?.tenantId ?? '',
                  commandId: request.command,
                  actorId: scope.actorId,
                  idempotencyKey: request.idempotencyKey,
                  signal,
                  declared: command.integrations,
                  outerRetries: options.door === 'workflow' || options.door === 'job',
                }),
                // The tenant it runs in, read before the transaction: a command naming no record has no row to say it.
                ...(receiptOwner ? { tenant: receiptOwner.tenantId } : {}),
                ...stood,
              }),
              input,
            );
        checkCancelled();
        if (!lookupHeld) lookup = lookupResult(value);
      } catch (error) {
        if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        if (error instanceof AppAccessDenied) throw error;
        /* The reason is kept for the operator (a read the audit could not record is said as itself), never the caller;
           and a lookup's refuse(code, { keep }) its keep, run once the transaction this refusal rolls back has. */
        lookupFailure = isBusinessCommandExecutionError(error)
          ? carryErrorOwnership(
              error,
              carryRefusalKeep(
                error,
                new BusinessCommandExecutionError(error.code, 'not_applied', error.field, error.key, refusalReason(error, sayRefusal)),
              ),
            )
          : recordRefusalCause(new BusinessCommandExecutionError('temporarily_unavailable'), error);
      }
    }
    const lanes = [
      JSON.stringify([
        'receipt',
        receiptOwner ?? null,
        scope.appId,
        scope.actorId,
        scope.commandId,
        scope.commandVersion,
        scope.idempotencyKey,
      ]),
      ...list.keys.map((key) => recordLane(authorized.resource, key)),
    ];
    /* What the transaction opens with, told before it begins so the adapter
       sends it behind the BEGIN (writeAhead.ts): the receipt the journal path
       looks up first, and the records read by key before the handler runs.
       Only a hint: what the transaction then asks is what it always asked. */
    const targetTable = authorized.catalog?.[command.target];
    const ahead: WriteAhead = {
      ...(track === undefined ? { receipt: scope } : {}),
      /* Not for an approval, whose claim on its proposal is written first and drops the read sent ahead, nor for a
         status check, which answers from the receipt and reads no target. */
      targets:
        command.targets !== 'none' && !creating && targetTable && options.proposalId === undefined && !options.statusOnly
          ? list.keys.flatMap((key) => {
              const exact = canonicalKey(targetTable, key);
              // The table as the transaction names it (the catalog's id), not the command's local name for it.
              return exact ? [{ table: targetTable.meta.id, key: exact }] : [];
            })
          : [],
      writes: command.appendOnly !== true,
    };
    // One snapshot for every read, where the command asked for it (snapshotRead.ts); SQLite's writer is one already.
    const reading = <T>(work: () => Promise<T>) => withWriteAhead(ahead, () => withSnapshotRead(snapshot, work));
    /* What a refusal still writes (refuse(code, { keep })), once the handler's own writes are rolled back: a fresh
       transaction, not a savepoint inside the first, since rolling back to a savepoint drops the locks taken after it
       (postgresTransactionHandle.ts), the fence's among them. The same principal and fence through the same authorized
       source, in the same lanes; only `refused.writes`, only insert and update, each stamped as a handler's write is.
       No receipt, no events, no effects: the record history marks its writes as kept on refusal, and a notify on
       them fires as on any write. It does not watch the request's signal: the refusal is decided, and a caller that
       hangs up then must not undo what it leaves behind, or dropping the connection would skip an attempt's count.
       What holds any transaction to its source (a scope still active, the connection still writable) holds it. */
    keepRefused = (keep) => {
      const refused = command.refused;
      if (!refused)
        throw developerError(
          `Command "${commandId}" refused with a keep but declares no refused: { writes: [...] } for it to write [refused-writes].`,
        );
      const action = `${currentWriteAttribution()?.action ?? commandId} (kept on refusal)`;
      const addingOnly = (table: string) => {
        const said = authorized.insertOnly?.get(table);
        if (said !== undefined) throw new BusinessCommandExecutionError('forbidden', 'not_applied', undefined, undefined, said);
      };
      // A binding that opens its command's transaction once per request (a public intake's) opens a keep's apart.
      const transaction = authorized.refusalTransaction ?? authorized.commandTransaction!;
      return inWriteLanes(lanes, () =>
        attributeAction(action, () =>
          transaction(async (records) => {
            /* The targets as the handler's transaction held them (assertTargets): this one is fresh, and the person's
               rows may have moved since. What the keep writes the row scope holds as it holds any write. */
            const targets = async () => {
              for (const key of list.keys) await authorized.assertTarget?.(records, key);
            };
            await targets();
            const operations = new TransactionOperations(true);
            const accept = <Request, Result>(request: Request, run: (request: Request) => Promise<Result>, read = false) => {
              const copy = carryServerRequest(request, scoped ? snapshotScopedData(request) : structuredClone(request));
              return read ? operations.read(() => run(copy)) : operations.run(() => run(copy));
            };
            const tx: WriteTransaction = Object.freeze<WriteTransaction>({
              query: (request) => accept(request, async (request) => (addingOnly(request.table), records.query(request)), true),
              count: (table, filter) =>
                accept({ table, filter }, async ({ table, filter }) => (addingOnly(table), records.count(table, filter)), true),
              ...(records.aggregate
                ? {
                    aggregate: (request: AggregateRequest) =>
                      accept(request, async (request) => (addingOnly(request.table), records.aggregate!(request)), true),
                  }
                : {}),
              insert: (request) =>
                accept(request, (request) =>
                  records.insert(
                    bindMoments(authorized, machineInsert(authorized.machine, request, now(), authorized.catalog, authorized.timezone)),
                  ),
                ),
              update: (request) =>
                accept(request, async (request) => {
                  addingOnly(request.table);
                  const moved = await machineUpdate(authorized.machine, request, records, now(), authorized.catalog, authorized.timezone);
                  return records.update(bindMoments(authorized, moved));
                }),
              remove: () => Promise.reject(developerError(`Command "${commandId}"'s keep removes nothing; it inserts and updates.`)),
            });
            const db = createCommandDb({
              tx,
              catalog: authorized.catalog ?? {},
              read: refused.writes,
              write: refused.writes,
              now,
              ...(authorized.versionField === undefined ? {} : { versionField: authorized.versionField }),
              target: command.target,
              constant: (table, column, word) => commandConstant(authorized, tx, table.meta, column, word, now()),
            });
            // Insert and update, never remove nor a file: what a refusal leaves behind is a count, a mark, a row.
            const kept: RefusalKeepDb = Object.freeze(
              Object.fromEntries(
                Object.entries(db).map(([name, table]) => {
                  const { remove: _remove, insertFile: _insertFile, moveFile: _moveFile, ...rest } = table as WriteTable<UntypedRow>;
                  return [name, Object.freeze(rest)];
                }),
              ),
            );
            try {
              await keep(kept);
              await operations.finish();
            } catch (error) {
              await operations.finish().catch(() => {});
              throw error;
            }
            await targets();
            return null;
          }),
        ),
      ).then(() => undefined);
    };
    /* Who made the run and the proposal it carried out, on each history row it writes: the receipt's own values, read
       here once rather than looked up again (recordHistory.ts, captureRecordHistory). A maker that names itself is kept so. */
    const madeAs = receiptActorKind(authorized.actor, options.door, options.maker);
    const committed: BusinessCommandStatus = await inWriteLanes(lanes, () =>
      reading(() =>
        asMaker(madeAs, options.makerActor, options.proposalId, () =>
          zonedTransaction(authorized)(async (records, journal) => {
            afterCommit.length = 0;
            transactionStarted = true;
            checkCancelled();
            /* Targets this transaction wrote through the row scope, which proved
         each visible after the write and holds it to commit (a row lock, or
         SQLite's write lock): a visibility check of one again before commit
         would read what cannot have changed. Only a policy of the row's own
         columns decides visibility (shared/rowScope.ts), so nothing else in
         the transaction moves it. */
            const held = new Set<string>();
            const heldKey = (key: unknown) => {
              const table = authorized.catalog?.[command.target];
              const exact = table && key && typeof key === 'object' ? canonicalKey(table, key as Record<string, unknown>) : undefined;
              return exact ? JSON.stringify(table!.key.map((column) => exact[column])) : undefined;
            };
            // Row ceilings are judged per key: one hidden target refuses the whole
            // request before the receipt is even looked up.
            /* Targets this transaction removed (A row action that deletes its own row). Each was judged
           against its ceiling just before the removal; after it there is no row left to judge, and "gone, removed
           by this request" is inside the ceiling the request was granted. */
            const removed = new Set<string>();
            const assertTargets = async () => {
              for (const key of list.keys) {
                const at = heldKey(key) ?? '';
                if (removed.has(at) || (track !== undefined && held.has(at))) continue;
                await authorized.assertTarget?.(records, key);
              }
            };
            /* The fresh path reads each target through the row scope before the
         handler runs (below); a hidden one is refused there, as forbidden,
         before anything is written. Only a command that names no record is
         checked here first. */
            const readsTargets = command.targets !== 'none' && !creating;
            if (track === undefined || !readsTargets) await assertTargets();
            // Nothing to replay without a receipt: a refusal is this attempt's own.
            // A trial answers no receipt and keeps none: whatever it refuses is its own, and rolled back.
            if (track === 'none' || trial) priorOutcomeUnknown = false;
            const saved = track === undefined && !trial ? await journal.find(scope, events?.expectation) : undefined;
            if (scoped && !saved && track === undefined) priorOutcomeUnknown = false;
            if (saved) {
              if (saved.fingerprint !== fingerprint) throw new BusinessCommandExecutionError('idempotency_conflict');
              if (scoped) {
                let result: unknown;
                try {
                  result = validateHistoricalCommandOutput(saved.resultJson, command.output);
                } catch (error) {
                  throw recordRefusalCause(
                    new BusinessCommandExecutionError('invalid_result'),
                    recordRefusalCause(
                      new Error(
                        `Command "${commandId}"'s saved result for this idempotency key ` +
                          'no longer matches its declared output; the output shape changed since that run.',
                      ),
                      error,
                    ),
                  );
                }
                await authorized.assertResult!(records, list.keys[0], result);
                await assertTargets();
                checkCancelled();
                return answer(saved.id, result, true);
              }
              return answer(saved.id, JSON.parse(saved.resultJson), true);
            }
            if (options.statusOnly) return { status: 'not_found', outcome: 'unknown' };
            /* The fresh path asks only whether the receipt is there — one read, no
         lock — and a taken one is replayed by the receipt-first lookup, so a
         retry never runs the handler again. A delivery racing its original
         is caught by the receipt's insert at commit instead. */
            if (track !== undefined && track !== 'none' && !trial) {
              if (typeof journal.insert !== 'function' || typeof journal.taken !== 'function')
                throw new BusinessCommandExecutionError('temporarily_unavailable');
              if (await journal.taken(scope)) throw new ReceiptTaken();
            }
            // Both receipt paths can recover while disabled, but neither can run a new handler.
            if (!flagEnabled) throw new BusinessCommandExecutionError('forbidden');
            // No receipt answers the request: a failed lookup refuses it now.
            if (lookupFailure) throw lookupFailure;
            if (options.proposalId !== undefined) await claimProposal(journal, authorized, options.proposalId, commandId, now().getTime());
            /* A saved form's step runs in its own application and nowhere else: the
         root is found by the cookie's hash here, in this transaction, and
         every read and write below is fenced to it. Only a public submission
         carries one. */
            /* A public form's draft is a visitor's, a signed-in form's a person's (savedForms.ts): the other
             kind of principal never opens either. */
            if (options.draft && (options.draft.owner !== undefined) === publicActor) throw new AppAccessDenied();
            /* A person's draft is owned by `me`, found in this transaction through the command's reading of the
             people table: the request names nobody. */
            const owner = options.draft?.owner
              ? (await whenPerson(records, authorized.actor, authorized.people, ['owner = me']))?.person?.key
              : undefined;
            const draft = options.draft
              ? await openSavedDraft(
                  options.draft,
                  records,
                  authorized.catalog ??
                    (() => {
                      throw new AppAccessDenied();
                    })(),
                  now(),
                  options.draft.owner ? (owner ?? null) : undefined,
                  authorized.files,
                )
              : undefined;
            const store = draft?.records ?? records;
            /* A handler's reads asked together start together here, in the order asked, and the store beneath decides
             whether they leave together: a writer that pipelines sends them in one flight, any other one by one. */
            let operations = new TransactionOperations(true);
            const accept = <Request, Result>(
              request: Request,
              run: (snapshot: Request) => Promise<Result>,
              read = false,
            ): Promise<Result> => {
              // Capture before joining the queue: handlers still own their arguments.
              try {
                const snapshot = carryServerRequest(request, scoped ? snapshotScopedData(request) : structuredClone(request));
                return read ? operations.read(() => run(snapshot)) : operations.run(() => run(snapshot));
              } catch (error) {
                return operations.run(async () => {
                  throw error;
                });
              }
            };
            // One audit row per target. A write to a target row is that target's;
            // any other write is recorded on the target written most recently
            // before it — the first target's, before any — so a handler that works
            // record by record leaves each record's dependents on its own row.
            const keyTexts = list.keys.map(commandKeyText);
            const changes: unknown[][] = list.keys.map(() => []);
            const changeJsons: string[][] = list.keys.map(() => []);
            // The bytes each target's entries come to as one array, kept as they are added so a long audit is not walked again.
            const changeBytes: number[] = list.keys.map(() => 1);
            const chunkBytes: number[] = list.keys.map(() => 1);
            const chunkNodes: number[] = list.keys.map(() => 1);
            const AUDIT_CHUNK_MAX_NODES = 10_000;
            let attributed = 0;
            // What the audit keeps of each image. A public command's default is
            // keys and column names only: an applicant's input is not the journal's
            // to hold outside every role's ceiling unless the command says so.
            const redact = command.audit?.redact ?? (command.public === true ? 'values' : undefined);
            const redacted = Array.isArray(redact) ? new Set<string>(redact) : undefined;
            const image = (row: unknown): unknown =>
              !redact || !row || typeof row !== 'object' || Array.isArray(row)
                ? row
                : Object.fromEntries(
                    Object.entries(row).map(([column, value]) => [
                      column,
                      redact === 'values' || redacted!.has(column) ? AUDIT_REDACTED : value,
                    ]),
                  );
            const attribute = (key: unknown) => {
              if (!many) return;
              const index = keyTexts.indexOf(commandKeyText(key));
              if (index >= 0) attributed = index;
            };
            const recordChange = (change: { resource: string; key?: unknown } & Record<string, unknown>) => {
              if (change.resource === command.target) attribute(change.key);
              const list = changes[attributed];
              if (list.length >= changeCap) {
                throw recordRefusalCause(
                  new BusinessCommandExecutionError('invalid_result'),
                  `Command "${request.command}" made more than ${changeCap.toLocaleString('en-US')} changes for one target; ` +
                    `a command may change at most ${changeCap.toLocaleString('en-US')}${command.maxChanges === undefined ? ' unless it declares maxChanges' : ''} ` +
                    `(up to ${AUDIT_TARGET_ENTRIES_MOST.toLocaleString('en-US')}), and its audit keeps 4 MiB.`,
                );
              }
              try {
                // Validate and canonicalize once; when redacting, redact the validated copy before measuring its stored form.
                let snapped = snapshotCanonicalJson(change, AUDIT_TARGET_BYTES);
                if (redact) {
                  const copy = { ...(snapped.value as Record<string, unknown>) };
                  let changed = false;
                  for (const side of ['before', 'after']) {
                    if (Object.hasOwn(copy, side)) {
                      copy[side] = image(copy[side]);
                      changed = true;
                    }
                  }
                  if (changed) snapped = snapshotCanonicalJson(copy, AUDIT_TARGET_BYTES);
                }
                // Stored in pieces of AUDIT_PART_ENTRIES, each bounded by node count and bytes.
                if (list.length % AUDIT_PART_ENTRIES === 0) {
                  chunkBytes[attributed] = 1;
                  chunkNodes[attributed] = 1;
                }
                const nextChunkNodes = chunkNodes[attributed] + snapped.nodes;
                const nextChunkBytes = chunkBytes[attributed] + snapped.bytes + 1;
                const nextTotalBytes = changeBytes[attributed] + snapped.bytes + 1;
                if (nextChunkNodes > AUDIT_CHUNK_MAX_NODES || nextChunkBytes > AUDIT_TARGET_BYTES || nextTotalBytes > AUDIT_TARGET_BYTES)
                  throw new Error('over the audit');
                chunkNodes[attributed] = nextChunkNodes;
                chunkBytes[attributed] = nextChunkBytes;
                changeBytes[attributed] = nextTotalBytes;
                list.push(snapped.value);
                changeJsons[attributed].push(snapped.json);
              } catch {
                throw developerError(auditRefusal(request.command, change));
              }
            };
            /* Under snapshot: true (REPEATABLE READ), rows read in this tx cannot silently move (conflicting UPDATE aborts
               with 40001). Caching single-row reads by PK lets updateVia reuse the before-image instead of re-SELECTing. */
            const snapshotRows = command.snapshot === true ? new Map<string, Record<string, unknown>>() : undefined;
            const snapshotRowKey = (tableId: string, rowOrKey: Record<string, unknown>): string | undefined => {
              const meta = authorized.catalog?.[tableId];
              const exact = meta?.key.length ? canonicalKey(meta, rowOrKey) : undefined;
              return exact ? `${tableId}\0${commandKeyText(exact)}` : undefined;
            };
            const rememberSnapshotRow = (tableId: string, row: Record<string, unknown>) => {
              const k = snapshotRows ? snapshotRowKey(tableId, row) : undefined;
              if (k !== undefined) snapshotRows!.set(k, { ...row });
            };
            const lookupSnapshotRow = (tableId: string, key: Record<string, string | number>) => {
              const k = snapshotRows ? snapshotRowKey(tableId, key) : undefined;
              return k !== undefined ? snapshotRows!.get(k) : undefined;
            };
            const forgetSnapshotRow = (tableId: string, key: Record<string, string | number> | undefined) => {
              const k = snapshotRows && key ? snapshotRowKey(tableId, key) : undefined;
              if (k !== undefined) snapshotRows!.delete(k);
            };
            /* The target's revision, checked up front, or, for a command that declares `appendOnly`, at its first write to the
           target. `owed` holds each record whose refusal waits for that write, by key: decided from the revision the
           first read took (`movedSince`) and never read again, so a trigger or a digest column that its own child insert
           moved cannot refuse it. Only the declaration moves the check; a command that writes other tables without it
           is refused up front, as every command was. */
            const lazyRevision =
              command.appendOnly === true && !(preparesInitial(command) || registeredAvailability(command) || authorized.machine?.verb);
            const owed = new Set<string>();
            const guardTarget = (key: Record<string, string | number>) => {
              if (owed.delete(commandKeyText(key))) throw new BusinessCommandExecutionError('stale_record', 'not_applied', undefined, key);
            };
            /* The rows this command has made on its target, by key text: a public command's link names the one it made. */
            const madeOnTarget: string[] = [];
            /* The rows a trial would write, by table: what an import's check says each run would do. */
            const trialWrites: Record<string, number> = {};
            /* The tables this run changed a row of, told to the route with its answer (commandWrites.ts). */
            const wroteTables = new Set<string>();
            const tally = (table: string, rows: number) => {
              if (rows > 0) wroteTables.add(table);
              if (trial && rows > 0) trialWrites[table] = (trialWrites[table] ?? 0) + rows;
            };
            const { written: wroteOnTarget, wrote } = targetWrites(authorized, command.target);
            /* One insert as the handler asked it, written through `write`: the store's own insert for one row, one row of
             one statement for a batch (adapter.ts gathered), with the same stamps, footprint and audit either way. */
            const insertVia = async (
              request: InsertRequest,
              write: (request: InsertRequest) => Promise<InsertResult>,
            ): Promise<InsertResult> => {
              checkCancelled();
              const said = Object.keys(request.values);
              request = machineInsert(authorized.machine, request, now(), authorized.catalog, authorized.timezone);
              request = bindMoments(authorized, request);
              const file = fileInsert(commandId, authorized, request);
              let result: InsertResult;
              try {
                result = await write(request);
              } catch (error) {
                if (unproved(error)) footprintFault ??= footprintFailure(commandId, authorized, request);
                throw error;
              }
              tally(request.table, 1);
              forgetSnapshotRow(request.table, result.key);
              if (request.table === command.target && result.key !== undefined) {
                madeOnTarget.push(commandKeyText(result.key));
                wrote(result.key, Object.keys(request.values), said);
              }
              if (auditing)
                recordChange({
                  operation: 'insert',
                  resource: request.table,
                  key: result.key,
                  after: file ? { ...result.applied, ...file } : result.applied,
                });
              return result;
            };
            /* `me` in a `frozen` condition is this actor, read once and only where a condition says it (commandWhen.ts). */
            let frozenPerson: Promise<QueryPerson | undefined> | undefined;
            const frozenMe = authorized.machine?.frozenWhen
              ? () =>
                  (frozenPerson ??= whenPerson(
                    store,
                    authorized.actor,
                    authorized.people,
                    [...authorized.machine!.frozenWhen!.values()].map((rule) => rule.text),
                  ))
              : undefined;
            /* One update, likewise. `read` is the audit's before image where a batch read them all in one statement:
             a row it lacks a column of (a machine's `since`, added here) is read on its own, as a single update's is. */
            const updateVia = async (
              request: UpdateRequest,
              write: (request: UpdateRequest) => Promise<UpdateResult>,
              read?: (request: UpdateRequest) => QueryResult | undefined,
              lockedBefore?: () => Record<string, unknown> | undefined,
            ): Promise<UpdateResult> => {
              checkCancelled();
              if (request.table === command.target) guardTarget(request.key);
              /* A frozen row (`frozen`, appModel.ts) takes no change, judged of the row as stored, before any write. */
              await assertWriteNotFrozen(
                authorized.machine?.frozenWhen,
                store,
                authorized.catalog,
                request.table,
                request.key,
                now(),
                frozenMe,
              );
              const said = Object.keys(request.values);
              /* A machine's column moves along an edge of its graph, and its `since` with it. The audit's before image
               is read with the state, in its one read, where the machine reads one. */
              let seen: QueryResult | undefined;
              request = await machineUpdate(
                authorized.machine,
                request,
                store,
                now(),
                authorized.catalog,
                authorized.timezone,
                auditing ? Object.keys(request.values) : [],
                (found) => (seen = found),
              );
              request = bindMoments(authorized, request);
              seen ??= auditing ? read?.(request) : undefined;
              // The before image is the audit's; a command that keeps none does not read it.
              const audited = Object.keys(request.values);
              const cachedBefore = !seen && auditing ? lookupSnapshotRow(request.table, request.key) : undefined;
              let before = auditing
                ? await resolveBeforeImage(store, request, audited, seen, cachedBefore, Boolean(lockedBefore))
                : undefined;
              let result: UpdateResult;
              try {
                result = await write(request);
              } catch (error) {
                if (isWriteConflict(error) && request.table === command.target) conflictKey = request.key;
                else if (unproved(error)) footprintFault ??= footprintFailure(commandId, authorized, request);
                throw error;
              }
              forgetSnapshotRow(request.table, request.key);
              tally(request.table, result.affected);
              if (result.affected === 0) return result;
              if (!before && auditing && lockedBefore) {
                const locked = lockedBefore();
                before =
                  locked && audited.every((c) => Object.hasOwn(locked, c)) ? { rows: [projectBeforeRow(locked, audited)] } : { rows: [] };
              }
              if (before && before.rows.length !== 1) {
                throw recordRefusalCause(
                  new BusinessCommandExecutionError('invalid_result'),
                  `Command "${commandId}" updated ${request.table} by a key that matched ${before.rows.length} rows; an update names exactly one row by its primary key.`,
                );
              }
              if (auditing)
                recordChange({
                  operation: 'update',
                  resource: request.table,
                  key: request.key,
                  before: before!.rows[0],
                  after: result.applied,
                });
              else if (request.table === command.target) attribute(request.key);
              if (request.table === command.target) wrote(request.key, Object.keys(request.values), said);
              if (scoped && request.table === command.target) {
                const at = heldKey(request.key);
                if (at) held.add(at);
              }
              return result;
            };
            /* A batch update's before images, read in one statement: every row it names, by its key. */
            const beforeImages = (requests: readonly UpdateRequest[]) =>
              auditing && requests.length ? readBatchBeforeImages(store, requests) : Promise.resolve(undefined);
            /* A table the actor cannot read takes this command's new rows and gives nothing back (insertOnly): every
             read, change and removal is refused, but an `elevate: { read }` table is read under the command's authority. */
            const addingOnly = (table: string, reading = false) => {
              const said = authorized.insertOnly?.get(table);
              if (reading && command.elevate?.read.includes(table)) return;
              if (said !== undefined) throw new BusinessCommandExecutionError('forbidden', 'not_applied', undefined, undefined, said);
            };
            // Audit explicit write intent, not trigger/default after-images. Deletions
            // retain identity, not potentially sensitive fields from the deleted row.
            const tx = Object.freeze<WriteTransaction>({
              query: (request) =>
                accept(
                  request,
                  async (request) => {
                    checkCancelled();
                    addingOnly(request.table, true);
                    const result = await store.query(request);
                    if (snapshotRows && result.rows.length === 1) rememberSnapshotRow(request.table, result.rows[0]);
                    return result;
                  },
                  true,
                ),
              count: (table, filter) =>
                accept(
                  { table, filter },
                  async ({ table, filter }) => {
                    checkCancelled();
                    addingOnly(table, true);
                    return store.count(table, filter);
                  },
                  true,
                ),
              /* Sums and groups read as `count` reads, through the same store and its scope; a store that cannot say one
               leaves this out, and the handler's db refuses (commandDb.ts). */
              ...(store.aggregate
                ? {
                    aggregate: (request: AggregateRequest) =>
                      accept(
                        request,
                        async (request) => {
                          checkCancelled();
                          addingOnly(request.table, true);
                          return store.aggregate!(request);
                        },
                        true,
                      ),
                  }
                : {}),
              ...(store.cte
                ? {
                    cte: (request: CteRequest) =>
                      accept(
                        request,
                        async (request) => {
                          checkCancelled();
                          for (const tbl of cteTables(request)) addingOnly(tbl, true);
                          return store.cte!(request);
                        },
                        true,
                      ),
                  }
                : {}),
              insert: (request) => accept(request, (request) => insertVia(request, (request) => store.insert(request))),
              update: (request) =>
                accept(request, async (request) => {
                  addingOnly(request.table);
                  return updateVia(request, (request) => store.update(request));
                }),
              remove: (request) =>
                accept(request, async (request) => {
                  checkCancelled();
                  addingOnly(request.table);
                  if (request.table === command.target) guardTarget(request.key);
                  await assertWriteNotFrozen(
                    authorized.machine?.frozenWhen,
                    store,
                    authorized.catalog,
                    request.table,
                    request.key,
                    now(),
                    frozenMe,
                  );
                  const own = request.table === command.target ? heldKey(request.key) : undefined;
                  if (own && !held.has(own)) await authorized.assertTarget?.(records, request.key);
                  const result = await store.remove(request);
                  forgetSnapshotRow(request.table, request.key);
                  tally(request.table, result.affected);
                  if (own) {
                    held.delete(own);
                    if (result.affected === 1) removed.add(own);
                  }
                  // A removed row's links end with it, in this transaction: a key reused later opens nothing minted before.
                  const linked = authorized.linkedTables?.get(request.table);
                  if (linked !== undefined && result.affected > 0 && typeof journal.revokeLinks === 'function')
                    await journal.revokeLinks(authorized.actor.appId, linked, commandKeyText(request.key), undefined, now().getTime());
                  if (auditing) recordChange({ operation: 'delete', resource: request.table, key: request.key });
                  return result;
                }),
            });
            /* The handler's `db` has a transaction with batches beside it; `context.tx`, the escape hatch, keeps its
             one-row surface. A batch: each row through everything above, its write one row of one statement. A store
             that carries none (a draft, a SQLite row scope) leaves these out, and the db writes a row at a time. */
            const batched = Object.freeze<WriteTransaction>({
              ...tx,
              ...(store.insertMany
                ? {
                    insertMany: (requests: readonly InsertRequest[]) =>
                      accept(requests, (requests) => gathered(requests, insertVia, (rows) => store.insertMany!(rows))),
                  }
                : {}),
              ...(store.updateMany
                ? {
                    updateMany: (requests: readonly UpdateRequest[]) =>
                      accept(requests, async (requests) => {
                        for (const request of requests) addingOnly(request.table);
                        const defer = scoped && auditing && requests.length >= 2;
                        const read = defer ? undefined : await beforeImages(requests);
                        let i = 0;
                        return collectLockedBefores((sink) =>
                          gathered(
                            requests,
                            (req, write) => {
                              const at = i++;
                              return updateVia(req, write, read, defer ? () => sink.rows?.[at] : undefined);
                            },
                            (rows) => store.updateMany!(rows),
                          ),
                        );
                      }),
                  }
                : {}),
            });
            try {
              // A command that names a record gets it read here, in this transaction,
              // before its handler runs: present, at the revision the form saw (a
              // service principal names none: a job acts on the row as it is now),
              // and in the state `when` requires. Every target in the client's
              // order; a refusal names the key when the request listed several.
              const catalog = authorized.catalog,
                table = catalog?.[command.target];
              if (!table) throw new AppAccessDenied();
              /* Inside the command's transaction, so through its journal: a second writer would nest in it (SQLite
               refuses that) or wait on it. Buffered in order while reads run (including Promise.all waves) and flushed
               in one batch before COMMIT, so audited reads never serialize a command's pipelined queries. */
              const heldAudits: ReadAuditRow[] = [];
              const heldAudit: CommandReadAudit | undefined = authorized.readAudit && {
                ...authorized.readAudit,
                sink: Object.freeze<ReadAuditSink>({
                  ...authorized.readAudit.sink,
                  held: true,
                  append: async (row) => {
                    if (typeof journal.appendReadAudit !== 'function')
                      throw new Error('this database keeps no read audit in a command transaction');
                    assertReadAuditRow(row);
                    heldAudits.push(row);
                  },
                }),
              };
              /* The target is the one read of the executor's own that the read audit hears: the person acted on that
               record, so it is a line under this command whether or not a lookup or the handler reads it too. */
              const auditedTarget = authorized.audited?.tables.get(command.target);
              const targets: UntypedRow[] = [];
              /* `me` in the command's `when` and its inputs' is this actor (commandWhen.ts whenPerson), read once; it
               carries the tenant's profile, which an input's record part may compare with. */
              const person =
                command.targets !== 'none' && !creating
                  ? await whenPerson(tx, authorized.actor, authorized.people, [
                      command.when,
                      authorized.machine?.frozenWhen?.get(command.target)?.text,
                      ...command.fields.map((field) => (field.type === 'group' ? undefined : field.when)),
                    ])
                  : undefined;
              const me = authorized.tenant
                ? { ...(person ?? { email: authorized.actor.email ?? null }), tenant: authorized.tenant }
                : person;
              if (command.targets !== 'none' && !creating) {
                for (const [index, key] of list.keys.entries()) {
                  checkCancelled();
                  const refused = (code: 'not_found' | 'stale_record' | 'ineligible_state') =>
                    new BusinessCommandExecutionError(code, 'not_applied', undefined, key);
                  const exact = canonicalKey(table, key);
                  if (!exact) throw refused('not_found');
                  /* The row as `when` admits it, in one read: the common case, an
               eligible target, is then one statement where it was a read and
               a count. Only a row it does not admit is read again by its key
               alone, to say which refusal it is — not found, moved, or not in
               the state `when` requires — in that order, as before. A `when`
               that reads a rollup or a computed column is judged once the row
               is read (commandWhen.ts), in this transaction all the same. */
                  const when = command.when === undefined ? undefined : compileWhen(table, command.when, now(), me);
                  const derives = Boolean(when?.derived.size);
                  const [named] = keyFilter(exact).groups;
                  let found =
                    when && !when.none && !derives
                      ? await tx.query({
                          table: command.target,
                          ...(authorized.versionField === undefined ? { binary: true as const } : {}),
                          limit: 2,
                          offset: 0,
                          filter: { groups: when.filter.groups.length ? when.filter.groups.map((group) => [...named, ...group]) : [named] },
                        })
                      : undefined;
                  let eligible = found?.rows.length === 1;
                  if (!eligible)
                    found = await tx.query({
                      table: command.target,
                      ...(authorized.versionField === undefined ? { binary: true as const } : {}),
                      filter: keyFilter(exact),
                      limit: 2,
                      offset: 0,
                    });
                  if (!found!.rows.length) {
                    // Hidden or absent: a hidden one is refused as the row scope refuses it.
                    if (track !== undefined) await authorized.assertTarget?.(records, key);
                    throw refused('not_found');
                  }
                  if (found!.rows.length !== 1) {
                    throw recordRefusalCause(
                      new BusinessCommandExecutionError('invalid_result'),
                      `Command "${commandId}"'s target key matched ` +
                        `${found!.rows.length} rows of ${command.target}; a target names exactly one row.`,
                    );
                  }
                  /* A frozen row (`frozen`, appModel.ts) takes no command at all, one that only reads it included: judged
               of the row as stored, before the command's own `when`, so the refusal says what the record is. */
                  const frozenRule = authorized.machine?.frozenWhen?.get(command.target);
                  if (
                    frozenRule &&
                    (await rowFrozen(
                      tx,
                      authorized.catalog,
                      command.target,
                      exact,
                      frozenRule,
                      now(),
                      me,
                      normalizeRow(table, found!.rows[0]),
                    ))
                  )
                    throw new BusinessCommandExecutionError('frozen', 'not_applied', undefined, key, frozenRule.said);
                  /* The revision the request holds is the row's as read now: its
               version column, or the digest of the row (commandRevision.ts),
               taken before the row is normalized, as prepare takes it. A job
               names none: it acts on the row as it is. */
                  let movedSince = false;
                  if (authorized.actor.kind !== 'service' && authorized.actor.kind !== 'public') {
                    const revision = rowRevision(found!.rows[0], authorized.versionField);
                    if (revision === undefined) {
                      throw recordRefusalCause(
                        new BusinessCommandExecutionError('invalid_result'),
                        `Command "${commandId}" could not take the revision of its ` +
                          `${command.target} row${authorized.versionField === undefined ? '' : ` from its version column "${authorized.versionField}"`}.`,
                      );
                    }
                    /* A command is refused here, before the handler, if the record moved since the request read it. One that
                   declares `appendOnly` is adding child rows — a note, a comment, an attachment — and has nothing of the
                   target's to overwrite; under churn on the record every retry was refused for a change it never touched.
                   It is refused at its first write to the target instead (`guardTarget`), so a stale one that does write a
                   target field still is. A verb of a machine, and a command whose form was prefilled from the record,
                   depend on the record as the person saw it and keep the check up front. */
                    if (!lazyRevision) {
                      if (revision !== list.expectedVersions[index]) throw refused('stale_record');
                    } else {
                      movedSince = revision !== list.expectedVersions[index];
                      if (movedSince) owed.add(commandKeyText(exact));
                    }
                  }
                  const row = normalizeRow(table, found!.rows[0]) as UntypedRow;
                  rememberSnapshotRow(command.target, found!.rows[0]);
                  if (auditedTarget && !lookupAudited.has(commandKeyText(exact)))
                    await auditCommandRead(heldAudit, request.command, {
                      ...auditedTarget,
                      keys: table.key,
                      groups: keyFilter(exact).groups,
                      rows: [row],
                    });
                  let derivedFailure: DerivedFailure | undefined;
                  if (when !== undefined && derives)
                    [eligible] = await whenHolds(
                      tx,
                      catalog!,
                      command.target,
                      when,
                      [row],
                      now(),
                      (_row, failure) => (derivedFailure = failure),
                    );
                  /* A timer's run is its stay's: still in the state it waited in, at the instant it was swept for, and,
                 for a resource's `at` (appAt.ts), still matching its when — judged in this transaction. */
                  if (options.timer) {
                    const timer = options.timer;
                    if (
                      (timer.column !== undefined && String(row[timer.column]) !== timer.state) ||
                      String(row[timer.since]) !== timer.enteredAt
                    )
                      throw refused('ineligible_state');
                    if (timer.when !== undefined) {
                      const holds = compileWhen(table, timer.when, now());
                      const still = holds.none
                        ? 0
                        : (
                            await tx.query({
                              table: command.target,
                              limit: 2,
                              offset: 0,
                              filter: {
                                groups: holds.filter.groups.length ? holds.filter.groups.map((group) => [...named, ...group]) : [named],
                              },
                            })
                          ).rows.length;
                      if (still !== 1) throw refused('ineligible_state');
                    }
                  }
                  /* A record that moved and no longer qualifies is stale first, as the up-front check always said. */
                  if (movedSince && when !== undefined && !eligible) throw refused('stale_record');
                  if (when !== undefined && !eligible) {
                    /* Say which part of the `when` the record fails, in the App's words for the column and only to a person
                   who reads it; the generic sentence stays where it cannot be said. */
                    const stored = failingCondition(table, when, row);
                    /* A computed column is no column of the table: it may be said when everything it is computed from is
                     the person's to read, and its value is the one the `when` was judged by. */
                    const computed = derivedFailure && table.derived?.computed[derivedFailure.condition.column];
                    const reads = typeof computed === 'object' ? computed.reads : undefined;
                    const why = whenRefusalSentence(
                      catalog![command.target].saying,
                      stored ?? derivedFailure?.condition,
                      row,
                      (column) =>
                        !stored && reads
                          ? reads.every((read) => Object.hasOwn(table.kinds, read) && mayReadTargetColumn(authorized.actor, read))
                          : mayReadTargetColumn(authorized.actor, column),
                      stored ? undefined : derivedFailure,
                    );
                    throw why === undefined
                      ? refused('ineligible_state')
                      : new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, key, why);
                  }
                  /* A verb of the target's machine runs only from a state that lists it: the graph is its precondition. */
                  const graph = authorized.machine?.verb && authorized.machine.tables.get(command.target);
                  if (graph && !authorized.machine!.verb!.from.has(String(row[graph.column]))) {
                    throw recordRefusalCause(
                      refused('ineligible_state'),
                      `Command "${request.command}" is a verb of the machine of "${command.target}" ` +
                        `from ${[...authorized.machine!.verb!.from].map((state) => `"${state}"`).join(', ')}, and the record is "${String(row[graph.column])}".`,
                    );
                  }
                  targets.push(row);
                }
                if (lookupHeld) throw new BusinessCommandExecutionError('stale_record', 'not_applied', undefined, list.keys[0]);
              }
              /* An input asked only where its `when` holds, where that `when` reads the record or the tenant: each
               `record.<path>` part judged of the record in this transaction (following its references as the actor
               reads them), each `tenant.<column>` of the profile the request read, and the rest over the draft — the
               form's truths are judged again here, whatever it was told. A value for one the draft hides is refused,
               as is a required one left empty where it is shown; each names its field, as the form's own checks do. */
              const conditional = command.fields.filter(
                (field) =>
                  field.type !== 'group' &&
                  field.type !== 'lines' &&
                  field.when !== undefined &&
                  readsRecord(field.when) &&
                  (targets.length === 1 || !readsTarget(field.when)),
              );
              if (conditional.length) {
                const bound: Record<string, BoundCondition> = {};
                for (const field of conditional) {
                  bound[field.name] = await bindRecord(
                    (field as { when: string }).when,
                    `input "${field.name}"`,
                    (comparison) =>
                      targets.length === 1
                        ? recordPartHolds(tx, catalog!, command.target, comparison, targets[0], now(), me)
                        : Promise.resolve(false),
                    now(),
                    command.fields,
                    authorized.tenant ?? {},
                  );
                }
                try {
                  judgeDraft(command, (input ?? {}) as Record<string, unknown>, bound, now());
                } catch (error) {
                  if (error instanceof DraftRefusal)
                    throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.path, undefined, error.said);
                  throw error;
                }
                checkCancelled();
              }
              /* An option the tenant's profile does not offer (its `when`), refused as no choice whatever the form drew. */
              const withheldChoice = withheldAnswer(
                withheldOptions(command.fields, authorized.tenant ?? {}),
                (input ?? {}) as Record<string, unknown>,
              );
              if (withheldChoice)
                throw new BusinessCommandExecutionError(
                  'invalid_input',
                  'not_applied',
                  withheldChoice.path,
                  undefined,
                  withheldChoice.reason,
                );
              /* Answers to questions defined in rows, judged against the rows as they stand in this
             transaction and in the reader's tenant, whatever the form drew. */
              const unanswered = await definedAnswerBreak(tx, catalog!, command, input, targets.length === 1 ? targets[0] : undefined);
              if (unanswered)
                throw new BusinessCommandExecutionError('invalid_input', 'not_applied', unanswered.path, undefined, unanswered.reason);
              /* A pick from a table's rows names a row this reader reads here and now, and a member one of this tenant's. */
              const unsourced = (await sourcedChoiceBreak(tx, command, input)) ?? (await memberBreak(command, input, authorized.members));
              if (unsourced)
                throw new BusinessCommandExecutionError('invalid_input', 'not_applied', unsourced.path, undefined, unsourced.reason);
              checkCancelled();
              const available = await evaluateCommandAvailability({
                command,
                commandId: request.command,
                actor: authorized.actor,
                records: targets,
                catalog,
                reader: tx,
                signal,
                now,
                requestId,
                flags,
              });
              const denied = available.findIndex((value) => !value);
              if (denied >= 0) throw new BusinessCommandExecutionError('forbidden', 'not_applied', undefined, list.keys[denied]);
              /* What the handler reads through its `db` and `tx` of an audited resource is written before it has the
               rows, under this command (readAudit.ts auditCommandRead); the executor's own reads around it —
               availability, constants — are the command's machinery, not the handler's reads. */
              const auditedTables = authorized.audited?.tables;
              const audit = (inner: WriteTransaction): WriteTransaction =>
                auditedTables?.size
                  ? Object.freeze<WriteTransaction>({
                      ...inner,
                      async query(read) {
                        const result = await inner.query(read);
                        const found = auditedTables.get(read.table);
                        if (found)
                          await auditCommandRead(heldAudit, request.command, {
                            ...found,
                            keys: catalog[read.table]?.key ?? [],
                            groups: read.filter?.groups,
                            sort: read.orderBy,
                            offset: read.offset,
                            rows: result.rows,
                          });
                        return result;
                      },
                    })
                  : inner;
              const db = createCommandDb({
                tx: audit(batched),
                catalog,
                read: command.read,
                write: command.write,
                now,
                ...(authorized.versionField === undefined ? {} : { versionField: authorized.versionField }),
                target: command.target,
                ...(options.chosen ? { chosen: options.chosen } : {}),
                ...(command.maxChanges === undefined ? {} : { changeCap: command.maxChanges }),
                constant: (table, column, word) => commandConstant(authorized, tx, table.meta, column, word, now()),
                fileRead: lookupFiles?.budget.read ?? 0,
                ...(authorized.fileReads ? { fileReads: authorized.fileReads, fileScope } : {}),
                ...(authorized.files
                  ? {
                      files: authorized.files,
                      afterCommit: (run: () => void) => void afterCommit.push(run),
                      stored: (table: string, data: Uint8Array) => void storedFiles.push([table, data]),
                      placeFile: async (rule: CommandFileRule, values: Record<string, unknown>) => {
                        const placed = await placeFile(rule, values, fileScope);
                        placedFiles.push(placed);
                        return placed.values;
                      },
                    }
                  : {}),
              });
              /* The rows of the machines that move with this command, read before its handler runs: the move at its end
             is of the rows that stood then, so a row the handler inserts (the new one a "replace the earlier ones"
             verb adds) is not moved with the old. */
              const carriedRows = async (at: number, index: number, limit = 257) => {
                const carried = authorized.machine!.carried![at];
                const parent: Record<string, unknown> = { ...targets[index], ...canonicalKey(table, list.keys[index]) };
                return (
                  await tx.query({
                    table: carried.table,
                    columns: [...(authorized.catalog?.[carried.table]?.key ?? []), carried.column],
                    filter: {
                      groups: [
                        carried.reference.from.map((column, at) => ({
                          column,
                          op: '=' as const,
                          value: parent[carried.reference.to[at]] as string | number,
                        })),
                      ],
                    },
                    limit,
                    offset: 0,
                  })
                ).rows;
              };
              const stood: Set<string>[][] = [];
              for (const [at, carried] of (authorized.machine?.carried ?? []).entries()) {
                const key = authorized.catalog?.[carried.table]?.key ?? [];
                stood[at] = [];
                for (const index of targets.keys()) {
                  const rows = await carriedRows(at, index);
                  if (rows.length > 256)
                    throw recordRefusalCause(
                      new BusinessCommandExecutionError('invalid_result'),
                      `Command "${request.command}" moves more than 256 "${carried.table}" rows of one "${command.target}" with it; its audit keeps at most 256.`,
                    );
                  stood[at][index] = new Set(rows.map((row) => carriedKey(key, row)));
                }
              }
              const named =
                command.targets === 'none' || creating ? {} : many ? { records: Object.freeze(targets) } : { record: targets[0] };
              /* A flow's notify step tells of the record its command runs on and no other, in this transaction: the
             notice is kept with the step's receipt, so a replay tells nobody twice (flowCommand.ts). */
              const flowTell =
                flowCommandOf(command) && !many && 'record' in named
                  ? (audience: string, message: string) => {
                      const exact = canonicalKey(authorized.catalog![command.target]!, list.keys[0]);
                      if (!exact || !store.tell) throw new BusinessCommandExecutionError('temporarily_unavailable');
                      const tell = store.tell.bind(store);
                      return accept(
                        { table: command.target, key: exact as Record<string, string | number>, audience, message },
                        async (request) => {
                          checkCancelled();
                          await tell(request);
                        },
                      );
                    }
                  : undefined;
              // Only a public submission is told where it lands, and only by its binding.
              const intake =
                publicActor && (authorized.intake === 'tenant' || authorized.intake === 'platform') ? authorized.intake : undefined;
              const placement =
                publicActor && authorized.placement ? Object.freeze({ tenantId: authorized.placement.tenantId }) : undefined;
              /* The files the input names by id, taken from what this sender holds for this command (stagedFiles.ts):
             deleted in this transaction, so a refusal below holds them again and a commit uses them up. */
              const held = await takeHeldFiles(command.fields, input, journal, {
                appId: authorized.actor.appId,
                command: request.command,
                owner: stagedOwner(publicActor ? actor : authorized.actor, options.visitor),
                now: now().getTime(),
                ...(options.delivered ? { delivered: options.delivered } : {}),
              });
              const handed = Object.keys(held.files).length ? { ...held.files, ...revealed } : revealed;
              /* A link's run is read again in the transaction that runs it: one revoked or expired since the page
               opened runs nothing, whatever session its holder still carries. In a tenant App it is the tenant's own
               link that is read, so one minted in another tenant is none here. */
              if (authorized.actor.kind === 'link') {
                const holds = authorized.actor.link;
                const live = holds && (await journal.readLink?.(authorized.actor.appId, holds.id, now().getTime()));
                if (
                  !holds ||
                  !live ||
                  live.tenant !== (receiptOwner?.tenantId ?? '') ||
                  live.resource !== holds.resource ||
                  live.rowKey !== holds.key ||
                  live.name !== holds.name
                )
                  throw new AppAccessDenied();
              }
              const links = handlerLinks({
                journal,
                appId: authorized.actor.appId,
                tenant: receiptOwner?.tenantId ?? '',
                resource: authorized.resource,
                command: request.command,
                actorId: authorized.actor.id,
                links: authorized.links,
                tenantApp: receiptOwner !== undefined,
                rowKey:
                  (command.targets ?? 'one') === 'one' && !creating && !many && list.keys.length === 1
                    ? commandKeyText(list.keys[0])
                    : authorized.actor.kind === 'public'
                      ? () => (madeOnTarget.length === 1 ? madeOnTarget[0] : undefined)
                      : undefined,
                now,
              });
              const output = await withoutRevealed(revealed, () =>
                executeWithCommandFlags(flags, command.enabledBy, (executionFlags) =>
                  command.handle(
                    Object.freeze({
                      actor: authorized.actor,
                      door: options.entry ?? (options.door ? handlerDoorOf(options.door) : 'ui'),
                      requestId,
                      commandId: request.command,
                      version: command.version,
                      source: command.source,
                      signal,
                      now,
                      today: () => zoneDay(now(), authorized.timezone),
                      timezone: authorized.timezone ?? 'UTC',
                      locale,
                      chosen: chosenContext(options.chosen),
                      flags: executionFlags,
                      db,
                      cte: cteOf(db),
                      tx: audit(tx),
                      nextNumber: handlerNextNumber(journal, authorized.actor.appId),
                      link: links.link,
                      revokeLinks: links.revokeLinks,
                      publicLink: authorized.publicLink ?? noPublicLinks,
                      ...named,
                      ...(lookupRun ? { lookup } : {}),
                      ...(intake ? { intake } : {}),
                      ...(authorized.tenant ? { tenant: authorized.tenant } : {}),
                      ...(placement ? { placement } : {}),
                      ...(draft ? { draft: draft.context } : {}),
                      ...(options.files ? { files: Object.freeze(options.files.map((file) => Object.freeze({ ...file }))) } : {}),
                      ...(flowTell ? { [FLOW_TELL]: flowTell } : {}),
                    }),
                    Object.keys(handed).length ? Object.freeze({ ...(input as object), ...handed }) : input,
                  ),
                ),
              );
              /* A held file becomes its row in this transaction or the command does not commit: one left unstored would be
             used up and kept nowhere. */
              for (const file of held.taken)
                if (!storedFiles.some(([table, data]) => table === held.from.get(file) && data === file.data))
                  throw recordRefusalCause(
                    new BusinessCommandExecutionError('invalid_result'),
                    `Command "${request.command}" was sent the file "${file.name}" for ${held.from.get(file)} and did not store it; ` +
                      `store each with db.${held.from.get(file)}.insertFile(file, values).`,
                  );
              /* A whole sensitive value is the handler's alone: an output that says it back would put it in the receipt,
             the journal and the reader's screen. */
              if (Object.keys(revealed).length) {
                const said = JSON.stringify(output ?? null);
                if (Object.values(revealed).some((value) => value.length >= 4 && said.includes(value)))
                  throw recordRefusalCause(
                    new BusinessCommandExecutionError('invalid_result'),
                    `Command "${request.command}" returned a sensitive input's whole value; a handler may use it, never return it.`,
                  );
              }
              /* The machines that move with this command (a payment's `cancelOrder: 'voided'`): each row of each
             record moves along its edge, through the same writes a handler's go through — the graph, `since`
             and the audit. A row already final, or already where the command leads, stays; any other means
             the command does not apply to it, and the whole command is refused. */
              for (const [at, carried] of (authorized.machine?.carried ?? []).entries()) {
                const key = authorized.catalog?.[carried.table]?.key ?? [];
                for (const index of targets.keys()) {
                  attribute(list.keys[index]);
                  // What stood, and room for what the handler added beside it; past that, a row that stood could be unread.
                  const limit = stood[at][index].size + 257;
                  const rows = await carriedRows(at, index, limit);
                  const seen = new Set(rows.map((row) => carriedKey(key, row)));
                  if (rows.length === limit && [...stood[at][index]].some((row) => !seen.has(row)))
                    throw recordRefusalCause(
                      new BusinessCommandExecutionError('invalid_result'),
                      `Command "${request.command}" inserted more than 256 "${carried.table}" rows of one "${command.target}" that moves them with it; ` +
                        'its move reads at most 256 beside the ones that stood.',
                    );
                  for (const row of rows) {
                    // A row the command made itself is where the command meant it to be.
                    if (!stood[at][index].has(carriedKey(key, row))) continue;
                    const state = String(row[carried.column]);
                    const to = carried.moves.get(state);
                    if (to !== undefined) {
                      await tx.update({
                        table: carried.table,
                        key: Object.fromEntries(key.map((column) => [column, row[column] as string | number])),
                        values: { [carried.column]: to },
                      });
                    } else if (!carried.done.has(state)) {
                      throw recordRefusalCause(
                        new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, list.keys[index]),
                        `Command "${request.command}" moves each "${carried.table}" of the "${command.target}" with it, from ` +
                          `${[...carried.moves.keys()].map((from) => `"${from}"`).join(', ')}; one is "${state}".`,
                      );
                    }
                  }
                }
              }
              await operations.finish();
              checkCancelled();
              /* A verb leaves its record in one of the states it leads to, or where it was. */
              const graph = authorized.machine?.verb?.to.size ? authorized.machine.tables.get(command.target) : undefined;
              if (graph && targets.length) {
                for (const [index, before] of targets.entries()) {
                  const exact = canonicalKey(table, list.keys[index])!;
                  const after = await store.query({
                    table: command.target,
                    columns: [graph.column],
                    filter: keyFilter(exact),
                    limit: 1,
                    offset: 0,
                  });
                  const state = String(after.rows[0]?.[graph.column]);
                  const destinations = authorized.machine!.verb!.to.get(String(before[graph.column]));
                  if (after.rows.length && state !== String(before[graph.column]) && destinations && !destinations.has(state)) {
                    throw recordRefusalCause(
                      new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, list.keys[index]),
                      `Command "${request.command}" left the "${command.target}" in "${state}"; the machine's verb leads to ${[...destinations].map((to) => `"${to}"`).join(' or ')}.`,
                    );
                  }
                }
              }
              // The application keeps its place, or is finished, in this transaction.
              await draft?.finish();
              let resultJson: string;
              try {
                resultJson = canonicalCommandJson(command.output.parse(output), 16384);
              } catch (error) {
                throw recordRefusalCause(
                  new BusinessCommandExecutionError('invalid_result'),
                  command.output === NO_OUTPUT
                    ? `Command "${request.command}" returned a value but declares no output. Declare \`output: shape({ … })\` naming what it returns, or return nothing.`
                    : error instanceof CommandInputError && error.field
                      ? `Command "${request.command}" returned a result its output declaration refuses at "${error.field}".`
                      : `Command "${request.command}" returned a result that is not its declared output, or is over 16 KiB of JSON.`,
                );
              }
              const result = immutableResult(resultJson);
              await authorized.assertResult?.(records, list.keys[0], result);
              await assertTargets();
              checkCancelled();
              let eventBatch: CommandEventBatch | undefined;
              try {
                /* An effect's body may be read from rows: through the command's db, read-only, in this transaction and
                 limited to what the command reads, opened only when it has an effect. A replay never comes here. */
                const resolved = events
                  ? await resolveCommandEffects(events, result, () => {
                      /* The handler's queue was finished above, once its writes had settled; the projection's reads take a
                       fresh one on the same transaction, finished below, so a read it leaves in flight cannot outlive it. */
                      operations = new TransactionOperations(true);
                      return {
                        db: effectProjectionDb(
                          createCommandDb({
                            tx: audit(batched),
                            catalog,
                            read: command.read,
                            write: [],
                            now,
                            target: command.target,
                            constant: (table, column, word) => commandConstant(authorized, tx, table.meta, column, word, now()),
                          }),
                        ),
                      };
                    })
                  : undefined;
                await operations.finish();
                eventBatch = events ? projectCommandEvents(events, result, resolved) : undefined;
              } catch (error) {
                // A body over its limit, or a projection that wrote or read past the grants, is the author's to fix: by name.
                if (error instanceof EffectBodyTooLarge || error instanceof EffectProjectionRefused)
                  throw recordRefusalCause(
                    new BusinessCommandExecutionError('invalid_result'),
                    recordRefusalCause(new Error(`Command "${commandId}": ${error.message}`), error),
                  );
                throw recordRefusalCause(
                  new BusinessCommandExecutionError('invalid_result'),
                  recordRefusalCause(new Error(`Command "${commandId}"'s events could not be ` + 'made from its result.'), error),
                );
              }
              // Each event the command records, on its span: the name and version travel, the payload stays local.
              for (const event of eventBatch ?? []) {
                currentSpan()?.event('mistri.event', { 'mistri.event.name': event.name, 'mistri.event.version': event.version });
              }
              if (eventBatch?.length)
                currentSpan()?.detail(() => ({
                  events: eventBatch!.map((event) => ({ name: event.name, version: event.version, payload: event.payloadJson })),
                }));
              checkCancelled();
              // A trial ends here, before its receipt, provenance, links and journal: thrown, so all of it rolls back.
              if (trial) throw new TrialRolledBack(trialWrites, JSON.parse(resultJson));
              const id = randomUUID();
              const completedAt = now().toISOString();
              // One receipt names every target through its audit rows, in order.
              const framedAudit = Boolean((publicActor && eventBatch?.length) || authorized.actor.scope);
              const audits = list.keys.map((key, index) => {
                if (!framedAudit) {
                  const entries = changeJsons[index];
                  const changesJson = `[${entries.slice(0, AUDIT_PART_ENTRIES).join(',')}]`;
                  const parts: string[] = [];
                  for (let from = AUDIT_PART_ENTRIES; from < entries.length; from += AUDIT_PART_ENTRIES)
                    parts.push(`[${entries.slice(from, from + AUDIT_PART_ENTRIES).join(',')}]`);
                  return {
                    target: receiptOwner ? resource : authorized.resource,
                    keyJson: canonicalCommandJson(key, 8192),
                    changesJson,
                    ...(parts.length ? { changesParts: Object.freeze(parts) } : {}),
                  };
                }
                return {
                  target: receiptOwner ? resource : authorized.resource,
                  keyJson: canonicalCommandJson(key, 8192),
                  ...splitAudit(changes[index], (head) =>
                    publicActor && eventBatch?.length
                      ? commandVisitorAudit(flags, head)
                      : authorized.actor.scope
                        ? scopedAudit(authorized.actor.scope, head)
                        : head,
                  ),
                };
              });
              const actorKind = madeAs;
              if (wroteOnTarget.size)
                await settleProvenance(journal, actorKind, completedAt, {
                  authorized,
                  written: wroteOnTarget,
                  tenant: receiptOwner?.tenantId ?? '',
                  input: request.input,
                  proposalId: options.proposalId,
                  makerActor: options.makerActor,
                  evidence: options.evidence,
                });
              const receipt = {
                ...scope,
                id,
                fingerprint,
                resultJson,
                requestId,
                completedAt,
                actorKind,
                ...(options.proposalId === undefined ? {} : { proposalId: options.proposalId }),
              };
              await mintQueued(journal, links, id);
              // A command that keeps no receipt leaves receipt_id empty: the id would name a row that never exists.
              if (
                options.proposalId !== undefined &&
                track !== 'none' &&
                !(await journal.settleProposal?.(authorized.actor.appId, options.proposalId, id))
              )
                throw new BusinessCommandExecutionError('temporarily_unavailable');
              if (heldAudits.length) {
                try {
                  for (let i = 0; i < heldAudits.length; i += 256) await journal.appendReadAudit!(heldAudits.slice(i, i + 256));
                } catch (error) {
                  throw new ReadAuditFailed(`The read could not be recorded in the read audit: ${(error as Error).message}`, {
                    cause: error,
                  });
                }
              }
              if (track === undefined) await journal.commit(receipt, audits.length === 1 ? audits[0] : audits, eventBatch);
              // The receipt, its audit and the replay check are one statement: taken, this attempt rolls back and replays it.
              else if (track !== 'none' && !(await journal.insert!(receipt, audits.length === 1 ? audits[0] : audits)))
                throw new ReceiptTaken();
              checkCancelled();
              /* Said only whole: a table with no id in the catalog, or one this person cannot read, leaves it unsaid. */
              const wroteIds = [...wroteTables].map((table) =>
                authorized.insertOnly?.has(table) ? undefined : authorized.catalog?.[table]?.schemaId,
              );
              if (wroteIds.every((table) => table !== undefined)) tellWrites(id, wroteIds as string[]);
              return answer(id, scoped ? result : JSON.parse(resultJson), false);
            } catch (error) {
              await operations.finish().catch(() => {});
              throw error;
            }
          }),
        ),
      ),
    );
    for (const run of afterCommit.splice(0)) {
      try {
        run();
      } catch {
        /* Work after the commit never changes the command's answer. */
      }
    }
    if (committed.status === 'applied') settleInFlight?.(committed);
    return committed;
  } catch (error) {
    /* A trial's end: its transaction rolled back, so what it would have started after a commit is dropped and the
       files it placed are deleted. Only one known rolled back is answered so; an unknown outcome is said as one. */
    const ended = error instanceof CommandTransactionFailure ? error.cause : error;
    if (ended instanceof TrialRolledBack && !(error instanceof CommandTransactionFailure && error.outcome === 'unknown')) {
      afterCommit.length = 0;
      for (const placed of placedFiles.splice(0)) await placed.discard();
      return { status: 'trial', ran: true, writes: ended.writes, result: ended.result };
    }
    let cause = footprintFault ?? (error instanceof CommandTransactionFailure ? error.cause : error);
    /* The fresh path checked for its receipt without a lock, so a delivery
       of the same request can commit after the check: this attempt then
       finds its receipt taken at commit, or finds the record already moved by
       it (stale, ineligible, gone, a duplicate). Either is looked up now, in
       a transaction of its own that takes the scope's lock and waits for a
       delivery still in flight, and a receipt found is the answer. Only an
       attempt that rolled back is looked up — one whose commit may have
       landed stays unknown — and a lookup that cannot answer leaves the
       attempt's own refusal. */
    const rolledBack = error instanceof CommandTransactionFailure && error.outcome === 'not_applied';
    if (rolledBack) for (const placed of placedFiles.splice(0)) await placed.discard();
    const racedBy = (reason: unknown) =>
      reason instanceof ReceiptTaken ||
      isWriteConflict(reason) ||
      (isBusinessCommandExecutionError(reason) &&
        ['stale_record', 'ineligible_state', 'not_found', 'duplicate_record'].includes(reason.code)) ||
      writeFailureKind(reason) === 'unique';
    if (tracked && !trial && rolledBack && racedBy(cause)) {
      try {
        const status = await executeUntraced(binding, actor, rawRequest, { ...options, statusOnly: true, door: undefined });
        if (status.status === 'applied') {
          settleInFlight?.(status);
          return status;
        }
        priorOutcomeUnknown = false;
      } catch (lookup) {
        // The key was used for a different request: said as the receipt-first path says it.
        if (isBusinessCommandExecutionError(lookup) && lookup.code === 'idempotency_conflict') {
          const conflict = new BusinessCommandExecutionError('idempotency_conflict', scoped ? 'unknown' : 'not_applied');
          settleInFlight?.(undefined, conflict);
          throw conflict;
        }
      }
      if (cause instanceof ReceiptTaken) {
        const unavailable = new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
        settleInFlight?.(undefined, unavailable);
        throw unavailable;
      }
    }
    /* A refusal that keeps something (refuse(code, { keep })) is answered once its keep commits. Only after a
       rollback known to have happened: an attempt whose commit may have landed keeps nothing more. A keep the record
       moved under is run again, three times at most; a keep that fails is what the caller hears, since what the
       refusal had to leave behind is not there. */
    // A trial keeps nothing: what a refusal would leave behind is the real run's to leave.
    const keep = rolledBack && !options.statusOnly && !trial && keepRefused ? refusalKeep(cause) : undefined;
    if (keep) {
      for (let attempt = 0; ; attempt++) {
        try {
          await keepRefused!(keep);
          break;
        } catch (kept) {
          const reason = kept instanceof CommandTransactionFailure ? kept.cause : kept;
          const unknown = kept instanceof CommandTransactionFailure && kept.outcome === 'unknown';
          const stale = isWriteConflict(reason) || (isBusinessCommandExecutionError(reason) && reason.code === 'stale_record');
          if (stale && !unknown && attempt < KEEP_RETRIES) continue;
          if (unknown) priorOutcomeUnknown = true;
          cause = reason;
          break;
        }
      }
    }
    try {
      rethrowCommandFailure({
        error,
        cause,
        statusOnly: Boolean(options.statusOnly),
        priorOutcomeUnknown,
        transactionStarted,
        scoped,
        snapshot,
        conflictKey,
        given,
        refusedKey,
        sayRefusal,
      });
    } catch (classified) {
      settleInFlight?.(undefined, classified);
      throw classified;
    }
  }
}

export function lookupBusinessCommandStatus(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: Omit<ExecutionOptions, 'statusOnly'> = {},
): Promise<BusinessCommandStatus> {
  return executeBusinessCommand(binding, actor, rawRequest, { ...options, statusOnly: true });
}

/* ---------- what a new row may carry ---------- */

/** One carried row's key, as one string: a row is the same row before and after its handler. */
const carriedKey = (key: readonly string[], row: Record<string, unknown>) => JSON.stringify(key.map((column) => String(row[column])));

/* How many more times a refusal's keep runs when the record moved under it. */
/* An authorization made without an App to read (a test's) names no public view. */
const noPublicLinks = (view: string): never => {
  throw new TypeError(`publicLink("${String(view)}"): this command's App has no public view to link to.`);
};

const KEEP_RETRIES = 3;
