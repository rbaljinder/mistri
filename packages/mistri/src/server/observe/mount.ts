/**
 * `/_mistri/observe`: the dev observer's address, reserved on every
 * server and answered only when the observer runs.
 *
 * `_mistri` is one of the server's own segments (shared/mount.ts
 * SERVER_SEGMENTS): no App is mounted there and a root App cannot route to
 * it. The observer claims `observe` under it, and is reached under the base
 * path like every server path. In a production start this module is all there is: no
 * observer code is loaded, and the address answers 404 before any gate, any
 * App or the client shell can answer it instead.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NO_MOUNT, serverPath, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { linkTraces } from '@mistriwork/engine/server/http/reply.js';

export const RESERVED = '/_mistri/observe';

export type ObserverHttp = (req: IncomingMessage, res: ServerResponse, url: URL, mount: AddressMount) => void;
/* Each request's mount, so a reply built far from the router links under its base. */
const mounts = new WeakMap<IncomingMessage, AddressMount>();
let mounted: ObserverHttp | undefined;

/** The observer, when a dev start loaded it. */
export function mountObserver(handler: ObserverHttp | undefined): void {
  mounted = handler;
  /* A refusal sent while it runs says where its trace is (reply.ts `send`). */
  linkTraces(handler ? observerLink : undefined);
}
export const observerMounted = () => mounted !== undefined;

/** Answer a request under the reserved address. True when answered, which is always. */
export function observerRoute(req: IncomingMessage, res: ServerResponse, url: URL, mount?: AddressMount): boolean {
  /* A tenant host hands the request on to its data server, which asks again
     without a mount: the first answer, the one that read the address, stands. */
  if (mount || !mounts.has(req)) mounts.set(req, mount ?? NO_MOUNT);
  if (url.pathname !== RESERVED && !url.pathname.startsWith(`${RESERVED}/`)) return false;
  if (mounted) {
    mounted(req, res, url, mounts.get(req)!);
    return true;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'Not found.' }));
  return true;
}

/** Where a refusal's trace can be read, while the observer runs: the "Open in observer" link. */
function observerLink(traceId: string | undefined, req?: IncomingMessage): string | undefined {
  return mounted && traceId ? serverPath((req && mounts.get(req)) ?? NO_MOUNT, `${RESERVED}/#trace/${traceId}`) : undefined;
}

/** The observer's address under this request's base, for a page's tag. */
export const observerHome = (mount: AddressMount): string => serverPath(mount, `${RESERVED}/`);
