/**
 * Spans and logs, for whoever is listening — and nothing at all when nobody is.
 *
 * Two listeners exist. The OpenTelemetry exporter (otlp.ts) is switched on by
 * the standard OTEL_* environment variables and sends what it is given to a
 * collector, Datadog's Agent or Dynatrace. The dev observer
 * (server/observe/) keeps the last few hundred requests in memory for the
 * author at work. Both hear the same spans, so what the observer shows is
 * what production exports, plus the detail production must never see.
 *
 * That split is the privacy rule, made structural rather than remembered:
 *
 * - `attributes` travel. They are set only from values the code itself names
 *   — a route template, a statement's kind and table, a command's id, a
 *   refusal's code, a count — never from a request, a row, a parameter, a
 *   body, an email or a token. They follow the OpenTelemetry semantic
 *   conventions where one exists.
 * - `detail` does not. It is where the SQL with its parameters, a command's
 *   input and output and a refusal's recorded cause go, and only a sink that
 *   asks for it (the dev observer, loopback only, dev only) is handed it.
 *   With no such sink, `detail` is never even built: callers pass a function.
 *
 * With no sink at all, `inSpan` calls its function and returns: no id is
 * drawn, no clock read, no context entered. `npx tablewalk` pays one boolean.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type AttributeValue = string | number | boolean | readonly string[] | readonly number[];
type Attributes = Readonly<Record<string, AttributeValue>>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface SpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes?: Attributes;
}

/** One finished (or, for `onStart`, begun) span, as every sink sees it. Times are epoch milliseconds, fractional. */
export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  /** The parent came from another process (a `traceparent` header): this span is the local root. */
  readonly remoteParent: boolean;
  readonly traceState?: string;
  /** Settable until the span ends: a request is named once its route is known. */
  name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  endTime?: number;
  readonly attributes: Record<string, AttributeValue>;
  readonly events: Array<{ name: string; time: number; attributes: Attributes }>;
  readonly links: readonly SpanLink[];
  status: { code: 'unset' | 'ok' | 'error'; message?: string };
  /** Whether the exporter keeps it: the sampler's word at the trace's root. The observer keeps every span. */
  readonly sampled: boolean;
  /** Dev-only detail. Empty unless a sink asked for it. Never exported. */
  readonly detail: Record<string, unknown>;
}

/** A structured log line: `message` and `attributes` travel, `detail` stays local like a span's. */
export interface LogRecord {
  readonly time: number;
  readonly level: LogLevel;
  /** What wrote it: `http`, `commands`, `jobs`, `app` (an App's own console), `startup`… */
  readonly source: string;
  readonly message: string;
  readonly attributes: Attributes;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly sampled?: boolean;
  readonly detail?: Record<string, unknown>;
  /** A line only the local observer may keep (the App's console, which says anything). */
  readonly local?: boolean;
}

interface TelemetrySink {
  /** Hand this sink the spans' `detail` and local log lines. Only the dev observer may. */
  readonly local?: boolean;
  onStart?(span: SpanRecord): void;
  onEnd(span: SpanRecord): void;
  onLog?(record: LogRecord): void;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly recording: boolean;
  setAttribute(key: string, value: AttributeValue | undefined): void;
  /** Rename the span before it ends: a request's route is known only once its address is read. */
  rename(name: string): void;
  /** Drop the span: it ends and no sink hears of it (a heartbeat, the observer's own requests). */
  discard(): void;
  setAttributes(values: Readonly<Record<string, AttributeValue | undefined>>): void;
  /** Local detail, built only when a local sink listens. */
  detail(build: () => Record<string, unknown>): void;
  event(name: string, attributes?: Readonly<Record<string, AttributeValue | undefined>>): void;
  /** The span failed. `code` is what travels (a refusal code, an error class); the error itself stays local. */
  fail(code: string, error?: unknown): void;
  end(): void;
}

const NOOP: Span = Object.freeze({
  traceId: '',
  spanId: '',
  recording: false,
  setAttribute() {},
  rename() {},
  discard() {},
  setAttributes() {},
  detail() {},
  event() {},
  fail() {},
  end() {},
});

const sinks: TelemetrySink[] = [];
let local = false;
const storage = new AsyncLocalStorage<LiveSpan>();
/** The sampler: whether a new trace is exported. Always on until the exporter says otherwise. */
let sampler: (traceId: string) => boolean = () => true;

/** Whether anything listens. The one check every instrumented path makes first. */
export const tracing = (): boolean => sinks.length > 0;
/** Whether a local sink (the dev observer) listens, so local detail is worth building. */
export const observing = (): boolean => local;

export function addSink(sink: TelemetrySink): () => void {
  sinks.push(sink);
  local ||= sink.local === true;
  return () => {
    const at = sinks.indexOf(sink);
    if (at >= 0) sinks.splice(at, 1);
    local = sinks.some((each) => each.local === true);
  };
}

export function setSampler(decide: (traceId: string) => boolean): void {
  sampler = decide;
}

const now = () => performance.timeOrigin + performance.now();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const clean = (values: Readonly<Record<string, AttributeValue | undefined>>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, AttributeValue>;

class LiveSpan implements Span {
  readonly recording = true;
  ended = false;
  constructor(readonly record: SpanRecord) {}
  get traceId() {
    return this.record.traceId;
  }
  get spanId() {
    return this.record.spanId;
  }
  setAttribute(key: string, value: AttributeValue | undefined) {
    if (value !== undefined && !this.ended) this.record.attributes[key] = value;
  }
  setAttributes(values: Readonly<Record<string, AttributeValue | undefined>>) {
    if (!this.ended) Object.assign(this.record.attributes, clean(values));
  }
  rename(name: string) {
    if (!this.ended) this.record.name = name;
  }
  discarded = false;
  discard() {
    this.ended = true;
    this.discarded = true;
  }
  detail(build: () => Record<string, unknown>) {
    if (!local) return;
    // Detail is a courtesy to the author; building it must never fail the work it describes.
    try {
      Object.assign(this.record.detail, build());
    } catch {
      /* left out */
    }
  }
  event(name: string, attributes: Readonly<Record<string, AttributeValue | undefined>> = {}) {
    if (!this.ended) this.record.events.push({ name, time: now(), attributes: clean(attributes) });
  }
  fail(code: string, error?: unknown) {
    this.record.status = { code: 'error', message: code };
    this.record.attributes['error.type'] = code;
    if (error !== undefined) this.detail(() => ({ error: describeError(error) }));
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.record.endTime = now();
    for (const sink of sinks) {
      try {
        sink.onEnd(this.record);
      } catch {
        /* a sink never fails the traced work */
      }
    }
  }
}

/** What an error was, for local eyes only: its class, its words and the reasons recorded beneath it. */
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') out.code = code;
  if (error.stack) out.stack = error.stack.split('\n').slice(0, 12).join('\n');
  return out;
}

interface TraceParent {
  traceId: string;
  spanId: string;
  sampled: boolean;
  traceState?: string;
}

interface SpanOptions {
  kind?: SpanKind;
  attributes?: Readonly<Record<string, AttributeValue | undefined>>;
  /** A parent from elsewhere: an incoming `traceparent`, a job's enqueuer. Ignored when a span is already current. */
  remote?: TraceParent;
  links?: readonly SpanLink[];
  /** Start only inside an existing span: a statement outside any request, job or command is not worth a trace. */
  childOnly?: boolean;
}

/** Begin a span; the caller ends it. Prefer `inSpan`, which also makes it current. */
export function startSpan(name: string, options: SpanOptions = {}): Span {
  if (!sinks.length) return NOOP;
  const parent = storage.getStore();
  if (options.childOnly && !parent) return NOOP;
  // Beneath a dropped span nothing is traced: the observer's own EXPLAIN is not a trace.
  if (parent?.discarded) return NOOP;
  const remote = parent ? undefined : options.remote;
  const traceId = parent?.traceId ?? remote?.traceId ?? hex(16);
  const record: SpanRecord = {
    traceId,
    spanId: hex(8),
    parentSpanId: parent?.spanId ?? remote?.spanId,
    remoteParent: !parent && !!remote,
    ...((parent?.record.traceState ?? remote?.traceState) ? { traceState: parent?.record.traceState ?? remote?.traceState } : {}),
    name,
    kind: options.kind ?? 'internal',
    startTime: now(),
    attributes: clean(options.attributes ?? {}),
    events: [],
    links: options.links ?? [],
    status: { code: 'unset' },
    sampled: parent ? parent.record.sampled : remote ? remote.sampled : sampler(traceId),
    detail: {},
  };
  const span = new LiveSpan(record);
  for (const sink of sinks) {
    try {
      sink.onStart?.(record);
    } catch {
      /* as above */
    }
  }
  return span;
}

/** Run `work` inside `span`, so every span begun beneath it is its child. */
export function withSpan<T>(span: Span, work: () => T): T {
  return span instanceof LiveSpan ? storage.run(span, work) : work();
}

/**
 * Run `work` as a span: current for everything it starts, ended when it
 * settles, failed when it throws. The error's class names the failure unless
 * `failure` says otherwise (a refusal's code).
 */
export function inSpan<T>(name: string, options: SpanOptions, work: (span: Span) => T, failure: (error: unknown) => string = errorCode): T {
  if (!sinks.length) return work(NOOP);
  const span = startSpan(name, options);
  if (!(span instanceof LiveSpan)) return work(span);
  return storage.run(span, () => {
    let result: T;
    try {
      result = work(span);
    } catch (error) {
      span.fail(failure(error), error);
      span.end();
      throw error;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (value) => {
          span.end();
          return value;
        },
        (error) => {
          span.fail(failure(error), error);
          span.end();
          throw error;
        },
      ) as T;
    }
    span.end();
    return result;
  });
}

/** An error's travelling name: its `code` when it is one of ours (a refusal's), else its class. Never its message. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)) return code;
  return error instanceof Error ? error.name || 'Error' : 'Error';
}

export function currentSpan(): Span | undefined {
  return storage.getStore();
}

/** The current trace, as a W3C `traceparent` header. */
function traceparent(span: Span | undefined = storage.getStore()): string | undefined {
  if (!span || !(span instanceof LiveSpan)) return undefined;
  return `00-${span.traceId}-${span.spanId}-${span.record.sampled ? '01' : '00'}`;
}

/** Carry the current trace on an outgoing request's headers (W3C Trace Context). */
export function injectTrace(headers: Record<string, string>): Record<string, string> {
  const span = storage.getStore();
  const parent = traceparent(span);
  if (!parent) return headers;
  return { ...headers, traceparent: parent, ...(span!.record.traceState ? { tracestate: span!.record.traceState } : {}) };
}

/** Read a W3C `traceparent` (and its `tracestate`), refusing anything malformed rather than guessing. */
export function parseTraceparent(header: unknown, state?: unknown): TraceParent | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim());
  if (!match || match[1] === 'ff' || /^0+$/.test(match[2]) || /^0+$/.test(match[3])) return undefined;
  const traceState = typeof state === 'string' && state.length <= 512 && /^[\x20-\x7e]*$/.test(state) ? state.trim() : undefined;
  return { traceId: match[2], spanId: match[3], sampled: (parseInt(match[4], 16) & 1) === 1, ...(traceState ? { traceState } : {}) };
}

/**
 * One structured log line, correlated with the current span. The terminal's
 * own lines are left as they are; this is the structured version, for the
 * exporter and the observer. `message` and `attributes` travel: write them
 * from the code's own words.
 */
export function log(
  level: LogLevel,
  source: string,
  message: string,
  options: {
    attributes?: Readonly<Record<string, AttributeValue | undefined>>;
    detail?: () => Record<string, unknown>;
    local?: boolean;
  } = {},
): void {
  if (!sinks.length) return;
  const span = storage.getStore();
  let detail: Record<string, unknown> | undefined;
  if (local && options.detail) {
    try {
      detail = options.detail();
    } catch {
      detail = undefined;
    }
  }
  const record: LogRecord = {
    time: now(),
    level,
    source,
    message,
    attributes: clean(options.attributes ?? {}),
    ...(span ? { traceId: span.traceId, spanId: span.spanId, sampled: span.record.sampled } : {}),
    ...(detail ? { detail } : {}),
    ...(options.local ? { local: true } : {}),
  };
  for (const sink of sinks) {
    if (record.local && !sink.local) continue;
    try {
      sink.onLog?.(record);
    } catch {
      /* as above */
    }
  }
}
