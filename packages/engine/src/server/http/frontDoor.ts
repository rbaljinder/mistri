/**
 * The one place an HTTP server is made. Every listener that takes a person's
 * request (the single-App server, the tenant servers and the suite) is
 * `frontDoor(options, handle)`, so what no surface may forget is done here
 * once, before its handler reads anything:
 *
 *   - the request waits in a pool's line as its client's, read through the
 *     proxies this server trusts (poolAdmission.ts, trust.ts `forwardedClient`);
 *   - the baseline headers (baselineHeaders.ts), set before anything is routed
 *     so a reply that names its own still wins;
 *   - the guard (`guard`), the surface's first refusal: a Host it does not
 *     serve (trust.ts `hostRefusal`, `doorRefusal`), or a stop in progress.
 *     It runs after the headers, so a refusal carries them as an answer does.
 *
 * A surface's own refusals, in the shapes its callers read, stay in the
 * surface; what they have in common is the part here. A `createServer` call
 * anywhere else in a package's source is refused by
 * `test/front-door-structure.test.ts`, which names the few that are not a door.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { withAdmission } from '../../adapters/poolAdmission.js';
import { setBaselineHeaders } from './baselineHeaders.js';
import { forwardedClient, type ProxyRange } from './trust.js';

interface FrontDoorOptions {
  /** The proxies whose forwarded address and protocol are read; read per request, so a late binding is seen. */
  readonly trustedProxies?: readonly ProxyRange[] | (() => readonly ProxyRange[] | undefined);
  /** False for a server nobody queues at, whose callers a front has already admitted; default true. */
  readonly admit?: boolean;
  /** Seen first, after admission: the operator's meters (operations/diagnostics.ts). */
  readonly diagnostics?: { observe(req: IncomingMessage, res: ServerResponse): void };
  /**
   * Outermost, around admission: the request's span (traceRequest.ts) covers
   * the line it waits in. Call `run` once.
   */
  readonly around?: (req: IncomingMessage, res: ServerResponse, run: () => void) => void;
  /** The first refusal: true when it answered, and nothing further is read. */
  readonly guard?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

/** The server, made but not listening. */
export function frontDoor(options: FrontDoorOptions, handle: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const proxies = () => (typeof options.trustedProxies === 'function' ? options.trustedProxies() : options.trustedProxies) ?? [];
  const through = (req: IncomingMessage, res: ServerResponse) => {
    options.diagnostics?.observe(req, res);
    setBaselineHeaders(req, res, proxies());
    if (options.guard?.(req, res)) return;
    handle(req, res);
  };
  const admitted = (req: IncomingMessage, res: ServerResponse) =>
    options.admit === false ? through(req, res) : withAdmission(forwardedClient(req, proxies()), () => through(req, res));
  return createServer((req, res) => (options.around ? options.around(req, res, () => admitted(req, res)) : admitted(req, res)));
}
