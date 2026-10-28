/**
 * A tab's first lease reaches it in one of two answers: a click on the chooser asks /api/tenant/context/open, and a
 * sole membership is entered as the page loads by /api/tenant/enter, whose answer carries the lease beside discovery
 * (`entered.context`), with the owner headers /open would send. A spec waiting for "the selection" waits for either.
 */
import type { Response } from '@playwright/test';
import type { TenantContextReply } from '../../packages/mistri/src/shared/tenantContext.js';

/** Both routes, for `page.route`: holding the selection holds whichever of them delivers it. */
export const selectionRoute = '**/api/tenant/{context/open,enter}?*';

/** An /enter that found several tenants (or none) entered nothing: the page's /open after a click is the selection. */
export async function isSelection(response: Response): Promise<boolean> {
  if (response.request().method() !== 'POST') return false;
  const path = new URL(response.url()).pathname;
  if (path === '/api/tenant/context/open') return true;
  if (path !== '/api/tenant/enter' || response.status() !== 200) return false;
  const body: unknown = await response.json().catch(() => undefined);
  return typeof body === 'object' && body !== null && 'entered' in body;
}

/** The lease a selection answered with, whichever route answered. */
export async function leaseOfSelection(response: Response): Promise<TenantContextReply> {
  const body = await response.json();
  return new URL(response.url()).pathname === '/api/tenant/enter' ? body.entered.context : body;
}
