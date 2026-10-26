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
export function readFreshness(
  request: Pick<IncomingMessage, 'headers'>,
  response: Pick<ServerResponse, 'headersSent' | 'getHeader' | 'setHeader'>,
  base: string,
  now: () => number = Date.now,
): ReadContext {
  const bearer = /^Bearer\s+(\S+)/i.exec(request.headers.authorization ?? '')?.[1];
  if (bearer) return { fresh: false, key: `bearer:${createHash('sha256').update(bearer).digest('base64url').slice(0, 22)}` };
  const at = now();
  const fresh = cookieValues(request.headers.cookie, freshCookie()).some((value) => {
    const wrote = /^\d{1,16}$/.test(value) ? Number(value) : NaN;
    // A time ahead of this clock by more than a little is not one this server wrote.
    return wrote <= at + 1_000 && at - wrote < FRESH_READ_MS;
  });
  return {
    fresh,
    onWrite: () => {
      if (response.headersSent) return;
      const cookie = `${freshCookie()}=${now()}; Path=${base || '/'}; Max-Age=${FRESH_READ_MS / 1000}; HttpOnly; SameSite=Lax`;
      const prior = response.getHeader('set-cookie');
      response.setHeader('set-cookie', prior === undefined ? cookie : [...(Array.isArray(prior) ? prior : [String(prior)]), cookie]);
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
