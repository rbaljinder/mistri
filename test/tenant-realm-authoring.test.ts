/**
 * Authoring a two-realm tenant App, on both engines.
 *
 * A lender above its dealers is two authored surfaces over two catalogs, and
 * the checks used to judge both by the tenant's: a platform view over the
 * platform's own table found "no table", and one that shows whose row it is
 * found no `tenant_id` column. A correct App could not pass `mistri check`, so
 * the lender's half could not be authored at all.
 *
 * Here the App is whole — tenant views, a platform view with its `show` and a
 * platform nav group — and every declaration is judged in the realm it names.
 * The tenant realm's half is judged exactly as before: naming the platform's
 * table is still refused when the App loads, and naming the managed ownership
 * column is still refused by the catalog a tenant reads.
 *
 * The schema is the one a two-realm App actually needs, which SQLite refused
 * to serve: the ownership column carries two references — its own to the
 * tenancy profile, and its part in the composite key to another tenant-owned
 * row — so both engines must describe it, and agree.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test, type TestContext } from 'node:test';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { physicalBindings, type AppDef } from '../packages/mistri/src/shared/app.js';
import { appForRealm, appRealms, type AppRealms } from '../packages/mistri/src/shared/appTenancy.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { appProblems, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { tenantAuthoringProblems } from '../packages/mistri/src/server/tenant/tenantAuthoring.js';
import { TenantContextError, refusalCause } from '../packages/engine/src/server/evidence.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { projectTenantMetadata } from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { tenantAuthoringSchema } from '../packages/mistri/src/server/tenant/tenantVisibleFields.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  TENANT_DIALECTS,
  type TenantDialect,
  type TenantEngine,
} from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-tenants' };

/* The ownership column in both kinds of key: `vehicle` is tenant-owned with a
   composite key that opens with it, and `lead` reaches one by (tenant_id,
   vehicle_id) while its own tenant_id points at the dealer it belongs to. */
const SCHEMA = {
  tables: ['review_file', 'lead', 'vehicle', 'vehicle_model', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE vehicle_model (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE vehicle (tenant_id TEXT NOT NULL REFERENCES dealer(id), id TEXT NOT NULL,
      model_id TEXT REFERENCES vehicle_model(id), PRIMARY KEY (tenant_id, id));
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id),
      vehicle_id TEXT, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicle(tenant_id, id));
    CREATE TABLE review_file (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES lead(id), note TEXT);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.vehicle_model (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.vehicle (tenant_id text NOT NULL REFERENCES public.dealer(id), id text NOT NULL,
      model_id text REFERENCES public.vehicle_model(id), PRIMARY KEY (tenant_id, id));
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id),
      vehicle_id text, name text NOT NULL, version integer NOT NULL DEFAULT 0,
      FOREIGN KEY (tenant_id, vehicle_id) REFERENCES public.vehicle(tenant_id, id));
    CREATE TABLE public.review_file (id text PRIMARY KEY, lead_id text NOT NULL REFERENCES public.lead(id), note text);`,
};
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO vehicle_model VALUES ('m1', 'Sedan');
    INSERT INTO vehicle VALUES ('north', 'v1', 'm1');
    INSERT INTO lead (id, tenant_id, vehicle_id, name) VALUES ('n1', 'north', 'v1', 'North lead');
    INSERT INTO review_file VALUES ('r1', 'n1', 'Lender only');`;

/** The whole two-realm App: a dealer's rooms, and the lender's above them. */
const manifest = () => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    review_file: { owner: 'platform' },
    /* The lender's assignment, on the dealer's own row: a platform-realm
       command whose target is a tenant-owned resource, and whose reviewer
       comes from the platform's own table. */
    lead: {
      access: 'write',
      owner: 'tenant',
      actions: {
        assignReviewer: {
          label: 'Assign reviewer',
          command: {
            id: 'assign',
            version: 1,
            target: 'lead',
            realm: 'platform',
            input: { reviewer: { type: 'reference', from: 'dealer', by: 'id', labelColumn: 'name' } },
          },
        },
      },
    },
    vehicle: { owner: 'tenant' },
    vehicle_model: { owner: 'global' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: true, write: ['lead'] }, manager: { realm: 'platform', read: true, commands: ['assign'] } },
  },
  views: {
    leads: { kind: 'list', from: 'lead', show: ['id', 'name'] },
    stock: { kind: 'list', from: 'vehicle', show: ['tenant_id', 'id'] },
    // The lender's own: every dealer's leads, saying whose each row is, and the dealers themselves.
    portfolio: { kind: 'list', from: 'lead', realm: 'platform', show: ['id', 'tenant_id', 'name'] },
    dealers: { kind: 'list', from: 'dealer', realm: 'platform', show: ['id', 'name'] },
    files: { kind: 'list', from: 'review_file', realm: 'platform', show: ['id', 'note'] },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads', 'stock'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['portfolio', 'dealers', 'files'] },
  ],
  home: 'leads',
});
type Manifest = ReturnType<typeof manifest>;
const app = (alter?: (raw: Manifest) => void): AppDef => {
  const raw = manifest();
  alter?.(raw);
  return parseTestApp(raw, 'lending.ts');
};
const loadedFrom = (value: AppDef): LoadedApp => ({ path: 'lending.ts', app: value, pages: [], sources: {} });
/** The problems themselves, for a message assertion; the realm is checked apart. */
const said = (problems: readonly { readonly realm: string; readonly problem: string }[]): string[] =>
  problems.map((entry) => entry.problem);
/** The App without the lender's action or the grant that names its command:
 * enrollment checks both against the registry, and a deployment that starts is
 * not what the action is here to prove — the authoring checks above are. */
const withoutActions = (): AppDef =>
  app((raw) => {
    delete (raw.resources.lead as { actions?: unknown }).actions;
    delete (raw.auth.roles.manager as { commands?: unknown }).commands;
  });
/** The lender's assignment with its realm dropped: the same action, now the tenant's. */
const withoutActionRealm = (): AppDef =>
  app((raw) => {
    const action = raw.resources.lead.actions.assignReviewer;
    raw.resources.lead.actions = {
      assignReviewer: {
        label: action.label,
        command: { id: action.command.id, version: action.command.version, target: action.command.target, input: action.command.input },
      },
    } as never;
  });

const ownership = {
  dealer: { kind: 'platform' as const },
  review_file: { kind: 'platform' as const },
  lead: { kind: 'tenant' as const, column: 'tenant_id' },
  vehicle: { kind: 'tenant' as const, column: 'tenant_id' },
  vehicle_model: { kind: 'global' as const, access: 'read-only' as const },
};
const policy = () =>
  defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership,
    resolveMembershipRows: () => ({ lead: true, vehicle: true, vehicle_model: true }),
    resolveRows: () => ({ lead: true, vehicle: true, vehicle_model: true }),
    resolvePlatformRows: () => ({ dealer: true, review_file: true, lead: true, vehicle: true }),
  });

/** The App's own catalog, attested from a real SQLite read of this schema. */
function owned(t: TestContext, definition: AppDef = app()): TenantOwnershipSnapshot {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SCHEMA.sqlite.replace('PRAGMA journal_mode=WAL;', ''));
  db.exec('BEGIN IMMEDIATE');
  const physical = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  return ownedFrom(physical, definition);
}
function ownedFrom(physical: DatabaseSchema, definition: AppDef): TenantOwnershipSnapshot {
  const catalog = appResourceCatalog(physical, physicalBindings(definition, 'business'));
  return captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema: physical,
    schema: catalog.schema,
    resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
    ownership,
    profile: 'dealer',
  });
}

/* ---------- the realms the authoring check reads ---------- */

test('every declaration belongs to the realm that names it, or to the menu that places it', () => {
  const realms: AppRealms = appRealms(app());
  assert.equal(realms.platform, true);
  assert.deepEqual([realms.view('leads'), realms.view('stock')], ['tenant', 'tenant']);
  assert.deepEqual([realms.view('portfolio'), realms.view('dealers')], ['platform', 'platform']);
  // A resource's realm is whose rows it holds: that is which catalog its table is in.
  assert.deepEqual([realms.resource('lead'), realms.resource('vehicle_model')], ['tenant', 'tenant']);
  assert.deepEqual([realms.resource('dealer'), realms.resource('review_file')], ['platform', 'platform']);
  // Without the platform realm there is one realm, and the projection is the App.
  /* Without the platform realm nothing may say one: no platform owner, so no
     profile either, and the tenancy is just what a tenant is called. */
  const single = appRealms(
    app((raw) => {
      raw.auth.tenancy = { label: 'Dealer' } as never;
      raw.auth.roles = { staff: { read: true, write: ['lead'] } } as never;
      raw.resources.dealer.owner = 'tenant';
      raw.resources.review_file.owner = 'tenant';
      // Nothing may say a realm without one, the lender's action included.
      delete (raw.resources.lead as { actions?: unknown }).actions;
      raw.views = { leads: raw.views.leads } as never;
      raw.nav = ['leads'] as never;
    }),
  );
  assert.equal(single.platform, false);
});

test('each realm is projected to its own declarations, and the tenant half is the App it always was', () => {
  const whole = app();
  const tenant = appForRealm(whole, [], 'tenant'),
    platform = appForRealm(whole, [], 'platform');
  assert.deepEqual(Object.keys(tenant.app.views).sort(), ['leads', 'stock']);
  assert.deepEqual(Object.keys(platform.app.views).sort(), ['dealers', 'files', 'portfolio']);
  assert.deepEqual(Object.keys(tenant.app.resources!).sort(), ['lead', 'vehicle', 'vehicle_model']);
  /* The platform's own blocks, and the tenant's `lead` for the one action the
     lender runs on it: its binding and that action, and none of the
     declarations that are judged where its rows live. */
  assert.deepEqual(Object.keys(platform.app.resources!).sort(), ['dealer', 'lead', 'review_file']);
  assert.deepEqual(
    platform.app.resources!.lead.actions!.map((action) => action.label),
    ['Assign reviewer'],
  );
  assert.equal(platform.app.resources!.lead.form, undefined);
  assert.equal(platform.app.resources!.lead.fields, undefined);
  // The dealer's own half keeps the block and loses the lender's action.
  assert.deepEqual(tenant.app.resources!.lead.actions, []);
  assert.equal(tenant.app.resources!.lead.access, 'write');
  assert.deepEqual(
    tenant.app.nav.map((node) => ('group' in node ? node.group : 'view' in node ? node.view : undefined)),
    ['dealership'],
  );
  assert.deepEqual(
    platform.app.nav.map((node) => ('group' in node ? node.group : 'view' in node ? node.view : undefined)),
    ['lender'],
  );
  assert.deepEqual(
    tenant.app.home.map((rule) => rule.view),
    ['leads'],
  );
  assert.deepEqual(platform.app.home, []);
  // The projection reads the App; it never rewrites it.
  assert.deepEqual(Object.keys(whole.views).sort(), ['dealers', 'files', 'leads', 'portfolio', 'stock']);
});

test('realm authoring narrows resource grants only after validating the whole authority', () => {
  const whole = app();
  whole.auth!.roles!.manager.read = ['lead', 'review_file'];
  whole.auth!.roles!.manager.fields = { review_file: { read: ['id'], write: [] } };
  const tenant = appForRealm(whole, [], 'tenant').app;
  assert.deepEqual(tenant.auth!.roles!.manager.read, ['lead']);
  assert.deepEqual(tenant.auth!.roles!.manager.fields, {});
  assert.deepEqual(tenant.auth!.roles!.manager.commands, ['assign'], "shared machine graphs retain the other realm's command grants");
  assert.deepEqual(whole.auth!.roles!.manager.read, ['lead', 'review_file'], 'runtime authority is unchanged');
  whole.auth!.roles!.manager.read = ['lead', 'not_a_resource'];
  assert.throws(() => appForRealm(whole, [], 'tenant'), /not_a_resource.*outside its access ceiling/);
});

test('the whole two-realm App checks, platform view and nav included', (t) => {
  const definition = app(),
    snapshot = owned(t, definition);
  assert.deepEqual(tenantAuthoringProblems(loadedFrom(definition), snapshot), []);
  /* What the gap was: judged by the tenant's catalog alone, the lender's half
     is a pile of missing tables and a missing ownership column. */
  const single = appProblems(loadedFrom(definition), tenantAuthoringSchema(snapshot));
  assert.ok(single.length >= 3, single.join('; '));
  assert.ok(
    single.some((problem) => problem.includes('no table "dealer"')),
    single.join('; '),
  );
  assert.ok(
    single.some((problem) => problem.includes('tenant_id')),
    single.join('; '),
  );
});

test('record labels are authoring declarations in their owning realm, while a served restricted catalog may redact them', (t) => {
  const named = app((raw) => {
    (raw.resources.lead as { recordLabel?: string }).recordLabel = 'name';
  });
  const namedOwnership = owned(t, named);
  assert.deepEqual(tenantAuthoringProblems(loadedFrom(named), namedOwnership), []);
  const deniedCatalog = structuredClone(tenantAuthoringSchema(namedOwnership));
  deniedCatalog.tables.find((table) => table.id === 'lead')!.columns = deniedCatalog.tables
    .find((table) => table.id === 'lead')!
    .columns.filter((column) => column.name !== 'name');
  assert.equal(
    projectTenantMetadata(named, [], deniedCatalog).app.resources.lead.recordLabel,
    false,
    'a served field-denied catalog retains the opaque sentinel',
  );

  const misspelled = app((raw) => {
    (raw.resources.lead as { recordLabel?: string }).recordLabel = 'nmae';
  });
  const missing = tenantAuthoringProblems(loadedFrom(misspelled), owned(t, misspelled));
  assert.deepEqual([...new Set(missing.map((entry) => entry.realm))], ['tenant']);
  assert.ok(
    said(missing).some((problem) => problem.includes('recordLabel') && problem.includes('nmae')),
    said(missing).join('; '),
  );

  const managed = app((raw) => {
    (raw.resources.lead as { recordLabel?: string }).recordLabel = 'tenant_id';
  });
  const hidden = tenantAuthoringProblems(loadedFrom(managed), owned(t, managed));
  assert.deepEqual([...new Set(hidden.map((entry) => entry.realm))], ['tenant']);
  assert.ok(
    said(hidden).some((problem) => problem.includes('recordLabel') && problem.includes('tenant_id')),
    said(hidden).join('; '),
  );
});

test('a tenant-realm declaration still cannot reach the platform realm, in the same words', (t) => {
  /* The App does not even load: this is the refusal a tenant view over a
     platform table has always had. `leads` is in the dealership group, so the
     menu places it in the tenant realm whatever it says itself. */
  assert.throws(
    () =>
      app((raw) => {
        raw.views.leads.from = 'dealer';
      }),
    /views "leads" is in the tenant realm and reads "dealer", a platform-owned resource/,
  );
  // And the ownership column stays managed for a tenant's own rooms.
  const showing = app((raw) => {
    raw.views.leads.show = ['id', 'tenant_id', 'name'];
  });
  const problems = said(tenantAuthoringProblems(loadedFrom(showing), owned(t, showing)));
  assert.ok(
    problems.some((problem) => problem.includes('show') && problem.includes('tenant_id')),
    problems.join('; '),
  );
});

test("an action is judged in its command's realm, so a platform command may name the platform's own tables", (t) => {
  /* The lender assigns a reviewer on a dealer's row: the target is tenant-owned
     and the picker reads the platform's table. Judged in the tenant catalog
     that reference cannot resolve, which is what forced a typed field. */
  const definition = app();
  assert.deepEqual(tenantAuthoringProblems(loadedFrom(definition), owned(t, definition)), []);
  // Each problem says which realm found it, so an author knows which surface to fix.
  const broken = app((raw) => {
    raw.resources.lead.actions.assignReviewer.command.input = {
      reviewer: { type: 'reference', from: 'dealer', by: 'id', labelColumn: 'missing_column' },
    } as never;
  });
  const named = tenantAuthoringProblems(loadedFrom(broken), owned(t, broken));
  assert.deepEqual([...new Set(named.map((entry) => entry.realm))], ['platform']);
  assert.ok(
    said(named).some((problem) => problem.includes('reviewer')),
    said(named).join('; '),
  );
  // The same action in the tenant realm has no platform catalog to resolve in.
  const tenantRealm = withoutActionRealm();
  const problems = said(tenantAuthoringProblems(loadedFrom(tenantRealm), owned(t, tenantRealm)));
  assert.ok(
    problems.some((problem) => problem.includes('assignReviewer') && problem.includes('reviewer')),
    problems.join('; '),
  );
});

test("an API token is one tenant membership's, so it is judged in the tenant realm only", (t) => {
  const definition = app();
  assert.deepEqual(tenantAuthoringProblems(loadedFrom(definition), owned(t, definition), { only: 'tenant' }), []);
  // A tenant-realm mistake is still a mistake there.
  const broken = app((raw) => {
    raw.views.leads.show = ['id', 'missing_column'];
  });
  assert.ok(tenantAuthoringProblems(loadedFrom(broken), owned(t, broken), { only: 'tenant' }).length > 0);
});

/* ---------- both engines: the schema, and a deployment that starts ---------- */

/* This suite's own PostgreSQL database, named for this run and dropped with it. */
const DATABASE = `realm_authoring_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a two-realm App on ${dialect}`, { skip }, () => {
    async function fixture(t: TestContext) {
      const engine: TenantEngine = await openTenantEngine(dialect as TenantDialect, {
        tables: SCHEMA.tables,
        sqlite: SCHEMA.sqlite + ROWS,
        postgres: SCHEMA.postgres + ROWS,
        database: DATABASE,
      });
      const owners: Array<{ retire(): Promise<void> }> = [];
      t.after(async () => {
        try {
          await Promise.allSettled(owners.map((owner) => owner.retire()));
        } finally {
          await engine.close();
        }
      });
      await engine.provisionStore(binding);
      const grant = { status: 'active' as const, validUntil: 10_000, expectedVersion: null };
      await engine.maintenance(binding, async (admin) => {
        await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
        await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
        await admin.putPlatform({ status: 'active', expectedVersion: null });
        await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['manager'] });
      });
      return { engine, owners };
    }

    test('the ownership column carries both of its references, and the catalog serves them', async (t) => {
      const f = await fixture(t),
        physical = await f.engine.physicalSchema();
      const lead = physical.tables.find((table) => table.id === f.engine.id('lead'))!;
      const tenantColumn = lead.columns.find((column) => column.name === 'tenant_id')!;
      // Its own reference is the tenancy profile's, which the framework requires.
      assert.deepEqual(tenantColumn.references, { table: f.engine.id('dealer'), column: 'id' });
      // And its part in the composite key to another tenant-owned row is still an edge.
      const edges = physical.foreignKeys.filter((fk) => fk.from.table === f.engine.id('lead'));
      assert.deepEqual(edges.map((fk) => fk.to.table).sort(), [f.engine.id('dealer'), f.engine.id('vehicle')].sort());
      assert.ok(
        edges.some((fk) => fk.from.columns.length === 2 && fk.from.columns.includes('tenant_id')),
        'the composite tenant key',
      );
    });

    test('the App checks and the deployment starts', async (t) => {
      const f = await fixture(t),
        definition = app();
      const snapshot = ownedFrom(await f.engine.physicalSchema(), definition);
      assert.deepEqual(tenantAuthoringProblems(loadedFrom(definition), snapshot), []);
      /* The lender's assignment on a dealer's row, with its reviewer read from the
       platform's own table, checks on this engine — and the same action in the
       tenant realm is refused on it, where that table is not a resource. */
      const tenantRealm = withoutActionRealm();
      const refused = tenantAuthoringProblems(loadedFrom(tenantRealm), ownedFrom(await f.engine.physicalSchema(), tenantRealm));
      assert.ok(
        said(refused).some((problem) => problem.includes('assignReviewer')),
        said(refused).join('; '),
      );
      const service = await createTenantEnrollment({
        app: withoutActions(),
        policy: policy(),
        source: { ...binding.source, ...(dialect === 'postgres' ? { url: f.engine.url } : { existingPath: f.engine.path }) },
        deployment: 'generation',
        roles: ['staff', 'manager'],
        maxLifetimeMs: 1000,
        now: () => 100,
        pages: [],
        verifySession: async () => null,
      });
      f.owners.push(service);
      assert.equal(typeof service.retire, 'function');
    });

    test('a refusal stays one opaque sentence to a caller, and still tells the trusted owner why', async (t) => {
      const f = await fixture(t);
      /* A store this deployment was never provisioned for: the store refuses, and
       the reason must reach a startup that has to name it — without travelling
       on the error a caller inspects. */
      await assert.rejects(
        createTenantEnrollment({
          app: app(),
          policy: defineAppTenantPolicy({ ...policy(), storeId: 'not-this-deployments-store' }),
          source: { ...binding.source, ...(dialect === 'postgres' ? { url: f.engine.url } : { existingPath: f.engine.path }) },
          deployment: 'generation',
          roles: ['staff', 'manager'],
          maxLifetimeMs: 1000,
          now: () => 100,
          pages: [],
          verifySession: async () => null,
        }),
        (error) => {
          assert.ok(error instanceof TenantContextError);
          assert.equal('cause' in error, false, 'no cause travels with the refusal a caller sees');
          assert.notEqual(refusalCause(error), undefined, 'the trusted owner can still say why');
          return true;
        },
      );
    });
  });
