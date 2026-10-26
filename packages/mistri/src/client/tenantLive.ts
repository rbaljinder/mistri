/**
 * The live stream of a tenant's member, sent on the lease the page holds now.
 *
 * Apart from tenantTransport.ts so that the first page, which has no use for
 * a stream, does not carry it; the lease checks are that module's own. An
 * answer is the lease's only if it says so, as a read's must (`owns`).
 */
import { TENANT_HTTP_HEADERS as names } from '../shared/tenantContext.js';
import { captureSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { owns, selected, selector } from './tenantTransport.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/** `GET /api/live` for the current lease, or a throw where there is none (the caller waits for one). */
export async function tenantLiveRequest(after: string | undefined, signal: AbortSignal): Promise<Response> {
  const snapshot = captureSessionIdentity();
  const lease = selected(snapshot);
  const query = new URLSearchParams({ app: lease.appId, ...selector(lease.tenantId) });
  if (after) query.set('after', after);
  const response = await fetchServer(`/api/live?${query}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: {
      [names.account]: snapshot.accountId!,
      [names.app]: snapshot.appId!,
      [names.tab]: lease.tabId,
      [names.context]: lease.context,
      [names.revision]: String(lease.revision),
    },
  });
  if (response.ok && !owns(response.headers, lease)) {
    void response.body?.cancel();
    throw new Error('live-lease-mismatch');
  }
  return response;
}
