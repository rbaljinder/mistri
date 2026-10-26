/**
 * `createHandler`: an App served from inside somebody else's server,
 * under a path that server chose.
 *
 * Nothing here routes. The startup is the command line's (cli/serve.ts
 * `startServing`, cli/tenant.ts `startTenantServing`) with the listening left
 * out: it hands back the `node:http` server it wired, unlistened, and every
 * request is given to that server's own `request` listeners — the same
 * dispatch, gate, error mapping and analytics beacon a port would reach.
 * `node` is that for a Node host (http.createServer, Express, Fastify's raw
 * request); `fetch` is the same through a bridge (fetchBridge.ts) for a host
 * whose routes speak Fetch. The base path is the server's own `--base-path`,
 * so cookies, links in mail, the page's files and an App's canonical
 * addresses are all said under it exactly as they are behind a proxy.
 *
 * What the command line would refuse, this refuses — by throwing, never by
 * exiting the host's process — and a config that serves no App is refused
 * too: the standalone database browser is never mounted inside another
 * server, since its connection form treats whoever reaches it as the
 * operator.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBasePath, SERVER_SEGMENTS } from '@mistriwork/engine/shared/mount.js';
import { embedOrigin } from './issuerConfig.js';
import { bridgeFetch } from './fetchBridge.js';
import type { MountedServing } from '../cli/serve.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import { defaultServerSettings, withServerSettings, type ServerSettings } from '@mistriwork/engine/adapters/serverSettings.js';
import { SHARED_RATE_LIMIT_WARNING, warnOnce } from '@mistriwork/engine/server/startupWarnings.js';

export interface HandlerOptions {
  /** A mistri config file (connections, apps, auth), exactly as `--config` reads it. */
  config: string;
  /** Where the host serves the handler, like `/crm`: the server's `--base-path`. Every address it answers is under it. */
  basePath: string;
  /** The origin people's browsers use, like `https://example.com`: the Host and Origin checks, sign-in callbacks and links in mail are minted for it. */
  publicOrigin: string;
  /** An App directory to serve, as `--app` names one; the config's `"apps"` otherwise. A tenant App is named here. */
  app?: string;
  /** The App's commands module, as `--commands`. */
  commands?: string;
  /** A row-policy or tenant App's policy module, as `--policy`. */
  policy?: string;
  /**
   * A `defineJobs` module's path, as `--jobs` names one: its jobs run in this
   * process, beside the requests, and stop with `close()`. Needs `app`. Absent,
   * no job runs here — run them in a `mistri --jobs` process of their own
   * over the same database, as a deployment with several web processes does.
   */
  jobs?: string;
  /** A host on another origin than `publicOrigin`, or framing the App's pages. */
  embed?: {
    /**
     * Browser origins, exactly (`https://app.example.com`: no path, no
     * wildcard; http only on localhost), that may call this handler — CORS,
     * answered to that origin alone, `Vary: Origin`, never with credentials —
     * and frame an App's page asked for with `?embed=frame`. Added to the
     * origins the config file's hosts (`"kind": "embed"`) list. A request from
     * one never reads a cookie: it is signed in only by the bearer a host's
     * exchange gave that origin, which only an issuer's own origins are given.
     */
    origins?: readonly string[];
  };
}

export interface Handler {
  /** Node listener: `http.createServer(tw.node)`, Express `app.use(tw.node)`. Mount it before any body parser. */
  node(req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void): void;
  /** Fetch handler: a Next route handler, a TanStack Start server route, Hono's `c.req.raw`. */
  fetch(request: Request, context?: { clientAddress?: string }): Promise<Response>;
  /** Settles when the Apps, sign-in and pools are loaded. Requests before it wait; past ten seconds they are answered 503 with Retry-After. */
  readonly ready: Promise<void>;
  /** Stops the jobs, drains what is in flight and closes the pools and sign-in stores. Requests after it are answered 503. */
  close(): Promise<void>;
}

/** How long a request waits for startup before it is told to come back, as `/readyz` would say. */
const STARTUP_WAIT_MS = 10_000;

/** The origin as a browser sends it, or a refusal naming what is wrong with it. */
function parseOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(
      `createHandler: publicOrigin "${value}" is not a URL; give the origin people's browsers use, like https://example.com.`,
    );
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.replace(/\/+$/, '')) {
    throw new Error(
      `createHandler: publicOrigin "${value}" must be an origin alone — scheme, host and port, like https://example.com — with no path.`,
    );
  }
  return origin;
}

/**
 * Why a base path cannot be the handler's, or undefined. Its segments are the
 * host's address for mistri, and the server's own first segments
 * (shared/mount.ts SERVER_SEGMENTS) said again inside it make an address that
 * reads as two things: `/assets/tw` is the host's static files to every CDN
 * and build tool rule that caches `/assets/*` for a year, `/healthz/tw` is an
 * orchestrator's probe, and `/api` itself, or `/tw/api`, puts mistri's API
 * at `/api/api/…`. One shape is the host's own and is recommended: `api` first,
 * under a segment of the host's (`/api/tw`), beside the host's other routes.
 */
function basePathClash(base: string): string | undefined {
  const segments = base.split('/').filter(Boolean);
  const clash = segments.find(
    (segment, at) => SERVER_SEGMENTS.includes(segment) && !(at === 0 && segment === 'api' && segments.length > 1),
  );
  if (clash === undefined) return undefined;
  return (
    `createHandler: basePath "${base}" says "${clash}", one of the paths mistri answers itself (${SERVER_SEGMENTS.join(', ')}), ` +
    'so its addresses would read as two things. Mount it at a path of your own, like /crm, or under your API as /api/tw.'
  );
}

/** The handler's `embed.origins`, each checked as a config file's host origin is; the public origin is its own already. */
function embedOriginsOf(embed: HandlerOptions['embed'], publicOrigin: URL): string[] {
  if (embed === undefined) return [];
  if (!embed || typeof embed !== 'object' || Object.keys(embed).some((key) => key !== 'origins')) {
    throw new Error('createHandler: embed takes { origins: ["https://app.example.com"] }.');
  }
  if (embed.origins === undefined) return [];
  if (!Array.isArray(embed.origins))
    throw new Error('createHandler: embed.origins is a list of origins, like ["https://app.example.com"].');
  const origins = embed.origins.map((value) => embedOrigin(value, 'createHandler: embed.origins'));
  if (new Set(origins).size !== origins.length) throw new Error('createHandler: embed.origins names the same origin twice.');
  return origins.filter((value) => value !== publicOrigin.origin);
}

/**
 * The handler's own settings, read from the environment as the command line
 * reads them, and the options the startup is given. Settings, not process
 * globals (adapters/serverSettings.ts): a host process can mount several
 * handlers, and each keys its limits by its own proxy trust and sizes its
 * own pools.
 */
async function prepare(
  options: HandlerOptions,
  base: string,
  origin: URL,
  embedOrigins: readonly string[],
): Promise<{ opts: import('@mistriwork/engine/server/cli/args.js').Options; settings: ServerSettings }> {
  const [{ parseArgs, postgresPoolFlags, shutdownTimings }, { parseClientAddressPolicy, parseTrustedProxies }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/http/trust.js'),
  ]);
  /* The command line's options, as `mistri --config … --base-path …`
     would read them: the environment's pool and proxy settings apply as they
     would there, and nothing else the environment says about a database. */
  const opts = parseArgs([]);
  if (opts.retired) throw new Error(opts.retired);
  opts.target = '';
  opts.targetFromEnvironment = false;
  opts.config = resolve(options.config);
  opts.basePath = base;
  if (options.app !== undefined) opts.apps = [options.app];
  if (options.commands !== undefined) opts.commands = options.commands;
  if (options.policy !== undefined) opts.policy = options.policy;
  if (options.jobs !== undefined) opts.jobs = options.jobs;
  opts.host = origin.hostname.replace(/^\[|\]$/g, '');
  opts.port = Number(origin.port) || (origin.protocol === 'https:' ? 443 : 80);
  opts.portGiven = true;
  opts.open = false;
  // The host's name is the one the Host check accepts; it is never "this machine" (trust.ts clientTrusted).
  opts.allowedHosts = [...new Set([origin.host, ...opts.allowedHosts])];
  opts.embedded = { publicURL: origin.origin, ...(embedOrigins.length ? { origins: embedOrigins } : {}) };
  const proxies = parseTrustedProxies(opts.trustProxy);
  if (proxies.invalid.length) throw new Error(`MISTRI_TRUST_PROXY: ${proxies.invalid.join(', ')} is not an address or range.`);
  opts.trustedProxies = proxies.ranges;
  const client = parseClientAddressPolicy({ hops: opts.trustProxyHops, cloudflare: opts.trustProxyCloudflare });
  if ('error' in client) throw new Error(client.error);
  const pools = postgresPoolFlags(opts);
  if (typeof pools === 'string') throw new Error(pools);
  const timings = shutdownTimings(opts);
  if (typeof timings === 'string') throw new Error(timings);
  return {
    opts,
    settings: {
      ...defaultServerSettings(),
      clientAddress: client.policy,
      ...(pools.readers !== undefined ? { readers: pools.readers } : {}),
      ...(pools.pooler !== undefined ? { pooler: pools.pooler } : {}),
      ...(pools.writers !== undefined ? { writers: pools.writers } : {}),
      ...(pools.lockTimeoutMs !== undefined ? { lockTimeoutMs: pools.lockTimeoutMs } : {}),
    },
  };
}

/** Startup, inside the handler's settings scope: what it opens takes them. */
async function start(
  opts: import('@mistriwork/engine/server/cli/args.js').Options,
  settings: ServerSettings,
  embedOrigins: readonly string[],
): Promise<MountedServing> {
  const { Registry } = await import('@mistriwork/engine/server/connections.js');
  const registry = new Registry();
  try {
    /* The config's identity and email sections are registered by serviceConnections. */
    const [{ readStartupConfig }, { loadStartupApps }, { isRowPolicyApp, isTenantApp }] = await Promise.all([
      import('../serviceConnections.js').then(() => import('@mistriwork/engine/server/cli/config.js')),
      import('../cli/apps.js'),
      import('../../shared/appModel.js'),
    ]);
    const config = await readStartupConfig(opts, registry, CONFIG_SECTIONS);
    if (opts.noLive) (await import('../live/liveBinding.js')).setLiveSync(false);
    // Settled once the config is read, as the command line settles it (writeLanes.ts).
    settings.writeOrder = 'keyed';
    const apps = await loadStartupApps(opts, registry, config);
    const { loadedApps } = apps;
    if (!loadedApps.length) {
      throw new Error(
        'createHandler serves an App, and this config names none. The standalone database browser is never mounted ' +
          'inside another server: name an App with the config\'s "apps" or the handler\'s app option.',
      );
    }
    if (loadedApps.some((loaded) => isTenantApp(loaded.app))) {
      /* A tenant App's host holds its door to the origins its hosts' issuers list (embed/crossOrigin.ts), and to nothing beside them. */
      if (embedOrigins.length) {
        throw new Error(
          'createHandler: a tenant App takes cross-origin requests from the origins its hosts list in the config file ("kind": "embed"), not from embed.origins.',
        );
      }
      const { startTenantServing } = await import('../cli/tenant.js');
      const served = await startTenantServing(opts, registry, config, apps, false);
      if (!served) throw new Error('The tenant App stopped while it started.');
      return served;
    }
    if (opts.policy !== undefined || loadedApps.some((loaded) => isRowPolicyApp(loaded.app))) {
      if (!opts.policy || opts.apps?.length !== 1 || loadedApps.length !== 1) {
        throw new Error('A row-policy App needs the policy option and exactly one app.');
      }
      const { assertHttpRowPolicyApp } = await import('../policy/appPolicyHttp.js');
      assertHttpRowPolicyApp(loadedApps[0].app, opts.commands !== undefined || loadedApps.some((loaded) => loaded.commands));
    }
    // A bad connection is a startup error, as on the command line, not a broken page.
    if (registry.active) await registry.open(registry.active);
    // An App's declared API validates before anything is served (cli/mistriMain.ts does the same).
    if (loadedApps.some((loaded) => loaded.app.api)) {
      const { loadAppRuntimeResources } = await import('../app/appRuntimeResources.js');
      for (const loaded of loadedApps.filter((candidate) => candidate.app.api)) {
        const scoped = loaded.app.connection;
        const match = registry.list().find((connection) => connection.id === scoped || connection.name === scoped);
        if (scoped && !match) throw new Error('API application entry connection is unavailable.');
        await loadAppRuntimeResources(registry, loaded.app, match?.id ?? registry.active!);
      }
    }
    const { hostCommands } = await import('../cli/commandHost.js');
    const hosted = await hostCommands(opts, registry, loadedApps);
    const { startServing } = await import('../cli/serve.js');
    const served = await startServing(opts, registry, config, apps, hosted, false);
    if (!served) throw new Error('The server stopped while it started.');
    return served;
  } catch (error) {
    // startServing closes what it opened; before it, the registry is still ours.
    await registry.closeAll().catch(() => {});
    throw error;
  }
}

export function createHandler(options: HandlerOptions): Handler {
  if (!options || typeof options.config !== 'string' || !options.config) {
    throw new Error('createHandler: config names the mistri config file to serve.');
  }
  if (!existsSync(options.config)) throw new Error(`createHandler: no config file at ${resolve(options.config)}.`);
  if (typeof options.basePath !== 'string') throw new Error('createHandler: basePath is where the host serves the handler, like /crm.');
  const base = parseBasePath(options.basePath, 'createHandler: basePath');
  const clash = basePathClash(base);
  if (clash) throw new Error(clash);
  const origin = parseOrigin(String(options.publicOrigin ?? ''));
  if (options.jobs !== undefined && (typeof options.jobs !== 'string' || !options.jobs)) {
    throw new Error(
      'createHandler: jobs is the path of a defineJobs module, as --jobs names one; leave it out to run the jobs in a mistri --jobs process of their own.',
    );
  }
  if (options.jobs !== undefined && options.app === undefined) {
    throw new Error('createHandler: jobs run the commands of one App; name it with the app option.');
  }
  const embedOrigins = embedOriginsOf(options.embed, origin);

  let served: MountedServing | undefined;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  /* Filled in before startup opens anything; until then a request waits for `ready`, so none reads it unset. */
  let settings: ServerSettings | undefined;
  const ready = prepare(options, base, origin, embedOrigins)
    .then((prepared) => {
      settings = prepared.settings;
      return withServerSettings(prepared.settings, () => start(prepared.opts, prepared.settings, embedOrigins));
    })
    .then(
      (serving) => {
        served = serving;
      },
      (error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
      },
    );
  // A host that never awaits `ready` still gets its requests refused with the reason, not an unhandled rejection.
  ready.catch(() => {});

  const under = (path: string) => !base || path === base || path.startsWith(`${base}/`);
  const unavailable = (res: ServerResponse, message: string, retry: boolean) => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(retry ? { 'retry-after': '5' } : {}),
    });
    res.end(JSON.stringify({ error: message }));
  };
  const dispatch = (req: IncomingMessage, res: ServerResponse) => {
    if (closing) return unavailable(res, 'This App is shutting down.', false);
    if (failure) return unavailable(res, `This App could not start: ${failure.message}`, false);
    // Everything the request runs is this handler's: its proxy trust keys its limits, its pools serve it.
    withServerSettings(settings!, () => served!.server.emit('request', req, res));
  };

  const node: Handler['node'] = (req, res, next) => {
    /* Express takes its mount off `req.url` and keeps the whole of it in
       `originalUrl`. The server takes the base path off itself, so it reads
       the whole address either way: one rule, whatever the host stripped. */
    const original = (req as IncomingMessage & { originalUrl?: unknown }).originalUrl;
    const full = typeof original === 'string' ? original : (req.url ?? '/');
    if (!under(full.split('?')[0])) {
      // Not ours: the host's router has the request back as it gave it.
      if (next) return next();
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        .end(`Not found: mistri is mounted at ${base}.\n`);
      return;
    }
    /* The server reads its own bodies, bounded (http/reply.ts). A body parser
       ahead of it has already drained the stream, and a body read as empty
       would be a quieter and worse failure than saying so. */
    const parsed = (req as IncomingMessage & { _body?: unknown })._body === true;
    if (parsed || (req.readableEnded && req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          error:
            'mistri reads its own request bodies, and a body parser (express.json(), bodyParser) read this one first. Mount mistri before it.',
        }),
      );
      return;
    }
    req.url = full;
    if (served || failure || closing) return dispatch(req, res);
    let waited = false;
    const timer = setTimeout(() => {
      waited = true;
      unavailable(res, 'This App is starting. Try again in a moment.', true);
    }, STARTUP_WAIT_MS);
    void ready
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        if (!waited) dispatch(req, res);
      });
  };

  return {
    node,
    fetch: (request, context) => {
      // Without the visitor's address the bridge names one peer for everyone (fetchBridge.ts), so they share one budget.
      if (!context?.clientAddress?.trim()) warnOnce('shared-rate-limit', SHARED_RATE_LIMIT_WARNING);
      return bridgeFetch(request, node, context);
    },
    ready,
    close() {
      if (!closing) {
        closing = ready.catch(() => {}).then(() => (served && settings ? withServerSettings(settings, () => served!.close()) : undefined));
      }
      return closing;
    },
  };
}
