/**
 * The process's metrics, kept only while an exporter wants them.
 *
 * Instruments are declared here, once, with their OpenTelemetry names and
 * units, so a dashboard built on Datadog or Dynatrace finds the standard
 * `http.server.request.duration` where it looks for it. Their attributes are
 * the same travelling kind a span's are — a route template, a status, a
 * command id, an outcome — and never a value from a request: every series
 * is bounded by what the App declares.
 *
 * With no exporter, `record` returns at its first line. Cumulative
 * temporality, which every OTLP backend accepts; the exporter reads a
 * snapshot on its interval.
 */
import type { AttributeValue } from './trace.js';
import type { Metric, MetricPoint } from './otlpEncode.js';

type Attrs = Readonly<Record<string, AttributeValue | undefined>>;
type Kind = Metric['kind'];

/** Seconds, as the conventions ask for durations; the bounds are theirs for HTTP. */
const DURATION_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
/** Series per instrument. Past it a new combination is dropped, not a process's memory. */
const SERIES = 2000;

let on = false;
const started = Date.now();
const instruments = new Map<string, Instrument>();
const gauges: Array<() => Array<{ name: string; description: string; unit: string; kind: 'gauge' | 'updown'; points: MetricPoint[] }>> = [];

class Instrument {
  readonly series = new Map<
    string,
    { attributes: Record<string, AttributeValue>; value: number; count: number; sum: number; buckets: number[]; min: number; max: number }
  >();
  constructor(
    readonly name: string,
    readonly description: string,
    readonly unit: string,
    readonly kind: Kind,
    readonly bounds: readonly number[] = DURATION_BOUNDS,
  ) {}
  record(value: number, attributes: Attrs = {}) {
    if (!on || !Number.isFinite(value)) return;
    const clean = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as Record<string, AttributeValue>;
    const key = JSON.stringify(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b)));
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= SERIES) return;
      entry = {
        attributes: clean,
        value: 0,
        count: 0,
        sum: 0,
        buckets: Array.from({ length: this.bounds.length + 1 }, () => 0),
        min: Infinity,
        max: -Infinity,
      };
      this.series.set(key, entry);
    }
    if (this.kind === 'histogram') {
      entry.count++;
      entry.sum += value;
      entry.min = Math.min(entry.min, value);
      entry.max = Math.max(entry.max, value);
      let slot = this.bounds.findIndex((bound) => value <= bound);
      if (slot < 0) slot = this.bounds.length;
      entry.buckets[slot]++;
    } else entry.value += value;
  }
  snapshot(time: number): Metric | undefined {
    if (!this.series.size) return undefined;
    const points = [...this.series.values()].map((entry) =>
      this.kind === 'histogram'
        ? {
            attributes: entry.attributes,
            count: entry.count,
            sum: entry.sum,
            bounds: this.bounds,
            buckets: entry.buckets,
            ...(entry.count ? { min: entry.min, max: entry.max } : {}),
          }
        : { attributes: entry.attributes, value: entry.value },
    );
    return { name: this.name, description: this.description, unit: this.unit, kind: this.kind, points, start: started, time };
  }
}

function instrument(name: string, description: string, unit: string, kind: Kind, bounds?: readonly number[]): Instrument {
  const made = new Instrument(name, description, unit, kind, bounds);
  instruments.set(name, made);
  return made;
}

export const metrics = {
  /** `http.server.request.duration`: by method, route template and status. */
  httpDuration: instrument('http.server.request.duration', 'Duration of HTTP server requests.', 's', 'histogram'),
  /** Business commands by id and outcome (applied, replayed, not_applied, unknown) and refusal code. */
  commands: instrument('mistri.command.executions', 'Business command executions by outcome.', '{execution}', 'counter'),
  commandDuration: instrument('mistri.command.duration', 'Duration of business command executions.', 's', 'histogram'),
  /** `db.client.operation.duration`: by system, operation and table. */
  dbDuration: instrument('db.client.operation.duration', 'Duration of database client operations.', 's', 'histogram'),
  /** Job attempts by job and outcome code; lag from due to claimed. */
  jobAttempts: instrument('mistri.job.attempts', 'Job attempts by outcome.', '{attempt}', 'counter'),
  jobLag: instrument(
    'mistri.job.lag',
    'Time from a job being due to its attempt starting.',
    's',
    'histogram',
    [0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600],
  ),
  /** Outbound calls (webhooks, HTTP sources, email) by kind and outcome. */
  outbound: instrument('mistri.outbound.calls', 'Outbound calls by kind and outcome.', '{call}', 'counter'),
};

/** A gauge read when the exporter reads: the pools, the caches, the sessions. */
export function observeGauges(read: (typeof gauges)[number]): () => void {
  gauges.push(read);
  return () => {
    const at = gauges.indexOf(read);
    if (at >= 0) gauges.splice(at, 1);
  };
}

export function enableMetrics(): void {
  on = true;
}

export function snapshotMetrics(): Metric[] {
  const time = Date.now();
  const out: Metric[] = [];
  for (const each of instruments.values()) {
    const metric = each.snapshot(time);
    if (metric) out.push(metric);
  }
  for (const read of gauges) {
    try {
      for (const gauge of read()) if (gauge.points.length) out.push({ ...gauge, start: started, time });
    } catch {
      /* a gauge that cannot be read is left out */
    }
  }
  return out;
}
