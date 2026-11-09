/**
 * A tab's first lease reaches it in one of three answers. A sole membership is entered as the page loads by
 * /api/tenant/enter, whose answer carries the lease beside discovery (`entered.context`), with the owner headers
 * /open would send. A member of several tenants whose address names one of theirs, or whose tab was in one before a
 * reload, enters it with no chooser drawn (mistri client/tenantBrowser.ts `preferred`): by /api/tenant/context/resume
 * where the tab kept a context for that tenant, else by /api/tenant/context/open, the same /open a click on the
 * chooser asks. A spec waiting for "the selection" waits for any of them.
 */
import type { Page, Response } from '@playwright/test';
import { expect } from './harness.js';
import type { TenantContextReply } from '../../packages/mistri/src/shared/tenantContext.js';

/** Every route, for `page.route`: holding the selection holds whichever of them delivers it. */
export const selectionRoute = '**/api/tenant/{context/open,context/resume,enter}?*';

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
