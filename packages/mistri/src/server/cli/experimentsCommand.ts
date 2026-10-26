/** Explicit operator provisioning; serving never changes the owned layout. */

const usage = 'mistri experiments <provision|provision-sources> --suite <suite.json>';
export async function runExperimentsCommand(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      `${usage}\nProvision a dedicated experiment database, or register declared epochs and their destinations. An older store is brought forward by mistri migrate stores up.`,
    );
    return;
  }
  if (
    args.length !== 3 ||
    !['provision', 'provision-sources'].includes(args[0]) ||
    args[1] !== '--suite' ||
    !args[2] ||
    args[2].startsWith('-')
  ) {
    throw new Error(`Expected ${usage}`);
  }
  const { readSuiteConfiguration } = await import('./suiteConfig.js');
  const config = await readSuiteConfiguration(args[2], environment);
  if (!config.identity || !config.experiments)
    throw new Error('Experiment provisioning requires explicit suite identity and a dedicated experiment store.');
  if (args[0] === 'provision-sources') {
    const { provisionConfiguredExperimentSources } = await import('../experiments/provisionSources.js');
    await provisionConfiguredExperimentSources(config);
    console.log('Experiment source destinations provisioned.');
    return;
  }
  const { provisionPostgresExperimentStore } = await import('../experiments/storePostgres.js');
  await provisionPostgresExperimentStore({
    url: config.experiments.store,
    binding: { suiteId: config.identity.id, deploymentId: config.experiments.deploymentId },
  });
  console.log('Experiment store provisioned.');
}
