/** Mount BEFORE /api/flags management. Admission and one atomic snapshot belong
 * to the host's ordinary App request pipeline, never this transport. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_FLAG_VALUES_PATH, captureAppFlagValues, type AppFlagValues } from '../../shared/appFlagValues.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import { flagValuesEqual, normalizeFlagScope, type FlagEvaluation } from '../../shared/appFlags.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { captureComposedFlagRequest } from './request.js';

export interface FlagValuesCapture {
  /** Exact request and active context already admitted by App/session/membership owners. */
  readonly request: IncomingMessage;
  readonly tenantId: string | null;
  /** Tenant comes from an admitted public row-policy context, not a selector. */
  readonly publicContext?: true;
  /** Platform evaluation reads global controls; it still requires the platform lease selector. */
  readonly realm?: 'platform';
  readonly flagIds: readonly string[];
  readonly evaluation: Awaited<ReturnType<typeof captureComposedFlagRequest>>;
  /** Recheck asynchronous native/membership evidence, then synchronous retirement. */
  current(): Promise<void>;
  assertCurrent(): void;
  /** Optional native-owner issuance port, bound to this genuine request capture.
   * Resolve the registered active epoch with this same verified context and
   * snapshot pair; issue only for its native session/explicit visitor proof.
   * Must never record exposure. Null means this decision has no receipt. */
  issueAssignmentReceipt?(
    flagId: string,
    decision: FlagEvaluation,
  ): Promise<{
    readonly receipt: string;
    readonly value: FlagEvaluation['value'];
  } | null>;
}
interface FlagValuesHttpOptions {
  readonly appId: string;
  readonly environment: string;
  readonly bound: Bound;
  readonly mount?: string;
  /** Must admit ordinary App reads, attest canonical account/lease response
   * headers, and supply the SAME capture used by commands for this request.
   * Anonymous identity is absent unless an opaque visitor was explicitly
   * established. Neither this callback nor this port records exposures. */
  withCapture(
    req: IncomingMessage,
    res: ServerResponse,
    guard: () => void,
    use: (capture: FlagValuesCapture) => Promise<void>,
  ): Promise<void>;
}

export function createFlagValuesHttp(options: FlagValuesHttpOptions) {
  const { appId, environment } = normalizeFlagScope({ appId: options.appId, environment: options.environment, tenantId: null });
  const bound = captureTenantData(options.bound),
    withCapture = options.withCapture,
    mount = options.mount ?? '';
  if (mount !== '' && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount)) throw new Error('Invalid flag values mount.');
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const arrived = req.url ?? '',
      path = arrived.split('?')[0];
    if (path !== `${mount}${APP_FLAG_VALUES_PATH}`) return false;
    const send = (status: number, body: unknown) => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        throw new HttpError(405, 'Use GET.');
      }
      // Capture all headers, including canonical tenant assertions. Mutation of
      // a request across an await must not change the identity it was admitted as.
      const headers = JSON.stringify(req.headers);
      const guard = () => {
        if (
          req.url !== arrived ||
          req.method !== 'GET' ||
          JSON.stringify(req.headers) !== headers ||
          req.aborted ||
          res.destroyed ||
          res.writableEnded
        )
          throw new HttpError(409, 'Request retired.');
        // A GET, and still the page's own: the values are this visitor's, read by no other origin.
        if (doorRefusal(req, bound, { writing: false, origin: 'always' })) throw new HttpError(403, 'Invalid origin.');
      };
      guard();
      const url = new URL(arrived, 'http://localhost'),
        query = url.searchParams;
      if (
        url.hash ||
        [...query.keys()].some((key) => !['app', 'tenant', 'realm'].includes(key) || query.getAll(key).length !== 1) ||
        (query.has('app') && query.get('app') !== appId) ||
        (query.has('realm') && query.get('realm') !== 'platform') ||
        (query.has('tenant') && (!query.get('tenant') || query.get('tenant') === PLATFORM_TENANT_ID || query.has('realm'))) ||
        req.headers['transfer-encoding'] ||
        (req.headers['content-length'] && req.headers['content-length'] !== '0')
      ) {
        throw new HttpError(400, 'Invalid flag values request.');
      }
      let used = false;
      let buffered: AppFlagValues | undefined;
      await withCapture(req, res, guard, async (capture) => {
        if (used) throw new HttpError(503, 'Duplicate capture.');
        used = true;
        const issue = capture.issueAssignmentReceipt?.bind(capture);
        guard();
        capture.assertCurrent();
        await capture.current();
        guard();
        capture.assertCurrent();
        const evaluation = capture.evaluation,
          scope = evaluation.scope;
        const selector = query.has('realm') ? null : capture.publicContext && !query.has('tenant') ? capture.tenantId : query.get('tenant');
        if (
          (capture.realm === 'platform') !== query.has('realm') ||
          capture.request !== req ||
          scope.appId !== appId ||
          scope.environment !== environment ||
          scope.tenantId !== capture.tenantId ||
          selector !== capture.tenantId
        )
          throw new HttpError(409, 'Wrong capture owner.');
        if (capture.flagIds.length > 256 || new Set(capture.flagIds).size !== capture.flagIds.length)
          throw new HttpError(503, 'Invalid catalog.');
        const diagnostics = new Set<string>(),
          decisions = new Map<string, FlagEvaluation>();
        const values = Object.fromEntries(
          capture.flagIds.map((id) => {
            const decision = evaluation.evaluate(id);
            decisions.set(id, decision);
            for (const diagnostic of decision.diagnostics) diagnostics.add(diagnostic);
            return [id, decision.value];
          }),
        );
        const assignmentReceipts: Record<string, string> = {};
        if (issue)
          for (const [id, decision] of decisions) {
            if (decision.reason !== 'experiment') continue;
            await capture.current();
            guard();
            capture.assertCurrent();
            const issued = await issue(id, decision);
            await capture.current();
            guard();
            capture.assertCurrent();
            if (issued) {
              if (!flagValuesEqual(issued.value, decision.value)) throw new HttpError(503, 'Assignment decision changed.');
              assignmentReceipts[id] = issued.receipt;
            }
          }
        const payload = captureAppFlagValues({
          values,
          version: evaluation.version,
          ...(diagnostics.size ? { diagnostics: [...diagnostics] } : {}),
          ...(Object.keys(assignmentReceipts).length ? { assignmentReceipts } : {}),
        });
        if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) throw new HttpError(503, 'Reply too large.');
        await capture.current();
        guard();
        capture.assertCurrent();
        buffered = payload;
      });
      // Native tenant/policy owners fence again when their callback releases.
      // Do not publish inside that callback: its apparent success is not release.
      if (!used || !buffered) throw new HttpError(503, 'No capture.');
      guard();
      res.setHeader('x-mistri-app', appId);
      send(200, buffered);
    } catch (error) {
      send(error instanceof HttpError ? error.status : 503, { error: 'Evaluated flag values unavailable.' });
    }
    return true;
  };
}
