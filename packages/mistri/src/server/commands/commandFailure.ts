/**
 * Classifies a thrown command failure into the `BusinessCommandExecutionError`
 * a caller, job or workflow receives, keeping the trusted driver cause beneath
 * it (`recordRefusalCause`) and never naming hidden rows under a scoped run.
 */
import { isWriteConflict } from '@mistriwork/engine/adapters/adapter.js';
import { isSnapshotConflict } from '@mistriwork/engine/adapters/snapshotRead.js';
import { referencedBeneath, ScopeRefusal } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import { lockTimedOut } from '@mistriwork/engine/adapters/writeLanes.js';
import { constraintColumns, writeFailureKind } from '@mistriwork/engine/server/constraints.js';
import { recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import type { AppMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import { authorFault, isFrozenRefusal, isRequestFault } from '@mistriwork/engine/shared/refusal.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { NarrowedRefusal } from '../app/appNarrowedWrites.js';
import { AppValidationDenied, ConsumesRefused } from '../app/appValidationDenied.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError, refusalReason } from './commandErrors.js';
import { CommandInputError, type CommandKey } from './commandPayload.js';

export function rethrowCommandFailure(options: {
  readonly error: unknown;
  readonly cause: unknown;
  readonly statusOnly: boolean;
  readonly priorOutcomeUnknown: boolean;
  readonly transactionStarted: boolean;
  readonly scoped: boolean;
  readonly snapshot: boolean;
  readonly conflictKey: unknown;
  readonly given: unknown;
  readonly refusedKey: (key: unknown) => CommandKey | undefined;
  readonly sayRefusal: (ref: AppMessageRef) => string | undefined;
}): never {
  const {
    error,
    cause,
    statusOnly,
    priorOutcomeUnknown,
    transactionStarted,
    scoped,
    snapshot,
    conflictKey,
    given,
    refusedKey,
    sayRefusal,
  } = options;
  const outcome =
    statusOnly || priorOutcomeUnknown
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
        cause.outcome === 'unknown' || statusOnly ? 'unknown' : outcome,
        cause.field,
        refusedKey(cause.key ?? (cause.code === 'stale_record' ? conflictKey : undefined)),
        refusalReason(cause, sayRefusal),
      ),
      cause,
    );
  if (cause instanceof AppAccessDenied) throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', outcome), cause);
  /* The row scope's own refusal is permanent for this request: said as forbidden, which names no row and no value,
     where it fell through to temporarily_unavailable and sent a caller, a job or a workflow round a retry that
     could never succeed. */
  /* A delete refused while rows still point at it is the record's state, not the caller's grants: said in its own
     sentence, which names only the rows the caller reads, or none (scopedTransaction.ts ReferencedRefusal). */
  const referenced = referencedBeneath(cause);
  if (referenced)
    throw recordRefusalCause(
      new BusinessCommandExecutionError('ineligible_state', outcome, undefined, undefined, referenced.message),
      cause,
    );
  if (cause instanceof ScopeRefusal) throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', outcome), cause);
  if (cause instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', outcome, cause.field);
  /* A write a narrowed resource's query does not allow (appNarrowedWrites.ts): the record's state, said in its own
     sentence, where it fell through to temporarily_unavailable, a retry that could never succeed. */
  /* A write a record's `frozen` condition refuses, met below the command's own checks (the App's rules over its
     transaction): the record's state, said as 409 `frozen`, where it fell through to temporarily_unavailable. */
  if (isFrozenRefusal(cause))
    throw recordRefusalCause(new BusinessCommandExecutionError('frozen', outcome, undefined, undefined, cause.message), cause);
  if (cause instanceof NarrowedRefusal)
    throw recordRefusalCause(new BusinessCommandExecutionError('ineligible_state', outcome, undefined, undefined, cause.message), cause);
  /* A handler's write the App's rules refused (a text rule, a row-defined
     field): the input was wrong, not the server, so said as the field it
     names. It fell through to temporarily_unavailable, a retry that could
     never succeed. */
  /* A line's `consumes` taking more than is left: said with the rule's own sentence, filled for this reader. */
  if (cause instanceof ConsumesRefused)
    throw recordRefusalCause(
      new BusinessCommandExecutionError('consumes_refused', outcome, cause.fields[0], undefined, cause.sentence),
      cause,
    );
  if (cause instanceof AppValidationDenied)
    throw recordRefusalCause(
      new BusinessCommandExecutionError('invalid_input', outcome, cause.fields[0], undefined, cause.reasons[cause.fields[0]]),
      cause,
    );
  /* A request the handler built that can never succeed as written (a malformed filter, an aggregate naming a column
     the table lacks, a sum SQLite cannot add exactly): the App author's to fix, never a retry. */
  if (isRequestFault(cause)) throw authorFault(new BusinessCommandExecutionError('invalid_result', outcome), cause.message);
  if (isWriteConflict(cause)) throw new BusinessCommandExecutionError('stale_record', outcome, undefined, refusedKey(conflictKey));
  /* A snapshot command wrote or locked a row another transaction changed after its snapshot (PostgreSQL's 40001):
     the record moved under it, said as a conditional write's conflict is, which a job or workflow retries. */
  if (snapshot && isSnapshotConflict(cause))
    throw new BusinessCommandExecutionError('stale_record', outcome, undefined, refusedKey(conflictKey));
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
