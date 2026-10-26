import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig, type PageDef } from '../packages/engine/src/shared/page.js';
import type { TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { AppTenantPolicyDefinitionError, defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  BusinessCommandDefinitionError,
  CommandLookupRefusal,
  defineCommand,
  defineCommands,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { assertGlobalLookups } from '../packages/mistri/src/server/commands/commandLookup.js';
import { projectPlatformCapabilities, projectTenantCapabilities } from '../packages/mistri/src/server/tenant/tenantCapabilities.js';
import { createTenantContexts } from '../packages/mistri/src/server/tenant/tenantContexts.js';
import { TenantContextError, TenantRequestFault } from '../packages/engine/src/server/evidence.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import {
  captureTenantOwnership,
  type ResourceOwnership,
  type TenantOwnershipInput,
} from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import type { PlatformReadContext } from '../packages/mistri/src/server/tenant/tenantPlatformReadRuntime.js';
import { composePlatformReadScope, composeTenantReadScope } from '../packages/mistri/src/server/tenant/tenantReadScope.js';
import { tenantVisibleFields } from '../packages/mistri/src/server/tenant/tenantVisibleFields.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  TENANT_DIALECTS,
  type TenantDialect,
  type TenantEngine,
} from './support/tenantDialects.js';
import { parseTestApp } from './support/commandCatalog.js';

/* The platform realm (T5). A lender's platform staff read every dealer's
   tenant rows and own platform rows; a dealer's tenant context never reads a
   platform row, by two independent layers: its row scope is false, and the
   table is not a visible resource. */

const source = { id: 'business', connection: 'owned-source' };
const member = (): TenantMembershipEvidence => ({
  appId: 'lending',
  accountId: 'alice',
  tenantId: 'north',
  source,
  deployment: 'generation-1',
  membershipId: 'north-alice',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['staff'],
  verifiedAt: 1000,
  validUntil: 6000,
});
const platform = (): PlatformMembershipEvidence => ({
  realm: 'platform',
  appId: 'lending',
  accountId: 'lee',
  source,
  deployment: 'generation-1',
  membershipId: 'platform-lee',
  membershipVersion: '1',
  platformVersion: '1',
  roles: ['manager'],
  verifiedAt: 1000,
  validUntil: 6000,
});
const OWNERSHIP: Record<string, ResourceOwnership> = {
  dealer: { kind: 'platform' },
  lead: { kind: 'tenant', column: 'tenant_id' },
  review_file: { kind: 'platform' },
  vehicle_model: { kind: 'global', access: 'read-only' },
};
const DEALER = 'CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);';
const MODEL = 'CREATE TABLE vehicle_model (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);';
const LEAD = `CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id),
  model_id TEXT REFERENCES vehicle_model(id), name TEXT NOT NULL);`;
const REVIEW = 'CREATE TABLE review_file (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES lead(id), note TEXT);';

function ownership(
  t: TestContext,
  patch: Partial<TenantOwnershipInput> = {},
  ddl = [DEALER, MODEL, LEAD, REVIEW].join('\n'),
): TenantOwnershipInput {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON; ${ddl}`);
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  const resources = Object.fromEntries(schema.tables.map((table) => [table.id, table.id]));
  return {
    appId: 'lending',
    source,
    schema,
    physicalSchema: structuredClone(schema),
    resources,
    ownership: OWNERSHIP,
    profile: 'dealer',
    ...patch,
  };
}
const denied = (work: () => unknown) => assert.throws(work, TenantContextError);

test('ownership: the profile is the one platform table a tenant row may reference, and only by its ownership column', (t) => {
  const captured = captureTenantOwnership(ownership(t));
  assert.equal(captured.profile, 'dealer');
  assert.deepEqual({ ...captured.ownership.review_file }, { kind: 'platform' });
  // Without a profile the tenant → platform key has nothing to stand on.
  denied(() => captureTenantOwnership(ownership(t, { profile: undefined })));
  // The profile is platform-owned, and exists.
  denied(() => captureTenantOwnership(ownership(t, { profile: 'lead' })));
  denied(() => captureTenantOwnership(ownership(t, { profile: 'missing' })));
  // A platform rule carries its kind and nothing else.
  denied(() =>
    captureTenantOwnership(ownership(t, { ownership: { ...OWNERSHIP, review_file: { kind: 'platform', column: 'lead_id' } as never } })),
  );
});

test('ownership: a tenant row reaches no other platform key, and a global row reaches no platform row', (t) => {
  const note = `CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, review_id TEXT REFERENCES review_file(id));`;
  denied(() =>
    captureTenantOwnership(
      ownership(
        t,
        { ownership: { ...OWNERSHIP, note: { kind: 'tenant', column: 'tenant_id' } } },
        [DEALER, MODEL, LEAD, REVIEW, note].join('\n'),
      ),
    ),
  );
  const madeBy = 'CREATE TABLE vehicle_model (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, dealer_id TEXT REFERENCES dealer(id));';
  denied(() => captureTenantOwnership(ownership(t, {}, [DEALER, madeBy, LEAD, REVIEW].join('\n'))));
  // A platform row may reference a tenant row: review_file → lead above is accepted.
});

test('a tenant context reads no platform table, whatever either policy layer grants', (t) => {
  const owned = ownership(t);
  const all = { dealer: true, lead: true, review_file: true, vehicle_model: true };
  const scope = composeTenantReadScope(owned, member(), all, all);
  assert.equal(scope.dealer, false);
  assert.equal(scope.review_file, false);
  assert.equal(scope.vehicle_model, true);
  assert.deepEqual(JSON.parse(JSON.stringify(scope.lead)), {
    groups: [[{ column: 'tenant_id', op: '=', value: 'north' }]],
    binary: ['tenant_id'],
  });
  // Platform evidence has no tenant: the tenant composer refuses it.
  denied(() => composeTenantReadScope(owned, platform() as never, all, all));
});

test('the platform context reads across tenants under its own policy, and a table the policy does not name is denied', (t) => {
  const owned = ownership(t);
  const open = { groups: [[{ column: 'note', op: '=' as const, value: 'open' }]] };
  const scope = composePlatformReadScope(owned, platform(), { lead: true, dealer: true, review_file: open });
  assert.equal(scope.lead, true, "no tenant predicate: every dealer's leads");
  assert.equal(scope.dealer, true);
  assert.deepEqual(JSON.parse(JSON.stringify(scope.review_file)), open);
  assert.equal(scope.vehicle_model, false, 'unnamed, so denied, global or not');
  // Tenant evidence, or evidence for another App, never composes a platform scope.
  denied(() => composePlatformReadScope(owned, member() as never, { lead: true }));
  denied(() => composePlatformReadScope(owned, { ...platform(), appId: 'other' }, { lead: true }));
  denied(() => composePlatformReadScope(owned, { ...platform(), tenantId: 'north' } as never, { lead: true }));
});

test('visible fields: platform tables leave a tenant context; the platform context reads the owner column and writes only its own tables', (t) => {
  const owned = captureTenantOwnership(ownership(t));
  const everything = new Set(['dealer', 'lead', 'review_file', 'vehicle_model']);
  const tenant = tenantVisibleFields(owned, { readable: everything, writable: everything });
  assert.deepEqual([...tenant.readable].sort(), ['lead', 'vehicle_model']);
  assert.equal(tenant.writable.has('dealer') || tenant.writable.has('review_file'), false);
  assert.equal(tenant.fields!.has('dealer'), false);
  assert.equal(tenant.fields!.get('lead')!.read.has('tenant_id'), false);
  const lender = tenantVisibleFields(owned, { readable: everything, writable: everything }, 'platform');
  assert.deepEqual([...lender.readable].sort(), [...everything].sort());
  // Its own tables alone: a tenant's rows and global ones change through commands.
  assert.deepEqual([...lender.writable].sort(), ['dealer', 'review_file']);
  assert.equal(lender.fields!.get('lead')!.read.has('tenant_id'), true);
  assert.equal(lender.fields!.get('lead')!.write.size, 0);
  assert.equal(lender.fields!.get('vehicle_model')!.write.size, 0);
});

test('policy: a platform-owned table needs resolvePlatformRows, and the platform realm may exist without one', () => {
  const base = { kind: 'tenant' as const, appId: 'lending', storeId: 'store', resolveMembershipRows: () => ({}), resolveRows: () => ({}) };
  const lead = { kind: 'tenant' as const, column: 'tenant_id' };
  const policy = defineAppTenantPolicy({
    ...base,
    ownership: { lead, dealer: { kind: 'platform' } },
    resolvePlatformRows: () => ({ lead: true }),
  });
  assert.deepEqual({ ...policy.ownership.dealer }, { kind: 'platform' });
  assert.equal(typeof policy.resolvePlatformRows, 'function');
  assert.throws(
    () => defineAppTenantPolicy({ ...base, ownership: { lead, dealer: { kind: 'platform' } } }),
    AppTenantPolicyDefinitionError,
  );
  assert.throws(
    () =>
      defineAppTenantPolicy({
        ...base,
        ownership: { lead, dealer: { kind: 'platform', column: 'id' } as never },
        resolvePlatformRows: () => ({}),
      }),
    AppTenantPolicyDefinitionError,
  );
  assert.equal(
    typeof defineAppTenantPolicy({ ...base, ownership: { lead }, resolvePlatformRows: () => ({}) }).resolvePlatformRows,
    'function',
  );
  assert.throws(
    () => defineAppTenantPolicy({ ...base, ownership: { lead }, resolvePlatformRows: 'rows' as never }),
    AppTenantPolicyDefinitionError,
  );
  // Only platform tables: a tenant App still needs a tenant-owned table.
  assert.throws(
    () => defineAppTenantPolicy({ ...base, ownership: { dealer: { kind: 'platform' } }, resolvePlatformRows: () => ({}) }),
    AppTenantPolicyDefinitionError,
  );
});

/* ---------- the DSL: auth.tenancy, owner and realm ---------- */

type Manifest = Record<string, any>;
const lender = (): Manifest => ({
  id: 'lending',
  name: 'Lending',
  sources: { business: { connection: 'db' } },
  resources: {
    dealer: { owner: 'platform' },
    lead: { access: 'write', owner: 'tenant' },
    review_file: { owner: 'platform' },
    vehicle_model: { owner: 'global' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: true, write: ['lead'] }, manager: { realm: 'platform', read: true } },
  },
  views: {
    leads: { kind: 'list', from: 'lead' },
    dealers: { kind: 'list', from: 'dealer' },
    reviews: { kind: 'list', from: 'review_file' },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers', 'reviews'] },
  ],
  home: 'leads',
});
const refusedWith = (manifest: Manifest, expected: RegExp) => assert.throws(() => parseTestApp(manifest, 'lending.ts'), expected);

test('DSL: a lender App says who owns what, which realm each role and menu serves, and keeps it as written', (t) => {
  const app = parseTestApp(lender(), 'lending.ts');
  assert.deepEqual(app.auth?.tenancy, { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } });
  assert.equal(app.resources?.dealer.owner, 'platform');
  assert.equal(app.auth?.roles?.manager.realm, 'platform');
  assert.equal((app.nav[1] as { realm?: string }).realm, 'platform');
  // A tenant role's `read: true` is its realm's ceiling: no platform-owned table.
  const { schema } = ownership(t);
  assert.deepEqual([...resolveAppAccess(app, schema, ['staff']).readable].sort(), ['lead', 'vehicle_model']);
  // A platform role reads every table, across tenants, and writes none.
  const lenderAccess = resolveAppAccess(app, schema, ['manager']);
  assert.deepEqual([...lenderAccess.readable].sort(), ['dealer', 'lead', 'review_file', 'vehicle_model']);
  assert.equal(lenderAccess.writable.size, 0);
});

test('DSL: ownership, tenancy and roles are refused with what they need', () => {
  const without = (patch: (manifest: Manifest) => void) => {
    const manifest = lender();
    patch(manifest);
    return manifest;
  };
  refusedWith(
    without((m) => {
      delete m.resources.lead.owner;
    }),
    /resources "lead" has no "owner"/,
  );
  refusedWith(
    without((m) => {
      m.resources.vehicle_model.access = 'write';
    }),
    /"owner": "global", rows every tenant reads and none owns, so it takes no "access": it is read, never written/,
  );
  refusedWith(
    without((m) => {
      delete m.auth.tenancy.platform;
    }),
    /is "owner": "platform", which needs the platform realm: auth\.tenancy\.platform/,
  );
  refusedWith(
    without((m) => {
      m.auth.tenancy.profile = 'lead';
    }),
    /"profile" names "lead", which is not a platform-owned resource/,
  );
  refusedWith(
    without((m) => {
      delete m.auth.roles.staff.realm;
    }),
    /role "staff" has no "realm"/,
  );
  refusedWith(
    without((m) => {
      m.auth.roles.staff.read = ['lead', 'dealer'];
    }),
    /role "staff" is a tenant role and names "dealer", a platform-owned resource/,
  );
  refusedWith(
    without((m) => {
      m.auth.roles.manager.write = ['lead'];
    }),
    /role "manager" has "write" naming "lead", a tenant-owned resource\. A platform role edits only the platform's own rows/,
  );
});

test("DSL: every root menu node says its realm, a group's children keep it, and a tenant view never reads a platform table", () => {
  const without = (patch: (manifest: Manifest) => void) => {
    const manifest = lender();
    patch(manifest);
    return manifest;
  };
  refusedWith(
    without((m) => {
      delete m.nav[0].realm;
    }),
    /nav entry 1 \(dealership\) has no "realm"/,
  );
  refusedWith(
    without((m) => {
      m.views.dealers.realm = 'tenant';
    }),
    /the view "dealers" is "realm": "tenant" inside a "platform" group/,
  );
  refusedWith(
    without((m) => {
      m.nav = [
        { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads', 'dealers'] },
        { id: 'lender', label: 'Lender', realm: 'platform', children: ['reviews'] },
      ];
    }),
    /views "dealers" is in the tenant realm and reads "dealer", a platform-owned resource/,
  );
  refusedWith(
    without((m) => {
      m.pages = { dealer: { base: 'dealer' } };
    }),
    /pages "dealer" has the platform-owned base "dealer", so it says "realm": "platform"/,
  );
  refusedWith(
    without((m) => {
      m.home = [{ view: 'dealers', realm: 'tenant' }];
    }),
    /home rule 1 is "realm": "tenant" and opens the view "dealers", which is in the platform realm/,
  );
  // The platform realm's own page over its own table is fine.
  assert.equal(
    parseTestApp(
      without((m) => {
        m.pages = { dealer: { base: 'dealer', realm: 'platform' } };
      }),
      'lending.ts',
    ).name,
    'Lending',
  );
});

/* ---------- end to end: reads, switching, commands and HTTP ---------- */

/* The platform realm end to end, on SQLite and on live PostgreSQL
   (support/tenantDialects.ts): a lender's platform members read every
   dealer's rows and own platform rows; a dealer's tenant context never reads
   a platform row, even when both of its row-policy layers grant the table; one
   browser tab moves between the realms by switching; each realm is offered
   and runs its own commands only; and the platform realm writes through its
   commands, updating dealers' rows without ever placing, reassigning or
   removing one. */

/** A direct call's request, or the HTTP server's: both carry the fixture cookie. */
type Request = { readonly cookie?: string; readonly headers?: { readonly cookie?: string } };
const cookieOf = (request: Request) => request.cookie ?? request.headers?.cookie?.replace(/^fixture=/, '') ?? '';
const identities: Record<string, { id: string; who: string }> = {
  alice: { id: 'alice', who: 'Alice' },
  lee: { id: 'lee', who: 'Lee' },
  kim: { id: 'kim', who: 'Kim' },
  pat: { id: 'pat', who: 'Pat' },
};
const as = (cookie: string): Request => ({ cookie });
const instance = (request: Request) => {
  const identity = identities[cookieOf(request)];
  return identity ? { identity, sessionId: `session-${identity.id}`, expiresAt: 5000 } : null;
};
const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-store' };
const plain = (row: object) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
const page = (table: string) => ({ table, limit: 50, offset: 0 });
const rejected = (work: Promise<unknown>) => assert.rejects(work, TenantContextError);
const refused = (code?: string) => (error: unknown) =>
  error instanceof BusinessCommandExecutionError && (code === undefined || error.code === code);
const assertion = (reply: TenantContextReply) => ({ tabId: reply.tabId, expectedContext: reply.context, expectedRevision: reply.revision });
const one = (command: string, id: string, idempotencyKey: string) => ({
  command,
  commandVersion: 1,
  key: { id },
  expectedVersion: 0,
  idempotencyKey,
  input: {},
});
const many = (command: string, ids: readonly string[], idempotencyKey: string) => ({
  command,
  commandVersion: 1,
  keys: ids.map((id) => ({ id })),
  expectedVersions: ids.map(() => 0),
  idempotencyKey,
  input: {},
});
/** A count both engines answer as a number: PostgreSQL's own count is a bigint, which arrives as text. */
const counted = (table: string) => `SELECT CAST(count(*) AS INTEGER) AS n FROM "${table}"`;

let overreach: 'insert' | 'owner' | 'remove' = 'insert';
const output = { parse: (value: unknown) => value as Record<string, unknown> };
const registry = defineCommands({
  approve: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'lead',
    targets: 'many',
    read: ['dealer'],
    write: ['review_file'],
    input: {},
    output,
    async handle({ db, records }) {
      for (const lead of records) {
        await db.lead.update(lead, { status: 'approved' });
        await db.review_file.insert({ id: `review-${String(lead.id)}`, lead_id: lead.id, note: 'Approved' });
      }
      return { approved: records.length };
    },
  }),
  overreach: defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'lead',
    read: ['dealer'],
    input: {},
    output,
    // The raw transaction, on purpose: what the platform realm refuses whatever a handler asks of it.
    async handle({ record, tx }) {
      if (overreach === 'insert') await tx.insert({ table: 'lead', values: { id: 'n2', name: 'Planted' } });
      else if (overreach === 'owner') await tx.update({ table: 'lead', key: { id: String(record.id) }, values: { tenant_id: 'south' } });
      else await tx.remove({ table: 'lead', key: { id: String(record.id) } });
      return { done: true };
    },
  }),
  flag: defineCommand({
    source: 'business',
    target: 'lead',
    when: 'status = open',
    input: {},
    output,
    async handle({ db, record }) {
      await db.lead.update(record, { status: 'flagged' });
      return { flagged: true };
    },
  }),
});
const stampWith = (resource: string) =>
  defineCommand({
    realm: 'platform',
    source: 'business',
    target: 'lead',
    read: ['dealer'],
    sources: { business: [resource] },
    input: {},
    output,
    async lookup({ sources }) {
      const model = await sources.business.vehicle_model.get('m1');
      return { name: String(model.name) };
    },
    async handle({ db, record, lookup }) {
      const { name } = lookup as { name: string };
      await db.lead.update(record, { name });
      return { name };
    },
  });
const manifest = () => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    lead: {
      access: 'write',
      owner: 'tenant',
      actions: {
        approve: {
          label: 'Approve',
          bulk: true,
          command: { id: 'approve', version: 1, target: 'lead', input: {}, targets: 'many', realm: 'platform' },
        },
        overreach: { label: 'Overreach', command: { id: 'overreach', version: 1, target: 'lead', input: {}, realm: 'platform' } },
        stamp: { label: 'Stamp', command: { id: 'stamp', version: 1, target: 'lead', input: {}, realm: 'platform' } },
        flag: { label: 'Flag', command: { id: 'flag', version: 1, target: 'lead', input: {} } },
      },
    },
    review_file: { access: 'write', owner: 'platform' },
    vehicle_model: { owner: 'global' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true, commands: ['flag'] },
      manager: { realm: 'platform', read: true, commands: ['approve', 'overreach', 'stamp'] },
      // A platform member granted no command: offered none, runs none.
      auditor: { realm: 'platform', read: true },
    },
  },
  views: { leads: { kind: 'list', from: 'lead' }, dealers: { kind: 'list', from: 'dealer' } },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
  ],
  home: 'leads',
});

test("the platform realm's presentation offers its granted, registered commands and nothing to edit; each projection refuses the other realm", (t) => {
  // The pure ownership fixture above names the source's connection `owned-source`.
  const app = parseTestApp({ ...manifest(), sources: { business: { connection: source.connection } } }, 'lending.ts');
  const input = { app, ownership: ownership(t), principal: platform(), services: { commands: ['approve'] } };
  // Granted and registered: approve. Granted, not registered for this realm: overreach, not offered.
  assert.deepEqual(plain(projectPlatformCapabilities(input)), { resources: {}, writable: [], grantedCommands: ['approve'] });
  assert.deepEqual(plain(projectPlatformCapabilities({ ...input, principal: { ...platform(), roles: ['auditor'] } })).grantedCommands, []);
  // Tenant evidence, or platform evidence naming a tenant role, is never the platform realm's.
  denied(() => projectPlatformCapabilities({ ...input, principal: member() as never }));
  denied(() => projectPlatformCapabilities({ ...input, principal: { ...platform(), roles: ['staff'] } }));
  denied(() =>
    projectTenantCapabilities({
      app,
      ownership: ownership(t),
      principal: platform() as never,
      services: { recordWrites: true, deletedRecordPolicy: false, commands: ['approve'] },
    }),
  );
});

const SCHEMA = {
  tables: ['review_file', 'lead', 'vehicle_model', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE vehicle_model (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE review_file (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES lead(id), note TEXT);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.vehicle_model (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL,
      status text NOT NULL DEFAULT 'open', version integer NOT NULL DEFAULT 0);
    CREATE TABLE public.review_file (id text PRIMARY KEY, lead_id text NOT NULL REFERENCES public.lead(id), note text);`,
};
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO vehicle_model VALUES ('m1', 'Sedan');
    INSERT INTO lead (id, tenant_id, name) VALUES ('n1', 'north', 'North lead'), ('s1', 'south', 'South lead');
    INSERT INTO review_file VALUES ('r1', 'n1', 'Lender only');`;

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `platform_realm_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(
  t: TestContext,
  dialect: TenantDialect,
  alter?: (raw: ReturnType<typeof manifest>) => void,
  pages?: readonly PageDef[],
  lookup: { resource?: string; visible?: boolean } = {},
  context: { verifySessionInstance?: (request: Request) => ReturnType<typeof instance> | Promise<ReturnType<typeof instance>> } = {},
) {
  const engine: TenantEngine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const owners: TenantEnrollment<Request>[] = [];
  let contexts: ReturnType<typeof createTenantContexts<Request>> | undefined;
  // One hook, in order: the contexts, then the enrollment's sources, then the engine under them.
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
  const grant = { status: 'active' as const, validUntil: 10_000, expectedVersion: null };
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'kim', membershipId: 'north-kim', roles: ['staff'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['manager'] });
    await admin.putPlatformMembership({ ...grant, accountId: 'kim', membershipId: 'platform-kim', roles: ['manager'] });
    await admin.putPlatformMembership({ ...grant, accountId: 'pat', membershipId: 'platform-pat', roles: ['auditor'] });
  });
  const raw = manifest();
  alter?.(raw);
  const app = parseTestApp(raw, 'lending.ts');
  // Both tenant layers grant the platform tables on purpose: the realm hides them anyway.
  const everything = { dealer: true, lead: true, review_file: true, vehicle_model: true };
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: {
      dealer: { kind: 'platform' },
      lead: { kind: 'tenant', column: 'tenant_id' },
      review_file: { kind: 'platform' },
      vehicle_model: { kind: 'global', access: 'read-only' },
    },
    resolveMembershipRows: () => everything,
    resolveRows: () => everything,
    resolvePlatformRows: () => ({ dealer: true, lead: true, review_file: true, vehicle_model: lookup.visible ?? true }),
    resultReferences: { approve: () => [], overreach: () => [], flag: () => [], stamp: () => [] },
  });
  const service = await createTenantEnrollment<Request>({
    app,
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager', 'auditor'],
    maxLifetimeMs: 1000,
    now: () => 100,
    commands: { registry: defineCommands({ ...registry, stamp: stampWith(lookup.resource ?? 'vehicle_model') }) },
    ...(pages ? { pages } : {}),
    verifySession: (request) => identities[cookieOf(request)] ?? null,
  });
  owners.push(service);
  contexts = createTenantContexts<Request>({
    deployment: service.deployment,
    now: () => 100,
    verifySessionInstance: context.verifySessionInstance ?? instance,
  });
  return { engine, service, app, contexts, rows: (sql: string) => engine.all(sql) };
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
  return async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: 'fixture=lee', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, headers: response.headers, body: JSON.parse(await response.text()) as Record<string, unknown> };
  };
}
const ownerHeaders = (lease: TenantContextReply) => ({
  'x-mistri-account': lease.accountId,
  'x-mistri-tab': lease.tabId,
  'x-mistri-context': lease.context,
  'x-mistri-lease-revision': String(lease.revision),
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the platform realm end to end on ${dialect}`, { skip }, () => {
    test("a dealer's tenant context never reads a platform table: not its rows, counts, catalog or a path into it", async (t) => {
      const { service } = await fixture(t, dialect);
      const deployment = service.deployment;
      const seen = await deployment.withContext(as('alice'), ['north'], async (context) => ({
        tables: context.schema.tables.map((table) => table.id).sort(),
        leads: (await context.data.query(page('lead'))).rows.map(plain),
      }));
      assert.deepEqual(seen.tables, ['lead', 'vehicle_model']);
      assert.deepEqual(
        plain(seen).leads,
        [{ id: 'n1', name: 'North lead', status: 'open', version: 0 }],
        "north's own leads, without the ownership column",
      );
      await rejected(deployment.withContext(as('alice'), ['north'], (context) => context.data.query(page('review_file'))));
      await rejected(deployment.withContext(as('alice'), ['north'], (context) => context.data.count('dealer')));
      // A path into a platform table is a question this catalog cannot say: that read is refused, as an unknown column is.
      await assert.rejects(
        deployment.withContext(as('alice'), ['north'], (context) =>
          context.data.runView(
            {
              id: 'v',
              name: 'V',
              base: 'lead',
              columns: [{ path: 'id' }, { path: 'tenant_id.name' }],
              orderBy: [{ path: 'id', direction: 'asc' }],
              limit: 10,
            },
            0,
          ),
        ),
        (error: unknown) => error instanceof TenantRequestFault && error.status === 400 && error.code === 'invalid_read',
      );
      // A platform member holds no dealer membership: no tenant context either.
      await rejected(deployment.withContext(as('lee'), ['north'], () => true));
    });

    test("the platform context reads every dealer's rows under its own policy, sees whose they are, and a tenant member cannot open it", async (t) => {
      const { service } = await fixture(t, dialect);
      const deployment = service.deployment;
      const seen = await deployment.withPlatformContext(as('lee'), async (context) => ({
        tables: context.schema.tables.map((table) => table.id).sort(),
        leads: (
          await context.data.query({ ...page('lead'), columns: ['id', 'tenant_id'], orderBy: [{ column: 'id', direction: 'asc' }] })
        ).rows.map(plain),
        reviews: (await context.data.query(page('review_file'))).rows.map((row) => row.id),
      }));
      assert.ok(seen.tables.includes('lead') && seen.tables.includes('dealer') && seen.tables.includes('review_file'), seen.tables.join());
      assert.deepEqual(plain(seen).leads, [
        { id: 'n1', tenant_id: 'north' },
        { id: 's1', tenant_id: 'south' },
      ]);
      assert.deepEqual(seen.reviews, ['r1']);
      await rejected(deployment.withPlatformContext(as('alice'), () => true));
      // Discovery says who may open a platform context; tenants stay the tenant list.
      assert.deepEqual(plain(await service.discover(as('lee'))), {
        status: 'ready',
        appId: 'lending',
        accountId: 'lee',
        memberships: [],
        platform: true,
      });
      assert.deepEqual(plain(await service.discover(as('alice'))), {
        status: 'ready',
        appId: 'lending',
        accountId: 'alice',
        memberships: [{ tenantId: 'north' }],
      });
    });

    test('a platform read avoids a second empty context', async (t) => {
      const { engine, contexts } = await fixture(t, dialect);
      const lease = await contexts.openPlatform(as('lee'));
      const snapshots = engine.intercept(t, { match: (statement) => statement.sql.startsWith('BEGIN') && !statement.writer });
      try {
        await contexts.withPlatformContext(as('lee'), assertion(lease), () => true);
        /* Admission and the context's release fence each own a snapshot.
         Nothing revalidates the membership in a snapshot of its own before
         the first read, which does it in its own, nor after the release
         fence. The old empty context used six, then four, then three. */
        assert.equal(snapshots.calls, 2);
      } finally {
        snapshots.restore();
      }
    });

    /* A membership revoked while a platform read runs is refused by the read's
     own snapshot when a read follows, and by the runtime's release fence when
     none does. Neither needs the context owner to observe the membership once
     more afterwards: that snapshot of its own is gone, and both of these were
     refused before it ran as well. */
    for (const [when, body] of [
      [
        'before the body reads',
        async (context: PlatformReadContext, revoke: () => Promise<void>) => {
          await revoke();
          await context.data.query(page('lead'));
        },
      ],
      [
        "after the body's last read",
        async (context: PlatformReadContext, revoke: () => Promise<void>) => {
          await context.data.query(page('lead'));
          await revoke();
        },
      ],
    ] as const)
      test(`a platform membership revoked ${when} is refused`, async (t) => {
        const { engine, contexts } = await fixture(t, dialect);
        const revoke = () =>
          engine.maintenance(binding, (admin) =>
            admin.putPlatformMembership({
              status: 'revoked',
              validUntil: 10_000,
              accountId: 'lee',
              membershipId: 'platform-lee',
              roles: ['manager'],
              expectedVersion: '1',
            }),
          );
        const lease = await contexts.openPlatform(as('lee'));
        let finished = false;
        await rejected(
          contexts.withPlatformContext(as('lee'), assertion(lease), async (context) => {
            await body(context, revoke);
            finished = true;
            return true;
          }),
        );
        // A body that finished was refused after it: by the release fence, the one fence left there.
        assert.equal(finished, when !== 'before the body reads');
        await rejected(contexts.withPlatformContext(as('lee'), assertion(lease), () => true));
      });

    test("each realm presents only its own granted commands: the platform context its commands and no edits, a dealer's its own", async (t) => {
      const { service } = await fixture(t, dialect);
      const deployment = service.deployment;
      // Kim is both: a manager in the platform realm and staff at north. Each context offers its realm's commands only.
      assert.deepEqual(plain((await deployment.withPlatformContext(as('kim'), (context) => context.capabilities))!), {
        resources: {},
        writable: [],
        grantedCommands: ['approve', 'overreach', 'stamp'],
      });
      assert.deepEqual((await deployment.withContext(as('kim'), ['north'], (context) => context.capabilities))!.grantedCommands, ['flag']);
      // A platform role granted no command is offered none, and runs none.
      assert.deepEqual((await deployment.withPlatformContext(as('pat'), (context) => context.capabilities))!.grantedCommands, []);
      await assert.rejects(deployment.executePlatform(as('pat'), one('overreach', 'n1', 'pat-overreach-0001')), refused('forbidden'));
    });

    test("a platform command updates each dealer's lead and files its own row, and each audit row names the lead's dealer", async (t) => {
      const { rows, contexts } = await fixture(t, dialect),
        lee = as('lee');
      const lease = await contexts.openPlatform(lee);
      const leads = await contexts.withPlatformContext(lee, assertion(lease), async (context) =>
        (await context.data.query({ ...page('lead'), orderBy: [{ column: 'id', direction: 'asc' }] })).rows.map((row) => row.id),
      );
      assert.deepEqual(leads.value, ['n1', 's1']);
      const eligibility = await contexts.availabilityPlatform(lee, assertion(lease), {
        checks: [{ command: 'approve', commandVersion: 1, keys: [{ id: 'n1' }, { id: 's1' }, { id: 'missing' }] }],
      });
      assert.deepEqual(JSON.parse(JSON.stringify(eligibility.value)), {
        checks: [{ command: 'approve', commandVersion: 1, available: [true, true, false] }],
      });
      const done = await contexts.executePlatform(lee, assertion(lease), many('approve', ['n1', 's1'], 'approve-both-0001'));
      assert.equal(done.value.status, 'applied');
      assert.deepEqual(await rows('SELECT id, tenant_id, status, version FROM lead ORDER BY id'), [
        { id: 'n1', tenant_id: 'north', status: 'approved', version: 1 },
        { id: 's1', tenant_id: 'south', status: 'approved', version: 1 },
      ]);
      assert.deepEqual(await rows('SELECT id, lead_id FROM review_file ORDER BY id'), [
        { id: 'r1', lead_id: 'n1' },
        { id: 'review-n1', lead_id: 'n1' },
        { id: 'review-s1', lead_id: 's1' },
      ]);
      assert.deepEqual(await rows(`SELECT realm, tenant_id FROM "${journal.receipt}"`), [{ realm: 'platform', tenant_id: '' }]);
      assert.deepEqual(
        await rows(`SELECT ordinal, realm, tenant_id, owner_tenant_id, membership_id FROM ${auditRows(dialect)} a ORDER BY ordinal`),
        [
          { ordinal: 0, realm: 'platform', tenant_id: '', owner_tenant_id: 'north', membership_id: 'platform-lee' },
          { ordinal: 1, realm: 'platform', tenant_id: '', owner_tenant_id: 'south', membership_id: 'platform-lee' },
        ],
      );
      // The same request again replays its receipt rather than approving twice.
      const replay = await contexts.executePlatform(lee, assertion(lease), many('approve', ['n1', 's1'], 'approve-both-0001'));
      assert.equal(replay.value.replayed, true);
      assert.deepEqual(await rows(counted('review_file')), [{ n: 3 }]);
    });

    test('a platform command looks up global data through its own row scope and persists only the permitted result', async (t) => {
      const { service, rows } = await fixture(t, dialect);
      const request = one('stamp', 's1', 'platform-lookup-0001');
      const result = await service.deployment.executePlatform(as('lee'), request);
      assert.equal(result.status, 'applied');
      assert.ok(result.result && typeof result.result === 'object');
      assert.deepEqual(plain(result.result), { name: 'Sedan' });
      assert.deepEqual(await rows('SELECT id, name, version FROM lead ORDER BY id'), [
        { id: 'n1', name: 'North lead', version: 0 },
        { id: 's1', name: 'Sedan', version: 1 },
      ]);
      assert.equal((await service.deployment.executePlatform(as('lee'), request)).replayed, true);
      assert.deepEqual(await rows(`SELECT realm, owner_tenant_id FROM ${auditRows(dialect)} a`), [
        { realm: 'platform', owner_tenant_id: 'south' },
      ]);
    });

    test('a platform lookup cannot bypass its global row policy, and refuses without writing a receipt or target', async (t) => {
      const { service, rows } = await fixture(t, dialect, undefined, undefined, { visible: false });
      await assert.rejects(service.deployment.executePlatform(as('lee'), one('stamp', 's1', 'platform-hidden-0001')), refused());
      assert.deepEqual(await rows("SELECT name, version FROM lead WHERE id = 's1'"), [{ name: 'South lead', version: 0 }]);
      assert.deepEqual(await rows(counted(journal.receipt)), [{ n: 0 }]);
    });

    for (const resource of ['lead', 'dealer'])
      test(`a platform lookup of ${resource} is refused at enrollment because it is not global`, async (t) => {
        const app = parseTestApp(manifest(), 'lending.ts');
        assert.throws(
          () => assertGlobalLookups(app, defineCommands({ stamp: stampWith(resource) }), OWNERSHIP),
          (error: unknown) => {
            assert.ok(error instanceof CommandLookupRefusal);
            assert.match(error.message, /Command "stamp" looks up/);
            assert.match(error.message, /only resources every tenant reads, "owner": "global"/);
            return true;
          },
        );
        // Enrollment intentionally hides the definition error at its private admission boundary.
        await assert.rejects(fixture(t, dialect, undefined, undefined, { resource }), TenantContextError);
      });

    test('a platform command across dealers is all or nothing: one missing lead refuses the whole list', async (t) => {
      const { rows, contexts } = await fixture(t, dialect),
        lee = as('lee');
      const lease = await contexts.openPlatform(lee);
      await assert.rejects(
        contexts.executePlatform(lee, assertion(lease), many('approve', ['n1', 'x9'], 'approve-missing-0001')),
        refused(),
      );
      assert.deepEqual(await rows('SELECT id, status FROM lead ORDER BY id'), [
        { id: 'n1', status: 'open' },
        { id: 's1', status: 'open' },
      ]);
      assert.deepEqual(await rows(counted(journal.receipt)), [{ n: 0 }]);
    });

    for (const [mode, verb] of [
      ['insert', 'places'],
      ['owner', 'reassigns'],
      ['remove', 'removes'],
    ] as const) {
      test(`the platform realm never ${verb} a dealer's row, and nothing it tried stays`, async (t) => {
        const { rows, contexts } = await fixture(t, dialect),
          lee = as('lee');
        overreach = mode;
        const lease = await contexts.openPlatform(lee);
        await assert.rejects(contexts.executePlatform(lee, assertion(lease), one('overreach', 'n1', `overreach-${mode}-0001`)), refused());
        assert.deepEqual(await rows('SELECT id, tenant_id, status FROM lead ORDER BY id'), [
          { id: 'n1', tenant_id: 'north', status: 'open' },
          { id: 's1', tenant_id: 'south', status: 'open' },
        ]);
        assert.deepEqual(await rows(counted(journal.receipt)), [{ n: 0 }]);
      });
    }

    test('one tab moves between the platform realm and a dealer, and each lease reads only in its own realm', async (t) => {
      const { contexts } = await fixture(t, dialect);
      const kim = as('kim');
      const lender = await contexts.openPlatform(kim);
      assert.equal(lender.realm, 'platform');
      assert.equal(lender.tenantId, '@platform');
      const leads = await contexts.withPlatformContext(kim, assertion(lender), async (context) =>
        (await context.data.query({ ...page('lead'), orderBy: [{ column: 'id', direction: 'asc' }] })).rows.map((row) => row.id),
      );
      assert.deepEqual(leads.value, ['n1', 's1']);
      // A tenant operation never runs on a platform lease, nor a platform read on a tenant's.
      await rejected(contexts.withContext(kim, ['north'], assertion(lender), () => true));
      const north = await contexts.switch(kim, ['north'], assertion(lender));
      assert.equal(north.tenantId, 'north');
      assert.equal('realm' in north, false);
      await rejected(contexts.withPlatformContext(kim, assertion(north), () => true));
      const own = await contexts.withContext(kim, ['north'], assertion(north), async (context) =>
        (await context.data.query(page('lead'))).rows.map((row) => row.id),
      );
      assert.deepEqual(own.value, ['n1']);
      const back = await contexts.switchToPlatform(kim, assertion(north));
      assert.equal(back.realm, 'platform');
      const renewed = await contexts.renewPlatform(kim, assertion(back));
      assert.equal(renewed.revision, back.revision + 1);
      // A renewal keeps its realm: the platform lease is not renewed as a tenant's.
      await rejected(contexts.renew(kim, ['north'], assertion(renewed)));
      // A tenant-only account cannot open the platform realm at all.
      await rejected(contexts.openPlatform(as('alice')));
    });

    test("each realm runs only its own commands: a tenant's is refused on the platform lease, the platform's in a dealer's context", async (t) => {
      const { rows, contexts } = await fixture(t, dialect),
        kim = as('kim');
      const lender = await contexts.openPlatform(kim);
      await assert.rejects(
        contexts.executePlatform(kim, assertion(lender), one('flag', 'n1', 'flag-on-platform-0001')),
        refused('forbidden'),
      );
      const north = await contexts.switch(kim, ['north'], assertion(lender));
      await assert.rejects(
        contexts.execute(kim, ['north'], assertion(north), many('approve', ['n1'], 'approve-in-north-0001')),
        refused('forbidden'),
      );
      const flagged = await contexts.execute(kim, ['north'], assertion(north), one('flag', 'n1', 'flag-in-north-0001'));
      assert.equal(flagged.value.status, 'applied');
      assert.deepEqual(await rows(`SELECT realm, tenant_id, owner_tenant_id FROM ${auditRows(dialect)} a`), [
        { realm: 'tenant', tenant_id: 'north', owner_tenant_id: 'north' },
      ]);
    });

    test('a platform command is neither public nor event-emitting, and startup pins its realm on every reference and role', async (t) => {
      const base = { source: 'business', target: 'lead', read: ['lead'], write: ['lead'], input: {}, output, handle: async () => ({}) };
      for (const definition of [
        { ...base, realm: 'platform', public: true },
        { ...base, realm: 'platform', events: {} },
        { ...base, realm: 'lender' },
      ]) {
        assert.throws(() => defineCommand(definition as never), BusinessCommandDefinitionError);
      }
      assert.equal(defineCommand({ ...base, realm: 'platform' } as never).realm, 'platform');
      // The registered command owns its realm; a dealer's role may not grant a platform command.
      await assert.rejects(
        fixture(t, dialect, (raw) => {
          raw.auth.roles.staff.commands = ['flag', 'approve'];
        }),
      );
    });

    test('pages from the App loader meet the realm rules too: a page over a platform table serves the platform realm or nothing', async (t) => {
      const [dealerPage] = parsePagesConfig(
        { pages: [{ id: 'dealer-page', label: 'Dealer', base: 'dealer', sections: [{ kind: 'fields', show: ['name'] }] }] },
        'pages',
      );
      await assert.rejects(fixture(t, dialect, undefined, [dealerPage]));
      const { service } = await fixture(t, dialect, undefined, [{ ...dealerPage, realm: 'platform' }]);
      assert.equal(service.deployment.platform, true);
    });

    test('HTTP names the platform realm by ?realm=platform alone, attests it on every reply, reads, and writes through its commands only', async (t) => {
      const { service, rows, app } = await fixture(t, dialect);
      const call = await serve(t, service, app);
      assert.deepEqual((await call('/api/tenant/bootstrap?app=lending')).body, {
        status: 'ready',
        appId: 'lending',
        accountId: 'lee',
        memberships: [],
        platform: true,
      });
      const opened = await call('/api/tenant/context/open?app=lending&realm=platform', {});
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.realm, 'platform');
      assert.equal(opened.body.tenantId, '@platform');
      assert.equal(opened.headers.get('x-mistri-realm'), 'platform');
      const owner = ownerHeaders(opened.body as unknown as TenantContextReply);
      const read = await call(
        '/api/query?app=lending&realm=platform',
        { table: 'lead', orderBy: [{ column: 'id', direction: 'asc' }] },
        owner,
      );
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(
        (read.body.rows as { id: string }[]).map((row) => row.id),
        ['n1', 's1'],
      );
      assert.equal(read.headers.get('x-mistri-realm'), 'platform');
      assert.equal(read.headers.get('x-mistri-tenant'), '@platform');
      // Never beside a tenant, never another realm, never the reserved id as a
      // tenant, never asserted by header, and never opened by a tenant member.
      for (const [path, headers] of [
        ['/api/query?app=lending&realm=platform&tenant=north', owner],
        ['/api/query?app=lending&realm=tenant', owner],
        ['/api/query?app=lending&tenant=%40platform', owner],
        ['/api/query?app=lending&realm=platform', { ...owner, 'x-mistri-realm': 'platform' }],
        ['/api/tenant/context/open?app=lending&realm=platform', { cookie: 'fixture=alice' }],
      ] as const) {
        const refusal = await call(path, path.includes('/open') ? {} : { table: 'lead' }, headers);
        assert.ok(refusal.status >= 400, `${path} answered ${refusal.status}`);
        assert.equal(refusal.headers.get('x-mistri-realm'), null);
      }
      const write = await call(
        '/api/update?app=lending&realm=platform',
        { table: 'lead', key: { id: 'n1' }, values: { name: 'Changed' } },
        owner,
      );
      assert.equal(write.status, 403);
      assert.deepEqual(await rows("SELECT name, status FROM lead WHERE id = 'n1'"), [{ name: 'North lead', status: 'open' }]);
      /* Two commands in one request, as the lease's own action bar asks: a record
       offering several verbs gets an answer for each, in the request's one
       transaction over both footprints. */
      const available = await call(
        '/api/commands/availability?app=lending&realm=platform',
        {
          checks: [
            { command: 'approve', commandVersion: 1, keys: [{ id: 's1' }, { id: 'missing' }] },
            { command: 'overreach', commandVersion: 1, keys: [{ id: 's1' }] },
          ],
        },
        owner,
      );
      assert.equal(available.status, 200, JSON.stringify(available.body));
      assert.deepEqual(available.body, {
        checks: [
          { command: 'approve', commandVersion: 1, available: [true, false] },
          { command: 'overreach', commandVersion: 1, available: [true] },
        ],
      });
      assert.equal(available.headers.get('x-mistri-realm'), 'platform');
      const executed = await call('/api/commands/execute?app=lending&realm=platform', one('approve', 's1', 'http-approve-0001'), owner);
      assert.equal(executed.status, 200, JSON.stringify(executed.body));
      assert.equal(executed.body.status, 'applied');
      assert.equal(executed.headers.get('x-mistri-realm'), 'platform');
      assert.deepEqual(await rows("SELECT status FROM lead WHERE id = 's1'"), [{ status: 'approved' }]);
    });

    test("HTTP metadata offers the platform realm's command actions on its lease, a dealer's own on a tenant's, and no edits to the platform", async (t) => {
      const { service, app } = await fixture(t, dialect);
      const call = await serve(t, service, app);
      // A resource left with nothing to present is not served at all, so no block reads as no action.
      const labels = (reply: { body: Record<string, unknown> }) => {
        const served = reply.body.app as {
          resources?: Record<string, { actions?: { label: string }[] }>;
          grantedCommands: string[];
          writableTables: string[];
        };
        return {
          actions: (served.resources?.lead?.actions ?? []).map((action) => action.label),
          granted: served.grantedCommands,
          writable: served.writableTables,
        };
      };
      const lender = await call('/api/tenant/context/open?app=lending&realm=platform', {});
      const lenderOwner = ownerHeaders(lender.body as unknown as TenantContextReply);
      const offered = await call('/api/app?app=lending&realm=platform', undefined, lenderOwner);
      assert.equal(offered.status, 200, JSON.stringify(offered.body));
      assert.equal(offered.headers.get('x-mistri-realm'), 'platform');
      assert.deepEqual(labels(offered), {
        actions: ['Approve', 'Overreach', 'Stamp'],
        granted: ['approve', 'overreach', 'stamp'],
        writable: [],
      });
      const runtime = await call('/api/runtime?app=lending&realm=platform', undefined, lenderOwner);
      assert.deepEqual(
        (runtime.body.apps as { writable: boolean }[]).map((entry) => entry.writable),
        [false],
      );
      // Nothing in the platform schema is presented as editable.
      const schema = await call('/api/schema?app=lending&realm=platform', undefined, lenderOwner);
      const tables = schema.body.tables as { insertable: boolean; deletable: boolean; columns: { writable: boolean }[] }[];
      assert.ok(
        tables.length > 0 &&
          tables.every((table) => !table.insertable && !table.deletable && table.columns.every((column) => !column.writable)),
      );
      // Alice's north context: her realm's command, never the platform's.
      const dealer = await call('/api/tenant/context/open?app=lending&tenant=north', {}, { cookie: 'fixture=alice' });
      assert.equal(dealer.status, 200, JSON.stringify(dealer.body));
      const north = await call('/api/app?app=lending&tenant=north', undefined, {
        cookie: 'fixture=alice',
        ...ownerHeaders(dealer.body as unknown as TenantContextReply),
      });
      assert.equal(north.status, 200, JSON.stringify(north.body));
      assert.deepEqual(labels(north), { actions: ['Flag'], granted: ['flag'], writable: [] });
      // Pat's platform context: the realm, a role granted no command, so no action.
      const auditor = await call('/api/tenant/context/open?app=lending&realm=platform', {}, { cookie: 'fixture=pat' });
      const audited = await call('/api/app?app=lending&realm=platform', undefined, {
        cookie: 'fixture=pat',
        ...ownerHeaders(auditor.body as unknown as TenantContextReply),
      });
      assert.deepEqual(labels(audited), { actions: [], granted: [], writable: [] });
    });
  });
