import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  acquireSqliteApiTokenObservation,
  acquireSqliteApiCommandTokenObservation,
  captureAppAuthRuntime,
  createAppAuth,
} from '../packages/mistri/src/server/auth/auth.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import {
  issueSqliteApiToken,
  issueSqliteApiCommandToken,
  revokeSqliteApiToken,
} from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { observeSqliteAccountToken } from '../packages/mistri/src/server/auth/sqliteApiTokenObservation.js';
import { captureAuthStoreExclusion, type AuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';
const storeId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
const schema: DatabaseSchema = {
  label: 'Local',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
    },
  ],
};
const unavailable = { message: 'Native token observation is unavailable.' };

async function commandFixture(t: TestContext, provision = true) {
  const f = await fixture(t, provision);
  const logical: DatabaseSchema = {
    ...schema,
    tables: ['item', 'reference'].map((id) => ({
      id,
      name: id,
      schema: '',
      isView: false,
      columns: ['id', 'revision'].map((name) => ({ name, type: 'INTEGER', primaryKey: name === 'id', nullable: false })),
    })),
  };
  f.app.sources = { business: { connection: 'business', default: true } };
  f.app.resources!.item.access = 'write';
  f.app.resources!.reference = {};
  f.app.auth!.roles!.reader.commands = ['change'];
  f.app.auth!.roles!.incomplete = { read: ['item'], write: [], commands: ['change'] };
  f.app.api = parseTestApi(
    {
      version: 1,
      roles: ['reader', 'incomplete'],
      resources: { item: { fields: ['id'] } },
      commands: [{ id: 'change', version: 1, target: 'item', input: {} }],
    },
    ['reader', 'incomplete'],
  )!;
  let calls = 0;
  const registry = defineCommands({
    change: defineCommand({
      source: 'business',
      target: 'item',
      read: ['reference'],
      input: {},
      output: shape({ ok: bool() }),
      handle() {
        calls++;
        return { ok: true };
      },
      validate() {
        calls++;
      },
      initial() {
        calls++;
        return {};
      },
      availability() {
        calls++;
        return [];
      },
    }),
  });
  const evidence = { connectionFor: () => 'business', writableConnection: () => true, transactionalConnection: () => true };
  const options = {
    storeId,
    exclusions: [] as AuthStoreExclusion[],
    subjectId: 'account',
    actorId: 'account',
    roles: ['reader'],
    label: 'Command fixture',
    expiresAt: Date.now() + 60000,
  };
  return {
    ...f,
    logical,
    registry,
    evidence,
    options,
    calls: () => calls,
    issueCommand: (extra: Partial<typeof options> & { operations?: readonly string[] } = {}) =>
      issueSqliteApiCommandToken(f.path, f.app, logical, registry, evidence, { ...options, ...extra }, Date.now()),
    acquireCommand: () => acquireSqliteApiCommandTokenObservation(f.runtime, f.app, logical, registry, evidence),
  };
}

test('private command tokens derive actual unified grants while all existing read entrypoints refuse', async (t) => {
  const f = await commandFixture(t),
    token = f.issueCommand(),
    capability = f.acquireCommand();
  const scope = capability.inspect(capability.observe(token.token));
  assert.deepEqual(scope.operations, ['list:item', 'item:item', 'command:change']);
  assert.equal(scope.authorization, 'pending');
  assert.equal(scope.subject.id, 'account');
  const empty = f.issueCommand({ operations: [] }),
    command = f.issueCommand({ operations: ['command:change'] });
  assert.deepEqual(capability.inspect(capability.observe(empty.token)).operations, []);
  assert.deepEqual(capability.inspect(capability.observe(command.token)).operations, ['command:change']);
  assert.notEqual(command.tokenId, token.tokenId);
  assert.throws(f.issue);
  assert.throws(f.acquire);
  const db = new DatabaseSync(f.path);
  try {
    db.exec('BEGIN');
    assert.throws(() =>
      observeSqliteAccountToken(db, { app: f.app, schema: f.logical, storeId, assertCurrent() {} }, token.token, Date.now()),
    );
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
  assert.equal(f.calls(), 0);
  const retained = capability.observe(token.token);
  const expired = t.mock.method(Date, 'now', () => f.options.expiresAt + 1);
  assert.throws(() => capability.inspect(retained));
  assert.throws(() => capability.observe(token.token));
  expired.mock.restore();
  // Both data and evidence containers belong to the caller; captures outlive mutation.
  f.evidence.connectionFor = () => {
    throw new Error('mutated evidence');
  };
  f.app.api!.roles.length = 0;
  assert.deepEqual(capability.inspect(capability.observe(token.token)).operations, scope.operations);
  assert.throws(f.acquireCommand);
  capability.retire();
});

test('command token freshness, rotation, runtime ownership and opaque handles retain native fences', async (t) => {
  const f = await commandFixture(t),
    issued = f.issueCommand(),
    rotated = f.issueCommand(),
    cap = f.acquireCommand();
  const handle = cap.observe(issued.token);
  assert.throws(() => cap.inspect({ ...handle }));
  assert.throws(() => cap.inspect(new Proxy(handle, {})));
  assert.throws(() => acquireSqliteApiCommandTokenObservation({ ...f.runtime }, f.app, f.logical, f.registry, f.evidence));
  assert.throws(() => f.acquireCommand().inspect(handle));
  revokeSqliteApiToken(
    f.path,
    { appId: f.app.id, storeId, exclusions: [], tokenId: issued.tokenId, expectedVersion: '1', actorId: 'account' },
    Date.now(),
  );
  assert.throws(() => cap.observe(issued.token));
  assert.equal(cap.inspect(cap.observe(rotated.token)).subject.id, 'account');
  const db = new DatabaseSync(f.path);
  try {
    db.exec("UPDATE user SET role='incomplete' WHERE id='account'");
    assert.throws(() => cap.observe(rotated.token));
    db.exec("UPDATE user SET role='reader',banned=1 WHERE id='account'");
    assert.throws(() => cap.observe(rotated.token));
    db.exec("UPDATE user SET banned=0 WHERE id='account'");
  } finally {
    db.close();
  }
  cap.retire();
  assert.throws(() => cap.inspect(handle));
  assert.throws(() => cap.observe(rotated.token));
  const next = f.acquireCommand(),
    saved = next.observe(rotated.token);
  f.runtime.close();
  assert.throws(() => next.inspect(saved));
  assert.throws(() => next.observe(rotated.token));
});

test('private command issuance refuses incomplete authority, malformed evidence and missing native layout without provisioning', async (t) => {
  const f = await commandFixture(t);
  const db = new DatabaseSync(f.path);
  try {
    db.exec("UPDATE user SET role='incomplete' WHERE id='account'");
  } finally {
    db.close();
  }
  assert.throws(() => f.issueCommand({ roles: ['incomplete'], operations: ['command:change'] }));
  assert.throws(() => issueSqliteApiCommandToken(f.path, f.app, f.logical, {}, f.evidence, f.options, Date.now()));
  assert.throws(() =>
    issueSqliteApiCommandToken(
      f.path,
      f.app,
      f.logical,
      f.registry,
      { ...f.evidence, transactionalConnection: () => false },
      f.options,
      Date.now(),
    ),
  );
  let calls = 0;
  const hostile = Object.defineProperty({}, 'connectionFor', {
    enumerable: true,
    get() {
      calls++;
      return f.evidence.connectionFor;
    },
  });
  assert.throws(() => acquireSqliteApiCommandTokenObservation(f.runtime, f.app, f.logical, f.registry, hostile as typeof f.evidence));
  assert.equal(calls, 0);
  const changed = structuredClone(f.app);
  changed.api!.commands[0].command.version = 2;
  assert.throws(() => acquireSqliteApiCommandTokenObservation(f.runtime, changed, f.logical, f.registry, f.evidence));
  assert.throws(() => f.issueCommand({ exclusions: [captureAuthStoreExclusion(f.path)] }));
  const absent = await commandFixture(t, false);
  assert.throws(absent.acquireCommand);
  assert.throws(absent.issueCommand);
  const fresh = new DatabaseSync(absent.path);
  try {
    assert.equal(fresh.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='__mistri_api_token'").get()?.n, 0);
  } finally {
    fresh.close();
  }
});
async function fixture(t: TestContext, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-token-binding-')),
    path = join(directory, 'auth.db');
  const app = parseTestApp(
    {
      id: 'app',
      name: 'App',
      resources: { item: {} },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      auth: { store: path, roles: { reader: { read: true } } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
    },
    'fixture',
  );
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-binding-fixture-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  const loaded = { app, path: join(directory, 'app.json'), dir: directory, pages: [], sources: {} };
  let runtime;
  try {
    runtime = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  t.after(() => {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)').run(
    'account',
    'Account',
    'account@example.test',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    'reader',
  );
  db.close();
  if (provision) provisionSqliteApiTokenStore(path, { appId: 'app', storeId, exclusions: [] });
  const issue = () =>
    issueSqliteApiToken(
      path,
      app,
      schema,
      {
        storeId,
        exclusions: [],
        subjectId: 'account',
        actorId: 'account',
        roles: ['reader'],
        label: 'Binding',
        expiresAt: Date.now() + 60000,
      },
      Date.now(),
    );
  return { runtime, app, path, issue, acquire: () => acquireSqliteApiTokenObservation(runtime, app, schema) };
}

test('explicit capability requires extension, never migrates and preserves ordinary native auth', async (t) => {
  const f = await fixture(t, false);
  assert.throws(f.acquire, unavailable);
  assert.deepEqual(
    await captureAppAuthRuntime(f.runtime).lookupEligibleAccountRolesCurrent('account'),
    Object.assign(Object.create(null), { accountId: 'account', roles: ['reader'] }),
  );
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='__mistri_api_token'").get()?.n, 0);
  db.close();
  provisionSqliteApiTokenStore(f.path, { appId: 'app', storeId, exclusions: [] });
  assert.ok(f.acquire());
});

test('genuine binding captures catalog and issues opaque capability-local handles, never session or admission proof', async (t) => {
  const f = await fixture(t),
    other = await fixture(t),
    issued = f.issue();
  const capability = f.acquire(),
    foreign = other.acquire();
  const handle = capability.observe(issued.token),
    observation = capability.inspect(handle);
  assert.ok(Object.isFrozen(capability));
  assert.ok(Object.isFrozen(handle));
  assert.deepEqual(Object.keys(handle), []);
  assert.equal(observation.authorization, 'pending');
  assert.equal(observation.tokenId, issued.tokenId);
  assert.equal(observation.version, '1');
  assert.equal(observation.appId, 'app');
  assert.throws(() => capability.inspect({ ...handle }), unavailable);
  assert.throws(() => foreign.inspect(handle), unavailable);
  assert.throws(() => f.acquire().inspect(handle), unavailable);
  assert.throws(() => captureAppAuthRuntime(f.runtime).assertSessionCurrent(handle as never));
  f.app.api!.resources.item.fields.push('not_a_column');
  assert.equal(capability.inspect(capability.observe(issued.token)).tokenId, issued.tokenId, 'captured catalog is isolated');
  assert.throws(f.acquire, unavailable);
  capability.retire();
  capability.retire();
  assert.throws(() => capability.inspect(handle), unavailable);
  assert.throws(() => capability.observe(issued.token), unavailable);
  assert.ok(await captureAppAuthRuntime(f.runtime).lookupEligibleAccountRolesCurrent('account'), 'retire does not close browser auth');
});

test('runtime/caller forgeries and malformed catalogs refuse without getters; closed runtime invalidates handles', async (t) => {
  const f = await fixture(t),
    issued = f.issue(),
    capability = f.acquire(),
    handle = capability.observe(issued.token);
  let getters = 0;
  const malformed = { ...f.app };
  Object.defineProperty(malformed, 'id', {
    get() {
      getters++;
      return 'app';
    },
    enumerable: true,
  });
  assert.throws(() => acquireSqliteApiTokenObservation(f.runtime, malformed, schema), unavailable);
  assert.throws(() => acquireSqliteApiTokenObservation(f.runtime, new Proxy(f.app, {}), schema), unavailable);
  assert.throws(() => acquireSqliteApiTokenObservation(f.runtime, f.app, new Proxy(schema, {})), unavailable);
  assert.throws(() => acquireSqliteApiTokenObservation({ ...f.runtime }, f.app, schema), unavailable);
  assert.throws(() => acquireSqliteApiTokenObservation(f.runtime, { ...f.app, id: 'other' }, schema), unavailable);
  assert.equal(getters, 0);
  const descriptor = Object.getOwnPropertyDescriptor(f.runtime, 'store')!;
  Object.defineProperty(f.runtime, 'store', {
    get() {
      getters++;
      return 'forged';
    },
    configurable: true,
  });
  assert.throws(() => capability.inspect(handle), unavailable);
  assert.equal(getters, 0);
  Object.defineProperty(f.runtime, 'store', descriptor);
  f.runtime.close();
  assert.throws(() => capability.inspect(handle), unavailable);
  assert.throws(() => capability.observe(issued.token), unavailable);
});

test('metadata pins UUID and inspect remains explicitly nonfresh; fresh observation refuses revocation and expiry', async (t) => {
  const f = await fixture(t),
    issued = f.issue(),
    capability = f.acquire(),
    handle = capability.observe(issued.token);
  revokeSqliteApiToken(
    f.path,
    { appId: 'app', storeId, exclusions: [], tokenId: issued.tokenId, expectedVersion: '1', actorId: 'account' },
    Date.now(),
  );
  assert.equal(capability.inspect(handle).version, '1', 'inspection is not a new token observation');
  assert.throws(() => capability.observe(issued.token), unavailable);
  const db = new DatabaseSync(f.path);
  db.prepare('UPDATE __mistri_api_token_meta SET store_id=?').run('36c77f92-cf69-412d-ade3-3971490fb83a');
  db.close();
  assert.throws(() => capability.observe(issued.token), unavailable);
  const expiry = capability.inspect(handle).expiresAt;
  const clock = t.mock.method(Date, 'now', () => expiry);
  assert.throws(() => capability.inspect(handle), unavailable);
  clock.mock.restore();
});

test('retirement during native observation returns no handle and releases its transaction', async (t) => {
  const f = await fixture(t),
    issued = f.issue(),
    capability = f.acquire();
  const prepare = DatabaseSync.prototype.prepare;
  const spy = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('SELECT id, role,')) capability.retire();
    return prepare.call(this, sql);
  });
  assert.throws(() => capability.observe(issued.token), unavailable);
  spy.mock.restore();
  // A new capability can immediately use the same native connection; the
  // failed observation did not leave a transaction open.
  const next = f.acquire();
  assert.ok(next.inspect(next.observe(issued.token)));
});
