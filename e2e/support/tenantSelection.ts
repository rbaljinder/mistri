/**
 * A tab's first lease reaches it in one of three answers. /api/tenant/enter enters a sole membership as the page
 * loads, and, where the page asks who it is in that same enter (the `mistri-tenant-enters` meta), the tenant of
 * several that the address names or the tab kept (mistri shared/tenantBoot.ts `enteredTenant`): its answer carries
 * the lease beside discovery (`entered.context`), with the owner headers /open would send, and the tenant's boot
 * (`entered.boot`). Otherwise a member of several enters with no chooser drawn (mistri client/tenantBrowser.ts
 * `preferred`) by /api/tenant/context/resume where the tab kept a context for that tenant, else by
 * /api/tenant/context/open, the same /open a click on the chooser asks. A spec waiting for "the selection" waits for
 * any of them.
 */
import type { Page, Request, Response } from '@playwright/test';
import { expect } from './harness.js';
import { TENANT_HTTP_HEADERS, type TenantContextReply } from '../../packages/mistri/src/shared/tenantContext.js';

/** Every route, for `page.route`: holding the selection holds whichever of them delivers it. */
export const selectionRoute = '**/api/tenant/{context/open,context/resume,enter}?*';

/**
 * The page's first /enter, asked before it knows who is signed in and answered with who-am-I (mistri
 * client/tenantTransport.ts `enterFirst`): it names no account, where every later one names the account the page has
 * established. Refusing it in the network leaves the page as it was before that fold, asking who-am-I first and
 * entering after, the order in which a person can act on their account while the selection is still on its way.
 */
export function entersBeforeIdentity(request: Request): boolean {
  return new URL(request.url()).pathname === '/api/tenant/enter' && !request.headers()[TENANT_HTTP_HEADERS.account];
}

/** An /enter that found several tenants (or none) entered nothing: the page's /open or /resume is the selection. */
export async function isSelection(response: Response): Promise<boolean> {
  if (response.request().method() !== 'POST') return false;
  const path = new URL(response.url()).pathname;
  if (path === '/api/tenant/context/open') return true;
  /* A resume the host refuses is followed by an /open, which is then the selection. */
  if (path === '/api/tenant/context/resume') return response.status() === 200;
  if (path !== '/api/tenant/enter' || response.status() !== 200) return false;
  const body: unknown = await response.json().catch(() => undefined);
  return typeof body === 'object' && body !== null && 'entered' in body;
}

/** The lease a selection answered with, whichever route answered. */
export async function leaseOfSelection(response: Response): Promise<TenantContextReply> {
  const body = await response.json();
  return new URL(response.url()).pathname === '/api/tenant/enter' ? body.entered.context : body;
}

/** The shell is in `tenant` (as its header labels it), entered with no chooser left on the page. */
export async function expectEntered(page: Page, tenant: string): Promise<void> {
  await expect(page.locator('.tenant-control-host')).toContainText(`Tenant: ${tenant}`);
  await expect(page.getByRole('list', { name: 'Available tenants' })).toHaveCount(0);
}
