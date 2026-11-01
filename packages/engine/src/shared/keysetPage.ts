/**
 * Paging by key: the next page is the rows after the last one shown, in the
 * list's own order, rather than the rows after skipping every earlier page.
 *
 * An offset makes the database walk and throw away every row before the
 * page — page 40,000 of a sorted list was fifteen seconds on SQLite with the
 * server's one handle held throughout — and the HTTP routes refuse one past
 * 10,000 (MAX_PAGE_OFFSET). A page after a boundary costs what the first
 * page costs, however deep: the boundary is the last row's sort values and
 * key, and the continuation is "after it in this order", which an index on
 * the sort column reads as a range.
 *
 * The continuation is a filter like any other, so every layer that checks a
 * filter — a reader's grants, hidden columns, a row scope — checks it: it is
 * only ever an additional AND on columns the reader already sorts by. Where a
 * boundary cannot be exact the list pages by offset as before: no primary
 * key (the order is not total), a sort through a reference, or a column whose
 * value does not come back as it is stored (JSON, bytes, money, a float
 * read back rounded).
 *
 * NULL sorts last ascending on PostgreSQL and first on SQLite, and
 * no statement here says NULLS FIRST/LAST, so each engine's own placement is
 * the one the continuation follows.
 */
import { columnKind, declaredOrder, primaryKey, type Dialect, type Order, type TableMeta } from './schema.js';
import type { Condition } from './filter.js';

/** One boundary value per order column, as the row carried it. */
export type Boundary = Record<string, string | number | boolean | null>;

/** Where a page starts: after a row, before one, or at the end of the list. */
export type PageStep = { after: Boundary } | { before: Boundary } | { end: true };

/** The first and last rows' boundaries, for the pages either side. */
export interface PageBounds {
  first: Boundary;
  last: Boundary;
}

type Term = Pick<Condition, 'column' | 'op' | 'value'>;

/* The types whose value comes back as the engine compares it. */
const UNFAITHFUL = /json|xml|money|bytea|blob|binary|interval|array|\[\]/i;

/** Whether this order pages by key on this engine: total, and every column exact. */
export function keysetOrder(table: TableMeta, order: readonly Order[], dialect: Dialect): boolean {
  if (dialect !== 'postgres' && dialect !== 'sqlite') return false;
  const key = primaryKey(table);
  if (!key.length || !key.every((column) => order.some((o) => o.column === column))) return false;
  return order.every((o) => {
    const column = table.columns.find((c) => c.name === o.column);
    if (!column || UNFAITHFUL.test(column.type)) return false;
    const kind = columnKind(column.type);
    if (kind === 'other') return false;
    return true;
  });
}

/** The body fields a step is said in: a route that names the fields its body may carry names these too. */
export const PAGE_STEP_FIELDS = ['after', 'before', 'end'] as const;

/** Read a step from a request body: absent, one of the three, or malformed. */
export function readPageStep(body: Record<string, unknown>): PageStep | undefined | 'invalid' {
  const given = PAGE_STEP_FIELDS.filter((key) => body[key] !== undefined);
  if (!given.length) return undefined;
  if (given.length > 1) return 'invalid';
  if (given[0] === 'end') return body.end === true ? { end: true } : 'invalid';
  const raw = body[given[0]];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 64) return 'invalid';
  for (const value of Object.values(raw)) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
      return 'invalid';
  }
  return given[0] === 'after' ? { after: raw as Boundary } : { before: raw as Boundary };
}

/** The same order read the other way: the page before a row, or the list's end. */
export function reversedOrder(order: readonly Order[]): Order[] {
  return order.map((o) => ({ column: o.column, direction: o.direction === 'asc' ? ('desc' as const) : ('asc' as const) }));
}

/**
 * The rows after `boundary` in `order`, as OR-of-AND groups over its
 * columns; undefined when the boundary does not name a value for every one,
 * or names null for a column that cannot hold it. A strict comparison at one
 * position, equality at every earlier one; the first column's bound (`>=`,
 * `<=`) rides in each branch that compares it, which buildWhere says once so
 * an index on it reads a range.
 */
export function keysetAfter(table: TableMeta, order: readonly Order[], boundary: Boundary, dialect: Dialect): Term[][] | undefined {
  const nullsHigh = dialect === 'postgres';
  const columns = order.map((o) => table.columns.find((c) => c.name === o.column));
  if (columns.some((c) => !c)) return undefined;
  for (const [at, o] of order.entries()) {
    if (!Object.hasOwn(boundary, o.column)) return undefined;
    if (boundary[o.column] === null && !columns[at]!.nullable) return undefined;
  }
  const equal = (column: string): Term =>
    boundary[column] === null ? { column, op: 'isNull' } : { column, op: '=', value: boundary[column] as string | number | boolean };
  /* A vocabulary sorts as declared (schema.ts declaredOrder), NULL after
     its last value on every engine: the rows past a value are the values
     after it in the list, named, which an index reads as well as a range. */
  const declared = columns.map((column) => declaredOrder(column));
  for (const [at, o] of order.entries()) {
    const value = boundary[o.column];
    if (declared[at] && value !== null && !declared[at]!.includes(String(value))) return undefined;
  }
  const pastDeclared = (o: Order, values: readonly string[], nullable: boolean): Term[] => {
    const value = boundary[o.column],
      up = o.direction === 'asc';
    if (value === null) return up ? [] : [{ column: o.column, op: 'isNotNull' }];
    const rank = values.indexOf(String(value));
    const after = up ? values.slice(rank + 1) : values.slice(0, rank);
    return [
      ...(after.length ? [{ column: o.column, op: 'in' as const, value: [...after] }] : []),
      ...(up && nullable ? [{ column: o.column, op: 'isNull' as const }] : []),
    ];
  };
  /* Where the rows past a value lie: above it ascending, below descending,
     and NULL is on whichever side the engine sorts it. */
  const past = (o: Order, nullable: boolean, at: number): Term[] => {
    if (declared[at]) return pastDeclared(o, declared[at]!, nullable);
    const value = boundary[o.column],
      up = o.direction === 'asc';
    if (value === null) return up === nullsHigh ? [] : [{ column: o.column, op: 'isNotNull' }];
    const strict: Term = { column: o.column, op: up ? '>' : '<', value };
    return nullable && up === nullsHigh ? [strict, { column: o.column, op: 'isNull' }] : [strict];
  };
  const first = order[0],
    lead = boundary[first.column];
  const bound: Term | undefined =
    lead === null || declared[0] ? undefined : { column: first.column, op: first.direction === 'asc' ? '>=' : '<=', value: lead };
  const groups: Term[][] = [];
  for (const [at, o] of order.entries()) {
    const prefix = order.slice(0, at).map((p) => equal(p.column));
    for (const term of past(o, columns[at]!.nullable, at)) {
      const branch = [...prefix, term];
      // The bound holds wherever the first column is compared with a value; a NULL branch has none.
      const compared = branch[0].op !== 'isNull' && branch[0].op !== 'isNotNull';
      groups.push(bound && compared ? [bound, ...branch] : branch);
    }
  }
  return groups;
}

/** A filter's groups, each continued by every branch: the rows it matches past the boundary. */
export function continueGroups<T>(base: readonly (readonly T[])[] | undefined, tail: readonly (readonly T[])[]): T[][] {
  const starting = base?.filter((group) => group.length).length ? base.filter((group) => group.length) : [[]];
  return starting.flatMap((group) => tail.map((branch) => [...group, ...branch]));
}

/** The boundaries of a page's first and last rows, where every order column came back with them. */
export function pageBounds(
  order: readonly Order[],
  rows: readonly Record<string, unknown>[],
  name: (column: string) => string = (column) => column,
): PageBounds | undefined {
  if (!rows.length) return undefined;
  const read = (row: Record<string, unknown>): Boundary | undefined => {
    const boundary: Boundary = {};
    for (const o of order) {
      const key = name(o.column);
      if (!Object.hasOwn(row, key)) return undefined;
      const value = row[key];
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))
      )
        return undefined;
      boundary[o.column] = value as Boundary[string];
    }
    return boundary;
  };
  const first = read(rows[0]),
    last = read(rows[rows.length - 1]);
  return first && last ? { first, last } : undefined;
}
