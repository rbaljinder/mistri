/** One listener for independently configured App servers. Each child keeps
 * its registry, policy and authentication gate; requests are never proxied or
 * rewritten here. Children must be configured with their public base path. */
import { type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  appMounts,
  appHome,
  inward,
  parseBasePath,
  parseMountPath,
  SERVER_SEGMENTS,
  type AddressMount,
} from '@mistriwork/engine/shared/mount.js';
import { applyServerTimeouts } from '@mistriwork/engine/server/serverTimeouts.js';
import { probe } from '@mistriwork/engine/server/http/probes.js';
import { frontDoor } from '@mistriwork/engine/server/http/frontDoor.js';
import type { ProxyRange } from '@mistriwork/engine/server/http/trust.js';
import { SOURCE_CLIENT, attachDevClient, closeDevClientHmr, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import {
  createTenantHostRouter,
  getTenantHostIntent,
  normalizeSuitePublicOrigin,
  validateTenantDomain,
  validateTenantHosts,
  type TenantDomain,
  type TenantHostIntent,
  type TenantHostSource,
} from './tenantHosts.js';
import {
  createTenantDomains,
  dohResolver,
  hostCertificatesFor,
  PENDING_DOMAIN_DAYS,
  SUSPEND_AFTER,
  type CustomDomainsConfig,
  type DnsResolver,
  type HostCertificates,
  type TenantDomainsService,
  type TenantDomainsStore,
} from './customDomains.js';
import type { SuiteLinkHost } from '../auth/suiteLinkHttp.js';
import { hostSignInPath, hostSignInStaffPath } from '../auth/hostHandoff.js';
import type { FlagAuthorityOptions } from '../flags/authority.js';
import { openSuiteFlags, type SuiteFlags, type SuiteFlagsOptions } from './suiteFlags.js';
import { timeRequests } from '@mistriwork/engine/adapters/telemetry/serverTiming.js';

/** A custom domain is checked once a day; a tick each hour finds the ones due, so a restart does not reset the day. */
const DOMAIN_CHECK_DUE_MS = 23 * 60 * 60 * 1000;
const DOMAIN_CHECK_TICK_MS = 60 * 60 * 1000;

export interface SuiteHost {
  id: string;
  /** An unbound server, configured with the base path supplied to its factory. */
  server: Server;
  /** Trusted child capability, after Host/App admission and before sessions or mount stripping. */
  publicPlacementRoute?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Route metadata and access owners retained by this child, never authority in a URL. */
  links?: SuiteLinkHost;
  /** The tenant host table of a tenant App: read by the suite's router, and seeded with the suite's static `hosts`. */
  tenantHosts?: TenantHostSource & { seed(hosts: readonly { host: string; tenantId: string }[]): Promise<void> };
  /** A tenant App's custom domains (customDomains.ts), when the suite has `customDomains`: the daily check runs them. */
  domains?: TenantDomainsService;
  /** Sign-in on a tenant's own host (tenantAuthenticatedHttp.ts `hostSignIn`): its addresses, routed before any dispatch. */
  hostSignIn?: (req: IncomingMessage, res: ServerResponse, route: 'sign-in' | 'handoff' | 'sign-out' | 'staff') => Promise<void>;
  /** Private child-owned native authority factory; never read from an App DTO. */
  flagTargetFactory?: () => Omit<FlagAuthorityOptions, 'environment'>;
  experimentConversionAuthority?: (options: {
    epoch: import('../experiments/contracts.js').RegisteredEpoch;
    policy: import('../../adapters/events/eventDeliveryTypes.js').EventDeliveryPolicy;
  }) => {
    authorize(
      request: import('../experiments/conversionOwner.js').NativeConversionAuthorityRequest,
    ): Promise<import('../experiments/contracts.js').CommitGuard>;
    close(): void;
  };
  flagName?: string;
  attachFlagRuntime?: (port: import('../flags/deployment.js').FlagRequestReadPort, assertCurrent?: () => void) => void;
  flagValuesRoute?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** The account's active tenant memberships here, ids only: the Console's flag
   * scopes, and a count for the suite's `member` landing rules. */
  flagScopes?: (request: IncomingMessage, accountId: string) => Promise<readonly { tenantId: string; label: string }[]>;
  /** Structural native membership lease; no tenant source crosses the port. */
  flagScopeProof?: (environment: string) => (
    request: IncomingMessage,
    accountId: string,
    tenantId: string | null,
  ) => Promise<{
    reobserve(): void | Promise<void>;
    assertCurrent(): void;
  } | null>;
  /** This App's jobs, deliveries, workflows, store layouts and analytics, for the Console's Operations and Analytics rooms. */
  consoleOperations?: Omit<import('../console/operations.js').ConsoleOperationsOwner, 'appId'>;
  /** Activate background owners only once the suite listener is ready. */
  start?: () => void | Promise<void>;
  /** Stop upgraded connections and background admissions before HTTP drain. */
  stop: () => Promise<void>;
  /** Drain owned operations and release resources after HTTP responses finish. */
  close: () => Promise<void>;
}

/** Validate addresses before any factory opens stores or starts background work. */
export async function createSuite(
  apps: ReadonlyArray<{
    id: string;
    public?: boolean;
    open: (
      basePath: string,
      options: {
        allowedHosts: readonly string[];
        /** What the host table adds to `allowedHosts` while the suite runs (tenantHosts.ts `allows`). */
        allowsHost?: (host: string) => boolean;
        /** A tenant's primary live host from the table, where its links are written. */
        primaryHost?: (tenant: string) => string | undefined;
        /** The router's reading of a host for this App: the one source of a host sign-in's redirect target. */
        hostIntent?: (host: string) => TenantHostIntent | undefined;
        /** Whether a host is a subdomain of the suite's `tenantDomain`, as against a tenant's custom domain. */
        platformHost?: (host: string) => boolean;
        /** The suite's own base, where its sign-in and a host sign-in's staff leg live. */
        suiteBase?: string;
        hosts: readonly TenantHostIntent[];
        /** The custom-domain service over a tenant App's store, when the suite has `customDomains`. */
        domains?: (store: TenantDomainsStore) => TenantDomainsService;
      },
    ) => Promise<Omit<SuiteHost, 'id'>>;
  }>,
  addresses: {
    base?: string;
    mounts?: Readonly<Record<string, string>>;
    publicOrigin?: string;
    hosts?: readonly TenantHostIntent[];
    /** The wildcard parent a tenant's subdomain lives under, validated (tenantHosts.ts `validateTenantDomain`). */
    tenantDomain?: TenantDomain;
    /** Domains a tenant brings itself (customDomains.ts `validateCustomDomains`); absent, none can be added. */
    customDomains?: CustomDomainsConfig;
    /** What a custom domain's checks use in place of the public internet and the clock: for tests. The environment is
     * the operator's, where a certificate provider's credentials are read. */
    domainSeams?: { resolver?: DnsResolver; certificates?: HostCertificates; now?: () => number; environment?: NodeJS.ProcessEnv };
    /** The proxies whose forwarded address and protocol are read, beyond loopback (trust.ts); the baseline's HSTS follows it. */
    trustedProxies?: readonly ProxyRange[];
  } = {},
  identity?: {
    route(req: IncomingMessage, res: ServerResponse): Promise<void> | undefined;
    entry?(
      req: IncomingMessage,
      memberships?: (appId: string, accountId: string) => Promise<number>,
    ): Promise<string | undefined> | undefined;
    /** A redirect for a document request to an App that does not admit the signed-in account. */
    gate?(req: IncomingMessage, appId: string): Promise<string | undefined> | undefined;
    close(): void;
  },
  flagOptions?: SuiteFlagsOptions,
): Promise<{
  server: Server;
  mount: AddressMount;
  flags?: SuiteFlags;
  /** Reads every App's host table now; a suite also does it every 30 s and when a host is written in this process. */
  refreshHosts: () => Promise<void>;
  /** Runs the custom domains' daily check now, for every domain due (customDomains.ts `recheckDue`). */
  recheckDomains: (dueAfterMs?: number) => Promise<void>;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const ids = apps.map((app) => app.id);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('A suite needs distinct App ids.');
  const mounts = Object.fromEntries(
    Object.entries(addresses.mounts ?? {}).map(([id, path]) => [id, parseMountPath(path || '/', `Suite App "${id}"`)]),
  );
  const mount = appMounts(ids, { mounts, base: parseBasePath(addresses.base ?? '') });
  const publicOrigin = addresses.publicOrigin === undefined ? undefined : normalizeSuitePublicOrigin(addresses.publicOrigin);
  const mappings = validateTenantHosts(addresses.hosts, ids, publicOrigin);
  for (const mapping of mappings) {
    if (apps.find((app) => app.id === mapping.app)?.public !== true)
      throw new Error(`Suite host "${mapping.host}" requires an App with a declared public surface.`);
  }
  const tenantDomain = addresses.tenantDomain && validateTenantDomain(addresses.tenantDomain, publicOrigin);
  const hostRouter = createTenantHostRouter(mappings, publicOrigin, tenantDomain ? { tenantDomain } : {});
  const customDomains = addresses.customDomains;
  if (customDomains && !publicOrigin)
    throw new Error('Suite customDomains needs publicOrigin: the staff host a custom domain never takes.');
  const staffHost = publicOrigin && new URL(publicOrigin).hostname;
  const seams = addresses.domainSeams ?? {};
  const certificates =
    customDomains && (seams.certificates ?? (await hostCertificatesFor(customDomains.certificates, seams.environment ?? process.env)));
  const resolver = customDomains && (seams.resolver ?? dohResolver());
  const domainsFor =
    customDomains && certificates && resolver
      ? (store: TenantDomainsStore) =>
          createTenantDomains(store, {
            config: customDomains,
            certificates,
            resolver,
            ...(staffHost ? { staffHost } : {}),
            ...(tenantDomain ? { tenantDomain } : {}),
            // Read every table now: a name another App's tenant claimed a moment ago is held, refresh or not.
            heldBy: async (host) => {
              await hostRouter.refresh();
              return hostRouter.heldBy(host);
            },
            snapshot: (app) => hostRouter.rowsOf(app),
            ...(seams.now ? { now: seams.now } : {}),
          })
      : undefined;
  /* The host table is read when there is something to put in it: subdomains under a tenantDomain, or domains tenants
     bring. Without either the configuration's lists are the whole of it, as they were. */
  const tableHosts = Boolean(tenantDomain || customDomains);
  const hosts = new Map<string, SuiteHost>();
  let stopping = false;
  let flags: SuiteFlags | undefined;
  let closing: Promise<void> | undefined;
  const identityRequests = new Set<Promise<void>>();
  const identityBodies = new Set<IncomingMessage>();
  const target = (url: string | undefined) => {
    let path: string;
    try {
      path = new URL(url ?? '/', 'http://localhost').pathname;
    } catch {
      return undefined;
    }
    const inside = inward(mount, path);
    if (inside === undefined) return undefined;
    // Server endpoints belong to the root App, not whichever App opened first.
    let id: string;
    try {
      id = decodeURIComponent(inside.split('/')[1] ?? '');
    } catch {
      return undefined;
    }
    const root = hosts.get(Object.keys(mount.apps).find((key) => mount.apps[key] === '') ?? '');
    const relative = mount.base ? path.slice(mount.base.length) : path;
    let external: string;
    try {
      external = decodeURIComponent(relative.split('/')[1] ?? '');
    } catch {
      return undefined;
    }
    return SERVER_SEGMENTS.includes(external) ? root : (hosts.get(id) ?? root);
  };
  const customTarget = (req: IncomingMessage) => {
    const intent = getTenantHostIntent(req);
    if (!intent) return target(req.url);
    // Do not let URL parsing normalize an ambiguous incoming path into a mount.
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || /\\|%2f|%5c/i.test(req.url.split('?')[0])) return undefined;
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return undefined;
    }
    const base = appHome(mount, intent.app).replace(/\/$/, '');
    if (path !== base && !path.startsWith(`${base}/`)) return undefined;
    const relative = path.slice(base.length);
    if (/^\/api\/(auth|suite)(\/|$)/.test(relative) || /^\/_mistri\/apps(\/|$)/.test(relative)) return undefined;
    const selected = target(req.url);
    return selected?.id === intent.app ? selected : undefined;
  };
  /* A host sign-in's address, matched on the raw path and nothing looser: an encoded or doubled spelling is no route
     here and falls to the App, which serves no such address. */
  const hostSignInRoute = (req: IncomingMessage, intent: TenantHostIntent | undefined) => {
    const path = (req.url ?? '').split('?')[0];
    if (intent) {
      const host = hosts.get(intent.app);
      const route = (['sign-in', 'handoff', 'sign-out'] as const).find((leg) => path === hostSignInPath(mount, intent.app, leg));
      return host?.hostSignIn && route ? { host, route } : undefined;
    }
    // The staff leg is the suite's, beside its sign-in, so the sign-in can carry it as `next` (suiteLanding.ts).
    if (path !== hostSignInStaffPath(mount.base)) return undefined;
    const app = new URLSearchParams((req.url ?? '').slice(path.length + 1)).getAll('app');
    const host = app.length === 1 ? hosts.get(app[0]) : undefined;
    return host?.hostSignIn ? { host, route: 'staff' as const } : undefined;
  };
  /* The suite's own reads (its sign-in entry, its flag console) wait in a pool's line as their client's
     (poolAdmission.ts); an App it hands the request to files it again, under its own door. Its own answers
     (a stop, a Host it does not serve) carry the baseline headers like every App's. */
  const server = frontDoor(
    {
      trustedProxies: addresses.trustedProxies,
      guard: (req, res) => {
        if (stopping) {
          res.writeHead(503).end('The suite is stopping.');
          return true;
        }
        if (!hostRouter.accept(req)) {
          res.writeHead(403).end('Invalid host.');
          return true;
        }
        return false;
      },
    },
    (req, res) => {
      res.once('finish', () => {
        if (stopping) setImmediate(() => server.closeIdleConnections());
      });
      /* The orchestrator's probes are the suite's own, answered before any App: they went to the App at the root,
       and a suite whose Apps are all mounted under a path has none, so /readyz answered 404 for its whole life and
       an orchestrator, or @mistriwork/mistri/testing's host, waited out its timeout for a suite that was serving. */
      const probed = (() => {
        try {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (!mount.base) return path;
          return path.startsWith(`${mount.base}/`) ? path.slice(mount.base.length) : undefined;
        } catch {
          return undefined;
        }
      })();
      if (probed !== undefined && probe(req, res, probed, () => !stopping)) return;
      const intent = getTenantHostIntent(req);
      /* Caddy's on-demand TLS asks before it issues a certificate for a name a handshake brought: yes for a custom
         domain whose DNS has been seen to point here, no for anything else. Only the status says which: no body, so the
         question cannot be used to learn whose a name is or what state it is in. Asked of the deployment's own host. */
      if (probed === '/_mistri/tls-allowed' && !intent && customDomains?.certificates === 'caddy') {
        const domain = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('domain')?.toLowerCase() ?? '';
        const allowed = req.method === 'GET' && hostRouter.certificateWanted(domain);
        res.writeHead(allowed ? 200 : 404, { 'cache-control': 'no-store', 'content-length': '0' }).end();
        return;
      }
      /* A tenant whose primary is a domain of its own is found there: a page asked for on its platform subdomain moves,
         for good, to the same address on the domain. Only a page: an API call, an asset or a sign-in leg is answered
         where it was asked, so nothing a page already loaded breaks, and the staff host is never a tenant's to move. */
      const moved = intent && hostRouter.platformHost(intent.host) && hostRouter.primaryHost(intent.app, intent.tenant);
      if (
        moved &&
        moved !== intent.host &&
        !hostRouter.platformHost(moved) &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        String(req.headers.accept ?? '').includes('text/html') &&
        req.url?.startsWith('/') &&
        !req.url.startsWith('//') &&
        !/(^|\/)(api|_mistri|assets)(\/|$)/.test(req.url.split('?')[0]!)
      ) {
        const port = /:\d+$/.exec(String(req.headers.host ?? ''))?.[0] ?? '';
        const protocol = publicOrigin ? new URL(publicOrigin).protocol : 'https:';
        res.writeHead(301, { location: `${protocol}//${moved}${port}${req.url}`, 'cache-control': 'no-store' }).end();
        return;
      }
      const home = intent && appHome(mount, intent.app);
      if (home && home !== '/' && req.url?.split('?')[0] === '/') {
        res.writeHead(302, { location: home, 'cache-control': 'no-store' }).end();
        return;
      }
      const dispatch = async (entered = false) => {
        if (res.destroyed || res.writableEnded) return;
        if (stopping) {
          res.writeHead(503).end('The suite is stopping.');
          return;
        }
        const host = customTarget(req);
        if (!host) {
          res.writeHead(404).end('No App at this address.');
          return;
        }
        // The bare root's entry has already judged this account against the root App.
        const gated = intent || entered ? undefined : identity?.gate?.(req, host.id);
        if (gated) {
          const destination = await gated;
          if (res.destroyed || res.writableEnded) return;
          if (stopping) {
            res.writeHead(503).end('The suite is stopping.');
            return;
          }
          if (destination !== undefined) {
            res.writeHead(302, { location: destination, 'cache-control': 'no-store' }).end();
            return;
          }
        }
        const control = flags?.route(host.id, req, res);
        if (control) {
          await control.catch(() => {
            if (!res.headersSent) res.writeHead(503, { 'cache-control': 'no-store' }).end('Flag controls are unavailable.');
            else res.destroy();
          });
          return;
        }
        if (await host.publicPlacementRoute?.(req, res)) return;
        if (res.destroyed || res.writableEnded) return;
        if (stopping) {
          res.writeHead(503).end('The suite is stopping.');
          return;
        }
        // Child owners track their own accepted operations after this dispatch.
        host.server.emit('request', req, res);
      };
      // A host sign-in's addresses, ahead of the Console, the identity routes and the App: on a mapped host only its own
      // App's three, on the deployment's own host the staff leg of each tenant App's.
      const signIn = hostSignInRoute(req, intent);
      let operation: Promise<void> | undefined = signIn ? signIn.host.hostSignIn!(req, res, signIn.route) : undefined;
      operation ??= flags?.routeConsole(req, res) ?? (intent ? undefined : identity?.route(req, res));
      const bareRoot =
        (req.method === 'GET' || req.method === 'HEAD') && [mount.base, `${mount.base}/`].includes(req.url?.split('?')[0] ?? '/');
      if (!operation && !intent && bareRoot) {
        const entry = identity?.entry?.(req, async (appId, accountId) => {
          const scopes = hosts.get(appId)?.flagScopes;
          return scopes ? (await scopes(req, accountId)).length : 0;
        });
        if (entry)
          operation = entry.then((destination) => {
            if (res.destroyed || res.writableEnded) return;
            if (stopping) {
              res.writeHead(503).end('The suite is stopping.');
              return;
            }
            if (destination !== undefined) res.writeHead(302, { location: destination, 'cache-control': 'no-store' }).end();
            else return dispatch(true);
          });
      }
      operation ??= dispatch();
      if (operation) {
        req.once('error', () => {});
        identityBodies.add(req);
        const held = operation.catch(() => {
          if (!res.headersSent)
            res
              .writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              .end(JSON.stringify({ error: 'The suite is unavailable.', outcome: 'unknown' }));
          else res.destroy();
        });
        identityRequests.add(held);
        void held.then(() => {
          identityRequests.delete(held);
          identityBodies.delete(req);
        });
        return;
      }
    },
  );
  server.on('upgrade', (req, socket, head) => {
    if (stopping || !hostRouter.accept(req)) {
      socket.destroy();
      return;
    }
    // Host mappings grant only a public HTTP surface, never a private App
    // socket (even when a valid staff session cookie accompanies the upgrade).
    if (getTenantHostIntent(req)) {
      socket.destroy();
      return;
    }
    // Vite attaches its own upgrade listener lazily to this shared server.
    // Its transport is suite-wide, never a child App's authenticated socket.
    const protocol = req.headers['sec-websocket-protocol'];
    if (protocol === 'vite-hmr' || protocol === 'vite-ping') {
      let path: string;
      try {
        path = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (
        SOURCE_CLIENT &&
        (path === '/' || [...hosts.keys()].some((id) => path === `${appHome(mount, id).replace(/\/$/, '')}/`)) &&
        server.listenerCount('upgrade') > 1
      )
        return;
      socket.destroy();
      return;
    }
    const host = customTarget(req);
    if (!host || !host.server.emit('upgrade', req, socket, head)) socket.destroy();
  });
  /* Outermost, so a request's timing covers every listener above (serverTiming.ts); nothing when off. */
  timeRequests(server);
  applyServerTimeouts(server);
  let recheckTimer: NodeJS.Timeout | undefined;
  const recheckDomains = async (dueAfterMs = DOMAIN_CHECK_DUE_MS) => {
    for (const host of hosts.values()) {
      if (!host.domains || stopping) continue;
      try {
        const { suspended, live, expired } = await host.domains.recheckDue(dueAfterMs);
        for (const each of expired)
          console.warn(
            `mistri: the custom domain ${each.host} of tenant "${each.tenantId}" (${host.id}) was never verified and was dropped after ${PENDING_DOMAIN_DAYS} days.`,
          );
        for (const each of suspended)
          console.warn(
            `mistri: the custom domain ${each.host} of tenant "${each.tenantId}" (${host.id}) failed its DNS check ${SUSPEND_AFTER} times in 72 hours and is suspended; it serves again once a check passes.`,
          );
        for (const each of live)
          console.warn(
            `mistri: the custom domain ${each.host} of tenant "${each.tenantId}" (${host.id}) is live${each.from === 'suspended' ? ' again: its DNS records pass the check' : ''}.`,
          );
      } catch (error) {
        console.warn(`mistri: the custom domains of "${host.id}" could not be checked. ${(error as Error).message.split('\n')[0]}`);
      }
    }
  };
  const close = () => {
    stopping = true;
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = undefined;
    hostRouter.close();
    const flagDrain = flags?.close();
    void flagDrain?.catch(() => {});
    return (closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = async (work: () => Promise<void>) => {
        try {
          await work();
        } catch (error) {
          errors.push(error);
        }
      };
      // Stop admissions immediately, but keep stores alive until accepted HTTP
      // requests and each child's own operation leases have drained.
      for (const request of identityBodies) if (!request.complete) request.destroy(new Error('The suite is stopping.'));
      const drained = server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        : Promise.resolve();
      await attempt(() => closeDevClientHmr(server));
      // Native session and membership owners remain live until flag bodies,
      // reads and commit guards have settled and the one store is closed.
      await attempt(async () => {
        await flagDrain;
      });
      await Promise.all([...hosts.values()].map((host) => attempt(host.stop)));
      await attempt(() => drained);
      await Promise.allSettled([...identityRequests]);
      for (const host of [...hosts.values()].reverse()) await attempt(host.close);
      await attempt(async () => {
        identity?.close();
      });
      await attempt(() => retireDevClient(server));
      if (errors.length) throw new AggregateError(errors, 'Suite cleanup failed.');
    }));
  };
  if (SOURCE_CLIENT) attachDevClient(server);
  try {
    for (const app of apps) {
      const host = await app.open(appHome(mount, app.id).replace(/\/$/, ''), {
        allowedHosts: hostRouter.listedHosts(app.id),
        ...(tableHosts
          ? {
              allowsHost: (host: string) => hostRouter.allows(app.id, host),
              primaryHost: (tenant: string) => hostRouter.primaryHost(app.id, tenant),
            }
          : {}),
        hostIntent: (host: string) => hostRouter.intentFor(app.id, host),
        platformHost: (host: string) => hostRouter.platformHost(host),
        suiteBase: mount.base,
        // Its tenants' own hosts, where their capability links are written (tenantAuthenticatedHttp.ts linkBase).
        hosts: mappings.filter((intent) => intent.app === app.id),
        ...(domainsFor ? { domains: domainsFor } : {}),
      });
      hosts.set(app.id, { ...host, id: app.id });
      if (host.server.listening) throw new Error(`Suite App "${app.id}" must not own a listener.`);
      if (tableHosts && host.tenantHosts) {
        const mapped = mappings.filter((intent) => intent.app === app.id);
        // The configuration's hosts become rows too, so the CLI lists them; a store that cannot take them is said, not fatal: they still serve.
        if (mapped.length)
          await host.tenantHosts
            .seed(mapped.map((intent) => ({ host: intent.host, tenantId: intent.tenant })))
            .catch((error: Error) =>
              console.warn(`mistri: the hosts of "${app.id}" could not be recorded in its tenant store. ${error.message.split('\n')[0]}`),
            );
        await hostRouter.register(app.id, host.tenantHosts);
      }
    }
    hostRouter.start();
    if (flagOptions) {
      flags = await openSuiteFlags(flagOptions, hosts, mount);
      for (const host of hosts.values()) {
        const stop = host.stop,
          close = host.close;
        host.stop = async () => {
          await flags!.stopTarget(host.id);
          await stop();
        };
        host.close = async () => {
          await flags!.stopTarget(host.id);
          await close();
        };
      }
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Suite startup failed.');
    }
    throw error;
  }
  let starting: Promise<void> | undefined;
  const start = () => {
    if (stopping || !server.listening) return Promise.reject(new Error('The suite must be listening before its background owners start.'));
    return (starting ??= Promise.resolve().then(async () => {
      try {
        for (const host of hosts.values()) {
          if (stopping) throw new Error('The suite stopped during background startup.');
          await host.start?.();
        }
        flags?.start();
        if (customDomains && !recheckTimer) {
          // Each domain is due a day after its last check; the hourly tick finds the due ones, across restarts too.
          const tick = () => void recheckDomains();
          tick();
          recheckTimer = setInterval(tick, DOMAIN_CHECK_TICK_MS);
          recheckTimer.unref();
        }
      } catch (error) {
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Suite background startup failed.');
        }
        throw error;
      }
    }));
  };
  return { server, mount, ...(flags ? { flags } : {}), refreshHosts: hostRouter.refresh, recheckDomains, start, close };
}
