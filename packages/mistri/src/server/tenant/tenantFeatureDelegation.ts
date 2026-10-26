/**
 * Delegated administration and invitations at startup and enrollment. A
 * delegate rule names the role that earns it and a role ceiling; both are
 * tenant memberships' roles, so both must be this App's tenant-realm roles —
 * a platform role could never be held in a tenant membership, and granting
 * one there would be a membership nobody can use. Nor is a service role:
 * nobody signs in as one.
 */
import type { AppDef } from '../../shared/app.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { delegateRoles } from './tenantDelegation.js';
import { membershipRole } from './tenantFeatureMembershipRoles.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantStartupError } from './tenantStartupError.js';

function outsideTenantRealm(app: AppDef, policy: AppTenantPolicy): boolean {
  return [...delegateRoles(policy.administration?.delegates), ...delegateRoles(policy.invitations?.delegates)].some(
    (role) => !membershipRole(app, role, 'tenant'),
  );
}

export const delegationRoleCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  stage: "delegated administration and invitation roles (this App's tenant-realm roles only, and no service role)",
  run: ({ app, policy }) => {
    if (outsideTenantRealm(app, policy)) throw new TenantStartupError();
  },
});

export const delegationHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ app, policy }) => {
    if (outsideTenantRealm(app, policy)) denyTenant();
  },
});
