/**
 * `--reindex`: fill each searched resource's index from the database, then
 * exit. The index is a copy; this is how it catches up with writes made
 * outside the App, or starts after search is first declared.
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { LoadedApp } from '../app/apps.js';
import { isTenantApp } from '../../shared/appModel.js';

/** Index every searched resource of each app, or only the one named (`only`, '' for all).
 * A tenant App names its policy (`--policy`): each document keeps its row's
 * tenant, and the policy is what says which column that is. */
export async function reindexApps(registry: Registry, loadedApps: LoadedApp[], only: string, policyFile?: string): Promise<void> {
  try {
    if (!loadedApps.length) throw new Error('--reindex needs --app, and a search provider plugged in.');
    const { NO_SEARCH_PROVIDER, searchProviderOf } = await import('../app/searchProvider.js');
    if (!searchProviderOf(registry)) throw new Error(`--reindex: ${NO_SEARCH_PROVIDER}`);
    const { indexerFor } = await import('../app/appSearchRuntime.js');
    for (const loaded of loadedApps) {
      const scope = loaded.app.connection;
      const owner = (scope ? registry.list().find((c) => c.id === scope || c.name === scope)?.id : undefined) ?? registry.active;
      if (!owner) throw new Error(`App "${loaded.app.name}" has no connection to read from.`);
      let tenantColumns: Record<string, string> = {};
      if (isTenantApp(loaded.app)) {
        if (!policyFile)
          throw new Error(`App "${loaded.app.name}" is a tenant App: --reindex needs its --policy, which names each tenant column.`);
        const { loadAppTenantPolicy } = await import('../policy/appTenantPolicy.js');
        const { tenantSearchColumns } = await import('../tenant/tenantSearch.js');
        tenantColumns = tenantSearchColumns((await loadAppTenantPolicy(policyFile)).ownership);
      }
      for (const { resource, indexed } of await indexerFor(registry).reindex(
        loaded.app,
        owner,
        only || undefined,
        undefined,
        tenantColumns,
      )) {
        console.error(`mistri: indexed ${indexed} record(s) of "${resource}" for app "${loaded.app.name}"`);
      }
    }
  } catch (err) {
    console.error(`mistri: ${startupReport(err)}`);
    process.exitCode = 1;
  }
  await registry.closeAll();
  await registry.closeServices();
}
