/**
 * What a condition's right-hand side can stand for besides a literal: another
 * column (`on_hand < product_id.reorder_level`) or the signed-in person
 * (`owner_id = me`). Kept beside the query language rather than in it, since
 * each is a judgement about two columns or a session the grammar itself never
 * needs; query.ts asks these where a value would otherwise be read.
 */
import type { Condition, Op } from './filter.js';
import { columnKind, type ColumnKind, type ColumnMeta, type MachineStates, type TableMeta } from './schema.js';

/**
 * Who `me` is, for one request: the signed-in account, as the server's own
 * session says. Absent from a parse, `me` is refused rather than read as the
 * two letters, which made `owner != me` every row wherever a path forgot the
 * person; `"me"` quoted is the word.
 */
export interface QueryPerson {
  /** The account's email; null when nobody is signed in. */
  email: string | null;
  /** Signed in, with an email not yet proven where anyone may sign up: someone, and no one's `me` (appMe.ts unprovenPerson). */
  unproven?: true;
  /**
   * Nobody in particular: a catalog asking whether a segment reads at all, before
   * any request (appSegments.ts servedSegments). `me` and `me.<table>.<column>` are
   * read as no one's, so a segment about the person is judged by the rest of what it says.
   */
  anyone?: true;
  /**
   * The table people are rows of (an App's `auth.me`), and the signed-in
   * account's row key there — null when no row carries their email, which
   * then matches nothing rather than failing the list.
   */
  person?: { table: string; key: string | number | null };
  /**
   * `me.<table>.<column>` in a value list, by `table.column`:
   * the values of `column` in the rows of `table` that point at the person —
   * their teams, their territories — read for this request through its own
   * reader, so a row its grants, row policy or tenant hide is none of them;
   * or why they cannot be read.
   */
  sets?: Readonly<Record<string, MeSet>>;
}

/** Nobody in particular (`anyone` above): what a check that runs before any request reads `me` as. */
export const ANYONE: QueryPerson = Object.freeze({ email: null, anyone: true });

/** One `me.<table>.<column>`: its values and their kind, or the sentence that refuses it. */
export type MeSet = { values: readonly (string | number)[]; kind: ColumnKind } | { error: string };

/** `me.<table>.<column>`, written as one item of a value list. */
export const ME_SET = /^me\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;

export interface CompileContext {
  table: TableMeta | undefined;
  now: Date;
  /** Admit a column on the right-hand side (a view's compiler resolves it). */
  columnValues: boolean;
  me?: QueryPerson | null;
  /** A machine's states by column, where the catalog does not carry them (a parse with no schema). */
  states?: Readonly<Record<string, MachineStates>>;
}

const COMPARISON_OPS = new Set<Op>(['=', '!=', '<', '<=', '>', '>=']);
const BARE_WORD = /^[A-Za-z_$][\w$]*$/;
const PATH_WORD = /^[A-Za-z_$][\w$+]*(?:\.[A-Za-z_$][\w$+]*)+$/;

/**
 * The column an unquoted right-hand side names, when it names one.
 *
 * A reference path always does, on any column: no value is spelled
 * `product_id.reorder_level`, and reading it as text was a comparison
 * between a number and a word that SQLite answers "less" for every row. A
 * bare word does only beside a number, date or flag, which it could never
 * be the value of; beside text, `source = email` is the value "email" even
 * where the table has an `email` column, because that is what a status tab
 * means by it. Quoted, it is text everywhere.
 */
export function columnOperand(
  ctx: CompileContext,
  left: ColumnMeta | undefined,
  op: Op,
  value: string,
): { other?: ColumnMeta; error?: string } {
  const table = ctx.table;
  if (!table) return {};
  const path = PATH_WORD.test(value);
  if (!path && !BARE_WORD.test(value)) return {};
  const named = table.columns.find((c) => c.name === value);
  if (!path) {
    const kind = left ? columnKind(left.type) : 'other';
    if (!named || kind === 'text' || kind === 'other') return {};
  } else if (!named) {
    /* A dotted word whose first hop is a column is a path that did not
       resolve here — in a plain query because paths need a view, in a view
       because it goes nowhere (the view parser reports which). */
    if (!table.columns.some((c) => c.name === value.split('.')[0].split('+')[0])) return {};
    return {
      error: `"${value}" is a path, and a condition here compares ${table.name}'s own columns with a value. Quote it ("${value}") to mean the text.`,
    };
  }
  if (!ctx.columnValues) {
    return {
      error: `"${value}" is a column, and a condition here compares a column with a value. Quote it ("${value}") to mean the text.`,
    };
  }
  if (!COMPARISON_OPS.has(op)) return { error: `"${value}" is a column; compare it with =, !=, <, <=, > or >=.` };
  const a = left ? columnKind(left.type) : 'other';
  const b = columnKind(named!.type);
  if (a !== 'other' && b !== 'other' && a !== b) {
    return {
      error: `"${left!.name}" is ${left!.type || 'untyped'} and "${value}" is ${named!.type || 'untyped'}, so comparing them says nothing. Compare columns of one kind.`,
    };
  }
  return { other: named };
}

/**
 * What `me.<table>.<column>` stands for in a value list beside one column:
 * the values read for this request, of the column's own kind. An empty set
 * leaves the list holding nothing of the person's, which matches nothing.
 */
export function meSetOperand(
  ctx: CompileContext,
  column: ColumnMeta | undefined,
  word: string,
): { values?: (string | number)[]; error?: string } {
  const me: QueryPerson = ctx.me ?? { email: null };
  if (me.anyone) return { values: [] };
  if (me.email === null && !me.unproven) return { error: 'me is the signed-in person, and nobody is signed in.' };
  const set = me.sets?.[word.slice(3)];
  if (!set)
    return { error: `${word} is read only where a request names the signed-in person: a list, a tab, a count or an export of an App.` };
  if ('error' in set) return { error: set.error };
  const kind = column ? columnKind(column.type) : 'other';
  if (kind !== 'other' && set.kind !== 'other' && kind !== set.kind)
    return {
      error: `"${column!.name}" is ${column!.type || 'untyped'}, and ${word} holds ${set.kind} values, so comparing them says nothing.`,
    };
  return { values: [...set.values] };
}

/**
 * What `me` stands for beside one column: the person's row key where the
 * column points at the table people are rows of (or is that table's key),
 * their email where it holds text. Anything else is refused by name —
 * comparing a date with an email is the silent empty tab this exists to stop.
 */
export function meOperand(
  ctx: CompileContext,
  column: ColumnMeta | undefined,
  op: Op,
): { value?: string | number; conditions?: Condition[]; error?: string } {
  const me: QueryPerson = ctx.me ?? { email: null };
  /* Anyone's, for a check before any request: the word, which every column takes. */
  if (me.anyone) return { value: 'me' };
  const table = ctx.table;
  const name = column?.name ?? 'this column';
  const person = me.person;
  const points = person && column && (column.references?.table === person.table || (table?.id === person.table && column.primaryKey));
  /* Signed in, but nothing they said is proven: nothing is theirs. As for a person without a row. */
  const nothing = (): { conditions?: Condition[]; error?: string } =>
    op === '='
      ? { conditions: [{ column: name, op: 'in', value: [] }] }
      : op === '!='
        ? { conditions: [{ column: name, op: 'isNotNull' }] }
        : { error: `me is compared with ${name} by = or != only.` };
  if (points) {
    if (me.email === null) return me.unproven ? nothing() : { error: 'me is the signed-in person, and nobody is signed in.' };
    if (person!.key !== null) return { value: person!.key };
    /* Signed in, but no row carries the email: nothing is theirs. Said as
       conditions the builder already speaks, so no engine binds a null. */
    if (op === '=') return { conditions: [{ column: name, op: 'in', value: [] }] };
    if (op === '!=') return { conditions: [{ column: name, op: 'isNotNull' }] };
    return { error: `me is compared with ${name} by = or != only.` };
  }
  if (column?.references) {
    return {
      error: person
        ? `"${name}" references ${column.references.table}, and me is a row of ${person.table} or the signed-in account's email. Compare a column that points at ${person.table}, or a text column like ${name}.email.`
        : `"${name}" references ${column.references.table}, and me is the signed-in account's email. Say which table people are rows of — auth: { me: { from: '${column.references.table}', column: 'email' } } — or compare a text column (${name}.email = me).`,
    };
  }
  if (column && columnKind(column.type) !== 'text') {
    return {
      error: `"${name}" is ${column.type || 'untyped'}, and me is the signed-in account's email${person ? ` or their ${person.table} row` : ''}, which only a text column${person ? ' or a reference to it' : ''} holds.`,
    };
  }
  if (me.email === null) return me.unproven ? nothing() : { error: 'me is the signed-in person, and nobody is signed in.' };
  return { value: me.email };
}
