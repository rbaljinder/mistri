import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-schema-lifetime-')),
    path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const adapter = new SqliteAdapter(path),
    other = new SqliteAdapter(path);
  t.after(async () => {
    await adapter.close();
    await other.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, db, adapter, other };
}
test('only exact own physical introspection is accepted; data mutations preserve schema lifetime', async (t) => {
  const f = fixture(t),
    schema = await f.adapter.introspect(),
    current = f.adapter.captureSchemaLifetime(schema);
  current();
  f.db.exec("INSERT INTO item VALUES (1,'a')");
  current();
  assert.throws(() => f.adapter.captureSchemaLifetime({ ...schema }));
  const awaitedForeign = await f.other.introspect();
  assert.throws(() => f.adapter.captureSchemaLifetime(awaitedForeign));
});
test('ordinary committed DDL invalidates old guards and reintrospection produces a new usable schema', async (t) => {
  const f = fixture(t),
    schema = await f.adapter.introspect(),
    current = f.adapter.captureSchemaLifetime(schema);
  f.db.exec('ALTER TABLE item ADD COLUMN rank INTEGER NOT NULL DEFAULT 1');
  assert.throws(current);
  assert.throws(() => f.adapter.captureSchemaLifetime(schema));
  const next = await f.adapter.introspect();
  f.adapter.captureSchemaLifetime(next)();
  assert.ok(next.tables[0].columns.some((column) => column.name === 'rank'));
});
test('DDL between introspection statements refuses a mixed catalog', async (t) => {
  const f = fixture(t),
    prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  const spy = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (!changed && sql.startsWith('PRAGMA table_xinfo(')) {
      changed = true;
      f.db.exec('CREATE TABLE added(id INTEGER PRIMARY KEY)');
    }
    return prepare.call(this, sql);
  });
  await assert.rejects(f.adapter.introspect(), /schema changed during introspection/);
  spy.mock.restore();
  assert.equal(changed, true);
  f.adapter.captureSchemaLifetime(await f.adapter.introspect())();
});
test('closed adapters and replaced native files invalidate retained guards synchronously', async (t) => {
  const f = fixture(t),
    current = f.adapter.captureSchemaLifetime(await f.adapter.introspect());
  renameSync(f.path, join(f.directory, 'original.db'));
  const replacement = new DatabaseSync(f.path);
  replacement.exec('CREATE TABLE item(id INTEGER PRIMARY KEY)');
  replacement.close();
  assert.throws(current);
  await f.adapter.close();
  assert.throws(current);
  // Avoid double-close in fixture teardown without changing adapter semantics.
  t.mock.method(f.adapter, 'close', async () => {});
});
