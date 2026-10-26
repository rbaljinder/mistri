import { parseTestApp } from './support/commandCatalog.js';
/* A platform-only source (`sources.<name>.realm: 'platform'`): another
   database a tenant App's platform realm reads under resolvePlatformRows, by
   qualified name, and nothing else ever reaches. A tenant's or a member's
   context does not have it at all; nothing writes it; no command looks it up
   or names it; no API or MCP client is served it; it is never the App's own
   database or the authentication store under another name; and DDL on a
   declared table refuses its reads until restart. SQLite always, PostgreSQL
   live (support/tenantDialects.ts), each on databases this suite owns. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parseAppConfig, tenantAppShape, tenantBusinessApp } from '../packages/mistri/src/shared/app.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy, type AppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { bindPlatformReadRuntime } from '../packages/mistri/src/server/tenant/tenantPlatformReadRuntime.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import {
  assertTenantSourcesApart,
  captureTenantPlatformSource,
  openPostgresPlatformReadSource,
  openSqlitePlatformReadSource,
  platformSourceCatalog,
  platformSourceDeclaration,
  readPostgresSourceLocation,
  sqliteSourceLocation,
  type TenantPlatformSourceDeclaration,
  type TenantSourceLocation,
} from '../packages/mistri/src/server/tenant/tenantPlatformSource.js';
import { prepareTenantStartup, TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  pgClient,
  TENANT_DIALECTS,
  uuidPostgresDatabase,
  type Control,
  type TenantDialect,
  type TenantEngine,
} from './support/tenantDialects.js';
import { trustTenantCatalogFor } from '../packages/mistri/src/server/tenant/tenantPostgresCatalog.js';

/* These cases change a declared source's catalog and expect the very next read to refuse: no window in which an
   attestation stands without the digest (tenantReadSource.ts has the window's own cases). */
trustTenantCatalogFor(0);

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-store' };
const BUSINESS = {
  tables: ['lead', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL,
      version integer NOT NULL DEFAULT 0);`,
  rows: `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO lead (id, tenant_id, name) VALUES ('n1', 'north', 'North lead'), ('s1', 'south', 'South lead');`,
};
/* `note` is declared and never named by the policy; `secret` is not declared
   and references a declared table, which is tolerated and never read. */
const APPLICANTS = {
  sqlite: `PRAGMA foreign_keys = ON;
    CREATE TABLE applicant (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, ssn TEXT);
    CREATE TABLE credit_file (id TEXT PRIMARY KEY NOT NULL, applicant_id TEXT NOT NULL REFERENCES applicant(id), score INTEGER NOT NULL);
    CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, applicant_id TEXT REFERENCES applicant(id), body TEXT);
    CREATE TABLE secret (id TEXT PRIMARY KEY NOT NULL, applicant_id TEXT REFERENCES applicant(id), body TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.applicant (id text PRIMARY KEY, name text NOT NULL, status text NOT NULL, ssn text);
    CREATE TABLE public.credit_file (id text PRIMARY KEY, applicant_id text NOT NULL REFERENCES public.applicant(id), score integer NOT NULL);
    CREATE TABLE public.note (id text PRIMARY KEY, applicant_id text REFERENCES public.applicant(id), body text);
    CREATE TABLE public.secret (id text PRIMARY KEY, applicant_id text REFERENCES public.applicant(id), body text NOT NULL);`,
  rows: `
    INSERT INTO applicant VALUES ('a1', 'Ada', 'active', '111-11-1111'), ('a2', 'Bo', 'inactive', '222-22-2222');
    INSERT INTO credit_file VALUES ('c1', 'a1', 700), ('c2', 'a2', 610);
    INSERT INTO note VALUES ('t1', 'a1', 'Declared, never named');
    INSERT INTO secret VALUES ('x1', 'a1', 'Undeclared');`,
};

type Manifest = Record<string, any>;
const manifest = (): Manifest => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: 'business-db', default: true }, applicants: { connection: 'applicants-db', realm: 'platform' } },
  resources: {
    dealer: { owner: 'platform' },
    lead: { owner: 'tenant' },
    'applicants.applicant': { owner: 'platform', fields: { read: ['id', 'name', 'status'] } },
    'applicants.credit_file': { owner: 'platform' },
    'applicants.note': { owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true },
      manager: { realm: 'platform', read: true },
      // A platform member whose grant does not reach the platform-only source.
      auditor: { realm: 'platform', read: ['lead', 'dealer'] },
    },
  },
  views: { leads: { kind: 'list', from: 'lead' }, applicants: { kind: 'list', from: 'applicants.applicant' } },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['applicants'] },
  ],
  home: 'leads',
});
const altered = (patch: (m: Manifest) => void) => {
  const m = manifest();
  patch(m);
  return m;
};
const refusedWith = (patch: (m: Manifest) => void, expected: RegExp) =>
  assert.throws(() => parseAppConfig(altered(patch), 'lending.ts'), expected);
const platformRows = () => ({
  dealer: true,
  lead: true,
  'applicants.applicant': { groups: [[{ column: 'status', op: '=' as const, value: 'active' }]] },
  'applicants.credit_file': true,
});
const policy = (patch: Partial<AppTenantPolicy> = {}) =>
  defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => ({ lead: true }),
    resolveRows: () => ({ lead: true }),
    resolvePlatformRows: platformRows,
    ...patch,
  });

type Request = { readonly cookie?: string; readonly headers?: { readonly cookie?: string } };
const cookieOf = (request: Request) => request.cookie ?? request.headers?.cookie?.replace(/^fixture=/, '') ?? '';
const identities: Record<string, { id: string; who: string }> = {
  alice: { id: 'alice', who: 'Alice' },
  lee: { id: 'lee', who: 'Lee' },
  pat: { id: 'pat', who: 'Pat' },
};
const as = (cookie: string): Request => ({ cookie });
const instance = (request: Request) => {
  const identity = identities[cookieOf(request)];
  return identity ? { identity, sessionId: `session-${identity.id}`, expiresAt: 5000 } : null;
};
const plain = (row: object) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
// PostgreSQL's counts and bigint values arrive as exact decimal text.
const numeric = (value: unknown) => (typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value);
const values = (row: object) => Object.values(plain(row)).map(numeric);
const total = (value: unknown) =>
  Number(numeric(value !== null && typeof value === 'object' && 'count' in value ? (value as { count: unknown }).count : value));
const rejected = (work: Promise<unknown>) => assert.rejects(work, TenantContextError);
const denied = (work: () => unknown) => assert.throws(work, TenantContextError);
const applicants = { table: 'applicants.applicant', limit: 10, offset: 0, orderBy: [{ column: 'id', direction: 'asc' as const }] };
const revokeLee = `UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked', version = '2' WHERE id = 'platform-lee'`;

/* ---------- the DSL, the lock and the business projection ---------- */

test('DSL: a platform-only source, its read-only platform resources, the lock fact, and the App without it', () => {
  const app = parseAppConfig(manifest(), 'lending.ts');
  assert.deepEqual(app.sources, {
    business: { connection: 'business-db', default: true },
    applicants: { connection: 'applicants-db', default: false, realm: 'platform' },
  });
  assert.equal(app.resources!['applicants.applicant'].source, 'applicants');
  assert.equal(tenantAppShape(app), true, 'one source of its own, and the platform-only one beside it');
  // Widening it to an ordinary source is a removed line in the lock.
  assert.match(authorityReport(app), /^source applicants realm platform read-only — the App$/m);
  assert.doesNotMatch(
    authorityReport(
      parseAppConfig(
        altered((m) => {
          delete m.sources.applicants;
          for (const name of Object.keys(m.resources)) if (name.includes('.')) delete m.resources[name];
          m.views = { leads: m.views.leads };
          m.nav = [m.nav[0]];
        }),
        'lending.ts',
      ),
    ),
    /^source \w+ realm platform/m,
  );
  // Every owner but the platform realm's reads is built without it: no source, resource or grant naming it.
  const named = parseAppConfig(
    altered((m) => {
      m.auth.roles.auditor.read = ['lead', 'applicants.applicant'];
    }),
    'lending.ts',
  );
  const business = tenantBusinessApp(named);
  assert.deepEqual(Object.keys(business.sources!), ['business']);
  assert.deepEqual(Object.keys(business.resources!).sort(), ['dealer', 'lead']);
  assert.deepEqual(business.auth!.roles!.auditor.read, ['lead']);
  assert.equal(tenantAppShape(business), true);
  assert.equal(tenantBusinessApp(business), business, 'an App without one is its own projection');
});

test('DSL: a platform-only source is refused with what it needs', () => {
  refusedWith((m) => {
    m.sources.applicants.realm = 'tenant';
  }, /source "applicants" has a "realm" of "tenant"/);
  refusedWith((m) => {
    m.sources.applicants.default = true;
    delete m.sources.business.default;
  }, /source "applicants" is "realm": "platform", so it is never the default/);
  // Only a tenant App with the platform realm has one.
  refusedWith((m) => {
    delete m.auth.tenancy.platform;
  }, /source "applicants" is "realm": "platform".*needs a tenant App.*the platform realm/);
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Plain',
          sources: { main: { connection: 'main-db', default: true }, applicants: { connection: 'applicants-db', realm: 'platform' } },
          resources: { 'applicants.applicant': {} },
          views: { people: { kind: 'list', from: 'applicants.applicant' } },
          home: 'people',
        },
        'plain.ts',
      ),
    /needs a tenant App/,
  );
  // Its resources are the platform's, read only, and nothing acts on them.
  refusedWith((m) => {
    m.resources['applicants.applicant'].owner = 'global';
  }, /resources "applicants.applicant" is in the platform-only source "applicants", so it says "owner": "platform" and no "access": the platform realm reads it and nothing writes it/);
  refusedWith((m) => {
    m.resources['applicants.credit_file'].access = 'write';
  }, /so it says "owner": "platform" and no "access": the platform realm reads it and nothing writes it/);
  refusedWith((m) => {
    m.resources['applicants.credit_file'].favorite = true;
  }, /has "favorite", which a platform-only source's resource does not take/);
  refusedWith((m) => {
    m.resources['applicants.credit_file'].search = { connection: 'index', fields: ['id'] };
  }, /has "search", which a platform-only source's resource does not take/);
  refusedWith((m) => {
    m.resources['applicants.credit_file'].delete = true;
  }, /delete/);
  // Never the profile, and never a tenant's: not by role, and not by a tenant view.
  refusedWith((m) => {
    m.auth.tenancy.profile = 'applicants.applicant';
  }, /"profile" names "applicants\.applicant", in a platform-only source/);
  refusedWith((m) => {
    m.auth.roles.staff.read = ['lead', 'applicants.applicant'];
  }, /role "staff" is a tenant role and names "applicants\.applicant", a platform-owned resource/);
  refusedWith((m) => {
    m.nav = [{ id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads', 'applicants'] }];
  }, /views "applicants" is in the tenant realm and reads "applicants\.applicant", a platform-owned resource/);
  // A visitor reads one tenant's rows and global ones by its public address, never the platform's, in any source.
  assert.deepEqual(
    parseTestApp(
      altered((m) => {
        (m.auth as Record<string, unknown>).public = { read: ['lead'] };
      }),
      'lending.ts',
    ).auth?.public?.read,
    ['lead'],
  );
  refusedWith((m) => {
    (m.auth as Record<string, unknown>).public = { read: ['dealer'] };
  }, /"auth", "public", "read" names "dealer", a platform-owned resource/);
  refusedWith((m) => {
    (m.auth as Record<string, unknown>).public = { read: ['applicants.applicant'] };
  }, /applicants\.applicant/);
  // An API serves the App's own data; what it may never expose is this source.
  const exposing = (api: Record<string, unknown>) =>
    parseTestApp(
      altered((m) => {
        m.api = api;
      }),
      'lending.ts',
    );
  assert.equal(
    exposing({ version: 1, roles: ['staff'], resources: { lead: { fields: ['id', 'name'] } } }).api?.version,
    1,
    'an App with a platform-only source still serves its own resources',
  );
  assert.throws(
    () => exposing({ version: 1, roles: ['staff'], resources: { 'applicants.applicant': { fields: ['id'] } } }),
    /api\.resources\.applicants\.applicant names "applicants\.applicant", which belongs to the platform-only source "applicants"/,
  );
  assert.throws(
    () => exposing({ version: 1, roles: ['staff'], views: ['applicants'] }),
    /api\.views\.applicants names "applicants\.applicant", which belongs to the platform-only source "applicants"/,
  );
  // Nor the platform realm's own view or command, even over the App's own
  // table: a token acts through one tenant membership, and those are the
  // platform's — it looks across tenants, which no tenant-bound token does.
  const withPlatformView = (api: Record<string, unknown>) =>
    parseAppConfig(
      altered((m) => {
        m.views.audit = { kind: 'list', from: 'lead', realm: 'platform' };
        m.nav[1].children = ['applicants', 'audit'];
        m.api = api;
      }),
      'lending.ts',
    );
  assert.equal(
    withPlatformView({ version: 1, roles: ['staff'], resources: { lead: { fields: ['id', 'name'] } } }).api?.version,
    1,
    'the platform realm may keep its own view; only exposing it is refused',
  );
  assert.throws(
    () => withPlatformView({ version: 1, roles: ['staff'], views: ['audit'] }),
    /api\.views\.audit exposes a platform-realm view, which an API token cannot be served/,
  );
  /* And a view that says nothing itself, placed in the platform's group — the
     menu is what puts a view in a realm, so this is the same view. The
     ownership check downstream cannot catch it: `lead` is the tenant's own
     table, so a tenant token reads it perfectly well. */
  const placedInPlatformGroup = (api: Record<string, unknown>) =>
    parseAppConfig(
      altered((m) => {
        m.views.audit = { kind: 'list', from: 'lead' };
        m.nav[1].children = ['applicants', 'audit'];
        m.api = api;
      }),
      'lending.ts',
    );
  assert.throws(
    () => placedInPlatformGroup({ version: 1, roles: ['staff'], views: ['audit'] }),
    /api\.views\.audit exposes a platform-realm view, which an API token cannot be served/,
  );
  assert.throws(
    () =>
      exposing({
        version: 1,
        roles: ['staff'],
        resources: { lead: { fields: ['id', 'name'] } },
        commands: [{ id: 'approve', version: 1, target: 'lead', input: {}, realm: 'platform' }],
      }),
    /api\.commands names "approve", a "realm": "platform" command, which an API token cannot run/,
  );
  // An App whose every home rule reads that source has no home of its own.
  assert.throws(
    () =>
      parseAppConfig(
        altered((m) => {
          m.home = 'applicants';
        }),
        'lending.ts',
      ),
    /every "home" rule opens a view that reads a platform-only source/,
  );
});

test('catalog: exactly the declared tables, each one ordinary table; a key to a table it does not declare goes with that table', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    `${APPLICANTS.sqlite} CREATE VIEW active AS SELECT id, name FROM applicant; CREATE TABLE __mistri_hidden (id TEXT PRIMARY KEY NOT NULL);`,
  );
  db.exec('BEGIN');
  const physical = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const declaration = (resources: Record<string, string | null>): TenantPlatformSourceDeclaration => ({
    appId: 'lending',
    source: { id: 'applicants', connection: 'applicants-db' },
    resources,
  });
  const catalog = platformSourceCatalog(physical, declaration({ 'applicants.applicant': null, 'applicants.file': 'credit_file' }));
  assert.deepEqual(catalog.schema.tables.map((table) => table.id).sort(), ['applicants.applicant', 'applicants.file']);
  assert.deepEqual({ ...catalog.resources }, { 'applicants.applicant': 'applicant', 'applicants.file': 'credit_file' });
  assert.deepEqual(
    catalog.schema.foreignKeys.map((fk) => [fk.from.table, fk.to.table]),
    [['applicants.file', 'applicants.applicant']],
  );
  denied(() => platformSourceCatalog(physical, declaration({ 'applicants.missing': null })));
  denied(() => platformSourceCatalog(physical, declaration({ 'applicants.active': null })));
  denied(() => platformSourceCatalog(physical, declaration({ 'applicants.hidden': '__mistri_hidden' })));
  denied(() => platformSourceCatalog(physical, declaration({ 'applicants.a': 'applicant', 'applicants.b': 'applicant' })));
  denied(() => platformSourceCatalog(physical, declaration({ 'other.applicant': null })));
  denied(() => platformSourceCatalog(physical, declaration({})));
});

test("locations: a platform-only source is never the App's own database under another name", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-platform-location-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name: string) => {
    const path = join(dir, name),
      db = new DatabaseSync(path);
    db.exec('CREATE TABLE t (x)');
    db.close();
    return path;
  };
  const own = make('own.db'),
    other = make('other.db');
  symlinkSync(own, join(dir, 'link.db'));
  linkSync(own, join(dir, 'hard.db'));
  const here = sqliteSourceLocation(own);
  denied(() => assertTenantSourcesApart(here, [sqliteSourceLocation(join(dir, 'link.db'))]));
  denied(() => assertTenantSourcesApart(here, [sqliteSourceLocation(join(dir, 'hard.db'))]));
  assertTenantSourcesApart(here, [sqliteSourceLocation(other)]);
  const pg = (system: string | null, database: string): TenantSourceLocation => ({ kind: 'postgres', system, database });
  denied(() => assertTenantSourcesApart(pg('7', 'lending'), [pg('7', 'lending')]));
  // A server that will not say who it is is taken to be the same one.
  denied(() => assertTenantSourcesApart(pg(null, 'lending'), [pg('7', 'lending')]));
  assertTenantSourcesApart(pg('7', 'lending'), [pg('8', 'lending')]);
  assertTenantSourcesApart(pg('7', 'lending'), [pg('7', 'applicants')]);
  assertTenantSourcesApart(here, [pg(null, 'own')]);
});

/* ---------- end to end, on each engine ---------- */

interface Outside {
  readonly where: { readonly existingPath: string } | { readonly url: string };
  exec(sql: string): Promise<void>;
  rows(): Promise<unknown>;
  close(): Promise<void>;
}
async function outsideDatabase(dialect: TenantDialect): Promise<Outside> {
  const read = (all: (sql: string) => Promise<unknown[]>) => async () => ({
    applicant: await all('SELECT * FROM applicant ORDER BY id'),
    credit_file: await all('SELECT * FROM credit_file ORDER BY id'),
    note: await all('SELECT * FROM note ORDER BY id'),
    secret: await all('SELECT * FROM secret ORDER BY id'),
  });
  if (dialect === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-platform-source-'));
    const path = join(dir, 'applicants.db'),
      db = new DatabaseSync(path);
    db.exec(APPLICANTS.sqlite + APPLICANTS.rows);
    return {
      where: { existingPath: path },
      async exec(sql) {
        db.exec(sql);
      },
      rows: read(async (sql) =>
        db
          .prepare(sql)
          .all()
          .map((row) => ({ ...row })),
      ),
      async close() {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  const owned = await uuidPostgresDatabase('psrc_ref');
  let control: Control | undefined;
  try {
    control = await pgClient(owned.url);
    await control.query(APPLICANTS.postgres + APPLICANTS.rows);
  } catch (error) {
    await control?.end().catch(() => {});
    await owned.drop();
    throw error;
  }
  const client = control;
  return {
    where: { url: owned.url },
    async exec(sql) {
      await client.query(sql);
    },
    rows: read(async (sql) => (await client.query(sql)).rows.map((row) => ({ ...row }))),
    async close() {
      await client.end().catch(() => {});
      await owned.drop();
    },
  };
}

interface EnrollPatch {
  readonly alter?: (m: Manifest) => void;
  readonly policy?: AppTenantPolicy;
  readonly platformSources?: ReadonlyArray<Record<string, string>>;
  readonly registry?: ReturnType<typeof defineCommands>;
  readonly verifySession?: (request: Request) => { id: string; who: string } | null | Promise<{ id: string; who: string } | null>;
}
async function fixture(t: TestContext, dialect: TenantDialect) {
  const suffix = `psrc_${randomUUID().replaceAll('-', '')}`;
  const engine: TenantEngine = await openTenantEngine(dialect, {
    tables: BUSINESS.tables,
    sqlite: BUSINESS.sqlite + BUSINESS.rows,
    postgres: BUSINESS.postgres + BUSINESS.rows,
    database: suffix,
  });
  const owners: Array<{ retire(): Promise<void> }> = [];
  let outside: Outside | undefined;
  // One hook, in order: the owners, then the engines under them, then the databases this suite made.
  t.after(async () => {
    try {
      await Promise.allSettled(owners.map((owner) => owner.retire()));
    } finally {
      await engine.close().catch(() => {});
      await outside?.close();
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(suffix);
    }
  });
  outside = await outsideDatabase(dialect);
  await engine.provisionStore(binding);
  const grant = { status: 'active' as const, validUntil: 10_000, expectedVersion: null };
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['manager'] });
    await admin.putPlatformMembership({ ...grant, accountId: 'pat', membershipId: 'platform-pat', roles: ['auditor'] });
  });
  const own = dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path };
  const where = outside.where;
  const enroll = async (patch: EnrollPatch = {}) => {
    const raw = manifest();
    patch.alter?.(raw);
    const app = parseTestApp(raw, 'lending.ts');
    const service: TenantEnrollment<Request> = await createTenantEnrollment<Request>({
      app,
      policy: patch.policy ?? policy(),
      source: { ...binding.source, ...own },
      platformSources: (patch.platformSources ?? [{ id: 'applicants', connection: 'applicants-db', ...where }]) as never,
      deployment: 'generation',
      roles: ['staff', 'manager', 'auditor'],
      maxLifetimeMs: 1000,
      now: () => 100,
      ...(patch.registry ? { commands: { registry: patch.registry } } : {}),
      verifySession: patch.verifySession ?? ((request) => identities[cookieOf(request)] ?? null),
    });
    owners.push(service);
    return { service, app };
  };
  return { engine, outside, where, own, enroll, owners };
}

/** The dedicated tenant HTTP host over an enrollment, and a fetch as one of the fixture's accounts. */
async function serve(t: TestContext, service: TenantEnrollment<Request>, app: ReturnType<typeof parseAppConfig>) {
  const bound = { host: '127.0.0.1', port: 0 };
  const http = createTenantHttpServer({ app, enrollment: service, bound, verifySessionInstance: (req: IncomingMessage) => instance(req) });
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
  return async (account: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: `fixture=${account}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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
  describe(`a platform-only source on ${dialect}`, { skip }, () => {
    const postgres = dialect === 'postgres';

    test('the platform context reads it by qualified name, under resolvePlatformRows and within its column ceiling', async (t) => {
      const f = await fixture(t, dialect),
        { service } = await f.enroll(),
        before = await f.outside.rows();
      const seen = await service.deployment.withPlatformContext(as('lee'), async (context) => ({
        tables: context.schema.tables.map((table) => table.id).sort(),
        applicants: (await context.data.query(applicants)).rows.map(plain),
        credit: (
          await context.data.query({
            table: 'applicants.credit_file',
            columns: ['id', 'applicant_id', 'score'],
            limit: 10,
            offset: 0,
            orderBy: [{ column: 'id', direction: 'asc' }],
          })
        ).rows.map(values),
        notes: (await context.data.query({ table: 'applicants.note', limit: 10, offset: 0 })).rows.length,
        counted: total(await context.data.count('applicants.applicant')),
        leads: (
          await context.data.query({
            table: 'lead',
            columns: ['id', 'tenant_id'],
            limit: 10,
            offset: 0,
            orderBy: [{ column: 'id', direction: 'asc' }],
          })
        ).rows.map(values),
      }));
      assert.deepEqual(seen.tables, ['applicants.applicant', 'applicants.credit_file', 'applicants.note', 'dealer', 'lead']);
      // Active applicants only, as the policy says; never `ssn`, outside the column ceiling.
      assert.deepEqual(plain(seen).applicants, [{ id: 'a1', name: 'Ada', status: 'active' }]);
      assert.deepEqual(seen.credit, [
        ['c1', 'a1', 700],
        ['c2', 'a2', 610],
      ]);
      assert.equal(seen.notes, 0, 'declared, and not named by resolvePlatformRows: denied');
      assert.equal(seen.counted, 1);
      assert.deepEqual(
        seen.leads,
        [
          ['n1', 'north'],
          ['s1', 'south'],
        ],
        "the App's own rows beside it, across tenants",
      );
      // A column outside the ceiling, or a table it does not declare, is not there to read.
      await rejected(
        service.deployment.withPlatformContext(as('lee'), (context) => context.data.query({ ...applicants, columns: ['id', 'ssn'] })),
      );
      await rejected(
        service.deployment.withPlatformContext(as('lee'), (context) =>
          context.data.query({ table: 'applicants.secret', limit: 10, offset: 0 }),
        ),
      );
      assert.deepEqual(await f.outside.rows(), before, 'read, never written');
    });

    test('views, breakdowns, references and page plans go to the source that holds their table, and no key crosses sources', async (t) => {
      const f = await fixture(t, dialect),
        { service, app } = await f.enroll(),
        before = await f.outside.rows();
      const view = {
        id: 'v',
        name: 'V',
        base: 'applicants.credit_file',
        columns: [{ path: 'id' }, { path: 'applicant_id.name' }],
        orderBy: [{ path: 'id', direction: 'asc' as const }],
        limit: 10,
      };
      const breakdown = { base: 'applicants.applicant', by: [{ path: 'status' }], measures: [{ fn: 'count' as const }] };
      const seen = await service.deployment.withPlatformContext(as('lee'), async (context) => ({
        // The join stays in its source and under the joined table's own scope: an inactive applicant's name is not read.
        view: (await context.data.runView(view, 0)).rows.map(values),
        viewCount: total(await context.data.countView(view)),
        groups: (await context.data.runBreakdown(breakdown, 0)).rows.map(values),
        groupCount: total(await context.data.countBreakdown(breakdown)),
        crossing: context.schema.foreignKeys.filter(
          (fk) => fk.from.table.startsWith('applicants.') !== fk.to.table.startsWith('applicants.'),
        ).length,
      }));
      assert.deepEqual(seen.view, [
        ['c1', 'Ada'],
        ['c2', null],
      ]);
      assert.equal(seen.viewCount, 2);
      assert.deepEqual(seen.groups, [['active', 1]]);
      assert.equal(seen.groupCount, 1);
      assert.equal(seen.crossing, 0);
      // A path from one source into another has no key to walk.
      await rejected(
        service.deployment.withPlatformContext(as('lee'), (context) =>
          context.data.runView(
            { id: 'x', name: 'X', base: 'lead', columns: [{ path: 'id' }, { path: 'applicant_id.name' }], limit: 10 },
            0,
          ),
        ),
      );

      const fetchAs = await serve(t, service, app);
      const opened = await fetchAs('lee', '/api/tenant/context/open?app=lending&realm=platform', {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const lease = opened.body as unknown as TenantContextReply,
        headers = ownerHeaders(lease);
      const at = (path: string) => `${path}?app=lending&realm=platform`;
      const schema = await fetchAs('lee', at('/api/schema'), undefined, headers);
      assert.equal(schema.status, 200);
      const applicant = schema.body.tables.find((table: { id: string }) => table.id === 'applicants.applicant');
      assert.deepEqual(
        applicant.columns.map((column: { name: string }) => column.name),
        ['id', 'name', 'status'],
      );
      const rows = await fetchAs('lee', at('/api/query'), { table: 'applicants.applicant', limit: 10, offset: 0 }, headers);
      assert.equal(rows.status, 200, JSON.stringify(rows.body));
      assert.deepEqual(
        rows.body.rows.map((row: object) => plain(row).id),
        ['a1'],
      );
      const counted = await fetchAs('lee', at('/api/count'), { table: 'applicants.credit_file' }, headers);
      assert.equal(counted.status, 200, JSON.stringify(counted.body));
      // Incoming keys within its own source only, counted under their own scope; the undeclared table is not one of them.
      const references = await fetchAs('lee', at('/api/references'), { table: 'applicants.applicant', key: { id: 'a1' } }, headers);
      assert.equal(references.status, 200, JSON.stringify(references.body));
      assert.deepEqual(
        references.body.references.map((reference: { table: string; count: unknown }) => [reference.table, total(reference.count)]).sort(),
        [
          ['applicants.credit_file', 1],
          ['applicants.note', 0],
        ],
      );
      // A record outside the policy's rows is not found by its key.
      assert.equal(
        (await fetchAs('lee', at('/api/references'), { table: 'applicants.applicant', key: { id: 'a2' } }, headers)).status,
        403,
      );
      const plan = await fetchAs('lee', at('/api/pages/plan'), { page: 'suggested:applicants.applicant', key: { id: 'a1' } }, headers);
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(plan.body.page.base, 'applicants.applicant');
      const metadata = await fetchAs('lee', at('/api/app'), undefined, headers);
      assert.ok(Object.keys(metadata.body.app.views).includes('applicants'), 'the platform realm is offered its view of it');
      // Nothing writes it, on the platform lease or anywhere else.
      for (const [path, body] of [
        ['/api/insert', { table: 'applicants.applicant', values: { id: 'a3', name: 'Cy', status: 'active' } }],
        ['/api/update', { table: 'applicants.applicant', key: { id: 'a1' }, values: { name: 'Eve' } }],
        ['/api/delete', { table: 'applicants.applicant', key: { id: 'a1' }, confirm: true }],
      ] as const) {
        assert.equal((await fetchAs('lee', at(path), body, headers)).status, 403, path);
      }
      assert.deepEqual(await f.outside.rows(), before);
    });

    test("a tenant's context does not have it: not its catalog, reads or metadata, and a tenant policy naming it refuses", async (t) => {
      const f = await fixture(t, dialect),
        { service, app } = await f.enroll();
      const tables = await service.deployment.withContext(as('alice'), ['north'], async (context) =>
        context.schema.tables.map((table) => table.id),
      );
      assert.deepEqual(tables, ['lead']);
      await rejected(service.deployment.withContext(as('alice'), ['north'], (context) => context.data.query(applicants)));
      // A platform member holds no tenant membership, and a tenant member no platform one.
      await rejected(service.deployment.withPlatformContext(as('alice'), () => true));
      const fetchAs = await serve(t, service, app);
      const opened = await fetchAs('alice', '/api/tenant/context/open?app=lending&tenant=north', {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const headers = ownerHeaders(opened.body as unknown as TenantContextReply);
      const at = (path: string) => `${path}?app=lending&tenant=north`;
      const schema = await fetchAs('alice', at('/api/schema'), undefined, headers);
      assert.deepEqual(
        schema.body.tables.map((table: { id: string }) => table.id),
        ['lead'],
      );
      assert.equal(
        (await fetchAs('alice', at('/api/query'), { table: 'applicants.applicant', limit: 10, offset: 0 }, headers)).status,
        403,
      );
      assert.equal(
        (await fetchAs('alice', at('/api/references'), { table: 'applicants.applicant', key: { id: 'a1' } }, headers)).status,
        403,
      );
      const metadata = await fetchAs('alice', at('/api/app'), undefined, headers);
      assert.equal(Object.keys(metadata.body.app.views).includes('applicants'), false);
      // The tenant runtime's catalog has no such table: a layer naming one is refused, never widened.
      const named = await f.enroll({ policy: policy({ resolveRows: () => ({ lead: true, 'applicants.applicant': true }) }) });
      await rejected(named.service.deployment.withContext(as('alice'), ['north'], () => true));
    });

    test('an unused platform-only source stays unbound, and a failed concurrent first use withholds own rows', async (t) => {
      const f = await fixture(t, dialect);
      const physicalSchema = await f.engine.physicalSchema();
      const resources = { dealer: f.engine.id('dealer'), lead: f.engine.id('lead') };
      const catalog = appResourceCatalog(physicalSchema, resources);
      const ownership = captureTenantOwnership({
        appId: binding.appId,
        source: binding.source,
        schema: catalog.schema,
        physicalSchema,
        resources,
        ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
        profile: 'dealer',
      });
      const reader = await f.engine.openRead(ownership, binding, () => 100);
      const app = parseAppConfig(manifest(), 'lending.ts');
      const declaration = platformSourceDeclaration(app, 'applicants');
      const outside =
        'url' in f.where
          ? await openPostgresPlatformReadSource(f.where.url, declaration)
          : openSqlitePlatformReadSource(f.where.existingPath, declaration);
      const runtime = bindPlatformReadRuntime<Request>({
        app,
        source: reader,
        platformSources: [outside],
        deployment: 'generation',
        roles: ['manager'],
        maxLifetimeMs: 1000,
        verifySession: (request) => identities[cookieOf(request)] ?? null,
        resolvePlatformRows: platformRows,
        now: () => 100,
      });
      f.owners.push({
        retire: async () => {
          await runtime.retire();
          await outside.close();
          await reader.close();
        },
      });

      await outside.close();
      const own = await runtime.withContext(as('lee'), (context) => context.data.query({ table: 'lead', limit: 10, offset: 0 }));
      assert.deepEqual(
        own.rows.map((row) => plain(row).id),
        ['n1', 's1'],
        'an own-only context never binds the closed outside source',
      );
      await rejected(runtime.withContext(as('lee'), (context) => context.data.query(applicants)));

      let firstIds: unknown,
        outsideRejected = false;
      await rejected(
        runtime.withContext(as('lee'), async (context) => {
          const first = await context.data.query({ table: 'lead', limit: 10, offset: 0 });
          firstIds = first.rows.map((row) => plain(row).id);
          const [, outsideRead] = await Promise.allSettled([
            context.data.query({ table: 'lead', limit: 10, offset: 0 }),
            context.data.query(applicants),
          ]);
          outsideRejected = outsideRead.status === 'rejected';
          return first;
        }),
      );
      assert.deepEqual(firstIds, ['n1', 's1'], 'an earlier own result reaches the callback before the later failure');
      assert.equal(outsideRejected, true, 'the first outside operation rejects; the context withholds the earlier own result');
    });

    test("a platform member reads it only as a role grants: an auditor's grant does not reach it", async (t) => {
      const f = await fixture(t, dialect),
        { service } = await f.enroll();
      const tables = await service.deployment.withPlatformContext(as('pat'), async (context) =>
        context.schema.tables.map((table) => table.id).sort(),
      );
      assert.deepEqual(tables, ['dealer', 'lead']);
      await rejected(service.deployment.withPlatformContext(as('pat'), (context) => context.data.query(applicants)));
    });

    test('revoking the platform membership stops a read of it within an open context, and every later one', async (t) => {
      const f = await fixture(t, dialect),
        { service } = await f.enroll();
      await rejected(
        service.deployment.withPlatformContext(as('lee'), async (context) => {
          assert.equal((await context.data.query(applicants)).rows.length, 1);
          await f.engine.exec(revokeLee);
          return context.data.query(applicants);
        }),
      );
      await rejected(service.deployment.withPlatformContext(as('lee'), (context) => context.data.query(applicants)));
    });

    test('a revocation after the pre-read session proof stops the cached scoped binding before rows release', async (t) => {
      const f = await fixture(t, dialect);
      let armed = false,
        reached = false,
        secondResolved = false,
        atPrecheck!: () => void,
        release!: () => void;
      const precheck = new Promise<void>((resolve) => {
        atPrecheck = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { service } = await f.enroll({
        verifySession: async (request) => {
          const identity = identities[cookieOf(request)] ?? null;
          if (armed && !reached) {
            reached = true;
            atPrecheck();
            await resume;
          }
          return identity;
        },
      });
      const reading = service.deployment.withPlatformContext(as('lee'), async (context) => {
        assert.equal((await context.data.query(applicants)).rows.length, 1);
        armed = true;
        const second = await context.data.query(applicants);
        secondResolved = true;
        return second;
      });
      const boundary = await Promise.race([
        precheck.then(() => 'precheck'),
        reading.then(
          () => 'read',
          () => 'read',
        ),
      ]);
      assert.equal(boundary, 'precheck', 'the second read must reach its session precheck before completing');
      try {
        await f.engine.exec(revokeLee);
      } finally {
        release();
      }
      await rejected(reading);
      assert.equal(reached, true);
      assert.equal(secondResolved, false);
    });

    test('declared-source DDL after the pre-read session proof stops the cached scoped binding before rows release', async (t) => {
      const f = await fixture(t, dialect);
      let armed = false,
        reached = false,
        secondResolved = false,
        atPrecheck!: () => void,
        release!: () => void;
      const precheck = new Promise<void>((resolve) => {
        atPrecheck = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { service } = await f.enroll({
        verifySession: async (request) => {
          const identity = identities[cookieOf(request)] ?? null;
          if (armed && !reached) {
            reached = true;
            atPrecheck();
            await resume;
          }
          return identity;
        },
      });
      const reading = service.deployment.withPlatformContext(as('lee'), async (context) => {
        assert.equal((await context.data.query(applicants)).rows.length, 1);
        armed = true;
        const second = await context.data.query(applicants);
        secondResolved = true;
        return second;
      });
      const boundary = await Promise.race([
        precheck.then(() => 'precheck'),
        reading.then(
          () => 'read',
          () => 'read',
        ),
      ]);
      assert.equal(boundary, 'precheck', 'the second read must reach its session precheck before completing');
      try {
        await f.outside.exec('ALTER TABLE applicant ADD COLUMN risk TEXT');
      } finally {
        release();
      }
      await rejected(reading);
      assert.equal(reached, true);
      assert.equal(secondResolved, false);
    });

    test('DDL on a declared table refuses its reads until restart; the tables it does not declare may change', async (t) => {
      const f = await fixture(t, dialect),
        { service } = await f.enroll();
      const read = (owner = service) =>
        owner.deployment.withPlatformContext(as('lee'), async (context) => (await context.data.query(applicants)).rows.length);
      assert.equal(await read(), 1);
      await f.outside.exec(
        postgres ? 'CREATE TABLE public.unrelated (id text PRIMARY KEY)' : 'CREATE TABLE unrelated (id TEXT PRIMARY KEY NOT NULL)',
      );
      await f.outside.exec('ALTER TABLE secret ADD COLUMN extra TEXT');
      assert.equal(await read(), 1, "an undeclared table is not the App's");
      await f.outside.exec('ALTER TABLE applicant ADD COLUMN risk TEXT');
      await rejected(read());
      // Put back, it stays refused: only a restart attests it again.
      await f.outside.exec('ALTER TABLE applicant DROP COLUMN risk');
      await rejected(read());
      const restarted = await f.enroll();
      assert.equal(await read(restarted.service), 1);
    });

    /* The source attests a snapshot from a digest of the catalog rows its full
     attestation reads, as the App's own source does (tenantPostgresCatalog.ts),
     so an unchanged catalog is not described again; a change the full
     attestation refuses must still be refused on the next read, including one
     only the pg_catalog description sees. */
    if (postgres)
      test('a cached attestation reads without describing the catalog again, and still refuses a change made after it', async (t) => {
        const f = await fixture(t, dialect),
          { service } = await f.enroll();
        const read = () =>
          service.deployment.withPlatformContext(as('lee'), async (context) => (await context.data.query(applicants)).rows.length);
        assert.equal(await read(), 1, 'primed');
        const seen: string[] = [];
        const watch = f.engine.intercept(t, {
          match: (statement) => {
            seen.push(statement.sql);
            return false;
          },
        });
        try {
          assert.equal(await read(), 1);
          assert.equal(
            seen.filter((sql) => /information_schema\.columns/.test(sql)).length,
            0,
            'an unchanged catalog is not described again',
          );
        } finally {
          watch.restore();
        }
        await f.outside.exec("ALTER TABLE applicant ALTER COLUMN name SET DEFAULT 'unnamed'");
        await rejected(read());
      });

    test("the source admits only the deployment's genuine membership source and this App's platform evidence", async (t) => {
      const f = await fixture(t, dialect);
      const physicalSchema = await f.engine.physicalSchema();
      const resources = { dealer: f.engine.id('dealer'), lead: f.engine.id('lead') };
      const catalog = appResourceCatalog(physicalSchema, resources);
      const ownership = captureTenantOwnership({
        appId: binding.appId,
        source: binding.source,
        schema: catalog.schema,
        physicalSchema,
        resources,
        ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
        profile: 'dealer',
      });
      const reader = await f.engine.openRead(ownership, binding, () => 1000);
      const declaration = platformSourceDeclaration(parseAppConfig(manifest(), 'lending.ts'), 'applicants');
      const source =
        'url' in f.where
          ? await openPostgresPlatformReadSource(f.where.url, declaration)
          : openSqlitePlatformReadSource(f.where.existingPath, declaration);
      f.owners.push({
        retire: async () => {
          await source.close();
          await reader.close();
        },
      });
      assert.equal(captureTenantPlatformSource(source), source);
      denied(() => captureTenantPlatformSource({ ...source }));
      denied(() => captureTenantPlatformSource(new Proxy(source, {})));
      const lookup = {
        realm: 'platform' as const,
        appId: binding.appId,
        accountId: 'lee',
        source: binding.source,
        deployment: 'deployment-1',
      };
      const record = await reader.readPlatformMembership(lookup);
      assert.ok(record);
      const evidence: PlatformMembershipEvidence = {
        ...lookup,
        membershipId: record.membershipId,
        membershipVersion: record.membershipVersion,
        platformVersion: record.platformVersion,
        roles: [...record.roles],
        verifiedAt: 1000,
        validUntil: 6000,
      };
      const reads = await source.scopeReads(reader, evidence, { 'applicants.applicant': true });
      assert.deepEqual(
        (await reads.query(applicants)).rows.map((row) => plain(row).id),
        ['a1', 'a2'],
        'the scope this source is given, and no other',
      );
      assert.deepEqual(
        [...(await reads.query({ table: 'applicants.credit_file', limit: 10, offset: 0 })).rows],
        [],
        'unnamed here, so denied',
      );
      await rejected(source.scopeReads({ ...reader }, evidence, {}));
      await rejected(source.scopeReads(reader, { ...evidence, realm: 'tenant' } as never, {}));
      await rejected(source.scopeReads(reader, { ...evidence, appId: 'other' }, {}));
      await rejected(source.scopeReads(reader, evidence, { 'applicants.secret': true }));
      await rejected(source.scopeReads(reader, evidence, { lead: true }));
      // Each read revalidates in the tenant store first; a revoked membership reads nothing more.
      await f.engine.exec(revokeLee);
      await rejected(reads.query(applicants));
      await source.close();
      await rejected(source.scopeReads(reader, evidence, {}));
    });

    test("it is never the App's own database, its alias, or reached by a command", async (t) => {
      const f = await fixture(t, dialect);
      if (f.own.url !== undefined) {
        // The same database by another spelling is the same server's same database.
        const spelled = new URL(f.own.url);
        spelled.hostname = spelled.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        denied(() =>
          assertTenantSourcesApart({ kind: 'postgres', system: null, database: 'x' }, [{ kind: 'postgres', system: null, database: 'x' }]),
        );
        const [own, alias, other] = await Promise.all(
          [f.own.url, spelled.href, (f.where as { url: string }).url].map(readPostgresSourceLocation),
        );
        denied(() => assertTenantSourcesApart(own, [alias]));
        assertTenantSourcesApart(own, [other]);
        await assert.rejects(
          f.enroll({ platformSources: [{ id: 'applicants', connection: 'applicants-db', url: f.own.url }] }),
          TenantContextError,
        );
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'tablewalk-platform-alias-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        symlinkSync(f.own.existingPath, join(dir, 'link.db'));
        linkSync(f.own.existingPath, join(dir, 'hard.db'));
        for (const existingPath of [f.own.existingPath, join(dir, 'link.db'), join(dir, 'hard.db'), `${f.own.existingPath}-wal`]) {
          await assert.rejects(
            f.enroll({ platformSources: [{ id: 'applicants', connection: 'applicants-db', existingPath }] }),
            TenantContextError,
            existingPath,
          );
        }
      }
      // Absent, or another connection's, or named twice: exactly the App's own.
      await assert.rejects(f.enroll({ platformSources: [] }), TenantContextError);
      await assert.rejects(f.enroll({ platformSources: [{ id: 'applicants', connection: 'other-db', ...f.where }] }), TenantContextError);
      await assert.rejects(
        f.enroll({
          platformSources: [
            { id: 'applicants', connection: 'applicants-db', ...f.where },
            { id: 'applicants', connection: 'applicants-db', ...f.where },
          ],
        }),
        TenantContextError,
      );
      // No command looks it up, or names it as its source.
      await f.engine.migrateCommandJournal();
      const output = { parse: (value: unknown) => value as Record<string, unknown> };
      const withResults = (ids: string[]) => policy({ resultReferences: Object.fromEntries(ids.map((id) => [id, () => []])) });
      const looking = defineCommands({
        peek: defineCommand({
          targets: 'none',
          realm: 'platform',
          source: 'business',
          target: 'lead',
          read: ['dealer'],
          sources: { applicants: ['applicant'] },
          input: {},
          output,
          async lookup() {
            return {};
          },
          async handle() {
            return {};
          },
        }),
      });
      await assert.rejects(f.enroll({ registry: looking, policy: withResults(['peek']) }), TenantContextError);
      const naming = defineCommands({
        file: defineCommand({
          targets: 'none',
          realm: 'platform',
          source: 'applicants',
          target: 'applicant',
          read: ['applicant'],
          input: {},
          output,
          async handle() {
            return {};
          },
        }),
      });
      await assert.rejects(f.enroll({ registry: naming, policy: withResults(['file']) }), TenantContextError);
    });

    /* Both features at once, which is where each was proved alone and the pair
     was not: an App with a platform-only source AND a platform command. The
     policy names the other source's tables because the platform realm's
     startup check requires it to; the command runs on this source, so those
     entries are not its transaction's business and are left out of its scope
     rather than refusing the whole composition. */
    test('a platform command runs while the policy also names the platform-only source, which it still cannot read', async (t) => {
      const f = await fixture(t, dialect);
      await f.engine.migrateCommandJournal();
      const output = { parse: (value: unknown) => value as Record<string, unknown> };
      const command = (id: string) => ({ id, version: 1, target: 'lead', input: {}, realm: 'platform' });
      const grant = (m: Manifest) => {
        m.resources.lead = {
          ...m.resources.lead,
          access: 'write',
          actions: { rename: { label: 'Rename', command: command('rename') }, peek: { label: 'Peek', command: command('peek') } },
        };
        m.auth.roles.manager.commands = ['rename', 'peek'];
      };
      const registry = defineCommands({
        rename: defineCommand({
          realm: 'platform',
          source: 'business',
          target: 'lead',
          read: ['dealer'],
          input: {},
          output,
          async handle({ db, record }) {
            await db.lead.update(record, { name: 'Renamed' });
            return { renamed: String(record.id) };
          },
        }),
        // The same realm, the same policy, and a reach into the other source.
        peek: defineCommand({
          realm: 'platform',
          source: 'business',
          target: 'lead',
          read: ['dealer'],
          input: {},
          output,
          async handle({ tx }) {
            const rows = await tx.query({ table: 'applicants.applicant', columns: ['id'], limit: 1, offset: 0 });
            return { reached: rows.rows.length };
          },
        }),
      });
      const references = { rename: () => [], peek: () => [] };
      const { service } = await f.enroll({ registry, policy: policy({ resultReferences: references }), alter: grant });
      const applied = await service.deployment.executePlatform(as('lee'), {
        command: 'rename',
        commandVersion: 1,
        key: { id: 'n1' },
        expectedVersion: 0,
        idempotencyKey: 'platform_source_rename_01',
        input: {},
      });
      assert.equal(applied.status, 'applied');
      assert.deepEqual(await f.engine.all('SELECT id, name FROM lead ORDER BY id'), [
        { id: 'n1', name: 'Renamed' },
        { id: 's1', name: 'South lead' },
      ]);
      // Named by the policy, and still not a command's to read: the scope the
      // command runs under is this source's, and the other source is not in it.
      await assert.rejects(
        service.deployment.executePlatform(as('lee'), {
          command: 'peek',
          commandVersion: 1,
          key: { id: 'n1' },
          expectedVersion: 1,
          idempotencyKey: 'platform_source_peek_0001',
          input: {},
        }),
        (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'forbidden',
      );

      /* What the narrowing does not do: a name no source of this App holds is
       still refused, so a typed table name cannot quietly become a no-op. */
      const { service: second } = await f.enroll({
        registry,
        alter: grant,
        policy: policy({ resultReferences: references, resolvePlatformRows: () => ({ ...platformRows(), nosuch_table: true }) }),
      });
      await assert.rejects(
        second.deployment.executePlatform(as('lee'), {
          command: 'rename',
          commandVersion: 1,
          key: { id: 's1' },
          expectedVersion: 0,
          idempotencyKey: 'platform_source_rename_02',
          input: {},
        }),
        (error: unknown) => error instanceof BusinessCommandExecutionError,
      );
      assert.deepEqual(await f.engine.all("SELECT id, name FROM lead WHERE id = 's1'"), [{ id: 's1', name: 'South lead' }]);
    });

    /* ---------- startup, as the CLI runs it ---------- */

    async function startup(t: TestContext) {
      const f = await fixture(t, dialect);
      const dir = mkdtempSync(join(tmpdir(), 'tablewalk-platform-startup-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      // The policy as it stands without --commands, and with one extractor for the command the refusals load.
      const written = (results: string) => `export default { kind: 'tenant', appId: 'lending', storeId: 'lending-store',
  ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ lead: true }), resolveRows: () => ({ lead: true }),
  resolvePlatformRows: () => ({ dealer: true, lead: true, 'applicants.applicant': true })${results} };`;
      const policyFile = join(dir, 'policy.mjs');
      writeFileSync(policyFile, written(''));
      writeFileSync(join(dir, 'policy-commands.mjs'), written(', resultReferences: { peek: () => [] }'));
      const url = (where: { existingPath?: string; url?: string }) => where.url ?? where.existingPath!;
      const connections = (patch: { writable?: boolean; business?: string; platform?: string } = {}): ConnectionConfig[] => [
        {
          id: 'business-db',
          name: 'Business',
          url: patch.business ?? url(f.own),
          source: 'config',
          ...(patch.business === undefined ? {} : {}),
        },
        {
          id: 'applicants-db',
          name: 'Applicants',
          url: patch.platform ?? url(f.where),
          source: 'config',
          ...(patch.writable ? { writable: true } : {}),
        },
      ];
      const loaded = (patch: (m: Manifest) => void = () => {}): LoadedApp => {
        const m = altered((raw) => {
          raw.auth.store = './auth.db';
          patch(raw);
        });
        const path = join(dir, 'app.json');
        writeFileSync(path, JSON.stringify(m));
        return { path, app: parseAppConfig(m, path), pages: [], sources: {} };
      };
      const commands = (body: string) => {
        const file = join(dir, `commands-${randomUUID()}.mjs`);
        writeFileSync(
          file,
          `import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
const output = { parse: value => value };
export default defineCommands({ ${body} });`,
        );
        return file;
      };
      const refuses = (options: Parameters<typeof prepareTenantStartup>[0], message: RegExp) =>
        assert.rejects(prepareTenantStartup(options), (error) => {
          assert.ok(error instanceof TenantStartupError);
          assert.match(error.message, message);
          assert.doesNotMatch(error.message, /PRIVATE_|tablewalk-platform|postgres(ql)?:\/\//);
          return true;
        });
      return { f, dir, policyFile, connections, loaded, commands, refuses };
    }

    test("startup: one connection for the App's own source and one per platform-only source, read only, its declared tables present", async (t) => {
      const s = await startup(t);
      const prepared = await prepareTenantStartup({ loaded: s.loaded(), connections: s.connections(), policyFile: s.policyFile });
      assert.deepEqual(
        prepared.enrollment.platformSources?.map((entry) => ({ ...entry })),
        [
          {
            id: 'applicants',
            connection: 'applicants-db',
            ...('url' in s.f.where ? { url: s.f.where.url } : { existingPath: realpathSync(s.f.where.existingPath) }),
          },
        ],
      );
      const shape = /one matching, row-readable connection for the App's own source, one for each platform-only source, and no other/;
      await s.refuses({ loaded: s.loaded(), connections: s.connections().slice(0, 1), policyFile: s.policyFile }, shape);
      await s.refuses(
        {
          loaded: s.loaded(),
          connections: [...s.connections(), { id: 'spare-db', name: 'Spare', url: 'postgres://spare.invalid/x', source: 'config' }],
          policyFile: s.policyFile,
        },
        shape,
      );
      await s.refuses(
        { loaded: s.loaded(), connections: s.connections({ writable: true }), policyFile: s.policyFile },
        /A platform-only source is read only: its connection must not say writable: true\./,
      );
      await s.refuses(
        {
          loaded: s.loaded((m) => {
            m.resources['applicants.missing'] = { owner: 'platform' };
          }),
          connections: s.connections(),
          policyFile: s.policyFile,
        },
        /could not validate the platform-only sources/,
      );
    });

    test("startup: never the App's own database or the authentication store, and no command reaches it", async (t) => {
      const s = await startup(t);
      const own = 'url' in s.f.own ? s.f.own.url : s.f.own.existingPath,
        platform = 'url' in s.f.where ? s.f.where.url : s.f.where.existingPath;
      await s.refuses(
        { loaded: s.loaded(), connections: s.connections({ platform: own }), policyFile: s.policyFile },
        /could not validate the platform-only sources, apart from the App's own database and the authentication store/,
      );
      await s.refuses(
        {
          loaded: s.loaded((m) => {
            m.auth.store = platform;
          }),
          connections: s.connections(),
          policyFile: s.policyFile,
        },
        /could not validate the platform-only sources, apart from the App's own database and the authentication store/,
      );
      const writable = (): ConnectionConfig[] =>
        s.connections().map((connection) => (connection.id === 'business-db' ? { ...connection, writable: true } : connection));
      await s.f.engine.migrateCommandJournal();
      await s.refuses(
        {
          loaded: s.loaded(),
          connections: writable(),
          policyFile: join(s.dir, 'policy-commands.mjs'),
          commandsFile:
            s.commands(`peek: defineCommand({ targets: 'none', realm: 'platform', source: 'business', target: 'lead', read: ['dealer'],
        sources: { applicants: ['applicant'] }, input: {}, output, lookup() { return {}; }, handle() { throw new Error('PRIVATE_HANDLER'); } })`),
        },
        /Command "peek" looks up the platform-only source "applicants"\. A platform-only source is read by the platform realm's own reads alone/,
      );
      await s.refuses(
        {
          loaded: s.loaded(),
          connections: writable(),
          policyFile: join(s.dir, 'policy-commands.mjs'),
          commandsFile:
            s.commands(`peek: defineCommand({ targets: 'none', realm: 'platform', source: 'applicants', target: 'applicant', read: ['applicant'],
        input: {}, output, handle() { throw new Error('PRIVATE_HANDLER'); } })`),
        },
        /Command "peek" names the platform-only source "applicants" as its source/,
      );
    });
  });
