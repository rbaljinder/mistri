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
 * A dispatcher: a module that takes a request from a socket (or a host's
 * server) and holds it to the door before any route reads it, in the door's
 * order — the Host, the proxy's identity, the product's session, then a
 * write's Origin and body. Each product names its own in a table of these
 * (its server/http/dispatchers.ts), so the engine names no product's path;
 * test/door.test.ts stands each up and sends it the same refusals, and a new
 * one is named in its product's table and given a row there.
 */
export interface Dispatcher {
  /** The module, by its path in the repository. */
  readonly module: string;
  /** What it serves. */
  readonly serves: string;
}
