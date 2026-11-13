/** Fixed command refusals shared by handlers and execution, without loading the executor. */
import { isProxy } from 'node:util/types';
import { COMMAND_FIELD_PATH } from '@mistriwork/engine/shared/commandFieldPath.js';
import { COMMAND_REFUSAL_MESSAGES } from '../../shared/commandRefusals.js';
import { refusalSaid } from '@mistriwork/engine/shared/refusal.js';
import { isMessageRef, type AppMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import type { CommandKey } from './commandPayload.js';
import type { UntypedRow, WriteTable } from './commandDb.js';

const messages = COMMAND_REFUSAL_MESSAGES;

/* A handler can hold a second copy of this class. It imports it from
   `@mistriwork/mistri/commands`, and that is dist/ through the package self-reference
   but src/ under tsx (the root tsconfig's `paths`); a deployment that mixes
   the two — a built server, a handler bundled with its own mistri — would
   fail `instanceof` here and report every domain refusal as
   temporarily_unavailable. The brand is a registered symbol, so every copy
   of the module shares it, and the classification below reads it instead
   of the prototype chain. The native class still passes `instanceof`
   everywhere else, unchanged. */
const brand = Symbol.for('mistri.businessCommandExecutionError');

/** A bounded, detached copy of a key a refusal names; anything else names none. */
function namedKey(key: unknown): CommandKey | undefined {
  try {
    if (!key || typeof key !== 'object' || Array.isArray(key) || isProxy(key)) return undefined;
    const entries = Object.entries(key);
    if (!entries.length || entries.length > 16) return undefined;
    const copy: Record<string, string | number> = {};
    for (const [column, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(column)) return undefined;
      if (typeof value === 'string' ? value.length > 1024 : typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      copy[column] = value;
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  }
}

/* A handler's own sentence for why it said no: one line, bounded, never
   empty. Anything else is not a reason, and the code's fixed message stands. */
const REASON_MAX = 300;
function readerReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const said = reason.replace(/\s+/g, ' ').trim();
  const control = [...said].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
  return said && said.length <= REASON_MAX && !control ? said : undefined;
}

export class BusinessCommandExecutionError extends Error {
  readonly [brand] = true;
  /** The input the refusal is about, by its path — `reason`, `applicant.email`,
   * `vehicles[1].stock`; the message stays fixed. */
  readonly field?: string;
  /** The target the refusal is about, when a request names several. The
   * executor keeps it only when it is one of the request's own keys. */
  readonly key?: CommandKey;
  /** The handler's own sentence for the reader — `refuse('Quinn has 0 h of
   * Personal left')` — said in place of the code's fixed message. A handler
   * writes one, or the App's rule a handler's write broke (a validation's
   * `message`, a narrowed picker's pairing): the platform's other refusals
   * keep their fixed words. */
  readonly reason?: string;
  constructor(
    readonly code: keyof typeof messages,
    readonly outcome: 'not_applied' | 'unknown' = 'not_applied',
    field?: string,
    key?: Readonly<Record<string, string | number>>,
    reason?: string,
  ) {
    const said = readerReason(reason);
    super(said ?? messages[code]);
    this.name = 'BusinessCommandExecutionError';
    if (typeof field === 'string' && field.length <= 400 && COMMAND_FIELD_PATH.test(field)) this.field = field;
    const target = namedKey(key);
    if (target) this.key = target;
    if (said) this.reason = said;
  }
}

/** The native class, or a branded structural twin from another copy of the package. */
export function isBusinessCommandExecutionError(error: unknown): error is BusinessCommandExecutionError {
  if (error instanceof BusinessCommandExecutionError) return true;
  if (!(error instanceof Error) || (error as { [brand]?: unknown })[brand] !== true) return false;
  const { code, outcome, field, key, reason } = error as {
    code?: unknown;
    outcome?: unknown;
    field?: unknown;
    key?: unknown;
    reason?: unknown;
  };
  return (
    typeof code === 'string' &&
    Object.hasOwn(messages, code) &&
    (outcome === 'not_applied' || outcome === 'unknown') &&
    (field === undefined || typeof field === 'string') &&
    (key === undefined || (typeof key === 'object' && key !== null)) &&
    (reason === undefined || typeof reason === 'string')
  );
}

/** The codes a handler may refuse with: the platform's, each with its fixed message. */
export type RefusalCode = keyof typeof messages;

/** A table as a refusal's `keep` writes it: read, insert and update; never remove, never a file. */
export type RefusalKeepTable = Omit<WriteTable<UntypedRow>, 'remove' | 'insertFile' | 'moveFile'>;
/** What `keep` is handed: the tables of the command's `refused: { writes }`, and only those. */
export type RefusalKeepDb = Readonly<Record<string, RefusalKeepTable>>;

type RefusalDetail = {
  readonly field?: string;
  readonly key?: Readonly<Record<string, string | number>>;
  /** What the refusal still writes, in a fresh transaction once the handler's own writes are rolled back. Method
      syntax, so a handler may annotate `db` with its own context's type. */
  keep?(db: RefusalKeepDb): Promise<unknown>;
};

/* Registered, like the brand: the executor may hold another copy of this module than the handler's. Not
   enumerable, so a refusal said anywhere never carries its function along. */
const keepKey = Symbol.for('mistri.refusalKeep');
const keeping = (error: BusinessCommandExecutionError, keep: RefusalDetail['keep']): BusinessCommandExecutionError => {
  if (keep !== undefined) {
    if (typeof keep !== 'function') throw new TypeError('refuse() keep is an async function of the refused writes.');
    Object.defineProperty(error, keepKey, { value: keep, enumerable: false });
  }
  return error;
};

/** The `keep` a handler's refusal carries, if it carries one. */
export const refusalKeep = (error: unknown): ((db: RefusalKeepDb) => Promise<unknown>) | undefined => {
  const keep = error && typeof error === 'object' ? (error as Record<symbol, unknown>)[keepKey] : undefined;
  return typeof keep === 'function' ? (keep as (db: RefusalKeepDb) => Promise<unknown>) : undefined;
};

/** `to`, carrying the `keep` that `from` carries: a refusal said again elsewhere still leaves behind what it must. */
export const carryRefusalKeep = (from: unknown, to: BusinessCommandExecutionError): BusinessCommandExecutionError =>
  keeping(to, refusalKeep(from));

/* The App's message a refusal names (`refuse(msg('booking.full'))`), registered and hidden as `keep` is: the handler
   cannot say it, since it is said in the locale the server resolved, which the executor knows and the error does not. */
const messageKey = Symbol.for('mistri.refusalMessage');

/** The message a handler's refusal names, if it names one. */
const refusalMessage = (error: unknown): AppMessageRef | undefined => {
  const ref = error && typeof error === 'object' ? (error as Record<symbol, unknown>)[messageKey] : undefined;
  return isMessageRef(ref) ? ref : undefined;
};

/** A refusal's reason: its own sentence, else the message it names said by `say` (none where it cannot be: the code's words stand). */
export function refusalReason(error: unknown, say: (ref: AppMessageRef) => string | undefined): string | undefined {
  if (isBusinessCommandExecutionError(error) && error.reason !== undefined) return error.reason;
  const ref = refusalMessage(error);
  if (!ref) return undefined;
  try {
    return readerReason(say(ref));
  } catch {
    return undefined;
  }
}

/**
 * Refuse the command: nothing it wrote is kept, and the caller hears `code`'s
 * fixed message. `detail` is the input field the refusal is about (by path:
 * `applicant.email`, `rows[1].stock`), or `{ field, key }` — a key naming
 * which of several targets it is about. Typed `never`, so code after it knows
 * the condition that led to it was false.
 *
 * Or say why, in the reader's words: `refuse('Quinn has 0 h of Personal
 * left')` is `ineligible_state` — the record's state does not allow it —
 * with that sentence in place of the fixed message, in the form and the
 * report (the App API's problem keeps its fixed title). One line of at most
 * 300 characters; `{ key }` names the target when a request lists several.
 *
 * A sentence about one answer says which: `refuse('Only $12.00 is left to
 * refund', { field: 'amount' })` is `invalid_input` — the answer, not the
 * record, is what stops it — said under that field of the form, which stays
 * open to be corrected. The field is an input's path, as `detail` names one.
 *
 * Or say it from the App's messages: `refuse(msg('booking.full'))` is said in
 * the locale the person is served in (`ctx.locale`), as a sentence is, and
 * takes the same `{ field, key, keep }`. The message is said without
 * arguments; a key the catalogs lack leaves the code's fixed message.
 *
 * `{ keep: async (db) => … }` writes what a refusal must still leave behind — a
 * failed attempt counted, a lockout set — in a fresh transaction once the
 * handler's writes are rolled back, through the tables the command names in
 * `refused: { writes }`. The refusal is answered after it commits.
 */
export function refuse(reason: string, detail?: RefusalDetail): never;
export function refuse(message: AppMessageRef, detail?: RefusalDetail): never;
export function refuse(code: RefusalCode, detail?: string | RefusalDetail): never;
export function refuse(codeOrReason: string | AppMessageRef, detail?: string | RefusalDetail): never {
  const { field, key, keep } = typeof detail === 'string' ? { field: detail, key: undefined, keep: undefined } : (detail ?? {});
  if (typeof codeOrReason === 'object' && codeOrReason !== null) {
    if (!isMessageRef(codeOrReason)) throw new TypeError("refuse() takes a refusal code, a one-line reason, or msg('a.key').");
    checkRefusalField(field);
    const error = keeping(
      new BusinessCommandExecutionError(field !== undefined ? 'invalid_input' : 'ineligible_state', 'not_applied', field, key),
      keep,
    );
    Object.defineProperty(error, messageKey, {
      value: Object.freeze({ message: codeOrReason.message, ...(codeOrReason.args ? { args: { ...codeOrReason.args } } : {}) }),
      enumerable: false,
    });
    throw error;
  }
  if (Object.hasOwn(messages, codeOrReason))
    throw keeping(new BusinessCommandExecutionError(codeOrReason as RefusalCode, 'not_applied', field, key), keep);
  /* A word shaped like a code that is not one is a typo, not a sentence for
     a reader; it fails the handler rather than showing "ineligble_state". */
  const reason = readerReason(codeOrReason);
  if (!reason || /^[a-z]+(_[a-z]+)+$/.test(reason)) {
    throw new TypeError(
      `refuse() takes a refusal code or a one-line reason of at most ${REASON_MAX} characters; got ${JSON.stringify(String(codeOrReason).slice(0, 60))}.`,
    );
  }
  checkRefusalField(field);
  if (field !== undefined) throw keeping(new BusinessCommandExecutionError('invalid_input', 'not_applied', field, key, reason), keep);
  throw keeping(new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, key, reason), keep);
}

function checkRefusalField(field: unknown): void {
  if (field !== undefined && (typeof field !== 'string' || field.length > 400 || !COMMAND_FIELD_PATH.test(field)))
    throw new TypeError(
      `refuse() names a field by its input's path, such as "amount" or "lines[1].quantity"; got ${JSON.stringify(String(field).slice(0, 60))}.`,
    );
}

/** `forbidden`, in the words of the rule that refused where it said them (sayRefusal), else the code's fixed message. */
export const forbiddenBy = (error: unknown, outcome: 'not_applied' | 'unknown' = 'not_applied'): BusinessCommandExecutionError =>
  new BusinessCommandExecutionError('forbidden', outcome, undefined, undefined, refusalSaid(error));
