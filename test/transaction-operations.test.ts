import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';

test('a failing queued read prevents every later operation from executing and preserves its error', async () => {
  const operations = new TransactionOperations();
  const failure = new Error('read failed');
  const called: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = operations.run(async () => {
    called.push('read');
    await gate;
    throw failure;
  });
  const nextRead = operations.run(async () => {
    called.push('next read');
  });
  const nextWrite = operations.run(async () => {
    called.push('next write');
  });
  const finished = operations.finish();
  release();
  for (const result of [read, nextRead, nextWrite, finished]) {
    await assert.rejects(result, (error) => error === failure);
  }
  assert.deepEqual(called, ['read']);
  await assert.rejects(
    operations.run(async () => {
      called.push('escaped');
    }),
    /no longer active/,
  );
  assert.deepEqual(called, ['read']);
});

test('catching a synchronous operation failure cannot resume a transaction queue', async () => {
  const operations = new TransactionOperations();
  const failure = new Error('synchronous failure');
  let laterCalled = false;
  await assert.rejects(
    operations.run(() => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    operations.run(async () => {
      laterCalled = true;
    }),
    (error) => error === failure,
  );
  await assert.rejects(operations.finish(), (error) => error === failure);
  assert.equal(laterCalled, false);
});

test('unawaited failed and skipped operations remain observed while finish reports the first failure', async () => {
  const operations = new TransactionOperations();
  const failure = new Error('unawaited failure');
  const unhandled: unknown[] = [];
  const notice = (error: unknown) => {
    unhandled.push(error);
  };
  let laterCalled = false;
  process.on('unhandledRejection', notice);
  try {
    void operations.run(async () => {
      throw failure;
    });
    void operations.run(async () => {
      laterCalled = true;
    });
    await assert.rejects(operations.finish(), (error) => error === failure);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(laterCalled, false);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', notice);
  }
});
