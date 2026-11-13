/**
 * An input's `when` and its default reach past the target: `record.<ref>.<column>` follows the target's references
 * (at most two), `tenant.<column>` reads a shared column of the tenant's profile. Prepare tells the browser only
 * whether each part holds, a default is read under the actor's grants (a hop they cannot read starts nothing), and
 * the run judges the condition again.
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
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineSource, type CommandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { readPreparedRecord } from '../packages/mistri/src/server/commands/commandPrepare.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';

const source = defineSource<{ ticket: { id: number; version: number; state: string; note: string | null } }>('desk');
const base = { source, target: 'ticket' as const, output: bool(), handle: () => true };

test('a path follows at most two references, and a public form reads a tenant but no record', () => {
  const refused = (input: Record<string, unknown>, options = {}, pattern: RegExp = /./) =>
    assert.throws(() => parseCommandInput(input, 'input', options), pattern);
  assert.doesNotThrow(() => parseCommandInput({ rate: field.number({ default: { record: 'customer_id.region_id.rate' } }) }, 'input'));
  refused({ rate: { type: 'number', default: { record: 'a_id.b_id.c_id.rate' } } }, {}, /more than 2 references/);
  refused({ reason: { type: 'text', when: 'record.a_id.b_id.c_id.vip = true' } }, {}, /more than 2 references/);
  // A tenant App's public form is placed with a tenant (`?via=`, a mapped host) and judged by its shared profile.
  assert.doesNotThrow(() => parseCommandInput({ region: { type: 'text', when: "tenant.country = 'US'" } }, 'input', { publicForm: true }));
  refused({ region: { type: 'text', when: 'record.state = "NY"' } }, { publicForm: true }, /record/);
  refused({ region: { type: 'text', default: { tenant: 'country' } } }, { publicForm: true }, /no member to start a field from/);
  refused({ region: { type: 'text', when: 'tenant.country = record.state' } }, {}, /compare a tenant's value with a literal/);

  assert.throws(
    () => defineCommand({ ...base, targets: 'many', input: { region: field.text({ default: { tenant: 'country' } }) } }),
    /a selection's command does not prepare/,
  );
  // A tenant's own value needs no record: a form over none is asked by it.
  assert.ok(defineCommand({ ...base, targets: 'none', input: { region: field.text({ when: "tenant.country = 'US'" }) } }));
});

const catalog: CommandCatalog = {
  ticket: {
    name: 'ticket',
    key: ['id'],
    kinds: { id: 'number', version: 'number', state: 'text', note: 'text' },
    meta: {
      id: 'ticket',
      name: 'ticket',
      schema: '',
      isView: false,
      columns: ['id', 'version', 'state', 'note'].map((name) => ({
        name,
        type: name === 'id' || name === 'version' ? 'INTEGER' : 'TEXT',
        nullable: true,
        primaryKey: name === 'id',
      })),
    },
  },
};

test("prepare judges a tenant's when locally and starts a field from its profile", async () => {
  const reader = {
    query: async () => ({ rows: [{ id: 4, version: 2, state: 'open', note: null }] }),
    count: async () => 1,
  } as unknown as WriteTransaction;
  const prepare = (command: object, country: string | null, key: Record<string, number> = { id: 4 }) =>
    readPreparedRecord(reader, {
      command: command as Parameters<typeof readPreparedRecord>[1]['command'],
      commandId: 'route',
      actor: { id: 'account', appId: 'desk', roles: ['agent'] },
      key,
      catalog,
      tenant: { country },
    });
  const one = defineCommand({
    ...base,
    input: { region: field.text({ when: "tenant.country = 'US'", default: { tenant: 'country' } }) },
  });
  assert.deepEqual((await prepare(one, 'CA')).withheld, ['region']);
  assert.equal((await prepare(one, 'CA')).initial, undefined, 'a withheld field starts as nothing');
  const us = await prepare(one, 'US');
  assert.equal(us.withheld, undefined);
  assert.deepEqual(us.initial, { region: 'US' });
  assert.deepEqual((await prepare(one, null)).withheld, ['region'], 'an unset profile value meets no comparison');

  const none = defineCommand({
    ...base,
    targets: 'none',
    input: { region: field.text({ when: "tenant.country = 'US'", default: { tenant: 'country' } }) },
  });
  assert.deepEqual((await prepare(none, 'CA', {})).withheld, ['region']);
  const asked = await prepare(none, 'US', {});
  assert.equal(asked.withheld, undefined);
  assert.deepEqual(asked.initial, { region: 'US' });
});

const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
const clerk: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };

test("a path default is read under the actor's grants, and the run judges a path's when again", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-input-paths-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE region (id INTEGER PRIMARY KEY, name TEXT NOT NULL, vip INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, default_rate REAL, region_id INTEGER REFERENCES region(id));
    CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      customer_id INTEGER REFERENCES customer(id), rate REAL, note TEXT);
    INSERT INTO region (id, name, vip) VALUES (1, 'North', 1), (2, 'South', 0);
    INSERT INTO customer (id, name, default_rate, region_id) VALUES (1, 'Acme', 95, 1), (2, 'Bolt', 70, 2);
    INSERT INTO job (id, title, customer_id) VALUES (1, 'Kitchen', 1), (2, 'Porch', 2), (3, 'Shed', NULL);`);
  migrateSqliteCommandJournal(file);
  clearJournal('shop-db');
  const connections = new Registry();
  connections.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const manifest = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'shop-db', default: true } },
      resources: {
        job: { access: 'write', actions: { price: { label: 'Price', command: 'price' } } },
        customer: {},
        region: {},
      },
      auth: {
        providers: ['email'],
        roles: {
          agent: { read: true, commands: ['price'] },
          clerk: {
            read: ['job', 'customer', 'region'],
            fields: { customer: { read: ['id', 'name', 'region_id'] } },
            commands: ['price'],
          },
        },
      },
      views: { jobs: { kind: 'list', from: 'job' } },
      home: 'jobs',
      nav: ['jobs'],
    },
    'input paths',
    { commands: catalogOf({ price: { target: 'job' } }) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'input paths pages');
  const people: Record<string, Identity> = { [agent.id]: agent, [clerk.id]: clerk };
  const host: AppHost = {
    app: { app: manifest, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: {
      spec: manifest.auth!,
      store: '/private/shop/auth.db',
      close() {},
      handler: async () => {},
      session: async (req: { headers: Record<string, string | string[] | undefined> }) =>
        people[String(req.headers['x-mistri-account'])] ?? null,
    },
  } as AppHost;
  const price = defineCommand({
    source: 'shop',
    target: 'job',
    read: ['customer', 'region'],
    input: {
      rate: field.number({ default: { record: 'customer_id.default_rate' } }),
      // A customer in a VIP region is priced with a reason on file.
      reason: field.text({ when: 'record.customer_id.region_id.vip = true' }),
    },
    async handle({ db, record }, input: { rate: number; reason?: string }) {
      await db.job.update(record, { rate: input.rate, note: input.reason ?? null });
    },
  } as Parameters<typeof defineCommand>[0]);
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry: connections,
    bound,
    apps: [host],
    pages,
    commands: { appId: 'shop', registry: defineCommands({ price }) },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const post = async (who: Identity, path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': who.id },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const prepare = async (who: Identity, id: number) => {
    const prepared = await post(who, '/api/commands/prepare', { command: 'price', commandVersion: 1, key: { id } });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    return prepared.body;
  };
  let requests = 0;
  const run = async (id: number, input: object) => {
    const prepared = await prepare(agent, id);
    return post(agent, '/api/commands/execute', {
      command: 'price',
      commandVersion: 1,
      key: { id },
      expectedVersion: prepared.expectedVersion,
      idempotencyKey: `input-paths-request-${String(++requests).padStart(4, '0')}`,
      input,
    });
  };
  const job = (id: number) => ({ ...(db.prepare('SELECT rate, note FROM job WHERE id = ?').get(id) as object) });
  try {
    const vip = await prepare(agent, 1);
    assert.deepEqual(vip.initial, { rate: 95 }, "the customer's rate, two tables away");
    assert.equal(vip.withheld, undefined, 'a VIP region asks the reason');
    assert.ok(!JSON.stringify(vip).includes('North'), 'the browser is told whether, never what');
    const plain = await prepare(agent, 2);
    assert.deepEqual(plain.initial, { rate: 70 });
    assert.deepEqual(plain.withheld, ['reason']);
    const empty = await prepare(agent, 3);
    assert.equal(empty.initial, undefined, 'an empty reference starts nothing');
    assert.deepEqual(empty.withheld, ['reason'], 'and holds of nothing');

    const unread = await prepare(clerk, 1);
    assert.equal(unread.initial, undefined, 'a column the clerk cannot read starts nothing');

    const unasked = await run(1, { rate: 95 });
    assert.equal(unasked.status, 400, JSON.stringify(unasked.body));
    assert.equal(unasked.body.field, 'reason');
    const refused = await run(2, { rate: 70, reason: 'Because' });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.field, 'reason');
    assert.equal((await run(1, { rate: 95, reason: 'VIP account' })).status, 200);
    assert.equal((await run(2, { rate: 70 })).status, 200);
    assert.deepEqual(
      [job(1), job(2)],
      [
        { rate: 95, note: 'VIP account' },
        { rate: 70, note: null },
      ],
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
