/**
 * A fixed action granted without write (`roles.<role>.actions`) in a tenant App, over the tenant HTTP host: the member's
 * own writer admits exactly the action (its `when` read through the tenant's rows, its stamps the server's clock and the
 * member's person row), on the tenant's rows alone, and the tenant column is never part of it.
 *
 * What is proved here: a clerk (an action grant, no write) moves a draft to sent and gets the machine's `since` and the
 * action's `me` stamps; the same clerk cannot write any other column or the owner column; another tenant's row is not
 * found; a false `when` is refused in words; the action is in the clerk's payload and not the viewer's; and the move is
 * in the record's history.
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
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseTestApp } from './support/commandCatalog.js';

type Dialect = 'sqlite' | 'postgres';
type Answer = { status: number; text: string; body: any };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-actions-store' };

/* Ada is a clerk and Eve a lead in north, Bea a viewer there; Sam is a clerk in south. Each is a person row of their own
   tenant, found by account id. An invoice's draft with no amount (north-empty) is one the action's `when` refuses. */
const TABLES = `
  CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO customer VALUES ('north', 'North'), ('south', 'South');
  CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL,
    UNIQUE (tenant_id, account_id));
  CREATE TABLE item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL,
    state TEXT NOT NULL, sent_by TEXT REFERENCES person(id), sent_at TEXT);
  INSERT INTO person VALUES ('north-ada', 'north', 'ada', 'Ada'), ('north-eve', 'north', 'eve', 'Eve'),
    ('north-bea', 'north', 'bea', 'Bea'), ('south-sam', 'south', 'sam', 'Sam');
  INSERT INTO item (id, tenant_id, title, amount, state) VALUES ('north-one', 'north', 'North one', 10, 'draft'),
    ('north-two', 'north', 'North two', 20, 'draft'), ('north-empty', 'north', 'North empty', 0, 'draft'),
    ('south-one', 'south', 'South one', 30, 'draft');`;

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: {
      rows: 'tenant',
      /* The tenant profile is platform-owned, so the tenant's scope catalog does not hold it: the fixed action's grant is
         read off the capabilities, not resolved again against that catalog (a field report). */
      tenancy: { label: 'Customer', profile: 'customer', platform: { label: 'Operator' } },
      me: { from: 'person', column: 'account_id' },
      roles: {
        clerk: { realm: 'tenant', read: true, actions: { item: ['send'] } },
        lead: { realm: 'tenant', read: true, write: ['item'] },
        viewer: { realm: 'tenant', read: true },
        operator: { realm: 'platform', read: true },
      },
    },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      customer: { owner: 'platform' },
      person: { owner: 'tenant' },
      item: {
        owner: 'tenant',
        access: 'write',
        machine: {
          column: 'state',
          since: 'sent_at',
          states: { draft: { on: { send: { to: 'sent', set: { sent_by: { auto: 'me' } }, when: 'amount > 0' } } }, sent: { final: true } },
        },
      },
    },
    views: { items: { kind: 'list', from: 'item', realm: 'tenant' } },
    home: 'items',
    nav: [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['items'] }],
  },
  'tenant fixed actions fixture',
);

const everything: RowScope = { person: true, item: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    customer: { kind: 'platform' },
    person: { kind: 'tenant', column: 'tenant_id' },
    item: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => everything,
  resolveRows: () => everything,
  resolvePlatformRows: () => ({ ...everything, customer: true }),
});

/* The verb's own words, as the bar sends them: the move, the member's `me` and the machine's `since`; the server resolves both. */
const SEND = { state: 'sent', sent_by: 'me', sent_at: 'now' };
const ROLES: Record<string, string> = { ada: 'clerk', eve: 'lead', bea: 'viewer', sam: 'clerk' };

interface Lab {
  source: { id: string; connection: string; existingPath: string } | { id: string; connection: string; url: string };
  admin(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
  item(id: string): Promise<Record<string, unknown>>;
}

async function sqliteLab(t: TestContext): Promise<Lab> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-fixed-actions-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${TABLES}`);
  provisionSqliteTenantStore(path, binding);
  provisionSqliteRecordHistory(path);
  return {
    source: { ...binding.source, existingPath: path },
    async admin(run) {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    },
    item: async (id) => ({ ...db.prepare('SELECT * FROM item WHERE id = ?').get(id)! }),
  };
}

/* The same tables and rows in a database of this file's own on the server TABLEWALK_TEST_PG names. */
async function postgresLab(t: TestContext): Promise<Lab> {
  const { url, drop } = await uuidPostgresDatabase('tw_tenant_actions');
  const control = await pgClient(url);
  t.after(async () => {
    await control.end().catch(() => {});
    await drop();
  });
  await control.query(TABLES);
  await migratePostgresTenantStore(url, binding);
  await provisionPostgresRecordHistory(url);
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
    item: async (id) => ({ ...(await control.query('SELECT * FROM item WHERE id = $1', [id])).rows[0] }),
  };
}

async function fixture(t: TestContext, dialect: Dialect) {
  const lab = await (dialect === 'sqlite' ? sqliteLab(t) : postgresLab(t));
  await lab.admin(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const [tenantId, accountId] of [
      ['north', 'ada'],
      ['north', 'eve'],
      ['north', 'bea'],
      ['south', 'sam'],
    ])
      await admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles: [ROLES[accountId]],
        validUntil: Date.now() + 3_600_000,
        expectedVersion: null,
      });
  });
  /** Who the session is, per request: a case switches accounts here. */
  const as = { account: 'eve' };
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: parsePagesConfig(
      { pages: [{ id: 'items', label: 'Item', base: 'item', sections: [{ kind: 'fields', show: ['title'] }, { kind: 'history' }] }] },
      'history fixture',
    ),
    policy,
    source: lab.source,
    deployment: 'desk-actions-deployment',
    roles: ['clerk', 'lead', 'viewer'],
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: as.account, who: `${as.account}@example.invalid` }),
  });
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: (): VerifiedSessionInstance => ({
      identity: { id: as.account, who: `${as.account}@example.invalid` },
      sessionId: `session-${as.account}`,
      expiresAt: Date.now() + 3_600_000,
    }),
  });
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
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  /** The account's lease on its tenant. */
  const open = async (account: string, tenant: string): Promise<Context> => {
    as.account = account;
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as Context;
  };
  const data = (path: string, lease: Context, body: unknown) => {
    as.account = lease.accountId;
    return call(select(path, lease.tenantId), body, {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    });
  };
  return {
    open,
    data,
    read: async (path: string, lease: Context): Promise<Answer> => {
      as.account = lease.accountId;
      const response = await fetch(`http://${bound.host}:${bound.port}${select(path, lease.tenantId)}`, {
        headers: {
          'x-mistri-tab': lease.tabId,
          'x-mistri-context': lease.context,
          'x-mistri-lease-revision': String(lease.revision),
          'x-mistri-account': lease.accountId,
        },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    },
    update: (lease: Context, id: string, values: Record<string, unknown>) =>
      data('/api/update', lease, { table: 'item', key: { id }, values }),
    item: lab.item,
  };
}

/* The clock's digits as a zone-less text moment holds them (the App names no zone: UTC). */
const moment = (value: unknown) => {
  assert.equal(typeof value, 'string');
  assert.match(String(value), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  const at = Date.parse(`${String(value).replace(' ', 'T')}Z`);
  assert.ok(Math.abs(Date.now() - at) < 60_000, `${value} is now`);
};

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG) },
])
  describe(`fixed actions in a tenant App on ${dialect}`, { skip }, () => {
    test("a clerk's granted action moves a draft to sent, stamped with the member's row and the clock, and is in the record's history", async (t) => {
      const f = await fixture(t, dialect);
      const ada = await f.open('ada', 'north');
      const sent = await f.update(ada, 'north-one', SEND);
      assert.equal(sent.status, 200, sent.text);
      const one = await f.item('north-one');
      assert.deepEqual([one.state, one.sent_by, one.tenant_id], ['sent', 'north-ada', 'north']);
      moment(one.sent_at);
      // The same verb in south is Sam's own row there, and nothing else moved.
      const sam = await f.open('sam', 'south');
      assert.equal((await f.update(sam, 'south-one', SEND)).status, 200);
      assert.equal((await f.item('south-one')).sent_by, 'south-sam');
      assert.equal((await f.item('north-two')).state, 'draft');
      const history = await f.data('/api/record-history', ada, { table: 'item', key: { id: 'north-one' } });
      assert.equal(history.status, 200, history.text);
      assert.ok(JSON.stringify(history.body).includes('sent'), history.text);
    });

    test('the grant admits the action alone: no other column, no owner column, no stamp the body names', async (t) => {
      const f = await fixture(t, dialect);
      const ada = await f.open('ada', 'north');
      for (const values of [
        { title: 'Renamed' },
        { amount: 99 },
        { tenant_id: 'south' },
        { ...SEND, title: 'Renamed' },
        { ...SEND, sent_at: '1999-01-01 00:00:00' },
        { ...SEND, tenant_id: 'south' },
      ]) {
        const answer = await f.update(ada, 'north-one', values);
        assert.notEqual(answer.status, 200, `${JSON.stringify(values)} ${answer.text}`);
      }
      assert.deepEqual(
        [
          (await f.item('north-one')).title,
          (await f.item('north-one')).amount,
          (await f.item('north-one')).state,
          (await f.item('north-one')).tenant_id,
          (await f.item('north-one')).sent_at,
        ],
        ['North one', 10, 'draft', 'north', null],
      );
      // A viewer holds no action: the same body that moves Ada's row is refused.
      const bea = await f.open('bea', 'north');
      assert.notEqual((await f.update(bea, 'north-one', SEND)).status, 200);
      assert.equal((await f.item('north-one')).state, 'draft');
    });

    test("another tenant's row is not found, and a false `when` is refused in words", async (t) => {
      const f = await fixture(t, dialect);
      const ada = await f.open('ada', 'north');
      const foreign = await f.update(ada, 'south-one', SEND);
      assert.ok([403, 404].includes(foreign.status), foreign.text);
      assert.doesNotMatch(foreign.text, /South one/);
      assert.equal((await f.item('south-one')).state, 'draft');
      // An invoice with no amount: the verb's `when` (amount > 0) is false on the stored row.
      const refused = await f.update(ada, 'north-empty', SEND);
      assert.ok([403, 409, 422].includes(refused.status), refused.text);
      assert.match(String(refused.body.error ?? refused.body.errors?.[0]?.message ?? refused.text), /\w+ \w+/, 'said in words');
      assert.equal((await f.item('north-empty')).state, 'draft');
    });

    test('the action is in the payload of a role granted it and absent for another', async (t) => {
      const f = await fixture(t, dialect);
      const grants = async (account: string) => {
        const lease = await f.open(account, 'north');
        const { app } = (await f.read('/api/app', lease)).body;
        const verbs = (app.resources.item.actions ?? []).map((action: { id: string }) => action.id);
        return { verbs, granted: app.grantedActions };
      };
      const ada = await grants('ada');
      assert.deepEqual(ada.verbs, ['send']);
      assert.deepEqual(ada.granted, { item: ['send'] });
      const bea = await grants('bea');
      assert.deepEqual(bea.verbs, []);
      assert.equal(bea.granted, undefined);
      // A lead writes the table, so the action is offered by the write itself, not as a grant without write.
      assert.equal((await grants('eve')).granted, undefined);
    });
  });

test('the generated isolation suite aims each granted action at another tenant’s record', async () => {
  const { tenantsModule } = await import('../packages/mistri/src/server/cli/testInitTenant.js');
  const grants = new Map([
    ['clerk', { read: new Set(['person', 'item']), commands: new Set<string>(), actions: new Set(['item Send']) }],
    ['lead', { read: new Set(['person', 'item']), commands: new Set<string>() }],
  ]);
  const suite = await tenantsModule({ app } as never, grants as never, ['north', 'south']);
  assert.match(suite, /\['item', '\{"sent_by":"me","state":"sent","sent_at":"now"\}', 'clerk', 'clerk', 'send'\]/);
  assert.match(suite, /refused on another customer's record/);
  assert.match(suite, /\/api\/update/);
});
