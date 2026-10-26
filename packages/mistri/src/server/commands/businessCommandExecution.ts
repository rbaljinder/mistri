import { commandVisitorAudit } from '../experiments/commandVisitor.js';
import { createHash, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { inWriteLanes, recordLane } from '@mistriwork/engine/adapters/writeLanes.js';
import { withWriteAhead, type WriteAhead } from '@mistriwork/engine/adapters/writeAhead.js';
import { isWriteConflict, Refusal, TransactionOperations, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import type { CommandEventBatch } from '../../adapters/events/commandEventTypes.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { ScopeRefusal } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import { lockTimedOut } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { AppValidationDenied, ConsumesRefused } from '../app/appValidationDenied.js';
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
import { canonicalKey, createCommandDb, keyFilter, normalizeRow, type UntypedRow } from './commandDb.js';
import { FLOW_TELL, flowCommandOf } from './flowCommandBrand.js';
import { compileWhen, failingCondition, inputsWithheld, whenHolds, whenPerson } from './commandWhen.js';
import { whenRefusalSentence } from './commandSaying.js';
import { bindRecord, readsRecord, type BoundCondition } from '../../shared/commandDraft.js';
import { mayReadTargetColumn } from './commandActorColumns.js';
import { rowRevision } from './commandRevision.js';
import { preparesInitial } from './commandPrepareNeeds.js';
import { nowStamp, written, zoneDay } from '../app/appStamps.js';
import { stampColumn } from '../../shared/appStamps.js';
import { stateStampColumn } from '@mistriwork/engine/shared/schema.js';
import { wallClockText, withWallClock } from '../app/wallClock.js';
import { createLookupSources, lookupResult } from './commandLookup.js';
import { immutableCommandResult as immutableResult, validateHistoricalCommandOutput } from './commandHistoricalOutput.js';
import { COMMAND_INPUT_LIMITS } from '../../shared/command.js';
import { CommandInputRefusal } from '../../shared/commandInput.js';
import { lineCell } from '../../shared/commandLineCell.js';
import { definedAnswerBreak, sourcedChoiceBreak } from './commandDefined.js';
import { projectCommandEvents } from './businessEvents.js';
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
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from './commandErrors.js';
import { evaluateCommandAvailability } from './commandAvailability.js';
import { constraintColumns, writeFailureKind } from '@mistriwork/engine/server/constraints.js';
import { placeFile, type PlacedFile } from '../files/fileStorage.js';
import type { CommandFileRule } from './businessCommandAuthorization.js';
import { openSavedDraft, type SavedDraftRun } from '../forms/savedForms.js';
import { currentSpan, errorCode, inSpan, tracing } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { refusalCause, refusalReasons } from '@mistriwork/engine/shared/refusal.js';
import { handlerNextNumber } from '../../adapters/commands/commandSequences.js';
import { commandFlagEnabled, commandFlagsReader, executeWithCommandFlags, type CommandFlags } from './commandFlags.js';

// Keep existing internal imports compatible; handlers and metadata use the leaf directly.
export { BusinessCommandExecutionError, isBusinessCommandExecutionError, refuse } from './commandErrors.js';
export { effectiveTrack, type CommandDoor, type CommandHandlerDoor } from './commandTrack.js';
import { effectiveTrack, handlerDoorOf, type CommandDoor, type CommandHandlerDoor, type CommandTrack } from './commandTrack.js';
import { integrationCalls } from '../integrations/integrationRuntime.js';
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
  /** A saved public form's step, from its route: the application it runs in is found here, in its transaction (savedForms.ts). */
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
  /** Files the host received for this run, beside the input (an inbound email's attachments): the handler's `files`. */
  files?: readonly import('./businessCommands.js').CommandFile[];
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
  options: ExecutionOptions = {},
): Promise<BusinessCommandStatus> {
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
  return executeObserved(binding, actor, rawRequest, options);
}

async function executeObserved(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: ExecutionOptions,
): Promise<BusinessCommandStatus> {
  if (!tracing()) return executeUntraced(binding, actor, rawRequest, options);
  /* The command's span: its id and version, how it came out and the refusal
     code travel; its input, its output and a refusal's recorded cause stay
     local, for the dev observer (adapters/telemetry/trace.ts). The id and
     version are read from the request only once the envelope parses them as
     the registered ones: an arbitrary string is never a label. */
  const envelope =
    rawRequest && typeof rawRequest === 'object' ? (rawRequest as { command?: unknown; commandVersion?: unknown; input?: unknown }) : {};
  const id = typeof envelope.command === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(envelope.command) ? envelope.command : undefined;
  return inSpan(
    options.statusOnly ? `command status ${id ?? ''}`.trim() : `command ${id ?? ''}`.trim(),
    {
      attributes: {
        'mistri.command.id': id,
        'mistri.command.version': typeof envelope.commandVersion === 'number' ? envelope.commandVersion : undefined,
        ...(options.statusOnly ? { 'mistri.command.status_only': true } : {}),
      },
    },
    async (span) => {
      span.detail(() => {
        const { input, ...rest } = envelope as Record<string, unknown>;
        return { input, envelope: rest };
      });
      try {
        const result = await executeUntraced(binding, actor, rawRequest, options);
        const applied = result as Partial<BusinessCommandResult> & { status: string };
        span.setAttributes({
          'mistri.command.outcome': applied.status === 'applied' ? (applied.replayed ? 'replayed' : 'applied') : applied.status,
          'mistri.command.target': applied.resource,
        });
        span.detail(() => ({ output: applied.result, receiptId: applied.receiptId, key: applied.key }));
        return result;
      } catch (error) {
        if (isBusinessCommandExecutionError(error)) {
          span.setAttributes({ 'mistri.command.outcome': error.outcome, 'mistri.refusal.code': error.code });
          span.detail(() => ({
            refusal: {
              code: error.code,
              message: error.message,
              ...(error.field ? { field: error.field } : {}),
              ...(error.reason ? { reason: error.reason } : {}),
            },
            because: refusalReasons(error),
          }));
        }
        throw error;
      }
    },
    errorCode,
  );
}

async function executeUntraced(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  rawRequest: unknown,
  options: ExecutionOptions = {},
): Promise<BusinessCommandStatus> {
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
  /* Objects a handler's insertFile put in a bucket (files/fileStorage.ts):
     deleted when the transaction is known to have rolled back, and left for
     the sweep when its outcome is unknown. */
  const placedFiles: PlacedFile[] = [];
  /* Started after the transaction has committed, and dropped with a failed attempt (a retried one makes its own). */
  const afterCommit: Array<() => void> = [];
  /* The parsed input, kept for a refusal: the field a broken constraint names is marked only when the input has it. */
  let given: unknown;
  try {
    // Only the actor's own declared kind, or the binding's word that a
    // signed-in form runs the command, decides whether an empty key is
    // admitted; the authorizer then proves the principal whole or refuses it.
    const publicActor = !!actor && typeof actor === 'object' && Object.getOwnPropertyDescriptor(actor, 'kind')?.value === 'public';
    const creates = (command: string): boolean => publicActor || binding.creates?.(command) === true;
    const request = parseCommandEnvelope(rawRequest, { creating: creates });
    const creating = creates(request.command);
    // Named in a refusal's recorded reason, where an inner write's own `request` shadows this one.
    const commandId = request.command;
    const list = commandTargetList(request);
    requestKeys = list.keys;
    const authorized = binding.authorize(request.command, actor);
    if (!authorized || typeof authorized !== 'object' || isProxy(authorized)) throw new AppAccessDenied();
    // The authorizer already refuses this; the executor says it again because
    // it is the one boundary a handler's public flag is trusted at. A
    // signed-in form's command is never public and names no key.
    if (
      creating &&
      (list.expectedVersions[0] !== 0 ||
        (publicActor
          ? authorized.command.public !== true || authorized.actor.kind !== 'public'
          : // A signed-in form's, or a job's that runs at its times (`every`), never a public principal's.
            authorized.command.public === true ||
            (authorized.actor.kind !== undefined && authorized.actor.kind !== 'service') ||
            authorized.keyColumns.length !== 0))
    )
      throw new AppAccessDenied();
    if (scoped && (typeof authorized.assertTarget !== 'function' || typeof authorized.assertResult !== 'function'))
      throw new AppAccessDenied();
    const { command } = authorized;
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
    const now = options.now ?? (() => new Date());
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
    // Lookup: the App's other sources, read before the transaction opens, with
    // the target as it stands now. Nothing here refuses yet: the transaction
    // first looks for the request's receipt, so a replay answers as it always
    // did, and only a first attempt hears that its lookup failed.
    const lookupRun = options.statusOnly || !flagEnabled ? undefined : registeredLookup(command);
    let lookup: unknown, lookupFailure: BusinessCommandExecutionError | undefined;
    if (lookupRun) {
      const reader = authorized.lookup;
      const table = authorized.catalog?.[command.target];
      if (!reader || !table) throw new AppAccessDenied();
      try {
        const before: UntypedRow[] = [];
        if (command.targets !== 'none' && !creating) {
          for (const key of list.keys) {
            const exact = canonicalKey(table, key);
            const row = exact ? await reader.target(exact) : undefined;
            if (!row) throw new BusinessCommandExecutionError('not_found', 'not_applied', undefined, key);
            before.push(normalizeRow(table, row) as UntypedRow);
          }
        }
        const stood = command.targets === 'none' || creating ? {} : many ? { records: Object.freeze(before) } : { record: before[0] };
        const value = await lookupRun(
          Object.freeze({
            actor: authorized.actor,
            requestId,
            commandId: request.command,
            version: command.version,
            source: command.source,
            signal,
            now,
            flags,
            sources: createLookupSources({ catalogs: reader.catalogs, query: reader.query, now }),
            // Each call keyed by this request, so a replay re-running lookup is answered from the call's record.
            integrations: integrationCalls({
              appId: scope.appId,
              tenant: receiptOwner?.tenantId ?? '',
              commandId: request.command,
              actorId: scope.actorId,
              idempotencyKey: request.idempotencyKey,
              signal,
              declared: command.integrations,
            }),
            ...stood,
          }),
          input,
        );
        checkCancelled();
        lookup = lookupResult(value);
      } catch (error) {
        if (signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        if (error instanceof AppAccessDenied) throw error;
        lookupFailure = isBusinessCommandExecutionError(error)
          ? new BusinessCommandExecutionError(error.code, 'not_applied', error.field, error.key, error.reason)
          : new BusinessCommandExecutionError('temporarily_unavailable');
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
      targets:
        command.targets !== 'none' && !creating && targetTable
          ? list.keys.flatMap((key) => {
              const exact = canonicalKey(targetTable, key);
              // The table as the transaction names it (the catalog's id), not the command's local name for it.
              return exact ? [{ table: targetTable.meta.id, key: exact }] : [];
            })
          : [],
      writes: command.appendOnly !== true,
    };
    const committed: BusinessCommandStatus = await inWriteLanes(lanes, () =>
      withWriteAhead(ahead, () =>
        authorized.commandTransaction!(async (records, journal) => {
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
          if (track === 'none') priorOutcomeUnknown = false;
          const saved = track === undefined ? await journal.find(scope, events?.expectation) : undefined;
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
          if (track !== undefined && track !== 'none') {
            if (typeof journal.insert !== 'function' || typeof journal.taken !== 'function')
              throw new BusinessCommandExecutionError('temporarily_unavailable');
            if (await journal.taken(scope)) throw new ReceiptTaken();
          }
          // Both receipt paths can recover while disabled, but neither can run a new handler.
          if (!flagEnabled) throw new BusinessCommandExecutionError('forbidden');
          // No receipt answers the request: a failed lookup refuses it now.
          if (lookupFailure) throw lookupFailure;
          /* A saved form's step runs in its own application and nowhere else: the
         root is found by the cookie's hash here, in this transaction, and
         every read and write below is fenced to it. Only a public submission
         carries one. */
          if (options.draft && !publicActor) throw new AppAccessDenied();
          const draft = options.draft
            ? await openSavedDraft(
                options.draft,
                records,
                authorized.catalog ??
                  (() => {
                    throw new AppAccessDenied();
                  })(),
                now(),
              )
            : undefined;
          const store = draft?.records ?? records;
          const operations = new TransactionOperations();
          const accept = <Request, Result>(request: Request, run: (snapshot: Request) => Promise<Result>): Promise<Result> => {
            // Capture before joining the queue: handlers still own their arguments.
            try {
              const snapshot = scoped ? snapshotScopedData(request) : structuredClone(request);
              return operations.run(() => run(snapshot));
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
            if (list.length >= 256) {
              throw recordRefusalCause(
                new BusinessCommandExecutionError('invalid_result'),
                `Command "${request.command}" made more than 256 changes for one target; its audit keeps at most 256.`,
              );
            }
            try {
              // Redacted before the bound is measured: what is checked is what is stored.
              const entry = JSON.parse(canonicalCommandJson(change, 65536)) as Record<string, unknown>;
              for (const side of ['before', 'after']) if (Object.hasOwn(entry, side)) entry[side] = image(entry[side]);
              list.push(entry);
              canonicalCommandJson(list, 65536);
            } catch {
              throw recordRefusalCause(new BusinessCommandExecutionError('invalid_result'), auditRefusal(request.command, change));
            }
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
          // Audit explicit write intent, not trigger/default after-images. Deletions
          // retain identity, not potentially sensitive fields from the deleted row.
          const tx = Object.freeze<WriteTransaction>({
            query: (request) =>
              accept(request, async (request) => {
                checkCancelled();
                return store.query(request);
              }),
            count: (table, filter) =>
              accept({ table, filter }, async ({ table, filter }) => {
                checkCancelled();
                return store.count(table, filter);
              }),
            insert: (request) =>
              accept(request, async (request) => {
                checkCancelled();
                request = machineInsert(authorized.machine, request, now(), authorized.catalog, authorized.timezone);
                request = bindMoments(authorized, request);
                const file = fileInsert(commandId, authorized, request);
                let result: Awaited<ReturnType<typeof store.insert>>;
                try {
                  result = await store.insert(request);
                } catch (error) {
                  if (unproved(error)) footprintFault ??= footprintFailure(commandId, authorized, request);
                  throw error;
                }
                if (auditing)
                  recordChange({
                    operation: 'insert',
                    resource: request.table,
                    key: result.key,
                    after: file ? { ...result.applied, ...file } : result.applied,
                  });
                return result;
              }),
            update: (request) =>
              accept(request, async (request) => {
                checkCancelled();
                if (request.table === command.target) guardTarget(request.key);
                // A machine's column moves along an edge of its graph, and its `since` with it.
                request = await machineUpdate(authorized.machine, request, store, now(), authorized.catalog, authorized.timezone);
                request = bindMoments(authorized, request);
                // The before image is the audit's; a command that keeps none does not read it.
                const before = auditing
                  ? await store.query({
                      table: request.table,
                      columns: Object.keys(request.values),
                      limit: 2,
                      offset: 0,
                      filter: { groups: [Object.entries(request.key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
                    })
                  : undefined;
                let result: Awaited<ReturnType<WriteTransaction['update']>>;
                try {
                  result = await store.update(request);
                } catch (error) {
                  if (isWriteConflict(error) && request.table === command.target) conflictKey = request.key;
                  else if (unproved(error)) footprintFault ??= footprintFailure(commandId, authorized, request);
                  throw error;
                }
                if (before && before.rows.length !== 1) {
                  throw recordRefusalCause(
                    new BusinessCommandExecutionError('invalid_result'),
                    `Command "${commandId}" updated ${request.table} by a key that ` +
                      `matched ${before.rows.length} rows; an update names exactly one row by its primary key.`,
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
                if (scoped && request.table === command.target) {
                  const at = heldKey(request.key);
                  if (at) held.add(at);
                }
                return result;
              }),
            remove: (request) =>
              accept(request, async (request) => {
                checkCancelled();
                if (request.table === command.target) guardTarget(request.key);
                const own = request.table === command.target ? heldKey(request.key) : undefined;
                if (own && !held.has(own)) await authorized.assertTarget?.(records, request.key);
                const result = await store.remove(request);
                if (own) {
                  held.delete(own);
                  if (result.affected === 1) removed.add(own);
                }
                if (auditing) recordChange({ operation: 'delete', resource: request.table, key: request.key });
                return result;
              }),
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
            const targets: UntypedRow[] = [];
            /* `me` in the command's `when` and its inputs' is this actor (commandWhen.ts whenPerson), read once. */
            const me =
              command.targets !== 'none' && !creating
                ? await whenPerson(tx, authorized.actor, authorized.people, [
                    command.when,
                    ...command.fields.map((field) => (field.type === 'group' ? undefined : field.when)),
                  ])
                : undefined;
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
                /* The revision the request holds is the row's as read now: its
               version column, or the digest of the row (commandRevision.ts),
               taken before the row is normalized, as prepare takes it. A job
               names none: it acts on the row as it is. */
                let movedSince = false;
                if (authorized.actor.kind !== 'service') {
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
                if (when !== undefined && derives) [eligible] = await whenHolds(tx, catalog!, command.target, when, [row], now());
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
                  const why = whenRefusalSentence(catalog![command.target].saying, failingCondition(table, when, row), row, (column) =>
                    mayReadTargetColumn(authorized.actor, column),
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
              /* An input asked only where its `when` holds, where that `when` reads the record: each
               `record.<column>` part judged of the record in this transaction, as the command's own `when` is, and
               the rest over the draft. A value for one the draft hides is refused, as is a required one left empty
               where it is shown; each names its field, as the form's own checks do. */
              const conditional = command.fields.filter(
                (field) => field.type !== 'group' && field.type !== 'lines' && field.when !== undefined && readsRecord(field.when),
              );
              if (conditional.length && targets.length === 1) {
                const bound: Record<string, BoundCondition> = {};
                for (const field of conditional) {
                  bound[field.name] = await bindRecord(
                    (field as { when: string }).when,
                    `input "${field.name}"`,
                    async (comparison) => {
                      const [withheld] = await inputsWithheld(
                        tx,
                        catalog!,
                        command.target,
                        [{ name: field.name, when: comparison }],
                        targets[0],
                        now(),
                        me,
                      );
                      return withheld === undefined;
                    },
                    now(),
                    command.fields,
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
            }
            /* Answers to questions defined in rows, judged against the rows as they stand in this
             transaction and in the reader's tenant, whatever the form drew. */
            const unanswered = await definedAnswerBreak(tx, catalog!, command, input, targets.length === 1 ? targets[0] : undefined);
            if (unanswered)
              throw new BusinessCommandExecutionError('invalid_input', 'not_applied', unanswered.path, undefined, unanswered.reason);
            /* A choice from a table's rows names a row this reader reads here and now (field.choice({ from })). */
            const unsourced = await sourcedChoiceBreak(tx, command, input);
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
            const db = createCommandDb({
              tx,
              catalog,
              read: command.read,
              write: command.write,
              now,
              ...(authorized.versionField === undefined ? {} : { versionField: authorized.versionField }),
              target: command.target,
              constant: (table, column, word) => commandConstant(authorized, tx, table.meta, column, word, now()),
              ...(authorized.files
                ? {
                    files: authorized.files,
                    afterCommit: (run: () => void) => void afterCommit.push(run),
                    placeFile: async (rule: CommandFileRule, values: Record<string, unknown>) => {
                      const placed = await placeFile(rule, values, {
                        app: authorized.actor.appId,
                        ...(receiptOwner ? { tenant: receiptOwner.tenantId } : {}),
                      });
                      placedFiles.push(placed);
                      return placed.values;
                    },
                  }
                : {}),
            });
            const named = command.targets === 'none' || creating ? {} : many ? { records: Object.freeze(targets) } : { record: targets[0] };
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
            const placement = publicActor && authorized.placement ? Object.freeze({ tenantId: authorized.placement.tenantId }) : undefined;
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
                    flags: executionFlags,
                    db,
                    tx,
                    nextNumber: handlerNextNumber(journal, authorized.actor.appId),
                    ...named,
                    ...(lookupRun ? { lookup } : {}),
                    ...(intake ? { intake } : {}),
                    ...(placement ? { placement } : {}),
                    ...(draft ? { draft: draft.context } : {}),
                    ...(options.files ? { files: Object.freeze(options.files.map((file) => Object.freeze({ ...file }))) } : {}),
                    ...(flowTell ? { [FLOW_TELL]: flowTell } : {}),
                  }),
                  Object.keys(revealed).length ? Object.freeze({ ...(input as object), ...revealed }) : input,
                ),
              ),
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
            for (const carried of authorized.machine?.carried ?? []) {
              const key = authorized.catalog?.[carried.table]?.key ?? [];
              for (const [index, before] of targets.entries()) {
                attribute(list.keys[index]);
                const parent: Record<string, unknown> = { ...before, ...canonicalKey(table, list.keys[index]) };
                const rows = await tx.query({
                  table: carried.table,
                  columns: [...key, carried.column],
                  filter: {
                    groups: [
                      carried.reference.from.map((column, at) => ({
                        column,
                        op: '=' as const,
                        value: parent[carried.reference.to[at]] as string | number,
                      })),
                    ],
                  },
                  limit: 257,
                  offset: 0,
                });
                if (rows.rows.length > 256)
                  throw recordRefusalCause(
                    new BusinessCommandExecutionError('invalid_result'),
                    `Command "${request.command}" moves more than 256 "${carried.table}" rows of one "${command.target}" with it; its audit keeps at most 256.`,
                  );
                for (const row of rows.rows) {
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
                error instanceof CommandInputError && error.field
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
              eventBatch = events ? projectCommandEvents(events, result) : undefined;
            } catch (error) {
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
            const id = randomUUID();
            const completedAt = now().toISOString();
            // One receipt names every target through its audit rows, in order.
            const audits = list.keys.map((key, index) => ({
              target: receiptOwner ? resource : authorized.resource,
              keyJson: canonicalCommandJson(key, 8192),
              changesJson: canonicalCommandJson(
                publicActor && eventBatch?.length ? commandVisitorAudit(flags, changes[index]) : changes[index],
                65536,
              ),
            }));
            const receipt = { ...scope, id, fingerprint, resultJson, requestId, completedAt };
            if (track === undefined) await journal.commit(receipt, audits.length === 1 ? audits[0] : audits, eventBatch);
            // The receipt, its audit and the replay check are one statement: taken, this attempt rolls back and replays it.
            else if (track !== 'none' && !(await journal.insert!(receipt, audits.length === 1 ? audits[0] : audits)))
              throw new ReceiptTaken();
            checkCancelled();
            return answer(id, scoped ? result : JSON.parse(resultJson), false);
          } catch (error) {
            await operations.finish().catch(() => {});
            throw error;
          }
        }),
      ),
    );
    for (const run of afterCommit.splice(0)) {
      try {
        run();
      } catch {
        /* Work after the commit never changes the command's answer. */
      }
    }
    return committed;
  } catch (error) {
    const cause = footprintFault ?? (error instanceof CommandTransactionFailure ? error.cause : error);
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
    if (tracked && rolledBack && racedBy(cause)) {
      try {
        const status = await executeUntraced(binding, actor, rawRequest, { ...options, statusOnly: true, door: undefined });
        if (status.status === 'applied') return status;
        priorOutcomeUnknown = false;
      } catch (lookup) {
        // The key was used for a different request: said as the receipt-first path says it.
        if (isBusinessCommandExecutionError(lookup) && lookup.code === 'idempotency_conflict') {
          throw new BusinessCommandExecutionError('idempotency_conflict', scoped ? 'unknown' : 'not_applied');
        }
      }
      if (cause instanceof ReceiptTaken) throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
    }
    const outcome =
      options.statusOnly || priorOutcomeUnknown
        ? 'unknown'
        : error instanceof CommandTransactionFailure
          ? error.outcome
          : transactionStarted
            ? 'unknown'
            : 'not_applied';
    // Each refusal rebuilt here keeps the reason recorded under what it replaces.
    if (isBusinessCommandExecutionError(cause))
      throw recordRefusalCause(
        new BusinessCommandExecutionError(
          cause.code,
          cause.outcome === 'unknown' || options.statusOnly ? 'unknown' : outcome,
          cause.field,
          refusedKey(cause.key ?? (cause.code === 'stale_record' ? conflictKey : undefined)),
          cause.reason,
        ),
        cause,
      );
    if (cause instanceof AppAccessDenied) throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', outcome), cause);
    /* The row scope's own refusal is permanent for this request: said as forbidden, which names no row and no value,
       where it fell through to temporarily_unavailable and sent a caller, a job or a workflow round a retry that
       could never succeed. */
    if (cause instanceof ScopeRefusal) throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', outcome), cause);
    if (cause instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', outcome, cause.field);
    /* A handler's write the App's rules refused (a text rule, a row-defined
       field): the input was wrong, not the server, so said as the field it
       names. It fell through to temporarily_unavailable, a retry that could
       never succeed. */
    /* A line's `consumes` taking more than is left: said with the rule's own sentence, filled for this reader. */
    if (cause instanceof ConsumesRefused)
      throw recordRefusalCause(new BusinessCommandExecutionError('consumes_refused', outcome, undefined, undefined, cause.sentence), cause);
    if (cause instanceof AppValidationDenied)
      throw recordRefusalCause(
        new BusinessCommandExecutionError('invalid_input', outcome, cause.fields[0], undefined, cause.reasons[cause.fields[0]]),
        cause,
      );
    if (isWriteConflict(cause)) throw new BusinessCommandExecutionError('stale_record', outcome, undefined, refusedKey(conflictKey));
    /* An integrity rule the database enforced, recognized by the engine's own
       code and never by its message (constraints.ts). A unique or exclusion
       violation conflicts with a row already there, and a foreign key with one
       that is not: the request was well formed and the state disagreed, so
       both are the conflict refusals. Required and check are the values
       themselves. All of them are permanent for this input, and calling them
       temporarily_unavailable sent a caller round a retry loop that could
       never end.

       Only where nothing was hidden from this caller. Under a scoped
       invocation the index that refused spans rows the row policy or the
       tenant keeps invisible, so naming the conflict would answer a question
       the caller is not allowed to ask — "is there an active reservation on
       this vehicle in another dealership?" — from a refusal. Those keep the
       value-free code (tenant-inventory pins it), and the reason is recorded
       below for the owner instead.

       What is deliberately left alone: an error carrying none of these codes —
       a dropped connection, a statement timeout, a trigger raising its own
       error — stays temporarily_unavailable, because a guess from its text
       would be a worse lie than the vague code. And `outcome` is untouched
       here: where the commit was attempted and its answer lost it is already
       unknown, and it must stay unknown even for a constraint violation,
       since "not applied" about a write that may have landed is the one
       direction of lie this must never tell. */
    // A lock wait that ran out (--lock-timeout) rolled back: said as what it is, for a retry.
    if (outcome === 'not_applied' && lockTimedOut(cause))
      throw recordRefusalCause(new BusinessCommandExecutionError('row_locked', outcome), cause);
    const constraint = scoped ? undefined : writeFailureKind(cause);
    if (constraint) {
      /* The column the engine named, when it is one of the command's own inputs: the form marks that field, as a
         record write's does (appErrors.ts). A column the input does not carry names nothing the reader typed. */
      const broke = constraintColumns(cause);
      const own = given && typeof given === 'object' && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
      const field = broke && !broke.parent ? broke.columns.find((column) => Object.hasOwn(own, column)) : undefined;
      throw recordRefusalCause(
        new BusinessCommandExecutionError(
          constraint === 'unique' ? 'duplicate_record' : constraint === 'reference' ? 'ineligible_state' : 'invalid_input',
          outcome,
          field,
        ),
        cause,
      );
    }
    /* The one refusal that says nothing about what went wrong, so it is the
       one that most needs the trusted record: the driver error is kept on the
       refusal where only an owner holding the reader can see it, and never
       where a caller, a log line or JSON would. */
    throw recordRefusalCause(new BusinessCommandExecutionError('temporarily_unavailable', outcome), cause);
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

/* Why a change could not go into the command's audit, in the author's terms:
   the entry is JSON, so a binary value (a Buffer handed to db.insert) cannot
   be one, and each target's entries are bounded at 64 KiB. Said to the
   operator (refusalReport.ts); the caller hears invalid_result. */
function auditRefusal(command: string, change: Record<string, unknown>): string {
  const where = typeof change.resource === 'string' ? change.resource : 'a resource';
  for (const side of ['values', 'before', 'after']) {
    const image = change[side];
    if (!image || typeof image !== 'object') continue;
    for (const [column, value] of Object.entries(image)) {
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return (
          `Command "${command}" wrote a binary value to ${where}.${column}; a command's audit keeps JSON values only ` +
          '(text, numbers, booleans, null), so store bytes through a file resource or as text.'
        );
      }
    }
  }
  return (
    `Command "${command}"'s changes to ${where} are over the 64 KiB its audit keeps for one target; ` +
    'write smaller values, or fewer rows per command.'
  );
}

/* ---------- what a new row may carry ---------- */

type Authorized = import('./businessCommandAccess.js').AuthorizedBusinessCommand;
const developerError = (cause: string) => recordRefusalCause(new BusinessCommandExecutionError('invalid_result'), cause);

/**
 * A reference a command's write sets must land in the command's footprint
 * (G67): a table it does not read is one whose row nothing proves, which a
 * scoped write refused as a row it could not see — an unexplained retry. The
 * handler's mistake, said as one: invalid_result, never a retry, the table
 * named for the operator, when the scoped write refuses the row — a row its
 * place forbids (a tenant's ownership column set to another tenant) stays
 * forbidden. Only what the write sets is judged: a row's other references
 * were proved when they were written. Said here and not at startup, since a
 * command that names no record may create rows in its target or only update
 * them, and startup cannot tell which (field report R10: an update-only
 * command was refused for not reading every table a new row would point at).
 */
function footprintFailure(
  commandId: string,
  authorized: Authorized,
  request: { table: string; values: Readonly<Record<string, unknown>> },
): unknown {
  const meta = authorized.catalog?.[request.table]?.meta;
  if (!meta) return;
  const footprint = new Set([...(authorized.command.read ?? []), ...(authorized.command.write ?? [])]);
  for (const column of meta.columns) {
    const to = column.references?.table;
    const value = request.values[column.name];
    if (!to || value === undefined || value === null || footprint.has(to)) continue;
    return developerError(
      `Command "${commandId}" set ${request.table}.${column.name}, which points at a "${to}" row, and "${to}" is not in the command's ` +
        `footprint: add "${to}" to its read, so the reference is proved against the rows it reads.`,
    );
  }
}

/**
 * Bytes go only into a file resource's content (or thumbnail) column, within
 * its cap — the upload's rule (http/fileRows.ts) — and the audit keeps the
 * file's name, type and size where the bytes were, never the bytes. Returns
 * that stand-in for the audit's after-image; undefined for a row with none.
 */
function fileInsert(
  commandId: string,
  authorized: Authorized,
  request: { table: string; values: Record<string, unknown> },
): Record<string, unknown> | undefined {
  const binary = Object.entries(request.values).filter(([, value]) => ArrayBuffer.isView(value) || value instanceof ArrayBuffer);
  if (!binary.length) return undefined;
  const rule = authorized.files?.get(request.table);
  if (!rule)
    throw developerError(
      `Command "${commandId}" wrote bytes to ${request.table}.${binary[0][0]}, which is not a file resource it writes: ` +
        "a command stores bytes only through a resource's `file`, with db.<table>.insertFile(file, values).",
    );
  const said: Record<string, unknown> = {};
  for (const [column, value] of binary) {
    if (column !== rule.content && column !== rule.thumbnail)
      throw developerError(
        `Command "${commandId}" wrote bytes to ${request.table}.${column}; a file resource keeps bytes in "${rule.content}"` +
          (rule.thumbnail ? ` and "${rule.thumbnail}"` : '') +
          '.',
      );
    const size = (value as ArrayBufferView | ArrayBuffer).byteLength;
    if (size > rule.maxBytes)
      throw developerError(
        `Command "${commandId}" wrote ${size} bytes to ${request.table}.${column}; the resource takes files up to ${rule.maxBytes} bytes.`,
      );
    said[column] = {
      file: typeof request.values[rule.name] === 'string' ? request.values[rule.name] : null,
      ...(rule.type && typeof request.values[rule.type] === 'string' ? { type: request.values[rule.type] } : {}),
      bytes: size,
    };
  }
  return said;
}

/* ---------- the machines a command's writes meet (appMachine.ts) ---------- */

type CommandMachineBinding = NonNullable<import('./businessCommandAuthorization.js').BusinessCommandAuthorization['machine']>;
type Catalog = import('./commandDb.js').CommandCatalog | undefined;

/** The moment a state changed, as its `since` column holds it: what the `now` stamp writes there. */
function sinceValue(catalog: Catalog, table: string, column: string, now: Date, timezone: string | undefined): string {
  const meta = catalog?.[table]?.meta.columns.find((candidate) => candidate.name === column);
  return (meta && nowStamp(meta, now, timezone)) ?? wallClockText(new Date(Math.floor(now.getTime() / 1000) * 1000), timezone);
}

/**
 * A `Date` a handler writes into a zone-less timestamp column becomes the wall
 * clock of the App's zone, the digits a `now` stamp writes there, not the
 * driver's: `pg` and `mysql2` format a Date in the server process's zone, which
 * is where it happens to run. A zoned column keeps the instant, as it always did.
 */
function bindMoments<T extends { table: string; values: Record<string, unknown> }>(
  authorized: { readonly catalog: Catalog; readonly timezone?: string },
  request: T,
): T {
  const columns = authorized.catalog?.[request.table]?.meta.columns;
  const values = withWallClock(columns, request.values, authorized.timezone);
  return values === request.values ? request : { ...request, values };
}

/**
 * A constant a handler writes (`db.ticket.update(row, { closed_at: now, closed_by: me })`): judged against its
 * column as an action's `set` is, and written as one is. `me` on a reference to the people table is the actor's
 * row, read in this transaction; anywhere else it is the actor's email.
 */
async function commandConstant(
  authorized: {
    readonly actor: { readonly email?: string };
    readonly timezone?: string;
    readonly people?: { table: string; column: string; key: string; id: string };
  },
  tx: Pick<WriteTransaction, 'query'>,
  table: import('@mistriwork/engine/shared/schema.js').TableMeta,
  column: import('@mistriwork/engine/shared/schema.js').ColumnMeta,
  word: 'now' | 'today' | 'me',
  now: Date,
): Promise<string | number | boolean | null> {
  const reference = column.references?.table;
  const people = authorized.people;
  const toPeople = !!reference && !!people && (reference === people.id || reference === people.table);
  const judged = stampColumn(word, column, reference ? (toPeople ? people!.id : reference) : false, people?.id);
  if ('problem' in judged) {
    const hint = reference && !people && word === 'me' ? " Add the people table (auth.me) to the command's reads." : '';
    throw new Error(`${table.name}: ${judged.problem}${hint}`);
  }
  const who = authorized.actor.email;
  /* Nobody signed in, or nobody's row: this account cannot be the one recorded, so the command is not theirs to run. */
  const refused = (error: unknown) => {
    throw error instanceof Refusal ? recordRefusalCause(new BusinessCommandExecutionError('forbidden'), error) : error;
  };
  return written(
    judged.column,
    {
      now,
      ...(who ? { who } : {}),
      person: async () => {
        const found = await tx.query({
          table: people!.table,
          columns: [people!.key],
          limit: 2,
          offset: 0,
          filter: { groups: [[{ column: people!.column, op: '=', value: who! }]] },
        });
        const key = found.rows.length === 1 ? found.rows[0][people!.key] : null;
        return typeof key === 'string' || typeof key === 'number' ? key : null;
      },
    },
    authorized.timezone,
  ).catch(refused);
}

const refusedMove = (cause: string) => recordRefusalCause(new BusinessCommandExecutionError('ineligible_state'), cause);

/** A new row of a machine's table starts in its first state, or one its `entry` names, and stamps `since`. */
function machineInsert<T extends { table: string; values: Record<string, unknown> }>(
  machine: CommandMachineBinding | undefined,
  request: T,
  now: Date,
  catalog: Catalog,
  timezone: string | undefined,
): T {
  const graph = machine?.tables.get(request.table);
  if (!graph) return request;
  const state = request.values[graph.column];
  if (state !== undefined && (state === null || (String(state) !== graph.start && !graph.entry.has(String(state))))) {
    const starts = [graph.start, ...graph.entry].map((name) => `"${name}"`).join(', ');
    throw refusedMove(
      `A new "${request.table}" starts in ${starts}, as its machine on "${graph.column}" allows; the command inserted it in ` +
        `"${String(state)}". A command starts a record past the first state only where the machine's "entry" names that state.`,
    );
  }
  const entered = enteredValue(catalog, request, state === undefined ? graph.start : String(state), graph, now, timezone);
  return {
    ...request,
    values: {
      ...request.values,
      ...(state === undefined ? { [graph.column]: graph.start } : {}),
      ...(graph.since && !Object.hasOwn(request.values, graph.since)
        ? { [graph.since]: sinceValue(catalog, request.table, graph.since, now, timezone) }
        : {}),
      ...entered,
    },
  };
}

/** The state's own stamp (`ready_at` beside `ready`, appMachine.ts), as the record enters it, unless the write says it. */
function enteredValue(
  catalog: Catalog,
  request: { table: string; values: Record<string, unknown> },
  state: string,
  graph: { column: string; since?: string },
  now: Date,
  timezone: string | undefined,
): Record<string, string> {
  const column = stateStampColumn(state, catalog?.[request.table]?.meta.columns ?? [], graph);
  return column && !Object.hasOwn(request.values, column.name) ? { [column.name]: nowStamp(column, now, timezone)! } : {};
}

/** An update that moves a machine's column: along an edge of the graph from the stored state, stamping `since`. */
async function machineUpdate<
  T extends { table: string; key: Record<string, unknown>; values: Record<string, unknown>; expected?: Record<string, unknown> },
>(
  machine: CommandMachineBinding | undefined,
  request: T,
  store: Pick<WriteTransaction, 'query'>,
  now: Date,
  catalog: Catalog,
  timezone: string | undefined,
): Promise<T> {
  const graph = machine?.tables.get(request.table);
  if (!graph || !Object.hasOwn(request.values, graph.column)) return request;
  /* Each state's own stamp is read with the state: a guarded write is guarded at every column it writes. */
  const columns = catalog?.[request.table]?.meta.columns ?? [];
  const stamps = [...new Set([...graph.moves.values()].flatMap((next) => [...next]))].flatMap(
    (state) => stateStampColumn(state, columns, graph)?.name ?? [],
  );
  const found = await store.query({
    table: request.table,
    columns: [graph.column, ...(graph.since ? [graph.since] : []), ...stamps],
    limit: 2,
    offset: 0,
    filter: {
      groups: [Object.entries(request.key).map(([column, value]) => ({ column, op: '=' as const, value: value as string | number }))],
    },
  });
  if (found.rows.length !== 1) return request;
  const from = String(found.rows[0][graph.column]),
    to = String(request.values[graph.column]);
  if (from === to) return request;
  if (!graph.moves.get(from)?.has(to)) {
    const allowed = [...(graph.moves.get(from) ?? [])];
    throw refusedMove(
      `The machine of "${request.table}" moves "${graph.column}" from "${from}" ${allowed.length ? `only to ${allowed.map((state) => `"${state}"`).join(', ')}` : 'nowhere'}; ` +
        `the command wrote "${to}".`,
    );
  }
  const entered = enteredValue(catalog, request, to, graph, now, timezone);
  const since = graph.since && !Object.hasOwn(request.values, graph.since) ? graph.since : undefined;
  const added = { ...(since ? { [since]: sinceValue(catalog, request.table, since, now, timezone) } : {}), ...entered };
  if (!Object.keys(added).length) return request;
  /* A write guarded at the values it read (commandDb.ts) is guarded at what the machine adds too: it was read with the state. */
  return {
    ...request,
    values: { ...request.values, ...added },
    ...(request.expected
      ? {
          expected: {
            ...request.expected,
            ...Object.fromEntries(Object.keys(added).map((column) => [column, found.rows[0][column] ?? null])),
          },
        }
      : {}),
  };
}

/* A handler that throws with a revealed value in its words would put it on the operator's stderr and in an author's
   answer (refusalReport): the error leaves this call with the value cut from its message, its stack and its reasons. */
async function withoutRevealed<T>(revealed: Record<string, string>, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const values = Object.values(revealed).filter((value) => value.length >= 4);
    if (values.length && error instanceof Error) {
      const cut = (text: string) => values.reduce((said, value) => said.split(value).join('[sensitive]'), text);
      error.message = cut(error.message);
      if (error.stack) error.stack = cut(error.stack);
      scrubReasons(error, cut);
    }
    throw error;
  }
}

function scrubReasons(error: Error, cut: (text: string) => string): void {
  const seen = new Set<unknown>([error]);
  for (let because = refusalCause(error) ?? error.cause, depth = 0; because instanceof Error && !seen.has(because) && depth < 8; depth++) {
    seen.add(because);
    because.message = cut(because.message);
    if (because.stack) because.stack = cut(because.stack);
    because = refusalCause(because) ?? because.cause;
  }
}
