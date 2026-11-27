/**
 * CLI runner for Mistri's Jepsen-style data-integrity and fault-injection suite.
 *
 *   npm run test:jepsen -- --pg postgres://mistri:mistri@127.0.0.1:15432/mistri_jepsen --workload all
 *   npm run test:jepsen -- --pg postgres://... --replica-pg postgres://127.0.0.1:15433/mistri_jepsen --pgbouncer-pg postgres://127.0.0.1:16432/mistri_jepsen --valkey valkey://127.0.0.1:16379/0 --workload all
 *   npm run test:jepsen -- --workload append --elle-cli /path/to/elle-cli
 *   npm run test:jepsen -- --workload sqlite-crash
 *
 * Writes `report.json`, `report.md`, and per-workload `.jsonl` + `.edn`
 * histories (compatible with Jepsen / `elle-cli`) to `--out` or a fresh
 * OS temp directory (`mistri-jepsen-*`). Exits 0 when every invariant holds
 * and 1 on any data-integrity or isolation violation.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBankWorkload, type BankWorkloadReport } from './workloads/bank.js';
import { runDdlEpochWorkload, type DdlEpochWorkloadReport } from './workloads/ddlEpoch.js';
import { runEventDeliveryWorkload, type EventDeliveryWorkloadReport } from './workloads/eventDelivery.js';
import { runFailoverWorkload, type FailoverWorkloadReport } from './workloads/failover.js';
import { runHttpClusterWorkload, type HttpClusterWorkloadReport } from './workloads/httpCluster.js';
import { runListAppendWorkload, type ListAppendWorkloadReport } from './workloads/listAppend.js';
import { runPgBouncerWorkload, type PgBouncerWorkloadReport } from './workloads/pgbouncer.js';
import { runProposalsLiveWorkload, type ProposalsLiveWorkloadReport } from './workloads/proposalsLive.js';
import { runReplicaRywWorkload, type ReplicaWorkloadReport } from './workloads/replicaRyw.js';
import { runRetryStormWorkload, type RetryStormWorkloadReport } from './workloads/retryStorm.js';
import { runSqliteCrashWorkload, type SqliteCrashWorkloadReport } from './workloads/sqliteCrash.js';
import { runSupportLeaseWorkload, type SupportLeaseWorkloadReport } from './workloads/supportLease.js';
import { runTenantIsolationWorkload, type TenantWorkloadReport } from './workloads/tenantIsolation.js';
import { runValkeyCacheWorkload, type ValkeyCacheWorkloadReport } from './workloads/valkeyCache.js';
import { runWorkflowFencingWorkload, type WorkflowWorkloadReport } from './workloads/workflowFencing.js';

export type SingleWorkload =
  | 'bank'
  | 'append'
  | 'workflow'
  | 'outbox'
  | 'replica'
  | 'tenant'
  | 'pgbouncer'
  | 'ddl'
  | 'cache'
  | 'proposals'
  | 'failover'
  | 'support-lease'
  | 'http-cluster'
  | 'sqlite-crash'
  | 'retry-storm';

export type WorkloadChoice = SingleWorkload | 'all';

export type AnyWorkloadReport =
  | BankWorkloadReport
  | ListAppendWorkloadReport
  | WorkflowWorkloadReport
  | EventDeliveryWorkloadReport
  | ReplicaWorkloadReport
  | TenantWorkloadReport
  | PgBouncerWorkloadReport
  | DdlEpochWorkloadReport
  | ValkeyCacheWorkloadReport
  | ProposalsLiveWorkloadReport
  | FailoverWorkloadReport
  | SupportLeaseWorkloadReport
  | HttpClusterWorkloadReport
  | SqliteCrashWorkloadReport
  | RetryStormWorkloadReport;

const ALL_WORKLOADS: readonly SingleWorkload[] = [
  'bank',
  'append',
  'workflow',
  'outbox',
  'replica',
  'tenant',
  'pgbouncer',
  'ddl',
  'cache',
  'proposals',
  'failover',
  'support-lease',
  'http-cluster',
  'sqlite-crash',
  'retry-storm',
];

export interface CliOptions {
  readonly workload: WorkloadChoice;
  readonly pgUrl: string;
  readonly replicaPgUrl?: string;
  readonly pgbouncerPgUrl?: string;
  readonly valkeyUrl?: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
  readonly elleCliPath?: string;
  readonly help?: boolean;
}

const USAGE = `mistri Jepsen-style data-integrity harness

Usage:
  npm run test:jepsen -- [options]

Options:
  --workload <name|all>                  Workload: ${ALL_WORKLOADS.join('|')}|all (default: all)
  --pg <postgres://...>                  PostgreSQL primary URL (default: $MISTRI_JEPSEN_PG or $TABLEWALK_TEST_PG)
  --replica-pg <postgres://...>          Optional streaming replica URL for replica & failover workloads (default: $MISTRI_JEPSEN_REPLICA_PG)
  --pgbouncer-pg <postgres://...>        Optional transaction-mode PgBouncer URL for pgbouncer workload (default: $MISTRI_JEPSEN_PGBOUNCER_PG)
  --valkey <valkey://...>                Optional Valkey/Redis URL for cache workload (default: $MISTRI_JEPSEN_VALKEY)
  --duration <seconds>                   Chaos window per workload, 1..600 (default: 8)
  --concurrency <n>                      Concurrent workers per workload, 2..32 (default: 6)
  --seed <n>                             PRNG seed for reproducible runs (default: current timestamp)
  --nemesis / --no-nemesis               Enable/disable fault injection (default: --nemesis)
  --out <dir>                            Directory for histories (.edn/.jsonl) and reports (default: temp dir)
  --elle-cli <path>                      Optional path to official elle-cli binary/JAR (or set ELLE_CLI_BIN / ELLE_CLI_JAR)
  -h, --help                             Show this help message
`;

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let workload: WorkloadChoice = 'all';
  let pgUrl = env.MISTRI_JEPSEN_PG ?? env.TABLEWALK_TEST_PG ?? '';
  let replicaPgUrl = env.MISTRI_JEPSEN_REPLICA_PG || undefined;
  let pgbouncerPgUrl = env.MISTRI_JEPSEN_PGBOUNCER_PG || undefined;
  let valkeyUrl = env.MISTRI_JEPSEN_VALKEY || undefined;
  let durationSec = 8;
  let concurrency = 6;
  let nemesis = true;
  let seed = Date.now() & 0x7fffffff;
  let outDir: string | undefined;
  let elleCliPath: string | undefined;

  const takeValue = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      return { workload, pgUrl, durationSec, concurrency, nemesis, seed, help: true };
    }
    if (arg === '--workload') {
      const value = takeValue(i++, arg);
      if (value !== 'all' && !(ALL_WORKLOADS as readonly string[]).includes(value)) {
        throw new Error(`Invalid --workload "${value}". Expected ${ALL_WORKLOADS.join(', ')}, or all.`);
      }
      workload = value as WorkloadChoice;
    } else if (arg === '--pg') {
      pgUrl = takeValue(i++, arg);
    } else if (arg === '--replica-pg') {
      replicaPgUrl = takeValue(i++, arg);
    } else if (arg === '--pgbouncer-pg') {
      pgbouncerPgUrl = takeValue(i++, arg);
    } else if (arg === '--valkey') {
      valkeyUrl = takeValue(i++, arg);
    } else if (arg === '--duration') {
      durationSec = Number(takeValue(i++, arg));
      if (!Number.isFinite(durationSec) || durationSec < 1 || durationSec > 600) {
        throw new Error(`Invalid --duration "${durationSec}". Expected 1..600 seconds.`);
      }
    } else if (arg === '--concurrency') {
      concurrency = Number(takeValue(i++, arg));
      if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 32) {
        throw new Error(`Invalid --concurrency "${concurrency}". Expected integer 2..32.`);
      }
    } else if (arg === '--seed') {
      seed = Number(takeValue(i++, arg));
      if (!Number.isInteger(seed) || seed < 0) throw new Error(`Invalid --seed "${seed}".`);
    } else if (arg === '--nemesis') {
      nemesis = true;
    } else if (arg === '--no-nemesis') {
      nemesis = false;
    } else if (arg === '--out') {
      outDir = resolve(takeValue(i++, arg));
    } else if (arg === '--elle-cli') {
      elleCliPath = takeValue(i++, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    workload,
    pgUrl,
    ...(replicaPgUrl ? { replicaPgUrl } : {}),
    ...(pgbouncerPgUrl ? { pgbouncerPgUrl } : {}),
    ...(valkeyUrl ? { valkeyUrl } : {}),
    durationSec,
    concurrency,
    nemesis,
    seed,
    ...(outDir ? { outDir } : {}),
    ...(elleCliPath ? { elleCliPath } : {}),
  };
}

function appendViolations(lines: string[], violations: readonly { readonly code: string; readonly detail: string }[]) {
  if (violations.length === 0) return;
  lines.push('- **Violations**:');
  for (const v of violations) lines.push(`  - \`${v.code}\`: ${v.detail}`);
}

function formatMarkdownReport(
  options: CliOptions,
  outDir: string,
  reports: readonly AnyWorkloadReport[],
  skipped: readonly string[],
): string {
  const lines: string[] = [
    '# Mistri Jepsen Data-Integrity Report',
    '',
    `- **Overall verdict**: ${reports.every((r) => r.valid) ? 'PASS' : 'FAIL'}`,
    `- **Workloads executed**: ${reports.length}${skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : ''}`,
    `- **Seed**: \`${options.seed}\``,
    `- **Duration per workload**: ${options.durationSec}s`,
    `- **Concurrency**: ${options.concurrency}`,
    `- **Nemesis**: ${options.nemesis ? 'enabled' : 'disabled'}`,
    `- **Artifacts**: \`${outDir}\``,
    '',
  ];

  for (const report of reports) {
    lines.push(`## Workload: \`${report.workload}\` — ${report.valid ? 'PASS' : 'FAIL'}`);
    lines.push('');
    lines.push(`- Elapsed: ${report.durationMs} ms | Nemesis events: ${report.nemesisEvents}`);
    const cuts = report.proxyStats.reduce((sum, p) => sum + p.stats.commitCuts, 0);
    const resets = report.proxyStats.reduce((sum, p) => sum + p.stats.resets, 0);
    const drops = report.proxyStats.reduce((sum, p) => sum + p.stats.partitionDrops, 0);
    if (report.proxyStats.length > 0) {
      lines.push(`- FaultProxy faults: ${cuts} post-COMMIT cuts, ${resets} TCP resets, ${drops} partition drops`);
    }

    switch (report.workload) {
      case 'bank':
      case 'http-cluster': {
        const s = report.check.summary;
        if (report.workload === 'http-cluster') {
          lines.push(`- HTTP pods chaos: killed=${report.podsKilled}, sigstopPaused=${report.podsPaused}`);
        }
        lines.push(
          `- Conservation: initial=${s.expectedTotal}, final=${s.finalTotal}, readsChecked=${s.readsChecked}`,
          `- Commands: applied=${s.appliedKeys}/${s.uniqueKeysAttempted}, ok=${s.okOps}, fail=${s.failOps}, info=${s.infoOps}, replayed=${s.replayedOps}, recovered=${s.recoveredOps}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'append': {
        const e = report.elle;
        lines.push(
          `- Elle DSG: txns=${e.transactionCount} (ok=${e.okCount}, fail=${e.failCount}, info=${e.infoCount}), edges=(ww:${e.edgeCounts.ww}, wr:${e.edgeCounts.wr}, rw:${e.edgeCounts.rw})`,
        );
        if (report.elleCli) {
          lines.push(
            `- External \`elle-cli\`: ${report.elleCli.ran ? (report.elleCli.valid ? 'PASS' : 'FAIL') : `skipped (${report.elleCli.reason})`}`,
          );
        }
        if (e.anomalies.length > 0) {
          lines.push('- **Anomalies**:');
          for (const a of e.anomalies) lines.push(`  - \`${a.kind}\`: ${a.detail}`);
        }
        break;
      }
      case 'workflow': {
        const s = report.check.summary;
        lines.push(
          `- Workflows: completed=${s.completedWorkflows}/${s.totalWorkflows}, overtaken=${s.overtakenAdvances}, aborted=${s.abortedAdvances}, sideEffects=${s.totalSideEffects}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'outbox': {
        const s = report.check.summary;
        lines.push(
          `- Outbox: delivered=${s.uniqueDeliveredCount}/${s.committedCount}, attempts=${s.totalDeliveryAttempts}, deduplicatedRetries=${s.deduplicatedRetries}, clockRegressions=${s.clockRegressionsInjected}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'replica': {
        const s = report.check.summary;
        lines.push(
          `- Replica (${report.usedStreamingReplica ? 'streaming standby' : 'proxied read pool'}): writes=${s.writesCompleted}, rywReads=${s.rywReadsChecked}, lagReads=${s.lagTolerantReadsChecked}, replicaCheckouts=${s.replicaCheckouts}, fallbackReads=${s.fallbackReadsSucceeded}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'tenant':
      case 'pgbouncer': {
        const s = report.check.summary;
        const label =
          report.workload === 'pgbouncer'
            ? `PgBouncer (${report.usedPgBouncer ? 'transaction-mode PgBouncer' : 'direct PG with pooler=transaction'})`
            : 'Multi-tenant isolation';
        lines.push(
          `- ${label}: tenants=${s.tenantsTested}, scopedReads=${s.scopedReadsChecked}, writes=(ok:${s.scopedWritesOk}, fail:${s.scopedWritesFail}, info:${s.scopedWritesInfo}), finalRows=${s.finalRowCount}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'ddl': {
        const s = report.check.summary;
        lines.push(
          `- Online DDL & epoch invalidation: ddlSteps=${s.ddlStepsExecuted}, writes=(ok:${s.writesOk}, fail:${s.writesFail}, info:${s.writesInfo}), finalRows=${s.finalRowCount}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'cache': {
        const s = report.check.summary;
        lines.push(
          `- Valkey cache: reads=${s.readsChecked}, writes=${s.writesCompleted}, partitionDegradedReads=${s.partitionDegradedReads}, incrUnavailable=${s.incrUnavailableErrors}, postHealFreshChecks=${s.postHealFreshChecks}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'proposals': {
        const s = report.check.summary;
        lines.push(
          `- Proposals & LISTEN/NOTIFY: total=${s.totalProposals}, approved=${s.approvedCount}, dismissed=${s.dismissedCount}, wakes=${s.observedWakeCount}/${s.committedWakeCount}, rollbackWakes=${s.rollbackWakeCount}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'failover': {
        const s = report.check.summary;
        lines.push(
          `- Failover (${report.usedStreamingReplica ? 'streaming standby' : 'database read-only mode'}): readOnlyRejections=${s.readOnlyRejections}, falseApplied=${s.falseAppliedOnReadOnly}, postFailoverOk=${s.postFailoverWritesOk}, total=${s.finalTotal}/${s.initialTotal}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'support-lease': {
        const s = report.check.summary;
        lines.push(
          `- Support leases: opens=${s.openSucceeded}, exits=${s.exitSucceeded}, maxActive=${s.maxActiveObserved}, postRevokeActive=${s.finalActiveAfterRevoke}, postRevokeOpens=${s.postRevokeOpenSucceeded}, auditSessions=${s.auditSessionsCount}, auditFailed=${s.auditChainFailedCount}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'sqlite-crash': {
        const s = report.check.summary;
        lines.push(
          `- SQLite WAL crash recovery: integrity=${s.integrityCheck}, total=${s.finalTotal}/${s.initialTotal}, minBal=${s.minBalance}, transfers=${s.appliedTransfers}, sigkills=${s.killsInjected}, undoEntries=${s.undoEntriesPersisted}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
      case 'retry-storm': {
        const s = report.check.summary;
        lines.push(
          `- Retry-storm defenses: stormAttempts=${s.stormDownstreamAttempts}/${s.stormMaxAllowedAttempts} (reqs=${s.stormRequestsSent}), unclaimedAmplifications=${s.unclaimedAmplifications}/${s.unclaimedDownstreamFailures}, maxNestedInner=${s.maxNestedInnerAttempts}, coalescedMaxExec=${s.maxHandlerExecutionsPerKey} (${s.coalescedTotalRequests}/${s.coalescedUniqueKeys} keys)`,
          `- Overload & recovery: freshAdmitted=${s.freshRequestsAdmitted}, retriesShed=${s.retryRequestsShed}, abortedWithdrawn=${s.abortedWaitersWithdrawn}, replicaSpilloverSuppressed=${s.replicaSpilloversSuppressed}, maxHalfOpenProbes=${s.maxConcurrentHalfOpenProbes}, postHealOk=${s.postHealRecoveriesOk}`,
        );
        appendViolations(lines, report.check.violations);
        break;
      }
    }

    if (report.historyFiles) {
      lines.push(`- History: \`${report.historyFiles.edn}\` & \`${report.historyFiles.jsonl}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const selected: readonly SingleWorkload[] = options.workload === 'all' ? ALL_WORKLOADS : [options.workload];
  const needsPg = selected.some((w) => w !== 'sqlite-crash' && w !== 'retry-storm');
  if (needsPg && !options.pgUrl) {
    console.error('Error: PostgreSQL URL required via --pg <url>, MISTRI_JEPSEN_PG, or TABLEWALK_TEST_PG.');
    console.error('Start the local Docker stack first:\n  docker compose -f test/jepsen/docker-compose.yml up -d');
    return 2;
  }
  if (options.workload === 'cache' && !options.valkeyUrl) {
    console.error('Error: Valkey URL required for --workload cache via --valkey <url> or MISTRI_JEPSEN_VALKEY.');
    return 2;
  }

  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), 'mistri-jepsen-'));
  mkdirSync(outDir, { recursive: true });

  const reports: AnyWorkloadReport[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < selected.length; i++) {
    const name = selected[i];
    if (name === 'cache' && !options.valkeyUrl) {
      console.log('[jepsen] skipping workload=cache (pass --valkey or MISTRI_JEPSEN_VALKEY to enable)');
      skipped.push('cache');
      continue;
    }
    const seed = options.seed + i;
    console.log(
      `[jepsen] running workload=${name} duration=${options.durationSec}s concurrency=${options.concurrency} nemesis=${options.nemesis} seed=${seed}`,
    );
    const base = {
      durationSec: options.durationSec,
      concurrency: options.concurrency,
      nemesis: options.nemesis,
      seed,
      outDir,
    };

    switch (name) {
      case 'bank':
        reports.push(await runBankWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'append':
        reports.push(
          await runListAppendWorkload({
            ...base,
            pgUrl: options.pgUrl,
            ...(options.elleCliPath ? { elleCliPath: options.elleCliPath } : {}),
          }),
        );
        break;
      case 'workflow':
        reports.push(await runWorkflowFencingWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'outbox':
        reports.push(await runEventDeliveryWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'replica':
        reports.push(
          await runReplicaRywWorkload({
            ...base,
            pgUrl: options.pgUrl,
            ...(options.replicaPgUrl ? { replicaPgUrl: options.replicaPgUrl } : {}),
          }),
        );
        break;
      case 'tenant':
        reports.push(await runTenantIsolationWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'pgbouncer':
        reports.push(
          await runPgBouncerWorkload({
            ...base,
            pgUrl: options.pgUrl,
            ...(options.pgbouncerPgUrl ? { pgbouncerUrl: options.pgbouncerPgUrl } : {}),
          }),
        );
        break;
      case 'ddl':
        reports.push(await runDdlEpochWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'cache':
        reports.push(await runValkeyCacheWorkload({ ...base, pgUrl: options.pgUrl, valkeyUrl: options.valkeyUrl! }));
        break;
      case 'proposals':
        reports.push(await runProposalsLiveWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'failover':
        reports.push(
          await runFailoverWorkload({
            ...base,
            pgUrl: options.pgUrl,
            ...(options.replicaPgUrl ? { replicaPgUrl: options.replicaPgUrl } : {}),
          }),
        );
        break;
      case 'support-lease':
        reports.push(await runSupportLeaseWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'http-cluster':
        reports.push(await runHttpClusterWorkload({ ...base, pgUrl: options.pgUrl }));
        break;
      case 'sqlite-crash':
        reports.push(await runSqliteCrashWorkload(base));
        break;
      case 'retry-storm':
        reports.push(await runRetryStormWorkload(base));
        break;
    }
    const last = reports[reports.length - 1];
    console.log(`[jepsen] workload=${name} verdict=${last.valid ? 'PASS' : 'FAIL'} (${last.durationMs} ms)`);
  }

  const markdown = formatMarkdownReport(options, outDir, reports, skipped);
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify(
      {
        options: {
          ...options,
          pgUrl: options.pgUrl ? '<redacted>' : '',
          replicaPgUrl: options.replicaPgUrl ? '<redacted>' : undefined,
          pgbouncerPgUrl: options.pgbouncerPgUrl ? '<redacted>' : undefined,
          valkeyUrl: options.valkeyUrl ? '<redacted>' : undefined,
        },
        skipped,
        reports,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(join(outDir, 'report.md'), markdown, 'utf8');

  console.log('\n' + markdown);
  return reports.every((r) => r.valid) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
