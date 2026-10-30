/**
 * `mistri deploy`'s words and flags. The App's own flags (the build request) override what `init` wrote.
 */
import { resolve } from 'node:path';
import { DEFAULT_RESTART_TOKEN_ENV, DEFAULT_ROLL_TIMEOUT_MS, type DeployConfig, type DeployFlags } from './types.js';

export const DEPLOY_USAGE =
  'mistri deploy init cloudflare --app <dir> [--config <path>] [--commands <file>] [--jobs <file>] [--policy <file>] [--app-entry <file>] [--out <dir>] [--dir <dir>] [--force]\n' +
  '  mistri deploy [--dry-run] [--yes] [--allow-contract] [--allow-dirty] [--migrate-url <url>] [--migrations <dir>] [--connection-limit <n>] [--verbose] [--backup-check <cmd>] [--smoke <cmd>] [--roll-timeout <minutes>] [--dir <dir>]\n' +
  '  mistri deploy verify [--roll] [--roll-timeout <minutes>] [--smoke <cmd>] [--dir <dir>]\n' +
  '  mistri deploy status | rollback [<deploy-id>] [--dry-run] | logs [--dir <dir>]';

/** The build request flags a deploy takes beside the command's own, by flag. */
const REQUEST: Record<string, keyof DeployConfig> = {
  '--app': 'app',
  '--app-entry': 'appEntry',
  '--out': 'out',
  '--config': 'config',
  '--commands': 'commands',
  '--jobs': 'jobs',
  '--policy': 'policy',
};

export const DEFAULT_DIR = 'deploy/cloudflare';

interface ParsedDeploy {
  words: string[];
  flags: DeployFlags;
  request: Partial<DeployConfig>;
  force: boolean;
}

/** Throws a sentence for the person; the caller prefixes `mistri deploy:`. */
export function parseDeployArgs(argv: string[], env: (name: string) => string | undefined): ParsedDeploy {
  const words: string[] = [];
  const request: Record<string, string> = {};
  const flags: DeployFlags = {
    dir: resolve(DEFAULT_DIR),
    dryRun: false,
    yes: false,
    allowContract: false,
    allowDirty: false,
    verbose: false,
    roll: false,
    rollTimeoutMs: DEFAULT_ROLL_TIMEOUT_MS,
    restartTokenEnv: DEFAULT_RESTART_TOKEN_ENV,
  };
  let force = false;
  const value = (i: number, flag: string): string => {
    const given = argv[i + 1];
    if (given === undefined || given.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return given;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--allow-contract') flags.allowContract = true;
    else if (arg === '--allow-dirty') flags.allowDirty = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--roll') flags.roll = true;
    else if (arg === '--force') force = true;
    else if (arg === '--dir') flags.dir = resolve(value(i++, arg));
    else if (arg === '--migrate-url') flags.migrateUrl = value(i++, arg);
    else if (arg === '--migrations') flags.migrationsDir = value(i++, arg);
    else if (arg === '--connection-limit') {
      const limit = Number(value(i++, arg));
      if (!Number.isInteger(limit) || limit <= 0)
        throw new Error('--connection-limit takes the number of connections the database allows, like 22.');
      flags.connectionLimit = limit;
    } else if (arg === '--backup-check') flags.backupCheck = value(i++, arg);
    else if (arg === '--smoke') flags.smoke = value(i++, arg);
    else if (arg === '--roll-timeout') {
      const minutes = Number(value(i++, arg));
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--roll-timeout takes a number of minutes, like 20.');
      flags.rollTimeoutMs = Math.round(minutes * 60_000);
    } else if (arg in REQUEST) request[REQUEST[arg]] = value(i++, arg);
    else if (arg.startsWith('-')) throw new Error(`unknown option "${arg}". ${DEPLOY_USAGE}`);
    else words.push(arg);
  }
  flags.migrateUrl ??= env('MISTRI_MIGRATE_URL') || undefined;
  return { words, flags, request: request as Partial<DeployConfig>, force };
}
