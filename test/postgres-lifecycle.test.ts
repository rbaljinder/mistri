import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Statement = { client: number; text: string };

function fixture() {
  const pools: FakePool[] = [];
  const statements: Statement[] = [];
  let nextClient = 0;
  let beforeQuery: (text: string) => Promise<void> = async () => {};

  class FakeClient implements PgClient {
    readonly id = ++nextClient;
    readonly releases: Array<boolean | Error | undefined> = [];
    private active = false;

    query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async query(
      request: string | { text: string; values?: unknown[]; rowMode?: string },
      params: unknown[] = [],
    ): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
      const text = typeof request === 'string' ? request : request.text;
      assert.equal(this.active, false, `Concurrent query on client ${this.id}: ${text}`);
      assert.equal(this.releases.length, 0, `Query after release on client ${this.id}`);
      this.active = true;
      statements.push({ client: this.id, text });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await beforeQuery(text);
        if (typeof request !== 'string' && request.rowMode === 'array') {
          return { rows: [[1]], fields: [{ name: 'value' }], rowCount: 1 };
        }
        const rows = text.includes('SELECT c.relkind')
          ? [{ kind: 'r' }]
          : text.includes('FROM pg_attribute')
            ? [
                { name: 'id', type: 'integer', notnull: true, is_pk: true },
                { name: 'name', type: 'text', notnull: true, is_pk: false },
              ]
            : text.includes('COUNT(*)')
              ? [{ n: '1' }]
              : text.startsWith('INSERT INTO')
                ? [{ id: params[0], name: params[1] }]
                : [];
        return { rows, fields: [], rowCount: /^(UPDATE|INSERT|DELETE)/.test(text) ? 1 : rows.length };
      } finally {
        this.active = false;
      }
    }

    release(destroy?: boolean | Error): void {
      assert.equal(this.active, false, 'Release before the current query finished');
      assert.equal(this.releases.length, 0, 'Lease released twice');
      this.releases.push(destroy);
    }
  }

  class FakePool extends EventEmitter implements PgPool {
    readonly clients: FakeClient[] = [];
    ended = false;
    constructor(readonly options: PgPoolOptions) {
      super();
      pools.push(this);
    }

    async connect(): Promise<FakeClient> {
      assert.equal(this.ended, false);
      const client = new FakeClient();
      this.clients.push(client);
      await this.options.onConnect(client);
      return client;
    }

    query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async query(
      request: string | { text: string; values?: unknown[]; rowMode?: string },
      params?: unknown[],
    ): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
      const client = await this.connect();
      let failed = false;
      try {
        return await (typeof request === 'string' ? client.query(request, params) : client.query(request));
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        client.release(failed);
      }
    }

    async end(): Promise<void> {
      this.ended = true;
    }
  }

  const manager = new PgConnectionManager('postgres://host/db', undefined, async () => ({ Pool: FakePool }));
  const adapter = new PostgresAdapter('postgres://host/db', 'lifecycle', [], manager);
  return {
    adapter,
    pools,
    statements,
    beforeQuery: (hook: typeof beforeQuery) => {
      beforeQuery = hook;
    },
  };
}

for (const kind of ['refusal', 'constraint'] as const) {
  for (const commit of [false, true]) {
    for (const rollbackFails of [false, true]) {
      test(`Postgres ${kind}: commit attempted=${commit}, rollback failure=${rollbackFails} classifies outcome and discards failed lease`, async () => {
        const { adapter, pools, statements, beforeQuery } = fixture();
        const original =
          kind === 'refusal'
            ? new Refusal('Private original refusal')
            : Object.assign(new Error('Private constraint detail'), { code: '23505' });
        beforeQuery(async (text) => {
          if (commit && text === 'COMMIT') throw original;
          if (rollbackFails && text === 'ROLLBACK') throw new Error('Rollback transport failed');
        });
        try {
          await assert.rejects(
            adapter.transaction(async (tx) => {
              await tx.update({ table: 'public.item', key: { id: 1 }, values: { name: 'Changed' } });
              if (!commit) throw original;
            }),
            (error) => {
              if (commit || rollbackFails) {
                assert.ok(error instanceof TransactionOutcomeUnknown);
                assert.equal(error instanceof Refusal, false);
                assert.equal(error.outcome, 'unknown');
                assert.equal(error.cause, original);
                assert.doesNotMatch(error.message, /Private|constraint|23505/);
              } else assert.equal(error, original);
              return true;
            },
          );
          const first = pools[0].clients[0];
          assert.deepEqual(first.releases, [true]);
          assert.equal(
            statements.some((statement) => statement.text === 'COMMIT'),
            commit,
          );
          assert.equal(statements.at(-1)!.text, 'ROLLBACK');
          beforeQuery(async () => {});
          await adapter.transaction(async (tx) => assert.equal(await tx.count('public.item'), 1));
          assert.notEqual(pools[0].clients.at(-1)!.id, first.id);
          assert.deepEqual(pools[0].clients.at(-1)!.releases, [false]);
        } finally {
          await adapter.close();
        }
      });
    }
  }
}

test('Postgres failed BEGIN never invokes callback and destroys the uncertain session', async () => {
  const { adapter, pools, statements, beforeQuery } = fixture();
  const original = new Refusal('BEGIN acknowledgement lost');
  beforeQuery(async (text) => {
    if (/^BEGIN(?:;|$)/.test(text)) throw original;
  });
  try {
    await assert.rejects(
      adapter.transaction(async () => assert.fail('callback entered')),
      (error) => error === original,
    );
    assert.deepEqual(pools[0].clients[0].releases, [true]);
    assert.equal(
      statements.some((statement) => statement.text === 'COMMIT'),
      false,
    );
    beforeQuery(async () => {});
    await adapter.transaction(async () => {});
    assert.equal(pools[0].clients.length, 2);
  } finally {
    await adapter.close();
  }
});

test('Postgres transaction queued behind a lost commit uses a fresh lease', async () => {
  const { adapter, pools, beforeQuery } = fixture();
  let failed = false;
  beforeQuery(async (text) => {
    if (text === 'COMMIT' && !failed) {
      failed = true;
      throw new Refusal('Lost commit');
    }
  });
  try {
    const first = adapter.transaction(async (tx) => tx.update({ table: 'public.item', key: { id: 1 }, values: { name: 'First' } }));
    const second = adapter.transaction(async (tx) => tx.count('public.item'));
    await assert.rejects(first, TransactionOutcomeUnknown);
    assert.equal(await second, 1);
    assert.deepEqual(
      pools[0].clients.map((client) => client.releases),
      [[true], [false]],
    );
  } finally {
    await adapter.close();
  }
});

test('structured transaction reads and preflights share their write lease and expire with it', async () => {
  const { adapter, pools, statements } = fixture();
  try {
    for (const fail of [false, true]) {
      let escaped!: WriteTransaction;
      const start = statements.length;
      const work = adapter.transaction(async (tx) => {
        escaped = tx;
        await tx.insert({ table: 'public.item', values: { id: 1, name: 'Inserted' } });
        await Promise.all([
          tx.query({ table: 'public.item', columns: ['name'], limit: 1, offset: 0 }),
          tx.count('public.item'),
          tx.update({ table: 'public.item', key: { id: 1 }, values: { name: 'Updated' } }),
        ]);
        await tx.remove({ table: 'public.item', key: { id: 1 } });
        if (fail) throw new Error('Abort transaction');
      });
      if (fail) await assert.rejects(work, /Abort transaction/);
      else await work;
      const within = statements.slice(start);
      assert.equal(new Set(within.map((statement) => statement.client)).size, 1);
      assert.ok(within.some((statement) => statement.text.includes('COUNT(*)')));
      assert.ok(within.some((statement) => statement.text.startsWith('SELECT "name"')));
      assert.equal(within.at(-1)?.text, fail ? 'ROLLBACK' : 'COMMIT');
      const beforeLate = statements.length;
      await assert.rejects(() => escaped.query({ table: 'public.item', limit: 1, offset: 0 }), /no longer active/);
      await assert.rejects(() => escaped.count('public.item'), /no longer active/);
      await assert.rejects(() => escaped.remove({ table: 'public.item', key: { id: 1 } }), /no longer active/);
      assert.equal(statements.length, beforeLate);
    }
    assert.equal(pools.length, 1, 'transactional metadata must not create a separate reader pool');
  } finally {
    await adapter.close();
  }
});

test('Postgres rolls back when a transaction operation failure is caught by the callback', async () => {
  const { adapter, statements, beforeQuery } = fixture();
  beforeQuery(async (text) => {
    if (text.startsWith('UPDATE')) throw new Error('Injected update failure');
  });
  try {
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.insert({ table: 'public.item', values: { id: 1, name: 'Must roll back' } });
        await tx.update({ table: 'public.item', key: { id: 1 }, values: { name: 'Failed' } }).catch(() => {});
      }),
      /Injected update failure/,
    );
    assert.equal(statements.at(-1)?.text, 'ROLLBACK');
    assert.equal(
      statements.some((statement) => statement.text === 'COMMIT'),
      false,
    );
  } finally {
    await adapter.close();
  }
});

test('raw read transactions keep one exclusive lease while ordinary reads use other clients', { timeout: 5_000 }, async () => {
  const { adapter, pools, statements, beforeQuery } = fixture();
  const reached = deferred();
  const resume = deferred();
  beforeQuery(async (text) => {
    if (text.includes('SELECT 99')) {
      reached.resolve();
      await resume.promise;
    }
  });
  const reading = adapter.runSql({ text: 'SELECT 99', timeoutMs: 250, limit: 20 });
  try {
    await reached.promise;
    assert.equal(await adapter.count('public.item'), 1);
    const raw = statements.find((statement) => statement.text === 'BEGIN READ ONLY')!.client;
    assert.ok(statements.filter((statement) => statement.text.includes('COUNT(*)')).every((statement) => statement.client !== raw));
    resume.resolve();
    await reading;
    assert.deepEqual(
      statements.filter((statement) => statement.text === 'ROLLBACK').map((statement) => statement.client),
      [raw],
    );
    assert.deepEqual(pools[0].clients.find((client) => client.id === raw)!.releases, [true]);
  } finally {
    resume.resolve();
    await reading.catch(() => {});
    await adapter.close();
  }
});

test('raw writes wait until a structured transaction commits or rolls back', { timeout: 5_000 }, async () => {
  for (const fail of [false, true]) {
    const { adapter, pools, statements } = fixture();
    const reached = deferred();
    const resume = deferred();
    const graph = adapter
      .transaction(async (tx) => {
        await tx.update!({ table: 'public.item', key: { id: 1 }, values: { name: 'inside transaction' } });
        reached.resolve();
        await resume.promise;
        if (fail) throw new Error('Roll back graph');
      })
      .catch((error) => error);
    try {
      await reached.promise;
      const raw = adapter.runSql({ text: 'UPDATE raw_target SET flag = 1', write: true, limit: 20 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        statements.some((statement) => statement.text.includes('UPDATE raw_target')),
        false,
      );
      resume.resolve();
      const outcome = await graph;
      assert.equal(outcome instanceof Error, fail);
      assert.equal((await raw).affected, 1);
      const boundary = statements.findIndex((statement) => statement.text === (fail ? 'ROLLBACK' : 'COMMIT'));
      const rawIndex = statements.findIndex((statement) => statement.text.includes('UPDATE raw_target'));
      assert.ok(boundary >= 0 && rawIndex > boundary);
      assert.notEqual(statements[boundary].client, statements[rawIndex].client);
      const writer = pools.find((pool) => pool.options.max === 1)!;
      assert.deepEqual(writer.clients.at(-1)!.releases, [true]);
    } finally {
      resume.resolve();
      await graph;
      await adapter.close();
    }
  }
});

test('Promise.all transaction operations cannot issue overlapping queries on their held client', { timeout: 5_000 }, async () => {
  const { adapter, pools, statements } = fixture();
  try {
    await adapter.transaction(async (tx) => {
      await Promise.all([
        tx.update!({ table: 'public.item', key: { id: 1 }, values: { name: 'one' } }),
        tx.update!({ table: 'public.item', key: { id: 2 }, values: { name: 'two' } }),
      ]);
    });
    const writes = statements.filter((statement) => statement.text.startsWith('UPDATE'));
    assert.equal(writes.length, 2);
    assert.equal(writes[0].client, writes[1].client);
    const writer = pools.find((pool) => pool.options.max === 1)!;
    assert.equal(writer.clients.length, 1);
    assert.deepEqual(writer.clients[0].releases, [false]);
    assert.equal(statements.at(-1)!.text, 'COMMIT');
  } finally {
    await adapter.close();
  }
});

test('raw reads and EXPLAIN destroy their clients on success and after rollback failure', { timeout: 5_000 }, async () => {
  const { adapter, pools, beforeQuery } = fixture();
  try {
    await adapter.runSql({ text: 'SELECT 1', limit: 20 });
    await adapter.explainSql({ text: 'SELECT 1' });
    const failure = new Error('Original statement failed');
    beforeQuery(async (text) => {
      if (text === 'VACUUM') throw failure;
      if (text === 'ROLLBACK') throw new Error('Broken connection');
    });
    await assert.rejects(adapter.runSql({ text: 'VACUUM', limit: 20 }), (error) => error === failure);
    assert.equal(pools[0].clients.length, 3);
    assert.deepEqual(
      pools[0].clients.map((client) => client.releases),
      [[true], [true], [true]],
    );
  } finally {
    await adapter.close();
  }
});
