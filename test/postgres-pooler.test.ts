/**
 * The transaction-mode path: every guarantee a direct connection gets from
 * its session, made per transaction instead, so it holds behind a pooler that
 * hands this client's server connection to someone else between
 * transactions. The live half — a server connection a write left dirty, then
 * read through — is test/postgres-pool-live.test.ts.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgQuery,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { transactionScoped, type TransactionScopedClient } from '../packages/engine/src/adapters/postgresPooler.js';
import { StatementStopped, withCancellation } from '../packages/engine/src/adapters/statementControl.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const RESET =
  /^SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; CLOSE ALL; UNLISTEN \*; SELECT pg_catalog\.pg_advisory_unlock_all\(\); DISCARD PLANS; DISCARD SEQUENCES; DISCARD TEMP/;
const WRITE_BEGIN = 'BEGIN; SET LOCAL statement_timeout = 30000';
const READ_BEGIN = 'BEGIN READ ONLY; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000';

test('snapshot cancellation destroys first but drains callback finally before releasing its logical checkout', async () => {
  const { manager, pools, cancels } = managerFixture('transaction');
  const controller = new AbortController();
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let enteredCleanup = false,
    settled = false;
  let lent: PgQuery | undefined;
  const pending = withCancellation(controller.signal, () =>
    manager.withReadClient(
      async (client) => {
        lent = client;
        await client.query('BEGIN');
        try {
          await client.query('SELECT pg_sleep(60)');
        } finally {
          enteredCleanup = true;
          await cleanup;
        }
      },
      false,
      true,
    ),
  );
  const rejected = assert.rejects(pending, (error) => error instanceof StatementStopped && error.reason === 'cancelled');
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    while (!pools[0]?.clients[0]?.statements.includes('SELECT pg_sleep(60)')) await tick();
    const physical = pools[0].clients[0];
    const originalRelease = physical.release.bind(physical);
    physical.release = (destroy) => {
      originalRelease(destroy);
      if (destroy) physical.interrupt();
    };
    controller.abort();
    while (!enteredCleanup) await tick();
    assert.deepEqual(physical.releases, [true]);
    assert.equal(settled, false);
    assert.equal(manager.stats()[0].inUse, 1);
    await assert.rejects(lent!.query('SELECT 2'), StatementStopped);
    assert.equal(physical.statements.includes('SELECT 2'), false);
    assert.equal(cancels(), 0);
    assert.equal(
      await manager.withReadClient(async (client) => {
        await client.query('SELECT 3');
        return 'sibling';
      }),
      'sibling',
    );
    assert.equal(manager.stats()[0].inUse, 1);
  } finally {
    finish();
  }
  await rejected;
  assert.equal(manager.stats()[0].inUse, 0);
  assert.deepEqual(pools[0].clients[0].releases, [true]);
  await manager.close();
});

test('closed transaction facade refuses continuation SQL after a pending BEGIN completes', async () => {
  let complete!: () => void;
  const begun = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const statements: string[] = [];
  const raw: PgQuery = {
    query: async (request: string | { text: string }) => {
      statements.push(typeof request === 'string' ? request : request.text);
      await begun;
      return { rows: [], fields: [], rowCount: 0 };
    },
  };
  const client = transactionScoped(raw, { role: 'read', capMs: 1000, untrusted: false });
  const pending = client.query('BEGIN');
  client.close(new StatementStopped('cancelled'));
  complete();
  await pending;
  await assert.rejects(client.query('SELECT 1'), StatementStopped);
  await assert.rejects(client.settle(), StatementStopped);
  assert.equal(statements.length, 1);
});

test('draining checkout cancellation during settle destroys without waiting for rollback', async () => {
  const { manager, pools } = managerFixture('transaction');
  const controller = new AbortController();
  let started!: () => void;
  const rollbackStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let rejectRollback!: (error: Error) => void;
  const pending = withCancellation(controller.signal, () =>
    manager.withReadClient(
      async (client) => {
        await client.query('BEGIN');
        const physical = pools[0].clients[0];
        const query = physical.query.bind(physical);
        physical.query = ((request: string | { text: string }) => {
          if (request === 'ROLLBACK')
            return new Promise<never>((_, reject) => {
              rejectRollback = reject;
              started();
            });
          return query(request as string);
        }) as PgQuery['query'];
        const release = physical.release.bind(physical);
        physical.release = (destroy) => {
          release(destroy);
          if (destroy) rejectRollback(new Error('connection terminated'));
        };
        return 'must not escape';
      },
      false,
      true,
    ),
  );
  const rejected = assert.rejects(pending, StatementStopped);
  await rollbackStarted;
  controller.abort();
  await rejected;
  assert.deepEqual(pools[0].clients[0].releases, [true]);
  assert.equal(manager.stats()[0].inUse, 0);
  await manager.close();
});

/** A client that records every statement, and refuses the ones `fail` matches. */
class Recorder {
  readonly log: string[] = [];
  fail?: RegExp;

  async query(request: string | { text: string }): Promise<unknown> {
    const text = typeof request === 'string' ? request : request.text;
    this.log.push(text);
    if (this.fail?.test(text)) throw Object.assign(new Error(`refused: ${text}`), { code: 'XX000' });
    const result = { rows: [], fields: [], rowCount: 0 };
    // A simple-protocol string with several statements answers with one result each, as pg does.
    return text.includes('; ') ? [result, result] : result;
  }
}

function scoped(role: 'read' | 'write', untrusted = false): { client: TransactionScopedClient; recorder: Recorder; log: string[] } {
  const recorder = new Recorder();
  const client = transactionScoped(recorder as unknown as PgQuery, { role, capMs: 30_000, untrusted });
  return { client, recorder, log: recorder.log };
}

test('a statement outside a transaction runs in one of its own: read-only on a reader, with the cap', async () => {
  const read = scoped('read');
  await read.client.query('SELECT 1', []);
  assert.deepEqual(read.log, [READ_BEGIN, 'SELECT 1', 'COMMIT']);
  const write = scoped('write');
  await write.client.query('UPDATE t SET x = 1 WHERE id = $1', [1]);
  assert.deepEqual(write.log, [WRITE_BEGIN, 'UPDATE t SET x = 1 WHERE id = $1', 'COMMIT']);
});

test("a caller's BEGIN carries the settings in the same round trip, and COMMIT or ROLLBACK closes it", async () => {
  const write = scoped('write');
  await write.client.query('BEGIN');
  await write.client.query('SELECT 1 FROM t FOR UPDATE');
  await write.client.query('SAVEPOINT a');
  await write.client.query('ROLLBACK TO SAVEPOINT a');
  await write.client.query('UPDATE t SET x = 2');
  await write.client.query('COMMIT');
  await write.client.query('SELECT 2');
  assert.deepEqual(write.log, [
    WRITE_BEGIN,
    'SELECT 1 FROM t FOR UPDATE',
    'SAVEPOINT a',
    'ROLLBACK TO SAVEPOINT a',
    'UPDATE t SET x = 2',
    'COMMIT',
    WRITE_BEGIN,
    'SELECT 2',
    'COMMIT',
  ]);

  // A reader's transaction is read-only whatever its BEGIN said, and its isolation is kept.
  const read = scoped('read');
  await read.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await read.client.query('SELECT 1');
  await read.client.query('ROLLBACK');
  const plain = scoped('read');
  await plain.client.query('BEGIN');
  assert.deepEqual(
    [...read.log, ...plain.log],
    [
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000',
      'SELECT 1',
      'ROLLBACK',
      'BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000',
    ],
  );
});

test('edges are read past leading comments, nested ones included', async () => {
  const write = scoped('write');
  await write.client.query('-- note\n/* outer /* inner */ still */ BEGIN');
  await write.client.query('/* done */ COMMIT;');
  assert.deepEqual(write.log, ['-- note\n/* outer /* inner */ still */ BEGIN; SET LOCAL statement_timeout = 30000', '/* done */ COMMIT;']);
});

test('a statement that fails outside a transaction is rolled back, its error kept, and the next one wrapped afresh', async () => {
  const write = scoped('write');
  write.recorder.fail = /^INSERT/;
  await assert.rejects(write.client.query('INSERT INTO t VALUES (1)'), /refused: INSERT/);
  write.recorder.fail = undefined;
  await write.client.query('SELECT 1');
  assert.deepEqual(write.log, [WRITE_BEGIN, 'INSERT INTO t VALUES (1)', 'ROLLBACK', WRITE_BEGIN, 'SELECT 1', 'COMMIT']);
});

test('a BEGIN whose settings fail is rolled back, and nothing after it counts as inside', async () => {
  const write = scoped('write');
  write.recorder.fail = /SET LOCAL/;
  await assert.rejects(write.client.query('BEGIN'), /refused/);
  write.recorder.fail = undefined;
  await write.client.query('SELECT 1');
  assert.deepEqual(write.log, [WRITE_BEGIN, 'ROLLBACK', WRITE_BEGIN, 'SELECT 1', 'COMMIT']);
});

test('user-authored SQL is fenced by a savepoint and leaves no session state behind', async () => {
  // The write path: one statement, committed in a transaction of its own after the reset.
  const write = scoped('write', true);
  await write.client.query('SELECT pg_advisory_lock(1)', []);
  assert.equal(write.log.length, 3);
  assert.equal(write.log[0], `${WRITE_BEGIN}; SAVEPOINT mistri_statement`);
  assert.equal(write.log[1], 'SELECT pg_advisory_lock(1)');
  assert.match(write.log[2], RESET);
  assert.match(write.log[2], /; COMMIT$/);

  // A failure goes back to the savepoint first, so the lock it took can still be shed.
  const failing = scoped('write', true);
  failing.recorder.fail = /^SELECT 1\/0$/;
  await assert.rejects(failing.client.query('SELECT 1/0'));
  assert.match(failing.log[2], /^ROLLBACK TO SAVEPOINT mistri_statement; SET SESSION AUTHORIZATION DEFAULT/);
  assert.match(failing.log[2], /; ROLLBACK$/);

  // The read path: the adapter's own BEGIN READ ONLY, fenced statements, and the reset before its ROLLBACK.
  const read = scoped('read', true);
  await read.client.query('BEGIN READ ONLY');
  await read.client.query('SET LOCAL statement_timeout = 200');
  read.recorder.fail = /^PREPARE/;
  await assert.rejects(read.client.query({ text: 'PREPARE p AS SELECT 1', values: [], rowMode: 'array' }));
  read.recorder.fail = undefined;
  await read.client.query('ROLLBACK');
  assert.deepEqual(read.log.slice(0, 6), [
    READ_BEGIN,
    'SAVEPOINT mistri_statement',
    'SET LOCAL statement_timeout = 200',
    'SAVEPOINT mistri_statement',
    'PREPARE p AS SELECT 1',
    'ROLLBACK TO SAVEPOINT mistri_statement',
  ]);
  assert.match(read.log[6], RESET);
  assert.equal(read.log[7], 'ROLLBACK');
  assert.equal(read.log.length, 8);
});

test('a reset that fails refuses the commit it came before', async () => {
  const write = scoped('write', true);
  write.recorder.fail = /DISCARD TEMP; COMMIT$/;
  await assert.rejects(write.client.query('SET search_path = public'), /refused/);
  assert.equal(write.log.at(-1), 'ROLLBACK');
});

test('a transaction the work left open is closed when the lease settles', async () => {
  const write = scoped('write');
  await write.client.query('BEGIN');
  await write.client.settle();
  await write.client.settle();
  assert.deepEqual(write.log, [WRITE_BEGIN, 'ROLLBACK']);
  const user = scoped('write', true);
  await user.client.query('BEGIN');
  await user.client.settle();
  assert.match(user.log[1], RESET);
  assert.match(user.log[1], /; ROLLBACK$/);
  const idle = scoped('read');
  await idle.client.settle();
  assert.deepEqual(idle.log, []);
});

/** A recording client a manager leases; SELECT pg_sleep hangs until finish(). */
class LeasedClient extends EventEmitter implements PgClient {
  readonly statements: string[] = [];
  readonly releases: Array<boolean | Error | undefined> = [];
  readonly processID = 4242;
  private hung?: { resolve: () => void; reject: (error: Error) => void };

  /** The hung statement ends of its own accord. */
  finish(): void {
    this.hung?.resolve();
  }
  /** What a pg_cancel_backend does to the statement on a direct connection. */
  interrupt(): void {
    this.hung?.reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
  }

  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(request: string | { text: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
    const text = typeof request === 'string' ? request : request.text;
    this.statements.push(text);
    if (text.startsWith('SELECT pg_sleep'))
      await new Promise<void>((resolve, reject) => {
        this.hung = { resolve, reject };
      });
    return { rows: [], fields: [], rowCount: 0 };
  }

  release(destroy?: boolean | Error): void {
    this.releases.push(destroy);
  }
}

test('observed checkout guards expire on release and remove their listeners', async () => {
  const { manager, pools } = managerFixture('session');
  let escaped!: () => void;
  await manager.withObservedReadClient(async (client, current) => {
    escaped = current;
    current();
    await client.query('SELECT 1');
    current();
    assert.equal(pools[0].clients[0].listenerCount('end'), 1);
  });
  assert.throws(escaped, /unavailable/);
  assert.equal(pools[0].clients[0].listenerCount('end'), 0);
  // The guard's own listener is gone; the one every client gets as it connects stays, so no 'error' can end the process.
  assert.equal(pools[0].clients[0].listenerCount('error'), 1);
  assert.doesNotThrow(() => pools[0].clients[0].emit('error', new Error('terminating connection due to administrator command')));
  assert.deepEqual(pools[0].clients[0].releases, [false]);
  await manager.close();
});

for (const event of ['error', 'end'] as const) {
  test(`observed checkout refuses after native ${event} even when callback catches its guard`, async () => {
    const { manager, pools } = managerFixture('session');
    await assert.rejects(
      manager.withObservedReadClient(async (client, current) => {
        pools[0].clients[0].emit(event);
        assert.throws(current, /unavailable/);
        await assert.rejects(client.query('SELECT 1'), /unavailable/);
      }),
      /unavailable/,
    );
    assert.deepEqual(pools[0].clients[0].releases, [true]);
    await manager.withObservedReadClient(async (client, current) => {
      await client.query('SELECT 1');
      current();
    });
    await manager.close();
  });
}

test('a caught driver failure still invalidates the observed checkout', async () => {
  const { manager, pools } = managerFixture('session');
  await assert.rejects(
    manager.withObservedReadClient(async (client, current) => {
      const query = client.query('SELECT pg_sleep(60)');
      pools[0].clients[0].interrupt();
      await assert.rejects(query, /canceling statement/);
      assert.throws(current, /unavailable/);
    }),
    /unavailable/,
  );
  assert.deepEqual(pools[0].clients[0].releases, [true]);
  await manager.close();
});

test('observed checkout refuses clients without native event hooks before callback entry', async () => {
  const clients: LeasedClient[] = [];
  const manager = new PgConnectionManager(
    'postgres://host/db',
    undefined,
    async () => ({
      Pool: class extends LeasingPool {
        override async connect(): Promise<LeasedClient> {
          const client = await super.connect();
          Object.defineProperty(client, 'off', { value: undefined });
          clients.push(client);
          return client;
        }
      },
    }),
    { pooler: 'session', capMs: 5000 },
  );
  let called = false;
  try {
    await assert.rejects(
      manager.withObservedReadClient(async () => {
        called = true;
      }),
      /unavailable/,
    );
    assert.equal(called, false);
    assert.deepEqual(clients[0].releases, [true]);
  } finally {
    await manager.close();
  }
});

test('manager close immediately invalidates an observed checkout', async () => {
  const { manager } = managerFixture('session');
  await assert.rejects(
    manager.withObservedReadClient(async (_client, current) => {
      await manager.close();
      assert.throws(current, /closed/);
    }),
    /closed/,
  );
});

test('observed cancellation invalidates immediately but drains the callback', async () => {
  const { manager, pools, cancels } = managerFixture('transaction');
  const controller = new AbortController();
  let finish!: () => void,
    entered = false,
    settled = false;
  const pending = withCancellation(controller.signal, () =>
    manager.withObservedReadClient(async (_client, current) => {
      entered = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      assert.throws(current, (error) => error instanceof StatementStopped);
    }),
  );
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!entered) await tick();
  controller.abort();
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(pools[0].clients[0].releases, [true]);
  finish();
  await assert.rejects(pending, (error) => error instanceof StatementStopped);
  assert.equal(cancels(), 0);
  assert.deepEqual(pools[0].clients[0].releases, [true]);
  await manager.close();
});

class LeasingPool extends EventEmitter implements PgPool {
  readonly clients: LeasedClient[] = [];
  constructor(readonly options: PgPoolOptions) {
    super();
  }

  async connect(): Promise<LeasedClient> {
    const client = new LeasedClient();
    this.clients.push(client);
    await this.options.onConnect(client);
    return client;
  }

  query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
  async query(..._request: unknown[]): Promise<never> {
    throw new Error('Reads lease a client; nothing calls pool.query.');
  }

  async end(): Promise<void> {}
}

function managerFixture(pooler: 'session' | 'transaction') {
  const pools: LeasingPool[] = [];
  let cancelClients = 0;
  const module = {
    Pool: class extends LeasingPool {
      constructor(options: PgPoolOptions) {
        super(options);
        pools.push(this);
      }
    },
    /* What a pg_cancel_backend is sent from; never connected anywhere. The cancel is counted, not the Client: with
       MISTRI_SERVER_TIMING=1 the round-trip probe (serverTiming.ts) dials one of its own for its SELECT 1s. */
    Client: class {
      async connect() {}
      async query(text: string) {
        if (text.includes('pg_cancel_backend')) cancelClients += 1;
        return {};
      }
      async end() {}
      on() {}
    },
  };
  const manager = new PgConnectionManager('postgres://host/db', undefined, async () => module, { pooler, capMs: 5_000 });
  return { manager, pools, cancels: () => cancelClients };
}

test('behind a transaction-mode pooler nothing is set on the session, and every lease sets its own', async () => {
  const { manager, pools } = managerFixture('transaction');
  const read = await manager.read();
  await read.query('SELECT 1');
  await manager.withWriteClient(async (write) => {
    await write.query('BEGIN');
    await write.query('UPDATE t SET x = 1');
    await write.query('COMMIT');
  });
  assert.deepEqual(pools[0].clients[0].statements, [
    'BEGIN READ ONLY; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 5000',
    'SELECT 1',
    'COMMIT',
  ]);
  // A writer also stops waiting for a lock (writeLanes.ts), never longer than its statement may run.
  assert.deepEqual(pools[1].clients[0].statements, [
    'BEGIN; SET LOCAL statement_timeout = 5000; SET LOCAL lock_timeout = 5000',
    'UPDATE t SET x = 1',
    'COMMIT',
  ]);
  assert.deepEqual(
    pools.map((pool) => pool.clients[0].releases),
    [[false], [false]],
  );
  await manager.close();
});

test('a cancelled read behind a pooler stops waiting at once and never cancels by backend id', async () => {
  const { manager, pools, cancels } = managerFixture('transaction');
  const read = await manager.read();
  const controller = new AbortController();
  const pending = withCancellation(controller.signal, () => read.query('SELECT pg_sleep(60)'));
  while (!pools[0].clients[0]?.statements.includes('SELECT pg_sleep(60)')) await tick();
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof StatementStopped && error.reason === 'cancelled');
  assert.deepEqual(pools[0].clients[0].releases, [true]);
  await tick();
  assert.equal(cancels(), 0);
  pools[0].clients[0].finish();
  await manager.close();

  // A direct connection's backend id is the server's own, so there it is cancelled by id.
  const direct = managerFixture('session');
  const directRead = await direct.manager.read();
  const stop = new AbortController();
  const waiting = withCancellation(stop.signal, () => directRead.query('SELECT pg_sleep(60)'));
  while (!direct.pools[0].clients[0]?.statements.includes('SELECT pg_sleep(60)')) await tick();
  stop.abort();
  while (direct.cancels() === 0) await tick();
  direct.pools[0].clients[0].interrupt();
  await assert.rejects(waiting, (error) => error instanceof StatementStopped && error.reason === 'cancelled');
  assert.deepEqual(direct.pools[0].clients[0].statements.slice(0, 2), [
    'SET default_transaction_read_only = on',
    "SET statement_timeout = '5s'",
  ]);
  await direct.manager.close();
});

/* A read snapshot's BEGIN carries its prologue (PostgresAdapter.readSnapshot).
   The cap has to be in force before the prologue's LOCK can wait, so the
   settings go straight after the BEGIN, and the caller is answered with the
   BEGIN's result and the prologue's, the settings' taken out. */
test("a BEGIN with a prologue gets its settings before the prologue, and the prologue's results back", async () => {
  const sent: string[] = [];
  const raw: PgQuery = {
    query: (async (request: string) => {
      sent.push(request);
      return request.split(';').map((statement, index) => ({ rows: [{ index, statement: statement.trim() }], fields: [], rowCount: 1 }));
    }) as unknown as PgQuery['query'],
  };
  const client = transactionScoped(raw, { role: 'read', capMs: 30_000, untrusted: false });
  const answered = (await client.query(
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; LOCK TABLE "public"."t" IN ACCESS SHARE MODE; SELECT 1',
  )) as unknown as PgResult<Record<string, unknown>>[];
  assert.deepEqual(sent, [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; ' +
      'LOCK TABLE "public"."t" IN ACCESS SHARE MODE; SELECT 1',
  ]);
  assert.deepEqual(
    answered.map((result) => result.rows[0].statement),
    ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'LOCK TABLE "public"."t" IN ACCESS SHARE MODE', 'SELECT 1'],
  );
  // A BEGIN alone is answered as before: its own result, not a list.
  const alone = await transactionScoped(raw, { role: 'write', capMs: 30_000, untrusted: false }).query('BEGIN');
  assert.equal(Array.isArray(alone), false);
  assert.equal(sent.at(-1), WRITE_BEGIN);
});

/* A pipelining client (node-postgres's `pipeline`, which the App's writers and
   the authentication store use) sends what it is asked without waiting: a
   statement's own transaction leaves with it, one round trip where three were
   awaited in turn. Each part is answered on its own, as pg syncs each query. */
function pipelined(fail?: RegExp) {
  const sent: string[] = [];
  let flights = 0,
    waiting = false;
  const raw: PgQuery = {
    query: (async (request: string | { text: string }) => {
      const text = typeof request === 'string' ? request : request.text;
      sent.push(text);
      // A flight is what leaves before anything is answered.
      if (!waiting) {
        waiting = true;
        flights += 1;
        setImmediate(() => {
          waiting = false;
        });
      }
      await tick();
      if (fail?.test(text)) throw Object.assign(new Error(`refused: ${text}`), { code: 'XX000' });
      const result = { rows: [{ text }], fields: [], rowCount: 1 };
      return text.includes('; ') ? text.split('; ').map(() => result) : result;
    }) as unknown as PgQuery['query'],
  };
  return { raw, sent, flights: () => flights };
}

test('on a pipelining client a lone statement leaves with its BEGIN and COMMIT in one flight', async () => {
  for (const role of ['read', 'write'] as const) {
    const { raw, sent, flights } = pipelined();
    const client = transactionScoped(raw, { role, capMs: 30_000, untrusted: false, pipelines: true });
    const answer = (await client.query('SELECT $1::int AS n', [1])) as unknown as PgResult<{ text: string }>;
    assert.equal(answer.rows[0].text, 'SELECT $1::int AS n', 'the statement is what is answered');
    assert.deepEqual(sent, [role === 'read' ? READ_BEGIN : WRITE_BEGIN, 'SELECT $1::int AS n', 'COMMIT']);
    assert.equal(flights(), 1);
  }
  // Without the option, the three are awaited in turn, as before.
  const { raw, flights } = pipelined();
  await transactionScoped(raw, { role: 'write', capMs: 30_000, untrusted: false }).query('SELECT 1', []);
  assert.equal(flights(), 3);
});

test('a pipelined statement that fails is the one thrown, and the COMMIT behind it ends the aborted transaction', async () => {
  const failing = pipelined(/^UPDATE/);
  const client = transactionScoped(failing.raw, { role: 'write', capMs: 30_000, untrusted: false, pipelines: true });
  await assert.rejects(client.query('UPDATE t SET x = 1', []), /refused: UPDATE/);
  // PostgreSQL answers a COMMIT in an aborted transaction by rolling it back; nothing else is sent.
  assert.deepEqual(failing.sent, [WRITE_BEGIN, 'UPDATE t SET x = 1', 'COMMIT']);
  // Settings that fail: the statement behind them was refused in the aborted transaction, and the setting is thrown.
  const unset = pipelined(/^BEGIN/);
  await assert.rejects(
    transactionScoped(unset.raw, { role: 'write', capMs: 30_000, untrusted: false, pipelines: true }).query('SELECT 1', []),
    /refused: BEGIN/,
  );
  assert.deepEqual(unset.sent, [WRITE_BEGIN, 'SELECT 1', 'COMMIT']);
  // A COMMIT that fails is thrown, and the connection is not handed back mid-transaction.
  const uncommitted = pipelined(/^COMMIT$/);
  await assert.rejects(
    transactionScoped(uncommitted.raw, { role: 'write', capMs: 30_000, untrusted: false, pipelines: true }).query('SELECT 1', []),
    /refused: COMMIT/,
  );
  assert.deepEqual(uncommitted.sent, [WRITE_BEGIN, 'SELECT 1', 'COMMIT', 'ROLLBACK']);
});

test('an untrusted lease never pipelines its statement: the savepoint that fences it is awaited first', async () => {
  const { raw, sent, flights } = pipelined();
  await transactionScoped(raw, { role: 'read', capMs: 30_000, untrusted: true, pipelines: true }).query('SELECT 1', []);
  assert.equal(sent[0], `${READ_BEGIN}; SAVEPOINT mistri_statement`);
  assert.ok(flights() > 1);
});
