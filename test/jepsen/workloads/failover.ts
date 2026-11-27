/**
 * Jepsen PostgreSQL Read-Only Failover (`25006`) & Recovery workload.
 *
 * Exercises what happens during a primary demotion / split-brain VIP switch:
 *  - Mistri executes business commands (`transfer`) through a `FaultProxy`.
 *  - Phase 1: normal writes commit on the writable primary.
 *  - Phase 2 (nemesis failover fault): `FaultProxy` switches upstream to the
 *    read-only streaming standby (`--replica-pg`, which rejects writes with
 *    PostgreSQL SQLSTATE `25006` `read_only_sql_transaction`) — or, when no
 *    replica URL is given, toggles `ALTER DATABASE ... SET default_transaction_read_only = on`
 *    and resets pooled sockets so new connections hit `25006`.
 *  - Phase 3 (recovery): `FaultProxy` switches back to the writable primary
 *    and resets sockets; Mistri must recover cleanly with zero manual restart,
 *    zero false-applied writes during the read-only window, and exact balance
 *    conservation.
 */
import { join } from 'node:path';
import { Registry } from '../../../packages/engine/src/server/connections.js';
import { migratePostgresCommandJournal } from '../../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadAppRuntimeResources } from '../../../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../../../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  refuse,
} from '../../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../../../packages/mistri/src/server/commands/businessCommands.js';
import { int, shape } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { checkFailover, type FailoverCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface FailoverWorkloadOptions {
  readonly pgUrl: string;
  readonly replicaPgUrl?: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface FailoverWorkloadReport {
  readonly workload: 'failover';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly usedStreamingReplica: boolean;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: FailoverCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-failover';
const SOURCE_ID = 'bank';
const CONNECTION_ID = 'jepsen-failover-pg';
const ACTOR: BusinessCommandActor = { id: 'failover-teller', appId: APP_ID, roles: ['teller'] };

const commands = defineCommands({
  transfer: defineCommand({
    source: SOURCE_ID,
    target: 'account',
    read: ['account'],
    write: ['account'],
    snapshot: true,
    input: {
      toAccountId: { label: 'To', type: 'number' },
      amount: { label: 'Amount', type: 'number' },
    },
    output: shape({ fromId: int(), toId: int(), amount: int() }),
    async handle({ db, record }, input) {
      const fromId = Number(record.id);
      const toId = Number(input.toAccountId);
      const amount = Number(input.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0 || fromId === toId) refuse('invalid_input');
      const toRow = await db.account.find({ id: toId });
      if (!toRow) refuse('not_found');
      const fromBal = Number(record.balance);
      if (fromBal < amount) refuse('ineligible_state');
      await db.account.update(record, { balance: fromBal - amount });
      await db.account.update(toRow, { balance: Number(toRow.balance) + amount });
      return { fromId, toId, amount };
    },
  }),
});

function isReadOnlyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '25006') return true;
    if (typeof e.message === 'string' && /read-only|25006|cannot execute .* in a read-only/i.test(e.message)) return true;
    cur = e.cause;
  }
  return false;
}

export async function runFailoverWorkload(options: FailoverWorkloadOptions): Promise<FailoverWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const accountCount = 4;
  const initialBalance = 1_000;
  const initialTotal = accountCount * initialBalance;

  return withIsolatedPostgresDb(options.pgUrl, 'failover', async ({ dbUrl, dbName, control }) => {
    await control.query(`
      CREATE TABLE public.account (
        id integer PRIMARY KEY,
        version integer NOT NULL DEFAULT 0,
        balance integer NOT NULL CHECK (balance >= 0)
      );
    `);
    for (let id = 1; id <= accountCount; id++) {
      await control.query('INSERT INTO public.account (id, version, balance) VALUES ($1, 0, $2)', [id, initialBalance]);
    }
    await migratePostgresCommandJournal(dbUrl);

    const primaryParsed = new URL(dbUrl);
    const primaryHost = primaryParsed.hostname || '127.0.0.1';
    const primaryPort = Number(primaryParsed.port || 5432);

    const usedStreamingReplica = Boolean(options.replicaPgUrl);
    const replicaParsed = options.replicaPgUrl ? new URL(options.replicaPgUrl) : undefined;
    const replicaHost = replicaParsed?.hostname || primaryHost;
    const replicaPort = Number(replicaParsed?.port || primaryPort);

    // Wait briefly so the newly created database & tables replicate to the standby before we ever switch to it.
    if (usedStreamingReplica) await sleep(400);

    const proxy = new FaultProxy(primaryHost, primaryPort);
    await proxy.start();

    const app = parseAppConfig(
      {
        id: APP_ID,
        name: 'Jepsen Failover',
        sources: { [SOURCE_ID]: { connection: CONNECTION_ID } },
        resources: { account: { physical: 'public.account', access: 'write' } },
        auth: { roles: { teller: { read: true, commands: ['transfer'] } } },
        views: { accounts: { kind: 'list', from: 'account' } },
        home: 'accounts',
      },
      'jepsen failover app',
    );

    const registry = new Registry();
    registry.add({ id: CONNECTION_ID, name: 'Failover', url: proxy.proxiedUrl(dbUrl), writable: true, source: 'config' });

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;
    let inReadOnlyWindow = false;
    let readOnlyRejections = 0;
    let falseAppliedOnReadOnly = 0;
    let postFailoverWritesOk = 0;
    let inRecoveryPhase = false;
    let keySeq = 0;

    try {
      const resources = await loadAppRuntimeResources(registry, app, CONNECTION_ID);
      const binding = bindBusinessCommands({
        app,
        registry: commands,
        resources,
        writableConnection: () => true,
      });

      const readVersion = async (accountId: number): Promise<number> => {
        const opened = await registry.open(CONNECTION_ID);
        const res = await opened.adapter.query({
          table: 'public.account',
          filter: { groups: [[{ column: 'id', op: '=', value: accountId }]] },
          limit: 1,
          offset: 0,
        });
        return Number(res.rows[0]?.version ?? 0);
      };

      const attemptTransfer = async (proc: number) => {
        const from = rng.int(1, accountCount + 1);
        let to = rng.int(1, accountCount + 1);
        while (to === from) to = rng.int(1, accountCount + 1);
        const amount = rng.int(1, 26);
        const idempotencyKey = `jepsen-failover-${options.seed}-${String(++keySeq).padStart(6, '0')}`;
        const wasReadOnly = inReadOnlyWindow;
        const wasRecovery = inRecoveryPhase;

        history.invoke(proc, 'failover-transfer', { idempotencyKey, from, to, amount, readOnlyWindow: wasReadOnly });
        try {
          const expectedVersion = await readVersion(from);
          const result = await executeBusinessCommand(binding, ACTOR, {
            command: 'transfer',
            commandVersion: 1,
            key: { id: from },
            expectedVersion,
            idempotencyKey,
            input: { toAccountId: to, amount },
          });
          if (result.status === 'applied') {
            if (wasReadOnly && inReadOnlyWindow) falseAppliedOnReadOnly++;
            if (wasRecovery) postFailoverWritesOk++;
            history.ok(proc, 'failover-transfer', { idempotencyKey, outcome: 'applied', readOnlyWindow: wasReadOnly });
          } else {
            history.fail(proc, 'failover-transfer', { idempotencyKey, outcome: result.status });
          }
        } catch (error) {
          if (isReadOnlyError(error)) {
            readOnlyRejections++;
            history.fail(proc, 'failover-transfer', { idempotencyKey, code: '25006' });
          } else if (error instanceof BusinessCommandExecutionError) {
            if (isReadOnlyError(error.cause)) readOnlyRejections++;
            history.fail(proc, 'failover-transfer', { idempotencyKey, code: error.code });
          } else {
            history.info(proc, 'failover-transfer', {
              idempotencyKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };

      const totalMs = Math.max(3_000, options.durationSec * 1_000);
      const phase1End = Date.now() + Math.floor(totalMs * 0.25);
      const readOnlyEnd = Date.now() + Math.floor(totalMs * 0.6);
      const stopAt = Date.now() + totalMs;

      const nemesisTask = async () => {
        // Phase 1: healthy primary writes.
        while (Date.now() < phase1End) await sleep(50);

        // Phase 2: switch writer to read-only standby (or read-only database mode).
        nemesisEvents++;
        inReadOnlyWindow = true;
        history.info('nemesis', 'enter-readonly', { mode: usedStreamingReplica ? 'streaming-replica' : 'database-readonly' });
        if (usedStreamingReplica) {
          proxy.setUpstream(replicaHost, replicaPort, true);
        } else {
          await control.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = on`);
          proxy.resetConnections();
        }

        while (Date.now() < readOnlyEnd) {
          // Verify the proxied upstream actually rejects writes with PostgreSQL SQLSTATE 25006.
          try {
            const opened = await registry.open(CONNECTION_ID);
            await opened.adapter.update!({ table: 'public.account', key: { id: 1 }, values: { balance: 1_000 } });
            falseAppliedOnReadOnly++;
          } catch (error) {
            if (isReadOnlyError(error)) readOnlyRejections++;
          }
          await sleep(200);
          if (options.nemesis && readOnlyRejections === 0) proxy.resetConnections();
        }

        // Phase 3: failover back to writable primary & confirm automatic recovery.
        nemesisEvents++;
        inReadOnlyWindow = false;
        inRecoveryPhase = true;
        history.info('nemesis', 'failover-to-primary', { host: primaryHost, port: primaryPort });
        if (usedStreamingReplica) {
          proxy.setUpstream(primaryHost, primaryPort, true);
        } else {
          await control.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = off`);
          proxy.resetConnections();
        }
      };

      const workerCount = Math.max(2, Math.min(options.concurrency, 6));
      const worker = async (id: number) => {
        while (Date.now() < stopAt) {
          await attemptTransfer(id);
          await sleep(rng.int(10, 40));
        }
      };

      await Promise.all([nemesisTask(), ...Array.from({ length: workerCount }, (_, i) => worker(i))]);

      // Guarantee at least one explicit recovery write even on very short runs.
      if (postFailoverWritesOk === 0) {
        inReadOnlyWindow = false;
        inRecoveryPhase = true;
        for (let attempt = 0; attempt < 10 && postFailoverWritesOk === 0; attempt++) {
          await attemptTransfer(99);
          await sleep(50);
        }
      }

      const finalRows = (await control.query('SELECT balance FROM public.account')).rows as { balance: number }[];
      const finalTotal = finalRows.reduce((sum, r) => sum + Number(r.balance), 0);

      const check = checkFailover({
        readOnlyRejections,
        postFailoverWritesOk,
        initialTotal,
        finalTotal,
        falseAppliedOnReadOnly,
      });

      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'failover-history')) : undefined;

      return {
        workload: 'failover',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        usedStreamingReplica,
        proxyStats: [{ node: 'failover-proxy', stats: proxy.stats() }],
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      if (!usedStreamingReplica) {
        await control.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = off`).catch(() => {});
      }
      await registry.closeAll().catch(() => {});
      await proxy.close().catch(() => {});
    }
  });
}
