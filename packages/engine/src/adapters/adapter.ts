/**
 * What a database adapter has to provide, and — just as importantly — what it
 * is not allowed to decide.
 *
 * An adapter reads a dialect's catalog and runs parameterised reads. It does
 * not build WHERE clauses from user input, does not decide what a row is
 * called, and never returns SQL for something upstream to concatenate. Every
 * value the user supplies reaches the database as a bound parameter, because
 * a browsing tool that interpolates a filter into SQL is a SQL injection
 * vulnerability with a nice front end.
 */
import { declaredOrder, type DatabaseSchema, type Order, type TableMeta } from '../shared/schema.js';
/* Type-only, and deliberately so: shared/ never imports the adapters, and a
   value import from here would put them in its graph. Types are erased, so
   these edges do not exist once compiled. */
import type { CompiledColumn, CompiledJoin, ViewDef } from '../shared/view.js';
import type { BreakdownDef, CompiledMeasure } from '../shared/breakdown.js';
import type { RowScope } from '../shared/rowScope.js';
import { Refusal } from '../shared/refusal.js';
import type { QueryResult } from '../shared/reads.js';
import { orderClauseSql, type Filter, type SqlFragment, type SqlStyle } from '../shared/filter.js';
import type { PoolRoleStats } from './poolMetrics.js';

/* The filter, the limit policy and Refusal live in shared/, where the query
   language and views reach them without depending on the adapters. Adapter
   and server code keep reaching them through this contract. */
export {
  ANSI_STYLE,
  MYSQL_STYLE,
  OPS,
  POSTGRES_STYLE,
  buildWhere,
  type Condition,
  type Filter,
  type Op,
  type SqlFragment,
  type SqlStyle,
} from '../shared/filter.js';
export {
  DEFAULT_LIMIT,
  ESTIMATE_ABOVE,
  MAX_LIMIT,
  clampLimit,
  clampOffset,
  countStatement,
  countEachStatement,
  countEachRows,
  type CountResult,
  type QueryResult,
} from '../shared/reads.js';

/** One count of `Adapter.countEach`: a table, and the rows of it to count. */
export interface CountItem {
  table: string;
  filter?: Filter;
}

/**
 * Whether one scan can answer every item (countEachStatement's `together`):
 * they all read one table, and the catalog says that table holds no more
 * rows than the bound — so reading all of it costs no more than one bounded
 * count would. Unbounded, one scan always beats one per item.
 */
export function countsTogether(schema: DatabaseSchema | null, items: readonly CountItem[], limit?: number): boolean {
  if (!items.every((item) => item.table === items[0]?.table)) return false;
  if (limit === undefined) return true;
  const rows = schema?.tables.find((table) => table.id === items[0].table)?.approxRows;
  return typeof rows === 'number' && rows <= limit;
}
export { Refusal } from '../shared/refusal.js';

/**
 * A read's ORDER BY, or nothing: each column by its value, or by its declared
 * vocabulary where the catalog has one over text (shared/schema.ts
 * `declaredOrder`), its values bound from `startIndex`. Every adapter's plain
 * read and a scoped read say it the same way, so a list sorts alike on all
 * three engines.
 */
export function orderClause(
  order: readonly Order[] | undefined,
  table: TableMeta | undefined,
  style: SqlStyle,
  startIndex: number,
  quote: (column: string) => string = (column) => style.quote(column),
): SqlFragment {
  return orderClauseSql(
    (order ?? []).map((o) => ({
      expression: quote(o.column),
      direction: o.direction,
      declared: declaredOrder(table?.columns.find((column) => column.name === o.column)),
    })),
    style,
    startIndex,
  );
}

/* Registered, not a local symbol: a command handler catches the conflict its
   `tx.update` threw and rethrows through the copy of tablewalk it imported,
   which need not be this one (see businessCommandExecution.ts). */
const conflictBrand = Symbol.for('mistri.writeConflict');

/** A conditional update matched no row and did not apply its proposed values. */
export class WriteConflict extends Error {
  readonly [conflictBrand] = true;
  constructor() {
    super('This record changed or was removed since it was read. Reload it and review your changes before applying them again.');
    this.name = 'WriteConflict';
  }
}

/** The native class, or a branded twin from another copy of the package. */
export function isWriteConflict(error: unknown): error is WriteConflict {
  return error instanceof WriteConflict || (error instanceof Error && (error as { [conflictBrand]?: unknown })[conflictBrand] === true);
}

/** A transaction acknowledgement could not establish whether writes landed.
 * Never inherit Refusal or driver constraint codes: callers must not turn a
 * failed rollback of a rejected operation into permission to retry it. */
export class TransactionOutcomeUnknown extends Error {
  readonly outcome = 'unknown' as const;
  constructor(cause: unknown) {
    super('The transaction outcome could not be confirmed. Refresh and reconcile the records before making another change.', { cause });
    this.name = 'TransactionOutcomeUnknown';
  }
}

export interface QueryRequest {
  table: string;
  filter?: Filter;
  /** Column names to return. Empty means the adapter picks a sensible set. */
  columns?: string[];
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  limit: number;
  offset: number;
  /** Binary columns come back as their bytes, not the `<n bytes>` label: a file download's read, never a grid's. */
  binary?: true;
}

/**
 * What running a view returns.
 *
 * `columns` is the ordered output names, as in `QueryResult`; `resolved`
 * carries what each of them *is* — the table and column it came from, its
 * type, and how many references were followed to reach it. The client needs
 * that to group a hundred fields by their table and to render a date as a
 * date, and re-deriving it in the browser would mean a second path resolver.
 */
export interface ViewResult extends QueryResult {
  resolved: CompiledColumn[];
  joins: CompiledJoin[];
}

/**
 * What a breakdown returns.
 *
 * `groups` rather than `rows` everywhere else in this file would be nicer and
 * is not worth the split: the shape is a result set, the grid renders it, and
 * `columns` still names the output. What is different is `resolved`, which
 * says of each column whether it is a key or a measure — the interface needs
 * that to right-align a count and to know that a key is clickable back into
 * the rows behind it.
 */
export interface BreakdownResult extends QueryResult {
  resolved: CompiledMeasure[];
}

/* ---------- raw SQL ---------- */

/**
 * A statement the user typed, run as they typed it.
 *
 * This is the one place the tool hands the database text it did not build,
 * which makes every guarantee elsewhere in this file inapplicable: there is no
 * `Filter` to compile, no identifier to check against the catalog, no value to
 * bind. The safety argument has to be made somewhere else entirely.
 *
 * It is made in three places, none of which involve reading the statement:
 *
 *   1. **The connection cannot write.** A read runs inside a transaction opened
 *      READ ONLY, which neither Postgres nor MySQL will let a statement promote
 *      from the inside; SQLite's handle is opened read-only at the file level.
 *      A `DELETE` fails with the database's own error, not with our guess about
 *      what a `DELETE` looks like.
 *   2. **One statement per call.** Stacking is refused before anything runs, so
 *      `SELECT 1; DROP TABLE customer` cannot smuggle a second statement past a
 *      check aimed at the first.
 *   3. **The result is bounded.** The statement is wrapped in a subquery with a
 *      LIMIT, so a bare `SELECT * FROM huge` returns a page rather than a heap.
 *
 * Writing is possible and is a different request: `write: true`, refused unless
 * the connection is marked writable, and run on the write handle.
 */
export interface SqlRequest {
  text: string;
  /** Rows to return. Bounded by `clampLimit` like every other read. */
  limit: number;
  /** Run on the write handle. Refused unless the connection allows it. */
  write?: boolean;
  /**
   * A cap below the default for this one statement, in milliseconds, held
   * between a floor and STATEMENT_TIMEOUT_MS (statementControl.ts). Never
   * raises the cap; politeness only lowers.
   *
   * Postgres sets it inside the statement's transaction and MySQL on the
   * statement's own session. SQLite has no statement timeout, so it keeps
   * this one only for a read a caller can stop — one run inside
   * `withCancellation` — which it runs in a process it can kill; a read on
   * the in-process handle cannot be interrupted.
   */
  timeoutMs?: number;
  /**
   * Refuse a statement that touches tablewalk's own runtime or sign-in tables
   * before it runs (reservedSql.ts): the lexical check, then the engine's own
   * account of what the statement reads where it gives one. A statement the
   * check cannot read is refused rather than run.
   */
  refuseReserved?: boolean;
}

export interface SqlResult {
  columns: string[];
  /**
   * Rows as arrays, not objects.
   *
   * `SELECT id, id FROM t` returns two columns with one name. An object keyed
   * by column name can only hold one of them, so the second silently replaces
   * the first and the grid shows a column of values from somewhere else. The
   * adapters disagree about this today — SQLite builds rows with `Object.keys`
   * and loses the duplicate outright, Postgres and MySQL keep both in the
   * header and one in the row — and positional rows are the only shape that
   * cannot lose data whatever the driver does.
   */
  rows: unknown[][];
  ms: number;
  /** A row beyond the limit existed: there is more than is being shown. */
  truncated: boolean;
  /** The LIMIT wrap applied. False means the database did the whole job. */
  bounded: boolean;
  /** Rows changed, for a write. Absent for a read. */
  affected?: number;
  sql: { text: string; params: unknown[] };
}

export interface ExplainRequest {
  text: string;
  /** Bound values for the statement's placeholders, when it has them. */
  params?: unknown[];
  /** As on SqlRequest: refuse a statement that touches tablewalk's own tables. */
  refuseReserved?: boolean;
}

export interface ExplainResult {
  /** The plan, one line per node, in the engine's own words. */
  plan: string[];
  ms: number;
}

export interface ColumnProfile {
  column: string;
  type: string;
  /** The share of rows where this column is null, 0..1. */
  nullFrac?: number;
  /** Distinct non-null values — estimated where the engine estimates. */
  distinct?: number;
  /** The edges of the range, as the engine reports them. Approximate where
      the numbers come from a sample rather than a scan. */
  min?: unknown;
  max?: unknown;
  /** The values that repeat most, each with its share of rows. Absent when
      nothing repeats — a unique column's most common value is noise. */
  common?: Array<{ value: unknown; frac: number }>;
}

export interface ProfileResult {
  table: string;
  /** The table's row count. An estimate where `source` says statistics;
      exact otherwise — a sample still counts the whole table first. */
  rows?: number;
  columns: ColumnProfile[];
  /** What the answer cost to make: `statistics` read numbers the planner
      already keeps (free, sample-based, stale until the next ANALYZE);
      `scan` computed them by reading the table; `sample` read a bounded
      slice of a table too large to scan while a synchronous driver holds
      the process. */
  source: 'statistics' | 'scan' | 'sample';
  /** How many rows the fractions are relative to, when `source` is sample. */
  sampled?: number;
  /**
   * Set when value-bearing fields were withheld — a shape-only connection.
   *
   * Present rather than implied: a profile with no `min` and no `common`
   * looks identical to a profile of a column that has neither, and a reader
   * cannot tell "nothing repeats here" from "you are not allowed to know".
   */
  redacted?: string;
  ms: number;
}

/**
 * When a profile stops scanning and starts sampling.
 *
 * Overridable per call so a test can exercise the sampling path against a
 * five-hundred-row fixture instead of manufacturing a million rows.
 */
export interface ProfileLimits {
  /** Scan whole up to this many rows. */
  scanAtMost?: number;
  /** Aim for roughly this many rows when sampling. */
  sampleSize?: number;
}

/**
 * Refuse anything that is more than one statement.
 *
 * Not a SQL parser and not trying to be one — it answers exactly one question,
 * "is there a second statement here", and it answers it by scanning for a
 * semicolon that has something after it. Everything that can contain a
 * semicolon harmlessly is skipped: single- and double-quoted strings,
 * backquoted identifiers, line comments, block comments, and Postgres's
 * dollar-quoted bodies, which is how a function definition carries semicolons
 * without being several statements.
 *
 * Stacking is refused rather than truncated. Running the first half of what
 * someone typed and discarding the rest is worse than refusing both: they
 * asked for two things and would be told about neither.
 *
 * Returns null when the text is a single statement, or the reason it is not.
 */
export function refuseStacked(text: string): string | null {
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // Line comment, to end of line.
    if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    // Block comment. Not nested: no dialect here nests them.
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // Dollar-quoted body: $$…$$ or $tag$…$tag$. Postgres only, harmless
    // elsewhere because the opening tag simply will not match.
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < n) {
        /* A backslash is a character, not an escape. Postgres (standard-
           conforming strings, the default since 9.1) and SQLite both read
           `'\'` as a one-character string; only MySQL treats `\'` as an
           escaped quote. Reading it as an escape here meant a Postgres
           statement `'\'; drop table x; --'` scanned as one long string and
           the second statement walked past this check — the driver's own
           refusal of multi-statement text caught it, but the first line of
           defence had a hole. Reading it literally errs toward refusing: a
           MySQL string holding `\'` may now be cut short, and the worst
           that does is refuse a statement that was fine. */
        // A doubled quote is an escaped quote, not the end of the string.
        if (text[i] === ch && text[i + 1] === ch) {
          i += 2;
          continue;
        }
        if (text[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === ';') {
      // A trailing semicolon is punctuation, not a second statement.
      if (text.slice(i + 1).trim() === '') return null;
      return 'One statement at a time. Remove the semicolon and everything after it, or run them separately.';
    }
    i += 1;
  }
  return null;
}

/**
 * Output column names, with collisions given a suffix.
 *
 * `SELECT id, id FROM t` names both columns `id`. Left alone, the grid draws
 * one header twice and nothing says which value belongs to which. The suffix
 * is the same answer `compileView` gives an explicit collision, for the same
 * reason: one column quietly standing in for two is worse than an ugly name.
 */
export function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name}_${count + 1}` : name;
  });
}

/** A statement with its trailing semicolon and surrounding space removed. */
export function trimStatement(text: string): string {
  /* The whitespace *before* the semicolon goes too. `select 1 ;` left a
     trailing space, which is invisible in the editor and shows up in the
     reported statement as a difference between what ran and what was typed. */
  return text.trim().replace(/\s*;+\s*$/, '');
}

/**
 * Wrap a statement so it cannot return more rows than asked for.
 *
 * `clampLimit` is the invariant everywhere else in this file, and it has no
 * application point in a statement this process did not build — there is no
 * request object to clamp. Wrapping is the equivalent: the database is asked
 * for a bounded result rather than trusted to have been asked politely.
 *
 * One more row than the caller wanted, so "there is more than this" is known
 * without a second query — the same trick `runView` uses.
 *
 * The limit is interpolated rather than bound, which is the one deliberate
 * exception to the rule that nothing is interpolated. It is an integer this
 * process computed from `clampLimit`, never a value that came from outside,
 * and it is asserted to be one before it is used. Binding it would need a
 * dialect-specific placeholder here *and* MySQL's decimal-string workaround
 * for row counts, which is a lot of machinery to parameterise a number we
 * chose ourselves.
 *
 * Not every statement can be wrapped — `EXPLAIN`, `PRAGMA`, a `WITH` that ends
 * in `INSERT … RETURNING` — so the caller is told whether it applied and can
 * fall back to running the statement bare and saying so.
 */
export function boundStatement(text: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`A row limit must be a positive integer, not ${String(limit)}.`);
  }
  /* The inner statement sits on its own line. A trailing line comment —
     `select * from huge -- note` — would otherwise swallow the closing
     parenthesis and the LIMIT with it, the wrap would fail to parse, and the
     fallback ran the statement *unbounded* and materialised every row before
     slicing. A newline ends the comment; the wrapper survives. */
  return `SELECT * FROM (\n${trimStatement(text)}\n) AS mistri_bounded LIMIT ${limit + 1}`;
}

/**
 * Refuse a statement that `EXPLAIN` would *execute* rather than plan.
 *
 * `EXPLAIN` is offered as the planner's account of a statement without
 * running it. `EXPLAIN ANALYZE …` (Postgres, MySQL 8.0.18+) and the option
 * form `EXPLAIN (ANALYZE) …` run the statement to measure it, so text that
 * begins with `analyze` or `(` turned a plan-only tool into an execute tool.
 * Both sit inside a read-only transaction, so no row could be written — but
 * a `pg_sleep(60)` or a full scan runs all the same, and the contract said
 * it would not. Leading comments are skipped so the check reads the
 * statement, not a note above it.
 */
export function refuseAnalyze(text: string): string | null {
  const first = trimStatement(text).replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '');
  if (/^(?:\(|analy[sz]e\b|explain\b)/i.test(first)) {
    return 'explain plans a statement without running it: give it the statement itself, not ' + 'an EXPLAIN, ANALYZE or (option) form.';
  }
  return null;
}

/**
 * Whether a statement is worth trying to wrap.
 *
 * A conservative first token test, and deliberately not a parse. Getting this
 * wrong in the cautious direction costs a bounded result; getting it wrong in
 * the other direction costs a confusing syntax error from the database about a
 * statement the user did not write. `WITH` is included because a CTE ending in
 * a SELECT is the common case, and the wrap failing on one that does not is
 * handled by the fallback rather than by being clever here.
 */
export function looksWrappable(text: string): boolean {
  const first = trimStatement(text).replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '');
  /* `(select …) union (select …)` is a SELECT too, and unwrapped it ran unbounded. */
  return /^(?:\(|(?:select|with|table|values)\b)/i.test(first);
}

export interface DeleteRequest {
  table: string;
  /** The whole primary key, and nothing else. */
  key: Record<string, string | number>;
}

export interface DeleteResult {
  affected: number;
  sql: { text: string; params: unknown[] };
}

/** Create a new row. Primary-key and other unique conflicts must fail, never
 * silently ignore, update, or replace an existing row through conflict policy.
 * SQLite explicitly uses OR ABORT; PostgreSQL/MySQL use plain INSERT. */
export interface InsertRequest {
  table: string;
  /**
   * Column name to value. The database fills whatever is left out — that is
   * what defaults are for — and refuses what it must, in its own words.
   */
  values: Record<string, string | number | boolean | null>;
}

export interface InsertResult {
  /** The new row's primary key, read back from the database. */
  key: Record<string, string | number>;
  /**
   * The row as the database stored it — defaults filled, types settled.
   * Absent only where the engine gives no way to read it back.
   */
  row?: Record<string, unknown>;
  /** Values after coercion to their column types, for the caller to confirm. */
  applied: Record<string, string | number | boolean | null>;
  sql: { text: string; params: unknown[] };
}

/**
 * A queue of one.
 *
 * Every adapter here writes through a single connection, and a transaction is
 * a span of statements on it that nothing else may enter. Node is
 * single-threaded but `await` is not: two requests arriving together interleave
 * at every await point, so a plain `/api/update` can land in the middle of
 * somebody's open transaction and be rolled back with it — a write that
 * succeeded, reported success, and then quietly did not happen.
 *
 * So writes queue. The cost is that two concurrent edits are applied one after
 * the other rather than at once, which is what a single connection was always
 * going to do anyway.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    /* The chain must not break on a failure: `catch` here keeps the *queue*
       going while the caller still gets the rejection from `next`. */
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
}

/**
 * Structured reads and writes on the same transaction connection.
 * This is not the whole adapter: no raw SQL, DDL, or cross-source access.
 * Reads see earlier writes from this callback. Methods expire when it ends;
 * callers must await operations and must not retain this handle for later.
 */
export interface WriteTransaction {
  /** Internal existing-row fence, held until this transaction ends. Call before
   * reading stored originals or comparing an inverse image. Returns no data and
   * grants no read/write authority. Missing keys do NOT reserve absence for a
   * later restore. Scoped writers may omit this capability; never fall back to
   * a plain SELECT when a fence is required. */
  lockRecord?(request: DeleteRequest): Promise<void>;
  query(request: QueryRequest): Promise<QueryResult>;
  count(table: string, filter?: Filter): Promise<number>;
  /** Non-replacing creation, including restoration: enforce InsertRequest's
   * conflict contract in this transaction. A prior absent-key lock/read is not
   * an absence reservation; uniqueness conflicts must still reject the insert. */
  insert(request: InsertRequest): Promise<InsertResult>;
  remove(request: DeleteRequest): Promise<DeleteResult>;
  update(request: UpdateRequest): Promise<UpdateResult>;
  /** Internal: a flow's notify step (appFlows.ts). The record's `notify` rules on `{ flow: audience }` tell their people
   * in this transaction, as a write's rules do, with the step's words. Writes nothing to the record. Only the flows'
   * own command reaches it, about its own target; a facade that cannot carry it omits it. */
  tell?(request: TellRequest): Promise<void>;
}

/** What a flow's notify step tells: whom (an audience a `notify` rule names `on: { flow }`), about which record, and its words. */
export interface TellRequest {
  table: string;
  key: Record<string, string | number>;
  audience: string;
  message: string;
}

/** Drain accepted operations before commit/rollback, then refuse escaped handles. */
export class TransactionOperations {
  private active = true;
  private operations = new Serial();
  private failure: { error: unknown } | undefined;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.active) return Promise.reject(new Refusal('This transaction is no longer active.'));
    const result = this.operations.run(async () => {
      // Some engine errors roll back the transaction themselves. Running a
      // later queued write (including a receipt) could then autocommit it.
      if (this.failure) throw this.failure.error;
      try {
        return await work();
      } catch (error) {
        this.failure = { error };
        throw error;
      }
    });
    // Fire-and-forget failures are still observed and rethrown by finish().
    void result.catch(() => {});
    return result;
  }

  async finish(): Promise<void> {
    this.active = false;
    await this.operations.run(async () => {});
    if (this.failure) throw this.failure.error;
  }
}

/** Capture before queue waits, including failures: a caught malformed lock must
 * still poison the owning transaction just like a failed database operation. */
export function queueRecordLock(
  operations: TransactionOperations,
  input: DeleteRequest,
  work: (request: DeleteRequest) => Promise<void>,
): Promise<void> {
  let request: DeleteRequest;
  let invalid: { error: unknown } | undefined;
  try {
    const data = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Refusal('Malformed record lock request.');
      const entries = Reflect.ownKeys(value).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
          throw new Refusal('Malformed record lock request.');
        return [key, descriptor.value] as const;
      });
      return Object.fromEntries(entries);
    };
    const root = data(input);
    if (typeof root.table !== 'string' || !root.table.length) throw new Refusal('Malformed record lock table.');
    const key = data(root.key);
    if (
      !Object.keys(key).length ||
      Object.values(key).some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
    )
      throw new Refusal('Malformed record lock key.');
    request = { table: root.table, key: key as DeleteRequest['key'] };
  } catch (error) {
    invalid = { error };
  }
  return operations.run(() => {
    if (invalid) throw invalid.error;
    return work(request!);
  });
}

/** Catalog-attested complete key only; callers supply the writer's metadata. */
export function recordLockFilter(request: DeleteRequest, primary: string[]): Filter {
  if (!primary.length) throw new Refusal(`${request.table} has no primary key, so no single row can be identified.`);
  if (Object.keys(request.key).length !== primary.length || primary.some((column) => !Object.hasOwn(request.key, column))) {
    throw new Refusal(`Locking ${request.table} needs exactly its primary key (${primary.join(', ')}).`);
  }
  return { groups: [primary.map((column) => ({ column, op: '=', value: request.key[column] }))] };
}

/** A bound private read capability. No writer, raw SQL, lifecycle owner or
 * way to replace its server-owned scope is handed to the consumer. */
export interface ScopedReads {
  query(request: QueryRequest): Promise<QueryResult>;
  /** With `limit`, stops after that many matching rows (countStatement). */
  count(table: string, filter?: Filter, limit?: number): Promise<number>;
  runView(view: ViewDef, offset?: number): Promise<ViewResult>;
  /** With `limit`, stops after that many matching rows, as `count` does. */
  countView(view: ViewDef, limit?: number): Promise<number>;
  runBreakdown(breakdown: BreakdownDef, offset?: number): Promise<BreakdownResult>;
  /** With `limit`, stops after that many groups, as `count` does. */
  countBreakdown(breakdown: BreakdownDef, limit?: number): Promise<number>;
  /** Several `count`s in one statement, each under the scope and its own filter
   * (a menu's badges); absent on a reader that counts one at a time. */
  countEach?(items: readonly CountItem[], limit?: number): Promise<number[]>;
}

/** A role's reach beyond reading: each a phrase for the startup notice. */
export interface RolePrivileges {
  superuser: boolean;
  /** Write privileges within what the connection browses, e.g. "INSERT/UPDATE/DELETE on 12 tables". */
  writes: string[];
  /** May create objects in a browsed schema or database. */
  create: boolean;
}

export interface Adapter {
  readonly dialect: DatabaseSchema['dialect'];

  /** Optional explicit capability, never fall back to ordinary reads when absent.
   * This read-only foundation does not authorize writes or resolve identity. */
  scopeReads?(scope: RowScope): Promise<ScopedReads>;

  /** Private same-source row enforcement; never substitute an ordinary
   * transaction when this capability is absent. No command journal implied.
   * Catalog evidence is detached, immutable and read on this same transaction;
   * permission facades must attest it before using cached field/graph grants. */
  scopeTransaction?<T>(scope: RowScope, run: (tx: WriteTransaction, catalog: DatabaseSchema) => Promise<T>): Promise<T>;

  /** Read the catalog once on connect. Not per request. */
  introspect(): Promise<DatabaseSchema>;

  /**
   * What this connection's database role could do beyond reading. Every read
   * here runs in a read-only transaction, which holds for everything tablewalk
   * sends but not for a superuser (`COPY … TO PROGRAM` is a read); the role is
   * the boundary that always holds. Absent where there is no role (SQLite).
   */
  privileges?(): Promise<RolePrivileges>;

  /**
   * The connection pools' meters (poolMetrics.ts): checkouts, the wait for a
   * connection, how long each was held, how many are in use and queued now.
   * Absent where the adapter keeps no pool: SQLite, MySQL's two single
   * connections, an HTTP source.
   */
  poolStats?(): readonly PoolRoleStats[];

  /**
   * What the database thinks a table holds, without counting.
   *
   * Optional, and unfiltered by nature: the catalog knows roughly how many rows
   * a table has and nothing whatever about how many match a `WHERE`. An adapter
   * whose engine keeps no such statistic returns undefined and gets an exact
   * count, which is the honest outcome rather than a fabricated one.
   *
   * The number can be wrong — badly wrong on InnoDB, which samples index dives,
   * and stale on Postgres until the next ANALYZE. That is why it is reported as
   * an estimate everywhere it is shown, and why the exact count stays one click
   * away.
   */
  estimateCount?(table: string): Promise<number | undefined>;

  /**
   * Run a statement the user wrote.
   *
   * Optional, because an adapter that cannot make the read genuinely read-only
   * should not offer it at all. An implementation must:
   *
   *   - run a read inside a transaction the statement cannot promote, not
   *     merely on a connection that is configured read-only — a session
   *     default the statement can reset is not a guarantee;
   *   - refuse `write` unless it has a separate write handle, and never run a
   *     write on the browsing connection;
   *   - report `bounded` honestly, so the caller can say "the database did the
   *     whole job" rather than implying a limit that was not applied.
   */
  runSql?(request: SqlRequest): Promise<SqlResult>;

  /**
   * The planner's account of how a statement would run, without running it.
   *
   * The question a query author actually has — "does this use the index or
   * walk the table" — and the one `runSql` cannot answer, because its bounding
   * wrap makes the statement it explains a different statement. Plans, never
   * executes: implementations must not allow the analysing variants that run
   * the statement to time it, which on a write would be the write.
   */
  explainSql?(request: ExplainRequest): Promise<ExplainResult>;

  /**
   * What a table's columns actually hold: null share, distinct count, range,
   * and the values that repeat most.
   *
   * Optional because the honest cost differs by engine — Postgres reads
   * numbers the planner already keeps, SQLite has to look — and the result
   * says which happened, so the caller can decide whether to ask twice.
   */
  profile?(table: string, limits?: ProfileLimits): Promise<ProfileResult>;

  /** Run a read. Adapters must reject anything that is not a read. */
  query(request: QueryRequest): Promise<QueryResult>;

  /**
   * Run a multi-table view.
   *
   * Optional, and thin by design: `compileView` in shared/view.ts does all the
   * work — resolving paths, planning joins, numbering placeholders — so an
   * adapter that implements this only picks its `SqlStyle`, runs the statement
   * and maps the rows. Anything an adapter decided for itself here would be a
   * second join builder to keep in step with the first, and the join builder
   * is exactly where the LEFT-versus-INNER mistake lives.
   */
  runView?(view: ViewDef, offset?: number): Promise<ViewResult>;

  /**
   * How many rows a view matches, ignoring the page.
   *
   * Separate from `count` because a view's WHERE clause addresses paths, not
   * columns, so the joins have to exist for the predicate to compile at all.
   * Optional alongside `runView`: an adapter that can run a view can count
   * one, and one that cannot has no use for either. With `limit`, stops
   * after that many matching rows (countStatement), as `count` does.
   */
  countView?(view: ViewDef, limit?: number): Promise<number>;

  /**
   * Run a breakdown: counts and sums, grouped by something.
   *
   * Thin for the same reason `runView` is thin — `compileBreakdown` does the
   * work and the adapter picks a style and runs the statement. The one thing
   * it contributes is `dateBucket`, because cutting a timestamp down to a
   * month is the single part of this that no two engines spell alike.
   */
  runBreakdown?(breakdown: BreakdownDef, offset?: number): Promise<BreakdownResult>;

  /** How many groups there are, ignoring the page. With `limit`, stops after that many. */
  countBreakdown?(breakdown: BreakdownDef, limit?: number): Promise<number>;

  /**
   * Count matching rows, for pagination and the "how many point here" badge.
   * With `limit`, stop after that many matching rows (countStatement): the
   * answer is exact below the bound and the bound itself at or above it.
   */
  count(table: string, filter?: Filter, limit?: number): Promise<number>;

  /**
   * Several counts in one statement (countEachStatement), in the items' order,
   * each with `limit` as `count` takes it. A list's tab badges and a record's
   * references were a statement — and on a pool, a round trip — apiece.
   *
   * Optional, and absent on every wrapper that has not said how it guards it:
   * an access layer builds its adapter from the methods it checks, so a
   * missing one is refused rather than passed through, and the caller falls
   * back to `count` per item (resourceReadOperations.readCounts). A row-scoped
   * reader has none, so its counts keep compiling under its scope one by one.
   */
  countEach?(items: readonly CountItem[], limit?: number): Promise<number[]>;

  /**
   * The database's own stored DDL, when it keeps one.
   *
   * Optional on purpose. SQLite keeps the original `CREATE TABLE` text in
   * `sqlite_master` and can hand it back exactly; Postgres does not store one
   * (pg_dump reconstructs it too). Adapters that cannot be exact should not
   * implement this — the caller falls back to `renderDDL` and labels the
   * result as reconstructed, which is honest rather than convenient.
   */
  ddl?(table: string): Promise<string | undefined>;

  /**
   * Update exactly one column of exactly one row.
   *
   * Optional, and separate from `query` on purpose: the read path has no way
   * to express a write, and adding one would mean every reader had to be
   * trusted not to. An adapter that implements this opens its own write
   * connection lazily — the browsing connection stays read-only for the life
   * of the process.
   *
   * Implementations must refuse unless the filter matches exactly one row.
   * The danger in a cell editor is never injection; it is an UPDATE whose
   * WHERE is broader than the author believed.
   */
  update?(request: UpdateRequest): Promise<UpdateResult>;
  /** Add one row. Absent on read-only dialects, like every other write. */
  insert?(request: InsertRequest): Promise<InsertResult>;

  /**
   * Remove one row, having proved it is one row.
   *
   * The same contract as `update`: the exact primary key, a pre-flight count,
   * and a refusal unless it matches exactly one. What is
   * *not* an adapter's job is deciding whether the row should go — what
   * references it, and what the database will do to those references, is
   * answered above this layer where the schema is in hand.
   *
   * Constraint violations are left to the database. A `RESTRICT` that fires is
   * the correct outcome reported in the engine's own words, and re-deriving
   * that judgement here would be a second implementation of a rule the database
   * already enforces — which is exactly how the two come to disagree.
   */
  remove?(request: DeleteRequest): Promise<DeleteResult>;

  /**
   * Several writes as one, or none of them.
   *
   * A fixture is a graph — an invoice needs its customer, the customer needs
   * its country — and inserting it one call at a time means a ten-row fixture
   * that fails at row seven leaves six rows and a dirty database. That is
   * worse than failing, because the database now holds something nobody
   * designed and nothing named.
   *
   * The callback gets same-connection reads and writes: see `WriteTransaction`. It is run
   * behind the same queue as every other write, so nothing outside can land
   * inside the transaction and be rolled back with it.
   *
   * Optional like the writes themselves. An adapter that cannot write cannot
   * offer this, and one that can should: the guarantee is the engine's, and
   * all three of these engines have it.
   *
   * A failure after a commit attempt or without confirmed rollback must throw
   * TransactionOutcomeUnknown. Other failures mean no callback write committed.
   * This outcome contract is required by Undo; atomicity alone cannot establish
   * what happened when an acknowledgement was lost.
   */
  transaction?<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T>;

  /* The App framework's command transactions (`commandTransaction` and the
     rest) are declared onto this interface by the App framework itself
     (commands/commandJournalTypes.ts): an adapter that hosts its journal
     offers them, and the engine neither calls nor names them. */

  close(): Promise<void>;
}

export interface UpdateRequest {
  table: string;
  /** Primary key columns and their values. Must identify one row. */
  key: Record<string, string | number>;
  /**
   * Column name to new value. Several at once on purpose.
   *
   * Editing three fields as three statements means three chances to fail
   * half way, leaving a row in a state the user never asked for. One
   * statement either applies or does not.
   */
  values: Record<string, string | number | boolean | null>;
  /**
   * Set only by history's revert: a record returning to its recorded
   * before-image is not a new transition (server/app/appTransitions.ts).
   */
  restore?: true;
  /** Original values for exactly the touched fields; checked atomically by UPDATE. */
  expected?: Record<string, string | number | boolean | null>;
}

export interface UpdateResult {
  affected: number;
  /** Values after coercion to their column types, for the caller to confirm. */
  applied: Record<string, string | number | boolean | null>;
  sql: { text: string; params: unknown[] };
}
