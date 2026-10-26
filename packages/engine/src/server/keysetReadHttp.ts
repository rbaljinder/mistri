/**
 * The query bar's side of paging by key (shared/keysetPage.ts): which order a
 * read pages in, the continuation a step asks for, and the page's boundaries
 * for the next step. A table read and a view read the bar falls through to
 * each get the same three answers, one over columns and one over paths.
 *
 * A boundary needs every order column in the row. A list that sorts by one
 * it does not show (`show name sort created_at`) asks for it too, and it is
 * taken out of the rows before they are sent: the reader may sort by it, so
 * they may read it, but the list did not ask to show it.
 */
import type { Filter } from '../adapters/adapter.js';
import { defaultOrder, resolveOrder, withKey, type DatabaseSchema, type Order, type TableMeta } from '../shared/schema.js';
import type { ViewDef, ViewCondition } from '../shared/viewPaths.js';
import {
  continueGroups,
  keysetAfter,
  keysetOrder,
  pageBounds,
  reversedOrder,
  type PageBounds,
  type PageStep,
} from '../shared/keysetPage.js';
import type { RecordsContinuation, ViewContinuation } from './resourceReadOperations.js';

type Row = Record<string, unknown>;

/** The groups past (or, read the other way, before) a step's boundary; undefined when it names no exact boundary. */
function continuationGroups(table: TableMeta, order: readonly Order[], step: PageStep, dialect: DatabaseSchema['dialect']) {
  if ('end' in step) return { reverse: true, groups: undefined };
  const reverse = 'before' in step;
  const tail = keysetAfter(table, reverse ? reversedOrder(order) : order, reverse ? step.before : step.after, dialect);
  return tail && { reverse, groups: tail };
}

interface RecordsPaging {
  order: Order[];
  /** The columns to read: the request's, with any order column it left out. */
  columns?: string[];
  continuation?: RecordsContinuation;
  /** Read for the boundary only, and taken out of the rows. */
  extra: string[];
}

/** How a table read pages, or undefined when it can only page by offset. */
export function recordsPaging(
  table: TableMeta,
  dialect: DatabaseSchema['dialect'],
  orderBy: Order[] | undefined,
  columns: string[] | undefined,
  filter: Filter | undefined,
  step: PageStep | undefined,
): RecordsPaging | undefined {
  const { order } = resolveOrder(table, orderBy);
  if (!keysetOrder(table, order, dialect)) return undefined;
  const extra = columns?.length ? order.map((o) => o.column).filter((column) => !columns.includes(column)) : [];
  const planned = step && continuationGroups(table, order, step, dialect);
  if (step && !planned) return { order, extra: [] };
  return {
    order,
    extra,
    ...(extra.length ? { columns: [...columns!, ...extra] } : {}),
    ...(planned
      ? {
          continuation: { reverse: planned.reverse, ...(planned.groups ? { groups: continueGroups(filter?.groups, planned.groups) } : {}) },
        }
      : {}),
  };
}

export interface ViewPaging {
  /** The view as it is read: its order made total, and any order column it left out asked for. */
  view: ViewDef;
  order: Order[];
  continuation?: ViewContinuation;
  extra: string[];
}

/**
 * How a view read pages. Only an order over the base table's own columns
 * pages by key: a path through a reference, an aggregate's alias, a distance
 * or byte-ordered text keep the offset. Its order is made total with the key,
 * as a table read's is (withKey), on every page, so the first page and the
 * next agree about ties.
 */
export function viewPaging(schema: DatabaseSchema, table: TableMeta, view: ViewDef, step: PageStep | undefined): ViewPaging | undefined {
  const given = view.orderBy ?? [];
  if (given.some((o) => o.alias || o.near !== undefined || o.collation !== undefined || !table.columns.some((c) => c.name === o.path)))
    return undefined;
  const order = given.length
    ? withKey(
        table,
        given.map((o) => ({ column: o.path, direction: o.direction })),
      )
    : defaultOrder(table);
  if (!keysetOrder(table, order, schema.dialect)) return undefined;
  // No columns is every column of the base table, the order's among them.
  const shown = new Set(view.columns.map((c) => c.path));
  const extra = view.columns.length ? order.map((o) => o.column).filter((column) => !shown.has(column)) : [];
  const read: ViewDef = {
    ...view,
    orderBy: order.map((o) => ({ path: o.column, direction: o.direction })),
    ...(extra.length ? { columns: [...view.columns, ...extra.map((path) => ({ path }))] } : {}),
  };
  const planned = step && continuationGroups(table, order, step, schema.dialect);
  if (step && !planned) return { view: read, order, extra };
  const toPaths = (groups: ReturnType<typeof keysetAfter> & object): ViewCondition[][] =>
    groups.map((group) => group.map(({ column, op, value }) => ({ path: column, op, ...(value === undefined ? {} : { value }) })));
  return {
    view: read,
    order,
    extra,
    ...(planned
      ? {
          continuation: {
            reverse: planned.reverse,
            orderBy: planned.reverse ? reversedOrder(order).map((o) => ({ path: o.column, direction: o.direction })) : read.orderBy!,
            ...(planned.groups ? { groups: continueGroups(view.filter?.groups, toPaths(planned.groups)) } : {}),
          },
        }
      : {}),
  };
}

/** The page's boundaries, then the rows and columns without what was read only for them. */
export function settlePage(
  order: readonly Order[],
  extra: readonly string[],
  result: { rows: Row[]; columns: string[] },
  name: (column: string) => string = (column) => column,
): { bounds?: PageBounds; rows: Row[]; columns: string[] } {
  const bounds = pageBounds(order, result.rows, name);
  if (!extra.length) return { ...(bounds ? { bounds } : {}), rows: result.rows, columns: result.columns };
  const dropped = new Set(extra.map(name));
  return {
    ...(bounds ? { bounds } : {}),
    rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !dropped.has(key)))),
    columns: result.columns.filter((column) => !dropped.has(column)),
  };
}
