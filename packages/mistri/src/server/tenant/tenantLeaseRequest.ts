/** What a lease-bearing request says about itself, read the same way for a page's request and the assistant's proposal. */
import type { IncomingMessage } from 'node:http';
import { TENANT_HTTP_HEADERS as headers, type TenantContextAssertion } from '../../shared/tenantContext.js';
import { parseTenantSelector } from './tenantMembership.js';
import { exposed, revisionHeader, tenantHttpHeader } from './tenantWire.js';

/** The tenant a lease-bearing request selects: its URL's, never a header's. Platform and control requests that open
 * no tenant select none. */
export function tenantSelectors(url: URL, tenant: boolean): string[] {
  if (!tenant) return [];
  const selectors = [url.searchParams.get('tenant')!];
  parseTenantSelector(selectors);
  exposed(headers.tenant, selectors[0]);
  return selectors;
}

/** app/tenant are URL selectors, never competing request headers. App's response header is accepted only as a
 * matching stale-App precondition. */
export function ownerHeadersRefused(req: IncomingMessage, appId: string): boolean {
  return (
    tenantHttpHeader(req, headers.tenant) !== undefined ||
    tenantHttpHeader(req, headers.realm) !== undefined ||
    (tenantHttpHeader(req, headers.app) !== undefined && tenantHttpHeader(req, headers.app) !== appId)
  );
}

/** The lease a request bears, as its tab, context and revision headers assert it; none without a tab and a context.
 * A page's request and the assistant's proposal (`propose`) are both read here. */
export function leaseAssertion(req: IncomingMessage): TenantContextAssertion | undefined {
  const assertion = {
    tabId: tenantHttpHeader(req, headers.tab) ?? '',
    expectedContext: tenantHttpHeader(req, headers.context) ?? '',
    expectedRevision: revisionHeader(req),
  };
  return assertion.tabId && assertion.expectedContext ? assertion : undefined;
}
