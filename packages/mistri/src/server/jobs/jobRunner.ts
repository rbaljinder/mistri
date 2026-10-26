import { isProxy } from 'node:util/types';
import { inSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import {
  JOB_ID,
  jobFail,
  JobRefusal,
  type JobClaim,
  type JobInspection,
  type JobOutcomeCode,
  type JobProvenance,
  type JobState,
} from '../../adapters/jobs/jobStoreTypes.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { isDefinedJob, JobCancelled, JobRejected, type JobContext, type JobGrant, type JobRegistry } from './jobs.js';

export { JobCancelled, JobRejected } from './jobs.js';

export interface JobAuthorizationRequest {
  readonly audience: 'mistri.jobs';
  readonly jobId: string;
  readonly job: string;
  readonly version: number;
  readonly provenance: JobProvenance;
  readonly attempt: number;
}
/** Asked once per attempt, before the handler. Null or a throw means the
 * attempt fails as not authorized; the handler never runs. */
export type JobAuthorizer = (request: JobAuthorizationRequest) => JobGrant | null | Promise<JobGrant | null>;

interface JobTickOutcome {
  readonly id: string;
  readonly job: string;
  readonly attempt: number;
  /** 'unrecorded': the lease was already stale when the outcome was known, so
   * the store keeps its own account (lease_expired) rather than this one. */
  readonly state: JobState | 'unrecorded';
  readonly code: JobOutcomeCode;
}
interface JobTick {
  readonly status: 'ran' | 'idle' | 'busy' | 'halting' | 'halted' | 'unavailable';
  readonly expired: number;
  readonly outcomes: readonly JobTickOutcome[];
}
type Settled = { kind: 'ok'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'interrupted'; code: 'timeout' | 'shutdown' };

/**
 * Explicitly driven private runner: no timer thread, no endpoint, no startup
 * registration. A trusted host calls `tick()`; the runner claims due jobs,
 * asks the authorizer for a fresh grant per attempt, runs the handler under an
 * abort signal and records one honest outcome per attempt. It never keeps a
 * grant, and it never supplies a database or command executor to a handler.
 */
export function createJobRunner(options: {
  readonly store: JobStore;
  readonly registry: JobRegistry;
  readonly authorize: JobAuthorizer;
  readonly now?: () => number;
  readonly attemptTimeoutMs: number;
}) {
  const { store, registry, authorize } = options,
    now = options.now ?? Date.now,
    timeoutMs = options.attemptTimeoutMs;
  if (
    !store ||
    typeof store !== 'object' ||
    typeof store.claim !== 'function' ||
    typeof authorize !== 'function' ||
    isProxy(authorize) ||
    typeof now !== 'function' ||
    isProxy(now) ||
    !registry ||
    typeof registry !== 'object' ||
    !Object.isFrozen(registry) ||
    !Object.keys(registry).length ||
    Object.keys(registry).some((id) => !JOB_ID.test(id) || !isDefinedJob(registry[id])) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs >= store.policy.leaseMs
  )
    return jobFail();
  let state: 'running' | 'halting' | 'halted' = 'running';
  let active: Promise<JobTick> | undefined;
  let halting: Promise<void> | undefined;
  const interrupts = new Set<() => void>();
  // An uncooperative handler that outlives its lease may still be running.
  // This owner never claims again; the store's expiry recovers the job.
  const abandon = () => {
    if (state === 'running') state = 'halted';
  };

  const grantOf = (granted: unknown, claim: JobClaim): JobGrant | null => {
    if (!granted || typeof granted !== 'object' || isProxy(granted)) return null;
    const grant = granted as JobGrant;
    if (
      grant.audience !== 'mistri.jobs' ||
      grant.job !== claim.job ||
      grant.version !== claim.version ||
      grant.appId !== claim.provenance.appId ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= now()
    )
      return null;
    return Object.freeze({
      audience: 'mistri.jobs' as const,
      job: grant.job,
      version: grant.version,
      appId: grant.appId,
      expiresAt: grant.expiresAt,
    });
  };
  const record = async (claim: JobClaim, code: JobOutcomeCode, mutate: () => Promise<JobInspection>): Promise<JobTickOutcome> => {
    try {
      return Object.freeze({ id: claim.id, job: claim.job, attempt: claim.attempt, state: (await mutate()).state, code });
    } catch (error) {
      if (error instanceof JobRefusal && error.code === 'fence_stale') {
        return Object.freeze({
          id: claim.id,
          job: claim.job,
          attempt: claim.attempt,
          state: 'unrecorded' as const,
          code: 'lease_expired' as const,
        });
      }
      throw error;
    }
  };

  /** `claimedAt` is this host's clock just before the claim: the lease it
   * measures from is on the store's clock, which may be another machine's. */
  async function attempt(claim: JobClaim, claimedAt: number): Promise<JobTickOutcome> {
    const { id, fence } = claim;
    const definition = Object.hasOwn(registry, claim.job) ? registry[claim.job] : undefined;
    // The registry is the contract. A job it no longer defines at this version
    // cannot be run by any later attempt either.
    if (!definition || definition.version !== claim.version)
      return record(claim, 'rejected', () => store.fail(id, fence, now(), 'rejected'));
    let granted: unknown = null;
    try {
      granted = await authorize(
        Object.freeze({
          audience: 'mistri.jobs' as const,
          jobId: id,
          job: claim.job,
          version: claim.version,
          provenance: claim.provenance,
          attempt: claim.attempt,
        }),
      );
    } catch {
      granted = null;
    }
    const grant = grantOf(granted, claim);
    if (!grant) return record(claim, 'not_authorized', () => store.fail(id, fence, now(), 'not_authorized'));
    let input: unknown;
    try {
      input = definition.input.parse(claim.input);
    } catch {
      return record(claim, 'input_invalid', () => store.fail(id, fence, now(), 'input_invalid'));
    }
    // Halted between the claim and the handler: nothing ran, so this is a
    // plain retry, not an unknown.
    if (state !== 'running') return record(claim, 'shutdown', () => store.retry(id, fence, now(), 'shutdown'));

    const controller = new AbortController();
    let interrupt!: (code: 'timeout' | 'shutdown') => void;
    const interrupted = new Promise<Settled>((resolve) => {
      interrupt = (code) => resolve({ kind: 'interrupted', code });
    });
    const onHalt = () => interrupt('shutdown');
    interrupts.add(onHalt);
    const timer = setTimeout(() => interrupt('timeout'), timeoutMs);
    const context: JobContext = Object.freeze({
      jobId: id,
      attempt: claim.attempt,
      maxAttempts: claim.maxAttempts,
      job: claim.job,
      version: claim.version,
      provenance: claim.provenance,
      signal: controller.signal,
      now: () => now(),
      grant,
      cancelRequested: () => store.cancelRequested(id, fence),
    });
    let settled = false;
    // The claim is committed and its store transaction is over.
    // A microtask also turns synchronous throws into handled results.
    const run: Promise<Settled> = Promise.resolve()
      .then(() => definition.handle(context, input))
      .then(
        (value) => {
          settled = true;
          return { kind: 'ok', value };
        },
        (error) => {
          settled = true;
          return { kind: 'error', error };
        },
      );
    try {
      const result = await Promise.race([run, interrupted]);
      if (result.kind === 'interrupted') {
        const code = result.code;
        controller.abort();
        // Wait for a cooperative handler to let go, but not past the lease:
        // after that the store's expiry owns the job, not this runner.
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          run,
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, Math.max(0, claimedAt + store.policy.leaseMs - now() - 1));
          }),
        ]);
        clearTimeout(grace);
        if (!settled) abandon();
        return record(claim, code, () => store.unknown(id, fence, now(), code));
      }
      if (result.kind === 'error') {
        if (result.error instanceof JobRejected) return record(claim, 'rejected', () => store.fail(id, fence, now(), 'rejected'));
        if (result.error instanceof JobCancelled) return record(claim, 'cancelled', () => store.fail(id, fence, now(), 'cancelled'));
        return record(claim, 'handler_error', () => store.retry(id, fence, now(), 'handler_error'));
      }
      // The handler resolved, so its effect happened; but authority did not
      // hold for the whole run. That is not a success this runner can vouch
      // for. Unknown keeps the lease, and the next attempt asks again.
      if (grant.expiresAt <= now()) return record(claim, 'not_authorized', () => store.unknown(id, fence, now(), 'not_authorized'));
      let retained: unknown = undefined;
      try {
        canonicalCommandJson(result.value, store.policy.maxInputBytes);
        retained = result.value;
      } catch {
        retained = undefined;
      }
      return record(claim, 'succeeded', () => store.succeed(id, fence, now(), retained));
    } finally {
      clearTimeout(timer);
      interrupts.delete(onHalt);
    }
  }

  async function work(limit: number | undefined): Promise<JobTick> {
    try {
      if (state !== 'running') return { status: state, expired: 0, outcomes: Object.freeze([]) };
      const expired = await store.expireLeases(now());
      const claimedAt = now();
      const claims = await store.claim(claimedAt, limit ?? store.policy.maxInFlight);
      if (!claims.length) return { status: 'idle', expired, outcomes: Object.freeze([]) };
      /* Each attempt is a trace of its own: its job, version, attempt and
         outcome travel; its input stays local (adapters/telemetry/trace.ts). */
      const outcomes = await Promise.all(
        claims.map((claim) =>
          inSpan(
            `job ${claim.job}`,
            {
              kind: 'consumer',
              attributes: {
                'mistri.job.id': claim.job,
                'mistri.job.version': claim.version,
                'mistri.job.attempt': claim.attempt,
                'mistri.job.max_attempts': claim.maxAttempts,
              },
            },
            async (span) => {
              span.detail(() => ({ jobId: claim.id, input: claim.input }));
              const outcome = await attempt(claim, claimedAt);
              span.setAttributes({ 'mistri.job.outcome': outcome.code, 'mistri.job.state': outcome.state });
              if (outcome.code !== 'succeeded') span.fail(outcome.code);
              return outcome;
            },
          ),
        ),
      );
      return { status: 'ran', expired, outcomes: Object.freeze(outcomes) };
    } catch {
      // The store could not record what happened. Keep the durable lease and
      // stop; expiry or a restart recovers the job conservatively.
      abandon();
      return { status: 'unavailable', expired: 0, outcomes: Object.freeze([]) };
    }
  }

  return Object.freeze({
    tick(limit?: number): Promise<JobTick> {
      if (state !== 'running') return Promise.resolve({ status: state, expired: 0, outcomes: Object.freeze([]) });
      if (active) return Promise.resolve({ status: 'busy', expired: 0, outcomes: Object.freeze([]) });
      // Set the reentry fence before calling even the trusted clock callback.
      const task = Promise.resolve().then(() => work(limit));
      active = task;
      void task.then(() => {
        if (active === task) active = undefined;
      });
      return task;
    },
    status: () => state,
    /** Stops claiming, aborts every in-flight signal and resolves once those
     * handlers settle (or their leases run out). The store is the caller's. */
    halt(): Promise<void> {
      return (halting ??= (async () => {
        if (state === 'running') state = 'halting';
        for (const interrupt of interrupts) interrupt();
        if (active) await active;
        state = 'halted';
      })());
    },
  });
}
export type JobRunner = ReturnType<typeof createJobRunner>;
