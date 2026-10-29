/**
 * The command line, read: every flag `tablewalk` takes, into one Options
 * value, with the environment variables that stand in for flags in a
 * container. `USAGE` in cli/usage.ts says the same list in words, and
 * test/prose.test.ts holds the two and the README to each other.
 */
import { parseHostList, type ProxyRange } from '../http/trust.js';
import { isReaderCount, MAX_READERS } from '../../adapters/postgresPool.js';
import { isLockTimeout, isWriterCount, MAX_LOCK_TIMEOUT_MS, MAX_WRITERS, MIN_LOCK_TIMEOUT_MS } from '../../adapters/writeLanes.js';
import type { PoolerMode } from '../../adapters/poolMetrics.js';
import { envName, productEnv } from '../product.js';

/**
 * The variable `mistri check` and a build set on the child that validates (build.ts `checkApp`): the real
 * validation, run as CI runs it, and not a spelling of the command line.
 */
export const CHECK_VALIDATION = 'MISTRI_CHECK_VALIDATION';

export interface Options {
  target: string;
  /** The target is DATABASE_URL's, not a flag's: a config's connections win over it (readStartupConfig). */
  targetFromEnvironment?: boolean;
  port: number;
  host: string;
  schemas: string[];
  open: boolean;
  config?: string;
  noConfig: boolean;
  /** `--no-live`: no change rows written, no `/api/live` (live/liveBinding.ts). */
  noLive?: boolean;
  /** Extra names the `Host` header may carry. See `doorRefusal`. */
  allowedHosts: string[];
  /** Speak MCP over stdio instead of serving HTTP. For coding agents. */
  mcp: boolean;
  /** Serve the dev observer at /_mistri/observe: loopback only, memory only (observe/observer.ts). */
  dev?: boolean;
  outputSchema: boolean;
  tools: string;
  /** Print the schema in this format and exit: md, mermaid, or json. */
  export?: string;
  /** Required for local OpenAPI export; no implicit integer wire policy. */
  apiIntegers?: string;
  apiReads?: boolean;
  apiRequestsPerMinute?: string;
  /** Speak one App's API as MCP tools on stdio; the token comes from the environment. */
  appMcp?: boolean;
  /** Report on the shape and exit: text or json. */
  lint?: string;
  /** Write a drafted TypeScript App project for the active connection into this directory, then exit. */
  scaffoldApp?: string;
  /** With --scaffold-app: the App's name, instead of one read off the database file's. */
  name?: string;
  /** Draft an HTTP connection's description from this OpenAPI JSON spec, print it, and exit. */
  fromOpenapi?: string;
  /** Serve the API this OpenAPI spec (a file or URL) describes, as a connection. */
  openapi?: string;
  /** With --openapi: the API's base URL, over the spec's servers. */
  apiUrl?: string;
  /** With --openapi: the variable holding a bearer token. */
  apiTokenEnv?: string;
  /** Validate the loaded app(s) against their connections, report, and exit: the validation step of `mistri check`,
      run as its child (CHECK_VALIDATION), never a flag of a person's. */
  checkApp?: boolean;
  /** With `mistri check`: write each App's authority.lock from what it grants now. */
  writeAuthority?: boolean;
  /** With `mistri check`: move these commands' contracts to their next version in authority.lock (commandContracts.ts). */
  bump?: string[];
  /** With --app: index the searched resources (all, or the one named), then exit. '' means all. */
  reindex?: string;
  /** With `lint`, the severity at which the exit code turns non-zero. */
  failOn?: string;
  /** Build a throwaway demo database and open it — an instant try with no
      database of your own. */
  demo: boolean;
  /** Whether a port was named explicitly; if not, a busy default rolls on. */
  portGiven: boolean;
  /** Print the usage and stop. */
  help: boolean;
  /** Print the version and stop. */
  version: boolean;
  /** A flag we do not know, kept so the error can name it. */
  unknown?: string;
  /** Compare the active connection with this one and exit. */
  diff?: string;
  /**
   * The header a reverse proxy sets with the signed-in user's identity
   * (`X-Forwarded-User`, `Cf-Access-Authenticated-User-Email`). Set, every
   * request from beyond loopback must carry it and come from a
   * `--trust-proxy` address, and every write is journaled with it. Not authentication — the proxy did that — but the
   * line that lets the proxy's decision reach this process.
   */
  authProxyHeader?: string;
  /** A retired spelling was given (a flag or variable renamed before 1.0): startup refuses it with this sentence. */
  retired?: string;
  /**
   * `--trust-proxy` values as given, then (after startup validates them) the
   * ranges: proxies whose X-Forwarded-For the public form rate limit may believe.
   * Loopback is trusted without them. Nothing to do with sign-in.
   */
  trustProxy: string[];
  /** `--trust-proxy-hops` as given; startup validates it (parseClientAddressPolicy). */
  trustProxyHops?: string;
  /** `--trust-proxy-cloudflare`: read CF-Connecting-IP. */
  trustProxyCloudflare: boolean;
  /** `--insecure-http-sign-in`: serve sign-in at an http address beyond this machine, which is otherwise refused. */
  insecureHttpSignIn?: boolean;
  trustedProxies?: ProxyRange[];
  /** Serve an app: a directory whose app.ts (or app.mjs / app.json) curates the UI. */
  apps?: string[];
  /** With one --app: its manifest file, when it is not the directory's own app.ts; the directory stays the App's root. */
  appEntry?: string;
  /** `--mount <app>=<path>` as written, by App id: `/` is the main App at the root (shared/mount.ts). Checked in main. */
  mounts?: Record<string, string>;
  /** `--base-path` (or MISTRI_BASE_PATH) as written: the path a reverse proxy serves this server under. Checked in main. */
  basePath?: string;
  commands?: string;
  /** A server-only defineJobs module: durable jobs that run the App's commands. */
  jobs?: string;
  policy?: string;
  /** `--read-pool` as written: PostgreSQL readers per database for every pool that names none. Checked in main. */
  readPool?: string;
  /** `--write-pool` as written: writers per database for an App's PostgreSQL source. Checked in main. */
  writePool?: string;
  /** `--lock-timeout` as written: seconds a writer waits for a lock. Checked in main. */
  lockTimeout?: string;
  /** `--pooler` as written: what sits between this process and PostgreSQL. Checked in main. */
  pooler?: string;
  /** `--drain-delay` as written: seconds /readyz fails before the listener closes on SIGTERM. Checked by shutdownTimings. */
  drainDelay?: string;
  /** `--shutdown-grace` as written: seconds a response still unfinished after the drain may keep the process. Checked by shutdownTimings. */
  shutdownGrace?: string;
  /**
   * Not a flag: set by `createHandler` (embed/handler.ts), whose server
   * runs inside somebody else's process. A startup refusal throws instead of
   * exiting it, and links are minted for the host's own origin. `origins` are
   * its `embed.origins`, carried on the listener's `Bound` (http/trust.ts).
   */
  embedded?: { publicURL: string; origins?: readonly string[] };
}

export function parseArgs(argv: string[]): Options {
  /* Loopback by default. A database browser listening on every interface is
     one shared wifi away from being someone else's database browser, and the
     old `listen(port)` did exactly that. Binding elsewhere is possible but
     has to be asked for. */
  const opts: Options = {
    target: '',
    port: 4111,
    host: '127.0.0.1',
    schemas: [],
    open: false,
    noConfig: false,
    allowedHosts: [],
    trustProxy: [],
    trustProxyCloudflare: false,
    mcp: false,
    outputSchema: false,
    tools: '',
    help: false,
    version: false,
    demo: false,
    portGiven: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db' || arg === '-d') opts.target = argv[++i] ?? '';
    else if (arg === '--port' || arg === '-p') {
      opts.port = Number(argv[++i] ?? 4111);
      opts.portGiven = true;
    } else if (arg === '--demo') opts.demo = true;
    else if (arg === '--host') opts.host = argv[++i] ?? '127.0.0.1';
    else if (arg === '--allowed-host') opts.allowedHosts.push(argv[++i] ?? '');
    else if (arg === '--trust-proxy') opts.trustProxy.push(argv[++i] ?? '');
    else if (arg === '--trust-proxy-hops') opts.trustProxyHops = argv[++i] ?? '';
    else if (arg === '--trust-proxy-cloudflare') opts.trustProxyCloudflare = true;
    else if (arg === '--insecure-http-sign-in') opts.insecureHttpSignIn = true;
    else if (arg === '--auth-proxy-header') opts.authProxyHeader = (argv[++i] ?? '').trim() || undefined;
    /* Renamed before 1.0, and refused rather than ignored: beside three flags
       that name the visitor's address it read as one of them, and a server
       that silently dropped it would stop requiring the identity header. */
    else if (arg === '--trust-proxy-header') {
      i++;
      opts.retired ??= '--trust-proxy-header is now --auth-proxy-header (the header a signing-in proxy sets with the user).';
    } else if (arg === '--schema') opts.schemas.push(argv[++i] ?? '');
    else if (arg === '--read-pool') opts.readPool = argv[++i] ?? '';
    else if (arg === '--write-pool') opts.writePool = argv[++i] ?? '';
    else if (arg === '--lock-timeout') opts.lockTimeout = argv[++i] ?? '';
    else if (arg === '--pooler') opts.pooler = argv[++i] ?? '';
    else if (arg === '--drain-delay') opts.drainDelay = argv[++i] ?? '';
    else if (arg === '--shutdown-grace') opts.shutdownGrace = argv[++i] ?? '';
    else if (arg === '--api-integers') {
      if (opts.apiIntegers !== undefined) opts.unknown = '--api-integers (may be supplied only once)';
      else opts.apiIntegers = argv[++i] ?? '';
    } else if (arg === '--api-reads') {
      if (opts.apiReads !== undefined) opts.unknown = '--api-reads (may be supplied only once)';
      else opts.apiReads = true;
    } else if (arg === '--app-mcp') {
      if (opts.appMcp !== undefined) opts.unknown = '--app-mcp (may be supplied only once)';
      else opts.appMcp = true;
    } else if (arg === '--api-requests-per-minute') {
      if (opts.apiRequestsPerMinute !== undefined) opts.unknown = '--api-requests-per-minute (may be supplied only once)';
      else opts.apiRequestsPerMinute = argv[++i] ?? '';
    } else if (arg === '--config') opts.config = argv[++i] ?? '';
    else if (arg === '--no-config') opts.noConfig = true;
    else if (arg === '--no-live') opts.noLive = true;
    else if (arg === '--app') (opts.apps ??= []).push(argv[++i] ?? '');
    else if (arg === '--mount') {
      const said = argv[++i] ?? '';
      const eq = said.indexOf('=');
      if (eq <= 0) opts.unknown = `--mount ${said} (write it <app>=<path>, like main=/ or billing=/billing)`;
      else if (Object.hasOwn((opts.mounts ??= {}), said.slice(0, eq))) opts.unknown = `--mount ${said} (each App is mounted once)`;
      else opts.mounts[said.slice(0, eq)] = said.slice(eq + 1);
    } else if (arg === '--base-path') {
      if (opts.basePath !== undefined) opts.unknown = '--base-path (may be supplied only once)';
      else opts.basePath = argv[++i] ?? '';
    } else if (arg === '--app-entry') {
      if (opts.appEntry !== undefined) opts.unknown = '--app-entry (may be supplied only once)';
      else opts.appEntry = argv[++i] ?? '';
    } else if (arg === '--commands') {
      if (opts.commands !== undefined) opts.unknown = '--commands (may be supplied only once)';
      else opts.commands = argv[++i] ?? '';
    } else if (arg === '--jobs') {
      if (opts.jobs !== undefined) opts.unknown = '--jobs (may be supplied only once)';
      else opts.jobs = argv[++i] ?? '';
    } else if (arg === '--policy') {
      if (opts.policy !== undefined) opts.unknown = '--policy (may be supplied only once)';
      else opts.policy = argv[++i] ?? '';
    } else if (arg === '--scaffold-app') opts.scaffoldApp = argv[++i] ?? '';
    else if (arg === '--name') opts.name = argv[++i] ?? '';
    else if (arg === '--from-openapi') opts.fromOpenapi = argv[++i] ?? '';
    else if (arg === '--openapi') opts.openapi = argv[++i] ?? '';
    else if (arg === '--api-url') opts.apiUrl = argv[++i] ?? '';
    else if (arg === '--api-token-env') opts.apiTokenEnv = argv[++i] ?? '';
    else if (arg === '--write-authority') opts.writeAuthority = true;
    else if (arg === '--bump') (opts.bump ??= []).push(argv[++i] ?? '');
    else if (arg === '--reindex') {
      // The resource is optional: `--reindex` alone indexes every searched resource.
      const next = argv[i + 1];
      opts.reindex = next !== undefined && !next.startsWith('-') ? argv[++i] : '';
    } else if (arg === '--open') opts.open = true;
    else if (arg === '--dev') opts.dev = true;
    else if (arg === '--mcp') opts.mcp = true;
    else if (arg === '--output-schema') opts.outputSchema = true;
    else if (arg === '--tools') opts.tools = argv[++i] ?? '';
    else if (arg === '--export') opts.export = argv[++i] ?? '';
    /* `--lint` takes no argument by default, so `tablewalk --lint --db x`
       must not eat the next flag as a format. */
    else if (arg === '--lint') {
      opts.lint = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'text';
    } else if (arg === '--fail-on') opts.failOn = argv[++i] ?? '';
    else if (arg === '--diff') opts.diff = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-v' || arg === '-V') opts.version = true;
    else if (!arg.startsWith('-') && !opts.target) opts.target = arg;
    /* An unknown flag is a mistake, and saying so is cheap.

       It used to be ignored. That was survivable only by accident: with no
       target, the "nothing to open" gate printed the usage and exited, so
       `tablewalk --prot 4111` looked like it had told you something. Now that
       a server starts with nothing, the same typo silently starts one on the
       default port and waits — the least useful thing it could do with a
       command it did not understand. */
    else if (arg.startsWith('-') && !opts.unknown) opts.unknown = arg;
  }
  if (!opts.target && process.env.DATABASE_URL) {
    opts.target = process.env.DATABASE_URL;
    opts.targetFromEnvironment = true;
  }
  /* The env var exists for containers, where the name someone reaches tablewalk
     by is a property of the deployment rather than of the command line — a
     compose file sets it once, and the image's own CMD stays untouched. */
  opts.allowedHosts.push(...parseHostList(productEnv('ALLOWED_HOSTS')));
  if (!opts.authProxyHeader && productEnv('AUTH_PROXY_HEADER')?.trim()) {
    opts.authProxyHeader = productEnv('AUTH_PROXY_HEADER')!.trim();
  }
  if (productEnv('TRUST_PROXY_HEADER')?.trim())
    opts.retired ??= `${envName('TRUST_PROXY_HEADER')} is now ${envName('AUTH_PROXY_HEADER')} (the header a signing-in proxy sets with the user).`;
  opts.allowedHosts = opts.allowedHosts.filter(Boolean);
  // Added to the flags, like MISTRI_ALLOWED_HOSTS: a compose file names
  // its network's proxy once and the image's CMD stays untouched.
  opts.trustProxy.push(...parseHostList(productEnv('TRUST_PROXY')));
  if (opts.trustProxyHops === undefined && productEnv('TRUST_PROXY_HOPS')?.trim()) {
    opts.trustProxyHops = productEnv('TRUST_PROXY_HOPS')!.trim();
  }
  if (/^(1|true)$/i.test(productEnv('TRUST_PROXY_CLOUDFLARE')?.trim() ?? '')) opts.trustProxyCloudflare = true;
  if (/^(1|true)$/i.test(productEnv('INSECURE_HTTP_SIGN_IN')?.trim() ?? '')) opts.insecureHttpSignIn = true;
  /* Cloud Run, Heroku and most platforms hand the port in as PORT. A flag
     wins; it is the platform's word, so a busy port is not rolled past. */
  if (
    !opts.portGiven &&
    /^\d{1,5}$/.test(process.env.PORT?.trim() ?? '') &&
    Number(process.env.PORT) >= 1 &&
    Number(process.env.PORT) <= 65535
  ) {
    opts.port = Number(process.env.PORT);
    opts.portGiven = true;
  }
  /* The pool's shape is a fact about the deployment — the pod's share of the
     database's connections, the pooler in its path — so a container sets it
     once, as with the variables above. A flag says it for one run and wins. */
  if (opts.readPool === undefined && productEnv('READ_POOL')?.trim()) opts.readPool = productEnv('READ_POOL')!.trim();
  if (opts.writePool === undefined && productEnv('WRITE_POOL')?.trim()) opts.writePool = productEnv('WRITE_POOL')!.trim();
  if (opts.lockTimeout === undefined && productEnv('LOCK_TIMEOUT')?.trim()) opts.lockTimeout = productEnv('LOCK_TIMEOUT')!.trim();
  if (opts.pooler === undefined && productEnv('POOLER')?.trim()) opts.pooler = productEnv('POOLER')!.trim();
  // How long a platform lets a stopping container drain is the deployment's too.
  if (opts.drainDelay === undefined && productEnv('DRAIN_DELAY')?.trim()) opts.drainDelay = productEnv('DRAIN_DELAY')!.trim();
  if (opts.shutdownGrace === undefined && productEnv('SHUTDOWN_GRACE')?.trim()) opts.shutdownGrace = productEnv('SHUTDOWN_GRACE')!.trim();
  // Where the proxy serves it is the deployment's, as the host names are.
  if (opts.basePath === undefined && productEnv('BASE_PATH')?.trim()) opts.basePath = productEnv('BASE_PATH')!.trim();
  return opts;
}

/** Cloud Run gives a stopping instance 10 seconds in all, so the default drains nothing and cuts a stuck response at 10. */
export const DEFAULT_SHUTDOWN_TIMINGS = { drainMs: 0, graceMs: 10_000 } as const;
const MAX_DRAIN_DELAY_S = 120;
const MAX_SHUTDOWN_GRACE_S = 300;

/**
 * What `--drain-delay` and `--shutdown-grace` (or MISTRI_DRAIN_DELAY and
 * MISTRI_SHUTDOWN_GRACE) name, in milliseconds, or the sentence saying why
 * they cannot be used. The delay is the beat a balancer that probes /readyz
 * needs between the first 503 and the listener closing; the grace bounds a
 * response that never finishes once the rest has drained. They come one after
 * the other, so a platform's stop timeout must hold both plus the drain.
 */
export function shutdownTimings(opts: Pick<Options, 'drainDelay' | 'shutdownGrace'>): { drainMs: number; graceMs: number } | string {
  const seconds = (value: string | undefined, flag: string, variable: string, low: number, high: number): number | string | undefined => {
    if (value === undefined) return undefined;
    const given = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    if (!(given >= low && given <= high))
      return `${flag} takes seconds from ${low} to ${high}; "${value}" is not one. It comes from the flag or ${variable}.`;
    return Math.round(given * 1000);
  };
  const drainMs = seconds(opts.drainDelay, '--drain-delay', envName('DRAIN_DELAY'), 0, MAX_DRAIN_DELAY_S);
  if (typeof drainMs === 'string') return drainMs;
  const graceMs = seconds(opts.shutdownGrace, '--shutdown-grace', envName('SHUTDOWN_GRACE'), 1, MAX_SHUTDOWN_GRACE_S);
  if (typeof graceMs === 'string') return graceMs;
  return { drainMs: drainMs ?? DEFAULT_SHUTDOWN_TIMINGS.drainMs, graceMs: graceMs ?? DEFAULT_SHUTDOWN_TIMINGS.graceMs };
}

/**
 * The process-wide pool defaults `--read-pool`, `--write-pool`, `--pooler`
 * and `--lock-timeout` (or their variables) name, or the sentence saying why
 * they cannot be used. Refused rather than clamped: a pod sized for 16
 * readers that quietly got 4 is a capacity plan nobody can see failing.
 */
export function postgresPoolFlags(
  opts: Pick<Options, 'readPool' | 'writePool' | 'pooler' | 'lockTimeout'>,
): { readers?: number; writers?: number; pooler?: PoolerMode; lockTimeoutMs?: number } | string {
  let readers: number | undefined;
  if (opts.readPool !== undefined) {
    readers = /^\d+$/.test(opts.readPool) ? Number(opts.readPool) : Number.NaN;
    if (!isReaderCount(readers)) {
      return `--read-pool takes a whole number from 1 to ${MAX_READERS}; "${opts.readPool}" is not one. It comes from the flag or ${envName('READ_POOL')}.`;
    }
  }
  let writers: number | undefined;
  if (opts.writePool !== undefined) {
    writers = /^\d+$/.test(opts.writePool) ? Number(opts.writePool) : Number.NaN;
    if (!isWriterCount(writers)) {
      return `--write-pool takes a whole number from 1 to ${MAX_WRITERS}; "${opts.writePool}" is not one. It comes from the flag or ${envName('WRITE_POOL')}.`;
    }
  }
  let lockTimeoutMs: number | undefined;
  if (opts.lockTimeout !== undefined) {
    lockTimeoutMs = /^\d+(\.\d+)?$/.test(opts.lockTimeout) ? Math.round(Number(opts.lockTimeout) * 1000) : Number.NaN;
    if (!isLockTimeout(lockTimeoutMs)) {
      return `--lock-timeout takes seconds from ${MIN_LOCK_TIMEOUT_MS / 1000} to ${MAX_LOCK_TIMEOUT_MS / 1000}; "${opts.lockTimeout}" is not one. It comes from the flag or ${envName('LOCK_TIMEOUT')}.`;
    }
  }
  const pooler = opts.pooler;
  if (pooler !== undefined && pooler !== 'session' && pooler !== 'transaction') {
    return `--pooler takes "session" or "transaction"; "${pooler}" is neither. It comes from the flag or ${envName('POOLER')}.`;
  }
  return {
    ...(readers !== undefined ? { readers } : {}),
    ...(writers !== undefined ? { writers } : {}),
    ...(pooler !== undefined ? { pooler } : {}),
    ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
  };
}
