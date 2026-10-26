/** Private suite request composition. The host installs this scope around the
 * true incoming request; authored handlers cannot supply it. Admission still
 * belongs to each callback's native command/policy/membership owner. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import type { BusinessCommandActor } from '../commands/businessCommands.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import type { FlagRequestLifetime, FlagRequestRuntime, FlagRuntimeCapture } from './requestRuntime.js';

/* Written out rather than inferred: flagHttpRequest() is reachable from the
   public handler entry, and the inferred shape expands the runtime's admission
   types, which the declaration build cannot name from here. */
interface FlagHttpScope {
  readonly runtime: FlagRequestRuntime;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly lifetime: FlagRequestLifetime;
  hold(assertOwner: () => void): void;
  native(): Promise<FlagRuntimeCapture>;
  public(form?: string, tenantId?: string | null): ReturnType<FlagRequestRuntime['public']>;
}

const scopes = new AsyncLocalStorage<FlagHttpScope>();
function makeScope(
  runtime: FlagRequestRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  auth: AppAuthRuntime | undefined,
  current: () => void,
): FlagHttpScope {
  let active = true;
  const owners = new Set<() => void>();
  const lifetime = {
    generation: Object.freeze({}),
    assertCurrent() {
      current();
      if (!active || request.aborted || response.destroyed || response.writableEnded) throw new HttpError(409, 'Request retired.');
      for (const assertOwner of owners) assertOwner();
    },
    async current() {
      this.assertCurrent();
    },
  };
  const retire = () => {
    active = false;
  };
  response.once('finish', retire);
  response.once('close', retire);
  request.once('aborted', retire);
  let native: Promise<FlagRuntimeCapture> | undefined;
  return {
    runtime,
    request,
    response,
    lifetime,
    hold(assertOwner: () => void) {
      assertOwner();
      owners.add(assertOwner);
    },
    native() {
      return (native ??= (async () => {
        lifetime.assertCurrent();
        if (!auth || getTenantHostIntent(request)) throw new HttpError(403, 'Native admission required.');
        const proof = await captureAppAuthRuntime(auth).sessionInstance(request);
        lifetime.assertCurrent();
        if (!proof) throw new HttpError(401, 'Sign in required.');
        const accounts = request.rawHeaders.filter(
          (_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'x-mistri-account',
        );
        if (
          accounts.length > 1 ||
          (request.headers['x-mistri-account'] !== undefined && request.headers['x-mistri-account'] !== proof.identity.id)
        ) {
          throw new HttpError(409, 'Account changed.');
        }
        const capture = await runtime.native(request, proof, lifetime);
        response.setHeader('x-mistri-account', proof.identity.id);
        return capture;
      })());
    },
    public(form?: string, tenantId?: string | null) {
      return runtime.public(request, { ...lifetime, ...(form === undefined ? {} : { form }), tenantId });
    },
  };
}
export function withFlagHttpRequest<T>(
  runtime: FlagRequestRuntime | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  auth: AppAuthRuntime | undefined,
  current: () => void,
  run: () => T,
): T {
  if (!runtime) return run();
  const existing = scopes.getStore();
  if (existing?.request === request && existing.runtime === runtime) return run();
  return scopes.run(makeScope(runtime, request, response, auth, current), run);
}
/** Installed once before the child is exposed or background work starts. */
export function bindFlagHttpServer(
  server: Server,
  runtime: () => FlagRequestRuntime | undefined,
  auth: AppAuthRuntime | undefined,
  current: () => void,
  values?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): void {
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) =>
    withFlagHttpRequest(runtime(), req, res, auth, current, () => {
      const dispatch = () => {
        for (const listener of listeners) listener.call(server, req, res);
      };
      if (!values) dispatch();
      else
        void values(req, res)
          .then((handled) => {
            if (!handled) dispatch();
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(503).end();
            else res.destroy();
          });
    }),
  );
}
export function flagHttpRequest(): FlagHttpScope | undefined {
  return scopes.getStore();
}
export async function captureHttpCommandFlags(
  actor: BusinessCommandActor,
  placement?: { tenantId: string | null },
  assertOwner?: () => void,
) {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  if (assertOwner) scope.hold(assertOwner);
  const capture = actor.kind === 'public' ? await scope.public(actor.form, placement?.tenantId) : await scope.native();
  return capture.captureFlags(actor);
}
export async function captureHttpTenantFlags(principal: unknown, request: unknown) {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  if (request !== scope.request) throw new HttpError(403, 'Wrong request owner.');
  return scope.runtime.captureTenantFlags(principal, scope.request);
}
