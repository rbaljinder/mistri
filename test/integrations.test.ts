/**
 * The integration seams below a host: what defineIntegration and a jobs
 * module's `integrations` refuse, the sentences `mistri check` names by
 * code, the channel's consent and quiet hours over a real store, and the
 * webhooks lowered onto an inbound endpoint (their HTTP refusals, beside a
 * defineInbound's, are test/inbound-webhooks.test.ts). The tenant host's whole path, secrets to
 * webhooks to effects, is test/tenant-integrations.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { openIntegrationStore, provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import type { NoticeRule } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { bindNotices } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { parseNotify } from '../packages/mistri/src/shared/appNotify.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { effectIdempotencyKey, send } from '../packages/mistri/src/server/commands/commandEffects.js';
import type { EventPublication } from '../packages/mistri/src/server/events/eventPublisher.js';
import { defineIntegration, IntegrationDeclarationError, shape } from '../packages/mistri/src/server/integration.js';
import { channelHolder, channelSender, quietUntil } from '../packages/mistri/src/server/integrations/integrationChannels.js';
import {
  integrationCommandProblems,
  integrationNotifyProblems,
  integrationRoleProblems,
} from '../packages/mistri/src/server/integrations/integrationChecks.js';
import { captureIntegrations, type CapturedIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import {
  createIntegrationRuntime,
  registerIntegrationRuntime,
  saveIntegrationSettings,
} from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { integrationRoutes } from '../packages/mistri/src/server/http/integrationRoutes.js';
import { HttpError } from '../packages/engine/src/server/http/reply.js';
import type { PostContext } from '../packages/engine/src/server/http/context.js';
import { integrationEndpoints } from '../packages/mistri/src/server/integrations/integrationInbound.js';
import { createInboundHost } from '../packages/mistri/src/server/jobs/inboundHost.js';
import { parseTestApp } from './support/commandCatalog.js';
import { fakepay, provider, resetProvider, signDelivery } from './fixtures/integrations/fakepay/index.js';

process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

const fail = (message: string): never => {
  throw new Error(message);
};
const principals = new Map([
  ['payments', ['payments']],
  ['clerk', ['staff']],
]);
const capture = (value: unknown) => captureIntegrations(value, principals, fail);

test('defineIntegration refuses what an App could not use, and a lookalike is not an integration', () => {
  const client = () => ({});
  const refused = (definition: unknown, pattern: RegExp) =>
    assert.throws(
      () => defineIntegration(definition as Parameters<typeof defineIntegration>[0]),
      (error: unknown) => error instanceof IntegrationDeclarationError && pattern.test(error.message),
    );
  refused(
    { name: 'Fake Pay', secrets: [], client, actions: { ping: { input: shape({}), output: shape({}), run: () => ({}) } } },
    /lowercase letters/,
  );
  refused({ name: 'quiet', secrets: [], client }, /declares no actions, webhooks or channel/);
  refused({ name: 'mailer', secrets: [], client, channel: { name: 'email', send: () => ({}) } }, /not "email"/);
  refused(
    { name: 'loose', secrets: [], client, actions: { ping: { input: { kind: 'object' }, output: shape({}), run: () => ({}) } } },
    /shape from @mistriwork\/mistri\/integration/,
  );
  refused({ name: 'extra', secrets: [], client, actions: {}, channel: { name: 'sms', send: () => ({}) }, retries: 9 }, /has no "retries"/);

  assert.throws(() => capture({ use: [{ ...fakepay() }] }), /made by defineIntegration/);
  assert.throws(() => capture({ use: [fakepay(), fakepay()] }), /lists "fakepay" twice/);
});

test("a jobs module's integrations name what exists, by the codes check-codes.md lists", () => {
  const codeOf = (value: unknown) => {
    try {
      capture(value);
    } catch (error) {
      return validationCode((error as Error).message);
    }
    return 'accepted';
  };
  assert.equal(
    codeOf({ use: [fakepay()], webhooks: { stripe: { runAs: 'payments', events: { paid: 'markPaid' } } } }),
    'integration-unknown',
  );
  assert.equal(
    codeOf({ use: [fakepay()], webhooks: { fakepay: { runAs: 'payments', events: { disputed: 'markPaid' } } } }),
    'integration-event-unknown',
  );
  assert.equal(codeOf({ use: [fakepay()], webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markPaid' } } } }), 'accepted');
  assert.throws(
    () => capture({ use: [fakepay()], webhooks: { fakepay: { runAs: 'nobody', events: { paid: 'markPaid' } } } }),
    /principals do not declare/,
  );
  assert.throws(() => capture({ use: [fakepay()], quietHours: { from: '21:00', to: '21:00', timezone: 'UTC' } }), /from and to differ/);
  assert.throws(() => capture({ use: [fakepay()], quietHours: { from: '9pm', to: '08:00', timezone: 'UTC' } }), /24-hour times/);
  assert.throws(() => capture({ use: [fakepay()], editors: 'owner' }), /editors lists the App roles/);
});

test('commands call only declared actions and send only on provided channels; an event runs a service command its payload fills', () => {
  const declared = capture({
    use: [fakepay()],
    webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markPaid', refunded: 'markRefunded' } } },
  });
  const output = { parse: (value: unknown) => value as Record<string, unknown> };
  const registry = defineCommands({
    pay: defineCommand({
      source: 'db',
      target: 'orders',
      input: {},
      integrations: { stripe: ['charge'] },
      lookup: async () => ({}),
      output,
      handle: async () => ({}),
    }),
    void: defineCommand({
      source: 'db',
      target: 'orders',
      input: {},
      // @ts-expect-error -- fakepay declares no "void": a type error here, and still the check's for an App that does not type it
      integrations: { fakepay: ['void'] },
      lookup: async () => ({}),
      output,
      handle: async () => ({}),
    }),
    page: defineCommand({
      source: 'db',
      target: 'orders',
      input: {},
      output,
      effects: { page: send('pager', () => ({ to: 'ops', text: 'up', consent: true })) },
      handle: async () => ({}),
    }),
    markPaid: defineCommand({
      source: 'db',
      target: 'orders',
      targets: 'none',
      input: { charge: { type: 'text' }, amount: { type: 'number' } },
      output,
      handle: async () => ({}),
    }),
    markRefunded: defineCommand({
      source: 'db',
      target: 'orders',
      targets: 'none',
      input: { charge: { type: 'text' }, reason: { type: 'text' } },
      output,
      handle: async () => ({}),
    }),
  });
  const problems = integrationCommandProblems(declared, registry);
  assert.deepEqual(problems.map(validationCode), [
    'integration-unknown',
    'integration-action-unknown',
    'integration-channel-unknown',
    'integration-event-input',
  ]);
  assert.match(problems[1], /fakepay\.void, which integration "fakepay" does not declare\. It declares: charge, refund\./);
  assert.match(problems[3], /may not carry "reason", which the command requires/);

  const app = parseTestApp(
    {
      id: 'shop',
      name: 'Shop',
      sources: { db: { connection: 'shop-db' } },
      resources: { orders: { physical: 'orders', access: 'write' } },
      auth: {
        roles: {
          staff: { read: true, commands: ['markPaid'] },
          payments: { read: true, service: true, commands: ['markPaid'] },
        },
      },
      views: { orders: { kind: 'list', from: 'orders' } },
      home: 'orders',
    },
    'shop.ts',
  );
  const roles = integrationRoleProblems(declared, principals, app);
  assert.deepEqual(roles.map(validationCode), ['integration-service-role']);
  assert.match(roles[0], /"payments" \(roles payments\) is not granted command "markRefunded"/);
  const asClerk = capture({
    use: [fakepay()],
    webhooks: { fakepay: { runAs: 'clerk', events: { paid: 'markPaid' } } },
    editors: ['payments'],
  });
  assert.deepEqual(integrationRoleProblems(asClerk, principals, app), [
    'integrations.editors names "payments", which is not a person\'s role in App "shop": a service enters no secrets.',
    '[integration-service-role] principal "clerk" runs integrations.webhooks "fakepay" event "paid", so every role it holds is a service role ("service": true); "staff" is not.',
  ]);
});

async function openRuntime(t: TestContext, declared: CapturedIntegrations, clock: { now: number }) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-integrations-'));
  const path = join(directory, 'app.db');
  new DatabaseSync(path).close();
  provisionSqliteIntegrations(path);
  const store = await openIntegrationStore({ sqlite: path });
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return createIntegrationRuntime({ appId: 'shop', declared, store, now: () => clock.now });
}

test('a channel message waits out quiet hours, in the recipient zone when it names one, and an opt-in stands for consent', async (t) => {
  resetProvider();
  const declared = capture({ use: [fakepay()], quietHours: { from: '21:00', to: '08:00', timezone: 'America/New_York' } });
  // 02:30 UTC is 22:30 in New York (quiet until 08:00 there, 13:00 UTC) and 11:30 in Tokyo (not quiet).
  const night = Date.UTC(2026, 0, 15, 2, 30);
  assert.equal(quietUntil(declared.quietHours, undefined, night), Date.UTC(2026, 0, 15, 13, 0));
  assert.equal(quietUntil(declared.quietHours, 'Asia/Tokyo', night), night, 'in Tokyo it is midday');
  const clock = { now: night };
  const runtime = await openRuntime(t, declared, clock);
  await saveIntegrationSettings(runtime, 't1', 'owner', {
    integration: 'fakepay',
    secrets: { apiKey: 'sk_t1', webhookSecret: 'whsec_t1' },
  });
  const sender = channelSender(runtime, 'sms');
  const transport = sender.transport(new Set(['notify\neffect.text']));
  let receipt = 0;
  const publish = (message: Record<string, unknown>) =>
    transport({
      envelope: {
        name: 'effect.text',
        commandId: 'notify',
        receiptId: `receipt-${++receipt}`,
        tenantId: 't1',
        payloadJson: JSON.stringify({ body: message }),
      },
      signal: AbortSignal.timeout(5_000),
    } as unknown as EventPublication);

  assert.equal(await publish({ to: '+15550001', text: 'Shipped.', consent: true }), 'accepted');
  assert.equal(await publish({ to: '+15550002', text: 'Shipped.', consent: true, timezone: 'Asia/Tokyo' }), 'accepted');
  assert.deepEqual(
    provider.texts.map(({ to }) => to),
    ['+15550002'],
    'the Tokyo recipient is texted now; the New York one is held',
  );
  const held = await runtime.store.message('shop', effectIdempotencyKey('receipt-1', 'text'));
  assert.equal(held?.state, 'held');
  assert.equal(held?.reason, 'quiet_hours');
  assert.equal(await sender.sendDue(), false, 'nothing is due before 08:00 in New York');
  clock.now = Date.UTC(2026, 0, 15, 13, 0);
  assert.equal(await sender.sendDue(), true);
  assert.deepEqual(
    provider.texts.map(({ to, apiKey }) => [to, apiKey]),
    [
      ['+15550002', 'sk_t1'],
      ['+15550001', 'sk_t1'],
    ],
  );
  // A redelivery of a message already decided changes nothing.
  receipt = 0;
  assert.equal(await publish({ to: '+15550001', text: 'Shipped.', consent: true }), 'accepted');
  assert.equal(provider.texts.length, 2);

  // No consent from the App: suppressed, until the recipient opts in on the channel (a START the webhook records).
  receipt = 10;
  await publish({ to: '+15550003', text: 'Hello.', consent: false });
  assert.equal((await runtime.store.message('shop', effectIdempotencyKey('receipt-11', 'text')))?.reason, 'no_consent');
  const webhooks = createInboundHost({
    endpoints: integrationEndpoints(runtime, {}),
    appId: 'shop',
    principals,
    tenants: true,
    deliveries: runtime.store,
    now: () => clock.now,
    bind: async () => assert.fail('no event is mapped'),
  });
  const server: Server = createServer((req, res) => void webhooks.handle(req, res, new URL(req.url!, 'http://local')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const start = signDelivery('whsec_t1', { id: 'evt_start', type: 'sms.start', data: { from: '+1 (555) 000-3' } }, clock.now);
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/inbound/fakepay/t1`, {
    method: 'POST',
    headers: start.headers,
    body: start.body,
  });
  assert.equal(response.status, 204, 'taken: the opt-in is recorded, though no command is mapped to it');
  await publish({ to: '+15550003', text: 'Hello again.', consent: false });
  assert.deepEqual(provider.texts.at(-1)?.to, '+15550003');
});

test('a held message the provider never takes is tried eight times, a minute apart, then recorded failed', async (t) => {
  resetProvider();
  const declared = capture({ use: [fakepay()], quietHours: { from: '21:00', to: '08:00', timezone: 'America/New_York' } });
  const clock = { now: Date.UTC(2026, 0, 15, 2, 30) };
  const runtime = await openRuntime(t, declared, clock);
  await saveIntegrationSettings(runtime, 't1', 'owner', {
    integration: 'fakepay',
    secrets: { apiKey: 'sk_t1', webhookSecret: 'whsec_t1' },
  });
  const sender = channelSender(runtime, 'sms');
  const transport = sender.transport(new Set(['notify\neffect.text']));
  await transport({
    envelope: {
      name: 'effect.text',
      commandId: 'notify',
      receiptId: 'receipt-poison',
      tenantId: 't1',
      payloadJson: JSON.stringify({ body: { to: '+15550009', text: 'Shipped.', consent: true } }),
    },
    signal: AbortSignal.timeout(5_000),
  } as unknown as EventPublication);
  const key = effectIdempotencyKey('receipt-poison', 'text');
  assert.equal((await runtime.store.message('shop', key))?.reason, 'quiet_hours');
  provider.failNext = 1_000;
  clock.now = Date.UTC(2026, 0, 15, 13, 0);
  for (let tried = 1; tried <= 8; tried++) {
    assert.equal(await sender.sendDue(), true, `try ${tried} is due`);
    const row = await runtime.store.message('shop', key);
    assert.deepEqual([row?.state, row?.attempts], [tried < 8 ? 'held' : 'failed', tried]);
    clock.now += 60_000;
  }
  assert.equal(await sender.sendDue(), false, 'a failed message is not due again');
  assert.equal(provider.calls, 8);
  assert.equal((await runtime.store.message('shop', key))?.reason, 'fakepay did not accept it');
});

test("an integration's webhooks lower onto an inbound endpoint named after it: the package verifies, the mapping decides what runs", async (t) => {
  resetProvider();
  const declared = capture({ use: [fakepay()], webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markPaid' } } } });
  const clock = { now: Date.now() };
  const runtime = await openRuntime(t, declared, clock);
  const [endpoint, ...others] = integrationEndpoints(runtime, { markPaid: { version: 3 } });
  assert.equal(others.length, 0);
  assert.equal(endpoint.name, 'fakepay', 'served at POST /api/inbound/fakepay');
  assert.equal(endpoint.windowMs, 300_000);
  assert.equal(await endpoint.secrets(''), undefined, 'no secrets set: the address answers as one that names nothing');
  await saveIntegrationSettings(runtime, '', 'owner', {
    integration: 'fakepay',
    secrets: { apiKey: 'sk_app', webhookSecret: 'whsec_app' },
  });
  const secrets = (await endpoint.secrets(''))!;
  const delivered = (event: { id: string; type: string; data: unknown }, secret = 'whsec_app') => {
    const signed = signDelivery(secret, event, clock.now);
    return endpoint.verify({ headers: signed.headers, body: Buffer.from(signed.body) }, secrets, clock.now);
  };
  assert.equal(delivered({ id: 'evt_1', type: 'charge.succeeded', data: {} }, 'whsec_other'), undefined);
  const paid = delivered({ id: 'evt_1', type: 'charge.succeeded', data: { charge: 'ch_9', amount: 400 } })!;
  assert.equal(paid.at, Math.floor(clock.now / 1000) * 1000, "the time is the package's: the host holds it to the window");
  const reading = endpoint.read(paid.payload);
  assert.equal(reading.key, 'evt_1', "the event's id is the sender's id: a retry repeats it");
  assert.deepEqual(reading.plan(), {
    run: { command: { id: 'markPaid', version: 3 }, runAs: 'payments', input: { charge: 'ch_9', amount: 400 } },
  });
  assert.notEqual(endpoint.receipts('t1'), endpoint.receipts('t2'), "one tenant's event id is not another's receipt");
  // Providers send many events: one the App does not map is taken and runs nothing; a payload off its shape is 400.
  assert.deepEqual(endpoint.read(delivered({ id: 'evt_2', type: 'charge.refunded', data: { charge: 'ch_9' } })!.payload).plan(), {
    status: 202,
  });
  assert.deepEqual(endpoint.read(delivered({ id: 'evt_3', type: 'invoice.created', data: {} })!.payload).plan(), { status: 202 });
  assert.throws(() => endpoint.read(delivered({ id: 'evt_4', type: 'charge.succeeded', data: { charge: 9 } })!.payload).plan());
  // An opt-out records the recipient's consent, in the delivery's tenant, before any command.
  const stop = endpoint.read(delivered({ id: 'evt_5', type: 'sms.stop', data: { from: '+15550001' } })!.payload).plan();
  assert.equal(stop.status, 204);
  assert.equal(stop.run, undefined);
  await stop.record!('t1', clock.now);
  assert.equal((await runtime.store.consent('shop', 't1', 'sms', channelHolder('+15550001', 'sms')))?.state, 'out');
  assert.equal(await runtime.store.consent('shop', 't2', 'sms', channelHolder('+15550001', 'sms')), undefined);
  // Newest wins: an opt-in after it stands, and the old opt-out resent late (a provider's retry) changes nothing.
  const start = endpoint.read(delivered({ id: 'evt_6', type: 'sms.start', data: { from: '+15550001' } })!.payload).plan();
  await start.record!('t1', clock.now + 1000);
  await stop.record!('t1', clock.now);
  assert.equal((await runtime.store.consent('shop', 't1', 'sms', channelHolder('+15550001', 'sms')))?.state, 'in');
});

test('on a single-App server the settings route says which secrets are set, never a value, and only an editor saves', async (t) => {
  const runtime = await openRuntime(t, capture({ use: [fakepay()], editors: ['owner'] }), { now: Date.now() });
  t.after(registerIntegrationRuntime(runtime));
  // The route as the handler mounts it: one App, signed in, its session's role beside the principal.
  const host = { app: { app: { id: 'shop' } }, auth: {} };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const principal = req.headers['x-principal'] as string | undefined;
    const post = {
      res,
      path: new URL(req.url!, 'http://local').pathname,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
      registry: { configOf: () => undefined },
      connection: 'main',
      appHosts: [host],
      principal,
      role: req.headers['x-role'] as string | undefined,
    } as unknown as PostContext;
    try {
      if (!(await integrationRoutes(post))) res.writeHead(418).end();
    } catch (error) {
      res.writeHead(error instanceof HttpError ? error.status : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/integrations`;
  const call = async (path: string, body: unknown, who?: { principal: string; role: string }) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { 'x-principal': who.principal, 'x-role': who.role } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const owner = { principal: 'ann@example.org', role: 'owner' },
    clerk = { principal: 'bob@example.org', role: 'staff' };

  assert.equal((await call('', {})).status, 401, 'signed out: nothing is said');
  assert.equal((await call('', { tenant: 't1' }, owner)).status, 400, 'a single App has no tenant to name');
  const before = await call('', {}, clerk);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, {
    integrations: [
      {
        name: 'fakepay',
        secrets: [
          { name: 'apiKey', set: false, savedAt: null },
          { name: 'webhookSecret', set: false, savedAt: null },
        ],
        webhook: '/api/inbound/fakepay',
        channel: 'sms',
      },
    ],
    editor: false,
  });
  const secrets = { integration: 'fakepay', secrets: { apiKey: 'sk_live_secret' } };
  assert.equal((await call('/save', secrets, clerk)).status, 403, 'a role editors does not name may not save');
  const refused = await call('/save', { integration: 'nopay', secrets: { apiKey: 'x' } }, owner);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'integration_refused');
  const saved = await call('/save', secrets, owner);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.editor, true);
  const fakepaySettings = (saved.body.integrations as Array<{ secrets: Array<{ name: string; set: boolean }> }>)[0];
  assert.deepEqual(
    fakepaySettings.secrets.map(({ name, set }) => [name, set]),
    [
      ['apiKey', true],
      ['webhookSecret', false],
    ],
  );
  assert.ok(!JSON.stringify(saved.body).includes('sk_live_secret'), 'a value is never sent back');
  assert.equal(await runtime.secrets('', 'fakepay'), undefined, 'a package reads its secrets only once all of them are set');
});

test('a notify rule that sends on a channel queues its message with the write, and the channel decides it after the commit', async (t) => {
  resetProvider();
  // The parse reads `send`; the check holds its channel to one a listed integration provides.
  assert.deepEqual(
    parseNotify([{ on: 'update', title: 'Shipped', send: { channel: 'sms', to: 'phone', consent: 'sms_ok' } }], 'n')[0].send,
    {
      channel: 'sms',
      to: 'phone',
      consent: 'sms_ok',
    },
  );
  assert.throws(() => parseNotify([{ on: 'update', title: 'Shipped', send: { channel: 'sms' } }], 'n'), /"send.to" is a column/);
  const app = {
    id: 'shop',
    resources: { orders: { notify: [{ on: 'update', title: 'Shipped', send: { channel: 'fax', to: 'phone' } }] } },
  };
  assert.match(
    integrationNotifyProblems(capture({ use: [fakepay()] }), app as never)[0],
    /^\[integration-channel-unknown\] .*"fax".* They provide: sms\./,
  );
  assert.deepEqual(integrationNotifyProblems(capture({ use: [fakepay()] }), { ...app, resources: {} } as never), []);

  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-notify-via-'));
  const path = join(directory, 'app.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, phone TEXT, sms_ok INTEGER, tz TEXT);
    INSERT INTO orders VALUES (1, 'open', '+15550001', 1, NULL), (2, 'open', '+15550002', 0, NULL), (3, 'open', '+15550003', 1, 'Asia/Tokyo');`);
  provisionSqliteIntegrations(path);
  const adapter = new SqliteAdapter(path);
  const store = await openIntegrationStore({ sqlite: path });
  t.after(async () => {
    await adapter.close();
    await store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const column = (name: string) => ({ column: name, hops: [] });
  const rule: NoticeRule = {
    app: 'shop',
    on: { kind: 'update', columns: ['status'] },
    when: [[{ column: 'status', values: ['shipped'] }]],
    to: [],
    title: ['Order ', column('id'), ' shipped.'],
    open: { resource: 'orders' },
    uses: [],
    send: { channel: 'sms', to: column('phone'), consent: column('sms_ok'), timezone: column('tz') },
  };
  bindNotices(adapter, new Map([['orders', [rule]]]));
  const ship = (id: number) =>
    attributeWrites({ actor: 'clerk@example.org', name: 'Clerk', via: 'app' }, () =>
      adapter.update({ table: 'orders', key: { id }, values: { status: 'shipped' } }),
    );
  const queued = () =>
    db.prepare('SELECT recipient, text, state, reason, consent, timezone FROM "__mistri_integration_message" ORDER BY recipient').all();

  await assert.rejects(
    adapter.transaction(async (tx) => {
      await tx.update({ table: 'orders', key: { id: 1 }, values: { status: 'shipped' } });
      throw new Error('handler failed');
    }),
    /handler failed/,
  );
  assert.deepEqual(queued(), [], 'a write that rolled back queued nothing');
  for (const id of [1, 2, 3]) await ship(id);
  assert.deepEqual(
    queued().map((row) => ({ ...row })),
    [
      { recipient: '+15550001', text: 'Order 1 shipped.', state: 'held', reason: 'queued', consent: 1, timezone: null },
      { recipient: '+15550002', text: 'Order 2 shipped.', state: 'held', reason: 'queued', consent: 0, timezone: null },
      { recipient: '+15550003', text: 'Order 3 shipped.', state: 'held', reason: 'queued', consent: 1, timezone: 'Asia/Tokyo' },
    ],
  );

  // The next 02:30 UTC after the writes were queued: night in New York (the App's quiet hours), midday in Tokyo.
  const day = new Date(Date.now() + 86_400_000);
  const clock = { now: Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 2, 30) };
  const runtime = createIntegrationRuntime({
    appId: 'shop',
    declared: capture({ use: [fakepay()], quietHours: { from: '21:00', to: '08:00', timezone: 'America/New_York' } }),
    store,
    now: () => clock.now,
  });
  await saveIntegrationSettings(runtime, '', 'owner', {
    integration: 'fakepay',
    secrets: { apiKey: 'sk_app', webhookSecret: 'whsec_app' },
  });
  const sender = channelSender(runtime, 'sms');
  assert.equal(await sender.sendDue(), true);
  assert.deepEqual(
    provider.texts.map(({ to, text }) => [to, text]),
    [['+15550003', 'Order 3 shipped.']],
    'Tokyo is told now; New York waits out the quiet hours; no consent is told nothing',
  );
  const state = () => Object.fromEntries(queued().map((row) => [row.recipient, `${row.state}:${row.reason}`]));
  assert.deepEqual(state(), { '+15550001': 'held:quiet_hours', '+15550002': 'suppressed:no_consent', '+15550003': 'sent:null' });
  clock.now += 10.5 * 3_600_000; // 13:00 UTC: morning in New York, in summer time or not
  await sender.sendDue();
  assert.deepEqual(
    provider.texts.map(({ to }) => to),
    ['+15550003', '+15550001'],
  );
  assert.equal(await sender.sendDue(), false, 'nothing is left to decide');
});

test("a command's calls are typed by the package's actions, and only the ones it declares", () => {
  const output = { parse: (value: unknown) => value as Record<string, unknown> };
  const typed = defineCommand({
    source: 'db',
    target: 'orders',
    input: {},
    integrations: { fakepay: ['charge'] },
    output,
    async lookup({ integrations }) {
      const charged = await integrations.fakepay.charge({ amount: 1200, customer: 'ann' });
      const id: string = charged.id;
      // @ts-expect-error -- the charge's input is { amount, customer }
      void integrations.fakepay.charge({ amount: '12' });
      // @ts-expect-error -- refund is fakepay's, but this command did not declare it
      void integrations.fakepay.refund;
      return id;
    },
    handle: async () => ({}),
  });
  assert.ok(typed);
  // An action the package does not declare is a type error here, and [integration-action-unknown] at check.
  const undeclared = () =>
    defineCommand({
      source: 'db',
      target: 'orders',
      input: {},
      // @ts-expect-error -- fakepay declares no "void" action
      integrations: { fakepay: ['void'] },
      lookup: async () => ({}),
      output,
      handle: async () => ({}),
    });
  assert.equal(typeof undeclared, 'function');
});
