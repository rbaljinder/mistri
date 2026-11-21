/**
 * Computed columns in a single-table read's filter: `db.tasks.where('is_overdue')` in a handler or a loader.
 *
 * A computed column is no column of the table (computed.ts), so a read that names one carries its expression on the
 * filter (`Filter.computed`), and the adapter writes that expression where a condition names it, with the same
 * compiler a view uses (`compileComputed`). The expression is what the reader's catalog served, its constants folded:
 * the caller resolved it, never the person asking. It is still checked here, node by node, before a word of it reaches
 * a statement, because `compileComputed` writes a function's name, an operator, a unit and a JSON key as text: anything
 * the parser would never have produced is refused, and so is a read of anything but one of the table's own columns.
 * What it reads is worked out from the expression (`computedReads`), never taken from the request, so a grant check
 * of those reads (columnGrants.ts) is a check of what the statement reads.
 */
import { COMPUTED_TYPES, compileComputed, computedKind, computedReads, type ComputedNode, type ComputedType } from './computed.js';
import { COMPUTED_FUNCTIONS } from './computedParse.js';
import { asksAboutRows, type Condition, type Filter, type SqlStyle } from './filter.js';
import { RequestFault } from './refusal.js';
import { findTable, type DatabaseSchema, type TableMeta } from './schema.js';
import { columnRead } from './viewLabels.js';

/** The computed columns a filter's conditions may name, by name: each one's type and its expression, constants folded. */
export type FilterComputed = Readonly<Record<string, { readonly type: ComputedType; readonly expr: ComputedNode }>>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPS = new Set(['+', '-', '*', '/', '=', '!=', '<', '<=', '>', '>=', 'and', 'or']);
const UNITS = new Set(['minute', 'hour', 'day', 'week', 'month', 'year']);
const FUNCTIONS = new Set<string>(COMPUTED_FUNCTIONS);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

const refuse = (detail: string): never => {
  throw new RequestFault(`This read cannot use that computed column: ${detail}.`);
};

/** Whether a filter carries computed columns, so the adapter needs the table's columns to write them. */
export const asksComputed = (filter: Filter | undefined): boolean =>
  filter?.computed !== undefined &&
  filter.computed !== null &&
  typeof filter.computed === 'object' &&
  Object.keys(filter.computed).length > 0;

/** Whether a single-table read's filter needs the catalog: it asks about other rows, or names a computed column. */
export const readsCatalog = (filter: Filter | undefined): boolean => asksAboutRows(filter) || asksComputed(filter);

/** The table a computed column is written over; a catalog that cannot say it refuses the read, never drops the condition. */
export function computedTable(schema: DatabaseSchema | undefined, id: string): TableMeta {
  const table = schema && findTable(schema, id);
  if (!table) throw new RequestFault('This read cannot use a computed column.');
  return table;
}

/**
 * The filter's computed columns, each checked against the table: a name that is no column of it, a type, and an
 * expression of the parser's own shapes reading only the table's stored columns. Its constants are folded already:
 * `today`, `now` and `me` are the request's, said by whoever resolved the column, so an unfolded one is refused.
 */
export function checkedComputed(
  filter: Filter,
  table: TableMeta,
): Map<string, { type: ComputedType; expr: ComputedNode; reads: string[] }> {
  const out = new Map<string, { type: ComputedType; expr: ComputedNode; reads: string[] }>();
  const given = filter.computed;
  if (given === undefined) return out;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) refuse('not a map of columns');
  const stored = new Set(table.columns.map((column) => column.name));
  for (const [name, def] of Object.entries(given)) {
    if (!IDENTIFIER.test(name) || stored.has(name)) refuse(`"${name}" is a column of ${table.name} or no name`);
    if (def === null || typeof def !== 'object') refuse(`"${name}" has no definition`);
    if (!(COMPUTED_TYPES as readonly unknown[]).includes(def.type)) refuse(`"${name}" has no type`);
    let size = 0;
    const node = (n: unknown): void => {
      if (++size > 500) refuse(`"${name}" is too large`);
      if (n === null || typeof n !== 'object') refuse(`"${name}" is not an expression`);
      const at = n as Record<string, unknown>;
      switch (at.k) {
        case 'path':
          if (typeof at.path !== 'string' || !stored.has(at.path)) refuse(`"${name}" reads what is not a column of ${table.name}`);
          return;
        case 'json':
          if (typeof at.column !== 'string' || !stored.has(at.column)) refuse(`"${name}" reads what is not a column of ${table.name}`);
          if (!Array.isArray(at.keys) || !at.keys.length || !at.keys.every((key) => typeof key === 'string' && IDENTIFIER.test(key)))
            refuse(`"${name}" names a member that is no identifier`);
          return;
        case 'number':
          if (typeof at.value !== 'number' || !Number.isFinite(at.value)) refuse(`"${name}" has a figure that is no number`);
          return;
        case 'text':
          if (typeof at.value !== 'string') refuse(`"${name}" has text that is no text`);
          return;
        case 'bool':
          if (typeof at.value !== 'boolean') refuse(`"${name}" has a yes-or-no that is neither`);
          return;
        case 'date':
          if (typeof at.value !== 'string' || !DAY.test(at.value)) refuse(`"${name}" has a day that is no day`);
          return;
        case 'instant':
          if (typeof at.value !== 'string' || !INSTANT.test(at.value)) refuse(`"${name}" has an instant that is no instant`);
          return;
        case 'nobody':
          return;
        case 'not':
        case 'neg':
          return node(at.of);
        case 'empty':
          if (typeof at.negate !== 'boolean') refuse(`"${name}" is not an expression`);
          return node(at.of);
        case 'span':
          if (typeof at.unit !== 'string' || !UNITS.has(at.unit)) refuse(`"${name}" moves by no unit`);
          return node(at.of);
        case 'call':
          if (typeof at.fn !== 'string' || !FUNCTIONS.has(at.fn)) refuse(`"${name}" calls no function an expression knows`);
          if (!Array.isArray(at.args) || !at.args.length) refuse(`"${name}" calls a function with nothing`);
          return (at.args as unknown[]).forEach(node);
        case 'op':
          if (typeof at.op !== 'string' || !OPS.has(at.op)) refuse(`"${name}" has no operator an expression knows`);
          node(at.left);
          return node(at.right);
        /* `today`, `now` and `me` are this request's: folded by whoever resolved the column, never left for the statement. */
        default:
          refuse(`"${name}" is not an expression with its constants said`);
      }
    };
    node(def.expr);
    const kindOf = (path: string) => columnRead(table.columns.find((column) => column.name === path))?.kind;
    try {
      computedKind(def.expr, kindOf);
    } catch {
      refuse(`"${name}" does not type`);
    }
    out.set(name, { type: def.type, expr: def.expr, reads: computedReads(def.expr) });
  }
  return out;
}

/**
 * The filter as buildWhere takes it, with its computed columns written where a condition names one: the filter
 * without them, a column resolver that writes the expression in place of the name, and a types reader that says
 * nothing of a computed name (it has no catalog type, so it compares by the operator as written). `column` is how
 * the read writes its own columns; the expression's reads are written through it too.
 */
export function withComputedWhere(
  filter: Filter,
  table: TableMeta,
  style: SqlStyle,
  column: (name: string, condition?: Condition) => string = (name) => style.quote(name),
  types?: (name: string) => string | undefined,
): { filter: Filter; column: (name: string, condition?: Condition) => string; types?: (name: string) => string | undefined } {
  const computed = checkedComputed(filter, table);
  const { computed: _carried, ...rest } = filter;
  if (!computed.size) return { filter: rest, column, types };
  const kindOf = (path: string) => columnRead(table.columns.find((c) => c.name === path));
  const written = new Map([...computed].map(([name, def]) => [name, `(${compileComputed(def, style, (path) => column(path), kindOf)})`]));
  return {
    filter: rest,
    column: (name, condition) => written.get(name) ?? column(name, condition),
    types: types && ((name) => (written.has(name) ? undefined : types(name))),
  };
}
