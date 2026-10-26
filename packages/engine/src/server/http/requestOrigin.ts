/**
 * The origin a request was made to, as the browser that made it wrote it:
 * what a sitemap's `<loc>` and a link preview's `og:url` must be, since both
 * are read away from the page and need an absolute address. The Host header
 * has already been held to the server's allowed hosts by the gate
 * (trust.ts); the scheme is https when the socket is TLS or a trusted proxy
 * says it forwarded https (`--trust-proxy`), and http otherwise.
 */
import type { IncomingMessage } from 'node:http';
import { trustedProxyPeer, type Bound } from './trust.js';

export function requestOrigin(req: Pick<IncomingMessage, 'headers' | 'socket'>, bound: Pick<Bound, 'trustedProxies'>): string | undefined {
  const host = String(req.headers.host ?? '').trim();
  // A host, an optional port: anything else is not an origin to write into a page.
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(host)) return undefined;
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure =
    Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    (forwarded === 'https' && trustedProxyPeer(req.socket.remoteAddress, bound.trustedProxies));
  return `${secure ? 'https' : 'http'}://${host.toLowerCase()}`;
}
