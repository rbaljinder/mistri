/**
 * A full pool answers "busy" quickly instead of holding a request for the
 * driver's ten-second timeout: the manager refuses a checkout past its queue
 * bound or its queue-wait budget with PoolBusy, and the server turns that into
 * a 503 with Retry-After — for a write, one that says it never began.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { isPoolBusy, PoolBusy, POOL_BUSY_MESSAGE } from '../packages/engine/src/adapters/poolMetrics.js';
import { asBackgroundWork } from '../packages/engine/src/adapters/writeLanes.js';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { makeDemoDatabase } from './make-demo-db.js';

class Client implements PgClient {
  constructor(private readonly pool: HoldingPool) {}
  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
    return { rows: [], fields: [], rowCount: 0 };
  }
  release(): void {
    this.pool.giveBack();
  }
}

/** Hands out `max` clients, then queues every checkout until one is given back: pg-pool with no timeout of its own. */
class HoldingPool extends EventEmitter implements PgPool {
  leased = 0;
  readonly queue: Array<(client: Client) => void> = [];
  constructor(readonly options: PgPoolOptions) {
    super();
  }
  get totalCount(): number {
    return this.leased;
  }
  connect(): Promise<Client> {
    if (this.leased < this.options.max) {
      this.leased += 1;
      return Promise.resolve(new Client(this));
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  giveBack(): void {
    const next = this.queue.shift();
    if (next) next(new Client(this));
    else this.leased -= 1;
  }
  query(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  async end(): Promise<void> {}
}

function manager(options: { queueWaitMs?: number; queuePerConnection?: number } = {}) {
  const made: HoldingPool[] = [];
  const pg = {
    Pool: function Pool(o: PgPoolOptions) {
      const pool = new HoldingPool(o);
      made.push(pool);
      return pool;
    },
  };
  const connections = new PgConnectionManager(
    'postgres://fake',
    () => {},
    async () => pg,
    { readers: 2, writers: 1, ...options },
  );
  return { connections, pool: () => made[0] };
}

test('a full pool refuses a checkout at its queue-wait budget, long before the driver would', async () => {
  const { connections } = manager({ queueWaitMs: 50 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = [1, 2].map(() =>
    connections.withReadClient(async () => {
      await held;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  await assert.rejects(
    connections.withReadClient(async () => 'never'),
    (error: unknown) => {
      assert.ok(error instanceof PoolBusy);
      assert.equal(error.why, 'queue_timeout');
      assert.equal(error.message, POOL_BUSY_MESSAGE);
      return true;
    },
  );
  assert.ok(performance.now() - started < 1_000, 'refused fast');
  const [reads] = connections.stats();
  assert.equal(reads.timedOut, 1);
  assert.equal(reads.saturated, true);
  release();
  await Promise.all(running);
  await connections.close();
});

/* A burst a pool works through well inside the wait is waited for, not refused: a page's boot has up to eight reads
   in flight, and at eight queued per connection a field report saw two thirds of the tabs opened at one moment by 25
   people turned away busy while the server's loop sat idle. */
test('a burst the pool answers inside the wait is served, not refused for its size', async () => {
  const { connections } = manager();
  // Two readers, twelve pages opening at once with eight reads in flight each (a boot's fan-out, measured): a
  // millisecond's work apiece, so the last is answered long before the wait runs out.
  const reads = Array.from({ length: 12 * 8 }, () =>
    connections.withReadClient(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return 'ran';
    }),
  );
  const answers = await Promise.allSettled(reads);
  assert.deepEqual(
    answers.filter((answer) => answer.status === 'rejected').map((answer) => String((answer as PromiseRejectedResult).reason)),
    [],
  );
  await connections.close();
});

test('a checkout past the queue bound is refused at once, and a late connection is given back', async () => {
  const { connections, pool } = manager({ queueWaitMs: 5_000, queuePerConnection: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = [1, 2].map(() =>
    connections.withReadClient(async () => {
      await held;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  // Two readers, one queued place per reader: two may wait, the third is refused.
  const queued = [1, 2].map(() => connections.withReadClient(async () => 'ran'));
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  await assert.rejects(
    connections.withReadClient(async () => 'never'),
    (error: unknown) => error instanceof PoolBusy && error.why === 'queue_full',
  );
  assert.ok(performance.now() - started < 200, 'refused without waiting');
  release();
  assert.deepEqual(await Promise.all(queued), ['ran', 'ran']);
  await Promise.all(running);
  assert.equal(pool().leased, 0, 'nothing leaked');
  await connections.close();
});

test('a connection that arrives after the budget goes straight back to the pool', async () => {
  const { connections, pool } = manager({ queueWaitMs: 20 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = [1, 2].map(() =>
    connections.withReadClient(async () => {
      await held;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    connections.withReadClient(async () => 'never'),
    PoolBusy,
  );
  release();
  await Promise.all(running);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pool().leased, 0);
  await connections.close();
});

test('PoolBusy is found through causes, but not behind an unknown outcome', () => {
  const busy = new PoolBusy('write', 'queue_full');
  assert.equal(isPoolBusy(busy), true);
  assert.equal(isPoolBusy(new Error('wrapped', { cause: busy })), true);
  assert.equal(isPoolBusy(Object.assign(new Error('commit?', { cause: busy }), { outcome: 'unknown' })), false);
  assert.equal(isPoolBusy(new Error('other')), false);
});

test('the server answers a refused checkout 503 with Retry-After; a write says it never ran', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-busy-'));
  const db = join(dir, 'busy.db');
  makeDemoDatabase(db);
  const registry = new Registry();
  registry.add({ name: 'rw', url: db, writable: true, source: 'config' });
  registry.setActive('rw');
  const opened = await registry.open('rw');
  const refuse = () => {
    throw new PoolBusy('read', 'queue_timeout');
  };
  /* Every statement the adapter would run, so whichever one a route asks first is the one refused. */
  const adapter = opened.adapter as unknown as Record<string, unknown>;
  const names = new Set([...Object.keys(adapter), ...Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))]);
  for (const name of names) {
    if (['constructor', 'introspect', 'close', 'dialect', 'poolStats', 'privileges'].includes(name) || typeof adapter[name] !== 'function')
      continue;
    adapter[name] = refuse;
  }
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  bound.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${bound.port}`;
  try {
    const read = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'country' }),
    });
    assert.equal(read.status, 503, await read.clone().text());
    assert.equal(read.headers.get('retry-after'), '1');
    const readBody = (await read.json()) as Record<string, unknown>;
    assert.equal(readBody.error, POOL_BUSY_MESSAGE);
    assert.equal(readBody.code, 'server_busy');
    assert.equal(readBody.outcome, undefined);

    const write = await fetch(`${base}/api/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'country', key: { code: 'AU' }, values: { name: 'Zedland' } }),
    });
    assert.equal(write.status, 503, await write.clone().text());
    assert.equal(write.headers.get('retry-after'), '1');
    const writeBody = (await write.json()) as Record<string, unknown>;
    assert.equal(writeBody.outcome, 'not_applied');
    assert.equal(writeBody.code, 'server_busy');
  } finally {
    server.close();
    server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The background writer is one connection that jobs, effects, deliveries and workflow steps all wait for. It used to
   take any number of them, for as long as the driver's connect timeout, and a burst failed together as an
   unavailable store. A line past its bound is answered busy before anything was leased, which a job's command
   reads as temporarily_unavailable and retries; the ones inside the bound all complete. */
test('a burst of background checkouts past the writer queue is answered busy, and none of the queued is lost', async () => {
  const { connections } = manager({ queuePerConnection: 3 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done: number[] = [];
  const work = (n: number, wait?: Promise<void>) =>
    asBackgroundWork(() =>
      connections.withWriteClient(async () => {
        await wait;
        done.push(n);
      }),
    );
  // One holds the background writer; three more may wait (the queue is 1 x 3); the rest are refused at once.
  const first = work(0, held);
  await new Promise((resolve) => setImmediate(resolve));
  const settling = Promise.allSettled([first, ...Array.from({ length: 8 }, (_, i) => work(i + 1))]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await settling;
  const refused = answers.filter((answer) => answer.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(refused.length, 5);
  for (const answer of refused) assert.ok(isPoolBusy(answer.reason), 'busy, which a caller retries');
  assert.deepEqual(
    [...done].sort((a, b) => a - b),
    [0, 1, 2, 3],
    'what queued ran',
  );
  await connections.close();
});

test("a background checkout that waits out the driver's connect timeout is answered busy, not as a store fault", async () => {
  const pg = {
    Pool: function Pool(o: PgPoolOptions) {
      const pool = new HoldingPool(o);
      pool.connect = () => Promise.reject(new Error('timeout exceeded when trying to connect'));
      return pool;
    },
  };
  const connections = new PgConnectionManager(
    'postgres://fake',
    () => {},
    async () => pg,
    { readers: 1, writers: 1 },
  );
  await assert.rejects(
    asBackgroundWork(() => connections.withWriteClient(async () => 'never')),
    (error: unknown) => isPoolBusy(error),
  );
  await connections.close();
});
