/**
 * A funnel over the analytics store: one SQL statement of chained CTEs, the
 * same text on PostgreSQL and SQLite, counting every row (no sampling).
 *
 * A unit reaches step 1 at its first matching event in `[from, to)`. It
 * reaches step k at its first matching event after its step k-1 event
 * (ordered by time, then by id, so two events in one millisecond still have
 * an order) provided that event is no later than step 1's time plus the
 * conversion window, and is before `to`. Rows with no unit never join a
 * funnel: they have nothing to follow. Times are UTC milliseconds.
 */
import { stepKind, type AnalyticsFunnel, type AnalyticsStep } from '../../shared/appAnalytics.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import type { AnalyticsStore } from './store.js';

interface FunnelStepResult {
  readonly step: number;
  readonly label: string;
  readonly units: number;
  /** Units reached over units at the previous step; 1 for the first. */
  readonly fromPrevious: number;
  /** Units reached over units at step 1. */
  readonly fromStart: number;
}
export interface FunnelResult {
  readonly unit: 'subject' | 'visitor';
  readonly fromMs: number;
  readonly toMs: number;
  readonly conversionWindowHours: number;
  readonly tenantId: string | null;
  readonly steps: readonly FunnelStepResult[];
}

/** A step's label, as a person reads it: `form apply:contact`. */
function funnelStepLabel(step: AnalyticsStep): string {
  const kind = stepKind(step);
  if ('form' in step) return `form ${step.form}${step.step ? `:${step.step}` : ''}`;
  return `${kind} ${(step as Record<string, string>)[kind]}`;
}

/** What a step matches in `events`: its kind, name and (for a form) step. A command counts the runs, not the refusals. */
function match(step: AnalyticsStep, alias: string): { sql: string; params: unknown[] } {
  if ('view' in step) return { sql: `${alias}.kind = 'view' AND ${alias}.name = ?`, params: [step.view] };
  /* A command's run is stored under the event kind 'action' (store.ts); the authored step says `command`. */
  if ('command' in step) return { sql: `${alias}.kind = 'action' AND ${alias}.name = ? AND ${alias}.step = 'ran'`, params: [step.command] };
  if ('form' in step)
    return { sql: `${alias}.kind = 'form' AND ${alias}.name = ? AND ${alias}.step = ?`, params: [step.form, step.step ?? 'submit'] };
  return { sql: `${alias}.kind IN ('event', 'business') AND ${alias}.name = ?`, params: [step.event] };
}

function funnelSql(
  funnel: AnalyticsFunnel,
  window: { fromMs: number; toMs: number; tenantId?: string | null },
  events: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [],
    windowMs = parseDuration(funnel.conversionWindow)!;
  const tenant = window.tenantId ? ' AND e.tenant_id = ?' : '';
  const ctes: string[] = [];
  funnel.steps.forEach((step, index) => {
    const m = match(step, 'e');
    if (index === 0) {
      ctes.push(`c1 AS (SELECT unit_id, t AS t1, t, id FROM (
  SELECT e.unit_id AS unit_id, e.occurred_at AS t, e.id AS id, ROW_NUMBER() OVER (PARTITION BY e.unit_id ORDER BY e.occurred_at, e.id) AS rn
  FROM ${events} e WHERE e.unit_kind = ? AND e.unit_id IS NOT NULL AND e.occurred_at >= ? AND e.occurred_at < ? AND ${m.sql}${tenant}) x WHERE rn = 1)`);
      params.push(funnel.unit, window.fromMs, window.toMs, ...m.params, ...(window.tenantId ? [window.tenantId] : []));
      return;
    }
    const k = index + 1;
    ctes.push(`c${k} AS (SELECT unit_id, t1, t, id FROM (
  SELECT p.unit_id AS unit_id, p.t1 AS t1, e.occurred_at AS t, e.id AS id, ROW_NUMBER() OVER (PARTITION BY p.unit_id ORDER BY e.occurred_at, e.id) AS rn
  FROM c${k - 1} p JOIN ${events} e ON e.unit_id = p.unit_id AND e.unit_kind = ?
  WHERE (e.occurred_at > p.t OR (e.occurred_at = p.t AND e.id > p.id)) AND e.occurred_at <= p.t1 + ? AND e.occurred_at < ? AND ${m.sql}${tenant}) x WHERE rn = 1)`);
    params.push(funnel.unit, windowMs, window.toMs, ...m.params, ...(window.tenantId ? [window.tenantId] : []));
  });
  const counts = funnel.steps.map((_, index) => `SELECT ${index + 1} AS step, COUNT(*) AS units FROM c${index + 1}`).join(' UNION ALL ');
  return { sql: `WITH ${ctes.join(',\n')}\n${counts} ORDER BY step`, params };
}

export async function runFunnel(
  store: AnalyticsStore,
  funnel: AnalyticsFunnel,
  window: { fromMs: number; toMs: number; tenantId?: string | null },
): Promise<FunnelResult> {
  if (!(window.fromMs < window.toMs)) throw new Error('A funnel window needs from before to.');
  const { sql, params } = funnelSql(funnel, window, store.table('events'));
  const rows = await store.rows<{ step: number | string; units: number | string }>(sql, params);
  const units = new Map(rows.map((row) => [Number(row.step), Number(row.units)]));
  const first = units.get(1) ?? 0;
  const steps = funnel.steps.map((step, index): FunnelStepResult => {
    const here = units.get(index + 1) ?? 0,
      before = index === 0 ? here : (units.get(index) ?? 0);
    return {
      step: index + 1,
      label: funnelStepLabel(step),
      units: here,
      fromPrevious: index === 0 ? 1 : before ? here / before : 0,
      fromStart: first ? here / first : 0,
    };
  });
  return {
    unit: funnel.unit,
    fromMs: window.fromMs,
    toMs: window.toMs,
    conversionWindowHours: parseDuration(funnel.conversionWindow)! / 3_600_000,
    tenantId: window.tenantId ?? null,
    steps,
  };
}
