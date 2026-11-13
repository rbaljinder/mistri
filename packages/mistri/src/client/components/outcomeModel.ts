/**
 * How a command ended, as the person reads it: one of four outcomes, the same
 * wherever a command runs (CommandForm, a public form). Drawn by
 * CommandOutcome.tsx; worked out here, apart from drawing, so each state is
 * tested as a value.
 *
 * - done: what changed, in the command's own words when its result said any,
 *   and the record it changed when the person is not already on it;
 * - pending: on its way (sending, checking a lost answer), or accepted and
 *   waiting — queued, or awaiting someone's approval — which a handler says by
 *   returning `pending: 'queued' | 'approval'` beside its `message`;
 * - refused: the refusal's own words, and what to do next by its code;
 * - unknown: the answer was lost; a check reads the receipt and never sends twice.
 *
 * The body is the App's: the handler's `message`, its `refuse(...)` sentence,
 * a public form's `done` words. The title and the next step are the platform's.
 */
import { fieldLabel as humanized } from '../../shared/command.js';
import { say } from '../copy/forms/components/outcomeModel.js';

type Waiting = 'sending' | 'checking' | 'queued' | 'approval';
export type Outcome =
  | { state: 'done'; said: string; changed?: { label: string } }
  | { state: 'pending'; waiting: Waiting; said?: string }
  | { state: 'refused'; said: string; next: string }
  | { state: 'unknown'; said: string; next: string };

/** The handler's word that what it accepted is not finished yet: `{ message, pending: 'queued' }`. */
export function pendingOf(result: unknown): 'queued' | 'approval' | undefined {
  const pending = (result as { pending?: unknown } | null | undefined)?.pending;
  return pending === 'queued' || pending === 'approval' ? pending : undefined;
}

/** A field as a refusal names it: its label, and whether the label was read from the field's name (the author wrote none). */
export type FieldWord = { label: string; derived: boolean };

/** A field's word for a refusal: `derived` when the field's label is what its name reads as, which no author chose. */
export const fieldWord = (label: string, field?: { name: string; label: string }): FieldWord => ({
  label,
  derived: field !== undefined && field.label === humanized(field.name),
});

/** A label inside a sentence: "Applicant name", read from a column's name, reads "applicant name". What an author wrote
    ("Toyota model") stays as written, and a word that is all capitals ("VIN") or has a capital inside it keeps them. */
const inSentence = ({ label, derived }: FieldWord) =>
  derived && /^[A-Z][a-z]+(?![A-Z])/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;

/**
 * What to do after a refusal, by its code: the words of the refusal are the App's, the way on is the platform's.
 * A submission (a public form) changes no record the person can refresh to see, so a refusal of its state or of
 * something it names says to look at the answers instead.
 */
export function refusalNext(code: string | undefined, field?: string | FieldWord, submission = false): string {
  if (field) return say('nextField', { field: inSentence(typeof field === 'string' ? { label: field, derived: false } : field) });
  if (submission && code === 'ineligible_state') return say('sentIneligible');
  if (submission && code === 'not_found') return say('sentNotFound');
  switch (code) {
    case 'invalid_input':
      return say('nextInput');
    case 'stale_record':
    case 'idempotency_conflict':
    case 'command_version_mismatch':
      return say('nextStale');
    case 'ineligible_state':
      return say('nextIneligible');
    case 'forbidden':
      return say('nextForbidden');
    case 'not_found':
      return say('nextNotFound');
    case 'rate_limited':
    case 'row_locked':
    case 'temporarily_unavailable':
    case 'unavailable':
      return say('nextWait');
    case 'duplicate_record':
      return say('nextDuplicate');
    default:
      return say('nextDefault');
  }
}

/** What to do after a lost answer: check, which reads the receipt — or, with no receipt kept, look at the record. */
export const unknownNext = (untracked = false): string => (untracked ? say('untrackedNext') : say('unknownNext'));

/** The title a state is read by, before its body. */
export function outcomeTitle(outcome: Outcome): string {
  return outcome.state === 'pending' ? WAITING[outcome.waiting]() : TITLE[outcome.state]();
}
const WAITING: Record<Waiting, () => string> = {
  sending: () => say('sending'),
  checking: () => say('checking'),
  queued: () => say('queued'),
  approval: () => say('approval'),
};
const TITLE: Record<Exclude<Outcome['state'], 'pending'>, () => string> = {
  done: () => say('done'),
  refused: () => say('refused'),
  unknown: () => say('unknown'),
};

interface OperationLike {
  phase: 'pending' | 'success' | 'error' | 'unknown';
  message: string;
  said?: string;
  output?: unknown;
  code?: string;
  field?: string;
  /** A pending operation that is reading the receipt of a lost answer, not sending. */
  checking?: boolean;
}

/**
 * A command operation (commandState.ts) as an outcome. `record` is the one
 * record it acted on, named, when the person is not already looking at it —
 * done then links to it. `untracked`: the action keeps no receipt, so a lost
 * answer is checked on the record itself.
 */
export function outcomeOfOperation(
  operation: OperationLike,
  { record, untracked = false, fieldLabel }: { record?: { label: string }; untracked?: boolean; fieldLabel?: FieldWord } = {},
): Outcome {
  switch (operation.phase) {
    case 'pending':
      return { state: 'pending', waiting: operation.checking ? 'checking' : 'sending' };
    case 'success': {
      const waiting = pendingOf(operation.output);
      if (waiting)
        return { state: 'pending', waiting, said: operation.said ?? (waiting === 'queued' ? say('queuedBody') : say('approvalBody')) };
      return { state: 'done', said: operation.said ?? say('doneBody'), ...(record ? { changed: record } : {}) };
    }
    case 'error':
      return { state: 'refused', said: operation.message, next: refusalNext(operation.code, fieldLabel) };
    default:
      return { state: 'unknown', said: say('unknownBody'), next: unknownNext(untracked) };
  }
}
