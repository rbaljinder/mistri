/**
 * A job at times run once now, by hand (OP9): `mistri jobs run <name>` for an operator, and a test's
 * `host.runJob` (jobHost.ts runNow). The run is enqueued in the job store the schedule enqueues its slots in, under a
 * key of its own (`manual-…`), so the same runner claims it, it is journaled as a slot's run is, and the store tells
 * it apart. The store runs a job at times one at a time (jobStoreRules.ts oneAtATime): a manual run waits while the
 * schedule's run of that job holds its lease, and the schedule's next slot waits for it. On a tenant App a job per
 * tenant is run by hand for one tenant, its run carrying that tenant as its slot's would; manual runs of it still go
 * one at a time, but a tenant's own slot carries its tenant in a longer key and is not held back by one.
 */
import { randomBytes } from 'node:crypto';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { JobInspection } from '../../adapters/jobs/jobStoreTypes.js';
import type { CapturedJob, CapturedJobModule } from './jobModule.js';

/** A manual run's key: when it was asked for, and enough chance that two asked in one millisecond are two. */
const manualRunKey = (at: number): string => `manual-${String(at).padStart(16, '0')}-${randomBytes(12).toString('base64url')}`;

/** Whether a person may run the job now: a job at times run once on the platform, or, where the caller runs it
 * for a tenant it names (`perTenant`), one run per tenant too. */
const byHand = (job: CapturedJob | undefined, perTenant: boolean): job is CapturedJob =>
  Boolean(job?.every && (perTenant || job.realm !== 'tenant'));

/** The job named, or why it cannot be run now, with the names that can. */
export function jobToRun(module: Pick<CapturedJobModule, 'jobs'>, name: string, perTenant = false): CapturedJob | string {
  const job = module.jobs.get(name);
  if (byHand(job, perTenant)) return job;
  const names = [...module.jobs.values()].filter((each) => byHand(each, perTenant)).map((each) => `"${each.id}"`);
  return `"${name}" is not one of this App's jobs at times (${names.join(', ') || 'it has none'}).`;
}

/** Enqueue one run of `job` now, under a manual key, as its service principal, for `tenantId` where it runs per
 * tenant (the server admits it there, as a slot's run): the row's id and its key. */
export async function enqueueManualRun(
  jobs: JobStore,
  appId: string,
  job: Pick<CapturedJob, 'id' | 'version' | 'input' | 'runAs'>,
  at: number,
  tenantId?: string,
): Promise<{ id: string; key: string }> {
  const key = manualRunKey(at);
  const { id } = await jobs.enqueue(
    {
      job: job.id,
      version: job.version,
      idempotencyKey: key,
      input: { key: {}, input: job.input ?? {} },
      runAt: at,
      provenance: {
        appId,
        actorId: `service:${job.runAs}`,
        ...(tenantId === undefined ? {} : { tenantId }),
        correlationId: key,
        causationId: key,
      },
    },
    at,
  );
  return { id, key };
}

/** The run's row, paged through in insertion order however many came before it. */
export async function findRun(jobs: JobStore, job: string, id: string): Promise<JobInspection | undefined> {
  let after: string | undefined;
  for (;;) {
    const page = await jobs.inspect({ job, ...(after ? { afterId: after } : {}) }, 128);
    const hit = page.find((row) => row.id === id);
    if (hit || page.length < 128) return hit;
    after = page[page.length - 1].id;
  }
}

/** Whether the run's first attempt has ended: done, refused, or waiting for a retry. */
export const attemptEnded = (row: JobInspection | undefined): JobInspection | undefined =>
  row !== undefined && row.attempts > 0 && row.state !== 'leased' ? row : undefined;
