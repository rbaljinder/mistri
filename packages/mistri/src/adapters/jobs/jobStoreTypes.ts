import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { recordRefusalCause } from '@mistriwork/engine/shared/refusal.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

/** Storage or policy could not be verified. Carries no detail on purpose. */
export class JobStoreUnavailable extends Refusal {
  constructor(message = 'Job storage or policy could not be verified. Operator review is required.') {
    super(message);
    this.name = 'JobStoreUnavailable';
  }
}
/** Refuse, recording for the operator why (refusalReport.ts, the startup headline): the caller still hears the fixed
    sentence, but a missing file or foreign keys left off is no longer told as "could not be verified" alone. */
export const jobFail = (message?: string, because?: unknown): never => {
  throw recordRefusalCause(new JobStoreUnavailable(message), because);
};

type JobRefusalCode =
  | 'input_invalid'
  | 'input_too_large'
  | 'idempotency_conflict'
  | 'fence_stale'
  | 'job_not_found'
  | 'result_invalid'
  | 'operator_invalid'
  | 'not_redrivable'
  | 'lease_held'
  | 'redrive_limit';
/** A refused call that changed nothing. The code is the whole diagnostic: no
 * payload, key or provenance is ever echoed back. */
export class JobRefusal extends Refusal {
  constructor(readonly code: JobRefusalCode) {
    super(`The job store refused this call: ${code}.`);
    this.name = 'JobRefusal';
  }
}
export const jobRefuse = (code: JobRefusalCode): never => {
  throw new JobRefusal(code);
};

export function jobText(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value !== value.trim() ||
    Buffer.byteLength(value) > maximum ||
    /\p{Cc}|[\uD800-\uDFFF]/u.test(value)
  )
    jobFail();
}
export function jobInteger(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) jobFail();
}
export const JOB_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return jobFail();
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) jobFail();
}

/** Private trusted deployment configuration. One database holds exactly one
 * namespace; changing any bound is a new namespace, never a live migration. */
export interface JobPolicy {
  readonly namespace: string;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly backoffMs: Readonly<{ base: number; cap: number }>;
  readonly maxInputBytes: number;
  readonly maxInFlight: number;
}
export interface JobPolicyInput {
  readonly namespace: string;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly backoffMs?: Readonly<{ base: number; cap: number }>;
  readonly maxInputBytes?: number;
  readonly maxInFlight?: number;
}
const JOB_POLICY_DEFAULTS = Object.freeze({
  maxAttempts: 8,
  leaseMs: 30_000,
  backoffMs: Object.freeze({ base: 1_000, cap: 60_000 }),
  maxInputBytes: 16_384,
  maxInFlight: 8,
});
export function captureJobPolicy(input: JobPolicyInput): JobPolicy {
  try {
    // Captures descriptors without invoking accessors/toJSON; refuses proxies,
    // cycles and excess allocation before consulting any configuration value.
    const value = JSON.parse(canonicalCommandJson(input, 4_096)) as Record<string, unknown>;
    exactKeys(value, ['namespace'], ['maxAttempts', 'leaseMs', 'backoffMs', 'maxInputBytes', 'maxInFlight']);
    jobText(value.namespace, 128);
    if (!JOB_ID.test(value.namespace)) jobFail();
    const policy = { namespace: value.namespace, ...JOB_POLICY_DEFAULTS, ...value } as JobPolicy;
    jobInteger(policy.maxAttempts, 1, 32);
    jobInteger(policy.leaseMs, 1_000, 600_000);
    exactKeys(policy.backoffMs, ['base', 'cap']);
    jobInteger(policy.backoffMs.base, 1, 86_400_000);
    jobInteger(policy.backoffMs.cap, policy.backoffMs.base, 86_400_000);
    jobInteger(policy.maxInputBytes, 2, 65_536);
    jobInteger(policy.maxInFlight, 1, 64);
    return Object.freeze({
      namespace: policy.namespace,
      maxAttempts: policy.maxAttempts,
      leaseMs: policy.leaseMs,
      backoffMs: Object.freeze({ base: policy.backoffMs.base, cap: policy.backoffMs.cap }),
      maxInputBytes: policy.maxInputBytes,
      maxInFlight: policy.maxInFlight,
    });
  } catch {
    return jobFail();
  }
}

/** Who asked for the work. Recorded for the handler and for causation; it is
 * never authority. Every attempt asks the injected authorizer again. */
export interface JobProvenance {
  readonly appId: string;
  readonly actorId: string;
  readonly tenantId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}
export function captureJobProvenance(value: unknown): JobProvenance {
  exactKeys(value, ['appId', 'actorId'], ['tenantId', 'correlationId', 'causationId']);
  for (const key of Object.keys(value)) jobText(value[key], 128);
  return Object.freeze({ ...value }) as unknown as JobProvenance;
}

export interface JobEnqueueInput {
  readonly job: string;
  readonly version: number;
  readonly idempotencyKey: string;
  /** Plain JSON only. Optional fields are omitted, not `undefined`. */
  readonly input: unknown;
  readonly runAt?: number;
  readonly provenance: JobProvenance;
  readonly maxAttempts?: number;
}
export interface JobEnqueued {
  readonly id: string;
  readonly runAt: number;
  /** The same job, version, input and provenance were already accepted under
   * this key. Nothing was written. */
  readonly replayed: boolean;
}

export type JobState = 'scheduled' | 'leased' | 'retry' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type JobOutcomeCode =
  | 'succeeded'
  | 'rejected'
  | 'not_authorized'
  | 'timeout'
  | 'shutdown'
  | 'lease_expired'
  | 'cancelled'
  | 'input_invalid'
  | 'handler_error'
  | 'redriven';
export type JobAttemptOutcome = 'leased' | 'succeeded' | 'failed' | 'retry' | 'unknown' | 'cancelled' | 'redriven';
export const JOB_STATES: readonly JobState[] = Object.freeze([
  'scheduled',
  'leased',
  'retry',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
]);
export const JOB_CODES: readonly JobOutcomeCode[] = Object.freeze([
  'succeeded',
  'rejected',
  'not_authorized',
  'timeout',
  'shutdown',
  'lease_expired',
  'cancelled',
  'input_invalid',
  'handler_error',
  'redriven',
]);
export const JOB_ATTEMPT_OUTCOMES: readonly JobAttemptOutcome[] = Object.freeze([
  'leased',
  'succeeded',
  'failed',
  'retry',
  'unknown',
  'cancelled',
  'redriven',
]);

/** An operator may put a job back in line at most this many times. Each
 * redrive grants the job's attempt budget once more; the ceiling keeps a
 * poisoned job from being retried forever by habit. */
export const JOB_REDRIVE_LIMIT = 3;
/** Attempt-history rows one job can hold: every budget spent, plus one row
 * per redrive. */
export const JOB_HISTORY_LIMIT = 32 * (JOB_REDRIVE_LIMIT + 1) + JOB_REDRIVE_LIMIT;
/** Who redrove a job: an operator's stable id, recorded in the history row. */
export const JOB_OPERATOR = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

export interface JobClaim {
  readonly id: string;
  /** Fence token for this attempt. Every mutation must present it; a stale
   * fence changes nothing. Never use it for deduplication. */
  readonly fence: string;
  readonly job: string;
  readonly version: number;
  readonly attempt: number;
  /** The attempt at which the job fails: its budget, raised by a redrive. */
  readonly maxAttempts: number;
  readonly input: unknown;
  readonly provenance: JobProvenance;
  /** On the store's clock, which on PostgreSQL is the database's. */
  readonly deadline: number;
}
export type JobCancelOutcome = 'cancelled' | 'requested' | 'unchanged';
export interface JobInspection {
  readonly id: string;
  readonly job: string;
  readonly version: number;
  readonly state: JobState;
  /** Rows in the attempt history: attempts made, plus one per redrive. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly redrives: number;
  readonly runAt: number;
  readonly leaseUntil: number | null;
  readonly cancelRequested: boolean;
  readonly lastCode: JobOutcomeCode | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface JobAttemptInspection {
  readonly attempt: number;
  readonly startedAt: number;
  /** Null on a redrive row, which leased nothing. */
  readonly deadline: number | null;
  readonly outcome: JobAttemptOutcome;
  readonly code: JobOutcomeCode | null;
  readonly finishedAt: number | null;
  /** The operator who redrove the job; null on every attempt the runner made. */
  readonly operator: string | null;
}
export interface JobPruneResult {
  readonly pruned: number;
  /** The batch was full: call again for the next one. */
  readonly more: boolean;
}
