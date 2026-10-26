/**
 * A tenant member's everyday surfaces, over the tenant HTTP host, where a
 * service desk built on the public API found the tenant realm falling short:
 * a form whose command names no record, a history whose people are named by a template,
 * another customer's record address, and a natural key unique within its
 * tenant. Each is what the member's own tenant answers, and none of them
 * ends the session.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appAddressBook, naturalKeyProblems } from '../packages/mistri/src/shared/appAddress.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { tenantAuthoringSchema } from '../packages/mistri/src/server/tenant/tenantVisibleFields.js';
import type { TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseAppPages } from '../packages/mistri/src/shared/appPages.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Answer = { status: number; headers: Headers; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; appId: string; accountId: string; tenantId: string; revision: number; expiresAt: number };
const appId = 'desk';
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-gaps-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  let owner: ReturnType<typeof createTenantHttpServer> | undefined;
  let enrollment: Awaited<ReturnType<typeof createTenantEnrollment<IncomingMessage>>> | undefined;
  t.after(async () => {
    try {
      if (owner) {
        const stopped = new Promise<void>((resolve) => owner!.server.close(() => resolve()));
        owner.server.closeAllConnections();
        await stopped;
        await owner.retire();
      }
      await enrollment?.retire();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  /* A ticket's number is its address, unique within its tenant: two customers each have ticket 1. */
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE person(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL);
    CREATE TABLE ticket(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL,
      assignee TEXT REFERENCES person(id), version INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id, number));
    INSERT INTO person VALUES ('north-ada','north','Ada','Lovelace'),('north-alan','north','Alan','Turing'),('south-grace','south','Grace','Hopper');
    INSERT INTO ticket VALUES ('north-1','north','1','Printer jammed','north-ada',0),('south-1','south','1','South secret','south-grace',0);`);
  const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-store' };
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  provisionSqliteRecordHistory(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, binding);
  for (const tenantId of ['north', 'south']) {
    await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId,
      accountId: 'eve',
      membershipId: `${tenantId}-eve`,
      status: 'active',
      roles: ['employee'],
      validUntil: 10000,
      expectedVersion: null,
    });
  }
  await operations.finish();
  db.exec('COMMIT');
  const app = parseTestApp(
    {
      id: appId,
      name: 'Desk',
      auth: { rows: 'tenant', roles: { employee: { read: true, commands: ['raise', 'retitle'] } } },
      sources: { business: { connection: binding.source.connection } },
      resources: {
        person: { owner: 'tenant', recordLabel: '{first} {last}' },
        ticket: {
          owner: 'tenant',
          access: 'write',
          address: 'number',
          fields: { read: ['id', 'number', 'title', 'assignee', 'version'] },
          actions: {
            retitle: { label: 'Retitle', command: { id: 'retitle', version: 1, target: 'ticket', input: { title: { type: 'text' } } } },
          },
        },
      },
      views: {
        tickets: { kind: 'list', from: 'ticket' },
        // A signed-in form over a command that names no record.
        raise: { kind: 'form', label: 'Raise a ticket', command: { id: 'raise', version: 1, input: { title: { type: 'text' } } } },
      },
      nav: ['tickets', 'raise'],
      home: 'tickets',
    },
    'desk fixture',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        { id: 'ticket', label: 'Ticket', base: 'ticket', sections: [{ kind: 'fields', show: ['title', 'assignee'] }, { kind: 'history' }] },
      ],
    },
    'desk pages',
  );
  /* A ticket on paper (appDocuments.ts): captured with the tenant's pages, read by the record page's routes. */
  pages.push(
    ...parseAppPages(
      {
        pages: {
          slip: {
            base: 'ticket',
            sections: [{ kind: 'fields', show: ['number', 'title', 'assignee'] }],
            document: { label: 'Ticket slip', number: 'number' },
          },
        },
      },
      'desk documents',
    ),
  );
  const rows: RowScope = { person: true, ticket: true };
  const registry = defineCommands({
    raise: defineCommand({
      source: 'business',
      target: 'ticket',
      targets: 'none',
      read: ['ticket', 'person'],
      write: ['ticket'],
      input: { title: { type: 'text' } },
      output: { parse: (value: unknown) => value as { id: string } },
      // A keyless form starts from what the member's own tenant reads: north has one ticket, south's is not counted.
      async initial({ db: records }) {
        return { title: `Ticket ${(await records.ticket.count()) + 1}` };
      },
      async handle({ db: records }, input) {
        const count = await records.ticket.count();
        const id = `north-${count + 1}`;
        await records.ticket.insert({ id, number: String(count + 1), title: String(input.title), assignee: 'north-ada' });
        return { id };
      },
    }),
    retitle: defineCommand({
      source: 'business',
      target: 'ticket',
      input: { title: { type: 'text' } },
      output: { parse: (value: unknown) => value as { id: string } },
      async handle({ db: records, record }, input) {
        await records.ticket.update(record, { title: String(input.title), version: Number(record.version) + 1 });
        return { id: String(record.id) };
      },
    }),
  });
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId,
    storeId: binding.storeId,
    ownership: { person: { kind: 'tenant', column: 'tenant_id' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    resultReferences: {
      raise: (result) => [{ table: 'ticket', key: { id: String(object(result).id) } }],
      retitle: (result) => [{ table: 'ticket', key: { id: String(object(result).id) } }],
    },
  });
  enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages,
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'desk-deployment',
    roles: ['employee'],
    maxLifetimeMs: 300000,
    now: () => 1000,
    commands: { registry },
    verifySession: async () => ({ id: 'eve', who: 'Eve' }),
  });
  const session: VerifiedSessionInstance = { identity: { id: 'eve', who: 'Eve' }, sessionId: 'session-eve', expiresAt: 20000 };
  const bound = { host: '127.0.0.1', port: 0 };
  owner = createTenantHttpServer({ app, enrollment, bound, verifySessionInstance: () => session });
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
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: object(JSON.parse(text)) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  const open = async (tenant = 'north'): Promise<Context> => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as Context;
  };
  const data = (path: string, value: Context, body: unknown) =>
    call(select(path, value.tenantId), body, {
      'x-mistri-tab': value.tabId,
      'x-mistri-context': value.context,
      'x-mistri-lease-revision': String(value.revision),
      'x-mistri-account': value.accountId,
    });
  return { db, open, data, path, app };
}

const ok = (reply: Answer) => {
  assert.equal(reply.status, 200, reply.text);
  return reply.body;
};

test("a signed-in form whose command names no record is offered and runs in the member's tenant (G19)", async (t) => {
  const f = await fixture(t),
    north = await f.open();
  const app = object(ok(await f.data('/api/app', north, undefined)).app);
  assert.ok((app.grantedCommands as string[]).includes('raise'), "the form's command is granted, so a component can name it");
  assert.ok(Object.hasOwn(object(app.views), 'raise'), 'the form is served');
  // Its form prepares over no record: the starting values, no revision.
  assert.deepEqual(ok(await f.data('/api/commands/prepare', north, { command: 'raise', commandVersion: 1, key: {} })), {
    expectedVersion: 0,
    initial: { title: 'Ticket 2' },
  });
  // A key is no way to name a record it does not have.
  assert.equal((await f.data('/api/commands/prepare', north, { command: 'raise', commandVersion: 1, key: { id: 'north-1' } })).status, 400);
  const receipt = ok(
    await f.data('/api/commands/execute', north, {
      command: 'raise',
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: 'raise-attempt-0001',
      input: { title: 'Mouse missing' },
    }),
  );
  assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
  assert.deepEqual(
    f.db
      .prepare("SELECT tenant_id, title FROM ticket WHERE title = 'Mouse missing'")
      .all()
      .map((row) => ({ ...row })),
    [{ tenant_id: 'north', title: 'Mouse missing' }],
  );
});

test('a history names its people by their template inside the tenant, and never ends the session (G21)', async (t) => {
  const f = await fixture(t),
    north = await f.open();
  // The people a ticket's history names, as the history section asks for their names.
  const names = ok(
    await f.data('/api/view/run', north, {
      view: {
        id: 'history:person',
        name: '',
        base: 'person',
        columns: [{ path: 'id' }, { path: '$label' }],
        filter: { groups: [[{ path: 'id', op: 'in', value: ['north-ada', 'south-grace'] }]] },
        limit: 2,
      },
    }),
  );
  assert.deepEqual(
    (names.rows as Array<Record<string, unknown>>).map((row) => [row.id, row.$label]),
    [['north-ada', 'Ada Lovelace']],
  );
  const through = ok(
    await f.data('/api/view/run', north, {
      view: {
        id: 'history:ticket',
        name: '',
        base: 'ticket',
        columns: [{ path: 'id' }, { path: 'assignee.$label' }],
        filter: { groups: [[{ path: 'id', op: 'in', value: ['north-1', 'south-1'] }]] },
        limit: 2,
      },
    }),
  );
  assert.deepEqual(
    (through.rows as Array<Record<string, unknown>>).map((row) => [row.id, row['assignee.$label']]),
    [['north-1', 'Ada Lovelace']],
  );
  // A label path asked of a plain read is the request's fault, said as one, and the session stays.
  const wrong = await f.data('/api/query', north, { table: 'person', columns: ['id', '$label'], limit: 1, offset: 0 });
  assert.equal(wrong.status, 400, wrong.text);
  assert.equal(wrong.body.code, 'invalid_read');
  assert.equal(
    (ok(await f.data('/api/query', north, { table: 'person', columns: ['id'], limit: 5, offset: 0 })).rows as unknown[]).length,
    2,
  );
});

test("another customer's record is not found, the same as a missing one, and the session stays (G24)", async (t) => {
  const f = await fixture(t),
    north = await f.open();
  for (const id of ['south-1', 'no-such-ticket']) {
    for (const path of ['/api/pages/compose', '/api/pages/plan']) {
      const reply = await f.data(path, north, { page: 'ticket', key: { id } });
      assert.equal(reply.status, 404, `${path} ${id}: ${reply.text}`);
      assert.equal(reply.body.code, 'not_found');
      assert.doesNotMatch(reply.text, /South secret|south-grace/);
    }
  }
  // The lease still answers.
  assert.equal(ok(await f.data('/api/pages/compose', north, { page: 'ticket', key: { id: 'north-1' } })).planned, true);
});

test("a document is offered as its record's verb and read in the member's tenant, never another's", async (t) => {
  const f = await fixture(t),
    north = await f.open();
  const app = object(ok(await f.data('/api/app', north, undefined)).app);
  assert.deepEqual(app.documents, [{ id: 'slip', base: 'ticket', label: 'Ticket slip' }]);
  assert.ok(
    !(app.pages as Array<{ id: string }> | undefined)?.some((page) => page.id === 'slip'),
    'a document is not a page a record opens on',
  );
  const own = await f.data('/api/pages/compose', north, { page: 'slip', key: { id: 'north-1' } });
  assert.equal(own.body.planned, true, own.text);
  assert.match(own.text, /Printer jammed/);
  for (const id of ['south-1', 'no-such-ticket']) {
    for (const path of ['/api/pages/compose', '/api/pages/plan']) {
      const reply = await f.data(path, north, { page: 'slip', key: { id } });
      assert.equal(reply.status, 404, `${path} ${id}: ${reply.text}`);
      assert.doesNotMatch(reply.text, /South secret|south-grace/);
    }
  }
});

test("a natural key unique within its tenant addresses the tenant's own record (G23)", async (t) => {
  const f = await fixture(t),
    north = await f.open(),
    south = await f.open('south');
  // The address /tickets/1 is resolved as the client resolves it: by the column, in the lease's tenant.
  const find = async (context: Context) =>
    (
      ok(
        await f.data('/api/query', context, {
          table: 'ticket',
          filter: { groups: [[{ column: 'number', op: '=', value: '1' }]] },
          limit: 2,
          offset: 0,
        }),
      ).rows as Array<Record<string, unknown>>
    ).map((row) => row.id);
  assert.deepEqual(await find(north), ['north-1']);
  assert.deepEqual(await find(south), ['south-1']);
  // And the check accepts it: the catalog reports the pair, and a tenant-owned resource is proven by it.
  const adapter = new SqliteAdapter(f.path, 'desk');
  try {
    const schema = await adapter.introspect();
    assert.deepEqual(schema.tables.find((table) => table.id === 'ticket')?.uniquePairs, [['tenant_id', 'number']]);
    const book = appAddressBook({
      views: f.app.views as never,
      order: Object.keys(f.app.views),
      resources: f.app.resources ?? {},
      pages: [],
      tables: schema.tables,
    });
    assert.deepEqual(
      naturalKeyProblems(book, (table) => f.app.resources?.[table]?.owner === 'tenant'),
      [],
    );
    /* And in the catalog the tenant realm is judged against, which hides the ownership column: the pair
       stays, so the address is accepted at startup and not only here. */
    const owned = {
      schema,
      ownership: Object.fromEntries(schema.tables.map((table) => [table.id, { kind: 'tenant', column: 'tenant_id' }])),
    } as unknown as TenantOwnershipSnapshot;
    const realm = tenantAuthoringSchema(owned).tables.find((table) => table.id === 'ticket')!;
    assert.equal(
      realm.columns.some((column) => column.name === 'tenant_id'),
      false,
    );
    assert.deepEqual(realm.uniquePairs, [['tenant_id', 'number']]);
    const judged = appAddressBook({
      views: f.app.views as never,
      order: Object.keys(f.app.views),
      resources: f.app.resources ?? {},
      pages: [],
      tables: tenantAuthoringSchema(owned).tables,
    });
    assert.deepEqual(
      naturalKeyProblems(judged, (table) => f.app.resources?.[table]?.owner === 'tenant'),
      [],
    );
  } finally {
    await adapter.close();
  }
});
