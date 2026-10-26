import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SQLITE_API_TOKEN_DDL, SQLITE_API_TOKEN_TABLES } from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const storeId = '36c77f92-cf69-412d-ade3-3971490fb83a';
const options = () => ({ appId: 'layout', storeId, exclusions: [] });
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'SQLite API token storage could not be provisioned.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-token-provision-'));
  let runtime: AppAuthRuntime | undefined;
  const server = createServer((req, res) => {
    if (!runtime) {
      res.writeHead(503);
      res.end();
      return;
    }
    void runtime.handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    t.mock.restoreAll();
    runtime?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'auth ?雪#.db');
  const start = async () => {
    const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    try {
      process.env.BETTER_AUTH_SECRET = 'synthetic-provision-test-secret-at-least-thirty-two-characters';
      delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
      delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
      runtime = await createAppAuth(
        {
          path: join(directory, 'app.ts'),
          dir: directory,
          pages: [],
          sources: {},
          app: parseAppConfig(
            {
              id: 'layout',
              name: 'Layout',
              auth: { store: path, signUp: 'open' },
              resources: { item: {} },
              views: { items: { kind: 'list', from: 'item' } },
              home: 'items',
            },
            'fixture',
          ),
        },
        { baseURL: origin, trustedOrigins: [origin] },
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    return captureAppAuthRuntime(runtime!);
  };
  const call = (endpoint: string, body: object) =>
    fetch(`${origin}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  const inspect = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const stop = () => {
    runtime?.close();
    runtime = undefined;
  };
  await start();
  return { directory, path, start, stop, call, inspect };
}
const coreRows = (db: DatabaseSync) =>
  ['user', 'account', 'session', 'verification'].map((table) => db.prepare(`SELECT * FROM "${table}" ORDER BY id COLLATE BINARY`).all());

test('explicit provision is idempotent, preserves native accounts and allows cookie login after restart', async (t) => {
  const f = await fixture(t);
  const account = { name: 'Fixture', email: 'provision@example.test', password: 'synthetic-password-for-provision-123' };
  const signup = await f.call('sign-up/email', account);
  assert.equal(signup.status, 200);
  const body = (await signup.json()) as { user: { id: string } };
  f.stop();
  const before = f.inspect(coreRows);
  assert.deepEqual(provisionSqliteApiTokenStore(f.path, options()), { migrated: true, version: 1, appId: 'layout', storeId });
  assert.deepEqual(f.inspect(coreRows), before);
  assert.equal(provisionSqliteApiTokenStore(f.path, options()).migrated, false);
  assert.deepEqual(f.inspect(coreRows), before);
  for (const change of [{ appId: 'another' }, { storeId: '36c77f92-cf69-412d-ade3-3971490fb83b' }]) {
    assert.throws(() => provisionSqliteApiTokenStore(f.path, { ...options(), ...change }), unavailable);
    assert.deepEqual(f.inspect(coreRows), before);
  }
  const binding = await f.start();
  assert.equal((await binding.lookupEligibleAccountRolesCurrent(body.user.id))!.accountId, body.user.id);
  const login = await f.call('sign-in/email', { email: account.email, password: account.password });
  assert.equal(login.status, 200);
  assert.ok(login.headers.getSetCookie().length);
  await login.arrayBuffer();
});

test('missing, business, hardlinked and partial layouts refuse without creating or repairing targets', async (t) => {
  const f = await fixture(t);
  f.stop();
  const missing = join(f.directory, 'missing.db');
  assert.throws(() => provisionSqliteApiTokenStore(missing, options()), unavailable);
  assert.equal(existsSync(missing), false);
  const businessPath = join(f.directory, 'ordinary.db'),
    business = new DatabaseSync(businessPath);
  business.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)');
  business.close();
  assert.throws(() => provisionSqliteApiTokenStore(businessPath, options()), unavailable);
  const exclusion = captureAuthStoreExclusion(f.path),
    alias = join(f.directory, 'business.db');
  linkSync(f.path, alias);
  assert.throws(() => provisionSqliteApiTokenStore(alias, { ...options(), exclusions: [exclusion] }), unavailable);
  const before = f.inspect(coreRows);
  f.inspect((db) => db.exec(SQLITE_API_TOKEN_DDL[0]));
  assert.throws(() => provisionSqliteApiTokenStore(f.path, options()), unavailable);
  assert.deepEqual(f.inspect(coreRows), before);
  assert.equal(
    f.inspect((db) => db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(SQLITE_API_TOKEN_TABLES.token)),
    undefined,
  );
});

test('failure after either DDL or before commit rolls back the entire extension', async (t) => {
  const f = await fixture(t);
  f.stop();
  const before = f.inspect((db) => db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all());
  for (const [point, after] of [
    [SQLITE_API_TOKEN_DDL[1], false],
    [SQLITE_API_TOKEN_DDL[1], true],
    ['COMMIT', false],
  ] as const) {
    const original = DatabaseSync.prototype.exec;
    const stub = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === point && !after) throw new Error('PRIVATE_INJECTED_FAILURE');
      const result = original.call(this, sql);
      if (sql === point) throw new Error('PRIVATE_INJECTED_FAILURE');
      return result;
    });
    assert.throws(() => provisionSqliteApiTokenStore(f.path, options()), unavailable);
    stub.mock.restore();
    assert.deepEqual(
      f.inspect((db) => db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all()),
      before,
    );
  }
  assert.equal(provisionSqliteApiTokenStore(f.path, options()).migrated, true);
});

test('uncertain reply after successful commit recovers by exact idempotent retry, not a rollback claim', async (t) => {
  const f = await fixture(t);
  f.stop();
  const before = f.inspect(coreRows),
    original = DatabaseSync.prototype.exec;
  const stub = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = original.call(this, sql);
    if (sql === 'COMMIT') throw new Error('PRIVATE_LOST_COMMIT_REPLY');
    return result;
  });
  assert.throws(() => provisionSqliteApiTokenStore(f.path, options()), unavailable);
  stub.mock.restore();
  assert.deepEqual(f.inspect(coreRows), before);
  assert.equal(provisionSqliteApiTokenStore(f.path, options()).migrated, false);
});

test('malformed captured exclusions and options refuse before schema changes or accessor execution', async (t) => {
  const f = await fixture(t);
  f.stop();
  const before = f.inspect((db) => db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all());
  let reads = 0;
  const sparse = Array(1);
  for (const raw of [
    {
      ...options(),
      get exclusions() {
        reads++;
        return [];
      },
    },
    { ...options(), exclusions: sparse },
    { ...options(), exclusions: [{}] },
    { ...options(), extra: true },
    { ...options(), appId: ' layout' },
  ]) {
    assert.throws(() => provisionSqliteApiTokenStore(f.path, raw as ReturnType<typeof options>), unavailable);
  }
  assert.equal(reads, 0);
  assert.deepEqual(
    f.inspect((db) => db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all()),
    before,
  );
});

test('identity replacement after acquisition refuses before writing the replacement file', async (t) => {
  const f = await fixture(t);
  f.stop();
  const replacement = join(f.directory, 'replacement.db'),
    displaced = join(f.directory, 'displaced-auth.db');
  const other = new DatabaseSync(replacement);
  other.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
  other.close();
  const original = DatabaseSync.prototype.exec;
  const stub = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = original.call(this, sql);
    if (sql === 'BEGIN IMMEDIATE') {
      renameSync(f.path, displaced);
      renameSync(replacement, f.path);
    }
    return result;
  });
  assert.throws(() => provisionSqliteApiTokenStore(f.path, options()), unavailable);
  stub.mock.restore();
  assert.deepEqual(
    f.inspect((db) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).map((row) => row.name),
    ['unrelated'],
  );
  const old = new DatabaseSync(displaced);
  try {
    assert.equal(old.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(SQLITE_API_TOKEN_TABLES.meta), undefined);
  } finally {
    old.close();
  }
});
