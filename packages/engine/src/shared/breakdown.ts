/**
 * Counting things by something: GROUP BY, as a shape rather than as text.
 *
 * This was the last real hole in the query language. "How many invoices per
 * month", "which countries have the most customers", "what does each status
 * add up to" are the questions anybody asks of a database in the first ten
 * minutes, and until now the only way to ask them here was to drop into `sql`
 * — which means an agent leaves the checked path exactly where the question
 * gets interesting, and a person leaves the tool.
 *
 * A breakdown is deliberately *not* a view with a `groupBy` bolted on. A view
 * promises one row per base record, and every part of it — the correlated
 * aggregates, the LEFT JOIN rule, the row-click that opens a record — leans on
 * that promise. Grouping breaks it: the rows that come back are not records
 * and cannot be opened, and a column that is neither a key nor an aggregate is
 * a bug on two engines and a silent wrong answer on the third. So it is a
 * sibling type with its own compiler, sharing the parts that are genuinely the
 * same: path resolution, the join planner, and `buildWhere`.
 *
 *     invoice  count  by status
 *     invoice  sum total  by month invoice_date
 *     invoice  count, avg total  by customer_id.country_code.name  sort count desc
 *
 * Two rules the shape enforces, both of which SQL leaves to the author:
 *
 *   - **Every selected expression is a key or a measure.** There is nowhere to
 *     put a third thing, so `SELECT status, name, COUNT(*) … GROUP BY status`
 *     — which a lenient engine would answer with an arbitrary `name` — cannot be
 *     written.
 *   - **The result is bounded like every other read.** A breakdown over a
 *     high-cardinality column is a million-row answer, and `sort count desc
 *     limit 20` is what somebody meant anyway.
 */
import { buildWhere, type Condition, type DateUnit, type Filter, type SqlStyle } from './filter.js';
import { clampLimit, clampOffset, countStatement } from './reads.js';
import { aggregateInput, columnKind, findTable, labelPath, type DatabaseSchema, type ForeignKey } from './schema.js';
import { JoinPlan, PathError, sqlLiteral, type ViewFilter } from './view.js';
import { ScopedRelations, type RowScope } from './rowScope.js';
import { readsOf } from './query.js';
import { isFixedScopeCatalog } from './scopeCatalog.js';
import { viewPaths, withViewComputed } from './viewLabels.js';
import { tableAtPrefix, tryResolvePath, type ViewDef } from './viewPaths.js';
import type { ComputedPath } from './rollups.js';
import { withViewReferences } from './declaredReferences.js';
import { LABEL_SEGMENT, labelPrefix } from './recordLabel.js';

/** What a measure can do. `count` is the only one that needs no column. `median` is PostgreSQL's
    `percentile_cont(0.5)`: SQLite has no median aggregate, so it is refused there. */
export type MeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';

export const MEASURE_FUNCTIONS: MeasureFn[] = ['count', 'sum', 'avg', 'min', 'max', 'median'];

/** The arithmetic a computed measure joins its terms with. SQL's precedence: `*` and `/` before `+` and `-`. */
export type MeasureOp = '+' | '-' | '*' | '/';
export const MEASURE_OPS: readonly MeasureOp[] = ['+', '-', '*', '/'];

/** Why a dialect cannot answer a measure function, or undefined when it can. */
export function measureRefusal(fn: MeasureFn, dialect: string | undefined): string | undefined {
  if (fn !== 'median') return undefined;
  if (dialect === 'sqlite')
    return '`median` is not available on SQLite: it has no median aggregate (no percentile_cont). Use `avg`, or a PostgreSQL source.';
  return undefined;
}

/** The periods a date key can be cut into. */
export const DATE_UNITS: DateUnit[] = ['day', 'week', 'month', 'quarter', 'year', 'weekday', 'hour'];

/**
 * One thing to group by: a path, optionally cut down to a period.
 *
 * The path is a reference path like a view's, so "customers by country name"
 * is `customer … by country_code.name` and needs no join written by hand.
 */
export interface BreakdownKey {
  path: string;
  /** Cut a date or timestamp down to a period. Refused on anything else. */
  bucket?: DateUnit;
  alias?: string;
}

/** One aggregate: a function and the column it reads. */
export interface MeasureTerm {
  fn: MeasureFn;
  /** The column to measure. Absent means `COUNT(*)`, and is only valid there. */
  path?: string;
  /** COUNT DISTINCT. Meaningless on the others and refused there. */
  distinct?: boolean;
  /**
   * `count when [status = open]`: only the rows that hold these conditions are counted, in the same statement as the
   * other measures (`COUNT(CASE WHEN … THEN 1 END)`), so a funnel's stages are one snapshot and can never disagree.
   * Only a bare `count` takes it. `when` is the conditions as written; `where` is what they parsed to, which is what
   * runs: the parser fills it, and a request's own is held to the same shape a filter is (resourceReadOperations.ts).
   */
  when?: string;
  where?: ViewFilter;
}

/**
 * A measure: one aggregate, or a computed measure — aggregates and numbers
 * joined by arithmetic, `sum paid / sum total`, `sum total - sum cost`. A
 * ratio is the `/` case, not a function of its own. A division never
 * truncates and never fails: its divisor is read as a decimal and a zero
 * one answers null.
 */
export interface Measure extends MeasureTerm {
  alias?: string;
  /** The terms after the first, each with the operator before it. */
  steps?: { op: MeasureOp; term: MeasureTerm | number }[];
}

const termText = (t: MeasureTerm | number): string =>
  typeof t === 'number'
    ? String(t)
    : [t.fn, ...(t.distinct ? ['distinct'] : []), ...(t.path ? [t.path] : []), ...(t.when ? ['when', `[${t.when}]`] : [])].join(' ');

/** A measure as it is written: `sum paid / sum total as rate`. */
export function measureToText(m: Measure): string {
  return [termText(m), ...(m.steps ?? []).flatMap(({ op, term }) => [op, termText(term)]), ...(m.alias ? ['as', m.alias] : [])].join(' ');
}

const termName = (t: MeasureTerm | number, path = typeof t === 'number' ? undefined : t.path): string =>
  typeof t === 'number' ? String(t) : t.fn === 'count' ? (path ? `count(${path})` : 'count') : `${t.fn}(${path ?? ''})`;

/** The name a measure answers under when it has no alias: `sum(total)`, `sum(paid) / sum(total)`. */
export function measureName(m: Measure, path = m.path): string {
  return m.alias?.trim() || [termName(m, path), ...(m.steps ?? []).flatMap(({ op, term }) => [op, termName(term)])].join(' ');
}

/** Every column a measure reads. */
export function measurePaths(m: Measure): string[] {
  return [m, ...(m.steps ?? []).map(({ term }) => term)].flatMap((t) => (typeof t !== 'number' && t.path ? [t.path] : []));
}

/** Every `when` among a breakdown's measures, in order: what a reader's grants and the stitched-read check must also hold. */
export const measureConditions = (measures: readonly Measure[] | undefined): ViewFilter[] =>
  (measures ?? []).flatMap((m) => (m.where?.groups.length ? [m.where] : []));

/** The paths a filter's conditions walk, and the paths they compare against. */
export const filterPaths = (filter: ViewFilter | undefined): string[] =>
  (filter?.groups ?? []).flatMap((group) => group.flatMap((c) => [c.path, ...(c.other === undefined ? [] : [c.other])]));

export interface BreakdownOrder {
  /** A key's or a measure's output name. Breakdowns sort by what they show. */
  name: string;
  direction: 'asc' | 'desc';
  /** On a key: this entry only moves the empty group (a null key) after every other, whatever the entries after it
      say; it orders nothing else, so `direction` is not read. The groups of a grouped list use it to draw "No sprint"
      last under any sort — done in the query because the groups are paged, so no page could place it by itself. */
  emptyLast?: boolean;
}

export interface BreakdownDef {
  base: string;
  by: BreakdownKey[];
  /** `table.column` of text columns an App declares dates (declaredDates.ts), which this catalog reads as TEXT:
      a period bucket over one is allowed. Carried by the App's resource facade, never taken from a request. */
  dateColumns?: string[];
  measures: Measure[];
  filter?: ViewFilter;
  orderBy?: BreakdownOrder[];
  limit?: number;
  /** The breakdown written down, when it came from text. */
  text?: string;
  /** The ISO weekday a `week` bucket's weeks start on, 1 (Monday) to 7 (Sunday); Monday when unsaid. An App's
      server sets it from `ui.locale` (weekStart.ts), whatever a request carried. */
  weekStart?: number;
  /**
   * The rollups its paths name (rollups.ts), by path — a measure `sum
   * on_hand`, a key, a condition. Filled by the server from the App's
   * catalog (withBreakdownComputed), never taken from a request, and read
   * by the compiler where the adapter's catalog does not carry them.
   */
  computed?: Record<string, ComputedPath>;
  /** The computed columns its paths name (computed.ts), pinned the same way. */
  expressions?: ViewDef['expressions'];
  /** The record tags its conditions ask (`tags has vpn`, tagLists.ts), pinned the same way: a filter rail's
      counts under a tags filter ask them where the adapter's catalog has no tags. */
  tagged?: ViewDef['tagged'];
  /** The App's declared references it may walk, as a view carries them (ViewDef.references); never a request's. */
  references?: ForeignKey[];
  /**
   * The keys that are references, each with the path of the name of the
   * record it points at (`customer_id` → `customer_id.name`): a group of
   * `customer_id` is a customer, and is said by the customer's name, as a
   * grid's cell says it. Each such key answers that name in a `label` column
   * after the measures. Filled by the server from the catalog
   * (withBreakdownComputed), never taken from a request, as are `labels`,
   * the record-name templates a `$label` name needs (a view's `labels`).
   */
  names?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface CompiledMeasure {
  name: string;
  /** A key, a measure, or a key's record name (`of` names the key). */
  kind: 'key' | 'measure' | 'label';
  of?: string;
  fn?: MeasureFn;
  /** The path this came from, for the interface to label it with. */
  path?: string;
  /** What the values are, as far as the schema knows. */
  type: string;
  bucket?: DateUnit;
}

interface CompiledBreakdown {
  text: string;
  params: unknown[];
  columns: CompiledMeasure[];
  limit: number;
}

/** How many group keys are worth having. */
const MAX_KEYS = 3;

/**
 * Is this column something a date bucket can be taken of?
 *
 * Read off the declared type rather than the values, because the answer has
 * to be the same before and after the table has any rows in it. SQLite's
 * `DATE` is a convention rather than a type, which is exactly why the check is
 * on the declaration: a column somebody called `DATE` is one they intend to
 * hold dates, and `strftime` over text that is not one returns null — a group
 * of its own rather than an error, which is the honest outcome.
 */
const isDateish = (type: string): boolean => /date|time/i.test(type ?? '');

/**
 * Compile a breakdown to one parameterised SELECT.
 *
 * The order of work matches `compileView`'s and for the same reason: keys,
 * then measures, then the filter, then the sort — so aliases are handed out in
 * first-use order and the same breakdown always compiles to the same text.
 */
export function compileBreakdown(
  schema: DatabaseSchema,
  def: BreakdownDef,
  style: SqlStyle,
  offset: number | unknown = 0,
  scope?: RowScope,
): CompiledBreakdown {
  /* A breakdown compiles to the same statement against the same catalog, and an App's enter asks for each of its
     rail's and dashboard's breakdowns several times — against the reader's pruned catalog and the full one for
     the access check (columnGrants.ts), under the reader's scope to run it, and again for the SQL pane — each a
     full compile (a field report: a large tenant App spent a twelfth of an enter's CPU here). Kept only against a catalog nothing can change (fixedCatalog, below), for a definition
     whose text says all of it (breakdownText), and only where compiling read neither the clock nor the reader
     (query.ts readsOf): a statement that wrote a request's instant, day or email is that request's, and is never
     handed to another. */
  const text = typeof offset === 'number' && fixedCatalog(schema) ? breakdownText(def) : undefined;
  if (text === undefined) {
    breakdownsCompiled++;
    return compileBreakdownFresh(schema, def, style, offset, scope);
  }
  let byStyle = breakdownsKept.get(schema);
  if (!byStyle) breakdownsKept.set(schema, (byStyle = new WeakMap()));
  let kept = byStyle.get(style);
  if (!kept) byStyle.set(style, (kept = new Map()));
  const key = `${scope ? scopeOrdinal(scope) : 0}\0${offset as number}\0${text}`;
  let found = kept.get(key);
  if (found) {
    kept.delete(key);
    kept.set(key, found);
  } else {
    breakdownsCompiled++;
    const read = readsOf(() => compileBreakdownFresh(schema, def, style, offset, scope));
    if (read.clock !== 0 || read.reader) return read.value;
    found = read.value;
    kept.set(key, found);
    if (kept.size > BREAKDOWNS_KEPT) kept.delete(kept.keys().next().value!);
  }
  // Each caller's own arrays: a driver or a caller may add to what it is handed.
  return { ...found, params: [...found.params], columns: found.columns.map((column) => ({ ...column })) };
}
/* A catalog nothing can change: a captured scope catalog (scopeCatalog.ts), or whatever the server says it froze
   all the way down (evidence.ts captureTenantData, which registers itself here: a shared module cannot import it). */
let alsoFixed: (schema: DatabaseSchema) => boolean = () => false;
/** Who says a catalog cannot change, beside the scope catalog's own captures. */
export function keepBreakdownsAgainst(fixed: (schema: DatabaseSchema) => boolean): void {
  alsoFixed = fixed;
}
const fixedCatalog = (schema: DatabaseSchema) => isFixedScopeCatalog(schema) || alsoFixed(schema);

/* A definition's text, where the text says all of it: plain records, arrays, strings, booleans and finite numbers.
   A property left undefined (a key with no `bucket`, a list with no `orderBy` — most of them, as a reader's snapshot
   carries them) is said as one, never dropped, so the text of a definition that has the key and one that does not
   still differ; anything else JSON would say alike — an undefined in a list, a non-finite number, an object that is
   not a plain record, a function, a symbol or a BigInt — is no text, and is compiled afresh. */
const UNDEFINED = Object.freeze({ '\u0000': 'undefined' });
function breakdownText(def: BreakdownDef): string | undefined {
  let plain = true;
  const text = JSON.stringify(def, function (this: Record<string, unknown>, key, item: unknown) {
    // The value as held, not as its toJSON says it: a Date is said as text, and is not the text it says.
    const held = this[key];
    if (held === undefined) {
      if (Array.isArray(this)) plain = false;
      return UNDEFINED;
    }
    // JSON drops a function or symbol (two definitions apart only by one would share a text) and throws on a BigInt.
    if (typeof held === 'function' || typeof held === 'symbol' || typeof held === 'bigint') {
      plain = false;
      return null;
    }
    if (
      (typeof held === 'number' && !Number.isFinite(held)) ||
      (held !== null && typeof held === 'object' && !Array.isArray(held) && ![null, Object.prototype].includes(Object.getPrototypeOf(held)))
    )
      plain = false;
    return item;
  });
  return plain ? text : undefined;
}

const breakdownsKept = new WeakMap<DatabaseSchema, WeakMap<SqlStyle, Map<string, CompiledBreakdown>>>();
const BREAKDOWNS_KEPT = 256;
let breakdownsCompiled = 0;
/** For tests: how many breakdowns were compiled rather than found. */
export function breakdownsCompiledSoFar(): number {
  return breakdownsCompiled;
}
const scopeOrdinals = new WeakMap<RowScope, number>();
let scopesSeen = 0;
const scopeOrdinal = (scope: RowScope): number => {
  let ordinal = scopeOrdinals.get(scope);
  if (ordinal === undefined) scopeOrdinals.set(scope, (ordinal = ++scopesSeen));
  return ordinal;
};

function compileBreakdownFresh(
  schema: DatabaseSchema,
  def: BreakdownDef,
  style: SqlStyle,
  offset: number | unknown,
  scope: RowScope | undefined,
): CompiledBreakdown {
  // The App's soft keys, where this catalog is the database's own (declaredReferences.ts).
  schema = withViewReferences(schema, def.references);
  const base = findTable(schema, def.base);
  if (!base) {
    throw new PathError(`No table called "${def.base}" in this database, so there is nothing to break down.`, def.base, def.base, 0);
  }
  /* No `by` is one group: the whole answer as a single row —
     "invoice sum total" is a number, not a mistake. The app home's metric
     cards ride on exactly this, and it reads the same in the workbench. */
  if (def.by.length > MAX_KEYS) {
    /* A cap rather than a warning. Three keys is already a table nobody reads
       across; the fourth is how a breakdown becomes the base table again, one
       row per record, with the count column always saying 1. */
    throw new PathError(
      `A breakdown groups by at most ${MAX_KEYS} things; this one names ${def.by.length}.`,
      def.by[MAX_KEYS].path,
      def.by[MAX_KEYS].path,
      0,
    );
  }
  if (!def.measures?.length) {
    throw new PathError('A breakdown needs something to measure — `count`, or `sum total`.', '', '', 0);
  }

  const relations = new ScopedRelations(schema, style, scope);
  const baseRelation = relations.table(base.id);
  const plan = new JoinPlan(schema, base, style, relations.table);
  /* The view compiler's paths, so a rollup — the base's or through a
     reference — is the same correlated subquery here as in a list, its
     child rows read through this statement's relations (a row scope's
     CTE). A key, a measure and a condition may each name one. */
  const paths = viewPaths(
    schema,
    {
      id: '',
      name: '',
      base: def.base,
      ...(def.computed ? { computed: def.computed } : {}),
      ...(def.expressions ? { expressions: def.expressions } : {}),
      ...(def.tagged ? { tagged: def.tagged } : {}),
      ...(def.labels ? { labels: def.labels } : {}),
    } as ViewDef,
    plan,
    style,
    relations,
  );
  const qualify = (path: string): string => paths.qualify(path);
  const membership = paths.membership;
  const exists = paths.exists;

  const seen = new Map<string, number>();
  /** Output names are unique or the result set loses a column silently. */
  const nameFor = (wanted: string): string => {
    const count = seen.get(wanted) ?? 0;
    seen.set(wanted, count + 1);
    return count ? `${wanted}_${count + 1}` : wanted;
  };

  const columns: CompiledMeasure[] = [];
  const select: string[] = [];
  const grouping: string[] = [];

  for (const key of def.by ?? []) {
    const resolved = paths.resolve(key.path);
    let sql = qualify(key.path);
    if (key.bucket) {
      // A request's word, looked up in the dialect's own table: one of the four, never anything else.
      if (!DATE_UNITS.includes(key.bucket)) {
        throw new PathError(
          `"${String(key.bucket).slice(0, 40)}" is not a period. Use one of: ${DATE_UNITS.join(', ')}.`,
          key.path,
          key.path,
          0,
        );
      }
      if (!isDateish(resolved.column.type) && !def.dateColumns?.includes(`${resolved.table.id}.${resolved.column.name}`)) {
        throw new PathError(
          `"${key.path}" is ${resolved.column.type || 'untyped'}, so it cannot be grouped by ${key.bucket}. ` +
            'Group by it directly, or pick a date column.',
          key.path,
          key.path,
          resolved.hops.length,
        );
      }
      sql = style.dateBucket(sql, key.bucket, def.weekStart);
    }

    const name = nameFor(key.alias?.trim() || (key.bucket ? `${key.bucket}(${resolved.path})` : resolved.path));
    select.push(`${sql} AS ${style.quote(name)}`);
    /* Grouped by the *expression*, not by the output name. Postgres
       would take the alias; SQLite would too — but a bucketed key aliased to
       `month(invoice_date)` and grouped by that name is one identifier away
       from grouping by a column that happens to share it. The expression is
       never ambiguous.

       A rollup is the exception: its expression is a correlated subquery,
       and an engine can fail to see two copies of one as
       the same thing, so it refuses the SELECT list's copy as ungrouped.
       Grouped by its position in the SELECT list instead — the one place it
       is written, which every engine groups by and nothing can shadow. */
    grouping.push(def.computed && Object.hasOwn(def.computed, key.path) ? String(select.length) : sql);
    columns.push({
      name,
      kind: 'key',
      path: resolved.path,
      /* A bucket makes text out of whatever it was, and the interface should
         render `2026-08` as the label it is rather than as a date it is not. */
      type: key.bucket ? 'text' : resolved.column.type,
      bucket: key.bucket,
    });
  }

  /* One aggregate's SQL, and what its values are. */
  const termSql = (term: MeasureTerm): { sql: string; path?: string; type: string } => {
    /* The function is written into the statement as a word, so it is one of
       the words: a structured def arrives from a request (`/api/breakdown`
       `def`), and anything else there would be SQL of the caller's own,
       outside every scope and grant this statement reads through. */
    if (typeof term !== 'object' || term === null || !MEASURE_FUNCTIONS.includes(term.fn)) {
      throw new PathError(`"${String(term?.fn).slice(0, 40)}" is not a measure. Use one of: ${MEASURE_FUNCTIONS.join(', ')}.`, '', '', 0);
    }
    if (term.fn === 'count') {
      if (term.distinct && !term.path) {
        throw new PathError('`count distinct` needs a column to count distinct values of.', '', '', 0);
      }
      /* COUNT(*) rather than COUNT(column) when no column is named: a column
         count skips nulls, which turns "how many invoices" into "how many
         invoices have a total" without saying so. Naming a column is how you
         ask the other question, and then the skipping is the point. */
      return {
        sql: term.path ? `COUNT(${term.distinct ? 'DISTINCT ' : ''}${qualify(term.path)})` : 'COUNT(*)',
        path: term.path,
        type: 'integer',
      };
    }
    if (!term.path) {
      throw new PathError(`\`${term.fn}\` needs a column: \`${term.fn} total\`.`, '', '', 0);
    }
    if (term.distinct) {
      throw new PathError(`\`distinct\` only means something with \`count\`, not with \`${term.fn}\`.`, term.path, term.path, 0);
    }
    const refused = measureRefusal(term.fn, style.dialect);
    if (refused) throw new PathError(refused, term.path, term.path, 0);
    const resolved = paths.resolve(term.path);
    const read = aggregateInput(qualify(term.path), resolved.column.type, style.dialect);
    return {
      sql: term.fn === 'median' ? `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${read})` : `${term.fn.toUpperCase()}(${read})`,
      path: resolved.path,
      /* `avg` and `median` are fractions of whatever they read — an average
         of integers is not an integer, and saying otherwise makes the
         interface round a number the database did not. */
      type:
        term.fn === 'avg' || term.fn === 'median'
          ? 'numeric'
          : term.fn === 'sum' && columnKind(resolved.column.type) === 'boolean'
            ? 'integer'
            : resolved.column.type,
    };
  };

  /* A measure that counts only some rows (`count when [...]`) is written once the statement's own parameters are
     counted, below: its values are bound after the scope's and before the filter's, in the order the text reads. */
  const whens: { at: number; name: string; where: ViewFilter }[] = [];
  const asFilter = (filter: ViewFilter | undefined): Filter | undefined =>
    filter?.groups.length
      ? {
          groups: filter.groups.map((group) =>
            group.map((c): Condition =>
              c.any
                ? { column: c.path, op: c.op, any: c.any }
                : c.other === undefined
                  ? { column: c.path, op: c.op, value: c.value }
                  : { column: c.path, op: c.op, other: c.other },
            ),
          ),
        }
      : undefined;
  /* Every path a condition names is planned (its joins, its tags) before the scope prefix is frozen. */
  const planPaths = (conditions: Filter | undefined) => {
    for (const group of conditions?.groups ?? []) {
      for (const condition of group) {
        /* A tags condition (`has`) plans its link and tag relations here too, before the scope
           prefix is frozen, as a view's does: its EXISTS reads them through it. */
        if (condition.any) {
          exists(condition.any);
          continue;
        }
        qualify(condition.column);
        if (condition.other !== undefined) qualify(condition.other);
      }
    }
  };

  for (const measure of def.measures) {
    if (measure.where !== undefined || measure.when !== undefined) {
      if (measure.fn !== 'count' || measure.path || measure.distinct || measure.steps?.length || !measure.where) {
        throw new PathError('`when` only goes with a bare `count`: `count when [status = open]`.', '', '', 0);
      }
      const conditions = asFilter(measure.where);
      if (conditions) {
        planPaths(conditions);
        const name = nameFor(measureName(measure, undefined));
        whens.push({ at: select.length, name, where: measure.where });
        select.push('');
        columns.push({ name, kind: 'measure', fn: 'count', type: 'integer' });
        continue;
      }
    }
    const head = termSql(measure);
    if (!measure.steps?.length) {
      const name = nameFor(measureName(measure, head.path));
      select.push(`${head.sql} AS ${style.quote(name)}`);
      columns.push({ name, kind: 'measure', fn: measure.fn, path: head.path, type: head.type });
      continue;
    }
    /* A computed measure is written out in its own order: SQL's precedence
       is the grammar's. A divisor is made a decimal, so integer counts do
       not divide to zero on PostgreSQL and SQLite, and NULLIF makes a zero
       one an empty answer instead of an error. */
    const pieces = [head.sql];
    for (const { op, term } of measure.steps) {
      if (!MEASURE_OPS.includes(op)) throw new PathError(`"${op}" is not arithmetic a measure joins with: + - * or /.`, '', '', 0);
      if (typeof term === 'number' && !Number.isFinite(term)) throw new PathError("A computed measure's number must be finite.", '', '', 0);
      const sql = typeof term === 'number' ? String(term) : termSql(term).sql;
      pieces.push(op, op === '/' ? `NULLIF(1.0 * ${sql}, 0)` : sql);
    }
    const name = nameFor(measureName(measure, head.path));
    select.push(`(${pieces.join(' ')}) AS ${style.quote(name)}`);
    columns.push({ name, kind: 'measure', type: 'numeric' });
  }

  /* A key that is a reference is said by its record's name, as a grid's cell
     is: the name through the same join the key's path walks, read through
     this statement's relations, so a record this reader's scope does not
     admit has no name and the group stays its key. Last, after the
     measures, so a reader that takes the key and the measure by position
     reads what it always did; grouped by position, since the key decides it. */
  for (const [index, key] of (def.by ?? []).entries()) {
    if (key.bucket || !def.names || !Object.hasOwn(def.names, key.path)) continue;
    const path = def.names[key.path];
    const name = nameFor(`${columns[index].name}.${LABEL_SEGMENT}`);
    select.push(`${qualify(path)} AS ${style.quote(name)}`);
    grouping.push(String(select.length));
    columns.push({ name, kind: 'label', of: columns[index].name, path, type: 'text' });
  }

  const conditions = asFilter(def.filter);
  planPaths(conditions);
  const joins = plan.clauses();
  const prefix = relations.finish();
  const whenParams: unknown[] = [];
  for (const { at, name, where: held } of whens) {
    const built = buildWhere(asFilter(held), style, prefix.params.length + whenParams.length + 1, qualify, qualify, membership, exists);
    whenParams.push(...built.params);
    /* COUNT, not SUM: a count of no rows is 0, where a sum of none is null. */
    select[at] = `COUNT(CASE WHEN ${built.text.replace(/^ WHERE /, '')} THEN 1 END) AS ${style.quote(name)}`;
  }
  const where = buildWhere(conditions, style, prefix.params.length + whenParams.length + 1, qualify, qualify, membership, exists);

  /* Sorted by output name, and only by output name.

     Every column of a breakdown is either a key or a measure, and both are in
     the SELECT list under a name — so there is nothing else it could sort by,
     and ORDER BY runs late enough to see the aliases on all three engines.
     Sorting by an expression instead would let `sort total desc` mean the
     ungrouped column on a statement where that column no longer exists. */
  const names = new Set(columns.map((c) => c.name));
  const order = (def.orderBy ?? []).map((o) => {
    if (!names.has(o.name)) {
      throw new PathError(`Nothing called "${o.name}" is in this breakdown. It shows: ${[...names].join(', ')}.`, o.name, o.name, 0);
    }
    if (o.emptyLast) return `(${style.quote(o.name)} IS NULL) ASC`;
    return `${style.quote(o.name)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
  });

  const limit = clampLimit(def.limit);
  const skip = clampOffset(offset);
  const n = prefix.params.length + whenParams.length + where.params.length;

  const lines = [`SELECT ${select.join(',\n       ')}`, `  FROM ${baseRelation} ${style.quote(plan.baseAlias)}`, ...joins];
  if (where.text) lines.push(where.text);
  if (grouping.length) lines.push(` GROUP BY ${grouping.join(', ')}`);
  if (order.length) lines.push(` ORDER BY ${order.join(', ')}`);
  lines.push(` LIMIT ${style.placeholder(n + 1)} OFFSET ${style.placeholder(n + 2)}`);

  return { text: prefix.text + lines.join('\n'), params: [...prefix.params, ...whenParams, ...where.params, limit, skip], columns, limit };
}

/**
 * The breakdown with the rollups its paths name, read from a catalog that
 * serves them (an App's) — and with any it arrived with dropped, as
 * withViewComputed does for a view: which rows a number sums is the
 * catalog's to say, never a request's.
 */
export function withBreakdownComputed(schema: DatabaseSchema, def: BreakdownDef): BreakdownDef {
  // A request's declared dates and names are dropped with its rollups: all are the catalog's to carry (appResources.ts).
  const { computed: _given, expressions: _written, tagged: _tagged, dateColumns: _dated, names: _names, labels: _labels, ...rest } = def;
  /* A key that is a reference to a record with a name: its groups are said
     by that name (compileBreakdown), the one a grid's cell reads (labelPath),
     through the same reference. */
  const names: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const key of def.by ?? []) {
    if (typeof key?.path !== 'string' || key.bucket || Object.hasOwn(names, key.path)) continue;
    const target = tableAtPrefix(schema, def.base, key.path);
    const resolved = target && tryResolvePath(schema, def.base, key.path).resolved;
    if (!target || !resolved || resolved.rollup) continue;
    const naming = labelPath(schema, target);
    if (!naming) continue;
    names[key.path] = `${key.path}.${naming}`;
    const prefix = labelPrefix(names[key.path]);
    if (prefix !== undefined && target.labelTemplate) labels[prefix] = target.labelTemplate;
  }
  const named = Object.keys(names).length ? { ...rest, names, ...(Object.keys(labels).length ? { labels } : {}) } : rest;
  const paths = [
    ...(def.by ?? []).map((key) => key.path),
    ...(def.measures ?? []).flatMap(measurePaths),
    ...filterPaths(def.filter),
    ...measureConditions(def.measures).flatMap(filterPaths),
  ];
  /* The rollups and computed columns its paths name, as a view's are (withViewComputed). */
  const pinned = withViewComputed(schema, {
    id: '',
    name: '',
    base: def.base,
    columns: paths.filter((path): path is string => typeof path === 'string').map((path) => ({ path })),
  });
  return {
    ...named,
    ...(pinned.computed ? { computed: pinned.computed } : {}),
    ...(pinned.expressions ? { expressions: pinned.expressions } : {}),
    ...(pinned.tagged ? { tagged: pinned.tagged } : {}),
  };
}

/**
 * How many groups there are, ignoring the page.
 *
 * `SELECT COUNT(*) FROM (the grouped statement)` — the only honest way to
 * count groups, because the number is a property of the grouping rather than
 * of the base table. Without the limit and offset, which is the whole point of
 * asking.
 */
export function compileBreakdownCount(
  schema: DatabaseSchema,
  def: BreakdownDef,
  style: SqlStyle,
  scope?: RowScope,
  limit?: number,
): { text: string; params: unknown[] } {
  const inner = compileBreakdown(schema, def, style, 0, scope);
  /* The LIMIT/OFFSET line is the last one and carries the last two
     parameters. Dropped by rebuilding rather than by string surgery would be
     nicer; it is the last line by construction, and the test says so. */
  const lines = inner.text.split('\n');
  const body = lines.slice(0, -1).join('\n');
  return {
    /* With a bound, at most `limit` groups are counted (countStatement). The
       grouping itself still reads what it groups; the bound keeps the count's
       answer, not the scan, from growing with the data. */
    text: limit === undefined ? `SELECT COUNT(*) AS n FROM (\n${body}\n) AS grouped` : countStatement(`(\n${body}\n) AS grouped`, limit),
    params: inner.params.slice(0, -2),
  };
}

/**
 * Render a breakdown as the SQL it will become, values inline.
 *
 * The exact counterpart of `explainView`, and here for the same reason: the
 * SQL pane is how somebody learns what a line of the language did on their
 * behalf, and a statement full of `?` teaches nothing about the filter that
 * produced it. It also has to be a statement that runs, because the pane
 * offers to open it in the SQL editor.
 */
export function explainBreakdown(schema: DatabaseSchema, def: BreakdownDef, style: SqlStyle, offset: number | unknown = 0): string {
  const compiled = compileBreakdown(schema, def, style, offset);
  let i = 0;
  return compiled.text.replace(/\$\d+|\?/g, () => sqlLiteral(compiled.params[i++]));
}

/** A breakdown's groups said by name: key column → the key's value as text → the record's name. */
export type GroupNames = Record<string, Record<string, string>>;

/**
 * The answer as its readers take it — the keys first and the measures after,
 * by position — with each reference key's names (compileBreakdown's `label`
 * columns) lifted out beside it: a chart reads its key and measure by index,
 * a board its count last, and a name among them would be read as either.
 */
export function withGroupNames<R extends { columns: string[]; rows: Record<string, unknown>[]; resolved: CompiledMeasure[] }>(
  result: R,
): R & { names?: GroupNames } {
  const labels = result.resolved.filter((column) => column.kind === 'label' && column.of);
  if (!labels.length) return result;
  const names: GroupNames = {};
  for (const label of labels) {
    const said: Record<string, string> = {};
    for (const row of result.rows) {
      const key = row[label.of!],
        name = row[label.name];
      if (key !== null && key !== undefined && typeof name === 'string' && name !== '') said[String(key)] = name;
    }
    names[label.of!] = said;
  }
  const hidden = new Set(labels.map((label) => label.name));
  return {
    ...result,
    columns: result.columns.filter((name) => !hidden.has(name)),
    resolved: result.resolved.filter((column) => !hidden.has(column.name)),
    rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !hidden.has(name)))),
    names,
  };
}
