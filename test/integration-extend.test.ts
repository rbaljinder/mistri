/**
 * `extendIntegration`: a second feature added to a vendor's integration
 * without a second name. The result is one integration to core: one set of
 * sealed keys (the base's, per tenant), one webhook address, the base's
 * signature check. The refusals are at load, and the same ones in a jobs
 * module (which `mistri check` loads). The path from a stored row to an
 * extension's action and event runs on SQLite and on PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  openIntegrationStore,
  provisionPostgresIntegrations,
  provisionSqliteIntegrations,
} from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import {
  defineIntegration,
  extendIntegration,
  IntegrationDeclarationError,
  shape,
  text,
} from '../packages/mistri/src/server/integration.js';
import { captureIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import { capturedIntegration } from '../packages/mistri/src/server/integrations/integrationModule.js';
import { integrationEndpoints } from '../packages/mistri/src/server/integrations/integrationInbound.js';
import {
  createIntegrationRuntime,
  integrationCalls,
  registerIntegrationRuntime,
  saveIntegrationSettings,
} from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { defineJobs } from '../packages/mistri/src/server/jobs/jobModule.js';
import { liveSkip } from './live.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';
import { fakepay, provider, resetProvider, signDelivery } from './fixtures/integrations/fakepay/index.js';

process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

const fail = (message: string): never => {
  throw new Error(message);
};
const principals = new Map([['payments', ['payments']]]);
const capture = (value: unknown) => captureIntegrations(value, principals, fail);

/* What a second feature of the same vendor adds: a void action and a dispute event, and nothing of its own to sign with. */
const voids: Array<{ apiKey: string; charge: string; idempotencyKey: string }> = [];
const plus = () =>
  extendIntegration(fakepay(), {
    actions: {
      void: {
        input: shape({ charge: text() }),
        output: shape({ id: text() }),
        /* `client` and the call are typed by the base: tsc over this file is the check that they stay so. */
        run(client, input: { charge: string }, { idempotencyKey }) {
          voids.push({ apiKey: client.apiKey, charge: input.charge, idempotencyKey });
          return { id: `vo_${voids.length}` };
        },
      },
    },
    webhooks: { events: { disputed: { type: 'charge.disputed', payload: shape({ charge: text() }) } } },
  });

const refused = (run: () => unknown, pattern: RegExp) =>
  assert.throws(run, (error: unknown) => error instanceof IntegrationDeclarationError && pattern.test(error.message));

test("an extension adds and never overrides: what is the base's to say is refused where it is declared", () => {
  const base = fakepay();
  const action = { input: shape({}), output: shape({}), run: () => ({}) };
  const event = (type: string) => ({ type, payload: shape({ charge: text() }) });
  refused(
    () => extendIntegration(base, { actions: { charge: action } }),
    /action "charge" is the base's: an extension adds and never overrides/,
  );
  refused(() => extendIntegration(base, { webhooks: { events: { paid: event('charge.x') } } }), /event "paid" is the base's/);
  refused(
    () => extendIntegration(base, { webhooks: { events: { late: event('charge.succeeded') } } }),
    /type "charge.succeeded" is another event's: one name per type/,
  );
  for (const key of ['name', 'secrets', 'client', 'channel', 'retries'])
    refused(
      () => extendIntegration(base, { actions: { ping: action }, [key]: key === 'secrets' ? ['extra'] : {} } as never),
      new RegExp(`has no "${key}"`),
    );
  refused(
    () => extendIntegration(base, { webhooks: { verify: () => null, events: { late: event('charge.late') } } } as never),
    /webhooks has no "verify".*verify and signing/,
  );
  refused(
    () => extendIntegration(base, { webhooks: { signing: 'apiKey', events: { late: event('charge.late') } } } as never),
    /webhooks has no "signing"/,
  );
  refused(() => extendIntegration(base, {}), /declares no actions or webhook events/);
  refused(
    () =>
      extendIntegration(defineIntegration({ name: 'plain', secrets: [], client: () => ({}), actions: { ping: action } }), {
        webhooks: { events: { late: event('charge.late') } },
      }),
    /the base declares none: there is no signature check/,
  );
  refused(() => extendIntegration({ ...base } as never, { actions: { ping: action } }), /made by defineIntegration or extendIntegration/);
});

test('an extension is the base with more: its name, secrets, signature check and channel, and it chains', () => {
  const once = plus();
  const twice = extendIntegration(once, {
    actions: { audit: { input: shape({}), output: shape({ ok: text() }), run: () => ({ ok: 'yes' }) } },
  });
  const base = capturedIntegration(fakepay()),
    one = capturedIntegration(once),
    two = capturedIntegration(twice);
  assert.equal(twice.name, 'fakepay');
  assert.deepEqual([one.name, one.secrets, one.channel?.name], [base.name, base.secrets, 'sms']);
  assert.equal(one.webhooks?.signing, 'webhookSecret');
  assert.deepEqual([...one.actions.keys()], ['charge', 'refund', 'void']);
  assert.deepEqual([...one.webhooks!.events.keys()], ['paid', 'refunded', 'stopped', 'started', 'disputed']);
  assert.deepEqual([...two.actions.keys()], ['charge', 'refund', 'void', 'audit']);
  assert.equal(two.base, one, 'the WeakMap records the base');
  assert.equal(one.base?.base, undefined);
  /* The extension's events are checked on the one chain: a second extension may not take the first one's name or type. */
  refused(
    () => extendIntegration(once, { webhooks: { events: { disputed: { type: 'charge.other', payload: shape({ charge: text() }) } } } }),
    /event "disputed" is the base's/,
  );
  refused(
    () => extendIntegration(once, { actions: { void: { input: shape({}), output: shape({}), run: () => ({}) } } }),
    /action "void" is the base's/,
  );
});

test('an App lists the extension and not its base, in a jobs module as in capture, which is what check loads', () => {
  const base = fakepay();
  const listed =
    (...use: unknown[]) =>
    () =>
      capture({ use });
  const inModule =
    (...use: unknown[]) =>
    () =>
      defineJobs({}, { principals: { payments: { roles: ['payments'] } }, integrations: { use } } as never);
  const extension = extendIntegration(base, { actions: { audit: { input: shape({}), output: shape({}), run: () => ({}) } } });
  const sibling = extendIntegration(base, { actions: { note: { input: shape({}), output: shape({}), run: () => ({}) } } });
  const further = extendIntegration(extension, { actions: { trace: { input: shape({}), output: shape({}), run: () => ({}) } } });
  const together = /lists "fakepay" more than once.*List the extension only/;
  for (const enter of [listed, inModule]) {
    assert.throws(enter(base, extension), together);
    assert.throws(enter(extension, base), together);
    assert.throws(enter(extension, sibling), together);
    assert.throws(enter(further, base), together);
    assert.throws(enter(base, further), together);
    assert.throws(enter(extension, extension), /lists "fakepay" twice/);
    assert.throws(enter(fakepay(), fakepay()), /lists "fakepay" twice/);
    assert.doesNotThrow(enter(extension));
    assert.doesNotThrow(enter(further));
  }
  assert.deepEqual([...capture({ use: [further] }).use.keys()], ['fakepay']);
});

interface Engine {
  readonly name: 'sqlite' | 'postgres';
  readonly skip: false | string;
  open(t: TestContext): Promise<Awaited<ReturnType<typeof openIntegrationStore>>>;
}
const engines: readonly Engine[] = [
  {
    name: 'sqlite',
    skip: false,
    async open(t) {
      const directory = mkdtempSync(join(tmpdir(), 'mistri-integration-extend-'));
      const path = join(directory, 'app.db');
      new DatabaseSync(path).close();
      provisionSqliteIntegrations(path);
      const store = await openIntegrationStore({ sqlite: path });
      t.after(async () => {
        await store.close();
        rmSync(directory, { recursive: true, force: true });
      });
      return store;
    },
  },
  {
    name: 'postgres',
    skip: liveSkip('postgres', LIVE_PG),
    async open(t) {
      const url = await ownedPostgresDatabase();
      await provisionPostgresIntegrations(url);
      const store = await openIntegrationStore({ postgres: url });
      t.after(() => store.close());
      return store;
    },
  },
];

for (const engine of engines) {
  test(
    `on ${engine.name}, one stored row serves the base and its extension: the action's secrets, the event's signature and address`,
    { skip: engine.skip },
    async (t) => {
      resetProvider();
      voids.length = 0;
      const app = `shop-${randomUUID()}`,
        tenant = `t-${randomUUID()}`;
      const declared = capture({
        use: [plus()],
        webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markPaid', disputed: 'markDisputed' } } },
      });
      const clock = { now: Date.now() };
      const runtime = createIntegrationRuntime({ appId: app, declared, store: await engine.open(t), now: () => clock.now });
      t.after(registerIntegrationRuntime(runtime));
      const secret = `whsec_${randomUUID().replaceAll('-', '')}`;
      await saveIntegrationSettings(runtime, tenant, 'owner', {
        integration: 'fakepay',
        secrets: { apiKey: 'sk_ext_key', webhookSecret: secret },
      });

      // The extension's action is handed the base's client, made from the base's decrypted secrets.
      const { fakepay: calls } = integrationCalls({
        appId: app,
        tenant,
        commandId: 'void-charge',
        actorId: 'clerk',
        idempotencyKey: randomUUID(),
        signal: AbortSignal.timeout(10_000),
        declared: { fakepay: ['void', 'charge'] },
      });
      assert.deepEqual(await calls.void({ charge: 'ch_7' }), { id: 'vo_1' });
      assert.deepEqual([voids[0].apiKey, voids[0].charge], ['sk_ext_key', 'ch_7']);
      await calls.charge({ amount: 500, customer: 'ann' });
      assert.equal(provider.charges[0].apiKey, 'sk_ext_key', "the base's own action reads the same row");

      // The extension's event arrives at the base's address, signed with the base's secret, and applies.
      const [endpoint, ...others] = integrationEndpoints(runtime, { markPaid: { version: 1 }, markDisputed: { version: 2 } });
      assert.equal(others.length, 0, "one endpoint: the base name's");
      assert.equal(endpoint.name, 'fakepay');
      const secrets = (await endpoint.secrets(tenant))!;
      const delivered = (event: { id: string; type: string; data: unknown }, signedWith = secret) => {
        const signed = signDelivery(signedWith, event, clock.now);
        return endpoint.verify({ headers: signed.headers, body: Buffer.from(signed.body) }, secrets, clock.now);
      };
      const id = `evt_${randomUUID()}`;
      assert.equal(delivered({ id, type: 'charge.disputed', data: { charge: 'ch_7' } }, 'whsec_someone_elses_0123456789'), undefined);
      const disputed = delivered({ id, type: 'charge.disputed', data: { charge: 'ch_7' } })!;
      assert.deepEqual(endpoint.read(disputed.payload).plan(), {
        run: { command: { id: 'markDisputed', version: 2 }, runAs: 'payments', input: { charge: 'ch_7' } },
      });
      const paid = delivered({ id: `evt_${randomUUID()}`, type: 'charge.succeeded', data: { charge: 'ch_8', amount: 400 } })!;
      assert.equal((endpoint.read(paid.payload).plan() as { run: { command: { id: string } } }).run.command.id, 'markPaid');
    },
  );
}
