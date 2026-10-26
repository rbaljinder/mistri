/**
 * `POST /api/auth/embed/exchange { assertion }`: a host's signed assertion
 * (assertion.ts) exchanged for the App's ordinary session.
 *
 * Mounted inside the App's auth routes (auth.ts), so it is the same path
 * standalone, behind a proxy's base path, mounted in a host and on a tenant
 * App's server, and every one of those doors has already checked the Host.
 *
 * Two answers, by where the page is:
 *
 *   - **Same origin** (the host proxies the App, or mounts it): the session
 *     cookie, exactly as a password sign-in sets it. Nothing about the
 *     existing CSRF line changes: the request carries the page's own Origin.
 *   - **Another origin** in an issuer's `origins`: no cookie — a third-party
 *     cookie is blocked or partitioned in every browser, and one that worked
 *     would be a CSRF door — but `{ token, expiresAt }`, a bearer the page
 *     keeps in memory and sends back as `Authorization: Bearer`. It is good
 *     for an hour, only from that origin, and only on the App's browser
 *     routes (crossOrigin.ts); the host's next assertion is the refresh.
 *
 * Login CSRF — a victim's browser made to exchange the attacker's assertion —
 * is closed three ways: the body is JSON (a cross-site form cannot send it
 * without a preflight nobody answers), the Origin is required, and the
 * assertion names the origin it was minted for.
 *
 * `POST /api/auth/embed/sign-out` ends the session either way: the cookie's
 * on the same origin, the bearer's from another. A host whose own session
 * ended calls it, so the App's does not outlive it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ownOrigin, type ProxyRange } from '@mistriwork/engine/server/http/trust.js';
import { clientAddress, limitKey } from '@mistriwork/engine/server/http/rateLimit.js';
import { signInState } from '../auth/signInState.js';
import type { Jose } from '../auth/identityProviders.js';
import { EmbedRefusal, verifyEmbedAssertion, type EmbedAssertion, type EmbedIssuer } from './assertion.js';
import { corsHeaders } from './crossOrigin.js';

/** How long a cross-origin bearer is good for, whatever the session's own lifetime. */
const EMBED_BEARER_LIFETIME_MS = 3_600_000;
const MAX_BODY = 16 * 1024;
/* The exchange's budget, per issuer and client address: counted where Better
   Auth counts its own sign-in budget (signInState.consume), so instances
   behind one load balancer that share a cache spend one. A host's page
   exchanges once per load, and a bearer is refreshed hourly: thirty a minute
   leaves room for an office behind one address, and none for guessing. */
export const EMBED_EXCHANGE_BUDGET = Object.freeze({ window: 60, max: 30 });

/** What the App's sign-in machinery made of an assertion (auth.ts). */
interface EmbedSession {
  readonly accountId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  /** The Set-Cookie lines that carry it, as any sign-in's would. */
  readonly cookies: readonly string[];
  /** The session cookie's value alone: what a bearer stands for. It is never handed to a page. */
  readonly token: string;
}

interface EmbedExchangeOptions {
  readonly appId: string;
  readonly issuers: readonly EmbedIssuer[];
  readonly jose: Jose;
  /** Find or make the account, and open its session. Throws an EmbedRefusal when the account may not sign in. */
  readonly signIn: (assertion: EmbedAssertion, userAgent: string | undefined, lifetimeMs?: number) => Promise<EmbedSession>;
  /** End a session by its cookie value. */
  readonly endSession: (token: string) => Promise<void>;
  /** The ordinary sign-out, for a cookie on the same origin: its Set-Cookie lines. */
  readonly signOutCookie: (req: IncomingMessage) => Promise<readonly string[]>;
  /** Spend an assertion's id in the auth store (ledger.ts): true the first time. */
  readonly spend: (issuer: string, jti: string, until: number) => Promise<boolean>;
  /** The proxies whose X-Forwarded-For names the client (`--trust-proxy`); loopback always. */
  readonly trustedProxies?: readonly ProxyRange[];
}

interface BearerEvidence {
  origin: string;
  sessionId: string;
  /** The session cookie's value this bearer stands for, kept server side only: the page holds the opaque bearer, never this. */
  cookie: string;
}

const bearerKey = (token: string) => createHash('sha256').update(token).digest('base64url');

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | readonly string[]> = {}): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value as string | string[]);
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new EmbedRefusal(413, 'body_too_large', 'That is not one assertion.');
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* said below */
  }
  throw new EmbedRefusal(400, 'body_invalid', 'Send { "assertion": "<the host\'s signed assertion>" }.');
}

/** A request's single Origin, or undefined. */
const originOf = (req: IncomingMessage): string | undefined => (typeof req.headers.origin === 'string' ? req.headers.origin : undefined);

/** The bearer a request carries, or undefined. */
function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.slice(0, 7).toLowerCase() !== 'bearer ') return undefined;
  const token = header.slice(7).trim();
  return token && token.length <= 1024 && !/[\s;,]/.test(token) ? token : undefined;
}

export function createEmbedExchange(options: EmbedExchangeOptions) {
  const origins = new Set(options.issuers.flatMap((issuer) => issuer.config.origins));

  /** The session a bearer from `origin` stands for, when this App issued it to that origin and it is still good. */
  const bearerSession = async (token: string, origin: string | undefined): Promise<BearerEvidence | undefined> => {
    if (!origin || !origins.has(origin)) return undefined;
    const kept = await signInState.read<BearerEvidence>('embed-bearer', bearerKey(token));
    return kept && kept.origin === origin && typeof kept.sessionId === 'string' && typeof kept.cookie === 'string' ? kept : undefined;
  };

  const exchange = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = originOf(req);
    const sameOrigin = origin !== undefined && ownOrigin(req);
    const crossOrigin = !sameOrigin && origin !== undefined && origins.has(origin);
    const cors = crossOrigin ? corsHeaders(origin!) : {};
    try {
      if (req.method !== 'POST') throw new EmbedRefusal(405, 'method', 'POST the assertion.');
      /* A browser always says where a POST came from; one that does not is
         not the page the assertion was made for. */
      if (!origin) throw new EmbedRefusal(403, 'origin_required', 'The exchange is made from the page the assertion was made for.');
      if (!sameOrigin && !crossOrigin) throw new EmbedRefusal(403, 'origin_refused', 'This App takes no assertion from that page.');
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw new EmbedRefusal(415, 'json_required', 'The exchange takes application/json.');
      const body = await readJson(req);
      if (typeof body.assertion !== 'string')
        throw new EmbedRefusal(400, 'body_invalid', 'Send { "assertion": "<the host\'s signed assertion>" }.');
      const address = limitKey(clientAddress(req, options.trustedProxies));
      const assertion = await verifyEmbedAssertion(body.assertion, {
        appId: options.appId,
        origin,
        issuers: options.issuers,
        jose: options.jose,
        admit: async (issuer) => {
          const budget = await signInState.consume(`embed:${issuer.config.name}:${address}`, EMBED_EXCHANGE_BUDGET);
          if (!budget.allowed) {
            throw new EmbedRefusal(429, 'rate_limited', 'Too many sign-ins from here. Try again shortly.', budget.retryAfter ?? 60);
          }
        },
        spend: (issuer, jti, until) => options.spend(issuer.config.name, jti, until),
      });
      const ua = req.headers['user-agent'];
      /* Across origins the session is its own, made to last as long as the
         bearer: the page never holds the cookie's value, and a bearer replayed
         from elsewhere as a cookie meets a session that has lapsed. */
      const session = await options.signIn(
        assertion,
        typeof ua === 'string' ? ua : undefined,
        sameOrigin ? undefined : EMBED_BEARER_LIFETIME_MS,
      );
      if (sameOrigin) {
        reply(res, 200, { signedIn: true, accountId: session.accountId, expiresAt: session.expiresAt }, { 'set-cookie': session.cookies });
        return;
      }
      const expiresAt = Math.min(session.expiresAt, Date.now() + EMBED_BEARER_LIFETIME_MS);
      const bearer = randomBytes(32).toString('base64url');
      await signInState.put(
        'embed-bearer',
        bearerKey(bearer),
        { origin: origin!, sessionId: session.sessionId, cookie: session.token } satisfies BearerEvidence,
        expiresAt,
      );
      reply(res, 200, { signedIn: true, accountId: session.accountId, token: bearer, expiresAt }, cors);
    } catch (error) {
      if (!(error instanceof EmbedRefusal)) throw error;
      reply(
        res,
        error.status,
        { error: error.message, code: error.code },
        {
          ...cors,
          ...(error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}),
        },
      );
    }
  };

  const signOut = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = originOf(req);
    const sameOrigin = origin !== undefined && ownOrigin(req);
    const cors = !sameOrigin && origin !== undefined && origins.has(origin) ? corsHeaders(origin) : {};
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST to sign out.', code: 'method' }, cors);
    const token = bearerOf(req);
    if (token) {
      const kept = await bearerSession(token, origin);
      if (!kept) return reply(res, 401, { error: 'That is not a session this App gave this page.', code: 'bearer_refused' }, cors);
      await signInState.remove('embed-bearer', bearerKey(token));
      await options.endSession(kept.cookie);
      return reply(res, 200, { signedOut: true }, cors);
    }
    // A cookie is only ever ended from its own page: another page asking is the CSRF this line exists for.
    if (!sameOrigin) return reply(res, 403, { error: "Sign out from the App's own page.", code: 'origin_refused' }, cors);
    const cookies = await options.signOutCookie(req);
    reply(res, 200, { signedOut: true }, { 'set-cookie': cookies });
  };

  return {
    origins: origins as ReadonlySet<string>,
    exchange,
    signOut,
    /** The session cookie a bearer stands for, when it is one this App issued to the request's origin; undefined otherwise. */
    async bearer(req: IncomingMessage): Promise<string | undefined> {
      const token = bearerOf(req);
      return token ? (await bearerSession(token, originOf(req)))?.cookie : undefined;
    },
  };
}
