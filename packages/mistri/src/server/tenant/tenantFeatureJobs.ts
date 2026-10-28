/**
 * A tenant App's `--jobs` at startup and enrollment. A job starts on a tenant
 * command's event and runs one tenant or platform command as a service
 * principal (tenantJobs.ts). Its stores — one delivery destination per job and
 * the job store, beside the tenant event store — are attested in the
 * enrollment snapshot — with the mail store when it declares mail — never created: provisionStores, with the tenant binding
 * and the jobs module, from @mistriwork/mistri/maintenance creates them.
 */
import { assertSqliteEventDeliveryStore } from '../../adapters/events/eventDeliverySchema.js';
import { assertPostgresEventDeliveryStore } from '../../adapters/events/postgresEventDeliveryStore.js';
import { assertSqliteJobStore } from '../../adapters/jobs/jobStoreSchema.js';
import { assertPostgresMailStore, assertSqliteMailStore } from '../../adapters/mail/mailStore.js';
import { assertPostgresJobStore } from '../../adapters/jobs/postgresJobStore.js';
import { JobDeclarationError, runsJobs } from '../jobs/jobModule.js';
import { assertSqliteWorkflowStore, assertPostgresWorkflowStore } from '../../adapters/workflows/workflowStoreSchema.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { assertTenantJobs, tenantJobDeployment } from './tenantJobs.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

// A jobs module names only ids in its refusals: they reach the operator in their own words.
export const jobsCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  catalog: true,
  run: ({ app, policy, registry, owned, configured, jobs }) => {
    if (!jobs) return;
    if (!registry) throw new TenantCommandStartupError("--jobs requires a --commands registry: a job runs one of the App's commands.");
    try {
      tenantJobDeployment(jobs, { binding: { appId: app.id, storeId: policy.storeId, source: owned.source }, commands: registry });
      assertTenantJobs(jobs, app, registry, owned, configured);
    } catch (error) {
      throw new TenantCommandStartupError(error instanceof JobDeclarationError ? error.message : 'The jobs module could not be checked.');
    }
  },
});

export const jobsHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ registry, jobs }) => {
    if (jobs && !registry) denyTenant();
  },
  sqlite: (db, { jobs }) => {
    if (!jobs) return;
    if (runsJobs(jobs.module)) assertSqliteJobStore(db, jobs.deployment.store);
    for (const { policy } of [...jobs.deployment.destinations, ...jobs.deployment.workflowDestinations])
      assertSqliteEventDeliveryStore(db, policy);
    if (jobs.deployment.workflowDestinations.length) assertSqliteWorkflowStore(db);
    if (jobs.module.mail) assertSqliteMailStore(db);
  },
  postgres: async (client, { jobs }) => {
    if (!jobs) return;
    if (runsJobs(jobs.module)) await assertPostgresJobStore(client, jobs.deployment.store);
    for (const { policy } of [...jobs.deployment.destinations, ...jobs.deployment.workflowDestinations])
      await assertPostgresEventDeliveryStore(client, policy);
    if (jobs.deployment.workflowDestinations.length) await assertPostgresWorkflowStore(client, jobs.deployment.store.namespace);
    if (jobs.module.mail) await assertPostgresMailStore(client);
  },
});
