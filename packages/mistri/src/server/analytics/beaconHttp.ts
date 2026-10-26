/**
 * `POST {mount}/_mistri/analytics`: the one door a browser's events use.
 *
 * Same-origin only, one JSON body of at most 20 events and 16 KB. The unit
 * is never read from the body: `resolveUnit` answers from the session or the
 * AN2 visitor cookie, and a request that sends Sec-GPC drops a visitor unit,
 * so its events count toward totals and join no funnel. The answer is always
 * 204 with nothing in it: a beacon learns nothing about what was kept. Each
 * client has a budget (429 past it), as a public form does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson } from '@mistriwork/engine/server/http/reply.js';
import { clientAddress, FixedWindowLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { ANALYTICS_BEACON_PATH } from '../../shared/appAnalytics.js';
import type { AnalyticsIngest, AnalyticsUnit } from './ingest.js';

const ANALYTICS_BEACON_BYTES = 16 * 1024;
/* Anyone who can reach the App can post a beacon, signed in or not: without a
   budget a loop could write rows into the store as fast as it could send. A
   page sends a few a minute; past the budget a beacon is answered 429 and kept
   nowhere. Evicting the stalest client keeps rotating addresses from shutting
   out new ones; the total bounds what they write together. */
const ANALYTICS_BEACON_WINDOWS = Object.freeze([{ limit: 300, ms: 60_000 }]);
const ANALYTICS_BEACON_TOTAL = Object.freeze([{ limit: 6_000, ms: 60_000 }]);

export function createAnalyticsBeaconHttp(options: {
  readonly mount: string;
  readonly bound: Bound;
  readonly ingest: AnalyticsIngest;
  /** The verified unit of this request, or null for none. Never from the body. */
  readonly resolveUnit: (req: IncomingMessage) => Promise<AnalyticsUnit | null> | AnalyticsUnit | null;
  /** Tests narrow the budget; one limiter per beacon otherwise. */
  readonly limiter?: Pick<FixedWindowLimiter, 'take'>;
}) {
  const path = `${options.mount}${ANALYTICS_BEACON_PATH}`;
  const limiter =
    options.limiter ?? new FixedWindowLimiter(ANALYTICS_BEACON_WINDOWS, Date.now, { total: ANALYTICS_BEACON_TOTAL, whenFull: 'evict' });
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.url ?? '').split('?')[0] !== path) return false;
    const reply = (status: number) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end();
    };
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new HttpError(405, 'Use POST.');
      }
      if (req.url !== path) throw new HttpError(400, 'No query selectors.');
      if (doorRefusal(req, options.bound, { writing: true, sameSite: true })) throw new HttpError(403, 'Same origin only.');
      const decision = limiter.take(clientAddress(req, options.bound.trustedProxies));
      if (!decision.ok) {
        res.setHeader('retry-after', String(decision.retryAfterSeconds));
        throw new HttpError(429, 'Too many beacons.');
      }
      const body = await readJson(req, ANALYTICS_BEACON_BYTES);
      let unit = await options.resolveUnit(req);
      if (unit?.kind === 'visitor' && req.headers['sec-gpc'] === '1') unit = null;
      await options.ingest.recordBeacon(body, unit);
      reply(204);
    } catch (error) {
      reply(error instanceof HttpError ? error.status : 503);
    }
    return true;
  };
}
