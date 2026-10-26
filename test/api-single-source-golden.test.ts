/**
 * What a single-source App's API says, byte for byte: the read and composed
 * OpenAPI documents, AsyncAPI, the App MCP tool listing, item, list and view
 * bodies, a cursor's round trip and the refusals, on SQLite and (under
 * TABLEWALK_TEST_PG) PostgreSQL. Several sources came to the API after 1.0's
 * promise was made to the Apps that have one; this fixture is that promise:
 * nothing a one-source App is answered may change because a second source
 * became possible. Values that are new on every run — receipt and event ids,
 * instants, sealed cursors — are masked; everything else is compared exactly.
 *
 * TABLEWALK_GOLDEN_WRITE=1 rewrites the fixtures. Only do that for a change
 * that is meant to be seen by every one-source App, and say so.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, int } from '../packages/mistri/src/server/commands/commandShapes.js';
import { apiOwnerFixture, commandOwner, readOwner, type Engine, type Said } from './support/apiOwnerFixture.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

/* The same statements on both engines: the types chosen say the same thing to both codecs. */
const TABLES = `CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT);
   CREATE TABLE invoice(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), total INTEGER NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
   INSERT INTO customer(id,name,region) VALUES (1,'Acme','east'),(2,'Brill',NULL),(3,'Corvid','west');
   INSERT INTO invoice(id,customer_id,total,status) VALUES (1,1,50,'open'),(2,1,150,'open'),(3,2,250,'paid'),(4,3,400,'open');`;

const segments = { large: 'total >= 100' };
const views = {
  invoices: { kind: 'list', from: 'invoice', query: 'status = open', sort: 'id asc', tabs: ['large'] },
};
const exposure = {
  customer: { fields: ['id', 'name', 'region'], filters: ['region'], sorts: ['id', 'name'] },
  invoice: { fields: ['id', 'customer_id', 'customer_id.name', 'total', 'status'], filters: ['status'], sorts: ['id', 'total'] },
};

/** A read-only App on one connection, named the plain way (`connection`, no `sources`). */
const readsApp = (store: string) => ({
  id: 'ledger',
  name: 'Ledger',
  connection: 'data',
  resources: { customer: {}, invoice: { segments } },
  views,
  home: 'invoices',
  auth: { store, roles: { reader: { read: true }, narrow: { read: ['customer'] } } },
  api: { version: 1, roles: ['reader', 'narrow'], resources: exposure, views: ['invoices'] },
});

/** The same data with a command, a generic write and an event, named by one source. */
const commandsApp = (store: string) => ({
  id: 'ledger',
  name: 'Ledger',
  sources: { business: { connection: 'data', default: true } },
  resources: { customer: { access: 'write' }, invoice: { access: 'write', segments } },
  views,
  home: 'invoices',
  auth: {
    store,
    roles: { clerk: { read: true, write: ['customer'], commands: ['settle'] }, reader: { read: true } },
  },
  api: {
    version: 1,
    roles: ['clerk', 'reader'],
    resources: { ...exposure, customer: { ...exposure.customer, update: true } },
    views: ['invoices'],
    commands: [{ id: 'settle', version: 1, target: 'invoice', input: {} }],
    events: ['invoice.settled'],
  },
});

const settled = defineEvent('invoice.settled', shape({ id: int() }));
const registry = () =>
  defineCommands({
    settle: defineCommand({
      source: 'business',
      target: 'invoice',
      input: {},
      output: shape({ id: int() }),
      events: { settled: defineEventProjection(settled, (output: { id: number }) => ({ id: output.id })) },
      async handle(context) {
        await context.tx.update({
          table: 'invoice',
          key: { id: Number(context.record.id) },
          values: { status: 'paid', version: Number(context.record.version) + 1 },
        });
        return { id: Number(context.record.id) };
      },
    }),
  });

/* What is new on every run. A sealed list cursor and an event cursor are
   masked where they stand (`next`), and passed back unmasked. */
const mask = (text: string) =>
  text
    .replace(/"next":"[^"]*"/g, '"next":"<cursor>"')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})/g, '<instant>');
const record = (said: Said) => ('refused' in said ? { refused: said.refused } : { ...said, body: mask(said.body) });
const nextOf = (said: Said) => ('refused' in said ? null : (JSON.parse(said.body).next as string | null));

async function capture(t: TestContext, engine: Engine) {
  const said: Record<string, unknown> = {};
  {
    const f = await apiOwnerFixture(t, {
      engine,
      app: readsApp,
      connections: { data: { sql: TABLES } },
      accounts: { reader: 'reader', narrow: 'narrow' },
    });
    const reader = await f.issue('reader', ['reader']),
      narrow = await f.issue('narrow', ['narrow']);
    const reads = await readOwner(f, engine, 'decimal-string');
    said['reads openapi reader'] = record(await reads.spec(reader));
    said['reads openapi narrow'] = record(await reads.spec(narrow));
    said['reads tools reader'] = record(await reads.tools(reader));
    said['reads tools narrow'] = record(await reads.tools(narrow));
    said['item invoice 1'] = record(await reads.item(reader, 'item:invoice', '1'));
    said['item invoice 99'] = record(await reads.item(reader, 'item:invoice', '99'));
    said['item invoice forbidden'] = record(await reads.item(narrow, 'item:invoice', '1'));
    said['item unauthenticated'] = record(await reads.item('not-a-token', 'item:invoice', '1'));
    said['item bad key'] = record(await reads.item(reader, 'item:invoice', 'x'));
    const first = await reads.list(reader, 'list:customer', 'limit=2&sort=name&count=true');
    said['list customer page 1'] = record(first);
    const cursor = nextOf(first);
    assert.ok(cursor, 'the first page continues');
    const second = await reads.list(reader, 'list:customer', `limit=2&sort=name&count=true&cursor=${encodeURIComponent(cursor!)}`);
    said['list customer page 2'] = record(second);
    said['list customer cursor other token'] = record(
      await reads.list(narrow, 'list:customer', `limit=2&sort=name&count=true&cursor=${encodeURIComponent(cursor!)}`),
    );
    said['list customer cursor changed query'] = record(
      await reads.list(reader, 'list:customer', `limit=2&sort=id&count=true&cursor=${encodeURIComponent(cursor!)}`),
    );
    said['list invoice filtered'] = record(await reads.list(reader, 'list:invoice', 'status=open&fields=id,customer_id.name&sort=-total'));
    said['list invalid limit'] = record(await reads.list(reader, 'list:customer', 'limit=0'));
    said['list unknown filter'] = record(await reads.list(reader, 'list:customer', 'name=Acme'));
    said['view invoices'] = record(await reads.list(reader, 'view:invoices', 'count=true'));
    said['view invoices large'] = record(await reads.list(reader, 'view:invoices', 'segment=large&limit=1'));
    said['events without feed'] = record(await reads.events(reader, ''));
    said['asyncapi without feed'] = record(await reads.asyncapi(reader));
  }
  {
    const commands = registry();
    const f = await apiOwnerFixture(t, {
      engine,
      app: commandsApp,
      connections: { data: { sql: TABLES, writable: true, events: { sourceId: 'business' } } },
      commands,
      events: { sourceId: 'business' },
      accounts: { clerk: 'clerk', reader: 'reader' },
    });
    const clerk = await f.issue('clerk', ['clerk']),
      reader = await f.issue('reader', ['reader']);
    const reads = await readOwner(f, engine, 'decimal-string');
    const owner = await commandOwner(f, engine, 'decimal-string');
    said['composed openapi clerk'] = record(await owner.spec(clerk));
    said['composed openapi reader'] = record(await owner.spec(reader));
    said['composed tools clerk'] = record(await owner.tools(clerk));
    said['read owner refuses composed spec'] = record(await reads.spec(clerk));
    said['asyncapi clerk'] = record(await reads.asyncapi(clerk));
    said['asyncapi reader'] = record(await reads.asyncapi(reader));
    said['events empty'] = record(await reads.events(clerk, ''));
    const run = { command: 'settle', commandVersion: 1, key: { id: 1 }, input: {}, idempotencyKey: 'golden-attempt-000001' };
    said['prepare'] = record(await owner.prepare(clerk, { command: 'settle', commandVersion: 1, key: { id: 1 } }));
    said['execute stale'] = record(await owner.execute(clerk, { ...run, expectedVersion: 7, idempotencyKey: 'golden-attempt-000000' }));
    said['execute forbidden'] = record(await owner.execute(reader, { ...run, expectedVersion: 0 }));
    said['execute unknown'] = record(await owner.execute(clerk, { ...run, command: 'nope', expectedVersion: 0 }));
    said['execute version mismatch'] = record(await owner.execute(clerk, { ...run, commandVersion: 2, expectedVersion: 0 }));
    said['execute applied'] = record(await owner.execute(clerk, { ...run, expectedVersion: 0 }));
    said['execute replayed'] = record(await owner.execute(clerk, { ...run, expectedVersion: 0 }));
    said['recover'] = record(await owner.recover(clerk, { command: 'settle', commandVersion: 1, idempotencyKey: run.idempotencyKey }));
    said['recover unknown'] = record(
      await owner.recover(clerk, { command: 'settle', commandVersion: 1, idempotencyKey: 'golden-attempt-999999' }),
    );
    said['events after'] = record(await reads.events(clerk, ''));
    said['item after'] = record(await reads.item(clerk, 'item:invoice', '1'));
    // A table without a version column: its revision is a digest of the row, read by preparing.
    const update = { command: 'update-customer', commandVersion: 1, key: { id: 2 } };
    const prepared = await owner.prepare(clerk, update);
    said['prepare update customer'] = record(prepared);
    const version = 'refused' in prepared ? -1 : (JSON.parse(prepared.body).version as number);
    said['update customer'] = record(
      await owner.execute(clerk, {
        ...update,
        expectedVersion: version,
        input: { name: 'Brill & Co' },
        idempotencyKey: 'golden-attempt-000002',
      }),
    );
    said['item customer after update'] = record(await reads.item(clerk, 'item:customer', '2'));
  }
  return said;
}

function compare(engine: Engine, said: Record<string, unknown>) {
  const file = fileURLToPath(new URL(`./fixtures/api-single-source-golden/${engine}.json`, import.meta.url));
  const text = JSON.stringify(said, null, 2) + '\n';
  if (process.env.TABLEWALK_GOLDEN_WRITE === '1' || !existsSync(file)) {
    assert.ok(process.env.TABLEWALK_GOLDEN_WRITE === '1', `${file} is missing; write it with TABLEWALK_GOLDEN_WRITE=1`);
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, 'utf8'));
}

test('a one-source SQLite App is answered exactly as before', { timeout: 120000 }, async (t) => {
  compare('sqlite', await capture(t, 'sqlite'));
});

test('a one-source PostgreSQL App is answered exactly as before', { skip: liveSkip('postgres', LIVE), timeout: 180000 }, async (t) => {
  compare('postgres', await capture(t, 'postgres'));
});
