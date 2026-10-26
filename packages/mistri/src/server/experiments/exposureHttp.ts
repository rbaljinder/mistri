/** Actual-consumption POST only. Native/session/membership and control owners
 * supply a fresh resolved assignment at each fence, including inside ingestion.
 * Receipts measure feature delivery/consumption, never human attention. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PLATFORM_TENANT_ID, TENANT_HTTP_HEADERS as names } from '../../shared/tenantContext.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { HttpError, readJson } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { ensure, identifier, integer, list, opaqueIdentifier, record, time, type ExperimentStore } from './contracts.js';
import { createExperimentExposureRecorder } from './exposure.js';
import {
  ASSIGNMENT_RECEIPT_LIMITS,
  type AssignmentReceiptClaims,
  type AssignmentReceiptProvider,
  type ResolvedExperimentAssignment,
} from './assignmentReceipt.js';

export const EXPERIMENT_EXPOSURES_PATH = '/api/experiments/exposures';
export const EXPOSURE_HTTP_LIMITS = Object.freeze({ batch: 16, bodyBytes: 16 * (ASSIGNMENT_RECEIPT_LIMITS.bytes + 4) + 64 });
/** Structural output of the native owner, not an alternate membership verifier.
 * Only the admitted tenant/platform request owner may supply a private lease. */
export interface ExperimentExposureScope {
  readonly appId: string;
  readonly environment: string;
  readonly tenantId: string | null;
  readonly realm: 'app' | 'tenant' | 'platform' | 'public';
}
export interface ExperimentExposureLease {
  readonly appId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly tabId: string;
  readonly context: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly realm?: 'platform';
}
interface ExperimentExposureOwner {
  readonly request: IncomingMessage;
  /** Verified account, not a body/header assertion. Null only for the explicitly
   * admitted signed visitor path; no anonymous fallback after native denial. */
  readonly accountId: string | null;
  readonly scope: ExperimentExposureScope;
  readonly lease?: ExperimentExposureLease;
  assertCurrent(): void;
  current(): Promise<void>;
  /** Authenticated receipt fields select an epoch, never supply eligibility.
   * Read its registered immutable declaration and a fresh atomic control pair;
   * call receipts.resolveAssignment with current verified context/session or
   * explicit visitor proof. Recheck membership and retirement around awaits. */
  resolveAssignment(claims: AssignmentReceiptClaims): Promise<ResolvedExperimentAssignment>;
}
interface ExperimentExposureHttpOptions {
  readonly appId: string;
  readonly environment: string;
  readonly bound: Bound;
  readonly mount?: string;
  readonly receipts: AssignmentReceiptProvider;
  readonly store: ExperimentStore;
  /** Captured native owner callback. Admit before body read; hold/drain the
   * request until use completes. Must not create cookies/visitor identity.
   * Failures use HttpError (401/403/409/503); never trust body authority. Recheck
   * native authority/retirement after use resolves, before releasing ownership.
   * This transport publishes verified owner headers only after that release. */
  withOwner(
    req: IncomingMessage,
    res: ServerResponse,
    guard: () => void,
    use: (owner: ExperimentExposureOwner) => Promise<void>,
  ): Promise<void>;
}
type Outcome = 'recorded' | 'duplicate' | 'failed' | 'unknown';

export function createExperimentExposureHttp(options: ExperimentExposureHttpOptions) {
  const { receipts, store, withOwner } = options;
  const appId = identifier(options.appId),
    environment = identifier(options.environment);
  const bound = captureTenantData(options.bound),
    mount = options.mount ?? '';
  ensure(mount === '' || /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount));
  ensure(typeof withOwner === 'function');
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const arrived = req.url ?? '';
    if (arrived.split('?')[0] !== `${mount}${EXPERIMENT_EXPOSURES_PATH}`) return false;
    const outcomes: Outcome[] = [];
    let count = 0;
    const coverage = () => ({
      received: count,
      recorded: outcomes.filter((value) => value === 'recorded').length,
      duplicate: outcomes.filter((value) => value === 'duplicate').length,
      failed: outcomes.filter((value) => value === 'failed').length,
      unknown: outcomes.filter((value) => value === 'unknown').length,
      dropped: count - outcomes.length,
    });
    const send = (status: number, body: unknown, ownerHeaders: Readonly<Record<string, string>> = {}) => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      // An admission callback may have staged headers. Never let those attest a
      // failed/unreleased owner, or accidentally retain another scope's tuple.
      for (const name of Object.values(names)) res.removeHeader(name);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...ownerHeaders,
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new HttpError(405, 'Use POST.');
      }
      const url = new URL(arrived, 'http://localhost'),
        query = url.searchParams;
      if (
        url.hash ||
        query.get('app') !== appId ||
        [...query.keys()].some((key) => !['app', 'tenant', 'realm'].includes(key) || query.getAll(key).length !== 1) ||
        (query.has('realm') && query.get('realm') !== 'platform') ||
        (query.has('realm') && query.has('tenant'))
      )
        throw new HttpError(400, 'Invalid exposure selector.');
      const tenantId = query.has('tenant') ? query.get('tenant')! : null;
      try {
        if (tenantId !== null) identifier(tenantId);
      } catch {
        throw new HttpError(400, 'Invalid exposure tenant.');
      }
      const canonical = new URLSearchParams({
        app: appId,
        ...(tenantId === null ? {} : { tenant: tenantId }),
        ...(query.has('realm') ? { realm: 'platform' } : {}),
      });
      if (arrived !== `${mount}${EXPERIMENT_EXPOSURES_PATH}?${canonical}`) throw new HttpError(400, 'Noncanonical exposure selector.');
      const headers = JSON.stringify(req.headers);
      const guard = () => {
        if (
          req.url !== arrived ||
          req.method !== 'POST' ||
          JSON.stringify(req.headers) !== headers ||
          req.aborted ||
          res.destroyed ||
          res.writableEnded
        )
          throw new HttpError(409, 'Request retired.');
        if (doorRefusal(req, bound, { writing: true, sameSite: true })) throw new HttpError(403, 'Invalid origin.');
      };
      guard();
      let used = false;
      let buffered: { status: number; headers: Readonly<Record<string, string>>; expiresAt: number | null } | undefined;
      await withOwner(req, res, guard, async (supplied) => {
        if (used) throw new HttpError(503, 'Duplicate owner.');
        used = true;
        // Capture callbacks and identity before the body/first asynchronous fence.
        const request = supplied.request,
          accountId = supplied.accountId;
        const scope = record(captureTenantData(supplied.scope), ['appId', 'environment', 'tenantId', 'realm']);
        const lease =
          supplied.lease === undefined
            ? undefined
            : record(captureTenantData(supplied.lease), [
                'appId',
                'accountId',
                'tenantId',
                'tabId',
                'context',
                'revision',
                'expiresAt',
                'realm',
              ]);
        const assertCurrent = supplied.assertCurrent.bind(supplied),
          current = supplied.current.bind(supplied);
        const resolveAssignment = supplied.resolveAssignment.bind(supplied);
        if (
          request !== req ||
          req.headers[names.app] !== appId ||
          (accountId === null
            ? req.headers[names.account] !== undefined
            : typeof accountId !== 'string' || !accountId.length || req.headers[names.account] !== accountId)
        ) {
          throw new HttpError(409, 'Account changed.');
        }
        const selectedTenant = accountId === null && !query.has('tenant') ? scope.tenantId : tenantId;
        if (
          scope.appId !== appId ||
          scope.environment !== environment ||
          scope.tenantId !== selectedTenant ||
          !['app', 'tenant', 'platform', 'public'].includes(scope.realm as string) ||
          (scope.realm === 'platform') !== query.has('realm') ||
          (scope.realm === 'public') !== (accountId === null) ||
          (scope.realm === 'app' && tenantId !== null) ||
          (scope.realm === 'tenant' && tenantId === null)
        )
          throw new HttpError(409, 'Wrong exposure scope.');
        const privateLease = scope.realm === 'tenant' || scope.realm === 'platform';
        if (privateLease !== !!lease) throw new HttpError(409, 'Exposure lease required.');
        const attested: Record<string, string> = { [names.app]: appId };
        if (accountId !== null) attested[names.account] = opaqueIdentifier(accountId);
        let expiresAt: number | null = null;
        if (lease) {
          if (
            lease.appId !== appId ||
            lease.accountId !== accountId ||
            lease.tenantId !== (scope.realm === 'platform' ? PLATFORM_TENANT_ID : tenantId) ||
            lease.realm !== (scope.realm === 'platform' ? 'platform' : undefined)
          )
            throw new HttpError(409, 'Wrong exposure lease.');
          // Lease IDs use the native opaque transport grammar, not experiment
          // IDs. These exact values are returned only from the trusted owner.
          const opaque = (value: unknown): string => {
            if (typeof value !== 'string' || !value || value.length > 1024 || value.trim() !== value || /[\p{Cc}\p{Cs}]/u.test(value))
              throw new HttpError(409, 'Invalid exposure lease.');
            return value;
          };
          attested[names.tenant] = lease.tenantId as string;
          attested[names.tab] = opaque(lease.tabId);
          attested[names.context] = opaque(lease.context);
          attested[names.revision] = String(integer(lease.revision, 1));
          expiresAt = time(lease.expiresAt);
          if (scope.realm === 'platform') attested[names.realm] = 'platform';
        }
        for (const name of [names.tab, names.context, names.revision]) {
          if (req.headers[name] !== attested[name]) throw new HttpError(409, 'Exposure lease assertion changed.');
        }
        for (const name of [names.tenant, names.realm]) {
          if (req.headers[name] !== undefined && req.headers[name] !== attested[name])
            throw new HttpError(409, 'Wrong exposure scope assertion.');
        }
        const live = () => {
          guard();
          assertCurrent();
          if (expiresAt !== null && Date.now() >= expiresAt) throw new HttpError(409, 'Exposure lease expired.');
        };
        const fresh = async () => {
          live();
          await current();
          live();
        };
        await fresh();
        const timeout = setTimeout(() => req.destroy(new Error('Exposure body timeout.')), 30_000);
        timeout.unref();
        let body: unknown;
        try {
          body = await readJson(req, EXPOSURE_HTTP_LIMITS.bodyBytes);
        } finally {
          clearTimeout(timeout);
        }
        await fresh();
        let batch: readonly unknown[];
        try {
          batch = list(record(body, ['receipts']).receipts, EXPOSURE_HTTP_LIMITS.batch);
          ensure(batch.length > 0);
        } catch {
          throw new HttpError(400, 'Invalid exposure batch.');
        }
        count = batch.length;
        for (const token of batch) {
          await fresh();
          let attempted = false;
          try {
            const claims = receipts.decode(token);
            ensure(
              claims.scope.appId === appId &&
                claims.scope.environment === environment &&
                claims.scope.evaluationTenantId === selectedTenant,
            );
            ensure(accountId === null ? claims.unit.kind === 'visitor' : claims.unit.kind === 'subject' && claims.unit.id === accountId);
            const verify = async () => {
              await fresh();
              const assignment = await resolveAssignment(claims);
              await fresh();
              return receipts.verify(token, assignment);
            };
            await verify();
            const reobserve = async () => {
              await verify();
            };
            const recorder = createExperimentExposureRecorder({
              store,
              epoch: claims.epoch,
              async verifyUse() {
                const verified = await verify();
                attempted = true;
                return { fact: verified.fact, reobserve };
              },
            });
            // Errors after entering ingestion may represent a lost commit reply.
            // Count conservatively, never auto-retry or acknowledge as recorded.
            const result = await recorder.recordUse(token);
            await reobserve();
            ensure(!result.late && ['inserted', 'duplicate', 'earlier-exposure'].includes(result.status));
            outcomes.push(result.status === 'duplicate' ? 'duplicate' : 'recorded');
          } catch {
            outcomes.push(attempted ? 'unknown' : 'failed');
          }
        }
        await fresh();
        buffered = { status: outcomes.includes('unknown') ? 503 : 200, headers: Object.freeze(attested), expiresAt };
      });
      if (!used || !buffered) throw new HttpError(503, 'No owner.');
      guard();
      if (buffered.expiresAt !== null && Date.now() >= buffered.expiresAt) throw new HttpError(409, 'Exposure lease expired.');
      send(buffered.status, { outcomes, coverage: coverage() }, buffered.headers);
    } catch (error) {
      // A failed final native fence cannot publish a late acknowledgement, even
      // when an earlier transaction committed. Preserve uncertainty honestly.
      for (let i = 0; i < outcomes.length; i++) if (outcomes[i] === 'recorded' || outcomes[i] === 'duplicate') outcomes[i] = 'unknown';
      send(error instanceof HttpError ? error.status : 503, { error: 'Exposure delivery unavailable.', outcomes, coverage: coverage() });
    }
    return true;
  };
}
