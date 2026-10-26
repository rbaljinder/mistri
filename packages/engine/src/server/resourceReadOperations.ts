import {
  ESTIMATE_ABOVE,
  OPS,
  Refusal,
  clampLimit,
  clampOffset,
  type Adapter,
  type CountResult,
  type Filter,
  type QueryRequest,
} from '../adapters/adapter.js';
import { snapshotScopedData } from '../adapters/scoped/scopedReads.js';
import { findTable, resolveOrder, type DatabaseSchema, type Order } from '../shared/schema.js';
import { withViewComputed, withViewLabels, type ViewDef } from '../shared/view.js';
import { measureConditions, withBreakdownComputed, withGroupNames, type BreakdownDef } from '../shared/breakdown.js';
import type { StructuredFilter } from '../shared/structuredFilter.js';
import { reversedOrder } from '../shared/keysetPage.js';

/** An already authorized, invocation-owned reader. No registry, credentials,
 * writer, or fallback adapter can be obtained through this service. */
export type ResourceReader = Pick<
  Adapter,
  'query' | 'count' | 'estimateCount' | 'runView' | 'countView' | 'runBreakdown' | 'countBreakdown'
> &
  Partial<Pick<Adapter, 'countEach'>>;
type ReadCountMode = 'none' | 'exact' | 'estimate';
type RecordReadInput = Omit<QueryRequest, 'limit' | 'offset'> & { limit?: unknown; offset?: unknown };
interface ReadPagination {
  limit?: unknown;
  offset?: unknown;
}
/**
 * A page read by key (keysetPage.ts): the rows past a boundary, or read the
 * other way and turned round — the page before one, or the list's end. The
 * total is still the question's own; the offset is only what the page is
 * called, never skipped.
 */
export interface RecordsContinuation {
  groups?: Filter['groups'];
  reverse: boolean;
}
export interface ViewContinuation {
  groups?: NonNullable<ViewDef['filter']>['groups'];
  orderBy: NonNullable<ViewDef['orderBy']>;
  reverse: boolean;
}

export class ResourceReadError extends Error {
  constructor(
    readonly status: 400 | 404 | 501,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceReadError';
  }
}

/** The most a bounded count counts. Asking for more is clamped, not refused:
 * the bound is what keeps the count cheap, so the server has the last word. */
export const MAX_COUNT_LIMIT = 100_000;

/**
 * The bound a list's total, a tab's badge and a record's references are
 * counted to when the request names none: past it the answer is "10,000+".
 * A filtered total is a COUNT(*) that cannot be estimated, and on a large
 * table it was most of the read — a million-row Postgres list spent 64 ms
 * counting what 7 ms bounded said as well as anyone reads it. The exact
 * number stays one explicit request away (`exactCount`).
 */
export const DEFAULT_COUNT_LIMIT = 10_000;

/**
 * A request's `countLimit`. Absent (undefined or null) is the count the route
 * always gave; otherwise a positive whole number, clamped to MAX_COUNT_LIMIT.
 * Anything else is refused rather than read as absent: an unreadable bound
 * quietly becoming no bound is the full scan the caller asked to avoid.
 */
export function countLimitOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ResourceReadError(400, 'countLimit must be a positive whole number.');
  }
  return Math.min(value, MAX_COUNT_LIMIT);
}

function capture(
  reader: ResourceReader,
  needs: {
    records?: boolean;
    count?: boolean;
    estimate?: boolean;
    view?: boolean;
    viewCount?: boolean;
    breakdown?: boolean;
    breakdownCount?: boolean;
    countEach?: boolean;
  },
): Partial<ResourceReader> {
  // Capture methods as well as their receiver before any driver wait. Replacing
  // an adapter property during a read cannot redirect its count to another one.
  try {
    const query = needs.records ? reader.query?.bind(reader) : undefined;
    const count = needs.count ? reader.count?.bind(reader) : undefined;
    const estimateCount = needs.estimate ? reader.estimateCount?.bind(reader) : undefined;
    const runView = needs.view ? reader.runView?.bind(reader) : undefined;
    const countView = needs.viewCount ? reader.countView?.bind(reader) : undefined;
    const runBreakdown = needs.breakdown ? reader.runBreakdown?.bind(reader) : undefined;
    const countBreakdown = needs.breakdownCount ? reader.countBreakdown?.bind(reader) : undefined;
    const countEach = needs.countEach ? reader.countEach?.bind(reader) : undefined;
    return {
      countEach: countEach && ((items, limit) => provider(() => countEach(items, limit))),
      query: query && ((request) => provider(() => query(request))),
      count:
        count && ((table, filter, limit) => provider(() => (limit === undefined ? count(table, filter) : count(table, filter, limit)))),
      estimateCount: estimateCount && ((table) => provider(() => estimateCount(table))),
      runView: runView && ((view, offset) => provider(() => runView(view, offset))),
      countView: countView && ((view, limit) => provider(() => (limit === undefined ? countView(view) : countView(view, limit)))),
      runBreakdown: runBreakdown && ((definition, offset) => provider(() => runBreakdown(definition, offset))),
      countBreakdown:
        countBreakdown &&
        ((definition, limit) => provider(() => (limit === undefined ? countBreakdown(definition) : countBreakdown(definition, limit)))),
    };
  } catch (error) {
    throw providerError(error);
  }
}

function providerError(error: unknown): unknown {
  // The class alone is not proof of a safe, request-derived diagnostic. Strip
  // it at the provider boundary; ordinary database callers retain the message,
  // while App HTTP applies its normal private-error projection.
  return error instanceof ResourceReadError ? new Error(error.message, { cause: error }) : error;
}

async function provider<R>(work: () => Promise<R>): Promise<R> {
  try {
    return await work();
  } catch (error) {
    throw providerError(error);
  }
}

/** Validate already captured data. Shared by operation services and private
 * capability boundaries; malformed predicates must never become an absent one. */
export function assertStructuredReadFilter<Field extends 'column' | 'path'>(
  filter: unknown,
  field: Field,
): asserts filter is StructuredFilter<Field> | null | undefined {
  if (filter === undefined || filter === null) return;
  const fail = (): never => {
    throw new ResourceReadError(400, 'Invalid structured filter.');
  };
  if (typeof filter !== 'object' || Array.isArray(filter)) fail();
  const given = filter as Record<string, unknown>;
  if (Object.keys(given).some((key) => key !== 'groups') || !Array.isArray(given.groups)) fail();
  const scalar = (value: unknown) =>
    value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  for (const group of given.groups as unknown[]) {
    if (!Array.isArray(group)) fail();
    for (const raw of group as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
      const condition = raw as Record<string, unknown>;
      /* A column on the right is a path only a view resolves: a plain
         table read has no way to check it against its reader's grants. */
      const other = field === 'path' && condition.other !== undefined;
      /* The rows that point at the record (`any opportunity where …`): asked
         is (not) empty of the record, their own condition one level down,
         judged by the same rule. A view checks the hop against its grants. */
      if (field === 'path' && condition.any !== undefined) {
        const any = condition.any as Record<string, unknown> | null;
        if (
          Object.keys(condition).some((key) => !['path', 'op', 'any'].includes(key)) ||
          typeof condition.path !== 'string' ||
          (condition.op !== 'isNull' && condition.op !== 'isNotNull') ||
          !any ||
          typeof any !== 'object' ||
          Array.isArray(any) ||
          Object.keys(any).some((key) => key !== 'via' && key !== 'filter') ||
          typeof any.via !== 'string' ||
          !any.via.includes('.')
        )
          fail();
        assertStructuredReadFilter(any!.filter, 'column');
        continue;
      }
      if (
        Object.keys(condition).some((key) => ![field, 'op', 'value', 'collation', ...(other ? ['other'] : [])].includes(key)) ||
        typeof condition[field] !== 'string' ||
        !condition[field].length
      )
        fail();
      if (typeof condition.op !== 'string') fail();
      if (other) {
        if (
          typeof condition.other !== 'string' ||
          !condition.other.length ||
          condition.value !== undefined ||
          !['=', '!=', '>', '>=', '<', '<='].includes(condition.op as string)
        )
          fail();
        continue;
      }
      // A byte comparison (an API cursor's boundary) narrows, never widens.
      if (
        condition.collation !== undefined &&
        (condition.collation !== 'binary' || !['=', '!=', '>', '>=', '<', '<='].includes(condition.op as string))
      )
        fail();
      if (!OPS.has(condition.op as string)) {
        throw new ResourceReadError(400, `"${condition.op}" is not an operator this tool knows.`);
      }
      if (condition.op === 'in' || condition.op === 'has') {
        if (!Array.isArray(condition.value) || !condition.value.every(scalar)) fail();
      } else if (condition.op === 'isNull' || condition.op === 'isNotNull') {
        if (condition.value !== undefined && !scalar(condition.value)) fail();
      } else if (!scalar(condition.value)) fail();
    }
  }
}

function checkedPathFilter<T extends { filter?: unknown }>(
  definition: T,
): asserts definition is T & { filter?: StructuredFilter<'path'> | null } {
  assertStructuredReadFilter(definition.filter, 'path');
}

function checkedTable(schema: DatabaseSchema, tableId: string, request: { filter?: Filter; columns?: unknown[]; orderBy?: Order[] }) {
  const table = findTable(schema, tableId);
  if (!table) throw new ResourceReadError(404, `Unknown table "${tableId}"`);
  const filter: unknown = request.filter;
  assertStructuredReadFilter(filter, 'column');
  const known = new Set(table.columns.map((column) => column.name));
  const named: string[] = [];
  for (const group of filter?.groups ?? []) {
    if (!Array.isArray(group)) continue;
    for (const condition of group) if (condition && typeof condition.column === 'string') named.push(condition.column);
  }
  for (const column of request.columns ?? []) if (typeof column === 'string') named.push(column);
  for (const order of request.orderBy ?? []) if (order && typeof order.column === 'string') named.push(order.column);
  const unknown = [...new Set(named.filter((column) => !known.has(column)))];
  if (unknown.length)
    throw new ResourceReadError(400, `"${table.name}" has no column ${unknown.map((column) => `"${column}"`).join(', ')}.`);
  return table;
}

async function counted(
  reader: Partial<ResourceReader>,
  table: string,
  filter: Filter | undefined,
  exact: boolean,
  bound?: number,
): Promise<CountResult> {
  if (bound !== undefined) {
    /* Counted, never estimated: the bound is what makes the count cheap, and
       its answer is about the rows this reader may see, which a catalog
       figure is not. One row past the bound is enough to know there are more. */
    if (!reader.count) throw new ResourceReadError(501, 'This connection cannot count records.');
    const n = await reader.count(table, filter, bound + 1);
    return n > bound ? { count: bound, exact: true, capped: true } : { count: n, exact: true };
  }
  if (!exact && !filter?.groups?.length && reader.estimateCount) {
    let estimate: number | undefined;
    try {
      estimate = await reader.estimateCount(table);
    } catch (error) {
      // Statistics may be unavailable, but a policy/lifetime refusal is not
      // permission to start another read after the capability has refused.
      if (error instanceof Refusal) throw error;
    }
    if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= ESTIMATE_ABOVE) {
      return { count: estimate, exact: false };
    }
  }
  if (!reader.count) throw new ResourceReadError(501, 'This connection cannot count records.');
  return { count: await reader.count(table, filter), exact: true };
}

/** Settle both accepted reads, including synchronous throws. A failed count
 * must not return partial rows or release an invocation while rows still run.
 * This is completion ownership, not a shared database snapshot. */
async function together<R, C>(rows: () => Promise<R>, count: () => Promise<C>): Promise<[R, C]> {
  const [result, total] = await Promise.allSettled([Promise.resolve().then(rows), Promise.resolve().then(count)]);
  if (result.status === 'rejected') throw result.reason;
  if (total.status === 'rejected') throw total.reason;
  return [result.value, total.value];
}

export async function readCount(
  reader: ResourceReader,
  schema: DatabaseSchema,
  input: { table: string; filter?: Filter; exact?: boolean; countLimit?: unknown },
): Promise<CountResult> {
  const request = snapshotScopedData(input);
  const table = checkedTable(schema, request.table, request);
  const bound = countLimitOf(request.countLimit);
  return counted(
    capture(reader, { count: true, estimate: bound === undefined && request.exact !== true && !request.filter?.groups?.length }),
    table.id,
    request.filter,
    request.exact === true,
    bound,
  );
}

/**
 * Several bounded counts, in one statement where the reader can say them in
 * one (Adapter.countEach) and one by one where it cannot — a row-scoped or
 * tenant reader, whose counts compile under its scope. Either way each is
 * counted to `countLimit` (DEFAULT_COUNT_LIMIT when absent) and said as
 * `capped` past it. An unfiltered count of a table the catalog calls large is
 * the catalog's estimate instead, as a list's own total is.
 */
export async function readCounts(
  reader: ResourceReader,
  schema: DatabaseSchema,
  inputs: ReadonlyArray<{ table: string; filter?: Filter }>,
  countLimit?: unknown,
): Promise<CountResult[]> {
  const given = snapshotScopedData(inputs);
  const bound = countLimitOf(countLimit) ?? DEFAULT_COUNT_LIMIT;
  const items = given.map((item) => ({ table: checkedTable(schema, item.table, item).id, filter: item.filter }));
  const results = Array.from<CountResult | undefined>({ length: items.length });
  const large = (table: string) => (findTable(schema, table)?.approxRows ?? 0) >= ESTIMATE_ABOVE;
  const estimates = items.map((item, i) => ({ item, i })).filter(({ item }) => !item.filter?.groups?.length && large(item.table));
  if (estimates.length) {
    const bound = capture(reader, { count: true, estimate: true });
    for (const { item, i } of estimates) results[i] = await counted(bound, item.table, undefined, false);
  }
  const rest = items.map((item, i) => ({ item, i })).filter(({ i }) => !results[i]);
  const said = (n: number): CountResult => (n > bound ? { count: bound, exact: true, capped: true } : { count: n, exact: true });
  const each = rest.length > 1 ? capture(reader, { countEach: true }).countEach : undefined;
  if (each) {
    const counts = await each(
      rest.map(({ item }) => item),
      bound + 1,
    );
    rest.forEach(({ i }, at) => {
      results[i] = said(counts[at]);
    });
  } else if (rest.length) {
    const { count } = capture(reader, { count: true });
    if (!count) throw new ResourceReadError(501, 'This connection cannot count records.');
    await inWindows(rest, async ({ item, i }) => {
      results[i] = said(await count(item.table, item.filter, bound + 1));
    });
  }
  return results as CountResult[];
}

/* Counts one at a time, a few at once, as a record's references always were
   on a reader that cannot say them in one statement: all of them together is
   a dozen scans against the connection serving the page, and strictly one
   after another lets one slow count hold every other. A window settles
   whole before a failure is thrown, so no count is still running when the
   request answers, and no further window starts after one. */
const COUNT_WINDOW = 4;
async function inWindows<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += COUNT_WINDOW) {
    const settled = await Promise.allSettled(items.slice(at, at + COUNT_WINDOW).map(run));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

export async function readRecords(
  reader: ResourceReader,
  schema: DatabaseSchema,
  input: RecordReadInput,
  countMode: ReadCountMode = 'none',
  countLimit?: unknown,
  continuation?: RecordsContinuation,
) {
  const given = snapshotScopedData(input);
  const table = checkedTable(schema, given.table, given);
  const countBound = countMode === 'none' ? undefined : countLimitOf(countLimit);
  /* An API answers in its own order. With none asked for, none is sent: the
     key as a default sort is one most APIs do not document, and would turn
     every plain list into a refusal (adapters/http). */
  const order = snapshotScopedData(
    schema.dialect === 'http' && !given.orderBy?.length ? { order: [] as Order[], implicit: true } : resolveOrder(table, given.orderBy),
  );
  const request: QueryRequest = {
    ...given,
    table: table.id,
    orderBy: order.order,
    limit: clampLimit(given.limit),
    offset: clampOffset(given.offset),
  };
  const bound = capture(reader, {
    records: true,
    count: countMode !== 'none',
    estimate: countMode === 'estimate' && countBound === undefined && !request.filter?.groups?.length,
  });
  if (!bound.query) throw new ResourceReadError(501, 'This connection cannot query records.');
  const countFilter = snapshotScopedData(request.filter);
  const page = continuation && snapshotScopedData(continuation);
  const rowsRequest: QueryRequest = !page
    ? request
    : {
        ...request,
        offset: 0,
        orderBy: page.reverse ? reversedOrder(request.orderBy ?? []) : request.orderBy,
        ...(page.groups ? { filter: { groups: page.groups } } : {}),
      };
  const [read, total] = await together(
    () => bound.query!(snapshotScopedData(rowsRequest)),
    () =>
      countMode === 'none' ? Promise.resolve(undefined) : counted(bound, request.table, countFilter, countMode === 'exact', countBound),
  );
  const result = page?.reverse ? { ...read, rows: [...read.rows].reverse() } : read;
  return { request, result, order, total };
}

/** How many rows a view matches, bounded as readCounts bounds a table's, with
 * no rows read: a tab whose question walks a reference. */
export async function readViewCount(
  reader: ResourceReader,
  schema: DatabaseSchema,
  input: ViewDef,
  countLimit?: unknown,
): Promise<CountResult> {
  const { references: _requested, ...given } = snapshotScopedData(input);
  checkedTable(schema, given.base, {});
  checkedPathFilter(given);
  /* The catalog's rollups too, as readView takes them: a tab whose question
     names one ("replies = 0") was counted without them and refused the whole
     batch of tab counts. */
  const pinned = withViewComputed(schema, given);
  const view = {
    ...given,
    labels: withViewLabels(schema, given).labels,
    computed: pinned.computed,
    expressions: pinned.expressions,
    tagged: pinned.tagged,
  };
  if (!view.labels) delete view.labels;
  if (!view.computed) delete view.computed;
  if (!view.expressions) delete view.expressions;
  if (!view.tagged) delete view.tagged;
  const bound = countLimitOf(countLimit) ?? DEFAULT_COUNT_LIMIT;
  const { countView } = capture(reader, { viewCount: true });
  if (!countView) throw new ResourceReadError(501, `${schema.dialect} connections cannot count views in this build.`);
  const n = await countView(snapshotScopedData(view), bound + 1);
  return n > bound ? { count: bound, exact: true, capped: true } : { count: n, exact: true };
}

/** A count read one past its bound, said the way `counted` says it: the bound, and `capped`. */
function boundedTotal(n: number | undefined, bound: number | undefined): { total: number | undefined; capped?: true } {
  return n !== undefined && bound !== undefined && n > bound ? { total: bound, capped: true } : { total: n };
}

export async function readView(
  reader: ResourceReader,
  schema: DatabaseSchema,
  input: ViewDef,
  pagination: ReadPagination = {},
  countMode: 'none' | 'exact' = 'exact',
  countLimit?: unknown,
  continuation?: ViewContinuation,
) {
  // Declared references are attached below this read by the App's resource layer, never taken from a request.
  const { references: _requested, ...given } = snapshotScopedData(input);
  checkedTable(schema, given.base, {});
  checkedPathFilter(given);
  // A `$label` path's template, and a rollup's rows, are this catalog's (an
  // App's), never the request's.
  const pinned = withViewComputed(schema, given);
  const view = {
    ...given,
    labels: withViewLabels(schema, given).labels,
    computed: pinned.computed,
    expressions: pinned.expressions,
    tagged: pinned.tagged,
  };
  if (!view.labels) delete view.labels;
  if (!view.computed) delete view.computed;
  if (!view.expressions) delete view.expressions;
  if (!view.tagged) delete view.tagged;
  const page = snapshotScopedData(pagination);
  const limit = clampLimit(page.limit ?? view.limit);
  const offset = clampOffset(page.offset);
  const countBound = countMode === 'none' ? undefined : countLimitOf(countLimit);
  const bound = capture(reader, { view: true, viewCount: countMode === 'exact' });
  const run = bound.runView;
  const count = countMode === 'none' ? undefined : bound.countView;
  if (!run) throw new ResourceReadError(501, `${schema.dialect} connections cannot run views in this build.`);
  const step = continuation && snapshotScopedData(continuation);
  const rowsView: ViewDef = !step ? view : { ...view, orderBy: step.orderBy, ...(step.groups ? { filter: { groups: step.groups } } : {}) };
  const [read, counted] = await together(
    () => run({ ...snapshotScopedData(rowsView), limit }, step ? 0 : offset),
    () => (count ? count(snapshotScopedData(view), countBound === undefined ? undefined : countBound + 1) : Promise.resolve(undefined)),
  );
  const result = step?.reverse ? { ...read, rows: [...read.rows].reverse() } : read;
  const { total, capped } = boundedTotal(counted, countBound);
  /* A capped total is a floor, not the end: whether a page follows is the
     page's own evidence, as it is when there is no total at all. */
  const more = total === undefined || capped ? result.rows.length >= limit : offset + result.rows.length < total;
  return { view, result, total, ...(capped ? { capped } : {}), more, limit, offset };
}

export async function readBreakdown(
  reader: ResourceReader,
  schema: DatabaseSchema,
  input: BreakdownDef,
  pagination: ReadPagination = {},
  countLimit?: unknown,
) {
  const { references: _requested, ...given } = snapshotScopedData(input);
  checkedTable(schema, given.base, {});
  checkedPathFilter(given);
  /* A `count when [...]` carries a filter of its own; it is held to the same shape as the section's. */
  for (const where of measureConditions(given.measures)) assertStructuredReadFilter(where, 'path');
  const page = snapshotScopedData(pagination);
  const limit = clampLimit(page.limit ?? given.limit);
  const offset = clampOffset(page.offset);
  const countBound = countLimitOf(countLimit);
  const breakdown = { ...given, limit };
  /* What runs carries the rollups a measure, a key or a condition names:
     this catalog's, never the request's. The answer echoes the def asked. */
  const ran = withBreakdownComputed(schema, breakdown as BreakdownDef) as typeof breakdown;
  const grouped = Boolean(breakdown.by?.length);
  const bound = capture(reader, { breakdown: true, breakdownCount: grouped });
  const run = bound.runBreakdown;
  if (!run) throw new ResourceReadError(501, `${schema.dialect} connections cannot group in this build.`);
  /* No `by` is one group, always: an aggregate with no GROUP BY answers with
     exactly one row, even over no rows at all. Its count was a second
     statement — `SELECT COUNT(*) FROM (SELECT SUM(…))` — whose answer could
     only ever be 1, run beside every metric on every dashboard. */
  if (!grouped) {
    const result = await run(snapshotScopedData(ran), offset);
    return { breakdown, result, total: 1, limit, offset };
  }
  /* Grouped, the page itself usually says how many groups there are: one
     group past the page is asked for, and when it does not come back the
     groups ended on this page. Only a full page (or one past the end) still
     needs the count, and then it runs after the rows rather than beside them
     — a dashboard's charts and a rail's facets nearly never pay for it. */
  const peek = clampLimit(limit + 1);
  const read = await run(snapshotScopedData({ ...ran, limit: peek }), offset);
  const beyond = read.rows.length > limit;
  /* Each reference key's names beside the groups, out of the columns
     (withGroupNames), read off the page after the peek row is dropped: the
     group past the page is not in the answer, so neither is its name. */
  const result = withGroupNames(beyond ? { ...read, rows: read.rows.slice(0, limit) } : read);
  const settled = peek > limit && !beyond && (result.rows.length > 0 || offset === 0);
  let counted: number | undefined;
  if (settled) counted = offset + result.rows.length;
  else if (bound.countBreakdown) {
    counted = await bound.countBreakdown(snapshotScopedData(ran), countBound === undefined ? undefined : countBound + 1);
  }
  const { total, capped } = boundedTotal(counted, countBound);
  const { names, ...answer } = result;
  return { breakdown, result: answer, ...(names ? { names } : {}), total, ...(capped ? { capped } : {}), limit, offset };
}
