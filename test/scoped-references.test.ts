/**
 * A scoped write's parent check on SQLite, compared as SQLite's own foreign
 * key compares (scopedTransaction.ts parentChecks, sqliteScopeCatalog.ts).
 *
 * The check reads the parent a written reference points at under the
 * principal's rows, with the value the column will store. SQLite's foreign
 * key applies the parent's affinity to the child's stored value, which no
 * read before the write can reproduce across affinities: a REAL reference to
 * a TEXT key given "7" was checked as "7", stored as 7.0, and found the
 * hidden "7.0". A scoped write that sets a reference whose two sides differ in
 * affinity is refused. What the check cannot judge before the write — a
 * reference the write names only in part — is left to the database, whose
 * refusal is said as the check's, so a missing parent and a hidden one answer
 * alike.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Filter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
/** Tenant a's rows of each table named. */
const ofA = (...tables: string[]): RowScope => Object.fromEntries(tables.map((table) => [table, eq('tenant', 'a')]));
const REFUSED = 'ScopeRefusal: This operation is not available in the current row scope.';
/** node:sqlite's rows have no prototype; deepEqual compares one. */
const plain = (rows: readonly object[]) => rows.map((row) => ({ ...row }));

async function fixture(t: TestContext, sql: string) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scoped-references-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(sql);
  const adapter = new SqliteAdapter(file);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  /** 'committed', or the refusal's message and its cause for the operator. */
  const said = async (scope: RowScope, operation: (tx: WriteTransaction) => Promise<unknown>) => {
    try {
      await adapter.scopeTransaction(scope, operation);
      return { said: 'committed', cause: '' };
    } catch (error) {
      return { said: `${(error as Error).constructor.name}: ${(error as Error).message}`, cause: String(refusalCause(error as Error)) };
    }
  };
  return { db, said };
}

const OWNERS = `
  CREATE TABLE owner (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL);
  CREATE TABLE item (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, owner_id INTEGER REFERENCES owner(id));
  INSERT INTO owner VALUES (1, 'a'), (2, 'b'), (7, 'a');
`;

test('a value the column coerces is checked as it is written: "" for a nullable reference is NULL, "7.0" is 7', async (t) => {
  const { db, said } = await fixture(t, OWNERS);
  const insert = (id: number, owner: string) => (tx: WriteTransaction) =>
    tx.insert({ table: 'item', values: { id, tenant: 'a', owner_id: owner } });
  assert.equal((await said(ofA('item', 'owner'), insert(1, ''))).said, 'committed');
  assert.equal((await said(ofA('item', 'owner'), insert(2, '7.0'))).said, 'committed');
  assert.equal(
    (await said(ofA('item', 'owner'), (tx) => tx.update({ table: 'item', key: { id: 2 }, values: { owner_id: '' } }))).said,
    'committed',
  );
  assert.deepEqual(
    db
      .prepare('SELECT id, owner_id FROM item ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 1, owner_id: null },
      { id: 2, owner_id: null },
    ],
  );
  // "2.0" is the hidden owner 2, refused as 2 is.
  assert.equal((await said(ofA('item', 'owner'), insert(3, '2.0'))).said, REFUSED);
});

test('a row that references itself by the key it is written with is admitted', async (t) => {
  const { said } = await fixture(
    t,
    `CREATE TABLE node (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, parent_id INTEGER REFERENCES node(id));`,
  );
  const insert = (values: Record<string, number>) => (tx: WriteTransaction) =>
    tx.insert({ table: 'node', values: { tenant: 'a', ...values } });
  assert.equal((await said(ofA('node'), insert({ id: 1, parent_id: 1 }))).said, 'committed');
  // Another row's key is still a parent to check.
  assert.equal((await said(ofA('node'), insert({ id: 2, parent_id: 1 }))).said, 'committed');
  assert.equal((await said(ofA('node'), insert({ id: 3, parent_id: 9 }))).said, REFUSED);
});

test('a reference to a key of another affinity is refused whatever it names: no read before the write compares as its foreign key does', async (t) => {
  const { db, said } = await fixture(
    t,
    `CREATE TABLE tag (code TEXT PRIMARY KEY, tenant TEXT NOT NULL);
     CREATE TABLE note (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, tag INTEGER REFERENCES tag(code));
     INSERT INTO tag VALUES ('7', 'a'), ('7.0', 'b');`,
  );
  // "7.0" is stored as 7, which the TEXT key reads as "7": the check, given "7.0", would read the hidden "7.0".
  const insert = (tx: WriteTransaction) => tx.insert({ table: 'note', values: { id: 1, tenant: 'a', tag: '7.0' } });
  const hidden = await said(ofA('tag', 'note'), insert);
  assert.equal(hidden.said, REFUSED);
  assert.match(hidden.cause, /"note"\.tag references "tag"\.code, a column of another affinity/);
  assert.deepEqual(db.prepare('SELECT * FROM note').all(), []);
  db.exec(`DELETE FROM tag WHERE code = '7.0'`);
  assert.equal((await said(ofA('tag', 'note'), insert)).said, hidden.said, 'a missing parent and a hidden one answer alike');
  // A write that leaves the reference alone is not refused for it.
  assert.equal((await said(ofA('tag', 'note'), (tx) => tx.insert({ table: 'note', values: { id: 2, tenant: 'a' } }))).said, 'committed');
});

test('a reference the write names only in part is judged by the database, and its refusal is said as the check says one', async (t) => {
  const { db, said } = await fixture(
    t,
    `CREATE TABLE project (org TEXT NOT NULL, code TEXT NOT NULL, tenant TEXT NOT NULL, PRIMARY KEY (org, code));
     CREATE TABLE task (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, org TEXT NOT NULL DEFAULT 'acme', code TEXT,
       FOREIGN KEY (org, code) REFERENCES project(org, code));
     INSERT INTO project VALUES ('acme', 'secret', 'b');`,
  );
  const insert = (code: string) => (tx: WriteTransaction) => tx.insert({ table: 'task', values: { id: 1, tenant: 'a', code } });
  const hidden = await said(ofA('project', 'task'), insert('secret'));
  const missing = await said(ofA('project', 'task'), insert('nothing'));
  assert.equal(hidden.said, REFUSED);
  assert.equal(missing.said, hidden.said);
  assert.match(missing.cause, /The database's foreign key refused the write/);
  assert.doesNotMatch(missing.cause, /nothing/);
  assert.deepEqual(db.prepare('SELECT * FROM task').all(), []);
});

/* SQLite's foreign key applies the parent column's affinity to what the child column stored; the check applies it to
   what the write sends. Where the child's own affinity leaves that value as it was — a BLOB (or typeless) child, a
   TEXT child against an INTEGER key, two columns of one affinity — both read the same row, and the write is checked.
   A key of another affinity (REAL, NUMERIC, a decimal with a scale) is refused whatever it names: scoped-key-types.test.ts. */
for (const [label, parent, child] of [
  ['a typeless reference to an INTEGER key', 'INTEGER', ''],
  ['a BLOB reference to an INTEGER key', 'INTEGER', 'BLOB'],
  ['a typeless reference to a TEXT key', 'TEXT', ''],
  ['a TEXT reference to an INTEGER key', 'INTEGER', 'TEXT'],
  ['an INTEGER reference to a BIGINT key', 'BIGINT', 'INTEGER'],
] as const)
  test(`${label}: the visible parent is found and the hidden one is not`, async (t) => {
    const { db, said } = await fixture(
      t,
      `CREATE TABLE owner (id ${parent} PRIMARY KEY, tenant TEXT NOT NULL);
       CREATE TABLE item (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, owner_id ${child} REFERENCES owner(id));
       INSERT INTO owner VALUES ('1', 'a'), ('2', 'b');`,
    );
    const insert = (id: number, owner: string | number) => (tx: WriteTransaction) =>
      tx.insert({ table: 'item', values: { id, tenant: 'a', owner_id: owner } });
    const visible = await said(ofA('owner', 'item'), insert(1, '1'));
    assert.equal(visible.said, 'committed', visible.cause);
    // A number is bound as a REAL: a typeless column stores 1.0, which a TEXT key reads as "1.0", the check as well.
    assert.equal((await said(ofA('owner', 'item'), insert(2, 1))).said, parent === 'TEXT' && !child ? REFUSED : 'committed');
    for (const [id, hidden] of [
      [3, '2'],
      [4, 2],
    ] as const) {
      const refused = await said(ofA('owner', 'item'), insert(id, hidden));
      assert.equal(refused.said, REFUSED, `${JSON.stringify(hidden)}: ${refused.said}`);
      assert.doesNotMatch(refused.cause, /another affinity/);
    }
    assert.deepEqual(
      db
        .prepare('SELECT id FROM item ORDER BY id')
        .all()
        .map((row) => row.id),
      parent === 'TEXT' && !child ? [1] : [1, 2],
    );
  });

/* And where it changes it, the two part: a number column stores "7.0" as 7, which a TEXT key reads as "7". A NUMERIC
   reference, or a key declared without a type (which compares what a TEXT column stored as "7" as itself, not as 7),
   is not a type a key may be at all (keyTypes.ts), and is refused for that before its affinity is weighed. */
const ANOTHER_AFFINITY = /"item"\.owner_id references "owner"\.id, a column of another affinity/;
for (const [label, parent, child, cause] of [
  ['an INTEGER reference to a TEXT key', 'TEXT', 'INTEGER', ANOTHER_AFFINITY],
  [
    'a NUMERIC reference to a TEXT key',
    'TEXT',
    'NUMERIC',
    /"item"\.owner_id is of type NUMERIC \(NUMERIC affinity\), which is not supported as a key/,
  ],
  ['a TEXT reference to a typeless key', '', 'TEXT', /"owner"\.id is of type BLOB \(BLOB affinity\), which is not supported as a key/],
  [
    'an INTEGER reference to a typeless key',
    '',
    'INTEGER',
    /"owner"\.id is of type BLOB \(BLOB affinity\), which is not supported as a key/,
  ],
] as const)
  test(`${label} is refused: its own affinity changes the value before the foreign key compares it`, async (t) => {
    const { said } = await fixture(
      t,
      `CREATE TABLE owner (id ${parent} PRIMARY KEY, tenant TEXT NOT NULL);
       CREATE TABLE item (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, owner_id ${child} REFERENCES owner(id));
       INSERT INTO owner VALUES ('1', 'a');`,
    );
    const refused = await said(ofA('owner', 'item'), (tx) => tx.insert({ table: 'item', values: { id: 1, tenant: 'a', owner_id: '1' } }));
    assert.equal(refused.said, REFUSED);
    assert.match(refused.cause, cause);
  });

/* A reference with a generated column moves with what its expression reads, which no update names: an update of `x`
   re-pointed `k GENERATED ALWAYS AS (x + 1) REFERENCES p` at a hidden parent and committed, while a missing parent
   was refused by the foreign key, telling the two apart. Every update now checks such a reference after the
   statement, from the row as stored: a hidden parent and a missing one are the one refusal, and nothing is left. */
for (const stored of ['STORED', 'VIRTUAL'])
  test(`a ${stored} generated reference is checked after every update: a hidden parent and a missing one answer alike`, async (t) => {
    const { db, said } = await fixture(
      t,
      `PRAGMA foreign_keys = ON;
       CREATE TABLE p (k INTEGER PRIMARY KEY, tenant TEXT NOT NULL);
       CREATE TABLE ch (id INTEGER PRIMARY KEY, x INTEGER NOT NULL, k INTEGER GENERATED ALWAYS AS (x + 1) ${stored} REFERENCES p(k),
                        tenant TEXT NOT NULL, note TEXT);
       INSERT INTO p VALUES (1, 'a'), (2, 'b'), (3, 'a');
       INSERT INTO ch (id, x, tenant) VALUES (1, 0, 'a');`,
    );
    const retag = (x: number) => (tx: WriteTransaction) => tx.update({ table: 'ch', key: { id: 1 }, values: { x } });
    const hidden = await said(ofA('p', 'ch'), retag(1));
    assert.equal(hidden.said, REFUSED);
    assert.match(hidden.cause, /"ch"\.k points at the "p" row k 2, which the principal's rows do not include/);
    const missing = await said(ofA('p', 'ch'), retag(8));
    assert.equal(missing.said, REFUSED);
    assert.deepEqual(plain(db.prepare('SELECT x, k FROM ch').all()), [{ x: 0, k: 1 }]);
    assert.equal((await said(ofA('p', 'ch'), retag(2))).said, 'committed');
    // An update of another column leaves it where it was, and checks it there.
    assert.equal(
      (await said(ofA('p', 'ch'), (tx) => tx.update({ table: 'ch', key: { id: 1 }, values: { note: 'seen' } }))).said,
      'committed',
    );
    assert.deepEqual(plain(db.prepare('SELECT x, k, note FROM ch').all()), [{ x: 2, k: 3, note: 'seen' }]);
  });

/* A column another table references, generated from the row: an update of what it reads moves it, as an update of
   the column itself would, and is refused alike (a cascade would carry the move to rows the principal cannot see). */
test('a referenced generated column moved by an update is refused, and its cascade with it', async (t) => {
  const { db, said } = await fixture(
    t,
    `PRAGMA foreign_keys = ON;
     CREATE TABLE p (id INTEGER PRIMARY KEY, x INTEGER NOT NULL, g INTEGER GENERATED ALWAYS AS (x + 1) STORED UNIQUE, tenant TEXT NOT NULL, note TEXT);
     CREATE TABLE ch (id INTEGER PRIMARY KEY, g INTEGER REFERENCES p(g) ON UPDATE CASCADE, tenant TEXT NOT NULL);
     INSERT INTO p (id, x, tenant) VALUES (1, 0, 'a');
     INSERT INTO ch VALUES (1, 1, 'b');`,
  );
  const moved = await said(ofA('p', 'ch'), (tx) => tx.update({ table: 'p', key: { id: 1 }, values: { x: 5 } }));
  assert.equal(moved.said, REFUSED);
  assert.match(moved.cause, /may not change "p"\.g: a key, or a column another table references, generated/);
  assert.deepEqual(plain(db.prepare('SELECT g FROM ch').all()), [{ g: 1 }]);
  assert.equal((await said(ofA('p', 'ch'), (tx) => tx.update({ table: 'p', key: { id: 1 }, values: { note: 'x' } }))).said, 'committed');
});
