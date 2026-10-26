/**
 * The Console's Analytics room, read off the analytics store: events
 * a day over a window, the names counted most, simple breakdowns, and each
 * declared funnel computed by the funnel's own statement (funnel.ts).
 *
 * Read-only, and only counts leave it: never a unit id, a visitor id, a field
 * value or a row. Distinct units are counted as they were recorded (the store
 * already refuses an email or an IP), so a visitor and a signed-in subject are
 * two units, as the funnels count them. The same SQL runs on SQLite and
 * PostgreSQL: integer division of milliseconds is a UTC day on both.
 */
import type { AnalyticsDeclaration } from '../../shared/appAnalytics.js';
import { runFunnel, type FunnelResult } from './funnel.js';
import type { AnalyticsStore } from './store.js';

const DAY = 86_400_000;
/** The widest window one report reads. */
export const ANALYTICS_REPORT_DAYS = 366;
const TOP = 20;

interface AnalyticsReport {
  readonly fromMs: number;
  readonly toMs: number;
  /** Each UTC day of the window, oldest first: events of the App's own kinds (views, actions, forms, custom events) and business events. */
  readonly days: readonly Readonly<{ day: string; tracked: number; business: number }>[];
  /** The names counted most, with the distinct units that did them. */
  readonly names: readonly Readonly<{ kind: string; name: string; events: number; units: number }>[];
  readonly breakdowns: Readonly<{
    kind: readonly Readonly<{ key: string; events: number; units: number }>[];
    /** `subject` (signed in), `visitor` (an AN2 visitor) or `none` (counted, never joined). */
    unit: readonly Readonly<{ key: string; events: number; units: number }>[];
    /** Present for a store that holds tenant rows: the tenants with the most events. */
    tenant?: readonly Readonly<{ key: string; events: number; units: number }>[];
  }>;
  readonly funnels: readonly Readonly<{ id: string; result: FunnelResult }>[];
}

const count = (value: unknown) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};
const UNITS = "COUNT(DISTINCT CASE WHEN unit_id IS NULL THEN NULL ELSE unit_kind || ':' || unit_id END)";

export async function analyticsReport(
  store: AnalyticsStore,
  declaration: AnalyticsDeclaration,
  window: Readonly<{ fromMs: number; toMs: number }>,
  only?: Readonly<{ kind: string; name: string }>,
): Promise<AnalyticsReport> {
  const { fromMs, toMs } = window;
  if (
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    fromMs < 0 ||
    !(fromMs < toMs) ||
    toMs - fromMs > ANALYTICS_REPORT_DAYS * DAY
  ) {
    throw new RangeError('An analytics window is a start before its end, at most a year apart.');
  }
  const events = store.table('events'),
    where = `occurred_at >= ? AND occurred_at < ?`,
    params = [fromMs, toMs];
  // One statement after another: a SQLite store answers one at a time.
  // The days alone follow one event when asked; the names, breakdowns and funnels stay the whole window's.
  const perDay = await store.rows<{ day: unknown; business: unknown; events: unknown }>(
    `SELECT occurred_at / ${DAY} AS day, CASE WHEN kind = 'business' THEN 1 ELSE 0 END AS business, COUNT(*) AS events
     FROM ${events} WHERE ${where}${only ? ' AND kind = ? AND name = ?' : ''} GROUP BY occurred_at / ${DAY}, CASE WHEN kind = 'business' THEN 1 ELSE 0 END`,
    only ? [...params, only.kind, only.name] : params,
  );
  const names = await store.rows<{ kind: unknown; name: unknown; events: unknown; units: unknown }>(
    `SELECT kind, name, COUNT(*) AS events, ${UNITS} AS units FROM ${events} WHERE ${where}
     GROUP BY kind, name ORDER BY COUNT(*) DESC, kind, name LIMIT ${TOP}`,
    params,
  );
  const by = (column: string) =>
    store.rows<{ key: unknown; events: unknown; units: unknown }>(
      `SELECT ${column} AS key, COUNT(*) AS events, ${UNITS} AS units FROM ${events} WHERE ${where}
     GROUP BY ${column} ORDER BY COUNT(*) DESC, ${column} LIMIT ${TOP}`,
      params,
    );
  const shaped = (rows: Awaited<ReturnType<typeof by>>, none = 'none') =>
    Object.freeze(
      rows.map((row) =>
        Object.freeze({ key: row.key === null ? none : String(row.key), events: count(row.events), units: count(row.units) }),
      ),
    );
  const kind = shaped(await by('kind'));
  const unit = shaped(await by('unit_kind'));
  const tenants = shaped(await by('tenant_id'), '');
  const tenant = tenants.some((row) => row.key !== '') ? tenants.filter((row) => row.key !== '') : undefined;

  const first = Math.floor(fromMs / DAY),
    last = Math.floor((toMs - 1) / DAY),
    days = [];
  for (let day = first; day <= last; day++) {
    const of = (business: number) => count(perDay.find((row) => count(row.day) === day && count(row.business) === business)?.events);
    days.push(Object.freeze({ day: new Date(day * DAY).toISOString().slice(0, 10), tracked: of(0), business: of(1) }));
  }
  const funnels = [];
  for (const [id, funnel] of Object.entries(declaration.funnels ?? {}))
    funnels.push(Object.freeze({ id, result: await runFunnel(store, funnel, { fromMs, toMs }) }));
  return Object.freeze({
    fromMs,
    toMs,
    days: Object.freeze(days),
    names: Object.freeze(
      names.map((row) =>
        Object.freeze({ kind: String(row.kind), name: String(row.name), events: count(row.events), units: count(row.units) }),
      ),
    ),
    breakdowns: Object.freeze({ kind, unit, ...(tenant ? { tenant } : {}) }),
    funnels: Object.freeze(funnels),
  });
}

/**
 * A window's totals, for the change a KPI tile says against the equal period
 * before it: events of the App's own kinds, business events, the distinct
 * units that did them, and the counts of the names asked (a top-events trend).
 * Counts only, as the report's are.
 */
export async function analyticsTotals(
  store: AnalyticsStore,
  window: Readonly<{ fromMs: number; toMs: number }>,
  names: readonly Readonly<{ kind: string; name: string }>[] = [],
  only?: Readonly<{ kind: string; name: string }>,
): Promise<
  Readonly<{
    tracked: number;
    business: number;
    units: number;
    names: readonly Readonly<{ kind: string; name: string; events: number }>[];
  }>
> {
  const { fromMs, toMs } = window;
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || !(fromMs < toMs))
    throw new RangeError('An analytics window is a start before its end.');
  const events = store.table('events'),
    where = `occurred_at >= ? AND occurred_at < ?`,
    params = [fromMs, toMs];
  const [totals] = await store.rows<{ tracked: unknown; business: unknown; units: unknown }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'business' THEN 0 ELSE 1 END), 0) AS tracked, COALESCE(SUM(CASE WHEN kind = 'business' THEN 1 ELSE 0 END), 0) AS business,
     ${UNITS} AS units FROM ${events} WHERE ${where}${only ? ' AND kind = ? AND name = ?' : ''}`,
    only ? [...params, only.kind, only.name] : params,
  );
  const counted = [];
  for (const { kind, name } of names.slice(0, TOP)) {
    const [row] = await store.rows<{ events: unknown }>(
      `SELECT COUNT(*) AS events FROM ${events} WHERE ${where} AND kind = ? AND name = ?`,
      [...params, kind, name],
    );
    counted.push(Object.freeze({ kind, name, events: count(row?.events) }));
  }
  return Object.freeze({
    tracked: count(totals?.tracked),
    business: count(totals?.business),
    units: count(totals?.units),
    names: Object.freeze(counted),
  });
}
