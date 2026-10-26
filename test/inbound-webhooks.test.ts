/**
 * Verified inbound webhooks (`defineInbound`, jobs/inboundHost.ts): a signed
 * delivery from an outside system runs one of the App's commands as a service
 * principal. Declaration rules, the verifier on its own (Slack's shape as
 * well as ours), startup refusals, and deliveries over a real loopback
 * server on each engine: a good one, a bad signature, a stale time, a replay,
 * a retry, a conflict, a body nobody can read, and what the answer never
 * carries. An integration's webhooks are lowered onto the same endpoint
 * (integrations/integrationInbound.ts), and are refused here exactly as a
 * hand-written one is.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  openIntegrationStore,
  provisionPostgresIntegrations,
  provisionSqliteIntegrations,
  type IntegrationStore,
} from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { id, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { captureIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import { integrationEndpoints } from '../packages/mistri/src/server/integrations/integrationInbound.js';
import { createIntegrationRuntime, saveIntegrationSettings } from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import {
  createInboundHost,
  inboundCommandKey,
  inboundEndpoint,
  inboundSecretProblems,
  verifyDelivery,
  type InboundEndpoint,
} from '../packages/mistri/src/server/jobs/inboundHost.js';
import { jobGrantProblems, prepareJobs } from '../packages/mistri/src/server/jobs/jobLoader.js';
import {
  capturedJobModule,
  defineInbound,
  defineJob,
  defineJobs,
  hmac,
  JobDeclarationError,
  pinJobs,
} from '../packages/mistri/src/server/jobs/jobModule.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { fakepay, signDelivery } from './fixtures/integrations/fakepay/index.js';

process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';
const WEBHOOK_SECRET = 'whsec_inbound_parity';

const SECRET = 'inbound-test-secret-value';
const sign = (body: string, timestamp: string, secret = SECRET) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

const TS = { header: 'x-timestamp', window: '5 minutes' };
const verifier = () =>
  hmac({
    secret: 'INBOUND_TEST_SECRET',
    signature: { header: 'x-signature', encoding: 'hex' },
    timestamp: { header: 'x-timestamp', window: '5 minutes' },
    signed: '{timestamp}.{body}',
  });
const settled = (extra: Record<string, unknown> = {}) =>
  defineInbound({
    verify: verifier(),
    runAs: 'sender',
    command: 'settle',
    key: (body: { id: string }) => body.id,
    input: (body: { status: string }) => ({ status: body.status }),
    target: (body: { item: number }) => ({ id: body.item }),
    ...extra,
  });
const moduleOf = (
  inbound: Record<string, ReturnType<typeof defineInbound>> = { settled: settled() },
  principals: Record<string, { roles: string[] }> = { sender: { roles: ['integration'] } },
) => capturedJobModule(defineJobs({}, { principals, inbound }));

test('an inbound endpoint is declared with a verifier, a principal, a command and pure readers of the body', () => {
  const captured = moduleOf();
  const endpoint = captured.inbound.get('settled')!;
  assert.equal(endpoint.name, 'settled');
  assert.equal(endpoint.verify.secretEnv, 'INBOUND_TEST_SECRET');
  assert.equal(endpoint.verify.windowMs, 300_000);
  assert.equal(endpoint.command.id, 'settle');
  assert.equal(captured.jobs.size, 0, 'a module of endpoints alone declares no jobs');
  const bad: Array<[() => unknown, RegExp]> = [
    [() => defineJobs({}, { principals: { sender: { roles: ['integration'] } } }), /at least one job or inbound endpoint/],
    [
      () => defineJobs({}, { principals: {}, inbound: { settled: settled() } }),
      /runs as "sender", which the module's principals do not declare/,
    ],
    [
      () => defineJobs({}, { principals: { sender: { roles: ['integration'] } }, inbound: { 'bad name': settled() } }),
      /Inbound names start with a letter/,
    ],
    [
      () => defineJobs({}, { principals: { sender: { roles: ['integration'] } }, inbound: { settled: {} as never } }),
      /must be created with defineInbound/,
    ],
    [
      () => defineInbound({ verify: {} as never, runAs: 'sender', command: 'settle', key: () => '', input: () => ({}) } as never),
      /must be created with hmac/,
    ],
    // An integration's webhooks are the inbound endpoint named after it: one address is one endpoint.
    [
      () =>
        defineJobs(
          {},
          {
            principals: { sender: { roles: ['integration'] } },
            inbound: { fakepay: settled() },
            integrations: { use: [fakepay()], webhooks: { fakepay: { runAs: 'sender', events: { paid: 'markPaid' } } } },
          },
        ),
      /Inbound "fakepay" takes the address of integration "fakepay"'s webhooks/,
    ],
    [() => settled({ key: 'id' }), /key must be a function/],
    [() => settled({ extra: true }), /unknown option: extra/],
    [() => hmac({ secret: 'a secret', signature: { header: 'x-signature' }, timestamp: TS }), /names the environment variable/],
    // A signed time is required: a body-only signature replays once the command's receipt is pruned.
    [() => hmac({ secret: 'S', signature: { header: 'x-signature' } } as never), /hmac needs a timestamp/],
    [() => hmac({ secret: 'S', signature: { header: 'x-signature' }, signed: '{body}' } as never), /hmac needs a timestamp/],
    [() => hmac({ secret: 'S', signature: { header: 'x-signature' }, timestamp: TS, signed: 'nothing' }), /must include \{body\}/],
    [
      () =>
        hmac({ secret: 'S', signature: { header: 'x-signature' }, timestamp: { header: 'x-ts', window: '5 minutes' }, signed: '{body}' }),
      /must include \{timestamp\}/,
    ],
    [
      () => hmac({ secret: 'S', signature: { header: 'x-signature' }, timestamp: { header: 'x-ts', window: '2 days' } }),
      /window is a duration/,
    ],
    [() => hmac({ secret: 'S', signature: { header: 'x-signature' }, timestamp: TS, signed: '{nope}{body}' }), /unknown part \{nope\}/],
  ];
  for (const [make, message] of bad)
    assert.throws(make, (error) => error instanceof JobDeclarationError && message.test(error.message), String(message));
});

test("the verifier checks the raw bytes, the time and the digest, for our shape and for Slack's", () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const body = Buffer.from('{"id":"c1","score":700}');
  const ours = pinJobs(moduleOf(), {}).inbound.get('settled')!.verify;
  const seconds = String(Math.floor(now / 1000)),
    millis = String(now);
  const headers = (extra: Record<string, string>) => ({ 'x-signature': sign(body.toString(), seconds), 'x-timestamp': seconds, ...extra });
  assert.equal(verifyDelivery(ours, headers({}), body, SECRET, now), true);
  // Milliseconds are read as milliseconds: the test provider's clock.
  assert.equal(verifyDelivery(ours, { 'x-signature': sign(body.toString(), millis), 'x-timestamp': millis }, body, SECRET, now), true);
  assert.equal(verifyDelivery(ours, headers({}), Buffer.from('{"id":"c1","score":701}'), SECRET, now), false, 'one changed byte');
  assert.equal(verifyDelivery(ours, headers({}), body, 'another-secret', now), false);
  assert.equal(verifyDelivery(ours, headers({}), body, '', now), false, 'no secret verifies nothing');
  assert.equal(verifyDelivery(ours, headers({ 'x-signature': 'zz' }), body, SECRET, now), false, 'not hex');
  assert.equal(verifyDelivery(ours, headers({ 'x-signature': 'ab' }), body, SECRET, now), false, 'wrong length');
  assert.equal(verifyDelivery(ours, { 'x-timestamp': seconds }, body, SECRET, now), false, 'no signature');
  assert.equal(verifyDelivery(ours, { 'x-signature': sign(body.toString(), seconds) }, body, SECRET, now), false, 'no time');
  assert.equal(verifyDelivery(ours, headers({}), body, SECRET, now + 301_000), false, 'stale');
  assert.equal(verifyDelivery(ours, headers({}), body, SECRET, now - 301_000), false, 'from the future');
  assert.equal(verifyDelivery(ours, headers({}), body, SECRET, now + 299_000), true, 'inside the window');
  // A time that is not signed is not evidence: swapping in a fresh one changes the digest.
  const old = String(Math.floor(now / 1000) - 3600);
  assert.equal(verifyDelivery(ours, { 'x-signature': sign(body.toString(), old), 'x-timestamp': seconds }, body, SECRET, now), false);

  // Slack: v0=<hex of HMAC("v0:" + timestamp + ":" + body)>.
  const slack = capturedJobModule(
    defineJobs(
      {},
      {
        principals: { sender: { roles: ['integration'] } },
        inbound: {
          slack: defineInbound({
            verify: hmac({
              secret: 'SLACK_SIGNING_SECRET',
              signature: { header: 'X-Slack-Signature', prefix: 'v0=' },
              timestamp: { header: 'X-Slack-Request-Timestamp', window: '5 minutes' },
              signed: 'v0:{timestamp}:{body}',
            }),
            runAs: 'sender',
            command: 'settle',
            key: () => 'k',
            input: () => ({}),
          }),
        },
      },
    ),
  ).inbound.get('slack')!.verify;
  const digest = createHmac('sha256', SECRET).update(`v0:${seconds}:${body}`).digest('hex');
  assert.equal(
    verifyDelivery(slack, { 'x-slack-signature': `v0=${digest}`, 'x-slack-request-timestamp': seconds }, body, SECRET, now),
    true,
  );
  assert.equal(
    verifyDelivery(slack, { 'x-slack-signature': digest, 'x-slack-request-timestamp': seconds }, body, SECRET, now),
    false,
    'prefix missing',
  );

  // base64, sha1, and the default signed text: {timestamp}.{body}.
  const plain = capturedJobModule(
    defineJobs(
      {},
      {
        principals: { sender: { roles: ['integration'] } },
        inbound: {
          plain: defineInbound({
            verify: hmac({ secret: 'S', algorithm: 'sha1', signature: { header: 'x-hub', encoding: 'base64' }, timestamp: TS }),
            runAs: 'sender',
            command: 'settle',
            key: () => 'k',
            input: () => ({}),
          }),
        },
      },
    ),
  ).inbound.get('plain')!.verify;
  const hub = createHmac('sha1', SECRET).update(`${seconds}.${body}`).digest('base64');
  assert.equal(verifyDelivery(plain, { 'x-hub': hub, 'x-timestamp': seconds }, body, SECRET, now), true);
  assert.equal(
    verifyDelivery(plain, { 'x-hub': createHmac('sha1', SECRET).update(body).digest('base64') }, body, SECRET, now),
    false,
    'a body-only signature, no time',
  );
});

test("a command receipt key carries the endpoint and the sender's id in the shape a receipt takes", () => {
  assert.match(inboundCommandKey('settled', 'c1'), /^inbound-[0-9a-f]{64}$/);
  assert.notEqual(inboundCommandKey('settled', 'c1'), inboundCommandKey('other', 'c1'));
  assert.notEqual(inboundCommandKey('settled', 'c1'), inboundCommandKey('settled', 'c2'));
});

/* This suite's own PostgreSQL database, beside the server's. */
const DATABASE = `inbound_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const settle = defineCommand({
  source: 'shop',
  target: 'vehicle',
  input: { status: field.choice(['reserved', 'sold']) },
  output: shape({ id: id() }),
  async handle({ db, record }, input) {
    const updated = await db.vehicle.update(record!, { status: input.status });
    return { id: updated.id as number };
  },
});
// The provider's "paid", run by FakePay's webhook: it names no record, and finds the item by its stock number.
const markPaid = defineCommand({
  source: 'shop',
  target: 'vehicle',
  targets: 'none',
  input: { charge: field.text(), amount: field.number() },
  output: shape({ id: id() }),
  async handle({ db }, input) {
    const found = await db.vehicle.find({ stock: String(input.charge) });
    // A command that names no record keeps the version itself: a second run would show as a second write.
    const updated = await db.vehicle.update(found!, { status: 'sold', version: Number(found!.version) + 1 });
    return { id: updated.id as number };
  },
});

interface Fixture {
  url: string;
  module: ReturnType<typeof moduleOf>;
  app: ReturnType<typeof parseAppConfig>;
  config: Record<string, unknown>;
  resources: Awaited<ReturnType<typeof loadAppRuntimeResources>>;
  binding: ReturnType<typeof bindBusinessCommands>;
  commands: ReturnType<typeof defineCommands>;
  clock: { now: number };
  item: (id: number) => Promise<{ status: string; version: number }>;
  send: (
    body: string,
    headers?: Record<string, string>,
    options?: { method?: string; path?: string; sign?: boolean; secret?: string },
  ) => Promise<Response>;
  delivery: (payload: Record<string, unknown>) => { body: string; headers: Record<string, string> };
  registry: Registry;
  engine: Awaited<ReturnType<typeof openTenantEngine>>;
  /** Where deliveries are remembered: the integrations store, provisioned beside the App's rows. */
  store: IntegrationStore;
  /** The endpoints the fixture's host serves: the module's defineInbound ones, then FakePay's lowered webhooks. */
  endpoints: readonly InboundEndpoint[];
  /** A FakePay delivery, signed with the tenant's webhook secret (or another) at the fixture's clock (or another time). */
  fakepay: (
    event: { id: string; type: string; data: unknown },
    options?: { secret?: string; at?: number; path?: string; method?: string },
  ) => Promise<Response>;
}

async function fixture(
  dialect: TenantDialect,
  run: (f: Fixture) => Promise<void>,
  inbound?: Record<string, ReturnType<typeof defineInbound>>,
) {
  const setup = `CREATE TABLE db_item (id INTEGER PRIMARY KEY, stock TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO db_item VALUES (1, 'FC-1', 'available', 0), (2, 'FC-2', 'available', 0), (3, 'FC-3', 'available', 0);`;
  const engine = await openTenantEngine(dialect, { tables: ['db_item'], sqlite: setup, postgres: setup, database: DATABASE });
  const registry = new Registry();
  process.env.INBOUND_TEST_SECRET = SECRET;
  let server: ReturnType<typeof createApp> | undefined;
  let store: IntegrationStore | undefined;
  try {
    await engine.migrateCommandJournal();
    if (dialect === 'sqlite') provisionSqliteIntegrations(engine.path);
    else await provisionPostgresIntegrations(engine.url);
    store = await openIntegrationStore(dialect === 'sqlite' ? { sqlite: engine.path } : { postgres: engine.url });
    const commands = defineCommands({ settle, markPaid });
    registry.add({ id: 'private-db', name: 'Shop', url: engine.path || engine.url, writable: true, source: 'config' });
    const config = {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'private-db' } },
      resources: { vehicle: { physical: engine.id('db_item'), access: 'write' } },
      auth: {
        roles: {
          staff: { read: true },
          integration: { read: true, service: true, commands: ['settle', 'markPaid'] },
          clerk: { read: true, commands: ['settle'] },
          observer: { read: true },
        },
      },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    };
    const app = parseAppConfig(config, 'inbound fixture');
    const resources = await loadAppRuntimeResources(registry, app, 'private-db');
    const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
    const module = pinJobs(moduleOf(inbound), commands);
    const clock = { now: Date.parse('2026-10-02T12:00:00Z') };
    // FakePay's webhooks, mapped as an App maps them, lowered onto the same inbound host as the module's endpoints.
    const declared = captureIntegrations(
      { use: [fakepay()], webhooks: { fakepay: { runAs: 'sender', events: { paid: 'markPaid' } } } },
      module.principals,
      (message) => {
        throw new Error(message);
      },
    );
    const runtime = createIntegrationRuntime({ appId: 'shop', declared, store, now: () => clock.now });
    await saveIntegrationSettings(runtime, '', 'owner', {
      integration: 'fakepay',
      secrets: { apiKey: 'sk_parity', webhookSecret: WEBHOOK_SECRET },
    });
    const endpoints = [
      ...[...module.inbound.values()].map((endpoint) => inboundEndpoint(endpoint, process.env)),
      ...integrationEndpoints(runtime, commands),
    ];
    const host = createInboundHost({
      endpoints,
      appId: 'shop',
      principals: module.principals,
      bind: async () => ({ binding, release() {} }),
      deliveries: store,
      now: () => clock.now,
      warn: () => {},
    });
    server = createApp({ registry, bound: { host: '127.0.0.1', port: 0 }, inbound: host });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server!.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const delivery = (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload),
        timestamp = String(Math.floor(clock.now / 1000));
      return { body, headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': sign(body, timestamp) } };
    };
    const send: Fixture['send'] = (body, headers = {}, options = {}) => {
      const timestamp = String(Math.floor(clock.now / 1000));
      return fetch(`${url}${options.path ?? '/api/inbound/settled'}`, {
        method: options.method ?? 'POST',
        body: options.method === 'GET' ? undefined : body,
        headers: {
          'content-type': 'application/json',
          'x-timestamp': timestamp,
          ...(options.sign === false ? {} : { 'x-signature': sign(body, headers['x-timestamp'] ?? timestamp, options.secret) }),
          ...headers,
        },
      });
    };
    const item = async (key: number) => {
      const [row] = await engine.all(`SELECT status, version FROM db_item WHERE id = ${key}`);
      return { status: String(row.status), version: Number(row.version) };
    };
    const pay: Fixture['fakepay'] = (event, options = {}) => {
      const signed = signDelivery(options.secret ?? WEBHOOK_SECRET, event, options.at ?? clock.now);
      return fetch(`${url}${options.path ?? '/api/inbound/fakepay'}`, {
        method: options.method ?? 'POST',
        body: options.method === 'GET' ? undefined : signed.body,
        headers: signed.headers,
      });
    };
    await run({
      url,
      module,
      app,
      config,
      resources,
      binding,
      commands,
      clock,
      item,
      send,
      delivery,
      registry,
      engine,
      store,
      endpoints,
      fakepay: pay,
    });
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    delete process.env.INBOUND_TEST_SECRET;
    await store?.close();
    await registry.closeAll();
    await engine.close();
  }
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`inbound webhooks on ${dialect}`, { skip }, () => {
    test('a good delivery runs the command as the principal and answers 204 with nothing in the body', async () => {
      await fixture(dialect, async (f) => {
        const { body, headers } = f.delivery({ id: 'chk-1', item: 1, status: 'reserved' });
        const reply = await f.send(body, headers);
        assert.equal(reply.status, 204);
        assert.equal(await reply.text(), '');
        assert.deepEqual(await f.item(1), { status: 'reserved', version: 1 });
        assert.deepEqual(await f.item(2), { status: 'available', version: 0 });
      });
    });

    test('a bad or missing signature is 401 and changes nothing, and says nothing', async () => {
      await fixture(dialect, async (f) => {
        const { body } = f.delivery({ id: 'chk-2', item: 1, status: 'reserved' });
        for (const options of [{ secret: 'someone-elses-secret' }, { sign: false }]) {
          const reply = await f.send(body, {}, options);
          assert.equal(reply.status, 401);
          assert.equal(await reply.text(), '');
        }
        // Signed over different bytes.
        assert.equal(
          (await f.send(body, { 'x-signature': sign(body.replace('reserved', 'sold'), String(Math.floor(f.clock.now / 1000))) }, {}))
            .status,
          401,
        );
        assert.deepEqual(await f.item(1), { status: 'available', version: 0 });
      });
    });

    test('a stale or future timestamp is 401 even with a valid signature over it', async () => {
      await fixture(dialect, async (f) => {
        const { body } = f.delivery({ id: 'chk-3', item: 1, status: 'reserved' });
        for (const offset of [-600, 600]) {
          const timestamp = String(Math.floor(f.clock.now / 1000) + offset);
          assert.equal((await f.send(body, { 'x-timestamp': timestamp, 'x-signature': sign(body, timestamp) })).status, 401);
        }
        assert.deepEqual(await f.item(1), { status: 'available', version: 0 });
      });
    });

    test("a replay answers the first delivery's receipt, as the sender's retry signed anew does; the same id with another body is 409", async () => {
      await fixture(dialect, async (f) => {
        const first = f.delivery({ id: 'chk-4', item: 1, status: 'reserved' });
        assert.equal((await f.send(first.body, first.headers)).status, 204);
        const replay = await f.send(first.body, first.headers);
        assert.equal(replay.status, 204, 'the same bytes and the same signed time again: the receipt, not a failure to retry on');
        assert.equal(await replay.text(), '');
        assert.deepEqual(await f.item(1), { status: 'reserved', version: 1 }, 'the replay wrote nothing');
        f.clock.now += 2000;
        const retry = f.delivery({ id: 'chk-4', item: 1, status: 'reserved' });
        assert.equal((await f.send(retry.body, retry.headers)).status, 204, 'the provider retried, signing a new time');
        assert.deepEqual(await f.item(1), { status: 'reserved', version: 1 }, 'one write');
        f.clock.now += 2000;
        const other = f.delivery({ id: 'chk-4', item: 1, status: 'sold' });
        const conflict = await f.send(other.body, other.headers);
        assert.equal(conflict.status, 409);
        assert.equal(await conflict.text(), '');
        assert.deepEqual(await f.item(1), { status: 'reserved', version: 1 });
        // Another sender's id is another delivery.
        const next = f.delivery({ id: 'chk-5', item: 2, status: 'sold' });
        assert.equal((await f.send(next.body, next.headers)).status, 204);
        assert.deepEqual(await f.item(2), { status: 'sold', version: 1 });
      });
    });

    test('an integration webhook and a defineInbound refuse the same bad signatures, stale times and replays alike', async () => {
      await fixture(dialect, async (f) => {
        const seconds = () => String(Math.floor(f.clock.now / 1000));
        /* The same cases, each in its own sender's scheme: ours (an hmac declared with defineInbound) and FakePay's
           (Stripe's shape, read by the package's verify). Each case answers one status, whichever declared it. */
        type Case = { name: string; hand: () => Promise<Response>; integration: () => Promise<Response> };
        let n = 0;
        const fresh = () => {
          n += 1;
          return {
            hand: f.delivery({ id: `par-${n}`, item: 3, status: 'reserved' }),
            event: { id: `evt_par_${n}`, type: 'charge.succeeded', data: { charge: 'FC-3', amount: 400 } },
          };
        };
        const cases: Array<Case & { status: number }> = [];
        const at = (name: string, status: number, make: () => Omit<Case, 'name'>) => cases.push({ name, status, ...make() });
        at('another secret', 401, () => {
          const { hand, event } = fresh();
          return {
            hand: () => f.send(hand.body, {}, { secret: 'someone-elses' }),
            integration: () => f.fakepay(event, { secret: 'whsec_other' }),
          };
        });
        at('no signature', 401, () => {
          const { hand, event } = fresh();
          return {
            hand: () => f.send(hand.body, {}, { sign: false }),
            integration: () =>
              fetch(`${f.url}/api/inbound/fakepay`, {
                method: 'POST',
                body: JSON.stringify(event),
                headers: { 'content-type': 'application/json' },
              }),
          };
        });
        at('signed over other bytes', 401, () => {
          const { hand, event } = fresh();
          const signed = signDelivery(WEBHOOK_SECRET, event, f.clock.now);
          return {
            hand: () => f.send(hand.body.replace('reserved', 'sold'), { 'x-signature': hand.headers['x-signature'] }),
            integration: () =>
              fetch(`${f.url}/api/inbound/fakepay`, { method: 'POST', body: signed.body.replace('400', '401'), headers: signed.headers }),
          };
        });
        for (const offset of [-600_000, 600_000])
          at(offset < 0 ? 'stale' : 'from the future', 401, () => {
            const { hand, event } = fresh();
            const stamp = String(Math.floor((f.clock.now + offset) / 1000));
            return {
              hand: () => f.send(hand.body, { 'x-timestamp': stamp, 'x-signature': sign(hand.body, stamp) }),
              integration: () => f.fakepay(event, { at: f.clock.now + offset }),
            };
          });
        at('GET', 405, () => {
          const { hand, event } = fresh();
          return { hand: () => f.send(hand.body, hand.headers, { method: 'GET' }), integration: () => f.fakepay(event, { method: 'GET' }) };
        });
        at('a tenant address on an App without tenants', 404, () => {
          const { hand, event } = fresh();
          return {
            hand: () => f.send(hand.body, hand.headers, { path: '/api/inbound/settled/north' }),
            integration: () => f.fakepay(event, { path: '/api/inbound/fakepay/north' }),
          };
        });
        for (const { name, status, hand, integration } of cases) {
          const [byHand, lowered] = [await hand(), await integration()];
          assert.deepEqual([byHand.status, await byHand.text()], [status, ''], `defineInbound: ${name}`);
          assert.deepEqual([lowered.status, await lowered.text()], [status, ''], `integration: ${name}`);
        }
        assert.deepEqual(await f.item(3), { status: 'available', version: 0 }, 'nothing refused wrote');

        // A good delivery, the same again (a replay), and the sender's retry signed anew.
        const hand = f.delivery({ id: 'par-good', item: 1, status: 'reserved' });
        const event = { id: 'evt_par_good', type: 'charge.succeeded', data: { charge: 'FC-2', amount: 400 } };
        // One after the other: the two share the App's one writer.
        const pairs = async (make: () => [() => Promise<Response>, () => Promise<Response>]) => {
          const [a, b] = make();
          return [(await a()).status, (await b()).status];
        };
        assert.deepEqual(await pairs(() => [() => f.send(hand.body, hand.headers), () => f.fakepay(event)]), [204, 204], 'applied');
        assert.deepEqual(
          await pairs(() => [() => f.send(hand.body, hand.headers), () => f.fakepay(event)]),
          [204, 204],
          'a replay answers the receipt',
        );
        f.clock.now += 3000;
        const again = f.delivery({ id: 'par-good', item: 1, status: 'reserved' });
        assert.equal(again.headers['x-timestamp'], seconds());
        assert.deepEqual(
          await pairs(() => [() => f.send(again.body, again.headers), () => f.fakepay(event)]),
          [204, 204],
          'a retry replays the receipt',
        );
        assert.deepEqual(await f.item(1), { status: 'reserved', version: 1 }, 'written once');
        assert.deepEqual(await f.item(2), { status: 'sold', version: 1 }, 'written once');
        // Past the limit, unread, before any signature is looked at.
        const large = JSON.stringify({ id: 'big', pad: 'x'.repeat(300 * 1024) });
        assert.deepEqual(
          await pairs(() => [
            () => f.send(large, {}),
            () => fetch(`${f.url}/api/inbound/fakepay`, { method: 'POST', body: large, headers: { 'content-type': 'application/json' } }),
          ]),
          [413, 413],
        );
        // An event the App does not map is taken and runs nothing; a hand-written endpoint has no such event.
        assert.equal((await f.fakepay({ id: 'evt_par_refund', type: 'charge.refunded', data: { charge: 'FC-3' } })).status, 202);
        assert.equal((await f.fakepay({ id: 'evt_par_other', type: 'invoice.created', data: {} })).status, 202);
        assert.deepEqual(await f.item(3), { status: 'available', version: 0 });
      });
    });

    test('a body nobody can read, an input the command refuses and a missing id are 400; the rest of the route is as plain', async () => {
      await fixture(dialect, async (f) => {
        const stamp = String(Math.floor(f.clock.now / 1000));
        const signed = (body: string) => ({ 'x-timestamp': stamp, 'x-signature': sign(body, stamp) });
        for (const body of ['not json', '[1,2]', '"text"', ''])
          assert.equal((await f.send(body, signed(body))).status, 400, JSON.stringify(body));
        const invalid = f.delivery({ id: 'chk-6', item: 1, status: 'bogus' });
        assert.equal((await f.send(invalid.body, invalid.headers)).status, 400, "the command's own input rules");
        const noId = f.delivery({ item: 1, status: 'reserved' });
        assert.equal((await f.send(noId.body, noId.headers)).status, 400);
        const noTarget = f.delivery({ id: 'chk-7', status: 'reserved' });
        assert.equal((await f.send(noTarget.body, noTarget.headers)).status, 400);
        assert.deepEqual(await f.item(1), { status: 'available', version: 0 });
        const ok = f.delivery({ id: 'x', item: 1, status: 'reserved' });
        assert.equal((await f.send(ok.body, ok.headers, { method: 'GET', path: '/api/inbound/settled' })).status, 405);
        assert.equal((await f.send(ok.body, ok.headers, { path: '/api/inbound/nobody' })).status, 404);
        // Past the limit, unread: refused before the signature is looked at.
        const large = JSON.stringify({ id: 'big', pad: 'x'.repeat(300 * 1024) });
        assert.equal((await f.send(large, signed(large))).status, 413);
      });
    });

    test('a principal the App does not grant is refused at the call, not applied', async () => {
      await fixture(dialect, async (f) => {
        // The App changed under a running server: the principal's role lost the command.
        const narrowed = parseAppConfig({ ...f.config, auth: { roles: { integration: { read: true } } } }, 'revoked');
        const binding = bindBusinessCommands({
          app: narrowed,
          registry: f.commands,
          resources: f.resources,
          writableConnection: () => true,
        });
        const host = createInboundHost({
          endpoints: f.endpoints,
          appId: 'shop',
          principals: f.module.principals,
          bind: async () => ({ binding, release() {} }),
          deliveries: f.store,
          now: () => f.clock.now,
        });
        const server = createApp({ registry: f.registry, bound: { host: '127.0.0.1', port: 0 }, inbound: host });
        server.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
          const { body, headers } = f.delivery({ id: 'chk-8', item: 1, status: 'reserved' });
          const reply = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inbound/settled`, {
            method: 'POST',
            body,
            headers,
          });
          assert.equal(reply.status, 403);
          assert.equal(await reply.text(), '');
          assert.deepEqual(await f.item(1), { status: 'available', version: 0 });
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      });
    });

    test('startup refuses an unresolved command and an ungranted principal; a missing secret is named', async () => {
      await fixture(dialect, async (f) => {
        const dir = mkdtempSync(join(tmpdir(), 'tw-inbound-'));
        try {
          const source = (
            inbound: string,
            principals = `{ sender: { roles: ['integration'] } }`,
            stamp = `, timestamp: { header: 'x-timestamp', window: '5 minutes' }`,
          ) => {
            const file = join(dir, `jobs-${randomUUID()}.mjs`);
            writeFileSync(
              file,
              `import { defineInbound, defineJobs, hmac } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages/mistri/src/server/jobs.ts')).href)};
export default defineJobs({}, { principals: ${principals}, inbound: { settled: defineInbound({
  verify: hmac({ secret: 'INBOUND_TEST_SECRET', signature: { header: 'x-signature' }${stamp} }), ${inbound} }) } });
`,
            );
            return file;
          };
          const prepare = (file: string) =>
            prepareJobs({
              file,
              app: f.app,
              commands: f.commands,
              resources: f.resources,
              binding: f.binding,
              locate: () => f.engine.path || f.engine.url,
            });
          const good = `runAs: 'sender', command: 'settle', key: b => b.id, input: b => ({ status: b.status }), target: b => ({ id: b.item })`;
          const prepared = await prepare(source(good));
          assert.equal(prepared.deployment, undefined, 'endpoints alone have no job store');
          assert.equal(prepared.module.inbound.get('settled')!.command.version, 1);
          assert.match(
            prepared.lines[0],
            /^inbound: settled POST \/api\/inbound\/settled \(hmac sha256, ±300s, secret INBOUND_TEST_SECRET\) → settle@1 as sender$/,
          );
          await assert.rejects(
            prepare(source(good.replace("'settle'", "'nothing'"))),
            /runs command "nothing", which the commands module does not register/,
          );
          await assert.rejects(
            prepare(source(good.replace('integration', 'observer'), `{ sender: { roles: ['observer'] } }`)),
            /principal "sender" \(roles observer\) is not granted command "settle"/,
          );
          await assert.rejects(prepare(source(good, `{ sender: { roles: ['staff'] } }`)), /not granted command "settle"/);
          // Granted the command, and a person's role: an outside caller proving a secret never acts as a person.
          await assert.rejects(
            prepare(source(good, `{ sender: { roles: ['clerk'] } }`)),
            /principal "sender" runs inbound endpoint "settled", so every role it holds is a service role \("service": true\); "clerk" is not/,
          );
          // A verifier with no signed time is refused when the module loads, so serving and mistri check both stop on it.
          await assert.rejects(prepare(source(good, undefined, '')), /hmac needs a timestamp/);
          assert.deepEqual(jobGrantProblems(f.module, f.app), []);
          assert.deepEqual(inboundSecretProblems(f.module, { INBOUND_TEST_SECRET: SECRET }), []);
          assert.deepEqual(inboundSecretProblems(f.module, {}), [
            'inbound endpoint "settled" verifies with the secret in INBOUND_TEST_SECRET, and that environment variable is not set.',
          ]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });

test('a module may mix jobs and endpoints, and a job still needs its principal', () => {
  const mixed = capturedJobModule(
    defineJobs(
      { minutely: defineJob({ every: '* * * * *', runAs: 'sender', command: 'settle' }) },
      { principals: { sender: { roles: ['integration'] } }, inbound: { settled: settled() } },
    ),
  );
  assert.equal(mixed.jobs.size, 1);
  assert.equal(mixed.inbound.size, 1);
});
