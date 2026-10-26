/**
 * Integrations and effects on a tenant App, through a real enrollment on
 * SQLite: FakePay (test/fixtures/integrations/fakepay) as the vendor package,
 * its webhook behind a node server, its SMS channel and a config webhook
 * delivered by the tenant effect host, and the control connection reading
 * what the database holds.
 *
 * 1. Secrets are each tenant's: a call in North uses North's key, South has
 *    none and is refused "not set up", and a value sealed for one tenant does
 *    not open as another's.
 * 2. A call is journaled under a key the provider dedupes by: replaying the
 *    command, or retrying a call that failed on the way, charges once.
 * 3. The webhook: a bad signature is 401; a good one runs the mapped command
 *    as the service principal, in that tenant, with its grants; the same
 *    delivery again replays its receipt (204); North's delivery at South's address is 401.
 * 4. Effects: a member's command posts to a config webhook and texts on the
 *    channel, each delivered after commit as its tenant; a STOP the provider
 *    sends is honoured on the next text, and a recipient who never agreed
 *    is not texted.
 * 5. The settings screen reads which secrets are set, never a value.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { post, send } from '../packages/mistri/src/server/commands/commandEffects.js';
import { defineJobs } from '../packages/mistri/src/server/jobs/jobModule.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { openSecret, sealSecret } from '../packages/mistri/src/server/integrations/integrationSecrets.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { openTenantIntegrations, type TenantIntegrations } from '../packages/mistri/src/server/tenant/tenantIntegrations.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { webhookConnectionOf } from '../packages/mistri/src/server/webhooks.js';
import { parseTestApp } from './support/commandCatalog.js';
import { fakepay, provider, resetProvider, signDelivery } from './fixtures/integrations/fakepay/index.js';

type Row = Record<string, unknown>;
type Request = { readonly account: string };
const binding = { appId: 'tenant-pay', source: { id: 'business', connection: 'pay-business' }, storeId: 'tenant-pay-store' };
const HOUR = 3_600_000;
process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

const app = parseTestApp(
  {
    id: binding.appId,
    name: 'Tenant pay',
    sources: { business: { connection: binding.source.connection } },
    resources: {
      shop: { owner: 'platform' },
      orders: {
        physical: 'orders',
        access: 'write',
        owner: 'tenant',
        actions: {
          charge: { label: 'Charge', command: { id: 'chargeOrder', version: 1, target: 'orders', input: {} } },
          ship: { label: 'Ship', command: { id: 'shipOrder', version: 1, target: 'orders', input: {} } },
        },
      },
    },
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Shop', profile: 'shop', platform: { label: 'Operator' } },
      roles: {
        staff: { realm: 'tenant', read: true, commands: ['chargeOrder', 'shipOrder'] },
        owner: { realm: 'tenant', read: true, commands: [] },
        payments: { realm: 'tenant', read: true, service: true, commands: ['markPaid'] },
      },
    },
    views: { orders: { kind: 'list', from: 'orders' } },
    home: 'orders',
  },
  'tenant-pay.ts',
);

const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { shop: { kind: 'platform' }, orders: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ orders: true }),
  resolveRows: () => ({ orders: true }),
  resolvePlatformRows: () => ({ shop: true, orders: true }),
  resultReferences: { chargeOrder: () => [], shipOrder: () => [], markPaid: () => [] },
});

type Shipped = { orderId: string; phone: string; consent: boolean };
const output = { parse: (value: unknown) => value as Record<string, unknown> };
const commands = defineCommands({
  // A member's charge: the provider is called before the transaction, and the order records what it answered.
  chargeOrder: defineCommand({
    source: 'business',
    target: 'orders',
    input: {},
    integrations: { fakepay: ['charge'] },
    output,
    async lookup({ record, integrations }) {
      return integrations.fakepay.charge({ amount: Number(record!.amount), customer: String(record!.customer) });
    },
    async handle({ db, record, lookup }) {
      const charged = lookup as { id: string };
      await db.orders.update(record, { status: 'charged', charge_id: charged.id, version: Number(record.version) + 1 });
      return { charge: charged.id };
    },
  }),
  // A member's shipment: the shop's webhook hears of it, and the customer gets a text.
  shipOrder: defineCommand({
    source: 'business',
    target: 'orders',
    input: {},
    output: { parse: (value: unknown) => value as Shipped },
    effects: {
      notify: post<Shipped>('shop-hooks', (value) => ({ orderId: value.orderId })),
      text: send<Shipped>('sms', (value) => ({ to: value.phone, text: `Order ${value.orderId} is on its way.`, consent: value.consent })),
    },
    async handle({ db, record }) {
      await db.orders.update(record, { status: 'shipped', version: Number(record.version) + 1 });
      return { orderId: String(record.id), phone: String(record.phone), consent: Number(record.sms_consent) === 1 };
    },
  }),
  // The provider's "paid": run as the payments service, finding the order by its charge.
  markPaid: defineCommand({
    source: 'business',
    target: 'orders',
    targets: 'none',
    input: { charge: { type: 'text' }, amount: { type: 'number' } },
    output,
    async handle({ db }, input) {
      const order = await db.orders.find({ charge_id: String(input.charge) });
      if (!order) return { found: false };
      await db.orders.update(order, { status: 'paid', version: Number(order.version) + 1 });
      return { found: true };
    },
  }),
});

const jobs = defineJobs(
  {},
  {
    principals: { payments: { roles: ['payments'] } },
    integrations: {
      use: [fakepay()],
      webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markPaid' } } },
      editors: ['owner'],
    },
  },
);

const SCHEMA = `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
  CREATE TABLE shop (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE orders (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES shop(id), customer TEXT NOT NULL,
    phone TEXT NOT NULL, sms_consent INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL, status TEXT NOT NULL,
    charge_id TEXT, version INTEGER NOT NULL DEFAULT 0);
  INSERT INTO shop VALUES ('north', 'North Goods'), ('south', 'South Supply');
  INSERT INTO orders (id, tenant_id, customer, phone, sms_consent, amount, status) VALUES
    ('n1', 'north', 'ann', '+15550001', 1, 1200, 'open'), ('n2', 'north', 'ben', '+15550002', 0, 800, 'open'),
    ('s1', 'south', 'cat', '+15550003', 1, 500, 'open');`;

interface Lab {
  readonly path: string;
  readonly db: DatabaseSync;
  rows(sql: string): Row[];
}

async function openLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-pay-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(SCHEMA);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  // What an operator runs once, with the server stopped: the jobs module's stores (the integrations store
  // among them), and the effects' deliveries on the tenant event store.
  const provisioned = await provisionStores({ sqlite: path }, { app: { tenant: binding, commands }, jobs });
  // A module of only integrations runs no jobs: its integrations store is made, and no job store beside it.
  assert.equal(provisioned.stores.jobs, undefined);
  assert.equal(provisioned.stores.integrations?.provisioned, true);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__mistri_job_%'").all(), []);
  await provisionStores({ sqlite: path }, { app: { tenant: binding, commands } });
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  try {
    const admin = createSqliteTenantAdministration(db, operations, binding);
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const [account, roles] of [
        ['ada', ['staff']],
        ['olu', ['owner']],
      ] as const)
        await admin.putMembership({
          tenantId,
          accountId: account,
          membershipId: `${tenantId}-${account}`,
          status: 'active',
          roles: [...roles],
          validUntil: Date.now() + HOUR,
          expectedVersion: null,
        });
    }
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await operations.finish();
    db.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return {
    path,
    db,
    rows: (sql) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
  };
}

interface Shop {
  enrollment: TenantEnrollment<Request>;
  integrations: TenantIntegrations;
  clock: { now: number };
  hooks: Array<{ body: Row; auth: string | undefined }>;
  deliver(
    tenant: string,
    secret: string,
    event: { id: string; type: string; data: unknown },
    at?: number,
    claimed?: number,
  ): Promise<number>;
  run(tenant: string, command: string, id: string, key: string): Promise<{ replayed: boolean; result: unknown }>;
  saveSecrets(tenant: string, secrets: Record<string, string>): Promise<void>;
}

async function openShop(t: TestContext, lab: Lab): Promise<Shop> {
  resetProvider();
  const hooks: Shop['hooks'] = [];
  const hookServer: Server = createServer((req: IncomingMessage, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      hooks.push({ body: JSON.parse(text) as Row, auth: req.headers.authorization });
      res.writeHead(204).end();
    });
  });
  hookServer.listen(0, '127.0.0.1');
  await once(hookServer, 'listening');
  t.after(() => new Promise<void>((resolve) => hookServer.close(() => resolve())));
  const hookPort = (hookServer.address() as { port: number }).port;

  const enrollment = await createTenantEnrollment<Request>({
    app,
    policy,
    source: { ...binding.source, existingPath: lab.path },
    deployment: 'generation-1',
    roles: ['staff', 'owner', 'payments'],
    maxLifetimeMs: 60_000,
    verifySession: (request) => ({ id: request.account, who: request.account }),
    commands: { registry: commands },
    jobs: { module: jobs },
  });
  t.after(() => enrollment.retire());
  const clock = { now: Date.now() };
  const integrations = await openTenantIntegrations({
    enrollment,
    webhookConfig: (name) =>
      name === 'shop-hooks' ? webhookConnectionOf({ name, kind: 'webhook', url: `http://127.0.0.1:${hookPort}/hook` }, 'test') : undefined,
    now: () => clock.now,
    warn: () => {},
  });
  assert.ok(integrations, 'a deployment with effects and integrations opens them');
  t.after(() => integrations.stop());

  const server: Server = createServer((req, res) => {
    void integrations.handle(req, res, new URL(req.url!, 'http://shop.example.com')).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const versionOf = (id: string) => Number(lab.rows(`SELECT version FROM orders WHERE id = '${id}'`)[0]?.version ?? 0);
  return {
    enrollment,
    integrations,
    clock,
    hooks,
    async deliver(tenant, secret, event, at = clock.now, claimed = at) {
      const delivery = signDelivery(secret, event, at);
      // A captured delivery re-sent with a fresh time in its header: the time is part of what the signature covers.
      if (claimed !== at)
        delivery.headers['fakepay-signature'] = delivery.headers['fakepay-signature'].replace(
          `t=${Math.floor(at / 1000)},`,
          `t=${Math.floor(claimed / 1000)},`,
        );
      const response = await fetch(`${base}/api/inbound/fakepay/${tenant}`, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body,
        signal: AbortSignal.timeout(10_000),
      });
      return response.status;
    },
    async run(tenant, command, id, key) {
      const result = await enrollment.deployment.execute({ account: 'ada' }, [tenant], {
        command,
        commandVersion: 1,
        key: { id },
        expectedVersion: versionOf(id),
        idempotencyKey: key,
        input: {},
      });
      return { replayed: result.replayed, result: result.result };
    },
    async saveSecrets(tenant, secrets) {
      await integrations.settings!.save(tenant, 'olu', { integration: 'fakepay', secrets });
    },
  };
}

const NORTH = { apiKey: 'sk_north', webhookSecret: 'whsec_north' };
const SOUTH = { apiKey: 'sk_south', webhookSecret: 'whsec_south' };

test("each tenant's secrets are its own: North's call uses North's key, South is not set up, and a sealed value opens nowhere else", async (t) => {
  const lab = await openLab(t),
    shop = await openShop(t, lab);
  await shop.saveSecrets('north', NORTH);

  const charged = await shop.run('north', 'chargeOrder', 'n1', 'charge-n1-key-0001-000000');
  assert.deepEqual({ ...(charged.result as object) }, { charge: 'ch_1' });
  assert.deepEqual(
    provider.charges.map(({ apiKey, amount, customer }) => ({ apiKey, amount, customer })),
    [{ apiKey: 'sk_north', amount: 1200, customer: 'ann' }],
  );
  await assert.rejects(shop.run('south', 'chargeOrder', 's1', 'charge-s1-key-0001-000000'), (error: unknown) => {
    assert.match(String((error as { reason?: string }).reason), /fakepay is not set up yet/);
    return true;
  });
  assert.equal(provider.charges.length, 1, 'South was never charged, under any key');
  assert.equal(lab.rows("SELECT status FROM orders WHERE id = 's1'")[0].status, 'open');

  // Sealed under the App, the tenant, the integration and the name: moved to South's row, it opens as nothing.
  const [row] = lab.rows("SELECT sealed FROM __mistri_integration_secret WHERE tenant = 'north' AND name = 'apiKey'");
  assert.doesNotMatch(String(row.sealed), /sk_north/, 'the value is not kept in the clear');
  const place = { app: binding.appId, integration: 'fakepay', name: 'apiKey' };
  assert.equal(openSecret({ ...place, tenant: 'north' }, String(row.sealed)), 'sk_north');
  assert.equal(openSecret({ ...place, tenant: 'south' }, String(row.sealed)), undefined);
  assert.equal(openSecret({ ...place, tenant: 'north', name: 'webhookSecret' }, sealSecret({ ...place, tenant: 'north' }, 'x')), undefined);

  // The settings screen says which are set, and when; never a value.
  const settings = await shop.integrations.settings!.read('north');
  assert.deepEqual(
    settings.integrations.map((entry) => ({ ...entry, secrets: entry.secrets.map(({ name, set }) => ({ name, set })) })),
    [
      {
        name: 'fakepay',
        secrets: [
          { name: 'apiKey', set: true },
          { name: 'webhookSecret', set: true },
        ],
        webhook: '/api/inbound/fakepay/north',
        channel: 'sms',
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(settings), /sk_north|whsec_north/);
  assert.equal(
    (await shop.integrations.settings!.read('south')).integrations[0].secrets.every((secret) => !secret.set),
    true,
  );
});

test('a call is journaled and idempotent: a replayed command and a retried call each charge once', async (t) => {
  const lab = await openLab(t),
    shop = await openShop(t, lab);
  await shop.saveSecrets('north', NORTH);
  // The first two tries fail on the way; the third is answered, inside the one request.
  provider.failNext = 2;
  const first = await shop.run('north', 'chargeOrder', 'n1', 'charge-n1-key-0002-000000');
  assert.equal(provider.calls, 3);
  assert.equal(provider.charges.length, 1);
  const [call] = lab.rows('SELECT tenant, integration, action, command, state, attempts, result_json FROM __mistri_integration_call');
  assert.deepEqual(
    { ...call, result_json: JSON.parse(String(call.result_json)) },
    {
      tenant: 'north',
      integration: 'fakepay',
      action: 'charge',
      command: 'chargeOrder',
      state: 'done',
      attempts: 3,
      result_json: { id: 'ch_1', status: 'succeeded' },
    },
  );
  // The same request again is the receipt's replay: the provider is not asked twice.
  const again = await shop.enrollment.deployment.execute({ account: 'ada' }, ['north'], {
    command: 'chargeOrder',
    commandVersion: 1,
    key: { id: 'n1' },
    expectedVersion: 0,
    idempotencyKey: 'charge-n1-key-0002-000000',
    input: {},
  });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.result, first.result);
  assert.equal(provider.charges.length, 1);
  assert.equal(provider.calls, 3, "a replay is the receipt's: the provider is not asked again");

  // A definite no is recorded with its reason, and answered so again without a second charge.
  provider.decline = true;
  await assert.rejects(shop.run('north', 'chargeOrder', 'n2', 'charge-n2-key-0001-000000'), /declined|ineligible/);
  const calls = provider.calls;
  await assert.rejects(shop.run('north', 'chargeOrder', 'n2', 'charge-n2-key-0001-000000'), (error: unknown) => {
    assert.equal((error as { reason?: string }).reason, 'The card was declined.');
    return true;
  });
  assert.equal(provider.calls, calls, 'the recorded refusal is the answer');
  assert.equal(lab.rows("SELECT state FROM __mistri_integration_call WHERE state = 'refused'").length, 1);
});

test('the webhook: signed by the tenant, run as the service principal in that tenant, a replay refused, another tenant blocked', async (t) => {
  const lab = await openLab(t),
    shop = await openShop(t, lab);
  await shop.saveSecrets('north', NORTH);
  await shop.saveSecrets('south', SOUTH);
  await shop.run('north', 'chargeOrder', 'n1', 'charge-n1-key-0003-000000');
  const paid = { id: 'evt_1', type: 'charge.succeeded', data: { charge: 'ch_1', amount: 1200 } };

  assert.equal(await shop.deliver('north', 'whsec_wrong', paid), 401, 'a bad signature');
  assert.equal(await shop.deliver('north', NORTH.webhookSecret, paid, shop.clock.now - 10 * 60_000), 401, 'outside the window');
  assert.equal(
    await shop.deliver('north', NORTH.webhookSecret, paid, shop.clock.now - 10 * 60_000, shop.clock.now),
    401,
    'a stale delivery re-timed to now: the signature covers the time',
  );
  // North's delivery at South's address does not verify under South's secret, and changes nothing of either's.
  assert.equal(await shop.deliver('south', NORTH.webhookSecret, paid), 401);
  assert.equal(lab.rows("SELECT status FROM orders WHERE id = 'n1'")[0].status, 'charged');

  assert.equal(await shop.deliver('north', NORTH.webhookSecret, paid), 204);
  assert.equal(lab.rows("SELECT status FROM orders WHERE id = 'n1'")[0].status, 'paid');
  const [receipt] = lab.rows("SELECT r.realm, r.tenant_id, r.actor_id FROM __mistri_command_receipt r WHERE r.command_id = 'markPaid'");
  assert.deepEqual(receipt, { realm: 'tenant', tenant_id: 'north', actor_id: 'service:payments' });
  assert.equal(await shop.deliver('north', NORTH.webhookSecret, paid), 204, 'the same delivery again replays its receipt');
  assert.equal(lab.rows("SELECT version FROM orders WHERE id = 'n1'")[0].version, 2, 'and writes nothing');

  // South's own delivery naming North's charge runs in South: it finds nothing of North's to change.
  const crossed = { id: 'evt_2', type: 'charge.succeeded', data: { charge: 'ch_1', amount: 1200 } };
  assert.equal(await shop.deliver('south', SOUTH.webhookSecret, crossed), 204);
  assert.equal(lab.rows("SELECT version FROM orders WHERE id = 'n1'")[0].version, 2);
  // An event the App does not map is taken and dropped; a tenant that does not exist is not found.
  assert.equal(await shop.deliver('north', NORTH.webhookSecret, { id: 'evt_3', type: 'charge.refunded', data: { charge: 'ch_1' } }), 202);
  assert.equal(await shop.deliver('west', NORTH.webhookSecret, { ...paid, id: 'evt_4' }), 404);
});

test("effects are delivered as their tenant: a member's command posts to the shop's webhook and texts with consent, opt-out honoured", async (t) => {
  const lab = await openLab(t),
    shop = await openShop(t, lab);
  await shop.saveSecrets('north', NORTH);
  const settle = async () => {
    for (let step = 0; step < 20 && (await shop.integrations.tick()); step++);
  };

  await shop.run('north', 'shipOrder', 'n1', 'ship-n1-key-0001-000000');
  await settle();
  assert.deepEqual(
    shop.hooks.map(({ body }) => ({ tenant: body.tenant, effect: body.effect, command: body.command, payload: body.payload })),
    [{ tenant: 'north', effect: 'notify', command: 'shipOrder', payload: { orderId: 'n1' } }],
  );
  assert.deepEqual(
    provider.texts.map(({ apiKey, to, text }) => ({ apiKey, to, text })),
    [{ apiKey: 'sk_north', to: '+15550001', text: 'Order n1 is on its way.' }],
  );

  // Ben never agreed: his text is suppressed, logged, and never reaches the provider.
  await shop.run('north', 'shipOrder', 'n2', 'ship-n2-key-0001-000000');
  await settle();
  assert.equal(provider.texts.length, 1);

  // Ann replies STOP; the provider tells us; her next text is suppressed.
  assert.equal(await shop.deliver('north', NORTH.webhookSecret, { id: 'evt_stop', type: 'sms.stop', data: { from: '+1 555 0001' } }), 204);
  lab.db.exec("UPDATE orders SET status = 'open' WHERE id = 'n1'");
  await shop.run('north', 'shipOrder', 'n1', 'ship-n1-key-0002-000000');
  await settle();
  assert.equal(provider.texts.length, 1);
  assert.deepEqual(
    lab
      .rows('SELECT tenant, recipient, state, reason FROM __mistri_integration_message ORDER BY recipient, state')
      .map((row) => ({ ...row })),
    [
      { tenant: 'north', recipient: '+15550001', state: 'sent', reason: null },
      { tenant: 'north', recipient: '+15550001', state: 'suppressed', reason: 'opted_out' },
      { tenant: 'north', recipient: '+15550002', state: 'suppressed', reason: 'no_consent' },
    ],
  );
});
