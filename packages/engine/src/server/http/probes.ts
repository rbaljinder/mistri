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
 * Both answer `{ deploy, build }` beside the status (`mistri deploy` verifies a
 * roll by them): `deploy` is MISTRI_DEPLOY_ID, which the platform's Worker sets
 * in the container's environment on each deploy, and `build` is the id of the
 * build being served. Both are random or a hash, so safe to expose.
 *
 * While a tenant server is still opening its tenants, `/readyz` also says how far
 * it has got (`ready`, `opened`, `of`), and afterward which tenant keys failed to
 * open: counts and keys only, never an error.
 *
 * The operator reads with more in them (`/api/operations/readiness`) are
 * signed-in and granted; these are not, and so say nothing else.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

let buildSource: () => string | null = () => null;

/** Where `/readyz` reads the served build's id from; the App framework registers it when it serves a build. */
export function setBuildIdSource(source: () => string | null): void {
  buildSource = source;
}

/** What a readiness check may say beside yes or no: words for the body (how far a start has got, what failed to open). */
export type ReadyAnswer = boolean | { readonly ok: boolean; readonly body?: Readonly<Record<string, unknown>> };

export function probe(req: IncomingMessage, res: ServerResponse, path: string, ready?: () => ReadyAnswer): boolean {
  if (path !== '/healthz' && path !== '/readyz') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
    return true;
  }
  let ok = true;
  let extra: Readonly<Record<string, unknown>> = {};
  if (path === '/readyz') {
    try {
      const answer = ready?.() ?? true;
      ok = typeof answer === 'boolean' ? answer : answer.ok;
      if (typeof answer === 'object' && answer.body) extra = answer.body;
    } catch {
      ok = false;
    }
  }
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    req.method === 'HEAD'
      ? undefined
      : JSON.stringify({ status: ok ? 'ok' : 'unavailable', deploy: process.env.MISTRI_DEPLOY_ID || null, build: buildSource(), ...extra }),
  );
  return true;
}
