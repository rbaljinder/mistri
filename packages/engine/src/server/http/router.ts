/**
 * How a dispatcher is put together: the door (door.ts) and then tables of
 * routes, each tried in order until one answers. A route is a predicate
 * that answers as it decides, so a table reads as the order requests are
 * matched in, and moving a route moves its precedence with it — which is
 * why the tables are lists rather than a map keyed by path.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** What every route is handed, whatever product's dispatcher it sits in: the request, and what that product adds. */
export type RequestContext<Ext = object> = {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly path: string;
} & Ext;

/** One route: true when it answered the request. */
export type Route<C extends RequestContext> = (ctx: C) => boolean | Promise<boolean>;

/** Try `routes` in order; true when one answered. */
export async function route<C extends RequestContext>(ctx: C, routes: readonly Route<C>[]): Promise<boolean> {
  for (const each of routes) if (await each(ctx)) return true;
  return false;
}

/**
 * Every dispatcher: a module that takes a request from a socket (or a host's
 * server) and holds it to the door before any route reads it, in the door's
 * order — the Host, the proxy's identity, the product's session, then a
 * write's Origin and body. test/door.test.ts stands each up and sends it the
 * same refusals; a new one is named here, and given a row there.
 */
export const DISPATCHERS = [
  { module: 'packages/tablewalk/src/server/http/browserHandler.ts', serves: 'the database browser' },
  { module: 'packages/mistri/src/server/http/handler.ts', serves: 'the Apps of a deployment that serves them' },
  { module: 'packages/mistri/src/server/embed/handler.ts', serves: 'an App mounted inside somebody else’s server' },
  { module: 'packages/mistri/src/server/http/suite.ts', serves: 'several deployments under one origin, each behind its own dispatcher' },
  { module: 'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts', serves: 'a tenant App’s browser host and its native sign-in' },
  { module: 'packages/mistri/src/server/tenant/tenantHttp.ts', serves: 'a tenant App’s data, inside its browser host' },
] as const;
