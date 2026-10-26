/**
 * `ui.timezone: { column }` in a tenant App: each tenant reads its
 * days on its own clock — the zone its settings row names — and no tenant's
 * zone reaches another's response, however the requests interleave. A tenant
 * whose row names none reads the App's own, which is also the clock every
 * tenant's writes keep. And a union (G50) reads each branch in the tenant's
 * own rows, as a read of either table would.
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
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseUi } from '../packages/mistri/src/shared/appUi.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { zoneColumnProblem } from '../packages/mistri/src/server/app/readerZone.js';
import { parseTestApp } from './support/commandCatalog.js';

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-zone-store' };
const ZONES = { north: 'America/Chicago', south: 'Pacific/Kiritimati' } as const;
const OWN = 'America/New_York';

const dayIn = (zone: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: { rows: 'tenant', roles: { agent: { read: true } } },
    sources: { business: { connection: binding.source.connection } },
    ui: { timezone: { column: 'desk_setting.timezone', default: OWN } },
    resources: { desk_setting: { owner: 'tenant' }, ticket: { owner: 'tenant' } },
    unions: [
      {
        name: 'everything',
        branches: [
          { from: 'ticket', as: { label: 'id' } },
          { from: 'desk_setting', as: { label: 'timezone' } },
        ],
      },
    ],
    views: { tickets: { kind: 'list', from: 'ticket' } },
    home: 'tickets',
  },
  'desk zone fixture',
);

const rows: RowScope = { desk_setting: true, ticket: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: { desk_setting: { kind: 'tenant', column: 'tenant_id' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
});

/* Each tenant has a ticket opened on Chicago's today and one on Kiritimati's
   (a day apart for most of every day); `today` picks the tenant's own. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-zone-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const chicago = dayIn(ZONES.north),
    kiritimati = dayIn(ZONES.south);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE desk_setting (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, timezone TEXT);
    CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, opened_on DATE NOT NULL);
    INSERT INTO desk_setting VALUES ('north', 'north', '${ZONES.north}'), ('south', 'south', '${ZONES.south}'),
      ('west', 'west', 'Not/AZone');
    INSERT INTO ticket VALUES
      ('north-chi', 'north', '${chicago}'), ('north-kir', 'north', '${kiritimati}'),
      ('south-chi', 'south', '${chicago}'), ('south-kir', 'south', '${kiritimati}');`);
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, binding);
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
  await operations.finish();
  db.exec('COMMIT');
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'desk-zone-deployment',
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
  const labels = async (lease: Context) => {
    const reply = await data('/api/run', lease, { q: 'everything sort label', limit: 50, offset: 0, count: 'exact' });
    assert.equal(reply.status, 200, reply.text);
    return (reply.body.rows as Array<Record<string, unknown>>).map((row) => `${row.from}:${row.label}`);
  };
  return { open, served, today, labels, chicago, kiritimati };
}

test("each tenant reads its days in its own row's zone, and none reaches another tenant's response", async (t) => {
  const f = await fixture(t);
  const north = await f.open('north'),
    south = await f.open('south'),
    west = await f.open('west');
  const expected = (tenant: 'north' | 'south', zone: string) =>
    [`${tenant}-chi`, `${tenant}-kir`].filter((id) => (id.endsWith('chi') ? f.chicago : f.kiritimati) === dayIn(zone)).sort();
  // Interleaved, back and forth: nothing is kept across contexts.
  for (let round = 0; round < 2; round++) {
    const northUi = await f.served(north);
    assert.deepEqual([northUi.timezone, northUi.clockZone], [ZONES.north, OWN]);
    assert.deepEqual(await f.today(south), expected('south', ZONES.south));
    assert.equal((await f.served(south)).timezone, ZONES.south);
    assert.deepEqual(await f.today(north), expected('north', ZONES.north));
    // A row naming no zone this runtime knows reads the App's own.
    assert.equal((await f.served(west)).timezone, OWN);
  }
  // Writes keep one clock whoever caused them.
  assert.equal((await f.served(south)).clockZone, OWN);
});

test('ui.timezone reads a resource column, and only that spelling of an object', () => {
  const parsed = (timezone: unknown) => parseUi({ timezone }, 'zone fixture').timezone;
  assert.deepEqual(parsed({ column: 'desk_setting.timezone', default: 'UTC' }), { column: 'desk_setting.timezone', default: 'UTC' });
  assert.equal(parsed('Australia/Sydney'), 'Australia/Sydney');
  assert.throws(() => parsed({ column: 'timezone' }), /"resource.column"/);
  assert.throws(() => parsed({ column: 'desk_setting.timezone', default: 'Mars/Base' }), /not an IANA zone/);
  assert.throws(() => parsed({ column: 'desk_setting.timezone', zone: 'UTC' }), /zone/);
});

test("startup names a zone column the catalog does not keep as a resource's text", () => {
  const catalog = (type: string): DatabaseSchema => ({
    label: 'Desk',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'desk_setting',
        name: 'desk_setting',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
          { name: 'timezone', type, nullable: true, primaryKey: false },
        ],
      },
    ],
  });
  assert.equal(zoneColumnProblem(app, catalog('TEXT')), undefined);
  assert.match(zoneColumnProblem(app, catalog('INTEGER')) ?? '', /a zone is text/);
  const elsewhere = { ...app, ui: { timezone: { column: 'account.timezone' } } };
  assert.match(zoneColumnProblem(elsewhere, catalog('TEXT')) ?? '', /not one of the App's resources/);
});

test("a union reads each branch in the tenant's own rows", async (t) => {
  const f = await fixture(t);
  const north = await f.open('north'),
    south = await f.open('south');
  assert.deepEqual(await f.labels(north), ['desk_setting:America/Chicago', 'ticket:north-chi', 'ticket:north-kir']);
  assert.deepEqual(await f.labels(south), ['desk_setting:Pacific/Kiritimati', 'ticket:south-chi', 'ticket:south-kir']);
});
