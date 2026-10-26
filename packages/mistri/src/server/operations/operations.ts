import {
  REQUEST_DURATION_BOUNDS_MS,
  REQUEST_METHODS,
  REQUEST_ROUTES,
  REQUEST_STATUS_CLASSES,
  type RequestMetricsSnapshot,
} from '@mistriwork/engine/server/operations/requestMetrics.js';
import { POOL_DURATION_BOUNDS_MS } from '@mistriwork/engine/adapters/poolMetrics.js';
import type { CapacityPool, CapacitySnapshot } from '@mistriwork/engine/server/operations/diagnostics.js';
/* What a capacity snapshot is, kept with the request diagnostics that read it too: both products serve them. */
export type { CapacityPool, CapacitySnapshot };

/**
 * The operations contract deliberately has no HTTP, filesystem or network
 * dependency. A future protected status surface can adapt this value without
 * giving ordinary App responses access to operator diagnostics.
 */
export type OperationsScope = 'standalone' | 'app';
type ReadinessState = 'ready' | 'not_ready' | 'degraded';
export type ReadinessCode =
  | 'ok'
  | 'connection_unavailable'
  | 'app_load_failed'
  | 'validation_failed'
  | 'configuration_invalid'
  | 'diagnostics_degraded'
  | 'shutting_down'
  /* The job host's: work is due and waiting too long, or retention is
     nearly full; work has failed or its outcome is unknown; a runner or
     publisher stopped and stays stopped until the process restarts. */
  | 'backlog_pressure'
  | 'work_failed'
  | 'worker_halted'
  /* A database pool has a checkout queued now, or had one time out within
     the last minute: the support bundle's capacity section says which. */
  | 'pool_saturated'
  | 'unknown';

const MAX_CHECKS = 32;
const MAX_CHECK_NAME = 40;
const MAX_JSON_BYTES = 256_000;
const CHECK_NAME = /^[a-z][a-z0-9_.-]*$/;
const STATES = new Set<ReadinessState>(['ready', 'not_ready', 'degraded']);
const CODES = new Set<ReadinessCode>([
  'ok',
  'connection_unavailable',
  'app_load_failed',
  'validation_failed',
  'configuration_invalid',
  'diagnostics_degraded',
  'shutting_down',
  'backlog_pressure',
  'work_failed',
  'worker_halted',
  'pool_saturated',
  'unknown',
]);
const MAX_POOLS = 64;
const DIALECTS = new Set(['postgres', 'mysql', 'sqlite', 'http']);

export interface ReadinessCheckInput {
  readonly name: string;
  readonly state: ReadinessState;
  readonly code: ReadinessCode;
}

interface ReadinessCheck {
  readonly name: string;
  readonly state: ReadinessState;
  readonly code: ReadinessCode;
}

interface ReadinessSummary {
  readonly total: number;
  readonly ready: number;
  readonly degraded: number;
  readonly notReady: number;
}

export interface ReadinessSnapshot {
  readonly event: 'mistri.readiness';
  readonly version: 1;
  readonly generatedAt: string;
  readonly scope: OperationsScope;
  readonly ready: boolean;
  readonly summary: ReadinessSummary;
  readonly checks: readonly ReadinessCheck[];
}

interface SupportBundleInput {
  readonly scope: OperationsScope;
  readonly checks: readonly ReadinessCheckInput[];
  readonly metrics?: RequestMetricsSnapshot;
  readonly capacity?: CapacitySnapshot;
  /** Injectable only for deterministic tests; production callers omit it. */
  readonly generatedAt?: string;
}

export interface SupportBundle {
  readonly event: 'mistri.support';
  readonly version: 1;
  readonly generatedAt: string;
  readonly scope: OperationsScope;
  readonly readiness: ReadinessSnapshot;
  readonly metrics?: RequestMetricsSnapshot;
  readonly capacity?: CapacitySnapshot;
}

export class OperationsInputError extends Error {
  override name = 'OperationsInputError';
}

function assertScope(scope: OperationsScope): void {
  if (scope !== 'standalone' && scope !== 'app') throw new OperationsInputError('Invalid operations scope.');
}

function assertTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new OperationsInputError('Invalid operations timestamp.');
  }
  return value;
}

function normalizeChecks(inputs: readonly ReadinessCheckInput[]): readonly ReadinessCheck[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_CHECKS) {
    throw new OperationsInputError('Too many readiness checks.');
  }
  const names = new Set<string>();
  const checks = inputs.map((input) => {
    if (
      !input ||
      typeof input.name !== 'string' ||
      input.name.length === 0 ||
      input.name.length > MAX_CHECK_NAME ||
      !CHECK_NAME.test(input.name) ||
      names.has(input.name)
    ) {
      throw new OperationsInputError('Invalid readiness check name.');
    }
    if (!STATES.has(input.state) || !CODES.has(input.code)) {
      throw new OperationsInputError('Invalid readiness check state.');
    }
    names.add(input.name);
    return Object.freeze({ name: input.name, state: input.state, code: input.code });
  });
  return Object.freeze(checks);
}

function readiness(scope: OperationsScope, checks: readonly ReadinessCheck[], generatedAt: string): ReadinessSnapshot {
  assertScope(scope);
  const summary = Object.freeze({
    total: checks.length,
    ready: checks.filter((check) => check.state === 'ready').length,
    degraded: checks.filter((check) => check.state === 'degraded').length,
    notReady: checks.filter((check) => check.state === 'not_ready').length,
  });
  return Object.freeze({
    event: 'mistri.readiness',
    version: 1,
    generatedAt,
    scope,
    ready: checks.every((check) => check.state === 'ready'),
    summary,
    checks,
  });
}

/** Build a bounded readiness result with safe, allowlisted failure codes. */
export function buildReadiness(
  scope: OperationsScope,
  checks: readonly ReadinessCheckInput[],
  generatedAt = new Date().toISOString(),
): ReadinessSnapshot {
  return readiness(scope, normalizeChecks(checks), assertTimestamp(generatedAt));
}

function finiteCounter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeStatusClass(value: unknown): RequestMetricsSnapshot['series'][number]['statusClass'] {
  return REQUEST_STATUS_CLASSES.includes(value as never) ? (value as RequestMetricsSnapshot['series'][number]['statusClass']) : 'unknown';
}

function safeMethod(value: unknown): RequestMetricsSnapshot['series'][number]['method'] {
  return REQUEST_METHODS.includes(value as never) ? (value as RequestMetricsSnapshot['series'][number]['method']) : 'OTHER';
}

function safeRoute(value: unknown): RequestMetricsSnapshot['series'][number]['route'] {
  return REQUEST_ROUTES.includes(value as never) ? (value as RequestMetricsSnapshot['series'][number]['route']) : 'unknown';
}

function sanitizeMetrics(value: RequestMetricsSnapshot): RequestMetricsSnapshot {
  const source = value && typeof value === 'object' ? value : ({} as RequestMetricsSnapshot);
  const series = Array.isArray(source.series)
    ? source.series.slice(0, 768).map((item) => {
        const buckets = Array.isArray(item?.durationBuckets)
          ? item.durationBuckets.slice(0, REQUEST_DURATION_BOUNDS_MS.length + 1).map(finiteCounter)
          : [];
        while (buckets.length < REQUEST_DURATION_BOUNDS_MS.length + 1) buckets.push(0);
        return Object.freeze({
          method: safeMethod(item?.method),
          route: safeRoute(item?.route),
          statusClass: safeStatusClass(item?.statusClass),
          count: finiteCounter(item?.count),
          completed: finiteCounter(item?.completed),
          aborted: finiteCounter(item?.aborted),
          durationBuckets: Object.freeze(buckets),
          invalidDurationTotal: finiteCounter(item?.invalidDurationTotal),
        });
      })
    : [];
  return Object.freeze({
    started: finiteCounter(source.started),
    completed: finiteCounter(source.completed),
    aborted: finiteCounter(source.aborted),
    inFlight: finiteCounter(source.inFlight),
    durationBoundsMs: REQUEST_DURATION_BOUNDS_MS,
    series: Object.freeze(series),
  });
}

function poolBuckets(value: unknown): readonly number[] {
  const buckets = Array.isArray(value) ? value.slice(0, POOL_DURATION_BOUNDS_MS.length + 1).map(finiteCounter) : [];
  while (buckets.length < POOL_DURATION_BOUNDS_MS.length + 1) buckets.push(0);
  return Object.freeze(buckets);
}

function sanitizeCapacity(value: CapacitySnapshot): CapacitySnapshot {
  const source = value && typeof value === 'object' ? value : ({} as CapacitySnapshot);
  const loop = source.eventLoop && typeof source.eventLoop === 'object' ? source.eventLoop : ({} as CapacitySnapshot['eventLoop']);
  const pools = Array.isArray(source.pools)
    ? source.pools.slice(0, MAX_POOLS).map((pool) =>
        Object.freeze({
          position: finiteCounter(pool?.position),
          dialect: DIALECTS.has(pool?.dialect) ? pool.dialect : 'unknown',
          role: ['read', 'write', 'background', 'replica'].includes(pool?.role) ? pool.role : 'unknown',
          ...(pool?.role === 'replica' ? { replica: finiteCounter(pool.replica) } : {}),
          pooler: pool?.pooler === 'session' || pool?.pooler === 'transaction' ? pool.pooler : 'unknown',
          size: finiteCounter(pool?.size),
          open: typeof pool?.open === 'number' ? finiteCounter(pool.open) : null,
          inUse: finiteCounter(pool?.inUse),
          waiting: finiteCounter(pool?.waiting),
          saturated: pool?.saturated === true,
          checkouts: finiteCounter(pool?.checkouts),
          queued: finiteCounter(pool?.queued),
          timedOut: finiteCounter(pool?.timedOut),
          failed: finiteCounter(pool?.failed),
          waitBuckets: poolBuckets(pool?.waitBuckets),
          holdBuckets: poolBuckets(pool?.holdBuckets),
        }),
      )
    : [];
  return Object.freeze({
    eventLoop: Object.freeze({ activeMs: finiteCounter(loop.activeMs), idleMs: finiteCounter(loop.idleMs) }),
    durationBoundsMs: POOL_DURATION_BOUNDS_MS,
    pools: Object.freeze(pools),
  });
}

/**
 * Build a local support artifact. It contains no app/connection identity,
 * URLs, SQL, values, exception text, credentials or authorization material.
 * The caller must still explicitly decide who may obtain or persist it.
 */
export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  assertScope(input.scope);
  const generatedAt = assertTimestamp(input.generatedAt ?? new Date().toISOString());
  const result: SupportBundle = Object.freeze({
    event: 'mistri.support',
    version: 1,
    generatedAt,
    scope: input.scope,
    readiness: buildReadiness(input.scope, input.checks, generatedAt),
    ...(input.metrics ? { metrics: sanitizeMetrics(input.metrics) } : {}),
    ...(input.capacity ? { capacity: sanitizeCapacity(input.capacity) } : {}),
  });
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw new OperationsInputError('Support bundle exceeds its size limit.');
  }
  return result;
}

/** Re-sanitize before serialization so structural callers cannot smuggle data. */
export function supportBundleJson(bundle: SupportBundle): string {
  const safe = buildSupportBundle({
    scope: bundle.scope,
    checks: bundle.readiness.checks,
    metrics: bundle.metrics,
    capacity: bundle.capacity,
    generatedAt: bundle.generatedAt,
  });
  const json = JSON.stringify(safe);
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) {
    throw new OperationsInputError('Support bundle exceeds its size limit.');
  }
  return json;
}
