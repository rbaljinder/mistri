import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { observeSqliteAccountToken } from '../packages/mistri/src/server/auth/sqliteApiTokenObservation.js';

const storeId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
const app = parseAppConfig(
  {
    id: 'app',
    name: 'App',
    resources: { item: {} },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    auth: { store: 'auth.db', signUp: 'open', roles: { reader: { read: true } } },
    api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
  },
  'observation fixture',
);
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
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'SQLite API token observation is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-token-observation-')),
    path = join(directory, 'auth.db');
  let db: DatabaseSync | undefined;
  t.after(() => {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-observation-secret-at-least-thirty-two-characters';
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
  provisionSqliteApiTokenStore(path, { appId: 'app', storeId, exclusions: [] });
  db = new DatabaseSync(path);
  db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)').run(
    'subject',
    'subject',
    'subject@example.test',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    'reader',
  );
  const options = { storeId, exclusions: [], subjectId: 'subject', actorId: 'subject', roles: ['reader'], label: 'Test', expiresAt: 2000 };
  const first = issueSqliteApiToken(path, app, schema, options, 1000);
  const second = issueSqliteApiToken(path, app, schema, { ...options, operations: [] }, 1000);
  return { db, first, second, input: { app, schema, storeId, assertCurrent: () => {} } };
}

test('native token observations verify credentials without granting authority or changing actor on rotation', async (t) => {
  const f = await fixture(t);
  f.db.exec('BEGIN');
  const first = observeSqliteAccountToken(f.db, f.input, f.first.token, 1500);
  const second = observeSqliteAccountToken(f.db, f.input, f.second.token, 1500);
  assert.equal(first.stage, 'token-observation');
  assert.equal(first.authorization, 'pending');
  assert.deepEqual(first.roles, ['reader']);
  assert.ok(first.operations.length > 0);
  assert.deepEqual(second.operations, []);
  assert.deepEqual(first.subject, second.subject);
  assert.notEqual(first.tokenId, second.tokenId);
  assert.equal(JSON.stringify(first).includes(f.first.token), false);
  assert.equal(Object.hasOwn(first, 'digest'), false);
  assert.ok(Object.isFrozen(first));
  for (const [input, credential, now] of [
    [f.input, 'invalid', 1500],
    [f.input, f.first.token, 2000],
    [f.input, f.first.token, 999],
    [f.input, f.first.token.slice(0, 42) + (f.first.token[42] === 'A' ? 'B' : 'A') + f.first.token.slice(43), 1500],
    [{ ...f.input, storeId: '36c77f92-cf69-412d-ade3-3971490fb83a' }, f.first.token, 1500],
    [{ ...f.input, app: { ...app, id: 'other' } }, f.first.token, 1500],
    [
      {
        ...f.input,
        assertCurrent: () => {
          throw new Error('retired');
        },
      },
      f.first.token,
      1500,
    ],
  ] as const)
    assert.throws(() => observeSqliteAccountToken(f.db, input, credential, now), unavailable);
  f.db.exec('ROLLBACK');
  assert.throws(() => observeSqliteAccountToken(f.db, f.input, f.first.token, 1500), unavailable);
});

test('each observation sees current native demotion, bans and token revocation', async (t) => {
  const f = await fixture(t);
  for (const statement of [
    'UPDATE user SET role=NULL',
    'UPDATE user SET banned=1',
    "UPDATE __mistri_api_token SET revoked_at=1400,revoked_by='subject'",
    "UPDATE __mistri_api_token SET digest='" + 'ab'.repeat(32) + "'",
  ]) {
    f.db.exec('BEGIN IMMEDIATE');
    f.db.exec(statement);
    assert.throws(() => observeSqliteAccountToken(f.db, f.input, f.first.token, 1500), unavailable);
    f.db.exec('ROLLBACK');
  }
  f.db.exec('BEGIN');
  let calls = 0;
  assert.throws(
    () =>
      observeSqliteAccountToken(
        f.db,
        {
          ...f.input,
          assertCurrent: () => {
            if (++calls === 3) throw new Error('owner retired during lookup');
          },
        },
        f.first.token,
        1500,
      ),
    unavailable,
  );
  f.db.exec('ROLLBACK');
});
