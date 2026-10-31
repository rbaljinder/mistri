/**
 * What every start does before its mode, whichever binary runs it: the questions answered without starting
 * anything (`--help`, `--version`, a typo), and the process's settings the flags make (the proxies it believes,
 * its pools). Both mains call these (packages/tablewalk/src/server/cli/browserMain.ts,
 * packages/mistri/src/server/cli/mistriMain.ts), each with its own words (`Product`), and each binary runs its own
 * main (bin.ts).
 */
import { parseClientAddressPolicy, parseTrustedProxies } from '../http/trust.js';
import { configureServerSettings } from '../../adapters/serverSettings.js';
import { configurePostgresPools } from '../../adapters/postgresPool.js';
import { configureLockTimeout, configureWriterPool } from '../../adapters/writeLanes.js';
import { postgresPoolFlags, shutdownTimings, type Options } from './args.js';
import { didYouMean, packageVersion } from './usage.js';
import { envName } from '../product.js';

/** A main: what a binary runs (bin.ts). Each binary has one, and a start that is the other's is refused by name. */
export type Main = () => Promise<void>;

/**
 * The binary a start is answered by, in its own words: the name every line it says starts with, its usage (`--help
 * all`) and first screen (`--help`), and the command and flag words a near miss is matched against.
 */
export interface Product {
  readonly bin: 'tablewalk' | 'mistri';
  readonly usage: string;
  readonly shortUsage: string;
  readonly commandWords: readonly string[];
  readonly flagWords: readonly string[];
}

/**
 * `--help`, `--version`, a retired spelling, an unknown flag, a command one slip away: answered before anything
 * else, and before any of it can start a server. True when answered.
 *
 * None of the first two was handled once. `--help` and `--version` were ignored and then rescued by the "nothing
 * to open" gate, which printed the usage and exited 1 — the right text, the wrong exit code, and only ever by
 * accident. Once a server started with no connection, the accident became `tablewalk --help` sitting on port 4111
 * waiting for a browser.
 */
export async function answeredFirst(opts: Options, product: Product): Promise<boolean> {
  const { bin } = product;
  if (opts.help) {
    console.log(opts.target === 'all' ? product.usage : product.shortUsage);
    return true;
  }
  if (opts.version) {
    console.log(await packageVersion());
    return true;
  }
  if (opts.retired) {
    console.error(`${bin}: ${opts.retired}`);
    process.exit(1);
  }
  /* A typo is named with its near miss, and the help is one command away: the whole usage after it buried the one
     line that said what was wrong. */
  if (opts.unknown) {
    const flag = opts.unknown.split(/[ =]/)[0];
    console.error(
      `${bin}: unknown option "${opts.unknown}".${opts.unknown === flag ? await didYouMean(flag, product.flagWords) : ''} ${bin} --help lists the options.`,
    );
    process.exit(1);
  }
  /* A word that is no file and is one slip from a command (`tablewalk chek`) was opened as a SQLite file of that
     name: a database that does not exist, said as a connection that would not open. */
  if (opts.target && /^[a-z][a-z-]*$/.test(opts.target) && !product.commandWords.includes(opts.target)) {
    const { existsSync } = await import('node:fs');
    const near = existsSync(opts.target) ? '' : await didYouMean(opts.target, product.commandWords);
    if (near) {
      console.error(
        `${bin}: "${opts.target}" is not a command, and no file of that name is here.${near.replace('Did you mean ', `Did you mean ${bin} `)} ${bin} --help lists the commands.`,
      );
      process.exit(1);
    }
  }
  return false;
}

/** The process's settings the flags make: the proxies whose addresses it believes, and its pools. Exits on a bad one. */
export function configureProcess(opts: Options, bin: Product['bin']): void {
  const proxies = parseTrustedProxies(opts.trustProxy);
  if (proxies.invalid.length) {
    console.error(
      `${bin}: --trust-proxy takes an IPv4 or IPv6 address or CIDR range (172.17.0.1, 10.0.0.0/8, fd00::/8); ` +
        `${proxies.invalid.map((entry) => `"${entry}"`).join(', ')} is not one. It comes from the flag or ${envName('TRUST_PROXY')}.`,
    );
    process.exit(1);
  }
  opts.trustedProxies = proxies.ranges;
  const identity = parseTrustedProxies(opts.authProxyFrom);
  if (identity.invalid.length) {
    console.error(
      `${bin}: --auth-proxy-from takes an IPv4 or IPv6 address or CIDR range (10.0.0.7, fd00::7); ` +
        `${identity.invalid.map((entry) => `"${entry}"`).join(', ')} is not one. It comes from the flag or ${envName('AUTH_PROXY_FROM')}.`,
    );
    process.exit(1);
  }
  opts.authProxies = identity.ranges;
  const client = parseClientAddressPolicy({ hops: opts.trustProxyHops, cloudflare: opts.trustProxyCloudflare });
  if ('error' in client) {
    console.error(`${bin}: ${client.error}`);
    process.exit(1);
  }
  // One server per process: its settings are the process's (adapters/serverSettings.ts).
  configureServerSettings({ clientAddress: client.policy });
  const timings = shutdownTimings(opts);
  if (typeof timings === 'string') {
    console.error(`${bin}: ${timings}`);
    process.exit(1);
  }
  const pools = postgresPoolFlags(opts);
  if (typeof pools === 'string') {
    console.error(`${bin}: ${pools}`);
    process.exit(1);
  }
  // Before anything opens a pool: the registry's, a tenant source's, the job host's.
  configurePostgresPools(pools);
  configureWriterPool(pools.writers);
  configureLockTimeout(pools.lockTimeoutMs);
}

/** The formats of `--export` the database browser prints (databaseOneShot.ts); the rest are an App's. */
export const SCHEMA_EXPORTS: ReadonlySet<string> = new Set(['md', 'markdown', 'mermaid', 'json']);

/**
 * Which product a start is the business of, on its flags alone: the App framework's when any flag names an App,
 * serves or checks its API, scaffolds one or watches it; else the database browser's modes (`--mcp`, `--lint`,
 * `--diff`, the schema in words); else neither yet — a server, which is the App framework's when the config file
 * names Apps (configNamesApps). Both mains ask, and each refuses the other's start by the other's name: there is no
 * handing over between the two binaries.
 */
export function startFor(opts: Options): 'browser' | 'mistri' | undefined {
  if (
    opts.appMcp ||
    opts.checkApp ||
    opts.apiReads ||
    opts.apiIntegers !== undefined ||
    opts.apiRequestsPerMinute !== undefined ||
    opts.apps?.length ||
    opts.appEntry !== undefined ||
    opts.commands !== undefined ||
    opts.jobs !== undefined ||
    opts.policy !== undefined ||
    opts.writeAuthority ||
    opts.bump ||
    opts.reindex !== undefined ||
    opts.scaffoldApp !== undefined ||
    opts.dev ||
    opts.fromOpenapi !== undefined ||
    (opts.export !== undefined && !SCHEMA_EXPORTS.has(opts.export.toLowerCase())) ||
    opts.mounts !== undefined ||
    opts.embedded
  )
    return 'mistri';
  if (opts.mcp || opts.lint || opts.diff || opts.export !== undefined) return 'browser';
  return undefined;
}
