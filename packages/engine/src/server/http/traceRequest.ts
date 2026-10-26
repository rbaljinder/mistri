/**
 * The span of one HTTP request, as the semantic conventions name it:
 * `GET /api/query`, kind server, with the method, the route template and the
 * status. The route is a template the server declares, never the path the
 * browser sent: a tablewalk path can carry a whole query (`/demo/invoice
 * total > 500`), a record id or a public slug.
 *
 * An incoming W3C `traceparent` makes the request a child of its caller's
 * trace. For the dev observer (and only then) the raw exchange is kept as
 * local detail: the path, the headers, and the bodies both ways, bounded.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { observing, parseTraceparent, startSpan, tracing, withSpan, type Span } from '../../adapters/telemetry/trace.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/* Every fixed API path the servers answer, as themselves. Anything else under
   /api/ keeps only word-like leading segments: a key never becomes a label. */
const API = new Set([
  '/api/connections',
  '/api/connections/test',
  '/api/connections/demo',
  '/api/connections/update',
  '/api/connections/remove',
  '/api/connections/save',
  '/api/connections/select',
  '/api/connections/refresh',
  '/api/whoami',
  '/api/app',
  '/api/app/live',
  '/api/schema',
  '/api/ddl',
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
  '/api/agent/tools',
  '/api/agent/call',
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
  '/api/pages/load',
  '/api/http/operations',
  '/api/http/operation',
  '/api/update',
  '/api/insert',
  '/api/delete',
  '/api/revert',
  '/api/sql',
  '/api/commands/execute',
  '/api/commands/status',
  '/api/commands/prepare',
  '/api/commands/availability',
  '/api/import',
  '/api/file/upload',
  '/api/record',
  '/api/history',
  '/api/inbox',
  '/api/operations/readiness',
  '/api/operations/support',
]);

/** The route template a path is reported under. */
function routeTemplate(path: string): string {
  if (API.has(path)) return path;
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return '/api/auth/*';
  if (path.startsWith('/api/')) {
    const words = path
      .split('/')
      .slice(2, 4)
      .filter((segment) => /^[a-z][a-z_-]{0,31}$/.test(segment));
    return `/api/${words.length ? `${words.join('/')}/` : ''}*`;
  }
  if (path === '/healthz' || path === '/readyz') return path;
  if (path.startsWith('/_mistri/')) return '/_mistri/*';
  // A file: the client's modules and assets, Vite's own paths in dev.
  if (/\.[a-z0-9]{1,8}$/i.test(path) || path.startsWith('/@') || path.startsWith('/node_modules/')) return '/{asset}';
  return '/{page}';
}

/** Local detail is capped per body: enough to read a command's input, never a whole export. */
const BODY_CAP = 64 * 1024;

/** Keep what a request sent and was sent back, for the dev observer. */
function keepExchange(req: IncomingMessage, res: ServerResponse, span: Span) {
  const sent: Buffer[] = [];
  let sentSize = 0;
  const push = req.push;
  // The parser hands the body to `push`, whoever reads it and however: tapping here never changes how it flows.
  req.push = function (chunk: unknown, encoding?: BufferEncoding) {
    if (chunk && sentSize < BODY_CAP) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
      sent.push(buffer.subarray(0, BODY_CAP - sentSize));
      sentSize += buffer.length;
    }
    return push.call(this, chunk, encoding);
  };
  const answered: Buffer[] = [];
  let answeredSize = 0;
  const keep = (chunk: unknown, encoding?: unknown) => {
    if (!chunk || typeof chunk === 'function' || answeredSize >= BODY_CAP) return;
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk), typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
    answered.push(buffer.subarray(0, BODY_CAP - answeredSize));
    answeredSize += buffer.length;
  };
  const write = res.write,
    end = res.end;
  res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
    keep(chunk, rest[0]);
    return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof res.write;
  res.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
    keep(chunk, rest[0]);
    return (end as (...a: unknown[]) => ServerResponse).call(this, chunk, ...rest);
  } as typeof res.end;
  return () => {
    const type = String(res.getHeader('content-type') ?? '');
    const encoded = res.getHeader('content-encoding');
    const readable = /json|text|javascript|xml|form/i.test(type) && !encoded;
    span.detail(() => ({
      request: {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        ...(sentSize ? { body: Buffer.concat(sent).toString('utf8'), bodyBytes: sentSize, truncated: sentSize > BODY_CAP } : {}),
      },
      response: {
        status: res.statusCode,
        headers: res.getHeaders(),
        ...(answeredSize
          ? readable
            ? { body: Buffer.concat(answered).toString('utf8'), bodyBytes: answeredSize, truncated: answeredSize > BODY_CAP }
            : { bodyBytes: answeredSize, body: `(${encoded ? `${encoded}-encoded ` : ''}${type || 'untyped'} body not shown)` }
          : {}),
      },
    }));
  };
}

/** Run a request's handling inside its span, ended when the response closes. */
export function traceRequest(req: IncomingMessage, res: ServerResponse, handle: () => void): void {
  if (!tracing()) return handle();
  const method = METHODS.has(req.method ?? '') ? req.method! : '_OTHER';
  // Named for now as the browser spelled it; `routedPath` renames it once the address is read inward.
  const route = routeTemplate((req.url ?? '/').split('?')[0]);
  const span = startSpan(`${method} ${route}`, {
    kind: 'server',
    remote: parseTraceparent(req.headers.traceparent, req.headers.tracestate),
    attributes: { 'http.request.method': method, 'http.route': route, 'url.scheme': 'http', 'network.protocol.version': req.httpVersion },
  });
  requests.set(req, { span, method });
  const exchange = observing() ? keepExchange(req, res, span) : undefined;
  if (observing() && !res.headersSent) res.setHeader('x-mistri-trace', span.traceId);
  res.once('close', () => {
    const status = res.headersSent ? res.statusCode : undefined;
    if (status !== undefined) span.setAttribute('http.response.status_code', status);
    /* A request the browser gave up on — a navigation away, a superseded
       fetch — is not a failure of the server's: said as aborted, apart from errors. */
    if (status === undefined || !res.writableFinished) span.setAttribute('mistri.request.aborted', true);
    else if (status >= 500) span.fail(String(status));
    exchange?.();
    span.end();
  });
  withSpan(span, handle);
}

const requests = new WeakMap<IncomingMessage, { span: Span; method: string }>();
const VITE_PATH = /^\/(?:@vite\/|@react-refresh|@fs\/|@id\/|node_modules\/)/;

/** The App a request was served for, by its id: what the observer lists a request under. */
export function servedApp(req: IncomingMessage, appId: string | undefined): void {
  if (appId) requests.get(req)?.span.setAttribute('mistri.app.id', appId);
}

/**
 * The request's address as the routes read it — the base path off, an App
 * at the root read back to `/{app}/…` (shared/mount.ts) — names its span.
 * The observer's own requests and the orchestrator's probes are dropped here:
 * the first would observe itself, the second is a heartbeat every few seconds.
 */
export function routedPath(req: IncomingMessage, path: string | undefined): void {
  const traced = requests.get(req);
  if (!traced) return;
  if (path === undefined) {
    traced.span.rename(`${traced.method} /{unrouted}`);
    traced.span.setAttribute('http.route', '/{unrouted}');
    return;
  }
  if (path.startsWith('/_mistri/') || path === '/healthz' || path === '/readyz') {
    traced.span.discard();
    return;
  }
  /* Vite's own paths in dev (`/@vite/client`, `/@react-refresh`) are files
     as the browser asked for them, whatever an App at the root reads them as. */
  const route = VITE_PATH.test((req.url ?? '/').split('?')[0]) ? '/{asset}' : routeTemplate(path);
  traced.span.rename(`${traced.method} ${route}`);
  traced.span.setAttribute('http.route', route);
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Give a server built elsewhere (the tenant servers) what `createApp` gives
 * its own: a span per request, and the reserved addresses — the
 * orchestrator's probes and the dev observer — answered before its handler.
 * Wraps the handler already registered, so the server's own code is unchanged.
 */
export function platformRequests(
  server: import('node:http').Server,
  reserved: (req: IncomingMessage, res: ServerResponse) => boolean,
): void {
  const listeners = server.listeners('request') as RequestListener[];
  server.removeAllListeners('request');
  for (const listener of listeners) {
    server.on('request', (req: IncomingMessage, res: ServerResponse) =>
      traceRequest(req, res, () => {
        routedPath(req, (req.url ?? '/').split('?')[0]);
        if (!reserved(req, res)) listener.call(server, req, res);
      }),
    );
  }
}
