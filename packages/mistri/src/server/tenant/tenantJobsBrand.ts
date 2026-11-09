/* The jobs runtimes bindTenantJobs built, and no other: a structural lookalike is not one. A module of its own so
   the command access module can ask without importing the runtime it vouches for. */
import { denyTenant } from '@mistriwork/engine/server/evidence.js';

const runtimes = new WeakSet<object>();
export function brandTenantJobs(jobs: object): void {
  runtimes.add(jobs);
}
/** The runtime itself when bindTenantJobs built it; anything else is refused. */
export function captureTenantJobs<T extends object>(jobs: T): T {
  if (!runtimes.has(jobs)) return denyTenant();
  return jobs;
}
