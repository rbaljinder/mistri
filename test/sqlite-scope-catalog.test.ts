import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, ANSI_STYLE } from '../packages/engine/src/adapters/adapter.js';
import { createScopedTransaction } from '../packages/engine/src/adapters/scoped/scopedTransaction.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { ScopedRelations } from '../packages/engine/src/shared/rowScope.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';

function database(t: TestContext, sql: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON; ${sql}; BEGIN IMMEDIATE`);
  return db;
}

test('fresh writer catalog has main-qualified identities, defaults and no estimates', (t) => {
  const db = database(t, "CREATE TABLE Item (id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'new')");
  const { schema, writable } = readSqliteScopeCatalog(db);
  assert.deepEqual([...writable], ['Item']);
  const item = schema.tables.find((table) => table.id === 'Item')!;
  assert.equal(item.schema, 'main');
  assert.equal(item.name, 'Item');
  assert.equal(item.columns[0].identity, 'by-default');
  assert.equal(item.columns[0].nullable, false);
  assert.equal(item.columns[1].default, "'new'");
  assert.equal(Object.hasOwn(item, 'approxRows'), false);
  const relations = new ScopedRelations(schema, ANSI_STYLE, { Item: true });
  relations.table('Item');
  assert.match(relations.finish().text, /FROM "main"\."Item"/);
});

test('each call sees schema changes instead of retaining a cached catalog', (t) => {
  const db = database(t, 'CREATE TABLE parent (id INTEGER PRIMARY KEY)');
  const before = readSqliteScopeCatalog(db);
  db.exec(`COMMIT;
    ALTER TABLE parent ADD COLUMN name TEXT;
    CREATE TABLE hidden_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    CREATE TRIGGER changed AFTER UPDATE ON parent BEGIN SELECT 1; END;
    BEGIN IMMEDIATE`);
  const after = readSqliteScopeCatalog(db);
  assert.equal(before.schema.tables[0].columns.length, 1);
  assert.equal(before.writable.has('parent'), true);
  assert.equal(after.schema.tables.find((table) => table.id === 'parent')!.columns.length, 2);
  assert.equal(after.writable.has('parent'), false);
  assert.equal(after.schema.foreignKeys[0].from.table, 'hidden_child');
  assert.equal(after.schema.foreignKeys[0].to.table, 'parent');
});

test('implicit composite references use PK ordinal, not column order or rowid', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE parent (left_key TEXT NOT NULL, right_key TEXT NOT NULL, PRIMARY KEY(right_key, left_key)) WITHOUT ROWID;
    CREATE TABLE child (id INTEGER PRIMARY KEY, first TEXT, second TEXT, FOREIGN KEY(first, second) REFERENCES parent)
  `,
  );
  const { schema } = readSqliteScopeCatalog(db);
  assert.deepEqual(schema.foreignKeys[0].from.columns, ['first', 'second']);
  assert.deepEqual(schema.foreignKeys[0].to.columns, ['right_key', 'left_key']);
  const parent = schema.tables.find((table) => table.id === 'parent')!;
  assert.deepEqual(
    parent.columns.map((column) => column.name),
    ['left_key', 'right_key'],
  );
  assert.equal(
    parent.columns.every((column) => column.primaryKey && !column.nullable),
    true,
  );
  const child = schema.tables.find((table) => table.id === 'child')!;
  assert.deepEqual(child.columns[1].references, { table: 'parent', column: 'right_key' });
});

test('FK table and column spellings canonicalize against actual ASCII-case-insensitive identities', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE Parent (ID INTEGER PRIMARY KEY, Code TEXT UNIQUE);
    CREATE TABLE Child (id INTEGER PRIMARY KEY, OwnerCode TEXT, FOREIGN KEY(ownercode) REFERENCES pArEnT(cOdE) ON DELETE SET NULL);
    CREATE TABLE Implicit (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES PARENT)
  `,
  );
  const { schema } = readSqliteScopeCatalog(db);
  const explicit = schema.foreignKeys.find((fk) => fk.from.table === 'Child')!;
  assert.deepEqual(explicit.from, { table: 'Child', columns: ['OwnerCode'] });
  assert.deepEqual(explicit.to, { table: 'Parent', columns: ['Code'] });
  assert.equal(explicit.onDelete, 'set null');
  assert.deepEqual(schema.foreignKeys.find((fk) => fk.from.table === 'Implicit')!.to.columns, ['ID']);
});

test('complete physical FK graph retains unscoped, generated and trigger-blocked children', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE hidden_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
    CREATE TABLE generated_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), computed INTEGER AS (id + 1));
    CREATE TRIGGER hidden_changed AFTER UPDATE ON hidden_child BEGIN SELECT 1; END
  `,
  );
  const { schema, writable } = readSqliteScopeCatalog(db);
  assert.deepEqual(
    schema.foreignKeys
      .filter((fk) => fk.to.table === 'parent')
      .map((fk) => fk.from.table)
      .sort(),
    ['generated_child', 'hidden_child'],
  );
  assert.equal(writable.has('parent'), true, 'Incoming-edge operation refusal belongs to the transaction helper');
  assert.equal(writable.has('hidden_child'), false);
  // A generated column is the database's to write, not a reason to keep its table out of scope (field report R1).
  assert.equal(writable.has('generated_child'), true);
});

test('main and TEMP triggers block only their main-table targets, and a write names them', async (t) => {
  const db = database(
    t,
    `
    CREATE TABLE ordinary (id INTEGER PRIMARY KEY);
    CREATE TABLE main_triggered (id INTEGER PRIMARY KEY);
    CREATE TABLE temp_triggered (id INTEGER PRIMARY KEY);
    CREATE TRIGGER main_action AFTER INSERT ON main_triggered BEGIN SELECT 1; END;
    CREATE TEMP TRIGGER temp_action AFTER INSERT ON main.temp_triggered BEGIN SELECT 1; END
  `,
  );
  const catalog = readSqliteScopeCatalog(db);
  assert.deepEqual([...catalog.writable], ['ordinary']);
  // The refusal names what blocks the table, so its owner knows what to drop or move.
  assert.deepEqual(
    [...(catalog.blockedBy ?? [])],
    [
      ['main_triggered', 'the trigger "main_action"'],
      ['temp_triggered', 'the trigger "temp_action"'],
    ],
  );
  const unused = {} as never;
  const scoped = createScopedTransaction(catalog, unused, unused, unused);
  // The reader is told only that the scope refuses; the reason is the owner's, kept beneath it.
  await assert.rejects(scoped.insert({ table: 'main_triggered', values: { id: 1 } }), (error: unknown) => {
    assert.match(String(refusalCause(error)), /"main_triggered" cannot be written under a row policy: it has the trigger "main_action"/);
    return true;
  });
});

test('same-name TEMP tables and views cannot redirect unqualified writer SQL', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE item (id INTEGER PRIMARY KEY);
    CREATE TABLE other (id INTEGER PRIMARY KEY);
    CREATE TABLE safe (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE ITEM (different TEXT);
    CREATE TEMP VIEW OTHER AS SELECT 1 AS id
  `,
  );
  const { schema, writable } = readSqliteScopeCatalog(db);
  assert.deepEqual([...writable], ['safe']);
  assert.deepEqual(
    schema.tables.find((table) => table.id === 'item')!.columns.map((column) => column.name),
    ['id'],
  );
  assert.equal(
    schema.tables.every((table) => table.schema === 'main'),
    true,
  );
});

test('views, virtual tables and shadow tables remain non-writable; a generated column is, its table is not', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE ordinary (id INTEGER PRIMARY KEY);
    CREATE TABLE generated (id INTEGER PRIMARY KEY, virtual_value INTEGER AS (id + 1), stored_value INTEGER AS (id + 2) STORED);
    CREATE VIEW projection AS SELECT id FROM ordinary;
    CREATE VIRTUAL TABLE search USING fts5(body)
  `,
  );
  const { schema, writable } = readSqliteScopeCatalog(db);
  assert.deepEqual([...writable].sort(), ['generated', 'ordinary']);
  assert.equal(schema.tables.find((table) => table.id === 'projection')!.isView, true);
  assert.deepEqual(
    schema.tables.find((table) => table.id === 'generated')!.columns.map((column) => [column.name, column.writable]),
    [
      ['id', undefined],
      ['virtual_value', false],
      ['stored_value', false],
    ],
  );
  assert.equal(
    schema.tables.some((table) => table.id === 'search_data'),
    true,
  );
  assert.equal(
    schema.tables.find((table) => table.id === 'search')!.columns.some((column) => column.name === 'rank'),
    true,
  );
});

test('rowid identity differs from INTEGER PRIMARY KEY DESC and nullable composite keys', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE ordinary (id INTEGER PRIMARY KEY);
    CREATE TABLE descending (id INTEGER PRIMARY KEY DESC);
    CREATE TABLE nullable_pair (a TEXT, b TEXT, PRIMARY KEY(b, a));
    CREATE TABLE strict_pair (a TEXT, b TEXT, PRIMARY KEY(b, a)) STRICT
  `,
  );
  const { schema } = readSqliteScopeCatalog(db);
  const table = (id: string) => schema.tables.find((table) => table.id === id)!;
  assert.equal(table('ordinary').columns[0].identity, 'by-default');
  assert.equal(table('descending').columns[0].identity, undefined);
  assert.equal(table('descending').columns[0].nullable, true);
  assert.equal(
    table('nullable_pair').columns.every((column) => column.nullable),
    true,
  );
  assert.equal(
    table('strict_pair').columns.every((column) => !column.nullable),
    true,
  );
});

test('disabled foreign keys refuse instead of silently relying on connection defaults', (t) => {
  const db = database(t, 'CREATE TABLE item (id INTEGER PRIMARY KEY)');
  db.exec('COMMIT; PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  assert.throws(() => readSqliteScopeCatalog(db), Refusal);
});

test('unresolved FK tables, columns and implicit cardinality refuse the entire catalog', (t) => {
  for (const sql of [
    'CREATE TABLE child (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES missing(id))',
    'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (owner INTEGER REFERENCES parent(missing))',
    'CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY(a, b)); CREATE TABLE child (owner TEXT REFERENCES parent)',
    'CREATE TABLE parent (a TEXT); CREATE TABLE child (owner TEXT REFERENCES parent)',
  ]) {
    const db = database(t, sql);
    assert.throws(() => readSqliteScopeCatalog(db), Refusal);
  }
});

test('a column in its own key and a composite one keeps both edges and follows its own', (t) => {
  /* A tenant table's ownership column, exactly: one reference to the tenancy
     profile, and its part in the composite key to another tenant-owned row. */
  const db = database(
    t,
    `
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE vehicle (tenant_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (tenant_id, id));
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), vehicle_id TEXT,
      FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicle(tenant_id, id))
  `,
  );
  const { schema } = readSqliteScopeCatalog(db);
  const lead = schema.tables.find((table) => table.id === 'lead')!;
  // The single-column key is the column's own link; the composite one is still an edge.
  assert.deepEqual(lead.columns.find((column) => column.name === 'tenant_id')!.references, { table: 'dealer', column: 'id' });
  assert.deepEqual(lead.columns.find((column) => column.name === 'vehicle_id')!.references, { table: 'vehicle', column: 'id' });
  assert.deepEqual(
    schema.foreignKeys
      .filter((fk) => fk.from.table === 'lead')
      .map((fk) => fk.to.table)
      .sort(),
    ['dealer', 'vehicle'],
  );
});

test('composite keys that name no single link leave the column without one, and every edge stands', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE left_parent (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE right_parent (c TEXT NOT NULL, d TEXT NOT NULL, PRIMARY KEY (c, d));
    CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, shared TEXT NOT NULL, one TEXT, two TEXT,
      FOREIGN KEY (shared, one) REFERENCES left_parent(a, b), FOREIGN KEY (shared, two) REFERENCES right_parent(c, d))
  `,
  );
  const { schema } = readSqliteScopeCatalog(db);
  const child = schema.tables.find((table) => table.id === 'child')!;
  assert.equal(child.columns.find((column) => column.name === 'shared')!.references, undefined);
  assert.equal(schema.foreignKeys.filter((fk) => fk.from.table === 'child').length, 2);
});

test('ambiguous single-column reference metadata refuses rather than choosing a target', (t) => {
  const db = database(
    t,
    `
    CREATE TABLE first_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE second_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (owner INTEGER REFERENCES first_parent(id) REFERENCES second_parent(id))
  `,
  );
  assert.throws(() => readSqliteScopeCatalog(db), Refusal);
});
