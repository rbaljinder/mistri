/** Optional target-owned experiment transport. The deployment supplies native
 * request authority, declared epochs and both stores; requests supply selectors
 * only. Mounting this adapter does not provision or register anything. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import { FlagValidationError, normalizeFlagScope, type FlagValue } from '../../shared/appFlags.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import {
  FlagAccountChanged,
  FlagDeploymentRetired,
  FlagInputInvalid,
  FlagSignInRequired,
  type FlagDeploymentTarget,
} from '../flags/deployment.js';
import { FlagManagementDenied, FlagRevisionConflict, FlagStoreUnavailable, flagStoreIdentifier, flagStoreRecord } from '../flags/store.js';
import { HttpError, readJson } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import { ExperimentConflict, ExperimentContractError, ExperimentStoreUnavailable } from './contracts.js';
import type { ExperimentDecisionRequest } from './decisions.js';

const BODY_LIMIT = 64 * 1024,
  REPLY_LIMIT = 1024 * 1024;
function fingerprint(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new FlagInputInvalid();
  return input;
}
function revision(input: unknown, results = false): number {
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < (results ? 1 : 0) ||
    input > Number.MAX_SAFE_INTEGER - (results ? 0 : 1)
  )
    throw new FlagInputInvalid();
  return input;
}
function decision(body: unknown, flagId: string): ExperimentDecisionRequest {
  const fields = ['tenantId', 'epochFingerprint', 'expectedRevision', 'expectedResultRevision', 'winnerVariant', 'reason'];
  let raw: Record<string, unknown>;
  try {
    raw = flagStoreRecord(body, fields);
  } catch {
    throw new FlagInputInvalid();
  }
  if (fields.some((field) => !Object.hasOwn(raw, field))) throw new FlagInputInvalid();
  const tenantId = normalizeFlagScope({ appId: 'input', environment: 'input', tenantId: raw.tenantId }).tenantId;
  if (
    typeof raw.reason !== 'string' ||
    !raw.reason.length ||
    raw.reason.length > 1024 ||
    raw.reason !== raw.reason.trim() ||
    /[\p{Cc}\p{Cs}]/u.test(raw.reason)
  )
    throw new FlagInputInvalid();
  return {
    tenantId,
    flagId,
    epochFingerprint: fingerprint(raw.epochFingerprint),
    expectedRevision: revision(raw.expectedRevision),
    expectedResultRevision: revision(raw.expectedResultRevision, true),
    winnerVariant: raw.winnerVariant as FlagValue,
    reason: raw.reason,
  };
}

/** GET M/api/experiments/:flag/results?epochFingerprint=...&tenant=...
 * POST M/api/experiments/:flag/decisions (closed ExperimentDecisionRequest body,
 * excluding flagId, which comes exclusively from the path). */
export function createExperimentHttp(options: { readonly target: FlagDeploymentTarget; readonly bound: Bound; readonly mount?: string }) {
  const target = options.target,
    bound = captureTenantData(options.bound),
    mount = options.mount ?? '';
  if (mount !== '' && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount)) throw new FlagInputInvalid();
  const base = `${mount}/api/experiments`;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const arrived = req.url ?? '',
      path = arrived.split('?')[0];
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const send = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      let json = JSON.stringify(body);
      if (Buffer.byteLength(json) > REPLY_LIMIT) {
        status = 503;
        json = JSON.stringify({ error: 'Experiment response unavailable.', code: 'experiments_unavailable' });
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
      const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(results|decisions)$/.exec(path.slice(base.length));
      if (!match) {
        send(404, { error: 'Experiment route unavailable.' });
        return true;
      }
      const flagId = flagStoreIdentifier(match[1]),
        writing = match[2] === 'decisions',
        method = writing ? 'POST' : 'GET';
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
        // An experiment's reads are an operator's own, so the Origin is checked on them too, and no host's bearer stands for one.
        if (doorRefusal(req, bound, { writing, origin: 'always' })) throw new HttpError(403, 'Invalid origin or content type.');
        if (req.aborted || res.destroyed) throw new FlagManagementDenied();
      };
      trust();
      if (typeof headers.account !== 'string' || !headers.account.length) throw new FlagAccountChanged();
      const url = new URL(arrived, 'http://localhost'),
        permitted = writing ? [] : ['tenant', 'epochFingerprint'];
      for (const key of url.searchParams.keys())
        if (!permitted.includes(key) || url.searchParams.getAll(key).length !== 1) throw new FlagInputInvalid();
      const selector = writing
        ? undefined
        : {
            flagId,
            epochFingerprint: fingerprint(url.searchParams.get('epochFingerprint')),
            tenantId: normalizeFlagScope({ appId: target.appId, environment: target.environment, tenantId: url.searchParams.get('tenant') })
              .tenantId,
          };
      await target.withRequest(req, headers.account, trust, async (session) => {
        if (writing) {
          const timeout = setTimeout(() => req.destroy(new Error('Experiment body timeout.')), 30_000);
          timeout.unref();
          let body: unknown;
          try {
            body = await readJson(req, BODY_LIMIT);
          } finally {
            clearTimeout(timeout);
          }
          trust();
          await session.current();
          const input = decision(body, flagId);
          attempted = true;
          const result = await session.decide(input);
          // Acknowledged commits remain successes even if authority is revoked
          // afterward. This acknowledgement contains no evidence or flag value.
          send(200, result);
        } else {
          const result = await session.results(selector!);
          trust();
          send(200, result);
        }
      });
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown)
        send(503, {
          error: 'Decision outcome unknown. Read control history before another decision.',
          code: 'experiments_outcome_unknown',
          outcome: 'unknown',
        });
      else if (error instanceof FlagRevisionConflict)
        send(409, {
          error: 'Control revision changed. Read again before deciding.',
          code: 'flags_revision_conflict',
          outcome: 'not_applied',
        });
      else if (error instanceof ExperimentConflict)
        send(409, {
          error: 'Experiment evidence changed or is unavailable. Read again before deciding.',
          code: 'experiments_revision_conflict',
          outcome: 'not_applied',
        });
      else if (error instanceof ExperimentContractError)
        send(409, {
          error: 'Experiment evidence does not support this decision.',
          code: 'experiments_evidence_rejected',
          outcome: 'not_applied',
        });
      else if (error instanceof FlagSignInRequired) send(401, { error: 'Sign in to continue.', code: 'experiments_sign_in_required' });
      else if (error instanceof FlagAccountChanged)
        send(409, { error: 'The signed-in account or request changed.', code: 'experiments_account_changed', outcome: 'not_applied' });
      else if (error instanceof FlagDeploymentRetired)
        send(503, { error: 'Control deployment is retiring.', code: 'experiments_retired', outcome: 'not_applied' });
      else if (error instanceof FlagInputInvalid || error instanceof FlagValidationError)
        send(400, { error: 'Invalid experiment request.', code: 'experiments_invalid_request', outcome: 'not_applied' });
      else if (error instanceof HttpError)
        send(error.status, { error: 'Invalid experiment request.', code: 'experiments_invalid_request', outcome: 'not_applied' });
      else if (error instanceof FlagManagementDenied)
        send(403, { error: 'Experiment access is unavailable.', code: 'experiments_denied', outcome: 'not_applied' });
      else if (attempted && !(error instanceof FlagStoreUnavailable) && !(error instanceof ExperimentStoreUnavailable))
        send(503, {
          error: 'Decision outcome unknown. Read control history before another decision.',
          code: 'experiments_outcome_unknown',
          outcome: 'unknown',
        });
      else send(503, { error: 'Experiment evidence storage is unavailable.', code: 'experiments_unavailable', outcome: 'not_applied' });
    }
    return true;
  };
}
