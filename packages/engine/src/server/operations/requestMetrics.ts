/* Only declared dimensions enter storage. There are at most 8 × 16 × 6
   series, regardless of the number of requests or distinct private URLs. */
export const REQUEST_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const);
export const REQUEST_ROUTES = Object.freeze([
  'api.connections',
  'api.identity',
  'api.app',
  'api.schema',
  'api.definitions',
  'api.agent',
  'api.query',
  'api.update',
  'api.insert',
  'api.delete',
  'api.revert',
  'api.sql',
  'api.auth',
  'api.other',
  'web',
  'unknown',
] as const);
export const REQUEST_STATUS_CLASSES = Object.freeze(['1xx', '2xx', '3xx', '4xx', '5xx', 'unknown'] as const);
export const REQUEST_DURATION_BOUNDS_MS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000]);

interface RequestMetricSeries {
  readonly method: (typeof REQUEST_METHODS)[number];
  readonly route: (typeof REQUEST_ROUTES)[number];
  readonly statusClass: (typeof REQUEST_STATUS_CLASSES)[number];
  readonly count: number;
  readonly completed: number;
  readonly aborted: number;
  /** Disjoint inclusive-upper-bound buckets, followed by an overflow bucket. */
  readonly durationBuckets: readonly number[];
  readonly invalidDurationTotal: number;
}

export interface RequestMetricsSnapshot {
  readonly started: number;
  readonly completed: number;
  readonly aborted: number;
  readonly inFlight: number;
  readonly durationBoundsMs: readonly number[];
  readonly series: readonly RequestMetricSeries[];
}

type MutableSeries = { -readonly [Key in keyof RequestMetricSeries]: RequestMetricSeries[Key] } & { durationBuckets: number[] };

export class RequestMetrics {
  private started = 0;
  private completed = 0;
  private aborted = 0;
  private readonly series = new Map<number, MutableSeries>();

  get revision(): number {
    return this.started + this.completed + this.aborted;
  }

  begin(method: string, route: string): (status: number | null, durationMs: number, outcome: 'completed' | 'aborted') => void {
    const methodIndex = REQUEST_METHODS.findIndex((value) => value === method);
    const routeIndex = REQUEST_ROUTES.findIndex((value) => value === route);
    const safeMethod = methodIndex < 0 ? REQUEST_METHODS.length - 1 : methodIndex;
    const safeRoute = routeIndex < 0 ? REQUEST_ROUTES.length - 1 : routeIndex;
    this.started += 1;
    let finished = false;
    return (status, durationMs, outcome) => {
      if (finished) return;
      finished = true;
      if (outcome === 'completed') this.completed += 1;
      else this.aborted += 1;
      const statusIndex =
        status !== null && Number.isInteger(status) && status >= 100 && status < 600
          ? Math.floor(status / 100) - 1
          : REQUEST_STATUS_CLASSES.length - 1;
      const key = (safeMethod * REQUEST_ROUTES.length + safeRoute) * REQUEST_STATUS_CLASSES.length + statusIndex;
      let series = this.series.get(key);
      if (!series) {
        series = {
          method: REQUEST_METHODS[safeMethod],
          route: REQUEST_ROUTES[safeRoute],
          statusClass: REQUEST_STATUS_CLASSES[statusIndex],
          count: 0,
          completed: 0,
          aborted: 0,
          durationBuckets: Array<number>(REQUEST_DURATION_BOUNDS_MS.length + 1).fill(0),
          invalidDurationTotal: 0,
        };
        this.series.set(key, series);
      }
      series.count += 1;
      if (outcome === 'completed') series.completed += 1;
      else series.aborted += 1;
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        series.invalidDurationTotal += 1;
      } else {
        const bucket = REQUEST_DURATION_BOUNDS_MS.findIndex((bound) => durationMs <= bound);
        series.durationBuckets[bucket < 0 ? REQUEST_DURATION_BOUNDS_MS.length : bucket] += 1;
      }
    };
  }

  snapshot(): RequestMetricsSnapshot {
    return Object.freeze({
      started: this.started,
      completed: this.completed,
      aborted: this.aborted,
      inFlight: this.started - this.completed - this.aborted,
      durationBoundsMs: REQUEST_DURATION_BOUNDS_MS,
      series: Object.freeze(
        [...this.series.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, series]) =>
            Object.freeze({
              ...series,
              durationBuckets: Object.freeze([...series.durationBuckets]),
            }),
          ),
      ),
    });
  }
}
