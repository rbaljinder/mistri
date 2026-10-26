/**
 * The dev observer's memory: the last few hundred traces and a few thousand
 * log lines, in this process, bounded, gone on restart. Nothing is written
 * to disk. Everything is masked on the way in (mask.ts), so what is kept is
 * what may be shown.
 *
 * Read two ways, by the page (http.ts) and by an agent over MCP (mcp.ts),
 * and both read the same answers here: a trace list, one trace as a tree,
 * logs, errors, slow and repeated statements, page reports, and a cursor to
 * tail from. The agent's answers are shaped for an agent — summaries first,
 * bounded, truncation said, ids to drill into — and so are the page's; the
 * page just draws more of them.
 */
import type { LogRecord, SpanRecord } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { statementShape } from '@mistriwork/engine/adapters/telemetry/statement.js';
import type { Masker } from './mask.js';

interface SpanView {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanRecord['kind'];
  start: number;
  duration: number;
  attributes: SpanRecord['attributes'];
  status: SpanRecord['status'];
  events: SpanRecord['events'];
  detail: Record<string, unknown>;
  flags: { slow?: true; nPlusOne?: number };
}

interface LogView {
  seq: number;
  time: number;
  level: LogRecord['level'];
  source: string;
  message: string;
  attributes: LogRecord['attributes'];
  traceId?: string;
  spanId?: string;
  detail?: Record<string, unknown>;
}

export interface TraceView {
  traceId: string;
  seq: number;
  start: number;
  duration: number;
  name: string;
  method?: string;
  route?: string;
  path?: string;
  status?: number;
  error?: string;
  /** The browser gave the request up before its answer was written: said apart from errors. */
  aborted?: true;
  /** The App the request was served for (traceRequest.ts servedApp). */
  app?: string;
  spans: Map<string, SpanView>;
  logs: LogView[];
  droppedSpans: number;
  statements: number;
  complete: boolean;
}

export interface PageReport {
  seq: number;
  time: number;
  kind: 'error' | 'layout-shift' | 'vital';
  path: string;
  traceId?: string;
  message?: string;
  stack?: string;
  value?: number;
  name?: string;
  sources?: Array<{ node: string; previous?: string; current?: string }>;
}

const TRACES = 300;
const SPANS_PER_TRACE = 1500;
const LOGS = 5000;
const LOGS_PER_TRACE = 500;
const PAGE_REPORTS = 300;
/** Traces dropped whole (a file the dev server handed out), remembered so a span that ends after them starts no trace of its own. */
const DROPPED = 1000;
/** The same statement shape this many times under one parent is the N+1 pattern. */
const N_PLUS_ONE = 5;

export class ObserverStore {
  private readonly traces = new Map<string, TraceView>();
  private readonly logs: LogView[] = [];
  private readonly pages: PageReport[] = [];
  private readonly dropped = new Set<string>();
  private seq = 0;
  readonly slowMs: number;

  constructor(
    private readonly mask: Masker,
    options: { slowMs?: number } = {},
  ) {
    this.slowMs = options.slowMs ?? 100;
  }

  get cursor(): number {
    return this.seq;
  }

  addSpan(span: SpanRecord): void {
    /* A module or file the dev server handed out is not a request anyone is
       debugging: under Vite every source file is one, each with the gate's
       session read beneath it, and they buried the App's own requests. One
       that failed stays. Its children ended first, so the trace goes whole. */
    if (
      span.kind === 'server' &&
      span.attributes['http.route'] === '/{asset}' &&
      (!span.parentSpanId || span.remoteParent) &&
      Number(span.attributes['http.response.status_code'] ?? 200) < 400
    ) {
      this.traces.delete(span.traceId);
      /* A request the browser dropped ends before its session read does,
         and that read, ending after, was kept as a trace of its own. */
      this.dropped.add(span.traceId);
      if (this.dropped.size > DROPPED) this.dropped.delete(this.dropped.values().next().value!);
      return;
    }
    if (this.dropped.has(span.traceId)) return;
    let trace = this.traces.get(span.traceId);
    if (!trace) {
      trace = {
        traceId: span.traceId,
        seq: 0,
        start: span.startTime,
        duration: 0,
        name: span.name,
        spans: new Map(),
        logs: [],
        droppedSpans: 0,
        statements: 0,
        complete: false,
      };
      this.traces.set(span.traceId, trace);
      while (this.traces.size > TRACES) this.traces.delete(this.traces.keys().next().value!);
    }
    trace.seq = ++this.seq;
    if (trace.spans.size >= SPANS_PER_TRACE) {
      trace.droppedSpans++;
      return;
    }
    const view: SpanView = {
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: span.kind,
      start: span.startTime,
      duration: (span.endTime ?? span.startTime) - span.startTime,
      attributes: { ...span.attributes },
      status: { ...span.status },
      events: span.events.slice(0, 50),
      detail: this.maskDetail(span),
      flags: {},
    };
    if (span.attributes['db.system.name']) {
      trace.statements++;
      if (view.duration >= this.slowMs) view.flags.slow = true;
    }
    trace.spans.set(span.spanId, view);
    trace.start = Math.min(trace.start, span.startTime);
    // The local root — no parent here, or a parent in another process — names the trace.
    const root = !span.parentSpanId || span.remoteParent || (!trace.spans.has(span.parentSpanId) && span.kind === 'server');
    if (root) {
      trace.name = span.name;
      trace.duration = view.duration;
      trace.complete = true;
      const method = span.attributes['http.request.method'];
      if (typeof method === 'string') trace.method = method;
      const route = span.attributes['http.route'];
      if (typeof route === 'string') trace.route = route;
      const status = span.attributes['http.response.status_code'];
      if (typeof status === 'number') trace.status = status;
      const request = view.detail.request as { url?: string } | undefined;
      if (request?.url) trace.path = request.url;
      if (typeof span.attributes['mistri.app.id'] === 'string') trace.app = span.attributes['mistri.app.id'];
      if (span.attributes['mistri.request.aborted'] === true) trace.aborted = true;
    }
    if (span.status.code === 'error' && (!trace.error || root)) trace.error = span.status.message ?? 'error';
  }

  private maskDetail(span: SpanRecord): Record<string, unknown> {
    const detail = span.detail;
    if (!Object.keys(detail).length) return {};
    const table =
      typeof span.attributes['db.collection.name'] === 'string'
        ? (span.attributes['db.collection.name'] as string)
        : typeof span.attributes['mistri.command.target'] === 'string'
          ? (span.attributes['mistri.command.target'] as string)
          : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (key === 'sql' && typeof value === 'string') out.sql = this.mask.text(value);
      else if (key === 'params') out.params = this.mask.params(typeof detail.sql === 'string' ? detail.sql : '', value, table);
      else if (key === 'request' || key === 'response') {
        const { headers, body, url, ...rest } = value as { headers?: Record<string, unknown>; body?: unknown; url?: unknown };
        out[key] = {
          ...(this.mask.value(rest, table) as object),
          ...(typeof url === 'string' ? { url: this.mask.text(url) } : {}),
          ...(headers ? { headers: this.mask.headers(headers) } : {}),
          ...(typeof body === 'string'
            ? { body: this.mask.body(body, table) }
            : body !== undefined
              ? { body: this.mask.value(body, table) }
              : {}),
        };
      } else out[key] = this.mask.value(value, table);
    }
    return out;
  }

  addLog(record: LogRecord): void {
    const view: LogView = {
      seq: ++this.seq,
      time: record.time,
      level: record.level,
      source: record.source,
      message: this.mask.text(record.message).slice(0, 8000),
      attributes: record.attributes,
      ...(record.traceId ? { traceId: record.traceId, spanId: record.spanId } : {}),
      ...(record.detail ? { detail: this.mask.value(record.detail) as Record<string, unknown> } : {}),
    };
    this.logs.push(view);
    if (this.logs.length > LOGS) this.logs.splice(0, this.logs.length - LOGS);
    const trace = record.traceId ? this.traces.get(record.traceId) : undefined;
    if (trace && trace.logs.length < LOGS_PER_TRACE) {
      trace.logs.push(view);
      trace.seq = view.seq;
    }
  }

  addPage(report: Omit<PageReport, 'seq'>): PageReport {
    const kept: PageReport = {
      ...report,
      seq: ++this.seq,
      ...(report.message ? { message: this.mask.text(report.message).slice(0, 2000) } : {}),
      ...(report.stack ? { stack: this.mask.text(report.stack).slice(0, 4000) } : {}),
      path: this.mask.text(report.path).slice(0, 2000),
    };
    this.pages.push(kept);
    if (this.pages.length > PAGE_REPORTS) this.pages.splice(0, this.pages.length - PAGE_REPORTS);
    return kept;
  }

  /* ---------- reads ---------- */

  private flagged(trace: TraceView): SpanView[] {
    const spans = [...trace.spans.values()];
    // N+1: one parent running the same statement shape again and again.
    const groups = new Map<string, SpanView[]>();
    for (const span of spans) {
      if (!span.attributes['db.system.name'] || typeof span.detail.sql !== 'string') continue;
      const key = `${span.parentSpanId ?? ''}\u0000${statementShape(span.detail.sql)}`;
      groups.set(key, [...(groups.get(key) ?? []), span]);
    }
    for (const group of groups.values()) {
      if (
        group.length >= N_PLUS_ONE &&
        !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET)/i.test(String(group[0].attributes['db.operation.name']))
      ) {
        for (const span of group) span.flags.nPlusOne = group.length;
      }
    }
    return spans.sort((a, b) => a.start - b.start);
  }

  summary(trace: TraceView) {
    const spans = this.flagged(trace);
    const statements = spans.filter((span) => span.attributes['db.system.name']);
    const commands = spans.filter((span) => span.attributes['mistri.command.id']);
    const refusal = spans.find((span) => span.attributes['mistri.refusal.code']);
    /* The refusal as its reader was told it — the sentence and the field it
       names — beside the cause the server recorded, so a list of errors
       says what went wrong without opening each trace. */
    const told = refusal
      ? spans
          .map((span) => span.detail.refusal as { message?: unknown; reason?: unknown; said?: unknown; field?: unknown } | undefined)
          .filter((detail) => detail !== undefined)
      : [];
    // The command's own words first (its reason, its message), then what the request answered.
    const sentence = [...told.map((detail) => detail!.reason ?? detail!.message), ...told.map((detail) => detail!.said)].find(
      (each) => typeof each === 'string',
    );
    const field = told.map((detail) => detail!.field).find((each) => typeof each === 'string');
    return {
      traceId: trace.traceId,
      seq: trace.seq,
      start: new Date(trace.start).toISOString(),
      durationMs: round(trace.duration),
      name: trace.name,
      ...(trace.method ? { method: trace.method } : {}),
      ...(trace.route ? { route: trace.route } : {}),
      ...(trace.path ? { path: trace.path } : {}),
      ...(trace.status !== undefined ? { status: trace.status } : {}),
      ...(trace.error ? { error: trace.error } : {}),
      ...(trace.aborted ? { aborted: true } : {}),
      ...(trace.app ? { app: trace.app } : {}),
      ...(refusal
        ? {
            refusal: {
              code: refusal.attributes['mistri.refusal.code'],
              ...(typeof sentence === 'string' ? { message: sentence } : {}),
              ...(field ? { field } : {}),
              ...(Array.isArray(refusal.detail.because) ? { because: refusal.detail.because } : {}),
            },
          }
        : {}),
      spans: trace.spans.size,
      statements: statements.length,
      slowStatements: statements.filter((span) => span.flags.slow).length,
      nPlusOne: new Set(statements.filter((span) => span.flags.nPlusOne).map((span) => statementShape(String(span.detail.sql)))).size,
      commands: commands.map((span) => ({
        id: span.attributes['mistri.command.id'],
        outcome: span.attributes['mistri.command.outcome'],
      })),
      logs: trace.logs.length,
      complete: trace.complete,
    };
  }

  list(
    filter: {
      route?: string;
      status?: number;
      error?: boolean;
      slowerThanMs?: number;
      since?: number;
      limit?: number;
      app?: string;
      text?: string;
    } = {},
  ) {
    const limit = clamp(filter.limit, 1, 200, 30);
    const matched = [...this.traces.values()]
      .reverse()
      .filter(
        (trace) =>
          (filter.route === undefined ||
            trace.route === filter.route ||
            trace.name.includes(filter.route) ||
            (trace.path ?? '').includes(filter.route)) &&
          (filter.status === undefined ||
            trace.status === filter.status ||
            (filter.status < 10 && Math.floor((trace.status ?? 0) / 100) === filter.status)) &&
          (filter.error === undefined || Boolean(trace.error || (trace.status ?? 0) >= 400) === filter.error) &&
          (filter.slowerThanMs === undefined || trace.duration >= filter.slowerThanMs) &&
          (filter.since === undefined || trace.seq > filter.since) &&
          (filter.app === undefined || trace.app === filter.app) &&
          (filter.text === undefined || JSON.stringify([trace.name, trace.path]).toLowerCase().includes(filter.text.toLowerCase())),
      );
    return {
      cursor: this.seq,
      total: matched.length,
      truncated: matched.length > limit,
      traces: matched.slice(0, limit).map((trace) => this.summary(trace)),
    };
  }

  trace(traceId: string, options: { full?: boolean } = {}) {
    const trace =
      this.traces.get(traceId) ?? [...this.traces.values()].find((each) => each.traceId.startsWith(traceId) && traceId.length >= 8);
    if (!trace) return undefined;
    const spans = this.flagged(trace);
    const logsBySpan = new Map<string, LogView[]>();
    for (const line of trace.logs) if (line.spanId) logsBySpan.set(line.spanId, [...(logsBySpan.get(line.spanId) ?? []), line]);
    const cap = options.full ? Infinity : 200;
    return {
      ...this.summary(trace),
      droppedSpans: trace.droppedSpans,
      truncated: spans.length > cap,
      spans: spans.slice(0, cap).map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: span.kind,
        offsetMs: round(span.start - trace.start),
        durationMs: round(span.duration),
        attributes: span.attributes,
        status: span.status,
        ...(span.events.length
          ? {
              events: span.events.map((event) => ({
                name: event.name,
                offsetMs: round(event.time - trace.start),
                attributes: event.attributes,
              })),
            }
          : {}),
        ...(Object.keys(span.detail).length ? { detail: span.detail } : {}),
        ...(Object.keys(span.flags).length ? { flags: span.flags } : {}),
        ...(logsBySpan.get(span.spanId)?.length
          ? {
              logs: logsBySpan
                .get(span.spanId)!
                .map((line) => ({ seq: line.seq, level: line.level, source: line.source, message: line.message })),
            }
          : {}),
      })),
    };
  }

  searchLogs(
    filter: {
      level?: string;
      text?: string;
      traceId?: string;
      source?: string;
      since?: number;
      limit?: number;
      outsideRequests?: boolean;
    } = {},
  ) {
    const limit = clamp(filter.limit, 1, 1000, 100);
    const levels = ['debug', 'info', 'warn', 'error'];
    const floor = filter.level ? levels.indexOf(filter.level) : 0;
    const text = filter.text?.toLowerCase();
    const matched = this.logs.filter(
      (line) =>
        levels.indexOf(line.level) >= Math.max(0, floor) &&
        (filter.since === undefined || line.seq > filter.since) &&
        (filter.traceId === undefined || line.traceId === filter.traceId || (line.traceId ?? '').startsWith(filter.traceId)) &&
        (filter.source === undefined || line.source === filter.source) &&
        (filter.outsideRequests === undefined || !line.traceId === filter.outsideRequests) &&
        (text === undefined || line.message.toLowerCase().includes(text) || line.source.includes(text)),
    );
    const lines = matched.slice(-limit);
    return {
      cursor: this.seq,
      total: matched.length,
      truncated: matched.length > limit,
      sources: [...new Set(this.logs.map((line) => line.source))].sort(),
      logs: lines,
    };
  }

  /** Refusals with their cause, server failures and page errors, newest first. */
  errors(limit?: number, since?: number) {
    const cap = clamp(limit, 1, 200, 20);
    const out: Array<Record<string, unknown> & { seq: number }> = [];
    for (const trace of this.traces.values()) {
      if (since !== undefined && trace.seq <= since) continue;
      if (!trace.error && (trace.status ?? 0) < 400) continue;
      const summary = this.summary(trace);
      const failing = [...trace.spans.values()].filter((span) => span.status.code === 'error').sort((a, b) => b.start - a.start)[0];
      out.push({
        kind: (trace.status ?? 0) >= 500 ? 'server-error' : summary.refusal ? 'refusal' : 'error',
        seq: trace.seq,
        traceId: trace.traceId,
        name: trace.name,
        path: trace.path,
        status: trace.status,
        error: trace.error,
        ...(summary.refusal ? { refusal: summary.refusal } : {}),
        ...(failing && failing.detail.error ? { failure: { span: failing.name, error: failing.detail.error } } : {}),
      });
    }
    for (const page of this.pages)
      if (page.kind === 'error' && (since === undefined || page.seq > since)) {
        out.push({ kind: 'page-error', seq: page.seq, path: page.path, message: page.message, stack: page.stack, traceId: page.traceId });
      }
    out.sort((a, b) => b.seq - a.seq);
    return { cursor: this.seq, total: out.length, truncated: out.length > cap, errors: out.slice(0, cap) };
  }

  slowQueries(limit?: number) {
    const cap = clamp(limit, 1, 200, 20);
    const all: Array<{
      traceId: string;
      spanId: string;
      summary: string;
      durationMs: number;
      sql?: unknown;
      params?: unknown;
      rows?: unknown;
    }> = [];
    for (const trace of this.traces.values())
      for (const span of trace.spans.values()) {
        if (!span.flags.slow) continue;
        all.push({
          traceId: trace.traceId,
          spanId: span.spanId,
          summary: span.name,
          durationMs: round(span.duration),
          sql: span.detail.sql,
          params: span.detail.params,
          rows: span.detail.rows,
        });
      }
    all.sort((a, b) => b.durationMs - a.durationMs);
    return { thresholdMs: this.slowMs, total: all.length, truncated: all.length > cap, statements: all.slice(0, cap) };
  }

  nPlusOne(limit?: number) {
    const cap = clamp(limit, 1, 100, 20);
    const found: Array<{
      traceId: string;
      trace: string;
      parent?: string;
      count: number;
      totalMs: number;
      shape: string;
      example: { spanId: string; params?: unknown };
    }> = [];
    for (const trace of [...this.traces.values()].reverse()) {
      const spans = this.flagged(trace);
      const seen = new Set<string>();
      for (const span of spans) {
        if (!span.flags.nPlusOne) continue;
        const shape = statementShape(String(span.detail.sql));
        const key = `${span.parentSpanId}\u0000${shape}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const group = spans.filter(
          (each) => each.parentSpanId === span.parentSpanId && each.flags.nPlusOne && statementShape(String(each.detail.sql)) === shape,
        );
        found.push({
          traceId: trace.traceId,
          trace: trace.path ?? trace.name,
          parent: span.parentSpanId ? trace.spans.get(span.parentSpanId)?.name : undefined,
          count: group.length,
          totalMs: round(group.reduce((sum, each) => sum + each.duration, 0)),
          shape: shape.length > 600 ? `${shape.slice(0, 300)} … ${shape.slice(-280)}` : shape,
          example: { spanId: span.spanId, params: span.detail.params },
        });
      }
    }
    return { threshold: N_PLUS_ONE, total: found.length, truncated: found.length > cap, patterns: found.slice(0, cap) };
  }

  pageReports(limit?: number, kind?: PageReport['kind']) {
    const cap = clamp(limit, 1, 300, 30);
    const matched = this.pages.filter((page) => !kind || page.kind === kind).reverse();
    return { total: matched.length, truncated: matched.length > cap, reports: matched.slice(0, cap) };
  }

  /**
   * What happened since `cursor`: new or changed traces, new logs, new page
   * reports. Asked with no cursor, the cursor to tail from and a count of
   * what is held — not the whole memory, which ran to tens of kilobytes.
   */
  tail(cursor?: number, limit?: number) {
    if (cursor === undefined) {
      return {
        cursor: this.seq,
        held: { traces: this.traces.size, logs: this.logs.length, pages: this.pages.length },
        next: 'Call again with this cursor after the next reload or request; cursor 0 reads the recent past.',
      };
    }
    const cap = clamp(limit, 1, 200, 50);
    const traces = [...this.traces.values()].filter((trace) => trace.seq > cursor).sort((a, b) => a.seq - b.seq);
    const logs = this.logs.filter((line) => line.seq > cursor);
    const pages = this.pages.filter((page) => page.seq > cursor);
    return {
      cursor: this.seq,
      traces: traces.slice(-cap).map((trace) => this.summary(trace)),
      tracesTruncated: traces.length > cap,
      logs: logs.slice(-cap),
      logsTruncated: logs.length > cap,
      pages: pages.slice(-cap),
    };
  }

  /** The span a statement ran as, for EXPLAIN: only statements this store still holds. */
  hasStatement(spanId: string): boolean {
    for (const trace of this.traces.values()) if (trace.spans.get(spanId)?.attributes['db.system.name']) return true;
    return false;
  }

  clear(): void {
    this.traces.clear();
    this.logs.length = 0;
    this.pages.length = 0;
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100;
const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
