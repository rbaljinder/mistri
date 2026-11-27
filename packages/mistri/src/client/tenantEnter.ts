/**
 * Lightweight first-paint tenant entry (`POST /api/tenant/enter`) split from
 * tenantBrowser.ts so appShell.js can fire the network request without waiting
 * for the full tenant shell, chooser, navigation, and suspension-overlay UI
 * modules to parse first.
 */
import { PLATFORM_TENANT_ID } from '../shared/tenantContext.js';
import { enterAddress, parseTenantLink } from './tenantLink.js';
import { enterFirst } from './tenantTransport.js';

export const KEPT_TENANT_STORAGE_KEY = 'mistri.tenant-context';

/** What this tab last held for `appId`, before who-am-I has answered: only to ask to re-enter. */
export function keptFor(appId: string): { readonly tenantId: string; readonly tabId: string } | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEPT_TENANT_STORAGE_KEY) ?? 'null') as {
      appId?: unknown;
      tenantId?: unknown;
      tabId?: unknown;
    } | null;
    return value &&
      value.appId === appId &&
      typeof value.tenantId === 'string' &&
      value.tenantId !== PLATFORM_TENANT_ID &&
      typeof value.tabId === 'string'
      ? { tenantId: value.tenantId, tabId: value.tabId }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page's first request, for a tenant App's address: entering, whose answer is who-am-I's too
 * (tenantTransport.ts `enterFirst`). The look the page takes once it has established who is signed in is that
 * request's answer, not another. Undefined for an address that names no entry, or one the host did not answer so.
 */
export async function enterFirstAt(appId: string, location: string): Promise<Record<string, unknown> | undefined> {
  let link;
  try {
    link = parseTenantLink(location, appId);
  } catch {
    return undefined;
  }
  return enterFirst(appId, enterAddress(link), link.tenantId ?? undefined, keptFor(appId));
}
