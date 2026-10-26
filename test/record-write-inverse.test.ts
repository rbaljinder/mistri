import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type Adapter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import {
  clearJournal,
  history,
  lastRevertible,
  latestRevertible,
  recordWrite,
  revert,
  journalFieldsMatch,
  journalImageMatches,
  type WriteStep,
} from '../packages/engine/src/server/journal.js';
import { recordedDelete, recordedInsert } from '../packages/engine/src/server/recordWriteOperations.js';

const sql = { text: '', params: [] };
const key = { id: 1 };
const table = 'item';

function fixture(
  t: TestContext,
  ddl = `CREATE TABLE item (
  id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE DEFAULT 'Alpha',
  note TEXT DEFAULT 'default', nullable TEXT, amount INTEGER DEFAULT 7, payload BLOB
)`,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-inverse-'));
  const db = new DatabaseSync(join(directory, 'data.db'));
  db.exec(ddl);
  const adapter = new SqliteAdapter(join(directory, 'data.db'));
  t.after(async () => {
    await adapter.close();
    db.close();
    clearJournal(directory);
    rmSync(directory, { recursive: true, force: true });
  });
  const transaction = adapter.transaction.bind(adapter);
  const row = () => {
    const value = db.prepare('SELECT * FROM item WHERE id = 1').get();
    return value && { ...value };
  };
  const insert = async () => {
    const result = await adapter.insert({ table, values: { id: 1 } });
    return recordWrite(directory, {
      kind: 'insert',
      summary: 'Inserted',
      revertible: true,
      steps: [{ table, key: result.key, after: result.row, wholeRow: true }],
    });
  };
  const deletion = async () => {
    const result = await adapter.query({ table, limit: 2, offset: 0, filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] } });
    await adapter.remove({ table, key });
    return recordWrite(directory, {
      kind: 'delete',
      summary: 'Deleted',
      revertible: true,
      steps: [{ table, key, before: result.rows[0], wholeRow: true }],
    });
  };
  return { adapter, db, connection: directory, row, insert, deletion, transaction };
}

test('whole-row insertion Undo checks the complete defaulted afterimage only inside its fence', async (t) => {
  const f = fixture(t);
  await recordedInsert(f, { table, values: { id: 1 } });
  const entry = history(f.connection)[0];
  assert.equal(entry.steps[0].wholeRow, true);
  assert.equal(entry.steps[0].after!.note, 'default');
  f.adapter.query = async () => assert.fail('outside read cannot prove an inverse');
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(result.outcome, 'applied');
  assert.equal(f.row(), undefined);
  assert.equal(history(f.connection).length, 0);
});

for (const [name, mutation] of [
  ['unsubmitted default', "UPDATE item SET note = 'newer'"],
  ['NULL becoming empty text', "UPDATE item SET nullable = ''"],
  ['NOCASE-equivalent text', "UPDATE item SET name = 'alpha'"],
  ['storage type', 'UPDATE item SET nullable = 0'],
  ['added defaulted column', "ALTER TABLE item ADD COLUMN newer TEXT DEFAULT 'added'"],
  ['deleted row', 'DELETE FROM item'],
] as const) {
  test(`whole-row insertion Undo refuses ${name}`, async (t) => {
    const f = fixture(t);
    const entry = await f.insert();
    f.db.exec(mutation);
    const before = f.row();
    const result = await revert(f.adapter, f.connection, entry);
    assert.equal(result.outcome, 'not_applied');
    assert.deepEqual(f.row(), before);
    assert.equal(entry.undoState, undefined);
    assert.equal(lastRevertible(f.connection)?.id, entry.id);
  });
}

for (const change of [false, true]) {
  test(`lossy BLOB afterimages refuse Undo${change ? ' after a same-size change' : ' even unchanged'}`, async (t) => {
    const f = fixture(t, "CREATE TABLE item(id INTEGER PRIMARY KEY, payload BLOB DEFAULT X'0102')");
    const entry = await f.insert();
    assert.equal(entry.steps[0].after!.payload, '<2 bytes>');
    if (change) f.db.exec("UPDATE item SET payload = X'0304'");
    const before = f.row();
    assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
    assert.deepEqual(f.row(), before);
  });
}

test('a BLOB replaced by its literal display label is still an ambiguous inverse', async (t) => {
  const f = fixture(t, "CREATE TABLE item(id INTEGER PRIMARY KEY, payload BLOB DEFAULT X'0102')");
  const entry = await f.insert();
  f.db.exec("UPDATE item SET payload = '<2 bytes>'");
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.row()!.payload, '<2 bytes>');
});

test('an AFTER INSERT trigger changing the RETURNING image causes conservative refusal', async (t) => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER changed AFTER INSERT ON item BEGIN UPDATE item SET note = 'trigger' WHERE id = NEW.id; END");
  const entry = await f.insert();
  assert.equal(entry.steps[0].after!.note, 'default');
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.row()!.note, 'trigger');
});

test('a change before the inverse obtains its transaction is observed and preserved', async (t) => {
  const f = fixture(t);
  const entry = await f.insert();
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) => {
    f.db.exec("UPDATE item SET note = 'racer'");
    return transaction(run);
  };
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.row()!.note, 'racer');
});

test('the SQLite transaction fences another physical writer between image check and removal', async (t) => {
  const f = fixture(t);
  const entry = await f.insert();
  let attempted = false;
  f.db.exec('PRAGMA busy_timeout = 0');
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) =>
    transaction((tx) =>
      run({
        ...tx,
        remove: async (request) => {
          attempted = true;
          assert.throws(() => f.db.exec("UPDATE item SET note = 'racer'"), /locked/);
          return tx.remove(request);
        },
      }),
    );
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'applied');
  assert.equal(attempted, true);
  assert.equal(f.row(), undefined);
});

for (const [name, mutate] of [
  [
    'missing afterimage',
    (step: WriteStep) => {
      delete step.after;
    },
  ],
  [
    'partial afterimage',
    (step: WriteStep) => {
      delete step.after!.note;
    },
  ],
  [
    'missing key',
    (step: WriteStep) => {
      delete step.key;
    },
  ],
  [
    'empty key',
    (step: WriteStep) => {
      step.key = {};
    },
  ],
  [
    'mismatched key',
    (step: WriteStep) => {
      step.key = { id: 2 };
    },
  ],
] as const) {
  test(`whole-row inverse refuses ${name}`, async (t) => {
    const f = fixture(t);
    const entry = await f.insert();
    mutate(entry.steps[0]);
    assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
    assert.ok(f.row());
  });
}

test('a stale projection cannot omit the canonical whole-row requirement', async (t) => {
  const f = fixture(t);
  const entry = await f.insert();
  const projected = structuredClone(entry);
  delete projected.steps[0].wholeRow;
  f.db.exec("UPDATE item SET nullable = ''");
  assert.equal((await revert(f.adapter, f.connection, projected)).outcome, 'not_applied');
  assert.equal(f.row()!.nullable, '');
});

test('a missing lock capability refuses before any whole-row read or removal', async (t) => {
  const f = fixture(t);
  const entry = await f.insert();
  f.adapter.transaction = (run) =>
    f.transaction((tx) =>
      run({
        ...tx,
        lockRecord: undefined,
        query: async () => assert.fail('no unfenced query'),
        remove: async () => assert.fail('no unfenced remove'),
      }),
    );
  assert.match((await revert(f.adapter, f.connection, entry)).errors![0], /fence/);
  assert.ok(f.row());
});

for (const dialect of ['postgres', 'mysql'] as const) {
  test(`${dialect} scalar image comparison still requires a fence (driver seam)`, async (t) => {
    const f = fake(t);
    const entry = f.entry();
    Object.assign(f.adapter, { dialect });
    delete f.tx.lockRecord;
    assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
    assert.deepEqual(f.calls, ['begin', 'rollback']);
  });
}

test('native SQLite restore rejects schema REPLACE conflicts even with an absent PK', async (t) => {
  const f = fixture(t, 'CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT UNIQUE ON CONFLICT REPLACE)');
  f.db.exec("INSERT INTO item VALUES (1, 'taken')");
  const entry = await f.deletion();
  f.db.exec("INSERT INTO item VALUES (2, 'taken')");
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(result.outcome, 'not_applied');
  assert.match(result.errors![0], /UNIQUE constraint/);
  assert.equal(f.row(), undefined);
  assert.equal(f.db.prepare('SELECT id FROM item').get()!.id, 2);
});

test('native non-replacing restore succeeds and verifies the complete restored image', async (t) => {
  const f = fixture(t);
  await f.insert();
  const before = f.row();
  const entry = await f.deletion();
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'applied');
  assert.deepEqual(f.row(), before);
});

for (const [name, insertion] of [
  ['PK reoccupation', "INSERT INTO item VALUES (1, 'replacement')"],
  ['different PK with a REPLACE uniqueness conflict', "INSERT INTO item VALUES (2, 'original')"],
] as const) {
  test(`non-replacing restore preserves ${name}`, async (t) => {
    const f = fixture(t, 'CREATE TABLE item(id INTEGER PRIMARY KEY ON CONFLICT REPLACE, name TEXT UNIQUE ON CONFLICT REPLACE)');
    f.db.exec("INSERT INTO item VALUES (1, 'original')");
    const entry = await f.deletion();
    const transaction = f.adapter.transaction.bind(f.adapter);
    f.adapter.transaction = (run) => {
      f.db.exec(insertion);
      return transaction(run);
    };
    assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM item').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT name FROM item').get()!.name, name === 'PK reoccupation' ? 'replacement' : 'original');
  });
}

test('restore coercion cannot silently change the captured original', async (t) => {
  const f = fixture(t, 'CREATE TABLE item(id INTEGER PRIMARY KEY, amount INTEGER)');
  f.db.exec("INSERT INTO item VALUES (1, '')");
  const entry = await f.deletion();
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.row(), undefined);
});

test('restore refuses newly defaulted fields and rolls the inserted row back', async (t) => {
  const f = fixture(t);
  await f.insert();
  const entry = await f.deletion();
  f.db.exec("ALTER TABLE item ADD COLUMN added TEXT DEFAULT 'new schema'");
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.row(), undefined);
  assert.equal(lastRevertible(f.connection)?.id, entry.id);
});

test('a lost SQLite commit acknowledgement quarantines a whole-row inverse that actually landed', async (t) => {
  const f = fixture(t);
  const entry = await f.insert();
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) =>
    transaction(async (tx) => {
      const value = await run(tx);
      const writer = Reflect.get(f.adapter, 'writeDb') as DatabaseSync;
      const exec = writer.exec.bind(writer);
      writer.exec = (statement) => {
        exec(statement);
        if (statement === 'COMMIT') throw new Error('lost acknowledgement');
      };
      return value;
    });
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.steps, undefined);
  assert.equal(f.row(), undefined, 'the deletion did commit');
  assert.equal(entry.undoState, 'unknown');
  assert.equal(lastRevertible(f.connection), undefined);
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'unknown');
});

function fake(t: TestContext, overrides: Partial<WriteTransaction> = {}) {
  const connection = mkdtempSync(join(tmpdir(), 'tablewalk-inverse-seam-'));
  t.after(() => {
    clearJournal(connection);
    rmSync(connection, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const tx: WriteTransaction = {
    lockRecord: async () => {
      calls.push('lock');
    },
    query: async () => {
      calls.push('query');
      return { columns: ['id', 'name'], rows: [{ id: 1, name: 'after' }], ms: 0, sql };
    },
    count: async () => 1,
    insert: async () => assert.fail('no ordinary insert fallback'),
    update: async () => assert.fail('no update fallback'),
    remove: async () => {
      calls.push('remove');
      return { affected: 1, sql };
    },
    ...overrides,
  };
  const forbidden = async () => assert.fail('no outside operations');
  const adapter: Adapter = {
    dialect: 'sqlite',
    introspect: forbidden,
    close: forbidden,
    count: forbidden,
    query: forbidden,
    insert: forbidden,
    update: forbidden,
    remove: forbidden,
    transaction: async (run) => {
      calls.push('begin');
      try {
        const result = await run(tx);
        calls.push('commit');
        return result;
      } catch (error) {
        calls.push('rollback');
        throw error;
      }
    },
  };
  const entry = () =>
    recordWrite(connection, {
      kind: 'insert',
      summary: 'Inserted',
      revertible: true,
      steps: [{ table, key, after: { id: 1, name: 'after' }, wholeRow: true }],
    });
  return { adapter, connection, calls, tx, entry };
}

test('the inverse orders fence, complete-image read and removal within one transaction', async (t) => {
  const f = fake(t);
  assert.equal((await revert(f.adapter, f.connection, f.entry())).outcome, 'applied');
  assert.deepEqual(f.calls, ['begin', 'lock', 'query', 'remove', 'commit']);
});

test('the image read follows a lock wait and catches the edit that won the race', async (t) => {
  const f = fake(t);
  let locked = false;
  f.tx.lockRecord = async () => {
    locked = true;
  };
  f.tx.query = async () => {
    assert.equal(locked, true);
    return { columns: ['id', 'name'], rows: [{ id: 1, name: 'newer' }], ms: 0, sql };
  };
  assert.equal((await revert(f.adapter, f.connection, f.entry())).outcome, 'not_applied');
  assert.equal(f.calls.includes('remove'), false);
});

for (const dialect of ['postgres', 'mysql'] as const) {
  test(`${dialect} scalar inverse orders fence, SQL predicates and strict image comparison (driver seam)`, async (t) => {
    const f = fake(t);
    Object.assign(f.adapter, { dialect });
    assert.equal((await revert(f.adapter, f.connection, f.entry())).outcome, 'applied');
    assert.deepEqual(f.calls, ['begin', 'lock', 'query', 'remove', 'commit']);
  });
}

test('capture helper refuses non-scalar, unsafe-number and display-only images before querying', async (t) => {
  const f = fake(t);
  for (const value of [{ nested: true }, [1], NaN, Infinity, 9007199254740992, '<2 bytes>', undefined]) {
    assert.equal(await journalImageMatches(f.tx, table, { id: 1, name: value }), false);
  }
  assert.deepEqual(f.calls, []);
});

test('capture helper uses SQL to reject a lossy driver image despite matching displayed values', async (t) => {
  const f = fake(t, {
    query: async (request) => {
      assert.deepEqual(request.filter, {
        groups: [
          [
            { column: 'id', op: '=', value: 1 },
            { column: 'name', op: '=', value: '2026-09-07T12:00:00.123Z' },
          ],
        ],
      });
      // The stored timestamp is .123456, which cannot equal the rounded parameter.
      return { columns: ['id', 'name'], rows: [], ms: 0, sql };
    },
  });
  assert.equal(await journalImageMatches(f.tx, table, { id: 1, name: '2026-09-07T12:00:00.123Z' }), false);
});

test('capture helper refuses duplicate matching rows and pruned column evidence', async (t) => {
  const f = fake(t);
  const query = f.tx.query;
  f.tx.query = async (request) => {
    const result = await query(request);
    return { ...result, rows: [result.rows[0], result.rows[0]] };
  };
  assert.equal(await journalImageMatches(f.tx, table, { id: 1, name: 'after' }), false);
  f.tx.query = async (request) => ({ ...(await query(request)), columns: ['id'] });
  assert.equal(await journalImageMatches(f.tx, table, { id: 1, name: 'after' }), false);
});

test('restore without a fence cannot query or insert through a plain transaction', async (t) => {
  const f = fake(t, { lockRecord: undefined });
  const entry = recordWrite(f.connection, {
    kind: 'delete',
    summary: 'Deleted',
    revertible: true,
    steps: [{ table, key, before: { id: 1, name: 'before' }, wholeRow: true }],
  });
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.deepEqual(f.calls, ['begin', 'rollback']);
});

test('restore handles a uniqueness race after its absence read without overwrite or retry', async (t) => {
  let inserts = 0;
  const f = fake(t, {
    query: async () => ({ columns: ['id', 'name'], rows: [], ms: 0, sql }),
    insert: async () => {
      inserts++;
      throw new Refusal('A concurrent insert took the unique key.');
    },
  });
  const entry = recordWrite(f.connection, {
    kind: 'delete',
    summary: 'Deleted',
    revertible: true,
    steps: [{ table, key, before: { id: 1, name: 'before' }, wholeRow: true }],
  });
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(inserts, 1);
  assert.deepEqual(f.calls, ['begin', 'lock', 'rollback']);
  assert.equal(lastRevertible(f.connection)?.id, entry.id);
});

test('shared recorded deletion captures under the native record lock', async (t) => {
  const f = fixture(t);
  await f.insert();
  const result = await recordedDelete(f, { table, key });
  assert.equal(result.result.affected, 1);
  assert.equal(f.row(), undefined);
});

test('zero-row inverse removal rolls back and retains the entry', async (t) => {
  const f = fake(t, { remove: async () => ({ affected: 0, sql }) });
  const entry = f.entry();
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.calls.at(-1), 'rollback');
  assert.equal(lastRevertible(f.connection)?.id, entry.id);
});

test('blocksUndo stops selection and direct attempts even on an inconsistently revertible entry', async (t) => {
  const f = fake(t);
  f.entry();
  const barrier = recordWrite(f.connection, { kind: 'insert', summary: 'No inverse', revertible: true, blocksUndo: true, steps: [] });
  assert.equal(lastRevertible(f.connection), undefined);
  assert.equal(latestRevertible(history(f.connection)), undefined);
  assert.equal((await revert(f.adapter, f.connection, barrier)).outcome, 'not_applied');
  assert.deepEqual(f.calls, []);
});

test('unknown inverse outcome quarantines the canonical entry and blocks retry and older fallthrough', async (t) => {
  const f = fake(t);
  f.entry();
  const entry = f.entry();
  const stale = structuredClone(entry);
  f.adapter.transaction = async (run) => {
    await run(f.tx);
    throw new TransactionOutcomeUnknown(new Refusal('lost acknowledgement'));
  };
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.steps, undefined);
  assert.equal(entry.undoState, 'unknown');
  assert.equal(lastRevertible(f.connection), undefined);
  const calls = [...f.calls];
  assert.equal((await revert(f.adapter, f.connection, stale)).outcome, 'unknown');
  assert.deepEqual(f.calls, calls);
  assert.doesNotMatch(result.errors![0], /nothing was changed|rolled back/);
});

test('pending inverse blocks duplicate attempts while its lock is waiting', async (t) => {
  const f = fake(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.tx.lockRecord = async () => gate;
  const entry = f.entry();
  const first = revert(f.adapter, f.connection, entry);
  assert.equal(entry.undoState, 'pending');
  assert.equal(lastRevertible(f.connection), undefined);
  assert.equal((await revert(f.adapter, f.connection, structuredClone(entry))).outcome, 'unknown');
  release();
  assert.equal((await first).outcome, 'applied');
});

test('whole-row inverse snapshots its image and marker before a lock wait', async (t) => {
  const f = fake(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.tx.lockRecord = async () => gate;
  const entry = f.entry();
  const first = revert(f.adapter, f.connection, entry);
  entry.steps[0].after!.name = 'mutated';
  entry.steps[0].wholeRow = false;
  release();
  assert.equal((await first).outcome, 'applied');
  assert.deepEqual(f.calls, ['begin', 'query', 'remove', 'commit']);
});

test('legacy graph insert Undo retains its submitted-field comparison and reverse order', async (t) => {
  const f = fixture(t);
  f.db.exec("INSERT INTO item(id, name) VALUES (1, 'first'), (2, 'second')");
  const entry = recordWrite(f.connection, {
    kind: 'insert_graph',
    summary: 'Graph',
    revertible: true,
    steps: [1, 2].map((id) => ({ table, key: { id }, after: { name: id === 1 ? 'first' : 'second' } })),
  });
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(
    result.steps!.map((step) => step.key!.id),
    [2, 1],
  );
});

test('legacy graph delete Undo retains reverse restoration order', async (t) => {
  const f = fixture(t);
  const entry = recordWrite(f.connection, {
    kind: 'delete_graph',
    summary: 'Graph',
    revertible: true,
    steps: [2, 1].map((id) => ({ table, key: { id }, before: { id, name: id === 1 ? 'first' : 'second' } })),
  });
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(
    result.steps!.map((step) => step.key!.id),
    [1, 2],
  );
  assert.equal(f.row()!.name, 'first');
});

test('exact-field update Undo never writes a captured BLOB display label as text', async (t) => {
  const f = fixture(t);
  f.db.exec("INSERT INTO item(id, payload) VALUES (1, X'0102')");
  const before = (await f.adapter.query({ table, columns: ['payload'], limit: 1, offset: 0 })).rows[0];
  assert.equal(before.payload, '<2 bytes>');
  await f.adapter.transaction(async (tx) => {
    await tx.lockRecord!({ table, key });
    assert.equal(await journalFieldsMatch(tx, table, key, before), false, 'capture must withhold this inverse');
    await tx.update({ table, key, values: { payload: 'after' } });
  });
  // An already-retained lossy entry must be refused too, even if capture-time
  // enrollment failed to withhold it. Never attempt to restore its label.
  const entry = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Changed payload',
    revertible: true,
    steps: [{ table, key, before, after: { payload: 'after' }, exactFields: true }],
  });
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) => transaction((tx) => run({ ...tx, update: async () => assert.fail('lossy inverse must not write') }));
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.equal(f.row()!.payload, 'after');
  assert.equal(lastRevertible(f.connection)?.id, entry.id);
});

test('exact-field update Undo rolls back INTEGER empty-text restoration coerced to NULL', async (t) => {
  const f = fixture(t);
  f.db.exec("INSERT INTO item(id, amount) VALUES (1, '')");
  await f.adapter.transaction(async (tx) => {
    await tx.lockRecord!({ table, key });
    assert.equal(await journalFieldsMatch(tx, table, key, { amount: '' }), true, 'the original storage is exactly empty text');
    await tx.update({ table, key, values: { amount: 9 } });
  });
  const entry = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Changed amount',
    revertible: true,
    steps: [{ table, key, before: { amount: '' }, after: { amount: 9 }, exactFields: true }],
  });
  let attempted = false;
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) =>
    transaction((tx) =>
      run({
        ...tx,
        update: async (request) => {
          attempted = true;
          const result = await tx.update(request);
          assert.equal(result.applied.amount, null, 'the generic adapter coerces the inverse');
          return result;
        },
      }),
    );
  const result = await revert(f.adapter, f.connection, entry);
  assert.equal(attempted, true);
  assert.equal(result.outcome, 'not_applied');
  assert.deepEqual(result.steps, []);
  assert.equal(f.row()!.amount, 9, 'readback mismatch rolled the NULL assignment back');
  assert.equal(entry.undoState, undefined);
  assert.equal(lastRevertible(f.connection)?.id, entry.id);
});

test('exact-field update Undo restores touched values and preserves newer untouched fields', async (t) => {
  const f = fixture(t);
  await f.insert();
  await f.adapter.update({ table, key, values: { amount: 9 } });
  f.db.exec("UPDATE item SET note = 'newer untouched value'");
  const entry = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Changed amount',
    revertible: true,
    steps: [{ table, key, before: { amount: 7 }, after: { amount: 9 }, exactFields: true }],
  });
  f.adapter.query = async () => assert.fail('exact-field preflight must be inside the fence');
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'applied');
  assert.equal(f.row()!.amount, 7);
  assert.equal(f.row()!.note, 'newer untouched value');
});

test('exact-field update Undo catches a collation-equivalent race under its lock', async (t) => {
  const f = fixture(t);
  await f.insert();
  const entry = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Changed name',
    revertible: true,
    steps: [{ table, key, before: { name: 'Before' }, after: { name: 'Alpha' }, exactFields: true }],
  });
  const projected = structuredClone(entry);
  delete projected.steps[0].exactFields;
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) => {
    f.db.exec("UPDATE item SET name = 'alpha'");
    return transaction(run);
  };
  assert.equal((await revert(f.adapter, f.connection, projected)).outcome, 'not_applied');
  assert.equal(f.row()!.name, 'alpha', 'dropping the projected marker did not weaken the canonical inverse');
});

test('exact-field update Undo requires a fence before any read or mutation', async (t) => {
  const f = fake(t, { lockRecord: undefined });
  const entry = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Changed name',
    revertible: true,
    steps: [{ table, key, before: { name: 'before' }, after: { name: 'after' }, exactFields: true }],
  });
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.deepEqual(f.calls, ['begin', 'rollback']);
});

test('exact-field update Undo rejects mismatched before/after field sets before mutation', async (t) => {
  const f = fake(t);
  const entry = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Incomplete update',
    revertible: true,
    steps: [{ table, key, before: { note: 'before' }, after: { name: 'after' }, exactFields: true }],
  });
  assert.equal((await revert(f.adapter, f.connection, entry)).outcome, 'not_applied');
  assert.deepEqual(f.calls, ['begin', 'lock', 'rollback']);
});
