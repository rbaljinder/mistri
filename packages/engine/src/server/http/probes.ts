/**
 * `/healthz` and `/readyz`, for an orchestrator.
 *
 * `/healthz` is liveness: the process answers HTTP. `/readyz` is readiness:
 * it should be sent traffic now — false while it starts, while a row policy
 * restarts after a save, and from the moment it begins shutting down, so a
 * load balancer stops sending before the listener closes. Both are answered
 * before any gate or App, carry nothing but their word, are never cached and
 * are not traced (a heartbeat every few seconds is not a trace).
 *
 * The operator reads with more in them (`/api/operations/readiness`) are
 * signed-in and granted; these are not, and so say nothing else.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function probe(req: IncomingMessage, res: ServerResponse, path: string, ready?: () => boolean): boolean {
  if (path !== '/healthz' && path !== '/readyz') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
    return true;
  }
  let ok = true;
  if (path === '/readyz') {
    try {
      ok = ready?.() ?? true;
    } catch {
      ok = false;
    }
  }
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: ok ? 'ok' : 'unavailable' }));
  return true;
}
