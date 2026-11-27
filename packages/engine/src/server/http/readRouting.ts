/**
 * Which body routes may read from a replica (packages/engine/src/adapters/replicas.ts).
 *
 * Lag-tolerant: a list's page and its counts (`/api/query`, `/api/run`,
 * `/api/view/run`, `/api/count`, `/api/counts`), a dashboard's breakdowns
 * (`/api/breakdown`, `/api/breakdowns`) and an export (`/api/export`) —
 * the Workbench grid and an App's lists, search and charts all arrive as
 * these. A row a moment old is what anyone reading a list already accepts:
 * it was a moment old by the time it was drawn.
 *
 * Everything else reads the primary, and so does a read of one row
 * (`limit: 1`): that is a record's own read — the record page, the
 * Workbench record, a section's probe — and a record is where a person
 * looks for what they just saved. A composed record page is pinned whole
 * (handler.ts), related lists and all. Commands, writes, the catalog,
 * the stores, raw SQL and the MCP tools never ask for a replica.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FRESH_READ_MS, type ReadContext } from '../../adapters/replicas.js';
import { product } from '../product.js';

const LAG_TOLERANT = new Set([
  '/api/query',
  '/api/run',
  '/api/view/run',
  '/api/count',
  '/api/counts',
  '/api/breakdown',
  '/api/breakdowns',
  '/api/export',
]);

/** Whether the POST `path` with `body` may read from a replica. */
export function toleratesLag(path: string, body: Readonly<Record<string, unknown>>): boolean {
  if (!LAG_TOLERANT.has(path)) return false;
  const view = body.view && typeof body.view === 'object' ? (body.view as { limit?: unknown }) : undefined;
  /* A batch carries a free-form page's views (`items[].view`): one that asks for one row goes where it would alone. */
  if (path === '/api/breakdowns' && Array.isArray(body.items)) {
    const one = body.items.some((item: unknown) => {
      const asked = item && typeof item === 'object' ? (item as { view?: unknown }).view : undefined;
      return !!asked && typeof asked === 'object' && !toleratesLag('/api/view/run', asked as Record<string, unknown>);
    });
    if (one) return false;
  }
  return body.limit !== 1 && view?.limit !== 1;
}

/** The cookie a write sets so the same browser's next reads go to the primary, in the running product's name. */
export const freshCookie = (): string => `${product()}_fresh`;

/**
 * The read-your-write context for one request (replicas.ts `readsAs`).
 *
 * A browser carries the marker: a write sets `<product>_fresh=<write time>` (`mistri_fresh`, or `tablewalk_fresh` in the browser)
 * for FRESH_READ_MS on the App's base path, and a request that brings one
 * back within that time reads the primary. It needs no shared state, so it
 * holds whichever pod the next request reaches, and each visitor — signed
 * in or not — has their own. It is HttpOnly and SameSite=Lax like the
 * other cookies here, and never Secure-only: it holds a time, not a
 * secret, and a forged or stolen one buys nothing but primary reads for
 * ten seconds. A caller sending a bearer token has no cookie jar, so its
 * writes are remembered in this process under a digest of the token.
 */
const MAX_FRESH_SCOPES = 8;
const SAFE_SCOPE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function parseFreshMarkers(values: readonly string[], at: number): { fresh: boolean; freshScopes: Map<string, number> } {
  let fresh = false;
  const freshScopes = new Map<string, number>();
  for (const raw of values) {
    if (/^\d{1,16}$/.test(raw)) {
      const wrote = Number(raw);
      // A time ahead of this clock by more than a little is not one this server wrote.
      if (wrote <= at + 1_000 && at - wrote < FRESH_READ_MS) fresh = true;
      continue;
    }
    for (const part of raw.split(',')) {
      const sep = part.lastIndexOf(':');
      if (sep <= 0) continue;
      const scope = part.slice(0, sep);
      const stamp = part.slice(sep + 1);
      if (!SAFE_SCOPE_RE.test(scope) || !/^\d{1,16}$/.test(stamp)) continue;
      const wrote = Number(stamp);
      if (wrote <= at + 1_000 && at - wrote < FRESH_READ_MS) {
        const prior = freshScopes.get(scope);
        if (prior === undefined || wrote > prior) freshScopes.set(scope, wrote);
      }
    }
  }
  return { fresh, freshScopes };
}

function serializeFreshScopes(scopes: ReadonlyMap<string, number>, at: number): string {
  const active = [...scopes.entries()]
    .filter(([, wrote]) => at - wrote < FRESH_READ_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FRESH_SCOPES);
  return active.map(([scope, wrote]) => `${scope}:${wrote}`).join(',');
}

export function readFreshness(
  request: Pick<IncomingMessage, 'headers'>,
  response: Pick<ServerResponse, 'headersSent' | 'getHeader' | 'setHeader'>,
  base: string,
  now: () => number = Date.now,
): ReadContext {
  const bearer = /^Bearer\s+(\S+)/i.exec(request.headers.authorization ?? '')?.[1];
  if (bearer) return { fresh: false, key: `bearer:${createHash('sha256').update(bearer).digest('base64url').slice(0, 22)}` };
  const at = now();
  const { fresh, freshScopes } = parseFreshMarkers(cookieValues(request.headers.cookie, freshCookie()), at);
  return {
    fresh,
    freshScopes,
    onWrite: (scope?: string) => {
      if (response.headersSent) return;
      const writtenAt = now();
      let value: string;
      if (scope !== undefined && SAFE_SCOPE_RE.test(scope) && !fresh) {
        freshScopes.set(scope, writtenAt);
        value = serializeFreshScopes(freshScopes, writtenAt) || String(writtenAt);
      } else {
        value = String(writtenAt);
      }
      const cookie = `${freshCookie()}=${value}; Path=${base || '/'}; Max-Age=${FRESH_READ_MS / 1000}; HttpOnly; SameSite=Lax`;
      const prior = response.getHeader('set-cookie');
      const namePrefix = `${freshCookie()}=`;
      const existing = prior === undefined ? [] : (Array.isArray(prior) ? prior : [String(prior)]).filter((c) => !c.startsWith(namePrefix));
      response.setHeader('set-cookie', existing.length ? [...existing, cookie] : cookie);
    },
  };
}

function cookieValues(header: string | undefined, name: string): string[] {
  return (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
}
