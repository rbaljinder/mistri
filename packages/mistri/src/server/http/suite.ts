/** One listener for independently configured App servers. Each child keeps
 * its registry, policy and authentication gate; requests are never proxied or
 * rewritten here. Children must be configured with their public base path. */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
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
import { SOURCE_CLIENT, attachDevClient, closeDevClientHmr, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import {
  createTenantHostRouter,
  getTenantHostIntent,
  normalizeSuitePublicOrigin,
  validateTenantHosts,
  type TenantHostIntent,
} from './tenantHosts.js';
import type { SuiteLinkHost } from '../auth/suiteLinkHttp.js';
import type { FlagAuthorityOptions } from '../flags/authority.js';
import { openSuiteFlags, type SuiteFlags, type SuiteFlagsOptions } from './suiteFlags.js';

export interface SuiteHost {
  id: string;
  /** An unbound server, configured with the base path supplied to its factory. */
  server: Server;
  /** Trusted child capability, after Host/App admission and before sessions or mount stripping. */
  publicPlacementRoute?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Route metadata and access owners retained by this child, never authority in a URL. */
  links?: SuiteLinkHost;
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
    open: (basePath: string, options: { allowedHosts: readonly string[] }) => Promise<Omit<SuiteHost, 'id'>>;
  }>,
  addresses: { base?: string; mounts?: Readonly<Record<string, string>>; publicOrigin?: string; hosts?: readonly TenantHostIntent[] } = {},
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
): Promise<{ server: Server; mount: AddressMount; flags?: SuiteFlags; start: () => Promise<void>; close: () => Promise<void> }> {
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
  const hostRouter = createTenantHostRouter(mappings, publicOrigin);
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
  const server = createServer((req, res) => {
    if (stopping) {
      res.writeHead(503).end('The suite is stopping.');
      return;
    }
    if (!hostRouter.accept(req)) {
      res.writeHead(403).end('Invalid host.');
      return;
    }
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
    let operation = flags?.routeConsole(req, res) ?? (intent ? undefined : identity?.route(req, res));
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
  });
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
  applyServerTimeouts(server);
  const close = () => {
    stopping = true;
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
      const host = await app.open(appHome(mount, app.id).replace(/\/$/, ''), { allowedHosts: hostRouter.allowedHosts(app.id) });
      hosts.set(app.id, { ...host, id: app.id });
      if (host.server.listening) throw new Error(`Suite App "${app.id}" must not own a listener.`);
    }
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
  return { server, mount, ...(flags ? { flags } : {}), start, close };
}
