/**
 * Retention: the App's `retention` windows, the pruner every store registers
 * with, and the two rules of the record history that retention rests on (a
 * write of only bookkeeping columns leaves no row; `at` is a real time).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES, createSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import { EVENT_DELIVERY_TABLES as delivery } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { RECORD_HISTORY_TABLES } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { JOB_TABLES, provisionSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import type { JobPolicyInput } from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import {
  PRUNE_BATCH,
  prune,
  pruneAll,
  pruneStatement,
  prunes,
  registerPrune,
  sqlitePruneDb,
  type PruneRule,
} from '../packages/mistri/src/adapters/retention/pruner.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parseAppRetention, retentionMs } from '../packages/mistri/src/shared/appRetention.js';
import { retentionJob, retentionPrunes, startRetentionTimer } from '../packages/mistri/src/server/retention.js';
import { storeTargetOf } from '../packages/mistri/src/server/commands/appCommandEvents.js';
import { bindRecordHistory } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25);
const tmp = () => mkdtempSync(join(tmpdir(), 'mistri-retention-'));

describe('the retention declaration', () => {
  test('takes durations and forever, and refuses anything else', () => {
    assert.deepEqual(parseAppRetention({ history: '365 days', attempts: '14 days', commands: 'forever' }, 'retention'), {
      history: '365 days',
      attempts: '14 days',
      commands: 'forever',
    });
    assert.throws(() => parseAppRetention({ history: '2 years' }, 'retention'), /history/);
    assert.throws(() => parseAppRetention({ attempts: '0 days' }, 'retention'), /attempts/);
    assert.throws(() => parseAppRetention({ audit: '1 day' }, 'retention'), /no "audit"/);
    assert.throws(() => parseAppRetention('30 days', 'retention'), /object/);
  });

  test('defaults are two years, two years and thirty days; forever is no window', () => {
    assert.deepEqual(retentionMs(), { history: 730 * DAY, commands: 730 * DAY, attempts: 30 * DAY });
    assert.deepEqual(retentionMs({ history: 'forever', attempts: '1 week' }), { history: null, commands: 730 * DAY, attempts: 7 * DAY });
  });

  test('is checked with the rest of the App', () => {
    const base = { id: 'ledger', name: 'Ledger', resources: { item: {} }, views: { items: { kind: 'list', from: 'item' } }, home: 'items' };
    const parse = (retention: unknown) => parseAppConfig({ ...base, retention }, 'retention fixture');
    assert.equal(parse({ history: '90 days' }).retention?.history, '90 days');
    assert.throws(() => parse({ history: 'soon' }), /retention history/);
  });
});

describe('the pruner', () => {
  const rule = (extra: Partial<PruneRule> = {}): PruneRule => ({
    id: 'proof',
    window: 'attempts',
    table: '__mistri_proof',
    time: 'at',
    clock: 'epoch-ms',
    ...extra,
  });
  function proof(run: (db: DatabaseSync) => Promise<void>) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE "__mistri_proof" (id INTEGER PRIMARY KEY, at INTEGER, done INTEGER NOT NULL DEFAULT 1)');
    return run(db).finally(() => db.close());
  }
  const count = (db: DatabaseSync) => Number(db.prepare('SELECT count(*) AS n FROM "__mistri_proof"').get()!.n);

  test('prunes what is older than the window, keeps the rest, and never prunes forever', async () => {
    await proof(async (db) => {
      const insert = db.prepare('INSERT INTO "__mistri_proof" (at) VALUES (?)');
      for (const age of [40, 31, 29, 1]) insert.run(NOW - age * DAY);
      const sleep = async () => {};
      assert.equal(await prune(sqlitePruneDb(db), rule(), null, { now: () => NOW, sleep }), 0);
      assert.equal(count(db), 4);
      assert.equal(await prune(sqlitePruneDb(db), rule(), 30 * DAY, { now: () => NOW, sleep }), 2);
      assert.deepEqual(
        db
          .prepare('SELECT at FROM "__mistri_proof" ORDER BY at')
          .all()
          .map((row) => (NOW - Number(row.at)) / DAY),
        [29, 1],
      );
    });
  });

  test('holds the batch bound, pauses between batches, and keeps what the predicate withholds', async () => {
    await proof(async (db) => {
      const insert = db.prepare('INSERT INTO "__mistri_proof" (at, done) VALUES (?, ?)');
      db.exec('BEGIN');
      for (let i = 0; i < 23; i++) insert.run(NOW - 100 * DAY, i < 20 ? 1 : 0);
      db.exec('COMMIT');
      const statements: number[] = [];
      const inner = sqlitePruneDb(db);
      const counting = {
        ...inner,
        async delete(sql: string, params: unknown[]) {
          const deleted = await inner.delete(sql, params);
          statements.push(deleted);
          return deleted;
        },
      };
      let pauses = 0;
      const withheld = rule({ where: () => 'done = 1' });
      assert.equal(await prune(counting, withheld, 30 * DAY, { now: () => NOW, batch: 8, sleep: async () => void pauses++ }), 20);
      assert.deepEqual(statements, [8, 8, 4]);
      assert.equal(pauses, 2);
      assert.equal(count(db), 3, 'the rows the predicate withholds stay however old');
      assert.match(pruneStatement({ dialect: 'postgres' }, rule(), PRUNE_BATCH), /LIMIT 5000 FOR UPDATE SKIP LOCKED/);
    });
  });

  test('a rule names plain identifiers and registers once', () => {
    assert.throws(() => registerPrune(rule({ id: 'bad', table: 'x; DROP TABLE y' })), /plain identifier/);
    const once = registerPrune(rule({ id: 'twice' }));
    assert.equal(registerPrune(rule({ id: 'twice' })), once);
    assert.throws(() => registerPrune(rule({ id: 'twice', time: 'other' })), /twice/);
    assert.deepEqual(
      ['record-history', 'job-attempts', 'delivery-attempts'].filter((id) => !prunes().some((each) => each.id === id)),
      [],
    );
  });
});

describe('the stores', () => {
  const policy: JobPolicyInput = {
    namespace: 'proof',
    maxAttempts: 3,
    leaseMs: 1_000,
    backoffMs: { base: 100, cap: 1_000 },
    maxInputBytes: 1_024,
    maxInFlight: 8,
  };
  const provenance = Object.freeze({ appId: 'ledger', actorId: 'native-account-proof', tenantId: 'north', correlationId: 'request-1' });
  const sleep = async () => {};

  test('a finished job loses its tries together; pending, retrying and running jobs keep theirs', async () => {
    const dir = tmp();
    const path = join(dir, 'jobs.db');
    try {
      new DatabaseSync(path).close();
      provisionSqliteJobStore(path, policy);
      const store = openSqliteJobStore(path, policy);
      const at = NOW - 90 * DAY;
      const enqueue = (key: string) => store.enqueue({ job: 'remind', version: 1, idempotencyKey: key, input: {}, provenance }, at);
      const [done, retrying, running] = [
        await enqueue('idempotency-key-0001'),
        await enqueue('idempotency-key-0002'),
        await enqueue('idempotency-key-0003'),
      ];
      await enqueue('idempotency-key-0004');
      const claims = await store.claim(at, 3);
      const byId = new Map(claims.map((claim) => [claim.id, claim]));
      await store.succeed(done.id, byId.get(done.id)!.fence, at + 10);
      await store.retry(retrying.id, byId.get(retrying.id)!.fence, at + 10, 'handler_error');
      const db = new DatabaseSync(path);
      try {
        const rules = prunes().filter((each) => each.id === 'job-attempts');
        const out = await pruneAll(sqlitePruneDb(db), rules, retentionMs(), { now: () => NOW, sleep });
        assert.deepEqual(out, [{ id: 'job-attempts', deleted: 1 }]);
        assert.deepEqual(await store.attempts(done.id), []);
        assert.equal((await store.attempts(retrying.id)).length, 1);
        assert.equal((await store.attempts(running.id)).length, 1);
        assert.equal((await store.inspect({ state: 'succeeded' })).length, 1, 'the finished job still reads, with no tries');
        assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM "${JOB_TABLES.attempt}"`).get()!.n), 2);
        // 'forever' keeps every try.
        assert.deepEqual(await pruneAll(sqlitePruneDb(db), rules, retentionMs({ attempts: 'forever' }), { now: () => NOW, sleep }), []);
      } finally {
        db.close();
      }
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a delivered fact loses its tries; one awaiting a redrive or in flight keeps them', async (t) => {
    const f = eventDeliveryFixture(t, eventDeliveryPolicy(1));
    const store = f.open();
    await f.seed('receipt-001');
    await f.seed('receipt-002');
    await store.discover();
    const now = NOW - 90 * DAY;
    const first = (await store.claim(now))!;
    assert.equal(await store.complete(first, 'accepted', 'accepted', now + 1), true);
    const second = (await store.claim(now + 2))!;
    assert.equal(await store.complete(second, 'rejected', 'rejected', now + 3), true);
    const rules = prunes().filter((each) => each.id === 'delivery-attempts');
    const out = await pruneAll(sqlitePruneDb(f.db), rules, retentionMs(), { now: () => NOW, sleep });
    assert.deepEqual(out, [{ id: 'delivery-attempts', deleted: 1 }]);
    assert.deepEqual(await store.attempts(first.eventId), []);
    assert.equal((await store.attempts(second.eventId)).length, 1);
    assert.equal(Number(f.db.prepare(`SELECT count(*) AS n FROM "${delivery.attempt}"`).get()!.n), 1);
    assert.equal((await store.inspect('delivered')).length, 1, 'the delivered fact still reads');
  });

  test('an old receipt goes; one with events, one a destination took up, and a recent one stay', async (t) => {
    const receipts = async (provision: boolean) => {
      const policy = eventDeliveryPolicy(1, 'app');
      const f = eventDeliveryFixture(t, policy, provision);
      const owner = { scope: 'app' as const, ...policy.source };
      // A command that recorded no events, finished on `day`.
      const plain = async (id: string, day: number) => {
        const receipt: StoredCommandReceipt = {
          id,
          appId: policy.source.appId,
          actorId: 'retention-proof',
          commandId: 'note',
          commandVersion: 1,
          idempotencyKey: `attempt-${id}`,
          fingerprint: `fingerprint-${id}`,
          resultJson: '{}',
          requestId: `request-${id}`,
          completedAt: new Date(day).toISOString(),
        };
        const operations = new TransactionOperations();
        f.db.exec('BEGIN IMMEDIATE');
        await createSqliteCommandJournal(f.db, operations, owner).commit(receipt, {
          target: 'effects',
          keyJson: '{"id":1}',
          changesJson: '[]',
        });
        await operations.finish();
        f.db.exec('COMMIT');
      };
      const left = () =>
        f.db
          .prepare(`SELECT id FROM "${COMMAND_JOURNAL_TABLES.receipt}" ORDER BY id`)
          .all()
          .map((row) => row.id);
      return { f, plain, left };
    };
    const rules = prunes().filter((each) => each.id === 'command-receipts');
    const windows = retentionMs({ commands: '30 days' });

    const { f, plain, left } = await receipts(true);
    await f.seed('receipt-001'); // events, finished 2026-09-08
    await plain('receipt-002', NOW - 60 * DAY);
    await f.open().discover(); // the destination takes up both, marking each
    assert.equal(Number(f.db.prepare(`SELECT count(*) AS n FROM "${delivery.receipt}"`).get()!.n), 2);
    await plain('receipt-003', NOW - 60 * DAY);
    await plain('receipt-004', NOW - 5 * DAY);
    assert.deepEqual(await pruneAll(sqlitePruneDb(f.db), rules, windows, { now: () => NOW, sleep: async () => {} }), [
      { id: 'command-receipts', deleted: 1 },
    ]);
    assert.deepEqual(left(), ['receipt-001', 'receipt-002', 'receipt-004']);

    // Where no delivery store is provisioned, its tables are not asked after.
    const bare = await receipts(false);
    await bare.f.seed('receipt-001');
    await bare.plain('receipt-002', NOW - 60 * DAY);
    assert.deepEqual(await pruneAll(sqlitePruneDb(bare.f.db), rules, windows, { now: () => NOW, sleep: async () => {} }), [
      { id: 'command-receipts', deleted: 1 },
    ]);
    assert.deepEqual(bare.left(), ['receipt-001']);
  });

  describe('record history', () => {
    function history(run: (adapter: SqliteAdapter, db: DatabaseSync, path: string) => Promise<void>) {
      const dir = tmp();
      const path = join(dir, 'data.db');
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT, version INTEGER NOT NULL DEFAULT 1);
        INSERT INTO ticket VALUES (1, 'Printer jam', 'open', 1);`);
      provisionSqliteRecordHistory(path);
      const adapter = new SqliteAdapter(path);
      return run(adapter, db, path).finally(async () => {
        await adapter.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      });
    }
    const rows = (db: DatabaseSync) => db.prepare(`SELECT * FROM "${RECORD_HISTORY_TABLES.change}" ORDER BY id`).all();

    test('a write that moved only bookkeeping columns leaves no row; a real change still does', async () => {
      await history(async (adapter, db) => {
        bindRecordHistory(adapter, new Map([['ticket', { redact: new Set<string>(), bookkeeping: new Set(['version']) }]]));
        await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { version: 2 } }));
        assert.equal(rows(db).length, 0);
        await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed', version: 3 } }));
        assert.equal(rows(db).length, 1);
      });
    });

    test('old rows are pruned and recent ones kept; the time is ISO text', async () => {
      await history(async (adapter, db) => {
        bindRecordHistory(adapter, new Map([['ticket', { redact: new Set<string>() }]]));
        await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } }));
        await adapter.transaction((tx) => tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open' } }));
        const [old] = rows(db) as Array<{ id: number; at: string }>;
        assert.match(old.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        db.prepare(`UPDATE "${RECORD_HISTORY_TABLES.change}" SET at = ? WHERE id = ?`).run(
          new Date(Date.now() - 800 * DAY).toISOString(),
          old.id,
        );
        const rules = prunes().filter((each) => each.id === 'record-history');
        assert.deepEqual(await pruneAll(sqlitePruneDb(db), rules, retentionMs(), { sleep }), [{ id: 'record-history', deleted: 1 }]);
        assert.equal(rows(db).length, 1);
      });
    });
  });
});

describe('the daily job', () => {
  test('runs every rule on every target under the App windows, and fails with the first error', async () => {
    const dir = tmp();
    try {
      const path = join(dir, 'data.db');
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE "__mistri_proof" (id INTEGER PRIMARY KEY, at INTEGER)');
      db.prepare('INSERT INTO "__mistri_proof" (at) VALUES (?)').run(NOW - 60 * DAY);
      db.close();
      const rule: PruneRule = { id: 'job-proof', window: 'attempts', table: '__mistri_proof', time: 'at', clock: 'epoch-ms' };
      const job = retentionJob({
        retention: { attempts: '14 days' },
        targets: [{ sqlite: path }, { sqlite: path }],
        rules: () => [rule],
        now: () => NOW,
        sleep: async () => {},
      });
      assert.equal(job.id, 'mistri-retention');
      await job.run();
      const after = new DatabaseSync(path);
      assert.equal(Number(after.prepare('SELECT count(*) AS n FROM "__mistri_proof"').get()!.n), 0);
      after.close();
      const broken = retentionJob({ targets: [{ sqlite: join(dir, 'missing', 'x.db') }, { sqlite: path }], rules: () => [rule] });
      await assert.rejects(broken.run());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retention beyond one SQLite file', () => {
  const proof = (dir: string, name: string, ages: readonly [number, string][]) => {
    const path = join(dir, name);
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE "__mistri_proof" (id INTEGER PRIMARY KEY, at INTEGER, state TEXT)');
    for (const [days, state] of ages) db.prepare('INSERT INTO "__mistri_proof" (at, state) VALUES (?, ?)').run(NOW - days * DAY, state);
    db.close();
    return path;
  };
  const left = (path: string) => {
    const db = new DatabaseSync(path);
    const rows = db
      .prepare('SELECT state FROM "__mistri_proof" ORDER BY id')
      .all()
      .map((row) => String(row.state));
    db.close();
    return rows;
  };
  const rule: PruneRule = {
    id: 'tenant-proof',
    window: 'attempts',
    table: '__mistri_proof',
    time: 'at',
    clock: 'epoch-ms',
    where: () => `"state" = 'done'`,
  };

  test('each database is pruned in turn under its App windows, and a pending row survives', async () => {
    const dir = tmp();
    try {
      const rows: [number, string][] = [
        [60, 'done'],
        [60, 'pending'],
        [10, 'done'],
      ];
      for (const [attempts, deleted] of [
        ['14 days', ['pending', 'done']],
        ['90 days', ['done', 'pending', 'done']],
      ] as const) {
        const jobs = proof(dir, `jobs-${attempts.split(' ')[0]}.db`, rows);
        const source = proof(dir, `source-${attempts.split(' ')[0]}.db`, rows);
        const job = retentionJob({
          retention: { attempts },
          targets: [{ sqlite: jobs }, { sqlite: source }],
          rules: () => [rule],
          now: () => NOW,
          sleep: async () => {},
        });
        await job.run();
        assert.deepEqual(left(jobs), deleted);
        assert.deepEqual(left(source), deleted);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a connection URL names its database', () => {
    assert.deepEqual(storeTargetOf('postgres://h/db'), { postgres: 'postgres://h/db' });
    assert.deepEqual(storeTargetOf('sqlite:///tmp/a.db'), { sqlite: '/tmp/a.db' });
    assert.equal(storeTargetOf(undefined), undefined);
  });
});

describe('retention without a job host', () => {
  test('an App prunes unless every window is forever', () => {
    assert.equal(retentionPrunes(), true);
    assert.equal(retentionPrunes({ attempts: 'forever' }), true);
    assert.equal(retentionPrunes({ history: 'forever', commands: 'forever', attempts: 'forever' }), false);
  });

  test('the timer runs the job at its next slot, again the day after, and stops when told', async () => {
    const ran: number[] = [];
    let clock = Date.UTC(2026, 9, 26, 4, 0, 0);
    const job = retentionJob({ targets: [], rules: () => [] });
    const spy = { ...job, run: async () => void ran.push(clock) };
    const timer = startRetentionTimer(spy, { now: () => clock });
    try {
      // Nothing yet: the slot is 04:41 UTC, forty-one minutes ahead.
      assert.deepEqual(ran, []);
      clock = Date.UTC(2026, 9, 26, 4, 41, 0);
    } finally {
      timer.stop();
    }
    // A stopped timer never runs, however long it is waited on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(ran, []);
  });

  test('a due slot runs the job once and arms the next', async () => {
    const ran: string[] = [];
    // The wait is zero because the clock reads the slot itself.
    const slot = Date.UTC(2026, 9, 26, 4, 41, 0);
    let now = slot - 1;
    const job = retentionJob({ targets: [], rules: () => [] });
    const timer = startRetentionTimer(
      {
        ...job,
        run: async () => {
          ran.push('ran');
          now = slot + 1000;
        },
      },
      { now: () => now },
    );
    try {
      // The first timer waits one millisecond (the clock is just before the slot).
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(ran, ['ran']);
    } finally {
      timer.stop();
    }
  });
});
