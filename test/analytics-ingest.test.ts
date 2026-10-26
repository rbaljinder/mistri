import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { normalizeAnalytics } from '../packages/mistri/src/shared/appAnalytics.js';
import { createAnalyticsIngest } from '../packages/mistri/src/server/analytics/ingest.js';
import { createAnalyticsBeaconHttp } from '../packages/mistri/src/server/analytics/beaconHttp.js';
import { createAnalyticsBusinessTransport } from '../packages/mistri/src/server/analytics/businessEvents.js';
import { openAnalyticsStore, provisionAnalyticsStore } from '../packages/mistri/src/server/analytics/store.js';
import { eventDeliveryFixture } from './support/eventDeliveryFixture.js';
import { scratch } from './support/storeLayouts.js';

const binding = { appId: 'shop', deploymentId: 'prod-1' };
const declaration = normalizeAnalytics(
  {
    collect: ['views', 'commands', 'forms'],
    events: { 'compare-opened': { fields: ['vehicleId', 'note'] } },
  },
  'test',
);
const catalog = { views: new Set(['vehicles']), commands: new Set(['close']), forms: new Map([['apply', ['contact']]]) };

async function fixture(t: import('node:test').TestContext) {
  const where = await scratch('sqlite', 'analytics-ingest');
  await provisionAnalyticsStore({ url: where.url, binding });
  const store = await openAnalyticsStore({ url: where.url, binding });
  t.after(async () => {
    await store.close();
    await where.drop();
  });
  const ingest = createAnalyticsIngest({ store, declaration, catalog, environment: 'prod', clock: () => 10_000 });
  return { store, ingest };
}

test('a beacon keeps only what is declared, and nothing personal reaches events', async (t) => {
  const { store, ingest } = await fixture(t);
  const stored = await ingest.recordBeacon(
    {
      events: [
        { kind: 'view', name: 'vehicles', route: '/vehicles' },
        { kind: 'view', name: 'vehicles', route: '/vehicles?search=jane@example.com' },
        { kind: 'view', name: 'vehicles', route: '/vehicles/1-2024-corolla?email=a' },
        { kind: 'view', name: 'secret-room' },
        { kind: 'form', name: 'apply', step: 'contact' },
        { kind: 'form', name: 'apply', step: 'unknown' },
        { kind: 'event', name: 'compare-opened', fields: { vehicleId: 'v-9', note: 'call jane@example.com', extra: 'x' } },
        { kind: 'event', name: 'compare-opened', fields: { vehicleId: '203.0.113.7', note: 'https://x.test/?token=abc' } },
        { kind: 'event', name: 'compare-opened', fields: { vehicleId: 'y'.repeat(201), note: { nested: 1 } } },
        { kind: 'event', name: 'notDeclared' },
        { kind: 'action', name: 'close' },
        { kind: 'business', name: 'application.submitted' },
        'not an event',
      ],
    },
    { kind: 'visitor', id: 'v-1' },
  );
  // Three views (two keep no route), the form step and three custom events survive.
  assert.equal(stored, 7);
  const rows = await store.readAfter(0, 50);
  const text = JSON.stringify(rows);
  for (const secret of ['jane@example.com', '203.0.113.7', 'token=abc', 'search=', 'email=a', 'yyyy', 'extra', 'nested']) {
    assert.ok(!text.includes(secret), `${secret} reached the store`);
  }
  assert.deepEqual(rows.find((row) => row.kind === 'event' && row.fields.vehicleId === 'v-9')?.fields, { vehicleId: 'v-9' });
  assert.ok(rows.every((row) => row.unitKind === 'visitor' && row.unitId === 'v-1' && row.occurredAt === 10_000));
  const counters = ingest.counters();
  assert.ok(counters.droppedPersonal >= 4 && counters.droppedUndeclared >= 4 && counters.droppedInvalid >= 2, JSON.stringify(counters));
});

test('a server records an action by command id, and only a collected, declared one', async (t) => {
  const { store, ingest } = await fixture(t);
  assert.equal(await ingest.recordAction({ command: 'close', outcome: 'ran', unit: { kind: 'subject', id: 'u-1', tenantId: 't-1' } }), 1);
  assert.equal(await ingest.recordAction({ command: 'refund', outcome: 'ran', unit: null }), 0);
  const [row] = await store.readAfter(0, 5);
  assert.deepEqual(
    [row.kind, row.name, row.step, row.unitKind, row.unitId, row.tenantId],
    ['action', 'close', 'ran', 'subject', 'u-1', 't-1'],
  );
});

test('the beacon route takes its unit from the cookie, never the body, and honors GPC', async (t) => {
  const { store, ingest } = await fixture(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const handle = createAnalyticsBeaconHttp({
    mount: '',
    bound: { host: '127.0.0.1', port },
    ingest,
    resolveUnit: (req) => (req.headers.cookie === 'visitor=v-7' ? { kind: 'visitor', id: 'v-7' } : null),
  });
  server.on('request', async (req, res) => {
    if (!(await handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/_mistri/analytics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const view = { kind: 'view', name: 'vehicles', unitId: 'forged', unit: { id: 'forged' } };
  assert.equal((await post({ cookie: 'visitor=v-7' }, { events: [view] })).status, 204);
  assert.equal((await post({ cookie: 'visitor=v-7', 'sec-gpc': '1' }, { events: [view] })).status, 204);
  assert.equal((await post({}, { events: [view] })).status, 204);
  assert.equal((await post({ origin: 'https://evil.test' }, { events: [view] })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' }, { events: [view] })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/_mistri/analytics`)).status, 405);
  assert.equal((await post({}, { events: Array.from({ length: 21 }, () => view) })).status, 204);
  const rows = await store.readAfter(0, 50);
  assert.deepEqual(
    rows.map((row) => row.unitId),
    ['v-7', null, null],
  );
});

test('a business event is copied as name, time, unit and source id, and a replay is stored once', async (t) => {
  const { store } = await fixture(t);
  const f = eventDeliveryFixture(t);
  const [signedIn] = await f.seed('receipt-001');
  const [publicActor] = await f.seed('receipt-002', undefined, {
    actorId: 'public:visitor-1',
    changesJson: '[{"operation":"update","resource":"effects"}]',
  });
  const enrollment = { source: f.policy.source, producerId: 'analytics-producer', correlationNamespace: 'analytics-facts' };
  const bridge = createAnalyticsBusinessTransport({
    store,
    events: new Set([signedIn.name]),
    enrollment,
    policy: f.policy,
    environment: 'prod',
  });
  const publish = (envelope: typeof signedIn) =>
    bridge.transport({
      destinationId: f.policy.destinationId,
      serviceId: f.policy.serviceId,
      envelope,
      idempotencyKey: envelope.eventId,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    });
  assert.equal(await publish(signedIn), 'accepted');
  assert.equal(await publish(signedIn), 'accepted', 'a redelivery is accepted again');
  assert.equal(await publish(publicActor), 'accepted');
  const rows = await store.readAfter(0, 10);
  assert.equal(rows.length, 2, 'one row per source event');
  assert.equal(rows[0].sourceEventId, signedIn.eventId);
  assert.equal(rows[0].unitId, signedIn.actorId);
  assert.equal(rows[1].unitId, null, 'a public actor has no unit');
  assert.ok(!JSON.stringify(rows).includes('assigned'), 'the payload is never copied');
  const other = createAnalyticsBusinessTransport({
    store,
    events: new Set(['other.event']),
    enrollment,
    policy: f.policy,
    environment: 'prod',
  });
  assert.equal(
    await other.transport({
      destinationId: f.policy.destinationId,
      serviceId: f.policy.serviceId,
      envelope: signedIn,
      idempotencyKey: signedIn.eventId,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    }),
    'accepted',
  );
  assert.equal((await store.readAfter(0, 10)).length, 2, 'an event no funnel names is accepted and not stored');
});

test('the beacon has a budget per client: past it a beacon is refused and nothing is written', async (t) => {
  const { store, ingest } = await fixture(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const handle = createAnalyticsBeaconHttp({ mount: '', bound: { host: '127.0.0.1', port }, ingest, resolveUnit: () => null });
  server.on('request', async (req, res) => {
    if (!(await handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  const post = (events: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/_mistri/analytics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  for (let i = 0; i < 300; i++) assert.equal((await post([])).status, 204);
  const refused = await post([{ kind: 'view', name: 'vehicles' }]);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal((await store.readAfter(0, 5)).length, 0, 'a refused beacon writes nothing');
});
