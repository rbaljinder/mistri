/**
 * Public tenant provisioning, from the package entry an operator's
 * maintenance script imports: `provisionStores` from `@mistriwork/mistri/maintenance`,
 * with the PostgreSQL migrations beside it and the binding type from `@mistriwork/mistri/commands`.
 *
 * Tenant App startup and administration are a public preview, and startup
 * attests an existing tenant store (and, with `administration`, its journal)
 * without ever creating one. So the step that creates them has to be public
 * too, or nobody outside this repository can start a tenant App. This file
 * proves the exported functions are exactly the ones startup trusts: a file
 * provisioned only through the public entry passes real tenant startup, with
 * and without administration; provisioning is idempotent, bound to one App,
 * source and store, and refuses without writing; and the published
 * declarations give a consumer the functions and the binding type without the
 * private store, fence or invitation APIs.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishedDeclarations } from './support/installedTablewalk.js';
import * as commands from '../packages/mistri/src/server/commands.js';
import * as maintenance from '../packages/mistri/src/server/maintenance.js';
import { provisionStores, type StoreTarget } from '../packages/mistri/src/server/maintenance.js';
import { send } from '../packages/mistri/src/server/commands/commandEffects.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { ADMINISTRATION_JOURNAL_TABLES } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { prepareTenantStartup, TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { verifySqliteSupportAudit } from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import {
  migratePostgresSupportAudit,
  verifyPostgresSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { migratePostgresTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { published } from '../scripts/pack-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binding = { appId: 'app', source: { id: 'business', connection: 'business-db' }, storeId: 'public-store' };
const at = (path: string): StoreTarget => ({ sqlite: path });
const app = (tenant: typeof binding) => ({ tenant });
const stores = (path: string, only: string[], tenant: typeof binding = binding) => provisionStores(at(path), { app: app(tenant), only });
const denied = (error: unknown) => {
  assert.ok(error instanceof TenantContextError, String(error));
  assert.equal(error.message, 'The tenant context could not be verified.');
  return true;
};

function fixture(t: TestContext, administration: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-provisioning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'business.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
      INSERT INTO db_item VALUES ('north-1', 'north', 'North')`);
  } finally {
    db.close();
  }
  const manifest = {
    id: binding.appId,
    name: 'Public provisioning fixture',
    auth: { store: './auth.db', rows: 'tenant', roles: { reader: { read: true } } },
    sources: { [binding.source.id]: { connection: binding.source.connection } },
    resources: { item: { physical: 'db_item', owner: 'tenant', fields: { read: ['id', 'name'] } } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
  };
  const appPath = join(dir, 'app.json');
  writeFileSync(appPath, JSON.stringify(manifest));
  const policyFile = join(dir, 'tenant-policy.mjs');
  writeFileSync(
    policyFile,
    `export default {
    kind: 'tenant', appId: '${binding.appId}', storeId: '${binding.storeId}',
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows() { return { item: true }; }, resolveRows() { return { item: true }; },
    ${
      administration
        ? `administration: { id: 'operators', version: '1', maxMembershipLifetimeMs: 60000,
      operators: [{ accountId: 'existing-operator', tenants: ['north'], operations: ['createTenant', 'setTenantStatus'], roles: [] }] },`
        : ''
    }
  };`,
  );
  const loaded: LoadedApp = { path: appPath, app: parseAppConfig(manifest, appPath), pages: [], sources: {} };
  const connection: ConnectionConfig = {
    id: binding.source.connection,
    name: 'Business',
    url: path,
    source: 'config',
    ...(administration ? { writable: true } : {}),
  };
  const tables = () => {
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      return reader
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '\\_\\_mistri\\_%' ESCAPE '\\' ORDER BY name")
        .all()
        .map((row) => row.name);
    } finally {
      reader.close();
    }
  };
  return { dir, path, startup: { loaded, connections: [connection], policyFile }, tables };
}

test('the public commands entry exports no maintenance step, and the maintenance entry the PostgreSQL migrations and no SQLite provisioner', () => {
  assert.deepEqual(Object.keys(commands).sort(), [
    'BusinessCommandDefinitionError',
    'bool',
    'date',
    'defineChallenges',
    'defineCommand',
    'defineCommands',
    'defineEvent',
    'defineEventProjection',
    'defineExperimentConversion',
    'defineLoader',
    'defineLoaders',
    'defineSource',
    'field',
    'id',
    'int',
    'list',
    'literal',
    'nullable',
    'number',
    'oneOf',
    'optional',
    'post',
    'publicReference',
    'publicReferencePattern',
    'refuse',
    'send',
    'shape',
    'text',
  ]);
  // The integrations' channel effect (commandEffects.ts), beside `post`: the same function, not a wrapper.
  assert.equal(commands.send, send);
  assert.equal(maintenance.migratePostgresTenantInvitations, migratePostgresTenantInvitations);
  assert.equal((commands as Record<string, unknown>).migratePostgresTenantInvitations, undefined);
  assert.equal(maintenance.migratePostgresTenantStore, migratePostgresTenantStore);
  assert.equal((commands as Record<string, unknown>).migratePostgresTenantStore, undefined);
  assert.equal(maintenance.migratePostgresTenantAdministrationJournal, migratePostgresTenantAdministrationJournal);
  assert.equal((commands as Record<string, unknown>).migratePostgresTenantAdministrationJournal, undefined);
  assert.equal(maintenance.verifySqliteSupportAudit, verifySqliteSupportAudit);
  assert.equal((commands as Record<string, unknown>).verifySqliteSupportAudit, undefined);
  assert.equal(maintenance.migratePostgresSupportAudit, migratePostgresSupportAudit);
  assert.equal((commands as Record<string, unknown>).migratePostgresSupportAudit, undefined);
  assert.equal(maintenance.verifyPostgresSupportAudit, verifyPostgresSupportAudit);
  assert.equal((commands as Record<string, unknown>).verifyPostgresSupportAudit, undefined);
});

test('a file provisioned only through provisionStores passes tenant startup', async (t) => {
  const f = fixture(t, false);
  await assert.rejects(prepareTenantStartup(f.startup), TenantStartupError, 'startup never creates the store');
  assert.deepEqual(f.tables(), []);
  const first = await stores(f.path, ['tenant-store']);
  assert.deepEqual(first, { stores: { 'tenant-store': { version: 1, provisioned: true } }, destinations: [] });
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.stores) && Object.isFrozen(first.stores['tenant-store']));
  assert.deepEqual(await stores(f.path, ['tenant-store']), {
    stores: { 'tenant-store': { version: 1, provisioned: false } },
    destinations: [],
  });
  assert.deepEqual(f.tables(), Object.values(TENANT_TABLES).sort());
  const prepared = await prepareTenantStartup(f.startup);
  assert.ok(Object.isFrozen(prepared.enrollment));
  assert.equal(existsSync(join(f.dir, 'auth.db')), false, 'provisioning and startup validation leave auth alone');
});

test('administration startup needs the journal provisionStores makes, after the store, whatever order is asked', async (t) => {
  const f = fixture(t, true);
  await assert.rejects(stores(f.path, ['tenant-administration']), denied);
  assert.deepEqual(f.tables(), [], 'the journal is never provisioned without its store');
  await stores(f.path, ['tenant-store']);
  await assert.rejects(prepareTenantStartup(f.startup), TenantStartupError, 'startup never creates the journal');
  assert.deepEqual((await stores(f.path, ['tenant-administration'])).stores, {
    'tenant-administration': { version: 1, provisioned: true },
  });
  assert.deepEqual((await stores(f.path, ['tenant-administration'])).stores, {
    'tenant-administration': { version: 1, provisioned: false },
  });
  assert.deepEqual(f.tables(), [...Object.values(ADMINISTRATION_JOURNAL_TABLES), ...Object.values(TENANT_TABLES)].sort());
  const prepared = await prepareTenantStartup(f.startup);
  assert.ok(Object.isFrozen(prepared.enrollment));
});

test('a list is made in dependency order however it is written, and the audit follows the store', async (t) => {
  const f = fixture(t, true);
  await assert.rejects(stores(f.path, ['tenant-store', 'tenant-support-audit']), /MISTRI_AUDIT_KEY/);
  assert.deepEqual(f.tables(), [], 'a missing audit key refuses the list before the store is made');
  const saved = process.env.MISTRI_AUDIT_KEY;
  process.env.MISTRI_AUDIT_KEY = 'k'.repeat(40);
  t.after(() => {
    if (saved === undefined) delete process.env.MISTRI_AUDIT_KEY;
    else process.env.MISTRI_AUDIT_KEY = saved;
  });
  const made = await stores(f.path, ['tenant-support-audit', 'tenant-invitations', 'tenant-administration', 'tenant-store']);
  assert.deepEqual(Object.keys(made.stores), ['tenant-store', 'tenant-administration', 'tenant-invitations', 'tenant-support-audit']);
  assert.ok(Object.values(made.stores).every((each) => each.provisioned));
  assert.deepEqual(made.destinations, [], "the App's own command stores are not made beside the tenant's");
  assert.ok((await stores(f.path, ['tenant-store', 'tenant-support-audit'])).stores['tenant-support-audit']!.provisioned === false);
  assert.ok((await prepareTenantStartup(f.startup)).enrollment);
});

test('a tenant store needs its binding, and a refused list makes nothing', async (t) => {
  const f = fixture(t, false);
  const before = readFileSync(f.path);
  await assert.rejects(
    provisionStores(at(f.path), { only: ['tenant-store'] }),
    /provisionStores: "tenant-store" .* give its binding as `app: \{ tenant \}`/,
  );
  await assert.rejects(provisionStores(at(f.path), { app: app(binding), only: ['tenant-store', 'no-such-store'] }), /no store is called/);
  await assert.rejects(
    provisionStores({ postgres: 'postgres://127.0.0.1:1/x' }, { app: app(binding), only: ['tenant-store', 'record-history', 'jobs'] }),
    /provisionStores: "jobs"/,
  );
  await assert.rejects(
    provisionStores({ mysql: 'mysql://db/x' }, { app: app(binding), only: ['tenant-store'] }),
    /kept in sqlite or postgres/,
  );
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(f.tables(), []);
});

test('provisioning is bound, explicit and refuses without writing', async (t) => {
  const f = fixture(t, false);
  const missing = join(f.dir, 'missing.db');
  await assert.rejects(stores(missing, ['tenant-store']), denied);
  assert.equal(existsSync(missing), false, 'provisioning never creates the business database');
  await assert.rejects(stores(f.dir, ['tenant-store']), denied);
  for (const invalid of [
    { ...binding, storeId: '' },
    { ...binding, source: { id: 'not a name', connection: 'business-db' } },
    { appId: binding.appId, storeId: binding.storeId },
    { ...binding, extra: true },
  ])
    await assert.rejects(stores(f.path, ['tenant-store'], invalid as never), denied);
  assert.deepEqual(f.tables(), []);
  await stores(f.path, ['tenant-store']);
  const before = readFileSync(f.path);
  for (const other of [
    { ...binding, storeId: 'other-store' },
    { ...binding, source: { ...binding.source, id: 'other_source' } },
  ]) {
    await assert.rejects(stores(f.path, ['tenant-store'], other), denied, 'an existing store is never rebound');
    await assert.rejects(stores(f.path, ['tenant-administration'], other), denied);
  }
  // One database holds one tenant App: a second App is refused, and the refusal says so.
  await assert.rejects(
    stores(f.path, ['tenant-store'], { ...binding, appId: 'other-app' }),
    /belongs to the tenant App "app", not "other-app"/,
  );
  await assert.rejects(stores(f.path, ['tenant-administration'], { ...binding, appId: 'other-app' }), denied);
  assert.deepEqual(readFileSync(f.path), before, 'refusals change nothing');
  // The connection id is a transient alias, not stored identity: a renamed
  // connection attests the same store, as startup already allows.
  assert.deepEqual((await stores(f.path, ['tenant-store'], { ...binding, source: { ...binding.source, connection: 'renamed' } })).stores, {
    'tenant-store': { version: 1, provisioned: false },
  });
});

test('published declarations type the provisioning steps without exposing private store APIs', () => {
  const pkg = published(JSON.parse(readFileSync(join(root, 'packages/mistri/package.json'), 'utf8')));
  assert.deepEqual(pkg.exports['./commands'], { types: './dist/server/commands.d.ts', default: './dist/server/commands.js' });
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.commands.json'), 'utf8')) as { include: string[] };
  assert.ok(config.include.includes('packages/mistri/src/server/commands.ts'));
  const { report, exports } = publishedDeclarations(
    `
    import {
      migratePostgresTenantAdministrationJournal, migratePostgresTenantStore,
      migratePostgresSupportAudit, verifyPostgresSupportAudit,
    } from '@mistriwork/mistri/maintenance';
    import type { TenantStoreBinding } from '@mistriwork/mistri/commands';
    import * as publicCommands from '@mistriwork/mistri/commands';
    import * as publicMaintenance from '@mistriwork/mistri/maintenance';
    const binding: TenantStoreBinding = { appId: 'app', source: { id: 'business', connection: 'business-db' }, storeId: 'store' };
    // The SQLite provisioners are not published here: provisionStores (@mistriwork/mistri/maintenance) makes the tenant stores.
    // @ts-expect-error
    publicCommands.provisionSqliteTenantStore;
    // @ts-expect-error
    publicCommands.provisionSqliteTenantAdministrationJournal;
    // @ts-expect-error
    publicCommands.provisionSqliteTenantInvitations;
    // @ts-expect-error
    publicCommands.provisionSqliteSupportAudit;
    const postgres: Promise<{ version: 1; migrated: boolean }> = migratePostgresTenantStore('postgres://db/business', binding);
    const postgresJournal: Promise<{ version: 1; migrated: boolean }> = migratePostgresTenantAdministrationJournal('postgres://db/business', binding);
    // @ts-expect-error A binding names the source the store belongs to.
    const partial: TenantStoreBinding = { appId: 'app', storeId: 'store' };
    // @ts-expect-error Bindings are immutable evidence.
    binding.storeId = 'other';
    // @ts-expect-error Store administration stays private.
    publicCommands.createSqliteTenantAdministration;
    // @ts-expect-error The membership fence stays private.
    publicCommands.assertPostgresTenantMembershipFence;
    // Invitation storage is public maintenance too, after the administration journal.
    const postgresInvitations: Promise<{ version: 1; migrated: boolean }> =
      publicMaintenance.migratePostgresTenantInvitations('postgres://db/business', binding);
    // @ts-expect-error The invitation store's transactions stay private.
    publicCommands.createSqliteTenantInvitations;
    const audit: Promise<{ version: 1; migrated: boolean }> = migratePostgresSupportAudit('postgres://db/business', binding);
    const report: Promise<{ version: 1; sessions: number; entries: number; failed: string[] }> =
      verifyPostgresSupportAudit('postgres://db/business', binding);
    // @ts-expect-error Appending to a support session stays private.
    publicCommands.createSqliteSupportAudit;
  `,
    join('@mistriwork/mistri', pkg.exports['./commands'].types),
  );
  assert.equal(report, '');
  assert.deepEqual(
    exports,
    [
      'BusinessCommand',
      'BusinessCommandActor',
      'BusinessCommandAvailabilityContext',
      'BusinessCommandContext',
      'BusinessCommandDefinitionError',
      'BusinessCommandInitialContext',
      'BusinessCommandLookupContext',
      'BusinessCommandRegistry',
      'BusinessCommandValidationContext',
      'BusinessEvent',
      'BusinessEventProjection',
      'CommandDb',
      'CommandDefinition',
      'ChallengeRequest',
      'ChannelMessageProjection',
      'HumanCheck',
      'defineChallenges',
      'CommandEffect',
      'CommandFile',
      'CommandInput',
      'CommandInputOf',
      'CommandSource',
      'EffectPayload',
      'ExperimentConversion',
      'LookupSources',
      'LookupTable',
      'PageLoader',
      'PageLoaderContext',
      'PageLoaderViewer',
      'PostOptions',
      'Query',
      'ReadTable',
      'RefusalCode',
      'RowOf',
      'Shape',
      'ShapeOf',
      'StandardSchema',
      'TenantStoreBinding',
      'Where',
      'WriteTable',
      'bool',
      'date',
      'defineCommand',
      'defineCommands',
      'defineEvent',
      'defineEventProjection',
      'defineExperimentConversion',
      'defineLoader',
      'defineLoaders',
      'defineSource',
      'field',
      'id',
      'int',
      'list',
      'literal',
      'nullable',
      'number',
      'oneOf',
      'optional',
      'post',
      'refuse',
      'send',
      'shape',
      'text',
      'publicReference',
      'publicReferencePattern',
    ].sort(),
  );
});
