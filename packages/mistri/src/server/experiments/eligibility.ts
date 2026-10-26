/** Whether a verified context may enter an epoch: one reading for the request
 * runtime and the receipt owner, over the audiences frozen into the epoch. */
import type { FlagContext } from '../../shared/appFlags.js';
import { inAnyAudience } from '../flags/audience.js';
import type { ExperimentEpoch } from './contracts.js';

export function epochAdmits(epoch: ExperimentEpoch, context: FlagContext, tenantId: string | null): boolean {
  const e = epoch.eligibility,
    audiences = e.audiences ?? {},
    names = Object.keys(audiences);
  // A 0.8 epoch said who directly; a 1.0 one carries neither list.
  const roles = e.roles ?? [],
    tenants = e.tenants ?? [];
  return (
    (!roles.length || roles.some((role) => context.roles?.includes(role))) &&
    (!tenants.length || (tenantId !== null && tenants.includes(tenantId))) &&
    (!names.length ||
      inAnyAudience(names, audiences, { appId: epoch.scope.appId, environment: epoch.scope.environment, tenantId, context }))
  );
}
