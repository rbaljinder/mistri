/**
 * OTLP's three export requests — traces, logs, metrics — in both encodings
 * OTLP/HTTP speaks: protobuf (the default, and the only one Dynatrace's API
 * takes) and JSON (what a person can read, and what Datadog's Agent and the
 * Collector take as well).
 *
 * Hand-written, like the MCP loop (server/mcp/protocol.ts), and for the same
 * reason: the messages used are a dozen, stable since OTLP 1.0, and the SDK
 * that would encode them is larger than this file and would ride into every
 * `npx tablewalk` that never exports anything. Field numbers are the
 * opentelemetry-proto ones, cited beside each message.
 */
import type { AttributeValue, LogRecord, SpanRecord } from './trace.js';

export interface Resource {
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}
export interface Scope {
  readonly name: string;
  readonly version: string;
}

export interface MetricPoint {
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly value?: number;
  readonly count?: number;
  readonly sum?: number;
  readonly bounds?: readonly number[];
  readonly buckets?: readonly number[];
  readonly min?: number;
  readonly max?: number;
}
export interface Metric {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly kind: 'counter' | 'histogram' | 'gauge' | 'updown';
  readonly points: readonly MetricPoint[];
  readonly start: number;
  readonly time: number;
}

/* ---------- protobuf wire ---------- */

class Writer {
  private chunks: Buffer[] = [];
  private length = 0;
  private push(buffer: Buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
  }
  varint(field: number, value: number | bigint) {
    this.tag(field, 0);
    this.rawVarint(BigInt(value));
  }
  private tag(field: number, wire: number) {
    this.rawVarint(BigInt((field << 3) | wire));
  }
  private rawVarint(value: bigint) {
    let v = BigInt.asUintN(64, value);
    const bytes: number[] = [];
    while (v > 0x7fn) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.push(Buffer.from(bytes));
  }
  fixed64(field: number, value: bigint) {
    this.tag(field, 1);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, value));
    this.push(b);
  }
  double(field: number, value: number) {
    this.tag(field, 1);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value);
    this.push(b);
  }
  fixed32(field: number, value: number) {
    this.tag(field, 5);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0);
    this.push(b);
  }
  bytes(field: number, value: Buffer) {
    this.tag(field, 2);
    this.rawVarint(BigInt(value.length));
    this.push(value);
  }
  string(field: number, value: string) {
    if (value) this.bytes(field, Buffer.from(value, 'utf8'));
  }
  message(field: number, build: (w: Writer) => void) {
    const inner = new Writer();
    build(inner);
    this.bytes(field, inner.finish());
  }
  packedFixed64(field: number, values: readonly number[]) {
    const b = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => b.writeBigUInt64LE(BigInt(Math.max(0, Math.round(value))), index * 8));
    this.bytes(field, b);
  }
  packedDouble(field: number, values: readonly number[]) {
    const b = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => b.writeDoubleLE(value, index * 8));
    this.bytes(field, b);
  }
  finish(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

const nanos = (ms: number) => BigInt(Math.round(ms * 1000)) * 1000n;
const KINDS = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;
const STATUS = { unset: 0, ok: 1, error: 2 } as const;
const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 } as const;

// AnyValue: string 1, bool 2, int 3, double 4, array 5 (ArrayValue.values 1).
function anyValue(w: Writer, value: AttributeValue) {
  if (typeof value === 'string') w.string(1, value);
  else if (typeof value === 'boolean') w.varint(2, value ? 1 : 0);
  else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) w.varint(3, value);
    else w.double(4, value);
  } else
    w.message(5, (array) => {
      for (const item of value) array.message(1, (v) => anyValue(v, item));
    });
}
// KeyValue: key 1, value 2.
function keyValues(w: Writer, field: number, values: Readonly<Record<string, AttributeValue>>) {
  for (const [key, value] of Object.entries(values))
    w.message(field, (kv) => {
      kv.string(1, key);
      kv.message(2, (v) => anyValue(v, value));
    });
}
// Resource: attributes 1. InstrumentationScope: name 1, version 2.
const resourceOf = (w: Writer, resource: Resource) => keyValues(w, 1, resource.attributes);
const scopeOf = (w: Writer, scope: Scope) => {
  w.string(1, scope.name);
  w.string(2, scope.version);
};

/** ExportTraceServiceRequest: resource_spans 1 → ResourceSpans { resource 1, scope_spans 2 → ScopeSpans { scope 1, spans 2 } }. */
export function tracesProto(resource: Resource, scope: Scope, spans: readonly SpanRecord[]): Buffer {
  const w = new Writer();
  w.message(1, (rs) => {
    rs.message(1, (r) => resourceOf(r, resource));
    rs.message(2, (ss) => {
      ss.message(1, (s) => scopeOf(s, scope));
      for (const span of spans)
        ss.message(2, (s) => {
          // Span: trace_id 1, span_id 2, trace_state 3, parent_span_id 4, name 5, kind 6, start 7, end 8,
          // attributes 9, events 11, links 13, status 15, flags 16.
          s.bytes(1, Buffer.from(span.traceId, 'hex'));
          s.bytes(2, Buffer.from(span.spanId, 'hex'));
          if (span.traceState) s.string(3, span.traceState);
          if (span.parentSpanId) s.bytes(4, Buffer.from(span.parentSpanId, 'hex'));
          s.string(5, span.name);
          s.varint(6, KINDS[span.kind]);
          s.fixed64(7, nanos(span.startTime));
          s.fixed64(8, nanos(span.endTime ?? span.startTime));
          keyValues(s, 9, span.attributes);
          // Event: time 1, name 2, attributes 3.
          for (const event of span.events)
            s.message(11, (e) => {
              e.fixed64(1, nanos(event.time));
              e.string(2, event.name);
              keyValues(e, 3, event.attributes);
            });
          // Link: trace_id 1, span_id 2, attributes 4.
          for (const link of span.links)
            s.message(13, (l) => {
              l.bytes(1, Buffer.from(link.traceId, 'hex'));
              l.bytes(2, Buffer.from(link.spanId, 'hex'));
              keyValues(l, 4, link.attributes ?? {});
            });
          // Status: message 2, code 3.
          if (span.status.code !== 'unset')
            s.message(15, (st) => {
              if (span.status.message) st.string(2, span.status.message);
              st.varint(3, STATUS[span.status.code]);
            });
          // SpanFlags: sampled bit, and whether the parent is remote (bits 8 and 9).
          s.fixed32(16, 0x01 | 0x100 | (span.remoteParent ? 0x200 : 0));
        });
    });
  });
  return w.finish();
}

/** ExportLogsServiceRequest: resource_logs 1 → { resource 1, scope_logs 2 → { scope 1, log_records 2 } }. */
export function logsProto(resource: Resource, scope: Scope, logs: readonly LogRecord[]): Buffer {
  const w = new Writer();
  w.message(1, (rl) => {
    rl.message(1, (r) => resourceOf(r, resource));
    rl.message(2, (sl) => {
      sl.message(1, (s) => scopeOf(s, scope));
      for (const record of logs)
        sl.message(2, (l) => {
          // LogRecord: time 1, severity_number 2, severity_text 3, body 5, attributes 6, flags 8, trace_id 9, span_id 10, observed 11.
          l.fixed64(1, nanos(record.time));
          l.varint(2, SEVERITY[record.level]);
          l.string(3, record.level.toUpperCase());
          l.message(5, (body) => anyValue(body, record.message));
          keyValues(l, 6, { ...record.attributes, 'log.source': record.source });
          if (record.traceId && record.spanId) {
            l.fixed32(8, record.sampled ? 1 : 0);
            l.bytes(9, Buffer.from(record.traceId, 'hex'));
            l.bytes(10, Buffer.from(record.spanId, 'hex'));
          }
          l.fixed64(11, nanos(record.time));
        });
    });
  });
  return w.finish();
}

/** ExportMetricsServiceRequest: resource_metrics 1 → { resource 1, scope_metrics 2 → { scope 1, metrics 2 } }. */
export function metricsProto(resource: Resource, scope: Scope, metrics: readonly Metric[]): Buffer {
  const w = new Writer();
  w.message(1, (rm) => {
    rm.message(1, (r) => resourceOf(r, resource));
    rm.message(2, (sm) => {
      sm.message(1, (s) => scopeOf(s, scope));
      for (const metric of metrics)
        sm.message(2, (m) => {
          // Metric: name 1, description 2, unit 3, gauge 5, sum 7, histogram 9.
          m.string(1, metric.name);
          m.string(2, metric.description);
          m.string(3, metric.unit);
          // NumberDataPoint: start 2, time 3, as_double 4, attributes 7.
          const number = (p: Writer, point: MetricPoint) => {
            p.fixed64(2, nanos(metric.start));
            p.fixed64(3, nanos(metric.time));
            p.double(4, point.value ?? 0);
            keyValues(p, 7, point.attributes);
          };
          if (metric.kind === 'gauge')
            m.message(5, (g) => {
              for (const point of metric.points) g.message(1, (p) => number(p, point));
            });
          else if (metric.kind === 'counter' || metric.kind === 'updown') {
            // Sum: data_points 1, aggregation_temporality 2 (2 = cumulative), is_monotonic 3.
            m.message(7, (sum) => {
              for (const point of metric.points) sum.message(1, (p) => number(p, point));
              sum.varint(2, 2);
              sum.varint(3, metric.kind === 'counter' ? 1 : 0);
            });
          } else {
            // Histogram: data_points 1, temporality 2. HistogramDataPoint: start 2, time 3, count 4, sum 5,
            // bucket_counts 6, explicit_bounds 7, attributes 9, min 11, max 12.
            m.message(9, (h) => {
              for (const point of metric.points)
                h.message(1, (p) => {
                  p.fixed64(2, nanos(metric.start));
                  p.fixed64(3, nanos(metric.time));
                  p.fixed64(4, BigInt(point.count ?? 0));
                  p.double(5, point.sum ?? 0);
                  p.packedFixed64(6, point.buckets ?? []);
                  p.packedDouble(7, point.bounds ?? []);
                  keyValues(p, 9, point.attributes);
                  if (point.min !== undefined) p.double(11, point.min);
                  if (point.max !== undefined) p.double(12, point.max);
                });
              h.varint(2, 2);
            });
          }
        });
    });
  });
  return w.finish();
}

/* ---------- OTLP/JSON ---------- */

const jsonValue = (value: AttributeValue): Record<string, unknown> =>
  typeof value === 'string'
    ? { stringValue: value }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : typeof value === 'number'
        ? Number.isSafeInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value }
        : { arrayValue: { values: value.map((item) => jsonValue(item)) } };
const jsonAttributes = (values: Readonly<Record<string, AttributeValue>>) =>
  Object.entries(values).map(([key, value]) => ({ key, value: jsonValue(value) }));
const jsonResource = (resource: Resource) => ({ attributes: jsonAttributes(resource.attributes) });
const jsonNanos = (ms: number) => nanos(ms).toString();

export function tracesJson(resource: Resource, scope: Scope, spans: readonly SpanRecord[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: jsonResource(resource),
        scopeSpans: [
          {
            scope,
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              ...(span.traceState ? { traceState: span.traceState } : {}),
              name: span.name,
              kind: KINDS[span.kind],
              startTimeUnixNano: jsonNanos(span.startTime),
              endTimeUnixNano: jsonNanos(span.endTime ?? span.startTime),
              attributes: jsonAttributes(span.attributes),
              events: span.events.map((event) => ({
                timeUnixNano: jsonNanos(event.time),
                name: event.name,
                attributes: jsonAttributes(event.attributes),
              })),
              links: span.links.map((link) => ({
                traceId: link.traceId,
                spanId: link.spanId,
                attributes: jsonAttributes(link.attributes ?? {}),
              })),
              status:
                span.status.code === 'unset'
                  ? {}
                  : { code: STATUS[span.status.code], ...(span.status.message ? { message: span.status.message } : {}) },
              flags: 0x01 | 0x100 | (span.remoteParent ? 0x200 : 0),
            })),
          },
        ],
      },
    ],
  });
}

export function logsJson(resource: Resource, scope: Scope, logs: readonly LogRecord[]): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: jsonResource(resource),
        scopeLogs: [
          {
            scope,
            logRecords: logs.map((record) => ({
              timeUnixNano: jsonNanos(record.time),
              observedTimeUnixNano: jsonNanos(record.time),
              severityNumber: SEVERITY[record.level],
              severityText: record.level.toUpperCase(),
              body: { stringValue: record.message },
              attributes: jsonAttributes({ ...record.attributes, 'log.source': record.source }),
              ...(record.traceId && record.spanId ? { traceId: record.traceId, spanId: record.spanId, flags: record.sampled ? 1 : 0 } : {}),
            })),
          },
        ],
      },
    ],
  });
}

export function metricsJson(resource: Resource, scope: Scope, metrics: readonly Metric[]): string {
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: jsonResource(resource),
        scopeMetrics: [
          {
            scope,
            metrics: metrics.map((metric) => {
              const number = (point: MetricPoint) => ({
                startTimeUnixNano: jsonNanos(metric.start),
                timeUnixNano: jsonNanos(metric.time),
                asDouble: point.value ?? 0,
                attributes: jsonAttributes(point.attributes),
              });
              const base = { name: metric.name, description: metric.description, unit: metric.unit };
              if (metric.kind === 'gauge') return { ...base, gauge: { dataPoints: metric.points.map(number) } };
              if (metric.kind === 'counter' || metric.kind === 'updown') {
                return {
                  ...base,
                  sum: { dataPoints: metric.points.map(number), aggregationTemporality: 2, isMonotonic: metric.kind === 'counter' },
                };
              }
              return {
                ...base,
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: metric.points.map((point) => ({
                    startTimeUnixNano: jsonNanos(metric.start),
                    timeUnixNano: jsonNanos(metric.time),
                    count: String(point.count ?? 0),
                    sum: point.sum ?? 0,
                    bucketCounts: (point.buckets ?? []).map(String),
                    explicitBounds: point.bounds ?? [],
                    attributes: jsonAttributes(point.attributes),
                    ...(point.min !== undefined ? { min: point.min } : {}),
                    ...(point.max !== undefined ? { max: point.max } : {}),
                  })),
                },
              };
            }),
          },
        ],
      },
    ],
  });
}
