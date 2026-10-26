/**
 * What starts a row-driven flow: the record's own history. A
 * resource with flows keeps one (recordHistory.ts), and the jobs host reads
 * its new rows each cycle, oldest first from a cursor, and hands each change
 * to the resource's runner as a dispatch job (workflowHost.ts) — the job, not
 * this tail, decides which flows the change starts, against the record as it
 * is then. Nothing polls a record, and a write never waits for a flow.
 *
 * Why a cursor that lags: a history row's id is taken when it is written and
 * becomes visible when its transaction commits, so a row may appear behind
 * one already read. The cursor passes a row only once it is a minute old,
 * which no write lasts; until then the row is remembered as seen. A restart
 * looks back a day, and the job store's key (the row's id) and the start's id
 * keep a change from starting a flow twice.
 *
 * A change a flow made (its writes carry the runner's actor) starts nothing:
 * a flow that sets a field its own trigger watches would otherwise run on
 * itself without end.
 */
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { FlowDispatch } from './workflowHost.js';
import { WORKFLOW_JOB_VERSION, workflowJobId } from './workflowKeys.js';

/** A history row of a resource with flows, as the host's reader maps it. */
export interface FlowChange {
  readonly id: number;
  /** When it was written, in milliseconds. */
  readonly at: number;
  /** The runner of the resource's flows, and its principal. */
  readonly workflow: string;
  readonly runAs: string;
  /** Its writer: a flow's own, or anyone else. */
  readonly byFlow: boolean;
  readonly dispatch: Omit<FlowDispatch, 'change'>;
  readonly tenantId?: string;
}

/** The rows after `after` (the first read: since `from`), oldest first, at most a page. */
export type FlowChangeReader = (query: Readonly<{ after?: number; from?: string }>) => Promise<readonly FlowChange[]>;

const SETTLE_MS = 60_000;
const LOOK_BACK_MS = 24 * 60 * 60_000;

export function createFlowTail(options: Readonly<{ read: FlowChangeReader; jobs: JobStore; appId: string; now: () => number }>): {
  tick(): Promise<boolean>;
} {
  let cursor: number | undefined;
  const seen = new Set<number>();
  return {
    async tick() {
      const at = options.now();
      let rows: readonly FlowChange[];
      try {
        rows = await options.read(cursor === undefined ? { from: new Date(at - LOOK_BACK_MS).toISOString() } : { after: cursor });
      } catch {
        // History unavailable now: the next cycle reads from the same cursor.
        return false;
      }
      let enqueued = false,
        settled = true;
      for (const row of rows) {
        if (!seen.has(row.id) && !row.byFlow) {
          const key = `flow-change-${String(row.id).padStart(12, '0')}`;
          try {
            await options.jobs.enqueue(
              {
                job: workflowJobId(row.workflow),
                version: WORKFLOW_JOB_VERSION,
                idempotencyKey: key,
                input: { dispatch: { ...row.dispatch, change: `h${row.id}` } },
                provenance: {
                  appId: options.appId,
                  actorId: `service:${row.runAs}`,
                  ...(row.tenantId === undefined ? {} : { tenantId: row.tenantId }),
                  correlationId: key,
                  causationId: key,
                },
              },
              at,
            );
            enqueued = true;
          } catch {
            // Not enqueued: the cursor stops here, and the next cycle tries this row again under the same key.
            return enqueued;
          }
        }
        seen.add(row.id);
        // The cursor passes the rows that cannot have an earlier row still committing behind them.
        settled &&= row.at <= at - SETTLE_MS;
        if (settled) cursor = row.id;
      }
      // Until a row settles the reads stay a window on the last day, so a quiet store never reads from its beginning.
      for (const id of seen) if (cursor !== undefined && id <= cursor) seen.delete(id);
      return enqueued;
    },
  };
}
