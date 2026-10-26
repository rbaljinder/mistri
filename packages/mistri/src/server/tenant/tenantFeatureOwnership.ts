/**
 * Ownership agreement at enrollment. The DSL says whose rows each resource
 * holds; the trusted policy supplies the columns. The two agree exactly, and
 * the platform realm exists in both or in neither: a mismatch denies startup
 * rather than trusting either side.
 */
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantEnrollmentHook } from './tenantFeatureContract.js';

export const ownershipHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ app, policy }) => {
    const resources = app.resources ?? {};
    for (const [name, resource] of Object.entries(resources)) {
      if (resource.owner === undefined) continue;
      if (!Object.hasOwn(policy.ownership, name) || policy.ownership[name].kind !== resource.owner) denyTenant();
    }
    for (const [name, rule] of Object.entries(policy.ownership)) {
      if (rule.kind === 'platform' && resources[name]?.owner !== 'platform') denyTenant();
    }
    if ((app.auth?.tenancy?.platform !== undefined) !== (policy.resolvePlatformRows !== undefined)) denyTenant();
    // A visitor's tenant is found by the policy's public address, and its rows by its callback: with auth.public, and only then.
    if ((app.auth?.public !== undefined) !== (policy.public !== undefined)) denyTenant();
  },
});
