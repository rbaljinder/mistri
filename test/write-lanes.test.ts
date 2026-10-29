/**
 * The order writes run in (packages/engine/src/adapters/writeLanes.ts), without a database:
 * the database browser's one-at-a-time queue, an App's lanes by record, the
 * `all` barrier raw SQL and shutdown take, the lane an App's save names from
 * outside its adapter, and which failures are a lock wait that ran out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WriteLanes, inRecordLane, inWriteLanes, keyedLane, lockTimedOut, recordLane } from '../packages/engine/src/adapters/writeLanes.js';

/** A write that runs until released, noting when it started and ended. */
function held(log: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    work: async () => {
      log.push(`${name}+`);
      await gate;
      log.push(`${name}-`);
      return name;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('serial order: every write waits for the one before it, whatever it names', async () => {
  const lanes = new WriteLanes('serial');
  const log: string[] = [];
  const a = held(log, 'a'),
    b = held(log, 'b');
  const first = lanes.run([recordLane('t', { id: 1 })], a.work);
  const second = lanes.run([recordLane('t', { id: 2 })], b.work);
  await tick();
  assert.deepEqual(log, ['a+']);
  a.release();
  await first;
  await tick();
  assert.deepEqual(log, ['a+', 'a-', 'b+']);
  b.release();
  assert.equal(await second, 'b');
});

test("keyed order: one record's writes run in the order they arrived, other records beside them", async () => {
  const lanes = new WriteLanes('keyed');
  const log: string[] = [];
  const a1 = held(log, 'a1'),
    a2 = held(log, 'a2'),
    b = held(log, 'b');
  const lane = (id: unknown) => [recordLane('lead', { id })];
  const runs = [lanes.run(lane(1), a1.work), lanes.run(lane('1'), a2.work), lanes.run(lane(2), b.work)];
  await tick();
  // The address's '1' and the row's 1 are one lane; record 2 does not wait.
  assert.deepEqual(log, ['a1+', 'b+']);
  b.release();
  await runs[2];
  a1.release();
  await runs[0];
  await tick();
  assert.deepEqual(log, ['a1+', 'b+', 'b-', 'a1-', 'a2+']);
  a2.release();
  await Promise.all(runs);
});

test('a failed write does not stop its lane', async () => {
  const lanes = new WriteLanes('keyed');
  const lane = [recordLane('lead', { id: 1 })];
  const failed = lanes.run(lane, async () => {
    throw new Error('refused');
  });
  const next = lanes.run(lane, async () => 'written');
  await assert.rejects(failed, /refused/);
  assert.equal(await next, 'written');
});

test('`all` waits for every write before it and holds back every write after it', async () => {
  const lanes = new WriteLanes('keyed');
  const log: string[] = [];
  const a = held(log, 'a'),
    sql = held(log, 'sql'),
    b = held(log, 'b'),
    c = held(log, 'c');
  const runs = [
    lanes.run([recordLane('t', { id: 1 })], a.work),
    lanes.run('all', sql.work),
    lanes.run([recordLane('t', { id: 2 })], b.work),
    lanes.run([], c.work),
  ];
  await tick();
  assert.deepEqual(log, ['a+']);
  a.release();
  await runs[0];
  await tick();
  assert.deepEqual(log, ['a+', 'a-', 'sql+']);
  sql.release();
  await runs[1];
  await tick();
  assert.deepEqual(log.slice(3), ['sql-', 'b+', 'c+']);
  b.release();
  c.release();
  await Promise.all(runs);
});

test('a write that names no lane waits for nothing in keyed order', async () => {
  const lanes = new WriteLanes('keyed');
  const log: string[] = [];
  const a = held(log, 'a'),
    b = held(log, 'b');
  const runs = [lanes.run([recordLane('t', { id: 1 })], a.work), lanes.run([], b.work)];
  await tick();
  assert.deepEqual(log, ['a+', 'b+']);
  a.release();
  b.release();
  await Promise.all(runs);
});

test("an App save names its record's lane from outside the adapter, and only its own write takes it", async () => {
  const lanes = new WriteLanes('keyed');
  const log: string[] = [];
  const first = held(log, 'first');
  const running = lanes.run(keyedLane({ table: 'lead', key: { id: 7 } }), first.work);
  // A transaction names no lane of its own (PostgresAdapter.transaction); the hint gives it the record's.
  let nested: Promise<string> | undefined;
  const hinted = inRecordLane('lead', { id: 7 }, () =>
    lanes.run([], async () => {
      log.push('second+');
      // What the write starts runs outside the lane: were it inside, it would wait for itself.
      nested = lanes.run([], async () => 'nested');
      return 'second';
    }),
  );
  await tick();
  assert.deepEqual(log, ['first+']);
  first.release();
  await running;
  assert.equal(await hinted, 'second');
  assert.equal(await nested, 'nested');
});

test('keyedLane is empty for a request the adapter would refuse, and one lane for a key', () => {
  assert.deepEqual(keyedLane({ table: 'lead', key: undefined }), []);
  assert.deepEqual(keyedLane({ table: 'lead', key: [1] }), []);
  assert.deepEqual(keyedLane({ table: 7, key: { id: 1 } }), []);
  assert.deepEqual(keyedLane({ table: 'lead', key: { b: 2, a: 1 } }), [recordLane('lead', { a: '1', b: '2' })]);
});

test('a lock wait that ran out is recognized through its causes, and never inside an unknown outcome', () => {
  const pg = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  assert.equal(lockTimedOut(pg), true);
  assert.equal(lockTimedOut(Object.assign(new Error('rolled back'), { outcome: 'not_applied', cause: pg })), true);
  assert.equal(lockTimedOut(Object.assign(new Error('unknown'), { name: 'TransactionOutcomeUnknown', cause: pg })), false);
  assert.equal(lockTimedOut(Object.assign(new Error('unknown'), { outcome: 'unknown', cause: pg })), false);
  assert.equal(lockTimedOut(Object.assign(new Error('unique'), { code: '23505' })), false);
  assert.equal(lockTimedOut(undefined), false);
});

test('bulk target and receipt lanes enter together without a reversed-key deadlock', async () => {
  const lanes = new WriteLanes('keyed');
  const log: string[] = [];
  const first = held(log, 'first');
  const a = recordLane('lead', { id: 1 }),
    b = recordLane('lead', { id: 2 });
  const running = inWriteLanes([a, b, 'receipt'], () => lanes.run([], first.work));
  const reversed = inWriteLanes([b, a], () =>
    lanes.run([], async () => {
      log.push('bulk');
    }),
  );
  const replay = inWriteLanes(['receipt'], () =>
    lanes.run([], async () => {
      log.push('replay');
    }),
  );
  await tick();
  assert.deepEqual(log, ['first+']);
  first.release();
  await Promise.all([running, reversed, replay]);
  assert.deepEqual(log, ['first+', 'first-', 'bulk', 'replay']);
});
