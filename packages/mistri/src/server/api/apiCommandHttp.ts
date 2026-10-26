/** The command transport core, shared by the SQLite and PostgreSQL
 * compositions: loopback, or beyond it for an App that declares `api.network`. createApp mounts the one for the App's engine, before its read
 * transport, under the explicit `--api-reads` opt-in for an App that exposes
 * commands. The owner uses the api-v1 wire; the integer representation
 * and rate budget are explicit deployment choices; cookies never authenticate
 * here. It claims only command routes, so the read transport keeps the rest —
 * except `$openapi` for an App that exposes commands, which no read owner
 * serves: that document is composed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProxy } from 'node:util/types';
import type { AppHost } from '../app/apps.js';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { commandBody } from '../commands/businessCommandHttp.js';
import { readApiBearerHeader } from './apiBearerHeader.js';
import { bearerChallenge, presentsAuthorization } from '../auth/oauthResource.js';
import { parseApiCommandRoute, type ApiCommandRoute } from './apiCommandRoute.js';
import { parseApiReadRoute } from './apiReadRoute.js';
import { ApiCommandRequestError, readApiCommandHeaders } from './apiCommandHeaders.js';
import { apiTransportProblem, commandProblem } from './apiCommandResponse.js';
import { ApiCommandUnauthenticated } from './sqliteApiCommandOwner.js';
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
import { apiExposesCommands } from './apiGenericWrites.js';

type Answer = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;
function own(value: object, key: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new Error('API transport configuration is unavailable.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('API transport configuration is unavailable.');
  return descriptor.value;
}

/** `deliver` runs one mapped request (or the document request, `spec`) on the
 * engine's owner and hands its one serialized, re-authorized answer to
 * `write` — once, or not at all. */
export function createApiCommandHttp<
  Owner extends {
    map(route: ApiCommandRoute, headers: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>, body: unknown): unknown;
    retire(): Promise<void>;
  },
>(
  host: AppHost,
  options: {
    bound: Bound;
    integers: 'decimal-string' | 'number';
    requestsPerMinute: number;
    /** The App API's budgets, shared with the read transport beside it. */
    admission?: ApiAdmission;
    /** `api.publicSpec`: the whole composed document for a request that presents no credential. */
    publicSpec?: ApiPublicSpec;
  },
  engine: {
    acquire(): Promise<Owner>;
    deliver(
      owner: Owner,
      kind: ApiCommandRoute['kind'] | 'spec',
      credential: string,
      envelope: unknown,
      signal: AbortSignal,
      write: (answer: Answer) => void,
    ): Promise<void>;
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
  const api = app.api,
    servesSpec = apiExposesCommands(api);
  const admission = options.admission ?? apiAdmission(options.requestsPerMinute);
  if (!(admission instanceof ApiAdmission) || isProxy(admission) || !apiTransportBound(options.bound, admission, app))
    throw new Error('API transport configuration is unavailable.');
  const publicSpec = api.publicSpec ? options.publicSpec : undefined;
  const pending = new Set<Promise<boolean>>();
  let retired = false,
    owner: Promise<Owner> | undefined;
  // One lazily built owner; a failed acquisition stays failed rather than retrying per request.
  const acquire = () => {
    if (!owner) {
      owner = engine.acquire();
      void owner.catch(() => {});
    }
    return owner;
  };
  const currentHost = () => {
    if (
      retired ||
      own(host, 'app') !== loaded ||
      own(host, 'auth') !== auth ||
      own(host, 'unavailable') ||
      own(host, 'loadError') ||
      JSON.stringify(captureTenantData(own(loaded, 'app'))) !== definition
    ) {
      retired = true;
      void owner?.then(
        (active) => active.retire(),
        () => {},
      );
      throw new Error('The command transport is retired.');
    }
  };
  const send = (res: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>> = {}) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      ...headers,
      'content-type': status === 200 ? 'application/json; charset=utf-8' : 'application/problem+json; charset=utf-8',
    });
    res.end(body);
  };
  const refuseEarly = (res: ServerResponse, code: Parameters<typeof apiTransportProblem>[0]) => {
    const problem = apiTransportProblem(code);
    send(res, problem.status, JSON.stringify(problem.value));
  };
  // The owner may have had the request: its outcome cannot be denied.
  const unknown = (res: ServerResponse) => send(res, 503, JSON.stringify(commandProblem('temporarily_unavailable', 'unknown')));
  const isSpec = (raw: string) => servesSpec && raw.split('?')[0].endsWith('/$openapi');
  // Command routes only; a normalization alias still reaches the raw parser.
  const claims = (raw: string) => claimsApiNamespace(raw) && (/\/commands(?:\/|$)/.test(raw.split('?')[0]) || isSpec(raw));
  return Object.freeze({
    prepare: async (): Promise<void> => {
      currentHost();
      await acquire();
      currentHost();
    },
    /** The owner commands run through, for the App MCP beside them: never a second one. */
    owner: (): Promise<Owner> => {
      currentHost();
      return acquire();
    },
    handle: (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (!claims(req.url ?? '')) return Promise.resolve(false);
      if (pending.size >= API_PENDING_LIMIT) {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        refuseEarly(res, 'temporarily_unavailable');
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
            refuseEarly(res, admitted.code);
            return true;
          }
          const spec = isSpec(req.url ?? '');
          let route: ApiCommandRoute | undefined;
          if (spec) {
            let parsed: ReturnType<typeof parseApiReadRoute>;
            try {
              parsed = parseApiReadRoute(req.url);
            } catch {
              refuseEarly(res, 'invalid_request');
              return true;
            }
            if (parsed.operationId !== '$openapi' || parsed.appId !== app.id || parsed.version !== api.version) {
              refuseEarly(res, 'not_found');
              return true;
            }
          } else {
            try {
              route = parseApiCommandRoute(req.url);
            } catch {
              refuseEarly(res, 'invalid_request');
              return true;
            }
          }
          const method = route?.method ?? 'GET';
          if (req.method !== method) {
            res.setHeader('allow', method);
            refuseEarly(res, 'method_not_allowed');
            return true;
          }
          if (
            method === 'GET' &&
            (req.headers['transfer-encoding'] !== undefined ||
              (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))
          ) {
            res.setHeader('connection', 'close');
            refuseEarly(res, 'invalid_request');
            return true;
          }
          // The published document answers only a request that presents no
          // credential at all: a bad one is refused below, never ignored.
          if (spec && publicSpec && !presentsCredential(req)) {
            const charged = admission.charge(admitted.client);
            if (!charged.ok) {
              res.setHeader('retry-after', charged.retryAfterSeconds);
              refuseEarly(res, 'rate_limited');
              return true;
            }
            const body = await publicSpec.read();
            if (cancellation.signal.aborted) return true;
            currentHost();
            written = true;
            send(res, 200, body);
            return true;
          }
          let credential: string;
          try {
            credential = readApiBearerHeader(req.rawHeaders).credential;
          } catch {
            // No credential is the address's to answer for.
            const charged = admission.charge(admitted.client);
            if (!charged.ok) {
              res.setHeader('retry-after', charged.retryAfterSeconds);
              refuseEarly(res, 'rate_limited');
              return true;
            }
            res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', presentsAuthorization(req)));
            refuseEarly(res, 'unauthenticated');
            return true;
          }
          // The token's own budget, before the owner does any work for it.
          const spent = admission.spend(credential);
          if (!spent.ok) {
            res.setHeader('retry-after', spent.retryAfterSeconds);
            refuseEarly(res, 'rate_limited');
            return true;
          }
          client = admitted.client;
          let headers: ReturnType<typeof readApiCommandHeaders> | undefined, body: unknown;
          if (route) {
            try {
              headers = readApiCommandHeaders(req.rawHeaders, route.kind);
              // The browser command path's reader: 64 KiB, fatal UTF-8, BOM refusal.
              body = route.method === 'POST' ? await commandBody(req) : undefined;
            } catch (error) {
              refuseEarly(res, error instanceof ApiCommandRequestError ? error.code : 'invalid_request');
              return true;
            }
          }
          if (cancellation.signal.aborted) return true;
          const active = await acquire();
          currentHost();
          let envelope: unknown;
          if (route) {
            try {
              envelope = active.map(route, headers!, body);
            } catch (error) {
              if (error instanceof ApiCommandRequestError) {
                refuseEarly(res, error.code);
                return true;
              }
              throw error;
            }
          }
          await engine.deliver(active, route?.kind ?? 'spec', credential, envelope, cancellation.signal, (answer) => {
            // Hand the bytes to the socket on the owner's stack, with no
            // asynchronous gap after its final authorization.
            currentHost();
            if (answer.status === 401) admission.charge(admitted.client);
            written = true;
            send(
              res,
              answer.status,
              answer.body,
              answer.status === 401 ? { ...answer.headers, 'www-authenticate': bearerChallenge(auth, 'rest', true) } : answer.headers,
            );
          });
          // An owner that could not hand its answer over cannot deny the outcome.
          if (!written && !cancellation.signal.aborted) unknown(res);
          return true;
        } catch (error) {
          if (written || cancellation.signal.aborted) return true;
          if (error instanceof ApiCommandUnauthenticated) {
            // A refused credential is the address's to answer for.
            if (client !== undefined) admission.charge(client);
            if (!res.destroyed && !res.writableEnded) res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', true));
            refuseEarly(res, 'unauthenticated');
            return true;
          }
          unknown(res);
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
