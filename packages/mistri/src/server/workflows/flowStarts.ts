/**
 * `mistri flows start` (cli/flowsCommand.ts): records that were there
 * before their flows were, each handed to the resource's flows runner as
 * though it had just been created. Nothing runs here. Each record becomes a
 * dispatch job in the App's job store, the same job the history tail writes
 * (flowTail.ts), and a server started with `--jobs` decides, against the
 * record as it is then, which of its `created` flows start (`--flow` narrows
 * them to one).
 *
 * Why keyed: a backfill is run again after it stops halfway, or by a second
 * operator who was not sure. The job's key and the dispatch's change id are
 * both a hash of the App, the runner, the record and the flow, so the job
 * store replays a key it already holds, and the workflow store never starts
 * an instance twice for one change. Running it again starts nothing new.
 *
 * Records are read a page at a time, in key order, from after the last key
 * a page ended on, so a table of any size is read in bounded memory and a
 * record written meanwhile is neither read twice nor skipped behind it.
 */
import { createHash } from 'node:crypto';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { historyKey } from '../../adapters/history/recordHistory.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import type { FlowDispatch } from './workflowHost.js';
import { WORKFLOW_JOB_VERSION, workflowJobId } from './workflowKeys.js';

/** Records read, and dispatches enqueued, per page. */
const PAGE = 200;

interface FlowStartsRequest {
  /** Reads the resource's own table. */
  readonly adapter: Pick<Adapter, 'query'>;
  /** The resource's physical table and its one key column. */
  readonly table: string;
  readonly keyColumn: string;
  /** On a tenant App: the column that owns a record, and the one tenant whose records start. */
  readonly owner?: Readonly<{ column: string; tenant: string }>;
  /** `--where`: which records, over the record's own columns. */
  readonly filter?: Filter;
  readonly jobs: Pick<JobStore, 'enqueue'>;
  readonly appId: string;
  /** The runner of the resource's flows, and the principal it runs as. */
  readonly runner: Readonly<{ workflow: string; runAs: string }>;
  /** One flow's id, or every `created` flow whose condition holds. */
  readonly flow?: string;
  readonly now: () => number;
  /** Count the records, enqueue nothing. */
  readonly dryRun?: boolean;
}

interface FlowStarts {
  /** Records read. */
  readonly records: number;
  /** Dispatches newly enqueued, and those an earlier run had already. */
  readonly enqueued: number;
  readonly already: number;
  /** Records whose key no history can keep (too long), which no flow could run on. */
  readonly skipped: number;
}

export async function startFlows(request: FlowStartsRequest): Promise<FlowStarts> {
  const { keyColumn, owner } = request;
  const groups = request.filter?.groups.length ? request.filter.groups : [[]];
  const scoped = (after: string | number | undefined): Filter | undefined => {
    const extra: Condition[] = [
      ...(owner ? [{ column: owner.column, op: '=' as const, value: owner.tenant }] : []),
      ...(after === undefined ? [] : [{ column: keyColumn, op: '>' as const, value: after }]),
    ];
    const scopedGroups = groups.map((group) => [...group, ...extra]).filter((group) => group.length);
    return scopedGroups.length ? { groups: scopedGroups } : undefined;
  };
  let after: string | number | undefined;
  let records = 0,
    enqueued = 0,
    already = 0,
    skipped = 0;
  for (;;) {
    const filter = scoped(after);
    const page = await request.adapter.query({
      table: request.table,
      columns: [keyColumn],
      ...(filter ? { filter } : {}),
      orderBy: [{ column: keyColumn, direction: 'asc' }],
      limit: PAGE,
      offset: 0,
    });
    for (const row of page.rows) {
      const value = row[keyColumn];
      if (typeof value !== 'string' && typeof value !== 'number') {
        skipped++;
        continue;
      }
      records++;
      // The record as its history names it: a tenant App's key holds its owner, which is whose run it is (flowChanges.ts).
      let record: string;
      try {
        record = historyKey(owner ? { [keyColumn]: value, [owner.column]: owner.tenant } : { [keyColumn]: value });
      } catch {
        skipped++;
        continue;
      }
      const target = String(value);
      if (record.length > 440 || !target || target.length > 512) {
        skipped++;
        continue;
      }
      if (request.dryRun) continue;
      const hash = createHash('sha256')
        .update(`${request.appId}\n${request.runner.workflow}\n${record}\n${request.flow ?? ''}`)
        .digest('hex')
        .slice(0, 40);
      const key = `flow-start-${hash}`;
      const dispatch: FlowDispatch = {
        change: `s${hash}`,
        record,
        target,
        trigger: 'created',
        changed: [],
        ...(request.flow === undefined ? {} : { flow: request.flow }),
      };
      const done = await request.jobs.enqueue(
        {
          job: workflowJobId(request.runner.workflow),
          version: WORKFLOW_JOB_VERSION,
          idempotencyKey: key,
          input: { dispatch },
          provenance: {
            appId: request.appId,
            actorId: `service:${request.runner.runAs}`,
            ...(owner ? { tenantId: owner.tenant } : {}),
            correlationId: key,
            causationId: key,
          },
        },
        request.now(),
      );
      if (done.replayed) already++;
      else enqueued++;
    }
    if (page.rows.length < PAGE) break;
    const last = page.rows.at(-1)![keyColumn];
    if (typeof last !== 'string' && typeof last !== 'number') break;
    after = last;
  }
  return Object.freeze({ records, enqueued, already, skipped });
}
