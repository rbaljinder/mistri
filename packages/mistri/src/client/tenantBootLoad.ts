/**
 * The page's first reads in one request on the lease just opened
 * (shared/tenantBoot.ts): the runtime, the App, its pages and schema, the
 * bell's count and the reads of the room at `path` and `search` (the inside
 * address). Each answer is held as the page's own (kit firstPaint.ts), for the
 * request that asks it on this same context to take once (tenantTransport.ts
 * `tenantReadApi`). Whatever the boot cannot say — refused, failed, a support
 * lease, a reply that does not attest this lease — leaves the shell to ask as
 * it always did.
 *
 * Its own module, loaded with the tenant's flows (tenantShell.js): the
 * transport every first paint carries holds only what takes an answer.
 */
import { adoptFirstPaint } from '@mistriwork/kit/client/firstPaint.js';
import type { FirstPaintData } from '@mistriwork/engine/shared/firstPaint.js';
import type { TenantContextReply } from '../shared/tenantContext.js';
import { carriedOn, tenantBootReply } from './tenantTransport.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export async function loadTenantBoot(path: string, search: string): Promise<void> {
  try {
    const reply = await tenantBootReply(path, search);
    if (reply) adoptTenantBoot(reply.value, reply.owner);
  } catch {
    /* The shell asks each read itself. */
  }
}

/**
 * A boot's answers, held as the page's own on `owner`'s context: asked on the lease (`loadTenantBoot`), or carried
 * by the request that opened it (`/api/tenant/enter`, tenantBrowser.ts), which the transport has already checked
 * attests that lease.
 */
export function adoptTenantBoot(value: Record<string, unknown>, owner: TenantContextReply): void {
  const adopted: FirstPaintData = { reads: {}, items: {} };
  for (const [key, read] of Object.entries(object(value.reads) ? value.reads : {})) {
    if (!object(read) || !object(read.body)) continue;
    carriedOn(read.body, owner);
    adopted.reads[key] = { body: read.body, account: owner.accountId, ...(typeof read.reads === 'string' ? { reads: read.reads } : {}) };
  }
  for (const [key, item] of Object.entries(object(value.items) ? value.items : {})) {
    if (object(item) && item.body !== undefined) adopted.items[key] = { body: item.body, account: owner.accountId };
  }
  adoptFirstPaint(adopted);
}
