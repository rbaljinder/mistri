/** The PostgreSQL read transport, mounted by createApp under the explicit
 * `--api-reads` opt-in for an App on PostgreSQL: loopback, or beyond it for
 * an App that declares `api.network`. The SQLite read
 * transport's admission, routes, statuses and error bodies, over the
 * PostgreSQL read owner: the owner calls `send` inside its native token
 * handoff, so the socket write happens after the final authorization and
 * while the token's native locks are still held — never from a buffered
 * result later. Cookies and proxy roles never authenticate this namespace. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProxy } from 'node:util/types';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { withoutCancellation } from '@mistriwork/engine/adapters/statementControl.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { readApiBearerHeader } from './apiBearerHeader.js';
import { bearerChallenge, presentsAuthorization } from '../auth/oauthResource.js';
import { parseApiReadRoute } from './apiReadRoute.js';
import { createPostgresApiReadOwner } from './postgresApiReadOwner.js';
import {
  admitApiRequest,
  apiAdmission,
  ApiAdmission,
  apiTransportBound,
  API_PENDING_LIMIT,
  claimsApiNamespace,
  presentsCredential,
} from './apiHttpAdmission.js';
import type { ApiPublicSpec } from './apiPublicSpec.js';

type Send = (response: Readonly<{ status: number; body: string }>) => void;
/** An owner that hands its one answer over through `send`, after its own
 * final authorization: the PostgreSQL read owner, or a tenant App's owner. */
type HandoffReadOwner = {
  readSpec(credential: string, send: Send, signal: AbortSignal): Promise<unknown>;
  readList(credential: string, operationId: string, query: string, send: Send, signal: AbortSignal): Promise<unknown>;
  readItem(credential: string, operationId: string, key: string, send: Send, signal: AbortSignal): Promise<unknown>;
  /** The event feed and AsyncAPI document; an owner without them answers 404. */
  readEvents?(credential: string, query: string, send: Send, signal: AbortSignal): Promise<unknown>;
  readAsyncApi?(credential: string, send: Send, signal: AbortSignal): Promise<unknown>;
  retire(): Promise<unknown>;
};
function own(value: object, key: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new Error('API transport configuration is unavailable.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('API transport configuration is unavailable.');
  return descriptor.value;
}

type TransportOptions = {
  bound: Bound;
  integers: 'decimal-string' | 'number';
  requestsPerMinute: number;
  /** The App API's budgets, shared with the App's command transport when it has one. */
  admission?: ApiAdmission;
  /** The App's commands, whose declared events the feed and AsyncAPI document describe. */
  commands?: BusinessCommandRegistry;
  /** `api.publicSpec`: the whole document for a request that presents no credential. */
  publicSpec?: ApiPublicSpec;
};

export function createPostgresApiReadHttp(registry: Registry, host: AppHost, options: TransportOptions) {
  return createApiReadHandoffHttp(host, options, () => createPostgresApiReadOwner(registry, host, options.integers, options.commands));
}

/** The same transport over any owner that hands its answer over through
 * `send`: the tenant host mounts it over its deployment's own owner. */
export function createApiReadHandoffHttp<Owner extends HandoffReadOwner>(
  host: AppHost,
  options: TransportOptions,
  build: () => Promise<Owner>,
) {
  const loaded = own(host, 'app') as object,
    auth = own(host, 'auth');
  const app = captureTenantData(own(loaded, 'app')) as AppHost['app']['app'];
  const definition = JSON.stringify(app);
  if (
    !app?.api ||
    !['decimal-string', 'number'].includes(options.integers) ||
    !Number.isSafeInteger(options.requestsPerMinute) ||
    options.requestsPerMinute < 1 ||
    options.requestsPerMinute > 1000000
  )
    throw new Error('API transport configuration is unavailable.');
  const admission = options.admission ?? apiAdmission(options.requestsPerMinute);
  if (!(admission instanceof ApiAdmission) || isProxy(admission) || !apiTransportBound(options.bound, admission, app))
    throw new Error('API transport configuration is unavailable.');
  const publicSpec = app.api.publicSpec ? options.publicSpec : undefined;
  const pending = new Set<Promise<boolean>>();
  let retired = false,
    owner: Promise<Owner> | undefined;
  // One owner for this serving lifetime, never built in a request's
  // cancellation context; a failed acquisition stays failed.
  const acquire = () => {
    if (!owner) {
      owner = withoutCancellation(build);
      void owner.catch(() => {});
    }
    return owner;
  };
  const currentHost = () => {
    try {
      if (
        retired ||
        own(host, 'app') !== loaded ||
        own(host, 'auth') !== auth ||
        own(host, 'unavailable') ||
        own(host, 'loadError') ||
        JSON.stringify(captureTenantData(own(loaded, 'app'))) !== definition
      )
        throw new Error();
    } catch {
      retired = true;
      void owner?.then(
        (active) => active.retire(),
        () => {},
      );
      throw new ApiReadFailure('temporarily_unavailable');
    }
  };
  const respond = (res: ServerResponse, status: number, code: string) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code, message: 'The API request could not be completed.' } }));
  };
  return Object.freeze({
    prepare: async (): Promise<void> => {
      currentHost();
      await acquire();
      currentHost();
    },
    /** The owner this transport answers through, for the App MCP beside it. */
    owner: (): Promise<Owner> => {
      currentHost();
      return acquire();
    },
    handle: (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (!claimsApiNamespace(req.url ?? '')) return Promise.resolve(false);
      // A rate budget limits arrivals, not outstanding work.
      if (pending.size >= API_PENDING_LIMIT) {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        respond(res, 503, 'temporarily_unavailable');
        return Promise.resolve(true);
      }
      const cancellation = new AbortController();
      const disconnect = () => cancellation.abort();
      req.once('aborted', disconnect);
      res.once('close', disconnect);
      if (req.aborted || res.destroyed || res.writableEnded) disconnect();
      const work = Promise.resolve().then(async () => {
        let written = false;
        let client: string | undefined;
        try {
          if (cancellation.signal.aborted) return true;
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-content-type-options', 'nosniff');
          currentHost();
          const admitted = admitApiRequest(req, options.bound, admission);
          if (!admitted.ok) {
            respond(res, admitted.status, admitted.code);
            return true;
          }
          if (req.method !== 'GET') {
            res.setHeader('allow', 'GET');
            respond(res, 405, 'method_not_allowed');
            return true;
          }
          if (
            req.headers['transfer-encoding'] !== undefined ||
            (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
          ) {
            res.setHeader('connection', 'close');
            respond(res, 400, 'invalid_request');
            return true;
          }
          // The published document answers only a request that presents no
          // credential at all: a bad one is refused below, never ignored.
          if (publicSpec && !presentsCredential(req)) {
            let published: ReturnType<typeof parseApiReadRoute> | undefined;
            try {
              published = parseApiReadRoute(req.url);
            } catch {
              /* Not the document; the credential check below answers. */
            }
            if (published?.operationId === '$openapi' && published.appId === app.id && published.version === app.api!.version) {
              const charged = admission.charge(admitted.client);
              if (!charged.ok) {
                res.setHeader('retry-after', charged.retryAfterSeconds);
                respond(res, 429, 'rate_limited');
                return true;
              }
              currentHost();
              const body = await publicSpec.read();
              if (cancellation.signal.aborted || res.destroyed || res.writableEnded) return true;
              currentHost();
              written = true;
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
              res.end(body);
              return true;
            }
          }
          let credential: string;
          try {
            credential = readApiBearerHeader(req.rawHeaders).credential;
          } catch {
            // No credential is the address's to answer for, and an address
            // over its budget is told to wait rather than to sign in.
            const charged = admission.charge(admitted.client);
            if (!charged.ok) {
              res.setHeader('retry-after', charged.retryAfterSeconds);
              respond(res, 429, 'rate_limited');
              return true;
            }
            res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', presentsAuthorization(req)));
            respond(res, 401, 'unauthenticated');
            return true;
          }
          let route: ReturnType<typeof parseApiReadRoute>;
          try {
            route = parseApiReadRoute(req.url);
          } catch {
            respond(res, 400, 'invalid_request');
            return true;
          }
          if (route.appId !== app.id || route.version !== app.api!.version) {
            respond(res, 404, 'not_found');
            return true;
          }
          // The token's own budget, before the owner does any work for it.
          const spent = admission.spend(credential);
          if (!spent.ok) {
            res.setHeader('retry-after', spent.retryAfterSeconds);
            respond(res, 429, 'rate_limited');
            return true;
          }
          client = admitted.client;
          const active = await acquire();
          currentHost();
          // Synchronous and void, as the owner requires: it runs inside the
          // native handoff, after the owner's final authorization.
          const send = (response: Readonly<{ status: number; body: string }>) => {
            currentHost();
            if (response.status === 401) admission.charge(admitted.client);
            if (cancellation.signal.aborted || res.destroyed || res.writableEnded) return;
            written = true;
            if (response.status === 401) res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', true));
            res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(response.body);
          };
          const signal = cancellation.signal;
          const metadata = route.operationId === '$events' || route.operationId === '$asyncapi';
          if (metadata && !(route.operationId === '$events' ? active.readEvents : active.readAsyncApi)) {
            respond(res, 404, 'not_found');
            return true;
          }
          await (route.operationId === '$openapi'
            ? active.readSpec(credential, send, signal)
            : route.operationId === '$events'
              ? active.readEvents!(credential, route.rawQuery, send, signal)
              : route.operationId === '$asyncapi'
                ? active.readAsyncApi!(credential, send, signal)
                : route.rawKey === undefined
                  ? active.readList(credential, route.operationId, route.rawQuery, send, signal)
                  : active.readItem(credential, route.operationId, route.rawKey, send, signal));
          if (!written && !signal.aborted) respond(res, 503, 'temporarily_unavailable');
          return true;
        } catch (error) {
          if (written || cancellation.signal.aborted) return true;
          const code = error instanceof ApiReadFailure ? error.code : 'temporarily_unavailable';
          const status = code === 'unauthenticated' ? 401 : code === 'forbidden' ? 403 : code === 'invalid_request' ? 400 : 503;
          // A refused credential is the address's to answer for.
          if (status === 401 && client !== undefined) admission.charge(client);
          if (status === 401 && !res.destroyed && !res.writableEnded)
            res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', true));
          respond(res, status, code);
          return true;
        } finally {
          req.removeListener('aborted', disconnect);
          res.removeListener('close', disconnect);
        }
      });
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    retire: async () => {
      retired = true;
      if (owner)
        await owner.then(
          (active) => active.retire(),
          () => {},
        );
      await Promise.allSettled([...pending]);
    },
  });
}
