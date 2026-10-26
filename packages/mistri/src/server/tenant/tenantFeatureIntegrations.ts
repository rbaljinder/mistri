/**
 * A tenant App's integrations at startup and enrollment (integrations/*). A
 * command that calls an integration or sends on a channel needs the jobs
 * module to list it, and the deployment a sealing key for its secrets; the
 * integrations store — secrets, the call journal, seen deliveries, consent
 * and the message log, every tenant's in rows of its own — sits beside the
 * tenant event store, attested in the enrollment snapshot and created only
 * by provisionStores (`only: ['integrations']`, or with the jobs module).
 */
import { assertPostgresIntegrations, assertSqliteIntegrations } from '../../adapters/integrations/integrationStore.js';
import { integrationCommandProblems, integrationNotifyProblems } from '../integrations/integrationChecks.js';
import { assertSecretsKey, configureSecretsKey, SecretsKeyMissing } from '../integrations/integrationSecrets.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

export const integrationsCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  stage: 'integrations',
  run: ({ app, registry, jobs, environment }) => {
    // With a jobs module its own check names these; without one, a call or a send has nothing to go through.
    if (!jobs && registry) {
      const [problem] = [...integrationCommandProblems(undefined, registry), ...integrationNotifyProblems(undefined, app)];
      if (problem) throw new TenantCommandStartupError(problem.replace(/^\[[a-z-]+\] /, ''));
    }
    if (!jobs?.integrations) return;
    configureSecretsKey(app.id, environment ?? process.env);
    try {
      assertSecretsKey(app.id);
    } catch (error) {
      throw new TenantCommandStartupError(error instanceof SecretsKeyMissing ? error.message : 'The integrations could not be checked.');
    }
  },
});

export const integrationsHook = Object.freeze<TenantEnrollmentHook>({
  sqlite: (db, { jobs }) => {
    if (jobs?.module.integrations) assertSqliteIntegrations(db);
  },
  postgres: async (client, { jobs }) => {
    if (jobs?.module.integrations) await assertPostgresIntegrations(client);
  },
});
