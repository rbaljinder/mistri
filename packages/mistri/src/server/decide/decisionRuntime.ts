/**
 * Opening what a job host decides with: the decision store on the jobs'
 * source (provisioned beside the job store, attested here, never created by
 * serving), decisions.lock as it is now, and each decision's contract.
 *
 * The lock is read once, at start: a pin written by `mistri decide eval
 * --pin` applies from the next start, as authority.lock's changes do.
 */
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { BuiltInJob } from '../jobs/jobHost.js';
import { JobDeclarationError } from '../jobs/jobModule.js';
import { parseEvery } from '../jobs/jobSchedule.js';
import { decisionDigests } from './decisionCheck.js';
import type { DecisionRuntime } from './decideHost.js';
import { decisionLockPath, readDecisionLock, readDecisionLockFile } from './decisionLock.js';
import type { CapturedDecision } from './decisionModule.js';

export async function openDecisionRuntime(
  options: Readonly<{
    decisions: ReadonlyMap<string, CapturedDecision>;
    commands: BusinessCommandRegistry;
    target: StoreTarget;
    /** Where decisions.lock is kept; absent, there is none, and every decision only suggests. */
    directory?: string;
    schema: () => Promise<DatabaseSchema>;
    tenancy: boolean;
    callsPerDay?: (tenant: string) => number | undefined;
    /** The maintenance step named in the refusal. */
    provisioning?: string;
  }>,
): Promise<DecisionRuntime> {
  let store: DecisionRuntime['store'];
  try {
    store =
      'postgres' in options.target
        ? await (await import('../../adapters/decide/postgresDecisions.js')).openPostgresDecisions(options.target.postgres)
        : (await import('../../adapters/decide/sqliteDecisions.js')).openSqliteDecisions(options.target.sqlite);
  } catch (error) {
    throw new JobDeclarationError(
      `Jobs: the decision store on the jobs' source could not be opened and attested (${(error as Error).message}). ` +
        `Provision it once, with the server stopped, through ${options.provisioning ?? "`mistri migrate stores up --app <the App's directory> --jobs <file>`, or provisionStores with the App and its jobs from @mistriwork/mistri/maintenance"}.`,
    );
  }
  return {
    store,
    lock: readDecisionLock(options.directory === undefined ? undefined : readDecisionLockFile(decisionLockPath(options.directory))),
    digests: decisionDigests(options.decisions.values(), options.commands),
    schema: options.schema,
    tenancy: options.tenancy,
    ...(options.callsPerDay ? { callsPerDay: options.callsPerDay } : {}),
  };
}

/** How long a decision row is kept (design §3, ordinary Apps); usage rows stay, for the bill. */
const DECISION_RETENTION_DAYS = 365;
/** A suggestion nobody took is ignored after this long (design §2). */
const SUGGESTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The six-hourly sweep: rows past retention removed, suggestions past
 * fourteen days ignored (`expired`). A built-in job of the host's, so one
 * process runs each slot however many serve the App.
 */
export function decisionRetention(
  runtime: DecisionRuntime,
  appId: string,
  options: Readonly<{ retentionDays?: number; now?: () => number }> = {},
): BuiltInJob {
  const now = options.now ?? Date.now;
  const days = options.retentionDays ?? DECISION_RETENTION_DAYS;
  return Object.freeze({
    id: 'mistri-decisions-retention',
    every: parseEvery('17 */6 * * *', 'UTC'),
    async run() {
      const at = now();
      await runtime.store.purge(
        appId,
        new Date(at - days * DAY_MS).toISOString(),
        new Date(at - SUGGESTION_DAYS * DAY_MS).toISOString(),
        new Date(at).toISOString(),
      );
    },
  });
}
