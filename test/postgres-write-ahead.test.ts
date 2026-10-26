/**
 * What a write transaction opens with, sent behind its BEGIN (writeAhead.ts,
 * postgresTransactionHandle.ts sendAhead), against a live PostgreSQL
 * (TABLEWALK_TEST_PG), 20 ms away through a latency relay.
 *
 * The statements sent ahead are a hint, never an instruction. Each is pinned
 * here as the property that makes it safe:
 *
 * - a transaction told what it opens with takes fewer round trips and
 *   answers exactly what it answers untold;
 * - a read after the transaction's own write is asked again, never answered
 *   from the row read ahead;
 * - a hint that names another record changes no answer, and what it sent is
 *   reported left;
 * - a statement sent ahead that fails aborts nothing anyone used: the
 *   transaction rolls back, begins again without them, answers the same, and
 *   says so (`redone`);
 * - writes no one reads before COMMIT leave with the COMMIT (beforeCommit):
 *   one that fails is the failure said, and the COMMIT is a ROLLBACK, known
 *   as one (RolledBackAtCommit), never an unknown outcome; sent in front of a
 *   statement asked before the COMMIT, they fail it with their own failure.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Filter, QueryRequest, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter, type PostgresTransactionVerifier } from '../packages/engine/src/adapters/postgres.js';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { beforeCommit, RolledBackAtCommit, transactionHandle } from '../packages/engine/src/adapters/postgresTransactionHandle.js';
import { withWriteAhead, type WriteAhead } from '../packages/engine/src/adapters/writeAhead.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { startLatencyProxy, type LatencyProxy } from '../e2e/support/latencyProxy.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

const ITEM = 'public.write_ahead_item';
const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const rowsA = (): RowScope => ({ [ITEM]: eq('tenant', 'a') });
const byKey = (id: number, columns?: string[]): QueryRequest => ({
  table: ITEM,
  filter: eq('id', id),
  limit: 1,
  offset: 0,
  ...(columns ? { columns } : {}),
});
const RESET = [`DROP TABLE IF EXISTS public.write_ahead_item CASCADE`];
const SETUP = [
  `CREATE TABLE public.write_ahead_item (id integer PRIMARY KEY, tenant text NOT NULL, name text, version integer NOT NULL DEFAULT 0)`,
  `INSERT INTO public.write_ahead_item VALUES (1, 'a', 'Alpha', 0), (2, 'a', 'Second', 0), (3, 'b', 'Hidden', 0)`,
];

interface Ahead {
  committed: boolean;
  sent: number;
  taken: number;
  answered: number;
  missed: number;
  left: string[];
  redone: number;
}

/** The write-ahead reports `work` writes (postgres.ts reportWriteAhead, under MISTRI_AHEAD_REPORT). */
async function reported<T>(work: () => Promise<T>): Promise<{ out: T; reports: Ahead[] }> {
  const reports: Ahead[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const previous = process.env.MISTRI_AHEAD_REPORT;
  process.env.MISTRI_AHEAD_REPORT = '1';
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith('mistri-ahead ')) {
      reports.push(JSON.parse(text.slice('mistri-ahead '.length)) as Ahead);
      return true;
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { out: await work(), reports };
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.MISTRI_AHEAD_REPORT;
    else process.env.MISTRI_AHEAD_REPORT = previous;
  }
}

/** A save: the record read by key as a command reads it (visible, its revision, its columns), then written, then read back. */
async function save(tx: WriteTransaction, id: number) {
  const seen = (await tx.query(byKey(id, ['id']))).rows;
  const revision = (await tx.query(byKey(id, ['version']))).rows;
  const whole = (await tx.query(byKey(id))).rows;
  await tx.update({ table: ITEM, key: { id }, values: { name: `Saved ${whole[0]?.name}`, version: Number(revision[0]?.version) + 1 } });
  const back = (await tx.query(byKey(id, ['name', 'version']))).rows;
  return { seen, revision, whole, back };
}

const target = (id: number, writes = true): WriteAhead => ({ targets: [{ table: ITEM, key: { id } }], writes });

describe('statements sent behind a write transaction’s BEGIN, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  let proxy: LatencyProxy;
  const reset = async () => {
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
  };
  const row = async (id: number) => (await control.query('SELECT name, version FROM public.write_ahead_item WHERE id = $1', [id])).rows[0];

  before(async () => {
    control = await client();
    proxy = await startLatencyProxy(LIVE!, 20);
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
    await proxy.close();
  });

  /** A fresh table and an adapter warmed by one transaction, so the scope's catalog is kept (what the hint is built from). */
  async function withAdapter<T>(run: (adapter: PostgresAdapter, flights: (since: number) => number) => Promise<T>): Promise<T> {
    await reset();
    const adapter = new PostgresAdapter(proxy.route(LIVE!), 'write-ahead proof', ['public']);
    const flights = (since: number) => {
      const sent = proxy.statements(since);
      const busiest = [...new Set(sent.map((statement) => statement.connection))]
        .map((connection) => sent.filter((statement) => statement.connection === connection))
        .sort((a, b) => b.length - a.length)[0];
      return new Set((busiest ?? []).map((statement) => statement.flight)).size;
    };
    try {
      await adapter.scopeTransaction(rowsA(), async (tx) => void (await tx.count(ITEM)));
      return await run(adapter, flights);
    } finally {
      await adapter.close();
    }
  }

  test('a save told its record answers what it answers untold, in fewer round trips', async () => {
    const untold = await withAdapter(async (adapter, flights) => {
      const since = Date.now();
      const { out, reports } = await reported(() => adapter.scopeTransaction(rowsA(), (tx) => save(tx, 1)));
      return { out, flights: flights(since), reports, row: await row(1) };
    });
    const told = await withAdapter(async (adapter, flights) => {
      const since = Date.now();
      const { out, reports } = await reported(() =>
        withWriteAhead(target(1), () => adapter.scopeTransaction(rowsA(), (tx) => save(tx, 1))),
      );
      return { out, flights: flights(since), reports, row: await row(1) };
    });
    assert.deepEqual(told.out, untold.out, 'every read answers alike');
    assert.deepEqual(told.row, untold.row, 'the same write committed');
    assert.deepEqual(told.out.back, [{ name: 'Saved Alpha', version: 1 }], 'the read after the write sees it');
    assert.deepEqual(untold.reports, [], 'nothing was sent ahead untold');
    assert.equal(told.reports.length, 1);
    const [report] = told.reports;
    assert.equal(report.committed, true);
    assert.deepEqual(report.left, [], 'everything sent ahead was asked');
    assert.equal(report.redone, 0);
    assert.ok(report.answered >= 3, `the reads by key before the write were answered from the row read ahead (${report.answered})`);
    assert.ok(told.flights < untold.flights, `${told.flights} round trips told, ${untold.flights} untold`);
  });

  test('a preparation told its record reads it ahead without a lock: BEGIN and COMMIT, two round trips', async () => {
    const prepare = (tx: WriteTransaction) =>
      Promise.all([tx.query(byKey(1, ['id'])), tx.query(byKey(1, ['version']))].map(async (read) => (await read).rows));
    const untold = await withAdapter(async (adapter) => adapter.scopeTransaction(rowsA(), prepare));
    await withAdapter(async (adapter, flights) => {
      const since = Date.now();
      const { out, reports } = await reported(() =>
        withWriteAhead({ ...target(1, false), readOnly: true }, () => adapter.scopeTransaction(rowsA(), prepare)),
      );
      assert.deepEqual(out, untold, 'every read answers alike');
      assert.equal(flights(since), 2, 'the row left with the BEGIN; the COMMIT is the second');
      assert.ok(
        proxy.statements(since).every((statement) => !/FOR (UPDATE|SHARE)/.test(statement.text)),
        'a preparation takes no row lock, told or untold',
      );
      assert.equal(reports.length, 1);
      assert.deepEqual(reports[0].left, [], 'everything sent ahead was asked');
      assert.ok(reports[0].answered >= 2, `both reads were answered from the row read ahead (${reports[0].answered})`);
    });
  });

  test('a hint naming another record changes no answer, and what it sent is reported left', async () => {
    const reference = await withAdapter(async (adapter) => adapter.scopeTransaction(rowsA(), (tx) => save(tx, 1)));
    await withAdapter(async (adapter) => {
      const { out, reports } = await reported(() =>
        withWriteAhead(target(2), () => adapter.scopeTransaction(rowsA(), (tx) => save(tx, 1))),
      );
      assert.deepEqual(out, reference);
      assert.deepEqual(await row(2), { name: 'Second', version: 0 }, 'the record the hint named is untouched');
      assert.equal(reports.length, 1);
      assert.ok(reports[0].left.length >= 1, 'the statements for the record never asked are reported');
      assert.ok(reports[0].missed >= 1, 'what the transaction asked instead went in its own turn');
    });
  });

  test('a record out of the scope is refused exactly as it is untold', async () => {
    await withAdapter(async (adapter) => {
      const untold = await adapter.scopeTransaction(rowsA(), async (tx) => (await tx.query(byKey(3))).rows);
      const { out } = await reported(() =>
        withWriteAhead(target(3), () => adapter.scopeTransaction(rowsA(), async (tx) => (await tx.query(byKey(3))).rows)),
      );
      assert.deepEqual(untold, []);
      assert.deepEqual(out, untold, 'the row read ahead through the scope is no row');
    });
  });

  test('a statement sent ahead that fails rolls back, begins again without them, and answers the same', async () => {
    const reference = await withAdapter(async (adapter) => adapter.scopeTransaction(rowsA(), (tx) => save(tx, 1)));
    await withAdapter(async (adapter) => {
      let verified = 0;
      // A verifier whose fence, sent ahead, fails: division by zero aborts the transaction behind the BEGIN.
      const verify = Object.assign(async () => void (verified += 1), {
        ahead: () => ['SELECT 1 / 0 AS write_ahead_failure'],
      }) as unknown as PostgresTransactionVerifier;
      const { out, reports } = await reported(() =>
        withWriteAhead(target(1), () => adapter.scopeVerifiedTransaction(rowsA(), verify, (tx) => save(tx, 1))),
      );
      assert.deepEqual(out, reference, 'the same answers');
      assert.deepEqual(await row(1), { name: 'Saved Alpha', version: 1 }, 'written once');
      assert.ok(verified >= 1, 'the verifier still judged the transaction');
      assert.equal(reports.length, 1);
      assert.equal(reports[0].redone, 1, 'counted');
      assert.equal(reports[0].committed, true);
    });
  });

  test('writes sent with the COMMIT commit with it, in its round trip, and one that fails rolls it back, known', async () => {
    await reset();
    const manager = new PgConnectionManager(proxy.route(LIVE!));
    const flights = (since: number) =>
      new Set(
        proxy
          .statements(since)
          .filter((statement) => /write_ahead_item/.test(statement.text))
          .map((statement) => `${statement.connection}:${statement.flight}`),
      ).size;
    const rename = (id: number, name: string) => ({
      text: 'UPDATE public.write_ahead_item SET name = $1 WHERE id = $2',
      values: [name, id],
    });
    try {
      let since = Date.now();
      await manager.withWriteClient(async (client) => {
        const handle = transactionHandle(client);
        await handle.query('BEGIN');
        assert.equal(beforeCommit(handle, [rename(1, 'Sent with the COMMIT'), rename(2, 'And this')]), true);
        await handle.query('COMMIT');
      });
      assert.deepEqual(await row(1), { name: 'Sent with the COMMIT', version: 0 });
      assert.deepEqual(await row(2), { name: 'And this', version: 0 });
      assert.equal(flights(since), 1, 'both writes left with the COMMIT');

      since = Date.now();
      await manager.withWriteClient(async (client) => {
        const handle = transactionHandle(client);
        await handle.query('BEGIN');
        await handle.query("UPDATE public.write_ahead_item SET name = 'Never' WHERE id = 3");
        beforeCommit(handle, [{ text: 'INSERT INTO public.write_ahead_item (id, tenant) VALUES ($1, $2)', values: [1, 'a'] }]);
        const refused = await handle.query('COMMIT').then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(refused instanceof RolledBackAtCommit, 'the COMMIT says it rolled back');
        assert.equal((refused.cause as { code?: string }).code, '23505', 'the duplicate key is the failure said');
      });
      assert.deepEqual(await row(3), { name: 'Hidden', version: 0 }, 'nothing committed');

      // A write the driver refuses as it is handed over never reaches the server, which would commit the rest: it rolls back instead.
      await manager.withWriteClient(async (client) => {
        const handle = transactionHandle(client);
        await handle.query('BEGIN');
        await handle.query("UPDATE public.write_ahead_item SET name = 'Never' WHERE id = 3");
        const unsendable = {
          toPostgres: () => {
            throw new Error('A value the driver cannot send');
          },
        };
        beforeCommit(handle, [{ text: 'UPDATE public.write_ahead_item SET name = $1 WHERE id = 1', values: [unsendable] }]);
        const refused = await handle.query('COMMIT').then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(refused instanceof RolledBackAtCommit, 'the COMMIT says it rolled back');
        assert.match(String(refused.cause), /cannot send/);
      });
      assert.deepEqual(await row(3), { name: 'Hidden', version: 0 }, 'nothing committed past an unsent write');

      await manager.withWriteClient(async (client) => {
        const handle = transactionHandle(client);
        await handle.query('BEGIN');
        beforeCommit(handle, [{ text: 'INSERT INTO public.write_ahead_item (id, tenant) VALUES ($1, $2)', values: [2, 'a'] }]);
        await assert.rejects(handle.query('SELECT 1 AS write_ahead_after'), (error: { code?: string }) => error.code === '23505');
        await handle.query('ROLLBACK');
      });
    } finally {
      await manager.close();
    }
  });
});
