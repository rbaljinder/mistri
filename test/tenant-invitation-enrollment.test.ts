import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import {
  AppTenantPolicyDefinitionError,
  defineAppTenantPolicy,
  type AppTenantPolicy,
} from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { openSqliteTenantAdministration, TenantAdministrationFailure } from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import {
  ADMINISTRATION_JOURNAL_TABLES,
  provisionSqliteTenantAdministrationJournal,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import type { AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  captureTenantAdministrationEnrollment,
  captureTenantEnrollment,
  createTenantEnrollment,
  loadTenantEnrollment,
  type TenantEnrollment,
  type TenantEnrollmentOptions,
} from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import type { InvitationPolicy } from '../packages/mistri/src/server/tenant/tenantInvitationModel.js';
import { INVITATION_TABLES, provisionSqliteTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { prepareTenantStartup, TenantStartupError } from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

const invitations = (): InvitationPolicy => ({
  id: 'private-inviters',
  version: 'v1',
  maxMembershipLifetimeMs: 60_000,
  maxRedemptionLifetimeMs: 30_000,
  maxPendingPerTenant: 10,
  operators: [{ accountId: 'private-inviter', tenants: ['north'], operations: ['issueInvitation'], roles: ['reader'] }],
});
const administration = (): AdministrationPolicy => ({
  id: 'private-admins',
  version: 'v1',
  maxMembershipLifetimeMs: 60_000,
  operators: [{ accountId: 'private-admin', tenants: ['south'], operations: ['grantMembership'], roles: ['reader'] }],
});
const declaration = (invite: InvitationPolicy | false = invitations()): AppTenantPolicy => ({
  kind: 'tenant',
  appId: 'app',
  storeId: 'private-store',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }),
  resolveRows: () => ({ item: true }),
  ...(invite === false ? {} : { invitations: invite }),
});
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Options = TenantEnrollmentOptions<IncomingMessage>;
type StoreStage = 'none' | 'tenant' | 'administration' | 'invitations';

/** Every store and policy module is disposable and outside shared browser fixtures. */
function fixture(t: TestContext, stage: StoreStage = 'invitations', policy = declaration()) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-invitation-enrollment-'));
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
  if (stage !== 'none') provisionSqliteTenantStore(path, binding);
  if (stage === 'administration' || stage === 'invitations') provisionSqliteTenantAdministrationJournal(path, binding);
  if (stage === 'invitations') provisionSqliteTenantInvitations(path, binding);
  const manifest = {
    id: 'app',
    name: 'Invitation enrollment fixture',
    sources: { business: { connection: binding.source.connection } },
    resources: { item: { physical: 'db_item', owner: 'tenant', fields: { read: ['id', 'name'] } } },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { store: './auth.db', rows: 'tenant', roles: { reader: { read: true } } },
  };
  const appPath = join(directory, 'app.json');
  writeFileSync(appPath, JSON.stringify(manifest));
  const loaded: LoadedApp = { path: appPath, app: parseAppConfig(manifest, appPath), pages: [], sources: {} };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { ...${JSON.stringify(policy)},
    resolveMembershipRows() { throw new Error('PRIVATE_CALLBACK'); },
    resolveRows() { throw new Error('PRIVATE_CALLBACK'); }
  };`,
  );
  const connection: ConnectionConfig = { id: binding.source.connection, name: 'Business', url: path, source: 'config', writable: true };
  const startup = { loaded, connections: [connection], policyFile };
  let callbacks = 0;
  const options: Options = {
    app: loaded.app,
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'private-deployment',
    roles: ['reader'],
    maxLifetimeMs: 12_345,
    now: () => 100,
    verifySession: () => {
      callbacks++;
      return null;
    },
  };
  const open = async (patch: Partial<Options> = {}) => {
    const owner = await createTenantEnrollment({ ...options, ...patch });
    owners.push(owner);
    return owner;
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
    authPath,
    db,
    binding,
    loaded,
    manifest,
    policyFile,
    connection,
    startup,
    options,
    owners,
    open,
    noAuth,
    snapshot,
    callbacks: () => callbacks,
  };
}

test('server-only invitation policy capture is exact, detached and deeply frozen', () => {
  let callbacks = 0;
  const input = {
    ...declaration(),
    resolveRows: () => {
      callbacks++;
      return { item: true as const };
    },
  };
  const captured = defineAppTenantPolicy(input);
  frozen(captured);
  assert.deepEqual(plain(captured.invitations), invitations());
  assert.equal(captured.resolveRows, input.resolveRows);
  assert.equal(callbacks, 0);
  (input.invitations!.operators[0].roles as string[]).push('manager');
  Object.assign(input.invitations!, { version: 'v2' });
  assert.deepEqual(captured.invitations!.operators[0].roles, ['reader']);
  assert.equal(captured.invitations!.version, 'v1');
  assert.equal(Object.isFrozen(input.invitations), false);
  assert.equal(Object.hasOwn(captured, 'administration'), false);
  assert.equal(Object.hasOwn(defineAppTenantPolicy(declaration(false)), 'invitations'), false);
});

test('invitation and administration policy capture never infer each other or combine grants', () => {
  const input = { ...declaration(), administration: administration() },
    policy = defineAppTenantPolicy(input);
  assert.deepEqual(plain(policy.administration), administration());
  assert.deepEqual(plain(policy.invitations), invitations());
  frozen(policy);
  const adminOnly = defineAppTenantPolicy({ ...declaration(false), administration: administration() });
  assert.equal(Object.hasOwn(adminOnly, 'invitations'), false);
});

test('present invitation declarations reject type-invalid, missing, extra and invalid policy data', () => {
  const invalid: unknown[] = [
    undefined,
    null,
    {},
    [],
    true,
    1,
    1n,
    Symbol('policy'),
    'policy',
    () => {},
    { ...invitations(), nativeRole: 'admin' },
    { ...invitations(), operators: [] },
    { ...invitations(), operators: [...invitations().operators, ...invitations().operators] },
    { ...invitations(), operators: [{ ...invitations().operators[0], operations: ['grantMembership'] }] },
    { ...invitations(), operators: [{ ...invitations().operators[0], roles: [] }] },
    { ...invitations(), id: 'bad\0id' },
    { ...invitations(), version: '\uD800' },
    { ...invitations(), maxPendingPerTenant: 0 },
    { ...invitations(), maxRedemptionLifetimeMs: Infinity },
  ];
  for (const key of Object.keys(invitations())) {
    const missing: Record<string, unknown> = { ...invitations() };
    delete missing[key];
    invalid.push(missing);
  }
  for (const value of invalid)
    assert.throws(
      () => defineAppTenantPolicy({ ...declaration(false), invitations: value } as AppTenantPolicy),
      AppTenantPolicyDefinitionError,
    );
});

test('invitation declaration accessors, proxies, symbols and inherited data execute no hooks', () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('PRIVATE_HOOK');
  };
  const proxy = new Proxy(invitations(), { ownKeys: hook, get: hook, getPrototypeOf: hook });
  const revoked = Proxy.revocable(invitations(), {});
  revoked.revoke();
  const input = Object.defineProperty(declaration(false), 'invitations', { enumerable: true, get: hook });
  assert.throws(() => defineAppTenantPolicy(input), AppTenantPolicyDefinitionError);
  for (const value of [
    proxy,
    revoked.proxy,
    Object.create(invitations()),
    { ...invitations(), [Symbol('extra')]: true },
    Object.defineProperty(invitations(), 'operators', { enumerable: true, get: hook }),
    { ...invitations(), operators: [Object.defineProperty({ ...invitations().operators[0] }, 'roles', { enumerable: true, get: hook })] },
    { ...invitations(), operators: [{ ...invitations().operators[0], roles: Object.defineProperty(['reader'], '0', { get: hook }) }] },
    Object.defineProperty(invitations(), 'id', { enumerable: false }),
  ]) {
    assert.throws(() => defineAppTenantPolicy({ ...declaration(false), invitations: value }), AppTenantPolicyDefinitionError);
  }
  assert.equal(calls, 0);
});

for (const mode of ['omitted', 'administration', 'invitations', 'both'] as const) {
  test(`enrollment captures independently configured owner policies: ${mode}`, async (t) => {
    const invite = mode === 'invitations' || mode === 'both',
      admin = mode === 'administration' || mode === 'both';
    const policy = { ...declaration(invite ? invitations() : false), ...(admin ? { administration: administration() } : {}) };
    const f = fixture(t, invite ? 'invitations' : admin ? 'administration' : 'tenant', policy),
      before = f.snapshot();
    const enrollment = await f.open(),
      captured = captureTenantAdministrationEnrollment(enrollment);
    if (!invite && !admin) assert.equal(captured, undefined);
    else {
      assert.ok(captured);
      frozen(captured);
      assert.equal(Object.hasOwn(captured, 'policy'), admin);
      assert.equal(Object.hasOwn(captured, 'invitations'), invite);
      if (admin) assert.deepEqual(plain(captured.policy), administration());
      if (invite) assert.deepEqual(plain(captured.invitations), invitations());
    }
    assert.equal(Object.hasOwn(captureTenantEnrollment(enrollment).app, 'invitations'), false);
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
    assert.equal(f.callbacks(), 0);
    assert.deepEqual(f.snapshot(), before);
    f.noAuth();
    assert.deepEqual(await enrollment.discover({} as IncomingMessage), { status: 'signed_out' });
  });
}

test('invitation-only options are source-derived and captured before caller mutation or publication', async (t) => {
  const f = fixture(t),
    alias = join(f.directory, 'alias.db');
  symlinkSync(f.path, alias);
  let instant = 100;
  const policy = declaration(),
    input = { ...f.options, policy, source: { ...f.options.source, existingPath: alias }, now: () => instant };
  const pending = createTenantEnrollment(input);
  input.source.existingPath = join(f.directory, 'unowned.db');
  input.source.connection = 'unowned';
  (policy.invitations!.operators[0].roles as string[]).push('manager');
  Object.assign(policy.invitations!, { version: 'v2' });
  const enrollment = await pending;
  f.owners.push(enrollment);
  const captured = captureTenantAdministrationEnrollment(enrollment)!;
  assert.deepEqual(Object.keys(captured).sort(), ['binding', 'deployment', 'invitations', 'maxLifetimeMs', 'now', 'path']);
  assert.equal(captured.path, realpathSync(f.path));
  assert.deepEqual(plain(captured.binding), f.binding);
  assert.equal(captured.deployment, 'private-deployment');
  assert.equal(captured.maxLifetimeMs, 12_345);
  assert.deepEqual(plain(captured.invitations), invitations());
  frozen(captured);
  assert.equal(captured.now, captureTenantEnrollment(enrollment).clock);
  assert.equal(captured.now(), 100);
  instant = 120;
  assert.equal(captured.now(), 120);
  instant = 110;
  assert.throws(captured.now, TenantContextError);
  for (const fake of [{ ...enrollment }, Object.create(enrollment), new Proxy(enrollment, {}), {}, null]) {
    assert.throws(() => captureTenantAdministrationEnrollment(fake as typeof enrollment), TenantContextError);
  }
  assert.equal(existsSync(input.source.existingPath), false);
  f.noAuth();
});

test('private file enrollment loads invitations and preserves captured source aliases', async (t) => {
  const f = fixture(t),
    alias = join(f.directory, 'alias.db');
  symlinkSync(f.path, alias);
  const { policy: _policy, ...options } = f.options;
  const pending = loadTenantEnrollment({ ...options, source: { ...options.source, existingPath: alias }, policyFile: f.policyFile });
  unlinkSync(alias);
  symlinkSync(join(f.directory, 'missing.db'), alias);
  const enrollment = await pending;
  f.owners.push(enrollment);
  const captured = captureTenantAdministrationEnrollment(enrollment)!;
  assert.equal(captured.path, realpathSync(f.path));
  assert.deepEqual(plain(captured.invitations), invitations());
  assert.equal(captured.policy, undefined);
  assert.equal(existsSync(join(f.directory, 'missing.db')), false);
  f.noAuth();
});

for (const role of ['native-admin', 'toString', '__proto__'])
  test(`invitation roles must be own authored App roles: ${role}`, async (t) => {
    const f = fixture(t),
      before = f.snapshot();
    const policy = declaration({ ...invitations(), operators: [{ ...invitations().operators[0], roles: [role] }] });
    await assert.rejects(f.open({ policy }), TenantContextError);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.callbacks(), 0);
    f.noAuth();
  });

test('independent invitation operation ceilings retain authored roles without administration operators', async (t) => {
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
  const operators: InvitationPolicy['operators'] = [
    { accountId: 'private-inviter', tenants: ['north'], operations: ['issueInvitation'], roles: ['reader'] },
    { accountId: 'private-inviter', tenants: ['north'], operations: ['reissueInvitation'], roles: ['manager'] },
  ];
  const enrollment = await f.open({ app, roles: ['reader', 'manager'], policy: declaration({ ...invitations(), operators }) });
  const captured = captureTenantAdministrationEnrollment(enrollment)!;
  assert.equal(captured.policy, undefined);
  assert.deepEqual(plain(captured.invitations!.operators), operators);
});

for (const enabled of [true, false])
  test(`retirement invalidates ${enabled ? 'invitation-only' : 'omitted'} capture before discovery drains`, async (t) => {
    const f = fixture(t, enabled ? 'invitations' : 'tenant', declaration(enabled ? invitations() : false));
    const entered = deferred(),
      release = deferred();
    t.after(release.resolve);
    const enrollment = await f.open({
      verifySession: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    });
    const refused = assert.rejects(enrollment.discover({} as IncomingMessage), TenantContextError);
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

for (const [name, stage] of [
  ['tenant', 'none'],
  ['administration', 'tenant'],
  ['invitation', 'administration'],
] as const) {
  test(`missing ${name} storage refuses before writer acquisition and remains unchanged`, async (t) => {
    const f = fixture(t, stage),
      before = f.snapshot(),
      bytes = readFileSync(f.path);
    const writer = t.mock.method(SqliteAdapter.prototype, 'scopeVerifiedTransaction', () => {
      throw new Error('Unexpected writer acquisition');
    });
    await assert.rejects(f.open(), TenantContextError);
    assert.equal(writer.mock.callCount(), 0);
    writer.mock.restore();
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(readFileSync(f.path), bytes);
    f.noAuth();
    f.db.exec('BEGIN EXCLUSIVE; ROLLBACK');
  });
}

for (const [name, tables, partial] of [
  ['tenant', TENANT_TABLES, TENANT_TABLES.membership],
  ['administration', ADMINISTRATION_JOURNAL_TABLES, ADMINISTRATION_JOURNAL_TABLES.receipt],
  ['invitation', INVITATION_TABLES, INVITATION_TABLES.invitation],
] as const)
  for (const fault of ['partial', 'foreign', 'future'] as const) {
    test(`${fault} ${name} storage refuses unchanged before writer acquisition`, async (t) => {
      const f = fixture(t);
      if (fault === 'partial') f.db.exec(`DROP TABLE "${partial}"`);
      if (fault === 'foreign') f.db.prepare(`UPDATE "${tables.meta}" SET store_id = ?`).run('foreign-store');
      if (fault === 'future') {
        // One past whatever each store's current version is: the tenant store is v2.
        f.db.exec(
          `PRAGMA ignore_check_constraints = ON; UPDATE "${tables.meta}" SET version = version + 1; PRAGMA ignore_check_constraints = OFF`,
        );
      }
      const before = f.snapshot(),
        bytes = readFileSync(f.path);
      const writer = t.mock.method(SqliteAdapter.prototype, 'scopeVerifiedTransaction', () => {
        throw new Error('Unexpected writer acquisition');
      });
      await assert.rejects(f.open(), TenantContextError);
      assert.equal(writer.mock.callCount(), 0);
      writer.mock.restore();
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(readFileSync(f.path), bytes);
      f.noAuth();
      f.db.exec('BEGIN EXCLUSIVE; ROLLBACK');
    });
  }

test('linked invitation attestation rejects orphan and inconsistent pending memberships at enrollment', async (t) => {
  const f = fixture(t),
    invitationId = '12345678-1234-4abc-8def-123456789abc',
    membershipId = '12345678-1234-4abc-9def-123456789abc';
  f.db.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('north', 'active', '1', 'tenant')`);
  f.db
    .prepare(`INSERT INTO "${INVITATION_TABLES.invitation}" VALUES (?, '1', 'north', ?, 'recipient', 'inviter',
    'issueInvitation', '["reader"]', '1', 'private-inviters', 'v1', 100, 1000, 2000, 'pending', ?)`)
    .run(invitationId, membershipId, '0'.repeat(64));
  const orphan = f.snapshot();
  await assert.rejects(f.open(), TenantContextError);
  assert.deepEqual(f.snapshot(), orphan);
  f.db
    .prepare(
      `INSERT INTO "${TENANT_TABLES.membership}" VALUES (?, 'north', 'recipient', 'active', '1', '["reader"]', 2000, 'member', NULL, NULL, NULL)`,
    )
    .run(membershipId);
  const active = f.snapshot();
  await assert.rejects(f.open(), TenantContextError);
  assert.deepEqual(f.snapshot(), active);
  f.db.prepare(`UPDATE "${TENANT_TABLES.membership}" SET status = 'invited' WHERE id = ?`).run(membershipId);
  const valid = f.snapshot(),
    enrollment = await f.open();
  assert.ok(captureTenantAdministrationEnrollment(enrollment)!.invitations);
  assert.deepEqual(f.snapshot(), valid);
  f.noAuth();
});

const refusedStartup = (message: RegExp) => (error: unknown) => {
  assert.ok(error instanceof TenantStartupError);
  assert.match(error.message, message);
  assert.doesNotMatch(error.message, /private-inviters|private-store|business\.db|__mistri_|PRIVATE_/);
  /* A wrapped startup failure carries its cause for the operator who started
     the deployment; what a caller is told is the sentence checked above. */
  return true;
};

for (const writable of [undefined, false])
  test(`public startup refuses invitations pre-auth without write opt-in (writable=${String(writable)})`, async (t) => {
    const f = fixture(t),
      before = f.snapshot(),
      bytes = readFileSync(f.path);
    await assert.rejects(
      prepareTenantStartup({ ...f.startup, connections: [{ ...f.connection, writable }] }),
      refusedStartup(/invitation connection write opt-in \(writable: true\)/),
    );
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(readFileSync(f.path), bytes);
    f.noAuth();
  });

test('public startup takes a provisioned invitation policy and hands the host its invitation owner', async (t) => {
  const f = fixture(t),
    before = f.snapshot();
  const prepared = await prepareTenantStartup(f.startup);
  assert.deepEqual(plain(prepared.enrollment.policy.invitations), invitations());
  const enrollment = await f.open({ ...prepared.enrollment });
  assert.deepEqual(plain(captureTenantAdministrationEnrollment(enrollment)?.invitations), invitations());
  assert.equal(captureTenantAdministrationEnrollment(enrollment)?.policy, undefined, 'invitations grant no administration');
  assert.deepEqual(f.snapshot(), before);
  f.noAuth();
});

test('public startup refuses invitations whose storage was never provisioned, and provisions nothing', async (t) => {
  const f = fixture(t, 'administration'),
    before = f.snapshot(),
    bytes = readFileSync(f.path);
  await assert.rejects(prepareTenantStartup(f.startup), refusedStartup(/existing tenant store/));
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(readFileSync(f.path), bytes);
  f.noAuth();
});

for (const grant of ['invitations', 'administration'] as const)
  test(`${grant} may place only tenant-realm roles a person holds in a tenant membership`, async (t) => {
    const f = fixture(t);
    const manifest = {
      ...f.manifest,
      auth: {
        ...f.manifest.auth,
        tenancy: { platform: { label: 'Lender' } },
        roles: {
          reader: { realm: 'tenant', read: true },
          lender: { realm: 'platform', read: true },
          sweeper: { realm: 'tenant', read: true, service: true },
        },
      },
    };
    writeFileSync(f.loaded.path, JSON.stringify(manifest));
    const loaded: LoadedApp = { path: f.loaded.path, app: parseAppConfig(manifest, f.loaded.path), pages: [], sources: {} };
    const policy = (role: string): AppTenantPolicy => ({
      ...declaration(false),
      resolvePlatformRows: () => ({}),
      ...(grant === 'invitations'
        ? { invitations: { ...invitations(), operators: [{ ...invitations().operators[0], roles: [role] }] } }
        : { administration: { ...administration(), operators: [{ ...administration().operators[0], roles: [role] }] } }),
    });
    // One file per role: a policy module, once imported, is cached for the process.
    const write = (role: string) => {
      const file = join(f.directory, `policy-${role}.mjs`);
      writeFileSync(
        file,
        `export default { ...${JSON.stringify(policy(role))},
      resolveMembershipRows() { throw new Error('PRIVATE_CALLBACK'); }, resolveRows() { throw new Error('PRIVATE_CALLBACK'); },
      resolvePlatformRows() { throw new Error('PRIVATE_CALLBACK'); } };`,
      );
      return file;
    };
    const before = f.snapshot();
    // A platform role, and a service role (a job's, never a person's).
    for (const role of ['lender', 'sweeper'])
      await assert.rejects(
        prepareTenantStartup({ ...f.startup, loaded, policyFile: write(role) }),
        refusedStartup(/role ceilings \(this App's tenant-realm roles only, and no service role\)/),
      );
    // The enrollment owner holds the same line when handed a policy directly.
    await assert.rejects(f.open({ app: loaded.app, policy: policy('lender'), roles: ['reader', 'lender'] }), TenantContextError);
    const prepared = await prepareTenantStartup({ ...f.startup, loaded, policyFile: write('reader') });
    await f.open({ ...prepared.enrollment, app: loaded.app });
    assert.deepEqual(f.snapshot(), before);
    f.noAuth();
  });

test('public CLI keeps administration-only startup and ordinary omitted policies working', async (t) => {
  for (const admin of [false, true]) {
    const policy = { ...declaration(false), ...(admin ? { administration: administration() } : {}) };
    const f = fixture(t, admin ? 'administration' : 'tenant', policy),
      before = f.snapshot();
    const prepared = await prepareTenantStartup({ ...f.startup, connections: [{ ...f.connection, writable: admin }] });
    assert.equal(Object.hasOwn(prepared.enrollment.policy, 'invitations'), false);
    const enrollment = await f.open({ ...prepared.enrollment });
    assert.equal(captureTenantAdministrationEnrollment(enrollment)?.invitations, undefined);
    assert.equal(Boolean(captureTenantAdministrationEnrollment(enrollment)?.policy), admin);
    assert.deepEqual(f.snapshot(), before);
    f.noAuth();
  }
});

for (const alias of ['same path', 'hardlink', 'symlink'] as const)
  test(`auth-store separation still precedes policy import: ${alias}`, async (t) => {
    const f = fixture(t),
      authPath = alias === 'same path' ? f.path : join(f.directory, 'auth-alias.db');
    if (alias === 'hardlink') linkSync(f.path, authPath);
    if (alias === 'symlink') symlinkSync(f.path, authPath);
    const before = readFileSync(f.path);
    const loaded = { ...f.loaded, app: { ...f.loaded.app, auth: { ...f.loaded.app.auth!, store: authPath } } };
    await assert.rejects(prepareTenantStartup({ ...f.startup, loaded, policyFile: join(f.directory, 'must-not-load.mjs') }), (error) => {
      assert.ok(error instanceof TenantStartupError);
      assert.match(error.message, /separate authentication store/);
      return true;
    });
    assert.deepEqual(readFileSync(f.path), before);
    f.noAuth();
  });

test('genuine invitation-only enrollment opens the shared native owner without administration or business grants', async (t) => {
  const f = await tenantAdministrationFixture(t);
  f.db.exec('CREATE TABLE tenant_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  provisionSqliteTenantInvitations(f.path, f.binding);
  const loaded: LoadedApp = {
    path: join(f.directory, 'tenant.json'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: f.binding.appId,
        name: 'Invitation enrollment',
        sources: { business: { connection: f.binding.source.connection } },
        resources: {
          item: { physical: 'tenant_item', owner: 'tenant', fields: { read: ['id', 'name'] } },
          business_record: { physical: 'business_record', owner: 'global' },
        },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        auth: { ...f.auth.spec, rows: 'tenant', roles: { reader: { read: true } } },
      },
      'native invitation enrollment',
    ),
  };
  const options = {
    policy: {
      ...declaration(),
      appId: loaded.app.id,
      storeId: f.binding.storeId,
      ownership: {
        item: { kind: 'tenant' as const, column: 'tenant_id' },
        business_record: { kind: 'global' as const, access: 'read-only' as const },
      },
      invitations: { ...invitations(), operators: [{ ...invitations().operators[0], accountId: f.users.operator.accountId }] },
    },
    source: { ...f.binding.source, existingPath: f.path },
    deployment: 'native-invitation-deployment',
    roles: ['reader'],
    maxLifetimeMs: 60_000,
  };
  const enrollment = await createTenantEnrollment({ ...options, app: loaded.app, verifySession: f.auth.session });
  f.addCleanup(enrollment.retire);
  const captured = captureTenantAdministrationEnrollment(enrollment)!;
  assert.equal(captured.policy, undefined);
  const owner = await openSqliteTenantAdministration({ ...captured, auth: f.auth });
  f.addCleanup(owner.retire);
  assert.ok(owner.invitations);
  assert.equal(await owner.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId }), null);
  assert.ok(await owner.invitations.openIssuer(f.users.operator.request, { expectedAccount: f.users.operator.accountId }));
  assert.equal(await owner.invitations.openIssuer(f.users.outsider.request, { expectedAccount: f.users.outsider.accountId }), null);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()!.n, 0);
  await owner.retire();
  await enrollment.retire();
  assert.throws(() => captureTenantAdministrationEnrollment(enrollment), TenantContextError);
  // Reattestation after enrollment prevents captured options adopting a changed store.
  f.db.prepare(`UPDATE "${INVITATION_TABLES.meta}" SET store_id = ?`).run('foreign-store');
  await assert.rejects(openSqliteTenantAdministration({ ...captured, auth: f.auth }), TenantAdministrationFailure);
  await assert.rejects(
    createTenantAuthenticatedHttpServer({
      loaded,
      auth: f.auth,
      enrollment: options,
      bound: { host: '127.0.0.1', port: Number(new URL(f.origin).port) },
    }),
    TenantContextError,
  );
  f.db.prepare(`UPDATE "${INVITATION_TABLES.meta}" SET store_id = ?`).run(f.binding.storeId);
  const host = await createTenantAuthenticatedHttpServer({
    loaded,
    auth: f.auth,
    enrollment: options,
    bound: { host: '127.0.0.1', port: Number(new URL(f.origin).port) },
  });
  f.addCleanup(host.retire);
  assert.equal(host.server.listening, false);
  assert.equal(f.db.prepare('SELECT value FROM business_record').get()!.value, 'original');
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()!.n, 0);
});
