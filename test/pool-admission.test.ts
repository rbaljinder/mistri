/**
 * A pool's line is shared out across accounts (adapters/poolAdmission.ts):
 * turns go round the accounts waiting, each account's own in arrival order;
 * no account holds more than half the line; a full line turns away its
 * longest account's newest waiter for a quieter account's request; and the
 * line's own bounds still refuse. Under a retry storm at one reader — a
 * client asking again the moment it is refused — another account's reads are
 * all answered, where they used to arrive to a line the storm kept full.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitAs, PoolAdmission, withAdmission } from '../packages/engine/src/adapters/poolAdmission.js';
import { PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { Refusal } from '../packages/engine/src/shared/refusal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { createApp } from './support/createApp.js';
import { makeDemoDatabase } from './make-demo-db.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** A checkout as `account`'s request makes it. */
const as = <T>(account: string, work: () => T): T =>
  withAdmission('203.0.113.1', () => {
    admitAs(account);
    return work();
  });
const busy = (why: PoolBusy['why']) => (error: unknown) => error instanceof PoolBusy && error.why === why;

test("turns go round the accounts: a quiet account's request is served next, not behind a storm's line", async () => {
  const line = new PoolAdmission('read', 1, 64);
  const holding = await line.enter(1_000);
  const served: string[] = [];
  const ask = (account: string, n: number) =>
    as(account, () => line.enter(1_000)).then((leave) => {
      served.push(`${account}${n}`);
      leave();
    });
  const storm = Array.from({ length: 10 }, (_, n) => ask('storm', n));
  const quiet = [ask('quiet', 0), ask('quiet', 1)];
  holding();
  await Promise.all([...storm, ...quiet]);
  assert.deepEqual(served.slice(0, 4), ['storm0', 'quiet0', 'storm1', 'quiet1'], 'one turn each, in turn');
  assert.deepEqual(
    served.filter((name) => name.startsWith('storm')),
    Array.from({ length: 10 }, (_, n) => `storm${n}`),
    "an account's own in the order they arrived",
  );
});

test('an account holds at most half the line; past it, refused at once while another account still queues', async () => {
  const line = new PoolAdmission('write', 1, 8);
  const holding = await line.enter(1_000);
  const mine = Array.from({ length: 4 }, () => as('storm', () => line.enter(1_000)));
  await assert.rejects(
    as('storm', () => line.enter(1_000)),
    busy('queue_full'),
  );
  const theirs = as('quiet', () => line.enter(1_000));
  holding();
  await Promise.all([...mine, theirs].map((place) => place.then((leave) => leave())));
});

test("a full line turns away its longest account's newest waiter for a quieter account, never an equal one", async () => {
  const line = new PoolAdmission('read', 1, 4);
  const holding = await line.enter(1_000);
  const outcome = (account: string) =>
    as(account, () => line.enter(1_000)).then(
      (leave) => {
        leave();
        return `${account} served`;
      },
      (error: unknown) => (busy('queue_full')(error) ? `${account} refused` : `${account} ${String(error)}`),
    );
  const a = [outcome('a'), outcome('a')];
  const b = [outcome('b'), outcome('b')];
  // The line is full, two apiece: c holds none, so the longest's newest (a's second) makes way.
  const c = outcome('c');
  await tick();
  // a 1, b 2, c 1: b's second makes way for d.
  const d = outcome('d');
  await tick();
  // One apiece: nobody holds more than e would by more than one, so e is the one refused.
  const e = outcome('e');
  holding();
  assert.deepEqual(await Promise.all([...a, ...b, c, d, e]), [
    'a served',
    'a refused',
    'b served',
    'b refused',
    'c served',
    'd served',
    'e refused',
  ]);
});

test("the line's own bounds still refuse: its length, and its wait, after which the waiter is gone from it", async () => {
  const line = new PoolAdmission('read', 1, 2);
  const holding = await line.enter(1_000);
  const first = as('a', () => line.enter(20));
  const second = as('b', () => line.enter(5_000));
  await assert.rejects(
    as('c', () => line.enter(5_000)),
    busy('queue_full'),
  );
  await assert.rejects(first, busy('queue_timeout'));
  // The one that gave up left the line: the next place is b's, and one more may wait.
  const third = as('c', () => line.enter(5_000));
  holding();
  (await second)();
  (await third)();
});

test("work no request sent is filed under no account: neither held to a share nor turned away for another's", async () => {
  const line = new PoolAdmission('read', 1, 2);
  const holding = await line.enter(1_000);
  // A share is one here; the server's own work waits in both places.
  const own = [line.enter(1_000), line.enter(1_000)];
  await assert.rejects(
    as('a', () => line.enter(1_000)),
    busy('queue_full'),
  );
  holding();
  await Promise.all(own.map((place) => place.then((leave) => leave())));
});

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

/** pg-pool with no timeout of its own: hands out `max` clients, then queues. */
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

test('a line resized to the connections a pool still has admits no more than those, and takes its turns again once restored', async () => {
  const line = new PoolAdmission('read', 2, 64);
  const first = await line.enter(1_000);
  const second = await line.enter(1_000);
  line.resize(1);
  const held: Array<() => void> = [];
  const third = line.enter(1_000).then((leave) => held.push(leave));
  first();
  await tick();
  assert.equal(held.length, 0, 'one place given back, but the line holds one and one is still out');
  second();
  await third;
  assert.equal(held.length, 1, 'served once the one place came free');
  const fourth = line.enter(1_000).then((leave) => held.push(leave));
  await tick();
  assert.equal(held.length, 1, 'held to one while the third is out');
  line.resize(2);
  await fourth;
  assert.equal(held.length, 2, 'served at once when the hold ends');
  for (const leave of held) leave();
});

test('a retry storm at one reader does not starve another account: every one of its reads is answered', async () => {
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
    {
      readers: 1,
      writers: 1,
    },
  );
  const read = () =>
    connections.withReadClient(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  let storming = true;
  let stormAnswered = 0;
  let stormRefused = 0;
  // A hundred clients of one account, each asking again the moment it is answered or refused: Retry-After unread.
  const storm = Array.from({ length: 100 }, async () => {
    while (storming) {
      await as('storm', () => read()).then(
        () => (stormAnswered += 1),
        (error: unknown) => {
          if (!(error instanceof PoolBusy)) throw error;
          stormRefused += 1;
          return tick();
        },
      );
    }
  });
  // Beside it, a second account's twenty reads, eight at a time, as a page's boot sends them.
  const quiet: Array<PromiseSettledResult<void>> = [];
  await tick();
  for (let round = 0; round < 3; round++) {
    quiet.push(...(await Promise.allSettled(Array.from({ length: round < 2 ? 8 : 4 }, () => as('quiet', () => read())))));
  }
  storming = false;
  await Promise.all(storm);
  assert.deepEqual(
    quiet.filter((answer) => answer.status === 'rejected').map((answer) => String((answer as PromiseRejectedResult).reason)),
    [],
    'the quiet account was never refused',
  );
  assert.equal(quiet.length, 20);
  assert.ok(stormRefused > 0, 'the storm was past its share of the line');
  assert.ok(stormAnswered > 0, 'and was served too, in its turns');
  assert.equal(made[0].leased, 0, 'nothing leaked');
  assert.equal(made[0].queue.length, 0, 'nothing left waiting in the driver');
  await connections.close();
});

test("over HTTP a request waits in line as its signed-in account's, or as its client's address's when signed out", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-admission-'));
  const db = join(dir, 'fair.db');
  makeDemoDatabase(db);
  const registry = new Registry();
  registry.add({ name: 'rw', url: db, writable: true, source: 'config' });
  registry.setActive('rw');
  const opened = await registry.open('rw');
  /* A line of one place with two to wait in, held, stands in for a full pool: a share of it is one. A list's rows
     wait their turn there and are then refused, so an answer of 400 says the request was admitted and 503 that the
     line turned it away; every other statement is refused at once, so it is the rows the answer waits for. */
  const line = new PoolAdmission('read', 1, 2);
  let arrived = 0;
  const adapter = opened.adapter as unknown as Record<string, unknown>;
  const names = new Set([...Object.keys(adapter), ...Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))]);
  for (const name of names) {
    if (['constructor', 'introspect', 'close', 'dialect', 'poolStats', 'privileges'].includes(name) || typeof adapter[name] !== 'function')
      continue;
    adapter[name] =
      name === 'query'
        ? async () => {
            arrived += 1;
            (await line.enter(5_000))();
            throw new Refusal('admitted');
          }
        : async () => {
            throw new Refusal('not this one');
          };
  }
  const serve = async (bound: Record<string, unknown> & { host: string; port: number }) => {
    const server = createApp({ registry, bound });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bound.port = (server.address() as { port: number }).port;
    return server;
  };
  const query = (port: number, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ table: 'country' }),
    }).then((res) => res.status);
  // Until `count` requests have reached the line: each crosses a socket first.
  const reached = async (count: number) => {
    for (let i = 0; i < 400 && arrived < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(arrived, count);
  };
  const signedIn = { host: '127.0.0.1', port: 0, identityHeader: 'X-Forwarded-User' };
  const signedOut = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies(['127.0.0.1']).ranges };
  const servers = [await serve(signedIn), await serve(signedOut)];
  try {
    for (const [port, first, same, other] of [
      [
        signedIn.port,
        { 'x-forwarded-user': 'ada@example.org' },
        { 'x-forwarded-user': 'ada@example.org' },
        { 'x-forwarded-user': 'bob@example.org' },
      ],
      [signedOut.port, { 'x-forwarded-for': '198.51.100.7' }, { 'x-forwarded-for': '198.51.100.7' }, { 'x-forwarded-for': '198.51.100.8' }],
    ] as const) {
      arrived = 0;
      const holding = await line.enter(5_000);
      const one = query(port, first);
      await reached(1);
      // The same account (or address) again is past its share; another's is still let in.
      assert.equal(await query(port, same), 503);
      const two = query(port, other);
      await reached(3);
      holding();
      assert.deepEqual(await Promise.all([one, two]), [400, 400]);
    }
  } finally {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
