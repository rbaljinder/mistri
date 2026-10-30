/**
 * `mistri deploy`: the word dispatch. The real runner is built only for a word that needs it (effects.ts), so
 * `init` and the usage never load wrangler, the database or the build.
 */
import { DEFAULT_DIR, DEPLOY_USAGE, parseDeployArgs } from './args.js';
import { readConfig } from './config.js';
import { appNameOf, readConfigText, writeInit } from './init.js';
import { logs, rollback, status, verify } from './manage.js';
import { makePlan } from './plan.js';
import { deploy } from './run.js';
import type { DeployConfig, DeployFlags, DeployRunner } from './types.js';

/** The exit codes: 0 done, 1 could not (or declined, or failed on the way), 7 refused by the plan. */
export async function runDeployCommand(
  argv: string[],
  seams: {
    runner?: (flags: DeployFlags, config: DeployConfig) => Promise<DeployRunner>;
    env?: (name: string) => string | undefined;
    /** The App's name, for the Worker's; absent, the App is loaded (init.ts appNameOf). */
    appName?: (request: { app: string; appEntry?: string }) => Promise<string | undefined>;
  } = {},
): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(
      `mistri deploy: check, migrate, deploy and verify an App on Cloudflare Containers.\n  ${DEPLOY_USAGE}\n\n  --migrate-url (or MISTRI_MIGRATE_URL) is the database the versioned migrations run over. The App's own stores\n  (migrate stores up) use the store URLs its config names, read from this machine's environment, not --migrate-url.\n  wrangler reads its login from $XDG_CONFIG_HOME/.wrangler when that is set: a shell whose XDG_CONFIG_HOME differs from the one used at \`wrangler login\` reports "not logged in".`,
    );
    return 0;
  }
  let parsed;
  try {
    parsed = parseDeployArgs(argv, seams.env ?? ((name) => process.env[name]));
  } catch (error) {
    console.error(`mistri deploy: ${(error as Error).message}`);
    return 1;
  }
  const { words, flags, request, force } = parsed;
  const [word, target] = words;
  try {
    if (word === 'init') {
      if (target !== 'cloudflare' || words.length !== 2) {
        console.error(`mistri deploy: init takes the target: cloudflare. ${DEPLOY_USAGE}`);
        return 1;
      }
      if (!request.app) {
        console.error('mistri deploy: init needs --app <dir>, the App the Worker is for.');
        return 1;
      }
      const written = writeInit({
        ...request,
        app: request.app,
        dir: flags.dir,
        configText: readConfigText(request.config ?? 'mistri.json'),
        sourceTexts: [request.appEntry, request.policy].map(readConfigText).filter((text): text is string => text !== undefined),
        appName: await (seams.appName ?? appNameOf)({ app: request.app, appEntry: request.appEntry }),
        force,
      });
      for (const file of written) console.log(`wrote ${file}`);
      console.log(
        `\nNext: set the Worker's secrets (npx wrangler secret put <NAME>, in ${DEFAULT_DIR}), then mistri deploy --dry-run.\nNothing was created on Cloudflare.`,
      );
      return 0;
    }
    if (word !== undefined && !['status', 'verify', 'rollback', 'logs'].includes(word)) {
      console.error(`mistri deploy: "${word}" is not a deploy command. ${DEPLOY_USAGE}`);
      return 1;
    }
    if (word !== 'rollback' && words.length > 1) {
      console.error(`mistri deploy: ${word ?? 'deploy'} takes no argument. ${DEPLOY_USAGE}`);
      return 1;
    }
    const config: DeployConfig = { ...readConfig(flags.dir), ...request };
    const makeRunner = seams.runner ?? (async (f, c) => (await import('./effects.js')).realRunner(f, c));
    const runner = await makeRunner(flags, config);
    if (word === 'status') return await status(runner, flags);
    if (word === 'logs') return await logs(runner, flags);
    if (word === 'verify') return await verify(runner, flags);
    if (word === 'rollback') return await rollback(runner, flags, target);
    return await deploy(runner, await makePlan(runner, flags, request), flags);
  } catch (error) {
    console.error(`mistri deploy: ${(error as Error).message}`);
    return 1;
  }
}
