/**
 * `/_mistri/theme`: the theme bench's address, reserved on every server and
 * answered only while `mistri dev` runs it (bench.ts).
 *
 * It sits under the server's own `_mistri` segment beside the observer
 * (observe/mount.ts), for the same reason: no App is mounted there, so a
 * root App cannot route to it. `/_theme` is the short way in, said where a
 * person types it; an App segment cannot begin with `_` (shared/mount.ts), so
 * it never shadows an App's own address. In a production start this module
 * is all there is, and both addresses answer 404.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressMount } from '@mistriwork/engine/shared/mount.js';

export const RESERVED = '/_mistri/theme';
const SHORT = '/_theme';

type BenchHttp = (req: IncomingMessage, res: ServerResponse, url: URL, mount: AddressMount) => void;
let mounted: BenchHttp | undefined;

/** The bench, when a dev start loaded it. */
export function mountThemeBench(handler: BenchHttp | undefined): void {
  mounted = handler;
}

/** Answer a request for the bench, or for its address while no bench runs: a 404 then, as the observer's is, since
 * left to fall through the address would be the client shell's page. True when answered. */
export function themeBenchRoute(req: IncomingMessage, res: ServerResponse, url: URL, mount: AddressMount): boolean {
  /* As typed, under the base: the inside path a root App's address is read into names the App first. */
  const typed = (req.url ?? '').split('?')[0];
  if (!mounted) {
    if (typed !== SHORT && typed !== `${SHORT}/` && url.pathname !== RESERVED && !url.pathname.startsWith(`${RESERVED}/`)) return false;
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'Not found.' }));
    return true;
  }
  if (typed === SHORT || typed === `${SHORT}/`) {
    res.writeHead(308, { location: `${mount.base}${RESERVED}/`, 'cache-control': 'no-store' }).end();
    return true;
  }
  if (url.pathname !== RESERVED && !url.pathname.startsWith(`${RESERVED}/`)) return false;
  mounted(req, res, url, mount);
  return true;
}
