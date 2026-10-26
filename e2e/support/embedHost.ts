/**
 * A host server of someone else's, with tablewalk mounted in it: its own page
 * at `/`, and Compass under `/crm` through `createHandler`. What
 * e2e/embed-handler.spec.ts walks. Arguments: the config file and the port.
 */
import { createServer } from 'node:http';
import { createHandler } from '../../packages/mistri/src/server/handler.ts';

const [config, port] = process.argv.slice(2);
const tw = createHandler({
  config,
  basePath: '/crm',
  publicOrigin: `http://127.0.0.1:${port}`,
  app: 'test/fixtures/apps/crm',
});

const server = createServer((req, res) => {
  if (req.url === '/crm' || req.url?.startsWith('/crm/') || req.url?.startsWith('/crm?')) return tw.node(req, res);
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Host</title><h1>The host</h1><a href="/crm/leads">Leads</a>');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not the host’s');
});

await tw.ready;
server.listen(Number(port), '127.0.0.1', () => console.log(`Host listening on ${port}`));

process.once('SIGTERM', async () => {
  await tw.close();
  server.close(() => process.exit(0));
});
