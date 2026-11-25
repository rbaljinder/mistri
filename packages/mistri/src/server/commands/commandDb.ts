/**
 * The typed `db` a command handler reads and writes through: one small handle
 * per table of the command's footprint, over the command's own transaction.
 *
 * It is a view, not a second path. Every call goes through the transaction
 * the executor built — the footprint, the resource and field ceilings, the
 * row or tenant scope, the audit and cancellation — so a table missing from
 * the footprint is refused there even when a handler reaches past the types.
 * What it adds is the handler's everyday arithmetic, once: one row or a
 * `not_found`, the guarded update with its revision bump and its
 * `stale_record`, a where written as an object or in the query language, and
 * rows whose booleans read the same on every engine.
 *
 * The types come from the App's generated `Rows` through `defineSource`: a
 * handle's tables are those local to its source, and a command's `db` holds
 * exactly the tables its footprint names.
 */
import {
  insertAll,
  isWriteConflict,
  updateAll,
  type AggregateMeasure,
  type AggregateRequest,
  type Condition,
  type Filter,
  type UpdateRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { foldConstants, readsMe, type ComputedColumn, type ComputedNode, type ComputedType } from '@mistriwork/engine/shared/computed.js';
import { declaredScale, exactAverage, formatDecimal, parseDecimal } from '@mistriwork/engine/shared/decimals.js';
import { continueGroups, keysetAfter, keysetOrder } from '@mistriwork/engine/shared/keysetPage.js';
import { FORBIDDEN_ANSWER_NAMES } from '@mistriwork/engine/shared/aggregate.js';
import { compileWhere as compilePageWhere } from '@mistriwork/engine/shared/pageWhere.js';
import { authorFault } from '@mistriwork/engine/shared/refusal.js';
import { asksAboutRows, type DateUnit } from '@mistriwork/engine/shared/filter.js';
import {
  ANY_CONDITION,
  anyConditions,
  expandSegments,
  parseQuery,
  splitClauseTail,
  type QueryPerson,
} from '@mistriwork/engine/shared/query.js';
import { nearest } from '@mistriwork/engine/shared/suggest.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import {
  columnKind,
  findTable,
  isJsonType,
  type ColumnKind,
  type ColumnMeta,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { BusinessCommandExecutionError, refuse } from './commandErrors.js';
import { fileValues, readFileRow } from '../http/fileRows.js';
import type { FileScope } from '../files/fileStorage.js';
import type { AppFileRule } from '../../shared/app.js';
import type { CommandFile } from '../../../schema/command.js';
import { zonedNow } from '../../shared/appZone.js';
import type { CommandDerived } from './commandWhen.js';
import type { ColumnSaying } from './commandSaying.js';
import { PublicLinkRef } from '../links/publicLink.js';

/** A value a column holds, as the handle writes it. */
export type Value = string | number | boolean | null;
/** A row when the source is untyped: every column a value. */
export type UntypedRow = Readonly<Record<string, Value>>;

/* ---------- the types ---------- */

declare const rowsType: unique symbol;
/** A typed handle on one of the App's sources: `defineSource<Rows>('lending')`. */
export interface CommandSource<Rows = unknown> {
  readonly name: string;
  readonly [rowsType]?: Rows;
}

const sources = new WeakSet<object>();
/**
 * A source the commands on it name, typed by the App's generated `Rows`
 * (mistri-schema.d.ts). A target written qualified (`applicants.applicant`)
 * reads that source's tables; an unqualified one, the App's default source's.
 */
export function defineSource<Rows = unknown>(name: string): CommandSource<Rows> {
  const handle = Object.freeze({ name });
  sources.add(handle);
  return handle as CommandSource<Rows>;
}
/** The source name a definition gives, from a handle or as text; undefined when neither. */
export const sourceName = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : value && typeof value === 'object' && sources.has(value) ? (value as CommandSource).name : undefined;

type Qualified<R, S extends string> = { [K in keyof R as K extends `${S}.${infer L}` ? L : never]: R[K] };
type Unqualified<R> = { [K in keyof R as K extends `${string}.${string}` ? never : K]: R[K] };
/** A source's tables by their local names: the qualifier a target is written with picks the source. */
export type SourceTables<Src, Target extends string> =
  Src extends CommandSource<infer R>
    ? unknown extends R
      ? Record<string, UntypedRow>
      : Target extends `${infer S}.${string}`
        ? Qualified<R, S>
        : Unqualified<R>
    : Record<string, UntypedRow>;
/** A target or table name without its source qualifier. */
export type LocalName<Name extends string> = Name extends `${string}.${infer L}` ? L : Name;
type RowIn<Scope, T> = T extends keyof Scope ? Readonly<Scope[T]> : UntypedRow;

/** The tables a handle reads, by name, each its row: what a where's `in: { from }` may name. Untyped, any table. */
type Reads = Readonly<Record<string, object>>;
/** One of the read tables' rows a where matches, for `in`: their own columns only, so no `in` inside it. */
type InRows<R> = { [T in keyof R & string]: { readonly from: T; readonly where: Where<R[T], {}> } }[keyof R & string];
/** A column's operators, the page-side `Where`'s own: ranges on anything ordered, matches on text, and `not`; and `in`,
    the key of one of another read table's rows (`customer_id: { in: { from: 'customer', where: { region: 'west' } } }`). */
type Operators<V, R> = {
  readonly not?: V | null | readonly V[];
  readonly gt?: V;
  readonly gte?: V;
  readonly lt?: V;
  readonly lte?: V;
  readonly contains?: string;
  readonly startsWith?: string;
  readonly endsWith?: string;
  readonly in?: InRows<R>;
};
/** Every entry must hold: a value, a list meaning one of them, `null` meaning empty, or operators
    (`{ day: { gte: from, lte: to } }`) as a page's `where` says them. */
export type Where<Row, R = Reads> = {
  readonly [C in keyof Row | PathKey]?: C extends keyof Row
    ? Row[C] | readonly Exclude<Row[C], null | undefined>[] | Operators<Exclude<Row[C], null | undefined>, R>
    : PathValue;
};
/** A key with a dot is a column of the row a reference points at (`'customer_id.region': 'west'`): one hop, to a
    table the handle reads. Typed loosely, since a row type does not say where its references lead; the reference is
    checked when it runs. The pattern is one more key of the same mapped type, not a second object beside it: an
    intersection per table of every handle's reads took Ignition's checked types up by about a tenth. */
type PathKey = `${string}.${string}`;
type Scalar = string | number | boolean;
type PathValue = Scalar | null | readonly Scalar[] | Omit<Operators<Scalar, {}>, 'in'>;
/** A where: an object, or the query language (`'status = new and year >= 2018'`). */
type WhereInput<Row, R = Reads> = Where<Row, R> | string;

/** Rows of one table, read when awaited: what a lookup's `where` answers (commandLookup.ts), which reads rows only. */
export interface RowQuery<Row> extends PromiseLike<Row[]> {
  orderBy(column: keyof Row & string, direction?: 'asc' | 'desc'): RowQuery<Row>;
  /** At most this many rows. Without it, more than 1,000 is refused rather than cut. */
  limit(count: number): RowQuery<Row>;
  first(): Promise<Row | undefined>;
}

/* The measures and keys below are constrained by what any table could name and checked against this one's columns in
   the parameter, not in the constraint: a constraint on `Row` would make a typed table's query unassignable to an
   untyped one (a handler's `db` as BusinessCommandContext says it), which every other method here allows. */
type AnyMeasures = Readonly<Record<string, Measure>>;

/** A query over one table in a command's transaction, run when awaited: rows, sums, groups and pages. */
export interface Query<Row, R extends Reads = Reads> extends RowQuery<Row> {
  /** Narrows the rows further: every where this query has been given must hold (`db.lead.segment('open').where({ owner: 7 })`). */
  where(where: WhereInput<Row, R>): Query<Row, R>;
  orderBy(column: keyof Row & string, direction?: 'asc' | 'desc'): Query<Row, R>;
  /** At most this many rows. Without it, more than 1,000 is refused rather than cut. */
  limit(count: number): Query<Row, R>;
  /**
   * Beside each row's own columns, the App's computed columns and rollups named here (`.with('balance', 'open_alerts')`),
   * worked out by the SQL a list of the table writes for them, in the same one read, as this reader is served them.
   * Only a page's loader reads them, and only the names it declares in `reads` (`'invoice.balance'`); a command's `db`
   * reads stored columns. They go with a read of rows: not a sum, a group or a page.
   */
  with<const N extends string>(...names: readonly N[]): Query<Row & { readonly [K in N]: Value }, R>;
  /** The matching rows' total of a number column: an exact decimal string for a decimal or an integer column
      (`'1834.50'`, `'0.00'` over no rows), a number for a float column (`REAL`, `double precision`), whose digits are
      not exact. SQLite refuses a decimal sum it cannot add exactly rather than answer it wrong. */
  sum(column: keyof Row & string): Promise<string | number>;
  /** Measures over every matching row, as one object: `aggregate({ entries: count(), posted: sum('amount') })`. */
  aggregate<M extends AnyMeasures>(measures: M & Measures<Row>): Promise<Aggregated<Row, M>>;
  /** One group per value of up to three columns (or a date's period, `period.month('posted_on')`), measured by `aggregate`. */
  groupBy<const Keys extends readonly GroupKey<Row>[]>(...keys: Keys): GroupBy<Row, Keys[number]>;
  /** One page in key order (or this query's order, the key appended), resumable from `next`, which is plain data. */
  page(options: { readonly after?: Boundary | undefined; readonly size: number }): Promise<Page<Row>>;
  /** Every matching row, a page at a time, in one command: at most 100,000, refused past that, never cut. */
  iterate(options: { readonly size: number }): AsyncIterable<Row>;
}

/* ---------- sums, groups and pages: the types ---------- */

type ColumnOf<Row> = keyof Row & string;
/** What a measure says of its rows. */
export type MeasureWord = 'count' | 'sum' | 'avg' | 'min' | 'max';
/** One measure of an aggregate, made by `count`, `sum`, `avg`, `min` or `max`. */
export interface Measure<Word extends MeasureWord = MeasureWord, Column extends string | undefined = string | undefined> {
  readonly measure: Word;
  readonly column: Column;
}
/** A date or timestamp column cut to a period, as a group's key: `period.month('posted_on')`. */
export interface Period<Column extends string = string> {
  readonly period: DateUnit;
  readonly column: Column;
}
/** The measures an aggregate takes, by the names its answer carries them under. */
export type Measures<Row> = Readonly<
  Record<string, Measure<'count', ColumnOf<Row> | undefined> | Measure<'sum' | 'avg' | 'min' | 'max', ColumnOf<Row>>>
>;
/** A group's key: one of the table's own columns, or a date column's period. */
export type GroupKey<Row> = ColumnOf<Row> | Period<ColumnOf<Row>>;
type KeyName<K> = K extends Period<infer C> ? C : K;
/* `Row` is looked up, never tested: TypeScript relates two deferred conditionals only when what they test is identical,
   and measures `Row` invariant where it meets `keyof Row` there, either of which would make a typed table's answers
   unassignable to an untyped one's (a handler's `db` as BusinessCommandContext says it). */
type KeyValue<Row, K> = K extends Period ? string | number | null : Row[K & keyof Row];
/** What each measure answers, by its word: a least or greatest value keeps its column's type. */
type MeasureValues<Row, Column> = {
  count: number;
  /** An exact decimal string; a number over a float column. */
  sum: string | number;
  /** An exact decimal string (a decimal's places plus two, an integer's two); a number over a float column;
      PostgreSQL's own text over an unconstrained numeric. */
  avg: string | number | null;
  min: Row[Column & keyof Row] | null;
  max: Row[Column & keyof Row] | null;
};
/** An aggregate's answer: each measure by its name. */
export type Aggregated<Row, M extends AnyMeasures> = {
  readonly [N in keyof M]: MeasureValues<Row, M[N]['column']>[M[N]['measure']];
};
/** One group: its keys by their columns' names, then its measures. */
export type GroupRow<Row, K, M extends AnyMeasures> = {
  readonly [N in KeyName<K> & string]: KeyValue<Row, Extract<K, N | Period<N>>>;
} & Aggregated<Row, M>;
/** Groups, read when awaited. */
export interface Grouped<T> extends PromiseLike<T[]> {
  /** By a key's or a measure's name; the keys ascending when unsaid. */
  orderBy(name: keyof T & string, direction?: 'asc' | 'desc'): Grouped<T>;
  /** At most this many groups. Without it, more than 1,000 is refused rather than cut. */
  limit(count: number): Grouped<T>;
}
export interface GroupBy<Row, K> {
  aggregate<M extends AnyMeasures>(measures: M & Measures<Row>): Grouped<GroupRow<Row, K, M>>;
}
/** Where a page ends: the last row's values for each column of its order, plain data a caller keeps. */
export type Boundary = Readonly<Record<string, string | number | boolean>>;
export interface Page<Row> {
  readonly rows: Row[];
  /** The next page's `after`; absent on the last page. */
  readonly next?: Boundary;
}
export interface ReadTable<Row, R extends Reads = Reads> {
  /** The row with this key — a one-column key's value, or `{ column: value }` — or `not_found`. */
  get(key: string | number | Partial<Row>): Promise<Row>;
  /** The one row that matches, or undefined; several is the handler's mistake, not a refusal. */
  find(where: WhereInput<Row, R>): Promise<Row | undefined>;
  where(where?: WhereInput<Row, R>): Query<Row, R>;
  /** The query language with values, each quoted: ``where`make = ${make}` ``. */
  where(template: TemplateStringsArray, ...values: readonly (string | number | boolean)[]): Query<Row, R>;
  count(where?: WhereInput<Row, R>): Promise<number>;
  /**
   * The rows of one of this resource's segments (`segments: { open: 'status = open' }` on the App's resource): the
   * conditions the segment's name stands for, read through the same grants, field projection and row policy as any
   * other read here, and chained as a `where` is (`.where(…)`, `.orderBy`, `.limit`). A name the resource does not
   * have is refused, with the ones it has. A segment that names what a handler's `db` does not read (a rollup, a
   * path, `me`) is refused as such at the call.
   */
  segment(name: string): Query<Row, R>;
  /**
   * A file resource's file — its name, type, size and bytes — by its row as read here, or its key: read through the
   * same grants and row policy as `get`, so a row this command may not see is `not_found`, as is one with no file. A
   * file kept in a bucket is fetched whole; none is streamed. Held to the resource's `maxBytes` (a tenant's at most
   * 10 MB), and one command reads at most 50 MB of files in all. Only on a file resource the command reads.
   */
  readFile(row: Row | string | number): Promise<CommandFile>;
}
/**
 * The constants `now`, `today` and `me` from `@mistriwork/mistri/app`, written as an
 * action's `set` writes them (appStamps.ts): the moment or the App's day in the
 * column's own format, the actor's email on a text column, their row on a
 * reference to the people table (`auth.me`).
 */
type WriteConstant = { readonly auto: 'now' | 'today' | 'me' };
/** What a write may give a column: its value, or a constant the server works out as the write runs. */
export type Written<Row> = { readonly [C in keyof Row]?: Row[C] | WriteConstant };

/**
 * What a write tells besides its row: `words` its notices say (`{words.code}` in a notify title), never stored. A
 * word may be a `publicLink(view)`: the mail says it as the view's URL, and is not sent where it has none.
 */
export interface WriteOptions {
  readonly words?: Readonly<Record<string, string | { readonly view: string; toJSON(): string }>>;
}

export interface WriteTable<Row, Moves extends object = Readonly<Record<string, UntypedRow>>, R extends Reads = Reads> extends ReadTable<
  Row,
  R
> {
  /** The row as stored, its key and defaults included. */
  insert(values: Written<Row>, options?: WriteOptions): Promise<Row>;
  /** Writes `changes` guarded by the row's values for those columns, bumping its revision: the new row, or `stale_record`. */
  update(row: Row, changes: Written<Row>, options?: WriteOptions): Promise<Row>;
  /** Removes the row by its key, or `stale_record` when it is gone. */
  remove(row: Row): Promise<void>;
  /**
   * Many new rows, as stored, in the order given: one statement where the source can say it, each row through the
   * same grants, stamps, audit and history as `insert`. The rows of one call cannot refer to each other.
   */
  insertMany(rows: readonly Written<Row>[]): Promise<Row[]>;
  /**
   * The same `changes` to every row the where matches, each guarded as `update` guards it and its revision bumped:
   * one read, then one statement where the source can say it. The rows as written; `stale_record` when any moved
   * since the read, and nothing is written. More than 1,000 matches is refused rather than cut.
   */
  updateWhere(where: WhereInput<Row, R>, changes: Written<Row>): Promise<Row[]>;
  /**
   * A file resource's new row (`file: { content, name, type?, size? }`): the
   * bytes, name, type and size go in the columns the resource names, held to
   * an upload's rules — a name of at most 255 characters, the resource's
   * `maxBytes` (a tenant's at most 10 MB) — and `values` are the row's others
   * (the record it belongs to). The audit and history keep the file's name,
   * type and size, never its bytes. Only on a file resource the command writes.
   */
  insertFile(file: { readonly name: string; readonly type?: string; readonly data: Uint8Array }, values?: Written<Row>): Promise<Row>;
  /**
   * The file of this row (read as `readFile` reads it, and counted toward the same 50 MB) moved to a new row of `to`,
   * another file resource the command writes, with `values` its other columns, and this row removed: one
   * transaction, so a refusal keeps both as they were. The new row is held to `to`'s own rules, as `insertFile` holds
   * it; a file kept in a bucket is written under the new row's own key, and its old object is deleted once the
   * command has committed. The history reads as an insert there and a delete here.
   */
  moveFile<To extends keyof Moves & string>(row: Row | string | number, to: To, values?: Written<Moves[To]>): Promise<Moves[To]>;
}

/* ---------- the measures and periods a handler writes ---------- */

const made = new WeakSet<object>();
const measureOf = <W extends MeasureWord, C extends string | undefined>(measure: W, column: C): Measure<W, C> => {
  const value = Object.freeze({ measure, column });
  made.add(value);
  return value;
};
/** The rows; with a column, the rows where it is not empty. */
export function count(): Measure<'count', undefined>;
export function count<C extends string>(column: C): Measure<'count', C>;
export function count(column?: string): Measure<'count', string | undefined> {
  return measureOf('count', column);
}
/** A number column's total, exact, as a decimal string with the column's places. */
export const sum = <C extends string>(column: C): Measure<'sum', C> => measureOf('sum', column);
/** A number column's mean from its exact total and count, half to even, at the column's places plus two; null over no values. */
export const avg = <C extends string>(column: C): Measure<'avg', C> => measureOf('avg', column);
/** The least value, in the column's own type; null over no values. */
export const min = <C extends string>(column: C): Measure<'min', C> => measureOf('min', column);
/** The greatest value, in the column's own type; null over no values. */
export const max = <C extends string>(column: C): Measure<'max', C> => measureOf('max', column);

const periods = new WeakSet<object>();
const periodOf =
  (unit: DateUnit) =>
  <C extends string>(column: C): Period<C> => {
    const value = Object.freeze({ period: unit, column });
    periods.add(value);
    return value;
  };
/** A date or timestamp column cut to a period, as a group's key: `groupBy(period.month('posted_on'))`. */
export const period = Object.freeze({
  hour: periodOf('hour'),
  day: periodOf('day'),
  week: periodOf('week'),
  month: periodOf('month'),
  quarter: periodOf('quarter'),
  year: periodOf('year'),
  weekday: periodOf('weekday'),
});

/** A command's tables: read `R`, written `W`. */
export type CommandTables<Scope, R extends string, W extends string> = {
  readonly [T in R | W]: T extends W
    ? WriteTable<RowIn<Scope, T>, { readonly [To in W]: RowIn<Scope, To> }, { readonly [To in R | W]: RowIn<Scope, To> }>
    : ReadTable<RowIn<Scope, T>, { readonly [To in R | W]: RowIn<Scope, To> }>;
};
/** One table's row on a source: `RowOf<typeof lending, 'lead'>`. */
export type RowOf<Src, Table extends string> = RowIn<SourceTables<Src, Table>, LocalName<Table>>;
/**
 * Some of a source's tables, for a helper a handler passes its `db` to: `Tables` read-only, and `Writes`, where the
 * helper writes, as the handler's own handles are (`insert`, `update`, `remove`, …). A handler whose command reads
 * and writes at least these hands its `db` over as it is:
 * `function post(db: CommandDb<typeof ledger, 'account', 'entry'>, …)` reads `account` and writes `entry`.
 * Read-only, it also takes a loader's and an `initial`'s `db`.
 */
export type CommandDb<Src, Tables extends string, Writes extends string = never> = {
  readonly [T in Tables | Writes]: T extends Writes
    ? WriteTable<RowOf<Src, T>, { readonly [To in Writes]: RowOf<Src, To> }, { readonly [To in Tables | Writes]: RowOf<Src, To> }>
    : ReadTable<RowOf<Src, T>, { readonly [To in Tables | Writes]: RowOf<Src, To> }>;
};

/* ---------- the catalog ---------- */

/** One footprint table as the handle needs it: its key, each column's kind, and its metadata named locally. */
interface CommandTable {
  readonly name: string;
  readonly key: readonly string[];
  readonly kinds: Readonly<Record<string, ColumnKind>>;
  readonly meta: TableMeta;
  /** The tables its handle may ask about with `any`/`no`, and the references between them: exactly the tables the
      catalog declares (commandCatalog), so a child outside the declared reads is not a table there. */
  readonly declared?: { readonly tables: TableMeta[]; readonly foreignKeys: ForeignKey[] };
  /** The engine the table is read from: PostgreSQL's unconstrained numeric sums to exact text, SQLite's is a float. */
  readonly dialect?: string;
  /** The rollups and computed columns a command's `when` may judge it by (commandWhen.ts); its handler's where names
      the computed columns of the row's own columns too (servedComputed), never a rollup. */
  readonly derived?: CommandDerived;
  /** How the App says this table's columns to a person (commandSaying.ts): a refusal's words, never the handler's `db`. */
  readonly saying?: ColumnSaying;
  /** The App's zone (`ui.timezone`), where the catalog is a command's: the `now` its `when` and its handler's `where`
      are given is the instant a stamp records, and a date phrase reads this zone's wall clock from it, as a list does. */
  readonly zone?: string;
}
/** The footprint's tables by local name. */
export type CommandCatalog = Readonly<Record<string, CommandTable>>;

/** A command's catalog read in the App's zone (`CommandTable.zone`); unchanged where the App names none. */
export function zonedCatalog(catalog: CommandCatalog, zone: string | undefined): CommandCatalog {
  if (!zone) return catalog;
  return Object.freeze(Object.fromEntries(Object.entries(catalog).map(([name, table]) => [name, Object.freeze({ ...table, zone })])));
}

/** The catalog of a footprint, from the logical schema; undefined for a table it does not hold. */
export function commandCatalog(
  schema: DatabaseSchema,
  footprint: readonly string[],
  logical: (local: string) => string,
): CommandCatalog | undefined {
  const tables: Record<string, CommandTable> = {};
  const idOf = new Map<string, string>();
  for (const name of footprint) idOf.set(logical(name), name);
  const declared: { tables: TableMeta[]; foreignKeys: ForeignKey[] } = { tables: [], foreignKeys: [] };
  for (const name of footprint) {
    /* Named once, not once per table scanned: `logical` reads the App's
       sources each time, and every command's footprint is cataloged at
       startup, for every role that is granted it. */
    const id = logical(name);
    const meta = findTable(schema, id);
    if (!meta) return undefined;
    const renamed = Object.freeze({ ...meta, id: name, name, schema: '' });
    declared.tables.push(renamed);
    tables[name] = Object.freeze({
      name,
      declared,
      key: Object.freeze(meta.columns.filter((column) => column.primaryKey).map((column) => column.name)),
      kinds: Object.freeze(Object.fromEntries(meta.columns.map((column) => [column.name, columnKind(column.type)]))),
      meta: renamed,
      dialect: schema.dialect,
    });
  }
  /* The references among the declared tables, in their local names: a table's handle asks about no other. */
  for (const fk of schema.foreignKeys) {
    const from = idOf.get(fk.from.table);
    const to = idOf.get(fk.to.table);
    if (from !== undefined && to !== undefined)
      declared.foreignKeys.push({ ...fk, from: { ...fk.from, table: from }, to: { ...fk.to, table: to } });
  }
  return Object.freeze(tables);
}

/* ---------- wheres ---------- */

const DEFAULT_CAP = 1000;
/** Said with a call's refusal so the author finds the one way to raise it (up to the platform's most). */
const raised = (options: { readonly changeCap?: number }): string =>
  options.changeCap === undefined ? '; a command may raise that with maxChanges' : '';
/** What a handle's own wheres are compiled with (see compileWhere). */
const HANDLE = Object.freeze({ anyRows: true });
interface Compiled {
  readonly filter: Filter;
  readonly none: boolean;
  readonly orderBy: { column: string; direction: 'asc' | 'desc' }[];
  readonly limit?: number;
}
/* ---------- computed columns in a handler's where ---------- */

/** A computed column read as its column would be, so an operator object over it compiles as one over a column. */
const COMPUTED_COLUMN_TYPE: Readonly<Record<ComputedType, string>> = { boolean: 'boolean', number: 'numeric', date: 'date', text: 'text' };

/** The computed columns the table is served to this reader, where it is read through a command's catalog: none elsewhere. */
function computedOf(table: CommandTable): Readonly<Record<string, ComputedColumn>> | undefined {
  return table.derived?.parse.tables[0]?.computed ?? table.meta.computed;
}

/* A name said as a word of its own: never part of a longer word or a path. */
const nameIn = (text: string, name: string): boolean => new RegExp(`(?<![\\w.])${name}(?![\\w.])`).test(text);

/** Whether a where in the query language names one of the table's computed columns. */
function namesComputed(table: CommandTable, text: string): boolean {
  const declared = computedOf(table);
  return !!declared && Object.keys(declared).some((name) => !Object.hasOwn(table.kinds, name) && nameIn(text, name));
}

/**
 * The computed column as a handler's where writes it (`Filter.computed`): its expression with `today` and `now` this
 * read's, so the statement compares what a list shows. Only one of the row's own stored columns may be read, since
 * the statement writes the expression over this table and nothing joined; a column reading through a reference, a
 * rollup or `me` (which a handler is handed no one for) is refused by name, so the where never quietly reads less.
 */
function servedComputed(table: CommandTable, name: string, column: ComputedColumn, now: Date): { type: ComputedType; expr: ComputedNode } {
  for (const read of column.reads) {
    if (read.includes('.'))
      throw new Error(
        `${table.name}: "${name}" reads "${read}" through a reference, and a where reads a computed column of the row's own columns.`,
      );
    if (!Object.hasOwn(table.kinds, read))
      throw new Error(
        `${table.name}: "${name}" reads "${read}", which is not one of ${table.name}'s columns, and a where reads a computed column of them.`,
      );
  }
  if (readsMe(column.expr))
    throw new Error(`${table.name}: "${name}" says "me", and a handler's where is handed no one; write actor.email.`);
  const wall = zonedNow(table.zone, now);
  const today = `${wall.getFullYear()}-${String(wall.getMonth() + 1).padStart(2, '0')}-${String(wall.getDate()).padStart(2, '0')}`;
  return { type: column.type, expr: foldConstants(column.expr, { today, now: now.toISOString(), me: null }) };
}

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw);

/* A template's values are always quoted, whatever they look like: the word
   `or` from a form is a value, never the language's `or`. */
function quoted(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  throw new TypeError('A where template takes text, numbers and booleans; for an empty value write "is empty".');
}

/**
 * A where as a filter over one table. Errors are the handler's: they name the table and the problem. `me` is
 * the actor where a command's `when` is judged (commandWhen.ts); a handler's own where is handed none, so `me`
 * there is refused — it writes `actor.email` instead.
 */
export function compileWhere(
  table: CommandTable,
  where: unknown,
  now: Date,
  values: readonly unknown[] = [],
  me?: QueryPerson,
  /** `columnValues` admits a column on a condition's right (`qty < reorder_at`): only for a `when`, which commandWhen.ts
      judges once the row is read. `anyRows` admits `any`/`no` over a declared child: only for a handle's `db`, whose reads
      reach the child through the same transaction (compileAnyWhere); everywhere else one is refused as it always was. */
  options: { columnValues?: boolean; anyRows?: boolean } = {},
): Compiled {
  if (where === undefined) return { filter: { groups: [] }, none: false, orderBy: [] };
  if (typeof where === 'string' || isTemplate(where)) {
    const text =
      typeof where === 'string'
        ? where
        : where.reduce((out, part, index) => out + part + (index < values.length ? quoted(values[index]) : ''), '');
    if (options.anyRows && (anyConditions(splitClauseTail(text).head).length || namesComputed(table, text)))
      return compileAnyWhere(table, text, now);
    const schema: DatabaseSchema = { label: table.name, dialect: 'sqlite', tables: [table.meta], foreignKeys: [], readAt: '' };
    const { query, errors } = parseQuery(`${table.name} ${text}`, {
      schema,
      now: zonedNow(table.zone, now),
      ...(me ? { me } : {}),
      ...(options.columnValues ? { columnValues: true } : {}),
    });
    if (!query || errors.length)
      throw new Error(`${table.name}: ${errors.map((error) => error.message).join(' ') || 'the where could not be read.'}`);
    if (query.columns.length) throw new Error(`${table.name}: a where names rows, not columns; leave out "show".`);
    return { filter: query.filter, none: false, orderBy: query.orderBy, ...(query.limit === undefined ? {} : { limit: query.limit }) };
  }
  if (!where || typeof where !== 'object' || Array.isArray(where))
    throw new TypeError(`${table.name}: a where is an object or the query language.`);
  /* A computed column is no column of the row: a handler's db reads it as its expression (servedComputed); a `when`
     and every other where are judged by the row's stored columns, so one named there is refused, as a path is. */
  const declared = computedOf(table);
  const computedKeys = declared ? Object.keys(where).filter((key) => Object.hasOwn(declared, key) && !Object.hasOwn(table.kinds, key)) : [];
  if (computedKeys.length && !options.anyRows)
    throw new Error(`${table.name}: "${computedKeys[0]}" is a computed column, which a where names only in a handler's db.`);
  /* A column tested against another table's rows (`customer_id: { in: { from: 'customer', where } }`) is carried as a
     condition of its own (`Condition.within`); the rest of the where is read as it would be without it. A path through
     a reference (`'customer_id.region': 'west'`) is that same test, written from the row's side. */
  const within: [string, InRowsValue][] = Object.entries(where).filter((entry): entry is [string, InRowsValue] => isInRows(entry[1]));
  const paths = Object.keys(where).filter((key) => key.includes('.'));
  if (within.length || paths.length) {
    if (!options.anyRows) {
      const said = within.length ? `"${within[0][0]}: { in: … }"` : `"${paths[0]}"`;
      throw new Error(`${table.name}: ${said} reads another table's rows, which only a handler's db reads.`);
    }
    within.push(...referencePaths(table, where as Record<string, unknown>, paths));
    const rest = compileWhere(
      table,
      Object.fromEntries(Object.entries(where).filter(([key, value]) => !isInRows(value) && !key.includes('.'))),
      now,
      [],
      me,
      options,
    );
    const tests = within.map(([column, value]) => compileInRows(table, column, value, now));
    if (rest.none || tests.some((test) => test === undefined)) return { filter: { groups: [] }, none: true, orderBy: [] };
    const added = tests as Condition[];
    return {
      ...rest,
      filter: { ...rest.filter, groups: rest.filter.groups.length ? rest.filter.groups.map((group) => [...group, ...added]) : [added] },
    };
  }
  /* An operator object is the page-side condition (engine/shared/pageWhere.ts), compiled by the one compiler into the
     language's text and read as text is: one vocabulary, the same refusals. A computed column's key goes the same way,
     typed as its column would be, so its text is read where the computed columns are names (compileAnyWhere). */
  if (computedKeys.length || Object.values(where).some((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) {
    // An empty list matches nothing here too, as it does without an operator beside it; the rest is still read first,
    // so a column or operator that is not there is refused all the same.
    const empty = Object.entries(where).filter(([, value]) => Array.isArray(value) && !value.length);
    const meta = computedKeys.length
      ? {
          ...table.meta,
          columns: [
            ...table.meta.columns,
            ...computedKeys.map((name) => ({ name, type: COMPUTED_COLUMN_TYPE[declared![name].type], nullable: true, primaryKey: false })),
          ],
        }
      : table.meta;
    const compiled = compilePageWhere(
      empty.length ? Object.fromEntries(Object.entries(where).filter(([, value]) => !(Array.isArray(value) && !value.length))) : where,
      meta,
    );
    if ('error' in compiled) throw new Error(`${table.name}: ${compiled.error}`);
    for (const [column] of empty)
      if (!Object.hasOwn(table.kinds, column) && !computedKeys.includes(column))
        throw new Error(`${table.name}: "${column}" is not one of its columns.`);
    if (empty.length) return { filter: { groups: [] }, none: true, orderBy: [] };
    return compileWhere(table, compiled.text, now, [], me, options);
  }
  const conditions: Condition[] = [];
  let none = false;
  for (const [column, value] of Object.entries(where)) {
    if (!Object.hasOwn(table.kinds, column)) throw new Error(`${table.name}: "${column}" is not one of its columns.`);
    if (value === null) conditions.push({ column, op: 'isNull' });
    else if (Array.isArray(value)) {
      if (!value.length) none = true;
      else conditions.push({ column, op: 'in', value: value.map((item) => scalar(table, column, item)) as Array<string | number> });
    } else if (value !== undefined) conditions.push({ column, op: '=', value: scalar(table, column, value) });
  }
  return { filter: { groups: conditions.length ? [conditions] : [] }, none, orderBy: [] };
}

type InRowsValue = { readonly in: unknown };

/**
 * The paths of a where (`'customer_id.region': 'west'`) as the `in` each reference's columns make: one test per
 * reference, its columns judged together (`customer_id: { in: { from: 'customer', where: { region: 'west' } } }`). The
 * reference must be one of this table's to a table the handle reads, by its one key column, as an `in` selects it.
 */
function referencePaths(table: CommandTable, where: Record<string, unknown>, paths: readonly string[]): [string, InRowsValue][] {
  const by = new Map<string, Record<string, unknown>>();
  for (const path of paths) {
    const dot = path.indexOf('.');
    const column = path.slice(0, dot);
    const rest = path.slice(dot + 1);
    if (!column || !rest) throw new Error(`${table.name}: "${path}" is not a path; write it reference.column.`);
    if (rest.includes('.'))
      throw new Error(
        `${table.name}: "${path}" crosses more than one reference; a where's path crosses one, so read the rows between first.`,
      );
    let inner = by.get(column);
    if (!inner) by.set(column, (inner = {}));
    inner[rest] = where[path];
  }
  return [...by].map(([column, inner]) => {
    if (!Object.hasOwn(table.kinds, column)) throw new Error(`${table.name}: "${column}" is not one of its columns.`);
    const fk = table.declared?.foreignKeys.find(
      (key) => key.from.table === table.name && key.from.columns.length === 1 && key.from.columns[0] === column,
    );
    const reads = table.declared?.tables.map((each) => each.name) ?? [table.name];
    if (!fk)
      throw new Error(
        `${table.name}: "${column}.…" follows "${column}", which is not a reference to a table this handle reads (${reads.join(', ')}); declare the table it points at in read or write.`,
      );
    const target = table.declared!.tables.find((each) => each.name === fk.to.table);
    const key = target?.columns.filter((each) => each.primaryKey) ?? [];
    if (key.length !== 1 || key[0].name !== fk.to.columns[0])
      throw new Error(
        `${table.name}: "${column}.…" points at ${fk.to.table} by a column that is not its one key; read ${fk.to.table} first.`,
      );
    return [column, { in: { from: fk.to.table, where: inner } }];
  });
}
/* Any object naming `in` is the test, so a malformed one is refused as such rather than read as an operator. */
const isInRows = (value: unknown): value is InRowsValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'in');

/**
 * `column: { in: { from, where } }`: the column's value is the key of one of `from`'s rows that `where` matches. The
 * table must be one the handle declares, read as a direct read of it is — the same transaction, scope, row policy and
 * narrowing (the executor writes it as `column IN (SELECT key FROM from WHERE …)`). Its `where` judges that table's own
 * columns, one level down: another `in` there is refused by name. Undefined when the where matches no row at all.
 */
function compileInRows(table: CommandTable, column: string, value: InRowsValue, now: Date): Condition | undefined {
  if (!Object.hasOwn(table.kinds, column)) throw new Error(`${table.name}: "${column}" is not one of its columns.`);
  const test = value.in as { from?: unknown; where?: unknown } | null;
  const said = `"${column}: { in: … }"`;
  if (
    Object.keys(value).length !== 1 ||
    !test ||
    typeof test !== 'object' ||
    Array.isArray(test) ||
    Object.keys(test).some((key) => key !== 'from' && key !== 'where') ||
    typeof test.from !== 'string'
  )
    throw new Error(`${table.name}: ${said} is written { in: { from: 'table', where: { … } } } and stands alone.`);
  const from = test.from;
  const reads = table.declared?.tables.map((each) => each.name) ?? [table.name];
  const other = table.declared?.tables.find((each) => each.name === from);
  if (!other)
    throw new Error(
      `${table.name}: "${column}: { in: { from: '${from}' } }" reads ${from}, which is not among the tables this handle reads (${reads.join(', ')}); declare it in read or write.`,
    );
  const key = other.columns.filter((each) => each.primaryKey);
  if (key.length !== 1) throw new Error(`${table.name}: ${said} selects ${from}'s key, and ${from} has no key of exactly one column.`);
  if (test.where === null || typeof test.where !== 'object' || Array.isArray(test.where))
    throw new Error(`${table.name}: ${said} judges ${from}'s rows by an object where ({ column: value }).`);
  for (const [inner, given] of Object.entries(test.where))
    if (isInRows(given))
      throw new Error(`${table.name}: ${said} reads one level; "${inner}: { in: … }" inside it is refused, so read ${from}'s rows first.`);
  const rows: CommandTable = {
    name: from,
    key: [key[0].name],
    kinds: Object.fromEntries(other.columns.map((each) => [each.name, columnKind(each.type)])),
    meta: other,
    ...(table.zone ? { zone: table.zone } : {}),
  };
  const compiled = compileWhere(rows, test.where, now);
  if (compiled.none) return undefined;
  return { column, op: 'in', within: { table: from, ...(compiled.filter.groups.length ? { filter: compiled.filter } : {}) } };
}

/**
 * A where that asks about the rows pointing at this one (`any line where qty > 5`, `no payment`), read against the
 * tables the handle declares and no others: the child must be one of them, or the where is refused by name. The
 * test is carried as a condition (`Condition.any`) and written as an EXISTS where the read is executed, over the
 * child's own table, read as this table is — by the same transaction, under the same scope or none. A reference path
 * (`customer_id.name`) stays refused here, in the child's conditions too.
 */
function compileAnyWhere(table: CommandTable, text: string, now: Date): Compiled {
  const world = table.declared;
  const reads = world?.tables.map((each) => each.name) ?? [table.name];
  const { head } = splitClauseTail(text);
  for (const found of anyConditions(head)) {
    const [, word, child] = ANY_CONDITION.exec(found.text) ?? [];
    if (child !== undefined && !reads.some((read) => read === child))
      throw new Error(
        `${table.name}: "${word} ${child}" asks about ${child}, which is not among the tables this handle reads (${reads.join(', ')}); declare it in read or write.`,
      );
  }
  /* The language reads this table's computed columns as names (each written as its expression, servedComputed) and
     no other table's, nor any rollup: a child's conditions read its stored columns, as its EXISTS writes them. */
  const declared = computedOf(table);
  const computed = Object.fromEntries(Object.entries(declared ?? {}).filter(([name]) => !Object.hasOwn(table.kinds, name)));
  const bare = (meta: TableMeta): TableMeta => {
    const { rollups: _rollups, computed: _computed, ...rest } = meta;
    return meta.name === table.name && Object.keys(computed).length ? { ...rest, computed } : rest;
  };
  const schema: DatabaseSchema = {
    label: table.name,
    dialect: 'sqlite',
    tables: (world?.tables ?? [table.meta]).map(bare),
    foreignKeys: world?.foreignKeys ?? [],
    readAt: '',
  };
  const parsed = parseViewQuery(schema, table.name, text, zonedNow(table.zone, now), { columnValues: false });
  if (parsed.errors.length) throw new Error(`${table.name}: ${parsed.errors.map((error) => error.message).join(' ')}`);
  if (parsed.columns.length) throw new Error(`${table.name}: a where names rows, not columns; leave out "show".`);
  /* A path is a column of another table, which the child's conditions and these do not read. */
  const own = (path: string): string => {
    if (path.includes('.'))
      throw new Error(`${table.name}: "${path}" is a path, and a condition here reads only ${table.name}'s own columns.`);
    return path;
  };
  const used: Record<string, { type: ComputedType; expr: ComputedNode }> = {};
  const isComputed = (name: string): boolean => Object.hasOwn(computed, name);
  const inner = (filter: Filter | undefined): void => {
    for (const group of filter?.groups ?? [])
      for (const c of group)
        if (isComputed(own(c.column)))
          throw new Error(`${table.name}: "${c.column}" is a computed column, which a where names of the row it reads, not inside "any".`);
  };
  /* A condition on a computed column: its expression goes with the filter, the condition names it. Compared with a
     value only; one compared with another column, or set in order, is refused rather than read some other way. */
  const condition = (path: string): string => {
    if (!isComputed(own(path))) return path;
    used[path] ??= servedComputed(table, path, computed[path], now);
    return path;
  };
  const compared = (path: string, other: string): string => {
    if (isComputed(path) || isComputed(own(other)))
      throw new Error(`${table.name}: a computed column in a where is compared with a value, not with another column.`);
    return other;
  };
  const groups = parsed.filter.groups.map((group) =>
    group.map((c): Condition => {
      if (c.any) {
        inner(c.any.filter);
        return { column: c.path, op: c.op, any: c.any };
      }
      return {
        column: condition(c.path),
        op: c.op,
        ...(c.value === undefined ? {} : { value: c.value }),
        ...(c.collation ? { collation: c.collation } : {}),
        ...(c.other === undefined ? {} : { other: compared(c.path, c.other) }),
      };
    }),
  );
  return {
    filter: { groups, ...(Object.keys(used).length ? { computed: used } : {}) },
    none: false,
    orderBy: parsed.orderBy.map((order) => {
      if (isComputed(own(order.path)))
        throw new Error(`${table.name}: "${order.path}" is a computed column, and a handler's read is ordered by its columns.`);
      return { column: order.path, direction: order.direction };
    }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
  };
}

function scalar(table: CommandTable, column: string, value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError(`${table.name}.${column}: a where compares text, numbers and booleans.`);
}

/** The filter naming one row by its key. */
export const keyFilter = (key: Readonly<Record<string, string | number>>): Filter => ({
  groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))],
});

/**
 * A key as a request or a handler spells it, made exact: an integer column
 * takes a safe integer or its canonical digits (an id past 2^53 stays its
 * digits and is never rounded into another row); `'01'`, `'1e0'` and `' 1'`
 * name no row. Undefined when the spelling names none.
 */
export function canonicalKey(
  table: Pick<CommandTable, 'key' | 'kinds'>,
  key: Readonly<Record<string, unknown>>,
): Record<string, string | number> | undefined {
  const exact: Record<string, string | number> = {};
  for (const column of table.key) {
    const value = key[column];
    if (table.kinds[column] === 'number') {
      if (typeof value === 'number' && Number.isSafeInteger(value)) exact[column] = value;
      else if (typeof value === 'string' && /^(0|-?[1-9][0-9]{0,39})$/.test(value))
        exact[column] = Number.isSafeInteger(Number(value)) ? Number(value) : value;
      else return undefined;
    } else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) exact[column] = value;
    else return undefined;
  }
  return exact;
}

/** A row as the handle hands it out: a boolean column reads true or false on every engine; frozen. */
export function normalizeRow(table: CommandTable, row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const copy: Record<string, unknown> = { ...row };
  for (const [column, kind] of Object.entries(table.kinds)) {
    if (kind === 'boolean' && (copy[column] === 0 || copy[column] === 1)) copy[column] = copy[column] === 1;
  }
  /* A JSON column reads as its value on every engine: node-pg parses jsonb,
     SQLite hands back the text. */
  for (const column of table.meta.columns) {
    if (!isJsonType(column.type) || typeof copy[column.name] !== 'string') continue;
    try {
      copy[column.name] = JSON.parse(copy[column.name] as string);
    } catch {
      // Text that is not JSON stays the text it is.
    }
  }
  return Object.freeze(copy);
}

/* ---------- sums, groups and pages: the work ---------- */

/** The most groups `.limit(n)` asks for, and the most rows `iterate` reads in one command: the reads' own ceiling. */
const MOST_ROWS = 100_000;
/** The page `iterate` asks for after `read` rows: never more than the bound leaves, so the walk never yields past it. */
export const iterateSize = (size: unknown, read: number, bound: number = MOST_ROWS): unknown =>
  typeof size === 'number' && Number.isSafeInteger(size) && size >= 1 ? Math.min(size, Math.max(bound - read, 1)) : size;
/** The largest page. */
const MOST_PAGE = 1000;
const MEASURE_WORDS: readonly MeasureWord[] = ['count', 'sum', 'avg', 'min', 'max'];
const PERIODS: readonly DateUnit[] = ['hour', 'day', 'week', 'month', 'quarter', 'year', 'weekday'];
const ANSWER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
/* Types whose total or order the engine does not keep exact: money comes back formatted, JSON and bytes not as compared. */
const NOT_SUMMED = /money|json|xml|bytea|blob|binary|interval|array|\[\]/i;

/* A handler's misuse of its handle: refused, and told to the operator first as the App author's to fix
   (refusal.ts authorFault); the caller hears the fixed sentence. */
function authorMistake(message: string): never {
  throw authorFault(new BusinessCommandExecutionError('invalid_result'), message);
}

/* A write's words for its notices: a few short named texts, said once and kept nowhere but sealed on their way. */
const WORD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
function wordsOf(name: string, written: WriteOptions | undefined): Readonly<Record<string, string>> | undefined {
  const words = (written as { words?: unknown } | undefined)?.words;
  if (words === undefined) return undefined;
  if (typeof words !== 'object' || words === null || Array.isArray(words)) authorMistake(`${name}: words is an object of named texts.`);
  const entries = Object.entries(words);
  if (entries.length > 20) authorMistake(`${name}: a write gives its notices at most 20 words.`);
  const said = entries.map(([word, text]) => [word, text instanceof PublicLinkRef ? text.toJSON() : text] as const);
  for (const [word, text] of said)
    if (!WORD_NAME.test(word) || typeof text !== 'string' || text.length > 2000)
      authorMistake(`${name}: words.${word.slice(0, 64)} is a name and a text of at most 2,000 characters.`);
  return Object.freeze(Object.fromEntries(said)) as Readonly<Record<string, string>>;
}

/* The places a column holds: PostgreSQL's catalog says them beside the type, SQLite's type string says them itself. */
const placesOf = (column: ColumnMeta): number => column.scale ?? declaredScale(column.type);

/* How a number column is added and said. A decimal with places is exact text; an integer is exact text too (past
   2^53 it is digits, never a rounded number); a float (REAL, double precision, SQLite's NUMERIC with no places) has
   no exact digits to say, so its sum and mean are numbers; PostgreSQL's unconstrained numeric is exact, and its
   own text is what it answers. */
type NumberClass = 'decimal' | 'integer' | 'float' | 'numeric';
function numberClass(table: CommandTable, column: ColumnMeta): NumberClass {
  if (placesOf(column) > 0) return 'decimal';
  if (column.scale === 0 || /int|serial/i.test(column.type) || /^\s*(?:decimal|numeric)\s*\(/i.test(column.type)) return 'integer';
  if (table.dialect === 'postgres' && /^\s*(?:decimal|numeric)\s*$/i.test(column.type)) return 'numeric';
  return 'float';
}

/* A float's digits without an exponent: 1e-7 is 0.0000001, so a total parses as a decimal. */
function plainNumber(value: number): string {
  if (Number.isInteger(value)) return BigInt(value).toString();
  const text = String(value);
  return /e/i.test(text) ? value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : text;
}

/* A total as a decimal string with at least `scale` places, zero over no rows; undefined for a value that is not a
   number. Never through Number(): a PostgreSQL numeric or bigint arrives as its exact text and stays it. */
function decimalText(value: unknown, scale: number): string | undefined {
  if (value === null || value === undefined) return formatDecimal(0n, scale);
  const parsed =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? parseDecimal(plainNumber(value))
        : undefined
      : typeof value === 'string' || typeof value === 'bigint'
        ? parseDecimal(value)
        : undefined;
  if (!parsed) return undefined;
  const places = Math.max(scale, parsed.scale);
  return formatDecimal(parsed.units * 10n ** BigInt(places - parsed.scale), places);
}

/* A count as a number: PostgreSQL reads count(*) as bigint text. */
const countOf = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : 0;

/* A column's value as a row read through the handle says it: a boolean true or false, a decimal with its places
   (SQLite reads an expression's MIN as a bare number; a row's column comes back scaled, sqliteDecimals.ts). */
function columnValue(column: ColumnMeta, kind: ColumnKind | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (kind === 'boolean' && (value === 0 || value === 1)) return value === 1;
  const scale = placesOf(column);
  if (scale > 0 && typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e21) return value.toFixed(scale);
  /* toFixed spells a double's exact digits to 1e21 (String() would round them at 1e15); text and bigints are the database's own. */
  if (scale > 0 && (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint'))
    return decimalText(value, scale) ?? value;
  return value;
}

interface AggregatePlan {
  readonly by: NonNullable<AggregateRequest['by']>;
  /** The measures asked of the engine; an `avg` ordered by asks for the engine's own mean too, for the order alone. */
  measures(ordered: ReadonlySet<string>): AggregateMeasure[];
  /** An answer's name as the statement orders it. */
  orderName(name: string): string;
  decode(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

/*
 * What a handler's keys and measures ask, checked against the table's own columns before anything is read: a
 * measure is a word and one of this table's columns, a key a column or a date column's period. Read
 * structurally, not by identity, since a handler may import a second copy of this module (commandErrors.ts).
 */
function planAggregate(table: CommandTable, keys: readonly unknown[], given: unknown): AggregatePlan {
  const name = table.name;
  const column = (value: unknown, what: string): ColumnMeta => {
    const meta =
      typeof value === 'string' && Object.hasOwn(table.kinds, value) ? table.meta.columns.find((c) => c.name === value) : undefined;
    return meta ?? authorMistake(`${name}: ${what} names one of its own columns; "${String(value).slice(0, 80)}" is not one.`);
  };
  if (keys.length > 3) authorMistake(`${name}: groupBy takes at most 3 keys.`);
  const answers = new Set<string>();
  /* A key answers under its column's own name, whatever it is (the statement aliases it `k0`); a measure's name is the
     handler's own and keeps to a plain identifier. Neither may be a name that reaches an object's prototype. */
  const answer = (value: string, what: string, ownColumn = false) => {
    if ((!ownColumn && !ANSWER_NAME.test(value)) || FORBIDDEN_ANSWER_NAMES.has(value) || answers.has(value))
      authorMistake(`${name}: each key and measure answers under its own name; ${what} "${value.slice(0, 80)}" does not.`);
    answers.add(value);
  };
  const by = keys.map((key, at) => {
    if (typeof key === 'string') {
      const meta = column(key, 'groupBy');
      answer(meta.name, 'the key', true);
      return { name: `k${at}`, answer: meta.name, meta, bucket: undefined };
    }
    const cut = key as Partial<Period> | null;
    if (!cut || typeof cut !== 'object' || !PERIODS.includes(cut.period as DateUnit))
      return authorMistake(`${name}: groupBy takes a column, or a period of one (period.month('posted_on')).`);
    const meta = column(cut.column, `period.${cut.period}`);
    if (table.kinds[meta.name] !== 'date')
      authorMistake(`${name}: period.${cut.period} cuts a date or time column; "${meta.name}" is not one.`);
    answer(meta.name, 'the key', true);
    return { name: `k${at}`, answer: meta.name, meta, bucket: cut.period as DateUnit };
  });
  if (!given || typeof given !== 'object' || Array.isArray(given))
    authorMistake(`${name}: aggregate takes its measures by name, { entries: count(), posted: sum('amount') }.`);
  const asked = Object.entries(given as Record<string, unknown>);
  if (!asked.length || asked.length > 32) authorMistake(`${name}: aggregate takes 1 to 32 measures.`);
  const measures = asked.map(([said, value], at) => {
    answer(said, 'the measure');
    const measure = value as Partial<Measure> | null;
    if (!measure || typeof measure !== 'object' || !MEASURE_WORDS.includes(measure.measure as MeasureWord))
      return authorMistake(`${name}: "${said}" is a measure made by count(), sum(), avg(), min() or max().`);
    const word = measure.measure as MeasureWord;
    if (word === 'count' && measure.column === undefined) return { said, word, at, meta: undefined, kind: undefined, numbers: undefined };
    const meta = column(measure.column, `${word}()`);
    const kind = table.kinds[meta.name];
    if ((word === 'sum' || word === 'avg') && (kind !== 'number' || NOT_SUMMED.test(meta.type)))
      authorMistake(`${name}: ${word}("${meta.name}") adds a number column, and "${meta.name}" is ${meta.type || 'not one'}.`);
    if ((word === 'min' || word === 'max') && (kind === 'other' || NOT_SUMMED.test(meta.type)))
      authorMistake(`${name}: ${word}("${meta.name}") compares values, and a ${meta.type} column's are not compared as stored.`);
    return { said, word, at, meta, kind, numbers: meta && (word === 'sum' || word === 'avg') ? numberClass(table, meta) : undefined };
  });
  const orderNames = new Map<string, string>([
    ...by.map((key) => [key.answer, key.name] as const),
    ...measures.map((measure) => [measure.said, measure.word === 'avg' ? `m${measure.at}a` : `m${measure.at}`] as const),
  ]);
  return {
    by: by.map((key) => ({ name: key.name, column: key.meta.name, ...(key.bucket ? { bucket: key.bucket } : {}) })),
    measures: (ordered) =>
      measures.flatMap((measure): AggregateMeasure[] => {
        const id = `m${measure.at}`;
        const column = measure.meta ? { column: measure.meta.name } : {};
        if (measure.word !== 'avg') return [{ name: id, fn: measure.word, ...column }];
        /* A float's mean, and PostgreSQL's unconstrained numeric's, is the engine's own: no places to divide to. */
        if (measure.numbers === 'float' || measure.numbers === 'numeric') return [{ name: `${id}a`, fn: 'avg' as const, ...column }];
        /* An exact mean is its exact total over its count, divided here; the engine's own AVG (a float, rounded
           differently on each engine) is asked only to order by, never answered. */
        return [
          { name: `${id}s`, fn: 'sum', ...column },
          { name: `${id}n`, fn: 'count', ...column },
          ...(ordered.has(`${id}a`) ? [{ name: `${id}a`, fn: 'avg' as const, ...column }] : []),
        ];
      }),
    orderName: (said) =>
      orderNames.get(said) ?? authorMistake(`${name}: groups order by one of their keys or measures, not "${said.slice(0, 80)}".`),
    decode: (row) => {
      const out: Record<string, unknown> = {};
      for (const key of by)
        out[key.answer] = key.bucket ? (row[key.name] ?? null) : columnValue(key.meta, table.kinds[key.meta.name], row[key.name]);
      for (const measure of measures) {
        const id = `m${measure.at}`;
        const scale = measure.meta ? placesOf(measure.meta) : 0;
        if (measure.word === 'count') out[measure.said] = countOf(row[id]);
        else if (measure.word === 'sum' && measure.numbers === 'float' && (typeof row[id] === 'number' || row[id] == null))
          out[measure.said] = row[id] ?? 0;
        else if (measure.word === 'sum')
          out[measure.said] =
            decimalText(row[id], scale) ?? authorMistake(`${name}: the total of "${measure.meta!.name}" is not a number.`);
        else if (measure.word === 'avg' && (measure.numbers === 'float' || measure.numbers === 'numeric')) {
          const mean = row[`${id}a`];
          out[measure.said] =
            mean === null || mean === undefined
              ? null
              : typeof mean === 'number' || typeof mean === 'string'
                ? mean
                : authorMistake(`${name}: the mean of "${measure.meta!.name}" is not a number.`);
        } else if (measure.word === 'avg') {
          const n = countOf(row[`${id}n`]);
          const total =
            decimalText(row[`${id}s`], scale) ?? authorMistake(`${name}: the total of "${measure.meta!.name}" is not a number.`);
          out[measure.said] = n > 0 ? exactAverage(total, n, scale + 2)! : null;
        } else out[measure.said] = columnValue(measure.meta!, measure.kind, row[id]);
      }
      return Object.freeze(out);
    },
  };
}

/* ---------- the handle ---------- */

type Reader = Pick<WriteTransaction, 'query' | 'count' | 'aggregate'>;
interface CommandDbOptions {
  readonly tx: Reader | WriteTransaction;
  readonly catalog: CommandCatalog;
  readonly read: readonly string[];
  /** Tables with insert, update and remove. Empty for a read-only handle. */
  readonly write: readonly string[];
  /** The revision column `update` bumps on any table that has it. */
  readonly versionField?: string;
  /** A conflict on this table's row names the row's key. */
  readonly target?: string;
  /** The command's `maxChanges`: the most rows one insertMany or updateWhere takes; absent, DEFAULT_CAP. */
  readonly changeCap?: number;
  readonly now: () => Date;
  /** The file resources among `write`, by local name: their rows take bytes through `insertFile`. */
  readonly files?: ReadonlyMap<string, AppFileRule>;
  /** The file resources among `read` and `write`, by local name: what `readFile` reads, and the most one hands over. */
  readonly fileReads?: ReadonlyMap<string, AppFileRule>;
  /** Whose bucket objects a row read here may name: the command's App, and its tenant (files/fileStorage.ts). */
  readonly fileScope?: FileScope;
  /** Puts a new file's bytes in its resource's bucket before the row is written, and gives the row's values naming
      the object (files/fileStorage.ts); the caller deletes the object if the transaction rolls back. */
  /** Work to start once the command has committed (a public picture's pre-made copies); never run on a rollback. */
  readonly afterCommit?: (run: () => void) => void;
  readonly placeFile?: (rule: AppFileRule, values: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Told of each file insertFile stored, by its table and the bytes it was given (a held file must be one). */
  readonly stored?: (table: string, data: Uint8Array) => void;
  /** What a constant (`now`, `today`, `me`) writes to a column; absent, a constant is refused. */
  readonly constant?: (table: CommandTable, column: ColumnMeta, word: WriteConstant['auto']) => Promise<Value>;
  /** The file bytes this run read before its handler (its lookup's `files.read` and `readFile`): readFile's budget starts there. */
  readonly fileRead?: number;
  /** The App's `choose`, as this request proved it (app/appChoices.ts): what `chosen.<name>` in a where reads. */
  readonly chosen?: Readonly<Record<string, string | number | null>>;
  /** The computed columns and rollups each table's `.with` may ask for, by local table name: a loader's declared reads. */
  readonly derived?: Readonly<Record<string, readonly string[]>>;
  /** Reads rows with those names beside them, in one statement (pageLoaderRun.ts); absent, `.with` is refused. */
  readonly readDerived?: (request: {
    readonly table: string;
    readonly names: readonly string[];
    readonly filter: Filter;
    readonly orderBy: readonly { column: string; direction: 'asc' | 'desc' }[];
    readonly limit: number;
  }) => Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
}

const isConstant = (value: unknown): value is WriteConstant =>
  !!value &&
  typeof value === 'object' &&
  Object.keys(value).length === 1 &&
  ['now', 'today', 'me'].includes((value as { auto?: unknown }).auto as string);

/* Each constant replaced by what it means now, in its column's format; the rest as given. */
async function withConstants(
  table: CommandTable,
  values: Record<string, unknown>,
  options: CommandDbOptions,
): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> | undefined;
  for (const [column, value] of Object.entries(values)) {
    if (!isConstant(value)) continue;
    const meta = table.meta.columns.find((candidate) => candidate.name === column);
    if (!meta) throw new Error(`${table.name}: "${column}" is not one of its columns.`);
    if (!options.constant) throw new Error(`${table.name}: "${column}" is ${value.auto}, which this handle cannot write.`);
    out ??= { ...values };
    out[column] = await options.constant(table, meta, value.auto);
  }
  return out ?? values;
}

/** The most file bytes one command reads, all its reads together: its lookup's `files.read` and
    `sources.<source>.<file>.readFile`, and its handler's `readFile` (`fileRead` starts the handler where the lookup
    stopped). A loop over rows that reads each one's file
    is refused here rather than filling the server's memory. A fixed bound, not a setting. */
export const COMMAND_FILE_READ_MOST = 50 * 1024 * 1024;

const sizeOf = (bytes: number) => `${Math.ceil((bytes / 1024 / 1024) * 10) / 10} MB`;

/** What one command run has read so far, across all its handles: its lookup's and its handler's. */
export interface FileReadBudget {
  read: number;
}

/**
 * One row's kept file (http/fileRows.ts), read through `reader`: the handler's transaction for `db.<file>.readFile`,
 * the lookup's scoped reader for `sources.<source>.<file>.readFile`, so its grants, row policy and tenant are that
 * reader's and the row is located there before any object is opened. The object's key is the row's, never the
 * caller's, and a row naming an object outside this App, tenant and resource reads as no file at all. Held to the
 * resource's maxBytes and to what this run may still read of its one budget.
 */
export async function readKeptFile(
  reader: Pick<WriteTransaction, 'query'>,
  options: Readonly<{
    name: string;
    verb: string;
    /** Where a row it takes was read, for the words when it is given neither a row nor a key. */
    via: string;
    table: CommandTable;
    rule: AppFileRule;
    scope: FileScope | undefined;
    budget: FileReadBudget;
  }>,
  given: unknown,
) {
  const { name, verb, table, rule, budget } = options;
  const keyOf = (row: Record<string, unknown>) => {
    const key = table.key.length ? canonicalKey(table, row) : undefined;
    if (!key) throw new Error(`${name}: the row carries no key; pass a row read through ${options.via}.`);
    return key;
  };
  const key =
    given !== null && typeof given === 'object'
      ? keyOf(given as Record<string, unknown>)
      : (typeof given === 'string' || typeof given === 'number') && table.key.length === 1
        ? (canonicalKey(table, { [table.key[0]]: given }) ?? refuse('not_found'))
        : authorMistake(`${name}: ${verb} takes a row read through ${options.via}, or its key (${table.key.join(', ')}).`);
  // Whose objects a row may name is the run's to say; without it, no row's object is anyone's to read.
  const scope = options.scope;
  if (!scope) throw new Error(`${name}: ${verb} was asked outside a command run that says whose files it reads.`);
  const found = await readFileRow(reader, table.meta, rule, key, undefined, scope);
  if ('error' in found) return found.status === 404 ? refuse('not_found') : authorMistake(`${name}: ${found.error}`);
  const held = (size: number) => {
    if (size > rule.maxBytes)
      authorMistake(`${name}: this file is ${sizeOf(size)}; ${verb} hands over at most the resource's ${sizeOf(rule.maxBytes)}.`);
    if (budget.read + size > COMMAND_FILE_READ_MOST)
      authorMistake(
        `${name}: one command reads at most ${sizeOf(COMMAND_FILE_READ_MOST)} of files; this one has read ${sizeOf(budget.read)} ` +
          `and this file is ${sizeOf(size)}. Read fewer in one command, or move the rest to a job.`,
      );
  };
  let data: Uint8Array;
  if ('bytes' in found) data = found.bytes;
  else {
    // Refused before the bytes are fetched where the row says how many there are.
    if (found.size !== undefined) held(found.size);
    /* And whatever the row says, no more is fetched than this read may hand over: a row with no size column, or
       one that understates its object, would otherwise pull the whole object into memory before it is refused. */
    const read =
      (await found.bucket.bytesAtMost(found.object, Math.min(rule.maxBytes, COMMAND_FILE_READ_MOST - budget.read))) ?? refuse('not_found');
    if ('over' in read) {
      held(read.over);
      throw new Error(`${name}: ${verb} fetched past what it may hand over.`);
    }
    data = read.bytes;
  }
  held(data.byteLength);
  budget.read += data.byteLength;
  const file: CommandFile = Object.freeze({
    name: found.name,
    type: found.claimed || 'application/octet-stream',
    size: data.byteLength,
    data,
  });
  return { file, key, stored: 'object' in found ? { bucket: found.bucket, object: found.object } : undefined };
}

/** The `db` of one command run: a frozen object of table handles, exactly the footprint's. */
export function createCommandDb(options: CommandDbOptions): Readonly<Record<string, ReadTable<UntypedRow> | WriteTable<UntypedRow>>> {
  const handles: Record<string, ReadTable<UntypedRow> | WriteTable<UntypedRow>> = {};
  const budget: FileReadBudget = { read: options.fileRead ?? 0 };
  const names = new Set([...options.read, ...options.write]);
  for (const name of names) {
    const table = options.catalog[name];
    if (!table) throw new Error(`The command's catalog has no table "${name}".`);
    /* What an `any`/`no` may ask about is what this handle declares, whatever else the catalog holds. */
    const declared = table.declared && {
      tables: table.declared.tables.filter((each) => names.has(each.id)),
      foreignKeys: table.declared.foreignKeys.filter((fk) => names.has(fk.from.table) && names.has(fk.to.table)),
    };
    handles[name] = tableHandle(declared ? { ...table, declared } : table, options.write.includes(name), options, budget, handles);
  }
  return Object.freeze(handles);
}

function tableHandle(
  table: CommandTable,
  writable: boolean,
  options: CommandDbOptions,
  budget: FileReadBudget = { read: 0 },
  // The run's other handles, filled by the time a handler calls: where moveFile writes.
  peers: Readonly<Record<string, ReadTable<UntypedRow> | WriteTable<UntypedRow>>> = {},
): ReadTable<UntypedRow> | WriteTable<UntypedRow> {
  const { tx, now } = options;
  const name = table.name;
  /* No one is signed in to a handler's where (`me` stays refused), but the request's choices are its to read. */
  const who: QueryPerson | undefined = options.chosen ? { email: null, chosen: options.chosen } : undefined;
  const rows = async (
    compiled: Compiled,
    limit: number,
    orderBy = compiled.orderBy,
    withNames: readonly string[] = [],
  ): Promise<UntypedRow[]> => {
    if (compiled.none) return [];
    if (withNames.length) {
      if (compiled.filter.groups.flat().some((condition) => condition.any || condition.within))
        authorMistake(`${name}: a read with .with takes a where over the row's own columns and computed columns, not "any" or "in".`);
      const found = await options.readDerived!({ table: name, names: withNames, filter: compiled.filter, orderBy, limit });
      return found.rows.map((row) => normalizeRow(table, row) as UntypedRow);
    }
    const result = await tx.query({ table: name, filter: compiled.filter, limit, offset: 0, ...(orderBy.length ? { orderBy } : {}) });
    return result.rows.map((row) => normalizeRow(table, row) as UntypedRow);
  };
  const keyOf = (row: unknown): Record<string, string | number> => {
    const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const key = table.key.length ? canonicalKey(table, record) : undefined;
    if (!key) throw new Error(`${name}: the row carries no key; pass a row read through db.${name}.`);
    return key;
  };
  const stale = (key: Record<string, string | number>) => refuse('stale_record', name === options.target ? { key } : undefined);
  /* Every where a query has been given must hold, as one: their groups multiplied out (an AND of two ORs), the order and
     the limit of each kept. */
  type Part = { readonly where: unknown; readonly values: readonly unknown[] };
  const compileParts = (parts: readonly Part[]): Compiled => {
    const compiled = parts.map((part) => compileWhere(table, part.where, now(), part.values, who, HANDLE));
    if (compiled.length === 1) return compiled[0];
    const filled = compiled.map((each) => each.filter.groups).filter((groups) => groups.length);
    const groups = filled.reduce<Condition[][]>((all, next) => all.flatMap((left) => next.map((right) => [...left, ...right])), [[]]);
    const limits = compiled.flatMap((each) => (each.limit === undefined ? [] : [each.limit]));
    const computed = Object.assign({}, ...compiled.map((each) => each.filter.computed ?? {}));
    return {
      filter: { groups: filled.length ? groups : [], ...(Object.keys(computed).length ? { computed } : {}) },
      none: compiled.some((each) => each.none),
      orderBy: compiled.flatMap((each) => each.orderBy),
      ...(limits.length ? { limit: Math.min(...limits) } : {}),
    };
  };
  const queryOver = (parts: Part[]): Query<UntypedRow> => {
    const order: { column: string; direction: 'asc' | 'desc' }[] = [];
    const withNames: string[] = [];
    let cap: number | undefined;
    const run = async (limit?: number): Promise<UntypedRow[]> => {
      const compiled = compileParts(parts);
      const bound = limit ?? cap ?? compiled.limit;
      const found = await rows(compiled, bound ?? DEFAULT_CAP + 1, [...compiled.orderBy, ...order], withNames);
      if (bound === undefined && found.length > DEFAULT_CAP) {
        throw new Error(`${name}: more than ${DEFAULT_CAP} rows match; say how many with .limit(n).`);
      }
      return found;
    };
    /* Sums and groups: every row the where matches, so the rows' own order and limit mean nothing here; the
         groups have their own, after aggregate(). */
    const measured = async (
      keys: readonly unknown[],
      given: unknown,
      grouped: boolean,
      groupOrder: readonly { name: string; direction: 'asc' | 'desc' }[] = [],
      groupCap?: number,
    ): Promise<Readonly<Record<string, unknown>>[]> => {
      if (order.length || cap !== undefined)
        authorMistake(`${name}: .orderBy and .limit order and count rows, and an aggregate reads every row its where matches.`);
      if (withNames.length) authorMistake(`${name}: .with goes with a read of rows; a sum or a group measures the columns themselves.`);
      const plan = planAggregate(table, keys, given);
      const compiled = compileParts(parts);
      if (compiled.orderBy.length || compiled.limit !== undefined)
        authorMistake(`${name}: an aggregate's where says which rows; leave "sort" and "limit" out of it.`);
      if (asksAboutRows(compiled.filter))
        authorMistake(
          `${name}: a sum or a group reads rows by their own columns; read the rows with an "any"/"no" or an "in" where, or count them.`,
        );
      const orderBy = groupOrder.map((o) => ({ name: plan.orderName(o.name), direction: o.direction }));
      if (compiled.none) return grouped ? [] : [plan.decode({})];
      /* Fail closed: a transaction that cannot say an aggregate under its scope (an HTTP source, a facade that
           does not carry one) has none, and nothing here reads the rows to add them up instead. */
      if (typeof tx.aggregate !== 'function') return authorMistake(`${name}: this command's source cannot sum or group rows.`);
      const result = await tx.aggregate({
        table: name,
        filter: compiled.filter,
        by: plan.by,
        measures: plan.measures(new Set(orderBy.map((o) => o.name))),
        ...(orderBy.length ? { orderBy } : {}),
        limit: grouped ? (groupCap ?? DEFAULT_CAP + 1) : 1,
      });
      if (grouped && groupCap === undefined && result.rows.length > DEFAULT_CAP)
        authorMistake(`${name}: more than ${DEFAULT_CAP} groups; say how many with .limit(n).`);
      return result.rows.map((row) => plan.decode(row));
    };
    /* A page: the key appended to the order so it is total, the boundary an AND on the where, so every scope and
         grant beneath checks it as it checks the where (keysetPage.ts). */
    const pageOrder = (compiled: Compiled): { column: string; direction: 'asc' | 'desc' }[] => {
      if (cap !== undefined || compiled.limit !== undefined)
        authorMistake(`${name}: a page's size says how many rows; leave out the limit.`);
      if (!table.key.length) authorMistake(`${name}: has no primary key, so a page cannot say where it ends.`);
      const paged = [...compiled.orderBy, ...order];
      if (new Set(paged.map((o) => o.column)).size !== paged.length) authorMistake(`${name}: a page orders by each column once.`);
      for (const column of table.key) if (!paged.some((o) => o.column === column)) paged.push({ column, direction: 'asc' });
      for (const o of paged) {
        const meta = table.meta.columns.find((column) => column.name === o.column);
        /* NULL sorts first on SQLite and last on PostgreSQL, so a boundary past an empty value would mean a
             different row on each: a page orders by columns that always hold one. */
        if (meta?.nullable && !meta.primaryKey)
          authorMistake(
            `${name}: a page orders by columns that are never empty, and "${o.column}" can be; order by the key or a NOT NULL column.`,
          );
      }
      if (!keysetOrder(table.meta, paged, 'sqlite'))
        authorMistake(
          `${name}: a page orders by columns read back exactly as stored, and ${paged.map((o) => o.column).join(', ')} are not all.`,
        );
      return paged;
    };
    const page = async (after: unknown, size: unknown): Promise<Page<UntypedRow>> => {
      if (withNames.length) authorMistake(`${name}: .with goes with a read of rows, not a page of them.`);
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MOST_PAGE)
        authorMistake(`${name}: a page's size is a whole number from 1 to ${MOST_PAGE}.`);
      const compiled = compileParts(parts);
      const paged = pageOrder(compiled);
      let filter = compiled.filter;
      if (after !== undefined) {
        /* A position, not a capability: whoever asks reads the page past it under their own scope. One that names
             other columns than the order is the caller's input, refused as such. */
        const boundary = after as Record<string, unknown> | null;
        if (
          !boundary ||
          typeof boundary !== 'object' ||
          Array.isArray(boundary) ||
          Object.keys(boundary).length !== paged.length ||
          paged.some((o) => !Object.hasOwn(boundary, o.column)) ||
          Object.values(boundary).some(
            (value) => typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)),
          )
        )
          return refuse('invalid_input');
        const tail = keysetAfter(table.meta, paged, boundary as Boundary, 'sqlite');
        if (!tail) return refuse('invalid_input');
        filter = { ...compiled.filter, groups: continueGroups(compiled.filter.groups, tail) as Condition[][] };
      }
      const found = await rows({ filter, none: compiled.none, orderBy: [] }, (size as number) + 1, paged);
      const shown = found.slice(0, size as number);
      const last = shown.at(-1);
      return found.length > shown.length && last
        ? {
            rows: shown,
            next: Object.freeze(Object.fromEntries(paged.map((o) => [o.column, last[o.column] as string | number | boolean]))),
          }
        : { rows: shown };
    };
    const query: Query<UntypedRow> = {
      where(more) {
        parts.push({ where: more, values: [] });
        return query;
      },
      orderBy(column, direction = 'asc') {
        if (!Object.hasOwn(table.kinds, column)) throw new Error(`${name}: "${column}" is not one of its columns.`);
        order.push({ column, direction: direction === 'desc' ? 'desc' : 'asc' });
        return query;
      },
      limit(count) {
        if (!Number.isSafeInteger(count) || count < 1) throw new RangeError(`${name}: a limit is a positive whole number.`);
        cap = count;
        return query;
      },
      with(...names) {
        if (!options.readDerived)
          authorMistake(
            `${name}: .with reads a computed column or rollup, which a page's loader does; a command's db reads stored columns.`,
          );
        for (const each of names as readonly unknown[]) {
          const allowed = options.derived?.[name];
          if (typeof each !== 'string' || !allowed?.includes(each))
            authorMistake(
              `${name}: ${typeof each === 'string' ? `"${each}"` : 'a name'} is not declared; list '${name}.${typeof each === 'string' ? each : '<name>'}' in the loader's reads` +
                `${allowed?.length ? ` (it declares ${allowed.join(', ')})` : ''}.`,
            );
          if (!withNames.includes(each)) withNames.push(each);
        }
        return query as never;
      },
      first: async () => (await run(1))[0],
      sum: async (column) => (await measured([], { total: sum(column) }, false))[0].total as string | number,
      aggregate: async (measures) => (await measured([], measures, false))[0] as never,
      groupBy(...keys) {
        return {
          aggregate(measures) {
            const groupOrder: { name: string; direction: 'asc' | 'desc' }[] = [];
            let groupCap: number | undefined;
            const grouped: Grouped<never> = {
              orderBy(answer, direction = 'asc') {
                groupOrder.push({ name: answer, direction: direction === 'desc' ? 'desc' : 'asc' });
                return grouped;
              },
              limit(count) {
                if (!Number.isSafeInteger(count) || count < 1 || count > MOST_ROWS)
                  authorMistake(`${name}: a limit on groups is a whole number from 1 to ${MOST_ROWS}.`);
                groupCap = count;
                return grouped;
              },
              // eslint-disable-next-line unicorn/no-thenable -- read when awaited, after the chain is written, as a query is.
              then: (resolve, reject) => measured(keys, measures, true, groupOrder, groupCap).then(resolve as never, reject),
            };
            return grouped;
          },
        };
      },
      page: (options) => page(options?.after, options?.size),
      async *iterate(options) {
        const size = options?.size;
        let after: Boundary | undefined;
        let read = 0;
        for (;;) {
          const next = await page(after, iterateSize(size, read));
          read += next.rows.length;
          yield* next.rows;
          if (!next.next) return;
          /* The bound is on what one command holds the writer for: past it, a walk pages across commands, its
               place kept by a workflow (docs: commands). Refused, never cut short. */
          if (read >= MOST_ROWS)
            authorMistake(`${name}: iterate reads at most ${MOST_ROWS} rows in one command; page across commands with .page({ after }).`);
          after = next.next;
        }
      },
      // Awaiting the query runs it: `await db.vehicle.where(...).limit(5)` reads once, after the chain is written.
      // eslint-disable-next-line unicorn/no-thenable -- the lazy thenable is the query's whole interface.
      then: (resolve, reject) => run().then(resolve, reject),
    };
    return query;
  };
  /* One row's file, through this command's transaction (http/fileRows.ts): its grants, row policy and tenant are the
     reader's. The row's key and object come back for moveFile. */
  const fileOf = async (given: unknown, verb: 'readFile' | 'moveFile') => {
    const rule = options.fileReads?.get(name);
    if (!rule) throw new Error(`${name}: ${verb} reads a file resource this command reads, and ${name} is not one here.`);
    return readKeptFile(tx, { name, verb, via: `db.${name}`, table, rule, scope: options.fileScope, budget }, given);
  };
  const read: ReadTable<UntypedRow> = {
    async get(key) {
      const given =
        key !== null && typeof key === 'object'
          ? (key as Record<string, unknown>)
          : table.key.length === 1
            ? { [table.key[0]]: key }
            : undefined;
      if (!given || Object.keys(given).length !== table.key.length || table.key.some((column) => !Object.hasOwn(given, column))) {
        throw new Error(`${name}: get takes the key (${table.key.join(', ')}); find takes any other columns.`);
      }
      const exact = canonicalKey(table, given);
      if (!exact) return refuse('not_found');
      const found = await rows({ filter: keyFilter(exact), none: false, orderBy: [] }, 2);
      if (found.length > 1) throw new Error(`${name}: its key names ${found.length} rows.`);
      return found[0] ?? refuse('not_found');
    },
    async find(where) {
      const found = await rows(compileWhere(table, where, now(), [], who, HANDLE), 2);
      if (found.length > 1) throw new Error(`${name}: find matched several rows; narrow the where, or use where().`);
      return found[0];
    },
    where(where?: unknown, ...values: readonly unknown[]): Query<UntypedRow> {
      /* Only the template binds values. A string with a second argument would drop it and match the wrong rows
         without a word, so it is the author's to fix. */
      if (values.length && !isTemplate(where))
        authorMistake(
          `${name}: where("...", value) does not bind values; write the template form where\`id <= \${x}\` or the object form where({ id: x }).`,
        );
      return queryOver([{ where, values }]);
    },
    segment(segment: string): Query<UntypedRow> {
      const segments = table.meta.segments;
      if (typeof segment !== 'string' || !segments || !Object.hasOwn(segments, segment)) {
        const names = Object.keys(segments ?? {});
        const near = typeof segment === 'string' ? nearest(segment, names) : undefined;
        throw new Error(
          `${name}: ${typeof segment === 'string' ? `"${segment}"` : 'that'} is not a segment of ${name}.` +
            (names.length ? ` Its segments: ${names.join(', ')}.${near ? ` Did you mean "${near}"?` : ''}` : ' It has none.'),
        );
      }
      /* Written out before it is read, as the language writes a segment's name (query.ts expandSegments): an `any` or `no`
         inside it is then judged as one a handler wrote, and what the segment names that this `db` does not read is
         refused here, at the call, in the segment's name rather than where the rows are awaited. */
      const expanded = expandSegments(segment, segments);
      if (expanded.error) throw new Error(`${name}: ${expanded.error.message}`);
      try {
        compileWhere(table, expanded.text, now(), [], who, HANDLE);
      } catch (error) {
        throw new Error(
          `${name}: the segment "${segment}" cannot be read here: ${(error as Error).message.replace(`${name}: `, '')} A handler reads a table's own columns and the tables it declares, not its rollups or paths.`,
        );
      }
      return queryOver([{ where: expanded.text, values: [] }]);
    },
    async count(where) {
      const compiled = compileWhere(table, where, now(), [], who, HANDLE);
      return compiled.none ? 0 : tx.count(name, compiled.filter);
    },
    async readFile(given) {
      return (await fileOf(given, 'readFile')).file;
    },
  };
  if (!writable) return Object.freeze(read);
  const writer = tx as WriteTransaction;
  /* The changes as written: constants worked out, each column one of the table's. */
  const changed = async (changes: unknown): Promise<Record<string, Value>> => {
    const values = { ...(await withConstants(table, changes as Record<string, unknown>, options)) } as Record<string, Value>;
    for (const column of Object.keys(values)) {
      if (!Object.hasOwn(table.kinds, column)) throw new Error(`${name}: "${column}" is not one of its columns.`);
    }
    return values;
  };
  /* One row's guarded update: its revision bumped, and guarded by exactly the changed columns, each at the value
     this row was read with — but a JSON column, which no engine compares and which is written whole (appAccess.ts). */
  const guarded = (row: UntypedRow, changes: Record<string, Value>): UpdateRequest => {
    const key = keyOf(row);
    const values = { ...changes };
    const revision = options.versionField;
    if (revision && Object.hasOwn(table.kinds, revision) && !Object.hasOwn(values, revision)) {
      const current = (row as Record<string, unknown>)[revision];
      if (typeof current === 'number' && Number.isSafeInteger(current) && current < Number.MAX_SAFE_INTEGER) values[revision] = current + 1;
    }
    const expected: Record<string, Value> = {};
    for (const column of Object.keys(values)) {
      if (!Object.hasOwn(row, column)) throw new Error(`${name}: update needs the row as read; it has no "${column}".`);
      if (table.meta.columns.some((meta) => meta.name === column && isJsonType(meta.type))) continue;
      expected[column] = ((row as Record<string, unknown>)[column] ?? null) as Value;
    }
    return { table: name, key, expected, values };
  };
  const insert = async (given: Record<string, unknown>, written?: WriteOptions) => {
    const values = await withConstants(table, given, options);
    const words = wordsOf(name, written);
    const result = await writer.insert({ table: name, values: values as Record<string, Value>, ...(words ? { words } : {}) });
    return normalizeRow(table, result.row ?? { ...result.applied, ...result.key }) as UntypedRow;
  };
  return Object.freeze({
    ...read,
    insert,
    async insertFile(file, values = {}) {
      const rule = options.files?.get(name);
      if (!rule) throw new Error(`${name}: insertFile writes a file resource, and ${name} declares no "file".`);
      const data = file?.data as unknown;
      if (!(data instanceof Uint8Array)) throw new TypeError(`${name}: insertFile takes the file's bytes as a Uint8Array (or a Buffer).`);
      const made = fileValues(rule, { name: file.name, type: file.type, bytes: data }, values);
      if ('error' in made) throw new Error(`${name}: ${made.error}`);
      // The pre-made copies of a public picture start when the command has committed (businessCommandExecution.ts).
      if (made.stored) options.afterCommit?.(made.stored);
      if (rule.storage !== 'bucket') {
        const row = await insert(made.values);
        options.stored?.(name, data);
        return row;
      }
      if (!options.placeFile) throw new Error(`${name}: its files are kept in a bucket, which this command cannot write to.`);
      const row = await insert(await options.placeFile(rule, made.values));
      options.stored?.(name, data);
      return row;
    },
    async moveFile(given, to, values = {}) {
      const into = peers[to] as WriteTable<UntypedRow> | undefined;
      const ceiling = options.files?.get(to)?.maxBytes;
      if (to === name || ceiling === undefined || typeof into?.insertFile !== 'function')
        throw new Error(`${name}: moveFile moves a file to another file resource this command writes, and ${String(to)} is not one here.`);
      const { file, key, stored } = await fileOf(given, 'moveFile');
      // Refused in the words readFile uses for its own cap, rather than as an upload too large for the App.
      if (file.size > ceiling)
        authorMistake(`${name}: this file is ${sizeOf(file.size)}; moveFile moves it into ${to}, which takes at most ${sizeOf(ceiling)}.`);
      // The new row first, held to its own resource's rules, and under its own key: a key is never shared by two rows.
      const row = await into.insertFile({ name: file.name, type: file.type, data: file.data }, values);
      const result = await writer.remove({ table: name, key });
      if (result.affected !== 1) stale(key);
      /* The old object goes once the move has committed; a rollback keeps it, as the row it names. Nothing else names
         it, and one the delete misses is the sweep's. */
      if (stored) options.afterCommit?.(() => void stored.bucket.delete(stored.object).catch(() => {}));
      return row;
    },
    async update(row, changes, written) {
      const words = wordsOf(name, written);
      const values = await changed(changes);
      if (!Object.keys(values).length) return row;
      const request = { ...guarded(row, values), ...(words ? { words } : {}) };
      let result: Awaited<ReturnType<WriteTransaction['update']>>;
      try {
        result = await writer.update(request);
      } catch (error) {
        if (isWriteConflict(error)) return stale(request.key);
        throw error;
      }
      if (result.affected !== 1) return stale(request.key);
      return normalizeRow(table, { ...row, ...request.values, ...result.applied }) as UntypedRow;
    },
    async insertMany(given) {
      if (!Array.isArray(given)) throw new TypeError(`${name}: insertMany takes an array of rows.`);
      const most = options.changeCap ?? DEFAULT_CAP;
      if (given.length > most)
        authorMistake(`${name}: insertMany writes at most ${most.toLocaleString('en-US')} rows in one call${raised(options)}.`);
      const requests = await Promise.all(
        given.map(async (values) => ({
          table: name,
          values: (await withConstants(table, values as Record<string, unknown>, options)) as Record<string, Value>,
        })),
      );
      const results = await insertAll(writer, requests);
      return results.map((result) => normalizeRow(table, result.row ?? { ...result.applied, ...result.key }) as UntypedRow);
    },
    async updateWhere(where, changes) {
      const values = await changed(changes);
      const compiled = compileWhere(table, where, now(), [], who, HANDLE);
      if (compiled.orderBy.length || compiled.limit !== undefined)
        authorMistake(`${name}: updateWhere's where says which rows; leave "sort" and "limit" out of it.`);
      const most = options.changeCap ?? DEFAULT_CAP;
      const found = await rows(compiled, most + 1);
      if (found.length > most)
        authorMistake(
          `${name}: more than ${most.toLocaleString('en-US')} rows match; updateWhere changes at most that many${raised(options)}.`,
        );
      if (!found.length || !Object.keys(values).length) return found;
      /* Each row with its own revision and its own guard, so one that moved since the read is a WriteConflict and
         the batch rolls back whole (adapter.ts updateAll), as one guarded update would. */
      const requests = found.map((row) => guarded(row, values));
      let results: Awaited<ReturnType<WriteTransaction['update']>>[];
      try {
        results = await updateAll(writer, requests);
      } catch (error) {
        /* A conflict does not say which row moved; one row's names it, as `update` does. */
        if (isWriteConflict(error)) return requests.length === 1 ? stale(requests[0]!.key) : refuse('stale_record');
        throw error;
      }
      return found.map((row, at) => {
        if (results[at]!.affected !== 1) return stale(requests[at]!.key);
        return normalizeRow(table, { ...row, ...requests[at]!.values, ...results[at]!.applied }) as UntypedRow;
      });
    },
    async remove(row) {
      const key = keyOf(row);
      const result = await writer.remove({ table: name, key });
      if (result.affected !== 1) stale(key);
    },
  } satisfies WriteTable<UntypedRow>);
}
