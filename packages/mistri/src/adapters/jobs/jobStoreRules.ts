/**
 * What a job row, its history and its calls must be, shared by the SQLite and
 * PostgreSQL stores so the two engines cannot disagree about a valid job.
 * Rows arrive normalised: integers as numbers, text as strings, NULL as null.
 */
import { createHash } from 'node:crypto';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  captureJobProvenance,
  exactKeys,
  IDEMPOTENCY_KEY,
  JOB_ATTEMPT_OUTCOMES,
  JOB_CODES,
  JOB_HISTORY_LIMIT,
  JOB_ID,
  JOB_OPERATOR,
  JOB_REDRIVE_LIMIT,
  JOB_STATES,
  jobFail,
  jobInteger,
  jobRefuse,
  jobText,
  type JobAttemptInspection,
  type JobAttemptOutcome,
  type JobClaim,
  type JobInspection,
  type JobOutcomeCode,
  type JobPolicy,
  type JobProvenance,
  type JobState,
} from './jobStoreTypes.js';

export type JobRow = Readonly<Record<string, unknown>>;
export const JOB_MAX_CLOCK = Number.MAX_SAFE_INTEGER - 86_700_000;
export const JOB_HELD: readonly string[] = Object.freeze(['leased', 'unknown']);

/*
 * A job at times runs one at a time (OP9): a run of its platform slot (`every-` and the slot's sixteen digits,
 * jobCommands.ts everySlotKey) or an operator's run of it now (`manual-`, jobManualRun.ts) is not claimed while
 * another such run of the same job holds a lease, nor beside one in the same claim. A tenant's slot carries its
 * tenant in a longer key and is not held back by another tenant's; an event's or a timer's job is never held back.
 * The claim is one serialized step on both engines (SQLite's one writer, PostgreSQL's namespace lock), so two hosts
 * cannot each lease one.
 */
const TIMED_KEY = /^(?:manual-|every-\d{16}$)/;
/** Whether a row's key is one of a job at times' runs that may not overlap. */
const oneAtATime = (key: unknown): boolean => typeof key === 'string' && TIMED_KEY.test(key);
/** The same, in SQL both engines read, over a table alias. */
export const oneAtATimeSql = (alias: string) =>
  `(substr(${alias}.idempotency_key, 1, 7) = 'manual-' OR (substr(${alias}.idempotency_key, 1, 6) = 'every-' AND length(${alias}.idempotency_key) = 22))`;
/** Due rows, less a second one-at-a-time run of a job in the same claim (the query already left out a job that holds one). */
export function withoutOverlap<R extends JobRow>(rows: readonly R[]): R[] {
  const taken = new Set<unknown>();
  return rows.filter((row) => {
    if (!oneAtATime(row.idempotency_key)) return true;
    if (taken.has(row.job)) return false;
    taken.add(row.job);
    return true;
  });
}
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

interface CapturedJobEnqueue {
  readonly job: string;
  readonly version: number;
  readonly key: string;
  readonly inputJson: string;
  readonly provenanceJson: string;
  readonly fingerprint: string;
  readonly runAt: number | undefined;
  readonly maxAttempts: number;
}
/** Everything an enqueue writes, captured and bounded before any transaction. */
export function captureJobEnqueue(policy: JobPolicy, input: unknown): CapturedJobEnqueue {
  let value: Record<string, unknown>, provenance: JobProvenance;
  try {
    value = JSON.parse(canonicalCommandJson(input, policy.maxInputBytes + 4_096)) as Record<string, unknown>;
    exactKeys(value, ['job', 'version', 'idempotencyKey', 'input', 'provenance'], ['runAt', 'maxAttempts']);
    jobText(value.job, 128);
    if (!JOB_ID.test(value.job)) jobFail();
    jobInteger(value.version, 1, Number.MAX_SAFE_INTEGER);
    if (typeof value.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(value.idempotencyKey)) jobFail();
    provenance = captureJobProvenance(value.provenance);
    if ('runAt' in value) jobInteger(value.runAt, 0, JOB_MAX_CLOCK);
    if ('maxAttempts' in value) jobInteger(value.maxAttempts, 1, policy.maxAttempts);
  } catch {
    return jobRefuse('input_invalid');
  }
  const inputJson = canonicalCommandJson(value.input);
  if (Buffer.byteLength(inputJson) > policy.maxInputBytes) return jobRefuse('input_too_large');
  const fingerprint = createHash('sha256')
    .update(canonicalCommandJson({ job: value.job, version: value.version, input: value.input, provenance }))
    .digest('hex');
  return Object.freeze({
    job: value.job as string,
    version: value.version as number,
    key: value.idempotencyKey as string,
    inputJson,
    provenanceJson: canonicalCommandJson(provenance),
    fingerprint,
    runAt: value.runAt as number | undefined,
    maxAttempts: (value.maxAttempts as number | undefined) ?? policy.maxAttempts,
  });
}

/** A runner's outcome code. 'succeeded' has its own call, and only an
 * operator's redrive writes 'redriven'. */
export function captureJobOutcome(value: unknown): JobOutcomeCode {
  if (!JOB_CODES.includes(value as JobOutcomeCode) || value === 'succeeded' || value === 'redriven') return jobFail();
  return value as JobOutcomeCode;
}
export function captureJobOperator(value: unknown): string {
  if (typeof value !== 'string' || !JOB_OPERATOR.test(value)) return jobRefuse('operator_invalid');
  return value;
}
export function captureJobResult(policy: JobPolicy, result: unknown): string | null {
  if (result === undefined) return null;
  try {
    return canonicalCommandJson(result, policy.maxInputBytes);
  } catch {
    return jobRefuse('result_invalid');
  }
}
export function captureJobInspectFilter(
  filter: unknown,
  limit: unknown,
): Readonly<{ state?: JobState; job?: string; afterId?: string; limit: number }> {
  exactKeys(filter, [], ['state', 'job', 'afterId']);
  if (filter.state !== undefined && !JOB_STATES.includes(filter.state as JobState)) jobFail();
  if (filter.job !== undefined) {
    jobText(filter.job, 128);
    if (!JOB_ID.test(filter.job)) jobFail();
  }
  if (filter.afterId !== undefined && (typeof filter.afterId !== 'string' || filter.afterId.length !== 36)) jobFail();
  jobInteger(limit, 1, 128);
  return Object.freeze({ ...filter, limit }) as Readonly<{ state?: JobState; job?: string; afterId?: string; limit: number }>;
}
export function captureJobPrune(olderThanMs: unknown, limit: unknown): void {
  jobInteger(olderThanMs, 0, JOB_MAX_CLOCK);
  jobInteger(limit, 1, 1_000);
}
export function captureJobId(id: unknown): string {
  if (typeof id !== 'string' || id.length !== 36) return jobRefuse('job_not_found');
  return id;
}

/** Exponential from the last redrive, so a redriven job starts its backoff
 * over rather than at the ceiling it already reached. */
function jobBackoff(policy: JobPolicy, row: JobRow): number {
  const sinceRedrive = (row.attempts as number) - ((row.attempt_limit as number) - (row.max_attempts as number));
  return Math.min(policy.backoffMs.cap, policy.backoffMs.base * 2 ** (Math.max(1, sinceRedrive) - 1));
}

export function inspectJobRow(policy: JobPolicy, row: JobRow): JobInspection {
  if (
    !JOB_STATES.includes(row.state as JobState) ||
    !safe(row.attempts) ||
    !safe(row.max_attempts) ||
    !safe(row.redrives) ||
    !safe(row.attempt_limit) ||
    (row.max_attempts as number) < 1 ||
    (row.max_attempts as number) > policy.maxAttempts ||
    (row.redrives as number) > JOB_REDRIVE_LIMIT ||
    (row.attempt_limit as number) > JOB_HISTORY_LIMIT ||
    (row.attempts as number) > (row.attempt_limit as number) ||
    !safe(row.run_at) ||
    !safe(row.created_at) ||
    !safe(row.updated_at) ||
    (row.cancel_requested !== 0 && row.cancel_requested !== 1) ||
    (row.last_code !== null && !JOB_CODES.includes(row.last_code as JobOutcomeCode))
  )
    return jobFail();
  if (JOB_HELD.includes(row.state as string)) {
    if (!safe(row.lease_until) || typeof row.fence !== 'string' || row.fence.length !== 36) return jobFail();
  } else if (row.lease_until !== null || row.fence !== null) return jobFail();
  return Object.freeze({
    id: row.id as string,
    job: row.job as string,
    version: row.version as number,
    state: row.state as JobState,
    attempts: row.attempts as number,
    maxAttempts: row.attempt_limit as number,
    redrives: row.redrives as number,
    runAt: row.run_at as number,
    leaseUntil: row.lease_until as number | null,
    cancelRequested: row.cancel_requested === 1,
    lastCode: row.last_code as JobOutcomeCode | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  });
}

/** The row and its complete history agree: numbered without a gap, only the
 * latest attempt may still be leased, every redrive names its operator, and
 * the budget is exactly the one the last redrive granted. */
export function verifyJobRow(policy: JobPolicy, row: JobRow, history: readonly JobRow[]): JobInspection {
  const inspection = inspectJobRow(policy, row);
  // A finished job whose tries were all forgotten by retention (server/retention.ts) has an empty history;
  // the pruner removes a job's tries together, so a partial history is still a defect.
  if (history.length === 0 && (row.attempts as number) > 0 && (row.state === 'succeeded' || row.state === 'cancelled')) return inspection;
  if (history.length !== row.attempts) return jobFail();
  let redrives = 0,
    lastRedrive = 0;
  history.forEach((attempt, i) => {
    if (attempt.attempt !== i + 1 || !safe(attempt.started_at) || !JOB_ATTEMPT_OUTCOMES.includes(attempt.outcome as JobAttemptOutcome))
      return jobFail();
    if (attempt.outcome === 'redriven') {
      if (
        attempt.fence !== null ||
        attempt.deadline !== null ||
        attempt.code !== 'redriven' ||
        attempt.finished_at !== attempt.started_at ||
        typeof attempt.operator !== 'string' ||
        !JOB_OPERATOR.test(attempt.operator)
      )
        return jobFail();
      redrives++;
      lastRedrive = i + 1;
      return;
    }
    if (
      typeof attempt.fence !== 'string' ||
      attempt.fence.length !== 36 ||
      !safe(attempt.deadline) ||
      attempt.deadline <= (attempt.started_at as number) ||
      attempt.operator !== null ||
      (i < history.length - 1 && attempt.outcome === 'leased')
    )
      return jobFail();
  });
  if (redrives !== row.redrives || row.attempt_limit !== lastRedrive + (row.max_attempts as number)) return jobFail();
  const latest = history.at(-1);
  if (
    latest &&
    (row.state === 'leased'
      ? latest.outcome !== 'leased' || latest.fence !== row.fence || latest.deadline !== row.lease_until
      : row.state === 'unknown'
        ? latest.outcome !== 'unknown' || latest.fence !== row.fence || latest.code !== row.last_code
        : latest.outcome === 'leased' || (row.state === 'succeeded' && latest.outcome !== 'succeeded'))
  )
    return jobFail();
  return inspection;
}

export function jobAttemptInspection(row: JobRow): JobAttemptInspection {
  return Object.freeze({
    attempt: row.attempt as number,
    startedAt: row.started_at as number,
    deadline: row.deadline as number | null,
    outcome: row.outcome as JobAttemptOutcome,
    code: row.code as JobOutcomeCode | null,
    finishedAt: row.finished_at as number | null,
    operator: row.operator as string | null,
  });
}

export function jobClaimOf(row: JobRow, attempt: number, fence: string, deadline: number): JobClaim {
  return Object.freeze({
    id: row.id as string,
    fence,
    job: row.job as string,
    version: row.version as number,
    attempt,
    maxAttempts: row.attempt_limit as number,
    input: freezeJson(JSON.parse(row.input_json as string) as unknown),
    provenance: captureJobProvenance(JSON.parse(row.provenance_json as string)),
    deadline,
  });
}

/** Where a settled attempt leaves the job: cancelled if asked, failed at the
 * budget, otherwise a retry after backoff. */
export function jobRelease(policy: JobPolicy, row: JobRow, now: number): { state: JobState; runAt: number; cancelled: boolean } {
  if (row.cancel_requested === 1) return { state: 'cancelled', runAt: row.run_at as number, cancelled: true };
  if ((row.attempts as number) >= (row.attempt_limit as number)) return { state: 'failed', runAt: row.run_at as number, cancelled: false };
  return { state: 'retry', runAt: now + jobBackoff(policy, row), cancelled: false };
}

/** Whether an operator may redrive this row now. */
export function assertJobRedrivable(row: JobRow, now: number): void {
  if (row.state === 'unknown') {
    // The handler may still be running under that lease.
    if (now < (row.lease_until as number)) jobRefuse('lease_held');
  } else if (row.state !== 'failed') jobRefuse('not_redrivable');
  if ((row.redrives as number) >= JOB_REDRIVE_LIMIT) jobRefuse('redrive_limit');
}
