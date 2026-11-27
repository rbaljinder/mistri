// test-package: mistri
/**
 * Fast, deterministic proof of the Jepsen harness itself (no PostgreSQL or
 * Docker needed): verifies EDN history serialization, proves the built-in Elle
 * DSG checker catches planted G0/G1a/G1b/G1c/lost-update/G-single anomalies
 * while accepting valid snapshot-isolated histories, verifies the bank and
 * workflow checkers catch planted integrity bugs, and exercises FaultProxy's
 * real loopback TCP latency, reset, partition, and Postgres COMMIT-cut paths.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect, createServer } from 'node:net';
import { describe, test } from 'node:test';
import { ValkeyCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import { RespClient } from '../packages/engine/src/adapters/cache/resp.js';
import {
  markCleanRollback,
  PgConnectionManager,
  type PgClient,
  type PgPool,
  type PgPoolOptions,
  type PgResult,
} from '../packages/engine/src/adapters/postgresPool.js';
import { beforeCommit, RolledBackAtCommit, transactionHandle } from '../packages/engine/src/adapters/postgresTransactionHandle.js';
import {
  checkBankConservation,
  checkDdlEpoch,
  checkEventDelivery,
  checkFailover,
  checkProposalsAndLiveSync,
  checkReplicaRyw,
  checkRetryStorm,
  checkSqliteCrash,
  checkSupportLeases,
  checkTenantIsolation,
  checkValkeyCache,
  checkWorkflowFencing,
  type RetryStormCheckInput,
} from './jepsen/checkers.js';
import { checkListAppendHistory } from './jepsen/elle.js';
import { containsPostgresCommit, FaultProxy } from './jepsen/faultProxy.js';
import { formatHistoryEdn, HistoryRecorder, type ListAppendMicroOp } from './jepsen/history.js';
import { parseCliArgs } from './jepsen/run.js';

describe('Jepsen history recorder & EDN serialization', () => {
  test('emits valid Jepsen/Elle EDN for list-append micro-ops and nemesis events', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    rec.invoke(0, 'txn', [
      ['r', 'k1', null],
      ['append', 'k1', 7],
    ]);
    rec.ok(0, 'txn', [
      ['r', 'k1', [1, 2]],
      ['append', 'k1', 7],
    ]);
    rec.info('nemesis', 'arm-commit-cut', []);

    const edn = formatHistoryEdn(rec.entries());
    const lines = edn.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /:type :invoke, :process 0, :f :txn, :value \[\[:r "k1" nil\] \[:append "k1" 7\]\]/);
    assert.match(lines[1], /:type :ok, :process 0, :f :txn, :value \[\[:r "k1" \[1 2\]\] \[:append "k1" 7\]\]/);
    assert.match(lines[2], /:type :info, :process :nemesis, :f :arm-commit-cut/);
  });

  test('parses and validates CLI options strictly', () => {
    const parsed = parseCliArgs(['--workload', 'bank', '--duration', '12', '--concurrency', '4', '--no-nemesis', '--seed', '99'], {
      MISTRI_JEPSEN_PG: 'postgres://localhost/db',
    });
    assert.equal(parsed.workload, 'bank');
    assert.equal(parsed.durationSec, 12);
    assert.equal(parsed.concurrency, 4);
    assert.equal(parsed.nemesis, false);
    assert.equal(parsed.seed, 99);
    assert.equal(parsed.pgUrl, 'postgres://localhost/db');
    assert.throws(() => parseCliArgs(['--workload', 'bogus'], {}), /Invalid --workload/);
    assert.throws(() => parseCliArgs(['--concurrency', '1'], {}), /Invalid --concurrency/);
  });
});

describe('Built-in Elle list-append DSG checker', () => {
  test('accepts a valid Snapshot Isolation history (including benign write skew under SI)', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    // T0 writes k1=[1], T1 writes k2=[2] concurrently, each reading the other's old empty value (classic SI write skew, allowed under SI)
    rec.invoke(0, 'txn', [
      ['r', 'k2', null],
      ['append', 'k1', 1],
    ]);
    rec.invoke(1, 'txn', [
      ['r', 'k1', null],
      ['append', 'k2', 2],
    ]);
    rec.ok(0, 'txn', [
      ['r', 'k2', []],
      ['append', 'k1', 1],
    ]);
    rec.ok(1, 'txn', [
      ['r', 'k1', []],
      ['append', 'k2', 2],
    ]);
    // Final reader sees both
    rec.invoke(2, 'txn', [
      ['r', 'k1', null],
      ['r', 'k2', null],
    ]);
    rec.ok(2, 'txn', [
      ['r', 'k1', [1]],
      ['r', 'k2', [2]],
    ]);

    const si = checkListAppendHistory(rec.entries(), { consistency: 'snapshot-isolation' });
    assert.equal(si.valid, true, JSON.stringify(si.anomalies));

    // Under serializable, that same write-skew history has a 2-rw cycle (G2) and MUST be flagged.
    const ser = checkListAppendHistory(rec.entries(), { consistency: 'serializable' });
    assert.equal(ser.valid, false);
    assert.ok(ser.anomalies.some((a) => a.kind === 'G-SI'));
  });

  test('detects G1a (aborted read)', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    rec.invoke(0, 'txn', [['append', 'k1', 1]]);
    rec.fail(0, 'txn', [['append', 'k1', 1]], 'aborted');
    rec.invoke(1, 'txn', [['r', 'k1', null]]);
    rec.ok(1, 'txn', [['r', 'k1', [1]]]);

    const res = checkListAppendHistory(rec.entries());
    assert.equal(res.valid, false);
    assert.ok(res.anomalies.some((a) => a.kind === 'G1a'));
  });

  test('detects G1b (intermediate read)', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    rec.invoke(0, 'txn', [
      ['append', 'k1', 1],
      ['append', 'k1', 2],
    ]);
    rec.invoke(1, 'txn', [['r', 'k1', null]]);
    rec.ok(1, 'txn', [['r', 'k1', [1]]]);
    rec.ok(0, 'txn', [
      ['append', 'k1', 1],
      ['append', 'k1', 2],
    ]);

    const res = checkListAppendHistory(rec.entries());
    assert.equal(res.valid, false);
    assert.ok(res.anomalies.some((a) => a.kind === 'G1b'));
  });

  test('detects G0 (write-write cycle across two keys)', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    rec.invoke(0, 'txn', [
      ['append', 'k1', 1],
      ['append', 'k2', 1],
    ]);
    rec.invoke(1, 'txn', [
      ['append', 'k1', 2],
      ['append', 'k2', 2],
    ]);
    rec.ok(0, 'txn', [
      ['append', 'k1', 1],
      ['append', 'k2', 1],
    ]);
    rec.ok(1, 'txn', [
      ['append', 'k1', 2],
      ['append', 'k2', 2],
    ]);
    // k1 ordered T0 -> T1, while k2 ordered T1 -> T0
    rec.invoke(2, 'txn', [
      ['r', 'k1', null],
      ['r', 'k2', null],
    ]);
    rec.ok(2, 'txn', [
      ['r', 'k1', [1, 2]],
      ['r', 'k2', [2, 1]],
    ]);

    const res = checkListAppendHistory(rec.entries());
    assert.equal(res.valid, false);
    assert.ok(res.anomalies.some((a) => a.kind === 'G0'));
  });

  test('detects G-single (fractured read under Snapshot Isolation)', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    // T0 appends to k1 and k2; T1 reads k1=[] (before T0) and k2=[2] (after T0) -> T1 -rw-> T0 -wr-> T1
    rec.invoke(0, 'txn', [
      ['append', 'k1', 1],
      ['append', 'k2', 2],
    ]);
    rec.invoke(1, 'txn', [
      ['r', 'k1', null],
      ['r', 'k2', null],
    ]);
    rec.ok(0, 'txn', [
      ['append', 'k1', 1],
      ['append', 'k2', 2],
    ]);
    rec.ok(1, 'txn', [
      ['r', 'k1', []],
      ['r', 'k2', [2]],
    ]);
    // Final read establishes canonical order for k1
    rec.invoke(2, 'txn', [
      ['r', 'k1', null],
      ['r', 'k2', null],
    ]);
    rec.ok(2, 'txn', [
      ['r', 'k1', [1]],
      ['r', 'k2', [2]],
    ]);

    const res = checkListAppendHistory(rec.entries(), { consistency: 'snapshot-isolation' });
    assert.equal(res.valid, false);
    assert.ok(res.anomalies.some((a) => a.kind === 'G-single'));
  });

  test('detects lost updates and forked list versions', () => {
    const rec = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    rec.invoke(0, 'txn', [['append', 'k1', 1]]);
    rec.ok(0, 'txn', [['append', 'k1', 1]]);
    rec.invoke(1, 'txn', [['r', 'k1', null]]);
    rec.ok(1, 'txn', [['r', 'k1', []]]);

    const res = checkListAppendHistory(rec.entries());
    assert.equal(res.valid, false);
    assert.ok(res.anomalies.some((a) => a.kind === 'lost-update'));
  });
});

describe('Domain checkers (bank conservation & workflow fencing)', () => {
  test('checkBankConservation passes on valid replayed/recovered history and flags planted violations', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.invoke(0, 'transfer', { idempotencyKey: 'k1', from: 1, to: 2, amount: 50 });
    rec.info(0, 'transfer', { idempotencyKey: 'k1', from: 1, to: 2, amount: 50, outcome: 'unknown' }, 'temporarily_unavailable');
    rec.invoke(0, 'recover', { idempotencyKey: 'k1', from: 1, to: 2, amount: 50 });
    rec.ok(0, 'recover', {
      idempotencyKey: 'k1',
      from: 1,
      to: 2,
      amount: 50,
      receiptId: 'rcpt-1',
      recovered: true,
      fromBalance: 950,
      toBalance: 1050,
    });
    rec.invoke(1, 'read', {});
    rec.ok(1, 'read', { balances: { '1': 950, '2': 1050 }, total: 2000 });

    const clean = checkBankConservation(rec.entries(), {
      initialBalances: { '1': 1000, '2': 1000 },
      finalBalances: { '1': 950, '2': 1050 },
      ledgerEntries: [{ idempotencyKey: 'k1', from: 1, to: 2, amount: 50 }],
      receiptKeys: ['k1'],
      eventKeys: ['k1'],
    });
    assert.equal(clean.valid, true, JSON.stringify(clean.violations));

    // Planted bug: missing outbox event + balance drift
    const broken = checkBankConservation(rec.entries(), {
      initialBalances: { '1': 1000, '2': 1000 },
      finalBalances: { '1': 900, '2': 1050 },
      ledgerEntries: [{ idempotencyKey: 'k1', from: 1, to: 2, amount: 50 }],
      receiptKeys: ['k1'],
      eventKeys: [],
    });
    assert.equal(broken.valid, false);
    const codes = new Set(broken.violations.map((v) => v.code));
    assert.ok(codes.has('conservation_mismatch'));
    assert.ok(codes.has('ledger_balance_divergence'));
    assert.ok(codes.has('missing_event'));
  });

  test('checkWorkflowFencing flags duplicate side effects and incomplete workflows', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.ok(0, 'advance', { instanceId: 'wf-1', status: 'overtaken' });
    rec.ok(1, 'advance', { instanceId: 'wf-1', status: 'completed' });

    const ok = checkWorkflowFencing({
      expectedWorkflows: ['wf-1'],
      expectedStepsPerWorkflow: ['step-a', 'step-b'],
      finalStatuses: { 'wf-1': 'completed' },
      sideEffectExecutions: { 'wf-1:step-a': 1, 'wf-1:step-b': 1 },
      history: rec.entries(),
    });
    assert.equal(ok.valid, true);
    assert.equal(ok.summary.overtakenAdvances, 1);

    const bad = checkWorkflowFencing({
      expectedWorkflows: ['wf-1'],
      expectedStepsPerWorkflow: ['step-a', 'step-b'],
      finalStatuses: { 'wf-1': 'waiting' },
      sideEffectExecutions: { 'wf-1:step-a': 2, 'wf-1:step-b': 0 },
      history: rec.entries(),
    });
    assert.equal(bad.valid, false);
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('workflow_not_completed'));
    assert.ok(codes.has('duplicate_step_effect'));
    assert.ok(codes.has('missing_step_effect'));
  });

  test('checkEventDelivery accepts deduplicated retries and flags lost, phantom, or unstable-key events', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.info('nemesis', 'clock-regress', { host: 'pub-b', offsetMs: -5000 });

    const ok = checkEventDelivery({
      committedKeys: ['ev-1', 'ev-2'],
      deliveries: [
        { eventKey: 'ev-1', idempotencyKey: 'idem-1', publisher: 'pub-a' },
        { eventKey: 'ev-1', idempotencyKey: 'idem-1', publisher: 'pub-b' },
        { eventKey: 'ev-2', idempotencyKey: 'idem-2', publisher: 'pub-b' },
      ],
      history: rec.entries(),
    });
    assert.equal(ok.valid, true);
    assert.equal(ok.summary.deduplicatedRetries, 1);
    assert.equal(ok.summary.clockRegressionsInjected, 1);

    const bad = checkEventDelivery({
      committedKeys: ['ev-1', 'ev-2'],
      deliveries: [
        { eventKey: 'ev-1', idempotencyKey: 'idem-1a', publisher: 'pub-a' },
        { eventKey: 'ev-1', idempotencyKey: 'idem-1b', publisher: 'pub-b' },
        { eventKey: 'ev-ghost', idempotencyKey: 'idem-ghost', publisher: 'pub-a' },
      ],
      history: rec.entries(),
    });
    assert.equal(bad.valid, false);
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('lost_event'));
    assert.ok(codes.has('phantom_event_delivered'));
    assert.ok(codes.has('unstable_idempotency_key'));
  });

  test('checkReplicaRyw verifies monotonic RYW and flags stale reads or unused replica', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.ok(0, 'write', { slotId: 1, val: 5, caller: 'w0' });
    rec.ok(0, 'ryw-read', { slotId: 1, expectedMin: 5, observed: 5, caller: 'w0' });
    rec.ok(1, 'lag-read', { slotId: 1, observed: 4, partitioned: false });

    const ok = checkReplicaRyw({ history: rec.entries(), replicaCheckouts: 12, fallbackReadsSucceeded: 3 });
    assert.equal(ok.valid, true);

    rec.ok(0, 'ryw-read', { slotId: 1, expectedMin: 6, observed: 4, caller: 'w0' });
    const bad = checkReplicaRyw({ history: rec.entries(), replicaCheckouts: 0, fallbackReadsSucceeded: 0 });
    assert.equal(bad.valid, false);
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('ryw_stale_read'));
    assert.ok(codes.has('replica_never_used'));
  });

  test('checkTenantIsolation detects cross-tenant reads, cross-tenant writes, and false-negative rollbacks', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.ok(0, 'scoped-read', { tenant: 'alpha', observedTenants: ['alpha', 'alpha'], rowCount: 2 });
    rec.ok(0, 'scoped-write', { tenant: 'alpha', seq: 1, outcome: 'applied' });

    const ok = checkTenantIsolation({
      tenants: ['alpha', 'beta'],
      history: rec.entries(),
      finalRows: [{ id: 1, tenant: 'alpha', writerTenant: 'alpha', seq: 1 }],
    });
    assert.equal(ok.valid, true);

    rec.ok(1, 'scoped-read', { tenant: 'alpha', observedTenants: ['alpha', 'beta'], rowCount: 2 });
    rec.fail(2, 'scoped-write', { tenant: 'beta', seq: 1, outcome: 'not_applied' }, '40001');
    const bad = checkTenantIsolation({
      tenants: ['alpha', 'beta'],
      history: rec.entries(),
      finalRows: [
        { id: 1, tenant: 'alpha', writerTenant: 'alpha', seq: 1 },
        { id: 2, tenant: 'alpha', writerTenant: 'beta', seq: 1 },
      ],
    });
    assert.equal(bad.valid, false);
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('cross_tenant_read'));
    assert.ok(codes.has('cross_tenant_write'));
    assert.ok(codes.has('false_negative_scoped_write'));
  });
});

describe('FaultProxy TCP & Postgres COMMIT wire interception', () => {
  function pgSimpleQueryFrame(sql: string): Buffer {
    const payload = Buffer.from(`${sql}\0`, 'utf8');
    const frame = Buffer.alloc(1 + 4 + payload.length);
    frame[0] = 0x51; // 'Q'
    frame.writeInt32BE(4 + payload.length, 1);
    payload.copy(frame, 5);
    return frame;
  }

  test('detects Postgres v3 COMMIT frames and ignores ordinary SELECT frames', () => {
    assert.equal(containsPostgresCommit(pgSimpleQueryFrame('COMMIT')), true);
    assert.equal(containsPostgresCommit(pgSimpleQueryFrame('SELECT 1')), false);
  });

  test('forwards COMMIT to upstream and cuts the client socket before delivering the reply', async (t) => {
    const upstreamReceived: Buffer[] = [];
    const upstream = createServer((socket) => {
      socket.on('data', (chunk) => {
        upstreamReceived.push(chunk);
        // Simulate Postgres CommandComplete reply
        socket.write(Buffer.from('C\0\0\0\x0bCOMMIT\0'));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = new FaultProxy('127.0.0.1', upstreamPort);
    const proxyPort = await proxy.start();

    t.after(async () => {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    proxy.armCommitCut(1);
    const client = connect({ host: '127.0.0.1', port: proxyPort });
    let clientReceivedBytes = 0;
    const closed = new Promise<void>((resolve) => {
      client.on('data', (chunk) => {
        clientReceivedBytes += chunk.length;
      });
      client.on('close', () => resolve());
      client.on('error', () => {});
    });

    await new Promise<void>((resolve) => client.once('connect', resolve));
    client.write(pgSimpleQueryFrame('COMMIT'));
    await closed;

    assert.equal(upstreamReceived.length, 1, 'COMMIT must reach upstream PostgreSQL');
    assert.equal(clientReceivedBytes, 0, 'COMMIT reply must be dropped before reaching the client');
    assert.equal(proxy.stats().commitCuts, 1);
  });

  test('drops connections during partition and restores forwarding cleanly after heal', async (t) => {
    const upstream = createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = new FaultProxy('127.0.0.1', upstreamPort);
    const proxyPort = await proxy.start();
    t.after(async () => {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    // Partition drops new connections immediately.
    proxy.setPartition(true);
    const dropped = connect({ host: '127.0.0.1', port: proxyPort });
    await new Promise<void>((resolve) => {
      dropped.on('close', () => resolve());
      dropped.on('error', () => {});
    });
    assert.ok(proxy.stats().partitionDrops >= 1);

    // After heal, latency-delayed echo works in order.
    proxy.heal();
    proxy.setLatency(10, 0);
    const client = connect({ host: '127.0.0.1', port: proxyPort });
    await new Promise<void>((resolve) => client.once('connect', resolve));
    const echoed = await new Promise<string>((resolve) => {
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length >= 6) resolve(buf);
      });
      client.write('abc');
      client.write('def');
    });
    client.destroy();
    assert.equal(echoed, 'abcdef');
  });
});

describe('postgresTransactionHandle beforeCommit outcome classification', () => {
  async function withPipeliningHandle(
    handler: (sql: string) => Promise<PgResult<Record<string, unknown>>>,
    run: (handle: ReturnType<typeof transactionHandle>) => Promise<void>,
  ): Promise<void> {
    class FakeClient implements PgClient {
      readonly pipeline = true;
      query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
      query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
      query(request: string | { text: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
        const sql = typeof request === 'string' ? request : request.text;
        if (sql.startsWith('SET ')) return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
        return handler(sql);
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
      async query(request: string | { text: string }): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
        return (await this.connect()).query(request as string);
      }
      async end(): Promise<void> {}
    }
    const manager = new PgConnectionManager('postgres://host/db', undefined, async () => ({ Pool: FakePool }));
    try {
      await manager.withWriteClient((leased) => run(transactionHandle(leased)));
    } finally {
      await manager.close();
    }
  }

  test('does NOT throw RolledBackAtCommit when a connection drop rejects both pipelined writes and COMMIT', async () => {
    const disconnect = new Error('Connection terminated unexpectedly');
    let rejectBefore!: (err: Error) => void;
    let rejectCommit!: (err: Error) => void;
    await withPipeliningHandle(
      (sql) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
        if (sql === 'COMMIT')
          return new Promise((_, reject) => {
            rejectCommit = reject;
          });
        return new Promise((_, reject) => {
          rejectBefore = reject;
        });
      },
      async (handle) => {
        await handle.query('BEGIN');
        assert.equal(beforeCommit(handle, ['INSERT INTO receipt VALUES (1)']), true);
        const pendingCommit = handle.query('COMMIT');
        await new Promise((resolve) => setImmediate(resolve));
        // Simulate TCP socket drop after COMMIT left: driver rejects all in-flight queries.
        rejectBefore(disconnect);
        rejectCommit(disconnect);

        const err = await pendingCommit.then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.ok(err instanceof Error);
        assert.equal(err instanceof RolledBackAtCommit, false, 'mid-COMMIT disconnect must keep outcome unknown, not RolledBackAtCommit');
      },
    );
  });

  test('throws RolledBackAtCommit when a pipelined write fails and Postgres answers COMMIT as ROLLBACK', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    await withPipeliningHandle(
      async (sql) => {
        if (sql === 'BEGIN') return { rows: [], fields: [], rowCount: 0 };
        if (sql === 'COMMIT') return { rows: [], fields: [], rowCount: 0, command: 'ROLLBACK' } as PgResult<Record<string, unknown>>;
        throw dup;
      },
      async (handle) => {
        await handle.query('BEGIN');
        assert.equal(beforeCommit(handle, ['INSERT INTO receipt VALUES (1)']), true);
        const err = await handle.query('COMMIT').then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.ok(err instanceof RolledBackAtCommit);
        assert.equal(err.cause, dup);
      },
    );
  });
});

describe('Expanded Jepsen invariant checkers & CLI options', () => {
  test('parseCliArgs supports --pgbouncer-pg, --valkey, and all expanded workloads', () => {
    const parsed = parseCliArgs([
      '--workload',
      'http-cluster',
      '--pg',
      'postgres://u:p@127.0.0.1:15432/db',
      '--replica-pg',
      'postgres://u:p@127.0.0.1:15433/db',
      '--pgbouncer-pg',
      'postgres://u:p@127.0.0.1:16432/db',
      '--valkey',
      'valkey://127.0.0.1:16379/0',
      '--duration',
      '5',
      '--concurrency',
      '4',
      '--seed',
      '42',
    ]);
    assert.equal(parsed.workload, 'http-cluster');
    assert.equal(parsed.pgbouncerPgUrl, 'postgres://u:p@127.0.0.1:16432/db');
    assert.equal(parsed.valkeyUrl, 'valkey://127.0.0.1:16379/0');
  });

  test('checkDdlEpoch catches constraint violations, lost ok writes, and false-negative rollbacks', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.ok(0, 'ddl-write', { id: 1, tenant: 'north', amount: 50, outcome: 'applied' });
    const good = checkDdlEpoch({
      history: rec.entries(),
      finalRows: [{ id: 1, tenant: 'north', amount: 50 }],
      ddlStepsExecuted: 3,
    });
    assert.equal(good.valid, true);

    rec.ok(1, 'ddl-write', { id: 2, tenant: 'north', amount: 25, outcome: 'applied' });
    rec.fail(2, 'ddl-write', { id: 3, tenant: 'south', amount: 10, outcome: 'not_applied' }, '40001');
    const bad = checkDdlEpoch({
      history: rec.entries(),
      finalRows: [
        { id: 1, tenant: 'south', amount: -5 },
        { id: 3, tenant: 'south', amount: 10 },
      ],
      ddlStepsExecuted: 0,
    });
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('constraint_violated_during_ddl'));
    assert.ok(codes.has('cross_tenant_ddl_write'));
    assert.ok(codes.has('acknowledged_ddl_write_lost'));
    assert.ok(codes.has('false_negative_ddl_write'));
    assert.ok(codes.has('no_ddl_executed'));
  });

  test('checkValkeyCache catches cross-tenant cache bleed and stale post-heal reads', () => {
    const rec = new HistoryRecorder<unknown>();
    rec.ok(0, 'cache-write', { tenant: 'alpha', version: 2 });
    rec.ok(0, 'cache-read', { tenant: 'alpha', observedTenant: 'alpha', observedVersion: 2, expectedMinVersion: 2, postHeal: true });
    assert.equal(
      checkValkeyCache({ history: rec.entries(), partitionDegradedReads: 4, incrUnavailableErrors: 2, postHealFreshChecks: 1 }).valid,
      true,
    );

    rec.ok(1, 'cache-read', { tenant: 'alpha', observedTenant: 'beta', observedVersion: 1, expectedMinVersion: 3, postHeal: true });
    const bad = checkValkeyCache({ history: rec.entries(), partitionDegradedReads: 4, incrUnavailableErrors: 2, postHealFreshChecks: 1 });
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('cross_tenant_cache_bleed'));
    assert.ok(codes.has('stale_cache_after_heal'));
  });

  test('checkProposalsAndLiveSync catches double-applies, dismissed executions, and rollback notifies', () => {
    assert.equal(
      checkProposalsAndLiveSync({
        proposalIds: ['p1', 'p2'],
        appliedCountByProposal: { p1: 1, p2: 0 },
        finalStateByProposal: { p1: 'approved', p2: 'dismissed' },
        committedWakeCount: 4,
        observedWakeCount: 3,
        rollbackWakeCount: 0,
      }).valid,
      true,
    );

    const bad = checkProposalsAndLiveSync({
      proposalIds: ['p1', 'p2', 'p3'],
      appliedCountByProposal: { p1: 2, p2: 1, p3: 0 },
      finalStateByProposal: { p1: 'approved', p2: 'dismissed', p3: 'approved' },
      committedWakeCount: 4,
      observedWakeCount: 0,
      rollbackWakeCount: 1,
    });
    const codes = new Set(bad.violations.map((v) => v.code));
    assert.ok(codes.has('proposal_double_applied'));
    assert.ok(codes.has('dismissed_proposal_executed'));
    assert.ok(codes.has('approved_proposal_missing_effect'));
    assert.ok(codes.has('rollback_triggered_notify'));
    assert.ok(codes.has('lost_all_wakeups'));
  });

  test('checkSqliteCrash, checkFailover, and checkSupportLeases flag planted integrity faults', () => {
    assert.equal(
      checkSqliteCrash({
        integrityCheck: 'ok',
        initialTotal: 6000,
        finalTotal: 6000,
        minBalance: 500,
        appliedTransfers: 10,
        killsInjected: 4,
        undoEntriesPersisted: 3,
      }).valid,
      true,
    );
    const badSqlite = checkSqliteCrash({
      integrityCheck: 'corrupt page 7',
      initialTotal: 6000,
      finalTotal: 5990,
      minBalance: -10,
      appliedTransfers: 0,
      killsInjected: 4,
      undoEntriesPersisted: 0,
    });
    assert.equal(badSqlite.valid, false);
    assert.equal(badSqlite.violations.length, 4);

    assert.equal(
      checkFailover({
        readOnlyRejections: 3,
        postFailoverWritesOk: 5,
        initialTotal: 4000,
        finalTotal: 4000,
        falseAppliedOnReadOnly: 0,
      }).valid,
      true,
    );
    const badFailover = checkFailover({
      readOnlyRejections: 0,
      postFailoverWritesOk: 0,
      initialTotal: 4000,
      finalTotal: 3995,
      falseAppliedOnReadOnly: 1,
    });
    assert.equal(badFailover.valid, false);
    assert.equal(badFailover.violations.length, 4);

    assert.equal(
      checkSupportLeases({
        openSucceeded: 5,
        exitSucceeded: 2,
        maxActiveObserved: 1,
        finalActiveAfterRevoke: 0,
        postRevokeOpenSucceeded: 0,
        auditChainFailedCount: 0,
        auditSessionsCount: 5,
      }).valid,
      true,
    );
    const badSupport = checkSupportLeases({
      openSucceeded: 0,
      exitSucceeded: 0,
      maxActiveObserved: 2,
      finalActiveAfterRevoke: 1,
      postRevokeOpenSucceeded: 1,
      auditChainFailedCount: 2,
      auditSessionsCount: 2,
    });
    assert.equal(badSupport.valid, false);
    assert.equal(badSupport.violations.length, 5);
  });
});

describe('RespClient per-connection reply queue isolation', () => {
  test('stale socket disconnect between connected() and write() never desyncs replies on the next connection', async (t) => {
    let connCount = 0;
    const server = createServer((socket) => {
      connCount++;
      const thisConn = connCount;
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (thisConn === 1 && buf.includes('GET')) {
          // Drop first connection mid-flight without replying.
          socket.destroy();
          return;
        }
        // On the reconnected socket, echo back the requested key name as a RESP bulk string.
        const match = /\$(\d+)\r\n([^\r\n]+)\r\n$/.exec(buf);
        if (match) {
          buf = '';
          const key = match[2];
          socket.write(`$${Buffer.byteLength(key)}\r\n${key}\r\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const resp = new RespClient({
      host: '127.0.0.1',
      port,
      tls: false,
      policy: { allowPrivate: true, allowLinkLocal: false },
      retryAfterMs: 20,
      commandTimeoutMs: 500,
    });
    const store = new ValkeyCacheStore(resp, () => {});
    t.after(async () => {
      await store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // Fire concurrent reads on connection 1 which abruptly disconnects mid-flight.
    const firstWave = await Promise.all([store.get('tenant:alpha'), store.get('tenant:beta'), store.get('tenant:gamma')]);
    assert.deepEqual(firstWave, [undefined, undefined, undefined]);

    // Wait past retryAfterMs and verify every tenant receives its own exact key on connection 2 (zero shifted replies).
    await new Promise((resolve) => setTimeout(resolve, 40));
    const alpha = await store.get('tenant:alpha');
    const beta = await store.get('tenant:beta');
    assert.equal(alpha, 'tenant:alpha');
    assert.equal(beta, 'tenant:beta');
  });
});

describe('PgConnectionManager clean-rollback pool reuse', () => {
  test('returns healthy write client to pool after markCleanRollback and destroys on unmarked failures', async (t) => {
    const releases: Array<boolean | Error | undefined> = [];
    const manager = new PgConnectionManager(
      'postgres://u:p@127.0.0.1:5432/clean_rollback_test',
      () => {},
      async () => ({
        Pool: class FakePool extends EventEmitter implements PgPool {
          constructor(_options: PgPoolOptions) {
            super();
          }
          async connect(): Promise<PgClient> {
            return Object.assign(new EventEmitter(), {
              async query() {
                return { rows: [], fields: [], rowCount: 0 } as PgResult<Record<string, unknown>>;
              },
              release(destroy?: boolean | Error) {
                releases.push(destroy);
              },
            }) as unknown as PgClient;
          }
          query = (async () => ({ rows: [], fields: [], rowCount: 0 })) as unknown as PgPool['query'];
          async end() {}
        },
      }),
    );
    t.after(() => manager.close());

    // Cleanly rolled-back business refusal (e.g. 409 stale_record) reuses the idle socket.
    await assert.rejects(
      manager.withWriteClient(async (client) => {
        markCleanRollback(client);
        throw new Error('stale_record');
      }),
      /stale_record/,
    );
    assert.equal(releases.at(-1), false, 'cleanly rolled-back write must return client with destroy=false');

    // Unmarked failure (e.g. transport drop or unacknowledged ROLLBACK) destroys the socket.
    await assert.rejects(
      manager.withWriteClient(async () => {
        throw new Error('ECONNRESET');
      }),
      /ECONNRESET/,
    );
    assert.equal(releases.at(-1), true, 'unmarked failure must destroy client');

    // destroyAfter=true always destroys even if markCleanRollback was called.
    await assert.rejects(
      manager.withWriteClient(async (client) => {
        markCleanRollback(client);
        throw new Error('sql_tool_error');
      }, true),
      /sql_tool_error/,
    );
    assert.equal(releases.at(-1), true, 'destroyAfter=true must still destroy client');
  });
});

describe('Retry-storm Jepsen checker', () => {
  const cleanSummary: RetryStormCheckInput = {
    unclaimedDownstreamFailures: 4,
    unclaimedAmplifications: 0,
    stormRequestsSent: 40,
    stormDownstreamAttempts: 48,
    stormMaxAllowedAttempts: 52,
    nestedOuterCalls: 4,
    maxNestedInnerAttempts: 1,
    coalescedUniqueKeys: 8,
    coalescedTotalRequests: 32,
    maxHandlerExecutionsPerKey: 1,
    conflictRacesAttempted: 8,
    conflictRacesSucceeded: 0,
    freshRequestsAdmitted: 12,
    retryRequestsShed: 12,
    abortedWaitersWithdrawn: 24,
    leakedAdmissionSlots: 0,
    replicaSpilloversSuppressed: 10,
    replicaSpilloversDuringSaturation: 0,
    publisherCooldownPauses: 6,
    publisherCooldownBreaches: 0,
    maxConcurrentHalfOpenProbes: 1,
    maxConcurrentAnthropicAsks: 4,
    exhaustedRefusalsChecked: 20,
    exhaustedRefusalsClaimed: 0,
    postHealRecoveriesOk: 4,
    postHealRecoveriesFailed: 0,
  };

  test('accepts a clean retry-storm chaos run and parses --workload retry-storm', () => {
    const cli = parseCliArgs(['--workload', 'retry-storm', '--duration', '4', '--concurrency', '4'], {});
    assert.equal(cli.workload, 'retry-storm');

    const history = new HistoryRecorder<unknown>();
    history.invoke(5, 'workflow-unclaimed', { id: 'u-1' });
    history.ok(5, 'workflow-unclaimed', { id: 'u-1', attempts: 1 });
    const res = checkRetryStorm(history.entries(), cleanSummary);
    assert.equal(res.valid, true, JSON.stringify(res.violations));
  });

  test('catches every planted retry-storm invariant violation', () => {
    const cases: readonly [Partial<RetryStormCheckInput>, string][] = [
      [{ unclaimedAmplifications: 1 }, 'error_ownership_amplified'],
      [{ exhaustedRefusalsClaimed: 1 }, 'exhausted_refusal_not_unclaimed'],
      [{ stormDownstreamAttempts: 120 }, 'retry_budget_breached'],
      [{ maxNestedInnerAttempts: 3 }, 'nested_retry_multiplication'],
      [{ maxHandlerExecutionsPerKey: 2 }, 'coalescing_duplicate_execution'],
      [{ conflictRacesSucceeded: 1 }, 'coalescing_conflict_missed'],
      [{ leakedAdmissionSlots: 1 }, 'aborted_waiter_leaked_slot'],
      [{ replicaSpilloversDuringSaturation: 1 }, 'replica_spillover_during_saturation'],
      [{ publisherCooldownBreaches: 1 }, 'publisher_cooldown_breached'],
      [{ maxConcurrentHalfOpenProbes: 2 }, 'half_open_probe_stampede'],
      [{ maxConcurrentAnthropicAsks: 6 }, 'anthropic_fanout_unbounded'],
      [{ postHealRecoveriesFailed: 1 }, 'metastable_recovery_failed'],
    ];
    for (const [override, expectedCode] of cases) {
      const res = checkRetryStorm([], { ...cleanSummary, ...override });
      assert.equal(res.valid, false, `expected planted bug ${expectedCode} to fail`);
      assert.ok(
        res.violations.some((v) => v.code === expectedCode),
        `expected violation ${expectedCode}, got ${JSON.stringify(res.violations)}`,
      );
    }

    // Also catches an unclaimed workflow retry recorded only in the EDN history.
    const badHistory = new HistoryRecorder<unknown>();
    badHistory.ok(5, 'workflow-unclaimed', { id: 'u-bad', attempts: 3 });
    const historyCheck = checkRetryStorm(badHistory.entries(), cleanSummary);
    assert.equal(historyCheck.valid, false);
    assert.ok(historyCheck.violations.some((v) => v.code === 'error_ownership_amplified'));
  });
});
