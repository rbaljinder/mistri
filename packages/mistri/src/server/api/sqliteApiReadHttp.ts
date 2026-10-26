/** Private transport composition, mounted only through explicit createApp
 * opt-in, not CLI defaults: loopback, or beyond it for an App that declares
 * `api.network`. Numeric representation and rate budget are explicit
 * deployment choices; cookies/proxy roles never authenticate this namespace. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProxy } from 'node:util/types';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { readApiBearerHeader } from './apiBearerHeader.js';
import { bearerChallenge, presentsAuthorization } from '../auth/oauthResource.js';
import { parseApiReadRoute } from './apiReadRoute.js';
import { createSqliteApiReadHost } from './sqliteApiReadHost.js';
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
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';

function own(value: object, key: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new Error('API transport configuration is unavailable.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('API transport configuration is unavailable.');
  return descriptor.value;
}

export function createSqliteApiReadHttp(
  registry: Registry,
  host: AppHost,
  options: {
    bound: Bound;
    integers: 'decimal-string' | 'number';
    requestsPerMinute: number;
    /** The App API's budgets, shared with the App's command transport when it has one. */
    admission?: ApiAdmission;
    /** The App's commands, whose declared events the feed and AsyncAPI document describe. */
    commands?: BusinessCommandRegistry;
    /** `api.publicSpec`: the whole document for a request that presents no credential. */
    publicSpec?: ApiPublicSpec;
  },
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
  const reader = createSqliteApiReadHost(registry, host, options.integers, options.commands);
  const pending = new Set<Promise<boolean>>();
  let retired = false;
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
      void reader.retire().catch(() => {});
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
      await reader.prepare();
      currentHost();
    },
    /** The owner these reads answer through, for the App MCP beside them. */
    owner: () => {
      currentHost();
      return reader.owner();
    },
    handle: (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (!claimsApiNamespace(req.url ?? '')) return Promise.resolve(false);
      // A rate budget limits arrivals, not outstanding work. Bound requests
      // retained across adapter awaits independently, before capturing tokens.
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
        let result: object | undefined;
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
          result =
            route.operationId === '$openapi'
              ? await reader.readSpec(credential, cancellation.signal)
              : route.operationId === '$events'
                ? await reader.readEvents(credential, route.rawQuery, cancellation.signal)
                : route.operationId === '$asyncapi'
                  ? await reader.readAsyncApi(credential, cancellation.signal)
                  : route.rawKey === undefined
                    ? await reader.readList(credential, route.operationId, route.rawQuery, cancellation.signal)
                    : await reader.readItem(credential, route.operationId, route.rawKey, cancellation.signal);
          if (cancellation.signal.aborted || res.destroyed || res.writableEnded) return true;
          currentHost();
          // Body serialization is already complete. Keep fresh consumption and
          // socket handoff on this stack with no intervening asynchronous work.
          const response = reader.consumeResult(result);
          res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(response.body);
          return true;
        } catch (error) {
          if (cancellation.signal.aborted) return true;
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
          if (result) reader.discardResult(result);
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
      await reader.retire();
      await Promise.allSettled([...pending]);
    },
  });
}
