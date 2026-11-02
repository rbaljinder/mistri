/**
 * A command's aggregate: one table's own rows counted, summed, or their least
 * and greatest taken, grouped by up to three of its own columns — what a
 * command handler's `db.entry.where(…).groupBy(…).aggregate(…)` asks
 * (commandDb.ts), run on the command's own transaction.
 *
 * It is a breakdown (breakdown.ts) and compiles through that compiler, so a
 * row scope binds it exactly as it binds a dashboard metric: the base table
 * is read through the scope's relation, and a group whose only rows are
 * hidden is never formed. What it adds is the narrowing a command needs.
 * A breakdown walks reference paths (`customer_id.region`), and under a
 * command's row scope every table off its footprint reads as no rows, so a
 * group keyed through one would come back null — a wrong answer, not a
 * refusal. Here every key, measure and condition names one of the table's
 * own columns or is refused, before anything is compiled.
 */
import type { BreakdownDef, BreakdownKey, Measure } from './breakdown.js';
import { compileBreakdown, DATE_UNITS } from './breakdown.js';
import type { RowScope } from './rowScope.js';
import type { DateUnit, Filter, SqlStyle } from './filter.js';
import { RequestFault } from './refusal.js';
import { findTable, type DatabaseSchema } from './schema.js';
import { PathError, type ViewCondition } from './viewPaths.js';

/** What an aggregate measures. `avg` is the engine's own mean, a float on SQLite: a command answers its mean from an
    exact sum and count (commandDb.ts) and asks for this one only to order groups by. */
type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
const AGGREGATE_FUNCTIONS: readonly AggregateFn[] = ['count', 'sum', 'avg', 'min', 'max'];
/** The most keys an aggregate groups by: a breakdown's own bound. */
const AGGREGATE_KEYS = 3;

interface AggregateKey {
  /** The output name the group's value answers under. */
  readonly name: string;
  readonly column: string;
  /** Cut a date or timestamp to a period, as a breakdown's key is. */
  readonly bucket?: DateUnit;
}
export interface AggregateMeasure {
  /** The output name. */
  readonly name: string;
  readonly fn: AggregateFn;
  /** Absent only for `count`, which then counts rows. */
  readonly column?: string;
}

/** An aggregate over one table, as a transaction is asked it. */
export interface AggregateRequest {
  readonly table: string;
  readonly filter?: Filter;
  readonly by?: readonly AggregateKey[];
  readonly measures: readonly AggregateMeasure[];
  /** The order of the groups, by output name; the keys ascending when unsaid. */
  readonly orderBy?: readonly { readonly name: string; readonly direction: 'asc' | 'desc' }[];
  /** At most this many groups, bounded as every read is. */
  readonly limit: number;
}
export interface AggregateResult {
  /** One row per group, keyed by the output names; one row with no keys. */
  readonly rows: Record<string, unknown>[];
}

/** Every column an aggregate's keys and measures read (its where's are a filter's, checked as one). */
export const aggregateColumns = (request: AggregateRequest): string[] => [
  ...(request.by ?? []).map((key) => key.column),
  ...request.measures.flatMap((measure) => (measure.column === undefined ? [] : [measure.column])),
];

const OUTPUT_NAME = /^[a-z_][a-z0-9_]{0,62}$/i;
/** Names an answer row is never keyed by: assigned on an object they reach its prototype, not a field. */
export const FORBIDDEN_ANSWER_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The breakdown an aggregate is, against `schema`: refused unless the table
 * is there and every column it names is one of that table's own. `table` is
 * the id the schema files it under, as the transaction names it.
 */
function aggregateBreakdown(schema: DatabaseSchema, request: AggregateRequest): BreakdownDef {
  if (!request || typeof request !== 'object') throw new RequestFault('An aggregate names a table and what to measure.');
  const table = typeof request.table === 'string' ? findTable(schema, request.table) : undefined;
  if (!table) throw new RequestFault('Unknown resource in aggregate.');
  const own = new Set(table.columns.map((column) => column.name));
  /* A column, never a path: a dot is a reference walked, and a walk under a command's scope can read a table its
     footprint holds as empty (above). */
  const column = (name: unknown, what: string): string => {
    if (typeof name !== 'string' || !own.has(name) || name.includes('.'))
      throw new RequestFault(
        `An aggregate's ${what} names one of "${table.name}"'s own columns; "${String(name).slice(0, 80)}" is not one.`,
      );
    return name;
  };
  const names = new Set<string>();
  const output = (name: unknown): string => {
    if (typeof name !== 'string' || !OUTPUT_NAME.test(name) || FORBIDDEN_ANSWER_NAMES.has(name) || names.has(name))
      throw new RequestFault('An aggregate answers each key and measure under its own name.');
    names.add(name);
    return name;
  };
  const by = request.by ?? [];
  if (!Array.isArray(by) || by.length > AGGREGATE_KEYS) throw new RequestFault(`An aggregate groups by at most ${AGGREGATE_KEYS} columns.`);
  const keys: BreakdownKey[] = by.map((key) => {
    if (key.bucket !== undefined && !DATE_UNITS.includes(key.bucket))
      throw new RequestFault(`"${String(key.bucket).slice(0, 40)}" is not a period. Use one of: ${DATE_UNITS.join(', ')}.`);
    return { path: column(key.column, 'key'), alias: output(key.name), ...(key.bucket ? { bucket: key.bucket } : {}) };
  });
  if (!Array.isArray(request.measures) || !request.measures.length) throw new RequestFault('An aggregate measures something.');
  const measures: Measure[] = request.measures.map((measure) => {
    if (!AGGREGATE_FUNCTIONS.includes(measure.fn)) throw new RequestFault(`"${String(measure.fn).slice(0, 40)}" is not an aggregate.`);
    if (measure.column === undefined && measure.fn !== 'count') throw new RequestFault(`\`${measure.fn}\` needs a column.`);
    return {
      fn: measure.fn,
      alias: output(measure.name),
      ...(measure.column === undefined ? {} : { path: column(measure.column, 'measure') }),
    };
  });
  const groups = (request.filter?.groups ?? []).map((group) =>
    group.map((condition): ViewCondition => {
      /* A comparison with another column, or rows that point here (`any`), reads past this table's own values:
         neither is a condition a command's where writes (compileWhere), and neither is taken here. */
      if (condition.any !== undefined || condition.other !== undefined)
        throw new RequestFault("An aggregate's where compares the table's own columns with values.");
      return {
        path: column(condition.column, 'where'),
        op: condition.op,
        ...(condition.value === undefined ? {} : { value: condition.value }),
        ...(condition.collation ? { collation: condition.collation } : {}),
      };
    }),
  );
  const orderBy = (request.orderBy?.length ? request.orderBy : keys.map((key) => ({ name: key.alias!, direction: 'asc' as const }))).map(
    (order) => {
      if (!names.has(order.name))
        throw new RequestFault(`An aggregate orders by one of its own keys or measures, not "${String(order.name).slice(0, 80)}".`);
      return { name: order.name, direction: order.direction === 'desc' ? ('desc' as const) : ('asc' as const) };
    },
  );
  /* Which text columns a period may cut is the catalog's to say (declaredDates.ts types them `TEXT as date`), never
     the request's: a raw request naming one more would bucket text that is not a date. */
  const dates = table.columns.filter((c) => / as date(time)?$/.test(c.type)).map((c) => `${table.id}.${c.name}`);
  return {
    base: table.id,
    by: keys,
    ...(dates.length ? { dateColumns: dates } : {}),
    measures,
    ...(groups.length ? { filter: { groups } } : {}),
    ...(orderBy.length ? { orderBy } : {}),
    limit: request.limit,
  };
}

/**
 * The statement an aggregate compiles to. A path the compiler refuses (a period cut of a column that is no date) is
 * the request's fault as written, said as one (RequestFault), never as a read that may succeed on a retry.
 */
export function compileAggregate(
  schema: DatabaseSchema,
  request: AggregateRequest,
  style: SqlStyle,
  offset: number | unknown = 0,
  scope?: RowScope,
): ReturnType<typeof compileBreakdown> {
  const def = aggregateBreakdown(schema, request);
  try {
    return compileBreakdown(schema, def, style, offset, scope);
  } catch (error) {
    if (error instanceof PathError) throw new RequestFault(error.message, { cause: error });
    throw error;
  }
}
