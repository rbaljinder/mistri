/** Explicit maintenance-owned accounts for disposable shared-identity suites. */
import { readSuiteConfiguration } from '../cli/suiteConfig.js';
import { loadApp } from '../app/apps.js';
import { loadConfig } from '@mistriwork/engine/server/connections.js';
import { openSuiteIdentity } from '../auth/suiteIdentity.js';
import { createNativeAccount } from '../auth/authAccounts.js';
import { appMounts, appHome } from '@mistriwork/engine/shared/mount.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

export async function createTestSuiteAccount(
  file: string,
  environment: Record<string, string>,
  input: { name: string; email: string; password: string },
) {
  const config = await readSuiteConfiguration(file, environment);
  if (!config.identity) throw new Error('Test suite accounts require shared identity.');
  const mount = appMounts(
    config.apps.map((app) => app.id),
    { base: config.basePath, mounts: Object.fromEntries(config.apps.map((app) => [app.id, app.mount])) },
  );
  const deployments = await Promise.all(
    config.apps.map(async (deployment) => ({
      app: await loadApp(deployment.directory, { lock: 'enforce' }),
      environment: deployment.environment,
      basePath: appHome(mount, deployment.id).replace(/\/$/, ''),
      connections: (await loadConfig(deployment.config, CONFIG_SECTIONS))!.connections,
    })),
  );
  const identity = await openSuiteIdentity(config, deployments);
  try {
    return await createNativeAccount(identity.native, input, { by: 'maintenance' });
  } finally {
    identity.close();
  }
}
