/**
 * A channel message the App names (`send('sms', (o) => ({ …, reference: o.id }))`) is told back to the App as it
 * settles: the jobs module's `integrations.settled` command runs, as its service principal, with the reference, the
 * channel, the state (held, sent, suppressed, failed), the reason and the provider's id, so the App records on its own
 * row what became of its text. Each state is told once; a message the App did not name is never told; and `check`
 * holds the command's input to what a settle sends.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { openIntegrationStore, provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { effectIdempotencyKey } from '../packages/mistri/src/server/commands/commandEffects.js';
import type { EventPublication } from '../packages/mistri/src/server/events/eventPublisher.js';
import { channelSender } from '../packages/mistri/src/server/integrations/integrationChannels.js';
import { integrationCommandProblems, integrationRoleProblems } from '../packages/mistri/src/server/integrations/integrationChecks.js';
import { captureIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import { createIntegrationRuntime, saveIntegrationSettings } from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { settledReporter } from '../packages/mistri/src/server/integrations/integrationSettled.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { fakepay, provider, resetProvider } from './fixtures/integrations/fakepay/index.js';

process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

const fail = (message: string): never => {
  throw new Error(message);
};
const principals = new Map([['texts', ['texts']]]);
const capture = (value: unknown) => captureIntegrations(value, principals, fail);

/* The App's own record of each text: what the settled command is told, row by row. */
const recordText = defineCommand({
  source: 'shop',
  target: 'text_log',
  targets: 'none',
  write: ['text_log'],
  input: {
    reference: { type: 'text' },
    channel: { type: 'text' },
    state: { type: 'text' },
    message: { type: 'text' },
    reason: { type: 'text', optional: true },
    providerId: { type: 'text', optional: true },
  },
  output: { parse: (value: unknown) => value },
  async handle({ db }, input) {
    await db.text_log.insert({
      reference: input.reference,
      state: input.state,
      reason: input.reason ?? null,
      provider_id: input.providerId ?? null,
    });
    return {};
  },
});

test('each state a named message settles in runs the App’s settled command once, with its reference and outcome', async (t) => {
  resetProvider();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-channel-settled-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE text_log (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, provider_id TEXT);`);
  migrateSqliteCommandJournal(path);
  provisionSqliteIntegrations(path);
  registry.add({ id: 'shop-db', name: 'Shop', url: path, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      home: 'texts',
      sources: { shop: { connection: 'shop-db', default: true } },
      resources: { text_log: { access: 'write' } },
      auth: { roles: { texts: { service: true, read: ['text_log'], commands: ['recordText'] } } },
      views: { texts: { kind: 'list', from: 'text_log' } },
    },
    'settled fixture',
  );
  const commands = defineCommands({ recordText });
  const resources = await loadAppRuntimeResources(registry, app, 'shop-db');
  const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: (id) => id === 'shop-db' });

  const declared = capture({
    use: [fakepay()],
    settled: { runAs: 'texts', command: 'recordText' },
    quietHours: { from: '21:00', to: '08:00', timezone: 'America/New_York' },
  });
  assert.deepEqual(integrationCommandProblems(declared, commands), []);
  assert.deepEqual(integrationRoleProblems(declared, principals, app), []);
  const clock = { now: Date.UTC(2026, 0, 15, 2, 30) }; // 21:30 in New York: quiet.
  const store = await openIntegrationStore({ sqlite: path });
  t.after(() => store.close());
  const runtime = createIntegrationRuntime({ appId: 'shop', declared, store, now: () => clock.now });
  await saveIntegrationSettings(runtime, '', 'owner', {
    integration: 'fakepay',
    secrets: { apiKey: 'sk_shop', webhookSecret: 'whsec_shop_0123456789abcdef' },
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
        payloadJson: JSON.stringify({ body: message }),
      },
      signal: AbortSignal.timeout(5_000),
    } as unknown as EventPublication);
  const reporter = settledReporter({
    runtime,
    version: 1,
    principals,
    bind: async () => ({ binding, release: () => {} }),
    warn: (message) => assert.fail(message),
  })!;
  const log = () =>
    (db.prepare('SELECT reference, state, reason, provider_id FROM text_log ORDER BY id').all() as Array<Record<string, unknown>>).map(
      (row) => ({ ...row }),
    );

  await publish({ to: '+15550001', text: 'Your order shipped.', consent: true, reference: 'order-7' });
  await publish({ to: '+15550002', text: 'Hello.', consent: false, reference: 'order-8' });
  await publish({ to: '+15550003', text: 'Unnamed.', consent: true, timezone: 'Asia/Tokyo' });
  assert.equal((await store.message('shop', effectIdempotencyKey('receipt-1', 'text')))?.reference, 'order-7');
  assert.equal(await reporter.report(), true);
  assert.deepEqual(log(), [
    { reference: 'order-7', state: 'held', reason: 'quiet_hours', provider_id: null },
    { reference: 'order-8', state: 'suppressed', reason: 'no_consent', provider_id: null },
  ]);
  // Told once: nothing has moved, so nothing runs again; the unnamed text (sent at once, in Tokyo) is never told.
  assert.equal(await reporter.report(), false);
  assert.equal(log().length, 2);

  // Morning in New York: the held text goes out, and the App is told it was sent, with the provider's id.
  clock.now = Date.UTC(2026, 0, 15, 13, 0);
  assert.equal(await sender.sendDue(), true);
  assert.equal(await reporter.report(), true);
  const sent = provider.texts.find((text) => text.to === '+15550001');
  assert.ok(sent);
  assert.deepEqual(log().at(-1), { reference: 'order-7', state: 'sent', reason: null, provider_id: sent.id });
  assert.equal(await reporter.report(), false);
  assert.equal(log().length, 3);
});

test('check holds the settled command to what a settle sends, and the declaration to a principal and a channel', () => {
  const declared = capture({ use: [fakepay()], settled: { runAs: 'texts', command: 'recordText' } });
  const wrong = defineCommands({
    recordText: defineCommand({
      source: 'shop',
      target: 'text_log',
      targets: 'none',
      input: { reference: { type: 'text' }, note: { type: 'text' } },
      output: { parse: (value: unknown) => value },
      handle: () => ({}),
    }),
  });
  assert.match(
    integrationCommandProblems(declared, wrong).join('\n'),
    /\[integration-settled-input\][^\n]*the command takes "note", which a settle does not send/,
  );
  assert.match(
    integrationCommandProblems(declared, defineCommands({})).join('\n'),
    /integrations\.settled runs command "recordText", which the commands module does not register/,
  );
  assert.throws(() => capture({ use: [fakepay()], settled: { runAs: 'nobody', command: 'recordText' } }), /principals do not declare/);
  assert.throws(() => capture({ use: [fakepay()], settled: { runAs: 'texts', command: 'recordText', extra: 1 } }), /has no "extra"/);
});
