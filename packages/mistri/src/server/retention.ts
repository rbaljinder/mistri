/**
 * Retention, run: the daily built-in job that forgets what the App's
 * `retention` says is old (shared/appRetention.ts). Every store that wants
 * pruning has registered a rule with the pruner (adapters/retention/pruner.ts);
 * this job runs those rules against each database the App keeps runtime
 * tables in, under the windows the App declared.
 *
 * It is a built-in job (jobs/jobHost.ts), so the job host's rule that one
 * runner holds each slot is what makes it run once a day however many
 * processes serve the App. A database that does not hold a rule's table is
 * skipped, and one that cannot be reached does not stop the others: the run
 * goes on and then fails with the first error, so the job store records it.
 */
import { DatabaseSync } from 'node:sqlite';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
// The stores register their rules as their modules load; a job that runs before any store was
// opened must still see them.
import '../adapters/history/recordHistory.js';
import '../adapters/jobs/jobStoreSchema.js';
import '../adapters/events/eventDeliverySchema.js';
import '../adapters/commands/commandJournalSchema.js';
import {
  mysqlPruneDb,
  pruneAll,
  postgresPruneDb,
  prunes,
  sqlitePruneDb,
  type PruneOptions,
  type PruneRule,
} from '../adapters/retention/pruner.js';
import { retentionMs, type AppRetention } from '../shared/appRetention.js';
import { storeTargetOf, type StoreTarget } from './commands/appCommandEvents.js';
import type { BuiltInJob } from './jobs/jobHost.js';
import { nextSlot, parseEvery } from './jobs/jobSchedule.js';

/** Once a day, at a minute no other built-in job picks (the files sweep spreads by App; decisions run every six hours). */
const RETENTION_EVERY = '41 4 * * *';

/**
 * Where a rule may run. A store target is a database that holds a job store or a command journal; MySQL
 * holds neither, but it does hold record history, which is why retention names it where the stores do not.
 */
type RetentionTarget = StoreTarget | Readonly<{ mysql: string }>;

/** The database a connection URL names for pruning: the store target, or a MySQL one. */
export function retentionTargetOf(url: string | undefined): RetentionTarget | undefined {
  if (typeof url === 'string' && /^(mysql|mariadb):\/\//i.test(url.trim())) return Object.freeze({ mysql: url.trim() });
  return storeTargetOf(url);
}

/** A MySQL database's statements, over one connection of their own that closes with the run. */
async function pruneMysql(url: string, which: readonly PruneRule[], windows: ReturnType<typeof retentionMs>, options: PruneOptions) {
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier).catch(() => {
    throw new Error('MySQL support needs the "mysql2" package. Install it with: npm install mysql2');
  })) as {
    createConnection?: (options: unknown) => Promise<Parameters<typeof mysqlPruneDb>[0] & { end(): Promise<void> }>;
    default?: { createConnection?: (options: unknown) => Promise<Parameters<typeof mysqlPruneDb>[0] & { end(): Promise<void> }> };
  };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error('Could not find a createConnection export in the "mysql2" package.');
  const db = await createConnection({ uri: url.replace(/^mariadb:/i, 'mysql:'), multipleStatements: false, timezone: 'Z' });
  try {
    await pruneAll(mysqlPruneDb(db), which, windows, options);
  } finally {
    await db.end().catch(() => {});
  }
}

interface RetentionJobOptions extends Pick<PruneOptions, 'now' | 'sleep' | 'batch' | 'pauseMs'> {
  /** The App's declared windows; absent, every window is its default. */
  readonly retention?: AppRetention;
  /** Every database the App keeps runtime tables in. */
  readonly targets: readonly RetentionTarget[];
  /** The rules to run; every registered one by default. */
  readonly rules?: () => readonly PruneRule[];
}

/** The built-in job: every rule, on every target, under the App's windows. */
export function retentionJob(options: RetentionJobOptions): BuiltInJob {
  const { retention, targets, rules = prunes, ...prune } = options;
  const seen = new Set<string>();
  const distinct = targets.filter((target) => {
    const key =
      'sqlite' in target ? `sqlite:${target.sqlite}` : 'mysql' in target ? `mysql:${target.mysql}` : `postgres:${target.postgres}`;
    return !seen.has(key) && seen.add(key);
  });
  return Object.freeze({
    id: 'mistri-retention',
    every: parseEvery(RETENTION_EVERY, 'UTC'),
    async run() {
      const windows = retentionMs(retention);
      let failure: unknown;
      for (const target of distinct) {
        try {
          if ('sqlite' in target) {
            const db = new DatabaseSync(target.sqlite);
            try {
              db.exec('PRAGMA busy_timeout = 5000');
              await pruneAll(sqlitePruneDb(db), rules(), windows, prune);
            } finally {
              db.close();
            }
          } else if ('mysql' in target) {
            await pruneMysql(target.mysql, rules(), windows, prune);
          } else {
            const connections = new PgConnectionManager(target.postgres, undefined, undefined, { readers: 1, writers: 1 });
            try {
              await pruneAll(postgresPruneDb(connections), rules(), windows, prune);
            } finally {
              await connections.close();
            }
          }
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    },
  });
}

/** True when any window prunes: all three at 'forever' is the one declaration that asks for nothing. */
export function retentionPrunes(retention?: AppRetention): boolean {
  const windows = retentionMs(retention);
  return windows.history !== null || windows.commands !== null || windows.attempts !== null;
}

/**
 * The retention job on its own clock, for an App that declares no jobs and so opens no job host to schedule it
 * (a job host needs a job store, and an App without jobs has none). The same job, the same daily minute, run
 * in this process. There is no slot lease here, so two processes may both prune on a day; the prune is batched
 * and idempotent, so the second finds little to do. The timer is unref'd and `stop()` cancels it.
 */
export function startRetentionTimer(
  job: BuiltInJob,
  options: { readonly now?: () => number; readonly onError?: (error: unknown) => void } = {},
): { stop(): void } {
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error: unknown) => console.error(`mistri: retention failed: ${(error as Error)?.message ?? error}`));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const at = nextSlot(job.every, now());
    if (at === undefined) return;
    // Past the setTimeout ceiling (about 24.8 days) the wait is taken in pieces.
    timer = setTimeout(
      () => {
        if (stopped) return;
        job.run().then(arm, (error: unknown) => {
          onError(error);
          arm();
        });
      },
      Math.min(Math.max(at - now(), 0), 2 ** 31 - 1),
    );
    timer.unref();
  };
  arm();
  return Object.freeze({
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });
}
