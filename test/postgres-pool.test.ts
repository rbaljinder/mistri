import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeClient implements PgClient {
  readonly statements: string[] = [];
  readonly releases: Array<boolean | Error | undefined> = [];

  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(request: string | { text: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
    this.statements.push(typeof request === 'string' ? request : request.text);
    return { rows: [], fields: [], rowCount: 0 };
  }

  release(destroy?: boolean | Error): void {
    this.releases.push(destroy);
  }
}

class FakePool extends EventEmitter implements PgPool {
  readonly clients: FakeClient[] = [];
  endCalls = 0;
  endGate?: Promise<void>;
  checkoutGate?: Promise<void>;

  constructor(readonly options: PgPoolOptions) {
    super();
  }

  async connect(): Promise<FakeClient> {
    await this.checkoutGate;
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
    try {
      return typeof request === 'string' ? client.query(request, params) : client.query(request);
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    this.endCalls += 1;
    await this.endGate;
  }
}

function fixture() {
  const pools: FakePool[] = [];
  let loads = 0;
  const module = {
    Pool: class extends FakePool {
      constructor(options: PgPoolOptions) {
        super(options);
        pools.push(this);
      }
    },
  };
  const manager = new PgConnectionManager('postgres://user@host/database', undefined, async () => {
    loads += 1;
    return module;
  });
  return { manager, pools, module, loads: () => loads };
}

test('Postgres pool creation is lazy, coalesced by role, and bounded', async () => {
  const { manager, pools, loads } = fixture();
  assert.equal(loads(), 0);
  const [first, second] = await Promise.all([manager.read(), manager.read()]);
  assert.equal(first, second);
  assert.equal(loads(), 1);
  assert.equal(pools.length, 1);
  await Promise.all([first.query('SELECT 1'), second.query('SELECT 2')]);
  await manager.withWriteClient(async (client) => {
    await client.query('UPDATE item SET name = name');
  });
  assert.equal(pools.length, 2);
  assert.deepEqual(
    pools.map((pool) => ({
      max: pool.options.max,
      connect: pool.options.connectionTimeoutMillis,
      idle: pool.options.idleTimeoutMillis,
    })),
    [
      { max: 4, connect: 10_000, idle: 30_000 },
      { max: 1, connect: 10_000, idle: 30_000 },
    ],
  );
  for (const client of pools[0].clients) {
    assert.deepEqual(client.statements.slice(0, 2), ['SET default_transaction_read_only = on', "SET statement_timeout = '30s'"]);
  }
  // The writer's session also stops waiting for a lock after five seconds (writeLanes.ts), in the same message.
  assert.deepEqual(pools[1].clients[0].statements, [
    "SET statement_timeout = '30s'; SET lock_timeout = '5000ms'",
    'UPDATE item SET name = name',
  ]);
  await manager.close();
});

test('Postgres leases release once on success and destroy on callback failure', async () => {
  const { manager, pools } = fixture();
  assert.equal(
    await manager.withReadClient(async (client) => {
      await client.query('BEGIN READ ONLY');
      await client.query('SELECT 1');
      await client.query('ROLLBACK');
      return 42;
    }),
    42,
  );
  assert.deepEqual(pools[0].clients[0].releases, [false]);
  const failure = new Error('callback failed');
  await assert.rejects(
    manager.withWriteClient(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(pools[1].clients[0].releases, [true]);
  await manager.close();
});

test('untrusted SQL leases can be discarded after successful reads and writes', async () => {
  const { manager, pools } = fixture();
  await manager.withReadClient(async (client) => {
    await client.query('SELECT pg_advisory_lock(1)');
  }, true);
  await manager.withWriteClient(async (client) => {
    await client.query('SET application_name = example');
  }, true);
  assert.deepEqual(
    pools.map((pool) => pool.clients[0].releases),
    [[true], [true]],
  );
  await manager.close();
});

test('Postgres role hooks initialize every physical client before it is used', async () => {
  const { manager, pools } = fixture();
  const read = await manager.read();
  await Promise.all([read.query('SELECT 1'), read.query('SELECT 2'), read.query('SELECT 3')]);
  assert.equal(pools[0].clients.length, 3);
  for (const client of pools[0].clients) {
    assert.equal(client.statements[0], 'SET default_transaction_read_only = on');
    assert.equal(client.statements[1], "SET statement_timeout = '30s'");
    assert.match(client.statements[2], /^SELECT/);
  }
  assert.doesNotThrow(() => pools[0].emit('error', new Error('idle backend disconnected')));
  await manager.close();
});

test('Postgres shutdown cannot reopen pools after an in-flight module load', async () => {
  const loading = deferred<unknown>();
  const { module, pools } = fixture();
  const manager = new PgConnectionManager('postgres://host/db', undefined, () => loading.promise);
  const opening = manager.read();
  const rejected = assert.rejects(opening, /closed/);
  const closing = manager.close();
  assert.equal(manager.close(), closing);
  loading.resolve(module);
  await Promise.all([rejected, closing]);
  assert.equal(pools.length, 0);
  await assert.rejects(manager.read(), /closed/);
  await assert.rejects(
    manager.withWriteClient(async () => {}),
    /closed/,
  );
});

test('Postgres shutdown waits for both pool ends, even if one fails', async () => {
  const { manager, pools } = fixture();
  await manager.read();
  await manager.withWriteClient(async () => {});
  const reader = deferred<void>();
  const writer = deferred<void>();
  pools[0].endGate = reader.promise;
  pools[1].endGate = writer.promise;
  let settled = false;
  const closing = manager.close().finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(closing, /shutdown failure/);
  reader.reject(new Error('shutdown failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  writer.resolve();
  await rejected;
  assert.deepEqual(
    pools.map((pool) => pool.endCalls),
    [1, 1],
  );
});

test('a checkout completing after shutdown is discarded without running work', async () => {
  const { manager, pools } = fixture();
  await manager.read();
  const checkout = deferred<void>();
  pools[0].checkoutGate = checkout.promise;
  let ran = false;
  const request = manager.withReadClient(async () => {
    ran = true;
  });
  const rejected = assert.rejects(request, /closed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = manager.close();
  checkout.resolve();
  await Promise.all([rejected, closing]);
  assert.equal(ran, false);
  assert.deepEqual(pools[0].clients[0].releases, [true]);
});

test('Postgres loader hooks support default exports and failed loading closes cleanly', async () => {
  const { module, pools } = fixture();
  const seen: unknown[] = [];
  const loaded = { default: module };
  const manager = new PgConnectionManager(
    'postgres://host/db',
    (pg) => seen.push(pg),
    async () => loaded,
  );
  await manager.read();
  assert.deepEqual(seen, [loaded]);
  await manager.close();
  assert.equal(pools[0].endCalls, 1);
  const failed = new PgConnectionManager('postgres://host/db', undefined, async () => {
    throw new Error('missing driver');
  });
  await assert.rejects(failed.read(), /missing driver/);
  await failed.close();
});
