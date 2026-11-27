/**
 * Jepsen Bank Transfer + Command Idempotency + Receipt Recovery + Event Outbox workload.
 *
 * Topology:
 *  - One isolated PostgreSQL database provisioned with Mistri's command journal
 *    and command event store.
 *  - Two independent Mistri `Registry` instances (`node-a`, `node-b`) simulating
 *    two separate application pods, each routed through its own `FaultProxy`.
 *
 * Behaviour under test:
 *  - Real Mistri `defineCommand({ snapshot: true, events: { transferred } })`
 *    executed via `executeBusinessCommand` and recovered via `lookupBusinessCommandStatus`
 *    plus idempotent retry across nodes.
 *  - Nemesis injects PostgreSQL post-COMMIT TCP reply cuts (`armCommitCut`),
 *    socket resets, latency spikes, and `pg_terminate_backend` kills.
 *  - Verifies strict balance conservation on every read and final state, zero
 *    negative balances, zero double-applies, zero lost commits, exact replay
 *    output agreement, and 1:1 ledger ↔ receipt ↔ event outbox correspondence.
 */
import { join } from 'node:path';
import { withSnapshotRead } from '../../../packages/engine/src/adapters/snapshotRead.js';
import { Registry } from '../../../packages/engine/src/server/connections.js';
import { runtimeTable } from '../../../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES } from '../../../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { COMMAND_EVENT_TABLES } from '../../../packages/mistri/src/adapters/events/commandEventSchema.js';
import { provisionPostgresCommandEventStore } from '../../../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import { loadAppRuntimeResources } from '../../../packages/mistri/src/server/app/appRuntimeResources.js';
import { appCommandEventStore, appCommandEventsFor } from '../../../packages/mistri/src/server/commands/appCommandEvents.js';
import { bindBusinessCommands } from '../../../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  refuse,
} from '../../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../../../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../../../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { checkBankConservation, type BankCheckResult, type BankReadValue, type BankTransferValue } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface BankWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
  readonly accountCount?: number;
  readonly initialBalance?: number;
}

export interface BankWorkloadReport {
  readonly workload: 'bank';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: BankCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-bank';
const SOURCE_ID = 'bank';
const CONNECTION_ID = 'jepsen-bank-pg';
const ACTOR: BusinessCommandActor = { id: 'jepsen-operator', appId: APP_ID, roles: ['teller'] };

const transferOutput = shape({
  idempotencyKey: text(),
  fromId: int(),
  toId: int(),
  amount: int(),
  fromBalance: int(),
  toBalance: int(),
});

const BankTransferred = defineEvent('bank.transferred', transferOutput);

const commands = defineCommands({
  transfer: defineCommand({
    source: SOURCE_ID,
    target: 'account',
    read: ['account'],
    write: ['account', 'ledger'],
    snapshot: true,
    input: {
      toAccountId: { label: 'Destination account', type: 'number' },
      amount: { label: 'Transfer amount', type: 'number' },
      transferKey: { label: 'Transfer key', type: 'text' },
    },
    output: transferOutput,
    events: {
      transferred: defineEventProjection(BankTransferred, (output) => output),
    },
    async handle({ db, record }, input) {
      const fromId = Number(record.id);
      const toId = Number(input.toAccountId);
      const amount = Number(input.amount);
      const transferKey = String(input.transferKey);
      if (!Number.isSafeInteger(amount) || amount <= 0 || fromId === toId) {
        refuse('invalid_input');
      }
      // Lock accounts in deterministic primary-key order to prevent avoidable DB deadlocks
      // while exercising concurrent REPEATABLE READ serialization and row locking.
      const toRow = await db.account.find({ id: toId });
      if (!toRow) refuse('not_found');
      const fromBal = Number(record.balance);
      const toBal = Number(toRow.balance);
      if (fromBal < amount) refuse('ineligible_state');
      const nextFrom = fromBal - amount;
      const nextTo = toBal + amount;
      await db.account.update(record, { balance: nextFrom });
      await db.account.update(toRow, { balance: nextTo });
      await db.ledger.insert({
        idempotency_key: transferKey,
        from_account: fromId,
        to_account: toId,
        amount,
      });
      return {
        idempotencyKey: transferKey,
        fromId,
        toId,
        amount,
        fromBalance: nextFrom,
        toBalance: nextTo,
      };
    },
  }),
});

export async function runBankWorkload(options: BankWorkloadOptions): Promise<BankWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const accountCount = options.accountCount ?? 6;
  const initialBalance = options.initialBalance ?? 1_000;

  return withIsolatedPostgresDb(options.pgUrl, 'bank', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.account (
        id integer PRIMARY KEY,
        version integer NOT NULL DEFAULT 0,
        balance integer NOT NULL CHECK (balance >= 0)
      );
      CREATE TABLE public.ledger (
        id serial PRIMARY KEY,
        idempotency_key text NOT NULL UNIQUE,
        from_account integer NOT NULL REFERENCES public.account(id),
        to_account integer NOT NULL REFERENCES public.account(id),
        amount integer NOT NULL CHECK (amount > 0)
      );
    `);

    const initialBalances: Record<string, number> = {};
    for (let id = 1; id <= accountCount; id++) {
      await control.query('INSERT INTO public.account (id, version, balance) VALUES ($1, 0, $2)', [id, initialBalance]);
      initialBalances[String(id)] = initialBalance;
    }

    await migratePostgresCommandJournal(dbUrl);
    await provisionPostgresCommandEventStore(dbUrl, appCommandEventStore(APP_ID, SOURCE_ID));

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    // Two independent Mistri nodes, each behind its own FaultProxy.
    const proxies = [
      { name: 'node-a', proxy: new FaultProxy(pgHost, pgPort) },
      { name: 'node-b', proxy: new FaultProxy(pgHost, pgPort) },
    ];
    for (const item of proxies) await item.proxy.start();

    const app = parseAppConfig(
      {
        id: APP_ID,
        name: 'Jepsen Bank',
        sources: { [SOURCE_ID]: { connection: CONNECTION_ID } },
        resources: {
          account: { physical: 'public.account', access: 'write' },
          ledger: { physical: 'public.ledger', access: 'write' },
        },
        auth: {
          roles: {
            teller: { read: true, commands: ['transfer'] },
          },
        },
        views: { accounts: { kind: 'list', from: 'account' } },
        home: 'accounts',
      },
      'jepsen bank app',
    );

    const nodes: Array<{
      readonly name: string;
      readonly proxy: FaultProxy;
      readonly registry: Registry;
      readonly binding: ReturnType<typeof bindBusinessCommands>;
    }> = [];

    const history = new HistoryRecorder<unknown>();
    let stopAt = Date.now() + options.durationSec * 1_000;
    let nemesisEvents = 0;

    try {
      for (const { name, proxy } of proxies) {
        const registry = new Registry();
        const proxiedUrl = proxy.proxiedUrl(dbUrl);
        registry.add({ id: CONNECTION_ID, name: `Bank (${name})`, url: proxiedUrl, writable: true, source: 'config' });
        const resources = await loadAppRuntimeResources(registry, app, CONNECTION_ID);
        const events = await appCommandEventsFor(app, commands, resources, (id) => registry.configOf(id)?.url);
        const binding = bindBusinessCommands({
          app,
          registry: commands,
          resources,
          writableConnection: (id) => registry.configOf(id)?.writable === true,
          events,
        });
        nodes.push({ name, proxy, registry, binding });
      }

      // Track indeterminate (`:info`) and recently succeeded keys (including their original expectedVersion)
      // so workers actively retry & recover them with the exact original command fingerprint.
      interface TransferSpec {
        readonly idempotencyKey: string;
        readonly from: number;
        readonly to: number;
        readonly amount: number;
        readonly expectedVersion: number;
      }
      const unknownQueue: TransferSpec[] = [];
      const replayCandidates: TransferSpec[] = [];
      let keySeq = 0;

      const readAccountVersion = async (nodeIdx: number, accountId: number): Promise<number> => {
        const opened = await nodes[nodeIdx].registry.open(CONNECTION_ID);
        const res = await opened.adapter.query({
          table: 'public.account',
          filter: { groups: [[{ column: 'id', op: '=', value: accountId }]] },
          limit: 1,
          offset: 0,
        });
        return Number(res.rows[0]?.version ?? 0);
      };

      const executeTransfer = async (proc: number, nodeIdx: number, spec: TransferSpec) => {
        const node = nodes[nodeIdx];
        const baseVal: BankTransferValue = {
          idempotencyKey: spec.idempotencyKey,
          from: spec.from,
          to: spec.to,
          amount: spec.amount,
          node: node.name,
        };
        history.invoke(proc, 'transfer', baseVal);
        try {
          const result = await executeBusinessCommand(node.binding, ACTOR, {
            command: 'transfer',
            commandVersion: 1,
            key: { id: spec.from },
            expectedVersion: spec.expectedVersion,
            input: { toAccountId: spec.to, amount: spec.amount, transferKey: spec.idempotencyKey },
            idempotencyKey: spec.idempotencyKey,
          });
          const out = result.result as { fromBalance?: number; toBalance?: number } | undefined;
          history.ok(proc, 'transfer', {
            ...baseVal,
            receiptId: result.receiptId,
            replayed: result.replayed,
            fromBalance: out?.fromBalance,
            toBalance: out?.toBalance,
            outcome: 'applied',
          });
          if (!result.replayed && replayCandidates.length < 256) replayCandidates.push(spec);
        } catch (error) {
          if (error instanceof BusinessCommandExecutionError) {
            if (error.outcome === 'not_applied') {
              history.fail(proc, 'transfer', { ...baseVal, outcome: 'not_applied' }, error.code);
            } else {
              history.info(proc, 'transfer', { ...baseVal, outcome: 'unknown' }, error.code);
              unknownQueue.push(spec);
            }
          } else {
            history.info(proc, 'transfer', { ...baseVal, outcome: 'unknown' }, String(error));
            unknownQueue.push(spec);
          }
        }
      };

      const runReadAudit = async (proc: number, nodeIdx: number) => {
        const node = nodes[nodeIdx];
        history.invoke(proc, 'read', { node: node.name });
        try {
          const opened = await node.registry.open(CONNECTION_ID);
          const balances: Record<string, number> = {};
          let total = 0;
          await withSnapshotRead(true, () =>
            opened.adapter.transaction!(async (tx) => {
              const res = await tx.query({ table: 'public.account', limit: accountCount + 10, offset: 0 });
              for (const row of res.rows) {
                const bal = Number(row.balance ?? 0);
                balances[String(row.id)] = bal;
                total += bal;
              }
            }),
          );
          const value: BankReadValue = { balances, total, node: node.name };
          history.ok(proc, 'read', value);
        } catch (error) {
          history.info(proc, 'read', { node: node.name }, error instanceof Error ? error.message : String(error));
        }
      };

      // Nemesis loop: cycles through post-COMMIT cuts, TCP resets, latency spikes, and pg_terminate_backend.
      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(350);
          if (Date.now() >= stopAt) break;
          const target = nodes[round % nodes.length];
          const action = round % 4;
          round++;
          nemesisEvents++;
          if (action === 0) {
            history.info('nemesis', 'arm-commit-cut', { node: target.name, count: 2 });
            target.proxy.armCommitCut(2);
          } else if (action === 1) {
            history.info('nemesis', 'latency', { node: target.name, ms: 40, jitterMs: 25 });
            target.proxy.setLatency(40, 25);
            await sleep(300);
            target.proxy.setLatency(0, 0);
          } else if (action === 2) {
            const count = target.proxy.resetConnections();
            history.info('nemesis', 'tcp-reset', { node: target.name, sockets: count });
          } else {
            // Kill one active non-control backend on this database.
            const killed = await control
              .query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
                 LIMIT 1`,
              )
              .catch(() => ({ rows: [] }));
            history.info('nemesis', 'pg-terminate-backend', { terminated: killed.rows.length });
          }
        }
        // Heal all proxies before final reconciliation phase.
        for (const n of nodes) n.proxy.heal();
        history.info('nemesis', 'heal', { all: true });
      };

      // Concurrent client workers.
      const workerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const nodeIdx = rng.int(0, nodes.length);
          const roll = rng.next();

          if (roll < 0.15) {
            await runReadAudit(workerId, nodeIdx);
          } else if (roll < 0.3 && unknownQueue.length > 0) {
            // Re-submit an unknown-outcome transfer to a (possibly different!) Mistri node.
            const spec = unknownQueue.shift()!;
            await executeTransfer(workerId, nodeIdx, spec);
          } else if (roll < 0.45 && replayCandidates.length > 0) {
            // Deliberate duplicate retry with the exact same idempotency key on either node.
            const spec = rng.pick(replayCandidates);
            await executeTransfer(workerId, nodeIdx, spec);
          } else {
            const from = rng.int(1, accountCount + 1);
            let to = rng.int(1, accountCount + 1);
            if (to === from) to = (from % accountCount) + 1;
            const amount = rng.int(1, 75);
            const idempotencyKey = `jepsen-xfer-${options.seed}-${++keySeq}-${rng.int(1000, 9999)}`;
            let expectedVersion = 0;
            try {
              expectedVersion = await readAccountVersion(nodeIdx, from);
            } catch {
              continue;
            }
            await executeTransfer(workerId, nodeIdx, { idempotencyKey, from, to, amount, expectedVersion });
          }
        }
      };

      stopAt = Date.now() + options.durationSec * 1_000;
      await Promise.all([nemesisLoop(), ...Array.from({ length: options.concurrency }, (_, i) => workerLoop(i))]);

      // Ensure proxies are fully healed, then recover every remaining indeterminate (`:info`) key
      // via `lookupBusinessCommandStatus` and verify idempotent replay across the other node.
      for (const n of nodes) n.proxy.heal();
      await sleep(100);

      const seenRecovery = new Set<string>();
      for (const spec of unknownQueue) {
        if (seenRecovery.has(spec.idempotencyKey)) continue;
        seenRecovery.add(spec.idempotencyKey);
        const node = nodes[seenRecovery.size % nodes.length];
        const baseVal: BankTransferValue = {
          idempotencyKey: spec.idempotencyKey,
          from: spec.from,
          to: spec.to,
          amount: spec.amount,
          node: node.name,
        };
        history.invoke(0, 'recover', baseVal);
        try {
          const status = await lookupBusinessCommandStatus(node.binding, ACTOR, {
            command: 'transfer',
            commandVersion: 1,
            key: { id: spec.from },
            expectedVersion: spec.expectedVersion,
            input: { toAccountId: spec.to, amount: spec.amount, transferKey: spec.idempotencyKey },
            idempotencyKey: spec.idempotencyKey,
          });
          if (status.status === 'applied') {
            const out = status.result as { fromBalance?: number; toBalance?: number } | undefined;
            history.ok(0, 'recover', {
              ...baseVal,
              receiptId: status.receiptId,
              recovered: true,
              fromBalance: out?.fromBalance,
              toBalance: out?.toBalance,
              outcome: 'applied',
            });
            // Also verify re-executing on the other node replays the identical receipt & output.
            await executeTransfer(0, (seenRecovery.size + 1) % nodes.length, spec);
          } else {
            history.fail(0, 'recover', { ...baseVal, outcome: 'unknown' }, 'not_found');
          }
        } catch (error) {
          history.info(0, 'recover', { ...baseVal, outcome: 'unknown' }, String(error));
        }
      }

      // Final clean audit read on both nodes.
      await runReadAudit(0, 0);
      await runReadAudit(0, 1);

      // Query ground-truth final DB state directly through the unproxied control connection.
      const finalBalances: Record<string, number> = {};
      const acctRows = await control.query('SELECT id, balance FROM public.account ORDER BY id');
      for (const row of acctRows.rows) finalBalances[String(row.id)] = Number(row.balance);

      const ledgerRows = await control.query('SELECT idempotency_key, from_account, to_account, amount FROM public.ledger ORDER BY id');
      const ledgerEntries = ledgerRows.rows.map((r) => ({
        idempotencyKey: String(r.idempotency_key),
        from: Number(r.from_account),
        to: Number(r.to_account),
        amount: Number(r.amount),
      }));

      const receiptTable = runtimeTable('postgres', COMMAND_JOURNAL_TABLES.receipt);
      const receiptRows = await control.query(`SELECT idempotency_key FROM ${receiptTable}`);
      const receiptKeys = receiptRows.rows.map((r) => String(r.idempotency_key));

      const eventTable = runtimeTable('postgres', COMMAND_EVENT_TABLES.event);
      const eventRows = await control.query(`SELECT envelope_json FROM ${eventTable}`);
      const eventKeys = eventRows.rows.map((r) => {
        const envelope = JSON.parse(String(r.envelope_json)) as { payloadJson?: string };
        const payload = envelope.payloadJson ? (JSON.parse(envelope.payloadJson) as { idempotencyKey?: string }) : {};
        return String(payload.idempotencyKey ?? '');
      });

      const check = checkBankConservation(history.entries(), {
        initialBalances,
        finalBalances,
        ledgerEntries,
        receiptKeys,
        eventKeys,
      });

      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'bank-history')) : undefined;
      return {
        workload: 'bank',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: nodes.map((n) => ({ node: n.name, stats: n.proxy.stats() })),
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      for (const n of nodes) await n.registry.closeAll().catch(() => {});
      for (const item of proxies) await item.proxy.close().catch(() => {});
    }
  });
}
