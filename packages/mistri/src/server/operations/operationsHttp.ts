/**
 * Operator reads over the authenticated App host.
 *
 * Two GET routes, `/api/operations/readiness` and `/api/operations/support`,
 * answer only for a verified session whose server roles carry the matching
 * `access.roles.<role>.operations` grant. Authentication stays with the host's
 * existing gate; this module turns a verified actor into a short-lived,
 * request-bound grant for the protected adapter, hands the read to the
 * headless contract, and maps its bounded result onto HTTP. Nothing here
 * creates authority, keeps state between requests, or echoes who asked.
 */
import { appOperationsGrants, homeSourceOf, type AppDef } from '../../shared/app.js';
import { createOperationsAdapter, type OperationsCollectedState } from './operationsAdapter.js';
import { createHeadlessOperationsReader, type HeadlessOperationsAction, type HeadlessOperationsReadResult } from './operationsHeadless.js';

const OPERATIONS_HTTP_PATHS: Readonly<Record<string, HeadlessOperationsAction>> = Object.freeze({
  '/api/operations/readiness': 'readiness',
  '/api/operations/support': 'support',
});

export function operationsHttpAction(path: string): HeadlessOperationsAction | undefined {
  return Object.hasOwn(OPERATIONS_HTTP_PATHS, path) ? OPERATIONS_HTTP_PATHS[path] : undefined;
}

/** The verified actor, as the host's auth gate established it for this request. */
interface OperationsHttpActor {
  readonly id: string;
  readonly roles: readonly string[];
}

/** A grant lives for one request; a slow collector cannot stretch it into a session. */
const GRANT_TTL_MS = 5_000;

const SOURCE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The adapter's named source: the App's own source when it has named ones, else the App id. */
export function operationsSourceId(app: AppDef): string | undefined {
  const candidate = homeSourceOf(app) ?? app.id;
  return typeof candidate === 'string' && candidate.length <= 64 && SOURCE_ID.test(candidate) ? candidate : undefined;
}

/**
 * Perform one operator read for one verified actor. The collector runs only
 * after the grant is established, so an unauthorized request costs nothing
 * and observes nothing.
 */
export async function readOperationsHttp(options: {
  readonly app: AppDef;
  readonly action: HeadlessOperationsAction;
  readonly actor: OperationsHttpActor;
  readonly collect: () => OperationsCollectedState | Promise<OperationsCollectedState>;
  readonly now?: () => number;
}): Promise<HeadlessOperationsReadResult> {
  const sourceId = operationsSourceId(options.app);
  if (!sourceId) return Object.freeze({ ok: false as const, cacheControl: 'no-store' as const, error: 'unavailable' as const });
  const clock = options.now ?? Date.now;
  const granted = appOperationsGrants(options.app, options.actor.roles);
  const adapter = createOperationsAdapter({
    scope: 'app',
    sourceId,
    now: clock,
    authorize: (request) =>
      request.caller.id === options.actor.id && granted.has(request.action)
        ? { audience: 'mistri.operations', action: request.action, scope: 'app', sourceId, expiresAt: clock() + GRANT_TTL_MS }
        : null,
    collect: () => options.collect(),
  });
  return createHeadlessOperationsReader(adapter).read({
    action: options.action,
    caller: { kind: 'app', id: options.actor.id, sourceId },
  });
}

const STATUS: Readonly<Record<'invalid_request' | 'not_authorized' | 'unavailable', number>> = Object.freeze({
  invalid_request: 400,
  not_authorized: 403,
  unavailable: 503,
});

/**
 * The bounded result as a status and body for the host's own writer. The body
 * never carries the caller, the source name or a failure's cause beyond its
 * code; the host sends it with `Cache-Control: no-store`.
 */
export function operationsHttpReply(result: HeadlessOperationsReadResult): { status: number; body: Record<string, unknown> } {
  return result.ok
    ? { status: 200, body: { ok: true, action: result.action, scope: result.scope, value: result.value } }
    : { status: STATUS[result.error], body: { ok: false, error: result.error } };
}
