/**
 * Tenant command events at enrollment. The event store is attested, never
 * provisioned: a missing or foreign store refuses startup. Each batch is then
 * written by the tenant writer's journal inside its fenced transaction.
 */
import { assertSqliteCommandEventStore } from '../../adapters/events/commandEventSchema.js';
import { assertPostgresCommandEventStore } from '../../adapters/events/postgresCommandEventStore.js';
import { getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { TenantEnrollmentHook } from './tenantFeatureContract.js';

const events = (registry: BusinessCommandRegistry | undefined) =>
  !!registry && Object.values(registry).some((command) => getCommandEvents(command));

export const eventStoreHook = Object.freeze<TenantEnrollmentHook>({
  sqlite: (db, { app, policy, registry, binding }) => {
    if (events(registry)) assertSqliteCommandEventStore(db, { appId: app.id, storeId: policy.storeId, sourceId: binding.source.id });
  },
  postgres: async (client, { app, policy, registry, binding }) => {
    if (events(registry))
      await assertPostgresCommandEventStore(client, { appId: app.id, storeId: policy.storeId, sourceId: binding.source.id });
  },
});
