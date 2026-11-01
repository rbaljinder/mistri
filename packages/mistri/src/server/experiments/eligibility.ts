/** Whether a verified context may enter an epoch: one reading for the request
 * runtime and the receipt owner, over the audiences frozen into the epoch. */
import type { FlagContext } from '../../shared/appFlags.js';
import { inAnyAudience } from '../flags/audience.js';
import type { ExperimentEpoch } from './contracts.js';

export function epochAdmits(epoch: ExperimentEpoch, context: FlagContext, tenantId: string | null): boolean {
  const e = epoch.eligibility,
    audiences = e.audiences ?? {},
    names = Object.keys(audiences);
  return (
    !names.length || inAnyAudience(names, audiences, { appId: epoch.scope.appId, environment: epoch.scope.environment, tenantId, context })
  );
}
