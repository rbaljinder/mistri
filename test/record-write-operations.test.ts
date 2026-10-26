import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  Refusal,
  TransactionOutcomeUnknown,
  WriteConflict,
  type Adapter,
  type QueryRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { runTool } from '../packages/tablewalk/src/server/mcp.js';
import { clearJournal, history, lastRevertible, recordWrite } from '../packages/engine/src/server/journal.js';
import {
  changingReferences,
  deletionDependents,
  recordedUpdate,
  recordedInsert,
  recordedDelete,
} from '../packages/engine/src/server/recordWriteOperations.js';

const sql = { text: '', params: [] };
const request = { table: 'item', key: { id: 1 }, values: { name: 'new' } };
let sequence = 0;
function fake(t: TestContext, overrides: Partial<WriteTransaction> = {}) {
  const connection = `record-write-${sequence++}`;
  t.after(() => clearJournal(connection));
  const calls: string[] = [];
  let stored: Record<string, unknown> | undefined;
  const tx: WriteTransaction = {
    lockRecord: async () => {},
    query: async (r) => {
      calls.push('read');
      const row = stored ?? { name: 'actual' };
      return { rows: [row], columns: r.columns ?? Object.keys(row), ms: 0, sql };
    },
    count: async () => 1,
    update: async (r) => {
      calls.push('update');
      stored = { ...stored, ...r.values };
      return { affected: 1, applied: r.values, sql };
    },
    insert: async (r) => {
      calls.push('insert');
      stored = { id: 2, ...r.values, defaulted: 'stored' };
      return { key: { id: 2 }, row: stored, applied: r.values, sql };
    },
    remove: async () => {
      calls.push('delete');
      return { affected: 1, sql };
    },
    ...overrides,
  };
  const adapter = {
    query: async () => {
      assert.fail('must not read through the separate adapter');
    },
    update: async () => {
      assert.fail('must not write outside the transaction');
    },
    insert: async () => {
      assert.fail('must not write outside the transaction');
    },
    remove: async () => {
      assert.fail('must not write outside the transaction');
    },
    transaction: async <T>(run: (writer: WriteTransaction) => Promise<T>) => {
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
  } as unknown as Adapter;
  return { adapter, connection, calls, tx };
}

function older(connection: string) {
  return recordWrite(connection, {
    kind: 'update',
    summary: 'Older edit',
    revertible: true,
    steps: [{ table: 'item', key: { id: 1 }, before: { name: 'old' }, after: { name: 'actual' } }],
  });
}

test('update captures touched actual values on the writer and publishes only after commit', async (t) => {
  let storedName = 'actual';
  const f = fake(t, {
    query: async (r: QueryRequest) => {
      assert.deepEqual(r.columns, ['name']);
      assert.deepEqual(r.filter?.groups[0][0], { column: 'id', op: '=', value: 1 });
      assert.equal(r.limit, 2);
      return { rows: [{ name: storedName }], columns: ['name'], ms: 0, sql };
    },
    update: async (r) => {
      assert.deepEqual({ ...r.expected }, { name: 'caller-claim' });
      storedName = 'coerced';
      return { affected: 1, applied: { name: 'coerced' }, sql };
    },
  });
  const result = await recordedUpdate(
    {
      ...f,
      by: 'Operator',
      record: (connection, entry) => {
        assert.equal(f.calls.at(-1), 'commit');
        return recordWrite(connection, entry);
      },
    },
    { ...request, expected: { name: 'caller-claim' } },
  );
  const entry = history(f.connection)[0];
  assert.equal(result.undoId, entry.id);
  assert.equal(entry.by, 'Operator');
  assert.deepEqual(entry.steps, [
    { table: 'item', key: { id: 1 }, before: { name: 'actual' }, after: { name: 'coerced' }, exactFields: true },
  ]);
  assert.deepEqual(result.result.applied, { name: 'coerced' });
});

test('request is detached before a transaction waits for its writer', async (t) => {
  const f = fake(t);
  const input = structuredClone(request);
  const transaction = f.adapter.transaction!;
  f.adapter.transaction = (run) => {
    input.key.id = 99;
    input.values.name = 'changed while waiting';
    return transaction(run);
  };
  await recordedUpdate(f, input);
  assert.deepEqual(history(f.connection)[0].steps[0].key, { id: 1 });
  assert.deepEqual(history(f.connection)[0].steps[0].after, { name: 'new' });
});

test('journal ownership and inverse permission are captured before writer acquisition', async (t) => {
  const f = fake(t);
  const options = { ...f, by: 'verified operator', completeInverse: false, record: recordWrite };
  const transaction = f.adapter.transaction!;
  f.adapter.transaction = (run) => {
    options.connection = 'another owner';
    options.by = 'changed attribution';
    options.completeInverse = true;
    options.record = () => {
      assert.fail('must use the captured publisher');
    };
    return transaction(run);
  };
  const saved = await recordedInsert(options, request);
  assert.equal(saved.undoId, undefined);
  assert.equal(history(f.connection)[0].by, 'verified operator');
  assert.equal(history(f.connection)[0].blocksUndo, true);
});

for (const operation of [recordedUpdate, recordedDelete]) {
  test(`${operation.name} refuses an unfenced transaction before reading or writing`, async (t) => {
    const f = fake(t);
    delete f.tx.lockRecord;
    await assert.rejects(operation(f, request), /record-lock capability/);
    assert.deepEqual(f.calls, ['begin', 'rollback']);
    assert.deepEqual(history(f.connection), []);
  });
}

test('insertion without a record-lock capability has no advertised Undo', async (t) => {
  const f = fake(t);
  delete f.tx.lockRecord;
  const result = await recordedInsert(f, request);
  assert.equal(result.undoId, undefined);
  assert.equal(history(f.connection)[0].blocksUndo, true);
});

for (const [name, operation, input] of [
  ['update', recordedUpdate, request],
  ['insert', recordedInsert, request],
  ['delete', recordedDelete, request],
] as const) {
  test(`${name} refuses a missing transaction without invoking a direct write`, async (t) => {
    const f = fake(t);
    delete f.adapter.transaction;
    await assert.rejects(operation(f, input), Refusal);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(history(f.connection), []);
  });

  test(`${name} retains explicit uncertainty even when its cause is a known constraint`, async (t) => {
    const f = fake(t);
    older(f.connection);
    const error = new TransactionOutcomeUnknown(Object.assign(new Refusal('private constraint detail'), { code: '23505' }));
    f.adapter.transaction = async () => {
      throw error;
    };
    await assert.rejects(operation(f, input), (caught) => caught === error);
    const entry = history(f.connection)[0];
    assert.equal(entry.undoState, 'unknown');
    assert.deepEqual(entry.steps, [{ table: 'item' }]);
    assert.doesNotMatch(JSON.stringify(entry), /private constraint detail|actual|new/);
    assert.equal(lastRevertible(f.connection), undefined);
  });

  test(`${name} journal publication failure after commit becomes unknown and attempts a barrier`, async (t) => {
    const f = fake(t);
    older(f.connection);
    let attempts = 0;
    await assert.rejects(
      operation(
        {
          ...f,
          record: (connection, entry) => {
            attempts++;
            assert.equal(f.calls.at(-1), 'commit');
            if (attempts === 1) throw new Refusal('publication unavailable');
            return recordWrite(connection, entry);
          },
        },
        input,
      ),
      TransactionOutcomeUnknown,
    );
    assert.equal(attempts, 2);
    assert.equal(history(f.connection)[0].undoState, 'unknown');
    assert.equal(lastRevertible(f.connection), undefined);
  });
}

for (const operation of [recordedUpdate, recordedDelete]) {
  test(`${operation.name} never continues after a failed transactional read`, async (t) => {
    const refusal = new Refusal('field unavailable');
    const f = fake(t, {
      query: async () => {
        throw refusal;
      },
    });
    await assert.rejects(operation(f, request), (error) => error === refusal);
    assert.deepEqual(f.calls, ['begin', 'rollback']);
    assert.deepEqual(history(f.connection), []);
  });
  test(`${operation.name} records a known barrier when a confirmed write has no original`, async (t) => {
    const f = fake(t, { query: async () => ({ rows: [], columns: [], ms: 0, sql }) });
    older(f.connection);
    const result = await operation(f, request);
    assert.equal(result.result.affected, 1);
    assert.equal(result.undoId, undefined);
    assert.equal(history(f.connection)[0].undoState, undefined);
    assert.equal(history(f.connection)[0].blocksUndo, true);
    assert.equal(lastRevertible(f.connection), undefined);
  });
}

test('conditional conflicts preserve the original error and do not publish history', async (t) => {
  const error = new WriteConflict();
  const f = fake(t, {
    update: async () => {
      throw error;
    },
  });
  await assert.rejects(recordedUpdate(f, { ...request, expected: { name: 'stale' } }), (caught) => caught === error);
  assert.equal(f.calls.at(-1), 'rollback');
  assert.deepEqual(history(f.connection), []);
});

test('confirmed constraint rollback remains a rejection without an uncertainty barrier', async (t) => {
  const error = Object.assign(new Error('constraint'), { code: '23505' });
  const f = fake(t, {
    insert: async () => {
      throw error;
    },
  });
  await assert.rejects(recordedInsert(f, request), (caught) => caught === error);
  assert.deepEqual(history(f.connection), []);
});

test('even repeated journal failures cannot replace a postcommit unknown with a refusal', async (t) => {
  const f = fake(t);
  const previous = older(f.connection);
  let attempts = 0;
  await assert.rejects(
    recordedInsert(
      {
        ...f,
        record: () => {
          attempts++;
          throw new Refusal('journal offline');
        },
      },
      request,
    ),
    TransactionOutcomeUnknown,
  );
  assert.equal(attempts, 2);
  assert.equal(f.calls.at(-1), 'commit');
  assert.equal(lastRevertible(f.connection), undefined);
  assert.equal(previous.undoState, 'unknown');
});

test('failed publication quarantines only captured physical source and verified history owner without a clock', async (t) => {
  const f = fake(t);
  const own = { principal: 'alice', app: 'loans' };
  const prior = older(f.connection);
  Object.assign(prior, own);
  const other = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Other account',
    revertible: true,
    principal: 'bob',
    app: 'loans',
    steps: [],
  });
  const otherApp = recordWrite(f.connection, {
    kind: 'update',
    summary: 'Other App',
    revertible: true,
    principal: 'alice',
    app: 'other',
    steps: [],
  });
  const otherSource = older(`${f.connection}-other`);
  t.after(() => clearJournal(`${f.connection}-other`));
  let attempts = 0;
  const options = {
    ...f,
    historyOwner: own,
    record: () => {
      attempts++;
      throw new Refusal('publication unavailable');
    },
  };
  const transaction = f.adapter.transaction!.bind(f.adapter);
  f.adapter.transaction = (run) => {
    own.principal = 'bob';
    options.connection = 'changed-after-capture';
    return transaction(run);
  };
  t.mock.method(Date.prototype, 'toISOString', () => {
    throw new Error('clock unavailable');
  });
  await assert.rejects(recordedUpdate(options, request), TransactionOutcomeUnknown);
  assert.equal(attempts, 2);
  assert.equal(prior.undoState, 'unknown');
  assert.equal(prior.revertible, false);
  assert.equal(other.undoState, undefined);
  assert.equal(otherApp.undoState, undefined);
  assert.equal(otherSource.undoState, undefined);
});

test('insert returns the full projected adapter row and marks its whole-row inverse', async (t) => {
  const f = fake(t);
  const result = await recordedInsert(f, request);
  assert.deepEqual(result.result.row, { id: 2, name: 'new', defaulted: 'stored' });
  const step = history(f.connection)[0].steps[0];
  assert.deepEqual(step.after, result.result.row);
  assert.equal(Reflect.get(step, 'wholeRow'), true);
  assert.ok(result.undoId);
  result.result.row!.name = 'response changed';
  assert.equal(step.after!.name, 'new');
});

test('field-limited creation succeeds with its projected row and a known inverse barrier', async (t) => {
  const f = fake(t, { insert: async () => ({ key: { id: 2 }, row: { name: 'visible' }, applied: { name: 'visible' }, sql }) });
  older(f.connection);
  const result = await recordedInsert({ ...f, completeInverse: false }, request);
  assert.deepEqual(result.result.row, { name: 'visible' });
  assert.equal(result.undoId, undefined);
  assert.equal(history(f.connection)[0].blocksUndo, true);
  assert.equal(history(f.connection)[0].undoState, undefined);
  assert.equal(lastRevertible(f.connection), undefined);
});

test('an insert without a stored row cannot advertise an inverse', async (t) => {
  const f = fake(t, { insert: async () => ({ key: { id: 2 }, applied: request.values, sql }) });
  const result = await recordedInsert(f, request);
  assert.equal(result.undoId, undefined);
  assert.equal(history(f.connection)[0].blocksUndo, true);
});

test('delete captures the complete actual row through the transaction', async (t) => {
  const row = { id: 1, name: 'actual', omitted: 'must restore' };
  const f = fake(t, {
    query: async (r) => {
      assert.equal(r.columns, undefined);
      return { rows: [row], columns: Object.keys(row), ms: 0, sql };
    },
  });
  await recordedDelete(f, request);
  assert.deepEqual(history(f.connection)[0].steps[0].before, row);
  assert.deepEqual(f.calls, ['begin', 'delete', 'commit']);
});

test('custom history callback owns physical source and account attribution, including unknown barriers', async (t) => {
  const f = fake(t);
  const connection = `${f.connection}-secondary`;
  t.after(() => clearJournal(connection));
  const record: typeof recordWrite = (owner, entry) => {
    assert.equal(owner, connection);
    assert.equal(entry.steps[0].table, 'item');
    return recordWrite(owner, {
      ...entry,
      principal: 'account',
      app: 'application',
      steps: entry.steps.map((step) => ({ ...step, table: 'physical_item' })),
    });
  };
  await recordedUpdate({ ...f, connection, record }, request);
  f.adapter.transaction = async () => {
    throw new TransactionOutcomeUnknown(new Error('lost'));
  };
  await assert.rejects(recordedInsert({ ...f, connection, record }, request), TransactionOutcomeUnknown);
  assert.deepEqual(history(f.connection), []);
  for (const entry of history(connection)) {
    assert.equal(entry.principal, 'account');
    assert.equal(entry.app, 'application');
    assert.equal(entry.steps[0].table, 'physical_item');
  }
  assert.equal(lastRevertible(connection), undefined);
});

function sqlite(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-writes-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT DEFAULT 'default', extra TEXT DEFAULT 'stored'); INSERT INTO item (id,name) VALUES (1,'original'); CREATE TABLE keyless (name TEXT); CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES item(id) ON DELETE CASCADE); INSERT INTO child VALUES (1,1);",
  );
  const adapter = new SqliteAdapter(file);
  const connection = `record-sqlite-${sequence++}`;
  t.after(async () => {
    await adapter.close();
    db.close();
    clearJournal(connection);
    rmSync(directory, { recursive: true, force: true });
  });
  return { adapter, connection, db, file };
}

test('real SQLite update captures a writer change and rejects forged expected values', async (t) => {
  const f = sqlite(t);
  const transaction = f.adapter.transaction.bind(f.adapter);
  f.adapter.transaction = (run) =>
    transaction(async (tx) => {
      await tx.update({ ...request, values: { name: 'changed on writer' } });
      return run(tx);
    });
  await recordedUpdate(f, request);
  assert.deepEqual(history(f.connection)[0].steps[0].before, { name: 'changed on writer' });
  f.adapter.transaction = transaction;
  await assert.rejects(recordedUpdate(f, { ...request, expected: { name: 'forged' } }), WriteConflict);
  assert.equal(history(f.connection).length, 1);
  assert.equal(f.db.prepare('SELECT name FROM item WHERE id=1').get()!.name, 'new');
});

test('real SQLite keyless creation uses its supported transaction and blocks older Undo', async (t) => {
  const f = sqlite(t);
  older(f.connection);
  const result = await recordedInsert(f, { table: 'keyless', values: { name: 'created' } });
  assert.deepEqual(result.result.key, {});
  assert.deepEqual(result.result.row, { name: 'created' });
  assert.equal(result.undoId, undefined);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM keyless').get()!.n, 1);
  assert.equal(lastRevertible(f.connection), undefined);
});

test('ordinary deletion leaves cascades adapter-owned and captures only the deleted row', async (t) => {
  const f = sqlite(t);
  await recordedDelete(f, request);
  assert.deepEqual(history(f.connection)[0].steps, [
    { table: 'item', key: { id: 1 }, before: { id: 1, name: 'original', extra: 'stored' }, wholeRow: true },
  ]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM child').get()!.n, 0);
});

test('a deletion whose cascade reached a row is a barrier, so it is undone whole or not at all', async (t) => {
  const f = sqlite(t);
  const dependents = changingReferences(await f.adapter.introspect(), 'item');
  assert.deepEqual(
    dependents.map((fk) => fk.from.table),
    ['child'],
  );
  const { undoId } = await recordedDelete(f, request, { references: dependents });
  assert.equal(undoId, undefined);
  const [entry] = history(f.connection);
  assert.equal(entry.revertible, false);
  assert.equal(entry.blocksUndo, true);
  assert.match(entry.reason!, /cannot be undone/);
  assert.equal(lastRevertible(f.connection), undefined);
  // Nothing behind the reference: the row alone is the whole deletion.
  f.db.exec("INSERT INTO item (id, name) VALUES (2, 'alone')");
  assert.ok((await recordedDelete(f, { table: 'item', key: { id: 2 } }, { references: dependents })).undoId);
  // A reference from a table the writer cannot read is a barrier whatever it holds.
  const catalog = await f.adapter.introspect();
  assert.deepEqual(
    deletionDependents(catalog, 'item', () => undefined),
    { references: [], unseen: true },
  );
  assert.equal(deletionDependents(catalog, 'nowhere', (table) => table).unseen, true);
  f.db.exec("INSERT INTO item (id, name) VALUES (3, 'alone too')");
  assert.equal((await recordedDelete(f, { table: 'item', key: { id: 3 } }, { unseen: true })).undoId, undefined);
});

test('MCP single-row writes preserve expected guards and truthful unknown results in process', async (t) => {
  const f = sqlite(t);
  const registry = new Registry();
  registry.add({ id: f.connection, name: f.connection, url: f.file, source: 'config', writable: true });
  t.after(() => registry.closeAll());
  const { adapter } = await registry.open(f.connection);
  const conflict = await runTool(registry, 'update', {
    connection: f.connection,
    table: 'item',
    key: { id: 1 },
    set: { name: 'bad' },
    expected: { name: 'forged' },
  });
  assert.equal(conflict.isError, true);
  assert.equal(f.db.prepare('SELECT name FROM item WHERE id=1').get()!.name, 'original');
  const updated = await runTool(registry, 'update', {
    connection: f.connection,
    table: 'item',
    key: { id: 1 },
    set: { name: 'new' },
    expected: { name: 'original' },
  });
  assert.equal(updated.isError, false);
  assert.equal(updated.structuredContent!.link, `/${f.connection}/item/~1`);
  assert.deepEqual(history(f.connection)[0].steps[0].before, { name: 'original' });
  adapter.transaction = async () => {
    throw new TransactionOutcomeUnknown(Object.assign(new Error('constraint'), { code: '23505' }));
  };
  for (const name of ['insert', 'delete', 'update']) {
    const result = await runTool(registry, name, {
      connection: f.connection,
      table: 'item',
      ...(name === 'insert'
        ? { values: { name: 'another' } }
        : { key: { id: 1 }, ...(name === 'delete' ? { confirm: true } : { set: { name: 'unknown' } }) }),
    });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent!.outcome, 'unknown');
    if (name !== 'update') assert.equal(result.structuredContent![name === 'insert' ? 'inserted' : 'deleted'], null);
    assert.equal(lastRevertible(f.connection), undefined);
  }
});
