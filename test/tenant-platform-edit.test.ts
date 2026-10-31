/**
 * The platform realm's generic edit: provider staff fix a typo on
 * an account, add a plan, retire one, with Save, New and Delete on the
 * platform's own rows, and nothing else. A tenant's rows change through
 * commands, a global row is read-only, and the profile is never made or ended
 * generically, nor its key or the addresses that place a visitor with a tenant
 * ever written. Each is refused at startup where an App could say it, by the
 * edit's own access, and again by the writer beneath it (the last layer has its
 * own suite in tenant-platform-dialects.test.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test, type TestContext } from 'node:test';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { RECORD_HISTORY_TABLES } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import { TenantContextError, TenantUnavailableError } from '../packages/engine/src/server/evidence.js';
import { projectPlatformCapabilities } from '../packages/mistri/src/server/tenant/tenantCapabilities.js';
import { createTenantContexts } from '../packages/mistri/src/server/tenant/tenantContexts.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { captureTenantOwnership, type ResourceOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import {
  platformDeletable,
  platformHeldColumns,
  platformInsertable,
  tenantVisibleFields,
} from '../packages/mistri/src/server/tenant/tenantVisibleFields.js';
import { TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';

const OWNERSHIP: Record<string, ResourceOwnership> = {
  dealer: { kind: 'platform' },
  region: { kind: 'platform' },
  plan: { kind: 'platform' },
  lead: { kind: 'tenant', column: 'tenant_id' },
  review_file: { kind: 'platform' },
  vehicle_model: { kind: 'global', access: 'read-only' },
};
const DDL = `
  CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, public_address TEXT);
  CREATE TABLE region (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE plan (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, region_id TEXT REFERENCES region(id));
  CREATE TABLE vehicle_model (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
  CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE review_file (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES lead(id), note TEXT);`;
const PG = `
  CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, public_address text);
  CREATE TABLE public.region (id text PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.plan (id text PRIMARY KEY, name text NOT NULL, price integer NOT NULL, region_id text REFERENCES public.region(id));
  CREATE TABLE public.vehicle_model (id text PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL,
    version integer NOT NULL DEFAULT 0);
  CREATE TABLE public.review_file (id text PRIMARY KEY, lead_id text NOT NULL REFERENCES public.lead(id), note text);`;
const NORTH = 'NorthPublicAddress0000001';
const ROWS = `
  INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}'), ('south', 'South Auto', NULL);
  INSERT INTO region VALUES ('r1', 'East');
  INSERT INTO plan VALUES ('p1', 'Basic', 10, 'r1');
  INSERT INTO vehicle_model VALUES ('m1', 'Sedan');
  INSERT INTO lead (id, tenant_id, name) VALUES ('n1', 'north', 'North lead'), ('s1', 'south', 'South lead');
  INSERT INTO review_file VALUES ('rv1', 'n1', 'Lender only');`;

type Manifest = Record<string, any>;
const manifest = (connection = 'business-db'): Manifest => ({
  id: 'lending',
  name: 'Lending',
  sources: { business: { connection } },
  resources: {
    dealer: { access: 'write', owner: 'platform' },
    region: { access: 'write', owner: 'platform', delete: true },
    plan: { access: 'write', owner: 'platform', delete: true },
    lead: { access: 'write', owner: 'tenant' },
    review_file: { access: 'write', owner: 'platform', delete: true },
    vehicle_model: { owner: 'global' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true, write: ['lead'] },
      manager: {
        realm: 'platform',
        read: true,
        write: ['dealer', 'region', 'plan', 'review_file'],
        create: ['region', 'plan', 'review_file'],
      },
      // A platform member granted no edit: offered none, makes none.
      auditor: { realm: 'platform', read: true },
    },
    public: { read: ['vehicle_model'] },
  },
  views: {
    leads: { kind: 'list', from: 'lead' },
    dealers: { kind: 'list', from: 'dealer' },
    plans: { kind: 'list', from: 'plan' },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers', 'plans'] },
  ],
  home: 'leads',
});
const refusedWith = (raw: Manifest, expected: RegExp) => assert.throws(() => parseTestApp(raw, 'lending.ts'), expected);
const withManager = (grant: Record<string, unknown>) => {
  const raw = manifest();
  raw.auth.roles.manager = { realm: 'platform', read: true, ...grant };
  return raw;
};

/* ---------- startup: what a platform role may name ---------- */

test('DSL: a platform role edits the platform-owned resources it names, and the App keeps it as written', () => {
  const app = parseTestApp(manifest(), 'lending.ts');
  assert.deepEqual(app.auth?.roles?.manager.write, ['dealer', 'region', 'plan', 'review_file']);
  assert.deepEqual(app.auth?.roles?.manager.create, ['region', 'plan', 'review_file']);
  // A column ceiling on its own table is a platform role's to say too.
  parseTestApp(withManager({ write: ['plan'], fields: { plan: { write: ['name'] } } }), 'lending.ts');
});

test('DSL: a platform role naming a tenant, global, read-only or platform-only resource, or New on the profile, is refused by name', () => {
  refusedWith(
    withManager({ write: true }),
    /role "manager" is a platform role with "write": true\. A platform role names the platform's own resources/,
  );
  refusedWith(
    withManager({ write: ['lead'] }),
    /role "manager" has "write" naming "lead", a tenant-owned resource\. A platform role edits only/,
  );
  // A global table is never written, so the resource ceiling refuses the grant before tenancy is asked.
  refusedWith(withManager({ write: ['vehicle_model'] }), /"write" names "vehicle_model".*no access 'write'/);
  refusedWith(withManager({ fields: { lead: { write: ['name'] } } }), /role "manager" has "fields" naming "lead", a tenant-owned resource/);
  const readOnly = manifest();
  readOnly.resources.plan = { owner: 'platform' };
  readOnly.auth.roles.manager.create = [];
  refusedWith(readOnly, /"write" names "plan", and resources "plan" is not written \(it has no access 'write'\)/);
  refusedWith(
    withManager({ write: ['dealer'], create: ['dealer'] }),
    /role "manager" has "create" naming "dealer", the tenancy profile: a tenant's profile row is made with the tenant, never by a generic New\./,
  );
  // A platform-only source's tables are read by the platform realm and written by nothing: no access, so no grant.
  const outside = manifest();
  outside.sources = { business: { connection: 'business-db', default: true }, ledger: { connection: 'ledger-db', realm: 'platform' } };
  outside.resources['ledger.invoice'] = { owner: 'platform' };
  outside.auth.roles.manager.write = ['plan', 'ledger.invoice'];
  refusedWith(outside, /"write" names "ledger\.invoice", and resources "ledger\.invoice" is not written/);
  // Actions stay the commands' alone in a tenant App, whatever the realm.
  refusedWith(withManager({ actions: { plan: ['archive'] } }), /actions/);
});

/* ---------- the edit's access, as pure structure ---------- */

const source = { id: 'business', connection: 'owned-source' };
function owned(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON; ${DDL}`);
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  return captureTenantOwnership({
    appId: 'lending',
    source,
    schema,
    physicalSchema: structuredClone(schema),
    resources: Object.fromEntries(schema.tables.map((table) => [table.id, table.id])),
    ownership: OWNERSHIP,
    profile: 'dealer',
  });
}

test("the edit's access: the platform's own tables, the profile's key and addresses held, New and Delete where nothing could cascade", (t) => {
  const ownership = owned(t);
  const held = platformHeldColumns(ownership, ['public_address', undefined]);
  assert.deepEqual([...held].sort(), ['id', 'public_address']);
  const everything = new Set(Object.keys(OWNERSHIP));
  const access = tenantVisibleFields(ownership, { readable: everything, writable: everything, creatable: everything }, 'platform', held);
  assert.deepEqual([...access.writable].sort(), ['dealer', 'plan', 'region', 'review_file']);
  assert.deepEqual([...access.fields!.get('dealer')!.write].sort(), ['name']);
  assert.equal(access.fields!.get('dealer')!.read.has('public_address'), true, 'held is readable, never written');
  assert.equal(access.fields!.get('lead')!.write.size, 0);
  assert.equal(access.fields!.get('vehicle_model')!.write.size, 0);
  // New: never the profile, never a tenant's or a global table.
  assert.deepEqual([...everything].filter((id) => platformInsertable(ownership, access, id)).sort(), ['plan', 'region', 'review_file']);
  // Delete: never the profile, and never a table a key refers to (region, by plan.region_id).
  assert.deepEqual([...everything].filter((id) => platformDeletable(ownership, access, id)).sort(), ['plan', 'review_file']);
  // The tenant realm is unchanged: no platform table at all.
  assert.equal(tenantVisibleFields(ownership, { readable: everything, writable: everything }).writable.has('plan'), false);
});

test("the platform realm's capabilities offer what its edit accepts, and nothing to a role granted no edit", (t) => {
  const app = parseTestApp(manifest(source.connection), 'lending.ts');
  const platform = (roles: string[]): PlatformMembershipEvidence => ({
    realm: 'platform',
    appId: 'lending',
    accountId: 'lee',
    source,
    deployment: 'generation-1',
    membershipId: 'platform-lee',
    membershipVersion: '1',
    platformVersion: '1',
    roles,
    verifiedAt: 1000,
    validUntil: 6000,
  });
  const ownership = owned(t);
  const input = { app, ownership, principal: platform(['manager']), services: { commands: [] }, held: ['id', 'public_address'] };
  const offered = JSON.parse(JSON.stringify(projectPlatformCapabilities(input)));
  assert.deepEqual(offered.writable, ['dealer', 'plan', 'region', 'review_file']);
  assert.deepEqual(offered.resources.dealer, { write: ['name'], insertable: false, deletable: false });
  assert.deepEqual(offered.resources.plan, { write: ['id', 'name', 'price', 'region_id'], insertable: true, deletable: true });
  assert.deepEqual(offered.resources.region, { write: ['id', 'name'], insertable: true, deletable: false });
  assert.equal(offered.resources.lead, undefined);
  assert.equal(offered.resources.vehicle_model, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(projectPlatformCapabilities({ ...input, principal: platform(['auditor']) }))), {
    resources: {},
    writable: [],
    grantedCommands: [],
  });
  assert.throws(() => projectPlatformCapabilities({ ...input, held: 'id' as never }), TenantContextError);
  // Roles resolve the way the write resolves them: the access the edit is judged by.
  assert.equal(resolveAppAccess(app, ownership.schema, ['manager']).writable.has('plan'), true);
});

/* ---------- end to end, on each engine ---------- */

type Request = { readonly cookie?: string; readonly headers?: { readonly cookie?: string } };
const cookieOf = (request: Request) => request.cookie ?? request.headers?.cookie?.replace(/^fixture=/, '') ?? '';
const identities: Record<string, { id: string; who: string }> = {
  alice: { id: 'alice', who: 'Alice' },
  lee: { id: 'lee', who: 'Lee' },
  pat: { id: 'pat', who: 'Pat' },
  sam: { id: 'sam', who: 'Sam' },
};
const as = (cookie: string): Request => ({ cookie });
const instance = (request: Request) => {
  const identity = identities[cookieOf(request)];
  return identity ? { identity, sessionId: `session-${identity.id}`, expiresAt: 5000 } : null;
};
const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-edit-store' };
/* Refused before anything applied: the edit's own access denying, or the writer beneath it refusing. */
const refusedEdit = (error: unknown) =>
  error instanceof TenantContextError || (error instanceof TenantWriteFailure && error.outcome === 'not_applied');
const DATABASE = `platform_edit_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: ['review_file', 'lead', 'vehicle_model', 'plan', 'region', 'dealer'],
    sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; ${DDL} ${ROWS}`,
    postgres: PG + ROWS,
    database: DATABASE,
  });
  const owners: TenantEnrollment<Request>[] = [];
  let contexts: ReturnType<typeof createTenantContexts<Request>> | undefined;
  t.after(async () => {
    try {
      await contexts?.retire();
      await Promise.allSettled(owners.map((owner) => owner.retire()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  if (dialect === 'postgres') await provisionPostgresRecordHistory(engine.url);
  else provisionSqliteRecordHistory(engine.path);
  const grant = { status: 'active' as const, validUntil: 10_000, expectedVersion: null };
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
    await admin.putMembership({ ...grant, tenantId: 'south', accountId: 'sam', membershipId: 'south-sam', roles: ['staff'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['manager'] });
    await admin.putPlatformMembership({ ...grant, accountId: 'pat', membershipId: 'platform-pat', roles: ['auditor'] });
  });
  const app = parseTestApp(manifest(), 'lending.ts');
  // A page over a platform table is the platform realm's.
  const pages = parsePagesConfig(
    { pages: [{ id: 'plan', label: 'Plan', base: 'plan', sections: [{ kind: 'fields', show: ['name', 'price'] }, { kind: 'history' }] }] },
    'edit pages',
  ).map((page) => ({ ...page, realm: 'platform' as const }));
  const everything = { dealer: true, region: true, plan: true, lead: true, review_file: true, vehicle_model: true };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: OWNERSHIP,
    resolveMembershipRows: () => everything,
    resolveRows: () => everything,
    resolvePlatformRows: () => everything,
    public: { address: 'public_address' },
    resolvePublicRows: () => ({ vehicle_model: true }),
  });
  const service = await createTenantEnrollment<Request>({
    app,
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager', 'auditor'],
    maxLifetimeMs: 1000,
    now: () => 100,
    pages,
    verifySession: (request) => identities[cookieOf(request)] ?? null,
  });
  owners.push(service);
  contexts = createTenantContexts<Request>({ deployment: service.deployment, now: () => 100, verifySessionInstance: instance });
  return { engine, service, app, contexts, rows: (sql: string) => engine.all(sql) };
}

async function serve(t: TestContext, service: TenantEnrollment<Request>, app: ReturnType<typeof parseAppConfig>) {
  const bound = { host: '127.0.0.1', port: 0 };
  const http = createTenantHttpServer({
    app,
    enrollment: service,
    bound,
    verifySessionInstance: (req: IncomingMessage) => instance(req),
    // The sign-in store's name for whoever the request was verified as (tenantAuthenticatedHttp.ts readerName).
    readerName: () => 'Lee Park',
  });
  t.after(async () => {
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
  return async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: 'fixture=lee', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, any> };
  };
}
const ownerHeaders = (lease: TenantContextReply) => ({
  'x-mistri-account': lease.accountId,
  'x-mistri-tab': lease.tabId,
  'x-mistri-context': lease.context,
  'x-mistri-lease-revision': String(lease.revision),
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the platform realm's generic edit on ${dialect}`, { skip }, () => {
    test("Save, New and Delete on the platform's own rows, with no Undo", async (t) => {
      const { service, rows } = await fixture(t, dialect);
      const deployment = service.deployment;
      const saved = await deployment.updatePlatform(as('lee'), { table: 'plan', key: { id: 'p1' }, values: { name: 'Gold', price: 20 } });
      assert.equal(saved.result.affected, 1);
      assert.equal('undoId' in saved, false);
      const made = await deployment.insertPlatform(as('lee'), {
        table: 'plan',
        values: { id: 'p2', name: 'Silver', price: 5, region_id: 'r1' },
      });
      assert.deepEqual({ ...made.result.key }, { id: 'p2' });
      // A dealer's name is the platform's to fix: the profile's own row, its key and address kept.
      await deployment.updatePlatform(as('lee'), { table: 'dealer', key: { id: 'north' }, values: { name: 'North Motors Ltd' } });
      // A platform row that points at a tenant's row is still the platform's.
      await deployment.updatePlatform(as('lee'), { table: 'review_file', key: { id: 'rv1' }, values: { note: 'Reviewed' } });
      assert.deepEqual(
        JSON.parse(JSON.stringify(await deployment.previewRemovePlatform(as('lee'), { table: 'plan', key: { id: 'p2' } }))),
        { impact: [], deleted: false },
      );
      assert.deepEqual({ ...(await deployment.removePlatform(as('lee'), { table: 'plan', key: { id: 'p2' } })).result }, { affected: 1 });
      assert.deepEqual(await rows('SELECT id, name, price FROM plan ORDER BY id'), [{ id: 'p1', name: 'Gold', price: 20 }]);
      assert.deepEqual(await rows("SELECT name, public_address FROM dealer WHERE id = 'north'"), [
        { name: 'North Motors Ltd', public_address: NORTH },
      ]);
      assert.deepEqual(await rows("SELECT note FROM review_file WHERE id = 'rv1'"), [{ note: 'Reviewed' }]);
    });

    test("a tenant's row, a global one, the profile's New, Delete, key and address, and a referenced table's Delete are refused", async (t) => {
      const { service, rows } = await fixture(t, dialect);
      const d = service.deployment;
      for (const attempt of [
        () => d.updatePlatform(as('lee'), { table: 'lead', key: { id: 'n1' }, values: { name: 'Edited' } }),
        () => d.insertPlatform(as('lee'), { table: 'lead', values: { id: 'n2', tenant_id: 'north', name: 'Planted' } }),
        () => d.removePlatform(as('lee'), { table: 'lead', key: { id: 's1' } }),
        () => d.updatePlatform(as('lee'), { table: 'vehicle_model', key: { id: 'm1' }, values: { name: 'Coupe' } }),
        () =>
          d.updatePlatform(as('lee'), { table: 'dealer', key: { id: 'north' }, values: { public_address: 'SomeoneElsesAddress000001' } }),
        () => d.updatePlatform(as('lee'), { table: 'dealer', key: { id: 'south' }, values: { id: 'east' } }),
        () => d.insertPlatform(as('lee'), { table: 'dealer', values: { id: 'west', name: 'West' } }),
        () => d.removePlatform(as('lee'), { table: 'dealer', key: { id: 'south' } }),
        () => d.previewRemovePlatform(as('lee'), { table: 'dealer', key: { id: 'south' } }),
        // A plan points at the region: removing it could take the plan with it.
        () => d.removePlatform(as('lee'), { table: 'region', key: { id: 'r1' } }),
        // A key a row refers to moves with a command only.
        () => d.updatePlatform(as('lee'), { table: 'region', key: { id: 'r1' }, values: { id: 'r9' } }),
        // A role granted no edit makes none.
        () => d.updatePlatform(as('pat'), { table: 'plan', key: { id: 'p1' }, values: { name: 'Audited' } }),
      ])
        await assert.rejects(attempt(), refusedEdit);
      // A dealer's member holds no platform lease at all.
      await assert.rejects(d.updatePlatform(as('alice'), { table: 'plan', key: { id: 'p1' }, values: { name: 'Mine' } }), refusedEdit);
      assert.deepEqual(await rows('SELECT id, tenant_id, name FROM lead ORDER BY id'), [
        { id: 'n1', tenant_id: 'north', name: 'North lead' },
        { id: 's1', tenant_id: 'south', name: 'South lead' },
      ]);
      assert.deepEqual(await rows('SELECT id, name, public_address FROM dealer ORDER BY id'), [
        { id: 'north', name: 'North Motors', public_address: NORTH },
        { id: 'south', name: 'South Auto', public_address: null },
      ]);
      assert.deepEqual(await rows('SELECT id FROM region'), [{ id: 'r1' }]);
      assert.deepEqual(await rows('SELECT name FROM vehicle_model'), [{ name: 'Sedan' }]);
      assert.deepEqual(await rows("SELECT name FROM plan WHERE id = 'p1'"), [{ name: 'Basic' }]);
    });

    /* The platform realm flattened every failure into a denial — its admission, its read runtime and the lease's
       read — so a database that did not answer told an operator their context was gone: a 403 the browser does not
       retry, where a tenant's read says 503. Each is classified now, as the tenant realm's is. */
    test('a platform read the database does not answer is unavailable, and a refusal stays a refusal', async (t) => {
      const { contexts } = await fixture(t, dialect);
      const lease = await contexts.openPlatform(as('lee'));
      const expected = { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision };
      for (const fault of [
        new PoolBusy('read', 'connection_limit'),
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' }),
      ])
        await assert.rejects(
          contexts.withPlatformContext(as('lee'), expected, () => Promise.reject(fault)),
          (error: unknown) => error instanceof TenantUnavailableError && error.code === 'tenant_temporarily_unavailable',
        );
      await assert.rejects(
        contexts.withPlatformContext(as('lee'), expected, () => Promise.reject(new TenantContextError())),
        (error: unknown) => error instanceof TenantContextError && !(error instanceof TenantUnavailableError),
      );
      // The lease stands through all of them.
      assert.equal((await contexts.withPlatformContext(as('lee'), expected, () => 1)).value, 1);
    });

    test('a lease edits after the platform is suspended no more: the next Save is refused and nothing changes', async (t) => {
      const { service, contexts, engine, rows } = await fixture(t, dialect);
      const lease = await contexts.openPlatform(as('lee')).catch(async (e) => {
        console.log(
          'REASON',
          (await import('../packages/engine/src/server/evidence.js')).refusalReasons(e),
          await service.deployment
            .withPlatformContext(as('lee'), () => 1)
            .catch(async (x) => (await import('../packages/engine/src/server/evidence.js')).refusalReasons(x)),
        );
        throw e;
      });
      const expected = { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision };
      await contexts.updatePlatform(as('lee'), expected, { table: 'plan', key: { id: 'p1' }, values: { name: 'Before' } });
      await engine.maintenance(binding, (admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
      await assert.rejects(
        contexts.updatePlatform(as('lee'), expected, { table: 'plan', key: { id: 'p1' }, values: { name: 'After' } }),
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(service.deployment.updatePlatform(as('lee'), { table: 'plan', key: { id: 'p1' }, values: { name: 'After' } }));
      assert.deepEqual(await rows("SELECT name FROM plan WHERE id = 'p1'"), [{ name: 'Before' }]);
    });

    test("HTTP: ?realm=platform saves, adds and deletes the platform's own rows, kept in history; import, Undo and upload are refused", async (t) => {
      const { service, app, rows, engine } = await fixture(t, dialect);
      const call = await serve(t, service, app);
      const opened = await call('/api/tenant/context/open?app=lending&realm=platform', {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const owner = ownerHeaders(opened.body as unknown as TenantContextReply);
      const saved = await call(
        '/api/update?app=lending&realm=platform',
        { table: 'plan', key: { id: 'p1' }, values: { name: 'Gold' } },
        owner,
      );
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.affected, 1);
      assert.equal(saved.body.undoId, undefined, 'no Undo in the platform realm');
      const made = await call(
        '/api/insert?app=lending&realm=platform',
        { table: 'plan', values: { id: 'p2', name: 'Silver', price: 5 } },
        owner,
      );
      assert.equal(made.status, 200, JSON.stringify(made.body));
      assert.deepEqual(made.body.key, { id: 'p2' });
      const preview = await call('/api/delete?app=lending&realm=platform', { table: 'plan', key: { id: 'p2' } }, owner);
      assert.deepEqual(preview.body, { impact: [], deleted: false });
      const deleted = await call('/api/delete?app=lending&realm=platform', { table: 'plan', key: { id: 'p2' }, confirm: true }, owner);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(deleted.body.deleted, true);
      // A tenant's row and the profile's address answer as any refused write does.
      for (const [path, body] of [
        ['/api/update', { table: 'lead', key: { id: 'n1' }, values: { name: 'Edited' } }],
        ['/api/update', { table: 'dealer', key: { id: 'north' }, values: { public_address: 'SomeoneElsesAddress000001' } }],
        ['/api/insert', { table: 'dealer', values: { id: 'west', name: 'West' } }],
        ['/api/delete', { table: 'dealer', key: { id: 'south' }, confirm: true }],
      ] as const) {
        const refused = await call(`${path}?app=lending&realm=platform`, body, owner);
        assert.equal(refused.status, 403, `${path} ${JSON.stringify(refused.body)}`);
        assert.equal(refused.body.outcome, 'rejected');
      }
      for (const [path, body] of [
        ['/api/import', { table: 'plan', csv: 'id,name,price\np9,Bulk,1', mapping: {}, mode: 'insert' }],
        ['/api/revert', { confirm: true }],
        ['/api/revert', {}],
        ['/api/file/upload', { table: 'plan' }],
      ] as const)
        assert.equal((await call(`${path}?app=lending&realm=platform`, body, owner)).status, 403, path);
      assert.deepEqual(await rows('SELECT id, name FROM plan ORDER BY id'), [{ id: 'p1', name: 'Gold' }]);
      assert.deepEqual(await rows("SELECT name, public_address FROM dealer WHERE id = 'north'"), [
        { name: 'North Motors', public_address: NORTH },
      ]);
      // The record's own history keeps the trail: the account that saved, by its name, through the App, for each write
      // (a history that named nobody said "Someone"). Kept under the table the writer was asked by:
      // `public.plan` on PostgreSQL.
      const kept = await rows(
        `SELECT kind, actor, actor_name, via FROM "${RECORD_HISTORY_TABLES.change}" WHERE resource = '${engine.id('plan')}' ORDER BY id`,
      );
      assert.deepEqual(
        kept.map((row) => ({ ...row })),
        [
          { kind: 'update', actor: 'Lee', actor_name: 'Lee Park', via: 'app' },
          { kind: 'insert', actor: 'Lee', actor_name: 'Lee Park', via: 'app' },
          { kind: 'delete', actor: 'Lee', actor_name: 'Lee Park', via: 'app' },
        ],
      );
    });

    test("HTTP: the platform lease's catalog offers exactly the edits its write accepts, and an auditor's none", async (t) => {
      const { service, app } = await fixture(t, dialect);
      const call = await serve(t, service, app);
      const lease = ownerHeaders(
        (await call('/api/tenant/context/open?app=lending&realm=platform', {})).body as unknown as TenantContextReply,
      );
      const schema = await call('/api/schema?app=lending&realm=platform', undefined, lease);
      assert.equal(schema.status, 200, JSON.stringify(schema.body));
      const table = (id: string) =>
        (
          schema.body.tables as { id: string; insertable: boolean; deletable: boolean; columns: { name: string; writable: boolean }[] }[]
        ).find((each) => each.id === id)!;
      const writable = (id: string) =>
        table(id)
          .columns.filter((column) => column.writable)
          .map((column) => column.name)
          .sort();
      assert.deepEqual(writable('dealer'), ['name']);
      assert.equal(table('dealer').insertable || table('dealer').deletable, false);
      assert.deepEqual(writable('plan'), ['id', 'name', 'price', 'region_id']);
      assert.equal(table('plan').insertable && table('plan').deletable, true);
      assert.equal(table('region').deletable, false);
      assert.deepEqual(writable('lead'), []);
      assert.deepEqual(writable('vehicle_model'), []);
      const served = await call('/api/app?app=lending&realm=platform', undefined, lease);
      assert.deepEqual([...served.body.app.writableTables].sort(), ['dealer', 'plan', 'region', 'review_file']);
      // The platform realm is never served a tenant's addresses.
      assert.equal(served.body.app.addresses, undefined);
      const auditor = await call('/api/tenant/context/open?app=lending&realm=platform', {}, { cookie: 'fixture=pat' });
      const audited = await call('/api/app?app=lending&realm=platform', undefined, {
        cookie: 'fixture=pat',
        ...ownerHeaders(auditor.body as unknown as TenantContextReply),
      });
      assert.deepEqual(audited.body.app.writableTables, []);
    });
  });

/* ---------- A tenant reads its own public address ---------- */

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant's own addresses on ${dialect}`, { skip }, () => {
    const SOUTH = 'SouthPublicAddress0000001';
    const ROTATED = 'NorthRotatedAddress000001';
    test("every member of a tenant's own lease is served its address, never another tenant's; a doubled or malformed one is no one's", async (t) => {
      const { service, app, engine } = await fixture(t, dialect);
      const call = await serve(t, service, app);
      const served = async (account: string, tenant: string) => {
        const cookie = { cookie: `fixture=${account}` };
        const lease = await call(`/api/tenant/context/open?app=lending&tenant=${tenant}`, {}, cookie);
        assert.equal(lease.status, 200, JSON.stringify(lease.body));
        const reply = await call(`/api/app?app=lending&tenant=${tenant}`, undefined, {
          ...cookie,
          ...ownerHeaders(lease.body as unknown as TenantContextReply),
        });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        // Never on the lease's own reply or a header: the App payload alone carries it.
        assert.doesNotMatch(JSON.stringify(lease.body), /PublicAddress|RotatedAddress/);
        return reply.body.app.addresses as { public?: string; intake?: string } | undefined;
      };
      assert.deepEqual(await served('alice', 'north'), { public: NORTH });
      // South has none yet: nothing is served, and never north's.
      assert.equal(await served('sam', 'south'), undefined);
      await engine.exec(`UPDATE dealer SET public_address = '${SOUTH}' WHERE id = 'south'`);
      assert.deepEqual(await served('sam', 'south'), { public: SOUTH });
      assert.deepEqual(await served('alice', 'north'), { public: NORTH });
      // Rotated: the next load shows the new address.
      await engine.exec(`UPDATE dealer SET public_address = '${ROTATED}' WHERE id = 'north'`);
      assert.deepEqual(await served('alice', 'north'), { public: ROTATED });
      // Two tenants holding one address: it places no one, so neither is shown it.
      await engine.exec(`UPDATE dealer SET public_address = '${ROTATED}' WHERE id = 'south'`);
      assert.equal(await served('alice', 'north'), undefined);
      assert.equal(await served('sam', 'south'), undefined);
      // Not of an address's shape: no one's either.
      await engine.exec(`UPDATE dealer SET public_address = 'short' WHERE id = 'north'`);
      assert.equal(await served('alice', 'north'), undefined);
      // The bootstrap names no address.
      assert.doesNotMatch(
        JSON.stringify((await call('/api/tenant/bootstrap?app=lending', undefined, { cookie: 'fixture=alice' })).body),
        /Address/,
      );
    });
  });
