/**
 * The triggers on a table a scoped write may target, and which of them a given
 * write can fire.
 *
 * A row policy bounds the rows a write reaches; a trigger runs inside that
 * write and reaches whatever its body says, which the policy cannot see. So a
 * table with a trigger used to be refused as a target outright, for every
 * write — and a field report's ledger lost its integrity triggers to get past
 * it: a validation-only `BEFORE UPDATE OF posted_minor` refused an update of
 * `status` that could never fire it.
 *
 * Two facts now decide it per write, not per table, and each fails closed:
 *
 * - Whether the write can fire the trigger at all. An INSERT fires the INSERT
 *   triggers, a DELETE the DELETE triggers, and an UPDATE every UPDATE trigger
 *   without a column list and those whose `UPDATE OF` list meets the columns it
 *   sets. Both engines fire on the SET list, not on whether a value changed.
 *   A definition the engine cannot read is taken to fire on every write.
 * - Whether the trigger is validation-only: it reads only the row being
 *   written (NEW and OLD) and literals, raises or does nothing, and writes
 *   nothing — not even NEW. Such a trigger is a CHECK constraint written as
 *   code: what it reads the policy already admitted (the row is in scope), and
 *   what it does is refuse the statement. One that reads another table could
 *   say, by whether it raises, that a row the policy hides exists, so it is not
 *   validation-only, however little it writes. The grammar each engine
 *   accepts is narrow on purpose (sqliteTriggers.ts, postgresTriggers.ts):
 *   anything else is not proven, and blocks the writes that fire it.
 */

export type TriggerEvent = 'insert' | 'update' | 'delete';

/** A column of the row being written, as a trigger names it: `NEW.account_id`, `OLD.id`. */
export interface EffectRef {
  readonly row: 'new' | 'old';
  readonly column: string;
}

/**
 * A value a keyed effect writes: a column of the row being written, a literal, or an expression in the grammar
 * whose value only the trigger computes (`posted_minor + NEW.amount`, `CURRENT_TIMESTAMP`). Only the first two are
 * known before the write.
 */
export type EffectTerm = EffectRef | { readonly literal: string | number | null } | { readonly expression: true };

/**
 * One thing a trigger does beyond checking its own row, in the keyed-effect grammar (docs/trigger-effects.md): it
 * writes, inserts or deletes one row of a table it names by a key equal to columns of NEW or OLD, or reads one
 * column of such a row in a condition. `table` is the name the body gives it (PostgreSQL `schema.name`), until the
 * catalog resolves it to a table id (triggerEffects.ts).
 */
export interface TriggerEffect {
  readonly kind: 'update' | 'insert' | 'delete' | 'read';
  readonly table: string;
  /** update, delete and read: the row it reaches, each key column equal to a column of NEW or OLD. */
  readonly key?: Readonly<Record<string, EffectRef>>;
  /** update: the columns it sets; insert: the columns it gives; read: the column it reads (a null literal). */
  readonly values?: Readonly<Record<string, EffectTerm>>;
}

/**
 * One trigger on a table, as the writer's catalog read it — or other code a write runs that the policy cannot bound,
 * judged the same way: a CHECK constraint, a default or a domain calling a function of the database's
 * (postgresTriggers.ts readPostgresTableCode). Such code is never validation-only.
 */
export interface ScopeTrigger {
  readonly name: string;
  /** What it is, as a refusal names it, when not a trigger: `CHECK constraint`, `default of column`, `domain`. */
  readonly kind?: string;
  /** The writes that may fire it. */
  readonly events: readonly TriggerEvent[];
  /** An update fires it only when it sets one of these columns (`UPDATE OF`). Absent: every update fires it. */
  readonly columns?: readonly string[];
  /** Proven validation-only (above): it does not block the writes that fire it. */
  readonly validates: boolean;
  /** Why it is not, as a refusal and `mistri check` say it: `it writes rows`, `it reads another table`. */
  readonly why?: string;
  /**
   * What it does, where its body is in the keyed-effect grammar and does more than validate: the effects an App
   * accepts by naming the trigger (`resources.<table>.triggers`). Absent where the body leaves the grammar.
   */
  readonly effects?: readonly TriggerEffect[];
  /** Why the effects cannot be accepted even when named, once the catalog has judged them (triggerEffects.ts). */
  readonly unaccepted?: string;
  /** `sha256:<hex>` of the normalized definition: what authority.lock approves, so a changed body is a stale lock. */
  readonly digest?: string;
  /** The longest chain of accepted-kind triggers its effects start, itself included (triggerEffects.ts). */
  readonly depth?: number;
}

/** Why a trigger's effects are not accepted where its definition is not plain (plainDefinition). */
export const PLAIN = 'its definition holds characters outside plain SQL, or an IN without a list';

/**
 * Whether a definition is plain enough for its effects to be accepted: outside its literals, quoted names and
 * comments, only ASCII and the engines' common whitespace (no U+00A0, which JavaScript's `\s` takes for space and
 * SQLite for part of a name; no vertical tab), no `$`, and every IN followed by a parenthesized list. Effects widen
 * what a write reaches, so they are held to the strictest reading even where validation is not.
 */
export function plainDefinition(
  sql: string,
  tokens: readonly { kind: string; text?: string; upper?: string }[],
  dialect: 'sqlite' | 'postgres',
): boolean {
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const close =
      char === "'"
        ? "'"
        : char === '"'
          ? '"'
          : dialect === 'sqlite' && char === '`'
            ? '`'
            : dialect === 'sqlite' && char === '['
              ? ']'
              : undefined;
    if (close) {
      const end = sql.indexOf(close, i + 1);
      if (end === -1) return false;
      i = end + 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      const code = char.charCodeAt(0);
      if (code >= 0x7f || char === '$' || (code < 0x20 && !'\t\n\f\r'.includes(char))) return false;
      i += 1;
    }
  }
  return tokens.every((token, index) => token.upper !== 'IN' || (tokens[index + 1]?.kind === 'op' && tokens[index + 1]?.text === '('));
}

/** A write as the triggers see it: its kind, and for an update the columns it sets. */
export interface TriggeringWrite {
  readonly kind: TriggerEvent;
  readonly set?: readonly string[];
}

/* SQLite matches a column name in `UPDATE OF` as it matches every identifier, folding ASCII case; PostgreSQL names
   an attribute exactly. */
const foldedName = (name: string) => name.replace(/[A-Z]/g, (char) => char.toLowerCase());

/** The triggers `write` can fire. */
export function firedBy(triggers: readonly ScopeTrigger[], write: TriggeringWrite, foldCase: boolean): ScopeTrigger[] {
  const same = foldCase ? foldedName : (name: string) => name;
  const set = new Set((write.set ?? []).map(same));
  return triggers.filter(
    (trigger) =>
      trigger.events.includes(write.kind) &&
      (write.kind !== 'update' ||
        trigger.columns === undefined ||
        write.set === undefined ||
        trigger.columns.some((column) => set.has(same(column)))),
  );
}

/** The triggers that keep `write` from running under a row policy: those it fires that are not validation-only. */
export function blockingTriggers(triggers: readonly ScopeTrigger[], write: TriggeringWrite, foldCase: boolean): ScopeTrigger[] {
  return firedBy(triggers, write, foldCase).filter((trigger) => !trigger.validates);
}

/** A write as a sentence names it: `an insert`, `an update of status, note`, `a delete`. */
export function sayWrite(write: TriggeringWrite): string {
  if (write.kind === 'insert') return 'an insert';
  if (write.kind === 'delete') return 'a delete';
  return write.set?.length ? `an update of ${write.set.join(', ')}` : 'an update';
}

const said = (trigger: ScopeTrigger) => `${JSON.stringify(trigger.name)} (${trigger.why ?? 'it is not validation-only'})`;

/**
 * Triggers as a refusal and `mistri check` name them: `the trigger "post" (it writes rows)`; other code by what it is,
 * `the CHECK constraint "seen" (it calls public.peek(text))`.
 */
export const sayTriggers = (triggers: readonly ScopeTrigger[]): string =>
  triggers.every((trigger) => trigger.kind === undefined)
    ? `the trigger${triggers.length === 1 ? '' : 's'} ${triggers.map(said).join(', ')}`
    : triggers.map((trigger) => `the ${trigger.kind ?? 'trigger'} ${said(trigger)}`).join(', ');

/** What a write does to the code it runs, as a refusal says it: `fires` a trigger, `runs` a constraint or a default. */
export const sayRuns = (triggers: readonly ScopeTrigger[]): string =>
  triggers.every((trigger) => trigger.kind === undefined) ? 'fires' : 'runs';

/** The writes a set of triggers blocks, as `mistri check` names them: `inserts`, `updates of posted_minor`, `deletes`. */
export function sayBlocked(triggers: readonly ScopeTrigger[]): string[] {
  const blocking = triggers.filter((trigger) => !trigger.validates);
  const said: string[] = [];
  if (blocking.some((trigger) => trigger.events.includes('insert'))) said.push('inserts');
  const updates = blocking.filter((trigger) => trigger.events.includes('update'));
  if (updates.some((trigger) => trigger.columns === undefined)) said.push('every update');
  else if (updates.length) said.push(`updates of ${[...new Set(updates.flatMap((trigger) => trigger.columns!))].join(', ')}`);
  if (blocking.some((trigger) => trigger.events.includes('delete'))) said.push('deletes');
  return said;
}

/** Whether the triggers refuse every insert, every update and every delete: no write to the table can run. */
export function blocksEveryWrite(triggers: readonly ScopeTrigger[]): boolean {
  const blocking = triggers.filter((trigger) => !trigger.validates);
  return (
    blocking.some((trigger) => trigger.events.includes('insert')) &&
    blocking.some((trigger) => trigger.events.includes('update') && trigger.columns === undefined) &&
    blocking.some((trigger) => trigger.events.includes('delete'))
  );
}
