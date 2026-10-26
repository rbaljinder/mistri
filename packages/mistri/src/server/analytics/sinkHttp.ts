/**
 * Delivery of the analytics stream to a warehouse: the outbox pattern applied
 * to the append-only table. A sink is a position (`sink_cursors`) and a
 * transport; a job on the existing job runner reads the rows after the
 * position, POSTs them, and moves the position only after a 2xx answer. A
 * crash between the answer and the move sends the same batch again under the
 * same `Idempotency-Key`, so the receiver can drop it. Retry, failure and
 * redrive are the jobs store's (`inspectJobs`, `redriveJobs`).
 *
 * A sink with a `preset` (Segment, PostHog, Amplitude, GA4, a warehouse) is
 * the same delivery over its vendor's own request: sinkPresets.ts.
 */
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { Webhook } from '../commands/commandEffects.js';
import { defineJobHandler, JobRejected, type JobDefinition } from '../jobs/jobs.js';
import type { AnalyticsEventRow, AnalyticsStore } from './store.js';

export const ANALYTICS_SINK_JOB = 'analyticsSink';
export const ANALYTICS_BATCH_FORMAT = 'mistri.analytics.v1';

export interface AnalyticsSink {
  readonly id: string;
  readonly batch: number;
  /** `accepted` promises durable acceptance; `rejected` promises none and is final. Anything thrown is unknown: asked again. */
  send(events: readonly AnalyticsEventRow[], options: { readonly idempotencyKey: string }): Promise<'accepted' | 'rejected'>;
}

/** The batch's key: the same rows always have the same one, whatever attempt or process sends them. */
const analyticsBatchKey = (sink: string, events: readonly AnalyticsEventRow[]): string =>
  `analytics:${sink}:${events[0].id}-${events.at(-1)!.id}`;

/** The wire form of a row: opaque ids and what the declaration allowed, nothing else. */
export const wire = (row: AnalyticsEventRow) => ({
  id: row.id,
  occurredAt: new Date(row.occurredAt).toISOString(),
  receivedAt: new Date(row.receivedAt).toISOString(),
  environment: row.environment,
  tenantId: row.tenantId,
  kind: row.kind,
  name: row.name,
  step: row.step,
  unitKind: row.unitKind,
  unitId: row.unitId,
  fields: row.fields,
  sourceEventId: row.sourceEventId,
});

/** An `http` sink over a webhook connection: 2xx accepted, a 4xx other than 408 and 429 rejected, the rest unknown. */
export function createHttpAnalyticsSink(options: { id: string; batch: number; webhook: Webhook }): AnalyticsSink {
  return Object.freeze({
    id: options.id,
    batch: options.batch,
    async send(events: readonly AnalyticsEventRow[], { idempotencyKey }: { readonly idempotencyKey: string }) {
      const status = await options.webhook.post({ format: ANALYTICS_BATCH_FORMAT, events: events.map(wire) }, idempotencyKey);
      if (status >= 200 && status < 300) return 'accepted';
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'rejected';
      throw new Error(`The analytics sink answered ${status}.`);
    },
  });
}

/**
 * One batch to one sink: the rows after its position, sent, and the position moved only after acceptance.
 * `empty` when nothing waits (or another process already moved the position), `rejected` when the receiver
 * refused for good, `sent` with how many otherwise. A thrown error is unknown: the position did not move.
 */
export async function deliverAnalyticsBatch(
  store: AnalyticsStore,
  sink: AnalyticsSink,
  options: { now: number; settleMs?: number; expectedPosition?: number },
): Promise<{ status: 'empty' | 'rejected' } | { status: 'sent'; sent: number }> {
  const position = await store.ensureCursor(sink.id, options.now);
  // Moved on by an earlier attempt that was answered but not recorded: nothing to send.
  if (options.expectedPosition !== undefined && position !== options.expectedPosition) return { status: 'empty' };
  const events = await store.readAfter(position, sink.batch, options.now - (options.settleMs ?? 2000));
  if (!events.length) return { status: 'empty' };
  if ((await sink.send(events, { idempotencyKey: analyticsBatchKey(sink.id, events) })) === 'rejected') return { status: 'rejected' };
  await store.advanceCursor(sink.id, position, events.at(-1)!.id, options.now);
  return { status: 'sent', sent: events.length };
}

interface SinkInput {
  readonly sink: string;
  readonly after: number;
}

/** The job: send the batch after `after` if the sink is still there, then move it. Registered once for every sink. */
export function analyticsSinkJob(options: {
  store: AnalyticsStore;
  sinks: readonly AnalyticsSink[];
  settleMs?: number;
}): JobDefinition<SinkInput> {
  const sinks = new Map(options.sinks.map((sink) => [sink.id, sink]));
  return defineJobHandler<SinkInput>({
    version: 1,
    input: {
      parse: (value: unknown): SinkInput => {
        const input = value as Partial<SinkInput> | null;
        if (!input || typeof input.sink !== 'string' || !Number.isSafeInteger(input.after) || (input.after as number) < 0)
          throw new Error('An analytics sink job names a sink and a position.');
        return { sink: input.sink, after: input.after as number };
      },
    },
    async handle(context, input) {
      const sink = sinks.get(input.sink);
      if (!sink) throw new JobRejected(`No analytics sink "${input.sink}" is configured.`);
      const result = await deliverAnalyticsBatch(options.store, sink, {
        now: context.now(),
        expectedPosition: input.after,
        ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
      });
      if (result.status === 'rejected') throw new JobRejected('The analytics sink refused this batch.');
      return { sent: result.status === 'sent' ? result.sent : 0 };
    },
  });
}

/** One job per sink position that has rows waiting: the key is the position, so asking twice enqueues once. Returns how many were enqueued. */
export async function enqueueAnalyticsSinkJobs(options: {
  store: AnalyticsStore;
  jobs: JobStore;
  sinks: readonly AnalyticsSink[];
  appId: string;
  now?: () => number;
  settleMs?: number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  let enqueued = 0;
  for (const sink of options.sinks) {
    const position = await options.store.ensureCursor(sink.id, now());
    if (!(await options.store.readAfter(position, 1, now() - (options.settleMs ?? 2000))).length) continue;
    const result = await options.jobs.enqueue(
      {
        job: ANALYTICS_SINK_JOB,
        version: 1,
        idempotencyKey: `analytics-sink-${sink.id.replaceAll('.', '_')}-${position}`,
        input: { sink: sink.id, after: position },
        provenance: { appId: options.appId, actorId: 'analytics-sink' },
      },
      now(),
    );
    if (!result.replayed) enqueued++;
  }
  return enqueued;
}
