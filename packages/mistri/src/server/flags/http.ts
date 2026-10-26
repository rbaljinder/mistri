/** Target-owned flag transport. Mount path and deployment are trusted startup
 * inputs; request selectors are intent, never proof or capability selectors. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import { FlagValidationError, normalizeFlagScope, type FlagOverride } from '../../shared/appFlags.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { readJson, HttpError } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import {
  FlagAccountChanged,
  FlagDeploymentRetired,
  FlagInputInvalid,
  FlagSignInRequired,
  type FlagDeploymentTarget,
} from './deployment.js';
import { FlagManagementDenied, FlagRevisionConflict, FlagStoreUnavailable, flagStoreIdentifier, flagStoreRecord } from './store.js';
import type { FlagManagementChange } from './management.js';

const BODY_LIMIT = 64 * 1024,
  REPLY_LIMIT = 1024 * 1024;
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw new FlagInputInvalid();
  return value;
}
function queryNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new FlagInputInvalid();
  return integer(Number(value));
}
function mutation(body: unknown, id: string, route: string): FlagManagementChange {
  const operation = route === 'override' ? 'set' : route === 'changes' ? (body as Record<string, unknown>)?.operation : route;
  if (!['set', 'kill', 'revert'].includes(operation as string)) throw new FlagInputInvalid();
  const fields = [
    'tenantId',
    'expectedRevision',
    'reason',
    ...(route === 'changes' ? ['operation'] : []),
    ...(operation === 'set' ? ['override'] : operation === 'revert' ? ['revertRevision'] : []),
  ];
  let raw: Record<string, unknown>;
  try {
    raw = flagStoreRecord(body, fields);
  } catch {
    throw new FlagInputInvalid();
  }
  if (fields.some((field) => !Object.hasOwn(raw, field))) throw new FlagInputInvalid();
  const tenantId = normalizeFlagScope({ appId: 'input', environment: 'input', tenantId: raw.tenantId }).tenantId;
  const expectedRevision = integer(raw.expectedRevision);
  if (
    typeof raw.reason !== 'string' ||
    !raw.reason.length ||
    raw.reason.length > 1024 ||
    raw.reason !== raw.reason.trim() ||
    /[\p{Cc}\p{Cs}]/u.test(raw.reason)
  )
    throw new FlagInputInvalid();
  const base = { flagId: id, tenantId, expectedRevision, reason: raw.reason };
  if (operation === 'set') return { ...base, operation, override: raw.override as FlagOverride };
  if (operation === 'revert') return { ...base, operation, revertRevision: integer(raw.revertRevision) };
  return { ...base, operation: 'kill' };
}

/** Returns false only outside its reserved target mount. No experiment results
 * or decisions transport is installed before an evidence owner exists. */
export function createFlagHttp(options: { target: FlagDeploymentTarget; bound: Bound; mount?: string }) {
  const target = options.target,
    bound = captureTenantData(options.bound),
    mount = options.mount ?? '';
  if (mount !== '' && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount)) throw new FlagInputInvalid();
  const base = `${mount}/api/flags`;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const arrived = req.url ?? '',
      path = arrived.split('?')[0];
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    // Reserved for the decision-provider owner, before the flag-ID grammar.
    // Until attached this route cannot read a flag named "evaluate".
    if (path === `${base}/evaluate` || path.startsWith(`${base}/evaluate/`)) {
      res
        .writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ error: 'Flag evaluation is unavailable.', code: 'flags_unavailable' }));
      return true;
    }
    const send = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      let json = JSON.stringify(body);
      if (Buffer.byteLength(json) > REPLY_LIMIT) {
        status = 503;
        json = JSON.stringify({ error: 'Flag response unavailable.', code: 'flags_unavailable' });
      }
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(json);
    };
    let attempted = false;
    try {
      const match = /^(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/(history|capabilities|changes|override|kill|revert))?)?$/.exec(
        path.slice(base.length),
      );
      if (!match) {
        send(404, { error: 'Flag route unavailable.' });
        return true;
      }
      const id = match[1] === undefined ? undefined : flagStoreIdentifier(match[1]),
        route = match[2];
      const writing = route !== undefined && ['changes', 'override', 'kill', 'revert'].includes(route);
      const method = writing ? (route === 'override' ? 'PUT' : 'POST') : 'GET';
      if (req.method !== method) {
        res.setHeader('allow', method);
        send(405, { error: `Use ${method}.` });
        return true;
      }
      const headers = captureTenantData({
        host: req.headers.host,
        origin: req.headers.origin,
        type: req.headers['content-type'],
        account: req.headers['x-mistri-account'],
        cookie: req.headers.cookie,
      });
      const trust = () => {
        if (getTenantHostIntent(req)) throw new FlagManagementDenied();
        if (
          req.url !== arrived ||
          req.method !== method ||
          req.headers.host !== headers.host ||
          req.headers.origin !== headers.origin ||
          req.headers['content-type'] !== headers.type ||
          req.headers.cookie !== headers.cookie ||
          req.headers['x-mistri-account'] !== headers.account
        )
          throw new FlagAccountChanged();
        // A flag's reads are an operator's own, so the Origin is checked on them too, and no host's bearer stands for one.
        if (doorRefusal(req, bound, { writing, origin: 'always' })) throw new HttpError(403, 'Invalid origin or content type.');
        if (req.aborted || res.destroyed) throw new FlagManagementDenied();
      };
      trust();
      if (typeof headers.account !== 'string' || !headers.account.length) throw new FlagAccountChanged();
      const url = new URL(arrived, 'http://localhost');
      const permitted = writing
        ? []
        : route === 'history'
          ? ['tenant', 'limit', 'beforeRevision']
          : !id
            ? ['tenant', 'limit', 'after']
            : ['tenant'];
      for (const key of url.searchParams.keys())
        if (!permitted.includes(key) || url.searchParams.getAll(key).length !== 1) throw new FlagInputInvalid();
      const tenantId = normalizeFlagScope({
        appId: target.appId,
        environment: target.environment,
        tenantId: url.searchParams.get('tenant'),
      }).tenantId;
      const limit = queryNumber(url.searchParams.get('limit'));
      if (limit !== undefined && (limit < 1 || limit > 100)) throw new FlagInputInvalid();
      const beforeRevision = queryNumber(url.searchParams.get('beforeRevision'));
      const after = url.searchParams.has('after') ? flagStoreIdentifier(url.searchParams.get('after')) : undefined;
      await target.withRequest(req, headers.account, trust, async (session) => {
        if (writing) {
          // The host's request lifetime includes this bounded body wait. A slow
          // body cannot keep shutdown draining indefinitely.
          const timeout = setTimeout(() => req.destroy(new Error('Flag body timeout.')), 30_000);
          timeout.unref();
          let body: unknown;
          try {
            body = await readJson(req, BODY_LIMIT);
          } finally {
            clearTimeout(timeout);
          }
          trust();
          await session.current();
          const change = mutation(body, id!, route!);
          attempted = true;
          const result = await session.change(change);
          // Commit was acknowledged: do not relabel success as a refusal if a
          // later session observation would fail. The reply contains no values.
          send(200, result);
        } else {
          const result = !id
            ? await session.list({ tenantId, ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) })
            : route === 'history'
              ? await session.history({
                  tenantId,
                  flagId: id,
                  ...(limit === undefined ? {} : { limit }),
                  ...(beforeRevision === undefined ? {} : { beforeRevision }),
                })
              : route === 'capabilities'
                ? await session.capabilities({ tenantId, flagId: id })
                : await session.get({ tenantId, flagId: id });
          trust();
          send(200, result);
        }
      });
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown)
        send(503, {
          error: 'The flag change outcome is unknown. Read and reconcile before another change.',
          code: 'flags_outcome_unknown',
          outcome: 'unknown',
        });
      else if (error instanceof FlagRevisionConflict)
        send(409, {
          error: 'The flag scope revision changed. Read again before making another change.',
          code: 'flags_revision_conflict',
          outcome: 'not_applied',
        });
      else if (error instanceof FlagSignInRequired) send(401, { error: 'Sign in to continue.', code: 'flags_sign_in_required' });
      else if (error instanceof FlagAccountChanged)
        send(409, { error: 'The signed-in account or request changed.', code: 'flags_account_changed', outcome: 'not_applied' });
      else if (error instanceof FlagDeploymentRetired)
        send(503, { error: 'Flag deployment is retiring.', code: 'flags_retired', outcome: 'not_applied' });
      else if (error instanceof FlagInputInvalid || error instanceof FlagValidationError)
        send(400, { error: 'Invalid flag request.', code: 'flags_invalid_request', outcome: 'not_applied' });
      else if (error instanceof HttpError)
        send(error.status, { error: 'Invalid flag request.', code: 'flags_invalid_request', outcome: 'not_applied' });
      else if (error instanceof FlagManagementDenied)
        send(403, { error: 'Flag access is unavailable.', code: 'flags_denied', outcome: 'not_applied' });
      else if (attempted && !(error instanceof FlagStoreUnavailable))
        send(503, {
          error: 'The flag change outcome is unknown. Read and reconcile before another change.',
          code: 'flags_outcome_unknown',
          outcome: 'unknown',
        });
      else send(503, { error: 'Flag control storage is unavailable.', code: 'flags_unavailable', outcome: 'not_applied' });
    }
    return true;
  };
}
