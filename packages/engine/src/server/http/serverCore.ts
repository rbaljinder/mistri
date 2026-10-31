/**
 * The HTTP server every product's dispatcher listens on: a `node:http`
 * server with the request's span, the baseline headers, the address read
 * through the mounts, the orchestrator's probes, and the error-to-status
 * mapping the tests pin — and, in the middle, the product's own answer
 * (`Answering`). The database browser's server (browserServer.ts) and the
 * App framework's (server.ts) are each this, with what their product adds.
 *
 * Kept whole rather than rebuilt per product, for the reason `createApp`
 * was pulled out of `main` in the first place: a wiring a product wrote for
 * itself would be the one its tests prove, and the shared parts — what a
 * malformed target is answered with, what an error's status is, which
 * requests a close waits for — would agree only by convention.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SOURCE_CLIENT, attachDevClient } from '../devclient.js';
import { applyServerTimeouts } from '../serverTimeouts.js';
import { Refusal, WriteConflict } from '../../adapters/adapter.js';
import { HttpSourceError } from '../../adapters/http/egress.js';
import { isPoolBusy } from '../../adapters/poolMetrics.js';
import { withAdmission } from '../../adapters/poolAdmission.js';
import { AppAccessDenied } from '../columnGrants.js';
import { wrongTypeValue } from '../constraints.js';
import type { RequestDiagnostics } from '../operations/diagnostics.js';
import { PathError } from '../../shared/view.js';
import { inward, type AddressMount } from '../../shared/mount.js';
import { arrivedUrls } from './context.js';
import { probe } from './probes.js';
import { reportRefusal } from './refusalReport.js';
import { HttpError, send, sendBusy } from './reply.js';
import { routedPath, servedApp, traceRequest } from './traceRequest.js';
import { setBaselineHeaders } from './baselineHeaders.js';
import { forwardedClient, type Bound } from './trust.js';
import { timeRequests } from '../../adapters/telemetry/serverTiming.js';

/* From source, Vite's modules are addressed from the root whatever the base
   (devclient.ts): its own paths and the client's files, never a page, the
   API or the host modules. */
const devModule = (path: string) =>
  !/^\/(?:api|_mistri)(?:\/|$)/.test(path) && (/^\/(?:@|node_modules\/)/.test(path) || /\.[A-Za-z0-9]+$/.test(path));

/**
 * The request read through the server's mounts (shared/mount.ts): the base
 * path taken off `req.url`, which the static files, the App API and Better
 * Auth read, and the address turned to its inside form on `url`, which every
 * route reads. False when it was answered: an address outside the base, or
 * an App's id where it is mounted under another name, names nothing.
 */
export function routeAddress(req: IncomingMessage, res: ServerResponse, url: URL, mount: AddressMount): boolean {
  if (mount.base) {
    const under = url.pathname === mount.base || url.pathname.startsWith(`${mount.base}/`);
    if (!under) {
      if (SOURCE_CLIENT && devModule(url.pathname)) return true;
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        .end(`Not found: this server is served under ${mount.base}.\n`);
      return false;
    }
    arrivedUrls.set(req, req.url ?? '/');
    req.url = (url.pathname.slice(mount.base.length) || '/') + url.search;
  }
  const inside = inward(mount, url.pathname);
  if (inside === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not found.\n');
    return false;
  }
  url.pathname = inside;
  return true;
}

/** The requests a server is still answering that its close waits for (`Answering.drains`). */
export const commandOperations = new WeakMap<Server, Set<Promise<void>>>();

/** What every server is given, whatever its product: where it listens, and the operator's meters. */
export interface Listening {
  /**
   * Read on every request instead of copied, so a caller listening on port 0
   * can fill the port in once the kernel has chosen one. That matters because
   * `doorRefusal` compares the `Host` header against it, and a bound record
   * that disagrees with the socket refuses every write.
   */
  readonly bound: Bound;
  readonly diagnostics?: RequestDiagnostics;
  /** Whether the server should take traffic now: false while it starts, reloads its policy or shuts down (`/readyz`). */
  readonly ready?: () => boolean;
  /** A suite owns the source client and HMR at its shared listener. */
  readonly sourceClient?: false;
  /** A suite must drain even disconnected form submissions before closing its App registry. */
  readonly drainRequests?: true;
}

/** A product's part of the server: its addresses, its answer, and the failures it says in its own words. */
export interface Answering {
  /** Where requests are served (shared/mount.ts), read per request. */
  mount(): AddressMount;
  /** Before the base path is read: a document whose address follows the origin, not the base. True when answered. */
  outside?(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  /** Which App the request is for, as far as its address says, for its span. */
  served?(url: URL): string | undefined;
  /** After the probes and before any door: what no product's door holds. True when answered. */
  ahead?(req: IncomingMessage, res: ServerResponse, url: URL, mount: AddressMount): boolean;
  /** The request itself. */
  answer(req: IncomingMessage, res: ServerResponse, url: URL, mount: AddressMount): Promise<void>;
  /** A failure the product answers in a shape of its own (a command's outcome). True when answered; asked first. */
  failed?(error: Error, req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  /** The status of a failure the engine has no status for, where the product has one. */
  status?(error: Error): number | undefined;
  /** A failure's body in the product's own words (an App's, which never says a driver's). True when answered. */
  said?(error: Error, req: IncomingMessage, res: ServerResponse, status: number): boolean;
  /** Whether a close waits for this request's answer. */
  drains?(url: URL): boolean;
}

/**
 * A failure's status. A path that does not resolve is the caller's mistake,
 * not the server's, and a 500 would have the client report it as an outage
 * rather than as the typo it is. Same for anything that named its own status
 * on the way up.
 */
function statusOf(err: Error, answering: Answering): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof AppAccessDenied) return 403;
  const own = answering.status?.(err);
  if (own !== undefined) return own;
  if (err instanceof WriteConflict) return 409;
  /* A path that does not resolve, an adapter that will not carry out the
     request and a value its column cannot hold (words searched in a number)
     are all the caller's mistake, and a 500 tells them to go and look at the
     server. */
  if (err instanceof PathError || err instanceof Refusal || wrongTypeValue(err)) return 400;
  // An API behind an HTTP connection failed; this server did not.
  if (err instanceof HttpSourceError) return 502;
  return 500;
}

/** The server, wired but not listening. */
export function listen(options: Listening, answering: Answering): Server {
  const pending = new Set<Promise<void>>();
  /* The span of each request (traceRequest.ts) names its route from the
     address after routeAddress has read it inward, never as the browser
     spelled it: under a base path or a root mount it is the same route. */
  const server = createServer((req, res) =>
    /* Its pool checkouts wait in line as its client's until its session names
       the account (adapters/poolAdmission.ts, http/door.ts). */
    traceRequest(req, res, () =>
      withAdmission(forwardedClient(req, options.bound.trustedProxies), () => {
        options.diagnostics?.observe(req, res);
        setBaselineHeaders(req, res, options.bound.trustedProxies);
        // Node accepts request targets that URL cannot parse. Refuse them before
        // dispatch, and reuse this parse in error mapping and drain tracking too.
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://localhost');
        } catch {
          return send(res, 400, { error: 'Invalid request target.' });
        }
        const mount = answering.mount();
        if (answering.outside?.(req, res, url)) return routedPath(req, url.pathname);
        // An address outside the base, or an App's id where it is not mounted, names no route: its span says so.
        if (!routeAddress(req, res, url, mount)) return routedPath(req, undefined);
        routedPath(req, url.pathname);
        if (answering.served) servedApp(req, answering.served(url));
        // The orchestrator's probes, before any door: they are no product's.
        if (probe(req, res, url.pathname, options.ready) || answering.ahead?.(req, res, url, mount)) return;
        const operation = answering.answer(req, res, url, mount).catch((err: Error) => {
          if (answering.failed?.(err, req, res, url)) return;
          /* The client left: its request was cut off mid-body, or it closed the
         socket before the answer, and what failed was the read it no longer
         waits for. Nobody can be answered and nothing went wrong on this
         side, so it is not a 500 on the operator's terminal: the request's
         span still says it was aborted (traceRequest.ts). */
          if (clientLeft(req, res, err)) {
            res.destroy();
            return;
          }
          /* The pool had no connection to give within its budget: the server is
         busy, which is neither the caller's mistake nor a failure, and a 500
         after ten seconds said both. Answered now, with when to come back. */
          if (isPoolBusy(err) && !res.headersSent) {
            reportRefusal(req, 503, 'server_busy', err.message, err);
            return sendBusy(res, {}, false, err);
          }
          const status = statusOf(err, answering);
          if (answering.said?.(err, req, res, status)) return;
          reportRefusal(req, status, undefined, err.message, err);
          send(res, status, { error: err.message });
        });
        if (options.drainRequests || answering.drains?.(url)) {
          pending.add(operation);
          void operation.finally(() => pending.delete(operation));
        }
      }),
    ),
  );
  commandOperations.set(server, pending);
  if (SOURCE_CLIENT && options.sourceClient !== false) attachDevClient(server);
  /* Explicit, rather than Node's defaults; serverTimeouts.ts says why. */
  /* Outermost, so a request's timing covers every listener above (serverTiming.ts); nothing when off. */
  timeRequests(server);
  applyServerTimeouts(server);
  return server;
}

/** Whether a request failed only because its client went away. */
function clientLeft(req: IncomingMessage, res: ServerResponse, error: unknown): boolean {
  if (res.headersSent) return false;
  const gone = req.destroyed || res.destroyed || res.writableEnded;
  const code = (error as { code?: unknown } | null)?.code;
  const stopped =
    error instanceof Error &&
    (error.name === 'StatementStopped' || error.name === 'AbortError' || (error.message === 'aborted' && code === 'ECONNRESET'));
  return gone && (stopped || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE');
}
