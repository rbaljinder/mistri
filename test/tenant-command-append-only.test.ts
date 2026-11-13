/**
 * A command that adds a row to a table its caller's role cannot read (a field report: a hand-off left for another
 * team): the role runs it, and the row lands, though nothing grants it a read of that table. A write grant never
 * implies a read grant: the command may only add there, so a handler that counts or reads those rows is refused in
 * words naming them, and nothing it wrote lands. The form is offered to the role, and `check` does not call the grant
 * dead.
 *
 * On SQLite always and on PostgreSQL where `TABLEWALK_TEST_PG` names a server.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { commandUnreadable } from '../packages/mistri/src/server/build/checkCommands.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
type Handle = Record<string, Record<string, (...args: never[]) => Promise<unknown>>>;
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-append-only-store' };

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Customer', profile: 'customer', platform: { label: 'Operator' } },
      /* The agent reads tickets and nothing of the hand-offs another team works from. */
      roles: {
        agent: { realm: 'tenant', read: ['ticket'], commands: ['handOff', 'peekHandoffs'] },
        operator: { realm: 'platform', read: true },
      },
    },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      customer: { owner: 'platform' },
      ticket: { owner: 'tenant', access: 'write' },
      handoff: { owner: 'tenant', access: 'write', noun: { one: 'hand-off', many: 'hand-offs' } },
    },
    views: { tickets: { kind: 'list', from: 'ticket', realm: 'tenant' } },
    home: 'tickets',
    nav: [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['tickets'] }],
  },
  'desk append-only fixture',
);

/* Opens a ticket and leaves a hand-off beside it; `then` is what the handler does after. */
const handOff = (then?: (db: Handle) => Promise<unknown>) =>
  defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    write: ['ticket', 'handoff'],
    input: { id: { type: 'text' } },
    async handle({ db }, input) {
      const handle = db as unknown as Handle;
      await handle.ticket.insert({ id: String(input.id), title: 'Printer jam' } as never);
      await handle.handoff.insert({ id: `${String(input.id)}-h`, ticket_id: String(input.id), note: 'Swap the drum' } as never);
      await then?.(handle);
    },
  });
const registry = defineCommands({
  handOff: handOff(),
  peekHandoffs: handOff((db) => db.handoff.count()),
});
const rows: RowScope = { ticket: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    customer: { kind: 'platform' },
    ticket: { kind: 'tenant', column: 'tenant_id' },
    handoff: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
  resultReferences: { handOff: () => [], peekHandoffs: () => [] },
  resolvePlatformRows: () => ({ ...rows, customer: true, handoff: true }),
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const suffix = `append_${randomUUID().replaceAll('-', '')}`;
  const tables = `
    CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE handoff (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES ticket (id),
      note TEXT NOT NULL);
    INSERT INTO customer (id, name) VALUES ('north', 'North');`;
  const engine = await openTenantEngine(dialect, {
    tables: ['customer', 'ticket', 'handoff'],
    sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;${tables}`,
    postgres: tables,
    database: suffix,
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    if (dialect === 'postgres') await dropDedicatedPostgresDatabase(suffix);
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  await engine.maintenance(binding, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'eve',
      membershipId: 'north-eve',
      status: 'active',
      roles: ['agent'],
      validUntil: Date.now() + 3_600_000,
      expectedVersion: null,
    });
  });
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'desk-append-only-deployment',
    roles: ['agent'],
    commands: { registry },
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: 'eve', who: 'eve@example.invalid' }),
  });
  const session: VerifiedSessionInstance = {
    identity: { id: 'eve', who: 'eve@example.invalid' },
    sessionId: 'session-eve',
    expiresAt: Date.now() + 3_600_000,
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({ app, enrollment, bound, verifySessionInstance: () => session });
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => owner.server.close(() => resolve()));
    owner.server.closeAllConnections();
    await stopped;
    await owner.retire();
    await enrollment.retire();
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const select = (path: string) => `${path}?app=${appId}&tenant=north`;
  const reply = await call(select('/api/tenant/context/open'), {});
  assert.equal(reply.status, 200, reply.text);
  const lease = reply.body as unknown as Context;
  const data = (path: string, body: unknown) =>
    call(select(path), body, {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    });
  const run = (command: string, id: string) =>
    data('/api/commands/execute', {
      command,
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: `${command}-${id}-attempt`,
      input: { id },
    });
  const handoffs = async () => (await engine.all('SELECT id, tenant_id, ticket_id FROM handoff ORDER BY id')) as unknown[];
  return { data, run, handoffs };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a command adds to a table its role cannot read (${dialect})`, { skip }, () => {
    test('the row lands, and the form is offered to the role', async (t) => {
      const f = await fixture(t, dialect);
      const served = await f.data('/api/app', undefined);
      assert.equal(served.status, 200, served.text);
      assert.match(served.text, /"handOff"/, 'the form is offered');
      const ran = await f.run('handOff', 't1');
      assert.equal(ran.status, 200, ran.text);
      assert.deepEqual(await f.handoffs(), [{ id: 't1-h', tenant_id: 'north', ticket_id: 't1' }]);
      const read = await f.data('/api/run', { q: 'handoff', limit: 5, offset: 0, count: 'none' });
      assert.match(read.text, /No table called \\"handoff\\"/, 'the role still reads no hand-off');
    });

    test('a handler that reads what it may only add is refused, naming them, and nothing lands', async (t) => {
      const f = await fixture(t, dialect);
      const refused = await f.run('peekHandoffs', 't2');
      assert.equal(refused.status, 403, refused.text);
      assert.match(String(refused.body.message), /cannot read hand-off records, which "[^"]+" reads: it may only add them/);
      assert.deepEqual(await f.handoffs(), []);
    });
  });
}

test('check does not call the grant dead for a table the command only adds to', () => {
  const column = (name: string) => ({ name, type: 'TEXT', notNull: true, pk: name === 'id' });
  const table = (id: string, columns: string[]) => ({ id, name: id, columns: columns.map(column) });
  const schema = {
    label: 'Desk',
    dialect: 'sqlite',
    tables: [
      table('customer', ['id', 'name']),
      table('ticket', ['id', 'tenant_id', 'title']),
      table('handoff', ['id', 'tenant_id', 'ticket_id', 'note']),
    ],
    foreignKeys: [],
  } as unknown as DatabaseSchema;
  assert.deepEqual(commandUnreadable(app, registry, schema), []);
});
