/**
 * The small parts the tenant request handler (tenantHttp.ts) is built from, which need nothing of its closure: how
 * a boot's read tells the tables it answered from, what counts as an answer a client can carry, which resource
 * reads are bounded, and the loaders as handed over.
 */
import type { PageLoader } from '../commands/pageLoaders.js';
import { isProxy } from 'node:util/types';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';

/* Where one read the page's boot carries says the tables it answered from (live/liveReads.ts), as its own
   request's `mistri-reads` header would have said them: each read apart, never the union of the boot's. */
export class ReadsTold {
  readonly headersSent = false;
  value: string | undefined;
  setHeader(_name: string, value: string): void {
    this.value = value;
  }
  removeHeader(): void {
    this.value = undefined;
  }
}

/** A reply the client takes as an answer: a success that says no error (engine http/firstPaint.ts `ok`). */
export const carriable = (reply: { status: number; body: unknown }): boolean =>
  reply.status >= 200 &&
  reply.status < 300 &&
  reply.body !== null &&
  typeof reply.body === 'object' &&
  !('error' in reply.body) &&
  !('errors' in reply.body && Array.isArray(reply.body.errors) && reply.body.errors.length > 0);

/** What discovery answers (`/api/tenant/bootstrap`): signed out, or the account's tenants with their names and marks. */
export type TenantDiscovery =
  | Readonly<{ status: 'signed_out' }>
  | Readonly<{
      status: 'ready';
      appId: string;
      accountId: string;
      memberships: readonly Readonly<{ tenantId: string; name?: string; sandbox?: true }>[];
      platform?: true;
    }>;
/* The resource reads whose every statement is the context's own and bounded: no file's bytes from object storage
   (FILE_READ_PATH), and each answered from the database alone (withBoundedReads). */
export const BOUNDED_READS: ReadonlySet<string> = new Set([
  '/api/query',
  '/api/count',
  '/api/counts',
  '/api/run',
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
]);

/* The loaders as handed over, captured once: own names, each a defineLoader's object, never a proxy. */
export function capturedLoaders(value: unknown): Readonly<Record<string, PageLoader>> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return denyTenant();
  const held: Record<string, PageLoader> = Object.create(null);
  for (const [name, loader] of Object.entries(value)) {
    if (!loader || typeof loader !== 'object' || isProxy(loader) || typeof (loader as PageLoader).load !== 'function') return denyTenant();
    held[name] = loader as PageLoader;
  }
  return Object.freeze(held);
}
