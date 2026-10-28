/**
 * Reads asked together inside one transaction leave together (adapter.ts
 * TransactionOperations.read): a handler's `Promise.all` of three reads was
 * three round trips, each read waiting for the one before it although nothing
 * in one could change what another reads.
 *
 * Pinned here as the properties that keep it safe, without a database:
 * - reads in flight together start together, in the order asked, only where
 *   the transaction was told its writer sends together;
 * - a write waits for every operation asked before it, and a read asked after
 *   a write waits for it: only operations in flight together overlap;
 * - each operation settles in the order asked, and the first failure in that
 *   order is every later operation's, started or not, and finish()'s;
 * and against a live PostgreSQL (TABLEWALK_TEST_PG), through a latency relay,
 * that the three reads leave in one flight on the writer, and three awaited
 * one after another still take three.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { startLatencyProxy } from '../e2e/support/latencyProxy.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

/** Work that records when it started and ended, and answers `value` (or fails with it) after `ms`. */
function recorder() {
  const log: string[] = [];
  const work =
    <T>(name: string, ms: number, value: T, fails = false) =>
    async (): Promise<T> => {
      log.push(`start ${name}`);
      await delay(ms);
      log.push(`end ${name}`);
      if (fails) throw value;
      return value;
    };
  return { log, work };
}

describe('TransactionOperations: reads asked together', () => {
  test('on a transaction that sends together, reads in flight start together, in the order asked', async () => {
    const operations = new TransactionOperations(true);
    const { log, work } = recorder();
    const answers = await Promise.all([
      operations.read(work('a', 30, 1)),
      operations.read(work('b', 10, 2)),
      operations.read(work('c', 20, 3)),
    ]);
    assert.deepEqual(answers, [1, 2, 3]);
    assert.deepEqual(log.slice(0, 3), ['start a', 'start b', 'start c']);
    await operations.finish();
  });

  test('elsewhere a read waits for the operation before it, as every operation did', async () => {
    const operations = new TransactionOperations();
    const { log, work } = recorder();
    await Promise.all([operations.read(work('a', 20, 1)), operations.read(work('b', 5, 2))]);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
  });

  test('a write waits for every read asked before it, and a read after the write waits for it', async () => {
    const operations = new TransactionOperations(true);
    const { log, work } = recorder();
    await Promise.all([
      operations.read(work('r1', 20, 1)),
      operations.read(work('r2', 5, 2)),
      operations.run(work('w', 5, 3)),
      operations.read(work('r3', 5, 4)),
      operations.read(work('r4', 5, 5)),
    ]);
    assert.deepEqual(log.slice(0, 2), ['start r1', 'start r2']);
    assert.ok(log.indexOf('start w') > log.indexOf('end r1') && log.indexOf('start w') > log.indexOf('end r2'), log.join(', '));
    assert.ok(log.indexOf('start r3') > log.indexOf('end w'), log.join(', '));
    assert.ok(log.indexOf('start r4') < log.indexOf('end r3'), `reads after the write start together again: ${log.join(', ')}`);
  });

  test('a read awaited before the next is asked is answered before the next starts', async () => {
    const operations = new TransactionOperations(true);
    const { log, work } = recorder();
    await operations.read(work('a', 10, 1));
    await operations.read(work('b', 1, 2));
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
  });

  test('answers settle in the order asked, though a later read finished first', async () => {
    const operations = new TransactionOperations(true);
    const { work } = recorder();
    const settled: string[] = [];
    await Promise.all([
      operations.read(work('slow', 30, 'slow')).then(() => settled.push('slow')),
      operations.read(work('fast', 1, 'fast')).then(() => settled.push('fast')),
    ]);
    assert.deepEqual(settled, ['slow', 'fast']);
  });

  test('the first failure in the order asked is every later operation’s, started or not, and finish()’s', async () => {
    const operations = new TransactionOperations(true);
    const { log, work } = recorder();
    const first = new Error('first');
    const own = new Error('its own');
    const outcomes = await Promise.allSettled([
      operations.read(work('ok', 1, 'ok')),
      operations.read(work('fails', 20, first, true)),
      // Started beside the failing read, and answered first: it is answered with that failure, never its rows.
      operations.read(work('beside', 1, 'rows')),
      // Failed on its own, after the first failure: the first is the one said.
      operations.read(work('also fails', 5, own, true)),
      operations.run(work('write', 1, 'written')),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : (outcome.reason as Error).message)),
      ['ok', 'first', 'first', 'first', 'first'],
    );
    assert.ok(!log.includes('start write'), 'a write after a failure never runs');
    await assert.rejects(operations.finish(), (error) => error === first);
  });

  test('a later read failing leaves an earlier read its answer, as when it ran alone', async () => {
    const operations = new TransactionOperations(true);
    const { work } = recorder();
    const failed = new Error('later');
    const outcomes = await Promise.allSettled([
      operations.read(work('earlier', 20, 'rows')),
      operations.read(work('later', 1, failed, true)),
    ]);
    assert.equal(outcomes[0].status === 'fulfilled' && outcomes[0].value, 'rows');
    assert.equal(outcomes[1].status === 'rejected' && outcomes[1].reason, failed);
    await assert.rejects(operations.finish(), (error) => error === failed);
  });
});

describe('reads asked together on PostgreSQL leave in one flight', { skip: liveSkip('postgres', LIVE) }, () => {
  test('a Promise.all of three reads is one flight on a pipelining writer; awaited one by one, three', async (t) => {
    const database = await uuidPostgresDatabase('tw_reads_together');
    t.after(() => database.drop());
    const control = await pgClient(database.url);
    try {
      await control.query(`CREATE TABLE item (id integer PRIMARY KEY, name text NOT NULL);
        CREATE TABLE note (id integer PRIMARY KEY, item_id integer NOT NULL REFERENCES item (id), body text NOT NULL);
        INSERT INTO item VALUES (1, 'Alpha'), (2, 'Beta');
        INSERT INTO note VALUES (1, 1, 'first'), (2, 1, 'second'), (3, 2, 'third');`);
    } finally {
      await control.end();
    }
    const proxy = await startLatencyProxy(database.url, 5);
    t.after(() => proxy.close());
    const adapter = new PostgresAdapter(proxy.route(database.url), 'reads together', ['public']);
    t.after(() => adapter.close());
    const byId = (table: string, id: number) => ({
      table,
      filter: { groups: [[{ column: 'id', op: '=' as const, value: id }]] },
      limit: 1,
      offset: 0,
    });
    // Warm: each table is looked up once on the writer (assertTable), outside what is measured.
    await adapter.transaction(async (tx) => {
      await tx.query(byId('public.item', 1));
      await tx.query(byId('public.note', 1));
    });

    /** The flights that carried statements naming the tables read: the reads' own, not the BEGIN's or the COMMIT's. */
    const readFlights = (since: number) =>
      new Set(
        proxy
          .statements(since)
          .filter((statement) => /FROM "public"\."(item|note)"/.test(statement.text) && !/^\s*BEGIN/.test(statement.text))
          .map((statement) => `${statement.connection}:${statement.flight}`),
      ).size;

    let since = Date.now();
    const together = await adapter.transaction((tx) =>
      Promise.all([tx.query(byId('public.item', 1)), tx.query(byId('public.note', 3)), tx.count('public.note')]),
    );
    assert.deepEqual(
      [together[0].rows[0]?.name, together[1].rows[0]?.body, together[2]],
      ['Alpha', 'third', 3],
      'each read answers what it asked',
    );
    assert.equal(readFlights(since), 1, 'the three reads left together');

    since = Date.now();
    const oneByOne = await adapter.transaction(async (tx) => {
      const item = await tx.query(byId('public.item', 2));
      const note = await tx.query(byId('public.note', 1));
      return [item.rows[0]?.name, note.rows[0]?.body, await tx.count('public.note')];
    });
    assert.deepEqual(oneByOne, ['Beta', 'first', 3]);
    assert.equal(readFlights(since), 3, 'a read awaited before the next is asked keeps its own round trip');

    // A read that fails beside others: the transaction fails with that failure, and nothing after it runs.
    since = Date.now();
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await Promise.all([tx.query(byId('public.item', 1)), tx.count('public.missing_table'), tx.query(byId('public.note', 1))]);
        await tx.update({ table: 'public.item', key: { id: 1 }, values: { name: 'Changed' } });
      }),
    );
    const after = await adapter.transaction((tx) => tx.query(byId('public.item', 1)));
    assert.equal(after.rows[0]?.name, 'Alpha', 'the write after a failed read never ran');
  });
});
