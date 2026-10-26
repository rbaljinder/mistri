/**
 * Effects: a command's POST to a webhook, written beside its receipt and sent
 * only after it commits. The webhook connection's rules (https, or http to
 * this machine; no credential in the URL; `${VAR}` credentials), the
 * definition's (a post() effect, the `effect.` event names the platform's),
 * and delivery over a real loopback receiver: the body and Idempotency-Key a
 * webhook sees, a 5xx retried after backoff, a 4xx failed and redriven from
 * maintenance, readiness, and an answer whose body is never read.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_EVENT_TABLES } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { appCommandEventsFor } from '../packages/mistri/src/server/commands/appCommandEvents.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  refuse,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { callHeaders, effectIdempotencyKey, post, webhookTransport } from '../packages/mistri/src/server/commands/commandEffects.js';
import { id, literal, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { effectDeployment, openEffectHost } from '../packages/mistri/src/server/effects/effectHost.js';
import { inspectEventDeliveries, provisionStores, redriveEventDeliveries } from '../packages/mistri/src/server/maintenance.js';
import { openWebhook, webhookConnectionOf } from '../packages/mistri/src/server/webhooks.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

test('a webhook connection is https, or http to this machine, with its credential in auth', () => {
  const at = 'config.json: connection "dealer-hooks"';
  const hook = (overrides: Record<string, unknown> = {}) => ({
    name: 'dealer-hooks',
    kind: 'webhook',
    url: 'https://hooks.example/tablewalk',
    ...overrides,
  });
  assert.deepEqual(webhookConnectionOf(hook({ auth: { bearer: '${HOOK_TOKEN}' } }), at), {
    kind: 'webhook',
    name: 'dealer-hooks',
    url: 'https://hooks.example/tablewalk',
    auth: { bearer: '${HOOK_TOKEN}' },
  });
  assert.equal(webhookConnectionOf(hook({ url: 'http://127.0.0.1:8080/hook' }), at).url, 'http://127.0.0.1:8080/hook');
  assert.equal(webhookConnectionOf(hook({ url: 'http://localhost/hook' }), at).url, 'http://localhost/hook');
  // Still a reference: checked when it opens, once the environment has said what it is.
  assert.equal(webhookConnectionOf(hook({ url: '${HOOK_URL}' }), at).url, '${HOOK_URL}');
  const refusals: Array<[Record<string, unknown>, RegExp]> = [
    [hook({ url: 'http://hooks.example/tablewalk' }), /plain http reaches only this machine/],
    [hook({ url: 'https://user:pw@hooks.example/' }), /credential or a query in its "url"/],
    [hook({ url: 'https://hooks.example/?token=1' }), /credential or a query in its "url"/],
    [hook({ insecure: true }), /takes no "insecure"/],
    [hook({ allowLinkLocal: true }), /takes no "allowLinkLocal"/],
    [hook({ name: 'Dealer hooks' }), /whose name is what a command's post\(\) names/],
    [hook({ auth: { token: 'x' } }), /an "auth" mistri cannot read/],
    [hook({ auth: { header: 'Idempotency-Key', value: 'x' } }), /not a header a credential can travel in/],
  ];
  for (const [entry, refusal] of refusals) assert.throws(() => webhookConnectionOf(entry, at), refusal);
});

const output = shape({ id: id(), status: literal('reserved') });
const reserve = (effects = true, options?: Parameters<typeof post>[2]) =>
  defineCommand({
    source: 'shop',
    target: 'vehicle',
    when: 'status = available',
    input: {},
    output,
    ...(effects
      ? {
          effects: {
            notify: post<{ id: number; status: 'reserved' }>(
              'dealer-hooks',
              (result) => ({ vehicleId: result.id, status: result.status }),
              options,
            ),
          },
        }
      : {}),
    async handle({ db, record }) {
      if (record!.stock === 'HOLD') refuse('forbidden');
      const updated = await db.vehicle.update(record!, { status: 'reserved' });
      return { id: updated.id as number, status: 'reserved' as const };
    },
  });

test('post() takes envelope: false and per-call headers, and nothing else', () => {
  const bare = (options: unknown) => () => post('slack', () => ({ text: 'hi' }), options as never);
  assert.doesNotThrow(bare({ envelope: false }));
  assert.doesNotThrow(bare({ envelope: false, headers: () => ({ 'Idempotency-Key': 'k-1' }) }));
  assert.throws(bare({ envelope: true }), /envelope is false/);
  assert.throws(bare({ headers: () => ({}) }), /envelope is false/);
  assert.throws(bare({ envelope: false, retries: 3 }), /options are \{ envelope: false, headers\? \}/);
  assert.throws(bare({ envelope: false, headers: {} }), /headers is a function/);
  // A call's headers are checked when the command's output is projected, so a bad one stops the command before it commits.
  const effects = {
    notify: post<{ id: number }>('slack', (out) => ({ text: String(out.id) }), { envelope: false, headers: () => ({ host: 'elsewhere' }) }),
  };
  assert.doesNotThrow(() =>
    defineCommand({ source: 'shop', target: 'vehicle', input: {}, output: shape({ id: id() }), effects, handle: () => ({ id: 1 }) }),
  );
});

test("an effect is a post() to a named webhook, and the effect. event names are the platform's", () => {
  assert.throws(() => post('Dealer hooks', () => ({})), /names a webhook connection/);
  assert.throws(
    () =>
      defineCommand({
        source: 'shop',
        target: 'vehicle',
        input: {},
        output,
        effects: { notify: { destination: 'dealer-hooks' } as never },
        handle: () => ({ id: 1, status: 'reserved' as const }),
      }),
    /not a post\(\.\.\.\) or send\(\.\.\.\) effect/,
  );
  const theirs = defineEvent('effect.notify', shape({ id: id() }));
  assert.throws(
    () =>
      defineCommand({
        source: 'shop',
        target: 'vehicle',
        input: {},
        output,
        events: { mine: defineEventProjection<{ id: number }, { id: number }>(theirs, (value) => ({ id: value.id })) },
        handle: () => ({ id: 1, status: 'reserved' as const }),
      }),
    /"effect\." is the platform's/,
  );
});

interface Received {
  method: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `effects_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(
  dialect: TenantDialect,
  run: (f: {
    effectRows: () => Promise<unknown[]>;
    target: Parameters<typeof inspectEventDeliveries>[0];
    received: Received[];
    answer: (...statuses: number[]) => void;
    clock: { now: number };
    execute: (key: number | string, request?: Record<string, unknown>) => Promise<{ receiptId: string; replayed: boolean }>;
    host: Awaited<ReturnType<typeof openEffectHost>>;
    deployment: NonNullable<ReturnType<typeof effectDeployment>>;
  }) => Promise<void>,
  options?: Parameters<typeof post>[2],
) {
  const setup = `CREATE TABLE db_item (id INTEGER PRIMARY KEY, stock TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO db_item VALUES (1, 'FC-1', 'available', 0), (2, 'HOLD', 'available', 0), (3, 'FC-3', 'available', 0), (4, 'FC-4', 'available', 0);`;
  const engine = await openTenantEngine(dialect, { tables: ['db_item'], sqlite: setup, postgres: setup, database: DATABASE });
  const target = dialect === 'sqlite' ? { sqlite: engine.path } : { postgres: engine.url };
  const registry = new Registry();
  const received: Received[] = [];
  const queue: number[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method ?? '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      // Six megabytes of something that is not JSON: past egress's cap, were the answer ever read.
      response.writeHead(queue.shift() ?? 200, { 'content-type': 'text/html' });
      response.end('<p>' + 'x'.repeat(6 * 1024 * 1024) + '</p>');
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.EFFECTS_TEST_TOKEN = 'hook-token-from-env';
  let host: Awaited<ReturnType<typeof openEffectHost>> | undefined;
  try {
    await engine.migrateCommandJournal();
    const commands = defineCommands({ reserve: reserve(true, options) });
    const provisioned =
      dialect === 'sqlite'
        ? await provisionStores({ sqlite: engine.path }, { app: { id: 'shop', commands } })
        : await provisionStores({ postgres: engine.url }, { app: { id: 'shop', commands } });
    assert.deepEqual(
      provisioned.destinations.map((each) => each.added),
      [true],
    );
    registry.add({ id: 'private-db', name: 'Shop', url: engine.path || engine.url, writable: true, source: 'config' });
    const app = parseAppConfig(
      {
        id: 'shop',
        name: 'Shop',
        sources: { shop: { connection: 'private-db' } },
        resources: { vehicle: { physical: engine.id('db_item'), access: 'write' } },
        auth: { roles: { staff: { read: true, commands: ['reserve'] } } },
        views: { vehicles: { kind: 'list', from: 'vehicle' } },
        home: 'vehicles',
      },
      'effects fixture',
    );
    const resources = await loadAppRuntimeResources(registry, app, 'private-db');
    const events = await appCommandEventsFor(app, commands, resources, (id) => registry.configOf(id)?.url);
    assert.ok(events, "a command with effects writes into the App's event store");
    const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true, events });
    const clock = { now: Date.parse('2026-09-13T12:00:00Z') };
    const execute = async (key: number | string, request: Record<string, unknown> = {}) => {
      const result = await executeBusinessCommand(
        binding,
        { id: 'account-a', appId: 'shop', roles: ['staff'] },
        {
          command: 'reserve',
          commandVersion: 1,
          key: { id: Number(key) },
          expectedVersion: 0,
          idempotencyKey: `effects-request-${key}`,
          input: {},
          ...request,
        },
        { now: () => new Date(clock.now) },
      );
      return { receiptId: result.receiptId, replayed: result.replayed };
    };
    const deployment = effectDeployment({ appId: 'shop', commands })!;
    const webhook = openWebhook(
      webhookConnectionOf(
        { name: 'dealer-hooks', kind: 'webhook', url: `http://127.0.0.1:${port}/hook`, auth: { bearer: '${EFFECTS_TEST_TOKEN}' } },
        'effects fixture',
      ),
    );
    host = await openEffectHost({ deployment, target, webhooks: new Map([['dealer-hooks', webhook]]), now: () => clock.now });
    const effectRows = async () =>
      (await engine.all(`SELECT envelope_json FROM "${COMMAND_EVENT_TABLES.event}"`)).map(
        (row) => JSON.parse(String(row.envelope_json)).name,
      );
    await run({ effectRows, target, received, answer: (...statuses) => queue.push(...statuses), clock, execute, host, deployment });
  } finally {
    await host?.stop();
    delete process.env.EFFECTS_TEST_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await registry.closeAll();
    await engine.close();
  }
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`command effects on ${dialect}`, { skip }, () => {
    test('the effect is written with the receipt, sent only after commit, never twice for a replay, and never for a refusal', async () => {
      await fixture(dialect, async (f) => {
        const first = await f.execute(1);
        assert.deepEqual(await f.effectRows(), ['effect.notify']);
        // The replay answers its receipt and writes nothing again; the refusal writes nothing at all.
        assert.equal((await f.execute(1)).replayed, true);
        await assert.rejects(
          f.execute(2),
          (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'forbidden',
        );
        assert.deepEqual(await f.effectRows(), ['effect.notify']);
        assert.equal(f.received.length, 0, 'nothing is sent from inside the command');
        await f.host.tick();
        assert.equal(f.received.length, 1);
        const [sent] = f.received;
        assert.equal(sent.method, 'POST');
        assert.equal(sent.headers['content-type'], 'application/json');
        assert.equal(sent.headers.authorization, 'Bearer hook-token-from-env');
        assert.equal(sent.headers['idempotency-key'], effectIdempotencyKey(first.receiptId, 'notify'));
        assert.deepEqual(sent.body, {
          effect: 'notify',
          command: 'reserve',
          receipt: first.receiptId,
          occurredAt: '2026-09-13T12:00:00.000Z',
          payload: { vehicleId: 1, status: 'reserved' },
        });
        // Accepted, though its six-megabyte answer was never read.
        const [delivered] = (await inspectEventDeliveries(f.target, f.deployment.destinations[0].policy)).rows;
        assert.equal(delivered.state, 'delivered');
        assert.deepEqual(f.host.readiness(), [{ name: 'effects', state: 'ready', code: 'ok' }]);
      });
    });

    test('a 5xx is asked again after backoff with the same key; a 4xx is asked again until its attempts are spent, then fails, readiness says so, and a redrive sends it again', async () => {
      await fixture(dialect, async (f) => {
        const policy = f.deployment.destinations[0].policy;
        const { receiptId } = await f.execute(3);
        f.answer(503);
        await f.host.tick();
        let [row] = (await inspectEventDeliveries(f.target, policy)).rows;
        // A send that threw is ambiguous: the store settles it `unknown` and asks
        // again after backoff (`retry` is what an operator's redrive writes).
        assert.equal(row.state, 'unknown');
        assert.deepEqual(
          f.host.readiness(),
          [{ name: 'effects', state: 'ready', code: 'ok' }],
          'a retryable ambiguous delivery has not exhausted its budget',
        );
        f.clock.now += 5_000;
        await f.host.tick();
        [row] = (await inspectEventDeliveries(f.target, policy)).rows;
        assert.equal(row.state, 'delivered');
        assert.deepEqual(
          f.received.map((each) => each.headers['idempotency-key']),
          [effectIdempotencyKey(receiptId, 'notify'), effectIdempotencyKey(receiptId, 'notify')],
        );

        await f.execute(4);
        f.answer(400);
        f.clock.now += 10_000;
        await f.host.tick();
        // A 4xx is rejected like any event destination's: asked again with
        // backoff, and failed only once its attempts are spent.
        assert.equal((await inspectEventDeliveries(f.target, policy, { state: 'retry' })).rows.length, 1);
        for (let attempt = 2; attempt <= policy.limits.maxAttempts; attempt++) {
          f.answer(400); // an answer is for one request; the webhook keeps refusing
          f.clock.now += policy.limits.maxBackoffMs;
          await f.host.tick();
        }
        const failed = (await inspectEventDeliveries(f.target, policy, { state: 'failed' })).rows;
        assert.equal(failed.length, 1, 'a 4xx fails once its attempts are spent');
        f.clock.now += 10_000;
        await f.host.tick();
        assert.deepEqual(f.host.readiness(), [{ name: 'effects', state: 'degraded', code: 'work_failed' }]);
        await redriveEventDeliveries(f.target, policy, { eventIds: [failed[0].eventId], operator: 'ops@example.test' });
        // An operator's redrive is stamped by the wall clock; the host's clock
        // reaches it before the resend is due.
        f.clock.now = Math.max(f.clock.now, Date.now()) + 1;
        await f.host.tick();
        assert.equal((await inspectEventDeliveries(f.target, policy, { state: 'failed' })).rows.length, 0);
        // The 503 and its retry, every attempt of the 4xx, then the redrive's.
        assert.equal(f.received.length, 2 + policy.limits.maxAttempts + 1);
      });
    });

    test("envelope: false sends the projection itself, with the call's own headers and Idempotency-Key", async () => {
      await fixture(
        dialect,
        async (f) => {
          await f.execute(1);
          await f.host.tick();
          const [sent] = f.received;
          assert.deepEqual(sent.body, { vehicleId: 1, status: 'reserved' }, 'the body is the projection, not the envelope');
          assert.equal(sent.headers['content-type'], 'application/json');
          assert.equal(sent.headers.authorization, 'Bearer hook-token-from-env');
          assert.equal(sent.headers['x-trace'], 'vehicle-1');
          assert.equal(sent.headers['idempotency-key'], 'reserve-1', "the provider's key replaces the platform's");
          const [delivered] = (await inspectEventDeliveries(f.target, f.deployment.destinations[0].policy)).rows;
          assert.equal(delivered.state, 'delivered');
        },
        {
          envelope: false,
          headers: (out) => {
            const { id } = out as { id: number };
            return { 'Idempotency-Key': `reserve-${id}`, 'X-Trace': `vehicle-${id}` };
          },
        },
      );
    });

    test('a bad call header stops the command before it commits, so nothing is written or sent', async () => {
      await fixture(
        dialect,
        async (f) => {
          await assert.rejects(f.execute(1));
          assert.deepEqual(await f.effectRows(), []);
          await f.host.tick();
          assert.equal(f.received.length, 0);
        },
        { envelope: false, headers: () => ({ 'content-length': '1' }) },
      );
    });
  });

test('a webhook destination nobody provisioned refuses to open, naming the step', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-effects-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'CREATE TABLE vehicle (id INTEGER PRIMARY KEY, stock TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);',
    );
    migrateSqliteCommandJournal(path);
    const deployment = effectDeployment({ appId: 'shop', commands: defineCommands({ reserve: reserve() }) })!;
    assert.equal(effectDeployment({ appId: 'shop', commands: defineCommands({ reserve: reserve(false) }) }), undefined);
    const webhook = openWebhook(webhookConnectionOf({ name: 'dealer-hooks', kind: 'webhook', url: 'http://127.0.0.1:9/hook' }, 'test'));
    await assert.rejects(
      openEffectHost({ deployment, target: { sqlite: path }, webhooks: new Map([['dealer-hooks', webhook]]) }),
      /could not be opened and attested\. Provision it once, with the server stopped: `mistri migrate stores up --app/,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a webhook call never leaves the connection's base path, even through an encoded dot segment", async () => {
  const webhook = openWebhook(webhookConnectionOf({ name: 'dealer-hooks', kind: 'webhook', url: 'http://127.0.0.1:9/v1/tenant' }, 'test'));
  // URL parsing reads `%2e%2e` as `..`: each of these would have reached /v1/admin or /x under the connection's credential.
  for (const path of ['/%2e%2e/admin', '/%2E%2e/%2e%2e/x', '/.%2e/x', '/../admin', '//elsewhere.example/x']) {
    await assert.rejects(webhook.call!({ method: 'GET', path }, 'key'), /stays inside the connection's address/, path);
  }
  // A dot segment that stays under the base is the base's own address, not an escape: it reaches the network (port 9 refuses).
  await assert.rejects(webhook.call!({ method: 'GET', path: '/a/%2e/b' }, 'key'), (error: Error) => !/stays inside/.test(error.message));
});

test("a connection's own auth header is the request's: no call or effect can set or replace it", async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const webhook = openWebhook(
      webhookConnectionOf(
        { name: 'bureau', kind: 'webhook', url: `http://127.0.0.1:${port}/v1`, auth: { header: 'X-Api-Key', value: 'the-key' } },
        'test',
      ),
    );
    assert.equal(webhook.credentialHeader, 'x-api-key');
    // The check both paths use: a workflow host refuses w.call with it, and an effect's delivery is rejected by it.
    assert.throws(() => callHeaders({ 'X-API-KEY': 'mine' }, webhook.credentialHeader), /does not own/);
    assert.deepEqual(callHeaders({ 'X-Trace': 'a' }, webhook.credentialHeader), { 'x-trace': 'a' });

    // An effect whose headers name it is rejected for an operator, and nothing is sent.
    const transport = webhookTransport({ webhook, routed: new Set(['reserve\neffect.notify']) });
    const envelope = {
      name: 'effect.notify',
      commandId: 'reserve',
      receiptId: 'r-1',
      occurredAt: '2026-10-21T00:00:00.000Z',
      payloadJson: JSON.stringify({ bare: true, body: { a: 1 }, headers: { 'x-api-key': 'mine' } }),
    };
    assert.equal(await transport({ envelope } as never), 'rejected');
    assert.equal(seen.length, 0);

    // Should a call's headers ever arrive unchecked, the credential is still the connection's.
    await webhook.call!({ method: 'POST', path: '/score', headers: { 'x-api-key': 'mine', 'x-trace': 'a' } }, 'key-1');
    await webhook.post({ a: 1 } as never, 'key-2', { 'x-api-key': 'mine' });
    assert.deepEqual(
      seen.map((headers) => [headers['x-api-key'], headers['idempotency-key']]),
      [
        ['the-key', 'key-1'],
        ['the-key', 'key-2'],
      ],
    );
    assert.equal(seen[0]!['x-trace'], 'a');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
