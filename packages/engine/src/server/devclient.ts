/**
 * The client, served from source.
 *
 * The published package serves dist/client, which `vite build` wrote at
 * publish time, and never reaches this file's import. Under tsx — `npm run
 * dev`, `npm start`, every test suite — the client directory is the source
 * tree, and since the source imports the TypeScript under src/shared it
 * cannot go to a browser as it is. So the server hands static requests to
 * Vite in middleware mode: each module is transformed on request, an edit
 * reloads the page, and nothing has to be built first.
 *
 * The signal is the file this module was loaded from. `.ts` means tsx, and
 * source; `.js` means the build, and dist/client. It is not the presence of
 * a `src` directory in the path, which a user's install could have.
 */
import type { EventEmitter } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { product } from './product.js';

export const FROM_SOURCE = import.meta.url.endsWith('.ts');

/**
 * The page a product's server sends: the folder Vite serves from source (its index.html), the one the build left,
 * and the workspace whose vite.config.ts, dependency cache and files Vite may use. The kit owns the page and says
 * where it is (@mistriwork/kit/clientFiles.js); the engine serves whatever it is handed.
 */
export interface ClientFiles {
  source: string;
  built: string;
  workspace: string;
}

/** Whether the client is served through Vite. Source by default; the browser
 * suite sets MISTRI_BUILT_CLIENT=1 so a server under tsx sends dist/client,
 * which one `npm run build` made, instead of each server owning a Vite. Only
 * the client's serving reads this — the rest of what FROM_SOURCE decides (the
 * component SDK's exports, the console's components, the observer) stays on
 * source, since those files sit beside the sources and not beside the build. */
export const SOURCE_CLIENT = FROM_SOURCE && process.env.MISTRI_BUILT_CLIENT !== '1';

interface Vite {
  middlewares: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
  transformIndexHtml(url: string, html: string): Promise<string>;
  /** A client module run on the server: the public pages' renderer (publicRender.ts). */
  ssrLoadModule?(url: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  closeHmr(): Promise<void>;
  /** The hot-reload socket Vite's client falls back to (`devSocket`), for the page's connect-src. */
  readonly socket?: string;
}

/* The addresses Vite's own hostname rule (resolveHostname) reads as "any": its client is told `localhost` for them. */
const ANY_HOST = new Set(['0.0.0.0', '::', '0000:0000:0000:0000:0000:0000:0000:0000']);

/**
 * The socket Vite's client opens when its first, on the page's own origin,
 * fails: `__HMR_DIRECT_TARGET__`, which Vite writes into `/@vite/client` from
 * the same configuration, read here by the same rule. Where the page's origin
 * carries the socket (a server tablewalk listens on, attachDevClient) the
 * first one opens and `'self'` admits it. Where it does not — an App mounted
 * in a host's server (embed/handler.ts), whose server never listens and whose
 * host does not pass an upgrade on — the client tries this one, and a policy
 * of `'self'` alone refused it. Without a protocol configured the client uses
 * the page's, so both are named for the one host, port and path.
 */
export function devSocket(config: Pick<ViteDevServer['config'], 'base' | 'server'>): string {
  const ws = typeof config.server.ws === 'object' && config.server.ws ? config.server.ws : undefined;
  const asked = config.server.host;
  const hostname = ws?.host || (typeof asked === 'string' && !ANY_HOST.has(asked) ? asked : 'localhost');
  const target = `${hostname}:${ws?.port || config.server.port}${config.base}`;
  return (ws?.protocol ? [ws.protocol] : ['ws', 'wss']).map((protocol) => `${protocol}://${target}`).join(' ');
}

/** A retired source host never reactivates its dependency watcher. */
export function ownDevClient(
  created: Pick<ViteDevServer, 'watcher' | 'middlewares' | 'transformIndexHtml' | 'close'> & {
    ws?: Pick<ViteDevServer['ws'], 'close'>;
    ssrLoadModule?: ViteDevServer['ssrLoadModule'];
    config?: Pick<ViteDevServer['config'], 'base' | 'server'>;
  },
  afterClose?: () => Promise<void>,
): Vite {
  // Vite closes its watcher and environments concurrently. A finishing
  // transform can still add an outside-root dependency; Chokidar.add resets
  // its closed flag and can resurrect that retired watcher.
  let retired = false,
    closing: Promise<void> | undefined;
  let hmrClosing: Promise<void> | undefined;
  // Provider.close also closes its socket server. Share that same close with
  // the earlier HTTP-drain step; native socket close is not repeatable.
  if (created.ws) {
    const closeSockets = created.ws.close.bind(created.ws);
    created.ws.close = () => (hmrClosing ??= Promise.resolve().then(closeSockets));
  }
  const watched = new WeakSet<ViteDevServer['watcher']>();
  const fence = () => {
    const watcher = created.watcher;
    if (watched.has(watcher)) return;
    watched.add(watcher);
    let closed = false;
    const add = watcher.add.bind(watcher),
      close = watcher.close.bind(watcher);
    watcher.add = (...paths) => (retired || closed ? watcher : add(...paths));
    watcher.close = () => {
      closed = true;
      return close();
    };
  };
  fence();
  return {
    get middlewares() {
      fence();
      return created.middlewares;
    },
    transformIndexHtml: (url, html) => {
      fence();
      return created.transformIndexHtml(url, html);
    },
    ...(created.ssrLoadModule
      ? {
          ssrLoadModule: (url: string) => {
            fence();
            return created.ssrLoadModule!(url);
          },
        }
      : {}),
    closeHmr: () => created.ws?.close() ?? Promise.resolve(),
    ...(created.config ? { socket: devSocket(created.config) } : {}),
    close: () => {
      retired = true;
      fence();
      if (closing) return closing;
      try {
        closing = Promise.resolve(created.close());
      } catch (error) {
        closing = Promise.reject(error);
      }
      return (closing = closing.finally(afterClose));
    },
  };
}

/* The servers whose pages are being served, and one Vite per base path in
   front of them. The unit suites open several servers in one process — a
   trusted one and a proxied one, a server per connection under test — and
   close them in whatever order the tests end. Vite goes when the last one
   goes, and comes back if another opens. */
/** Shared middleware providers, with their HMR sockets owned by one HTTP
 * server. A late factory belongs to its captured generation, never a restart. */
export function createDevClientHosts() {
  const live = new Set<Server>();
  const hmrStopped = new WeakSet<Server>();
  const retired = new WeakMap<Server, Promise<void>>();
  type Generation = { owner: Server; closed: boolean; value: Promise<Vite>; closing?: Promise<void>; hmrClosing?: Promise<void> };
  const current = new Map<string, Generation>();
  const close = (generation: Generation, provider: Vite) => (generation.closing ??= Promise.resolve().then(() => provider.close()));
  const closeHmr = (generation: Generation, provider: Vite) =>
    (generation.hmrClosing ??= Promise.resolve().then(() => provider.closeHmr()));
  return {
    attach(server: Server) {
      if (retired.has(server)) throw new Error('The source client owner was retired.');
      live.add(server);
    },
    async closeHmr(server: Server): Promise<void> {
      hmrStopped.add(server);
      await Promise.all(
        [...current.values()].map(async (generation) => {
          if (generation.owner !== server) return;
          let provider: Vite;
          try {
            provider = await generation.value;
          } catch {
            return;
          }
          await closeHmr(generation, provider);
        }),
      );
    },
    retire(server: Server): Promise<void> {
      const pending = retired.get(server);
      if (pending) return pending;
      live.delete(server);
      const generations = [...current.values()];
      if (!live.size) {
        for (const generation of generations) generation.closed = true;
        current.clear();
      }
      // Register before provider close callbacks can reenter retirement.
      const work = Promise.resolve().then(async () => {
        await Promise.all(
          generations.map(async (generation) => {
            // Acquisition failure has no provider to retire. Its own factory
            // closes a successfully created but retired generation before refusing.
            let provider: Vite;
            try {
              provider = await generation.value;
            } catch {
              await generation.closing;
              await generation.hmrClosing;
              return;
            }
            if (generation.closed) await close(generation, provider);
            else if (generation.owner === server) await closeHmr(generation, provider);
          }),
        );
      });
      retired.set(server, work);
      return work;
    },
    get(load: (owner: Server | undefined) => Promise<Vite>, base = ''): Promise<Vite> {
      const owner = live.values().next().value;
      if (!owner) return Promise.reject(new Error('The source client owner was retired.'));
      if (!current.has(base)) {
        const generation: Generation = { owner, closed: false, value: undefined as unknown as Promise<Vite> };
        generation.value = Promise.resolve().then(async () => {
          if (generation.closed) throw new Error('The source client owner was retired.');
          const provider = await load(generation.owner);
          if (generation.closed) {
            await close(generation, provider);
            throw new Error('The source client owner was retired.');
          }
          if (!live.has(generation.owner) || hmrStopped.has(generation.owner)) await closeHmr(generation, provider);
          if (generation.closed) {
            await close(generation, provider);
            throw new Error('The source client owner was retired.');
          }
          return provider;
        });
        current.set(base, generation);
      }
      return current.get(base)!.value;
    },
  };
}
const hosts = createDevClientHosts();

/**
 * Told which server the pages are on, so hot reloads can share its port
 * rather than opening a second listener that two test servers would then
 * fight over — and so Vite, whose file watcher would keep a process alive,
 * is closed once every server that used it has closed.
 */
export function attachDevClient(server: Server): void {
  hosts.attach(server);
  server.once('close', () => {
    void retireDevClient(server).catch(() => {});
  });
}

/** Stop upgraded sockets before awaiting HTTP close, retaining the renderer
 * until accepted HTTP responses have drained. Does not create a provider. */
export function closeDevClientHmr(server: Server): Promise<void> {
  return hosts.closeHmr(server);
}

/** Release the source renderer after accepted HTTP responses have drained. */
export function retireDevClient(server: Server): Promise<void> {
  return hosts.retire(server);
}

/** One source Vite generation owns its optimizer directory. Vite replaces
 * optimizer metadata while discovering dependencies, so sharing a directory
 * between independent Node processes can make an in-flight page request refer
 * to a dependency hash another process has just retired.
 *
 * Each is named for the process that owns it, because a server that is
 * killed never runs its close: the browser suites and a day's scratch servers
 * left over a thousand of these, two gigabytes, under node_modules/.vite.
 * So the next one sweeps the directories whose process is gone, and a process
 * that exits takes its own. An unnamed one is from before this, and goes once
 * it is a day old. */
const STALE_UNNAMED_MS = 24 * 60 * 60 * 1000;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
export async function sweepDevCaches(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const owned = /^client-(\d+)-/.exec(name);
      if (owned ? Number(owned[1]) === process.pid || alive(Number(owned[1])) : !name.startsWith('client-')) return;
      const path = join(root, name);
      if (!owned) {
        const info = await stat(path).catch(() => undefined);
        if (!info || Date.now() - info.mtimeMs < STALE_UNNAMED_MS) return;
      }
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }),
  );
}

async function devCache(workspace: string) {
  const root = resolve(workspace, 'node_modules', '.vite');
  await mkdir(root, { recursive: true });
  await sweepDevCaches(root);
  const path = await mkdtemp(join(root, `client-${process.pid}-`));
  // Synchronous, because 'exit' runs no more turns of the loop.
  const onExit = () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* the next start sweeps it */
    }
  };
  process.once('exit', onExit);
  let removing: Promise<void> | undefined;
  // The optimizer can still be writing when its generation closes, and on
  // Linux that refuses the removal (ENOTEMPTY). A cache directory is not worth
  // failing a server's retirement over: retry, and failing that leave it to
  // the exit handler or the next start's sweep.
  return {
    path,
    remove: () =>
      (removing ??= rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).then(
        () => {
          process.off('exit', onExit);
        },
        () => {},
      )),
  };
}

/**
 * What Vite's file watcher may look at: the package whose client it serves,
 * and nothing outside it. Vite watches its root and adds every file it loads
 * from beyond it (src/shared, src/adapters, package.json) whatever its path,
 * and chokidar follows links and, for a path gone by the time it looks,
 * watches the nearest folder still there. Nothing bounded where that could
 * lead: on a CI runner a served App's watcher reached /run and stat-ed udev's
 * self-referring links (ELOOP). An App's own code never goes through this
 * Vite (its components are compiled by appComponents.ts), so everything an
 * edit can reload lives under the package root; the rest is ignored. Both
 * spellings of the root, since module ids are real paths.
 */
export function outsidePackage(packageRoot: string): (path: string) => boolean {
  const slashed = (path: string) => resolve(path).replaceAll('\\', '/').replace(/\/$/, '');
  let real = packageRoot;
  try {
    real = realpathSync(packageRoot);
  } catch {
    /* the resolved spelling is the only one */
  }
  const roots = [...new Set([slashed(packageRoot), slashed(real)])];
  return (path) => {
    const at = slashed(path);
    return !roots.some((root) => at === root || at.startsWith(`${root}/`));
  };
}

/**
 * A watcher error is not the server's: chokidar emits 'error' for a path it
 * cannot stat, and Vite listens for none, so the first one was an uncaught
 * exception that took every page down with it. Say it once and keep serving;
 * the watcher goes on with the paths it could read.
 */
export function quietWatcherErrors(
  watcher: Pick<EventEmitter, 'on'>,
  warn: (message: string) => void = (message) => console.error(`${product()}: ${message}`),
): void {
  let said = false;
  watcher.on('error', (error: unknown) => {
    if (said) return;
    said = true;
    const why = error instanceof Error ? error.message : String(error);
    warn(`the client's file watcher could not follow a path (${why}); pages are still served, and an edit there needs a reload by hand.`);
  });
}

/** The Vite dev server, created on the first static request and kept. */
export function devClient(files: Pick<ClientFiles, 'source' | 'workspace'>, base = ''): Promise<Vite> {
  return hosts.get(async (httpServer) => {
    const cache = await devCache(files.workspace);
    try {
      const { createServer } = await import('vite');
      const created = await createServer({
        configFile: join(files.workspace, 'vite.config.ts'),
        root: files.source,
        // Vite must own the prefix throughout its graph, not just in HTML:
        // imports, CSS URLs, React refresh and the HMR socket all use it.
        base: `${base}/`,
        cacheDir: cache.path,
        appType: 'custom',
        logLevel: 'warn',
        server: {
          middlewareMode: true,
          /* The Host and Origin defence in index.ts has already answered by
             the time a request reaches Vite; a second, looser check here
             would only refuse the hosts `--allowed-host` let through. */
          allowedHosts: true,
          ws: httpServer ? { server: httpServer } : false,
          watch: { ignored: [outsidePackage(files.workspace)] },
        },
      });
      quietWatcherErrors(created.watcher);
      const close = created.close.bind(created);
      created.close = async () => {
        // An HTTP module response can finish before Vite's speculative imports.
        // Closing the optimizer then strands import-analysis hooks waiting for
        // its dependency batch, and pluginContainer.close never resolves.
        await created.environments.client.waitForRequestsIdle();
        await close();
      };
      return ownDevClient(created, cache.remove);
    } catch (error) {
      await cache.remove().catch(() => {});
      throw error;
    }
  }, base);
}
