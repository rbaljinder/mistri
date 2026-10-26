/** Private admission shared by the App API transports: the loopback bound
 * (unless the App and the operator both chose the network), the namespace
 * claim that keeps normalization aliases away from the cookie-authenticated
 * dispatcher, repeated Host/Origin refusal, Host/Origin trust, and the
 * process-local budgets. Each transport keeps its own error body. No
 * authentication or authority: a budget spent is never permission. */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { doorRefusal, forwardedClient, writes, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { FixedWindowLimiter } from '@mistriwork/engine/server/http/rateLimit.js';

/** Outstanding requests retained across adapter awaits, independent of arrivals. */
export const API_PENDING_LIMIT = 32;

/** The most unauthenticated requests one address may make a minute, whatever the token budget. */
const API_UNAUTHENTICATED_PER_MINUTE = 60;

const loopbackAddress = (address: string | undefined) => /^(localhost|127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(address ?? '');

/** Claim `/api/apps` and its normalization aliases too, so a raw parser refuses
 * them; they must never fall through to the cookie-authenticated dispatcher. */
export function claimsApiNamespace(raw: string): boolean {
  let namespace = raw.startsWith('/api/apps/');
  try {
    const path = new URL(raw, 'http://localhost').pathname;
    namespace ||= path === '/api/apps' || path.startsWith('/api/apps/');
  } catch {
    /* An unrelated malformed target belongs to the outer server. */
  }
  return namespace;
}

type Spent = Readonly<{ ok: true } | { ok: false; retryAfterSeconds: number }>;

/**
 * One App API's budgets, shared by every transport that answers it (reads,
 * commands, MCP over HTTP). Process-local only: a second process, or a
 * restart, counts afresh; shared cache or proxy quotas are not implied.
 *
 * - Each presented credential spends its own budget, `requestsPerMinute`.
 *   It is keyed by a digest of the whole credential, never by its token ID
 *   (which is printed and logged), so only the secret's holder can spend a
 *   token's budget — a forged secret under a real ID spends a budget of its
 *   own, and is charged to its address when the owner refuses it. A valid
 *   token is judged by this budget alone: nothing another credential or
 *   another client at its address does can spend it, so a shared NAT or
 *   proxy never locks an integration out. There is no ceiling across
 *   credentials for the same reason; the transports' pending limit bounds
 *   the work forged ones cost.
 * - Each address spends a second budget on what it does unauthenticated: a
 *   request with no credential, a credential the owner refuses (401), and the
 *   public document. Over it, those are 429 instead of 401 until its window
 *   rolls over; a request with a credential is still checked.
 *
 * `network`: the App declared `api.network` and the operator listens beyond
 * loopback. Peers off this machine are then admitted, and the address is the
 * one `forwardedClient` resolves (a forwarded header only from a trusted
 * proxy). Without it, only loopback peers are.
 */
export class ApiAdmission {
  readonly network: boolean;
  private readonly tokens: FixedWindowLimiter;
  private readonly unauthenticated: FixedWindowLimiter;

  constructor(
    readonly requestsPerMinute: number,
    options: Readonly<{ network?: boolean; now?: () => number }> = {},
  ) {
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 1000000)
      throw new Error('API transport configuration is unavailable.');
    this.network = options.network === true;
    const now = options.now ?? Date.now;
    this.tokens = new FixedWindowLimiter([{ limit: requestsPerMinute, ms: 60000 }], now, {
      maxClients: 4096,
      // A forgotten budget is a fresh one, never a refusal: a flood of forged
      // credentials cannot crowd a real token out of its own budget.
      whenFull: 'evict',
    });
    this.unauthenticated = new FixedWindowLimiter(
      [{ limit: Math.min(requestsPerMinute, API_UNAUTHENTICATED_PER_MINUTE), ms: 60000 }],
      now,
      { maxClients: 10000, whenFull: 'evict' },
    );
  }

  /** The credential's own budget, before the owner does any work for it. */
  spend(credential: string): Spent {
    const key = `token:${createHash('sha256').update(credential).digest('hex')}`;
    const decision = this.tokens.take(key);
    return decision.ok ? { ok: true } : { ok: false, retryAfterSeconds: decision.retryAfterSeconds };
  }

  /** One unauthenticated request from the address: refused credentials are counted after the fact. */
  charge(client: string): Spent {
    const decision = this.unauthenticated.take(client);
    return decision.ok ? { ok: true } : { ok: false, retryAfterSeconds: decision.retryAfterSeconds };
  }
}

/** Process-local only. Shared cache/proxy deployment support is not implied. */
export function apiAdmission(requestsPerMinute: number, options: Readonly<{ network?: boolean }> = {}): ApiAdmission {
  return new ApiAdmission(requestsPerMinute, options);
}

/** The bound a transport may be built on: loopback, or beyond it only when the
 * App declared `api.network` and this admission was made for the network. */
export function apiTransportBound(bound: Bound, admission: ApiAdmission, app: { api?: { network?: true } }): boolean {
  if (admission.network && app.api?.network !== true) return false;
  return admission.network || loopbackAddress(bound.host);
}

type ApiAdmitted = Readonly<
  { ok: true; client: string } | { ok: false; status: 400; code: 'invalid_request' } | { ok: false; status: 403; code: 'forbidden' }
>;

/** Decided before any credential is read: a repeated Host/Origin is ambiguous,
 * and a foreign peer (off the network), Host or Origin is refused. `client` is
 * the address a later unauthenticated request is charged to. */
export function admitApiRequest(req: IncomingMessage, bound: Bound, admission: ApiAdmission): ApiAdmitted {
  if (
    ['host', 'origin'].some((name) => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length > 1)
  )
    return { ok: false, status: 400, code: 'invalid_request' };
  if (
    (!admission.network && !loopbackAddress(req.socket.remoteAddress)) ||
    /* The bearer is the credential and no browser's: the Origin is checked on every request, a host's vouch never
       passes, and the body's type is the API's own reader's to refuse, in the API's own error shape. */
    doorRefusal(req, bound, { writing: writes(req), origin: 'always', json: false })
  ) {
    return { ok: false, status: 403, code: 'forbidden' };
  }
  return { ok: true, client: forwardedClient(req, bound.trustedProxies ?? []) };
}

/** Whether the request carries any Authorization header at all: the public
 * document answers only a request that presents no credential, so a bad one
 * is still refused rather than quietly ignored. */
export function presentsCredential(req: IncomingMessage): boolean {
  return req.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization');
}
