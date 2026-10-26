import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig, resourceCeiling } from '../packages/mistri/src/shared/app.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import {
  AppTenantPolicyDefinitionError,
  defineAppTenantPolicy,
  type AppTenantPolicy,
} from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { openSqliteTenantAdministration, TenantAdministrationFailure } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import {
  ADMINISTRATION_JOURNAL_TABLES as journal,
  provisionSqliteTenantAdministrationJournal,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { ADMINISTRATION_OPERATIONS, type AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  captureTenantAdministrationEnrollment,
  captureTenantEnrollment,
  createTenantEnrollment,
  loadTenantEnrollment,
  type TenantEnrollment,
  type TenantEnrollmentOptions,
} from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { prepareTenantStartup, TenantStartupError, watchTenantStartup } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

const administration = (): AdministrationPolicy => ({
  id: 'private-operators',
  version: 'v1',
  maxMembershipLifetimeMs: 60_000,
  operators: [{ accountId: 'private-operator', tenants: ['north'], operations: ADMINISTRATION_OPERATIONS, roles: ['reader'] }],
});
const declaration = (admin: AdministrationPolicy | false = administration()): AppTenantPolicy => ({
  kind: 'tenant',
  appId: 'app',
  storeId: 'private-store',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }),
  resolveRows: () => ({ item: true }),
  ...(admin === false ? {} : { administration: admin }),
});
type Options = TenantEnrollmentOptions<IncomingMessage>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Reusable fresh business-only fixture: startup tests must observe auth still
 * absent. The real-native owner test below reuses the existing auth support. */
function fixture(t: TestContext, admin = true, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-administration-startup-'));
  const path = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(path),
    owners: TenantEnrollment<IncomingMessage>[] = [];
  t.after(async () => {
    try {
      await Promise.all(owners.map((owner) => owner.retire()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('one', 'north', 'Original')`);
  const binding = { appId: 'app', source: { id: 'business', connection: 'business-db' }, storeId: 'private-store' };
  provisionSqliteTenantStore(path, binding);
  if (provision) provisionSqliteTenantAdministrationJournal(path, binding);
  const manifest = {
    id: 'app',
    name: 'Administration startup fixture',
    sources: { business: { connection: binding.source.connection } },
    resources: { item: { physical: 'db_item', owner: 'tenant', fields: { read: ['id', 'name'] } } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { store: './auth.db', rows: 'tenant', roles: { reader: { read: true } } },
  };
  const appPath = join(directory, 'app.json');
  writeFileSync(appPath, JSON.stringify(manifest));
  const loaded: LoadedApp = { path: appPath, app: parseAppConfig(manifest, appPath), pages: [], sources: {} };
  const policy = declaration(admin ? administration() : false),
    policyFile = join(directory, 'policy.mjs');
  const writePolicy = (value: AppTenantPolicy) =>
    writeFileSync(
      policyFile,
      `export default {
    ...${JSON.stringify(value)},
    resolveMembershipRows() { throw new Error('PRIVATE_CALLBACK'); },
    resolveRows() { throw new Error('PRIVATE_CALLBACK'); }
  };`,
    );
  writePolicy(policy);
  const connection: ConnectionConfig = { id: binding.source.connection, name: 'Business', url: path, source: 'config', writable: true };
  const startup = { loaded, connections: [connection], policyFile };
  const options: Options = {
    app: loaded.app,
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'private-deployment',
    roles: ['reader'],
    maxLifetimeMs: 12_345,
    now: () => 100,
    verifySession: () => null,
  };
  const open = async (patch: Partial<Options> = {}) => {
    const enrollment = await createTenantEnrollment({ ...options, ...patch });
    owners.push(enrollment);
    return enrollment;
  };
  const noAuth = () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(existsSync(authPath + suffix), false);
  };
  const snapshot = () => {
    const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
    const rows = schema
      .filter((row) => row.type === 'table')
      .map((row) => ({
        name: row.name,
        rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all(),
      }));
    return { schema, rows };
  };
  return {
    directory,
    path,
    db,
    binding,
    loaded,
    policy,
    policyFile,
    writePolicy,
    connection,
    startup,
    options,
    owners,
    open,
    noAuth,
    snapshot,
  };
}

test('server-only policy captures detached, deeply frozen administration without adding public App metadata', (t) => {
  const input = declaration(),
    policy = defineAppTenantPolicy(input);
  assert.deepEqual(plain(policy.administration), administration());
  for (const value of [
    policy,
    policy.administration,
    policy.administration!.operators,
    policy.administration!.operators[0],
    policy.administration!.operators[0].roles,
  ])
    assert.ok(Object.isFrozen(value));
  const original = input.administration!.operators[0].roles as string[];
  original.push('manager');
  assert.deepEqual(policy.administration!.operators[0].roles, ['reader']);
  const f = fixture(t);
  assert.equal(Object.hasOwn(f.loaded.app, 'administration'), false);
  assert.equal(Object.hasOwn(defineAppTenantPolicy(declaration(false)), 'administration'), false);
});

for (const [name, value] of [
  ['explicit undefined', undefined],
  ['null', null],
  ['empty', {}],
  ['unknown field', { ...administration(), path: '/private/request-path' }],
  ['unknown operation', { ...administration(), operators: [{ ...administration().operators[0], operations: ['arbitrarySql'] }] }],
  ['overlapping ceilings', { ...administration(), operators: [...administration().operators, ...administration().operators] }],
] as const)
  test(`strict administration policy refuses ${name}`, () => {
    assert.throws(
      () => defineAppTenantPolicy({ ...declaration(), administration: value } as AppTenantPolicy),
      AppTenantPolicyDefinitionError,
    );
  });

test('policy capture refuses accessors and proxies without invoking their hooks', () => {
  let calls = 0;
  const getter = Object.defineProperty(declaration(false), 'administration', {
    enumerable: true,
    get() {
      calls++;
      return administration();
    },
  });
  const nested = Object.defineProperty(administration(), 'operators', {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  const proxy = new Proxy(administration(), {
    ownKeys() {
      calls++;
      return [];
    },
  });
  for (const value of [getter, { ...declaration(), administration: nested }, { ...declaration(), administration: proxy }]) {
    assert.throws(() => defineAppTenantPolicy(value), AppTenantPolicyDefinitionError);
  }
  assert.equal(calls, 0);
});

test('only genuine active enrollment supplies frozen source-derived options and the shared clock', async (t) => {
  const f = fixture(t),
    alias = join(f.directory, 'alias.db');
  symlinkSync(f.path, alias);
  let instant = 100;
  const input = { ...f.options, source: { ...f.options.source, existingPath: alias }, now: () => instant };
  const pending = createTenantEnrollment(input);
  input.source.existingPath = join(f.directory, 'request.db');
  input.source.connection = 'request-source';
  const enrollment = await pending;
  f.owners.push(enrollment);
  const captured = captureTenantAdministrationEnrollment(enrollment)!;
  assert.ok(captured);
  assert.deepEqual(Object.keys(captured).sort(), ['binding', 'deployment', 'maxLifetimeMs', 'now', 'path', 'policy']);
  assert.equal(captured.path, realpathSync(f.path));
  assert.deepEqual(plain(captured.binding), f.binding);
  assert.equal(captured.deployment, 'private-deployment');
  assert.equal(captured.maxLifetimeMs, 12_345);
  for (const value of [captured, captured.binding, captured.binding.source, captured.policy]) assert.ok(Object.isFrozen(value));
  assert.equal(captured.now, captureTenantEnrollment(enrollment).clock);
  assert.equal(captured.now(), 100);
  instant = 120;
  assert.equal(captureTenantEnrollment(enrollment).clock(), 120);
  instant = 110;
  assert.throws(captured.now, TenantContextError);
  assert.deepEqual(Object.keys(captureTenantEnrollment(enrollment)).sort(), [
    'app',
    'clock',
    'enrollment',
    'events',
    'ownership',
    'pages',
    'source',
  ]);
  // Where its command events are recorded, for its effects (tenantIntegrations.ts): the attested binding's, never the request's.
  assert.deepEqual(plain(captureTenantEnrollment(enrollment).events), { storeId: f.binding.storeId, sourceId: f.binding.source.id });
  assert.ok(Object.isFrozen(captureTenantEnrollment(enrollment).events));
  // The canonical file, as administration holds it: where a tenant App's assistant store is kept.
  assert.deepEqual(captureTenantEnrollment(enrollment).source, { path: realpathSync(f.path) });
  assert.deepEqual(Object.keys(enrollment).sort(), [
    'addresses',
    'attachFlagRuntime',
    'deployment',
    'discover',
    'experimentConversionAuthority',
    'names',
    'retire',
    'sandboxes',
  ]);
  for (const fake of [{ ...enrollment }, Object.create(enrollment), new Proxy(enrollment, {}), {}, null]) {
    assert.throws(() => captureTenantAdministrationEnrollment(fake as typeof enrollment), TenantContextError);
  }
  assert.equal(existsSync(input.source.existingPath), false);
  await enrollment.retire();
  assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
});

test('policy-file enrollment captures canonical source and administration before publication', async (t) => {
  const f = fixture(t),
    alias = join(f.directory, 'alias.db');
  symlinkSync(f.path, alias);
  const { policy: _policy, ...options } = f.options;
  const pending = loadTenantEnrollment({ ...options, source: { ...options.source, existingPath: alias }, policyFile: f.policyFile });
  unlinkSync(alias);
  symlinkSync(join(f.directory, 'missing.db'), alias);
  const enrollment = await pending;
  f.owners.push(enrollment);
  assert.equal(captureTenantAdministrationEnrollment(enrollment)!.path, realpathSync(f.path));
  assert.deepEqual(plain(captureTenantAdministrationEnrollment(enrollment)!.policy), administration());
  f.noAuth();
});

for (const enabled of [true, false])
  test(`retirement invalidates ${enabled ? 'enabled' : 'omitted'} administration capture before pending discovery drains`, async (t) => {
    const f = fixture(t, enabled);
    const entered = deferred(),
      release = deferred();
    const enrollment = await f.open({
      verifySession: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    });
    if (!enabled) assert.equal(captureTenantAdministrationEnrollment(enrollment), undefined);
    const pending = enrollment.discover({} as IncomingMessage);
    const refused = assert.rejects(pending, TenantContextError);
    await entered.promise;
    const retiring = enrollment.retire();
    assert.equal(retiring, enrollment.retire());
    assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
    let drained = false;
    void retiring.then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    release.resolve();
    await refused;
    await retiring;
    assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
  });

for (const writable of [undefined, false, true])
  test(`administration with read-only App grants requires explicit connection writable=${String(writable)}`, async (t) => {
    const f = fixture(t),
      before = f.snapshot();
    assert.deepEqual(resourceCeiling(f.loaded.app).write, []);
    const startup = { ...f.startup, connections: [{ ...f.connection, writable }] };
    if (writable === true) {
      const prepared = await prepareTenantStartup(startup);
      assert.ok(Object.isFrozen(prepared.enrollment));
      const enrollment = await f.open({ ...prepared.enrollment });
      assert.equal(captureTenantAdministrationEnrollment(enrollment)!.deployment, prepared.enrollment.deployment);
    } else
      await assert.rejects(prepareTenantStartup(startup), (error) => {
        assert.ok(error instanceof TenantStartupError);
        assert.match(error.message, /writable: true/);
        return true;
      });
    assert.deepEqual(f.snapshot(), before);
    f.noAuth();
  });

test('late administration enrollment failure closes acquired sources and allows clean retry', async (t) => {
  const f = fixture(t),
    before = f.snapshot();
  const app = {
    ...f.loaded.app,
    auth: { ...f.loaded.app.auth!, roles: { reader: { read: true, write: false, commands: ['unconfigured'] } } },
  };
  await assert.rejects(f.open({ app }), TenantContextError);
  f.db.exec('BEGIN EXCLUSIVE; ROLLBACK');
  const enrollment = await f.open();
  assert.ok(captureTenantAdministrationEnrollment(enrollment));
  assert.deepEqual(f.snapshot(), before);
  f.noAuth();
});

test('administration capture stays invalid when retirement reports a source close failure', async (t) => {
  const f = fixture(t),
    enrollment = await f.open(),
    close = DatabaseSync.prototype.close;
  let closes = 0;
  const mocked = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    Reflect.apply(close, this, []);
    if (++closes === 1) throw new Error('Lost close acknowledgement');
  });
  try {
    const retiring = enrollment.retire();
    assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
    await assert.rejects(retiring);
    assert.equal(enrollment.retire(), retiring);
    assert.equal(closes, 4, 'both readers and both writer handles must be closed');
    assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
  } finally {
    mocked.mock.restore();
    f.owners.splice(f.owners.indexOf(enrollment), 1);
  }
  await (await f.open()).retire();
});

for (const fault of ['missing', 'partial', 'wrong binding', 'extra object'] as const) {
  test(`startup and direct enrollment refuse ${fault} administration journal without repair or auth acquisition`, async (t) => {
    const f = fixture(t, true, fault !== 'missing');
    if (fault === 'partial') f.db.exec(`DROP TABLE "${journal.receipt}"`);
    if (fault === 'wrong binding') f.db.prepare(`UPDATE "${journal.meta}" SET store_id = ?`).run('other-store');
    if (fault === 'extra object') f.db.exec('CREATE TABLE __mistri_admin_unexpected(id TEXT)');
    const before = f.snapshot(),
      bytes = readFileSync(f.path);
    await assert.rejects(prepareTenantStartup(f.startup), (error) => {
      assert.ok(error instanceof TenantStartupError);
      assert.match(error.message, /existing tenant store/);
      assert.doesNotMatch(error.message, /private-|business\.db|__mistri_/);
      return true;
    });
    await assert.rejects(f.open(), TenantContextError);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(readFileSync(f.path), bytes);
    f.noAuth();
    f.db.exec('BEGIN EXCLUSIVE; ROLLBACK');
  });
}

test('ordinary omission requires neither journal nor write opt-in and leaks no server policy through discovery', async (t) => {
  const f = fixture(t, false, false),
    before = f.snapshot();
  const prepared = await prepareTenantStartup({ ...f.startup, connections: [{ ...f.connection, writable: false }] });
  const enrollment = await f.open({ ...prepared.enrollment });
  assert.equal(captureTenantAdministrationEnrollment(enrollment), undefined);
  assert.deepEqual(await enrollment.discover({} as IncomingMessage), { status: 'signed_out' });
  assert.deepEqual(f.snapshot(), before);
  f.noAuth();
});

for (const role of ['native-admin', 'toString'])
  test(`enrollment refuses administration role ceiling outside authored roles: ${role}`, async (t) => {
    const f = fixture(t),
      policy = declaration({ ...administration(), operators: [{ ...administration().operators[0], roles: [role] }] });
    const before = f.snapshot();
    await assert.rejects(f.open({ policy }), TenantContextError);
    f.writePolicy(policy);
    await assert.rejects(prepareTenantStartup(f.startup), TenantStartupError);
    assert.deepEqual(f.snapshot(), before);
    f.noAuth();
  });

test('captured enrollment preserves independent per-operation role ceilings from authored roles', async (t) => {
  const f = fixture(t),
    app = {
      ...f.loaded.app,
      auth: {
        ...f.loaded.app.auth!,
        roles: {
          reader: { read: true, write: false },
          manager: { read: true, write: false },
        },
      },
    };
  const operators: AdministrationPolicy['operators'] = [
    { accountId: 'private-operator', tenants: ['north'], operations: ['replaceMembership'], roles: ['reader'] },
    { accountId: 'private-operator', tenants: ['north'], operations: ['revokeMembership'], roles: ['manager'] },
  ];
  const enrollment = await f.open({ app, roles: ['reader', 'manager'], policy: declaration({ ...administration(), operators }) });
  assert.deepEqual(plain(captureTenantAdministrationEnrollment(enrollment)!.policy!.operators), operators);
});

test('policy watch remains restart-only and never mutates a captured administration policy', async (t) => {
  const f = fixture(t),
    enrollment = await f.open(),
    changed = deferred();
  const close = watchTenantStartup({ loaded: f.loaded, policyFile: f.policyFile }, () => changed.resolve());
  t.after(close);
  /* A watch is armed asynchronously (FSEvents on macOS), so one write made
     right after arming can land before the watch sees anything; late in a
     full run that happened every time. Write until the watch reports: the
     property under test is that a changed policy invalidates, not how fast
     the platform starts watching. */
  let notified = false;
  void changed.promise.then(() => {
    notified = true;
  });
  const deadline = Date.now() + 10_000;
  while (!notified) {
    if (Date.now() > deadline) throw new Error('Policy watch did not invalidate');
    f.writePolicy(declaration({ ...administration(), version: 'v2' }));
    await Promise.race([changed.promise, new Promise((settle) => setTimeout(settle, 250))]);
  }
  assert.equal(captureTenantAdministrationEnrollment(enrollment)!.policy!.version, 'v1');
  await enrollment.retire();
  assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
});

test('genuine enrolled options open a native administration owner with no business membership and reattest on acquisition', async (t) => {
  const f = await tenantAdministrationFixture(t);
  f.db.exec('CREATE TABLE tenant_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  const app = parseAppConfig(
    {
      id: f.binding.appId,
      name: 'Admin enrollment',
      sources: { business: { connection: f.binding.source.connection } },
      resources: {
        item: { physical: 'tenant_item', owner: 'tenant', fields: { read: ['id', 'name'] } },
        business_record: { physical: 'business_record', owner: 'global' },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      auth: { store: f.auth.store, rows: 'tenant', roles: { reader: { read: true } } },
    },
    'native administration enrollment',
  );
  const enrollment = await createTenantEnrollment({
    app,
    policy: {
      ...declaration(),
      appId: app.id,
      storeId: f.binding.storeId,
      ownership: { item: { kind: 'tenant', column: 'tenant_id' }, business_record: { kind: 'global', access: 'read-only' } },
      administration: { ...administration(), operators: [{ ...administration().operators[0], accountId: f.users.operator.accountId }] },
    },
    source: { ...f.binding.source, existingPath: f.path },
    deployment: 'native-deployment',
    roles: ['reader'],
    maxLifetimeMs: 60_000,
    verifySession: f.auth.session,
  });
  f.addCleanup(enrollment.retire);
  const options = captureTenantAdministrationEnrollment(enrollment)!;
  const owner = await openSqliteTenantAdministration({ ...options, auth: f.auth });
  f.addCleanup(owner.retire);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()!.n, 0);
  await owner.retire();
  f.db.prepare(`UPDATE "${journal.meta}" SET store_id = ?`).run('replaced-store');
  await assert.rejects(openSqliteTenantAdministration({ ...options, auth: f.auth }), TenantAdministrationFailure);
  assert.equal(f.db.prepare('SELECT value FROM business_record').get()!.value, 'original');
});
