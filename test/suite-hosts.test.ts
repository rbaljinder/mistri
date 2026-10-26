import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { getTenantHostIntent } from '../packages/mistri/src/server/http/tenantHosts.js';
import { hostRefusal } from '../packages/engine/src/server/http/trust.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function raw(port: number, host: string, path = '/', headers: string[] = []) {
  return new Promise<{ status: number; headers: string; body: string }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('HTTP test timed out.')));
    socket.on('error', reject);
    socket.on('data', (data) => {
      answer += data;
    });
    socket.on('end', () => {
      const split = answer.indexOf('\r\n\r\n');
      resolve({
        status: Number(/^HTTP\/1.1 (\d+)/.exec(answer)?.[1] ?? 0),
        headers: answer.slice(0, split),
        body: answer.slice(split + 4),
      });
    });
    socket.on('connect', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}Connection: close\r\n\r\n`,
      ),
    );
  });
}

test('custom hosts preserve mounted URLs, isolate Apps, and bypass all suite identity dispatch', async (t) => {
  let identityCalls = 0;
  const bindings: Record<string, readonly string[]> = {};
  const mappings = [
    { host: 'one.example', app: 'store', tenant: 'tenant:one' },
    { host: 'two.example', app: 'store', tenant: 'tenant:two' },
  ];
  const suite = await createSuite(
    ['staff', 'store', 'other'].map((id) => ({
      id,
      public: id === 'store',
      open: async (basePath: string, { allowedHosts }: { allowedHosts: readonly string[] }) => {
        bindings[id] = allowedHosts;
        return {
          server: createServer((req, res) => {
            if (hostRefusal(req, { host: '127.0.0.1', port: 4111, allowedHosts })) {
              res.writeHead(403).end();
              return;
            }
            const intent = getTenantHostIntent(req);
            if (intent) {
              assert.ok(Object.isFrozen(intent));
              req.headers['x-tenant-id'] = 'forged-after-admission';
              assert.equal(getTenantHostIntent(req), intent);
            }
            const body = JSON.stringify({ id, basePath, url: req.url, intent });
            res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
          }),
          stop: async () => {},
          close: async () => {},
        };
      },
    })),
    { base: '/tools', mounts: { staff: '', store: 'dealers', other: 'other' }, publicOrigin: 'https://staff.example', hosts: mappings },
    {
      route: (req, res) => {
        identityCalls++;
        if (req.url === '/tools/_mistri/apps' || req.url === '/tools/api/auth/session') {
          res.end('identity');
          return Promise.resolve();
        }
        return undefined;
      },
      close: () => {},
    },
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  assert.deepEqual(bindings.staff, ['staff.example']);
  assert.deepEqual(bindings.other, ['staff.example']);
  assert.deepEqual(bindings.store, ['staff.example', 'one.example', 'two.example']);
  mappings[0].tenant = 'mutated-configuration';
  const redirect = await raw(port, 'one.example', '/?next=https://evil.example');
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers, /location: \/tools\/dealers\r\n/i);
  for (const [host, tenant] of [
    ['ONE.EXAMPLE:443', 'tenant:one'],
    ['two.example', 'tenant:two'],
  ]) {
    const response = await raw(port, host, '/tools/dealers/catalog?tenant=forged&app=other', [
      'X-Tenant-ID: forged',
      'X-Forwarded-Host: staff.example',
      'X-Forwarded-Proto: http',
      'Forwarded: host=other.example;proto=http',
    ]);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      id: 'store',
      basePath: '/tools/dealers',
      url: '/tools/dealers/catalog?tenant=forged&app=other',
      intent: { host: host.toLowerCase().replace(':443', ''), app: 'store', tenant },
    });
  }
  for (const path of [
    '/tools',
    '/tools/',
    '/tools/catalog',
    '/tools/other/catalog',
    '/tools/dealers-other',
    '/dealers',
    '/tools/_mistri/apps',
    '/tools/api/auth/session',
    '/tools/api/suite/apps',
    '/tools/dealers/api/auth',
    '/tools/dealers/api/auth/session',
    '/tools/dealers/api/suite/grants',
    '/tools/dealers/_mistri/apps',
    '/tools/dealers/api/%61uth/session',
    '/tools/dealers/../api/auth/session',
    '/tools/dealers%2fapi/auth/session',
    '//staff.example/tools/dealers',
    'http://staff.example/tools/dealers',
  ]) {
    assert.equal((await raw(port, 'one.example', path)).status, 404, path);
  }
  assert.equal(identityCalls, 0);
  for (const host of [
    'unknown.example',
    'one.example.evil',
    'one.example@staff.example',
    'one.example.',
    'one.example:0',
    'one.example:65536',
  ]) {
    assert.equal((await raw(port, host, '/tools/_mistri/apps', ['X-Forwarded-Host: staff.example'])).status, 403, host);
  }
  assert.equal((await raw(port, 'one.example', '/tools/dealers', ['Host: staff.example'])).status, 403);
  assert.equal(identityCalls, 0);
  const staff = await raw(port, 'staff.example', '/tools/_mistri/apps', ['X-Forwarded-Host: one.example']);
  assert.equal(staff.status, 200);
  assert.match(staff.body, /identity/);
  const local = await raw(port, `127.0.0.1:${port}`, '/tools/other/catalog', ['X-Forwarded-Host: one.example']);
  assert.equal(local.status, 200);
  assert.equal(JSON.parse(local.body).id, 'other');
  assert.equal(JSON.parse(local.body).intent, undefined);
});

test('mapped root Apps block identity endpoints and do not redirect in a loop', async (t) => {
  const suite = await createSuite(
    [
      {
        id: 'store',
        public: true,
        open: async () => ({
          server: createServer((_req, res) => res.end('store')),
          stop: async () => {},
          close: async () => {},
        }),
      },
    ],
    { hosts: [{ host: 'store.example', app: 'store', tenant: 'opaque' }] },
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  assert.equal((await raw(port, 'store.example')).status, 200);
  for (const path of ['/api/auth', '/api/auth/session', '/api/suite/apps', '/_mistri/apps']) {
    assert.equal((await raw(port, 'store.example', path)).status, 404);
  }
  assert.equal((await raw(port, 'undeclared.example', '/')).status, 403);
});

test('host mappings are validated before factories open resources', async () => {
  let opened = 0;
  const open = async () => {
    opened++;
    return { server: createServer(), stop: async () => {}, close: async () => {} };
  };
  const hosts = [{ host: 'store.example', app: 'store', tenant: 'opaque' }];
  await assert.rejects(createSuite([{ id: 'store', open }], { hosts }), /public surface/);
  await assert.rejects(createSuite([{ id: 'private', public: true, open }], { hosts }), /unknown App/);
  await assert.rejects(createSuite([{ id: 'store', public: true, open }], { hosts, publicOrigin: 'https://store.example' }), /collides/);
  assert.equal(opened, 0);
});

test('upgrades remain on the staff origin and reject every storefront socket', async (t) => {
  const visited: string[] = [];
  const suite = await createSuite(
    ['staff', 'store'].map((id) => ({
      id,
      public: id === 'store',
      open: async () => {
        const server = createServer();
        server.on('upgrade', (req, socket) => {
          visited.push(id);
          const intent = getTenantHostIntent(req);
          socket.end(`HTTP/1.1 101 Switching Protocols\r\nX-App: ${id}\r\nX-Tenant: ${intent?.tenant ?? ''}\r\nX-URL: ${req.url}\r\n\r\n`);
        });
        return { server, stop: async () => {}, close: async () => {} };
      },
    })),
    { mounts: { staff: '', store: 'shop' }, hosts: [{ host: 'store.example', app: 'store', tenant: 'opaque' }] },
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  const headers = ['Connection: Upgrade', 'Upgrade: websocket'];
  // Raw helper's final Connection: close is merged with Upgrade by Node.
  assert.equal((await raw(port, 'store.example', '/shop/socket?q=1', headers)).status, 0);
  const allowed = await raw(port, `127.0.0.1:${port}`, '/shop/socket?q=1', headers);
  assert.equal(allowed.status, 101);
  assert.match(allowed.headers, /X-Tenant: \r?\n/);
  assert.match(allowed.headers, /X-URL: \/shop\/socket\?q=1/);
  for (const [host, path, extra] of [
    ['evil.example', '/shop/socket', []],
    ['store.example', '/socket', []],
    ['store.example', '/shop/api/auth/session', []],
    ['store.example', '/', ['Sec-WebSocket-Protocol: vite-hmr']],
  ] as const) {
    assert.equal((await raw(port, host, path, [...headers, ...extra])).status, 0);
  }
  assert.deepEqual(visited, ['store']);
});

test("a suite answers the orchestrator's probes itself, though no App is at its root", async (t) => {
  /* Every App mounted under a path: /readyz reached no App and answered 404, so the suite was never ready. */
  const suite = await createSuite(
    ['lender', 'dealer'].map((id) => ({
      id,
      open: async () => ({
        server: createServer((_req, res) => res.end(id)),
        stop: async () => {},
        close: async () => {},
      }),
    })),
    { base: '/desk', mounts: { lender: 'lender', dealer: 'dealer' } },
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  for (const path of ['/desk/readyz', '/desk/healthz']) {
    const answer = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(answer.status, 200, path);
    assert.deepEqual(await answer.json(), { status: 'ok' });
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 404, 'outside the base path, as every route is');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/desk/lender/`)).text(), 'lender');
});
