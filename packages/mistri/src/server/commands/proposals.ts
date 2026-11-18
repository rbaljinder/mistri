/**
 * Proposals and provenance marks (commandProposals.ts keeps them): a command invocation a non-person maker prepared
 * for a person to decide, and a mark on what such a maker wrote, until a person confirms it.
 *
 * Every operation reaches the journal through a command the caller is granted, in that command's own transaction, so
 * a proposal is seen and decided only by whoever could run its command, in their own tenant's rows. Approving runs
 * the command as the approver, through the executor, with the proposal's id as its idempotency key: the executor
 * decides the proposal in the run's own transaction (businessCommandExecution.ts), so two approvals at once run it
 * once, and a run that fails leaves it undecided for this module to say why.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { appTime } from '@mistriwork/engine/server/http/clock.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import type { CommandJournal, CommandProposalRow, ProposalEvidence, ProvenanceRow } from '../../adapters/commands/commandJournalTypes.js';
import { PROPOSAL_STATES, type MakerKind, type ProposalState } from '../../adapters/commands/commandJournalSchema.js';
import { CommandInputRefusal } from '../../shared/commandInput.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import { lineCell } from '../../shared/commandLineCell.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from './businessCommandAccess.js';
import { parseRegisteredInput, type BusinessCommandActor } from './businessCommands.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from './commandErrors.js';
import { canonicalCommandJson, CommandInputError, parseCommandKey } from './commandPayload.js';
import { makerWrites } from './makerWrites.js';

/** Fourteen days, with no knob: a proposal nobody decided by then is stale advice about a record that has moved on. */
const PROPOSAL_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

/* Who may make a proposal or a mark through this module. `agent` stays in the store's vocabulary for an outside
   agent, which nothing admits yet, so nothing here mints it. */
const MAKERS: ReadonlySet<string> = new Set<MakerKind>(['assistant', 'job', 'decision', 'flow']);

/**
 * A proposal refusal the command codes say but not with their usual status: a proposal past its time is 410, gone,
 * where every other `ineligible_state` is 409. `businessCommandHttpError` reads the status this carries.
 */
export class ProposalRefusal extends BusinessCommandExecutionError {
  constructor(
    readonly status: 404 | 409 | 410,
    reason: string,
  ) {
    super(status === 404 ? 'not_found' : 'ineligible_state', 'not_applied', undefined, undefined, reason);
  }
}
const gone = () => new ProposalRefusal(410, 'This proposal has expired.');
const taken = () => new ProposalRefusal(409, 'This proposal was already decided.');
const missing = () => new ProposalRefusal(404, 'No such proposal.');

const unavailable = () => new BusinessCommandExecutionError('temporarily_unavailable');
// A body arrives through the door's snapshot (canonicalJson.ts), whose objects have no prototype at all.
const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new CommandInputError(field);
  return value;
};

/** The journal in the command's own transaction; a refusal raised inside it arrives as itself, not "unavailable". */
async function inJournal<T>(
  authorized: AuthorizedBusinessCommand,
  run: (journal: CommandJournal, records: WriteTransaction) => Promise<T>,
): Promise<T> {
  if (!authorized.commandTransaction) throw unavailable();
  try {
    return await authorized.commandTransaction((records, journal) => run(journal, records));
  } catch (thrown) {
    throw thrown instanceof CommandTransactionFailure ? thrown.cause : thrown;
  }
}
const member = <K extends keyof CommandJournal>(journal: CommandJournal, name: K): NonNullable<CommandJournal[K]> => {
  const found = journal[name];
  if (typeof found !== 'function') throw unavailable();
  return (found as (...args: unknown[]) => unknown).bind(journal) as NonNullable<CommandJournal[K]>;
};
const tenantOf = (authorized: AuthorizedBusinessCommand) => authorized.receiptOwner?.tenantId ?? '';

/** What a maker proposes: a command, its record (none for a creating command), its input, and why. */
export interface ProposalDraft {
  /** A maker that may ask twice (a job's retried attempt) names its proposal, so the second ask finds the first. */
  id?: string;
  command: string;
  key?: Readonly<Record<string, string | number>>;
  input: Record<string, unknown>;
  maker: MakerKind;
  /** The maker's own name: the assistant's conversation, a job's id, a decision's, a flow's. */
  makerActor: string;
  model?: string;
  modelVersion?: string;
  costMicros?: number;
  evidence: readonly ProposalEvidence[];
  reason: string;
}

/**
 * Keeps a proposal for `actor`'s command. The command must be one `actor` is granted, as running it would need, and
 * the input is judged by the command's own declaration now, so a person is never shown one that could not run as
 * written. The input kept is the one given: the approval's run parses it again, at the version it runs.
 */
export async function createProposal(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  draft: ProposalDraft,
  now: () => Date = () => appTime(),
): Promise<CommandProposalRow> {
  if (!MAKERS.has(draft.maker)) throw new BusinessCommandExecutionError('forbidden');
  const authorized = binding.authorize(draft.command, actor);
  const creating = binding.creates?.(draft.command) === true;
  let target: string | null = null;
  let key: Readonly<Record<string, string | number>> | undefined;
  if (draft.key !== undefined || !creating) {
    const parsed = parseCommandKey(draft.key);
    if (
      authorized.keyColumns.length !== Object.keys(parsed).length ||
      authorized.keyColumns.some((column) => !Object.hasOwn(parsed, column))
    )
      throw new CommandInputError('key');
    key = parsed;
    target = canonicalCommandJson(parsed, 8192);
  }
  if (!plainObject(draft.input)) throw new CommandInputError('input');
  const at = now();
  try {
    parseRegisteredInput(
      authorized.command,
      draft.input,
      Object.freeze({ actor: authorized.actor, commandId: draft.command, version: authorized.command.version }),
      {
        publicForm: false,
        now: at,
        ...(authorized.currency ? { currency: authorized.currency } : {}),
        cell: (table, column, value) => {
          const meta = authorized.catalog?.[table]?.meta;
          return meta ? lineCell(meta, column, value) : 'shape';
        },
      },
    );
  } catch (error) {
    if (error instanceof CommandInputRefusal)
      throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.path || undefined);
    if (isBusinessCommandExecutionError(error) && error.code === 'invalid_input') throw error;
    throw new BusinessCommandExecutionError('invalid_input', 'not_applied', 'input');
  }
  const row: CommandProposalRow = {
    id: draft.id ?? randomBytes(16).toString('base64url'),
    app: authorized.actor.appId,
    tenant: tenantOf(authorized),
    command: draft.command,
    target,
    input: JSON.parse(canonicalCommandJson(draft.input)) as Record<string, unknown>,
    actorKind: draft.maker,
    actor: draft.makerActor,
    model: draft.model ?? null,
    modelVersion: draft.modelVersion ?? null,
    costMicros: draft.costMicros ?? null,
    evidence: draft.evidence,
    reason: draft.reason,
    state: 'proposed',
    decidedBy: null,
    decidedAt: null,
    receiptId: null,
    createdAt: at.getTime(),
    expiresAt: at.getTime() + PROPOSAL_LIFETIME_MS,
  };
  return inJournal(authorized, async (journal, records) => {
    /* The record as the person's row policy shows it, in this transaction: a maker proposes only what its person
       could run the command on, so a proposal never names a row the person cannot reach. */
    if (key) await authorized.assertTarget?.(records, key);
    if (draft.id !== undefined) {
      const kept = await member(journal, 'readProposal')(row.app, draft.id);
      if (kept) {
        if (kept.command !== row.command || kept.actor !== row.actor) throw taken();
        return kept;
      }
    }
    await member(journal, 'createProposal')(row);
    return row;
  });
}

/** At most this many proposals asked by id: a conversation's cards, read back on reload (assistantRoutes.ts). */
const IDS_LIMIT = 50;

/** An unconfirmed mark as For review lists it: with a command the reader is granted on its resource, to confirm it through. */
type UnconfirmedMark = ProvenanceRow & { command: string };

/**
 * The proposals `actor` may decide: those of the offered commands this actor is granted, nothing of any other. Asked
 * of one command when the body names it, or of named proposals (`ids`, whatever their state unless `states` says).
 * Proposals past their time are marked expired first, so none is listed as still open. With `unconfirmed: true`, the
 * unconfirmed marks on the resources a maker writes that the actor is granted a command on, too: For review's second
 * section, in the same transaction.
 */
async function listProposals(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  offered: Iterable<string>,
  body: unknown,
  now: () => Date = () => appTime(),
): Promise<{ proposals: CommandProposalRow[]; unconfirmed?: UnconfirmedMark[] }> {
  const request = body === undefined || body === null ? {} : body;
  if (!plainObject(request)) throw new CommandInputError();
  const asked = request.command === undefined ? undefined : text(request.command, 'command');
  let ids: string[] | undefined;
  if (request.ids !== undefined) {
    if (
      !Array.isArray(request.ids) ||
      !request.ids.length ||
      request.ids.length > IDS_LIMIT ||
      request.ids.some((each) => typeof each !== 'string' || !each || each.length > 128)
    )
      throw new CommandInputError('ids');
    ids = [...new Set(request.ids as string[])];
  }
  if (request.unconfirmed !== undefined && typeof request.unconfirmed !== 'boolean') throw new CommandInputError('unconfirmed');
  let states: ProposalState[] = ids ? [...PROPOSAL_STATES] : ['proposed'];
  if (request.states !== undefined) {
    if (
      !Array.isArray(request.states) ||
      !request.states.length ||
      request.states.some((state) => !(PROPOSAL_STATES as readonly unknown[]).includes(state))
    )
      throw new CommandInputError('states');
    states = [...new Set(request.states as ProposalState[])];
  }
  const granted: Array<[string, AuthorizedBusinessCommand]> = [];
  for (const id of new Set(offered)) {
    if (asked !== undefined && id !== asked) continue;
    try {
      granted.push([id, binding.authorize(id, actor)]);
    } catch (error) {
      if (error instanceof AppAccessDenied || (isBusinessCommandExecutionError(error) && error.code === 'forbidden')) continue;
      throw error;
    }
  }
  if (!granted.length) return request.unconfirmed === true ? { proposals: [], unconfirmed: [] } : { proposals: [] };
  // One transaction for the lot: every command of an App shares its journal, and each row names its command.
  const [, first] = granted[0];
  const appId = first.actor.appId;
  return inJournal(first, async (journal) => {
    await member(journal, 'expireProposals')(appId, now().getTime());
    let proposals: CommandProposalRow[];
    if (ids) {
      const commands = new Set(granted.map(([id]) => id));
      const read = member(journal, 'readProposal');
      proposals = [];
      for (const id of ids) {
        const row = await read(appId, id);
        if (row && commands.has(row.command) && states.includes(row.state)) proposals.push(row);
      }
    } else proposals = await member(journal, 'listProposals')(appId, { commands: granted.map(([id]) => id), states, limit: LIST_LIMIT });
    if (request.unconfirmed !== true) return { proposals };
    /* A mark is confirmed through a command on its resource (confirmProvenance), so the resources listed are those
       the reader is granted one on, and of those only where a maker writes: elsewhere there is nothing to find. */
    const through = new Map<string, string>();
    for (const [id, authorized] of granted)
      if (!through.has(authorized.resource) && makerWrites(authorized.command)) through.set(authorized.resource, id);
    const unconfirmed: UnconfirmedMark[] = [];
    for (const [resource, command] of through)
      for (const mark of await member(journal, 'unconfirmedProvenance')(appId, resource, null)) unconfirmed.push({ ...mark, command });
    return { proposals, unconfirmed };
  });
}

/** The approver's own request: which proposal, its command, the revision of the record they saw, and, where they
    corrected it before approving, the input as they left it. */
interface ProposalApproval {
  id: string;
  command: string;
  expectedVersion: number;
  /** Approved with the input edited: the command runs with this, and each field changed is the approver's, not the
      maker's (businessCommandExecution.ts). Validated as any run's input is. */
  input?: Record<string, unknown>;
}
function parseProposalApproval(body: unknown): ProposalApproval {
  if (!plainObject(body)) throw new CommandInputError();
  const id = text(body.id, 'id');
  const command = text(body.command, 'command');
  const expectedVersion = body.expectedVersion ?? 0;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new CommandInputError('expectedVersion');
  if (body.input !== undefined && !plainObject(body.input)) throw new CommandInputError('input');
  return { id, command, expectedVersion, ...(body.input === undefined ? {} : { input: body.input }) };
}
/** The proposal a decision names, and its command: a dismissal's body. */
function parseProposalReference(body: unknown): { id: string; command: string } {
  if (!plainObject(body)) throw new CommandInputError();
  return { id: text(body.id, 'id'), command: text(body.command, 'command') };
}

/**
 * Runs a proposal's command as `actor`, who must be granted it now: a refused grant is a 403 and leaves the proposal
 * as it was. `run` is the host's execute, with its flags, door and locale, given the envelope this builds; the
 * executor decides the proposal in the run's transaction and names it on the receipt. A refusal is passed to
 * `refusedApproval` by the caller, in a transaction of its own, to say what became of the proposal.
 */
async function approveProposal<T>(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  approval: ProposalApproval,
  run: (envelope: Record<string, unknown>, proposalId: string) => Promise<T>,
): Promise<T> {
  const authorized = binding.authorize(approval.command, actor);
  const proposal = await inJournal(authorized, (journal) => member(journal, 'readProposal')(authorized.actor.appId, approval.id));
  if (!proposal || proposal.command !== approval.command) throw missing();
  if (proposal.state !== 'proposed') throw proposal.state === 'expired' ? gone() : taken();
  return run(
    {
      command: proposal.command,
      commandVersion: authorized.command.version,
      key: proposal.target === null ? {} : (JSON.parse(proposal.target) as unknown),
      expectedVersion: approval.expectedVersion,
      // The proposal is the operation: an approver's retry replays its own receipt, and nobody else's run is a second.
      idempotencyKey: proposal.id,
      input: approval.input ?? proposal.input,
    },
    proposal.id,
  );
}

/** A proposal a person approved, as told to whoever waits on it: its App, id and command. */
interface ApprovedProposal {
  readonly appId: string;
  readonly id: string;
  readonly command: string;
}
const approvedListeners = new Map<string, Set<(approved: ApprovedProposal) => void>>();

/**
 * Be told, in this process, when a proposal of this App is approved: how a flow step waiting on one is woken at once
 * rather than at its next look (workflowHost.ts). Only a hint: the step still reads the proposal, and its poll stays
 * the account across processes and restarts. Returns the unsubscribe.
 */
export function onProposalApproved(appId: string, listener: (approved: ApprovedProposal) => void): () => void {
  const listeners = approvedListeners.get(appId) ?? new Set();
  listeners.add(listener);
  approvedListeners.set(appId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && approvedListeners.get(appId) === listeners) approvedListeners.delete(appId);
  };
}
/** Tell this process's listeners a proposal was approved: called once the approval's run has committed. A tenant host,
    whose run is a step inside its request's transaction, calls it when that transaction is done (tenantDraftHttp.ts). */
export function announceProposalApproved(appId: string, id: string, command: string): void {
  approved(appId, id, command);
}
function approved(appId: string, id: string, command: string): void {
  for (const listener of approvedListeners.get(appId) ?? []) {
    try {
      listener({ appId, id, command });
    } catch {
      // A listener's failure is its own: the approval has committed, and the poll still finds it.
    }
  }
}

/* What says nothing about the proposal: the approver's own standing or view (a grant, a stale record, a version
   changed under them), or a failure a retry can cure. Every other refusal is the proposal's: it cannot run as made. */
const APPROVER_REFUSALS = new Set([
  'unauthenticated',
  'forbidden',
  'stale_account',
  'stale_record',
  'command_version_mismatch',
  'idempotency_conflict',
  'temporarily_unavailable',
  'row_locked',
  'cancelled',
  'reviewer_unavailable',
]);

/**
 * What an approval's refusal means for its proposal, asked after the run rolled back. Decided meanwhile: 409, which is
 * also how the second of two approvals at once is told. Past its time: marked expired, 410. Refused for a reason that
 * is the proposal's own: marked failed, and the run's refusal is the answer. Anything else leaves it to decide again.
 */
async function refusedApproval(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  approval: { id: string; command: string },
  error: unknown,
  now: () => Date = () => appTime(),
): Promise<unknown> {
  if (error instanceof ProposalRefusal || error instanceof AppAccessDenied) return error;
  let authorized: AuthorizedBusinessCommand;
  try {
    authorized = binding.authorize(approval.command, actor);
  } catch {
    return error;
  }
  const appId = authorized.actor.appId;
  try {
    return await inJournal(authorized, async (journal) => {
      const proposal = await member(journal, 'readProposal')(appId, approval.id);
      if (!proposal || proposal.command !== approval.command) return missing();
      if (proposal.state === 'expired') return gone();
      if (proposal.state !== 'proposed') return taken();
      const at = now().getTime();
      if (proposal.expiresAt <= at) {
        await member(journal, 'expireProposals')(appId, at);
        return gone();
      }
      if (!isBusinessCommandExecutionError(error) || error.outcome === 'unknown' || APPROVER_REFUSALS.has(error.code)) return error;
      const decided = await member(journal, 'decideProposal')(appId, approval.id, approval.command, 'failed', authorized.actor.id, at);
      return decided === 'decided' ? error : decided === 'expired' ? gone() : decided === 'taken' ? taken() : missing();
    });
  } catch {
    // The run's own refusal stands; what became of the proposal is read again on the next list.
    return error;
  }
}

/** Sets a proposal aside without running it: whoever may run its command may dismiss it. */
async function dismissProposal(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  reference: { id: string; command: string },
  now: () => Date = () => appTime(),
): Promise<{ id: string; state: 'dismissed' }> {
  const authorized = binding.authorize(reference.command, actor);
  const decided = await inJournal(authorized, (journal) =>
    member(journal, 'decideProposal')(
      authorized.actor.appId,
      reference.id,
      reference.command,
      'dismissed',
      authorized.actor.id,
      now().getTime(),
    ),
  );
  if (decided === 'missing') throw missing();
  if (decided === 'expired') throw gone();
  if (decided === 'taken') throw taken();
  return { id: reference.id, state: 'dismissed' };
}

/** A row (or one field of it) a non-person maker wrote, and where it read what it wrote from. */
export interface ProvenanceMark {
  /** A command `actor` is granted on the row's resource: the journal is reached through it. */
  command: string;
  key: Readonly<Record<string, string | number>>;
  field?: string;
  maker: MakerKind;
  makerActor: string;
  evidence: readonly ProposalEvidence[];
}

const rowKeyOf = (authorized: AuthorizedBusinessCommand, raw: unknown): string => {
  const key = parseCommandKey(raw);
  if (authorized.keyColumns.length !== Object.keys(key).length || authorized.keyColumns.some((column) => !Object.hasOwn(key, column)))
    throw new CommandInputError('key');
  return canonicalCommandJson(key, 8192);
};

/** Marks what a non-person write wrote. A person's own write is never marked: it needs no one to confirm it. */
export async function markProvenance(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  mark: ProvenanceMark,
  now: () => Date = () => appTime(),
): Promise<ProvenanceRow> {
  if (!MAKERS.has(mark.maker)) throw new BusinessCommandExecutionError('forbidden');
  const authorized = binding.authorize(mark.command, actor);
  const row: ProvenanceRow = {
    id: randomBytes(16).toString('base64url'),
    app: authorized.actor.appId,
    tenant: tenantOf(authorized),
    resource: authorized.resource,
    rowKey: rowKeyOf(authorized, mark.key),
    field: mark.field ?? null,
    actorKind: mark.maker,
    actor: mark.makerActor,
    evidence: mark.evidence,
    createdAt: now().getTime(),
    confirmedBy: null,
    confirmedAt: null,
  };
  await inJournal(authorized, (journal) => member(journal, 'markProvenance')(row));
  return row;
}

/** A confirmation's body: the command it is asked through, the row's resource and key, and a field or none. */
function parseProvenanceConfirm(body: unknown): { command: string; resource: string; key: unknown; field?: string } {
  if (!plainObject(body)) throw new CommandInputError();
  const field = body.field === undefined || body.field === null ? undefined : text(body.field, 'field');
  return { command: text(body.command, 'command'), resource: text(body.resource, 'resource'), key: body.key, ...(field ? { field } : {}) };
}

function onResource(binding: BusinessCommandBinding, actor: BusinessCommandActor, command: string, resource: string) {
  const authorized = binding.authorize(command, actor);
  // The command is the grant asked: one on another resource confirms nothing here.
  if (authorized.resource !== resource) throw new AppAccessDenied();
  return authorized;
}

/**
 * A person vouches for what a maker wrote: the row's unconfirmed marks (one field's and the row's own, or all of them
 * where no field is named) are stamped with who and when. The stamp is the record of it.
 */
async function confirmProvenance(
  binding: BusinessCommandBinding,
  actor: BusinessCommandActor,
  request: { command: string; resource: string; key: unknown; field?: string },
  now: () => Date = () => appTime(),
): Promise<{ confirmed: number; fields: string[] }> {
  const authorized = onResource(binding, actor, request.command, request.resource);
  const rowKey = rowKeyOf(authorized, request.key);
  const at = now();
  const confirmed = await inJournal(authorized, async (journal) => {
    /* The fields vouched for, read before they are stamped: the receipt names them, so the history says what the
       person confirmed and not only how many marks. A row's own mark (no field) is named by the row. */
    const marks = await member(journal, 'unconfirmedProvenance')(authorized.actor.appId, authorized.resource, rowKey);
    const fields = [
      ...new Set(
        marks
          .filter((mark) => request.field === undefined || mark.field === null || mark.field === request.field)
          .flatMap((mark) => (mark.field === null ? [] : [mark.field])),
      ),
    ].sort();
    const count = await member(journal, 'confirmProvenance')(
      authorized.actor.appId,
      authorized.resource,
      rowKey,
      request.field,
      authorized.actor.id,
      at.getTime(),
    );
    /* The stamp says who vouched; the receipt puts it in the record's history beside the write it vouches for, in
       the same transaction, under the command the confirmation was asked through. It changes no field, so its one
       audit row carries no changes. Nothing confirmed, nothing to record. */
    if (count > 0) {
      const resultJson = canonicalCommandJson({ confirmed: count, field: request.field ?? null, fields }, 8192);
      await journal.commit(
        {
          appId: authorized.actor.appId,
          actorId: authorized.actor.id,
          commandId: request.command,
          commandVersion: authorized.command.version,
          idempotencyKey: `provenance-confirm:${randomUUID()}`,
          id: randomUUID(),
          fingerprint: createHash('sha256').update(`provenance-confirm\0${authorized.resource}\0${rowKey}\0${resultJson}`).digest('hex'),
          resultJson,
          requestId: randomUUID(),
          completedAt: at.toISOString(),
          actorKind: 'person',
        },
        { target: authorized.resource, keyJson: rowKey, changesJson: '[]' },
      );
    }
    return { confirmed: count, fields: count > 0 ? fields : [] };
  });
  return confirmed;
}

/** The proposal routes' paths: a list, a decision either way, and a confirmation (shared/commandRoutes.ts). */
export const PROPOSAL_ROUTES: ReadonlySet<string> = new Set([
  COMMAND_ROUTES.proposals,
  COMMAND_ROUTES.approveProposal,
  COMMAND_ROUTES.dismissProposal,
  COMMAND_ROUTES.confirmProvenance,
]);

/**
 * One proposal route, as every door answers it: the App's own, a scoped context's, a tenant's. `offered` says which
 * commands the App serves, as an execute's does, so a proposal of a command no surface offers is not decided through
 * it; `execute` is the door's own run of an envelope, with its flags, door and locale, naming the proposal.
 */
export async function runProposalRoute<T>(options: {
  path: string;
  body: unknown;
  binding: BusinessCommandBinding;
  actor: BusinessCommandActor;
  offered: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  unoffered: (command: string) => Error;
  execute: (envelope: Record<string, unknown>, proposalId: string) => Promise<T>;
}): Promise<unknown> {
  const { path, body, binding, actor, offered } = options;
  const served = (command: string) => {
    if (!offered.has(command)) throw options.unoffered(command);
  };
  if (path === COMMAND_ROUTES.proposals) return listProposals(binding, actor, offered.keys(), body);
  if (path === COMMAND_ROUTES.dismissProposal) {
    const reference = parseProposalReference(body);
    served(reference.command);
    return dismissProposal(binding, actor, reference);
  }
  if (path === COMMAND_ROUTES.confirmProvenance) {
    const request = parseProvenanceConfirm(body);
    served(request.command);
    return confirmProvenance(binding, actor, request);
  }
  if (path !== COMMAND_ROUTES.approveProposal) throw new CommandInputError();
  const approval = parseProposalApproval(body);
  served(approval.command);
  let result: T;
  try {
    result = await approveProposal(binding, actor, approval, options.execute);
  } catch (error) {
    throw await refusedApproval(binding, actor, approval, error);
  }
  approved(actor.appId, approval.id, approval.command);
  return result;
}

/**
 * The assistant's proposal, as the host made it: a command the App serves, kept for the person the turn is for, under
 * their grant and their row policy (createProposal). Never a client's body: no route reads one into this.
 */
export function proposeForAssistant(options: {
  draft: unknown;
  binding: BusinessCommandBinding;
  actor: BusinessCommandActor;
  offered: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  unoffered: (command: string) => Error;
}): Promise<CommandProposalRow> {
  const { draft } = options;
  if (!plainObject(draft) || draft.maker !== 'assistant' || typeof draft.reason !== 'string' || !Array.isArray(draft.evidence))
    throw new CommandInputError();
  const command = text(draft.command, 'command');
  if (!options.offered.has(command)) throw options.unoffered(command);
  return createProposal(options.binding, options.actor, draft as unknown as ProposalDraft);
}

/**
 * One step of a proposal route, for a host whose request opens one transaction (a tenant's, tenantRequestRuntime.ts).
 * An approval there is three requests the host makes, never the client: `read` the proposal into its envelope, `run`
 * it, and, when the run is refused, `refused` to say what became of the proposal. `route` is every other route, each
 * one transaction already. The step's shape is the host's; the client's own body is only ever `body`.
 */
export async function runProposalStep<T>(options: {
  step: unknown;
  binding: BusinessCommandBinding;
  actor: BusinessCommandActor;
  offered: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  unoffered: (command: string) => Error;
  execute: (envelope: Record<string, unknown>, proposalId: string) => Promise<T>;
}): Promise<unknown> {
  const { step, binding, actor, offered } = options;
  if (!plainObject(step)) throw new CommandInputError();
  const served = (command: string) => {
    if (!offered.has(command)) throw options.unoffered(command);
  };
  if (step.step === 'route') {
    if (step.path === COMMAND_ROUTES.approveProposal || typeof step.path !== 'string') throw new CommandInputError();
    return runProposalRoute({ ...options, path: step.path, body: step.body, execute: () => Promise.reject(new CommandInputError()) });
  }
  // Built by the host alone (tenantHttp.ts's propose), never from a client's body.
  if (step.step === 'propose') return proposeForAssistant({ ...options, draft: step.draft });
  if (step.step === 'read') {
    const approval = parseProposalApproval(step.body);
    served(approval.command);
    return approveProposal(binding, actor, approval, async (envelope) => ({
      approval: { id: approval.id, command: approval.command },
      envelope,
      // The host announces the approval once its run's transaction commits, and names the App it is for.
      appId: actor.appId,
    }));
  }
  const approval = parseProposalReference(step.approval);
  served(approval.command);
  if (step.step === 'run') {
    if (!plainObject(step.envelope) || step.envelope.idempotencyKey !== approval.id || step.envelope.command !== approval.command)
      throw new CommandInputError();
    /* Not announced here: this step runs inside the host's transaction, and a flow woken now could read the proposal
       before it commits. The host announces after (tenantDraftHttp.ts). */
    return options.execute(step.envelope, approval.id);
  }
  if (step.step !== 'refused' || typeof step.code !== 'string') throw new CommandInputError();
  throw await refusedApproval(
    binding,
    actor,
    approval,
    new BusinessCommandExecutionError(
      step.code as BusinessCommandExecutionError['code'],
      step.outcome === 'unknown' ? 'unknown' : 'not_applied',
    ),
  );
}
