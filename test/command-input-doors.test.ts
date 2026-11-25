/**
 * What a command's input means at each door a caller reaches it by: the browser's request (what a form, `run`, a
 * `CommandButton` and the test kit's `client.command` all send), the App API's envelope, and the executor a job runs.
 *
 * Two things are held here, because each was a field report of doors disagreeing.
 *
 * A `field.money({ minor: true })` amount is given in the currency's MAJOR unit at every door, as the documentation
 * says (`"19.99"`, or the number 19.99): only the handler, and the stored column, hold minor units. A caller that sends
 * cents records a hundred times the amount, and the field's `min` and `max` are in the major unit too.
 *
 * A field with a literal `default` is not required: left out, it takes the default, at every door.
 *
 * And a handler may move another row of a machine's table along any edge of the graph, not only its own verb's.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { createApiCommandEnvelopeBundle } from '../packages/mistri/src/server/api/apiCommandEnvelope.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { createTestClient } from '../packages/mistri/src/server/testing/client.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { createApp } from './support/createApp.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

const clerk: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };

/* A payment of at most $500.00, kept in cents; "send anyway" and a channel that each have a default. */
const payInput = {
  amount_cents: field.money({ minor: true, min: 0.5, max: 500 }),
  force: field.bool({ default: false }),
  channel: field.text({ default: 'counter' }),
};
const PLAN_STATES = {
  proposed: { on: { acceptPlan: 'accepted', declinePlan: 'declined' } },
  accepted: { final: true },
  declined: { final: true },
};

async function fixture(
  run: (f: {
    payments: () => Array<{ amount_cents: number; forced: number; channel: string }>;
    plans: () => Record<number, string>;
    /** The executor, as a job or a service reaches it. */
    execute: (command: string, key: Record<string, number>, input: unknown) => Promise<unknown>;
    /** The App API's door: its envelope's own check of the request, then the executor. */
    api: (input: unknown) => Promise<unknown>;
    /** The browser's route, as a form, `run` and a `CommandButton` send. */
    post: (path: string, body: object) => Promise<{ status: number; body: any }>;
    /** The test kit's client (`client.command`). */
    kit: ReturnType<typeof createTestClient>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-input-doors-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE payment (id INTEGER PRIMARY KEY, amount_cents INTEGER NOT NULL, forced INTEGER NOT NULL DEFAULT 0, channel TEXT);
    CREATE TABLE plan (id INTEGER PRIMARY KEY, patient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed');
    INSERT INTO plan (id, patient) VALUES (1, 'Mara'), (2, 'Mara'), (3, 'Mara'), (4, 'Otto');`);
  db.close();
  migrateSqliteCommandJournal(file);
  clearJournal('desk-db');
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const commands = defineCommands({
    recordPayment: defineCommand({
      source: 'desk',
      target: 'payment',
      targets: 'none',
      input: payInput,
      async handle({ db: tables }, input) {
        await tables.payment.insert({ amount_cents: input.amount_cents as number, forced: input.force ? 1 : 0, channel: input.channel });
      },
    }),
    // A verb of the plan's machine: its own record goes to accepted, and it declines the patient's other proposals
    // along declinePlan's edge, in the same transaction.
    acceptPlan: defineCommand({
      source: 'desk',
      target: 'plan',
      async handle({ db: tables, record }) {
        await tables.plan.update(record, { status: 'accepted' });
        const others = await tables.plan.where({ patient: record.patient as string, status: 'proposed' });
        for (const other of others) if (other.id !== record.id) await tables.plan.update(other, { status: 'declined' });
      },
    }),
    declinePlan: defineCommand({
      source: 'desk',
      target: 'plan',
      async handle({ db: tables, record }) {
        await tables.plan.update(record, { status: 'declined' });
      },
    }),
    // No verb: it tries a move the graph has no edge for, on a row that is not its own.
    reviveOthers: defineCommand({
      source: 'desk',
      target: 'plan',
      async handle({ db: tables, record }) {
        const others = await tables.plan.where({ patient: record.patient as string, status: 'declined' });
        for (const other of others) await tables.plan.update(other, { status: 'proposed' });
      },
    }),
  });
  const contract = { id: 'recordPayment', version: 1, input: payInput };
  const app = parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: {
        payment: { access: 'write' },
        plan: {
          access: 'write',
          machine: { column: 'status', states: PLAN_STATES },
          actions: { reviveOthers: { label: 'Revive the others', command: 'reviveOthers' } },
        },
      },
      auth: {
        providers: ['email'],
        roles: { clerk: { read: true, commands: ['recordPayment', 'acceptPlan', 'declinePlan', 'reviveOthers'] } },
      },
      views: {
        payments: { kind: 'list', from: 'payment' },
        pay: { kind: 'form', label: 'Take a payment', command: contract },
      },
      home: 'payments',
      nav: ['payments', 'pay'],
      ui: { currency: 'USD' },
    },
    'input doors',
    { acceptPlan: { target: 'plan' }, declinePlan: { target: 'plan' }, reviveOthers: { target: 'plan' } },
  );
  const pages = parsePagesConfig({ pages: [] }, 'input doors pages');
  const host: AppHost = {
    app: { app, path: '/private/desk/app.ts', pages, sources: {} },
    pages,
    auth: { spec: app.auth!, store: '/private/desk/auth.db', close() {}, handler: async () => {}, session: async () => clerk },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages, commands: { appId: 'desk', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const check = new DatabaseSync(file, { readOnly: true });
  const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
  const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
  const actor = { id: clerk.id, appId: 'desk', roles: ['clerk'] };
  let sent = 0;
  const envelope = (command: string, key: Record<string, number>, input: unknown) => ({
    command,
    commandVersion: 1,
    key,
    expectedVersion: 0,
    idempotencyKey: `input-doors-request-${String(++sent).padStart(5, '0')}`,
    input,
  });
  const operation = createApiCommandEnvelopeBundle(
    { ...app, api: parseTestApi({ version: 1, roles: ['clerk'], commands: [contract] }, ['clerk'])! },
    resources.schema,
    commands,
    { connectionFor: (resource) => resources.connectionFor(resource), writableConnection: () => true, transactionalConnection: () => true },
  ).operations[0];
  try {
    await run({
      payments: () =>
        check
          .prepare('SELECT amount_cents, forced, channel FROM payment ORDER BY id')
          .all()
          .map((row) => ({ ...row })) as never,
      plans: () =>
        Object.fromEntries(
          check
            .prepare('SELECT id, status FROM plan ORDER BY id')
            .all()
            .map((row) => [row.id, row.status]),
        ),
      execute: (command, key, input) => executeBusinessCommand(binding, actor, envelope(command, key, input) as never, { door: 'job' }),
      api: async (input) =>
        executeBusinessCommand(binding, actor, operation.validateExecuteRequest(envelope('recordPayment', {}, input)) as never, {
          door: 'api',
        }),
      post: async (path, body) => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', 'x-mistri-account': clerk.id },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
      kit: createTestClient(base, { app: 'desk' }),
    });
  } finally {
    check.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
}

const refusedAt = (code: string, at?: string) => (error: unknown) =>
  (error as { code?: string }).code === code && (at === undefined || (error as { field?: string }).field === at);

test('a minor money input is the major amount at every door, and only the handler holds minor units', async () => {
  await fixture(async ({ execute, api, post, kit, payments }) => {
    // $255.00, said four ways by four doors: each stores 25500 cents.
    await execute('recordPayment', {}, { amount_cents: '255.00' });
    await api({ amount_cents: '255.00' });
    const browser = await post('/api/commands/execute?app=desk', {
      command: 'recordPayment',
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: 'input-doors-browser-00001',
      input: { amount_cents: '255.00' },
    });
    assert.equal(browser.status, 200, JSON.stringify(browser.body));
    const tested = await kit.command('recordPayment', {}, { amount_cents: 255 });
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.deepEqual(
      payments().map((row) => row.amount_cents),
      [25500, 25500, 25500, 25500],
    );
    // The number 25500 is $25,500.00 at every door, never 25500 cents: over this field's $500.00, so refused.
    await assert.rejects(execute('recordPayment', {}, { amount_cents: 25500 }), refusedAt('invalid_input', 'amount_cents'));
    await assert.rejects(api({ amount_cents: 25500 }));
    const cents = await kit.command('recordPayment', {}, { amount_cents: 25500 });
    assert.ok(!cents.ok && cents.code === 'invalid_input', JSON.stringify(cents));
    assert.equal(payments().length, 4);
  });
});

test("a minor money field's min and max are in the major unit, to the cent", async () => {
  await fixture(async ({ execute, kit, payments }) => {
    // max: 500 is $500.00, not 500 cents: $499.99 and $500.00 are taken, $500.01 is not.
    await execute('recordPayment', {}, { amount_cents: '499.99' });
    await execute('recordPayment', {}, { amount_cents: '500' });
    await assert.rejects(execute('recordPayment', {}, { amount_cents: '500.01' }), refusedAt('invalid_input', 'amount_cents'));
    // min: 0.5 is fifty cents, a bound a fraction states because the unit is the major one.
    await execute('recordPayment', {}, { amount_cents: '0.50' });
    const under = await kit.command('recordPayment', {}, { amount_cents: '0.49' });
    assert.ok(!under.ok && under.code === 'invalid_input', JSON.stringify(under));
    assert.deepEqual(
      payments().map((row) => row.amount_cents),
      [49999, 50000, 50],
    );
  });
});

test('a field with a default is not required: left out, it takes the default at every door', async () => {
  await fixture(async ({ execute, api, kit, payments }) => {
    await execute('recordPayment', {}, { amount_cents: '1' });
    await api({ amount_cents: '2' });
    const tested = await kit.command('recordPayment', {}, { amount_cents: '3' });
    assert.equal(tested.ok, true, JSON.stringify(tested));
    // Said, a value wins over its default.
    await execute('recordPayment', {}, { amount_cents: '4', force: true, channel: 'phone' });
    assert.deepEqual(payments(), [
      { amount_cents: 100, forced: 0, channel: 'counter' },
      { amount_cents: 200, forced: 0, channel: 'counter' },
      { amount_cents: 300, forced: 0, channel: 'counter' },
      { amount_cents: 400, forced: 1, channel: 'phone' },
    ]);
    // A field with no default is still asked for.
    await assert.rejects(execute('recordPayment', {}, {}), refusedAt('invalid_input', 'amount_cents'));
  });
});

test("a handler moves another row of the machine's table along any edge of its graph, and only along one", async () => {
  await fixture(async ({ kit, plans }) => {
    // Accepting plan 2 declines Mara's other proposals in the same transaction; Otto's is untouched.
    const accepted = await kit.command('acceptPlan', { id: 2 });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.deepEqual(plans(), { 1: 'declined', 2: 'accepted', 3: 'declined', 4: 'proposed' });
    // declined → proposed is no edge: a handler writing it to a sibling row is refused, and nothing moves.
    const revived = await kit.command('reviveOthers', { id: 2 });
    assert.ok(!revived.ok && revived.code === 'ineligible_state', JSON.stringify(revived));
    assert.deepEqual(plans(), { 1: 'declined', 2: 'accepted', 3: 'declined', 4: 'proposed' });
  });
});
