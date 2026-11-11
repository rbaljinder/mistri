/**
 * `ui.timezone: { column: 'tenant.timezone' }`, a column of the platform-owned tenant profile shared with its members
 * (`auth.tenancy.shared`): each tenant's person reads their days on the zone their tenant's profile row holds, though
 * no role is granted that resource and the scope catalog does not hold it (the platform reads the shared columns
 * itself, once per request). A null, unknown or empty zone is the App's own, and `zoneColumnProblem` refuses a column
 * `shared` does not list, a zone that is not text, and the profile named as a resource.
 *
 * On SQLite always and on PostgreSQL where `TABLEWALK_TEST_PG` names a server: the platform's read of the profile
 * is its own statement on the tenant source (readTenantProfile), and each engine spells the catalog it reads.
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
import { menuFor, menuWhenProblems, sharedProfileProblems, visitorApp } from '../packages/mistri/src/server/app/appTenantProfile.js';
import type { AppNavNode } from '../packages/mistri/src/shared/appModel.js';
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
      tenancy: { label: 'Customer', profile: 'customer', shared: ['timezone'], platform: { label: 'Operator' } },
      /* No grant on the profile: the zone is the platform's own read of it. */
      roles: { agent: { realm: 'tenant', read: ['ticket'], commands: ['stampToday'] }, operator: { realm: 'platform', read: true } },
    },
    sources: { business: { connection: binding.source.connection } },
    ui: { timezone: { column: 'tenant.timezone', default: OWN } },
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
const profilesSeen: Array<Record<string, unknown>> = [];
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: { customer: { kind: 'platform' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => rows,
  /* What each request's row scope was handed: the tenant's shared profile, read before it. */
  resolveRows: (_member, { tenant }) => {
    profilesSeen.push({ ...tenant });
    return rows;
  },
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
  const ask = async (lease: Context, q: string) => data('/api/run', lease, { q, limit: 50, offset: 0, count: 'none' });
  return { open, served, today, stamp, read, ask, chicago, kiritimati };
}

test('check refuses a zone column shared does not list, one that is not text, and the profile named as a resource', () => {
  const catalog = (columns: string[], type = 'TEXT'): DatabaseSchema => ({
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
        columns: columns.map((name, index) => ({ name, type: index ? type : 'TEXT', nullable: index > 0, primaryKey: index === 0 })),
      },
    ],
  });
  assert.equal(zoneColumnProblem(app, catalog(['id', 'timezone'])), undefined);
  assert.match(zoneColumnProblem(app, catalog(['id', 'timezone'], 'INTEGER')) ?? '', /which is INTEGER.*\[tenant-shared-column\]/);
  const unlisted = { ...app, auth: { ...app.auth!, tenancy: { ...app.auth!.tenancy!, shared: ['name'] } } };
  assert.match(zoneColumnProblem(unlisted, catalog(['id', 'timezone'])) ?? '', /shared does not list "timezone" \[tenant-shared-column\]/);
  const direct = { ...app, ui: { ...app.ui, timezone: { column: 'customer.timezone', default: OWN } } };
  assert.match(zoneColumnProblem(direct, catalog(['id', 'timezone'])) ?? '', /name it "tenant\.timezone".*\[tenant-shared-column\]/);
});

test('check refuses a shared column that is missing, the key, a reference or a document, and tenant. where no tenant is meant', () => {
  const column = (name: string, type = 'TEXT', extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
  const catalog: DatabaseSchema = {
    label: 'Desk',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [
      { from: { table: 'customer', columns: ['region_id'] }, to: { table: 'region', columns: ['id'] } },
    ] as DatabaseSchema['foreignKeys'],
    tables: [
      {
        id: 'customer',
        name: 'customer',
        schema: '',
        isView: false,
        columns: [
          column('id', 'TEXT', { primaryKey: true, nullable: false }),
          column('timezone'),
          column('country'),
          column('settings', 'JSON'),
          column('region_id', 'INTEGER', { references: { table: 'region', column: 'id' } }),
        ],
      },
      {
        id: 'tax_rate',
        name: 'tax_rate',
        schema: '',
        isView: false,
        columns: [column('id', 'INTEGER', { primaryKey: true }), column('country')],
      },
    ],
  };
  const sharing = (shared: string[], views: Record<string, unknown> = {}) =>
    ({
      ...app,
      auth: { ...app.auth!, tenancy: { ...app.auth!.tenancy!, shared } },
      views: { ...app.views, ...views },
    }) as typeof app;
  assert.deepEqual(sharedProfileProblems(sharing(['timezone', 'country']), catalog), []);
  const problems = sharedProfileProblems(sharing(['nowhere', 'id', 'region_id', 'settings']), catalog);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems[0], /"nowhere", and the profile "customer" has no such column \[tenant-shared-column\]/);
  assert.match(problems[1], /"id", the profile's key or a reference/);
  assert.match(problems[2], /"region_id", the profile's key or a reference/);
  assert.match(problems[3], /"settings", which is JSON/);
  const views = {
    rates: { kind: 'list', table: 'tax_rate', query: 'country = tenant.country' },
    quoted: { kind: 'list', table: 'tax_rate', query: 'country = "tenant.region"' },
    unlisted: { kind: 'list', table: 'tax_rate', query: 'country = tenant.region' },
    across: { kind: 'list', table: 'tax_rate', realm: 'platform', query: 'country = tenant.country' },
  };
  const read = sharedProfileProblems(sharing(['country'], views), catalog);
  assert.equal(read.length, 2, read.join('\n'));
  assert.match(read[0], /view "unlisted" reads tenant\.region, and auth\.tenancy\.shared does not list "region" \[tenant-shared-column\]/);
  assert.match(read[1], /view "across" reads tenant\.country in the platform realm.*\[tenant-shared-platform\]/);
});

test("a menu's when folds over a shared flag or vocabulary column, and an entry it does not meet is left out", () => {
  const column = (name: string, type = 'TEXT', extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
  const catalog: DatabaseSchema = {
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
        columns: [
          column('id', 'TEXT', { primaryKey: true, nullable: false }),
          column('timezone'),
          column('boarding', 'BOOLEAN'),
          column('plan', 'TEXT', { allowed: ['free', 'pro', 'team'] }),
          column('country'),
        ],
      },
    ],
  };
  const menu = (nav: AppNavNode[], shared = ['timezone', 'boarding', 'plan', 'country'], profile: string | null = 'customer') =>
    ({
      ...app,
      auth: { ...app.auth!, tenancy: profile === null ? undefined : { ...app.auth!.tenancy!, profile, shared } },
      nav,
    }) as typeof app;
  const nav: AppNavNode[] = [
    { group: 'boarding', label: 'Boarding', realm: 'tenant', when: 'tenant.boarding = true', children: [{ view: 'tickets' }] },
    {
      group: 'desk',
      label: 'Desk',
      realm: 'tenant',
      children: [
        { view: 'tickets', when: 'tenant.plan in (pro, team)' },
        { label: 'Help', to: { kind: 'view', app: 'desk', view: 'tickets' }, when: 'tenant.plan = free' },
      ],
    },
  ];
  assert.deepEqual(menuWhenProblems(menu(nav), catalog), []);
  const refused = (when: string, shared?: string[]) =>
    menuWhenProblems(menu([{ group: 'desk', label: 'Desk', realm: 'tenant', when, children: [{ view: 'tickets' }] }], shared), catalog);
  assert.match(refused('tenant.country = US')[0] ?? '', /group "desk" has when "tenant\.country = US".*\[nav-when\]/);
  assert.match(refused('tenant.boarding = true', ['timezone'])[0] ?? '', /\[nav-when\]/);
  assert.match(refused('tenant.plan > free')[0] ?? '', /\[nav-when\]/);
  assert.match(refused('status = open')[0] ?? '', /\[nav-when\]/);
  assert.match(menuWhenProblems(menu(nav, [], null), catalog)[0] ?? '', /no auth\.tenancy\.profile \[nav-when\]/);
  const across: AppNavNode[] = [
    { group: 'all', label: 'All', realm: 'platform', children: [{ view: 'tickets', when: 'tenant.boarding = true' }] },
  ];
  assert.match(menuWhenProblems(menu(across), catalog)[0] ?? '', /entry "tickets".*platform realm.*\[nav-when\]/);

  const judged = menuFor(menu(nav), catalog)!;
  assert.deepEqual([...judged.columns].sort(), ['boarding', 'plan']);
  assert.deepEqual(judged.prune(nav, { boarding: true, plan: 'pro' }), [
    { group: 'boarding', label: 'Boarding', realm: 'tenant', children: [{ view: 'tickets' }] },
    { group: 'desk', label: 'Desk', realm: 'tenant', children: [{ view: 'tickets' }] },
  ]);
  assert.deepEqual(judged.prune(nav, { boarding: false, plan: 'free' }), [
    { group: 'desk', label: 'Desk', realm: 'tenant', children: [{ label: 'Help', to: { kind: 'view', app: 'desk', view: 'tickets' } }] },
  ]);
  /* A profile that has none of it, the platform realm and a visitor meet no when; a group left empty goes too. */
  assert.deepEqual(judged.prune(nav, { boarding: null, plan: null }), []);
  assert.deepEqual(judged.prune(nav), []);
  /* One captured copy per App and per set of whens met, so a projection keyed by content finds it again. */
  const full = menu(nav);
  const shown = judged.shown(full, { boarding: true, plan: 'team' });
  assert.equal(judged.shown(full, { boarding: true, plan: 'pro' }), shown);
  assert.notEqual(judged.shown(full, { boarding: false, plan: 'pro' }), shown);
  /* What a served projection is remembered by: the whens met, so tenants whose values differ share one entry. */
  assert.equal(judged.met({ boarding: true, plan: 'team' }), judged.met({ boarding: true, plan: 'pro' }));
  assert.notEqual(judged.met({ boarding: false, plan: 'pro' }), judged.met({ boarding: true, plan: 'pro' }));
  assert.match(judged.met(), /^0+$/);
  assert.equal(judged.met({ boarding: null, plan: null }), judged.met());
  assert.ok(Object.isFrozen(shown));
  assert.deepEqual(visitorApp(full).nav, []);
  assert.equal(visitorApp(full), visitorApp(full));
  const plain: AppNavNode[] = [{ group: 'desk', label: 'Desk', children: [{ view: 'tickets' }] }];
  assert.equal(visitorApp(menu(plain)).nav, plain);
  assert.equal(menuFor(menu(plain), catalog), undefined);
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

    test("tenant.<column> in a query and resolveRows read the asking tenant's own profile, and an unshared column is refused", async (t) => {
      const f = await fixture(t, dialect);
      const north = await f.open('north'),
        south = await f.open('south');
      const ids = async (lease: Context, q: string) => {
        const reply = await f.ask(lease, q);
        assert.equal(reply.status, 200, reply.text);
        assert.deepEqual(reply.body.errors ?? [], [], reply.text);
        return (reply.body.rows as Array<Record<string, unknown>>).map((row) => row.id).sort();
      };
      profilesSeen.length = 0;
      assert.deepEqual(await ids(north, 'ticket id != tenant.timezone'), ['north-chi', 'north-kir']);
      assert.deepEqual(profilesSeen.at(-1), { timezone: ZONES.north });
      assert.deepEqual(await ids(south, 'ticket id = tenant.timezone'), []);
      assert.deepEqual(profilesSeen.at(-1), { timezone: ZONES.south });
      const unshared = await f.ask(north, 'ticket id = tenant.name');
      assert.match(unshared.text, /list \\?"name\\?" in auth\.tenancy\.shared/);
      assert.doesNotMatch(unshared.text, /North/, 'an unshared column is not read out');
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
