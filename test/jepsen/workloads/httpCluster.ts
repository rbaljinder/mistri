/**
 * Jepsen Multi-Process HTTP End-to-End Cluster Chaos workload.
 *
 * Topology:
 *  - One isolated PostgreSQL database provisioned with Mistri's command journal
 *    and command event store.
 *  - Two real independent OS child processes (`pod-a`, `pod-b`), each running
 *    a full Mistri HTTP server (`createApp`) connected to PostgreSQL through
 *    its own `FaultProxy`.
 *
 * Behaviour under test:
 *  - Real HTTP traffic (`POST /api/commands/prepare`, `POST /api/commands/execute`,
 *    `POST /api/commands/status`) across both pods.
 *  - Nemesis injects real OS signals (`SIGSTOP`/`SIGCONT` process freezes,
 *    `SIGKILL` crashes + pod respawns) AND PostgreSQL post-COMMIT TCP reply cuts
 *    and socket resets.
 *  - Clients retry indeterminate (`:info`) idempotency keys against the surviving
 *    pod and verify strict balance conservation, zero lost commits, zero double
 *    applies, and exact receipt/ledger/outbox agreement via `checkBankConservation`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Registry } from '../../../packages/engine/src/server/connections.js';
import { parsePagesConfig } from '../../../packages/engine/src/shared/page.js';
import { runtimeTable } from '../../../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES } from '../../../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { COMMAND_EVENT_TABLES } from '../../../packages/mistri/src/adapters/events/commandEventSchema.js';
import { provisionPostgresCommandEventStore } from '../../../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import type { AppHost } from '../../../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../../../packages/mistri/src/server/app/appRuntimeResources.js';
import { appCommandEventStore, appCommandEventsFor } from '../../../packages/mistri/src/server/commands/appCommandEvents.js';
import { refuse } from '../../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../../../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../../../packages/mistri/src/server/commands/businessEvents.js';
import { appCommandCatalog } from '../../../packages/mistri/src/server/commands/commandContracts.js';
import { int, shape, text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { createApp } from '../../../packages/mistri/src/server/http/server.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { checkBankConservation, type BankCheckResult, type BankReadValue, type BankTransferValue } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface HttpClusterWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface HttpClusterWorkloadReport {
  readonly workload: 'http-cluster';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly podsKilled: number;
  readonly podsPaused: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: BankCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const THIS_FILE = fileURLToPath(import.meta.url);
const APP_ID = 'jepsen-http';
const SOURCE_ID = 'bank';
const CONNECTION_ID = 'jepsen-http-pg';
const ACCOUNT_ID = 'jepsen-http-teller';
const ACCOUNT_COUNT = 6;
const INITIAL_BALANCE = 1_000;

const transferOutput = shape({
  idempotencyKey: text(),
  fromId: int(),
  toId: int(),
  amount: int(),
  fromBalance: int(),
  toBalance: int(),
});

const HttpTransferred = defineEvent('bank.transferred', transferOutput);

const commands = defineCommands({
  transfer: defineCommand({
    source: SOURCE_ID,
    target: 'account',
    read: ['account'],
    write: ['account', 'ledger'],
    snapshot: true,
    input: {
      toAccountId: { label: 'To', type: 'number' },
      amount: { label: 'Amount', type: 'number' },
      transferKey: { label: 'Key', type: 'text' },
    },
    output: transferOutput,
    events: {
      transferred: defineEventProjection(HttpTransferred, (output) => output),
    },
    async handle({ db, record }, input) {
      const fromId = Number(record.id);
      const toId = Number(input.toAccountId);
      const amount = Number(input.amount);
      const transferKey = String(input.transferKey);
      if (!Number.isSafeInteger(amount) || amount <= 0 || fromId === toId) refuse('invalid_input');
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
      return { idempotencyKey: transferKey, fromId, toId, amount, fromBalance: nextFrom, toBalance: nextTo };
    },
  }),
});

function buildAppManifest() {
  const catalog = appCommandCatalog(commands, {
    sources: { [SOURCE_ID]: { connection: CONNECTION_ID, default: true } },
  });
  return parseAppConfig(
    {
      id: APP_ID,
      name: 'Jepsen HTTP Bank',
      sources: { [SOURCE_ID]: { connection: CONNECTION_ID, default: true } },
      resources: {
        account: {
          physical: 'public.account',
          access: 'write',
          actions: { transfer: { label: 'Transfer', command: 'transfer' } },
        },
        ledger: { physical: 'public.ledger', access: 'write' },
      },
      auth: {
        providers: ['email'],
        roles: { teller: { read: true, commands: ['transfer'] } },
      },
      views: { accounts: { kind: 'list', from: 'account' } },
      home: 'accounts',
    },
    'jepsen http cluster app',
    { commands: catalog },
  );
}

/** Child-process HTTP pod entrypoint: boots a real Mistri `createApp` server on an ephemeral port. */
async function runHttpPodWorker(pgUrl: string, podName: string): Promise<void> {
  const registry = new Registry();
  registry.add({ id: CONNECTION_ID, name: `HTTP (${podName})`, url: pgUrl, writable: true, source: 'config' });
  const manifest = buildAppManifest();
  const resources = await loadAppRuntimeResources(registry, manifest, CONNECTION_ID);
  const events = await appCommandEventsFor(manifest, commands, resources, (id) => registry.configOf(id)?.url);
  const pages = parsePagesConfig({ pages: [] }, 'jepsen http pages');
  const host: AppHost = {
    app: { app: manifest, path: '/jepsen/http/app.ts', pages, sources: {} },
    pages,
    auth: {
      spec: manifest.auth!,
      store: '/jepsen/http/auth.db',
      close() {},
      handler: async () => {},
      session: async () => ({
        id: ACCOUNT_ID,
        who: 'teller@jepsen.local',
        role: 'teller',
      }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages,
    commands: { appId: APP_ID, registry: commands, events },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  process.stdout.write(`READY ${bound.port}\n`);

  const shutdown = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await registry.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

interface ManagedPod {
  readonly name: string;
  readonly proxy: FaultProxy;
  child: ChildProcess | undefined;
  port: number;
  paused: boolean;
}

async function startPod(pod: ManagedPod, dbUrl: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', THIS_FILE, '--jepsen-worker', pod.proxy.proxiedUrl(dbUrl), pod.name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pod.child = child;
  pod.paused = false;
  let buf = '';
  let errLog = '';
  pod.port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`pod ${pod.name} failed to start: ${buf} ${errLog}`)), 20_000);
    child.stdout!.on('data', (chunk) => {
      buf += String(chunk);
      const match = /READY (\d+)/.exec(buf);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.stderr!.on('data', (chunk) => {
      errLog += String(chunk);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`pod ${pod.name} exited early (code=${code} sig=${signal}): ${errLog}`));
    });
  });
}

async function stopPod(pod: ManagedPod, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const child = pod.child;
  if (!child) return;
  if (pod.paused) {
    try {
      child.kill('SIGCONT');
    } catch {
      /* ignore */
    }
    pod.paused = false;
  }
  if (child.exitCode === null) {
    const exited = once(child, 'exit').catch(() => {});
    child.kill(signal);
    const killer =
      signal === 'SIGTERM'
        ? setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 2_000)
        : undefined;
    await exited;
    if (killer) clearTimeout(killer);
  }
  pod.child = undefined;
  pod.port = 0;
}

async function postJson(port: number, path: string, body: object, timeoutMs = 3_000) {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      origin,
      'content-type': 'application/json',
      'x-mistri-account': ACCOUNT_ID,
    },
    body: JSON.stringify(body),
  });
  const textBody = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = textBody ? (JSON.parse(textBody) as Record<string, unknown>) : {};
  } catch {
    json = { raw: textBody };
  }
  return { status: response.status, body: json };
}

export async function runHttpClusterWorkload(options: HttpClusterWorkloadOptions): Promise<HttpClusterWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'http', async ({ dbUrl, control }) => {
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
    for (let id = 1; id <= ACCOUNT_COUNT; id++) {
      await control.query('INSERT INTO public.account (id, version, balance) VALUES ($1, 0, $2)', [id, INITIAL_BALANCE]);
      initialBalances[String(id)] = INITIAL_BALANCE;
    }

    await migratePostgresCommandJournal(dbUrl);
    await provisionPostgresCommandEventStore(dbUrl, appCommandEventStore(APP_ID, SOURCE_ID));

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    const pods: ManagedPod[] = [
      { name: 'pod-a', proxy: new FaultProxy(pgHost, pgPort), child: undefined, port: 0, paused: false },
      { name: 'pod-b', proxy: new FaultProxy(pgHost, pgPort), child: undefined, port: 0, paused: false },
    ];

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;
    let podsKilled = 0;
    let podsPaused = 0;

    try {
      for (const pod of pods) {
        await pod.proxy.start();
        await startPod(pod, dbUrl);
      }

      interface TransferSpec {
        readonly idempotencyKey: string;
        readonly from: number;
        readonly to: number;
        readonly amount: number;
        readonly expectedVersion: number;
      }
      const unknownQueue: TransferSpec[] = [];
      let keySeq = 0;

      const executeTransfer = async (proc: number, pod: ManagedPod, spec: TransferSpec) => {
        const baseVal: BankTransferValue = {
          idempotencyKey: spec.idempotencyKey,
          from: spec.from,
          to: spec.to,
          amount: spec.amount,
          node: pod.name,
        };
        history.invoke(proc, 'transfer', baseVal);
        if (!pod.port) {
          history.info(proc, 'transfer', { ...baseVal, error: 'pod_down' });
          unknownQueue.push(spec);
          return;
        }
        try {
          const res = await postJson(pod.port, '/api/commands/execute', {
            command: 'transfer',
            commandVersion: 1,
            key: { id: spec.from },
            expectedVersion: spec.expectedVersion,
            idempotencyKey: spec.idempotencyKey,
            input: { toAccountId: spec.to, amount: spec.amount, transferKey: spec.idempotencyKey },
          });
          const status = res.body.status as string | undefined;
          const outcome = res.body.outcome as string | undefined;
          const out = res.body.result as { fromBalance?: number; toBalance?: number } | undefined;
          if (res.status >= 200 && res.status < 300 && status === 'applied') {
            history.ok(proc, 'transfer', {
              ...baseVal,
              outcome: 'applied',
              replayed: Boolean(res.body.replayed),
              receiptId: typeof res.body.receiptId === 'string' ? res.body.receiptId : undefined,
              fromBalance: out?.fromBalance,
              toBalance: out?.toBalance,
            });
          } else if (outcome === 'not_applied' || (res.status >= 400 && res.status < 500 && outcome !== 'unknown')) {
            history.fail(
              proc,
              'transfer',
              {
                ...baseVal,
                outcome: outcome === 'not_applied' ? 'not_applied' : undefined,
              },
              String(res.body.code ?? `http_${res.status}`),
            );
          } else {
            history.info(
              proc,
              'transfer',
              {
                ...baseVal,
                outcome: 'unknown',
              },
              String(res.body.code ?? `http_${res.status}`),
            );
            unknownQueue.push(spec);
          }
        } catch (error) {
          history.info(proc, 'transfer', {
            ...baseVal,
            error: error instanceof Error ? error.message : String(error),
          });
          unknownQueue.push(spec);
        }
      };

      const stopAt = Date.now() + Math.max(4_000, options.durationSec * 1_000);

      const worker = async (proc: number) => {
        while (Date.now() < stopAt) {
          const pod = pods[rng.int(0, pods.length)];
          if (unknownQueue.length > 0 && rng.next() < 0.5) {
            const spec = unknownQueue.shift()!;
            // Prefer the surviving pod when retrying an indeterminate write.
            const livePod = pods.find((p) => p.port > 0 && !p.paused) ?? pod;
            await executeTransfer(proc, livePod, spec);
            continue;
          }

          if (rng.next() < 0.15) {
            history.invoke(proc, 'read', { node: 'pg-snapshot' });
            try {
              const balances: Record<string, number> = {};
              const rows = (await control.query('SELECT id, balance FROM public.account ORDER BY id')).rows as {
                id: number;
                balance: number;
              }[];
              let total = 0;
              for (const row of rows) {
                balances[String(row.id)] = Number(row.balance);
                total += Number(row.balance);
              }
              history.ok(proc, 'read', { balances, total, node: 'pg-snapshot' } satisfies BankReadValue);
            } catch (error) {
              history.fail(proc, 'read', { error: error instanceof Error ? error.message : String(error) });
            }
            continue;
          }

          const from = rng.int(1, ACCOUNT_COUNT + 1);
          let to = rng.int(1, ACCOUNT_COUNT + 1);
          while (to === from) to = rng.int(1, ACCOUNT_COUNT + 1);
          const amount = rng.int(1, 41);
          if (!pod.port) {
            await sleep(50);
            continue;
          }
          try {
            const prep = await postJson(pod.port, '/api/commands/prepare', {
              command: 'transfer',
              commandVersion: 1,
              key: { id: from },
            });
            if (prep.status >= 200 && prep.status < 300 && typeof prep.body.expectedVersion === 'number') {
              await executeTransfer(proc, pod, {
                idempotencyKey: `jepsen-http-${options.seed}-${String(++keySeq).padStart(6, '0')}`,
                from,
                to,
                amount,
                expectedVersion: prep.body.expectedVersion,
              });
            }
          } catch {
            await sleep(30);
          }
          await sleep(rng.int(5, 25));
        }
      };

      const nemesis = async () => {
        if (!options.nemesis) return;
        await sleep(500);
        let cycle = 0;
        while (Date.now() + 800 < stopAt) {
          const target = pods[cycle % pods.length];
          const action = cycle % 4;
          cycle++;
          nemesisEvents++;
          if (action === 0 && target.child && target.child.exitCode === null) {
            // Real OS process freeze (SIGSTOP -> SIGCONT).
            podsPaused++;
            target.paused = true;
            history.info('nemesis', 'sigstop-pod', { pod: target.name, pid: target.child.pid });
            target.child.kill('SIGSTOP');
            await sleep(rng.int(300, 500));
            if (target.child && target.child.exitCode === null) {
              target.child.kill('SIGCONT');
              target.paused = false;
              history.info('nemesis', 'sigcont-pod', { pod: target.name, pid: target.child.pid });
            }
          } else if (action === 1) {
            // Post-COMMIT TCP cut between HTTP pod and PostgreSQL.
            history.info('nemesis', 'commit-cut', { pod: target.name });
            target.proxy.armCommitCut(1);
            await sleep(450);
          } else if (action === 2 && target.child && target.child.exitCode === null) {
            // Real OS SIGKILL crash + fresh pod respawn.
            podsKilled++;
            history.info('nemesis', 'sigkill-pod', { pod: target.name, pid: target.child.pid });
            await stopPod(target, 'SIGKILL');
            await sleep(250);
            if (Date.now() + 600 < stopAt) {
              await startPod(target, dbUrl);
              history.info('nemesis', 'respawn-pod', { pod: target.name, port: target.port });
            }
          } else {
            history.info('nemesis', 'reset-pg-sockets', { pod: target.name });
            target.proxy.resetConnections();
            await sleep(300);
          }
        }
      };

      const workerCount = Math.max(2, Math.min(options.concurrency, 8));
      await Promise.all([nemesis(), ...Array.from({ length: workerCount }, (_, i) => worker(i))]);

      // Heal all pods and recover any queued indeterminate keys via `/api/commands/status`.
      for (const pod of pods) {
        pod.proxy.heal();
        if (pod.paused && pod.child && pod.child.exitCode === null) {
          pod.child.kill('SIGCONT');
          pod.paused = false;
        }
        if (!pod.port) await startPod(pod, dbUrl);
      }

      const recoveryPod = pods[0];
      const seen = new Set<string>();
      for (const spec of unknownQueue) {
        if (seen.has(spec.idempotencyKey)) continue;
        seen.add(spec.idempotencyKey);
        const baseVal: BankTransferValue = {
          idempotencyKey: spec.idempotencyKey,
          from: spec.from,
          to: spec.to,
          amount: spec.amount,
          node: recoveryPod.name,
        };
        history.invoke(99, 'recover', baseVal);
        const statusRes = await postJson(recoveryPod.port, '/api/commands/status', {
          command: 'transfer',
          commandVersion: 1,
          idempotencyKey: spec.idempotencyKey,
        });
        const out = statusRes.body.result as { fromBalance?: number; toBalance?: number } | undefined;
        if (statusRes.status >= 200 && statusRes.status < 300 && statusRes.body.status === 'applied') {
          history.ok(99, 'recover', {
            ...baseVal,
            receiptId: typeof statusRes.body.receiptId === 'string' ? statusRes.body.receiptId : undefined,
            recovered: true,
            fromBalance: out?.fromBalance,
            toBalance: out?.toBalance,
            outcome: 'applied',
          });
        } else {
          history.fail(99, 'recover', { ...baseVal, outcome: 'unknown' }, 'not_found');
        }
      }

      // Ground-truth inspection from PostgreSQL.
      const accRows = (await control.query('SELECT id, balance FROM public.account ORDER BY id')).rows as { id: number; balance: number }[];
      const finalBalances: Record<string, number> = {};
      for (const row of accRows) finalBalances[String(row.id)] = Number(row.balance);

      const ledgerRows = (await control.query('SELECT idempotency_key, from_account, to_account, amount FROM public.ledger ORDER BY id'))
        .rows as { idempotency_key: string; from_account: number; to_account: number; amount: number }[];

      const receiptTable = runtimeTable('postgres', COMMAND_JOURNAL_TABLES.receipt);
      const receiptRows = (await control.query(`SELECT idempotency_key FROM ${receiptTable}`)).rows as {
        idempotency_key: string;
      }[];

      const eventTable = runtimeTable('postgres', COMMAND_EVENT_TABLES.event);
      const eventRows = (await control.query(`SELECT envelope_json FROM ${eventTable}`)).rows as {
        envelope_json: string | { payloadJson?: string; payload?: Record<string, unknown> };
      }[];

      const check = checkBankConservation(history.entries(), {
        initialBalances,
        finalBalances,
        ledgerEntries: ledgerRows.map((r) => ({
          idempotencyKey: r.idempotency_key,
          from: Number(r.from_account),
          to: Number(r.to_account),
          amount: Number(r.amount),
        })),
        receiptKeys: receiptRows.map((r) => String(r.idempotency_key)),
        eventKeys: eventRows.map((r) => {
          const env = typeof r.envelope_json === 'string' ? JSON.parse(r.envelope_json) : r.envelope_json;
          const payload = typeof env.payloadJson === 'string' ? JSON.parse(env.payloadJson) : env.payload;
          return String(payload?.idempotencyKey ?? '');
        }),
      });

      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'http-cluster-history')) : undefined;

      return {
        workload: 'http-cluster',
        valid: check.valid && check.summary.appliedKeys > 0,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        podsKilled,
        podsPaused,
        proxyStats: pods.map((p) => ({ node: p.name, stats: p.proxy.stats() })),
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      await Promise.all(pods.map((p) => stopPod(p, 'SIGTERM').catch(() => {})));
      await Promise.all(pods.map((p) => p.proxy.close().catch(() => {})));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === '--jepsen-worker') {
  const [, , , pgUrl, podName] = process.argv;
  runHttpPodWorker(pgUrl, podName || 'pod').catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
