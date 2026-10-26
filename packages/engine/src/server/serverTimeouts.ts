/**
 * The timeouts every tablewalk HTTP server sets, in one place.
 *
 * Keep-alive outlives the idle timeouts of the proxies tablewalk is deployed
 * behind: nginx and cloud load balancers hold an idle upstream connection
 * for about a minute. At Node's five-second default the server closed a
 * pooled socket just as a proxy or client reused it, and that request failed
 * with a reset. The headers timeout stays above keep-alive, as Node requires,
 * and still bounds a client that sends its headers slowly; the request
 * timeout bounds a whole body. A socket that takes over a minute for its
 * headers, or ten for its body, is not a browser on this tool: cheap where
 * the server is loopback, the whole defence where someone bound it wider.
 *
 * The long keep-alive has a cost at shutdown. `close()` drops the sockets idle
 * at that moment, but a response still being written when it ran finishes
 * with `Connection: keep-alive`, and its socket then idles for the full
 * sixty-five seconds while `close()` waits on it — a browser left open on the
 * page held a stopping server for a minute. So once `close()` has run, the
 * idle sockets are swept again every quarter second until the server has
 * closed. A sweep rather than a `request` listener: the tenant and flag
 * servers wrap the one listener a server has, and refuse a second.
 *
 * Node counts a socket that has not sent a byte as busy, not idle, so the
 * sweep closes those too: a browser opens a spare connection ahead of a
 * request it may never make, and holds it about ten seconds before giving up,
 * which held a stopping suite past a test's whole timeout. One silent for a
 * second has asked nothing, so nothing is lost; a younger one may be a
 * request still on its way, and is left to send it.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;
const REQUEST_TIMEOUT_MS = 600_000;
const CLOSE_SWEEP_MS = 250;
const SILENT_MS = 1_000;

export function applyServerTimeouts(server: Server): Server {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  /* Each socket by when it connected: one silent past a second is a spare, not a request still on its way. */
  const sockets = new Map<Socket, number>();
  server.on('connection', (socket: Socket) => {
    sockets.set(socket, Date.now());
    socket.once('close', () => sockets.delete(socket));
  });
  const close = server.close;
  server.close = function closeAndSweep(this: Server, callback?: (error?: Error) => void) {
    const unused = () => {
      for (const [socket, connected] of sockets) if (socket.bytesRead === 0 && Date.now() - connected > SILENT_MS) socket.destroy();
    };
    const sweep = setInterval(() => {
      server.closeIdleConnections();
      unused();
    }, CLOSE_SWEEP_MS);
    sweep.unref();
    server.once('close', () => clearInterval(sweep));
    return close.call(this, callback);
  } as Server['close'];
  return server;
}
