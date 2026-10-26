/**
 * Where this page's server mounts its Apps, and the path it is served
 * under, as the page it sent says (server clientHttp.ts writes
 * `<meta name="mistri-mount">`; the rule is shared/mount.ts).
 *
 * The client thinks in inside addresses — `/lintel/leases/12`, whatever
 * the browser shows — and crosses to the browser's form only at its edges:
 * reading the address bar (`herePath`), writing it and every link
 * (`shown`), and every request it makes (`served`). A page with no mount —
 * the standalone database browser, a component test — reads and writes every
 * address as it is.
 */
import { inward, outward, readMountJson, serverPath } from '@mistriwork/engine/shared/mount.js';
import { shellQuery } from './shellHost.js';

const mount = readMountJson(typeof document === 'undefined' ? null : shellQuery('meta[name="mistri-mount"]')?.getAttribute('content'));

/**
 * The address bar's path in its inside form: `/leases/12` with Lintel at
 * the root is `/lintel/leases/12`. One the mount does not place is read as
 * it is, and names nothing.
 * @returns {string}
 */
export function herePath() {
  return inward(mount, window.location.pathname) ?? window.location.pathname;
}

/**
 * The address bar's query string, `?tab=ending_soon` or ''. Read here rather
 * than from `location` where it is asked, so that a shell whose address is
 * not the window's (an embedded surface, src/embed/) answers with its own.
 * @returns {string}
 */
export function hereSearch() {
  if (!placement) return window.location.search;
  const params = new URLSearchParams(window.location.search);
  params.delete('via');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/* A tenant App's visitor arrives on a tenant's public address (`?via=`, server
   tenantPublicReadHttp.ts), which places every read it makes with that tenant.
   Read once, as the page arrived, and kept on every address the page writes so
   a reload or a shared link reads the same tenant. Not part of what an address
   says — a list's parameters never see it (`hereSearch`). Kept only once
   who-am-I says this App serves its visitors so (`keepPlacement`). */
const arrived = (() => {
  if (typeof window === 'undefined') return null;
  const vias = new URLSearchParams(window.location.search).getAll('via');
  return vias.length === 1 && /^[A-Za-z0-9_-]{22,128}$/.test(vias[0]) ? vias[0] : null;
})();
/** @type {string | null} */
let placement = null;

/**
 * The public address this page arrived with, or null: asked of who-am-I before it is kept.
 * @returns {string | null}
 */
export function arrivedPlacement() {
  return arrived;
}

/**
 * Keep the arrived address on every address and request, once who-am-I says
 * it places this visitor (`tenantPublic`).
 * @param {boolean} keep
 * @returns {string | null}
 */
export function keepPlacement(keep) {
  placement = keep ? arrived : null;
  return placement;
}

/**
 * The address a visitor's reads are placed by, once kept.
 * @returns {string | null}
 */
export function publicPlacement() {
  return placement;
}

/**
 * An inside address as the browser shows it, for the address bar and a link.
 * @param {string} internal
 * @returns {string}
 */
export function shown(internal) {
  const outside = outward(mount, internal);
  return placement ? withPlacement(outside, placement) : outside;
}

/**
 * An inside address as the browser shows it, without the visitor's public
 * address: the sign-in door, where a member is a member and never a visitor.
 * @param {string} internal
 * @returns {string}
 */
export function shownUnplaced(internal) {
  return outward(mount, internal);
}

/**
 * One of an App's own files by its inside address — a compiled component,
 * `/{app}/_components/<file>` — where the browser fetches it. On a served
 * page that is the address bar's form: the page and the server share one
 * mount. An embedded shell has two, and fetches it from the endpoint.
 * @param {string} internal
 * @returns {string}
 */
export function appFile(internal) {
  return shown(internal);
}

/**
 * `appFile` without the visitor's public address: a logo's picture, whose one
 * address is the one its year-long cache keeps.
 * @param {string} internal
 * @returns {string}
 */
export function appFileUnplaced(internal) {
  return shownUnplaced(internal);
}

/**
 * @param {string} address
 * @param {string} via
 */
function withPlacement(address, via) {
  const hash = address.indexOf('#');
  const head = hash < 0 ? address : address.slice(0, hash),
    tail = hash < 0 ? '' : address.slice(hash);
  const query = head.indexOf('?');
  const path = query < 0 ? head : head.slice(0, query);
  const params = new URLSearchParams(query < 0 ? '' : head.slice(query + 1));
  params.set('via', via);
  return `${path}?${params.toString()}${tail}`;
}

/**
 * A server path — `/api/…`, `/_mistri/…` — where this page's server
 * answers it: under the base path, when there is one.
 * @param {string} path
 * @returns {string}
 */
export function served(path) {
  return serverPath(mount, path);
}
