/** Explicit local operator provisioning. Serving only opens an existing store. */
import { provisionPostgresFlagStore } from '../flags/storePostgres.js';
import { readSuiteConfiguration } from './suiteConfig.js';

const usage = 'mistri flags provision --suite <suite.json>';
export async function runFlagsCommand(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      `${usage}\nExplicitly provision an empty PostgreSQL flag control store. An older one is brought forward by mistri migrate stores up. Does not start a server.`,
    );
    return;
  }
  if (args.length !== 3 || args[0] !== 'provision' || args[1] !== '--suite' || !args[2] || args[2].startsWith('-')) {
    throw new Error(`Expected ${usage}`);
  }
  const config = await readSuiteConfiguration(args[2], environment);
  if (!config.identity || !config.flags)
    throw new Error('Flag provisioning requires explicit suite identity and flag control configuration.');
  await provisionPostgresFlagStore({
    url: config.flags.store,
    binding: { suiteId: config.identity.id, deploymentId: config.flags.deploymentId },
  });
  console.log('Flag control store provisioned.');
}
