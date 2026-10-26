import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refusal, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { runScopedTransactionFacade } from '../packages/mistri/src/server/policy/scopedTransactionFacade.js';

function records() {
  const calls: string[] = [];
  const tx: WriteTransaction = {
    query: async (request) => {
      calls.push(request.table);
      return { columns: [], rows: [], ms: 0, sql: { text: '', params: [] } };
    },
    count: async (table) => {
      calls.push(table);
      return 0;
    },
    insert: async (request) => {
      calls.push(request.table);
      return { key: { id: 1 }, applied: request.values, sql: { text: '', params: [] } };
    },
    update: async (request) => {
      calls.push(request.table);
      return { affected: 1, applied: request.values, sql: { text: '', params: [] } };
    },
    remove: async (request) => {
      calls.push(request.table);
      return { affected: 1, sql: { text: '', params: [] } };
    },
  };
  return { tx, calls };
}

test('scoped facade snapshots before queueing and drains unawaited successful work', async () => {
  const { tx, calls } = records();
  const value = await runScopedTransactionFacade(tx, async (scoped) => {
    const request = { table: 'captured', values: { name: 'Original' } };
    const work = scoped.insert(request);
    request.table = 'mutated';
    request.values.name = 'Changed';
    assert.deepEqual({ ...(await work).applied }, { name: 'Original' });
    void scoped.count('drained');
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(calls, ['captured', 'drained']);
});

test('synchronous facade refusals poison completion and block already queued operations', async () => {
  const { tx, calls } = records();
  tx.query = () => {
    throw new Refusal('Mapping denied');
  };
  await assert.rejects(
    runScopedTransactionFacade(tx, async (scoped) => {
      await scoped.count('earlier');
      const failed = scoped.query({ table: 'forbidden', limit: 1, offset: 0 });
      const pending = scoped.insert({ table: 'must not execute', values: {} });
      await assert.rejects(failed, /Mapping denied/);
      await assert.rejects(pending, /failed/);
      await assert.rejects(scoped.count('also blocked'), /failed/);
      return 'caught errors cannot succeed';
    }),
    /Mapping denied/,
  );
  assert.deepEqual(calls, ['earlier']);
});

test('scoped facade captures malformed data without invoking accessors and expires every method', async () => {
  const { tx, calls } = records();
  let escaped!: WriteTransaction;
  let accessed = false;
  await assert.rejects(
    runScopedTransactionFacade(tx, async (scoped) => {
      escaped = scoped;
      const invalid = Object.defineProperty({ table: 'item', values: {} }, 'values', {
        enumerable: true,
        get: () => {
          accessed = true;
          return {};
        },
      });
      void scoped.insert(invalid);
    }),
    Refusal,
  );
  assert.equal(accessed, false);
  assert.deepEqual(calls, []);
  for (const operation of [
    () => escaped.query({ table: 'late', limit: 1, offset: 0 }),
    () => escaped.count('late'),
    () => escaped.insert({ table: 'late', values: {} }),
    () => escaped.update({ table: 'late', key: { id: 1 }, values: { name: 'late' } }),
    () => escaped.remove({ table: 'late', key: { id: 1 } }),
  ])
    await assert.rejects(operation, /no longer active/);
  assert.deepEqual(calls, []);
});
