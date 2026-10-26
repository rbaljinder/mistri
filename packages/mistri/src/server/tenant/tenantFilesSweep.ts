/**
 * A tenant App's file sweep, as its job host runs it: the built-in job
 * `mistri-files-sweep` once a day at the minute the App's id picks, one run
 * per active tenant (jobs/jobHost.ts `realm: 'tenant'`), each deleting only
 * objects under its own tenant's prefix that none of its own rows names
 * (files/filesCli.ts sweepTenantFiles). The rows are read over the
 * deployment's source itself, as `mistri migrate files sweep` reads them:
 * a maintenance read of one column, filtered by the tenant's ownership
 * column, never a request's reader.
 */
import { bucketResources } from '../files/fileStorage.js';
import type { BuiltInJob } from '../jobs/jobHost.js';
import { parseEvery } from '../jobs/jobSchedule.js';
import { FILES_SWEEP_JOB, filesSweepEvery, sweepTenantFiles } from '../files/filesCli.js';
import type { AppDef } from '../../shared/app.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';

export function tenantFilesSweep(
  app: AppDef,
  ownership: TenantOwnershipSnapshot,
  source: Readonly<{ path: string }> | Readonly<{ url: string }>,
): BuiltInJob[] {
  if (!bucketResources([app]).length) return [];
  const owners = new Map(
    Object.entries(ownership.ownership).flatMap(([resource, rule]) => (rule.kind === 'tenant' ? [[resource, rule.column] as const] : [])),
  );
  return [
    {
      id: FILES_SWEEP_JOB,
      every: parseEvery(filesSweepEvery(app.id)),
      realm: 'tenant',
      run: async (tenantId) => {
        const { connect } = await import('@mistriwork/engine/adapters/connect.js');
        const adapter = connect('path' in source ? source.path : source.url);
        try {
          const lines: string[] = [];
          const code = await sweepTenantFiles(app, await adapter.introspect(), adapter, owners, tenantId!, (line) =>
            lines.push(line.trim()),
          );
          for (const line of lines) console.log(`mistri: files sweep of ${app.id} for tenant ${tenantId}: ${line}`);
          // A failed delete is retried with the job: an object no row names is still there tomorrow if not today.
          if (code !== 0) throw new Error(`the files sweep of ${app.id} for tenant ${tenantId} did not finish.`);
        } finally {
          await adapter.close().catch(() => {});
        }
      },
    },
  ];
}
