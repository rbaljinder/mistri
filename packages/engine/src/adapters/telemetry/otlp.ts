/**
 * OTLP over HTTP, configured by the standard OTEL_* environment variables
 * and nothing else — so a Collector, Datadog's Agent and Dynatrace all work
 * with what their own documentation already tells an operator to set.
 *
 * Read (per the OpenTelemetry SDK environment specification):
 *   OTEL_SDK_DISABLED                          `true` turns everything off
 *   OTEL_EXPORTER_OTLP_ENDPOINT                base URL; /v1/traces, /v1/logs, /v1/metrics appended
 *   OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT   a signal's full URL, used as given
 *   OTEL_EXPORTER_OTLP[_{SIGNAL}]_HEADERS      `key=value,…`, values percent-decoded
 *   OTEL_EXPORTER_OTLP[_{SIGNAL}]_PROTOCOL     `http/protobuf` (default) or `http/json`
 *   OTEL_EXPORTER_OTLP[_{SIGNAL}]_TIMEOUT      milliseconds, default 10000
 *   OTEL_EXPORTER_OTLP[_{SIGNAL}]_COMPRESSION  `gzip` or `none`
 *   OTEL_{TRACES,LOGS,METRICS}_EXPORTER        `otlp` (default when an endpoint is set) or `none`
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
 *   OTEL_TRACES_SAMPLER[_ARG]                  always_on, always_off, traceidratio, parentbased_*
 *   OTEL_BSP_SCHEDULE_DELAY, OTEL_BSP_MAX_QUEUE_SIZE, OTEL_BSP_MAX_EXPORT_BATCH_SIZE
 *   OTEL_BLRP_SCHEDULE_DELAY, OTEL_METRIC_EXPORT_INTERVAL
 *
 * gRPC is not spoken: `grpc` is answered with one line on stderr saying to
 * use the HTTP port, and HTTP/protobuf is sent. Every exporter that matters
 * here takes OTLP/HTTP.
 *
 * Nothing waits on an export. A full queue drops the newest and counts it; a
 * failed POST is retried once on the next interval and then dropped. The
 * exporter never logs through the telemetry it exports.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gzipSync } from 'node:zlib';
import { hostname } from 'node:os';
import { addSink, setSampler, type AttributeValue, type LogRecord, type SpanRecord } from './trace.js';
import { enableMetrics, snapshotMetrics, metrics } from './metrics.js';
import { logsJson, logsProto, metricsJson, metricsProto, tracesJson, tracesProto, type Resource, type Scope } from './otlpEncode.js';

type Signal = 'traces' | 'logs' | 'metrics';
type Env = Readonly<Record<string, string | undefined>>;

interface SignalConfig {
  url: URL;
  headers: Record<string, string>;
  json: boolean;
  timeoutMs: number;
  gzip: boolean;
}
interface OtlpConfig {
  resource: Resource;
  signals: Partial<Record<Signal, SignalConfig>>;
  sampler: (traceId: string) => boolean;
  scheduleMs: number;
  maxQueue: number;
  maxBatch: number;
  logScheduleMs: number;
  metricIntervalMs: number;
  warnings: string[];
}

const SIGNALS: readonly Signal[] = ['traces', 'logs', 'metrics'];
const upper = (signal: Signal) => signal.toUpperCase();

const int = (value: string | undefined, fallback: number, min = 0) => {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

/** `key=value,key2=value2`, each part percent-decoded, per the spec's W3C Baggage-like format. */
function parseKeyValues(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? '').split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, at).trim())] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      /* a malformed pair is skipped */
    }
  }
  return out;
}

function samplerOf(env: Env, warnings: string[]): (traceId: string) => boolean {
  const name = (env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  const ratio = Math.min(1, Math.max(0, Number(env.OTEL_TRACES_SAMPLER_ARG ?? '1')));
  // A parent's decision is honoured in trace.ts (`parentbased_` is how every span below a root samples);
  // this decides roots.
  switch (name.replace(/^parentbased_/, '')) {
    case 'always_on':
      return () => true;
    case 'always_off':
      return () => false;
    case 'traceidratio': {
      const bound = Number.isFinite(ratio) ? ratio : 1;
      // The spec's rule: the trace id's low 8 bytes, compared with ratio × 2^64.
      return (traceId) => bound >= 1 || (bound > 0 && BigInt(`0x${traceId.slice(16)}`) < BigInt(Math.floor(bound * 2 ** 53)) << 11n);
    }
    default:
      warnings.push(`OTEL_TRACES_SAMPLER=${name} is not one that is known; sampling every trace.`);
      return () => true;
  }
}

function otlpConfig(env: Env, version: string, service: string): OtlpConfig {
  const warnings: string[] = [];
  const signals: OtlpConfig['signals'] = {};
  for (const signal of SIGNALS) {
    const S = upper(signal);
    const exporters = env[`OTEL_${S}_EXPORTER`]
      ?.split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    if (exporters?.length && !exporters.includes('otlp')) continue;
    const own = env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`]?.trim();
    const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (!own && !base && !exporters?.includes('otlp')) continue;
    let url: URL;
    try {
      url = own ? new URL(own) : new URL(`${(base || 'http://localhost:4318').replace(/\/+$/, '')}/v1/${signal}`);
    } catch {
      warnings.push(`The OTLP ${signal} endpoint is not a URL; ${signal} are not exported.`);
      continue;
    }
    const protocol = (env[`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase();
    if (protocol === 'grpc')
      warnings.push(
        `OTLP over gRPC is not spoken; sending ${signal} as OTLP/HTTP protobuf to ${url.origin}. Point the endpoint at the collector's HTTP port (4318).`,
      );
    signals[signal] = {
      url,
      headers: { ...parseKeyValues(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseKeyValues(env[`OTEL_EXPORTER_OTLP_${S}_HEADERS`]) },
      json: protocol === 'http/json',
      timeoutMs: int(env[`OTEL_EXPORTER_OTLP_${S}_TIMEOUT`] ?? env.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000, 1),
      gzip: (env[`OTEL_EXPORTER_OTLP_${S}_COMPRESSION`] ?? env.OTEL_EXPORTER_OTLP_COMPRESSION ?? 'none').trim().toLowerCase() === 'gzip',
    };
  }
  const attributes: Record<string, AttributeValue> = {
    'service.name': service,
    'service.version': version,
    'telemetry.sdk.name': service,
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': version,
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.versions.node,
    'process.pid': process.pid,
    'host.name': hostname(),
    ...parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES),
    ...(env.OTEL_SERVICE_NAME?.trim() ? { 'service.name': env.OTEL_SERVICE_NAME.trim() } : {}),
  };
  return {
    resource: { attributes },
    signals,
    sampler: samplerOf(env, warnings),
    warnings,
    scheduleMs: int(env.OTEL_BSP_SCHEDULE_DELAY, 5000, 1),
    maxQueue: int(env.OTEL_BSP_MAX_QUEUE_SIZE, 2048, 1),
    maxBatch: int(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512, 1),
    logScheduleMs: int(env.OTEL_BLRP_SCHEDULE_DELAY, 1000, 1),
    metricIntervalMs: int(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000, 1),
  };
}

function post(config: SignalConfig, body: Buffer | string): Promise<boolean> {
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const payload = config.gzip ? gzipSync(raw) : raw;
  const headers: Record<string, string> = {
    ...config.headers,
    'content-type': config.json ? 'application/json' : 'application/x-protobuf',
    'content-length': String(payload.length),
    ...(config.gzip ? { 'content-encoding': 'gzip' } : {}),
  };
  return new Promise((resolve) => {
    const open = config.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = open(config.url, { method: 'POST', headers, timeout: config.timeoutMs }, (response) => {
      response.resume();
      // 2xx is accepted; a 4xx other than throttling will not improve on a retry.
      const status = response.statusCode ?? 0;
      resolve((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 429));
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('timeout')));
    outgoing.on('error', () => resolve(false));
    outgoing.end(payload);
  });
}

/** One signal's queue: batched, bounded, one POST at a time. */
class Queue<T> {
  private items: T[] = [];
  private retry: T[] | undefined;
  private sending: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval>;
  dropped = 0;
  constructor(
    private readonly target: SignalConfig,
    private readonly encode: (items: readonly T[], json: boolean) => Buffer | string,
    private readonly maxQueue: number,
    private readonly maxBatch: number,
    scheduleMs: number,
  ) {
    this.timer = setInterval(() => {
      void this.flush();
    }, scheduleMs);
    this.timer.unref();
  }
  add(item: T) {
    if (this.items.length >= this.maxQueue) {
      this.dropped++;
      return;
    }
    this.items.push(item);
    if (this.items.length >= this.maxBatch) void this.flush();
  }
  flush(): Promise<void> {
    if (this.sending) return this.sending.then(() => (this.items.length || this.retry ? this.flush() : undefined));
    if (!this.items.length && !this.retry) return Promise.resolve();
    const batch = this.retry ?? this.items.splice(0, this.maxBatch);
    const wasRetry = Boolean(this.retry);
    this.retry = undefined;
    this.sending = post(this.target, this.encode(batch, this.target.json))
      .then(
        (ok) => {
          if (!ok) {
            if (wasRetry) this.dropped += batch.length;
            else this.retry = batch;
          }
        },
        () => {
          this.dropped += batch.length;
        },
      )
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending.then(() => (this.items.length ? this.flush() : undefined));
  }
  stop() {
    clearInterval(this.timer);
  }
}

interface OtlpExporter {
  /** The signals being sent. */
  readonly signals: readonly Signal[];
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly warnings: readonly string[];
}

/** Start exporting what the environment asks for. The caller checked `otlpRequested`. */
export function startOtlp(env: Env, version: string, service = 'mistri'): OtlpExporter {
  const config = otlpConfig(env, version, service);
  const scope: Scope = { name: service, version };
  const { traces, logs, metrics: metricTarget } = config.signals;
  setSampler(config.sampler);
  const spanQueue =
    traces &&
    new Queue<SpanRecord>(
      traces,
      (items, json) => (json ? tracesJson(config.resource, scope, items) : tracesProto(config.resource, scope, items)),
      config.maxQueue,
      config.maxBatch,
      config.scheduleMs,
    );
  const logQueue =
    logs &&
    new Queue<LogRecord>(
      logs,
      (items, json) => (json ? logsJson(config.resource, scope, items) : logsProto(config.resource, scope, items)),
      config.maxQueue,
      config.maxBatch,
      config.logScheduleMs,
    );
  let metricTimer: ReturnType<typeof setInterval> | undefined;
  const sendMetrics = async () => {
    if (!metricTarget) return;
    const snapshot = snapshotMetrics();
    if (!snapshot.length) return;
    await post(
      metricTarget,
      metricTarget.json ? metricsJson(config.resource, scope, snapshot) : metricsProto(config.resource, scope, snapshot),
    );
  };
  if (metricTarget) {
    enableMetrics();
    metricTimer = setInterval(() => {
      void sendMetrics();
    }, config.metricIntervalMs);
    metricTimer.unref();
  }
  const remove = addSink({
    onEnd(span) {
      recordSpanMetrics(span);
      // Only the travelling parts are read here: never `detail`.
      if (span.sampled) spanQueue?.add(span);
    },
    onLog(record) {
      // A line only the local observer may keep (an App's own console) never reaches this sink; see trace.ts.
      if (record.local) return;
      logQueue?.add({
        time: record.time,
        level: record.level,
        source: record.source,
        message: record.message,
        attributes: record.attributes,
        ...(record.traceId ? { traceId: record.traceId, spanId: record.spanId, sampled: record.sampled } : {}),
      });
    },
  });
  const flush = async () => {
    await Promise.all([spanQueue?.flush(), logQueue?.flush(), sendMetrics()]);
  };
  return {
    warnings: config.warnings,
    signals: SIGNALS.filter((signal) => config.signals[signal]),
    flush,
    async shutdown() {
      remove();
      clearInterval(metricTimer);
      spanQueue?.stop();
      logQueue?.stop();
      await flush();
    },
  };
}

/** The metrics a span implies, recorded whether or not the span is sampled. */
function recordSpanMetrics(span: SpanRecord) {
  const seconds = ((span.endTime ?? span.startTime) - span.startTime) / 1000;
  const a = span.attributes;
  if (span.kind === 'server' && a['http.request.method']) {
    metrics.httpDuration.record(seconds, {
      'http.request.method': a['http.request.method'],
      'http.route': a['http.route'],
      'http.response.status_code': a['http.response.status_code'],
      'error.type': a['error.type'],
    });
  } else if (a['db.system.name']) {
    metrics.dbDuration.record(seconds, {
      'db.system.name': a['db.system.name'],
      'db.operation.name': a['db.operation.name'],
      'db.collection.name': a['db.collection.name'],
      'error.type': a['error.type'],
    });
  } else if (a['mistri.command.id']) {
    const labels = {
      'mistri.command.id': a['mistri.command.id'],
      'mistri.command.outcome': a['mistri.command.outcome'],
      'mistri.refusal.code': a['mistri.refusal.code'],
    };
    metrics.commands.record(1, labels);
    metrics.commandDuration.record(seconds, labels);
  } else if (a['mistri.job.id']) {
    metrics.jobAttempts.record(1, { 'mistri.job.id': a['mistri.job.id'], 'mistri.job.outcome': a['mistri.job.outcome'] });
    if (typeof a['mistri.job.lag_ms'] === 'number')
      metrics.jobLag.record(a['mistri.job.lag_ms'] / 1000, { 'mistri.job.id': a['mistri.job.id'] });
  } else if (a['mistri.outbound.kind']) {
    metrics.outbound.record(1, {
      'mistri.outbound.kind': a['mistri.outbound.kind'],
      'error.type': a['error.type'],
      'http.response.status_code': a['http.response.status_code'],
    });
  }
}
