/**
 * A host on another origin, talking to the App with an embed bearer
 * (exchange.ts). The rules that keep that from becoming a way around the
 * same-origin line every other request is held to (http/trust.ts):
 *
 *   - **CORS for named origins only.** An issuer's `origins` are the list;
 *     the reply names the one origin that asked (never `*`), says `Vary:
 *     Origin` so no cache hands it to another, and never allows credentials:
 *     the bearer is the credential, and a cookie is never read cross-origin.
 *   - **A bearer replaces the cookies.** A request admitted on a bearer is
 *     read as that session and nothing else the browser sent, so a cookie
 *     riding along cross-origin gains nothing. Without a bearer, a
 *     cross-origin request that changes something is refused as before.
 *   - **Browser routes only.** The App API and MCP have their own tokens;
 *     account administration, a member's API tokens, the native auth routes,
 *     the operator's routes and the database browser's never take a bearer,
 *     wherever it came from.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TENANT_HTTP_HEADERS } from '../../shared/tenantContext.js';
import { ownOrigin, vouchForOrigin } from '@mistriwork/engine/server/http/trust.js';

/** What the client reads off an App's answers (core.js), a tenant App's lease headers among them. */
/* `mistri-reads`: a cross-origin embed files its queries by the tables they read, as the App's own pages do (live/liveReads.ts). */
const EXPOSED = [...new Set(['x-mistri-search', 'mistri-reads', ...Object.values(TENANT_HTTP_HEADERS)])].join(', ');

/** What a server's auth runtime says of the hosts that sign people in to it (auth.ts). */
interface EmbedDoor {
  readonly origins: ReadonlySet<string>;
  readonly sessionCookie: string;
  /** The session cookie a bearer stands for, when it is one this App issued to the request's origin. */
  bearer(req: IncomingMessage): Promise<string | undefined>;
}

/**
 * The door both servers (http/gate.ts, tenant/tenantAuthenticatedHttp.ts)
 * hold a host's cross-origin requests to, before anything reads a session:
 *
 *   - a preflight from a listed origin is answered here (`'answered'`);
 *   - any other request from a listed origin that is not this server's own
 *     gets the CORS headers, and loses its cookies; on a browser route with a
 *     bearer issued to that origin, the bearer's session cookie takes their
 *     place, the Authorization header goes (it was this, not an API token),
 *     and the request is vouched for (`doorRefusal`) — `'bearer'`;
 *   - everything else is untouched (`'none'`), and held to the ordinary
 *     same-origin line.
 */
export async function embedDoor(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  embed: EmbedDoor,
): Promise<'answered' | 'bearer' | 'none'> {
  if (req.method === 'OPTIONS' && answerPreflight(req, res, path, embed.origins)) return 'answered';
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !embed.origins.has(origin) || ownOrigin(req)) return 'none';
  for (const [name, value] of Object.entries(corsHeaders(origin))) res.setHeader(name, value);
  const token = bearerRoute(path) ? await embed.bearer(req) : undefined;
  if (!token) {
    delete req.headers.cookie;
    return 'none';
  }
  req.headers.cookie = `${embed.sessionCookie}=${token}`;
  delete req.headers.authorization;
  admitted.add(req);
  vouchForOrigin(req);
  return 'bearer';
}

/* Requests the door admitted on a host's bearer. The door takes their
   Authorization header away (the session cookie now stands in for it), so a
   dispatcher further in that refuses a bearer asks `carriesBearer`, never the
   header, which by then says nothing. */
const admitted = new WeakSet<IncomingMessage>();

/**
 * Whether a request came with a bearer of any kind: an App API or MCP token
 * still in its Authorization header, or a host's embed bearer that the door
 * (`embedDoor`) exchanged for its session. What only a person at this App's
 * own page may do — open a support session, say — asks this.
 */
export function carriesBearer(req: IncomingMessage): boolean {
  return req.headers.authorization !== undefined || admitted.has(req);
}

/**
 * The door a server holds: the origins its App's hosts sign people in from
 * (auth.ts), with the ones a mounting host listed beside them
 * (`createHandler({ embed: { origins } })`, carried on `Bound`). A
 * listed origin with no issuer is answered CORS and has its cookies dropped
 * like any other, and holds no bearer: none was ever issued to it, so it
 * reads as a signed-out visitor and writes nothing.
 */
export function embedDoorFor(door: EmbedDoor | undefined, extra: readonly string[] | undefined): EmbedDoor | undefined {
  if (!extra?.length) return door;
  const origins = new Set([...(door?.origins ?? []), ...extra]);
  return door
    ? { origins, sessionCookie: door.sessionCookie, bearer: (req) => door.bearer(req) }
    : { origins, sessionCookie: '', bearer: async () => undefined };
}

export function corsHeaders(origin: string): Record<string, string> {
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': EXPOSED };
}

/* Routes a bearer never opens: another token's (the App API, MCP), the native
   auth and account routes, a member's own API tokens, a tenant's
   administration and invitations, saving an integration's settings and
   secrets, a tenant's branding, a platform operator's support sessions inside
   a tenant and their audit trail, the Suite console, and everything that is
   the operator's rather than a reader's. Matched on the routed path, a prefix
   and what is under it. A bearer lapses in an hour by design; the token routes
   would trade it for a credential that lasts up to a year, and the
   administration routes would let a script on the host page grant itself a
   membership or invite someone who keeps one.
   Support goes further than the rest: opening a session asks for a native
   sign-in no older than five minutes, and an exchanged bearer is always
   fresh, so a host whose assertions link verified addresses
   ("link-verified-email") could otherwise open a support session into any
   tenant for an operator whose address it named. */
const NOT_FOR_BEARERS = [
  '/api/auth',
  '/api/v1',
  '/api/mcp',
  '/api/accounts',
  '/api/tokens',
  '/api/tenant/administration',
  '/api/tenant/invitations',
  '/api/tenant/support',
  '/api/integrations/save',
  '/api/branding/save',
  '/api/console',
  '/api/connections',
  '/api/sql',
  '/api/ddl',
  '/api/queries',
  '/api/agent',
  '/api/operations',
  '/api/suite',
  '/api/inbound',
  '/api/apps',
  '/api/http',
];

/** Whether a bearer may stand for a session on this path. */
function bearerRoute(path: string): boolean {
  if (!path.startsWith('/api/') || path.includes('%') || path.includes('//')) return false;
  const lower = path.toLowerCase();
  return !NOT_FOR_BEARERS.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

const ALLOWED_HEADERS = /^(authorization|content-type|x-mistri-[a-z0-9-]+)$/;

/**
 * Answer a CORS preflight from one of `origins`, or say it is not one
 * (false), for the caller to answer as it would any other request. Only
 * what a browser route needs is allowed: the bearer, JSON, and mistri's
 * own `x-mistri-*` request headers.
 */
export function answerPreflight(req: IncomingMessage, res: ServerResponse, path: string, origins: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (req.method !== 'OPTIONS' || typeof origin !== 'string' || !origins.has(origin)) return false;
  const exchange = path === '/api/auth/embed/exchange' || path === '/api/auth/embed/sign-out';
  if (!exchange && !bearerRoute(path)) return false;
  const asked = String(req.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const method = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
  if (!['GET', 'HEAD', 'POST'].includes(method) || asked.some((name) => !ALLOWED_HEADERS.test(name))) {
    res.writeHead(403, { vary: 'Origin', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  res.writeHead(204, {
    ...corsHeaders(origin),
    'access-control-allow-methods': 'GET, HEAD, POST',
    ...(asked.length ? { 'access-control-allow-headers': asked.join(', ') } : {}),
    'access-control-max-age': '600',
    'cache-control': 'no-store',
  });
  res.end();
  return true;
}
