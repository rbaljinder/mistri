import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { POOL_DURATION_BOUNDS_MS } from '../../adapters/poolMetrics.js';
import type { ConnectionPoolStats } from '../connections.js';
import { RequestMetrics, type RequestMetricsSnapshot } from './requestMetrics.js';

/** One open database pool's meters (poolMetrics.ts), by its connection's
 * position in the configuration: never a name, URL or database. */
export interface CapacityPool {
  readonly position: number;
  readonly dialect: string;
  readonly role: string;
  /** Which of the connection's replicas, from 1, for a replica's readers. */
  readonly replica?: number;
  readonly pooler: string;
  readonly size: number;
  readonly open: number | null;
  readonly inUse: number;
  readonly waiting: number;
  readonly saturated: boolean;
  readonly checkouts: number;
  readonly queued: number;
  readonly timedOut: number;
  readonly failed: number;
  readonly waitBuckets: readonly number[];
  readonly holdBuckets: readonly number[];
}

/** What separates "add pods" from "raise the pool" from "the database is
 * slow": the event loop's cumulative busy and idle time, and every open pool. */
export interface CapacitySnapshot {
  readonly eventLoop: Readonly<{ activeMs: number; idleMs: number }>;
  readonly durationBoundsMs: readonly number[];
  readonly pools: readonly CapacityPool[];
}

/** The registry's pools and this process's event loop, now. Cumulative
 * since start: compare two snapshots for an interval, as with the HTTP metrics. */
export function collectCapacity(source: { poolStats(): readonly ConnectionPoolStats[] }): CapacitySnapshot {
  const loop = performance.eventLoopUtilization();
  return Object.freeze({
    eventLoop: Object.freeze({ activeMs: Math.round(loop.active), idleMs: Math.round(loop.idle) }),
    durationBoundsMs: POOL_DURATION_BOUNDS_MS,
    pools: Object.freeze([...source.poolStats()]),
  });
}

/* These labels are declared here, never copied from a request. App URLs can
   contain whole database queries, and even an unknown API path can be a secret. */
const ROUTE_GROUPS: [string, string[]][] = [
  [
    'connections',
    [
      '/api/connections',
      '/api/connections/test',
      '/api/connections/demo',
      '/api/connections/update',
      '/api/connections/remove',
      '/api/connections/save',
      '/api/connections/select',
      '/api/connections/refresh',
    ],
  ],
  ['identity', ['/api/whoami']],
  ['app', ['/api/app']],
  ['schema', ['/api/schema', '/api/ddl']],
  [
    'definitions',
    [
      '/api/views',
      '/api/queries',
      '/api/layouts',
      '/api/pages',
      '/api/pages/relations',
      '/api/pages/suggested',
      '/api/pages/saved',
      '/api/pages/save',
      '/api/filters',
      '/api/filters/save',
    ],
  ],
  ['agent', ['/api/agent/tools', '/api/agent/call']],
  [
    'query',
    [
      '/api/query',
      '/api/run',
      '/api/breakdown',
      '/api/breakdowns',
      '/api/view/run',
      '/api/view/compile',
      '/api/count',
      '/api/counts',
      '/api/export',
      '/api/references',
      '/api/pages/plan',
      '/api/pages/compose',
      '/api/http/operations',
      '/api/http/operation',
    ],
  ],
  ['update', ['/api/update']],
  ['insert', ['/api/insert']],
  ['delete', ['/api/delete']],
  ['revert', ['/api/revert']],
  ['sql', ['/api/sql']],
];
const ROUTES = new Map(ROUTE_GROUPS.flatMap(([label, paths]) => paths.map((path) => [path, `api.${label}`])));
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CAPACITY = 64;

export interface RequestDiagnostic {
  event: 'http.request';
  timestamp: string;
  requestId: string;
  method: string;
  route: string;
  status: number | null;
  durationMs: number;
  outcome: 'completed' | 'aborted';
  droppedTotal: number;
}

export interface RequestMetricsDiagnostic extends RequestMetricsSnapshot {
  readonly event: 'http.metrics';
  readonly version: 1;
  /** The pools and event loop at the moment the summary was taken, once a host attaches them. */
  readonly capacity?: CapacitySnapshot;
  readonly health: Readonly<{
    droppedTotal: number;
    failed: boolean;
    queuedRecords: number;
    writingRecord: boolean;
    writingSummary: boolean;
    summaryPending: boolean;
    summaryDroppedTotal: number;
  }>;
}

function routeFor(url: string | undefined): string {
  try {
    const path = new URL(url ?? '/', 'http://localhost').pathname;
    if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'api.auth';
    return ROUTES.get(path) ?? (path.startsWith('/api/') ? 'api.other' : 'web');
  } catch {
    return 'unknown';
  }
}

/** Local, best-effort HTTP diagnostics, separate from the business journal.
 * The caller owns the stream. No request waits for it, and only one bounded
 * record is handed to it at a time. A failed stream disables further output. */
export class RequestDiagnostics {
  private readonly queue: Omit<RequestDiagnostic, 'droppedTotal'>[] = [];
  private scheduled = false;
  private writing: 'request' | 'summary' | undefined;
  private failed = false;
  private dropped = 0;
  private readonly metrics = new RequestMetrics();
  private summaryPending = false;
  private summaryRevision: string | undefined;
  private summaryDropped = 0;
  private flushPromise: Promise<boolean> | undefined;
  private flushDone: (() => void) | undefined;
  private capacity: (() => CapacitySnapshot) | undefined;

  constructor(private readonly output: Writable) {
    output.on('error', this.fail);
  }

  get droppedTotal(): number {
    return this.dropped;
  }

  /** Carry the host's capacity (its pools and event loop) in every summary
   * from now on. Read when the summary is taken, never per request. */
  watchCapacity(read: () => CapacitySnapshot): void {
    this.capacity = read;
  }

  snapshot(): RequestMetricsDiagnostic {
    let capacity: CapacitySnapshot | undefined;
    // Instrumentation must not become a new failure path: a capacity that cannot be read is left out.
    try {
      capacity = this.capacity?.();
    } catch {
      capacity = undefined;
    }
    return Object.freeze({
      event: 'http.metrics',
      version: 1,
      ...this.metrics.snapshot(),
      ...(capacity ? { capacity } : {}),
      health: Object.freeze({
        droppedTotal: this.dropped,
        failed: this.failed,
        queuedRecords: this.queue.length,
        writingRecord: this.writing === 'request',
        writingSummary: this.writing === 'summary',
        summaryPending: this.summaryPending,
        summaryDroppedTotal: this.summaryDropped,
      }),
    });
  }

  private get revision(): string {
    return `${this.metrics.revision}:${this.dropped}`;
  }

  observe(req: IncomingMessage, res: ServerResponse): void {
    try {
      const requestId = randomUUID();
      const method = METHODS.has(req.method ?? '') ? req.method! : 'OTHER';
      const route = routeFor(req.url);
      const started = performance.now();
      res.setHeader('x-request-id', requestId);
      const recordMetrics = this.metrics.begin(method, route);
      let recorded = false;
      const complete = (outcome: RequestDiagnostic['outcome']) => {
        if (recorded) return;
        recorded = true;
        res.removeListener('finish', finished);
        res.removeListener('close', closed);
        const status = res.headersSent ? res.statusCode : null;
        const elapsedMs = Math.max(0, performance.now() - started);
        const durationMs = Math.round(elapsedMs * 100) / 100;
        recordMetrics(status, elapsedMs, outcome);
        this.enqueue({
          event: 'http.request',
          timestamp: new Date().toISOString(),
          requestId,
          method,
          route,
          status,
          durationMs,
          outcome,
        });
      };
      const finished = () => complete('completed');
      const closed = () => complete(res.writableFinished ? 'completed' : 'aborted');
      res.once('finish', finished);
      res.once('close', closed);
    } catch {
      // Instrumentation must not become a new request failure path.
      this.dropped += 1;
    }
  }

  /** A bounded shutdown opportunity, not a delivery guarantee. Does not end
   * stderr (or a caller's stream), and never participates in a business write. */
  flush(timeoutMs = 250): Promise<boolean> {
    if (this.failed) return Promise.resolve(false);
    if (this.summaryRevision !== this.revision) this.summaryPending = true;
    this.schedule();
    if (this.flushPromise) return this.flushPromise;
    if (!this.writing && !this.queue.length && !this.summaryPending) return Promise.resolve(true);
    this.flushPromise = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.flushDone = undefined;
        this.flushPromise = undefined;
        resolve(!this.failed);
      };
      const timer = setTimeout(
        () => {
          this.flushDone = undefined;
          this.flushPromise = undefined;
          resolve(false);
        },
        Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 1_000)) : 250,
      );
      this.flushDone = done;
    });
    return this.flushPromise;
  }

  private enqueue(event: Omit<RequestDiagnostic, 'droppedTotal'>): void {
    if (this.failed || this.queue.length + Number(this.writing === 'request') >= CAPACITY) {
      this.dropped += 1;
      return;
    }
    this.queue.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.writing || this.failed || (!this.queue.length && !this.summaryPending)) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.failed) return;
      const request = this.queue.shift();
      let event: RequestDiagnostic | RequestMetricsDiagnostic;
      if (request) {
        event = { ...request, droppedTotal: this.dropped };
        this.writing = 'request';
      } else if (this.summaryPending && this.summaryRevision !== this.revision) {
        this.summaryPending = false;
        event = this.snapshot();
        this.summaryRevision = this.revision;
        this.writing = 'summary';
      } else {
        this.summaryPending = false;
        this.notifyIdle();
        return;
      }
      try {
        this.output.write(`${JSON.stringify(event)}\n`, (error) => {
          if (error) {
            this.fail();
            return;
          }
          if (this.failed) return;
          this.writing = undefined;
          this.schedule();
          this.notifyIdle();
        });
      } catch {
        this.fail();
      }
    });
  }

  private readonly fail = (): void => {
    if (this.failed) return;
    this.failed = true;
    this.dropped += this.queue.length + Number(this.writing === 'request');
    this.summaryDropped += Number(this.summaryPending) + Number(this.writing === 'summary');
    this.summaryPending = false;
    this.queue.length = 0;
    this.writing = undefined;
    this.notifyIdle();
  };

  private notifyIdle(): void {
    if (!this.writing && !this.queue.length && !this.summaryPending) this.flushDone?.();
  }
}

/** Only the exact explicit opt-in enables diagnostics. MCP never calls this. */
export function diagnosticsFromEnvironment(value: string | undefined, output: Writable = process.stderr): RequestDiagnostics | undefined {
  return value === '1' ? new RequestDiagnostics(output) : undefined;
}
