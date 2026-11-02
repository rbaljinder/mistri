/**
 * `snapshot: true` on a command (snapshotRead.ts): the PostgreSQL write
 * transaction it runs in opens REPEATABLE READ, so every read sees one
 * moment; a transaction opened without it, or one opened inside its work,
 * stays READ COMMITTED. Driven over a fake client, as postgres-lifecycle is,
 * so the statement is proven without a server; the live behaviour (a row
 * inserted by another connection is not seen) runs where TABLEWALK_TEST_PG is
 * set. The definition takes only `true`, and check says what it means on
 * each engine.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { isSnapshotConflict, withSnapshotRead } from '../packages/engine/src/adapters/snapshotRead.js';
import { snapshotCommandChecks } from '../packages/mistri/src/server/app/appSnapshotChecks.js';
import { BusinessCommandDefinitionError, defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { liveSkip } from './live.js';

function fakePostgres() {
  const statements: string[] = [];
  class FakeClient implements PgClient {
    query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async query(request: string | { text: string; rowMode?: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
      const text = typeof request === 'string' ? request : request.text;
      statements.push(text);
      if (typeof request !== 'string' && request.rowMode === 'array') return { rows: [[1]], fields: [{ name: 'value' }], rowCount: 1 };
      const rows = text.includes('SELECT c.relkind')
        ? [{ kind: 'r' }]
        : text.includes('FROM pg_attribute')
          ? [{ name: 'id', type: 'integer', notnull: true, is_pk: true }]
          : text.includes('COUNT(*)')
            ? [{ n: '1' }]
            : [];
      return { rows, fields: [], rowCount: rows.length };
    }
    release(): void {}
  }
  class FakePool extends EventEmitter implements PgPool {
    constructor(readonly options: PgPoolOptions) {
      super();
    }
    async connect(): Promise<FakeClient> {
      const client = new FakeClient();
      await this.options.onConnect(client);
      return client;
    }
    query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async query(request: string | { text: string; rowMode?: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
      return (await this.connect()).query(request as string);
    }
    async end(): Promise<void> {}
  }
  const manager = new PgConnectionManager('postgres://host/db', undefined, async () => ({ Pool: FakePool }));
  return { adapter: new PostgresAdapter('postgres://host/db', 'snapshot', [], manager), statements };
}

const begins = (statements: readonly string[]) => statements.filter((text) => /^BEGIN\b/.test(text)).map((text) => text.split(';')[0]);

test('a snapshot command opens REPEATABLE READ on PostgreSQL; every other transaction, and one its work opens, does not', async (t) => {
  const { adapter, statements } = fakePostgres();
  t.after(() => adapter.close());
  await adapter.transaction(async (tx) => void (await tx.count('public.item')));
  assert.deepEqual(begins(statements), ['BEGIN']);
  statements.length = 0;
  await withSnapshotRead(true, () => adapter.transaction(async (tx) => void (await tx.count('public.item'))));
  assert.deepEqual(begins(statements), ['BEGIN ISOLATION LEVEL REPEATABLE READ']);
  // The writer's session carries the statement ceiling (postgres-pool.test.ts), so the snapshot's statements are capped too.
  statements.length = 0;
  let inner: Promise<void> | undefined;
  await withSnapshotRead(true, () =>
    adapter.transaction(async () => {
      // Opened by the work, it waits for this one (one writer) and is not this transaction: it takes no snapshot.
      inner = adapter.transaction(async () => {});
    }),
  );
  await inner;
  assert.deepEqual(begins(statements), ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN']);
});

test('a command takes snapshot: true or nothing, and check says what it means on each engine', () => {
  const base = { source: 'books', target: 'ledger', read: ['ledger'], write: ['ledger'], input: {}, handle: () => ({}) } as const;
  assert.equal(defineCommand({ ...base, snapshot: true }).snapshot, true);
  assert.equal(defineCommand(base).snapshot, undefined);
  assert.throws(() => defineCommand({ ...base, snapshot: 'yes' as unknown as true }), BusinessCommandDefinitionError);
  const registry = { reconcile: defineCommand({ ...base, snapshot: true }), post: defineCommand(base) };
  const on = (dialect: 'postgres' | 'sqlite' | 'http') => snapshotCommandChecks(registry, () => dialect);
  assert.deepEqual(on('postgres'), { problems: [], warnings: [] });
  assert.match(on('http').problems.join('\n'), /command "reconcile" .*HTTP source serves \[command-snapshot\]/);
  assert.deepEqual(on('http').warnings, []);
  assert.match(on('sqlite').warnings.join('\n'), /command "reconcile" .*SQLite \[command-snapshot\].*changes nothing/);
  assert.deepEqual(on('sqlite').problems, []);
});

const PG = process.env.TABLEWALK_TEST_PG;
describe('one snapshot on a live PostgreSQL', { skip: liveSkip('postgres', PG) }, () => {
  const name = `tw_snapshot_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  type Client = { connect(): Promise<void>; query(text: string): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
  let adapter: PostgresAdapter;
  let other: Client;
  before(async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client?: new (o: { connectionString: string }) => Client;
      default?: { Client: new (o: { connectionString: string }) => Client };
    };
    const Made = pg.Client ?? pg.default!.Client;
    other = new Made({ connectionString: PG! });
    await other.connect();
    await other.query(`CREATE TABLE public.${name} (id integer PRIMARY KEY, n integer NOT NULL); INSERT INTO public.${name} VALUES (1, 1)`);
    adapter = new PostgresAdapter(PG!, 'snapshot');
  });
  after(async () => {
    await adapter?.close();
    try {
      await other?.query(`DROP TABLE IF EXISTS public.${name}`);
    } finally {
      await other?.end();
    }
  });
  const table = () => `public.${name}`;

  test('a row another connection commits mid-command is seen without a snapshot and not with one', async () => {
    const seen = (snapshot: boolean, id: number) =>
      withSnapshotRead(snapshot, () =>
        adapter.transaction(async (tx) => {
          const before = await tx.count(table());
          await other.query(`INSERT INTO ${table()} VALUES (${id}, 0)`);
          return (await tx.count(table())) - before;
        }),
      );
    assert.equal(await seen(false, 2), 1);
    assert.equal(await seen(true, 3), 0);
  });

  test('a row another connection changes after the snapshot is refused when written, and nothing of the command lands', async () => {
    await assert.rejects(
      withSnapshotRead(true, () =>
        adapter.transaction(async (tx) => {
          await tx.count(table());
          await other.query(`UPDATE ${table()} SET n = 7 WHERE id = 1`);
          await tx.insert({ table: table(), values: { id: 9, n: 9 } });
          await tx.update({ table: table(), key: { id: 1 }, values: { n: 8 } });
        }),
      ),
      (error: unknown) => isSnapshotConflict(error) || isSnapshotConflict((error as { cause?: unknown }).cause),
    );
    const { rows } = await other.query(`SELECT id, n FROM ${table()} WHERE id IN (1, 9) ORDER BY id`);
    assert.deepEqual(
      rows.map((row) => [Number(row.id), Number(row.n)]),
      [[1, 7]],
    );
  });
});
