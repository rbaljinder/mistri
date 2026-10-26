import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import {
  createTenantEnrollment,
  loadTenantEnrollment,
  type TenantEnrollment,
  type TenantEnrollmentOptions,
} from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { TenantContextError, refusalReasons } from '../packages/engine/src/server/evidence.js';
import { provisionSqliteTenantStore, TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { createApp } from './support/createApp.js';
import { createAppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import { defineCommands, defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { MAX_COMMAND_IDS } from '../packages/mistri/src/server/commands/commandLimits.js';
import { commandReferencesCheck } from '../packages/mistri/src/server/tenant/tenantFeatureCommands.js';
import type { TenantStartupCommands } from '../packages/mistri/src/server/tenant/tenantFeatureContract.js';
import { TenantCommandStartupError } from '../packages/mistri/src/server/tenant/tenantStartupError.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { captureTenantDeployment } from '../packages/mistri/src/server/tenant/tenantDeployment.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseTestApp } from './support/commandCatalog.js';
import { VALIDATE, validating } from './support/validation.js';

type Request = { cookie: string };
type Options = TenantEnrollmentOptions<Request>;
const request = { cookie: 'alice' };
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  return true;
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-enrollment-'));
  const path = join(dir, 'business.db'),
    db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('n','north','North'),('s','south','South');`);
  const binding = { appId: 'app', source: { id: 'business', connection: 'business-db' }, storeId: 'private-store' };
  provisionSqliteTenantStore(path, binding);
  for (const tenant of ['north', 'south']) {
    db.prepare(`INSERT INTO "${tables.tenant}" VALUES (?, 'active', '1', 'tenant')`).run(tenant);
    db.prepare(
      `INSERT INTO "${tables.membership}" VALUES (?, ?, 'alice', 'active', '1', '["editor"]', 10000, 'member', NULL, NULL, NULL)`,
    ).run(tenant + '-alice', tenant);
  }
  const manifest = {
    id: 'app',
    name: 'Tenant fixture',
    sources: { business: { connection: binding.source.connection } },
    resources: { item: { physical: 'db_item', owner: 'tenant', access: 'write', fields: { read: ['id', 'name'], write: ['id', 'name'] } } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { rows: 'tenant', roles: { editor: { read: true, write: true } } },
  };
  const app = parseTestApp(manifest, 'fixture');
  let verifies = 0,
    resolves = 0;
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId: 'app',
    storeId: binding.storeId,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows: () => {
      resolves++;
      return { item: true };
    },
    resolveRows: () => {
      resolves++;
      return { item: true };
    },
  });
  const options: Options = {
    app,
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'generation',
    roles: ['editor'],
    maxLifetimeMs: 1000,
    now: () => 100,
    verifySession: (input) => {
      verifies++;
      return input.cookie === 'alice' ? { id: 'alice', who: 'Alice', role: 'global-admin' } : null;
    },
  };
  const deployments: TenantEnrollment<Request>[] = [];
  t.after(async () => {
    await Promise.allSettled(deployments.map((deployment) => deployment.retire()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = async (patch: Partial<Options> = {}) => {
    const deployment = await createTenantEnrollment({ ...options, ...patch });
    deployments.push(deployment);
    return deployment;
  };
  const policyFile = join(dir, 'tenant.mjs');
  writeFileSync(
    policyFile,
    `export default {kind:'tenant',appId:'app',storeId:'private-store',ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows(){return {item:true}},resolveRows(){return {item:true}}}`,
  );
  return { dir, path, db, manifest, options, open, deployments, policyFile, verifies: () => verifies, resolves: () => resolves };
}

test('real enrollment opens one genuine deployment plus independent discovery without invoking host providers at startup', async (t) => {
  const f = fixture(t),
    service = await f.open();
  assert.equal(f.verifies(), 0);
  assert.equal(f.resolves(), 0);
  assert.ok(Object.isFrozen(service));
  assert.deepEqual(Object.keys(service).sort(), [
    'addresses',
    'attachFlagRuntime',
    'deployment',
    'discover',
    'experimentConversionAuthority',
    'names',
    'retire',
    'sandboxes',
  ]);
  assert.equal(captureTenantDeployment(service.deployment), service.deployment);
  const discovered = await service.discover(request);
  assert.deepEqual(JSON.parse(JSON.stringify(discovered)), {
    status: 'ready',
    appId: 'app',
    accountId: 'alice',
    memberships: [{ tenantId: 'north' }, { tenantId: 'south' }],
  });
  assert.deepEqual(await service.discover({ cookie: 'unknown' }), { status: 'signed_out' });
  const result = await service.deployment.withContext(request, ['north'], (context) =>
    context.data.query({ table: 'item', limit: 20, offset: 0 }),
  );
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ['n'],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.sql)), { text: '', params: [] });
  await service.deployment.update(request, ['north'], { table: 'item', key: { id: 'n' }, values: { name: 'Changed' } });
  assert.equal(f.db.prepare("SELECT name FROM db_item WHERE id='n'").get()!.name, 'Changed');
  assert.equal(f.db.prepare("SELECT name FROM db_item WHERE id='s'").get()!.name, 'South');
  await service.retire();
  await assert.rejects(service.discover(request), safe);
  await assert.rejects(service.deployment.withContext(request, ['north'], () => true));
  assert.equal(service.retire(), service.retire());
});

test('file loader captures host App/source/roles before module await and keeps private policy out of DTOs', async (t) => {
  const f = fixture(t),
    input = { ...f.options, source: { ...f.options.source }, roles: [...f.options.roles], policyFile: f.policyFile };
  const { policy: _policy, ...loaded } = input;
  const pending = loadTenantEnrollment(loaded);
  loaded.source.existingPath = join(f.dir, 'wrong.db');
  loaded.source.connection = 'wrong';
  loaded.roles.push('global-admin');
  const service = await pending;
  f.deployments.push(service);
  assert.equal((await service.discover(request)).status, 'ready');
  assert.equal(existsSync(join(f.dir, 'wrong.db')), false);
  assert.equal(JSON.stringify(await service.discover(request)).includes('private-store'), false);
});

test('file loader resolves a source path alias before its first wait', async (t) => {
  const f = fixture(t),
    alias = join(f.dir, 'alias.db');
  symlinkSync(f.path, alias);
  const { policy: _policy, ...options } = f.options;
  const pending = loadTenantEnrollment({ ...options, source: { ...options.source, existingPath: alias }, policyFile: f.policyFile });
  unlinkSync(alias);
  symlinkSync(join(f.dir, 'missing.db'), alias);
  const service = await pending;
  f.deployments.push(service);
  assert.equal((await service.discover(request)).status, 'ready');
  assert.equal(existsSync(join(f.dir, 'missing.db')), false);
});

test('command enrollment attests existing v2 journal and binds captured policy result dependencies', async (t) => {
  const f = fixture(t);
  f.db.exec('ALTER TABLE db_item ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  const app = parseTestApp(
    {
      ...f.manifest,
      resources: {
        item: {
          ...f.manifest.resources.item,
          fields: { read: ['id', 'name', 'version'], write: ['id', 'name', 'version'] },
          actions: { rename: { label: 'Rename', command: { id: 'rename', version: 1, target: 'item', input: {} } } },
        },
      },
      auth: { ...f.manifest.auth, roles: { editor: { read: true, commands: ['rename'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      nav: ['items'],
    },
    'command fixture',
  );
  const rename = () =>
    defineCommand({
      source: 'business',
      target: 'item',
      input: {},
      output: { parse: () => 'n' },
      handle: async ({ db, record }) => {
        await db.item.update(record, { version: 1 });
        return 'n';
      },
    });
  // Past the 256 the enrollment once stopped at: a desk App with a service desk, a CRM and a sales setup registers more.
  const others = Array.from({ length: 299 }, (_, index) => `other${index}`);
  const registry = defineCommands({ rename: rename(), ...Object.fromEntries(others.map((id) => [id, rename()])) });
  const extract = () => [{ table: 'item', key: { id: 'n' } }];
  const policy = defineAppTenantPolicy({
    ...f.options.policy,
    resultReferences: Object.fromEntries(['rename', ...others].map((id) => [id, extract])),
  });
  assert.equal(Object.keys(registry).length, 300);
  await assert.rejects(f.open({ app, policy, commands: { registry } }), safe);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__mistri_command_%'").get()!.n, 0);
  migrateSqliteCommandJournal(f.path); // Explicit fixture maintenance, never enrollment.
  const service = await f.open({ app, policy, commands: { registry } });
  const envelope = {
    command: 'rename',
    commandVersion: 1,
    key: { id: 'n' },
    expectedVersion: 0,
    idempotencyKey: 'enrollment-command',
    input: {},
  };
  await service.deployment.execute(request, ['north'], envelope);
  await service.deployment.execute(request, ['north'], envelope);
  assert.equal(f.db.prepare("SELECT version FROM db_item WHERE id='n'").get()!.version, 1);
  assert.equal(f.db.prepare("SELECT version FROM db_item WHERE id='s'").get()!.version, 0);
  await service.retire();
  // The bound is named, with the count, for the operator; the caller still hears the one sentence.
  const many = Object.fromEntries(Array.from({ length: MAX_COMMAND_IDS + 1 }, (_, index) => [`c${index}`, registry.rename]));
  const refused = await f.open({ app, policy, commands: { registry: many } }).catch((error: unknown) => error);
  assert.ok(safe(refused));
  assert.deepEqual(refusalReasons(refused), [
    `The registry holds ${MAX_COMMAND_IDS + 1} commands; an App registers at most ${MAX_COMMAND_IDS}.`,
  ]);
  // Startup says it before enrollment, in words that reach the terminal and `mistri check`.
  assert.throws(
    () => commandReferencesCheck.run({ app, policy, registry: many } as unknown as TenantStartupCommands),
    (error: unknown) =>
      error instanceof TenantCommandStartupError &&
      error.message === `The --commands registry holds ${MAX_COMMAND_IDS + 1} commands; an App registers at most ${MAX_COMMAND_IDS}.`,
  );
});

test('acquisition failure attempts every owned handle close even when one acknowledgment throws', async (t) => {
  const f = fixture(t),
    close = DatabaseSync.prototype.close;
  const handles = new Set<DatabaseSync>();
  let fault = true;
  const method = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    if (this !== f.db) handles.add(this);
    Reflect.apply(close, this, []);
    if (handles.size === 2 && fault) {
      fault = false;
      throw new Error('PRIVATE_CLOSE_SECRET');
    }
  });
  const app = {
    ...f.options.app,
    auth: {
      ...f.options.app.auth!,
      roles: {
        editor: { read: true, write: true, commands: ['unconfigured'] },
      },
    },
  };
  await assert.rejects(f.open({ app }), safe);
  assert.equal(handles.size, 5, 'scanner, deployment reader, two writer handles, and discovery reader');
  method.mock.restore();
  await (await f.open()).retire();
});

for (const reason of [
  'no marker',
  'source id',
  'connection',
  'app id',
  'store id',
  'missing ownership',
  'unknown ownership',
  'owner column',
  'global only',
  'unknown role',
]) {
  test(`enrollment refuses ${reason} without changing business/store data`, async (t) => {
    const f = fixture(t),
      options = { ...f.options };
    if (reason === 'no marker') options.app = { ...options.app, auth: { ...options.app.auth!, rows: 'all' } };
    if (reason === 'source id') options.source = { ...options.source, id: 'alias' };
    if (reason === 'connection') options.source = { ...options.source, connection: 'alias' };
    if (reason === 'app id') options.policy = { ...options.policy, appId: 'other' };
    if (reason === 'store id') options.policy = { ...options.policy, storeId: 'other' };
    if (reason === 'missing ownership') options.policy = { ...options.policy, ownership: {} };
    if (reason === 'unknown ownership')
      options.policy = { ...options.policy, ownership: { ...options.policy.ownership, hidden: { kind: 'tenant', column: 'tenant_id' } } };
    if (reason === 'owner column') options.policy = { ...options.policy, ownership: { item: { kind: 'tenant', column: 'missing' } } };
    if (reason === 'global only') options.policy = { ...options.policy, ownership: { item: { kind: 'global', access: 'read-only' } } };
    if (reason === 'unknown role') options.roles = ['unknown'];
    await assert.rejects(createTenantEnrollment(options), safe);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM db_item').get()!.n, 2);
    assert.equal(f.db.prepare(`SELECT store_id FROM "${tables.meta}"`).get()!.store_id, 'private-store');
    await (await f.open()).retire();
  });
}

test('existing file only: neither absent files nor stores are provisioned by enrollment', async (t) => {
  const f = fixture(t),
    absent = join(f.dir, 'absent.db');
  await assert.rejects(f.open({ source: { ...f.options.source, existingPath: absent } }), safe);
  assert.equal(existsSync(absent), false);
  const bare = join(f.dir, 'bare.db'),
    db = new DatabaseSync(bare);
  db.exec('CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT)');
  db.close();
  await assert.rejects(f.open({ source: { ...f.options.source, existingPath: bare } }), safe);
  const check = new DatabaseSync(bare);
  try {
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__mistri_%'").get()!.n, 0);
  } finally {
    check.close();
  }
});

test('complete actual catalog must be declared; malformed/unsupported writable tables refuse acquisition', async (t) => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE extra(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)');
  await assert.rejects(f.open(), safe);
  f.db.exec('DROP TABLE extra; CREATE UNIQUE INDEX wrong_unique ON db_item(name)');
  const refused: unknown = await f.open().then(
    () => undefined,
    (error: unknown) => error,
  );
  safe(refused);
  // Opaque to the caller, and still said to the operator: the index, the table and the fix.
  assert.match(refusalReasons(refused).join('\n'), /Unique index "wrong_unique" on "item" does not include tenant column "tenant_id"/);
  f.db.exec('DROP INDEX wrong_unique');
  await (await f.open()).retire();
});

test('a tenant-owned key that keeps neither form is refused with the rule and the fix', async (t) => {
  const reasons = async (ddl: string) => {
    const f = fixture(t);
    f.db.exec(`DROP TABLE db_item; ${ddl}`);
    const refused: unknown = await f.open().then(
      () => undefined,
      (error: unknown) => error,
    );
    safe(refused);
    return refusalReasons(refused).join('\n');
  };
  // SQLite reads a primary key without NOT NULL as nullable: the opaque id the author meant, refused for a missing word.
  const nullable = await reasons('CREATE TABLE db_item(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT)');
  assert.match(
    nullable,
    /primary key includes its ownership column, as PRIMARY KEY \("tenant_id", id\), or is one opaque text id declared NOT NULL/,
  );
  assert.match(nullable, /Its key "id" is TEXT and may be null .*: declare it NOT NULL\./);
  const counted = await reasons('CREATE TABLE db_item(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT)');
  assert.match(counted, /Its key "id" is INTEGER, which counts across every tenant: add "tenant_id" to the key, or key it by a text id\./);
});

test('late deployment validation failure closes acquisitions and leaves the file reusable', async (t) => {
  const f = fixture(t);
  const bad = {
    ...f.options.app,
    auth: {
      ...f.options.app.auth!,
      roles: {
        editor: { read: true, write: true, commands: ['unconfigured'] },
      },
    },
  };
  for (let i = 0; i < 3; i++) await assert.rejects(f.open({ app: bad }), safe);
  f.db.exec('BEGIN EXCLUSIVE; ROLLBACK');
  await (await f.open()).retire();
});

test('captured callbacks/configuration reject proxy/getter hooks without executing them', async (t) => {
  const f = fixture(t);
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('SECRET');
  };
  for (const options of [
    new Proxy(f.options, { get: trap, ownKeys: trap }),
    Object.defineProperty({ ...f.options }, 'source', { get: trap }),
    { ...f.options, source: new Proxy(f.options.source, { get: trap, ownKeys: trap }) },
    { ...f.options, verifySession: new Proxy(f.options.verifySession, { apply: trap }) },
    { ...f.options, now: new Proxy(() => 100, { apply: trap }) },
    { ...f.options, commands: { registry: new Proxy({}, { ownKeys: trap }) } },
  ]) {
    await assert.rejects(createTenantEnrollment(options), safe);
  }
  assert.equal(hooks, 0);
});

test('combined retirement starts both families before waiting for an accepted discovery verifier', async (t) => {
  const f = fixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const service = await f.open({
    verifySession: async () => {
      enter();
      await gate;
      return { id: 'alice', who: 'Alice' };
    },
  });
  const pending = service.discover(request);
  await entered;
  const closing = service.retire();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await assert.rejects(service.deployment.withContext(request, ['north'], () => true));
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await assert.rejects(pending, safe);
  await closing;
});

test('ordinary row-policy deployment and direct HTTP construction refuse tenant markers before acquisition', async (t) => {
  const f = fixture(t);
  let acquired = 0;
  await assert.rejects(
    createAppPolicyDeployment({
      app: f.options.app,
      policy: { appId: 'app', resolveRows: () => ({ item: true }) },
      verifySession: async () => null,
      acquire: async () => {
        acquired++;
        throw new Error('must not acquire');
      },
    }),
  );
  assert.equal(acquired, 0);
  const registry = new Registry();
  t.after(() => registry.closeAll());
  assert.throws(
    () => createApp({ registry, apps: [{ app: { app: f.options.app } } as AppHost], bound: { host: '127.0.0.1', port: 0 } }),
    /Tenant applications are not enabled/,
  );
});

for (const args of [[], ['--mcp'], ['--export', 'types'], [VALIDATE], ['--lint', 'json']])
  test(`ordinary CLI refuses tenant enrollment before transport ${args.join(' ')}`, (t) => {
    const f = fixture(t),
      app = join(f.dir, 'app.json'),
      config = join(f.dir, 'connections.json');
    writeFileSync(app, JSON.stringify(f.manifest));
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'business-db', url: f.path }] }));
    let output = '';
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), '--config', config, '--app', app, ...validating(args).args],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: validating(args, { ...process.env, DATABASE_URL: '', MISTRI_OPEN: '0', XDG_CONFIG_HOME: join(f.dir, 'xdg') }).env,
            stdio: 'pipe',
          },
        ),
      (error) => {
        const failure = error as { status: number; stdout: string; stderr: string };
        // MCP and lint are the database browser's: mistri names that command before it would load the App.
        const browsers = args[0] === '--mcp' || args[0] === '--lint';
        assert.equal(failure.status, browsers ? 2 : 1);
        output = failure.stdout + failure.stderr;
        assert.match(
          output,
          browsers ? /is the database browser's, a command of its own: npx tablewalk/ : /Tenant applications are not enabled/,
        );
        return true;
      },
    );
    assert.doesNotMatch(output, /North|South|Listening on|speaking MCP/);
    assert.equal(readFileSync(app, 'utf8'), JSON.stringify(f.manifest));
  });
