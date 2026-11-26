/**
 * In-App SPA link resolution: decides whether an `<a href>` target belongs to
 * the currently mounted App shell so clicking it navigates in-place via
 * `navFollow()` instead of unloading the document and showing the startup splash.
 */
import { inside, shownUnplaced } from './addressMount.js';
import { sessionIdentity } from './sessionIdentity.js';
import { shell } from './shellMode.js';

const ROOT_NON_SPA = new Set([
  'api',
  'assets',
  '_mistri',
  'healthz',
  'readyz',
  'robots.txt',
  'sitemap.xml',
  'sign-in',
  'sign-out',
  'auth',
  'oauth',
  'scim',
  'tenant',
  'embed',
]);

const APP_NON_SPA = new Set(['sign-in', 'sign-out', 'form', '_components', 'embed', 'api', 'public', 'intake']);

/**
 * Returns the SPA href to pass to `navFollow()` if `rawHref` targets an in-App
 * route for the currently active App (and current tenant when in a tenant
 * session), or `null` if the browser should perform a normal navigation.
 */
export function resolveInAppSpaHref(rawHref: string | null | undefined): string | null {
  if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('//') || rawHref.startsWith('/\\')) return null;
  if (!shell().inApp()) return null;

  let external: string;
  if (rawHref.startsWith('/')) {
    external = rawHref;
  } else {
    if (typeof window === 'undefined') return null;
    try {
      const url = new URL(rawHref, window.location.href);
      if (url.origin !== window.location.origin) return null;
      external = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }

  const hashAt = external.indexOf('#');
  const beforeHash = hashAt < 0 ? external : external.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : external.slice(hashAt);

  const internal = inside(beforeHash);
  if (internal === undefined) return null;

  const queryAt = internal.indexOf('?');
  const rawPath = queryAt < 0 ? internal : internal.slice(0, queryAt);
  const query = queryAt < 0 ? '' : internal.slice(queryAt);
  const segments = rawPath.split('/').filter(Boolean);
  if (segments.length > 0 && ROOT_NON_SPA.has(segments[0])) return null;

  const appId = (shell().app() as { id?: string } | null)?.id;
  if (appId) {
    const encoded = encodeURIComponent(appId);
    if (segments.length === 0 || (segments[0] !== appId && segments[0] !== encoded)) return null;
    if (segments.length > 1 && APP_NON_SPA.has(segments[1])) return null;
  }

  const { tenant } = sessionIdentity();
  const tenantLinks = shell().tenantLinks;
  if (tenant && tenantLinks) {
    // Normalize trailing slashes on sub-paths (e.g. `/app/items/` -> `/app/items`)
    // so `qualifyTenantLink` does not reject the path and trigger a tenant reload.
    const cleanPath = segments.length > 0 ? `/${segments.join('/')}` : rawPath;
    const cleanQuery = query === '?' ? '' : query;
    const candidate = `${cleanPath}${cleanQuery}`;
    try {
      const parsed = tenantLinks.parse(candidate, tenant.appId);
      if (parsed.tenantId !== null) {
        return parsed.tenantId === tenant.tenantId ? `${external}` : null;
      }
      return `${shownUnplaced(tenantLinks.qualify(candidate, tenant.appId, tenant.tenantId))}${hash}`;
    } catch {
      return null;
    }
  }

  return external;
}
