import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appAssignedKey, autoKey, filledKey, isRequired, unformedColumns } from '../packages/engine/src/shared/form.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const folder = mkdtempSync(join(tmpdir(), 'mistri-identity-'));
const file = join(folder, 'catalog.db');
let adapter: SqliteAdapter;
let schema: DatabaseSchema;
const table = (name: string) => schema.tables.find((t) => t.id === name)!;

before(async () => {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE rowid_key (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE asc_key (id INTEGER PRIMARY KEY ASC, note TEXT);
    CREATE TABLE table_desc_key (id INTEGER, note TEXT, PRIMARY KEY(id DESC));
    CREATE TABLE unique_key (id INTEGER PRIMARY KEY UNIQUE, note TEXT);
    CREATE TABLE int_key (id INT PRIMARY KEY NOT NULL, note TEXT);
    CREATE TABLE bigint_key (id BIGINT PRIMARY KEY NOT NULL, note TEXT);
    CREATE TABLE desc_key (id INTEGER PRIMARY KEY DESC NOT NULL, note TEXT);
    CREATE TABLE without_rowid_key (id INTEGER PRIMARY KEY, note TEXT) WITHOUT ROWID;
    CREATE TABLE strict_key (id INT PRIMARY KEY, note TEXT) STRICT;
    CREATE TABLE composite_key (id INTEGER, part INTEGER, PRIMARY KEY(id, part));
    CREATE TABLE defaults_only (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE text_key (id TEXT PRIMARY KEY NOT NULL, note TEXT);
    CREATE TABLE short_text_key (id VARCHAR(12) PRIMARY KEY NOT NULL, note TEXT);
    CREATE TABLE defaulted_text_key (id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))), note TEXT);
    CREATE VIEW projected AS SELECT id, note FROM rowid_key;
  `);
  db.close();
  adapter = new SqliteAdapter(file);
  schema = await adapter.introspect();
});
after(async () => {
  await adapter?.close();
  rmSync(folder, { recursive: true, force: true });
});

test('SQLite reports only real rowid aliases as assigned keys', () => {
  for (const name of ['rowid_key', 'asc_key', 'table_desc_key', 'unique_key']) {
    assert.equal(table(name).columns[0].identity, 'by-default', name);
    assert.equal(table(name).columns[0].nullable, false, name);
    assert.equal(autoKey(table(name)), 'id', name);
    assert.ok(table(name).indexed?.includes('id'), name);
  }
  for (const name of ['int_key', 'bigint_key', 'desc_key', 'without_rowid_key', 'strict_key', 'composite_key', 'projected']) {
    assert.equal(table(name).columns[0].identity, undefined, name);
    assert.equal(autoKey(table(name)), null, name);
  }
});

test('manual integer keys remain required, including WITHOUT ROWID and STRICT tables', async () => {
  for (const name of ['int_key', 'bigint_key', 'desc_key', 'without_rowid_key', 'strict_key']) {
    assert.equal(isRequired(table(name).columns[0], autoKey(table(name))), true, name);
    await assert.rejects(adapter.insert({ table: name, values: { note: 'Missing key' } }), /NOT NULL/);
    const result = await adapter.insert({ table: name, values: { id: 17, note: 'Supplied key' } });
    assert.deepEqual(result.key, { id: 17 });
  }
});

/* A field report: a text key nothing fills was left off the New form and refused by NOT NULL. A tenant App's store fills
   it (app/appAccess.ts) where the table says so (`fillsKey`, appKeyFill.ts), so it is not a column a grant has to write
   before New is offered; a key the catalog fills, one too short for a UUID, or one of another type is not the store's,
   and a table not marked (an App that is not tenant-owned) fills nothing. */
test("a single text key nothing in the catalog fills is a tenant App store's to fill, where the table says so", () => {
  const marked = (name: string) => ({ ...table(name), fillsKey: true as const });
  assert.equal(filledKey(marked('text_key')), 'id');
  assert.equal(appAssignedKey(marked('text_key')), 'id');
  assert.deepEqual(
    unformedColumns(marked('text_key'), (column) => column === 'note'),
    [],
  );
  for (const name of ['short_text_key', 'defaulted_text_key', 'int_key', 'rowid_key', 'composite_key'])
    assert.equal(filledKey(marked(name)), null, name);
  assert.equal(appAssignedKey(marked('defaulted_text_key')), 'id');
  assert.equal(appAssignedKey(marked('int_key')), null);
  assert.deepEqual(
    unformedColumns(marked('short_text_key'), (column) => column === 'note'),
    ['id'],
  );
  // Not marked: nothing is filled, and a grant must write the key.
  assert.equal(filledKey(table('text_key')), null);
  assert.equal(appAssignedKey(table('text_key')), null);
  assert.deepEqual(
    unformedColumns(table('text_key'), (column) => column === 'note'),
    ['id'],
  );
});

test('an explicit default-only insert returns the assigned identity and actual server defaults', async () => {
  const result = await adapter.insert({ table: 'defaults_only', values: {} });
  assert.deepEqual(result.key, { id: 1 });
  assert.equal(result.row?.status, 'new');
  assert.match(String(result.row?.created_at), /^\d{4}-\d{2}-\d{2} /);
  assert.deepEqual(result.applied, {});
  assert.match(result.sql.text, /DEFAULT VALUES RETURNING/);
});
