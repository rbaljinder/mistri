import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './support/harness';
import { openShot, shotContext } from '../packages/mistri/src/server/build/shot';

/**
 * A page of an App with live sync holds `/api/live` open for as long as it is shown, so Playwright's `networkidle`
 * never came and `mistri grade` (which opens every page as shot does) timed out on its first page. `openShot` waits
 * for the page's own requests instead, less the two streams. The server is this test's own, on a free port.
 */
let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/api/live') {
      // Never ended, as the live stream is.
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': open\n\n');
      return;
    }
    if (request.url === '/api/rows') {
      setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end('["late"]'), 700);
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<!doctype html><title>live</title><main id="m">loading</main><script>' +
          'new EventSource("/api/live");' +
          'fetch("/api/rows").then((r) => r.json()).then((rows) => { document.getElementById("m").textContent = rows[0]; });' +
          '</script>',
      );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

test('a page that holds a live stream open settles, after its other requests', async ({ browser }) => {
  const context = await shotContext(browser, origin, { viewport: { width: 1280, height: 800 }, dark: false });
  try {
    const page = await context.newPage();
    const started = Date.now();
    const status = await openShot(page, origin, '/');
    expect(status).toBe(200);
    // The slow fetch was waited for; the stream was not.
    await expect(page.locator('#m')).toHaveText('late', { timeout: 100 });
    expect(Date.now() - started).toBeLessThan(15_000);
  } finally {
    await context.close();
  }
});
