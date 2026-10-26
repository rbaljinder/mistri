/**
 * A record's flow runs, as its page shows them, and a person's
 * start of a manual flow: what the `--jobs` host offers the App's routes
 * while it runs (http/recordFlowRoutes.ts). The host is the one that holds
 * the stores, so it provides this by the App's id when it opens and takes it
 * back when it stops; a server with no `--jobs` host has no runs to show.
 *
 * A run's account is the store's inspection — its state, the step it is at,
 * what it waits for, the sentence that stopped it — never a step's input,
 * result or error text, which may hold what the reader may not see.
 */
import { randomBytes } from 'node:crypto';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { WorkflowStore } from '../../adapters/workflows/workflowStoreContract.js';
import type { WorkflowState } from '../../adapters/workflows/workflowStoreTypes.js';
import { WORKFLOW_JOB_VERSION, workflowJobId, workflowPartition } from './workflowKeys.js';

interface FlowRunStep {
  readonly name: string;
  readonly status: string;
  readonly at: string;
}
interface FlowRun {
  readonly id: string;
  /** The flow's id, as its row says it. */
  readonly flow: string;
  readonly state: WorkflowState;
  readonly waitingFor: string | null;
  readonly wakeAt: string | null;
  readonly problem: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly steps: readonly FlowRunStep[];
}

export interface FlowRunsAccess {
  /** Whether a runner runs this resource's flows. */
  runs(resource: string): boolean;
  /** One record's runs, newest first: at most twenty. */
  of(resource: string, record: string, tenantId?: string): Promise<readonly FlowRun[]>;
  /** Start a manual flow on a record: the runner's dispatch decides, against the record as it is then, whether it starts. */
  start(
    resource: string,
    request: Readonly<{ record: string; target: string; flow: string }>,
    operator: string,
    tenantId?: string,
  ): Promise<void>;
}

const hosts = new Map<string, FlowRunsAccess>();

/** The host's: offer an App's runs while it runs. The returned function takes them back. */
export function provideFlowRuns(appId: string, access: FlowRunsAccess): () => void {
  hosts.set(appId, access);
  return () => {
    if (hosts.get(appId) === access) hosts.delete(appId);
  };
}
export const flowRunsOf = (appId: string): FlowRunsAccess | undefined => hosts.get(appId);

const RUNS_MOST = 20;
const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

export function flowRunsAccess(
  options: Readonly<{
    workflows: WorkflowStore;
    jobs: JobStore;
    appId: string;
    /** Each resource's runner: its workflow's name and principal. */
    runners: ReadonlyMap<string, Readonly<{ workflow: string; runAs: string }>>;
    now: () => number;
    wake: () => void;
  }>,
): FlowRunsAccess {
  const access: FlowRunsAccess = {
    runs: (resource: string) => options.runners.has(resource),
    async of(resource: string, record: string, tenantId?: string) {
      const runner = options.runners.get(resource);
      if (!runner) return [];
      const prefix = `${record}|`;
      const found = await options.workflows.inspect({ workflow: workflowPartition(runner.workflow, tenantId), keyPrefix: prefix }, 100);
      const newest = [...found].sort((a, b) => b.createdAt - a.createdAt).slice(0, RUNS_MOST);
      return Promise.all(
        newest.map(async (run) =>
          Object.freeze({
            id: run.id,
            flow: run.key.slice(prefix.length),
            state: run.state,
            waitingFor: run.state === 'waiting' ? run.waitEvent : null,
            wakeAt: run.state === 'waiting' ? iso(run.wakeAt) : null,
            problem: run.problem,
            startedAt: iso(run.createdAt)!,
            updatedAt: iso(run.updatedAt)!,
            steps: Object.freeze(
              (await options.workflows.steps(run.id)).map((step) =>
                Object.freeze({ name: step.name, status: step.status, at: iso(step.updatedAt)! }),
              ),
            ),
          }),
        ),
      );
    },
    async start(resource, request, operator, tenantId) {
      const runner = options.runners.get(resource);
      if (!runner) throw new Error('No runner runs these flows.');
      const change = `m-${randomBytes(12).toString('hex')}`;
      const key = `flow-${change}`;
      const at = options.now();
      await options.jobs.enqueue(
        {
          job: workflowJobId(runner.workflow),
          version: WORKFLOW_JOB_VERSION,
          idempotencyKey: key,
          input: {
            dispatch: { change, record: request.record, target: request.target, trigger: 'manual', changed: [], flow: request.flow },
          },
          provenance: {
            appId: options.appId,
            actorId: `operator:${operator}`,
            ...(tenantId === undefined ? {} : { tenantId }),
            correlationId: key,
            causationId: key,
          },
        },
        at,
      );
      options.wake();
    },
  };
  return Object.freeze(access);
}
