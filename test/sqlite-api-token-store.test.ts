import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { createSqliteApiTokenStore } from '../packages/mistri/src/server/auth/sqliteApiTokenStore.js';
import { SQLITE_API_TOKEN_TABLES } from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { captureStoredApiToken } from '../packages/mistri/src/server/api/apiTokenStorageContract.js';
const id = '36c77f92-cf69-412d-ade3-3971490fb83a',
  storeId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
const owner = { appId: 'app', storeId };
const token = () => ({
  format: 'twa1',
  digest: 'ab'.repeat(32),
  version: '9007199254740993',
  record: {
    id,
    appId: 'app',
    subject: { kind: 'account', id: 'account' },
    label: 'Automation',
    roles: ['reader'],
    createdAt: 100,
    createdBy: 'operator',
    expiresAt: 8640000000000000,
  },
});
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'SQLite API token storage is unavailable.');
  return true;
};
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-token-rows-')),
    path = join(directory, 'auth.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-token-row-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    const runtime = await createAppAuth(
      {
        path: join(directory, 'app.ts'),
        dir: directory,
        pages: [],
        sources: {},
        app: parseAppConfig(
          {
            id: 'app',
            name: 'App',
            resources: { item: {} },
            views: { items: { kind: 'list', from: 'item' } },
            home: 'items',
            auth: { store: 'auth.db', signUp: 'open', roles: { user: { read: true } } },
          },
          'token storage fixture',
        ),
      },
      { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] },
    );
    runtime.close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  provisionSqliteApiTokenStore(path, { ...owner, exclusions: [] });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  return db;
}
test('private rows: inert factory, exact captured roundtrip, terminal large-revision CAS', async (t) => {
  const db = await fixture(t);
  let observations = 0;
  const store = createSqliteApiTokenStore(db, owner, () => {
    observations++;
  });
  assert.equal(observations, 0);
  assert.throws(() => store.lookup(id), unavailable);
  db.exec('BEGIN IMMEDIATE');
  store.insert(token());
  assert.deepEqual(store.lookup(id), captureStoredApiToken(token()));
  assert.equal(store.lookup(storeId), null);
  assert.throws(() => store.insert(token()), unavailable);
  store.revoke({ tokenId: id, appId: 'app', expectedVersion: '9007199254740993', revokedAt: 200, revokedBy: 'operator' });
  assert.equal(store.lookup(id)?.version, '9007199254740994');
  assert.throws(
    () => store.revoke({ tokenId: id, appId: 'app', expectedVersion: '9007199254740994', revokedAt: 201, revokedBy: 'operator' }),
    unavailable,
  );
  db.exec('COMMIT');
  assert.throws(() => store.lookup(id), unavailable);
});
test('private rows: wrong binding, revoked owner and post-write retirement fail closed with owner rollback', async (t) => {
  const db = await fixture(t);
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => createSqliteApiTokenStore(db, { ...owner, appId: 'other' }, () => {}).lookup(id), unavailable);
  assert.throws(() => createSqliteApiTokenStore(db, owner, () => Promise.resolve()).lookup(id), unavailable);
  assert.throws(
    () =>
      createSqliteApiTokenStore(db, owner, () => {
        throw new Error('retired');
      }).insert(token()),
    unavailable,
  );
  const store = createSqliteApiTokenStore(db, owner, () => {
    if (db.prepare(`SELECT 1 FROM "${SQLITE_API_TOKEN_TABLES.token}"`).get()) throw new Error('retired after insert');
  });
  assert.throws(() => store.insert(token()), unavailable);
  db.exec('ROLLBACK');
  db.exec('BEGIN IMMEDIATE');
  assert.equal(createSqliteApiTokenStore(db, owner, () => {}).lookup(id), null);
  db.exec('ROLLBACK');
});
test('private rows: TEXT bytes reject invalid UTF8 and embedded NUL instead of aliasing', async (t) => {
  const db = await fixture(t);
  db.exec('BEGIN IMMEDIATE');
  const store = createSqliteApiTokenStore(db, owner, () => {});
  store.insert(token());
  db.exec('PRAGMA ignore_check_constraints=ON');
  for (const field of ['subject_id', 'roles_json', 'digest', 'label']) {
    db.exec(`SAVEPOINT corrupt; UPDATE "${SQLITE_API_TOKEN_TABLES.token}" SET ${field}=CAST(x'80' AS TEXT)`);
    assert.throws(() => store.lookup(id), unavailable);
    db.exec('ROLLBACK TO corrupt; RELEASE corrupt');
    db.exec(`SAVEPOINT corrupt; UPDATE "${SQLITE_API_TOKEN_TABLES.token}" SET ${field}=${field} || char(0) || 'suffix'`);
    assert.throws(() => store.lookup(id), unavailable);
    db.exec('ROLLBACK TO corrupt; RELEASE corrupt');
  }
  db.exec(`UPDATE "${SQLITE_API_TOKEN_TABLES.token}" SET token_id=token_id || char(0) || 'suffix'`);
  assert.equal(store.lookup(id), null, 'SQL binary locator must not match truncated ID');
  db.exec('ROLLBACK');
});
test('private rows: snapshots precede owner callbacks; schema drift and foreign App inserts refuse', async (t) => {
  const db = await fixture(t);
  db.exec('BEGIN IMMEDIATE');
  const input = token(),
    store = createSqliteApiTokenStore(db, owner, () => {
      input.record.subject.id = 'changed';
    });
  store.insert(input);
  assert.equal(store.lookup(id)?.record.subject.id, 'account');
  assert.throws(() => store.insert({ ...token(), record: { ...token().record, appId: 'other' } }), unavailable);
  db.exec(`ALTER TABLE "${SQLITE_API_TOKEN_TABLES.token}" ADD COLUMN foreign_column TEXT`);
  assert.throws(() => store.lookup(id), unavailable);
  db.exec('ROLLBACK');
});
test('private rows: native account/actor Unicode boundaries survive actual SQL roundtrip', async (t) => {
  const db = await fixture(t);
  db.exec('BEGIN IMMEDIATE');
  const store = createSqliteApiTokenStore(db, owner, () => {});
  for (const nativeId of ['雪'.repeat(1024), '😀'.repeat(512)]) {
    const input = { ...token(), record: { ...token().record, subject: { kind: 'account', id: nativeId }, createdBy: nativeId } };
    store.insert(input);
    assert.deepEqual(store.lookup(id), captureStoredApiToken(input));
    store.revoke({ tokenId: id, appId: 'app', expectedVersion: token().version, revokedAt: 200, revokedBy: nativeId });
    assert.equal(store.lookup(id)?.record.revokedBy, nativeId);
    db.exec(`DELETE FROM "${SQLITE_API_TOKEN_TABLES.token}"`);
  }
  for (const nativeId of ['雪'.repeat(1025), '😀'.repeat(513)]) {
    assert.throws(
      () => store.insert({ ...token(), record: { ...token().record, subject: { kind: 'account', id: nativeId } } }),
      unavailable,
    );
  }
  db.exec('ROLLBACK');
});
