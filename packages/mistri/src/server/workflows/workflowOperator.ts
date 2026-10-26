/**
 * What an operator may do to the workflow instances of the running host
 *: the list, one instance's steps, Cancel and Retry. The room over
 * HTTP (operations/workflowOperationsHttp.ts) is a thin reading of this. It
 * is the in-process twin of `inspectWorkflows`, `cancelWorkflow` and
 * `retryWorkflow` in maintenance: the same stores and the same rules, over
 * the connections the host already holds rather than ones of its own.
 */
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { WorkflowStore } from '../../adapters/workflows/workflowStoreContract.js';
import {
  WORKFLOW_OPERATOR,
  workflowRefuse,
  type WorkflowActionInspection,
  type WorkflowInspection,
  type WorkflowState,
  type WorkflowStepInspection,
} from '../../adapters/workflows/workflowStoreTypes.js';
import { retryAdmits, wakeKey, WORKFLOW_JOB_VERSION, workflowJobId, workflowOfPartition } from './workflowKeys.js';

export interface WorkflowOperator {
  list(
    filter: Readonly<{ state?: WorkflowState; workflow?: string; after?: string }>,
    limit: number,
  ): Promise<readonly WorkflowInspection[]>;
  steps(id: string): Promise<readonly WorkflowStepInspection[]>;
  /** Who cancelled or retried the instance, and when. */
  actions(id: string): Promise<readonly WorkflowActionInspection[]>;
  cancel(id: string, operator: string): Promise<Readonly<{ outcome: 'cancelled' | 'unchanged'; state: WorkflowState }>>;
  /** On a tenant App, `tenantId` names the instance's tenant: without it, or with another, a tenant's instance is not retryable. */
  retry(id: string, operator: string, tenantId?: string): Promise<WorkflowInspection>;
}

export function createWorkflowOperator(
  options: Readonly<{
    workflows: WorkflowStore;
    jobs: JobStore;
    appId: string;
    now: () => number;
    wake?: () => void;
  }>,
): WorkflowOperator {
  const { workflows, jobs, appId, now } = options;
  const named = (operator: string): string => (WORKFLOW_OPERATOR.test(operator) ? operator : workflowRefuse('operator_invalid'));
  const built: WorkflowOperator = {
    list: (filter, limit) =>
      workflows.inspect(
        {
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.workflow === undefined ? {} : { workflow: filter.workflow }),
          ...(filter.after === undefined ? {} : { afterId: filter.after }),
        },
        limit,
      ),
    steps: (id) => workflows.steps(id),
    actions: (id) => workflows.actions(id),
    async cancel(id, operator) {
      return workflows.cancel(id, named(operator), now());
    },
    async retry(id, operator, tenantId) {
      named(operator);
      const at = now();
      const instance = await workflows.retry(id, operator, at, retryAdmits(tenantId));
      await jobs.enqueue(
        {
          job: workflowJobId(workflowOfPartition(instance.workflow).name),
          version: WORKFLOW_JOB_VERSION,
          idempotencyKey: wakeKey('retry', instance.id, instance.epoch),
          input: { instance: instance.id },
          provenance: {
            appId,
            actorId: `operator:${operator}`,
            ...(tenantId === undefined ? {} : { tenantId }),
            correlationId: instance.id,
            causationId: instance.id,
          },
        },
        at,
      );
      options.wake?.();
      return Object.freeze({
        id: instance.id,
        workflow: instance.workflow,
        version: instance.version,
        key: instance.key,
        state: instance.state,
        currentStep: instance.currentStep,
        waitEvent: instance.waitEvent,
        wakeAt: instance.wakeAt,
        problem: instance.problem,
        problemStep: instance.problemStep,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
      });
    },
  };
  return Object.freeze(built);
}
