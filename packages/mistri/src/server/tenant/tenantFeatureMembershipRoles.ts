/**
 * The role ceiling administration and invitations share. Both place roles in
 * a tenant membership, whose admission admits tenant-realm roles only: a
 * platform role there would be an accepted membership nobody can ever use.
 * A service role (`service: true`) is never a membership's in either realm:
 * only a jobs module's principal holds it, so nobody signs in as it.
 */
import type { AppDef } from '../../shared/app.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantStartupError } from './tenantStartupError.js';

/** Whether a membership of `realm` may hold `role`: one of the App's roles, of that realm, and no service role. */
export function membershipRole(app: AppDef, role: string, realm: 'tenant' | 'platform'): boolean {
  const roles = app.auth?.roles ?? {};
  if (!Object.hasOwn(roles, role) || roles[role].service === true) return false;
  return (roles[role].realm === 'platform') === (realm === 'platform');
}

const outsideCeiling = (app: AppDef, policy: AppTenantPolicy) =>
  [...(policy.administration?.operators ?? []), ...(policy.invitations?.operators ?? [])].some((operator) =>
    operator.roles.some((role) => !membershipRole(app, role, 'tenant')),
  );

export const roleCeilingCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  stage: "administration and invitation role ceilings (this App's tenant-realm roles only, and no service role)",
  run: ({ app, policy }) => {
    if (outsideCeiling(app, policy)) throw new TenantStartupError();
  },
});

export const roleCeilingHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ app, policy }) => {
    if (outsideCeiling(app, policy)) denyTenant();
  },
});
