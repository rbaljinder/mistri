/*
 * The job store contract both engines satisfy: the SQLite store (jobStore.ts)
 * and the PostgreSQL store (postgresJobStore.ts). The runner, maintenance and
 * the contract suite depend on this and never on an engine.
 */
import type {
  JobAttemptInspection,
  JobCancelOutcome,
  JobClaim,
  JobEnqueued,
  JobEnqueueInput,
  JobInspection,
  JobOutcomeCode,
  JobPolicy,
  JobPruneResult,
  JobState,
} from './jobStoreTypes.js';

/**
 * The durable job store, as both engines provide it. Every method is one
 * bounded store transaction; no caller callback, handler or network call
 * ever runs inside one, and on PostgreSQL no pooled client is held between
 * calls. A coded `JobRefusal` changed nothing; any other failure is
 * `JobStoreUnavailable` and the store's account of the job stands.
 *
 * `now` is the caller's clock. A store that keeps its own (PostgreSQL, by
 * default: the database's) uses that instead, so hosts whose clocks disagree
 * cannot trip each other's clock floor; the persisted floor still stops the
 * store if the clock it does use runs backwards.
 */
export interface JobStore {
  readonly policy: JobPolicy;
  /** Idempotent by (job, idempotencyKey) within the namespace: the same
   * fingerprint replays the accepted job; a different one is a conflict. */
  enqueue(input: JobEnqueueInput, now: number): Promise<JobEnqueued>;
  /** Leases due jobs FIFO by timer then insertion, up to `limit` and the
   * namespace's in-flight bound. Expired leases are released first. Two
   * claimers never lease the same attempt. */
  claim(now: number, limit?: number): Promise<readonly JobClaim[]>;
  /** The handler resolved: its effect happened. */
  succeed(id: string, fence: string, now: number, result?: unknown): Promise<JobInspection>;
  /** Terminal. 'cancelled' records a handler that stopped without effect. */
  fail(id: string, fence: string, now: number, outcome: JobOutcomeCode): Promise<JobInspection>;
  /** Next attempt after exponential backoff; the budget turns the same code
   * into a failure, and a requested cancel ends the job instead. */
  retry(id: string, fence: string, now: number, outcome: JobOutcomeCode): Promise<JobInspection>;
  /** The effect may or may not have happened: the lease is kept until it
   * expires, and only then is the job leased again. */
  unknown(id: string, fence: string, now: number, outcome: JobOutcomeCode): Promise<JobInspection>;
  /** Waiting jobs are cancelled outright; a held lease is only asked to stop. */
  cancel(id: string, now: number): Promise<Readonly<{ outcome: JobCancelOutcome; state: JobState }>>;
  expireLeases(now: number): Promise<number>;
  /** Whether a cancel was requested while this fence holds the lease. */
  cancelRequested(id: string, fence: string): Promise<boolean>;
  /** Private bounded diagnostics: no input, result, provenance or error text. */
  inspect(filter?: Readonly<{ state?: JobState; job?: string; afterId?: string }>, limit?: number): Promise<readonly JobInspection[]>;
  attempts(id: string): Promise<readonly JobAttemptInspection[]>;
  /** Operator maintenance: a failed job, or an unknown one whose lease has
   * run out, goes back to retry with a fresh attempt budget, recorded as a
   * history row naming the operator. Succeeded and cancelled jobs refuse. */
  redrive(id: string, operator: string, now: number): Promise<JobInspection>;
  /** Deletes up to `limit` succeeded jobs, with their history, last settled
   * more than `olderThanMs` ago. The idempotency key goes with them. */
  prune(olderThanMs: number, now: number, limit?: number): Promise<JobPruneResult>;
  close(): Promise<void>;
}
