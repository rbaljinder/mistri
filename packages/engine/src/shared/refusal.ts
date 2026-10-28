/*
 * The error a request earns when the tool will not carry it out. Shared
 * because the row-scope and scope-catalog rules refuse requests as well as
 * the adapters, and every caller tells a refusal from a failure by this one
 * class.
 */
/**
 * A request an adapter will not carry out.
 *
 * Distinct from a database failure, and the distinction is the whole point:
 * "that is not the whole primary key" and "the database is down" are both
 * exceptions, and a server that cannot tell them apart answers both with a
 * 500. The first is something the caller can fix by asking differently.
 *
 * Ordinary adapter guards run before a statement. Private scoped transactions
 * also use this for stored-image checks: those failures poison the transaction
 * and require rollback. The error class alone never proves a write outcome.
 */
export class Refusal extends Error {
  /** The column names the message quotes, so a surface that calls them something else (an App's captions) can say them its way. Never values. */
  readonly columns?: readonly string[];

  /** `cause`: a database failure that kept the check from being made. The
   * request is still refused — the boundary does not move — but an owner that
   * answers a caller can tell "refused" from "could not answer". */
  constructor(message: string, options: { columns?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'Refusal';
    if (options.columns?.length) this.columns = [...new Set(options.columns)];
  }
}

/* Why a refusal happened, kept for the trusted owner that has to diagnose it.
   A caller hears one fixed sentence and must: a driver's error text names
   columns, values and internal tables, and a clash on a hidden unique column
   says a row exists. But the sentence alone, with the real error swallowed,
   has cost App authors whole days — an UPDATE the database refused, a startup
   that could not say which store, a row policy that "could not be loaded". So
   the cause is recorded on the refusal and kept off `cause`, which would
   travel with the error everywhere it is inspected or serialized:
   symbol-keyed and non-enumerable, so `'cause' in error` stays false and JSON
   ignores it. One mechanism for every refusal, tenant, command and row policy
   alike; registered, so a second copy of this module in a mixed deployment
   reads the same key. */
const CAUSE = Symbol.for('mistri.refusalCause');
/** Record why a refusal happened on the refusal itself, for the trusted reader
 * only. Every opaque refusal takes its reason this way — a tenant denial, a
 * row policy that did not load, a command the database would not take — so
 * the one reader below can say it to the operator. A string is a sentence for
 * that operator, written here and naming the rule, table or column. */
export function recordRefusalCause<E extends object>(error: E, cause: unknown): E {
  if (cause !== undefined && !Object.hasOwn(error, CAUSE)) {
    Object.defineProperty(error, CAUSE, { value: typeof cause === 'string' ? new Error(cause) : cause, enumerable: false });
  }
  return error;
}
/** The recorded reason behind a refusal, for a trusted diagnostic only. */
export const refusalCause = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && CAUSE in error ? (error as Record<symbol, unknown>)[CAUSE] : undefined;

/**
 * What the operator is told about a refusal: each reason under it, outermost
 * first — a recorded cause before `cause`, since the recorded one is the
 * refusal's own — as messages, never objects, because a driver error's object
 * can carry connection detail a console should not. Repeats are said once:
 * a refusal rethrown as the same sentence is one reason, not two.
 */
export function refusalReasons(error: unknown): string[] {
  const reasons: string[] = [];
  const seen = new Set<unknown>([error]);
  const outer = error instanceof Error ? error.message : undefined;
  for (
    let because = refusalCause(error) ?? (error as { cause?: unknown } | null)?.cause, depth = 0;
    because instanceof Error && !seen.has(because) && depth < 8;
    depth++
  ) {
    seen.add(because);
    if (because.message && because.message !== outer && !reasons.includes(because.message)) reasons.push(because.message);
    because = refusalCause(because) ?? because.cause;
  }
  return reasons;
}

/**
 * The refusal's one line for a startup headline: the fixed sentence, then the
 * reason behind it. The `because:` lines under it carry the whole chain, but a
 * reader (or a log that keeps one line) stopped at "could not be loaded or is
 * invalid" and went to bisect the module; the headline now says the cause.
 */
export function refusalHeadline(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [cause] = refusalReasons(error);
  return cause ? `${message} Cause: ${cause}` : message;
}

/** The `because:` lines under a refusalHeadline: the chain past the cause the headline says already, which
    printed again beneath it read as two reasons. */
export const refusalReasonsBelow = (error: unknown): string[] => refusalReasons(error).slice(1);

/**
 * A startup failure as the operator's terminal says it: the headline, then
 * each further reason on a `because:` line. Every startup print goes through
 * this, so a refusal that recorded why (a tenant denial's `"fonts" is not a
 * key this takes`) is never said as its fixed sentence alone. The terminal of
 * the person who started the server only: never an HTTP answer.
 */
export function startupReport(error: unknown): string {
  return [
    refusalHeadline(error),
    ...refusalReasonsBelow(error).map((reason) => `  because: ${reason}`),
    ...faultFrames(error).map((frame) => `  ${frame}`),
  ].join('\n');
}

/* A TypeError, a ReferenceError or a RangeError is a fault in the code that read the App, not a refusal of what its
   author wrote: its sentence ("Cannot read properties of undefined (reading 'realm')") names nothing to go and fix,
   and was printed with its stack swallowed (a field report). Its first frames are said beneath it, the file and line
   a fix starts from. A refusal, however deep, is said as its sentences alone. */
const FAULTS = new Set(['TypeError', 'ReferenceError', 'RangeError']);
/** Where an unexpected fault in `error` (or the chain under it) happened: its first stack frames, or none for a refusal.
    Read by name, not `instanceof`: an App module's errors are another realm's. */
export function faultFrames(error: unknown, most = 6): string[] {
  const seen = new Set<unknown>();
  for (let at: unknown = error, depth = 0; at !== null && typeof at === 'object' && !seen.has(at) && depth < 8; depth++) {
    seen.add(at);
    const { name, stack } = at as { name?: unknown; stack?: unknown };
    if (typeof name === 'string' && FAULTS.has(name) && typeof stack === 'string')
      return stack
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .slice(0, most)
        .map((line) => line.trim());
    at = refusalCause(at) ?? (at as { cause?: unknown }).cause;
  }
  return [];
}

/* What a refused request's own caller may be told about why: a sentence
   naming only what the request itself named (the table, the column, the
   command) and the kind of rule that refused it — the role's grant, the row
   policy, the database computing a column. Never a row it cannot see, a
   value, a physical name or a driver's words: those stay recorded for the
   operator (recordRefusalCause). Set where the refusal is decided, by the code
   that knows which rule it was, and said in place of the fixed sentence at
   the one place a request's failure becomes its answer (field report TR7:
   "not available to this account" with the cause only on the terminal). */
const SAID = Symbol.for('mistri.refusalSaid');
/** Record the sentence this refusal's caller is told: see above. The first one recorded stands. */
export function sayRefusal<E extends object>(error: E, sentence: string): E {
  if (sentence && !Object.hasOwn(error, SAID)) Object.defineProperty(error, SAID, { value: sentence, enumerable: false });
  return error;
}
/** The sentence a refusal's caller may read about why, if the code that refused said one. */
export const refusalSaid = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && SAID in error ? String((error as Record<symbol, unknown>)[SAID]) : undefined;
