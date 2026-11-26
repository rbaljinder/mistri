/** A tenant session's in-App addresses: the one place a page's address gains the tenant's selector, whatever the mount. */
import { inside, shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';

/**
 * An in-App address as the shell writes it for this session: a tenant's carries its selector. Anything it cannot
 * read stays as given.
 *
 * The address is one a page says (`hrefFor`), so it is in the browser's spelling, and the selector's writer reads the
 * inside one (`/{app}/…`): an App served at the root says `/forecast`, which named no App to it, and the address
 * went out bare — another tenant's link to the shell, and a whole new document. So it is read inside, qualified, and
 * written out again, whatever the mount.
 */
export function tenantQualified(href: string): string {
  const { tenant } = sessionIdentity();
  const tenantLinks = shell().tenantLinks;
  if (!tenant || !tenantLinks) return href;
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  try {
    const within = inside(beforeHash);
    if (within === undefined) return href;
    const queryAt = within.indexOf('?');
    const rawPath = queryAt < 0 ? within : within.slice(0, queryAt);
    const rawQuery = queryAt < 0 ? '' : within.slice(queryAt);
    const segments = rawPath.split('/').filter(Boolean);
    const cleanPath = segments.length > 0 ? `/${segments.join('/')}` : rawPath;
    const cleanQuery = rawQuery === '?' ? '' : rawQuery;
    const candidate = `${cleanPath}${cleanQuery}`;
    const parsed = tenantLinks.parse(candidate, tenant.appId);
    if (parsed.tenantId !== null) return href;
    return `${shownUnplaced(tenantLinks.qualify(candidate, tenant.appId, tenant.tenantId))}${hash}`;
  } catch {
    return href;
  }
}
