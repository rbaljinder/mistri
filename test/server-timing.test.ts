/**
 * MISTRI_SERVER_TIMING=1 answers each request with where its time went
 * (serverTiming.ts): absent without it, and with it the database flights a
 * pipelined batch makes counted once, and the wait for a full pool recorded.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PgConnectionManager, type PgPoolOptions, type PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import {
  registerGauge,
  sampleProcessNow,
  setServerTiming,
  setServerTimingToken,
  timeClient,
  timedListener,
} from '../packages/engine/src/adapters/telemetry/serverTiming.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { makeDemoDatabase } from './make-demo-db.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A driver client that answers each statement after `ms`, pipelining or not. */
class SlowClient {
  constructor(
    readonly pipeline: boolean,
    private readonly ms = 15,
    private readonly giveBack: () => void = () => {},
  ) {}
  async query(): Promise<PgResult<Record<string, unknown>>> {
    await pause(this.ms);
    return { rows: [], fields: [], rowCount: 0 };
  }
  release(): void {
    this.giveBack();
  }
}

/** Hands out `max` clients, then queues each checkout until one is given back. */
class HoldingPool extends EventEmitter {
  leased = 0;
  readonly queue: Array<(client: SlowClient) => void> = [];
  constructor(readonly options: PgPoolOptions) {
    super();
  }
  connect(): Promise<SlowClient> {
    const client = new SlowClient(false, 15, () => this.giveBack());
    if (this.leased < this.options.max) {
      this.leased += 1;
      return Promise.resolve(client);
    }
    return new Promise((resolve) => this.queue.push(() => resolve(client)));
  }
  giveBack(): void {
    const next = this.queue.shift();
    if (next) next(new SlowClient(false));
    else this.leased -= 1;
  }
  query(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  async end(): Promise<void> {}
}

async function serve(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** The header's metrics by name: `dur` and `desc`. */
function metrics(header: string | null): Map<string, { dur: number; desc?: string }> {
  assert.ok(header, 'a Server-Timing header');
  return new Map(
    header.split(', ').map((metric) => {
      const [name, ...params] = metric.split(';');
      const dur = Number(params.find((param) => param.startsWith('dur='))?.slice(4));
      const desc = params.find((param) => param.startsWith('desc='))?.slice(6, -1);
      return [name, { dur, ...(desc ? { desc } : {}) }];
    }),
  );
}

async function timedServer(work: () => Promise<void>): Promise<Map<string, { dur: number; desc?: string }>> {
  const server = createServer(
    timedListener(async (_req: IncomingMessage, res: ServerResponse) => {
      await work();
      res.end('ok');
    }),
  );
  const base = await serve(server);
  try {
    const answer = await fetch(base);
    await answer.text();
    return metrics(answer.headers.get('server-timing'));
  } finally {
    server.close();
  }
}

test('a request carries Server-Timing only when the flag is on, and says nothing of what it read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-timing-'));
  const db = join(dir, 'timing.db');
  makeDemoDatabase(db);
  const registry = new Registry();
  registry.add({ name: 'demo', url: db, source: 'config' });
  registry.setActive('demo');
  await registry.open('demo');
  const ask = async () => {
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound });
    const base = await serve(server);
    bound.port = Number(new URL(base).port);
    try {
      const read = await fetch(`${base}/api/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: 'country' }),
      });
      assert.equal(read.status, 200, await read.clone().text());
      await read.text();
      return read.headers.get('server-timing');
    } finally {
      server.close();
    }
  };
  try {
    setServerTiming(false);
    assert.equal(await ask(), null);
    setServerTiming(true);
    const header = await ask();
    const said = metrics(header);
    assert.ok(said.get('total')!.dur >= 0);
    assert.ok(said.get('cpu')!.dur >= 0);
    assert.doesNotMatch(header!, /country|SELECT/i);
  } finally {
    setServerTiming(false);
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pipelined batch is one flight; statements on a client that does not pipeline are one each', async () => {
  setServerTiming(true);
  try {
    const pipelining = new SlowClient(true);
    const serial = new SlowClient(false);
    timeClient(pipelining, 'app');
    timeClient(serial, 'auth');
    const said = await timedServer(async () => {
      await Promise.all([pipelining.query(), pipelining.query(), pipelining.query()]);
      await pipelining.query();
      await Promise.all([serial.query(), serial.query()]);
    });
    assert.equal(said.get('db-app')?.desc, 'flights=2 max=1');
    assert.equal(said.get('db-auth')?.desc, 'flights=2 max=1');
    assert.ok(said.get('db-app')!.dur >= 25, `two flights of 15 ms awaited: ${said.get('db-app')!.dur}`);
  } finally {
    setServerTiming(false);
  }
});

test('a checkout that waits for a full pool is recorded as pool wait, and the lease as a flight', async () => {
  setServerTiming(true);
  const pg = { Pool: HoldingPool };
  const connections = new PgConnectionManager(
    'postgres://fake',
    () => {},
    async () => pg,
    {
      readers: 1,
      writers: 1,
      timingLabel: 'timed',
    },
  );
  try {
    const hold = () =>
      connections.withReadClient(async (client) => {
        await client.query('SELECT 1');
        await pause(40);
      });
    const said = await timedServer(async () => {
      await Promise.all([hold(), hold()]);
    });
    const wait = said.get('pool-timed-read');
    assert.equal(wait?.desc, 'n=2');
    assert.ok(wait!.dur >= 40, `the second checkout waited for the first lease: ${wait!.dur}`);
    assert.equal(said.get('db-timed')?.desc, 'flights=2 max=1');
  } finally {
    setServerTiming(false);
    await connections.close();
  }
});

test('the process entry carries the instance, memory, gc, loop, cpu and registered gauges, and only with the flag on', async () => {
  setServerTiming(true);
  registerGauge('probe', () => 7);
  sampleProcessNow();
  const entry = (header: string | null) => {
    const desc = metrics(header).get('proc')?.desc;
    assert.ok(desc, 'a proc entry');
    return Object.fromEntries(desc.split(' ').map((pair) => pair.split('=') as [string, string]));
  };
  const listener = timedListener((_req: IncomingMessage, res: ServerResponse) => {
    res.end('ok');
  });
  const ask = async () => {
    const server = createServer(listener);
    const base = await serve(server);
    try {
      const response = await fetch(base);
      await response.text();
      return response.headers.get('server-timing');
    } finally {
      server.close();
    }
  };
  try {
    const first = entry(await ask());
    assert.match(first.i, /^[0-9a-f]{8}$/);
    for (const key of ['n', 'up', 'rss', 'hu', 'ht', 'ext', 'ab', 'gch', 'elu'])
      assert.ok(Number.isFinite(Number(first[key])), `${key} is a number: ${first[key]}`);
    assert.equal(first.gcn.split('/').length, 4, 'minor/major/incremental/weak counts');
    assert.equal(first.gcms.split('/').length, 4);
    assert.equal(first.el.split('/').length, 3, 'p50/p99/max');
    assert.equal(first.cpu.split('/').length, 2, 'user/system');
    assert.equal(first.probe, '7');
    assert.ok(Number(first.rss) > 0 && Number(first.hu) > 0);
    // The header is the cached sample: the same sample twice, until the next tick.
    const again = entry(await ask());
    assert.equal(again.n, first.n);
    assert.equal(again.i, first.i);
    sampleProcessNow();
    assert.equal(Number(entry(await ask()).n), Number(first.n) + 1);
    // A gauge taken out (a pool's, at its manager's close) is read no more, and nothing keeps its owner alive.
    const off = registerGauge('gone', () => 3);
    sampleProcessNow();
    assert.equal(entry(await ask()).gone, '3');
    off();
    off();
    sampleProcessNow();
    assert.equal(entry(await ask()).gone, undefined);
    assert.equal(entry(await ask()).probe, '7');
  } finally {
    setServerTiming(false);
  }
});

test("with MISTRI_SERVER_TIMING_TOKEN set, the process entry goes only to a request that sends the token; the request's own entries go to all", async () => {
  setServerTiming(true);
  sampleProcessNow();
  const listener = timedListener((_req: IncomingMessage, res: ServerResponse) => {
    res.end('ok');
  });
  const ask = async (headers: Record<string, string> = {}) => {
    const server = createServer(listener);
    const base = await serve(server);
    try {
      const response = await fetch(base, { headers });
      await response.text();
      return metrics(response.headers.get('server-timing'));
    } finally {
      server.close();
    }
  };
  try {
    setServerTimingToken(undefined);
    assert.ok((await ask()).has('proc'), "no token set: today's behavior, proc for anyone");
    setServerTimingToken('s3cret-token');
    const anonymous = await ask();
    assert.ok(!anonymous.has('proc'), 'no header: no proc');
    assert.ok(anonymous.has('total') && anonymous.has('cpu'), "the request's own entries stay");
    assert.ok(!(await ask({ 'x-mistri-timing': 'wrong' })).has('proc'), 'a wrong token: no proc');
    assert.ok(!(await ask({ 'x-mistri-timing': 's3cret-token-longer' })).has('proc'), 'a longer token: no proc');
    const trusted = await ask({ 'x-mistri-timing': 's3cret-token' });
    assert.ok(trusted.has('proc') && trusted.has('total'), 'the right token: proc added');
  } finally {
    setServerTimingToken(undefined);
    setServerTiming(false);
  }
});
