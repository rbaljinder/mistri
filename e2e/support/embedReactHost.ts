/**
 * A React app's server with tablewalk mounted in it: the handler answers
 * tablewalk's requests under `/api/mistri` (createHandler), and every
 * other address is the host's own page, a React app (./embed-react-host)
 * that shows Compass at `/crm` through @mistriwork/mistri/react. The host's page is
 * served from source through Vite's middleware with the embed's plugins
 * (config/vite.embed.config.ts `embedPlugins`), as every suite serves the client:
 * nothing is built first. What e2e/embed-react.spec.ts walks.
 *
 * Arguments: the config file, the port, and the App (Compass when absent).
 * With `PORTAL_EMBED_SECRET` set, the host also signs people in the way a
 * host does (e2e/embed-react-signin.spec.ts): `POST /host/assertion` mints a
 * minute-long statement that its person is Rita, for the page to hand the
 * Provider's `auth.assertion`, as the issuer "portal" in the config file.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createHandler, mintEmbedAssertion } from '../../packages/mistri/src/server/handler.ts';
import { embedPlugins } from '../../config/vite.embed.config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const PAGE = join(HERE, 'embed-react-host');
const [config, requested, app = 'test/fixtures/apps/crm'] = process.argv.slice(2);

/* Port 0 asks the OS: the server listens first and the origin is read from what it was given, so no number is chosen,
   released and bound again (a gap in which a parallel spec's server can take it). A number is still honoured.
   Until the handler and the warmed page are ready a request is answered 503, not dispatched to a handler not yet defined. */
let ready = false;
const server = createServer((req, res) => (ready ? handle(req, res) : void res.writeHead(503).end()));
await new Promise<void>((done) => server.listen(Number(requested), '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

const mistri = createHandler({ config, basePath: '/api/mistri', publicOrigin: origin, app });
const SECRET = process.env.PORTAL_EMBED_SECRET;
const vite = await createVite({
  configFile: false,
  root: PAGE,
  /* One optimizer directory per run, beside the run's database: concurrent Vites must not share one (devclient.ts). */
  cacheDir: join(dirname(config), 'vite'),
  appType: 'custom',
  logLevel: 'warn',
  plugins: embedPlugins(),
  server: { middlewareMode: true, hmr: false, fs: { allow: [REPO] } },
});

const ours = (url: string) => url === '/api/mistri' || url.startsWith('/api/mistri/') || url.startsWith('/api/mistri?');

const handle = (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  if (ours(url)) return void mistri.node(req, res);
  if (SECRET && url === '/host/assertion' && req.method === 'POST') {
    /* The host's own server, which knows who is signed in to it: a statement for this page's origin, never the key. */
    const said = mintEmbedAssertion({
      issuer: 'https://portal.example',
      key: SECRET,
      app: 'compass',
      origin,
      subject: 'rita',
      email: 'rita@portal.example',
    });
    return void said.then((assertion) => res.writeHead(200, { 'content-type': 'text/plain' }).end(assertion));
  }
  vite.middlewares(req, res, async () => {
    /* Not a module Vite serves: an address of the host's app, which is its one page. */
    if (req.method !== 'GET') return void res.writeHead(404).end();
    const html = await vite.transformIndexHtml(url, readFileSync(join(PAGE, 'index.html'), 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
};

await mistri.ready;
/* Compile the host's page and find its dependencies before anyone visits. Found on a first visit under load, the
   optimizer re-bundles mid-page and the page's imports answer 504 "Outdated Optimize Dep" (the dev server has no
   socket to tell it to reload: hmr is off), which fails whichever test happened to be first. */
await vite.warmupRequest('/main.tsx');
await vite.waitForRequestsIdle();
ready = true;
console.log(`Host listening on ${port}`);

process.once('SIGTERM', async () => {
  await Promise.all([mistri.close(), vite.close()]);
  server.close(() => process.exit(0));
});
