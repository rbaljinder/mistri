/**
 * Public intake at startup: a public form or a public command page places its
 * submissions only through the policy's intake, and intake serves only those.
 */
import { homeSourceOf } from '../../shared/appModel.js';
import type { TenantStartupCheck } from './tenantFeatureContract.js';
import { tenantPageProblems, tenantPublicPages } from './tenantIntakePages.js';
import { tenantPublicForms } from './tenantIntakeModel.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

export const intakeCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  run: ({ app, policy, registry }) => {
    const doors = tenantPublicForms(app).size + tenantPublicPages(app).size;
    if (doors && policy.intake === undefined) {
      throw new TenantCommandStartupError(
        "A tenant App's public form or public page needs the tenant policy's intake: { address }, naming the platform profile " +
          "column that holds each tenant's intake address, and the platform realm for submissions no address places.",
      );
    }
    if (!doors && policy.intake !== undefined)
      throw new TenantCommandStartupError(
        'The tenant policy declares intake, but the App has no public form or public page that runs a command.',
      );
    if (doors && !app.auth?.tenancy?.platform) {
      throw new TenantCommandStartupError(
        "A tenant App's public form or public page needs the platform realm (auth.tenancy.platform): a submission no address places goes to the platform.",
      );
    }
    /* A public page that intake could not run would be served and then refuse every visitor; say why before it is. */
    const problems = tenantPageProblems(app, registry, homeSourceOf(app) ?? '', (table) => policy.ownership[table]?.kind);
    if (problems.length) throw new TenantCommandStartupError(problems.join('\n'));
  },
});
