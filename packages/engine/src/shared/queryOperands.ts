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
   * With `anyone`: the query is compiled once and kept for every request (a rollup's rows), so a fact of one
   * request, `tenant.<column>`, cannot be read into it. Held for `anyone` alone, as a check before any request
   * does; here refused, since a figure that held it for everyone would count every row.
   */
  once?: true;
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
  /**
   * `tenant.<column>`: the reader's tenant profile row, by column, for the columns
   * the App shares with its members (`auth.tenancy.shared`), read once for this
   * request. A missing row reads as every column null. Absent where no tenant is
   * meant, and `tenant.<column>` is then refused rather than read as text.
   */
  tenant?: Readonly<Record<string, TenantValue>>;
}

/** One column of a tenant's profile row, as a member may read it. */
export type TenantValue = string | number | boolean | null;

/** `tenant.<column>`, unquoted, on the right of a comparison or in a value list. */
const TENANT_VALUE = /^tenant\.([A-Za-z_]\w*)$/;

/** Nobody in particular (`anyone` above): what a check that runs before any request reads `me` as. */
export const ANYONE: QueryPerson = Object.freeze({ email: null, anyone: true });

/** ANYONE for a query kept as it is compiled and served to every request: `tenant.<column>` is refused, not held. */
export const ANYONE_ONCE: QueryPerson = Object.freeze({ email: null, anyone: true, once: true });

const ONCE_TENANT = (word: string): string =>
  `${word} is a fact of one request's tenant, and this query is read once for every request, so it cannot ask it. Test the tenant in a \`when\` instead.`;

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

/** `tenant.<column>` where a condition's left-hand column would be. */
export const TENANT_FIELD = TENANT_VALUE;

/** How a condition with `tenant.<column>` on its left compares (`tenant.plan = 'pro'`, `tenant.plan in (pro, team)`). */
export type TenantTest = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not in' | 'isNull' | 'isNotNull';

/**
 * `tenant.<column>` on the left of a condition (`tenant.plan = 'pro'`): no column of the row but a fact of this
 * request, as a menu's or a command input's `when` reads it (commandWhen.ts foldWhen), so the condition holds of
 * every row or of none. Judged against the profile as that fold judges it: a null value meets only `is empty`, and
 * a value written is read as the profile's kind (a number, a flag, text). Refused with the words the right-hand
 * form uses where no tenant is meant or the column is not shared. A check before any request (ANYONE) holds it,
 * and the request judges it.
 */
export function tenantHolds(
  ctx: CompileContext,
  word: string,
  test: TenantTest,
  values: readonly { value: string; quoted: boolean }[],
): { holds?: boolean; error?: string } {
  const column = TENANT_VALUE.exec(word)![1];
  const me = ctx.me;
  if (me?.anyone && me.tenant === undefined) return me.once ? { error: ONCE_TENANT(word) } : { holds: true };
  if (!me?.tenant)
    return { error: `${word} is the reader's tenant profile, and no tenant is meant here. Quote it ("${word}") to mean the text.` };
  if (!Object.hasOwn(me.tenant, column))
    return { error: `${word} is not a column the App shares with its members: list "${column}" in auth.tenancy.shared.` };
  for (const { value, quoted } of values) {
    if (!quoted && (value === 'me' || ME_SET.test(value) || TENANT_VALUE.test(value) || ctx.table?.columns.some((c) => c.name === value)))
      return { error: `${word} is compared with a value, and ${value} is not one. Quote it ("${value}") to mean the text.` };
  }
  const held = me.tenant[column];
  if (test === 'isNull') return { holds: held === null };
  if (test === 'isNotNull') return { holds: held !== null };
  if (held === null) return { holds: false };
  const as = (given: string): string | number | boolean =>
    typeof held === 'number' ? Number(given) : typeof held === 'boolean' ? /^(1|true|t|yes|y)$/i.test(given) : given;
  const read = values.map((item) => as(item.value));
  switch (test) {
    case 'in':
      return { holds: read.includes(held) };
    case 'not in':
      return { holds: !read.includes(held) };
    case '=':
      return { holds: held === read[0] };
    case '!=':
      return { holds: held !== read[0] };
    case '<':
      return { holds: held < read[0] };
    case '<=':
      return { holds: held <= read[0] };
    case '>':
      return { holds: held > read[0] };
    case '>=':
      return { holds: held >= read[0] };
  }
}

/**
 * What `tenant.<column>` stands for beside one column: the profile's value, read for
 * this request. Undefined where the word is not one (quoted, or the table has a
 * `tenant` column of its own, whose path it then is). A null value matches no row, as
 * SQL's `= NULL` would, but said as conditions every engine speaks; in a list it is
 * left out. A check before any request (ANYONE) reads it as the word.
 */
export function tenantOperand(
  ctx: CompileContext,
  column: ColumnMeta | undefined,
  word: string,
  quoted: boolean,
): { value?: string | number | boolean; none?: true; error?: string } | undefined {
  const match = quoted ? null : TENANT_VALUE.exec(word);
  if (!match || ctx.table?.columns.some((c) => c.name === 'tenant')) return undefined;
  const me = ctx.me;
  if (me?.anyone && me.tenant === undefined) return me.once ? { error: ONCE_TENANT(word) } : { value: word };
  if (!me?.tenant)
    return { error: `${word} is the reader's tenant profile, and no tenant is meant here. Quote it ("${word}") to mean the text.` };
  if (!Object.hasOwn(me.tenant, match[1]))
    return { error: `${word} is not a column the App shares with its members: list "${match[1]}" in auth.tenancy.shared.` };
  const value = me.tenant[match[1]];
  if (value === null) return { none: true };
  if (typeof value === 'boolean' && column && columnKind(column.type) !== 'boolean')
    return { error: `${word} is a flag, and ${column.name} is not.` };
  return { value };
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
