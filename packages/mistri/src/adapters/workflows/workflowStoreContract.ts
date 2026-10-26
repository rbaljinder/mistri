/*
 * The workflow store contract both engines satisfy: the SQLite store
 * (workflowStore.ts) and the PostgreSQL store (postgresWorkflowStore.ts),
 * which share their rules in workflowStoreCore.ts. The runner (server/workflows)
 * and maintenance depend on this and never on an engine.
 */
import type {
  StepWrite,
  WorkflowActionInspection,
  WorkflowInspection,
  WorkflowInstance,
  WorkflowOutcome,
  WorkflowPruneResult,
  WorkflowSignal,
  WorkflowState,
  WorkflowStep,
  WorkflowStepInspection,
} from './workflowStoreTypes.js';

export interface WorkflowWait {
  /** The step the instance is suspended at. */
  readonly step: string | null;
  /** An event to wake on, besides the time. */
  readonly event?: Readonly<{ name: string; version: number }>;
  readonly wakeAt: number | null;
  /** The newest signal the run read for this event: one recorded since is a wake the run has not seen. */
  readonly seenSeq: number;
}

/**
 * The durable state of workflow instances: what each is at, the steps it
 * has taken, and the signals (committed facts) it may yet wait on.
 *
 * Every method is one bounded transaction; no step, handler or network call
 * ever runs inside one. An advancing run holds its instance's `epoch` and
 * presents it with every change: a cancel, a retry or a newer run moves the
 * epoch, and the older run's next write is refused (undefined) rather than
 * applied. `now` is the caller's clock.
 */
export interface WorkflowStore {
  /** A new instance for a start event, or the one that event already started. Undefined when a live instance already holds the key. */
  start(
    input: Readonly<{ workflow: string; version: number; key: string; eventId: string; startJson: string }>,
    now: number,
  ): Promise<Readonly<{ id: string; created: boolean }> | undefined>;
  /** Record a fact a live instance of the workflow may wait on, and say which instances are waiting for it. Nothing is recorded when none is live. */
  signal(
    input: Readonly<{ workflow: string; eventId: string; name: string; version: number; payloadJson: string }>,
    now: number,
  ): Promise<readonly string[]>;
  /** Take the instance to advance: running, with a new epoch, and its steps. Undefined when it is gone or over,
   * or when `workflow` is given and the instance is not of it (a tenant's partition: another tenant's id finds nothing). */
  begin(
    id: string,
    now: number,
    workflow?: string,
  ): Promise<Readonly<{ instance: WorkflowInstance; steps: readonly WorkflowStep[] }> | undefined>;
  /** The signals for one event after `afterSeq`, oldest first. */
  signals(workflow: string, name: string, version: number, afterSeq: number): Promise<readonly WorkflowSignal[]>;
  /** Persist one step (insert or update by name). The instance's new epoch, or undefined when the run was overtaken. */
  step(id: string, epoch: number, write: StepWrite, now: number): Promise<number | undefined>;
  /** Suspend at a wait: `waiting`, with the epoch it is at. 'signal' when a fact it waits on arrived unseen: the run reads again. */
  suspend(id: string, epoch: number, wait: WorkflowWait, now: number): Promise<Readonly<{ epoch: number }> | 'signal' | undefined>;
  /** Stay running for a later advance (the run's time is up): the new epoch. */
  release(id: string, epoch: number, now: number): Promise<number | undefined>;
  finish(id: string, epoch: number, outcome: WorkflowOutcome, now: number): Promise<boolean>;
  /** A live instance is cancelled outright, and the operator kept in its history; one already over is unchanged. */
  cancel(id: string, operator: string, now: number): Promise<Readonly<{ outcome: 'cancelled' | 'unchanged'; state: WorkflowState }>>;
  /** A failed or diverged instance runs again from its last good step: the step that stopped it, and every one after, is forgotten. The operator is kept in its history.
   * A running or waiting instance is woken where it is, with a new epoch and nothing forgotten: the caller enqueues its wake-up.
   * `admit`, asked of the instance's `workflow` before anything changes, refuses it as not_retryable when false: whoever wakes it must be able to. */
  retry(id: string, operator: string, now: number, admit?: (workflow: string) => boolean): Promise<WorkflowInstance>;
  /** Private bounded diagnostics: no payload, result or error text. */
  inspect(
    filter?: Readonly<{ state?: WorkflowState; workflow?: string; afterId?: string; keyPrefix?: string }>,
    limit?: number,
  ): Promise<readonly WorkflowInspection[]>;
  steps(id: string): Promise<readonly WorkflowStepInspection[]>;
  /** The operators' Cancels and Retries of one instance, oldest first. */
  actions(id: string): Promise<readonly WorkflowActionInspection[]>;
  /** Deletes up to `limit` completed or cancelled instances, with their steps, last changed more than `olderThanMs` ago, and the signals no live instance can still read. */
  prune(olderThanMs: number, now: number, limit?: number): Promise<WorkflowPruneResult>;
  close(): Promise<void>;
}
