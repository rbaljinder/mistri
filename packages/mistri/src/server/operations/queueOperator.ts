/**
 * What an operator may do to a running host's queues: its jobs and each of
 * its delivery destinations (a job's, a workflow's, a webhook's), listed by
 * state and redriven by name. The in-process twin of `inspectJobs`,
 * `redriveJobs`, `inspectEventDeliveries` and `redriveEventDeliveries` in
 * maintenance, over the stores the host already holds. The stores' own rules
 * stand: a redrive is recorded with its operator, refused past its limit, and
 * nothing here carries an input, payload, result or error text.
 */
import type { EventDeliveryStore } from '../../adapters/events/eventDeliveryContract.js';
import type {
  EventDeliveryAttemptInspection,
  EventDeliveryInspection,
  EventDeliveryState,
} from '../../adapters/events/eventDeliveryTypes.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { JobAttemptInspection, JobInspection, JobState } from '../../adapters/jobs/jobStoreTypes.js';

export interface JobQueueOperator {
  list(filter: Readonly<{ state?: JobState; after?: string }>, limit: number): Promise<readonly JobInspection[]>;
  attempts(id: string): Promise<readonly JobAttemptInspection[]>;
  redrive(id: string, operator: string): Promise<JobInspection>;
}
export interface DeliveryQueueOperator {
  /** `<kind>:<name>`, stable for one host. */
  readonly id: string;
  readonly kind: 'job' | 'workflow' | 'webhook';
  /** The job, workflow or webhook connection it delivers to. */
  readonly name: string;
  list(filter: Readonly<{ state?: EventDeliveryState; after?: string }>, limit: number): Promise<readonly EventDeliveryInspection[]>;
  attempts(eventId: string): Promise<readonly EventDeliveryAttemptInspection[]>;
  redrive(eventId: string, operator: string): Promise<EventDeliveryInspection>;
}

export function jobQueueOperator(store: JobStore, now: () => number, wake?: () => void): JobQueueOperator {
  return Object.freeze({
    list: (filter: Readonly<{ state?: JobState; after?: string }>, limit: number) =>
      store.inspect({ ...(filter.state ? { state: filter.state } : {}), ...(filter.after ? { afterId: filter.after } : {}) }, limit),
    attempts: (id: string) => store.attempts(id),
    async redrive(id: string, operator: string) {
      const row = await store.redrive(id, operator, now());
      wake?.();
      return row;
    },
  });
}

export function deliveryQueueOperator(
  kind: DeliveryQueueOperator['kind'],
  name: string,
  store: EventDeliveryStore,
  now: () => number,
  wake?: () => void,
): DeliveryQueueOperator {
  return Object.freeze({
    id: `${kind}:${name}`,
    kind,
    name,
    list: (filter: Readonly<{ state?: EventDeliveryState; after?: string }>, limit: number) =>
      store.inspect(filter.state, filter.after ?? '', limit),
    attempts: (eventId: string) => store.attempts(eventId),
    async redrive(eventId: string, operator: string) {
      const row = await store.redrive(eventId, operator, now());
      wake?.();
      return row;
    },
  });
}
