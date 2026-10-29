/*
 * The read contract both sides of the wire share: how many rows one read may
 * return, how a count is bounded, and what a read answers. The adapters
 * enforce it; the query language and the client page and export by the same
 * numbers.
 */
import { Refusal } from './refusal.js';
import { buildWhere, type Filter, type SqlStyle } from './filter.js';

/* ---------- the limit policy ----------

   One place, because a ceiling re-derived in four files is a ceiling that
   disagrees with itself. Every read goes through `clampLimit`, so there is no
   path to an unbounded query: a caller that omits a limit gets the default, a
   caller that asks for too many gets the ceiling, and a caller that sends
   nonsense gets the default rather than `LIMIT NaN`. */

/** What a caller gets when it does not say. Small on purpose: the first page
    of a browse should be instant, and paging is one click. */
export const DEFAULT_LIMIT = 20;

/** The hard ceiling. Nothing may exceed it, including an explicit request. */
export const MAX_LIMIT = 100_000;

/** The most rows one read answers for a table its reader may not export: the largest a screen reads (a tree list,
    read whole, is 2,000), so the list is never the way round an export grant (resourceReadHttp.ts). */
export const UNEXPORTED_MOST = 2_000;

/**
 * Above this many rows, an exact count is not worth what it costs.
 *
 * `COUNT(*)` is a scan. On a table of a few thousand rows that is free and the
 * exact number is strictly better; on a table of fifty million it is seconds of
 * work to compute a number that is stale before it is rendered, and it runs on
 * *every* query — the header stat is not something anyone asked for.
 *
 * The threshold is deliberately well above anything a person would notice the
 * difference on. Below it you get the true number; above it you get the
 * catalog's estimate and are told that is what it is.
 */
export const ESTIMATE_ABOVE = 50_000;

/** A row count, and whether it is the real one. */
export interface CountResult {
  count: number;
  /** False when this came from the catalog's statistics rather than a scan. */
  exact: boolean;
  /** Only when a bounded count stopped: `count` is the bound, and more rows match. */
  capped?: true;
}

/**
 * A count over one relation and its WHERE clause, optionally stopped.
 *
 * With `limit`, the inner SELECT reads at most that many matching rows, so
 * "how many, up to ten thousand" costs ten thousand rows however large the
 * table is. The relation and WHERE are the caller's own and unchanged: the
 * bound wraps the plan that already carries the row scope and the filter,
 * it never builds a second one. Without a limit the text is the plain
 * COUNT(*) it always was.
 *
 * The bound is written as digits, not bound as a parameter: it is an integer
 * checked here, and one statement shape then serves both drivers and the
 * scoped compiler — a driver may send a bound number as a DOUBLE, which
 * `LIMIT` refuses, and the scoped compiler does not know its driver.
 */
export function countStatement(relation: string, limit?: number): string {
  if (limit === undefined) return `SELECT COUNT(*) AS n FROM ${relation}`;
  checkBound(limit);
  return `SELECT COUNT(*) AS n FROM (SELECT 1 AS one FROM ${relation} LIMIT ${limit}) AS bounded`;
}

function checkBound(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Refusal('A count bound must be a positive whole number.');
}

/** Most counts one statement answers: a list's tabs, a record's references. */
export const COUNT_EACH_MAX = 64;

/** The most a menu row counts (`countLimit`); past it the row says 10,000+ (client navCounts.ts, and a first page's counts, server/http/firstPaintRooms.ts). */
export const NAV_COUNT_LIMIT = 10_000;

/** One count of a `countEach`: a relation the adapter has already checked
    against its catalog and quoted, and the filter over it. */
interface CountEachItem {
  relation: string;
  filter?: Filter;
}

/**
 * Several counts in one statement, each as `countStatement` would say it.
 *
 * Two shapes, both one round trip and one plan:
 *
 * - `together`: every item reads one relation and the caller knows that
 *   relation is small (at most the bound, by the catalog's figure). One scan
 *   answers them all, a conditional aggregate each — `COUNT(*) FILTER
 *   (WHERE …)` on Postgres, `COUNT(CASE WHEN … THEN 1 END)` elsewhere — and
 *   no count can pass the bound by much, so none needs one.
 * - otherwise, one bounded count per item joined by UNION ALL, each tagged
 *   with its position: a large table stops each scan at the bound instead of
 *   reading every row once for every tab.
 *
 * Rows come back as `{ i, n }` in either shape; `countEachRows` reads them.
 */
export function countEachStatement(
  items: readonly CountEachItem[],
  style: SqlStyle,
  options: { limit?: number; together?: boolean } = {},
): { text: string; params: unknown[] } {
  if (!items.length || items.length > COUNT_EACH_MAX) throw new Refusal(`One statement counts 1 to ${COUNT_EACH_MAX} things.`);
  const { limit, together = false } = options;
  if (limit !== undefined) checkBound(limit);
  const params: unknown[] = [];
  if (together && items.every((item) => item.relation === items[0].relation)) {
    const measures = items.map((item, i) => {
      const where = buildWhere(item.filter, style, params.length + 1);
      params.push(...where.params);
      const predicate = where.text.replace(/^ WHERE /, '');
      const measure = predicate ? (style.countWhere?.(predicate) ?? `COUNT(CASE WHEN ${predicate} THEN 1 END)`) : 'COUNT(*)';
      return `${measure} AS ${style.quote(`n${i}`)}`;
    });
    return { text: `SELECT ${measures.join(', ')} FROM ${items[0].relation}`, params };
  }
  const branches = items.map((item, i) => {
    const where = buildWhere(item.filter, style, params.length + 1);
    params.push(...where.params);
    const counted =
      limit === undefined
        ? `${item.relation}${where.text}`
        : `(SELECT 1 AS one FROM ${item.relation}${where.text} LIMIT ${limit}) AS ${style.quote(`c${i}`)}`;
    return `SELECT ${i} AS i, COUNT(*) AS n FROM ${counted}`;
  });
  return { text: branches.join('\nUNION ALL\n'), params };
}

/** The counts a `countEachStatement` answered, in the items' order. */
export function countEachRows(rows: readonly Record<string, unknown>[], length: number): number[] {
  const counts = Array.from({ length }, () => 0);
  if (rows.length === 1 && !('i' in rows[0])) {
    for (let i = 0; i < length; i++) counts[i] = Number(rows[0][`n${i}`] ?? 0);
    return counts;
  }
  for (const row of rows) {
    const i = Number(row.i);
    if (Number.isInteger(i) && i >= 0 && i < length) counts[i] = Number(row.n ?? 0);
  }
  return counts;
}

/**
 * Only a number or a numeric string counts as a request. Everything else —
 * undefined, null, '', [], {}, 'abc' — means "not specified" and gets the
 * default.
 *
 * The `null` case is why this cannot just be `Number(value)`: `Number(null)`
 * is 0, not NaN, so a null limit passed a finite check and clamped to 1. A
 * caller that omitted a limit would have got a single row and no error.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function clampLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const n = asNumber(value);
  if (n === undefined) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

/** Offsets have no ceiling but must be a real, non-negative integer. */
export function clampOffset(value: unknown): number {
  const n = asNumber(value);
  if (n === undefined || n < 0) return 0;
  return Math.floor(n);
}

export interface QueryResult {
  columns: string[];
  /** Values as returned by the driver, JSON-safe. */
  rows: Array<Record<string, unknown>>;
  /** Milliseconds the database took, for the "is this slow" question. */
  ms: number;
  /**
   * The SQL that ran, with parameters shown separately.
   *
   * Surfaced deliberately: a tool that hides its query teaches nothing and
   * cannot be trusted when the numbers look wrong. Seeing the statement is
   * how you learn the database as well as read it.
   */
  sql: { text: string; params: unknown[] };
}
