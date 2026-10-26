/*
 * The view model and its reference paths: what a view holds, and how a path
 * or an aggregate resolves against the foreign-key graph to the tables and
 * columns it names. view.ts compiles what resolves here into SQL.
 */
import { type AnyRows, type Op } from './filter.js';
import { findTable, isJsonType, referencesFrom, type ColumnMeta, type DatabaseSchema, type ForeignKey, type TableMeta } from './schema.js';
import { nearest, shortList } from './suggest.js';
import { LABEL_SEGMENT } from './recordLabel.js';
import { rollupColumnMeta, type ComputedPath, type Rollup } from './rollups.js';
import { computedColumnMeta, type ComputedColumn, type ComputedPath as ExpressionPath } from './computed.js';
import { TAGS_COLUMN, tagsColumnMeta, type TagPath, type TagSet } from './tagLists.js';
import { DEFINED_KEY, definedColumnMeta } from './definedFields.js';

/* ---------- the model ---------- */

/** One column of a view: a path, and optionally what to call it. */
export interface ViewColumn {
  path: string;
  /** Output name. Defaults to the path itself, which is already unique. */
  alias?: string;
}

/** One condition. Identical to `Condition` except that it addresses a path. */
export interface ViewCondition {
  path: string;
  op: Op;
  value?: string | number | boolean | Array<string | number>;
  /** As on `Condition`: compare by bytes; only comparisons take it. */
  collation?: 'binary';
  /** As on `Condition`: compare with this path's value rather than `value`. */
  other?: string;
  /**
   * As on `Condition`: the rows that point at this one, asked whether any
   * matches. `path` is then the condition as it is written (`any opportunity
   * where stage = won`), for a reader to say back; the compiler reads `any`.
   */
  any?: AnyRows;
}

/** OR-of-ANDs over paths — the same shape as `Filter`, one level out. */
export interface ViewFilter {
  groups: ViewCondition[][];
}

export interface ViewOrder {
  path: string;
  direction: 'asc' | 'desc';
  /**
   * When true, `path` names an aggregate's output alias rather than a
   * column: `sort invoices desc` after `count invoice … as invoices`.
   * Compiled as the quoted alias, which every dialect here accepts in an
   * ORDER BY — the one clause that runs late enough to see it.
   */
  alias?: boolean;
  /**
   * Closest first: order by the distance of `path` from this number rather
   * than by `path` itself — a similar list's nearest price. Written into the
   * ORDER BY as a literal, so it must be a finite, safe number; anything
   * else is refused, never quoted.
   */
  near?: number;
  /**
   * Order text by its bytes, not by the column's collation, so that a keyset
   * cursor's comparison (`collation` on a condition) agrees with the order it
   * resumes. A column only: an alias or a distance is refused with it.
   */
  collation?: 'binary';
  /**
   * Nulls after every value, in either direction, on every dialect: the order
   * a keyset cursor over a nullable column resumes (apiReadBoundary).
   */
  nulls?: 'last';
}

/* ---------- the other direction ----------

   A reference path walks *forwards*, along a foreign key from the row that
   holds it, so it always lands on at most one row. That is what lets a view
   promise one row per base record.

   The backwards direction — the rows that point *at* you — is the more
   interesting question and the one the tool is built around, but it is
   many-valued, and joining it multiplies: a work order with four parts and
   three notes becomes twelve rows, each repeating the work order's own
   columns, and the number on screen stops meaning work orders. Almost nobody
   asking for "work orders with their parts" wants that.

   An aggregate is the honest one-row-per-record answer to a many-valued
   question. It compiles to a correlated scalar subquery, which is worth
   preferring over a grouped join for three reasons: cardinality cannot change
   no matter how many aggregates are added, each one is independent so two
   counts over different children cannot inflate each other, and it carries no
   parameters — so the placeholder numbering that Postgres cares about is
   untouched by however many of these a view collects. */

export type AggregateFn = 'count' | 'sum' | 'min' | 'max' | 'avg';

export interface ViewAggregate {
  fn: AggregateFn;
  /**
   * The foreign key pointing back at the parent, by constraint name.
   *
   * A name rather than a table, because a table can point at the same parent
   * more than once — `work_order.parent_id` and `work_order.supersedes_id`
   * are two different questions and "count of work_orders" is neither.
   */
  via: string;
  /** Path prefix naming the parent the children point at. Empty is the base. */
  on?: string;
  /** Column on the child table. Required for everything except `count`. */
  column?: string;
  alias?: string;
}

export interface ViewDef {
  id: string;
  name: string;
  /** Base table id. Every path in the view starts here. */
  base: string;
  columns: ViewColumn[];
  /** Scalar summaries of many-valued relationships. */
  aggregates?: ViewAggregate[];
  filter?: ViewFilter;
  orderBy?: ViewOrder[];
  limit?: number;
  /**
   * The view written down, in the same language.
   *
   * When present it is the definition and the structure above is derived from
   * it — a config file holding `work_order show reference, customer_id.name
   * as customer count work_order_part via work_order_id as parts` is a file
   * someone can review in a pull request, which a nest of JSON objects with
   * `op: "contains"` in it is not.
   */
  text?: string;
  /** Config-defined views may name the connection they belong to. */
  connection?: string;
  /** Where this came from. Absent means the client's own storage. */
  source?: 'config' | 'saved';
  /**
   * The record-label templates its `$label` paths compile from, by the path
   * prefix each hangs off ('' for the base's own). Filled by the server's
   * read from the App's catalog (recordLabel.ts); a request never supplies it.
   */
  labels?: Record<string, string>;
  /**
   * The rollups its paths name (rollups.ts), by path: what makes `line_total`
   * or `customer_id.open_deals` a correlated subquery rather than a column.
   * Filled by the server's read from the App's catalog, like `labels`, and
   * carried with the view so a layer whose catalog is the database's own
   * (an adapter, a source) compiles the same statement; a request never
   * supplies it.
   */
  computed?: Record<string, ComputedPath>;
  /**
   * The computed columns its paths name (computed.ts), by path, each with its
   * expression and the prefix of the record it is on: filled from the App's
   * catalog like `computed`, so an adapter writes the same expression; a
   * request never supplies it.
   */
  expressions?: Record<string, ExpressionPath>;
  /**
   * The record tags its paths name (tagLists.ts), by path: filled from the
   * App's catalog like `computed`, so an adapter writes the same subquery; a
   * request never supplies them.
   */
  tagged?: Record<string, TagPath>;
  /**
   * The App's declared references (soft keys) the view may walk, as edges of
   * the catalog it is compiled against (declaredReferences.ts). Attached by
   * the App's resource layer, where a catalog that is the database's own
   * does not have them; a request never supplies them.
   */
  references?: ForeignKey[];
}

/**
 * How many foreign keys a path may follow.
 *
 * A cap is not a nicety: `work_order.parent_id` points at `work_order`, so the
 * path space is infinite and any breadth-first enumeration of it runs forever.
 * Four hops is past the point where anyone can still read the result, and the
 * limit is stated in the error rather than left to be discovered.
 */
export const MAX_PATH_DEPTH = 4;

/** What a `$label` path ends on: text, and empty where the row is missing. */
export const labelColumnMeta = (): ColumnMeta => ({ name: LABEL_SEGMENT, type: 'TEXT', nullable: true, primaryKey: false });

/* ---------- errors ---------- */

/**
 * A path that does not resolve, with the segment that failed.
 *
 * The segment matters more than the path: `customer_id.country_code.nmae` is
 * four words of which one is wrong, and an error that repeats the whole path
 * makes you find the wrong one yourself.
 */
export class PathError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly segment: string,
    /** Index of the failing segment within the path, 0-based. */
    readonly index: number,
  ) {
    super(message);
    this.name = 'PathError';
  }
}

/* ---------- hops ---------- */

/**
 * What a hop is called in a path.
 *
 * A single-column foreign key is named by its column, which is what anyone
 * would write and what the composer shows. A composite key has no single
 * column to name it, so its columns are joined with `+` — deterministic,
 * derivable from the model alone, and impossible to confuse with a column
 * name because `+` is not legal in one.
 */
export function hopName(fk: ForeignKey): string {
  return fk.from.columns.length === 1 ? fk.from.columns[0] : fk.from.columns.join('+');
}

export interface Hop {
  /** What to write in a path. */
  name: string;
  fk: ForeignKey;
  /** The table this hop lands on. */
  target: string;
  /** True when every column of the key is nullable — the row may not exist. */
  optional: boolean;
}

/** Every forward hop available from a table, in a stable order. */
export function hopsFrom(schema: DatabaseSchema, tableId: string): Hop[] {
  const table = findTable(schema, tableId);
  return referencesFrom(schema, tableId).map((fk) => ({
    name: hopName(fk),
    fk,
    target: fk.to.table,
    optional: fk.from.columns.some((c) => table?.columns.find((col) => col.name === c)?.nullable !== false),
  }));
}

/** A table's rollup of that name where it is a latest of a reference column: the record it names can be read through it. */
function latestReference(table: TableMeta, name: string): Rollup | undefined {
  const rollup = table.rollups && Object.hasOwn(table.rollups, name) ? table.rollups[name] : undefined;
  return rollup?.fn === 'latest' && rollup.references && !rollup.of ? rollup : undefined;
}

export interface ResolvedPath {
  path: string;
  /** The foreign keys followed, in order. Empty for a plain column. */
  hops: ForeignKey[];
  hopNames: string[];
  /** The table the final column lives on. */
  table: TableMeta;
  column: ColumnMeta;
  /** Set when the path ends on a rollup of `table` rather than a column (rollups.ts). */
  rollup?: Rollup;
  /** With `rollup`: the prefix of the record the rollup is on, where that is not the path's own (a path read through the rollup, below). */
  rollupAt?: string;
  /** Set when the path ends on a computed column of `table` (computed.ts). */
  computed?: ComputedColumn;
  /** Set when the path ends on the record's tags (tagLists.ts). */
  tags?: TagSet;
  /** Set when the path reads one key of a JSON column (`specs.capacity`, definedFields.ts): the column and the key. */
  jsonKey?: { column: string; key: string };
}

/**
 * Resolve a path against the schema, or explain precisely why it does not.
 *
 * Every hop is checked against the foreign key graph, so an unknown segment is
 * an error here rather than a database exception later — or, far worse, a
 * silently empty result that looks like a table with nothing in it.
 */
export function resolvePath(schema: DatabaseSchema, baseId: string, path: string): ResolvedPath {
  /* A path means the same against the same catalog, and a list asks for each
     of its columns' paths on every request, per row's worth of fields. Kept
     per schema object, so a reloaded App or a new catalog starts empty; a
     refused path is not kept (it throws, and is the rare one). The result is
     frozen, shared by every caller. */
  let kept = resolved.get(schema);
  if (!kept) resolved.set(schema, (kept = new Map()));
  const key = `${baseId}\u0000${path}`;
  const hit = kept.get(key);
  if (hit) return hit;
  const made = resolvePathFresh(schema, baseId, path);
  Object.freeze(made.hops);
  Object.freeze(made.hopNames);
  // A reader can type paths (a query's `a.b.c`), and a path may loop through
  // the graph, so what is kept is bounded; the declared ones come straight back.
  if (kept.size >= MAX_KEPT_PATHS) kept.clear();
  kept.set(key, Object.freeze(made));
  return made;
}

const resolved = new WeakMap<DatabaseSchema, Map<string, ResolvedPath>>();
const MAX_KEPT_PATHS = 2048;

function resolvePathFresh(schema: DatabaseSchema, baseId: string, path: string): ResolvedPath {
  const raw = String(path ?? '').trim();
  if (!raw) throw new PathError('A path cannot be empty.', raw, '', 0);

  const segments = raw.split('.');
  const blank = segments.findIndex((s) => s.trim() === '');
  if (blank !== -1) {
    throw new PathError(`"${raw}" has an empty segment — two dots in a row, or a trailing dot.`, raw, '', blank);
  }

  const hopCount = segments.length - 1;
  if (hopCount > MAX_PATH_DEPTH) {
    throw new PathError(
      `"${raw}" follows ${hopCount} references; at most ${MAX_PATH_DEPTH} are allowed. ` +
        'Deeper walks are usually two views rather than one.',
      raw,
      segments[MAX_PATH_DEPTH],
      MAX_PATH_DEPTH,
    );
  }

  let table = findTable(schema, baseId);
  if (!table) {
    throw new PathError(`No table called "${baseId}" in this database.`, raw, segments[0], 0);
  }

  const hops: ForeignKey[] = [];
  const hopNames: string[] = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const available = hopsFrom(schema, table.id);
    const matches = available.filter((h) => h.name === segment || h.fk.name === segment);
    /* The last step after a latest that reads a reference is a column of the record it names (`resident.name`): the
       rollup's key, read through that table's own relation (viewLabels.ts), so a list draws the name beside the key. */
    const through = !matches.length && i === segments.length - 2 ? latestReference(table, segment) : undefined;
    if (through) {
      const target = findTable(schema, through.references!.table);
      const wanted = segments[i + 1];
      const read = target?.columns.find((c) => c.name === wanted);
      if (!target || !read) {
        throw new PathError(`"${wanted}" is not a column on ${target?.name ?? through.references!.table}.`, raw, wanted, i + 1);
      }
      return {
        path: raw,
        hops,
        hopNames,
        table,
        column: read,
        rollup: { ...through, through: { table: target.id, key: through.references!.column, column: read.name } },
        rollupAt: hopNames.join('.'),
      };
    }
    /* The last step after a JSON column is one of its keys (`specs.capacity`):
       a value the definition rows name (definedFields.ts), read, filtered and
       sorted like a column. A reference of the same name wins. */
    const json =
      !matches.length && i === segments.length - 2 ? table.columns.find((c) => c.name === segment && isJsonType(c.type)) : undefined;
    if (json) {
      const key = segments[i + 1];
      if (!DEFINED_KEY.test(key))
        throw new PathError(`"${key}" is not a key "${segment}" can hold; a key is a name of letters, digits and _.`, raw, key, i + 1);
      return { path: raw, hops, hopNames, table, column: definedColumnMeta(key), jsonKey: { column: json.name, key } };
    }
    if (!matches.length) {
      /* A real column that simply is not a reference is the commonest
         mistake, and deserves its own sentence: "total is not a reference"
         beats "total is not one of customer_id, sold_by". */
      const isColumn = table.columns.some((c) => c.name === segment);
      const names = available.map((h) => h.name);
      const suggestion = nearest(segment, names);
      const hint = suggestion
        ? ` Did you mean "${suggestion}"?`
        : names.length
          ? ` ${table.name} references: ${shortList(names)}.`
          : ` ${table.name} has no foreign keys.`;
      throw new PathError(
        isColumn
          ? `"${segment}" is a column on ${table.name}, not a reference, so nothing can follow it.${hint}`
          : `"${segment}" is not a reference on ${table.name}.${hint}`,
        raw,
        segment,
        i,
      );
    }
    if (matches.length > 1) {
      throw new PathError(
        `"${segment}" is ambiguous on ${table.name} — ${matches.length} foreign keys match. ` +
          `Name the constraint instead: ${shortList(matches.map((m) => m.fk.name))}.`,
        raw,
        segment,
        i,
      );
    }
    const next = findTable(schema, matches[0].target);
    if (!next) {
      throw new PathError(`"${segment}" points at "${matches[0].target}", which is not in this schema.`, raw, segment, i);
    }
    hops.push(matches[0].fk);
    hopNames.push(matches[0].name);
    table = next;
  }

  const last = segments[segments.length - 1];
  if (last === LABEL_SEGMENT) {
    if (!table.labelTemplate) {
      throw new PathError(
        `${table.name} has no record label template, so "${LABEL_SEGMENT}" names nothing on it.`,
        raw,
        last,
        segments.length - 1,
      );
    }
    return { path: raw, hops, hopNames, table, column: labelColumnMeta() };
  }
  const column = table.columns.find((c) => c.name === last) ?? table.columns.find((c) => c.name.toLowerCase() === last.toLowerCase());
  /* A rollup is found by its exact name only, and after the columns: the
     catalog never serves one that shares a column's name, so this order
     only matters to a hand-made catalog, where the column wins. */
  const rollup = column ? undefined : table.rollups && Object.hasOwn(table.rollups, last) ? table.rollups[last] : undefined;
  if (rollup) return { path: raw, hops, hopNames, table, column: rollupColumnMeta(last, rollup), rollup };
  const computed = column ? undefined : table.computed && Object.hasOwn(table.computed, last) ? table.computed[last] : undefined;
  if (computed) return { path: raw, hops, hopNames, table, column: computedColumnMeta(last, computed), computed };
  if (!column && last === TAGS_COLUMN && table.tags)
    return { path: raw, hops, hopNames, table, column: tagsColumnMeta(), tags: table.tags };
  if (!column) {
    const suggestion = nearest(
      last,
      table.columns.map((c) => c.name),
    );
    throw new PathError(
      `"${last}" is not a column on ${table.name}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
      raw,
      last,
      segments.length - 1,
    );
  }

  return { path: raw, hops, hopNames, table, column };
}

/* ---------- many-valued relationships ---------- */

interface Backref {
  /** What to write in an aggregate's `via`. */
  name: string;
  fk: ForeignKey;
  /** The table holding the key — the "many" end. */
  child: string;
}

/** Every foreign key pointing at a table: the "what refers to me" direction. */
export function backrefsTo(schema: DatabaseSchema, tableId: string): Backref[] {
  return schema.foreignKeys.filter((fk) => fk.to.table === tableId).map((fk) => ({ name: fk.name, fk, child: fk.from.table }));
}

interface ResolvedAggregate {
  aggregate: ViewAggregate;
  fk: ForeignKey;
  /** The table the children live in. */
  child: TableMeta;
  /** The table the children point at. */
  parent: TableMeta;
  /** The path prefix of the parent, '' for the base table. */
  on: string;
  column?: ColumnMeta;
  /** Default output name, e.g. `count(work_order_part)`. */
  name: string;
}

export const AGGREGATE_FNS: AggregateFn[] = ['count', 'sum', 'min', 'max', 'avg'];

export function resolveAggregate(schema: DatabaseSchema, baseId: string, aggregate: ViewAggregate): ResolvedAggregate {
  const on = (aggregate.on ?? '').trim();
  const fail = (message: string, segment: string) => {
    throw new PathError(message, aggregate.via, segment, 0);
  };

  if (!AGGREGATE_FNS.includes(aggregate.fn)) {
    fail(`"${String(aggregate.fn)}" is not a summary. Use one of: ${AGGREGATE_FNS.join(', ')}.`, String(aggregate.fn));
  }

  /* The parent is the base table, or whatever a path prefix reaches. Resolved
     by resolving a path *through* it — the same code, so a prefix that is not
     a real chain of keys fails here exactly as it would anywhere else. */
  const parent = tableAtPrefix(schema, baseId, on);
  if (!parent) {
    fail(on ? `"${on}" is not a chain of references from ${baseId}.` : `No table called "${baseId}" in this database.`, on || baseId);
  }

  const candidates = backrefsTo(schema, parent!.id);
  // A qualified relationship spelling identifies endpoints, not a constraint.
  // Prefer it when a physical constraint happens to have the same text; App
  // logical-to-physical transfers use this form to preserve the selected edge.
  const match =
    candidates.find((b) => `${b.child}.${b.fk.from.columns.join('+')}` === aggregate.via) ??
    candidates.find((b) => b.name === aggregate.via);
  if (!match) {
    fail(
      `Nothing called "${aggregate.via}" points at ${parent!.name}.` +
        (candidates.length ? ` It is referred to by: ${shortList(candidates.map((c) => c.name))}.` : ' Nothing refers to it.'),
      aggregate.via,
    );
  }

  const child = findTable(schema, match!.child);
  if (!child) fail(`"${match!.child}" is not in this schema.`, aggregate.via);

  let column: ColumnMeta | undefined;
  if (aggregate.fn !== 'count') {
    if (!aggregate.column) {
      fail(`${aggregate.fn} needs a column on ${child!.name} to summarise.`, aggregate.via);
    }
    column = child!.columns.find((c) => c.name === aggregate.column);
    if (!column) {
      const suggestion = nearest(
        aggregate.column!,
        child!.columns.map((c) => c.name),
      );
      fail(
        `"${aggregate.column}" is not a column on ${child!.name}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
        aggregate.column!,
      );
    }
  }

  const subject = `${on ? `${on}.` : ''}${child!.name}${column ? `.${column.name}` : ''}`;
  return {
    aggregate,
    fk: match!.fk,
    child: child!,
    parent: parent!,
    on,
    column,
    name: aggregate.alias?.trim() || `${aggregate.fn}(${subject})`,
  };
}

/** The table a chain of hop names lands on. Empty prefix is the base itself. */
export function tableAtPrefix(schema: DatabaseSchema, baseId: string, prefix: string): TableMeta | undefined {
  let table = findTable(schema, baseId);
  if (!prefix) return table;
  for (const segment of prefix.split('.')) {
    if (!table) return undefined;
    const hop = hopsFrom(schema, table.id).find((h) => h.name === segment || h.fk.name === segment);
    if (!hop) return undefined;
    table = findTable(schema, hop.target);
  }
  return table;
}

/** Resolve without throwing — for callers collecting several errors at once. */
export function tryResolvePath(schema: DatabaseSchema, baseId: string, path: string): { resolved?: ResolvedPath; error?: PathError } {
  try {
    return { resolved: resolvePath(schema, baseId, path) };
  } catch (err) {
    if (err instanceof PathError) return { error: err };
    throw err;
  }
}
