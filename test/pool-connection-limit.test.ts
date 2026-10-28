/**
 * A database that refuses this process another connection (SQLSTATE 53300,
 * "too many connections for role") is a limit to work within, not a fault:
 * the pool goes on with the connections it holds and a checkout waits for one
 * of them, and a pool holding none answers busy. Either way nothing was
 * leased, which is what keeps a tenant writer open (tenant-write-source.test.ts).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { isPoolBusy, PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import { configureWriteOrder } from '../packages/engine/src/adapters/writeLanes.js';

/** The server: how many connections it lets this role hold, across every pool. */
interface Server {
  allows: number;
  open: number;
}

class Client implements PgClient {
  constructor(private readonly pool: LimitedPool) {}
  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
    return { rows: [], fields: [], rowCount: 0 };
  }
  release(): void {
    this.pool.giveBack(this);
  }
}

/** pg-pool's shape where it matters: idle clients first, a new one below `options.max`, a queue at it. */
class LimitedPool extends EventEmitter implements PgPool {
  clients = 0;
  readonly idle: Client[] = [];
  readonly queue: Array<(client: Client) => void> = [];
  constructor(
    readonly options: PgPoolOptions,
    private readonly server: Server,
  ) {
    super();
  }
  get totalCount(): number {
    return this.clients;
  }
  connect(): Promise<Client> {
    const idle = this.idle.pop();
    if (idle) return Promise.resolve(idle);
    if (this.clients >= this.options.max) return new Promise((resolve) => this.queue.push(resolve));
    if (this.server.open >= this.server.allows)
      return Promise.reject(
        Object.assign(new Error('too many connections for role "app"'), {
          code: '53300',
          severity: 'FATAL',
        }),
      );
    this.clients += 1;
    this.server.open += 1;
    return Promise.resolve(new Client(this));
  }
  giveBack(client: Client): void {
    const next = this.queue.shift();
    if (next) next(client);
    else this.idle.push(client);
  }
  query(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  async end(): Promise<void> {}
}

function manager(server: Server) {
  const pg = {
    Pool: function Pool(options: PgPoolOptions) {
      return new LimitedPool(options, server);
    },
  };
  // An App's writes are keyed, so its write pool is as large as it asked (a serial writer is always one).
  configureWriteOrder('keyed');
  try {
    return new PgConnectionManager(
      'postgres://fake',
      () => {},
      async () => pg,
      { readers: 2, writers: 3 },
    );
  } finally {
    configureWriteOrder('serial');
  }
}

function said(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

/* A field report: pools sized past what the database role allows. The write pool's second connection was refused
   at open, the write failed before it began, and the tenant writer took that as an uncertain write: it closed,
   reopened into the same refusal, and two commands in three failed at three users while the one connection it held
   sat idle. The pool now goes on with what it holds. */
test('a pool the database refuses another connection waits for the one it holds, and says so', async (t) => {
  const lines = said(t);
  const connections = manager({ allows: 1, open: 0 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = connections.withWriteClient(async () => {
    await held;
    return 'first';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = connections.withWriteClient(async () => 'second');
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  // Once, with the numbers an operator sizes the pools by.
  const limit = lines.filter((line) => line.includes('connection limit reached'));
  assert.equal(limit.length, 1, lines.join('\n'));
  assert.match(limit[0], /connection limit reached: the app write pool holds 1 of 3 connections/);
  assert.match(limit[0], /too many connections for role "app"/);
  // Later writes go on with the one connection, without asking the database again.
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => connections.withWriteClient(async () => 'ran'))), ['ran', 'ran', 'ran']);
  assert.equal(lines.filter((line) => line.includes('connection limit reached')).length, 1);
  await connections.close();
});

test('holding none, a refused connection is busy, with the refusal beneath it', async (t) => {
  const lines = said(t);
  const connections = manager({ allows: 0, open: 0 });
  await assert.rejects(
    connections.withWriteClient(async () => 'never'),
    (error: unknown) => {
      assert.ok(error instanceof PoolBusy, String(error));
      assert.equal(error.why, 'connection_limit');
      assert.ok(isPoolBusy(error));
      assert.equal((error.cause as { code?: unknown }).code, '53300');
      return true;
    },
  );
  assert.match(lines.join('\n'), /connection limit reached: the app write pool holds 0 of 3 connections/);
  await connections.close();
});

test('a reader refused at its limit waits for its held connection too', async (t) => {
  said(t);
  const connections = manager({ allows: 1, open: 0 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = connections.withReadClient(async () => {
    await held;
    return 'first';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = connections.withReadClient(async () => 'second');
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  await connections.close();
});
