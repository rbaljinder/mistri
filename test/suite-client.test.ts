/** The actual source renderer behind suite dispatch, without a browser or database. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';

test('source suite pages and module graphs use their mount, retaining host and HMR fences', { timeout: 60_000 }, async (t) => {
  const suite = await createSuite(
    ['main', 'other'].map((id) => ({
      id,
      public: true,
      open: async (basePath: string, { allowedHosts }: { allowedHosts: readonly string[] }) =>
        openSuiteApp({
          app: {
            path: 'source-client-test',
            sources: {},
            pages: [],
            app: parseAppConfig(
              { id, name: id, resources: { unused: {} }, views: { home: { kind: 'list', from: 'unused' } }, home: 'home' },
              'source client fixture',
            ),
          },
          registry: new Registry(),
          basePath,
          publicURL: 'http://localhost:4111',
          environment: {},
          bound: { host: '127.0.0.1', port: 0, allowedHosts },
        }),
    })),
    {
      base: '/tools',
      mounts: { main: '', other: 'desk' },
      publicOrigin: 'https://staff.example',
      hosts: [{ host: 'public.example', app: 'other', tenant: 'opaque' }],
    },
  );
  t.after(() => suite.close());
  await new Promise<void>((resolve) => suite.server.listen(0, '127.0.0.1', resolve));
  const port = (suite.server.address() as { port: number }).port;
  const read = (path: string, host = 'staff.example') =>
    new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path, headers: { host, ...(path.endsWith('.css') ? { accept: 'text/css' } : {}) } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), text }));
        },
      );
      req.setTimeout(30_000, () => req.destroy(new Error('Source client request timed out.')));
      req.on('error', reject);
      req.end();
    });
  for (const base of ['/tools/desk', '/tools']) {
    const page = await read(`${base}/home`);
    assert.equal(page.status, 200, page.text);
    for (const asset of ['/@vite/client', '/boot.js', '/style.css']) {
      assert.ok(page.text.includes(`"${base}${asset}"`), `${base} HTML must mount ${asset}`);
      const file = await read(`${base}${asset}`);
      assert.equal(file.status, 200, file.text);
      assert.match(file.type, asset.endsWith('.css') ? /text\/css/ : /javascript/);
      if (asset === '/boot.js') {
        assert.ok(file.text.includes(`"${base}/shellStart.js"`), 'transformed imports stay mounted');
        const imported = await read(`${base}/shellStart.js`);
        assert.equal(imported.status, 200);
        assert.match(imported.type, /javascript/);
      }
    }
    assert.ok(page.text.includes(`"${base}/@react-refresh"`), 'React refresh preamble stays mounted');
    const shared = await read(`${base}/addressMount.js`);
    assert.equal(shared.status, 200);
    const outside = /["']([^"']*\/@fs\/[^"']+)["']/.exec(shared.text)?.[1];
    assert.ok(outside && outside.startsWith(`${base}/@fs/`), 'shared TypeScript imports stay mounted');
    const dependency = await read(outside);
    assert.equal(dependency.status, 200);
    assert.match(dependency.type, /javascript/);
  }
  assert.equal((await read('/boot.js')).status, 404, 'no root asset escape outside the suite base');
  assert.equal((await read('/tools/desk/boot.js', 'unknown.example')).status, 403);
  assert.equal((await read('/tools/boot.js', 'public.example')).status, 404);
  const publicAsset = await read('/tools/desk/boot.js', 'public.example');
  assert.equal(publicAsset.status, 200);
  assert.match(publicAsset.type, /javascript/);
  assert.equal((await read('/tools/desk/api/auth/session', 'public.example')).status, 404);

  const ping = (path: string, host = 'staff.example') =>
    new Promise<void>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path,
        headers: {
          host,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-protocol': 'vite-ping',
        },
      });
      req.setTimeout(5000, () => req.destroy(new Error('HMR ping timed out.')));
      req.on('error', reject);
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve();
      });
      req.end();
    });
  await ping('/tools/desk/');
  await ping('/tools/');
  await assert.rejects(ping('/tools/desk/wrong'), /socket hang up/);
  await assert.rejects(ping('/tools/desk/', 'public.example'), /socket hang up/);
  await assert.rejects(ping('/tools/desk/', 'unknown.example'), /socket hang up/);
});
