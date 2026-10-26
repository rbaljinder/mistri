import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  assertSqliteCommandEventStore,
  captureCommandEventStoreBinding,
  COMMAND_EVENT_TABLES as tables,
  CommandEventStoreUnavailable,
  hasSqliteCommandEventStore,
  provisionSqliteCommandEventStore,
} from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { isRuntimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const owner = { appId: 'ignition', storeId: 'sample-store', sourceId: 'business' };
function fixture(t: TestContext, journal = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-event-schema-'));
  const path = join(directory, 'business.db');
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("CREATE TABLE application(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO application VALUES(1,'Before')");
  if (journal) migrateSqliteCommandJournal(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    path,
    directory,
    schema: () => db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
    unchanged: () => assert.equal(db.prepare('SELECT name FROM application WHERE id=1').get()!.name, 'Before'),
  };
}

test('event schema provisions only an existing journal source and is repeatable without edits', (t) => {
  const f = fixture(t);
  assert.equal(hasSqliteCommandEventStore(f.db), false);
  assert.throws(() => assertSqliteCommandEventStore(f.db, owner), CommandEventStoreUnavailable);
  assert.deepEqual(provisionSqliteCommandEventStore(f.path, owner), { version: 1, provisioned: true });
  const before = f.schema();
  assert.deepEqual(provisionSqliteCommandEventStore(f.path, owner), { version: 1, provisioned: false });
  assert.deepEqual(f.schema(), before);
  assertSqliteCommandEventStore(f.db, owner);
  f.unchanged();
  for (const name of Object.values(tables)) assert.equal(isRuntimeTable(name), true);
});

test('missing files, directories and sources without the command journal remain untouched', (t) => {
  const f = fixture(t, false),
    missing = join(f.directory, 'missing.db');
  const before = f.schema();
  for (const path of [missing, f.directory, f.path]) {
    assert.throws(() => provisionSqliteCommandEventStore(path, owner), CommandEventStoreUnavailable);
  }
  assert.equal(existsSync(missing), false);
  assert.deepEqual(f.schema(), before);
  f.unchanged();
});

for (const field of ['appId', 'storeId', 'sourceId'] as const) {
  test(`event schema refuses changed ${field} without migrating its bound namespace`, (t) => {
    const f = fixture(t);
    provisionSqliteCommandEventStore(f.path, owner);
    const before = f.schema(),
      other = { ...owner, [field]: 'other' };
    assert.throws(() => assertSqliteCommandEventStore(f.db, other), CommandEventStoreUnavailable);
    assert.throws(() => provisionSqliteCommandEventStore(f.path, other), CommandEventStoreUnavailable);
    assert.deepEqual(f.schema(), before);
    assertSqliteCommandEventStore(f.db, owner);
  });
}

for (const sql of [
  'CREATE TABLE __MISTRI_EVENT_extra(id INTEGER)',
  `CREATE TABLE "${tables.meta}" (singleton INTEGER, version INTEGER)`,
  `CREATE VIEW "${tables.event}" AS SELECT id FROM application`,
])
  test(`colliding event namespace is refused unchanged: ${sql}`, (t) => {
    const f = fixture(t);
    f.db.exec(sql);
    const before = f.schema();
    assert.equal(hasSqliteCommandEventStore(f.db), true);
    assert.throws(() => provisionSqliteCommandEventStore(f.path, owner), CommandEventStoreUnavailable);
    assert.deepEqual(f.schema(), before);
    f.unchanged();
  });

for (const sql of [
  `ALTER TABLE "${tables.event}" ADD COLUMN extra TEXT`,
  `CREATE TRIGGER unrelated_name AFTER INSERT ON "${tables.event}" BEGIN SELECT 1; END`,
  `CREATE TEMP TRIGGER unrelated_name AFTER INSERT ON main."${tables.event}" BEGIN SELECT 1; END`,
  `CREATE TEMP TABLE "${tables.meta}" (id INTEGER)`,
  `CREATE INDEX custom_lookup ON "${tables.event}"(receipt_id)`,
  `DROP TABLE "${tables.event}"`,
  `DELETE FROM "${tables.meta}"`,
  'PRAGMA foreign_keys=OFF',
])
  test(`event schema attestation refuses drift: ${sql}`, (t) => {
    const f = fixture(t);
    provisionSqliteCommandEventStore(f.path, owner);
    f.db.exec(sql);
    assert.throws(() => assertSqliteCommandEventStore(f.db, owner), CommandEventStoreUnavailable);
    f.unchanged();
  });

test('stored NUL cannot be hidden by SQLite TEXT truncation', (t) => {
  const f = fixture(t);
  provisionSqliteCommandEventStore(f.path, owner);
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.prepare(`UPDATE "${tables.meta}" SET store_id=?`).run(`${owner.storeId}\0hidden`);
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.throws(() => assertSqliteCommandEventStore(f.db, owner), CommandEventStoreUnavailable);
});

test('binding capture detaches and freezes scalars without invoking proxies or getters', () => {
  const mutable = { ...owner },
    captured = captureCommandEventStoreBinding(mutable);
  mutable.storeId = 'changed';
  assert.deepEqual(captured, owner);
  assert.ok(Object.isFrozen(captured));
  let hooks = 0;
  const proxy = new Proxy(owner, {
    ownKeys() {
      hooks++;
      return [];
    },
  });
  const getter = {
    ...owner,
    get storeId() {
      hooks++;
      return 'secret';
    },
  };
  for (const value of [proxy, getter]) assert.throws(() => captureCommandEventStoreBinding(value));
  assert.equal(hooks, 0);
});

for (const patch of [
  { storeId: '' },
  { storeId: ' leading' },
  { appId: 'x'.repeat(129) },
  { sourceId: 'business.extra' },
  { storeId: '\uD800' },
  { storeId: 'store\0hidden' },
  { storeId: 'é'.repeat(129) },
  { tenantId: 'north' },
  { path: '/private/file' },
  { appId: undefined },
])
  test(`malformed or provenance-expanding binding is refused: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => captureCommandEventStoreBinding({ ...owner, ...patch } as typeof owner), CommandEventStoreUnavailable);
  });

test('a half-written batch and an event without its receipt are refused', (t) => {
  const f = fixture(t);
  provisionSqliteCommandEventStore(f.path, owner);
  // The batch is the receipt's own manifest, count and digest: all null or all set.
  assert.throws(
    () =>
      f.db
        .prepare(
          `INSERT INTO "${COMMAND_JOURNAL_TABLES.receipt}" (id, app_id, store_id, source_id, realm, tenant_id, actor_id, command_id,
            command_version, idempotency_key, fingerprint, result_json, request_id, completed_at, membership_id, membership_version,
            realm_version, roles_json, deployment, target, owners_json, keys_json, changes_json, manifest_json, event_count, digest)
          VALUES ('half', 'a', 's', 'b', 'tenant', 't', 'x', 'c', 1, 'k', 'f', '{}', 'q', '2026-01-01T00:00:00.000Z', '', '', '', '[]', '',
            'item', '["t"]', '["{}"]', '["[]"]', '[]', NULL, NULL)`,
        )
        .run(),
    /CHECK/,
  );
  assert.throws(
    () => f.db.prepare(`INSERT INTO "${tables.event}" VALUES (?,?,?,?)`).run('event', 'absent-receipt', 0, '{}'),
    /FOREIGN KEY/,
  );
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n, 0);
});
