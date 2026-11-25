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
  const qualify = shell().tenantLinks?.qualify;
  if (!tenant || !qualify) return href;
  try {
    const within = inside(href);
    return within === undefined ? href : shownUnplaced(qualify(within, tenant.appId, tenant.tenantId));
  } catch {
    return href;
  }
}
