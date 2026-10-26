/**
 * Operator reads: readiness and the sanitized support bundle, for a verified
 * session whose roles say so.
 */
import { appEntrypoint } from '../app/appEntrypoint.js';
import { operationsHttpAction, operationsHttpReply, readOperationsHttp } from '../operations/operationsHttp.js';
import type { ReadinessCheckInput } from '../operations/operations.js';
import { capacityCheck, collectCapacity } from '../operations/capacity.js';
import { workflowOperationsReply, workflowOperationsRoute } from '../operations/workflowOperationsHttp.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';

export async function operationsRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, url, registry, policy, policyUnavailable, diagnostics, jobs, identity, signedIn } = ctx;

  /* Operator reads: readiness and the sanitized support bundle, for a verified
     session whose roles say so. Answered here, after the auth gate and before
     any data route, so the collector runs only for a granted actor and the
     reply is never cached. Standalone has no operator identity, so it has no
     route: an unauthenticated host says nothing about itself. */
  const workflowsRoute = workflowOperationsRoute(path);
  if (workflowsRoute) {
    res.setHeader('cache-control', 'no-store');
    if (!signedIn?.auth) {
      send(res, 404, { error: 'Operator reads are available only on an authenticated App host.' });
      return true;
    }
    if (!identity.id) {
      send(res, 401, { error: 'Sign in to continue.' });
      return true;
    }
    let body: Record<string, unknown> = {};
    // A write's body is read only once the route is one that takes it; the cross-origin gate has already run.
    if (req.method === 'POST' && (workflowsRoute === 'cancel' || workflowsRoute === 'retry')) {
      try {
        body = await readJson(req, 4_096);
      } catch (error) {
        if (error instanceof HttpError) {
          send(res, error.status, { ok: false, error: 'invalid_request' });
          return true;
        }
        throw error;
      }
    }
    const roles = (identity.role ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
    const reply = await workflowOperationsReply({
      app: signedIn.app.app,
      route: workflowsRoute,
      method: req.method ?? 'GET',
      actor: { id: identity.id, roles },
      operator: jobs?.workflows,
      query: url.searchParams,
      body,
    });
    send(res, reply.status, reply.body);
    return true;
  }

  const operationsAction = operationsHttpAction(path);
  if (operationsAction) {
    res.setHeader('cache-control', 'no-store');
    if (!signedIn?.auth) {
      send(res, 404, { error: 'Operator reads are available only on an authenticated App host.' });
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (!identity.id) {
      send(res, 401, { error: 'Sign in to continue.' });
      return true;
    }
    const roles = (identity.role ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
    const collect = () => {
      const snapshot = diagnostics?.snapshot();
      // Read per operator request, never per business request.
      const capacity = collectCapacity(registry);
      const pools = capacityCheck(capacity);
      const checks: ReadinessCheckInput[] = [
        { name: 'listener', state: 'ready', code: 'ok' },
        appEntrypoint(signedIn, registry)
          ? { name: 'sources', state: 'ready', code: 'ok' }
          : { name: 'sources', state: 'not_ready', code: 'connection_unavailable' },
        ...(policy || policyUnavailable
          ? [
              policyUnavailable
                ? { name: 'policy', state: 'not_ready' as const, code: 'configuration_invalid' as const }
                : { name: 'policy', state: 'ready' as const, code: 'ok' as const },
            ]
          : []),
        ...(snapshot
          ? [
              snapshot.health.failed || snapshot.health.droppedTotal > 0
                ? { name: 'diagnostics', state: 'degraded' as const, code: 'diagnostics_degraded' as const }
                : { name: 'diagnostics', state: 'ready' as const, code: 'ok' as const },
            ]
          : []),
        // Degraded while a database pool is saturated; absent until one is open.
        ...(pools ? [pools] : []),
        // The job host's `jobs` and `events.delivery` checks, from its last snapshot.
        ...(jobs?.readiness() ?? []),
      ];
      return {
        checks,
        capacity,
        ...(snapshot
          ? {
              metrics: {
                started: snapshot.started,
                completed: snapshot.completed,
                aborted: snapshot.aborted,
                inFlight: snapshot.inFlight,
                durationBoundsMs: snapshot.durationBoundsMs,
                series: snapshot.series,
              },
            }
          : {}),
      };
    };
    const reply = operationsHttpReply(
      await readOperationsHttp({ app: signedIn.app.app, action: operationsAction, actor: { id: identity.id, roles }, collect }),
    );
    send(res, reply.status, reply.body);
    return true;
  }

  return false;
}
