/**
 * `me` in the platform realm of a tenant App. A tenant's `me` is
 * its person row (`auth.me`, a tenant-owned table); the platform's staff are
 * rows of a platform-owned table of their own, and `auth.tenancy.platform.me`
 * names it in the same shape. Without it a platform lease's `me` was a tenant's
 * person, so `owner_id = me` on a platform row pointing at the staff table was
 * refused; the check judges the mapping in the platform realm's catalog as it
 * judges `auth.me` in a tenant's, and a lease resolves the `me` of
 * its own realm alone: one account that is both a tenant's person and the
 * platform's staff is the person on a tenant lease and the staff row on a
 * platform lease, never the other, even where a row names the other realm's id.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { tenantAuthoringProblems } from '../packages/mistri/src/server/tenant/tenantAuthoring.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const binding = { appId: 'desk', source: { id: 'business', connection: 'desk-db' }, storeId: 'store-platform-me' };

/* Eve is north's person and the provider's staff, staff number 1 as in an integer-keyed provider_staff. north-2
   names her staff id as its assignee: not hers in north. Lee is staff with no staff row; Ada is north's person only.
   The crossed id is written before foreign keys are enforced. */
const ROWS = `INSERT INTO person VALUES ('north-eve', 'north', 'eve', 'Eve North'), ('north-ada', 'north', 'ada', 'Ada');
  INSERT INTO staff VALUES (1, 'eve', 'Eve Staff'), (2, 'zed', 'Zed Staff');
  INSERT INTO ticket VALUES ('north-1', 'north', 'Printer jammed', 'north-eve'), ('north-2', 'north', 'Screen flickers', '1'),
    ('north-3', 'north', 'Badge lost', 'north-ada');
  INSERT INTO customer_case VALUES ('c-1', 'Renewal', 1), ('c-2', 'Escalation', 2), ('c-3', 'Billing', NULL);`;
const SCHEMA = {
  tables: ['ticket', 'customer_case', 'person', 'staff'],
  sqlite: `PRAGMA foreign_keys = OFF;
    CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE staff (id INTEGER NOT NULL PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT REFERENCES person(id));
    CREATE TABLE customer_case (id TEXT NOT NULL PRIMARY KEY, title TEXT NOT NULL, owner_id INTEGER REFERENCES staff(id));
    ${ROWS}
    PRAGMA foreign_keys = ON;`,
  postgres: `CREATE TABLE public.person (id text PRIMARY KEY, tenant_id text NOT NULL, account_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.staff (id integer PRIMARY KEY, account_id text NOT NULL UNIQUE, name text NOT NULL);
    CREATE TABLE public.ticket (id text PRIMARY KEY, tenant_id text NOT NULL, title text NOT NULL, assignee text);
    CREATE TABLE public.customer_case (id text PRIMARY KEY, title text NOT NULL, owner_id integer);
    ${ROWS.replaceAll('INTO ', 'INTO public.')}
    ALTER TABLE public.ticket ADD FOREIGN KEY (assignee) REFERENCES public.person(id) NOT VALID;
    ALTER TABLE public.customer_case ADD FOREIGN KEY (owner_id) REFERENCES public.staff(id) NOT VALID;`,
};
const DATABASE = `tenant_platform_me_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

/** The provider's desk over its tenants' helpdesks; `staff` is what the platform realm's `me` is, or null for none. */
const raw = (staff: unknown, me: unknown = { from: 'person', column: 'account_id' }) => ({
  id: 'desk',
  name: 'Desk',
  sources: { business: { connection: binding.source.connection, default: true } },
  auth: {
    rows: 'tenant',
    me,
    tenancy: { platform: { label: 'Provider', ...(staff === null ? {} : { me: staff }) } },
    roles: {
      agent: { realm: 'tenant', read: ['person', 'ticket'] },
      operator: { realm: 'platform', read: ['staff', 'customer_case'] },
    },
  },
  resources: {
    person: { owner: 'tenant' },
    staff: { owner: 'platform' },
    ticket: { owner: 'tenant', segments: { mine: 'assignee = me' } },
    customer_case: { owner: 'platform', segments: { mine: 'owner_id = me' } },
  },
  views: {
    tickets: { kind: 'list', from: 'ticket', tabs: [{ segment: 'mine' }] },
    cases: { kind: 'list', from: 'customer_case', realm: 'platform', tabs: [{ segment: 'mine' }] },
  },
  nav: [
    { id: 'helpdesk', label: 'Helpdesk', realm: 'tenant', children: ['tickets'] },
    { id: 'provider', label: 'Provider', realm: 'platform', children: ['cases'] },
  ],
  home: 'tickets',
});
const STAFF = { from: 'staff', column: 'account_id' };
const OWNERSHIP = {
  person: { kind: 'tenant', column: 'tenant_id' },
  ticket: { kind: 'tenant', column: 'tenant_id' },
  staff: { kind: 'platform' },
  customer_case: { kind: 'platform' },
} as const;

test('auth.tenancy.platform.me is { from, column } over a platform-owned resource, beside a tenant auth.me', () => {
  assert.equal(parseTestApp(raw(STAFF), 'desk.ts').auth?.tenancy?.platform?.me?.from, 'staff');
  for (const [given, refused] of [
    ['staff', /"platform", "me" is \{ from, column \}/],
    [{ from: 'staff' }, /"platform", "me" is \{ from, column \}/],
    [{ from: 'staff', column: ' ' }, /"platform", "me" is \{ from, column \}/],
    [{ from: 'staff', column: 'account_id', email: 'x' }, /email/],
    // A tenant's table: a member's `me` and the staff's would be one question.
    [{ from: 'person', column: 'account_id' }, /"person", which is not a platform-owned resource/],
    [{ from: 'nowhere', column: 'account_id' }, /"nowhere", which is not a platform-owned resource/],
  ] as const)
    assert.throws(() => parseTestApp(raw(given), 'desk.ts'), refused, JSON.stringify(given));
  // With the staff named, auth.me is the tenants' people and cannot be a platform table.
  assert.throws(() => parseTestApp(raw(STAFF, STAFF), 'desk.ts'), /"auth", "me" names "staff", a platform-owned resource/);
});

type Request = IncomingMessage;
const identities: Record<string, { id: string; who: string }> = {
  eve: { id: 'eve', who: 'eve@example.invalid' },
  lee: { id: 'lee', who: 'lee@example.invalid' },
  ada: { id: 'ada', who: 'ada@example.invalid' },
};
const who = (req: Request) => identities[String(req.headers['x-fixture-account'] ?? '')] ?? null;

async function fixture(t: TestContext, dialect: TenantDialect, staff: unknown = STAFF) {
  const engine = await openTenantEngine(dialect, { ...SCHEMA, database: DATABASE });
  const closing: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const close of closing.reverse()) await close().catch(() => {});
    await engine.close();
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  const grant = { status: 'active' as const, validUntil: Date.now() + 3_600_000, expectedVersion: null };
  await engine.maintenance(binding, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'eve', membershipId: 'north-eve', roles: ['agent'] });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'ada', membershipId: 'north-ada', roles: ['agent'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'eve', membershipId: 'platform-eve', roles: ['operator'] });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['operator'] });
  });
  const app = parseTestApp(raw(staff), 'desk.ts');
  const resources = Object.fromEntries(Object.keys(OWNERSHIP).map((name) => [name, engine.id(name)]));
  const physicalSchema = await engine.physicalSchema();
  const owned = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: appResourceCatalog(physicalSchema, resources).schema,
    resources,
    ownership: OWNERSHIP,
  });
  const loaded: LoadedApp = { path: 'desk.ts', app, pages: [], sources: {} };
  const rows: RowScope = { person: true, staff: true, ticket: true, customer_case: true };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: OWNERSHIP,
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    resolvePlatformRows: () => rows,
  });
  const enrollment = await createTenantEnrollment<Request>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'desk-platform-me',
    roles: ['agent', 'operator'],
    maxLifetimeMs: 300_000,
    verifySession: (req) => who(req),
  });
  closing.push(() => enrollment.retire());
  const bound = { host: '127.0.0.1', port: 0 };
  const http = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: (req: Request) => {
      const identity = who(req);
      return identity ? { identity, sessionId: `session-${identity.id}`, expiresAt: Date.now() + 3_600_000 } : null;
    },
  });
  closing.push(async () => {
    const stopped = new Promise<void>((resolve) => http.server.close(() => resolve()));
    http.server.closeAllConnections();
    await stopped;
    await http.retire();
  });
  http.server.listen(0, bound.host);
  await once(http.server, 'listening');
  const address = http.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, account: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      // No body is a GET, as the App's own metadata is read.
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-account': account, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  /** A lease of one realm, opened as the browser opens it: `realm=platform`, or the tenant. */
  const open = async (account: string, realm: 'platform' | 'north') => {
    const where = realm === 'platform' ? `app=${binding.appId}&realm=platform` : `app=${binding.appId}&tenant=north`;
    const opened = await call(`/api/tenant/context/open?${where}`, account, {});
    assert.equal(opened.status, 200, opened.text);
    const lease = opened.body as { tabId: string; context: string; accountId: string; revision: number };
    const leased = {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    };
    const run = (q: string) => call(`/api/run?${where}`, account, { q, limit: 50, offset: 0, count: 'none' }, leased);
    /** The App as this lease is served it: its views, each with its tabs. */
    const served = async () => {
      const reply = await call(`/api/app?${where}`, account, undefined, leased);
      assert.equal(reply.status, 200, reply.text);
      return (reply.body.app as { views: Record<string, { error?: string; tabs?: Array<{ query?: string }> }> }).views;
    };
    /** The ids a query-language read answers on this lease. */
    return Object.assign(
      async (q: string) => {
        const reply = await run(q);
        assert.equal(reply.status, 200, reply.text);
        assert.deepEqual(reply.body.errors ?? [], [], reply.text);
        return (reply.body.rows as Array<Record<string, unknown>>).map((row) => row.id).sort();
      },
      { run, served },
    );
  };
  return { problems: () => tenantAuthoringProblems(loaded, owned), open };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the platform realm's me on ${dialect}`, { skip }, () => {
    test("check judges the platform realm's me against its staff, and without platform.me a staff column is refused (G179)", async (t) => {
      const f = await fixture(t, dialect);
      assert.deepEqual(f.problems(), []);
      // Without the mapping, the platform's `me` is a tenant's person, and owner_id points at staff.
      const unmapped = await fixture(t, dialect, null);
      const refused = await (await unmapped.open('eve', 'platform')).run('customer_case owner_id = me');
      assert.match(refused.text, /"owner_id\\" references staff, and me is the signed-in account.s email/);
      // The mapping is judged against the platform realm's catalog as auth.me is against a tenant's.
      const misnamed = await fixture(t, dialect, { from: 'staff', column: 'email' });
      assert.deepEqual(
        misnamed.problems().map(({ realm, problem }) => [realm, problem]),
        [['platform', 'desk.ts: auth.me names "email", which is not a column of staff.']],
      );
    });

    test('one account is the staff row on a platform lease and the person on a tenant lease, never the other', async (t) => {
      const f = await fixture(t, dialect);
      const provider = await f.open('eve', 'platform'),
        north = await f.open('eve', 'north');
      // north-2 names her staff id: not hers in north; c-2 is another staff member's.
      assert.deepEqual(await provider('customer_case owner_id = me'), ['c-1']);
      assert.deepEqual(await north('ticket assignee = me'), ['north-1']);
      assert.deepEqual(await provider('customer_case owner_id != me'), ['c-2']);
      assert.deepEqual(await north('ticket assignee != me'), ['north-2', 'north-3']);
    });

    /* The served App judged a platform view's tabs with the tenant's `me`, the person: `owner_id = me` over the staff
       table was an error, and the room left the provider's menu whole, "not available to your role" (G192). The
       platform realm's surface carries its own `me`, as its reads do. */
    test("a platform view with a tab about me is served to the platform's staff, its tab whole (G192)", async (t) => {
      const f = await fixture(t, dialect);
      const provider = await (await f.open('eve', 'platform')).served();
      assert.ok(provider.cases, JSON.stringify(Object.keys(provider)));
      assert.equal(provider.cases.error, undefined);
      assert.deepEqual(
        provider.cases.tabs?.map((tab) => tab.query),
        ['mine'],
      );
      // A tenant lease is served its own view, its tab read against its own person.
      const north = await (await f.open('eve', 'north')).served();
      assert.equal(north.tickets?.error, undefined);
      assert.equal(north.cases, undefined);
    });

    test('staff with no staff row, and a tenant member, are nobody in the realm that is not theirs', async (t) => {
      const f = await fixture(t, dialect);
      // Lee is staff with no row: me is nobody, and nothing fails.
      const lee = await f.open('lee', 'platform');
      assert.deepEqual(await lee('customer_case owner_id = me'), []);
      assert.deepEqual(await lee('customer_case'), ['c-1', 'c-2', 'c-3']);
      // Ada is north's person alone: her tenant `me` is her row, and she holds no platform lease to resolve one on.
      const ada = await f.open('ada', 'north');
      assert.deepEqual(await ada('ticket assignee = me'), ['north-3']);
      await assert.rejects(f.open('ada', 'platform'));
    });
  });
