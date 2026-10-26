/**
 * `me` in a tenant App, over the tenant HTTP host, on each engine: one account
 * is a person row in each tenant it belongs to (`auth.me` names the account
 * column), and `assignee = me` is that tenant's row — resolved on every
 * request from the admitted lease, never from what a request says, and never
 * another tenant's. A membership with no row in its tenant matches nothing.
 * The person's own memberships (`team_id in (me.team_member.team_id)`) are read the same way, through the lease: another team's
 * tickets are not theirs, and a row of another tenant naming them is none.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

type Dialect = 'sqlite' | 'postgres';
type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-me-store' };

const TABLES = `
  CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL,
    UNIQUE (tenant_id, account_id));
  CREATE TABLE team (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE team_member (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, person_id TEXT NOT NULL REFERENCES person(id),
    team_id TEXT NOT NULL REFERENCES team(id));
  CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
    assignee TEXT REFERENCES person(id), filed_by TEXT, team_id TEXT REFERENCES team(id));
  INSERT INTO person VALUES ('north-eve', 'north', 'eve', 'Eve North'), ('north-ada', 'north', 'ada', 'Ada'),
    ('south-eve', 'south', 'eve', 'Eve South');
  INSERT INTO team VALUES ('north-net', 'north', 'Network'), ('north-hw', 'north', 'Hardware'), ('south-net', 'south', 'Network');
  -- Eve is in north's Network team and south's; a south row naming north's Eve in north's Hardware is south's, not hers in north.
  INSERT INTO team_member VALUES ('m1', 'north', 'north-eve', 'north-net'), ('m2', 'north', 'north-ada', 'north-hw'),
    ('m3', 'south', 'south-eve', 'south-net'), ('m4', 'south', 'north-eve', 'north-hw');
  INSERT INTO ticket VALUES ('north-1', 'north', 'Printer jammed', 'north-eve', 'eve@example.invalid', 'north-net'),
    ('north-2', 'north', 'Screen flickers', 'north-ada', 'ada@example.invalid', 'north-hw'),
    ('south-1', 'south', 'Badge lost', 'south-eve', 'eve@example.invalid', 'south-net'),
    ('west-1', 'west', 'Door stuck', NULL, 'eve@example.invalid', NULL);`;

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: {
      rows: 'tenant',
      // One account is a person row in each of its tenants, found by its account id.
      me: { from: 'person', column: 'account_id' },
      roles: { agent: { read: true } },
    },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      person: { owner: 'tenant', recordLabel: '{name}' },
      team: { owner: 'tenant' },
      team_member: { owner: 'tenant' },
      ticket: {
        owner: 'tenant',
        segments: { assigned_to_me: 'assignee = me', filed_by_me: 'filed_by = me' },
        fields: { read: ['id', 'title', 'assignee', 'filed_by', 'team_id'] },
        // A computed column's `me` is the reader's email, as in any App.
        computed: { mine: { type: 'boolean', value: 'filed_by = me' } },
      },
    },
    views: {
      tickets: {
        kind: 'list',
        from: 'ticket',
        tabs: ['assigned_to_me', 'filed_by_me'],
      },
      today: { kind: 'dashboard', label: 'Today', heading: 'Hello, {me.name}', sections: [{ kind: 'view', view: 'tickets' }] },
    },
    nav: ['today', 'tickets'],
    home: 'today',
  },
  'desk me fixture',
);

const rows: RowScope = { person: true, team: true, team_member: true, ticket: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    person: { kind: 'tenant', column: 'tenant_id' },
    team: { kind: 'tenant', column: 'tenant_id' },
    team_member: { kind: 'tenant', column: 'tenant_id' },
    ticket: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
});

interface Lab {
  source: { id: string; connection: string; existingPath: string } | { id: string; connection: string; url: string };
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
}

async function sqliteLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-me-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${TABLES}`);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  return {
    source: { ...binding.source, existingPath: path },
    async admin(run) {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    },
  };
}

async function postgresLab(t: TestContext): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_me');
  const control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(TABLES);
  await migratePostgresTenantStore(url, binding);
  await migratePostgresCommandJournal(url);
  return {
    source: { ...binding.source, url },
    async admin(run) {
      await control.query('BEGIN');
      const operations = new TransactionOperations();
      try {
        await run(createPostgresTenantAdministration(control, operations, binding));
        await operations.finish();
        await control.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await control.query('ROLLBACK');
        throw error;
      }
    },
  };
}

/** Eve is a member of north, south and west; west has no person row for her. */
async function fixture(t: TestContext, dialect: Dialect) {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t) : postgresLab(t));
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south', 'west']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId,
        accountId: 'eve',
        membershipId: `${tenantId}-eve`,
        status: 'active',
        roles: ['agent'],
        validUntil: Date.now() + 3_600_000,
        expectedVersion: null,
      });
    }
  });
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: lab.source,
    deployment: 'desk-me-deployment',
    roles: ['agent'],
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: 'eve', who: 'eve@example.invalid' }),
  });
  const session: VerifiedSessionInstance = {
    identity: { id: 'eve', who: 'eve@example.invalid' },
    sessionId: 'session-eve',
    expiresAt: Date.now() + 3_600_000,
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({ app, enrollment, bound, verifySessionInstance: () => session, readerName: () => 'Eve Adams' });
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
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  const open = async (tenant: string): Promise<Context> => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as unknown as Context;
  };
  const data = (path: string, lease: Context, body: unknown, tenant = lease.tenantId) =>
    call(select(path, tenant), body, {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    });
  /** The ids a query-language read answers on a lease. */
  const ids = async (lease: Context, q: string) => {
    const reply = await data('/api/run', lease, { q, limit: 50, offset: 0, count: 'none' });
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.body.errors ?? [], [], reply.text);
    return (reply.body.rows as Array<Record<string, unknown>>).map((row) => row.id).sort();
  };
  return { open, data, ids };
}

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG) },
])
  describe(`me in a tenant App on ${dialect}`, { skip }, () => {
    test("one account in two tenants is each tenant's own person, and switching tenant switches me", async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north'),
        south = await f.open('south');
      assert.deepEqual(await f.ids(north, 'ticket assignee = me'), ['north-1']);
      assert.deepEqual(await f.ids(south, 'ticket assignee = me'), ['south-1']);
      // Back in north, me is north's person again: nothing is kept across leases.
      assert.deepEqual(await f.ids(north, 'ticket assignee = me'), ['north-1']);
      assert.deepEqual(await f.ids(north, 'ticket assignee != me'), ['north-2']);
      // Beside text, me is the session's email.
      assert.deepEqual(await f.ids(north, 'ticket filed_by = me'), ['north-1']);
      // A computed column says the reader too.
      const computed = await f.data('/api/run', north, { q: 'ticket mine = true', limit: 50, offset: 0, count: 'none' });
      assert.equal(computed.status, 200, computed.text);
      assert.deepEqual(
        (computed.body.rows as Array<Record<string, unknown>>).map((row) => row.id),
        ['north-1'],
      );
      // A list view's tab asks the same way, as the list sends it.
      const view = await f.data('/api/view/run', north, {
        view: { id: 'tickets', name: '', base: 'ticket', columns: [{ path: 'id' }], limit: 10 },
        query: 'assignee = me',
      });
      assert.equal(view.status, 200, view.text);
      assert.deepEqual(
        (view.body.rows as Array<Record<string, unknown>>).map((row) => row.id),
        ['north-1'],
      );
    });

    test("the person's teams are their own tenant's: another team's tickets, and another tenant's rows naming them, are not theirs", async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north'),
        south = await f.open('south'),
        west = await f.open('west');
      const mine = 'ticket team_id in (me.team_member.team_id)';
      // North's Hardware ticket is Ada's team's; the south row that names north's Eve in it is south's, read by no north lease.
      assert.deepEqual(await f.ids(north, mine), ['north-1']);
      assert.deepEqual(await f.ids(south, mine), ['south-1']);
      // South's lease reads its own rows only: the row naming north's person is not south's Eve, and north's tickets are not south's.
      assert.deepEqual(await f.ids(south, 'ticket team_id in ("north-hw", "north-net")'), []);
      // No person in west: no teams, and nothing fails.
      assert.deepEqual(await f.ids(west, mine), []);
      const counted = await f.data('/api/breakdown', north, { text: `${mine} count` });
      assert.equal(counted.status, 200, counted.text);
      // PostgreSQL's count is a bigint, which the adapter hands on as text rather than risk rounding one past 2^53.
      assert.deepEqual(
        (counted.body.rows as { count: unknown }[]).map((row) => ({ count: Number(row.count) })),
        [{ count: 1 }],
      );
    });

    test('a membership with no person row in its tenant matches nothing, without an error', async (t) => {
      const f = await fixture(t, dialect);
      const west = await f.open('west');
      assert.deepEqual(await f.ids(west, 'ticket assignee = me'), []);
      assert.deepEqual(await f.ids(west, 'ticket assignee != me'), []);
      // The tenant's rows are still there to read; only `me` is nobody.
      assert.deepEqual(await f.ids(west, 'ticket'), ['west-1']);
    });

    test('a request cannot choose who me is: another tenant named on a lease is refused, and a forged body is not read', async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north');
      // The north lease asked as south: the lease, not the address, says the tenant.
      const forged = await f.data('/api/run', north, { q: 'ticket assignee = me', limit: 50, offset: 0, count: 'none' }, 'south');
      assert.ok(forged.status >= 400, forged.text);
      // Words in the body that name a person or a tenant are not who me is.
      const named = await f.data('/api/run', north, {
        q: 'ticket assignee = me',
        limit: 50,
        offset: 0,
        count: 'none',
        me: 'south-eve',
        tenant: 'south',
        accountId: 'ada',
      });
      if (named.status === 200)
        assert.deepEqual(
          (named.body.rows as Array<Record<string, unknown>>).map((row) => row.id),
          ['north-1'],
        );
      else assert.ok(named.status >= 400, named.text);
      // South's person, named outright, is not a row north can match.
      assert.deepEqual(await f.ids(north, 'ticket assignee = "south-eve"'), []);
    });

    test('a dashboard greets the member by their own name, and the tab about me is served', async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north');
      const reply = await f.data('/api/app', north, undefined);
      assert.equal(reply.status, 200, reply.text);
      const served = reply.body.app as { views: Record<string, { heading?: string; tabs?: Array<{ label: string }> }> };
      assert.equal(served.views.today.heading, 'Hello, Eve Adams');
      assert.deepEqual(
        served.views.tickets.tabs?.map((tab) => tab.label),
        ['Assigned to me', 'Filed by me'],
      );
    });
  });
