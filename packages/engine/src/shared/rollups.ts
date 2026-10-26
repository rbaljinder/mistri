/**
 * Rollups: one number about the rows that point at a record — an order's
 * line total, an account's open deals — declared once on the resource
 * (`rollups: { line_total: sum('order_line', 'amount') }`) and read wherever
 * a column of the record is: a list's `show`, a sort, a tab's condition, a
 * record page's fields, a card's figure and facts, a queue's facts, a
 * picker's query, a dashboard's measure and a breakdown's key — and through
 * a reference, as `sales_order_id.lines`, wherever a path is.
 *
 * A rollup is never a column of the table. It is not in `TableMeta.columns`,
 * so every path that reads one table by its own columns — an insert form, a
 * plain `/api/query`, an export of the table, a filter box built from the
 * schema — never sees it and never sends it to a single-table read, which
 * would be a statement naming a column the database does not have. It lives
 * beside the columns (`TableMeta.rollups`), where the path resolver finds it
 * by name, and it is compiled only by the view compiler, as a correlated
 * scalar subquery through one reference: the same construction as a view's
 * aggregates (viewPaths.ts says why a subquery rather than a grouped join),
 * so a list still has one row per record however many rollups it shows.
 *
 * The child rows are read through the statement's own relations
 * (rowScope.ts), so a row policy or a tenant scope on the child narrows the
 * number exactly as it narrows a related list of the same rows, and a reader
 * whose catalog cannot see the child table, its column or the reference is
 * served no rollup at all (appRollupRules), rather than a number built from
 * rows they may not read.
 */
import type { Filter } from './filter.js';
import type { ComputedColumn } from './computed.js';
import type { ColumnMeta } from './schema.js';

export const ROLLUP_FNS = ['count', 'sum', 'min', 'max', 'latest'] as const;
export type RollupFn = (typeof ROLLUP_FNS)[number];

/** A rollup as the catalog serves it and a view carries it: no request ever supplies one. */
export interface Rollup {
  fn: RollupFn;
  /**
   * The reference from the child rows to the record, as `child.column`
   * (`+`-joined for a composite key): endpoints rather than a constraint
   * name, so a layer that renames tables (an App's logical names, a
   * source's prefix) can rewrite it without resolving anything.
   */
  via: string;
  /** The child's column; absent for a count. */
  column?: string;
  /**
   * A `latest`'s order: the child's column whose greatest value is the latest row (its key breaks a tie), and
   * whose `column` the rollup reads — a payment's status, the last visit's outcome. A word about the rows, not a
   * figure, so it is never summed. Through two references it is the inner level's: the outer reads the newest of
   * all the rows joined to their middle record, not the newest of each middle's newest (viewLabels.ts).
   */
  by?: string;
  /**
   * A `latest` that reads a reference column (the newest lease's `resident_id`): the record it points at, so the value
   * is drawn as that record's name and link and never as its key (referenceModel.ts).
   */
  references?: { table: string; column: string };
  /**
   * Set only on a rollup a path reads *through* (`resident.name`, viewPaths.ts): the value wanted is this column of the
   * record the rollup's key names, read through that table's own relation, so a row policy narrows it as it narrows a
   * join to the same record. The reader must be able to read both (rollupReads).
   */
  through?: { table: string; key: string; column: string };
  /** A `latest`'s vocabulary: the child column's own, so the word it reads is drawn, filtered and typed as that column is. */
  allowed?: string[];
  /**
   * Set when `column` names a computed column of the child (computed.ts)
   * rather than a stored one: its expression, constants folded, written
   * inline over the child's row inside the aggregate — the same SQL a list
   * of the child writes for it. It reads the child's own columns only, never
   * a rollup or a reference (appRollupRules refuses those), so a rollup over
   * it is still one subquery, and no rollup can come to read itself.
   */
  expression?: Pick<ComputedColumn, 'type' | 'expr' | 'reads'>;
  /** Which child rows count — the rollup's `query`, over the child's own columns and paths through its references. */
  filter?: Filter;
  /**
   * The computed columns of the child that `filter` names (`breached = true`), each its expression, constants
   * and `now` folded: written over the row inside the narrowed relation, as `expression` is inside the aggregate.
   * Each reads the child's own columns only (appRollupRules), so the figure is still one subquery.
   */
  computed?: Record<string, Pick<ComputedColumn, 'type' | 'expr' | 'reads'>>;
  /**
   * The tables a path in `filter` walks to, with the columns read there (`sales_order_id.status` reads
   * `sales_order.id` and `sales_order.status`): what a reader must be able to read for the figure to be
   * served (rollupReads), as the child's own columns are.
   */
  reach?: Array<{ table: string; fields: string[] }>;
  /** The value's type: an integer for a count, the column's own otherwise. */
  type: string;
  /**
   * Set when `column` names a rollup of the child rather than one of its
   * columns — a customer's `lines: sum('sales_order', 'lines')`, the count
   * of its orders' lines, which is how a rollup reaches two hops. The inner
   * rollup is compiled inside the outer one's aggregate, each through its own
   * child's relation, so a row policy narrows both levels. One level only:
   * the inner one reads a column (appRollupRules says so when it does not).
   *
   * A rollup whose `whose` walks two references (`sum('time_entry', 'hours',
   * { whose: 'task_id.project_id' })`) is served in the same shape: the outer
   * reads the middle table (`task.project_id`) with no column of its own,
   * the inner the rows and column declared, with the declared query. A count
   * so built is the sum of the inner counts, and 0 where there are none; a
   * max of maxes and a min of mins are the max and min of the rows; a latest
   * is one ordered read over the rows joined to the middle table. The
   * access layer holds a reader to both levels' tables and fields
   * (rollupReads), as it does a rollup of a rollup.
   */
  of?: Rollup;
}

/**
 * A rollup a view names, keyed by its path in `ViewDef.computed`: the rollup
 * and the path prefix of the record it hangs off ('' for the view's base).
 */
export interface ComputedPath extends Rollup {
  on: string;
}

/** A rollup read as a column: never written, null only where there are no rows to read (a count is 0). */
export function rollupColumnMeta(name: string, rollup: Pick<Rollup, 'fn' | 'type' | 'allowed' | 'references'>): ColumnMeta {
  return {
    name,
    type: rollup.type,
    nullable: rollup.fn !== 'count',
    primaryKey: false,
    writable: false,
    ...(rollup.allowed ? { allowed: rollup.allowed } : {}),
    ...(rollup.references ? { references: rollup.references } : {}),
  };
}

/** The child table a rollup's `via` names. */
function rollupChild(via: string): string {
  return via.slice(0, via.lastIndexOf('.'));
}

/** `via` with its child table renamed — a layer mapping logical names to physical ones. */
function renamedVia(via: string, rename: (table: string) => string): string {
  const dot = via.lastIndexOf('.');
  return `${rename(via.slice(0, dot))}${via.slice(dot)}`;
}

/** A rollup with every child table it reads renamed, the inner one's too. */
function renamedRollup<R extends Rollup>(rollup: R, rename: (table: string) => string): R {
  return {
    ...rollup,
    via: renamedVia(rollup.via, rename),
    ...(rollup.reach ? { reach: rollup.reach.map((read) => ({ ...read, table: rename(read.table) })) } : {}),
    ...(rollup.references ? { references: { ...rollup.references, table: rename(rollup.references.table) } } : {}),
    ...(rollup.through ? { through: { ...rollup.through, table: rename(rollup.through.table) } } : {}),
    ...(rollup.of ? { of: renamedRollup(rollup.of, rename) } : {}),
  };
}

/** A view's or a breakdown's `computed` with every child table renamed. */
export function renamedComputed<T extends { computed?: Record<string, ComputedPath> }>(def: T, rename: (table: string) => string): T {
  return def.computed
    ? { ...def, computed: Object.fromEntries(Object.entries(def.computed).map(([path, rollup]) => [path, renamedRollup(rollup, rename)])) }
    : def;
}

/**
 * Every table a rollup reads rows of, with the fields it reads there: the
 * reference it walks, the column it sums (not an inner rollup's name, which
 * is no field, nor a computed column's, whose own reads stand for it) and
 * the columns its query narrows by — the inner rollup's too. What an access
 * layer holds a reader's grants against.
 */
export function rollupReads(rollup: Rollup): Array<{ table: string; fields: string[] }> {
  const table = rollupChild(rollup.via);
  const fields = [
    ...rollup.via.slice(table.length + 1).split('+'),
    ...(rollup.expression ? rollup.expression.reads : rollup.column && !rollup.of ? [rollup.column] : []),
    ...(rollup.by === undefined ? [] : [rollup.by]),
    // A path's first hop is the child's own reference column; the rest is in `reach`.
    ...(rollup.filter?.groups ?? []).flatMap((group) =>
      group.flatMap((c) =>
        [c.column, ...(c.other === undefined ? [] : [c.other])].flatMap((name) =>
          // A computed column's own reads stand for it, as `expression`'s do.
          rollup.computed && Object.hasOwn(rollup.computed, name) ? rollup.computed[name].reads : name.split('.')[0].split('+'),
        ),
      ),
    ),
  ];
  return [
    { table, fields },
    ...(rollup.reach ?? []),
    ...(rollup.of ? rollupReads(rollup.of) : []),
    ...(rollup.through ? [{ table: rollup.through.table, fields: [rollup.through.key, rollup.through.column] }] : []),
  ];
}
