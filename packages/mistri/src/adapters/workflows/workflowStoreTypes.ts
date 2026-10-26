// What the workflow store's rows are called, and the refusal that says the store could not be verified or reached.
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';

/** The workflow store could not be verified or reached. Carries no detail on purpose. */
export class WorkflowStoreUnavailable extends Refusal {
  constructor(message = 'Workflow storage could not be verified. Operator review is required.') {
    super(message);
    this.name = 'WorkflowStoreUnavailable';
  }
}
export const workflowFail = (message?: string): never => {
  throw new WorkflowStoreUnavailable(message);
};

type WorkflowRefusalCode = 'not_found' | 'not_retryable' | 'operator_invalid';
/** A refused call that changed nothing. The code is the whole diagnostic. */
export class WorkflowRefusal extends Refusal {
  constructor(readonly code: WorkflowRefusalCode) {
    super(`The workflow store refused this call: ${code}.`);
    this.name = 'WorkflowRefusal';
  }
}
export const workflowRefuse = (code: WorkflowRefusalCode): never => {
  throw new WorkflowRefusal(code);
};

/** `running`: advancing now, or ready to. `waiting`: suspended at a step, to be woken by its time or its event. */
export type WorkflowState = 'running' | 'waiting' | 'completed' | 'failed' | 'diverged' | 'cancelled';
export const WORKFLOW_STATES: readonly WorkflowState[] = Object.freeze([
  'running',
  'waiting',
  'completed',
  'failed',
  'diverged',
  'cancelled',
]);
export const LIVE_STATES: readonly WorkflowState[] = Object.freeze(['running', 'waiting']);

export type StepKind = 'run' | 'call' | 'sleep' | 'until' | 'waitFor' | 'now';
export const STEP_KINDS: readonly StepKind[] = Object.freeze(['run', 'call', 'sleep', 'until', 'waitFor', 'now']);
/** `pending`: begun and not done (a back-off, a timer, a wait). `refused`: the step said no, for good. `failed`: its attempts ran out. */
export type StepStatus = 'pending' | 'completed' | 'refused' | 'failed';
export const STEP_STATUSES: readonly StepStatus[] = Object.freeze(['pending', 'completed', 'refused', 'failed']);

/** The most a persisted payload or result may weigh. */
export const WORKFLOW_JSON_MAX = 65_536;
/** Signals one wait reads at a time. */
export const SIGNAL_PAGE = 256;
export const WORKFLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Who retried or cancelled a workflow: an operator's stable id, as the jobs' redrive takes. */
export const WORKFLOW_OPERATOR = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

export interface WorkflowInstance {
  readonly id: string;
  readonly workflow: string;
  readonly version: number;
  readonly key: string;
  readonly state: WorkflowState;
  /** Moves with every change the advancing run makes, so a run another change overtook finds out. */
  readonly epoch: number;
  readonly startEventId: string;
  readonly startJson: string;
  /** Signals recorded before this one began are not its. */
  readonly signalFloor: number;
  /** `name@version` of the event a waiting instance is waiting for. */
  readonly waitEvent: string | null;
  readonly wakeAt: number | null;
  readonly currentStep: string | null;
  readonly problem: string | null;
  readonly problemStep: string | null;
  readonly problemJson: string | null;
  readonly resultJson: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkflowStep {
  readonly name: string;
  /** Insertion order within the instance: what a retry from a step cuts at. */
  readonly ordinal: number;
  readonly kind: StepKind;
  readonly hash: string;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly wakeAt: number | null;
  readonly resultJson: string | null;
  /** The event a wait took, so no other wait takes it again. */
  readonly eventId: string | null;
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type StepWrite = Omit<WorkflowStep, 'ordinal' | 'createdAt' | 'updatedAt'>;

export interface WorkflowSignal {
  readonly seq: number;
  readonly eventId: string;
  readonly name: string;
  readonly version: number;
  readonly payloadJson: string;
}

/** What operators see: no start payload, no results, no error text. */
export interface WorkflowInspection {
  readonly id: string;
  readonly workflow: string;
  readonly version: number;
  readonly key: string;
  readonly state: WorkflowState;
  readonly currentStep: string | null;
  readonly waitEvent: string | null;
  readonly wakeAt: number | null;
  readonly problem: string | null;
  readonly problemStep: string | null;
  /** A `workflow_error`'s error, by its name and code alone: never its message. Absent for any other problem. */
  readonly problemError?: WorkflowProblemError;
  readonly createdAt: number;
  readonly updatedAt: number;
}
/** What an operator may know of an error a workflow's own code threw: its name and code, never its message. */
export interface WorkflowProblemError {
  readonly name: string;
  readonly code?: string;
}
/* A name is an identifier and a code a short token: neither can carry a sentence, a value or a credential's
   punctuation, and together they stay within about 120 characters. */
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,59}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
/** An error's name and code, checked; anything else about it is left behind. Undefined when it has no name to keep. */
export function workflowProblemError(error: unknown): WorkflowProblemError | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  let name: unknown, code: unknown;
  try {
    ({ name, code } = error as { name?: unknown; code?: unknown });
  } catch {
    return undefined;
  }
  if (typeof name !== 'string' || !ERROR_NAME.test(name)) return undefined;
  const coded = typeof code === 'number' && Number.isInteger(code) ? String(code) : code;
  return typeof coded === 'string' && ERROR_CODE.test(coded) ? { name, code: coded } : { name };
}
export interface WorkflowStepInspection {
  readonly name: string;
  readonly ordinal: number;
  readonly kind: StepKind;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly wakeAt: number | null;
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
/** An operator's Cancel or Retry, kept with the instance: who, and when. */
export interface WorkflowActionInspection {
  readonly action: 'cancel' | 'retry';
  readonly operator: string;
  readonly at: number;
}
export interface WorkflowPruneResult {
  readonly pruned: number;
  /** The batch was full: call again for the next one. */
  readonly more: boolean;
}

export type WorkflowOutcome =
  | Readonly<{ state: 'completed'; resultJson: string | null }>
  | Readonly<{ state: 'failed'; problem: string; problemStep: string | null; problemJson?: string }>
  | Readonly<{ state: 'diverged'; problem: 'diverged'; problemStep: string; problemJson: string }>;
