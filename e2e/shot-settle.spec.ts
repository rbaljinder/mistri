import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './support/harness';
import { openShot } from '../packages/mistri/src/server/build/shot';

/**
 * TC12: shot (and grade, which opens each page the same way) takes a page once it has settled — not mid-reload.
 * A page that loads itself again a moment after its first paint, as a dev server does when it finds a dependency,
 * or that asks for its content again and redraws in place, as an App does when its theme file is saved, was taken
 * as the first document stood, or blank between the two.
 *
 * A plain server of its own on a free port (listen(0)): each page says which document it is in data-state.
 */
let server: Server;
let origin = '';
/* Late enough that a capture which waited only for the first idle network (half a second) and a moment more
   had already been taken; early enough to fall in the stillness a settled page now keeps after it. */
const AFTER_MS = 880;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/late') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('redrawn');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      request.url === '/reload'
        ? `<!doctype html><body data-state="first"><script>
            if (sessionStorage.getItem('again')) document.body.dataset.state = 'again';
            else addEventListener('load', () => setTimeout(() => { sessionStorage.setItem('again', '1'); location.reload(); }, ${AFTER_MS}));
          </script></body>`
        : `<!doctype html><body data-state="first"><script>
            addEventListener('load', () => setTimeout(() => fetch('/late').then((r) => r.text()).then((text) => { document.body.dataset.state = text; }), ${AFTER_MS}));
          </script></body>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

test('a page that loads itself again after its first paint is taken in the document it settles in', async ({ page }) => {
  await openShot(page, origin, '/reload');
  // Read at once, as the capture reads it: the second document, whole.
  expect(await page.evaluate(() => document.body.dataset.state)).toBe('again');
});

test('a page that asks for its content again and redraws in place is taken redrawn', async ({ page }) => {
  await openShot(page, origin, '/redraw');
  expect(await page.evaluate(() => document.body.dataset.state)).toBe('redrawn');
});
