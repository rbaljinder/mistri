/* A tenant service token's change stream: `GET /api/live` with a bearer.

   A member's stream rides their lease (tenantHttp.ts); a program holding a
   tenant service token has no lease, so it is admitted here, as the App API
   admits it: the same door, budget and challenge, then the owner's own
   observation of the token. The stream is the member stream in every other
   respect — the same hub, limits, 30 s re-check and replay — and its re-check
   observes the token again, so a revoked token, a suspended tenant or a role
   taken out of `api.service` ends it at the next one. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { AppDef } from '../../shared/app.js';
import { readApiBearerHeader } from '../api/apiBearerHeader.js';
import { admitApiRequest, presentsCredential, type ApiAdmission } from '../api/apiHttpAdmission.js';
import { ApiReadFailure } from '../api/apiReadFailure.js';
import type { createTenantApiOwner } from '../api/tenantApiReadOwner.js';
import { bearerChallenge, presentsAuthorization } from '../auth/oauthResource.js';
import { liveOffResources, liveSyncOn } from '../live/liveBinding.js';
import { answerLiveOff, LIVE_PATH } from '../live/liveRoute.js';
import { endLiveStreams } from '../live/liveStream.js';
import { tenantLiveHub } from './tenantLive.js';
import { openTenantLiveStream, tenantLiveAuthority } from './tenantLiveRoute.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { tenantWriterPaused } from './tenantWriterHealth.js';

type Owner = Pick<Awaited<ReturnType<typeof createTenantApiOwner>>, 'serviceLive'>;

const STATUS: Readonly<Record<string, number>> = Object.freeze({ unauthenticated: 401, forbidden: 403 });

export function createTenantServiceLiveHttp(input: {
  app: AppDef;
  ownership: TenantOwnershipSnapshot;
  owner: Owner;
  bound: Bound;
  admission: ApiAdmission;
  /** The deployment's auth runtime: a refused bearer names where to get one. */
  auth: unknown;
}) {
  const { app, ownership, owner, bound, admission, auth } = input;
  const streams = new Set<ServerResponse>();
  let retired = false;
  const respond = (res: ServerResponse, status: number, code: string) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code, message: 'The API request could not be completed.' } }));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // A browser's stream carries its session, never a bearer: it stays the lease's to answer.
    if (url.pathname !== LIVE_PATH || !presentsCredential(req)) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (retired) {
      respond(res, 503, 'temporarily_unavailable');
      return true;
    }
    const admitted = admitApiRequest(req, bound, admission);
    if (!admitted.ok) {
      respond(res, admitted.status, admitted.code);
      return true;
    }
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      respond(res, 405, 'method_not_allowed');
      return true;
    }
    let credential: string;
    try {
      credential = readApiBearerHeader(req.rawHeaders).credential;
    } catch {
      const charged = admission.charge(admitted.client);
      if (!charged.ok) {
        res.setHeader('retry-after', charged.retryAfterSeconds);
        respond(res, 429, 'rate_limited');
        return true;
      }
      res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', presentsAuthorization(req)));
      respond(res, 401, 'unauthenticated');
      return true;
    }
    const spent = admission.spend(credential);
    if (!spent.ok) {
      res.setHeader('retry-after', spent.retryAfterSeconds);
      respond(res, 429, 'rate_limited');
      return true;
    }
    const hub = tenantLiveHub(ownership);
    // A writer an uncertain write closed is back in a moment, as for a member's stream: 503, not off.
    if (!hub && liveSyncOn() && app.live && tenantWriterPaused(`${ownership.appId}/${ownership.source.id}`)) {
      respond(res, 503, 'temporarily_unavailable');
      return true;
    }
    if (!hub || !liveSyncOn() || !app.live) {
      answerLiveOff(res);
      return true;
    }
    let first: Awaited<ReturnType<Owner['serviceLive']>>;
    try {
      first = await owner.serviceLive(credential);
    } catch (error) {
      const status = error instanceof ApiReadFailure ? (STATUS[error.code] ?? 503) : 503;
      if (status === 401) {
        admission.charge(admitted.client);
        res.setHeader('www-authenticate', bearerChallenge(auth, 'rest', true));
      } else if (status === 403) {
        /* A good token of the wrong kind — a member's, or one whose service
           no longer admits it — is told so the RFC 6750 way: this stream is a
           service's, and the credential reaches no further. */
        const challenge = bearerChallenge(auth, 'rest', false);
        res.setHeader('www-authenticate', `${challenge}${challenge === 'Bearer' ? ' ' : ', '}error="insufficient_scope"`);
      }
      respond(res, status, status === 503 ? 'temporarily_unavailable' : (error as ApiReadFailure).code);
      return true;
    }
    if (retired || req.aborted || res.destroyed) return true;
    // A service's grants are not narrowed by a row policy, so no table has a scope to probe: nothing is proven by one.
    const probe = async () => [] as readonly string[];
    const cursor = url.searchParams.get('after') ?? undefined;
    await openTenantLiveStream({
      req,
      res,
      hub,
      account: first.grants.accountId,
      ...(cursor === undefined ? {} : { cursor }),
      authority: tenantLiveAuthority(app.id, first.grants, first.actor, probe),
      resolve: async () => {
        const again = await owner.serviceLive(credential);
        // The same token in the same tenant, or the stream ends.
        if (again.grants.tenantId !== first.grants.tenantId || again.grants.accountId !== first.grants.accountId) return denyTenant();
        return tenantLiveAuthority(app.id, again.grants, again.actor, probe);
      },
      headers: {},
      off: liveOffResources(app),
    });
    if (res.destroyed || res.writableEnded) return true;
    streams.add(res);
    res.once('close', () => streams.delete(res));
    return true;
  };
  return Object.freeze({
    handle,
    retire: async () => {
      retired = true;
      endLiveStreams(streams, 'stopping');
    },
  });
}
