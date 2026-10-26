/** Explicit offline operator action; opening the suite never invokes this. */
import type { SuiteConfiguration } from '../cli/suiteConfig.js';
import { loadApp } from '../app/apps.js';
import { loadConfig } from '@mistriwork/engine/server/connections.js';
import { captureAppFlagCatalog } from '../flags/appCatalog.js';
import { loadExperimentConversions } from './loader.js';
import { openPostgresExperimentStore } from './storePostgres.js';
import { resolveExperimentSource } from './sourceConfiguration.js';
import { createExperimentRuntime } from './runtime.js';
import { provisionExperimentSource } from './producerHost.js';
import { ensure } from './contracts.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

export async function provisionConfiguredExperimentSources(config: SuiteConfiguration): Promise<void> {
  ensure(
    config.identity && config.flags && config.experiments && config.experiments.sources?.length,
    'Declare explicit experiments.sources before provisioning destinations.',
  );
  const store = await openPostgresExperimentStore({
    url: config.experiments.store,
    binding: { suiteId: config.identity.id, deploymentId: config.experiments.deploymentId },
  });
  try {
    for (const configured of config.experiments.sources) {
      const deployment = config.apps.find((app) => app.id === configured.appId);
      ensure(deployment);
      const app = await loadApp(deployment.directory, { lock: 'enforce' }),
        connections = await loadConfig(deployment.config, CONFIG_SECTIONS);
      ensure(app.app.id === configured.appId && app.commands && connections);
      const graph = captureAppFlagCatalog(app.app, app.commands.registry),
        conversions = await loadExperimentConversions(app.commands.file, app.commands.registry);
      const source = resolveExperimentSource(configured, {
        app: app.app,
        connections: connections.connections,
        environment: deployment.environment,
      });
      const runtime = createExperimentRuntime({ appId: app.app.id, environment: config.flags.environment, graph, conversions, store });
      const epoch = await store.registerEpoch(
        runtime.declaration(source.flagId, {
          controlTenantId: source.controlTenantId === undefined ? source.tenantId : source.controlTenantId,
          evaluationTenantId: source.tenantId,
        }),
        () => {},
      );
      await provisionExperimentSource(source, epoch, conversions);
    }
  } finally {
    await store.close();
  }
}
