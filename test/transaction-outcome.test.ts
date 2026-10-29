import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type Adapter, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appError } from '../packages/mistri/src/server/app/appErrors.js';
import { writeFailureOutcome } from '../packages/engine/src/server/constraints.js';
import {
  clearJournal,
  forget,
  history,
  lastRevertible,
  latestRevertible,
  recordWrite,
  revert,
  type JournalEntry,
} from '../packages/engine/src/server/journal.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-transaction-outcome-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item VALUES (1, 'After'), (2, 'Second');");
  const adapter = new SqliteAdapter(file);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await adapter.close();
    }
  };
  t.after(async () => {
    await close();
    db.close();
    clearJournal(directory);
    rmSync(directory, { recursive: true, force: true });
  });
  const entry = () =>
    recordWrite(directory, {
      kind: 'update',
      summary: 'Changed item',
      revertible: true,
      steps: [{ table: 'item', key: { id: 1 }, before: { name: 'Before' }, after: { name: 'After' } }],
    });
  const rows = () =>
    db
      .prepare('SELECT * FROM item ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  return { adapter, db, close, connection: directory, entry, rows };
}

test('successful Undo reports applied and stale logical copies cannot execute again', async (t) => {
  const { adapter, entry, connection, rows } = fixture(t);
  const write = entry();
  const stale = structuredClone(write);
  const result = await revert(adapter, connection, write);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.reverted, true);
  assert.equal(rows()[0].name, 'Before');
  assert.equal(history(connection).length, 0);
  assert.equal((await revert(adapter, connection, stale)).outcome, 'not_applied');
  assert.equal(rows()[0].name, 'Before');
});

for (const rollback of [false, true]) {
  test(`SQLite raw writes wait outside an owned transaction (${rollback ? 'rollback' : 'commit'})`, async (t) => {
    const { adapter, rows } = fixture(t);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = adapter.transaction(async (tx) => {
      await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Transaction' } });
      enter();
      await released;
      assert.equal(
        (await tx.query({ table: 'item', filter: { groups: [[{ column: 'id', op: '=', value: 2 }]] }, limit: 1, offset: 0 })).rows[0].name,
        'Second',
      );
      if (rollback) throw new Refusal('deliberate rollback');
    });
    const settled = transaction.then(
      () => undefined,
      (error) => error,
    );
    await entered;
    let rawFinished = false;
    const request = { text: "UPDATE item SET name = 'Raw' WHERE id = 2", write: true, limit: 10 };
    const raw = adapter.runSql(request).then((result) => {
      rawFinished = true;
      return result;
    });
    request.text = "UPDATE item SET name = 'Mutated' WHERE id = 1";
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(rawFinished, false);
    release();
    const failure = await settled;
    assert.equal(failure instanceof Refusal, rollback);
    assert.equal((await raw).affected, 1);
    assert.deepEqual(
      rows().map((row) => row.name),
      [rollback ? 'After' : 'Transaction', 'Raw'],
    );
  });
}

test('confirmed rollback preserves the original error and leaves Undo available', async (t) => {
  const { adapter, entry, connection, rows } = fixture(t);
  const failure = new Refusal('Second inverse denied');
  await assert.rejects(
    adapter.transaction(async (tx) => {
      await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Temporary' } });
      throw failure;
    }),
    (error) => error === failure,
  );
  const write = entry();
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = (run) =>
    transaction(async (tx) => {
      await run(tx);
      throw failure;
    });
  const result = await revert(adapter, connection, write);
  assert.equal(result.outcome, 'not_applied');
  assert.deepEqual(result.steps, []);
  assert.match(result.errors![0], /whole undo rolled back/);
  assert.equal(rows()[0].name, 'After');
  assert.equal(write.undoState, undefined);
  assert.equal(lastRevertible(connection)?.id, write.id);
  adapter.transaction = transaction;
  assert.equal((await revert(adapter, connection, write)).outcome, 'applied');
});

test('lost commit acknowledgement quarantines Undo without claiming zero applied steps', async (t) => {
  const { adapter, entry, connection, rows } = fixture(t);
  const older = entry();
  const write = entry();
  const stale = structuredClone(write);
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = (run) =>
    transaction(async (tx) => {
      const value = await run(tx);
      const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = handle.exec.bind(handle);
      handle.exec = (sql) => {
        exec(sql);
        if (sql === 'COMMIT') throw new Error('lost acknowledgement');
      };
      return value;
    });
  const result = await revert(adapter, connection, write);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.reverted, false);
  assert.equal(result.steps, undefined);
  assert.match(result.errors![0], /do not retry/);
  assert.doesNotMatch(result.errors![0], /nothing was changed|rolled back/);
  assert.equal(rows()[0].name, 'Before', 'the actual commit did land');
  assert.equal(Reflect.get(adapter, 'writeDb'), null);
  assert.equal(write.undoState, 'unknown');
  assert.equal(write.revertible, false);
  assert.equal(lastRevertible(connection), undefined, 'do not silently fall through to the older write');
  assert.equal(latestRevertible(history(connection)), undefined);
  let retried = false;
  adapter.transaction = async () => {
    retried = true;
    throw new Error('must not retry');
  };
  assert.equal((await revert(adapter, connection, stale)).outcome, 'unknown');
  assert.equal(retried, false);
  assert.equal(
    history(connection).some((item) => item.id === older.id),
    true,
  );
  const newer = entry();
  assert.equal(lastRevertible(connection)?.id, newer.id, 'a separately recorded later write is independent');
  forget(connection, newer.id);
  assert.equal(lastRevertible(connection), undefined);
});

test('a failed rollback cannot relabel a Refusal or constraint as a safely rejected write', async (t) => {
  const { adapter, rows } = fixture(t);
  const failures = [new Refusal('private rejection'), Object.assign(new Error('private constraint'), { code: '23505', errcode: 2067 })];
  for (const failure of failures) {
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Temporary' } });
        const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
        const exec = handle.exec.bind(handle);
        handle.exec = (sql) => {
          if (sql === 'ROLLBACK') throw new Error('lost rollback');
          exec(sql);
        };
        throw failure;
      }),
      (error) => {
        assert.ok(error instanceof TransactionOutcomeUnknown);
        assert.equal(error.cause, failure);
        assert.equal(error instanceof Refusal, false);
        assert.equal(writeFailureOutcome(error), 'unknown');
        assert.equal(appError(error, 'write').code, 'write_unconfirmed');
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
    assert.equal(rows()[0].name, 'After');
  }
});

test('Undo rollback uncertainty stays unknown even when closing the writer happens to roll it back', async (t) => {
  const { adapter, entry, connection, rows } = fixture(t);
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = (run) =>
    transaction(async (tx) => {
      await run(tx);
      const handle = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = handle.exec.bind(handle);
      handle.exec = (sql) => {
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        exec(sql);
      };
      throw new Refusal('private rejection');
    });
  const write = entry();
  const result = await revert(adapter, connection, write, () => 'sanitized');
  assert.equal(result.outcome, 'unknown');
  assert.equal(write.undoState, 'unknown');
  assert.equal(lastRevertible(connection), undefined);
  assert.equal(rows()[0].name, 'After');
  assert.doesNotMatch(result.errors![0], /sanitized|private|nothing was changed/);
});

test('an in-flight canonical Undo blocks duplicates and older fallthrough before preflight finishes', async (t) => {
  const { adapter, entry, connection, rows } = fixture(t);
  entry();
  const write = entry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const query = adapter.query.bind(adapter);
  let reads = 0;
  adapter.query = async (request) => {
    reads++;
    await gate;
    return query(request);
  };
  const pending = revert(adapter, connection, structuredClone(write));
  assert.equal(write.undoState, 'pending');
  assert.equal(lastRevertible(connection), undefined);
  const duplicate = await revert(adapter, connection, structuredClone(write));
  assert.equal(duplicate.outcome, 'unknown');
  assert.equal(reads, 1);
  assert.equal(rows()[0].name, 'After');
  release();
  assert.equal((await pending).outcome, 'applied');
  assert.equal(write.undoState, undefined);
  assert.equal(rows()[0].name, 'Before');
});

test('Undo requires a transaction and never falls back to separate inverse writes', async (t) => {
  const { adapter, entry, connection } = fixture(t);
  let calls = 0;
  const forbidden = async () => {
    calls++;
    throw new Error('must not execute');
  };
  const incapable = {
    dialect: 'sqlite',
    query: forbidden,
    count: forbidden,
    introspect: forbidden,
    close: forbidden,
    insert: forbidden,
    update: forbidden,
    remove: forbidden,
  } as Adapter;
  const write = entry();
  const result = await revert(incapable, connection, write);
  assert.equal(result.outcome, 'not_applied');
  assert.equal(calls, 0);
  assert.equal(write.undoState, undefined);
  assert.equal(await adapter.count('item'), 2);
});

test('Undo captures inverse steps before its first preflight await', async (t) => {
  const { adapter, entry, connection, rows } = fixture(t);
  const write = entry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const query = adapter.query.bind(adapter);
  adapter.query = async (request) => {
    await gate;
    return query(request);
  };
  const pending = revert(adapter, connection, write);
  write.steps[0].key!.id = 2;
  write.steps[0].before!.name = 'Mutated inverse';
  write.steps[0].after!.name = 'Second';
  release();
  assert.equal((await pending).outcome, 'applied');
  assert.deepEqual(rows(), [
    { id: 1, name: 'Before' },
    { id: 2, name: 'Second' },
  ]);
});

test('preflight read failure is not applied and clears the pending attempt', async (t) => {
  const { adapter, entry, connection } = fixture(t);
  const write = entry();
  adapter.query = async () => {
    throw new Error('private read error');
  };
  const result = await revert(adapter, connection, write, () => 'safe read error');
  assert.equal(result.outcome, 'not_applied');
  assert.deepEqual(result.errors, ['safe read error']);
  assert.equal(write.undoState, undefined);
  assert.equal(lastRevertible(connection)?.id, write.id);
});

for (const operation of ['update', 'remove'] as const) {
  test(`ordinary SQLite ${operation} stays on its captured lease across preflight close`, async (t) => {
    const { adapter, close, rows } = fixture(t);
    const before = rows();
    // Closed as the write is about to run: inside a transaction the write is its own row check, so this is its last await.
    const method = operation === 'update' ? 'updateNow' : 'removeNow';
    const write = Reflect.get(adapter, method).bind(adapter) as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(adapter, method, async (...args: unknown[]) => {
      await close();
      return write(...args);
    });
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.insert({ table: 'item', values: { id: 3, name: 'Rolled back' } });
        if (operation === 'update') await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Autocommit escape' } });
        else await tx.remove({ table: 'item', key: { id: 1 } });
      }),
      TransactionOutcomeUnknown,
    );
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
    assert.deepEqual(rows(), before);
    await assert.rejects(
      adapter.transaction(async () => {}),
      /closed/,
    );
    await assert.rejects(adapter.insert({ table: 'item', values: { id: 4 } }), /closed|not open/);
  });
}

test('failure before callback disposes the SQLite writer and the next transaction starts fresh', async (t) => {
  const { adapter } = fixture(t);
  await adapter.transaction(async () => {});
  const old = Reflect.get(adapter, 'writeDb') as DatabaseSync;
  const exec = old.exec.bind(old);
  old.exec = (sql) => {
    if (sql === 'BEGIN IMMEDIATE') throw new Error('begin failed');
    exec(sql);
  };
  let invoked = false;
  await assert.rejects(
    adapter.transaction(async () => {
      invoked = true;
    }),
    /begin failed/,
  );
  assert.equal(invoked, false);
  assert.equal(Reflect.get(adapter, 'writeDb'), null);
  await adapter.transaction(async (tx: WriteTransaction) => assert.equal(await tx.count('item'), 2));
  assert.notEqual(Reflect.get(adapter, 'writeDb'), old);
});

for (const queued of [false, true]) {
  test(`SQLite automatic rollback fail-stops ${queued ? 'already queued' : 'caught-error follow-up'} writes`, async (t) => {
    const { adapter, db, rows } = fixture(t);
    // Schema conflict policies yield to INSERT OR ABORT. Explicit RAISE must
    // still exercise automatic rollback and prevent later queued autocommits.
    db.exec(`CREATE TABLE guarded(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
      INSERT INTO guarded VALUES (1, 'Taken');
      CREATE TRIGGER rollback_guarded BEFORE INSERT ON guarded
      WHEN EXISTS (SELECT 1 FROM guarded WHERE name = NEW.name)
      BEGIN SELECT RAISE(ROLLBACK, 'forced automatic rollback'); END;`);
    const before = rows();
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'Must roll back' } });
        const bad = tx.insert({ table: 'guarded', values: { id: 2, name: 'Taken' } });
        if (!queued) await assert.rejects(bad);
        const later = tx.update({ table: 'item', key: { id: 2 }, values: { name: 'Must never autocommit' } });
        const outcomes = await Promise.allSettled([bad, later, tx.count('item')]);
        assert.ok(outcomes.every((result) => result.status === 'rejected'));
        assert.equal(
          Reflect.get(Reflect.get(adapter, 'writeDb'), 'isTransaction'),
          false,
          'the trigger ended the transaction before callback settlement',
        );
      }),
      TransactionOutcomeUnknown,
    );
    assert.deepEqual(rows(), before);
    assert.equal(Reflect.get(adapter, 'writeDb'), null);
  });
}

test('latestRevertible treats pending and unknown entries as barriers but ignores ordinary non-revertible SQL', () => {
  const base = { id: 1, connection: 'example', at: '', summary: '', kind: 'update', revertible: true, steps: [] } satisfies JournalEntry;
  assert.equal(latestRevertible([{ ...base, id: 2, revertible: false, kind: 'sql' }, base]), base);
  for (const undoState of ['pending', 'unknown'] as const) {
    assert.equal(latestRevertible([{ ...base, id: 2, undoState }, base]), undefined);
  }
});
