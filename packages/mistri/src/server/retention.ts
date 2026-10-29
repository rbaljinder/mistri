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
import { SMALL_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { DatabaseSync } from 'node:sqlite';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
// The stores register their rules as their modules load; a job that runs before any store was
// opened must still see them.
import '../adapters/history/recordHistory.js';
import '../adapters/jobs/jobStoreSchema.js';
import '../adapters/events/eventDeliverySchema.js';
import '../adapters/commands/commandJournalSchema.js';
import { pruneAll, postgresPruneDb, prunes, sqlitePruneDb, type PruneOptions, type PruneRule } from '../adapters/retention/pruner.js';
import { retentionMs, type AppRetention } from '../shared/appRetention.js';
import type { StoreTarget } from './commands/appCommandEvents.js';
import type { BuiltInJob } from './jobs/jobHost.js';
import { nextSlot, parseEvery } from './jobs/jobSchedule.js';

/** Once a day, at a minute no other built-in job picks (the files sweep spreads by App; decisions run every six hours). */
const RETENTION_EVERY = '41 4 * * *';

interface RetentionJobOptions extends Pick<PruneOptions, 'now' | 'sleep' | 'batch' | 'pauseMs'> {
  /** The App's declared windows; absent, every window is its default. */
  readonly retention?: AppRetention;
  /** Every database the App keeps runtime tables in. */
  readonly targets: readonly StoreTarget[];
  /** The rules to run; every registered one by default. */
  readonly rules?: () => readonly PruneRule[];
}

/** The built-in job: every rule, on every target, under the App's windows. */
export function retentionJob(options: RetentionJobOptions): BuiltInJob {
  const { retention, targets, rules = prunes, ...prune } = options;
  const seen = new Set<string>();
  const distinct = targets.filter((target) => {
    const key = 'sqlite' in target ? `sqlite:${target.sqlite}` : `postgres:${target.postgres}`;
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
          } else {
            const connections = new PgConnectionManager(target.postgres, undefined, undefined, SMALL_STORE_POOL);
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
