/** Explicit visitor opt-in. Admission stays with the native public App owner;
 * a verified cookie never widens that owner's read or intake permissions. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { identifier } from './contracts.js';
import type { ExperimentVisitorIdentityOwner } from './visitorIdentity.js';
import { EXPERIMENT_VISITOR_PATH } from '../../shared/appFlagValues.js';

interface PublicVisitorAdmission {
  readonly request: IncomingMessage;
  /** Signed-in sessions are not silently converted or stitched to visitors. */
  readonly accountId: null;
  assertCurrent(): void;
  current(): Promise<void>;
}
export function createExperimentVisitorHttp(options: {
  readonly appId: string;
  readonly mount: string;
  readonly bound: Bound;
  readonly identity: ExperimentVisitorIdentityOwner;
  /** Admit an actually public App/placed scope before reading any body. */
  readonly withPublic: (
    req: IncomingMessage,
    res: ServerResponse,
    guard: () => void,
    use: (owner: PublicVisitorAdmission) => Promise<void>,
  ) => Promise<void>;
}) {
  const appId = identifier(options.appId),
    path = `${options.mount}${EXPERIMENT_VISITOR_PATH}`;
  const bound = structuredClone(options.bound),
    identity = options.identity,
    withPublic = options.withPublic;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.url ?? '').split('?')[0] !== path) return false;
    const url = req.url,
      method = req.method,
      headers = JSON.stringify(req.headers);
    const guard = () => {
      if (
        req.aborted ||
        res.destroyed ||
        res.writableEnded ||
        req.url !== url ||
        req.method !== method ||
        JSON.stringify(req.headers) !== headers
      )
        throw new HttpError(409, 'Visitor request changed.');
      if (doorRefusal(req, bound, { writing: true, sameSite: true }) || req.headers['x-mistri-visitor'] !== 'establish')
        throw new HttpError(403, 'Explicit same-origin visitor interaction required.');
    };
    const send = (status: number, body: unknown) => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-mistri-app': appId,
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new HttpError(405, 'Use POST for visitor interaction.');
      }
      if (url !== path) throw new HttpError(400, 'Visitor interaction takes no query selectors.');
      guard();
      let used = false,
        cookie: string | null | undefined;
      await withPublic(req, res, guard, async (owner) => {
        if (used || owner.request !== req || owner.accountId !== null) throw new HttpError(403, 'Public visitor owner required.');
        used = true;
        const fresh = async () => {
          guard();
          owner.assertCurrent();
          await owner.current();
          guard();
          owner.assertCurrent();
        };
        await fresh();
        const timer = setTimeout(() => req.destroy(new Error('Visitor interaction body timeout.')), 5000);
        timer.unref();
        let body: Record<string, unknown>;
        try {
          body = await readJson(req, 128);
        } finally {
          clearTimeout(timer);
        }
        if (Object.keys(body).length) throw new HttpError(400, 'Visitor interaction body must be empty.');
        await fresh();
        cookie = identity.establish(req).setCookie;
        await fresh();
      });
      if (!used || cookie === undefined) throw new HttpError(503, 'Visitor owner unavailable.');
      guard();
      if (cookie) res.setHeader('set-cookie', cookie);
      send(200, { ready: true });
    } catch (error) {
      // Owner callbacks must not publish staged cookies when admission retires.
      res.removeHeader('set-cookie');
      send(error instanceof HttpError ? error.status : 503, { error: 'Visitor interaction unavailable.' });
    }
    return true;
  };
}
