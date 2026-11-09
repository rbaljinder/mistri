/**
 * A front end's server with mistri mounted in it as a back end only: the handler answers mistri's requests under
 * `/api/mistri` (createHandler, with the App's commands), and every other address is the front end's own page
 * (./embed-headless-host), which draws the App's rows with its own elements through @mistriwork/mistri/react/headless.
 * Served from source through Vite's middleware, as embedReactHost.ts serves its page. What
 * e2e/embed-headless.spec.ts walks.
 *
 * Arguments: the config file, the port (0 asks the OS), the App's directory (its surfaces/ are read from it), and its
 * commands module.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createHandler } from '../../packages/mistri/src/server/handler.ts';
import { embedPlugins } from '../../config/vite.embed.config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const PAGE = join(HERE, 'embed-headless-host');
const [config, requested, app, commands] = process.argv.slice(2);

/* Listen first and read the port the OS gave (embedReactHost.ts says why); 503 until the handler and page are ready. */
let ready = false;
const server = createServer((req, res) => (ready ? handle(req, res) : void res.writeHead(503).end()));
await new Promise<void>((done) => server.listen(Number(requested), '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

const mistri = createHandler({ config, basePath: '/api/mistri', publicOrigin: origin, app, commands });
const vite = await createVite({
  configFile: false,
  root: PAGE,
  cacheDir: join(dirname(config), 'vite'),
  appType: 'custom',
  logLevel: 'warn',
  plugins: embedPlugins(),
  server: { middlewareMode: true, hmr: false, ws: { server }, fs: { allow: [REPO] } },
});

const ours = (url: string) => url === '/api/mistri' || url.startsWith('/api/mistri/') || url.startsWith('/api/mistri?');

const handle = (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  if (ours(url)) return void mistri.node(req, res);
  vite.middlewares(req, res, async () => {
    if (req.method !== 'GET') return void res.writeHead(404).end();
    const html = await vite.transformIndexHtml(url, readFileSync(join(PAGE, 'index.html'), 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
};

await mistri.ready;
await vite.warmupRequest('/main.tsx');
await vite.waitForRequestsIdle();
ready = true;
console.log(`Host listening on ${port}`);

process.once('SIGTERM', async () => {
  await Promise.all([mistri.close(), vite.close()]);
  server.close(() => process.exit(0));
});
