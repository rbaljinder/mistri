/**
 * Jepsen / Elle `list-append` transactional isolation workload over Mistri
 * `snapshot: true` commands (`REPEATABLE READ` + `WriteAhead`) on PostgreSQL.
 *
 * Each concurrent worker submits multi-operation transactions (`[:r k]`,
 * `[:append k v]`) through two independent Mistri registries behind two
 * `FaultProxy` instances. Every transaction is logged in exact Elle
 * `list-append` format, verified with the built-in DSG analyzer (`G0`, `G1a`,
 * `G1b`, `G1c`, `P4`/lost updates, `G-single` snapshot-isolation anomalies),
 * and exported as `.edn` for `elle-cli` verification.
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
import { shape, text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { checkListAppendHistory, runElleCli, type ElleCheckResult, type ElleCliResult } from '../elle.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder, type ListAppendMicroOp } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface ListAppendWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly keyCount?: number;
  readonly outDir?: string;
  readonly elleCliPath?: string;
}

export interface ListAppendWorkloadReport {
  readonly workload: 'append';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly elle: ElleCheckResult;
  readonly elleCli?: ElleCliResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-append';
const SOURCE_ID = 'lists';
const CONNECTION_ID = 'jepsen-append-pg';
const ACTOR: BusinessCommandActor = { id: 'jepsen-worker', appId: APP_ID, roles: ['writer'] };

type EncodedMicroOp = readonly ['r', string, null] | readonly ['append', string, number];

function parseListCsv(csv: string): number[] {
  const trimmed = csv.trim();
  if (!trimmed) return [];
  return trimmed.split(',').map((part) => Number(part));
}

const commands = defineCommands({
  runTxn: defineCommand({
    source: SOURCE_ID,
    target: 'vault',
    read: ['list_cell'],
    write: ['list_cell'],
    snapshot: true,
    input: {
      opsJson: { label: 'Encoded micro-ops', type: 'text' },
    },
    output: shape({ resultJson: text() }),
    async handle({ db }, input) {
      const requested = JSON.parse(String(input.opsJson)) as EncodedMicroOp[];
      if (!Array.isArray(requested) || requested.length === 0) refuse('invalid_input');

      const completed: ListAppendMicroOp[] = [];
      for (const mop of requested) {
        if (mop[0] === 'r') {
          const row = await db.list_cell.find({ id: mop[1] });
          completed.push(['r', mop[1], row ? parseListCsv(String(row.items ?? '')) : []]);
        } else {
          const row = await db.list_cell.find({ id: mop[1] });
          if (!row) refuse('not_found');
          const current = parseListCsv(String(row.items ?? ''));
          const next = [...current, mop[2]];
          await db.list_cell.update(row, { items: next.join(',') });
          completed.push(['append', mop[1], mop[2]]);
        }
      }
      return { resultJson: JSON.stringify(completed) };
    },
  }),
});

export async function runListAppendWorkload(options: ListAppendWorkloadOptions): Promise<ListAppendWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const keyCount = options.keyCount ?? 5;
  const keys = Array.from({ length: keyCount }, (_, i) => `k${i + 1}`);

  return withIsolatedPostgresDb(options.pgUrl, 'append', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.vault (
        id text PRIMARY KEY,
        version integer NOT NULL DEFAULT 0
      );
      CREATE TABLE public.list_cell (
        id text PRIMARY KEY,
        items text NOT NULL DEFAULT ''
      );
    `);
    await control.query(`INSERT INTO public.vault (id, version) VALUES ('main', 0)`);
    for (const key of keys) {
      await control.query(`INSERT INTO public.list_cell (id, items) VALUES ($1, '')`, [key]);
    }
    await migratePostgresCommandJournal(dbUrl);

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    const proxies = [
      { name: 'node-a', proxy: new FaultProxy(pgHost, pgPort) },
      { name: 'node-b', proxy: new FaultProxy(pgHost, pgPort) },
    ];
    for (const item of proxies) await item.proxy.start();

    const app = parseAppConfig(
      {
        id: APP_ID,
        name: 'Jepsen List Append',
        sources: { [SOURCE_ID]: { connection: CONNECTION_ID } },
        resources: {
          vault: { physical: 'public.vault', access: 'write' },
          list_cell: { physical: 'public.list_cell', access: 'write' },
        },
        auth: { roles: { writer: { read: true, commands: ['runTxn'] } } },
        views: { cells: { kind: 'list', from: 'list_cell' } },
        home: 'cells',
      },
      'jepsen list-append app',
    );

    const nodes: Array<{
      readonly name: string;
      readonly proxy: FaultProxy;
      readonly registry: Registry;
      readonly binding: ReturnType<typeof bindBusinessCommands>;
    }> = [];

    const history = new HistoryRecorder<readonly ListAppendMicroOp[]>();
    let nemesisEvents = 0;

    try {
      for (const { name, proxy } of proxies) {
        const registry = new Registry();
        registry.add({ id: CONNECTION_ID, name: `Lists (${name})`, url: proxy.proxiedUrl(dbUrl), writable: true, source: 'config' });
        const resources = await loadAppRuntimeResources(registry, app, CONNECTION_ID);
        const binding = bindBusinessCommands({
          app,
          registry: commands,
          resources,
          writableConnection: (id) => registry.configOf(id)?.writable === true,
        });
        nodes.push({ name, proxy, registry, binding });
      }

      let nextVal = 1;
      let txSeq = 0;
      const stopAt = Date.now() + options.durationSec * 1_000;

      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(400);
          if (Date.now() >= stopAt) break;
          const target = nodes[round % nodes.length];
          const action = round % 3;
          round++;
          nemesisEvents++;
          if (action === 0) {
            history.info('nemesis', 'arm-commit-cut', []);
            target.proxy.armCommitCut(1);
          } else if (action === 1) {
            history.info('nemesis', 'latency', []);
            target.proxy.setLatency(30, 20);
            await sleep(250);
            target.proxy.setLatency(0, 0);
          } else {
            target.proxy.resetConnections();
            history.info('nemesis', 'tcp-reset', []);
          }
        }
        for (const n of nodes) n.proxy.heal();
        history.info('nemesis', 'heal', []);
      };

      const workerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const node = nodes[rng.int(0, nodes.length)];
          const opCount = rng.int(2, 5);
          const txnOps: EncodedMicroOp[] = [];
          for (let i = 0; i < opCount; i++) {
            const key = rng.pick(keys);
            if (rng.next() < 0.5) txnOps.push(['r', key, null]);
            else txnOps.push(['append', key, nextVal++]);
          }
          const idempotencyKey = `jepsen-append-${options.seed}-${++txSeq}-${workerId}`;
          history.invoke(workerId, 'txn', txnOps);
          try {
            const res = await executeBusinessCommand(node.binding, ACTOR, {
              command: 'runTxn',
              commandVersion: 1,
              key: { id: 'main' },
              expectedVersion: 0,
              input: { opsJson: JSON.stringify(txnOps) },
              idempotencyKey,
            });
            const completed = JSON.parse(String((res.result as { resultJson: string }).resultJson)) as ListAppendMicroOp[];
            history.ok(workerId, 'txn', completed);
          } catch (error) {
            if (error instanceof BusinessCommandExecutionError && error.outcome === 'not_applied') {
              history.fail(workerId, 'txn', txnOps, error.code);
            } else {
              history.info(workerId, 'txn', txnOps, error instanceof BusinessCommandExecutionError ? error.code : String(error));
            }
          }
        }
      };

      await Promise.all([nemesisLoop(), ...Array.from({ length: options.concurrency }, (_, i) => workerLoop(i))]);

      // Heal proxies and run one final clean read-all transaction so every committed write is observed in the history.
      for (const n of nodes) n.proxy.heal();
      await sleep(100);
      const finalReadOps: EncodedMicroOp[] = keys.map((k) => ['r', k, null] as const);
      history.invoke(0, 'txn', finalReadOps);
      const finalRes = await executeBusinessCommand(nodes[0].binding, ACTOR, {
        command: 'runTxn',
        commandVersion: 1,
        key: { id: 'main' },
        expectedVersion: 0,
        input: { opsJson: JSON.stringify(finalReadOps) },
        idempotencyKey: `jepsen-append-final-${options.seed}-${Date.now()}`,
      });
      const finalCompleted = JSON.parse(String((finalRes.result as { resultJson: string }).resultJson)) as ListAppendMicroOp[];
      history.ok(0, 'txn', finalCompleted);

      const elle = checkListAppendHistory(history.entries(), { consistency: 'snapshot-isolation' });
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'append-history')) : undefined;
      const elleCli = historyFiles
        ? await runElleCli(historyFiles.edn, {
            model: 'list-append',
            consistency: 'snapshot-isolation',
            ...(options.elleCliPath ? { cliPath: options.elleCliPath } : {}),
          })
        : undefined;

      const valid = elle.valid && (elleCli?.ran ? elleCli.valid === true : true);
      return {
        workload: 'append',
        valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: nodes.map((n) => ({ node: n.name, stats: n.proxy.stats() })),
        elle,
        ...(elleCli ? { elleCli } : {}),
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      for (const n of nodes) await n.registry.closeAll().catch(() => {});
      for (const item of proxies) await item.proxy.close().catch(() => {});
    }
  });
}
