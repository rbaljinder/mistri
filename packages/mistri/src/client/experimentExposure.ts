/** Actual-use delivery, in memory only. The browser sends server receipts, never
 * chooses units/variants. Nothing here establishes an anonymous identity. */
import {
  EXPERIMENT_EXPOSURES_PATH,
  EXPERIMENT_FORM_HEADER,
  EXPERIMENT_ADDRESS_HEADER,
  type ExperimentVisitorSelection,
  isAssignmentReceipt,
} from '../shared/appFlagValues.js';
import { TENANT_HTTP_HEADERS as names } from '../shared/tenantContext.js';
import {
  assertSessionCurrent,
  captureTenantLease,
  sessionIdentity,
  suspendTenantLease,
  tenantLeaseActive,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { say } from './copy/shell/experimentExposure.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

export const EXPOSURE_QUEUE_LIMITS = Object.freeze({ batch: 16, queued: 64, remembered: 256 });
export interface ExposureCoverage {
  readonly queued: number;
  readonly inFlight: number;
  readonly recorded: number;
  readonly duplicate: number;
  readonly failed: number;
  readonly unknown: number;
  readonly dropped: number;
}
type Outcome = 'recorded' | 'duplicate' | 'failed' | 'unknown';

function acknowledgement(input: unknown, count: number): { outcomes: Outcome[]; dropped: number } {
  const fail = (): never => {
    throw new Error(say('unrecognizedAcknowledgement'));
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const raw = input as Record<string, unknown>,
    coverage = raw.coverage as Record<string, unknown> | undefined;
  if (
    Object.keys(raw).some((key) => !['outcomes', 'coverage', 'error'].includes(key)) ||
    !Array.isArray(raw.outcomes) ||
    raw.outcomes.length > count ||
    !coverage ||
    typeof coverage !== 'object' ||
    Array.isArray(coverage) ||
    Object.keys(coverage).sort().join() !== ['received', 'recorded', 'duplicate', 'failed', 'unknown', 'dropped'].sort().join() ||
    Object.values(coverage).some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) ||
    coverage.received !== count ||
    coverage.dropped !== count - raw.outcomes.length
  )
    return fail();
  const outcomes = raw.outcomes as Outcome[];
  if (outcomes.some((value) => !['recorded', 'duplicate', 'failed', 'unknown'].includes(value))) return fail();
  for (const status of ['recorded', 'duplicate', 'failed', 'unknown'] as const) {
    if (coverage[status] !== outcomes.filter((value) => value === status).length) return fail();
  }
  return { outcomes, dropped: coverage.dropped as number };
}

/** One owner generation, one bounded deduplication set. Saturation drops new
 * receipts instead of evicting acknowledgements and silently resending them.
 * Failed/unknown outcomes are terminal here; later renders never auto-retry. */
export function createExperimentExposureQueue(port: {
  current(): boolean;
  send(receipts: readonly string[], signal: AbortSignal): Promise<unknown>;
}) {
  const seen = new Set<string>(),
    waiting: string[] = [];
  let retired = false,
    pending: Promise<void> | undefined,
    controller: AbortController | undefined,
    inFlight = 0;
  const totals = { recorded: 0, duplicate: 0, failed: 0, unknown: 0, dropped: 0 };
  const coverage = (): ExposureCoverage => Object.freeze({ ...totals, queued: waiting.length, inFlight });
  const retire = () => {
    if (retired) return;
    retired = true;
    totals.dropped += waiting.length;
    totals.unknown += inFlight;
    waiting.length = 0;
    inFlight = 0;
    seen.clear();
    controller?.abort();
  };
  const current = () => {
    try {
      if (!retired && !port.current()) retire();
    } catch {
      retire();
    }
    return !retired;
  };
  const flush = (): Promise<void> => {
    if (pending) return pending;
    if (!current() || !waiting.length) return Promise.resolve();
    pending = Promise.resolve()
      .then(async () => {
        while (current() && waiting.length) {
          const batch = waiting.splice(0, EXPOSURE_QUEUE_LIMITS.batch),
            abort = (controller = new AbortController());
          inFlight = batch.length;
          try {
            const raw = await port.send(Object.freeze(batch), abort.signal);
            if (!current() || abort.signal.aborted) return;
            const ack = acknowledgement(raw, batch.length);
            for (const outcome of ack.outcomes) totals[outcome]++;
            totals.dropped += ack.dropped;
          } catch {
            if (!current()) return;
            totals.unknown += batch.length;
          } finally {
            inFlight = 0;
            controller = undefined;
          }
        }
      })
      .finally(() => {
        pending = undefined;
        if (!retired && waiting.length) void flush();
      });
    return pending;
  };
  return Object.freeze({
    coverage,
    retire,
    flush,
    consume(receipt: string) {
      if (!current() || seen.has(receipt)) return;
      if (!isAssignmentReceipt(receipt) || seen.size >= EXPOSURE_QUEUE_LIMITS.remembered) {
        totals.dropped++;
        return;
      }
      seen.add(receipt);
      if (waiting.length >= EXPOSURE_QUEUE_LIMITS.queued) {
        totals.dropped++;
        return;
      }
      waiting.push(receipt);
      // Effects enqueue without waiting for network or delaying initial paint.
      void flush();
    },
  });
}

/** Purpose-specific transport over the normal captured account/tenant lease
 * protocol. No caller-supplied URL, credentials, identity, variant or timestamp.
 * The mount comes only from the page's existing trusted served() address owner. */
export function captureExperimentExposureSender(
  owner: { readonly appId: string; current(): boolean },
  options: { readonly visitor?: boolean; readonly selection?: ExperimentVisitorSelection } = {},
) {
  const identity = sessionIdentity(),
    lease = captureTenantLease(identity);
  const visitor = options.visitor === true && identity.mode === 'anonymous';
  if (
    (!visitor && (identity.mode !== 'authenticated' || !identity.accountId)) ||
    identity.appId !== owner.appId ||
    (identity.tenantRequired && (!lease || !tenantLeaseActive(identity)))
  )
    return undefined;
  const current = () =>
    owner.current() &&
    identity === sessionIdentity() &&
    (!identity.tenantRequired || (lease === captureTenantLease(identity) && tenantLeaseActive(identity)));
  const query = new URLSearchParams({ app: owner.appId });
  if (lease) query.set(lease.realm === 'platform' ? 'realm' : 'tenant', lease.realm === 'platform' ? 'platform' : lease.tenantId);
  const path = `${EXPERIMENT_EXPOSURES_PATH}?${query}`;
  const headers = Object.freeze({
    'content-type': 'application/json',
    ...(visitor && options.selection?.form ? { [EXPERIMENT_FORM_HEADER]: options.selection.form } : {}),
    ...(visitor && options.selection?.address ? { [EXPERIMENT_ADDRESS_HEADER]: options.selection.address } : {}),
    ...(!visitor ? { [names.account]: identity.accountId! } : {}),
    [names.app]: owner.appId,
    ...(lease ? { [names.tab]: lease.tabId, [names.context]: lease.context, [names.revision]: String(lease.revision) } : {}),
  });
  const owns = (reply: Headers) =>
    reply.get(names.app) === owner.appId &&
    reply.get(names.account) === identity.accountId &&
    (!lease ||
      (reply.get(names.tenant) === lease.tenantId &&
        reply.get(names.tab) === lease.tabId &&
        reply.get(names.context) === lease.context &&
        reply.get(names.revision) === String(lease.revision) &&
        reply.get(names.realm) === (lease.realm === 'platform' ? 'platform' : null)));
  return Object.freeze({
    current,
    async send(receipts: readonly string[], signal: AbortSignal): Promise<unknown> {
      if (
        !current() ||
        signal.aborted ||
        !receipts.length ||
        receipts.length > EXPOSURE_QUEUE_LIMITS.batch ||
        receipts.some((receipt) => !isAssignmentReceipt(receipt))
      )
        throw new Error(say('ownerUnavailable'));
      assertSessionCurrent(identity);
      const reply = await fetchServer(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: JSON.stringify({ receipts }),
        signal,
      });
      if (!current() || signal.aborted) throw new Error(say('ownerRetired'));
      const changedAccount = reply.headers.has(names.account) && reply.headers.get(names.account) !== identity.accountId;
      if (changedAccount || reply.status === 401) {
        const { invalidateSession } = await import('@mistriwork/kit/client/sessionLifecycle.js');
        if (current()) invalidateSession(changedAccount ? 'account-changed' : 'expired');
        throw new Error(say('accountChanged'));
      }
      if (lease && Object.values(names).some((name) => reply.headers.has(name)) && !owns(reply.headers)) {
        if (current()) suspendTenantLease(identity);
        throw new Error(say('leaseChanged'));
      }
      assertSessionCurrent(identity, reply.headers.get(names.account));
      if (!owns(reply.headers)) throw new Error(say('acknowledgementOwnerChanged'));
      const text = await reply.text();
      if (!current() || signal.aborted || text.length > 8192) throw new Error(say('acknowledgementUnavailable'));
      // A 503 may still contain honestly acknowledged earlier batch members.
      // Validate all counts in the queue, rather than equating HTTP OK to use.
      if (reply.status !== 200 && reply.status !== 503) throw new Error(say('requestRefused'));
      return JSON.parse(text) as unknown;
    },
  });
}
