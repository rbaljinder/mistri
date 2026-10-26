import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import {
  inspectSqliteApiToken,
  issueSqliteApiToken,
  revokeSqliteApiToken,
} from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { matchesApiTokenSecret } from '../packages/mistri/src/server/api/apiTokenSecret.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
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
const app = parseAppConfig(
  {
    id: 'app',
    name: 'App',
    resources: { item: {} },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { store: 'auth.db', signUp: 'open', roles: { reader: { read: true }, dormant: { read: false } } },
    api: { version: 1, roles: ['reader', 'dormant'], resources: { item: { fields: ['id'] } } },
  },
  'maintenance fixture',
);
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'SQLite API token maintenance is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
async function fixture(t: TestContext, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-token-maintenance-')),
    path = join(directory, 'auth ?雪#.db');
  let db: DatabaseSync | undefined;
  t.after(() => {
    t.mock.restoreAll();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-token-maintenance-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    const runtime = await createAppAuth(
      { path: join(directory, 'app.ts'), dir: directory, pages: [], sources: {}, app: { ...app, auth: { ...app.auth!, store: path } } },
      { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] },
    );
    runtime.close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (provision) provisionSqliteApiTokenStore(path, { appId: 'app', storeId, exclusions: [] });
  db = new DatabaseSync(path);
  for (const [id, role] of [
    ['subject', 'reader,dormant'],
    ['actor', null],
  ]) {
    db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)').run(
      id,
      id,
      id + '@example.test',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      role,
    );
  }
  const options = {
    storeId,
    exclusions: [],
    subjectId: 'subject',
    actorId: 'actor',
    roles: ['reader'],
    label: 'Automation',
    expiresAt: 2000,
  };
  return {
    db,
    directory,
    path,
    options,
    issue: () => issueSqliteApiToken(path, app, schema, options, 1000),
    rows: () => db!.prepare('SELECT * FROM __mistri_api_token ORDER BY token_id').all(),
    revoke: (tokenId: string, expectedVersion = '1') =>
      revokeSqliteApiToken(path, { appId: 'app', storeId, exclusions: [], tokenId, expectedVersion, actorId: 'actor' }, 1500),
  };
}
test('operator issuance commits only digest, exact roles and NULL versus empty operation scope', async (t) => {
  const f = await fixture(t),
    issued = f.issue(),
    stored = f.rows()[0];
  assert.ok(Object.isFrozen(issued));
  assert.equal(stored.token_id, issued.tokenId);
  assert.equal(stored.operations_json, null);
  assert.equal(stored.roles_json, '["reader"]');
  assert.ok(matchesApiTokenSecret('app', issued.tokenId, issued.token, stored.digest));
  assert.ok(!JSON.stringify(stored).includes(issued.token));
  const empty = issueSqliteApiToken(f.path, app, schema, { ...f.options, operations: [] }, 1000);
  assert.equal(f.rows().find((row) => row.token_id === empty.tokenId)?.operations_json, '[]');
  const dormant = issueSqliteApiToken(f.path, app, schema, { ...f.options, roles: ['dormant'] }, 1000);
  assert.equal(f.rows().find((row) => row.token_id === dormant.tokenId)?.roles_json, '["dormant"]');
});
test('current subject/actor and exact requested catalog scope refuse without grants or defaults', async (t) => {
  const f = await fixture(t),
    operation = checkApiReadCatalog(app.api!, app, schema).operations[0].id;
  for (const change of [
    { roles: [] },
    { roles: ['admin'] },
    { roles: ['reader', 'admin'] },
    { operations: ['missing'] },
    { roles: ['dormant'], operations: [operation] },
    { subjectId: 'missing' },
    { actorId: 'missing' },
    { expiresAt: 1000 },
  ]) {
    assert.throws(() => issueSqliteApiToken(f.path, app, schema, { ...f.options, ...change }, 1000), unavailable);
  }
  for (const id of ['subject', 'actor']) {
    f.db.prepare('UPDATE "user" SET banned=1 WHERE id=?').run(id);
    assert.throws(f.issue, unavailable);
    f.db.prepare('UPDATE "user" SET banned=0 WHERE id=?').run(id);
  }
  f.db.prepare('UPDATE "user" SET role=NULL WHERE id=?').run('subject');
  assert.throws(f.issue, unavailable);
  assert.equal(f.rows().length, 0);
});
test('revoke survives subject demotion/API removal but is exact terminal version CAS', async (t) => {
  const f = await fixture(t),
    issued = f.issue();
  f.db.prepare('UPDATE "user" SET role=NULL,banned=1 WHERE id=?').run('subject');
  assert.throws(() => f.revoke(issued.tokenId, '2'), unavailable);
  assert.equal(f.rows()[0].revoked_at, null);
  assert.deepEqual(f.revoke(issued.tokenId), { tokenId: issued.tokenId, version: '2' });
  assert.equal(f.rows()[0].revoked_by, 'actor');
  assert.equal(f.rows()[0].revoked_at, 1500);
  assert.throws(() => f.revoke(issued.tokenId, '2'), unavailable);
});
test('preprovisioned binding/exclusions required; absent file never created', async (t) => {
  const f = await fixture(t, false);
  assert.throws(f.issue, unavailable);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='__mistri_api_token'").get()?.n, 0);
  provisionSqliteApiTokenStore(f.path, { appId: 'app', storeId, exclusions: [] });
  assert.throws(
    () => issueSqliteApiToken(f.path, app, schema, { ...f.options, storeId: '36c77f92-cf69-412d-ade3-3971490fb83a' }, 1000),
    unavailable,
  );
  assert.throws(
    () => issueSqliteApiToken(f.path, app, schema, { ...f.options, exclusions: [captureAuthStoreExclusion(f.path)] }, 1000),
    unavailable,
  );
  const missing = join(f.directory, 'missing.db');
  assert.throws(() => issueSqliteApiToken(missing, app, schema, f.options, 1000), unavailable);
  assert.equal(existsSync(missing), false);
  assert.equal(f.rows().length, 0);
});
test('final native role recheck rolls back an already inserted digest', async (t) => {
  const f = await fixture(t),
    prepare = DatabaseSync.prototype.prepare;
  let reads = 0;
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('SELECT id, role,') && ++reads === 3) prepare.call(this, 'UPDATE "user" SET role=NULL WHERE id=?').run('subject');
    return prepare.call(this, sql);
  });
  assert.throws(f.issue, unavailable);
  mock.mock.restore();
  assert.equal(reads, 4);
  assert.equal(f.rows().length, 0);
  assert.equal(f.db.prepare('SELECT role FROM "user" WHERE id=?').get('subject')?.role, 'reader,dormant');
});
test('COMMIT failure never returns secret; uncertain committed response is not retried', async (t) => {
  const f = await fixture(t),
    exec = DatabaseSync.prototype.exec;
  for (const committed of [false, true]) {
    let commits = 0;
    const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') {
        commits++;
        if (committed) exec.call(this, sql);
        throw new Error('PRIVATE commit uncertainty');
      }
      return exec.call(this, sql);
    });
    assert.throws(f.issue, unavailable);
    mock.mock.restore();
    assert.equal(commits, 1);
    assert.equal(f.rows().length, committed ? 1 : 0);
  }
});

test('preselected locator reconciles uncertain issuance without exposing stored credentials or overwriting', async (t) => {
  const f = await fixture(t),
    tokenId = '17bedb31-6ac0-45f4-a533-8ab76b75df6a';
  const options = { appId: 'app', storeId, exclusions: [], tokenId };
  assert.equal(inspectSqliteApiToken(f.path, options), null);
  for (const invalid of [null, 'bad', tokenId.toUpperCase()]) {
    assert.throws(
      () => issueSqliteApiToken(f.path, app, schema, { ...f.options, tokenId: invalid as unknown as string }, 1000),
      unavailable,
    );
  }
  assert.equal(f.rows().length, 0);
  const exec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT') throw new Error('PRIVATE lost commit reply');
    return result;
  });
  assert.throws(() => issueSqliteApiToken(f.path, app, schema, { ...f.options, tokenId }, 1000), unavailable);
  mock.mock.restore();
  const observed = inspectSqliteApiToken(f.path, options)!;
  assert.deepEqual(Object.keys(observed), ['record', 'version']);
  assert.equal(observed.record.id, tokenId);
  assert.equal(observed.version, '1');
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.record));
  const previous = f.rows();
  assert.ok(!JSON.stringify(observed).includes(String(previous[0].digest)));
  assert.throws(() => issueSqliteApiToken(f.path, app, schema, { ...f.options, tokenId }, 1000), unavailable);
  assert.deepEqual(f.rows(), previous);
  f.revoke(tokenId, observed.version);
  assert.equal(inspectSqliteApiToken(f.path, options)?.record.revokedAt, 1500);
  assert.throws(() => inspectSqliteApiToken(f.path, { ...options, appId: 'another' }), unavailable);
});
