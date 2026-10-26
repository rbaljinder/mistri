import { PLATFORM_TENANT_ID } from '../shared/tenantContext.js';
import { say } from './copy/tenancy/tenantLink.js';

interface TenantLink {
  pathname: string;
  /** The App address's own parameters (a list's `tab=`, a dashboard's `period=`), as written, without the selector; '' when none. */
  search: string;
  tenantId: string | null;
}

const invalid = (): never => {
  throw new Error(say('invalidTenantLink'));
};

function identifier(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 1024 || value !== value.trim() || /\p{Cc}/u.test(value)) invalid();
  // URLSearchParams replaces lone surrogates; a tenant ID must not change.
  try {
    encodeURIComponent(value);
  } catch {
    invalid();
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return invalid();
  }
}

function checkedPath(pathname: string, appId: string): string {
  identifier(appId);
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || /[?#\\\p{Cc}]/u.test(pathname)) invalid();
  const parts = pathname.slice(1).split('/');
  if (parts.some((part) => !part)) invalid();
  const decoded = parts.map(decode);
  if (decoded.some((part) => part === '.' || part === '..') || decoded[0] !== appId || /[/\\]/.test(decoded[0])) invalid();
  // Refuse browser normalization (including raw spaces/Unicode). Do not decode
  // and rebuild the trail: encoded separators may be ordinary record-key data.
  if (new URL(pathname, 'http://tenant-link.invalid').pathname !== pathname) invalid();
  return pathname;
}

/* The selector's names, and the host's own, which no App parameter may take in
   any case or spelling: a field that decodes to one of them is a second
   selector, never an App's word. */
const RESERVED = new Set(['tenant', 'realm', 'app', 'conn']);

/** A tenant hint is navigation intent, never an established context or grant.
 * The query is the App address's own parameters (appAddress.ts) and at most
 * one selector, `tenant=` or `realm=platform`, in any position: every field is
 * kept as written, and one that could be read two ways refuses the link. */
export function parseTenantLink(link: string, appId: string): TenantLink {
  if (typeof link !== 'string' || link.includes('#') || link.includes('\\') || /\p{Cc}/u.test(link)) invalid();
  const separator = link.indexOf('?');
  const pathname = checkedPath(separator < 0 ? link : link.slice(0, separator), appId);
  if (separator < 0) return { pathname, search: '', tenantId: null };
  const query = link.slice(separator + 1);
  // The platform parser tolerates malformed escapes and empty fields. Neither
  // may silently become a different selector or an absent tenant hint here.
  if (!query) invalid();
  try {
    encodeURIComponent(query);
  } catch {
    invalid();
  }
  const kept: string[] = [],
    names = new Set<string>();
  let selector: { name: string; value: string } | undefined;
  for (const field of query.split('&')) {
    const equals = field.indexOf('=');
    if (equals < 1) invalid();
    const name = decode(field.slice(0, equals).replace(/\+/g, ' ')),
      value = decode(field.slice(equals + 1).replace(/\+/g, ' '));
    if (names.has(name.toLowerCase())) invalid();
    names.add(name.toLowerCase());
    if (!RESERVED.has(name.toLowerCase())) {
      kept.push(field);
      continue;
    }
    // A selector is spelled exactly: `tenant` or `realm`, unescaped, and only one.
    if (selector || (name !== 'tenant' && name !== 'realm') || field.slice(0, equals) !== name) invalid();
    selector = { name, value };
  }
  const search = kept.join('&');
  if (!selector) return { pathname, search, tenantId: null };
  // The platform realm is its own selector; no tenant hint names its reserved
  // id, as no `?tenant=` selector can on the server.
  if (selector.name === 'realm') {
    if (selector.value !== 'platform') invalid();
    return { pathname, search, tenantId: PLATFORM_TENANT_ID };
  }
  identifier(selector.value);
  if (selector.value === PLATFORM_TENANT_ID) invalid();
  return { pathname, search, tenantId: selector.value };
}

/** The safe root after a signed-in visitor reloads at the App's sign-in
 * door. A tenant selector survives because it is already a link contract;
 * every other query is auth-route data, not a room or a return destination. */
export function tenantRootLink(appId: string, search: string): string {
  identifier(appId);
  const pathname = `/${encodeURIComponent(appId)}`;
  if (typeof search !== 'string' || !search) return pathname;
  try {
    const link = parseTenantLink(`${pathname}${search}`, appId);
    return link.tenantId === null ? pathname : qualifyTenantLink(pathname, appId, link.tenantId);
  } catch {
    return pathname;
  }
}

/** Qualify an already encoded App address — a walk pathname, and the App's
 * own parameters after it — without changing its query/key text: the
 * selector goes last, so the address reads as the App's, then whose. */
export function qualifyTenantLink(address: string, appId: string, tenantId: string): string {
  if (typeof address !== 'string') invalid();
  const separator = address.indexOf('?');
  const pathname = checkedPath(separator < 0 ? address : address.slice(0, separator), appId);
  identifier(tenantId);
  const selector = new URLSearchParams(tenantId === PLATFORM_TENANT_ID ? { realm: 'platform' } : { tenant: tenantId }).toString();
  if (separator < 0) return `${pathname}?${selector}`;
  const own = address.slice(separator + 1);
  // The App's parameters, and never a selector of their own.
  const read = own ? parseTenantLink(`${pathname}?${own}`, appId) : undefined;
  if (!read || read.tenantId !== null || read.search !== own) invalid();
  return `${pathname}?${own}&${selector}`;
}
