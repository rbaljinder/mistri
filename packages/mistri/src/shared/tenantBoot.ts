/**
 * A tenant App's first page in one read on its lease (`POST /api/boot`).
 *
 * An ordinary App's page arrives with its first answers in it
 * (engine shared/firstPaint.ts). A tenant App's cannot: everything past
 * who-am-I is read on a lease, and the lease is opened by the page — a tab's
 * own context, never a cookie's — so the server has none to read on while it
 * sends the page. The shell asked the rest in rounds instead, each after the
 * last had answered: the runtime, then the App, its pages and its schema
 * together, then the first room's own reads (a field report measured five
 * waves past the lease, 4.1 s to a settled list on a remote database).
 *
 * So once the lease is open, the shell asks for the page in one read on it:
 * the server answers the runtime, the App, its pages and its schema on the one
 * context the read holds, plans the room the address opens exactly as an
 * ordinary App's first page plans it (server http/firstPaintRooms.ts), asks
 * each of the room's reads on the same context through the route its own
 * request reaches, and answers them all, each under the request it answers.
 * The client takes each answer as that request's reply, once
 * (kit client/firstPaint.ts), and asks anything else itself.
 *
 * An answer is keyed by the request exactly as the tenant transport sends it
 * (client tenantTransport.ts): the path with the lease's App and selector in
 * its query and the body without the App. `tenantReadAddress` is that rule,
 * one copy for the transport and the server.
 */
import { PLATFORM_TENANT_ID } from './tenantContext.js';

/** The page's reads in one: the runtime, the App, its pages and schema, and the room's own reads. */
export const TENANT_BOOT_PATH = '/api/boot';

/** The most an address may say, path and query together: past it the page asks for itself. */
const TENANT_BOOT_ADDRESS_MOST = 4096;

/**
 * A read's address as the tenant transport sends it: the path, its own query
 * without an `app`, then the lease's App, then its selector — a tenant's id,
 * or the platform realm.
 */
export function tenantReadAddress(target: string, appId: string, tenantId: string): string {
  const url = new URL(target, 'http://mistri.invalid');
  url.searchParams.delete('app');
  url.searchParams.set('app', appId);
  if (tenantId === PLATFORM_TENANT_ID) url.searchParams.set('realm', 'platform');
  else url.searchParams.set('tenant', tenantId);
  return `${url.pathname}${url.search}`;
}

/** A read's body as the tenant transport sends it: without the App, which the address names. */
export function tenantReadBody(body: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  const { app: _app, ...rest } = body;
  return rest;
}

/** What the boot is asked for: the page's inside address (shared/mount.ts), its path and its query string. */
interface TenantBootRequest {
  readonly path: string;
  readonly search: string;
}

/**
 * A person's tenants, and the page in the one they work in, in one request (`POST /api/tenant/enter`).
 *
 * Past who-am-I a tenant App's page asked the person's tenants (`/api/tenant/bootstrap`), then opened a lease in
 * the one it chose (`/api/tenant/context/open`), then read its page on that lease (`/api/boot`): three rounds one
 * after another, each its own admission, before a list could draw (a field report: 0.6 s of a 2.4 s list on a
 * database 23 ms away, the chooser never drawn). Someone in one tenant chooses nothing — the chooser enters a sole
 * membership at once (client tenantBrowser.ts) — so the page now asks for all three at once, and the host answers
 * them in the same order, each step the very function its own route runs: discovery, then the lease opened exactly
 * as `/open` opens it (or resumed as `/resume` resumes this tab's), then the boot read on that lease exactly as
 * `/api/boot` reads it. Anyone else — several tenants, the platform realm among them, none, a link naming a tenant
 * the person is not entered in — gets discovery's answer alone and the chooser, as before.
 */
export const TENANT_ENTER_PATH = '/api/tenant/enter';

/** What the page tells the host when it asks to enter: its address, the tenant a link names, the context this tab kept. */
interface TenantEnterRequest {
  readonly page: TenantBootRequest;
  /** The tenant the address names (`?tenant=`): entered only if it is the person's one. */
  readonly tenant?: string;
  /** The context this browser tab's last page let go (client tenantBrowser.ts `keep`), to resume where it is that tenant's. */
  readonly kept?: { readonly tenantId: string; readonly tabId: string };
}

const enterId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value === value.trim() && !/\p{Cc}/u.test(value);

/** Whether an enter request says what it may: a plannable address, and at most a named tenant and a kept context. */
export function tenantEnterRequest(input: Readonly<Record<string, unknown>>, appId: string): TenantEnterRequest | undefined {
  const { path, search, tenant, kept, ...rest } = input;
  if (Object.keys(rest).length) return undefined;
  const page = tenantBootRequest({ path, search }, appId);
  if (!page || (tenant !== undefined && (!enterId(tenant) || tenant === PLATFORM_TENANT_ID))) return undefined;
  const named = tenant === undefined ? {} : { tenant: tenant as string };
  if (kept !== undefined) {
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return undefined;
    const { tenantId, tabId, ...other } = kept as Record<string, unknown>;
    if (Object.keys(other).length || !enterId(tenantId) || tenantId === PLATFORM_TENANT_ID || !enterId(tabId)) return undefined;
    return { page, ...named, kept: { tenantId, tabId } };
  }
  return { page, ...named };
}

/**
 * The tenant a person is entered in without being asked: their one membership, where the platform realm is not a
 * choice too, and where the address names a tenant, that one. One rule for the chooser that enters it at once
 * (client tenantBrowser.ts) and the host that enters it in the same request as discovery (tenantHttp.ts).
 */
export function soleTenant(memberships: readonly string[], platform: boolean, named?: string): string | undefined {
  return memberships.length === 1 && !platform && memberships[0] !== PLATFORM_TENANT_ID && (named === undefined || named === memberships[0])
    ? memberships[0]
    : undefined;
}

/** Whether a boot request says an address it can plan: two strings within the bound, the path the App's own. */
export function tenantBootRequest(input: Readonly<Record<string, unknown>>, appId: string): TenantBootRequest | undefined {
  const { path, search } = input;
  if (typeof path !== 'string' || typeof search !== 'string' || path.length + search.length > TENANT_BOOT_ADDRESS_MOST) return undefined;
  if (/\p{Cc}/u.test(path + search) || path.includes('#') || search.includes('#')) return undefined;
  if (search !== '' && !search.startsWith('?')) return undefined;
  const first = path.split('/').filter(Boolean)[0];
  let named: string | undefined;
  try {
    named = first === undefined ? undefined : decodeURIComponent(first);
  } catch {
    return undefined;
  }
  return path.startsWith('/') && named === appId ? { path, search } : undefined;
}

/**
 * Reads asked in the same moment, past the first page, in one request (`POST /api/boot` with `reads`): a write's
 * refresh — the record's compose, the lists and counts it stands in, its verbs' questions — went out as six to eight
 * requests at once, each admitted on its own context and read on snapshots of its own, and on a small server they
 * queued for the read pool and the CPU together (a field report: 0.6 s to answer a save, then 2.6 s for the reads it
 * set off). The transport gathers whatever reads of one lease are asked in one moment (client tenantTransport.ts)
 * and the host answers each through the route its own request reaches, on the one context the request holds and one
 * snapshot, as the page's boot answers its own. Each answer is keyed as the boot's are, and only a success is
 * carried: any other read is asked alone and heard in its own words.
 *
 * Only reads: a path that writes, or that is answered anywhere but the read route (a command's availability), is
 * never asked here.
 */
export const TENANT_BATCH_READS: ReadonlySet<string> = new Set([
  '/api/query',
  '/api/count',
  '/api/counts',
  '/api/run',
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
  '/api/schema',
  '/api/runtime',
  '/api/app',
  '/api/pages',
  '/api/pages/suggested',
  '/api/pages/plan',
  '/api/pages/compose',
  '/api/references',
  '/api/record-history',
  '/api/inbox',
]);
const TENANT_BATCH_GETS: ReadonlySet<string> = new Set(['/api/schema', '/api/runtime', '/api/app', '/api/pages', '/api/pages/suggested']);

/** The most reads one batch carries: past it the transport sends another. */
export const TENANT_BATCH_MOST = 24;

/** One read of a batch: its method, its address as the tenant transport has it before the lease is named in it, its body. */
export interface TenantBatchRead {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

/** Whether a boot request is a batch whose every read is one a batch may carry, as each would be sent alone. */
export function tenantBatchRequest(input: Readonly<Record<string, unknown>>): readonly TenantBatchRead[] | undefined {
  const { reads, ...rest } = input;
  if (Object.keys(rest).length || !Array.isArray(reads) || reads.length < 1 || reads.length > TENANT_BATCH_MOST) return undefined;
  const asked: TenantBatchRead[] = [];
  for (const read of reads as unknown[]) {
    if (!read || typeof read !== 'object' || Array.isArray(read)) return undefined;
    const { method, path, body, ...other } = read as Record<string, unknown>;
    if (
      Object.keys(other).length ||
      (method !== 'GET' && method !== 'POST') ||
      typeof path !== 'string' ||
      path.length > TENANT_BOOT_ADDRESS_MOST
    )
      return undefined;
    if (/\p{Cc}/u.test(path) || path.includes('#') || !path.startsWith('/api/')) return undefined;
    const at = path.split('?')[0];
    if (!TENANT_BATCH_READS.has(at) || (method === 'GET') !== TENANT_BATCH_GETS.has(at)) return undefined;
    if (method === 'GET' ? body !== undefined : !body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    asked.push(method === 'GET' ? { method, path } : { method, path, body: body as Record<string, unknown> });
  }
  return asked;
}
