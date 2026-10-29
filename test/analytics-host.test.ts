import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { defineService, startService } from '@mistriwork/mistri/testing';
import { openWebhook } from '../packages/mistri/src/server/webhooks.js';
import { parseAnalyticsConfiguration } from '../packages/mistri/src/server/analytics/config.js';
import { openAnalyticsHost } from '../packages/mistri/src/server/analytics/host.js';
import { provisionAnalyticsStore } from '../packages/mistri/src/server/analytics/store.js';
import { parseTestApp } from './support/commandCatalog.js';
import { scratch } from './support/storeLayouts.js';

const app = parseTestApp(
  {
    name: 'Shop',
    auth: { roles: { operator: { read: true, commands: ['close'] } } },
    resources: { item: { actions: { close: { label: 'Close', command: { id: 'close', version: 1, target: 'item', input: {} } } } } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    nav: ['items'],
    analytics: { collect: ['views', 'commands'] },
  },
  'analytics-host',
);

test('configuration: a store, an App, sinks and nothing else, with a relative path read against its file', () => {
  const parsed = parseAnalyticsConfiguration(
    { store: 'analytics.db', app: 'shop', sinks: [{ id: 'warehouse', kind: 'http', connection: 'hook' }] },
    'cfg',
    '/etc/tw/suite.json',
  );
  assert.deepEqual(parsed, {
    store: '/etc/tw/analytics.db',
    app: 'shop',
    deploymentId: 'default',
    sinks: [{ id: 'warehouse', kind: 'http', connection: 'hook', batch: 500 }],
  });
  assert.equal(parseAnalyticsConfiguration({ store: 'postgres://h/db' }, 'cfg').store, 'postgres://h/db');
  for (const bad of [
    {},
    { store: 'mongodb://h/db' },
    { store: 'x', extra: 1 },
    { store: 'x', sinks: [{ id: 'a', kind: 'kafka', connection: 'c' }] },
    { store: 'x', sinks: [{ id: 'a', kind: 'http', connection: 'c', batch: 0 }] },
    {
      store: 'x',
      sinks: [
        { id: 'a', kind: 'http', connection: 'c' },
        { id: 'a', kind: 'http', connection: 'd' },
      ],
    },
  ]) {
    assert.throws(() => parseAnalyticsConfiguration(bad, 'cfg'), /cfg/);
  }
});

test('an App that declares no analytics cannot be bound to a store', async (t) => {
  const where = await scratch('sqlite', 'analytics-host-none');
  t.after(() => where.drop());
  const bare = { ...app, analytics: undefined };
  await assert.rejects(
    openAnalyticsHost({
      configuration: { store: where.url, deploymentId: 'd', sinks: [] },
      app: { app: bare, pages: [] },
      environment: 'prod',
      mount: '',
      bound: { host: '127.0.0.1', port: 1 },
      subject: async () => null,
      webhook: () => undefined,
    }),
    /declares no `analytics`/,
  );
});

test('an opened host takes the beacon, delivers to its sink and releases both on close', async (t) => {
  const where = await scratch('sqlite', 'analytics-host');
  t.after(() => where.drop());
  await provisionAnalyticsStore({ url: where.url, binding: { appId: app.id, deploymentId: 'prod-1' } });
  const received: { key: unknown; body: { events: { name: string; unitId: string | null }[] } }[] = [];
  await using receiver = await startService(
    defineService({
      name: 'warehouse',
      state: {},
      routes: [
        {
          id: 'hook',
          match: { method: 'POST', path: '/hook' },
          reply: ({ rawBody, headers }) => {
            received.push({ key: headers['idempotency-key'], body: JSON.parse(rawBody) });
            return { status: 200 };
          },
        },
      ],
    }),
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const host = await openAnalyticsHost({
    configuration: { store: where.url, deploymentId: 'prod-1', sinks: [{ id: 'warehouse', kind: 'http', connection: 'hook', batch: 100 }] },
    app: { app, pages: [] },
    environment: 'prod',
    mount: '',
    bound: { host: '127.0.0.1', port },
    sinkIntervalMs: 20,
    settleMs: 0,
    subject: async (req) => (req.headers.cookie === 'session=alice' ? 'account-alice' : null),
    webhook: (name) => (name === 'hook' ? openWebhook({ kind: 'webhook', name, url: `${receiver.url}/hook` }) : undefined),
  });
  server.on('request', async (req, res) => {
    if (!(await host.beacon(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  host.start();
  try {
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/_mistri/analytics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          events: [
            { kind: 'view', name: 'items' },
            { kind: 'view', name: 'unknown' },
          ],
        }),
      });
    assert.equal((await post({ cookie: 'session=alice' })).status, 204);
    assert.equal((await post({})).status, 204);
    const sent = () => received.flatMap((batch) => batch.body.events.map((event) => [event.name, event.unitId]));
    for (let waited = 0; sent().length < 2 && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      sent(),
      [
        ['items', 'account-alice'],
        ['items', null],
      ],
      'the sink was sent the stored events, and only the declared ones',
    );
    assert.match(String(received[0].key), /^analytics:warehouse:1-\d$/);
    assert.equal(await host.store.ensureCursor('warehouse'), 2);
  } finally {
    await host.close();
  }
});
