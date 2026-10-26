/**
 * Public intake at startup: a public form places its submissions only through
 * the policy's intake, and intake serves only public forms.
 */
import type { TenantStartupCheck } from './tenantFeatureContract.js';
import { tenantPublicForms } from './tenantIntakeModel.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

export const intakeCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  run: ({ app, policy }) => {
    const forms = tenantPublicForms(app);
    if (forms.size && policy.intake === undefined) {
      throw new TenantCommandStartupError(
        "A tenant App's public form needs the tenant policy's intake: { address }, naming the platform profile " +
          "column that holds each tenant's intake address, and the platform realm for submissions no address places.",
      );
    }
    if (!forms.size && policy.intake !== undefined)
      throw new TenantCommandStartupError('The tenant policy declares intake, but the App has no public form.');
    if (forms.size && !app.auth?.tenancy?.platform) {
      throw new TenantCommandStartupError(
        "A tenant App's public form needs the platform realm (auth.tenancy.platform): a submission no address places goes to the platform.",
      );
    }
  },
});
