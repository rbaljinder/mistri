import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineService, startService } from '@mistriwork/mistri/testing';
import { parseAnalyticsConfiguration } from '../packages/mistri/src/server/analytics/config.js';
import { createPresetAnalyticsSink, presetRequests, type PresetSinkOptions } from '../packages/mistri/src/server/analytics/sinkPresets.js';
import type { AnalyticsEventRow } from '../packages/mistri/src/server/analytics/store.js';

const at = 1_760_000_000_000;
const iso = '2025-10-09T08:53:20.000Z';
const base = { occurredAt: at, receivedAt: at + 5, environment: 'prod', sourceEventId: null };
/* A visitor's view, a signed-in person's action with a declared field, and a
   business event with no unit in a tenant: the three shapes a vendor is sent. */
const rows: AnalyticsEventRow[] = [
  { ...base, id: 1, tenantId: null, kind: 'view', name: 'leads', step: null, unitKind: 'visitor', unitId: 'v-9', fields: {} },
  {
    ...base,
    id: 2,
    tenantId: null,
    kind: 'action',
    name: 'close',
    step: 'ran',
    unitKind: 'subject',
    unitId: 's-1',
    fields: { plan: 'pro', kind: 'x' },
  },
  {
    ...base,
    id: 3,
    tenantId: 't-7',
    kind: 'business',
    name: 'order.paid',
    step: null,
    unitKind: null,
    unitId: null,
    fields: { amount: 12.5, gift: true },
  },
];
const options = (preset: PresetSinkOptions['preset'], more: Partial<PresetSinkOptions> = {}): PresetSinkOptions => ({
  id: 'out',
  batch: 25,
  preset,
  key: 'seg-key',
  source: 'shop.prod-1',
  ...more,
});
const plain = (requests: ReturnType<typeof presetRequests>) => requests.map((each) => ({ ...each, url: each.url.href }));
const KEY = 'analytics:out:1-3';
const props = {
  view: { mistri_kind: 'view', mistri_environment: 'prod' },
  action: { plan: 'pro', kind: 'x', mistri_kind: 'action', mistri_step: 'ran', mistri_environment: 'prod' },
  business: { amount: 12.5, gift: true, mistri_kind: 'business', mistri_environment: 'prod', mistri_tenant: 't-7' },
};

test('segment: one batch, page for a view, userId only for a subject, the key as Basic auth and no IP', () => {
  assert.deepEqual(plain(presetRequests(options('segment'), rows, KEY)), [
    {
      url: 'https://api.segment.io/v1/batch',
      headers: { 'idempotency-key': KEY, authorization: 'Basic c2VnLWtleTo=' },
      body: {
        batch: [
          {
            type: 'page',
            name: 'leads',
            anonymousId: 'v-9',
            messageId: 'shop.prod-1:1',
            timestamp: iso,
            properties: props.view,
            context: { library: { name: 'mistri' }, ip: '0.0.0.0' },
          },
          {
            type: 'track',
            event: 'action:close',
            userId: 's-1',
            messageId: 'shop.prod-1:2',
            timestamp: iso,
            properties: props.action,
            context: { library: { name: 'mistri' }, ip: '0.0.0.0' },
          },
          {
            type: 'track',
            event: 'order.paid',
            anonymousId: 'shop.prod-1',
            messageId: 'shop.prod-1:3',
            timestamp: iso,
            properties: props.business,
            context: { library: { name: 'mistri' }, ip: '0.0.0.0' },
          },
        ],
      },
    },
  ]);
});

test('posthog: the key in the body, stable uuids, geoip off, and no person profile without a unit', () => {
  assert.deepEqual(plain(presetRequests(options('posthog', { endpoint: 'https://eu.i.posthog.com/batch/' }), rows, KEY)), [
    {
      url: 'https://eu.i.posthog.com/batch/',
      headers: { 'idempotency-key': KEY },
      body: {
        api_key: 'seg-key',
        batch: [
          {
            event: '$pageview',
            distinct_id: 'v-9',
            timestamp: iso,
            uuid: 'b53db559-5043-8f06-888d-bcdbc298291d',
            properties: { ...props.view, $screen_name: 'leads', $geoip_disable: true },
          },
          {
            event: 'action:close',
            distinct_id: 's-1',
            timestamp: iso,
            uuid: '662f643b-013d-87f5-bcda-3d68c49792e2',
            properties: { ...props.action, $geoip_disable: true },
          },
          {
            event: 'order.paid',
            distinct_id: 'shop.prod-1',
            timestamp: iso,
            uuid: '90c21f37-9ba2-859c-a367-f7bda3d3cc5c',
            properties: { ...props.business, $geoip_disable: true, $process_person_profile: false },
          },
        ],
      },
    },
  ]);
});

test('amplitude: user_id or device_id, millisecond time and an insert_id per row', () => {
  assert.deepEqual(plain(presetRequests(options('amplitude'), rows, KEY)), [
    {
      url: 'https://api2.amplitude.com/batch',
      headers: { 'idempotency-key': KEY },
      body: {
        api_key: 'seg-key',
        events: [
          { event_type: 'view:leads', device_id: 'v-9', time: at, insert_id: 'shop.prod-1:1', event_properties: props.view },
          { event_type: 'action:close', user_id: 's-1', time: at, insert_id: 'shop.prod-1:2', event_properties: props.action },
          { event_type: 'order.paid', device_id: 'shop.prod-1', time: at, insert_id: 'shop.prod-1:3', event_properties: props.business },
        ],
        options: { min_id_length: 1 },
      },
    },
  ]);
});

test('ga4: one request per client, names and params in its alphabet, the secret in the query', () => {
  const url = 'https://www.google-analytics.com/mp/collect?measurement_id=G-ABC1234&api_secret=seg-key';
  assert.deepEqual(plain(presetRequests(options('ga4', { measurementId: 'G-ABC1234' }), rows, KEY)), [
    {
      url,
      headers: { 'idempotency-key': KEY },
      body: {
        client_id: 'v-9',
        events: [{ name: 'page_view', timestamp_micros: at * 1000, params: { ...props.view, page_title: 'leads' } }],
      },
    },
    {
      url,
      headers: { 'idempotency-key': KEY },
      body: { client_id: 's-1', user_id: 's-1', events: [{ name: 'action_close', timestamp_micros: at * 1000, params: props.action }] },
    },
    {
      url,
      headers: { 'idempotency-key': KEY },
      body: {
        client_id: 'shop.prod-1',
        events: [
          {
            name: 'order_paid',
            timestamp_micros: at * 1000,
            params: { amount: 12.5, gift: 'true', mistri_kind: 'business', mistri_environment: 'prod', mistri_tenant: 't-7' },
          },
        ],
      },
    },
  ]);
});

test('warehouse: the wire rows as NDJSON by default, as one JSON batch on request, Bearer only with a key', () => {
  const wire = (row: AnalyticsEventRow) => ({
    id: row.id,
    occurredAt: iso,
    receivedAt: '2025-10-09T08:53:20.005Z',
    environment: 'prod',
    tenantId: row.tenantId,
    kind: row.kind,
    name: row.name,
    step: row.step,
    unitKind: row.unitKind,
    unitId: row.unitId,
    fields: row.fields,
    sourceEventId: null,
  });
  const [ndjson] = presetRequests(
    options('warehouse', { key: undefined, endpoint: 'https://lake.example/in', format: 'ndjson' }),
    rows,
    KEY,
  );
  assert.deepEqual(ndjson.headers, { 'idempotency-key': KEY });
  assert.equal(ndjson.text?.type, 'application/x-ndjson');
  assert.deepEqual(
    ndjson.text?.body
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
    rows.map(wire),
  );
  assert.deepEqual(
    plain(presetRequests(options('warehouse', { key: 'tok', endpoint: 'https://lake.example/in', format: 'json' }), rows, KEY)),
    [
      {
        url: 'https://lake.example/in',
        headers: { 'idempotency-key': KEY, authorization: 'Bearer tok' },
        body: { format: 'mistri.analytics.v1', events: rows.map(wire) },
      },
    ],
  );
});

test('configuration: a preset takes a ${VARIABLE} key and its own fields, never a connection or a literal key', () => {
  const parsed = parseAnalyticsConfiguration(
    {
      store: 'postgres://h/db',
      sinks: [
        { id: 'seg', kind: 'http', preset: 'segment', key: '${SEGMENT_WRITE_KEY}' },
        { id: 'ga', kind: 'http', preset: 'ga4', key: '${GA4_SECRET}', measurementId: 'G-ABC1234' },
        { id: 'lake', kind: 'http', preset: 'warehouse', endpoint: 'https://lake.example/in' },
      ],
    },
    'cfg',
  );
  assert.deepEqual(parsed.sinks, [
    { id: 'seg', kind: 'http', batch: 100, preset: 'segment', key: '${SEGMENT_WRITE_KEY}' },
    { id: 'ga', kind: 'http', batch: 25, preset: 'ga4', key: '${GA4_SECRET}', measurementId: 'G-ABC1234' },
    { id: 'lake', kind: 'http', batch: 500, preset: 'warehouse', endpoint: 'https://lake.example/in', format: 'ndjson' },
  ]);
  for (const sink of [
    { preset: 'mixpanel', key: '${K}' },
    { preset: 'segment', key: 'literal-write-key' },
    { preset: 'segment' },
    { preset: 'segment', key: '${K}', connection: 'hook' },
    { preset: 'segment', key: '${K}', batch: 101 },
    { preset: 'ga4', key: '${K}' },
    { preset: 'posthog', key: '${K}', measurementId: 'G-ABC1234' },
    { preset: 'warehouse' },
    { preset: 'warehouse', endpoint: 'http://lake.example/in' },
    { preset: 'warehouse', endpoint: 'https://lake.example/in?token=x' },
    { preset: 'amplitude', key: '${K}', format: 'json' },
    { connection: 'hook', key: '${K}' },
  ])
    assert.throws(
      () => parseAnalyticsConfiguration({ store: 'a.db', sinks: [{ id: 's', kind: 'http', ...sink }] }, 'cfg'),
      /cfg: sink 1/,
      JSON.stringify(sink),
    );
});

test('a preset sink posts through egress: NDJSON with its media type, a 400 rejected, a 503 asked again', async () => {
  let answer = 200;
  const received: { type: unknown; key: unknown; auth: unknown; body: string }[] = [];
  await using receiver = await startService(
    defineService({
      name: 'lake',
      state: {},
      routes: [
        {
          id: 'in',
          match: { method: 'POST', path: '/in' },
          reply: ({ rawBody, headers }) => {
            received.push({ type: headers['content-type'], key: headers['idempotency-key'], auth: headers.authorization, body: rawBody });
            return { status: answer };
          },
        },
      ],
    }),
  );
  const sink = createPresetAnalyticsSink(options('warehouse', { key: 'tok', endpoint: `${receiver.url}/in` }));
  assert.equal(await sink.send(rows, { idempotencyKey: KEY }), 'accepted');
  assert.deepEqual(
    received.map(({ type, key, auth }) => ({ type, key, auth })),
    [{ type: 'application/x-ndjson', key: KEY, auth: 'Bearer tok' }],
  );
  assert.equal(received[0].body.split('\n').length, 4);
  answer = 400;
  assert.equal(await sink.send(rows, { idempotencyKey: KEY }), 'rejected');
  answer = 503;
  await assert.rejects(sink.send(rows, { idempotencyKey: KEY }), /answered 503/);
});
