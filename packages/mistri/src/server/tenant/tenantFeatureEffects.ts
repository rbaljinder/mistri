/**
 * Effects on a tenant App: a command's `post(...)` and `send(...)`. Each is
 * recorded beside the receipt in the tenant event store enrollment attests,
 * and delivered after commit from one destination per webhook or channel,
 * whose routes take every tenant's facts (`scope: 'tenants'`) — so a
 * delivery carries the tenant it was written for, and a channel message is
 * judged against that tenant's consent and sent with its secrets.
 *
 * The destinations are derived here exactly as provisioning derives them
 * (provisionStores with the App's commands and its tenant
 * binding) and attested in the enrollment snapshot, never created: a
 * changed effect is a new destination, provisioned with the server stopped.
 */
import { assertSqliteEventDeliveryStore } from '../../adapters/events/eventDeliverySchema.js';
import { assertPostgresEventDeliveryStore } from '../../adapters/events/postgresEventDeliveryStore.js';
import { BusinessCommandDefinitionError, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { effectDeployment } from '../effects/effectHost.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

/** The tenant deployment's effect destinations, or undefined when no command has an effect. */
export function tenantEffectDeployment(appId: string, storeId: string, registry: BusinessCommandRegistry | undefined) {
  if (!registry) return undefined;
  return effectDeployment({ appId, commands: registry, tenants: (sourceId) => ({ appId, storeId, sourceId }) });
}

export const effectsCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  stage: 'command effects',
  run: ({ app, policy, registry, owned }) => {
    let deployment;
    try {
      deployment = tenantEffectDeployment(app.id, policy.storeId, registry);
    } catch (error) {
      throw new TenantCommandStartupError(
        error instanceof BusinessCommandDefinitionError ? error.message : 'The command effects could not be checked.',
      );
    }
    if (deployment && deployment.sourceId !== owned.source.id)
      throw new TenantCommandStartupError(
        `Commands with effects are on source "${deployment.sourceId}"; a tenant App's effects ride its tenant source "${owned.source.id}".`,
      );
  },
});

export const effectsHook = Object.freeze<TenantEnrollmentHook>({
  sqlite: (db, { app, binding, registry }) => {
    const deployment = tenantEffectDeployment(app.id, binding.storeId, registry);
    if (!deployment) return;
    if (deployment.sourceId !== binding.source.id) denyTenant();
    for (const { policy } of deployment.destinations) assertSqliteEventDeliveryStore(db, policy);
  },
  postgres: async (client, { app, binding, registry }) => {
    const deployment = tenantEffectDeployment(app.id, binding.storeId, registry);
    if (!deployment) return;
    if (deployment.sourceId !== binding.source.id) denyTenant();
    for (const { policy } of deployment.destinations) await assertPostgresEventDeliveryStore(client, policy);
  },
});
