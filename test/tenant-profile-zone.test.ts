/**
 * `ui.timezone: { column }` naming the platform-owned tenant profile: each tenant's person reads their days on the
 * zone their tenant's profile row holds, though no role is granted that resource and the scope catalog does not hold
 * it (the platform reads that one column itself, as it reads the row's name). A null, unknown or empty zone is the
 * App's own, and a column the profile does not have is refused by `zoneColumnProblem`.
 *
 * On SQLite always and on PostgreSQL where `TABLEWALK_TEST_PG` names a server: the platform's read of the profile
 * column is its own statement on the tenant source (readTenantZone), and each engine spells the catalog it reads.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { zoneColumnProblem } from '../packages/mistri/src/server/app/readerZone.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-profile-zone-store' };
const ZONES = { north: 'America/Chicago', south: 'Pacific/Kiritimati' } as const;
const OWN = 'America/New_York';

const dayIn = (zone: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Customer', profile: 'customer', platform: { label: 'Operator' } },
      /* No grant on the profile: the zone is the platform's own read of it. */
      roles: { agent: { realm: 'tenant', read: ['ticket'], commands: ['stampToday'] }, operator: { realm: 'platform', read: true } },
    },
    sources: { business: { connection: binding.source.connection } },
    ui: { timezone: { column: 'customer.timezone', default: OWN } },
    resources: { customer: { owner: 'platform' }, ticket: { owner: 'tenant', access: 'write' } },
    views: { tickets: { kind: 'list', from: 'ticket', realm: 'tenant' } },
    home: 'tickets',
    nav: [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['tickets'] }],
  },
  'desk zone fixture',
);

/* A command that stamps a ticket with the day its handler counts. */
const registry = defineCommands({
  stampToday: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    read: ['ticket'],
    write: ['ticket'],
    input: { id: { type: 'text' } },
    output: { parse: (value: unknown) => value as { id: string } },
    async handle({ db, today }, input) {
      await db.ticket.insert({ id: String(input.id), opened_on: today() });
      return { id: String(input.id) };
    },
  }),
});
const rows: RowScope = { ticket: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: { customer: { kind: 'platform' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
  resultReferences: { stampToday: () => [] },
  resolvePlatformRows: () => ({ ...rows, customer: true }),
});

/* Each tenant has a ticket opened on Chicago's today and one on Kiritimati's
   (a day apart for most of every day); `today` picks the tenant's own. */
async function fixture(t: TestContext, dialect: TenantDialect) {
  const suffix = `pzone_${randomUUID().replaceAll('-', '')}`;
  const chicago = dayIn(ZONES.north),
    kiritimati = dayIn(ZONES.south);
  const tables = `
    CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, timezone TEXT);
    CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, opened_on DATE NOT NULL);
    INSERT INTO customer VALUES ('north', 'North', '${ZONES.north}'), ('south', 'South', '${ZONES.south}'),
      ('west', 'West', 'Not/AZone'), ('empty', 'Empty', ''), ('none', 'None', NULL);
    INSERT INTO ticket VALUES
      ('north-chi', 'north', '${chicago}'), ('north-kir', 'north', '${kiritimati}'),
      ('south-chi', 'south', '${chicago}'), ('south-kir', 'south', '${kiritimati}');`;
  const engine = await openTenantEngine(dialect, {
    tables: ['customer', 'ticket'],
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
    for (const tenantId of ['north', 'south', 'west', 'empty', 'none']) {
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
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'desk-profile-zone-deployment',
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
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  const open = async (tenant: string): Promise<Context> => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as unknown as Context;
  };
  const data = (path: string, lease: Context, body: unknown) =>
    call(select(path, lease.tenantId), body, {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    });
  const served = async (lease: Context) => {
    const reply = await data('/api/app', lease, undefined);
    assert.equal(reply.status, 200, reply.text);
    return (reply.body.app as { ui: { timezone?: string; clockZone?: string } }).ui;
  };
  const today = async (lease: Context) => {
    const reply = await data('/api/run', lease, { q: 'ticket opened_on = today', limit: 50, offset: 0, count: 'none' });
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.body.errors ?? [], [], reply.text);
    return (reply.body.rows as Array<Record<string, unknown>>).map((row) => row.id).sort();
  };
  const read = (lease: Context, table: string) =>
    data('/api/run', lease, { q: table, limit: 5, offset: 0, count: 'none' }).catch((error) => ({
      status: 0,
      text: String(error),
      body: {},
    }));
  const stamp = async (lease: Context, id: string) => {
    const reply = await data('/api/commands/execute', lease, {
      command: 'stampToday',
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: `stamp-${id}-attempt`,
      input: { id },
    });
    assert.equal(reply.status, 200, reply.text);
    return String((await engine.get('SELECT CAST(opened_on AS TEXT) AS opened_on FROM ticket WHERE id = ?', [id]))?.opened_on);
  };
  return { open, served, today, stamp, read, chicago, kiritimati };
}

test('check refuses a profile zone column the profile does not have, naming it', () => {
  const catalog = (columns: string[]): DatabaseSchema => ({
    label: 'Desk',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'customer',
        name: 'customer',
        schema: '',
        isView: false,
        columns: columns.map((name, index) => ({ name, type: 'TEXT', nullable: index > 0, primaryKey: index === 0 })),
      },
    ],
  });
  assert.equal(zoneColumnProblem(app, catalog(['id', 'timezone'])), undefined);
  assert.match(zoneColumnProblem(app, catalog(['id', 'name'])) ?? '', /"customer" has no column "timezone"/);
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a profile's zone on ${dialect}`, { skip }, () => {
    test("each tenant's person reads their days in the zone their profile row holds, with no grant on the profile", async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north'),
        south = await f.open('south');
      const expected = (tenant: 'north' | 'south', zone: string) =>
        [`${tenant}-chi`, `${tenant}-kir`].filter((id) => (id.endsWith('chi') ? f.chicago : f.kiritimati) === dayIn(zone)).sort();
      for (let round = 0; round < 2; round++) {
        const northUi = await f.served(north);
        assert.deepEqual([northUi.timezone, northUi.clockZone], [ZONES.north, OWN]);
        assert.deepEqual(await f.today(south), expected('south', ZONES.south));
        assert.equal((await f.served(south)).timezone, ZONES.south);
        assert.deepEqual(await f.today(north), expected('north', ZONES.north));
      }
      assert.equal((await f.served(south)).clockZone, OWN, 'writes keep one clock whoever caused them');
    });

    test('a null, empty or unknown zone on the profile is the App’s own, silently', async (t) => {
      const f = await fixture(t, dialect);
      for (const tenant of ['west', 'empty', 'none']) assert.equal((await f.served(await f.open(tenant))).timezone, OWN, tenant);
    });

    test('the profile is not readable through the zone: no other column, and no grant is implied', async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north');
      const reply = await f.read(north, 'customer');
      assert.match(reply.text, /No table called/);
      assert.doesNotMatch(reply.text, /America\/Chicago|North/);
    });

    test("a tenant command's today() is the day of the profile's zone, the day the reads count", async (t) => {
      const f = await fixture(t, dialect);
      for (const tenant of ['north', 'south'] as const) {
        const lease = await f.open(tenant);
        assert.equal(await f.stamp(lease, `${tenant}-stamped`), dayIn(ZONES[tenant]), tenant);
      }
      // The same lease's list for today finds what it stamped.
      assert.ok((await f.today(await f.open('south'))).includes('south-stamped'));
    });
  });
