/**
 * Jepsen AI Proposal Approval Races & Live-Sync (`LISTEN`/`NOTIFY`) Fault workload.
 *
 * Exercises two concurrent Mistri mechanisms on one isolated PostgreSQL DB:
 *  1. **Proposals (`proposals.ts`):** Two independent Mistri hosts race
 *     `approveProposal` vs `dismissProposal` (and duplicate concurrent approvals)
 *     against the same proposals behind `FaultProxy` with post-`COMMIT` cuts.
 *     Proves every proposal executes at most once and never executes after dismissal.
 *  2. **Live Sync (`listenForCommandEvents`):** Continuously commits and rolls
 *     back transactions emitting `NOTIFY_COMMAND_EVENTS` while the nemesis kills
 *     the `LISTEN` backend via `pg_terminate_backend`. Proves listeners reconnect,
 *     deliver committed notifications, and never fire on rolled-back transactions.
 */
import { join } from 'node:path';
import { Registry } from '../../../packages/engine/src/server/connections.js';
import { runtimeTable } from '../../../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES } from '../../../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import {
  COMMAND_EVENT_CHANNEL,
  listenForCommandEvents,
  NOTIFY_COMMAND_EVENTS,
} from '../../../packages/mistri/src/adapters/events/postgresCommandEventWake.js';
import { loadAppRuntimeResources } from '../../../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../../../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../../../packages/mistri/src/server/commands/businessCommands.js';
import { int, shape, text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { createProposal, runProposalRoute } from '../../../packages/mistri/src/server/commands/proposals.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { COMMAND_ROUTES } from '../../../packages/mistri/src/shared/commandRoutes.js';
import { checkProposalsAndLiveSync, type ProposalsLiveCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { openPgClient, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface ProposalsLiveWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface ProposalsLiveWorkloadReport {
  readonly workload: 'proposals';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: ProposalsLiveCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-proposals';
const SOURCE_ID = 'tickets';
const CONNECTION_ID = 'jepsen-proposals-pg';
const ACTOR: BusinessCommandActor = { id: 'approver-1', appId: APP_ID, roles: ['approver'] };

const commands = defineCommands({
  applyAdjustment: defineCommand({
    source: SOURCE_ID,
    target: 'ticket',
    read: ['ticket'],
    write: ['ticket', 'ticket_effect'],
    input: {
      proposalTag: { label: 'Proposal tag', type: 'text' },
      delta: { label: 'Delta', type: 'number' },
    },
    output: shape({ ticketId: int(), proposalTag: text(), delta: int() }),
    async handle({ db, record }, input) {
      const delta = Number(input.delta);
      const proposalTag = String(input.proposalTag);
      await db.ticket.update(record, { score: Number(record.score) + delta });
      await db.ticket_effect.insert({ ticket_id: Number(record.id), proposal_tag: proposalTag, delta });
      return { ticketId: Number(record.id), proposalTag, delta };
    },
  }),
});

export async function runProposalsLiveWorkload(options: ProposalsLiveWorkloadOptions): Promise<ProposalsLiveWorkloadReport> {
  const startedAt = Date.now();
  const proposalCount = 14;

  return withIsolatedPostgresDb(options.pgUrl, 'proposals', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.ticket (
        id integer PRIMARY KEY,
        version integer NOT NULL DEFAULT 0,
        score integer NOT NULL DEFAULT 0
      );
      CREATE TABLE public.ticket_effect (
        id serial PRIMARY KEY,
        ticket_id integer NOT NULL REFERENCES public.ticket(id),
        proposal_tag text NOT NULL,
        delta integer NOT NULL
      );
    `);
    for (let i = 1; i <= proposalCount; i++) {
      await control.query('INSERT INTO public.ticket (id, version, score) VALUES ($1, 0, 100)', [i]);
    }
    await migratePostgresCommandJournal(dbUrl);

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    const proxies = [
      { name: 'prop-a', proxy: new FaultProxy(pgHost, pgPort) },
      { name: 'prop-b', proxy: new FaultProxy(pgHost, pgPort) },
    ];
    for (const item of proxies) await item.proxy.start();

    const app = parseAppConfig(
      {
        id: APP_ID,
        name: 'Jepsen Proposals',
        sources: { [SOURCE_ID]: { connection: CONNECTION_ID } },
        resources: {
          ticket: { physical: 'public.ticket', access: 'write' },
          ticket_effect: { physical: 'public.ticket_effect', access: 'write' },
        },
        auth: { roles: { approver: { read: true, commands: ['applyAdjustment'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      'jepsen proposals app',
    );

    const nodes: Array<{
      readonly name: string;
      readonly proxy: FaultProxy;
      readonly registry: Registry;
      readonly binding: ReturnType<typeof bindBusinessCommands>;
    }> = [];

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;
    let observedWakeCount = 0;
    let rollbackWakeCount = 0;
    let inRollbackPhase = false;
    let committedWakeCount = 0;

    const listener = await listenForCommandEvents(dbUrl, () => {
      if (inRollbackPhase) rollbackWakeCount++;
      else observedWakeCount++;
    });

    try {
      for (const { name, proxy } of proxies) {
        const registry = new Registry();
        registry.add({ id: CONNECTION_ID, name: `Proposals (${name})`, url: proxy.proxiedUrl(dbUrl), writable: true, source: 'config' });
        const resources = await loadAppRuntimeResources(registry, app, CONNECTION_ID);
        const binding = bindBusinessCommands({
          app,
          registry: commands,
          resources,
          writableConnection: (id) => registry.configOf(id)?.writable === true,
        });
        nodes.push({ name, proxy, registry, binding });
      }

      // Create `proposalCount` proposals targeting tickets 1..N.
      const proposalIds: string[] = [];
      const tagByProposal = new Map<string, string>();
      for (let i = 1; i <= proposalCount; i++) {
        const tag = `prop-tag-${options.seed}-${i}`;
        const row = await createProposal(nodes[0].binding, ACTOR, {
          command: 'applyAdjustment',
          key: { id: i },
          input: { proposalTag: tag, delta: 10 },
          maker: 'assistant',
          makerActor: 'jepsen-assistant',
          evidence: [{ kind: 'record', ref: `ticket:${i}`, label: `Ticket #${i}` }],
          reason: `Jepsen adjustment for ticket ${i}`,
        });
        proposalIds.push(row.id);
        tagByProposal.set(row.id, tag);
      }

      const offered = new Set(['applyAdjustment']);

      // Phase A: Test rollback NOTIFY silence first (cleanly isolated window).
      const notifyClient = await openPgClient(dbUrl);
      try {
        inRollbackPhase = true;
        await notifyClient.query('BEGIN');
        await notifyClient.query(NOTIFY_COMMAND_EVENTS);
        await notifyClient.query('ROLLBACK');
        await sleep(150);
        inRollbackPhase = false;

        // Phase B: Race concurrent approve/dismiss across both Mistri hosts + LISTEN backend kills!
        const raceProposal = async (idx: number) => {
          const proposalId = proposalIds[idx];
          // Even proposals race two approvals against a dismissal; odd proposals race
          // two concurrent approvals across both hosts to prove at-most-once execution.
          const actions = [
            { hostIdx: 0, path: COMMAND_ROUTES.approveProposal, label: 'approve' },
            { hostIdx: 1, path: COMMAND_ROUTES.approveProposal, label: 'approve' },
            ...(idx % 2 === 0 ? [{ hostIdx: idx % 2, path: COMMAND_ROUTES.dismissProposal, label: 'dismiss' }] : []),
          ];
          await Promise.all(
            actions.map(async (act, sub) => {
              const node = nodes[act.hostIdx];
              const proc = idx * 3 + sub;
              history.invoke(proc, act.label, { proposalId, node: node.name });
              try {
                await runProposalRoute({
                  path: act.path,
                  body:
                    act.path === COMMAND_ROUTES.approveProposal
                      ? { id: proposalId, command: 'applyAdjustment', expectedVersion: 0 }
                      : { id: proposalId, command: 'applyAdjustment' },
                  binding: node.binding,
                  actor: ACTOR,
                  offered,
                  unoffered: () => new Error('unoffered'),
                  execute: (envelope, propId) => executeBusinessCommand(node.binding, ACTOR, envelope, { proposalId: propId }),
                });
                history.ok(proc, act.label, { proposalId, node: node.name });
              } catch (error) {
                history.info(proc, act.label, { proposalId, node: node.name }, error instanceof Error ? error.message : String(error));
              }
            }),
          );
        };

        const nemesisTask = async () => {
          if (!options.nemesis) return;
          for (let round = 0; round < 4; round++) {
            await sleep(180);
            const target = nodes[round % nodes.length];
            nemesisEvents++;
            if (round % 2 === 0) {
              target.proxy.armCommitCut(1);
              history.info('nemesis', 'arm-commit-cut', { node: target.name });
            } else {
              // Kill the LISTEN backend and emit a committed NOTIFY to prove reconnect + wake delivery.
              await control.query(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = current_database() AND query = 'LISTEN ${COMMAND_EVENT_CHANNEL}'`,
              );
              history.info('nemesis', 'kill-listen-backend', {});
            }
            await notifyClient.query('BEGIN');
            await notifyClient.query(NOTIFY_COMMAND_EVENTS);
            await notifyClient.query('COMMIT');
            committedWakeCount++;
          }
          for (const n of nodes) n.proxy.heal();
        };

        await Promise.all([
          nemesisTask(),
          (async () => {
            // Run in concurrent waves of `concurrency`.
            const waveSize = Math.max(2, Math.min(options.concurrency, 5));
            for (let i = 0; i < proposalIds.length; i += waveSize) {
              const wave = proposalIds.slice(i, i + waveSize).map((_, offset) => raceProposal(i + offset));
              await Promise.all(wave);
            }
          })(),
        ]);

        // Final committed NOTIFY after healing to ensure live wake delivery settles.
        for (const n of nodes) n.proxy.heal();
        await sleep(250);
        await notifyClient.query('BEGIN');
        await notifyClient.query(NOTIFY_COMMAND_EVENTS);
        await notifyClient.query('COMMIT');
        committedWakeCount++;
        await sleep(250);
      } finally {
        await notifyClient.end().catch(() => {});
      }

      // Ground-truth DB checks on proposal states and applied ticket_effect rows.
      const proposalTable = runtimeTable('postgres', COMMAND_JOURNAL_TABLES.proposal);
      const propRows = await control.query(`SELECT id, state FROM ${proposalTable}`);
      const finalStateByProposal: Record<string, string> = {};
      for (const r of propRows.rows) finalStateByProposal[String(r.id)] = String(r.state);

      const effectRows = await control.query('SELECT proposal_tag FROM public.ticket_effect');
      const countByTag = new Map<string, number>();
      for (const r of effectRows.rows) {
        const tag = String(r.proposal_tag);
        countByTag.set(tag, (countByTag.get(tag) ?? 0) + 1);
      }
      const appliedCountByProposal: Record<string, number> = {};
      for (const id of proposalIds) {
        appliedCountByProposal[id] = countByTag.get(tagByProposal.get(id)!) ?? 0;
      }

      const check = checkProposalsAndLiveSync({
        proposalIds,
        appliedCountByProposal,
        finalStateByProposal,
        committedWakeCount,
        observedWakeCount,
        rollbackWakeCount,
      });

      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'proposals-history')) : undefined;
      return {
        workload: 'proposals',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: nodes.map((n) => ({ node: n.name, stats: n.proxy.stats() })),
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      await listener.close().catch(() => {});
      for (const n of nodes) await n.registry.closeAll().catch(() => {});
      for (const item of proxies) await item.proxy.close().catch(() => {});
    }
  });
}
