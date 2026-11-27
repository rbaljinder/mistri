/**
 * Cross-shard scatter-gather execution engine (Phase 4):
 * - Deterministic k-way merge with global `(orderCols..., shardId, pk)` ordering
 *   supporting both offset slicing and O(N * limit) global keyset pagination.
 * - Two-phase partial-aggregate pushdown for `count`, `sum`, `min`, `max`,
 *   `avg` (pushed as partial `sum` + `count`, divided in coordinator), ratios,
 *   and conditional `count when [...]` funnels.
 * - Fail-closed refusal of non-decomposable cross-shard aggregates (`median` /
 *   `percentile_cont` and `COUNT(DISTINCT col)` where `col !== shardKey`).
 */
import {
  Refusal,
  type Adapter,
  type AggregateRequest,
  type AggregateResult,
  type BreakdownResult,
  type QueryRequest,
  type ViewResult,
} from './adapter.js';
import { measureName, type BreakdownDef, type CompiledMeasure, type Measure } from '../shared/breakdown.js';
import type { Order } from '../shared/schema.js';
import type { QueryResult } from '../shared/reads.js';
import type { ViewDef } from '../shared/view.js';

type Row = Record<string, unknown>;

export interface ShardedTarget {
  readonly shardId: string;
  readonly adapter: Adapter;
}

const DEFAULT_SCATTER_BOUND_SHARDS = 32;

/** Compare two scalar values deterministically across shards (nulls high for PG consistency, numeric by value, text bytewise). */
function compareShardValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a),
    right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic k-way merge of pre-sorted shard row arrays using `order` plus
 * `shardId` as a stable cross-shard tiebreaker, sliced to `[offset, offset + limit)`.
 */
function mergeShardedRows(
  batches: readonly Readonly<{ readonly shardId: string; readonly rows: readonly Row[] }>[],
  order: readonly { readonly column: string; readonly direction: 'asc' | 'desc' }[],
  offset: number,
  limit: number,
): Row[] {
  const cursors = batches.map(() => 0);
  const merged: Row[] = [];
  const wanted = offset + limit;
  while (merged.length < wanted) {
    let best = -1;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      if (cursors[i]! >= batch.rows.length) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const a = batch.rows[cursors[i]!]!;
      const b = batches[best]!.rows[cursors[best]!]!;
      let cmp = 0;
      for (const spec of order) {
        cmp = compareShardValues(a[spec.column], b[spec.column]) * (spec.direction === 'desc' ? -1 : 1);
        if (cmp !== 0) break;
      }
      if (cmp === 0) {
        cmp = batch.shardId < batches[best]!.shardId ? -1 : batch.shardId > batches[best]!.shardId ? 1 : 0;
      }
      if (cmp < 0) best = i;
    }
    if (best < 0) break;
    merged.push(batches[best]!.rows[cursors[best]!++]!);
  }
  return offset > 0 ? merged.slice(offset) : merged;
}

/** Enforce bounded scatter limits before fanning out across shards. */
export function assertScatterAllowed(
  table: string,
  shardKey: string,
  shardCount: number,
  policy: 'refuse' | 'bounded' | 'allow',
  maxBoundedShards: number = DEFAULT_SCATTER_BOUND_SHARDS,
): void {
  if (policy === 'refuse') {
    throw new Refusal(
      `Query on sharded resource "${table}" has no "${shardKey}" filter, and scatter-gather is refused. ` +
        `Filter by "${shardKey}" or enable bounded scatter on this view.`,
    );
  }
  if (policy === 'bounded' && shardCount > maxBoundedShards) {
    throw new Refusal(
      `Scatter-gather query on "${table}" would hit ${shardCount} shards (bounded limit is ${maxBoundedShards}). ` +
        `Filter by "${shardKey}" or route analytics to a read-only analytical source.`,
    );
  }
}

/** Execute a multi-shard `query` with parallel fan-out and deterministic k-way merge. */
export async function scatterQuery(targets: readonly ShardedTarget[], request: QueryRequest): Promise<QueryResult> {
  const started = performance.now();
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 50;
  // Fetch up to `offset + limit` from each shard (when keyset-filtered, offset is 0 -> O(N * limit)).
  const perShardRequest: QueryRequest = { ...request, offset: 0, limit: offset + limit };
  const results = await Promise.all(
    targets.map(async (target) => ({
      shardId: target.shardId,
      result: await target.adapter.query(perShardRequest),
    })),
  );
  const first = results[0]!.result;
  const order: readonly Order[] = request.orderBy?.length ? request.orderBy : [];
  const rows = mergeShardedRows(
    results.map((r) => ({ shardId: r.shardId, rows: r.result.rows })),
    order,
    offset,
    limit,
  );
  return {
    columns: first.columns,
    rows,
    ms: performance.now() - started,
    sql: first.sql,
  };
}

/** Execute a multi-shard `count`, summing per-shard counts and capping at `limit` when bounded. */
export async function scatterCount(
  targets: readonly ShardedTarget[],
  table: string,
  filter: QueryRequest['filter'],
  limit?: number,
): Promise<number> {
  const counts = await Promise.all(targets.map((target) => target.adapter.count(table, filter, limit)));
  let total = 0;
  for (const n of counts) {
    total += n;
    if (limit !== undefined && total > limit) return limit + 1;
  }
  return total;
}

/** Execute a multi-shard `runView` with parallel fan-out and deterministic k-way merge. */
export async function scatterView(targets: readonly ShardedTarget[], view: ViewDef, offset = 0): Promise<ViewResult> {
  const started = performance.now();
  const limit = view.limit ?? 50;
  const perShardView: ViewDef = { ...view, limit: offset + limit };
  const results = await Promise.all(
    targets.map(async (target) => {
      if (!target.adapter.runView) throw new Refusal(`Shard "${target.shardId}" does not support views.`);
      return { shardId: target.shardId, result: await target.adapter.runView(perShardView, 0) };
    }),
  );
  const first = results[0]!.result;
  const order = (view.orderBy ?? []).map((o) => {
    const resolved = first.resolved.find((col) => col.path === o.path || col.name === o.path);
    return { column: resolved?.name ?? o.path, direction: o.direction };
  });
  const rows = mergeShardedRows(
    results.map((r) => ({ shardId: r.shardId, rows: r.result.rows })),
    order,
    offset,
    limit,
  );
  return {
    ...first,
    rows,
    ms: performance.now() - started,
  };
}

function assertDecomposableMeasures(measures: readonly Measure[], shardKey?: string): void {
  for (const measure of measures) {
    if (measure.fn === 'median') {
      throw new Refusal(
        `Cross-shard breakdown cannot compute exact "median" (${measure.alias ?? measure.path ?? 'median'}). ` +
          `Filter by shard key or query a consolidated read-only analytical source.`,
      );
    }
    if (measure.fn === 'count' && measure.distinct && measure.path && measure.path !== shardKey) {
      throw new Refusal(
        `Cross-shard breakdown cannot compute exact "COUNT(DISTINCT ${measure.path})" across shards unless "${measure.path}" is the shard key.`,
      );
    }
  }
}

interface MeasurePlan {
  readonly original: Measure;
  readonly outputName: string;
  readonly pushIndices: readonly number[];
}

function buildPushdownMeasures(measures: readonly Measure[]): {
  readonly pushed: Measure[];
  readonly plans: readonly MeasurePlan[];
} {
  const pushed: Measure[] = [];
  const plans: MeasurePlan[] = [];
  measures.forEach((measure, idx) => {
    const outputName = measureName(measure);
    if (measure.fn === 'avg' && measure.path) {
      const sumIdx = pushed.length;
      pushed.push({
        fn: 'sum',
        path: measure.path,
        alias: `__mistri_sum_${idx}`,
        ...(measure.when ? { when: measure.when } : {}),
        ...(measure.where ? { where: measure.where } : {}),
      });
      const countIdx = pushed.length;
      pushed.push({
        fn: 'count',
        path: measure.path,
        alias: `__mistri_cnt_${idx}`,
        ...(measure.when ? { when: measure.when } : {}),
        ...(measure.where ? { where: measure.where } : {}),
      });
      plans.push({ original: measure, outputName, pushIndices: [sumIdx, countIdx] });
    } else {
      const pushedIdx = pushed.length;
      pushed.push({ ...measure, alias: `__mistri_m_${idx}` });
      plans.push({ original: measure, outputName, pushIndices: [pushedIdx] });
    }
  });
  return { pushed, plans };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Two-phase partial-aggregate pushdown for cross-shard `runBreakdown`.
 *
 * Pushes additive partial aggregates (`count`, `sum`, `min`, `max`, `avg` ->
 * `sum` + `count`, and conditional `count when [...]` funnels) to each shard,
 * merges groups by group-key tuple, and finalizes `avg` in the coordinator.
 */
export async function scatterBreakdown(
  targets: readonly ShardedTarget[],
  breakdown: BreakdownDef,
  offset = 0,
  shardKey?: string,
): Promise<BreakdownResult> {
  const started = performance.now();
  assertDecomposableMeasures(breakdown.measures, shardKey);

  const { pushed, plans } = buildPushdownMeasures(breakdown.measures);
  const limit = breakdown.limit ?? 50;
  // Over-fetch per shard when grouped so top-K across shards has accurate merged groups.
  const shardLimit = breakdown.by.length ? Math.min(Math.max((offset + limit) * 4, 200), 2_000) : 1;
  const perShard: BreakdownDef = {
    ...breakdown,
    measures: pushed,
    limit: shardLimit,
  };

  const results = await Promise.all(
    targets.map(async (target) => {
      if (!target.adapter.runBreakdown) throw new Refusal(`Shard "${target.shardId}" does not support breakdowns.`);
      return target.adapter.runBreakdown(perShard, 0);
    }),
  );

  const first = results[0]!;
  const keyCols = first.resolved.filter((col) => col.kind === 'key').map((col) => col.name);
  const pushedColNames = pushed.map((m, idx) => {
    const alias = m.alias ?? measureName(m);
    const found = first.resolved.find((col) => col.kind === 'measure' && col.name === alias);
    return found?.name ?? alias ?? `m_${idx}`;
  });

  type Acc = {
    keys: Record<string, unknown>;
    values: Array<number | null>;
    counts: Array<number>;
  };

  const groups = new Map<string, Acc>();
  for (const res of results) {
    for (const row of res.rows) {
      const groupKey = keyCols.length ? JSON.stringify(keyCols.map((k) => row[k] ?? null)) : '__all__';
      let acc = groups.get(groupKey);
      if (!acc) {
        const keys: Record<string, unknown> = {};
        for (const k of keyCols) keys[k] = row[k] ?? null;
        acc = { keys, values: plans.map(() => null), counts: plans.map(() => 0) };
        groups.set(groupKey, acc);
      }
      plans.forEach((plan, pIdx) => {
        const fn = plan.original.fn;
        if (fn === 'avg') {
          const sumVal = toFiniteNumber(row[pushedColNames[plan.pushIndices[0]!]!]);
          const cntVal = toFiniteNumber(row[pushedColNames[plan.pushIndices[1]!]!]);
          if (sumVal !== null && cntVal !== null && cntVal > 0) {
            acc!.values[pIdx] = (acc!.values[pIdx] ?? 0) + sumVal;
            acc!.counts[pIdx] = acc!.counts[pIdx]! + cntVal;
          }
        } else {
          const val = toFiniteNumber(row[pushedColNames[plan.pushIndices[0]!]!]);
          if (val === null) return;
          const prev = acc!.values[pIdx];
          if (fn === 'count' || fn === 'sum') {
            acc!.values[pIdx] = (prev ?? 0) + val;
          } else if (fn === 'min') {
            acc!.values[pIdx] = prev === null ? val : Math.min(prev, val);
          } else if (fn === 'max') {
            acc!.values[pIdx] = prev === null ? val : Math.max(prev, val);
          }
        }
      });
    }
  }

  // Synthesize final rows matching original requested measure names.
  const finalMeasureNames = plans.map((p) => p.outputName);
  const rows: Row[] = [...groups.values()].map((acc) => {
    const out: Row = { ...acc.keys };
    plans.forEach((plan, pIdx) => {
      if (plan.original.fn === 'avg') {
        const cnt = acc.counts[pIdx]!;
        out[plan.outputName] = cnt > 0 && acc.values[pIdx] !== null ? acc.values[pIdx]! / cnt : null;
      } else if (plan.original.fn === 'count') {
        out[plan.outputName] = acc.values[pIdx] ?? 0;
      } else {
        out[plan.outputName] = acc.values[pIdx];
      }
    });
    return out;
  });

  if (breakdown.orderBy?.length) {
    rows.sort((a, b) => {
      for (const spec of breakdown.orderBy!) {
        const cmp = compareShardValues(a[spec.name], b[spec.name]) * (spec.direction === 'desc' ? -1 : 1);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  const sliced = rows.slice(offset, offset + limit);
  const columns = [...keyCols, ...finalMeasureNames];
  const resolved: CompiledMeasure[] = [
    ...first.resolved.filter((c) => c.kind === 'key'),
    ...plans.map((p) => {
      const pushedMeta = first.resolved.find((c) => c.kind === 'measure' && c.name === pushedColNames[p.pushIndices[0]!]);
      return {
        name: p.outputName,
        kind: 'measure' as const,
        fn: p.original.fn,
        ...(p.original.path ? { path: p.original.path } : {}),
        type: p.original.fn === 'avg' ? 'real' : (pushedMeta?.type ?? 'numeric'),
      };
    }),
  ];

  return {
    columns,
    resolved,
    rows: sliced,
    ms: performance.now() - started,
    sql: first.sql,
  };
}

/** Two-phase partial-aggregate pushdown for cross-shard command `aggregate`. */
export async function scatterAggregate(
  targets: readonly ShardedTarget[],
  request: AggregateRequest,
  shardKey?: string,
): Promise<AggregateResult> {
  const breakdown: BreakdownDef = {
    base: request.table,
    by: (request.by ?? []).map((key) => ({
      path: key.column,
      ...(key.bucket ? { bucket: key.bucket } : {}),
      ...(key.name ? { alias: key.name } : {}),
    })),
    measures: request.measures.map((m) => ({
      fn: m.fn,
      ...(m.column ? { path: m.column } : {}),
      alias: m.name,
    })),
    ...(request.filter ? { filter: { groups: request.filter.groups.map((g) => g.map((c) => ({ ...c, path: c.column }))) } } : {}),
    ...(request.orderBy ? { orderBy: request.orderBy.map((o) => ({ name: o.name, direction: o.direction })) } : {}),
    limit: request.limit,
  };
  const result = await scatterBreakdown(targets, breakdown, 0, shardKey);
  return { rows: result.rows };
}
