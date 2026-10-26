import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { assertSqliteAuthCoreLayout } from '../packages/mistri/src/adapters/auth/sqliteAuthStoreLayout.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

async function fixture(t: TestContext, defaultRole = 'user', before?: (store: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-auth-layout-'));
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const prior = names.map((name) => [name, process.env[name]] as const);
  let runtime: AppAuthRuntime | undefined, db: DatabaseSync | undefined;
  t.after(() => {
    db?.close();
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const loaded = {
    path: join(directory, 'app.ts'),
    dir: directory,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'layout',
        name: 'Layout',
        auth: { store: 'auth.db', signUp: 'open', defaultRole },
        resources: { item: {} },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      },
      'fixture',
    ),
  };
  try {
    process.env.BETTER_AUTH_SECRET = 'synthetic-layout-test-secret-at-least-thirty-two-characters';
    delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
    delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
    const options = { baseURL: 'http://127.0.0.1:4799', trustedOrigins: ['http://127.0.0.1:4799'] };
    await before?.(join(directory, 'auth.db'));
    runtime = await createAppAuth(loaded, options);
    // Reinitialization must retain the exact code-owned current layout.
    runtime.close();
    runtime = await createAppAuth(loaded, options);
    db = new DatabaseSync(runtime.store);
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return db!;
}
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'SQLite authentication layout is unavailable for token maintenance.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
const catalog = (db: DatabaseSync) => db.prepare('SELECT * FROM main.sqlite_schema ORDER BY type, name').all();

test('current actual auth initializer and repeat startup match without writes or role-dependent layouts', async (t) => {
  for (const role of ['user', 'reviewer', 'admin'])
    await t.test(role, async (t) => {
      const db = await fixture(t, role),
        before = catalog(db);
      assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
      db.exec('BEGIN IMMEDIATE');
      assertSqliteAuthCoreLayout(db);
      assert.deepEqual(catalog(db), before);
      assert.equal(db.isTransaction, true);
      db.exec('ROLLBACK');
    });
});

test('foreign objects, shadows, missing constraints and altered native DDL refuse unchanged', async (t) => {
  const db = await fixture(t),
    original = catalog(db);
  const changes = [
    'CREATE TABLE private_extra (id TEXT)',
    'CREATE VIEW private_extra AS SELECT id FROM "user"',
    'CREATE INDEX private_extra ON "user" (name)',
    'CREATE TRIGGER private_extra AFTER INSERT ON "user" BEGIN SELECT 1; END',
    'DROP INDEX account_userId_idx',
    'ALTER TABLE "user" ADD COLUMN private_extra TEXT',
    'ALTER TABLE "user" RENAME TO "USER_old"',
    'CREATE TEMP TABLE "user" (id TEXT)',
    'CREATE TEMP VIEW private_extra AS SELECT 1',
    'CREATE TABLE __mistri_api_token_meta (version INTEGER)',
    // The account-administration trail is part of the layout, append-only guard and all.
    'DROP TRIGGER "accountAudit_no_delete"',
    'DROP TABLE "accountAudit"',
    'CREATE TABLE "accountAudit_archive" (id TEXT)',
  ];
  for (const change of changes)
    await t.test(change.split(' ').slice(0, 4).join(' '), () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(change);
        const before = catalog(db);
        assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
        assert.deepEqual(catalog(db), before);
        assert.equal(db.isTransaction, true);
      } finally {
        db.exec('ROLLBACK');
      }
      assert.deepEqual(catalog(db), original);
    });
  db.exec("ATTACH DATABASE ':memory:' AS extra");
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
  } finally {
    db.exec('ROLLBACK');
    db.exec('DETACH DATABASE extra');
  }
});

test('lookalike business layout and retired handle do not qualify as native core', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE session (id TEXT PRIMARY KEY); BEGIN IMMEDIATE');
    const before = catalog(db);
    assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
    assert.deepEqual(catalog(db), before);
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
  assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
});

test('reconstructed actual DDL refuses weakened native constraints', async (t) => {
  const source = await fixture(t);
  const ddl = catalog(source)
    .filter((row) => typeof row.sql === 'string')
    .sort((a, b) => Number(a.type === 'index') - Number(b.type === 'index'));
  for (const [label, from, to] of [
    ['baseline', '', ''],
    ['not null', '"name" text not null', '"name" text'],
    ['unique', '"email" text not null unique', '"email" text not null'],
    ['primary key', '"id" text not null primary key', '"id" text not null'],
    ['foreign key', ' references "user" ("id") on delete cascade', ''],
    ['delete cascade', ' on delete cascade', ''],
  ])
    await t.test(label, () => {
      const db = new DatabaseSync(':memory:');
      let changed = false;
      try {
        for (const row of ddl) {
          let sql = row.sql as string;
          if (from && !changed && sql.includes(from)) {
            sql = sql.replace(from, to);
            changed = true;
          }
          db.exec(sql);
        }
        assert.equal(changed, label !== 'baseline');
        const before = catalog(db);
        // A deferred transaction is sufficient for this structural prerequisite;
        // it does not attest to a maintenance owner's write reservation.
        db.exec('BEGIN');
        if (changed) assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
        else assertSqliteAuthCoreLayout(db);
        assert.deepEqual(catalog(db), before);
        assert.equal(db.isTransaction, true);
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    });
});

test('SQL-side catalog NUL checks refuse hidden suffixes without rewriting catalog bytes', async (t) => {
  const db = await fixture(t);
  // This handle belongs only to the disposable fixture. Newer Node versions
  // default to defensive mode; older versions may not expose this method.
  const defensive = (db as DatabaseSync & { enableDefensive?: (enabled: boolean) => void }).enableDefensive;
  const bytes = () => db.prepare('SELECT hex(type), hex(name), hex(tbl_name), hex(sql) FROM main.sqlite_schema ORDER BY rowid').all();
  try {
    defensive?.call(db, false);
    db.exec('PRAGMA writable_schema=ON');
    if (db.prepare('PRAGMA writable_schema').get()?.writable_schema !== 1) {
      t.skip('This SQLite build does not permit writable_schema');
      return;
    }
    for (const field of ['type', 'name', 'tbl_name', 'sql'])
      await t.test(field, () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          // Catalog mutation only: do not reload the schema or claim these bytes
          // describe the connection's already-cached executable table layout.
          db.prepare(`UPDATE main.sqlite_schema SET ${field} = ${field} || char(0) || 'hidden' WHERE name = 'user'`).run();
          assert.equal(db.prepare(`SELECT count(*) AS n FROM main.sqlite_schema WHERE instr(${field}, char(0)) > 0`).get()?.n, 1);
          const before = bytes();
          assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
          assert.deepEqual(bytes(), before);
          assert.equal(db.isTransaction, true);
        } finally {
          db.exec('ROLLBACK');
        }
      });
  } finally {
    try {
      db.exec('PRAGMA writable_schema=OFF');
    } finally {
      defensive?.call(db, true);
    }
  }
});

test('matching native DDL without foreign-key enforcement refuses', async (t) => {
  const db = await fixture(t),
    before = catalog(db);
  db.exec('PRAGMA foreign_keys=OFF');
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 0);
  db.exec('BEGIN');
  try {
    assert.throws(() => assertSqliteAuthCoreLayout(db), unavailable);
    assert.deepEqual(catalog(db), before);
    assert.equal(db.isTransaction, true);
  } finally {
    db.exec('ROLLBACK');
  }
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  try {
    assertSqliteAuthCoreLayout(db);
  } finally {
    db.exec('ROLLBACK');
  }
});

test('a file of the layout before the account-administration trail is refused, and startup brings it up with its accounts', async (t) => {
  let earlier: unknown[] = [];
  const db = await fixture(t, 'user', async (store) => {
    // The previous build's startup: Better Auth's own migration, the admin plugin alone.
    const file = new DatabaseSync(store);
    try {
      const { admin } = await import('better-auth/plugins');
      const { getMigrations } = await import('better-auth/db/migration');
      await (
        await getMigrations({
          database: file,
          emailAndPassword: { enabled: true },
          plugins: [admin({ defaultRole: 'user' })],
          secret: process.env.BETTER_AUTH_SECRET,
          baseURL: 'http://127.0.0.1:1',
          telemetry: { enabled: false },
        } as never)
      ).runMigrations();
      file.exec(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
        VALUES ('kept', 'Kept', 'kept@example.org', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'user')`);
      earlier = catalog(file);
      assert.equal(
        earlier.some((row) => (row as { name: string }).name === 'accountAudit'),
        false,
      );
      file.exec('BEGIN IMMEDIATE');
      try {
        assert.throws(() => assertSqliteAuthCoreLayout(file), unavailable);
      } finally {
        file.exec('ROLLBACK');
      }
    } finally {
      file.close();
    }
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    assertSqliteAuthCoreLayout(db);
  } finally {
    db.exec('ROLLBACK');
  }
  const names = catalog(db)
    .filter((row) => (row as { tbl_name: string }).tbl_name === 'accountAudit')
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(names.sort(), [
    'accountAudit',
    'accountAudit_createdAt_idx',
    'accountAudit_no_delete',
    'accountAudit_no_update',
    'accountAudit_targetId_idx',
    'sqlite_autoindex_accountAudit_1',
  ]);
  /* The trail's objects, and the version row that serving gives a file it had to bring up; layout 3's identity
     tables (the IdP session index, the SCIM directory) come with the same bring-up and are counted apart. */
  const identity = catalog(db).filter((row) => /^(idpSession|scim)/.test((row as { tbl_name: string }).tbl_name));
  assert.ok(identity.length > 0, 'bring-up stopped short of layout 3');
  assert.equal(catalog(db).length - identity.length, earlier.length + names.length + 1);
  assert.deepEqual(
    db
      .prepare('SELECT email FROM "user"')
      .all()
      .map((row) => row.email),
    ['kept@example.org'],
  );
});
