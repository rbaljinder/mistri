/**
 * A writer's pipeline against a live PostgreSQL (TABLEWALK_TEST_PG).
 *
 * A writer's client sends each statement as it is asked (postgresPool.ts), and
 * pipelined() (postgresTransactionHandle.ts) asks several at once inside a
 * transaction: one round trip for all of them. Four things have to hold for
 * that to be safe, and each is pinned here:
 *
 * - the statements leave together (one flight on the wire), and a client that
 *   does not pipeline gets the same answers one at a time;
 * - a statement that fails aborts every one behind it, the first failure is the
 *   one thrown, none rejects unheard, and the connection is usable after the
 *   ROLLBACK;
 * - behind a transaction-mode pooler (PgBouncer, PlanetScale's port 6432) the
 *   pipeline stays on its one server connection. A transaction pooler hands a
 *   server connection to another client when the server says it is idle
 *   (ReadyForQuery 'I'); a pipeline is safe there exactly when no such answer
 *   arrives while the client still has messages in flight. Every pipeline
 *   pipelined() sends sits inside BEGIN..COMMIT, where the server's answers
 *   say 'T' or 'E', never 'I'. That property does not depend on the pooler's
 *   version. The model below is such a pooler — one server connection shared
 *   by several clients, handed over on 'I' — and it counts every 'I' that
 *   arrives with messages still in flight: zero for our pipelines, and more
 *   than zero for a pipeline outside a transaction, so the count is proven to
 *   see what it is looking for.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { after, test } from 'node:test';
import { PgConnectionManager, pipelines, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { pipelined, transactionHandle } from '../packages/engine/src/adapters/postgresTransactionHandle.js';
import { startLatencyProxy } from '../e2e/support/latencyProxy.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE);

const unheard: unknown[] = [];
const listen = (reason: unknown) => unheard.push(reason);
process.on('unhandledRejection', listen);
after(() => process.off('unhandledRejection', listen));

const rows = (answer: unknown) => (answer as { rows: Record<string, unknown>[] }).rows;

test('a writer pipeline leaves in one flight, a reader asks one at a time, and both answer alike', { skip }, async () => {
  const proxy = await startLatencyProxy(LIVE!, 20);
  const manager = new PgConnectionManager(proxy.route(LIVE!));
  // Reads only: a reader's transaction is read-only.
  const statements = [
    'SELECT 1 AS pipeline_probe',
    { text: 'SELECT $1::int AS pipeline_probe', values: [2] },
    'SELECT count(*)::int AS n FROM generate_series(1, 7) AS pipeline_probe',
    { text: 'SELECT $1::text AS said, 4 AS pipeline_probe', values: ['last'] },
  ];
  const flights = (since: number) => {
    const sent = proxy.statements(since).filter((statement) => statement.text.includes('pipeline_probe'));
    return new Set(sent.map((statement) => `${statement.connection}:${statement.flight}`)).size;
  };
  try {
    const run = async (client: PgQuery) => {
      const handle = transactionHandle(client);
      await handle.query('BEGIN');
      try {
        const answers = await pipelined(handle, statements);
        return [rows(answers[2])[0].n, rows(answers[3])[0].said];
      } finally {
        await handle.query('ROLLBACK');
      }
    };
    let since = Date.now();
    assert.deepEqual(await manager.withWriteClient(run), [7, 'last']);
    assert.equal(flights(since), 1, 'the four statements left in one flight');
    since = Date.now();
    assert.deepEqual(await manager.withReadClient(run), [7, 'last']);
    assert.equal(flights(since), 4, 'a reader does not pipeline: each statement waits for the one before');
  } finally {
    await manager.close();
    await proxy.close();
  }
});

test(
  'a statement that fails mid-pipeline aborts the ones behind it, is the one thrown, and leaves the connection usable',
  { skip },
  async () => {
    const manager = new PgConnectionManager(LIVE!);
    try {
      await manager.withWriteClient(async (client) => {
        const handle = transactionHandle(client);
        await handle.query('BEGIN');
        await handle.query('CREATE TEMP TABLE pipeline_abort (n int PRIMARY KEY) ON COMMIT DROP');
        const failure = await pipelined(handle, [
          'INSERT INTO pipeline_abort VALUES (1)',
          'INSERT INTO pipeline_abort VALUES (1)',
          'INSERT INTO pipeline_abort VALUES (2)',
          'SELECT 1',
        ]).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.equal((failure as { code?: string }).code, '23505', 'the duplicate is what is thrown, not the abort behind it');
        await handle.query('ROLLBACK');
        assert.equal(rows(await handle.query('SELECT 2 AS n'))[0].n, 2);
        // A check that refuses an answer is the failure, and later answers reach no check.
        await handle.query('BEGIN');
        const checked: number[] = [];
        await assert.rejects(
          pipelined(handle, ['SELECT 1 AS n', 'SELECT 2 AS n', 'SELECT 3 AS n'], (answer, index) => {
            checked.push(index);
            if (rows(answer)[0].n === 2) throw new Error('two is refused');
          }),
          /two is refused/,
        );
        assert.deepEqual(checked, [0, 1]);
        await handle.query('ROLLBACK');
      });
      await assert.rejects(
        manager.withWriteClient((client) => pipelined(client, ['SELECT 1'])),
        /transaction handle/,
        'a bare client is refused: outside a transaction each statement would commit on its own',
      );
    } finally {
      await manager.close();
    }
    await new Promise((settled) => setImmediate(settled));
    assert.deepEqual(unheard, [], 'no answer behind the failure rejected unheard');
  },
);

interface PoolerModel {
  readonly url: string;
  /** Each time the server said idle while its client still had messages in flight. */
  readonly violations: string[];
  /** How many times the server connection changed hands. */
  handoffs: number;
  close(): Promise<void>;
}

/**
 * A transaction-mode pooler, as far as the property needs: `size` server
 * connections, each authenticated by relaying the first clients' startup, and
 * every later client told it is ready without one. A client takes an idle
 * server connection when it sends, and gives it back when the server says it
 * is idle ('Z' with 'I'). Named prepared statements and session state would
 * not survive this, and nothing here uses them.
 */
async function startTransactionPooler(target: string, size = 1): Promise<PoolerModel> {
  const { hostname, port } = new URL(target);
  interface Client {
    socket: Socket;
    server?: Server;
    queue: Buffer[];
    outstanding: number;
  }
  interface Server {
    socket: Socket;
    client?: Client;
    started: boolean;
  }
  const servers: Server[] = [];
  const waiting: Client[] = [];
  const sockets = new Set<Socket>();
  let greeting: Buffer[] | undefined;
  const greeted: Array<() => void> = [];
  const model: PoolerModel = {
    url: '',
    violations: [],
    handoffs: 0,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => listener.close(() => done()));
    },
  };
  const message = (type: string, body: Buffer) => {
    const head = Buffer.alloc(5);
    head.write(type, 0, 'latin1');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  };
  const attach = (client: Client, server: Server) => {
    server.client = client;
    client.server = server;
    for (const chunk of client.queue.splice(0)) server.socket.write(chunk);
  };
  const release = (server: Server) => {
    server.client = undefined;
    model.handoffs += 1;
    const next = waiting.shift();
    if (next) attach(next, server);
  };
  const acquire = (client: Client) => {
    const idle = servers.find((server) => server.started && !server.client);
    if (idle) attach(client, idle);
    else if (!waiting.includes(client)) waiting.push(client);
  };
  /** Whole typed messages off the front of `buffer`, and what is left. */
  const split = (buffer: Buffer): [Buffer[], Buffer] => {
    const out: Buffer[] = [];
    while (buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1) + 1) {
      const length = buffer.readInt32BE(1) + 1;
      out.push(buffer.subarray(0, length));
      buffer = buffer.subarray(length);
    }
    return [out, buffer];
  };

  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const client: Client = { socket, queue: [], outstanding: 0 };
    let pending: Buffer = Buffer.alloc(0);
    let started = false;
    let relaying: Server | undefined;
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (!started) {
        if (relaying) {
          relaying.socket.write(pending);
          pending = Buffer.alloc(0);
          return;
        }
        if (pending.length < 8 || pending.length < pending.readInt32BE(0)) return;
        const length = pending.readInt32BE(0);
        const packet = pending.subarray(0, length);
        pending = pending.subarray(length);
        const code = packet.readInt32BE(4);
        if (code === 80877103) {
          socket.write('N');
          continue;
        }
        if (servers.length < size) {
          const upstream = createConnection({ host: hostname, port: Number(port || 5432) });
          sockets.add(upstream);
          const server: Server = { socket: upstream, started: false };
          servers.push(server);
          relaying = server;
          let fromServer: Buffer = Buffer.alloc(0);
          const recorded: Buffer[] = [];
          upstream.on('data', (data: Buffer) => {
            let messages: Buffer[];
            [messages, fromServer] = split(Buffer.concat([fromServer, data]));
            for (const each of messages) {
              const type = String.fromCharCode(each[0]);
              if (!server.started) {
                if (type === 'S' || type === 'K') recorded.push(each);
                if (type === 'Z') {
                  server.started = true;
                  started = true;
                  relaying = undefined;
                  if (!greeting) {
                    greeting = recorded;
                    for (const ready of greeted.splice(0)) ready();
                  }
                }
                socket.write(each);
                if (server.started) {
                  const next = waiting.shift();
                  if (next) attach(next, server);
                  if (pending.length) socket.emit('data', Buffer.alloc(0));
                }
                continue;
              }
              const owner = server.client;
              if (!owner) {
                model.violations.push(`an answer (${type}) with no client holding the server`);
                continue;
              }
              owner.socket.write(each);
              if (type === 'Z') {
                owner.outstanding -= 1;
                if (each[5] !== 0x49) continue;
                if (owner.outstanding > 0) model.violations.push(`idle with ${owner.outstanding} message(s) of its client still in flight`);
                else {
                  owner.server = undefined;
                  release(server);
                }
              }
            }
          });
          upstream.write(packet);
          continue;
        }
        const greet = () => {
          socket.write(Buffer.concat([message('R', Buffer.from([0, 0, 0, 0])), ...greeting!, message('Z', Buffer.from('I'))]));
          started = true;
          if (pending.length) socket.emit('data', Buffer.alloc(0));
        };
        if (greeting) greet();
        else greeted.push(greet);
        return;
      }
      let messages: Buffer[];
      [messages, pending] = split(pending);
      for (const each of messages) {
        const type = String.fromCharCode(each[0]);
        if (type === 'X') {
          socket.end();
          return;
        }
        if (type === 'Q' || type === 'S') client.outstanding += 1;
        if (client.server) client.server.socket.write(each);
        else {
          client.queue.push(each);
          acquire(client);
        }
      }
    });
    socket.on('close', () => {
      const index = waiting.indexOf(client);
      if (index >= 0) waiting.splice(index, 1);
    });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const routed = new URL(target);
  routed.hostname = '127.0.0.1';
  routed.port = String((listener.address() as { port: number }).port);
  return Object.assign(model, { url: routed.href });
}

interface RawClient extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

async function rawClient(url: string, pipeline: boolean): Promise<RawClient> {
  const specifier = 'pg';
  type ClientClass = new (options: { connectionString: string; pipeline?: boolean }) => RawClient;
  const pg = (await import(specifier)) as { Client?: ClientClass; default?: { Client: ClientClass } };
  const Client = pg.Client ?? pg.default!.Client;
  const client = new Client({ connectionString: url, pipeline });
  await client.connect();
  return client;
}

/**
 * Twelve pipelined transactions at once, from two managers in transaction-pooler
 * mode, through `url`: each reads its own rows, under its own transaction and
 * cap, and every third fails mid-pipeline and rolls back.
 */
async function pooledSaves(url: string): Promise<void> {
  // Two managers, so several clients certainly share the pooler's server connections.
  const managers = [0, 1].map(() => new PgConnectionManager(url, undefined, undefined, { pooler: 'transaction' }));
  try {
    const save = (manager: PgConnectionManager, n: number) =>
      manager.withWriteClient(async (client) => {
        assert.ok(pipelines(client), 'a pooled writer pipelines too');
        const handle = transactionHandle(client);
        await handle.query('BEGIN');
        try {
          const answers = await pipelined(handle, [
            'CREATE TEMP TABLE pooled_probe (n int) ON COMMIT DROP',
            { text: 'INSERT INTO pooled_probe SELECT generate_series(1, $1::int)', values: [n] },
            'SELECT count(*)::int AS n, pg_current_xact_id()::text AS xact FROM pooled_probe',
            // The pooler path's per-transaction settings went ahead of the pipeline.
            "SELECT current_setting('statement_timeout') AS cap",
          ]);
          if (n % 3 === 0) {
            // A failure mid-pipeline rolls back, and the server goes back to the pool clean.
            await assert.rejects(pipelined(handle, ['SELECT 1/0', 'SELECT 1']), /division by zero/);
            await handle.query('ROLLBACK');
          } else await handle.query('COMMIT');
          const [counted] = rows(answers[2]);
          return { n: counted.n, xact: counted.xact, cap: rows(answers[3])[0].cap };
        } catch (error) {
          await handle.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    const answers = await Promise.all(Array.from({ length: 12 }, (_, n) => save(managers[n % 2], n + 1)));
    assert.deepEqual(
      answers.map((answer) => answer.n),
      Array.from({ length: 12 }, (_, n) => n + 1),
      'each pipeline read its own transaction',
    );
    assert.equal(new Set(answers.map((answer) => answer.xact)).size, 12, 'twelve transactions, none merged with another');
    assert.ok(
      answers.every((answer) => answer.cap !== '0'),
      'the transaction cap was in force for the whole pipeline',
    );
  } finally {
    await Promise.all(managers.map((manager) => manager.close()));
  }
}

test('behind a transaction-mode pooler, every pipeline stays on its server connection until its COMMIT', { skip }, async () => {
  const pooler = await startTransactionPooler(LIVE!, 1);
  try {
    await pooledSaves(pooler.url);
    assert.ok(pooler.handoffs >= 12, `the one server connection changed hands (${pooler.handoffs})`);
    assert.deepEqual(pooler.violations, []);

    // The same pipeline outside a transaction: the server says idle after the
    // first statement with the second still in flight, which is what the
    // model counts. Proven here, so the zero above means something.
    const bare = await rawClient(pooler.url, true);
    try {
      await Promise.all([bare.query('SELECT 1'), bare.query('SELECT 2')]);
    } finally {
      await bare.end();
    }
    assert.ok(pooler.violations.length > 0, 'a pipeline outside a transaction is seen');
  } finally {
    await pooler.close();
  }
});

/* A real PgBouncer in transaction mode, where one is running: its URL names a
   database it pools, with fewer server connections than the clients here. */
const BOUNCER = process.env.TABLEWALK_TEST_PGBOUNCER;

test('through a real transaction-mode PgBouncer, the same pipelines answer the same', { skip: skip || !BOUNCER }, async () => {
  await pooledSaves(BOUNCER!);
});
