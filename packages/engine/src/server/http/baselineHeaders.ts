/**
 * The headers every answer carries, set before anything is routed so a reply
 * that names its own (a mail link's `no-referrer`) still wins: `writeHead`'s
 * headers override what `setHeader` put first.
 *
 * - `Referrer-Policy: strict-origin-when-cross-origin`: an address under a
 *   record (`/compass/leads/127?search=…`) leaves this origin as the origin
 *   alone, and never over plain http.
 * - `Permissions-Policy`: no page here uses a camera, a microphone, a
 *   location or a payment sheet, so none is granted — to a component, or to
 *   whatever frames or is framed.
 * - `Strict-Transport-Security`, only on an answer that arrived over https
 *   (trust.ts `arrivedOverHttps`): the socket's own TLS, an https public
 *   address, or a proxy this server trusts saying it forwarded https. A
 *   plain-http server (a laptop, a loopback dev server) never pins its name
 *   to https.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arrivedOverHttps, type ProxyRange } from './trust.js';

export const REFERRER_POLICY = 'strict-origin-when-cross-origin';
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), ' +
  'magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), browsing-topics=()';
/** A year, and the names under this one: the time browsers ask of a name kept on https. */
export const STRICT_TRANSPORT = 'max-age=31536000; includeSubDomains';

export function setBaselineHeaders(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  res: ServerResponse,
  trustedProxies: readonly ProxyRange[] = [],
): void {
  res.setHeader('referrer-policy', REFERRER_POLICY);
  res.setHeader('permissions-policy', PERMISSIONS_POLICY);
  if (arrivedOverHttps(req, trustedProxies)) res.setHeader('strict-transport-security', STRICT_TRANSPORT);
}
