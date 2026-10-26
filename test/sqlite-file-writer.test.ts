import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-file-writers-'));
  const owners: SqliteAdapter[] = [];
  const create = (name: string) => {
    const path = join(directory, name),
      db = new DatabaseSync(path);
    db.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item VALUES(1,'original')");
    db.close();
    return path;
  };
  const open = (file: string) => {
    const adapter = new SqliteAdapter(file);
    owners.push(adapter);
    return adapter;
  };
  t.after(async () => {
    for (const owner of owners) await owner.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, create, open };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const alias of ['same-path', 'symbolic-link', 'hard-link']) {
  test(`independent SQLite writers share asynchronous admission through ${alias}`, async (t) => {
    const f = fixture(t),
      file = f.create('business.db'),
      path = join(f.directory, 'alias.db');
    if (alias === 'symbolic-link') symlinkSync(file, path);
    if (alias === 'hard-link') linkSync(file, path);
    const a = f.open(file),
      b = f.open(alias === 'same-path' ? file : path);
    const entered = latch(),
      hold = latch();
    let secondEntered = false;
    const first = a.runtimeMaintenanceTransaction(
      () => {},
      async () => {
        entered.release();
        await hold.promise;
      },
    );
    await entered.promise;
    const second = b.runtimeMaintenanceTransaction(
      () => {},
      async () => {
        secondEntered = true;
      },
    );
    // Attach rejection handling before yielding: the original busy_timeout bug
    // rejects the second write while preventing the first callback continuing.
    const results = Promise.allSettled([first, second]);
    await tick();
    assert.equal(secondEntered, false);
    hold.release();
    assert.deepEqual(
      (await results).map((result) => result.status),
      ['fulfilled', 'fulfilled'],
    );
    assert.equal(secondEntered, true);
  });
}

for (const kind of ['update', 'insert', 'delete', 'sql', 'transaction']) {
  test(`ordinary ${kind} waits for another owner's maintenance transaction`, async (t) => {
    const f = fixture(t),
      file = f.create('business.db'),
      a = f.open(file),
      b = f.open(file);
    const entered = latch(),
      hold = latch();
    const first = a.runtimeMaintenanceTransaction(
      () => {},
      async () => {
        entered.release();
        await hold.promise;
      },
    );
    await entered.promise;
    const write =
      kind === 'update'
        ? b.update({ table: 'item', key: { id: 1 }, values: { name: 'updated' } })
        : kind === 'insert'
          ? b.insert({ table: 'item', values: { id: 2, name: 'inserted' } })
          : kind === 'delete'
            ? b.remove({ table: 'item', key: { id: 1 } })
            : kind === 'sql'
              ? b.runSql({ text: "UPDATE item SET name='sql' WHERE id=1", write: true, limit: 10 })
              : b.transaction(async (tx) => {
                  await tx.update({ table: 'item', key: { id: 1 }, values: { name: 'transaction' } });
                });
    let settled = false;
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const results = Promise.allSettled([first, write]);
    await tick();
    const wasPending = !settled;
    hold.release();
    assert.deepEqual(
      (await results).map((result) => result.status),
      ['fulfilled', 'fulfilled'],
    );
    assert.equal(wasPending, true, 'must yield instead of blocking until SQLITE_BUSY');
  });
}

test('different SQLite files progress independently while same-file rollback releases queued work', async (t) => {
  const f = fixture(t),
    file = f.create('first.db'),
    a = f.open(file),
    b = f.open(file),
    c = f.open(f.create('second.db'));
  const entered = latch(),
    hold = latch();
  const failing = a.runtimeMaintenanceTransaction(
    () => {},
    async () => {
      entered.release();
      await hold.promise;
      throw new Error('intentional rollback');
    },
  );
  const rejected = assert.rejects(failing, /intentional rollback/);
  await entered.promise;
  await c.update({ table: 'item', key: { id: 1 }, values: { name: 'independent' } });
  const pending = b.update({ table: 'item', key: { id: 1 }, values: { name: 'after rollback' } });
  hold.release();
  await rejected;
  await pending;
  assert.equal((await b.query({ table: 'item', limit: 10, offset: 0 })).rows[0].name, 'after rollback');
  await a.update({ table: 'item', key: { id: 1 }, values: { name: 'next queue' } });
  assert.equal((await b.query({ table: 'item', limit: 10, offset: 0 })).rows[0].name, 'next queue');
});

test('nested writes refuse before queuing on the same handle or an alias, but transaction methods remain usable', async (t) => {
  const f = fixture(t),
    file = f.create('first.db'),
    a = f.open(file),
    b = f.open(file),
    c = f.open(f.create('second.db'));
  await a.transaction(async (tx) => {
    const update = { table: 'item', key: { id: 1 }, values: { name: 'nested' } };
    await assert.rejects(a.update(update), /active transaction writer/);
    await assert.rejects(b.update(update), /active transaction writer/);
    await assert.rejects(
      b.transaction(async () => {}),
      /active transaction writer/,
    );
    // Nested cross-file acquisition is also refused: a concurrent opposite
    // acquisition could otherwise create a cycle outside this call's ancestry.
    await assert.rejects(
      c.transaction(async () => {}),
      /active transaction writer/,
    );
    await tx.update({ ...update, values: { name: 'owned' } });
  });
  assert.equal((await b.query({ table: 'item', limit: 10, offset: 0 })).rows[0].name, 'owned');
  await b.update({ table: 'item', key: { id: 1 }, values: { name: 'later' } });
});

test('independent opposite-order cross-file nested writes refuse instead of deadlocking', async (t) => {
  const f = fixture(t),
    firstFile = f.create('first.db'),
    secondFile = f.create('second.db');
  const a = f.open(firstFile),
    b = f.open(secondFile),
    a2 = f.open(firstFile),
    b2 = f.open(secondFile);
  const first = latch(),
    second = latch();
  const update = { table: 'item', key: { id: 1 }, values: { name: 'nested' } };
  await Promise.all([
    a.transaction(async () => {
      first.release();
      await second.promise;
      await assert.rejects(b2.update(update), /active transaction writer/);
    }),
    b.transaction(async () => {
      second.release();
      await first.promise;
      await assert.rejects(a2.update(update), /active transaction writer/);
    }),
  ]);
  await a.update(update);
  await b.update(update);
});

for (const opened of [false, true]) {
  test(`file replacement refuses an old owner before ${opened ? 'existing' : 'lazy'} writer access`, async (t) => {
    const f = fixture(t),
      file = f.create('business.db'),
      a = f.open(file);
    if (opened) await a.update({ table: 'item', key: { id: 1 }, values: { name: 'old' } });
    const replacement = f.create('replacement.db');
    renameSync(file, join(f.directory, 'retired.db'));
    renameSync(replacement, file);
    const b = f.open(file);
    await assert.rejects(
      a.transaction(async () => {}),
      /SQLite file changed/,
    );
    await assert.rejects(a.update({ table: 'item', key: { id: 1 }, values: { name: 'must not apply' } }), /SQLite file changed/);
    await b.update({ table: 'item', key: { id: 1 }, values: { name: 'new owner' } });
    assert.equal((await b.query({ table: 'item', limit: 10, offset: 0 })).rows[0].name, 'new owner');
  });
}

test('retained async context of a completed transaction does not poison later independent writes', async (t) => {
  const f = fixture(t),
    file = f.create('first.db'),
    a = f.open(file),
    b = f.open(file);
  const release = latch();
  let later!: Promise<unknown>;
  await a.transaction(async () => {
    later = release.promise.then(() => b.update({ table: 'item', key: { id: 1 }, values: { name: 'later' } }));
  });
  release.release();
  await later;
  assert.equal((await b.query({ table: 'item', limit: 10, offset: 0 })).rows[0].name, 'later');
});
