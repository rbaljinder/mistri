/**
 * The cooking school's own server: one Node `http` server, one port, three owners of its addresses.
 *
 *   /api/tw/…        the Ladle App (createHandler from @mistriwork/mistri/handler): its API, sign-in and files
 *   /schedule.json   the host's own JSON (schedule.ts), code of the school's and no part of mistri
 *   everything else  the school's React site (index.html, main.tsx), which shows the App for staff under /staff
 *
 * The page is served through Vite's middleware, as a React app in development is; a production host builds it with
 * its own bundler and serves the files. Run it from the repository root (README.md):
 *
 *   npx tsx examples/apps/ladle/host/server.ts <config.json> [port]
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer as createVite, type InlineConfig } from 'vite';
import { createHandler } from '@mistriwork/mistri/handler';
import { scheduleRoute } from './schedule.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where the handler is mounted: under the host's API, never one of mistri's own paths (`/api` alone). */
export const MOUNT = '/api/tw';

export interface HostOptions {
  /** The mistri config file: the `ladle` connection, as the seed writes it. */
  config: string;
  port: number;
  /** The origin browsers use; `http://127.0.0.1:<port>` by default. */
  publicOrigin?: string;
  /** Vite's plugins and resolution for the page, in place of the defaults (React, and `@mistriwork/mistri/react` from the package). */
  vite?: Pick<InlineConfig, 'plugins' | 'resolve'>;
}

const ours = (url: string) => url === MOUNT || url.startsWith(`${MOUNT}/`) || url.startsWith(`${MOUNT}?`);

/** The database the `ladle` connection names, which the schedule reads with a driver of its own. */
function databaseOf(config: string): string {
  const { connections } = JSON.parse(readFileSync(config, 'utf8')) as { connections: Array<{ name: string; url: string }> };
  const ladle = connections.find((connection) => connection.name === 'ladle');
  if (!ladle) throw new Error(`${config} names no "ladle" connection.`);
  return resolve(dirname(config), ladle.url);
}

export async function startHost(options: HostOptions): Promise<{ server: Server; origin: string; close(): Promise<void> }> {
  const origin = options.publicOrigin ?? `http://127.0.0.1:${options.port}`;
  const tw = createHandler({ config: options.config, basePath: MOUNT, publicOrigin: origin, app: resolve(HERE, '..') });
  const schedule = scheduleRoute(databaseOf(options.config));
  const vite = await createVite({
    configFile: false,
    root: HERE,
    /* The optimizer's cache beside the config, not in the App directory the server watches. */
    cacheDir: join(dirname(resolve(options.config)), '.vite'),
    appType: 'custom',
    logLevel: 'warn',
    plugins: options.vite?.plugins ?? [react()],
    resolve: options.vite?.resolve ?? { dedupe: ['react', 'react-dom'] },
    server: { middlewareMode: true, hmr: false },
  });

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (ours(url)) return void tw.node(req, res);
    if (url === '/schedule.json' || url.startsWith('/schedule.json?')) return schedule(req, res);
    vite.middlewares(req, res, async () => {
      /* Not a module Vite serves: an address of the site, which is its one page. */
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(404).end();
      const html = await vite.transformIndexHtml(url, readFileSync(join(HERE, 'index.html'), 'utf8'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
  });

  await tw.ready;
  await new Promise<void>((done) => server.listen(options.port, '127.0.0.1', done));
  return {
    server,
    origin,
    async close() {
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await Promise.all([tw.close(), vite.close()]);
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [config, port = '4620'] = process.argv.slice(2);
  if (!config) throw new Error('Usage: npx tsx examples/apps/ladle/host/server.ts <config.json> [port]');
  const host = await startHost({ config, port: Number(port) });
  console.log(`Ladle Cooking School on ${host.origin} (staff at ${host.origin}/staff)`);
  process.once('SIGTERM', () => void host.close().then(() => process.exit(0)));
  process.once('SIGINT', () => void host.close().then(() => process.exit(0)));
}
