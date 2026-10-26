import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, WriteConflict } from '../packages/engine/src/adapters/adapter.js';
import { snapshotScopedData } from '../packages/engine/src/adapters/scoped/scopedReads.js';
import type { JournalEntry } from '../packages/engine/src/server/journal.js';
import {
  runRecordedTransaction,
  type HistoryDraft,
  type PreparedWrite,
  type UnknownHistoryDraft,
} from '../packages/engine/src/server/recordHistoryOperations.js';

function setup() {
  const events: string[] = [];
  const entries: HistoryDraft[] = [];
  const tx = Object.freeze({ identity: 'owned guarded writer' });
  const result = { affected: 1, applied: { name: 'stored' } };
  const entry: HistoryDraft = {
    kind: 'update',
    summary: 'Updated item',
    revertible: true,
    steps: [{ table: 'item', key: { id: 1 }, before: { name: 'original' }, after: { name: 'stored' } }],
  };
  const uncertainty: UnknownHistoryDraft = { kind: 'update', summary: 'Unconfirmed', revertible: false, undoState: 'unknown', steps: [] };
  const options = {
    mode: 'write' as const,
    transaction: async (work: (writer: typeof tx) => Promise<PreparedWrite<typeof result>>) => {
      events.push('begin');
      try {
        const prepared = await work(tx);
        events.push('commit');
        return prepared;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
    work: async (writer: typeof tx) => {
      assert.equal(writer, tx);
      events.push('work');
      return { result, entry };
    },
    history: {
      publish: (draft: HistoryDraft): JournalEntry => {
        events.push('publish');
        entries.push(structuredClone(draft));
        return { ...draft, id: entries.length, at: 'captured timestamp', connection: 'private bucket' };
      },
      quarantine: () => {
        events.push('quarantine');
      },
    },
    uncertainty,
    isRejection: (error: unknown): boolean => error instanceof Refusal || error instanceof WriteConflict,
  };
  return { options, tx, result, entry, events, entries };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('history runner publishes after confirmed transaction completion using the supplied writer', async () => {
  const f = setup();
  const answer = await runRecordedTransaction(f.options);
  assert.deepEqual(answer, { result: f.result, undoId: 1 });
  assert.equal(answer.result, f.result);
  assert.deepEqual(f.events, ['begin', 'work', 'commit', 'publish']);
  assert.deepEqual(f.entries, [f.entry]);
});

test('a confirmed non-invertible write still publishes its barrier without an Undo token', async () => {
  const f = setup();
  Object.assign(f.entry, { revertible: false, blocksUndo: true });
  assert.deepEqual(await runRecordedTransaction(f.options), { result: f.result });
  assert.deepEqual(f.entries, [f.entry]);
});

test('history evidence is detached inside the writer before its commit wait', async () => {
  const f = setup();
  const entered = gate(),
    held = gate();
  f.options.transaction = async (work) => {
    const captured = await work(f.tx);
    entered.release();
    await held.promise;
    return captured;
  };
  const expected = structuredClone(f.entry);
  const running = runRecordedTransaction(f.options);
  try {
    await entered.promise;
    assert.deepEqual(f.entries, []);
    f.entry.steps[0].before!.name = 'mutated original';
    f.entry.steps[0].key!.id = 99;
    f.entry.revertible = false;
  } finally {
    held.release();
  }
  const answer = await running;
  assert.equal(answer.undoId, 1);
  assert.deepEqual(f.entries, [expected]);
});

test('invalid history evidence rejects inside the transaction and cannot commit or publish', async () => {
  const f = setup();
  Reflect.set(f.entry.steps[0].before!, 'getter', () => 'not structured data');
  await assert.rejects(runRecordedTransaction(f.options), Refusal);
  assert.deepEqual(f.events, ['begin', 'work', 'rollback']);
  assert.deepEqual(f.entries, []);
});

for (const exceeds of [false, true]) {
  test(`combined history ${exceeds ? 'exceeding' : 'below'} the 1,048,576-character budget ${exceeds ? 'rolls back before commit without history' : 'commits and publishes'}`, async () => {
    const f = setup();
    const db = new DatabaseSync(':memory:');
    // snapshotScopedData counts string values AND object keys across the whole
    // draft, not serialized bytes or each image independently. Two 524,288-char
    // images exceed its 1,048,576-char limit once metadata is included. Leaving
    // 256 characters for this small draft's keys/metadata stays below the limit.
    const length = exceeds ? 524_288 : 524_160;
    const before = 'b'.repeat(length),
      after = 'a'.repeat(length);
    f.entry.steps[0].before = { name: before };
    f.entry.steps[0].after = { name: after };
    f.result.applied.name = after;
    // Each image is independently valid; refusal must concern their combined
    // history evidence, after the mutation but before its transaction commits.
    assert.doesNotThrow(() => snapshotScopedData(f.entry.steps[0].before));
    assert.doesNotThrow(() => snapshotScopedData(f.entry.steps[0].after));
    try {
      db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      db.prepare('INSERT INTO item VALUES (1, ?)').run(before);
      const options = {
        ...f.options,
        transaction: async (work: (tx: DatabaseSync) => Promise<PreparedWrite<typeof f.result>>) => {
          db.exec('BEGIN');
          f.events.push('begin');
          try {
            const prepared = await work(db);
            db.exec('COMMIT');
            f.events.push('commit');
            return prepared;
          } catch (error) {
            db.exec('ROLLBACK');
            f.events.push('rollback');
            throw error;
          }
        },
        work: async (tx: DatabaseSync) => {
          assert.equal(tx, db);
          assert.equal(tx.prepare('UPDATE item SET name = ? WHERE id = 1').run(after).changes, 1);
          f.events.push('work');
          return { result: f.result, entry: f.entry };
        },
      };
      if (exceeds) {
        await assert.rejects(runRecordedTransaction(options), (error) => {
          assert.ok(error instanceof Refusal);
          assert.equal(error.message, 'Invalid structured operation.');
          return true;
        });
        assert.deepEqual(f.events, ['begin', 'work', 'rollback']);
        assert.deepEqual(f.entries, [], 'neither normal nor uncertainty history may be published');
      } else {
        assert.equal((await runRecordedTransaction(options)).undoId, 1);
        assert.deepEqual(f.events, ['begin', 'work', 'commit', 'publish']);
        assert.deepEqual(f.entries, [f.entry]);
      }
      assert.equal(db.prepare('SELECT name FROM item WHERE id = 1').get()?.name, exceeds ? before : after);
    } finally {
      db.close();
    }
  });
}

test('invalid uncertainty evidence refuses before entering a writer', async () => {
  const f = setup();
  Reflect.set(f.options.uncertainty, 'bad', Infinity);
  await assert.rejects(runRecordedTransaction(f.options), Refusal);
  assert.deepEqual(f.events, []);
});

for (const error of [new Refusal('denied'), new WriteConflict(), Object.assign(new Error('constraint'), { code: '23505' })]) {
  test(`trusted classification preserves ${error.name}/${'code' in error ? error.code : error.message} rejection without publication`, async () => {
    const f = setup();
    let classifications = 0;
    f.options.isRejection = (seen) => {
      classifications++;
      assert.equal(seen, error);
      return true;
    };
    f.options.work = async () => {
      throw error;
    };
    await assert.rejects(runRecordedTransaction(f.options), (seen) => seen === error);
    assert.equal(classifications, 1);
    assert.deepEqual(f.events, ['begin', 'rollback']);
    assert.deepEqual(f.entries, []);
  });
}

for (const rejected of [false, true]) {
  test(`operation-specific classification ${rejected ? 'rejects' : 'preserves uncertainty for'} a known-looking driver error`, async () => {
    const f = setup();
    const error = Object.assign(new Error('constraint-shaped failure'), { code: '23505' });
    f.options.transaction = async () => {
      throw error;
    };
    f.options.isRejection = () => rejected;
    await assert.rejects(runRecordedTransaction(f.options), (seen) => {
      if (rejected) assert.equal(seen, error);
      else {
        assert.ok(seen instanceof TransactionOutcomeUnknown);
        assert.equal(seen.cause, error);
      }
      return true;
    });
    assert.deepEqual(f.entries, rejected ? [] : [f.options.uncertainty]);
  });
}

for (const stage of ['work', 'transaction'] as const) {
  for (const synchronous of [false, true]) {
    test(`${stage} ${synchronous ? 'synchronous throw' : 'rejection'} keeps unknown transaction outcome above classification`, async () => {
      const f = setup();
      const error = new TransactionOutcomeUnknown(new Refusal('constraint-like private cause'));
      const fail = () => {
        throw error;
      };
      f.options[stage] = synchronous ? fail : async () => fail();
      f.options.isRejection = () => {
        assert.fail('unknown must never enter the rejection classifier');
      };
      await assert.rejects(runRecordedTransaction(f.options), (seen) => seen === error);
      assert.deepEqual(f.entries, [f.options.uncertainty]);
      assert.equal(f.events.includes('quarantine'), false);
    });
  }
}

for (const doubleFailure of [false, true]) {
  test(`postcommit publication failure ${doubleFailure ? 'quarantines after one failed barrier' : 'publishes an uncertainty barrier'} even for Refusal`, async () => {
    const f = setup();
    const failure = new Refusal('publication unavailable');
    let calls = 0;
    const publish = f.options.history.publish;
    f.options.history.publish = (draft) => {
      calls++;
      if (calls === 1 || doubleFailure) throw failure;
      return publish(draft);
    };
    f.options.isRejection = () => {
      assert.fail('postcommit failures cannot become rejected writes');
    };
    await assert.rejects(runRecordedTransaction(f.options), (error) => {
      assert.ok(error instanceof TransactionOutcomeUnknown);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(f.events.filter((event) => event === 'commit').length, 1);
    assert.equal(f.events.filter((event) => event === 'quarantine').length, doubleFailure ? 1 : 0);
    assert.deepEqual(f.entries, doubleFailure ? [] : [f.options.uncertainty]);
  });
}

test('unknown execution with failed barrier publication quarantines once and retains the original outcome', async () => {
  const f = setup();
  const unknown = new TransactionOutcomeUnknown(new Error('lost acknowledgement'));
  f.options.transaction = async () => {
    throw unknown;
  };
  let attempts = 0;
  f.options.history.publish = () => {
    attempts++;
    throw new Error('second failure');
  };
  await assert.rejects(runRecordedTransaction(f.options), (error) => error === unknown);
  assert.equal(attempts, 1);
  assert.deepEqual(f.events, ['quarantine']);
});

test('transaction, work, classifier, history methods and uncertainty are captured before the writer wait', async () => {
  const f = setup();
  const capturedHistory = f.options.history;
  const expected = structuredClone(f.options.uncertainty);
  const entered = gate(),
    held = gate();
  const error = new Error('unclassified driver failure');
  let quarantined = 0,
    classified = 0,
    worked = 0;
  f.options.work = async function (writer) {
    assert.equal(this, f.options);
    assert.equal(writer, f.tx);
    worked++;
    throw error;
  };
  f.options.isRejection = function (seen) {
    assert.equal(this, f.options);
    assert.equal(seen, error);
    classified++;
    return false;
  };
  f.options.history.publish = function (draft) {
    assert.equal(this, capturedHistory);
    assert.deepEqual(structuredClone(draft), expected);
    throw new Error('publication failed');
  };
  f.options.history.quarantine = function () {
    assert.equal(this, capturedHistory);
    quarantined++;
  };
  f.options.transaction = async function (work) {
    assert.equal(this, f.options);
    entered.release();
    await held.promise;
    return work(f.tx);
  };
  const running = runRecordedTransaction(f.options);
  const rejected = assert.rejects(running, (error) => error instanceof TransactionOutcomeUnknown);
  try {
    await entered.promise;
    const unexpected = () => assert.fail('a replaced callback must not run');
    f.options.transaction = unexpected;
    f.options.work = unexpected;
    f.options.isRejection = unexpected;
    capturedHistory.publish = unexpected;
    capturedHistory.quarantine = unexpected;
    f.options.history = { publish: unexpected, quarantine: unexpected };
    f.options.uncertainty.summary = 'changed while waiting';
    f.options.uncertainty.steps.push({ table: 'another source' });
  } finally {
    held.release();
  }
  await rejected;
  assert.equal(worked, 1);
  assert.equal(classified, 1);
  assert.equal(quarantined, 1);
});

for (const fault of ['none', 'rejection', 'unknown'] as const) {
  test(`preview ${fault} never reads a history sink or classifier and never publishes`, async () => {
    const f = setup();
    const error = fault === 'unknown' ? new TransactionOutcomeUnknown(new Error('preview acknowledgement')) : new Refusal('preview denied');
    const options = {
      mode: 'preview' as const,
      transaction: async (work: (tx: typeof f.tx) => Promise<typeof f.result>) => work(f.tx),
      work: async (tx: typeof f.tx) => {
        assert.equal(tx, f.tx);
        if (fault !== 'none') throw error;
        return f.result;
      },
    };
    for (const key of ['history', 'uncertainty', 'isRejection'])
      Object.defineProperty(options, key, {
        get: () => assert.fail(`preview must not access ${key}`),
      });
    if (fault === 'none') assert.deepEqual(await runRecordedTransaction(options), { result: f.result });
    else await assert.rejects(runRecordedTransaction(options), (seen) => seen === error);
    assert.deepEqual(f.events, []);
  });
}
