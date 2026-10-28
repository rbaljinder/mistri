/**
 * The assistant's requests, as its panel sends them. In an ordinary App they
 * are `api()`'s. In a tenant App they carry the tab's context lease and
 * nothing that names a tenant: the server recovers the lease and takes the
 * tenant from it alone (server tenant/tenantAssistant.ts), so a conversation
 * is always the current customer's. Kept in the assistant's own chunk.
 */
import { api } from '@mistriwork/kit/client/core.js';
import { captureSessionIdentity, captureTenantLease } from '@mistriwork/kit/client/sessionIdentity.js';
import { TENANT_HTTP_HEADERS as names } from '../../shared/tenantContext.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/** The account, and in a tenant App the tab's lease: what the server admits an assistant request by. */
export function assistantHeaders(): Record<string, string> {
  const identity = captureSessionIdentity();
  if (identity.mode !== 'authenticated' || !identity.accountId) return {};
  const lease = identity.tenantRequired ? captureTenantLease(identity) : undefined;
  return {
    [names.account]: identity.accountId,
    ...(lease && identity.appId
      ? { [names.app]: identity.appId, [names.tab]: lease.tabId, [names.context]: lease.context, [names.revision]: String(lease.revision) }
      : {}),
  };
}

/**
 * Whose conversations the panel shows: the account's, in the lease's tenant, so the history switches with the customer
 * and with the person. The panel is kept while the page is, and a conversation it last showed was reopened for whoever
 * signed in next in that tab, who could only be refused it.
 */
export function assistantOwner(): string {
  const identity = captureSessionIdentity();
  const tenant = (identity.tenantRequired && captureTenantLease(identity)?.tenantId) || '';
  return `${identity.accountId ?? ''}\n${tenant}`;
}

export async function assistantApi(path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!captureSessionIdentity().tenantRequired) return api(path as never, ...((body === undefined ? [] : [body]) as never[]));
  const res = await fetchServer(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...assistantHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value: { error?: unknown } | null = null;
  try {
    value = (await res.json()) as { error?: unknown };
  } catch {
    /* The status is all there is to say. */
  }
  if (!res.ok) throw Object.assign(new Error(typeof value?.error === 'string' ? value.error : `${res.status}`), { status: res.status });
  return value;
}
