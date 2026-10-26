/**
 * Public reads at startup: a tenant App that opens resources to visitors
 * (`auth.public`) says where a visitor's tenant is found and which of its
 * rows are public — the policy's `public: { address }` and
 * `resolvePublicRows` — and a policy that says so opens resources it names.
 */
import type { TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

export const publicReadsCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  run: ({ app, policy }) => {
    if (app.auth?.public && policy.public === undefined) {
      throw new TenantCommandStartupError(
        'A tenant App\'s "auth.public" needs the tenant policy\'s public: { address }, naming the profile column that ' +
          "holds each tenant's public address, and resolvePublicRows, which picks each tenant's public rows.",
      );
    }
    if (!app.auth?.public && policy.public !== undefined)
      throw new TenantCommandStartupError(
        'The tenant policy declares public reads, but the App opens no resource to visitors ("auth.public").',
      );
  },
});
