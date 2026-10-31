/**
 * The reader pool's budget and its meters, on a fake driver that holds to its
 * `max` the way pg-pool does: a checkout past it queues until a client comes
 * back, and fails at the acquisition timeout when none does.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  configurePostgresPools,
  DEFAULT_READERS,
  MAX_READERS,
  PgConnectionManager,
  postgresPoolDefaults,
  type PgClient,
  type PgConnectionOptions,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { POOL_DURATION_BOUNDS_MS, PoolMeter, type PoolCheckout } from '../packages/engine/src/adapters/poolMetrics.js';
import { REQUEST_DURATION_BOUNDS_MS } from '../packages/engine/src/server/operations/requestMetrics.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** Samples past the 25 ms bound: a real wait or hold, not scheduling noise. */
const past25 = (values: readonly number[]) => sum(values.slice(POOL_DURATION_BOUNDS_MS.indexOf(50)));

class FakeClient implements PgClient {
  readonly statements: string[] = [];
  constructor(private readonly pool: BoundedPool) {}

  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(request: string | { text: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
    const text = typeof request === 'string' ? request : request.text;
    this.statements.push(text);
    await this.pool.gate(text);
    return { rows: [{ answer: text }], fields: [{ name: 'answer' }], rowCount: 1 };
  }

  release(destroy?: boolean | Error): void {
    this.pool.giveBack(this, Boolean(destroy));
  }
}

/** pg-pool in miniature: at most `max` clients, then a FIFO queue with a timeout. */
class BoundedPool extends EventEmitter implements PgPool {
  private readonly idle: FakeClient[] = [];
  private readonly waiters: Array<{ resolve: (client: FakeClient) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  total = 0;
  timeoutMs = 1_000;
  failNext?: Error;
  gate: (text: string) => Promise<void> = async () => {};

  constructor(readonly options: PgPoolOptions) {
    super();
  }

  get totalCount(): number {
    return this.total;
  }

  async connect(): Promise<FakeClient> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    const idle = this.idle.pop();
    if (idle) return idle;
    if (this.total < this.options.max) return this.dial();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error('timeout exceeded when trying to connect'));
        }, this.timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private async dial(): Promise<FakeClient> {
    this.total += 1;
    const client = new FakeClient(this);
    await this.options.onConnect(client);
    return client;
  }

  giveBack(client: FakeClient, destroy: boolean): void {
    if (destroy) this.total -= 1;
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      if (destroy) void this.dial().then(waiter.resolve, waiter.reject);
      else waiter.resolve(client);
    } else if (!destroy) this.idle.push(client);
  }

  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(..._request: unknown[]): Promise<never> {
    throw new Error('Reads lease a client; nothing calls pool.query.');
  }

  async end(): Promise<void> {}
}

function fixture(options?: PgConnectionOptions) {
  const pools: BoundedPool[] = [];
  const module = {
    Pool: class extends BoundedPool {
      constructor(o: PgPoolOptions) {
        super(o);
        pools.push(this);
      }
    },
  };
  const manager = new PgConnectionManager('postgres://user@host/db', undefined, async () => module, options);
  return { manager, pools };
}

/** A gate each SELECT waits at until the test lets it through. */
function held() {
  const waiting: Array<() => void> = [];
  return {
    waiting,
    gate: (text: string) =>
      text.startsWith('SELECT')
        ? new Promise<void>((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve(),
    releaseAll: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

test("the pool meters read on the HTTP metrics' bounds, so one scale reads both", () => {
  assert.deepEqual([...POOL_DURATION_BOUNDS_MS], [...REQUEST_DURATION_BOUNDS_MS]);
});

test('the reader pool takes its size from its options, then the process default, then four', async () => {
  try {
    const own = fixture({ readers: 16 });
    await own.manager.read();
    await own.manager.withWriteClient(async () => {});
    assert.deepEqual(
      own.pools.map((pool) => pool.options.max),
      [16, 1],
    );
    await own.manager.close();

    const plain = fixture();
    await plain.manager.read();
    assert.equal(DEFAULT_READERS, 4);
    assert.equal(plain.pools[0].options.max, DEFAULT_READERS);
    assert.equal(plain.manager.pooler, 'session');
    await plain.manager.close();

    configurePostgresPools({ readers: 9, pooler: 'transaction' });
    assert.deepEqual(postgresPoolDefaults(), { readers: 9, pooler: 'transaction' });
    const defaulted = fixture();
    await defaulted.manager.read();
    assert.equal(defaulted.pools[0].options.max, 9);
    assert.equal(defaulted.manager.pooler, 'transaction');
    await defaulted.manager.close();

    // A manager's own options still win over the process default.
    const named = fixture({ readers: 2, pooler: 'session' });
    await named.manager.read();
    assert.equal(named.pools[0].options.max, 2);
    assert.equal(named.manager.pooler, 'session');
    await named.manager.close();
  } finally {
    configurePostgresPools({});
  }
  assert.deepEqual(postgresPoolDefaults(), { readers: 4, pooler: 'session' });
});

test('a reader pool outside 1 to 64 is refused, never clamped', () => {
  for (const readers of [0, MAX_READERS + 1, 1.5, Number.NaN, -1]) {
    assert.throws(() => new PgConnectionManager('postgres://host/db', undefined, async () => ({}), { readers }), RangeError);
    assert.throws(() => configurePostgresPools({ readers }), RangeError);
  }
  assert.throws(() => configurePostgresPools({ pooler: 'statement' as never }), RangeError);
  assert.deepEqual(postgresPoolDefaults(), { readers: 4, pooler: 'session' });
  assert.doesNotThrow(() => new PgConnectionManager('postgres://host/db', undefined, async () => ({}), { readers: MAX_READERS }));
});

test('checkouts past the pool queue behind it, the meters say so while they wait, and every read still answers', async () => {
  const { manager, pools } = fixture({ readers: 2 });
  const read = await manager.read();
  const gate = held();
  pools[0].gate = gate.gate;
  let done = false;
  const answers = Promise.all([1, 2, 3, 4, 5].map((n) => read.query(`SELECT ${n}`))).then((results) => {
    done = true;
    return results;
  });
  while (gate.waiting.length < 2) await tick();

  const busy = manager.stats()[0];
  assert.deepEqual(
    {
      role: busy.role,
      size: busy.size,
      open: busy.open,
      inUse: busy.inUse,
      waiting: busy.waiting,
      queued: busy.queued,
      saturated: busy.saturated,
    },
    { role: 'read', size: 2, open: 2, inUse: 2, waiting: 3, queued: 3, saturated: true },
  );

  while (!done) {
    gate.releaseAll();
    await tick();
  }
  assert.deepEqual(
    (await answers).map((result) => result.rows[0].answer),
    ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4', 'SELECT 5'],
  );
  const calm = manager.stats()[0];
  assert.deepEqual(
    {
      inUse: calm.inUse,
      waiting: calm.waiting,
      saturated: calm.saturated,
      checkouts: calm.checkouts,
      queued: calm.queued,
      timedOut: calm.timedOut,
      failed: calm.failed,
    },
    { inUse: 0, waiting: 0, saturated: false, checkouts: 5, queued: 3, timedOut: 0, failed: 0 },
  );
  assert.equal(calm.waitBuckets.length, POOL_DURATION_BOUNDS_MS.length + 1);
  assert.equal(sum(calm.waitBuckets), 5);
  assert.equal(sum(calm.holdBuckets), 5);
  await manager.close();
});

test('a checkout that waited behind a held connection records the wait, and the holder its hold', async () => {
  const { manager } = fixture({ readers: 1 });
  const first = manager.withReadClient(() => new Promise<string>((resolve) => setTimeout(() => resolve('first'), 60)));
  while (manager.stats()[0]?.inUse !== 1) await tick();
  const second = manager.withReadClient(async () => 'second');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  const stats = manager.stats()[0];
  assert.equal(stats.queued, 1);
  assert.ok(past25(stats.waitBuckets) >= 1, `the second checkout waited about 60 ms: ${stats.waitBuckets.join(',')}`);
  assert.ok(past25(stats.holdBuckets) >= 1, `the first lease was held about 60 ms: ${stats.holdBuckets.join(',')}`);
  await manager.close();
});

test('a checkout that times out is counted as one and keeps the pool saturated; another failure is counted apart', async () => {
  const { manager, pools } = fixture({ readers: 1 });
  await manager.read();
  let release!: () => void;
  const holding = manager.withReadClient(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  while (manager.stats()[0].inUse !== 1) await tick();
  /* The checkout waits its turn in the manager's own line (poolAdmission.ts), then asks the driver, which gives up
     on the connection. */
  const waited = manager.withReadClient(async () => 'never');
  pools[0].failNext = new Error('timeout exceeded when trying to connect');
  release();
  await assert.rejects(waited, /timeout exceeded when trying to connect/);
  await holding;
  const stats = manager.stats()[0];
  assert.deepEqual(
    {
      timedOut: stats.timedOut,
      failed: stats.failed,
      waiting: stats.waiting,
      saturated: stats.saturated,
      checkouts: stats.checkouts,
      queued: stats.queued,
    },
    { timedOut: 1, failed: 0, waiting: 0, saturated: true, checkouts: 2, queued: 1 },
  );

  pools[0].failNext = new Error('connect ECONNREFUSED 127.0.0.1:5432');
  await assert.rejects(
    manager.withReadClient(async () => {}),
    /ECONNREFUSED/,
  );
  assert.deepEqual([manager.stats()[0].failed, manager.stats()[0].timedOut], [1, 1]);
  await manager.close();
});

test('the meter buckets waits and holds on the clock it is given, and forgets a timeout after a minute', () => {
  let now = 0;
  const meter = new PoolMeter('read', 2, () => now);
  const a: PoolCheckout = meter.begin();
  const b = meter.begin();
  const c = meter.begin();
  let stats = meter.stats('session', null);
  assert.deepEqual([stats.inUse, stats.waiting, stats.queued, stats.saturated], [0, 1, 1, true]);

  const giveA = a.acquired();
  const giveB = b.acquired();
  now = 30;
  giveA();
  const giveC = c.acquired();
  now = 12_030;
  giveB();
  giveC();
  const d = meter.begin();
  now += 10_000;
  d.failed(true);
  const e = meter.begin();
  e.failed(false);

  stats = meter.stats('transaction', 3);
  // Waits: a, b and e at once (≤1 ms), c 30 ms (≤50), d 10 s (≤10,000).
  assert.deepEqual(stats.waitBuckets, [3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
  // Holds: a 30 ms (≤50); b 12,030 ms and c 12,000 ms (≤30,000).
  assert.deepEqual(stats.holdBuckets, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0]);
  assert.deepEqual(
    {
      checkouts: stats.checkouts,
      queued: stats.queued,
      timedOut: stats.timedOut,
      failed: stats.failed,
      inUse: stats.inUse,
      waiting: stats.waiting,
      saturated: stats.saturated,
      pooler: stats.pooler,
      open: stats.open,
    },
    { checkouts: 5, queued: 1, timedOut: 1, failed: 1, inUse: 0, waiting: 0, saturated: true, pooler: 'transaction', open: 3 },
  );
  assert.equal(Object.isFrozen(stats), true);
  assert.equal(Object.isFrozen(stats.waitBuckets), true);

  // Settling twice changes nothing.
  giveA();
  d.failed(true);
  assert.deepEqual([meter.stats('session', null).inUse, meter.stats('session', null).timedOut], [0, 1]);

  now += 60_001;
  assert.equal(meter.stats('session', null).saturated, false);
});

test('stats list only the pools opened, readers first, and stay readable after close', async () => {
  const { manager } = fixture();
  assert.deepEqual(manager.stats(), []);
  await manager.withWriteClient(async () => {});
  assert.deepEqual(
    manager.stats().map((stats) => [stats.role, stats.size, stats.checkouts]),
    [['write', 1, 1]],
  );
  await manager.read();
  assert.deepEqual(
    manager.stats().map((stats) => [stats.role, stats.checkouts]),
    [
      ['read', 0],
      ['write', 1],
    ],
  );
  await manager.close();
  assert.deepEqual(
    manager.stats().map((stats) => stats.role),
    ['read', 'write'],
  );
});
