/**
 * `field.member()`: a command input that names a person on the tenant's team, by account id. The form offers the
 * team's names (/api/team); the server refuses, at the field, an id that is not an active member of the command's own
 * tenant, however the request was made: another tenant's member, a removed one, one who never was, an id in a crafted
 * request the form never offered. `check` refuses the field where there is no team to name one of.
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
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createBusinessCommandAuthorizer } from '../packages/mistri/src/server/commands/businessCommandAuthorization.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { commandInputProblems } from '../packages/mistri/src/shared/commandInput.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { renderApiInputSchema } from '../packages/mistri/src/server/api/apiInputSchema.js';
import { refusalReasons } from '../packages/engine/src/server/evidence.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = {
  tabId: string;
  context: string;
  accountId: string;
  tenantId: string;
  revision: number;
};
const appId = 'desk';
const assignInput = { owner: { type: 'text', format: 'member' } } as const;

function deskApp(team?: false) {
  return parseTestApp(
    {
      id: appId,
      name: 'Desk',
      auth: {
        rows: 'tenant',
        ...(team === false ? { tenancy: { team: false } } : {}),
        roles: { employee: { read: true, commands: ['assign'] } },
      },
      sources: { business: { connection: 'business-db' } },
      resources: {
        ticket: {
          owner: 'tenant',
          access: 'write',
          fields: { read: ['id', 'title', 'owner', 'version'] },
          actions: {
            assign: {
              label: 'Assign',
              command: {
                id: 'assign',
                version: 1,
                target: 'ticket',
                input: assignInput,
              },
            },
          },
        },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      nav: ['tickets'],
      home: 'tickets',
    },
    'desk fixture',
  );
}

const assign = () =>
  defineCommands({
    assign: defineCommand({
      source: 'business',
      target: 'ticket',
      input: { owner: field.member() },
      output: { parse: (value: unknown) => value as { id: string } },
      async handle({ db: records, record }, input) {
        await records.ticket.update(record, {
          owner: input.owner,
          version: Number(record.version) + 1,
        });
        return { id: String(record.id) };
      },
    }),
  });

async function fixture(t: TestContext, options: { team?: false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-command-member-')),
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
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE ticket(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, owner TEXT,
      version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO ticket VALUES ('north-1','north','Printer jammed',NULL,0),('south-1','south','South secret',NULL,0);`);
  const binding = {
    appId,
    source: { id: 'business', connection: 'business-db' },
    storeId: 'desk-store',
  };
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  provisionSqliteRecordHistory(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, binding);
  for (const tenantId of ['north', 'south'])
    await admin.putTenant({
      tenantId,
      status: 'active',
      expectedVersion: null,
    });
  /* North: eve (who acts) and ada are members; rex was, and was removed; ivy was invited and never joined.
     South: sam is a member there and nowhere else. */
  const members: Array<[string, string, 'active' | 'revoked' | 'invited']> = [
    ['north', 'eve', 'active'],
    ['north', 'ada', 'active'],
    ['north', 'rex', 'active'],
    ['north', 'ivy', 'invited'],
    ['south', 'eve', 'active'],
    ['south', 'sam', 'active'],
  ];
  for (const [tenantId, accountId, status] of members)
    await admin.putMembership({
      tenantId,
      accountId,
      membershipId: `${tenantId}-${accountId}`,
      status,
      roles: ['employee'],
      validUntil: 10000,
      expectedVersion: null,
    });
  // Removed: written as a member first, then revoked, as the administration removes someone.
  await admin.putMembership({
    tenantId: 'north',
    accountId: 'rex',
    membershipId: 'north-rex',
    status: 'revoked',
    roles: ['employee'],
    validUntil: 10000,
    expectedVersion: '1',
  });
  await operations.finish();
  db.exec('COMMIT');
  const app = deskApp(options.team);
  const rows: RowScope = { ticket: true };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId,
    storeId: binding.storeId,
    ownership: { ticket: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    resultReferences: {
      assign: (result) => [{ table: 'ticket', key: { id: String((result as { id: string }).id) } }],
    },
  });
  enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'desk-deployment',
    roles: ['employee'],
    maxLifetimeMs: 300000,
    now: () => 1000,
    commands: { registry: assign() },
    verifySession: async () => ({ id: 'eve', who: 'Eve' }),
  });
  const session: VerifiedSessionInstance = {
    identity: { id: 'eve', who: 'Eve' },
    sessionId: 'session-eve',
    expiresAt: 20000,
  };
  const bound = { host: '127.0.0.1', port: 0 };
  owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: () => session,
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: JSON.parse(text) as Record<string, unknown>,
    };
  };
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  const open = async (tenant = 'north'): Promise<Context> => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as unknown as Context;
  };
  const data = (path: string, value: Context, body: unknown) =>
    call(select(path, value.tenantId), body, {
      'x-mistri-tab': value.tabId,
      'x-mistri-context': value.context,
      'x-mistri-lease-revision': String(value.revision),
      'x-mistri-account': value.accountId,
    });
  let attempt = 0;
  /* What a form, a page's `run`, the test kit and the App's own client all send: the command's execute request. */
  const assignTo = (context: Context, ticket: string, accountId: unknown) =>
    data('/api/commands/execute', context, {
      command: 'assign',
      commandVersion: 1,
      key: { id: ticket },
      expectedVersion: 0,
      idempotencyKey: `assign-attempt-${String(++attempt).padStart(4, '0')}`,
      input: { owner: accountId },
    });
  const ownerOf = (ticket: string) =>
    (
      db.prepare('SELECT owner FROM ticket WHERE id = ?').get(ticket) as {
        owner: string | null;
      }
    ).owner;
  return { open, data, assignTo, ownerOf };
}

test('a member input admits an active member of the tenant, and refuses every other id at its field', async (t) => {
  const f = await fixture(t),
    north = await f.open();
  for (const [who, why] of [
    ['nobody', 'an account that is no member anywhere'],
    ['sam', "another tenant's member"],
    ['rex', 'a member who was removed'],
    ['ivy', 'an invitation never redeemed'],
  ] as const) {
    const refused = await f.assignTo(north, 'north-1', who);
    assert.equal(refused.status, 400, `${why}: ${refused.text}`);
    assert.equal(refused.body.code, 'invalid_input', why);
    assert.equal(refused.body.field, 'owner', why);
    assert.equal(refused.body.message, 'This is not a member of the team.', why);
    assert.equal(f.ownerOf('north-1'), null, `${why}: nothing was written`);
  }
  // A value that is not an account id at all is refused by its shape, before anything is read.
  const shaped = await f.assignTo(north, 'north-1', 'not an id');
  assert.equal(shaped.status, 400, shaped.text);
  assert.equal(shaped.body.field, 'owner');
  // A member of this tenant, and the actor themself, are admitted.
  const applied = await f.assignTo(north, 'north-1', 'ada');
  assert.equal(applied.status, 200, applied.text);
  assert.equal(f.ownerOf('north-1'), 'ada');
  // The same id is judged by the tenant the command runs in: sam is south's.
  const south = await f.open('south');
  assert.equal((await f.assignTo(south, 'south-1', 'ada')).body.field, 'owner', "north's member is not south's");
  assert.equal((await f.assignTo(south, 'south-1', 'sam')).status, 200);
  assert.equal(f.ownerOf('south-1'), 'sam');
});

test('check refuses a member input where there is no team to name one of', async (t) => {
  // auth.tenancy.team: false: no one may list the team, so no form could offer anyone.
  // Enrollment answers with its one opaque refusal; the reason it records is what startup and `check` say.
  await assert.rejects(fixture(t, { team: false }), (error) => {
    assert.match(String(refusalReasons(error).join('\n')), /\[command-member\][^\n]*auth\.tenancy\.team is false/);
    return true;
  });
  // An ordinary App has accounts but no team: the field is a tenant App's.
  const ordinary = parseTestApp(
    {
      id: 'stock',
      name: 'Stock',
      sources: { main: { connection: 'x', default: true } },
      resources: {
        bin: {
          access: 'write',
          actions: {
            assign: {
              label: 'Assign',
              command: {
                id: 'assign',
                version: 1,
                target: 'bin',
                input: assignInput,
              },
            },
          },
        },
      },
      auth: { roles: { clerk: { read: true, commands: ['assign'] } } },
      views: { bins: { kind: 'list', from: 'bin' } },
      home: 'bins',
      nav: ['bins'],
    },
    'ordinary fixture',
  );
  const schema = {
    dialect: 'sqlite',
    foreignKeys: [],
    tables: [
      {
        id: 'bin',
        schema: 'main',
        name: 'bin',
        isView: false,
        rowCount: 0,
        foreignKeys: [],
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'owner', type: 'TEXT', nullable: true, primaryKey: false },
          {
            name: 'version',
            type: 'INTEGER',
            nullable: false,
            primaryKey: false,
          },
        ],
      },
    ],
  };
  const registry = defineCommands({
    assign: defineCommand({
      source: 'main',
      target: 'bin',
      input: { owner: field.member() },
      output: { parse: (value: unknown) => value },
      handle: () => ({}),
    }),
  });
  assert.throws(
    () =>
      createBusinessCommandAuthorizer({
        app: ordinary,
        registry,
        schema: schema as never,
        connectionFor: () => 'x',
        writableConnection: () => true,
        transactionalConnection: () => true,
      }),
    /\[command-member\][^\n]*App "stock" has no team/,
  );
});

test('a member input is declared once: an account id, never on a public form or in a group, and said to the API', () => {
  const [declared] = parseCommandInput({ owner: field.member() }, 'assign');
  assert.deepEqual({ type: declared.type, format: (declared as { format?: string }).format }, { type: 'text', format: 'member' });
  assert.throws(() => parseCommandInput({ owner: field.member() }, 'ask', { publicForm: true }), /a public form has no team/);
  assert.throws(
    () => parseCommandInput({ crew: field.group({ owner: field.member() }) }, 'assign'),
    /a member of the team is a field of the input itself/,
  );
  assert.throws(() => parseCommandInput({ owner: { type: 'text', format: 'member', pattern: 'x' } }, 'assign'), /takes no pattern/);
  // The shape is the shared reader's, in the browser as on the server.
  assert.equal(commandInputProblems([declared], { owner: 'ada' }).length, 0);
  assert.equal(commandInputProblems([declared], { owner: 'not an id' })[0]?.reason, 'format');
  const rendered = renderApiInputSchema({
    input: { owner: field.member() },
  }) as {
    schema: {
      properties: Record<string, { type?: string; description?: string }>;
    };
  };
  assert.equal(rendered.schema.properties.owner.type, 'string');
  assert.match(String(rendered.schema.properties.owner.description), /active member of the tenant/);
});
