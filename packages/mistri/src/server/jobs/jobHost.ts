/**
 * The `--jobs` host: the one loop owner in a process. It opens the job store
 * and one delivery store per job destination on the jobs' source, activates
 * one publisher per destination and one runner, and drives them with a
 * `setTimeout` chain, never `setInterval`: again at once after work, and
 * never two cycles at a time. A command in this process that writes facts,
 * or a job enqueued here, wakes it (commandEventSignal.ts), and on
 * PostgreSQL so does one in any other process, by LISTEN/NOTIFY
 * (postgresCommandEventWake.ts), so new work is picked up at once.
 *
 * Idle, it waits for the next thing due, which an idle cycle reads in one
 * statement per store (`standing`): a job's `runAt`, a retry, a lease running
 * out, the next slot of a job at times, the next timer sweep. While it hears
 * every write — PostgreSQL with its LISTEN in place, and no flow tail, whose
 * history rows announce nothing — that is the whole wait, up to a fallback of
 * minutes (`QUIET_MS`). Otherwise (SQLite, which another process may write;
 * a listener down or behind a transaction-mode pooler; work past due that
 * the cycle could not take) it polls: a second, then twice as long each
 * time nothing moved, up to a ceiling (`nextIdleWait`). An idle cycle once
 * polled a second apart, some sixty statements a second against a metered
 * PostgreSQL doing nothing; its readiness snapshot inspected pages of waiting
 * rows, each verified against its attempt history, every five seconds.
 *
 * A publisher or runner that halts stays halted; readiness says so, and a
 * restart is the recovery. Recreating one in-process would evade the bounds
 * that halted it. Shutdown runs in one order: stop claiming, halt the runner
 * (aborting in-flight command signals), stop the publishers, close the
 * stores; the caller then closes the adapters.
 */
import type { EventDeliveryStore } from '../../adapters/events/eventDeliveryContract.js';
import type { FlagRequestRuntime } from '../flags/requestRuntime.js';
import { onCommandEvents } from '../../adapters/events/commandEventSignal.js';
import { listenForCommandEvents, wakeListenUrl, type CommandEventListener } from '../../adapters/events/postgresCommandEventWake.js';
import { openSqliteEventDeliveryStore } from '../../adapters/events/eventDeliveryStore.js';
import { openPostgresEventDeliveryStore } from '../../adapters/events/postgresEventDeliveryStore.js';
import { openSqliteJobStore } from '../../adapters/jobs/jobStore.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import { openPostgresJobStore } from '../../adapters/jobs/postgresJobStore.js';
import { openSqliteWorkflowStore } from '../../adapters/workflows/workflowStore.js';
import type { WorkflowStore } from '../../adapters/workflows/workflowStoreContract.js';
import { openPostgresWorkflowStore } from '../../adapters/workflows/postgresWorkflowStore.js';
import { workflowHandlers, workflowTransport, type WebhookSource } from '../workflows/workflowHost.js';
import { decisionHandlers } from '../decide/decideHost.js';
import { connectionFailure } from '../storeConnection.js';
import { workflowJobId } from '../workflows/workflowKeys.js';
import { createWorkflowOperator, type WorkflowOperator } from '../workflows/workflowOperator.js';
import { deliveryQueueOperator, jobQueueOperator, type DeliveryQueueOperator, type JobQueueOperator } from '../operations/queueOperator.js';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import type { AppDef } from '../../shared/app.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import { bindHttpBusinessCommands } from '../commands/businessCommandLoader.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { activateEventProducer, type EventProducer } from '../events/eventProducer.js';
import type { ReadinessCheckInput, ReadinessCode } from '../operations/operations.js';
import { createJobAuthorizer } from './jobAuthorization.js';
import {
  everySlotKey,
  everyTenantSlotKey,
  jobHandlers,
  jobTransport,
  type JobAttemptBinding,
  type JobCommandBinding,
} from './jobCommands.js';
import { JOB_SERVICE_ID, type JobDeployment } from './jobLoader.js';
import { JobDeclarationError, type CapturedJob, type CapturedJobModule, type MachineTimer } from './jobModule.js';
import { createJobRunner, type JobAuthorizationRequest, type JobAuthorizer } from './jobRunner.js';
import { defineJobHandler, JobRejected, type AnyJobDefinition } from './jobs.js';
import { latestSlot, nextSlot, type JobEvery } from './jobSchedule.js';
import { createHash } from 'node:crypto';
import { attemptEnded, enqueueManualRun, findRun, jobToRun } from './jobManualRun.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { createFlowTail, type FlowChangeReader } from '../workflows/flowTail.js';
import { flowRunsAccess, provideFlowRuns } from '../workflows/flowRuns.js';

interface JobHostOptions {
  readonly module: CapturedJobModule;
  readonly deployment: JobDeployment;
  readonly target: StoreTarget;
  /** A direct PostgreSQL URL to hold `LISTEN` on when `target` goes through a transaction-mode pooler, which cannot. */
  readonly listen?: string;
  /** The registry the App's commands are registered in: a workflow's steps run commands by name, at the versions it holds. */
  readonly commands?: BusinessCommandRegistry;
  /** The webhook connections a workflow's `w.call` reaches, by name. */
  readonly webhooks?: WebhookSource;
  /** The App as it is loaded now: each attempt is authorized against it. */
  readonly app: () => AppDef;
  /** A command binding for one attempt: over the current App, or a tenant App's service principal. */
  readonly bind: JobAttemptBinding;
  /** A further condition every attempt meets, asked after its grants and before
   * its handler: a tenant App's jobs ask that the anchors their command fences
   * are active, and keep the versions they read for the attempt's fence. */
  readonly admit?: (request: JobAuthorizationRequest) => Promise<boolean>;
  /** The maintenance steps that provision the stores, named in the refusal. */
  readonly provisioning?: string;
  /** Injected in tests. PostgreSQL stores then keep the caller's clock rather than the database's. */
  readonly now?: () => number;
  /** The first wait after an idle cycle. */
  readonly idleMs?: number;
  /** The longest an idle host waits between cycles: given, it bounds the wait for what is due too. */
  readonly maxIdleMs?: number;
  /** false: only another process's wake reaches it. Tests use it to prove LISTEN/NOTIFY alone. */
  readonly wakeInProcess?: false;
  /** A tenant App's active tenants, asked at each slot of a job at times with
   * `realm: 'tenant'`: each gets its own run, carrying its tenant. */
  readonly tenants?: () => Promise<readonly string[]>;
  /** The new history rows of the resources whose flows a runner of this module runs (workflows/flowTail.ts). */
  readonly flowChanges?: FlowChangeReader;
  /** The records a machine timer is due on: in its state since at or before `cutoff` (appMachine.ts `after`).
   * On a tenant App each carries the tenant its row's owner column names, read by the server (tenantJobs.ts). */
  readonly sweep?: (
    timer: MachineTimer,
    cutoff: Date,
    /** The principal the timer's job runs as: under a row policy, the records it may find are its. */
    runAs: string,
  ) => Promise<readonly Readonly<{ key: Readonly<Record<string, string | number>>; since: string; tenantId?: string }>[]>;
  /** The server's own work at times, beside the module's jobs (a bucket's daily sweep). */
  readonly builtIn?: readonly BuiltInJob[];
  /** What the module's decisions decide with (decide/decideHost.ts): their `decide-` jobs run through it. */
  readonly decide?: import('../decide/decideHost.js').DecisionRuntime;
}

/**
 * Work the server schedules for itself, beside an App's jobs: enqueued slot
 * by slot as a job at times is, under the key every process computes alike,
 * so the store keeps one run of each slot and one runner holds it at a time
 * (its lease); run by the same runner, granted by the server rather than a
 * principal, since no command and no person is behind it.
 */
export interface BuiltInJob {
  /** Outside every App's job names: `mistri-…`. */
  readonly id: string;
  readonly every: JobEvery;
  /** 'tenant': on a tenant App's host, one run per active tenant at each slot, given its tenant. */
  readonly realm?: 'tenant';
  run(tenantId?: string): Promise<void>;
}
/** A built-in job's actor in the job store's provenance. */
const BUILT_IN_ACTOR = 'service:mistri';

/** How often a machine timer looks for the records that have waited long enough. */
const SWEEP_MS = 60_000;

export interface JobHost {
  /** The `jobs` and `events.delivery` checks, from the last snapshot and the live worker states. */
  readiness(): readonly ReadinessCheckInput[];
  /** The instances an operator may list, cancel and retry; present when the module declares workflows. */
  readonly workflows?: WorkflowOperator;
  /** The job store and each delivery destination, as an operator lists and redrives them (the Console's Operations room). */
  readonly queue: Readonly<{ jobs: JobQueueOperator; deliveries: readonly DeliveryQueueOperator[] }>;
  /** One cycle: each publisher delivers what is due, then the runner claims. True when anything moved. */
  tick(): Promise<boolean>;
  start(): void;
  /** Look again soon, and poll from the shortest wait: something may have been written. */
  wake(): void;
  /**
   * A job at times run once now, as its next slot would run it — the same runner, principal and grants, at the
   * host's clock, a manual run as `mistri jobs run` enqueues one (jobManualRun.ts) — and the attempt's end: for a
   * test (testing/host.ts `runJob`), never on a schedule's behalf.
   */
  runNow(job: string, timeoutMs?: number): Promise<Readonly<{ state: string; code: string | null }>>;
  stop(): Promise<void>;
}

/** The longest an idle host that polls waits between cycles, unless told otherwise. */
const MAX_IDLE_MS = 30_000;
/** The longest an idle host that hears every write waits: a fallback, for a notification lost with its connection. */
const QUIET_MS = 5 * 60_000;

/** The wait before the next cycle: none after work, else double the last idle wait, from `idleMs` up to `maxIdleMs`. */
export function nextIdleWait(last: number | undefined, worked: boolean, idleMs: number, maxIdleMs: number): number {
  if (worked) return 0;
  const ceiling = Math.max(idleMs, maxIdleMs);
  return last === undefined || last <= 0 ? idleMs : Math.min(ceiling, last * 2);
}

/** How soon a wake looks: long enough for the writing transaction to have committed, usually. */
const WAKE_MS = 50;

/** An attempt's command binding over the registry's sources and the App
 * loaded now, exactly as an HTTP command request binds; its leases are
 * returned when the attempt ends. A row-policy App's attempt is its
 * principal's under the policy instead: the commands bound to the rows the
 * policy gives `service:<runAs>`, held until the attempt releases them. */
export function registryJobBinding(
  options: Readonly<{
    registry: Registry;
    app: () => AppDef;
    owner: string;
    commands: BusinessCommandRegistry;
    events?: CommandJournalAppScope;
    flagRuntime?: () => FlagRequestRuntime | undefined;
    /** A row-policy App's policy as it serves now: absent while it restarts after a save. */
    policy?: () => HttpAppPolicy | undefined;
  }>,
): (context?: Parameters<JobAttemptBinding>[0], runAs?: string) => Promise<JobCommandBinding> {
  const { registry, flagRuntime } = options;
  return async (context, runAs) => {
    const releases: Array<() => void> = [];
    let active = true;
    const generation = Object.freeze({});
    const assertCurrent = () => {
      if (!active || context?.signal.aborted) throw new Error('Job attempt retired.');
    };
    const release = () => {
      active = false;
      for (const done of releases.splice(0).reverse()) done();
    };
    try {
      let binding: JobCommandBinding['binding'];
      if (options.policy) binding = await policyBinding(options.policy(), runAs, (done) => releases.push(done));
      else {
        const app = options.app();
        const resources = await loadAppRuntimeResources(registry, app, options.owner, (id) => releases.push(registry.lease(id)));
        binding = bindHttpBusinessCommands(
          app,
          options.commands,
          resources,
          (id) => registry.configOf(id)?.writable === true,
          options.events,
        ).binding;
      }
      return {
        binding,
        release,
        async captureFlags(actor) {
          assertCurrent();
          const runtime = flagRuntime?.();
          if (!runtime) return undefined;
          if (actor.kind !== 'service') throw new Error('Service attempt required.');
          const capture = await runtime.attempt(generation, {
            actor: { ...actor, kind: 'service' },
            generation,
            realm: 'app',
            tenantId: null,
            assertCurrent,
            current: async () => assertCurrent(),
          });
          return capture.captureFlags(actor);
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  };
}

/**
 * A service's commands under the row policy, for as long as the attempt holds
 * them: the policy's own invocation stays open until `hold`'s release runs,
 * so retiring the policy waits for the attempt, and the attempt's commands
 * are refused once it ends. A principal the policy does not name is refused
 * for good; a policy that is restarting, or a resolveRows that threw, is
 * tried again on the job's own retries.
 */
async function policyBinding(
  policy: HttpAppPolicy | undefined,
  runAs: string | undefined,
  hold: (release: () => void) => void,
): Promise<JobCommandBinding['binding']> {
  if (!policy) throw new Error('The row policy is starting again; the attempt is tried again.');
  if (runAs === undefined || !policy.services.includes(runAs)) throw new AppAccessDenied();
  let end!: () => void;
  const ended = new Promise<void>((resolve) => (end = resolve));
  hold(end);
  return await new Promise<JobCommandBinding['binding']>((resolve, reject) => {
    let bound = false;
    policy
      .withService(runAs, async (_context, commands) => {
        if (!commands) throw new AppAccessDenied();
        bound = true;
        resolve(commands);
        await ended;
      })
      .catch((error: unknown) => {
        // Once bound, a failure is the command's own, already answered to the attempt.
        if (!bound)
          reject(
            error instanceof AppAccessDenied
              ? new Error('The row policy did not give the service its rows; the attempt is tried again.')
              : error,
          );
      });
  });
}

/** Deliveries one publisher may make in a cycle before the runner's turn. */
const DELIVERIES_PER_CYCLE = 16;
/** How often, at most, the readiness snapshot reads the stores. */
const SNAPSHOT_MS = 5_000;
/** Due work older than this many leases is a backlog. */
const BACKLOG_LEASES = 5;

export async function openJobHost(options: JobHostOptions): Promise<JobHost> {
  const { module, deployment, target } = options;
  const builtIn = options.builtIn ?? [];
  for (const job of builtIn)
    if (module.jobs.has(job.id) || !job.id.startsWith('mistri-'))
      throw new JobDeclarationError(`Jobs: "${job.id}" is the server's own job; an App's jobs are named otherwise.`);
  const now = options.now ?? Date.now,
    idleMs = options.idleMs ?? 1_000,
    maxIdleMs = options.maxIdleMs ?? MAX_IDLE_MS,
    quietMs = options.maxIdleMs ?? QUIET_MS;
  const clock = options.now ? ('caller' as const) : ('database' as const);
  // A tenant App's host is the one that knows its tenants: its workflows keep each tenant's instances apart.
  const tenancy = options.tenants !== undefined;
  const pg = 'postgres' in target ? new PgConnectionManager(target.postgres) : undefined;
  const deliveries: Array<{ job: string; store: EventDeliveryStore; producer: EventProducer; kind: 'job' | 'workflow'; name: string }> = [];
  let opened: JobStore | undefined;
  let workflows: WorkflowStore | undefined;
  try {
    const store = pg
      ? await openPostgresJobStore(pg, deployment.store, { clock })
      : openSqliteJobStore((target as { sqlite: string }).sqlite, deployment.store);
    opened = store;
    if (module.workflows.size) {
      // One App's instances on a shared database: the workflow store shares the job store's namespace.
      workflows = pg
        ? await openPostgresWorkflowStore(pg, deployment.store.namespace)
        : openSqliteWorkflowStore((target as { sqlite: string }).sqlite);
      for (const { workflow, policy } of deployment.workflowDestinations) {
        const delivery = pg
          ? await openPostgresEventDeliveryStore(pg, policy, { clock })
          : openSqliteEventDeliveryStore((target as { sqlite: string }).sqlite, policy);
        try {
          deliveries.push({
            job: workflowJobId(workflow),
            kind: 'workflow',
            name: workflow,
            store: delivery,
            producer: activateEventProducer(delivery, {
              enrollment: { source: deployment.events, producerId: JOB_SERVICE_ID, correlationNamespace: JOB_SERVICE_ID },
              transport: workflowTransport({
                workflow: module.workflows.get(workflow)!,
                workflows,
                jobs: store,
                appId: deployment.appId,
                now,
                tenancy,
              }),
              clock: now,
            }),
          });
        } catch (error) {
          await delivery.close().catch(() => {});
          throw error;
        }
      }
    }
    for (const { job, policy } of deployment.destinations) {
      const delivery = pg
        ? await openPostgresEventDeliveryStore(pg, policy, { clock })
        : openSqliteEventDeliveryStore((target as { sqlite: string }).sqlite, policy);
      try {
        deliveries.push({
          job,
          kind: 'job',
          name: job,
          store: delivery,
          producer: activateEventProducer(delivery, {
            enrollment: { source: deployment.events, producerId: JOB_SERVICE_ID, correlationNamespace: JOB_SERVICE_ID },
            transport: jobTransport({ job: module.jobs.get(job)!, store, appId: deployment.appId, now }),
            clock: now,
          }),
        });
      } catch (error) {
        await delivery.close().catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    for (const { producer } of deliveries) await producer.stop().catch(() => {});
    await opened?.close().catch(() => {});
    await workflows?.close().catch(() => {});
    await pg?.close().catch(() => {});
    const unreachable = connectionFailure(error);
    if (unreachable !== undefined) {
      throw new JobDeclarationError(
        `Jobs: the database for source "${deployment.sourceId}" could not be reached (${unreachable}). The stores are not the problem; ` +
          'fix the connection (the server may be refusing connections, or out of them) and start again.',
      );
    }
    throw new JobDeclarationError(
      `Jobs: the job store or event delivery on source "${deployment.sourceId}" could not be opened and attested. ` +
        `Provision them once, with the server stopped, through ${options.provisioning ?? "`mistri migrate stores up --app <the App's directory> --jobs <file>`, or provisionStores with the App and its jobs from @mistriwork/mistri/maintenance"}.`,
    );
  }
  const jobs = opened;
  const granted = createJobAuthorizer({
    module,
    appId: deployment.appId,
    app: options.app,
    attemptTimeoutMs: deployment.attemptTimeoutMs,
    now,
  });
  const admit = options.admit;
  const runner = createJobRunner({
    store: jobs,
    now,
    attemptTimeoutMs: deployment.attemptTimeoutMs,
    registry: jobHandlers({
      module,
      appId: deployment.appId,
      bind: options.bind,
      ...(workflows || builtIn.length || options.decide
        ? {
            extra: {
              ...builtInHandlers(builtIn),
              ...(options.decide
                ? decisionHandlers({
                    module,
                    appId: deployment.appId,
                    app: options.app,
                    bind: options.bind,
                    jobs,
                    runtime: options.decide,
                  })
                : {}),
              ...(workflows
                ? workflowHandlers({
                    module,
                    appId: deployment.appId,
                    bind: options.bind,
                    commands: options.commands ?? {},
                    webhooks: options.webhooks ?? { get: () => undefined },
                    workflows,
                    jobs,
                    now,
                    attemptTimeoutMs: deployment.attemptTimeoutMs,
                    tenancy,
                  })
                : {}),
            },
          }
        : {}),
    }),
    authorize: builtInGrants(
      builtIn,
      deployment.appId,
      () => now() + deployment.attemptTimeoutMs,
      admit
        ? async (request) => {
            const grant = await granted(request);
            return grant && (await admit(request)) ? grant : null;
          }
        : granted,
    ),
  });

  const flowRunners = new Map(
    [...module.workflows.values()].flatMap((workflow) =>
      workflow.flows ? [[workflow.flows.resource, { workflow: workflow.name, runAs: workflow.runAs }] as const] : [],
    ),
  );
  let withdrawFlowRuns: (() => void) | undefined;
  const flowTail =
    workflows && options.flowChanges ? createFlowTail({ read: options.flowChanges, jobs, appId: deployment.appId, now }) : undefined;

  let stopping = false;
  let stopped: Promise<void> | undefined;
  let active: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pressure = new Set<string>();

  type Check = ReadinessCheckInput;
  const check = (name: string, code: ReadinessCode): Check =>
    Object.freeze({
      name,
      state: code === 'ok' ? 'ready' : code === 'worker_halted' || code === 'shutting_down' ? 'not_ready' : 'degraded',
      code,
    });
  let jobsCheck = check('jobs', 'ok'),
    deliveryCheck = check('events.delivery', 'ok');
  let refreshedAt = Number.NEGATIVE_INFINITY;
  /* From the last standing read: when, on this process's clock, the stores next have something fall due, and
     whether something already due was left waiting. Unknown (a store unavailable) reads as both: poll. */
  let nextDue = Number.POSITIVE_INFINITY;
  let overdue = true;
  /** One statement a store, no row read: what readiness reports and when the next thing falls due. `idle` reads
   * it now — the wait about to begin is sized by it — and a busy host at most every few seconds. */
  async function refresh(idle: boolean): Promise<void> {
    const at = now();
    if (!idle && at - refreshedAt < SNAPSHOT_MS) return;
    refreshedAt = at;
    const wall = Date.now();
    let ahead = Number.POSITIVE_INFINITY,
      behind = false;
    const late = (time: number | null, storeAt: number) => time !== null && time + BACKLOG_LEASES * deployment.store.leaseMs < storeAt;
    const note = (standing: Readonly<{ waitingSince: number | null; next: number | null; at: number }>) => {
      if (standing.next !== null) ahead = Math.min(ahead, wall + Math.max(0, standing.next - standing.at));
      if (standing.waitingSince !== null && standing.waitingSince <= standing.at) behind = true;
    };
    try {
      const standing = await jobs.standing(at);
      note(standing);
      jobsCheck = check('jobs', standing.failed ? 'work_failed' : late(standing.waitingSince, standing.at) ? 'backlog_pressure' : 'ok');
    } catch {
      jobsCheck = check('jobs', 'unknown');
      behind = true;
    }
    try {
      let code: ReadinessCode = 'ok';
      for (const { job, store } of deliveries) {
        // A delivery's 'unknown' is retryable, and counted as waiting; a job's may still hold a handler lease.
        const standing = await store.standing(at);
        note(standing);
        if (standing.failed) code = 'work_failed';
        else if (code === 'ok' && (pressure.has(job) || late(standing.waitingSince, standing.at))) code = 'backlog_pressure';
      }
      deliveryCheck = check('events.delivery', code);
    } catch {
      deliveryCheck = check('events.delivery', 'unknown');
      behind = true;
    }
    nextDue = ahead;
    overdue = behind;
  }

  async function cycle(): Promise<boolean> {
    let worked = false;
    for (const { job, producer } of deliveries) {
      for (let i = 0; i < DELIVERIES_PER_CYCLE && !stopping; i++) {
        const tick = await producer.tick();
        if (tick.pressure) pressure.add(job);
        else if (tick.status === 'idle') pressure.delete(job);
        if (tick.status !== 'accepted' && tick.status !== 'rejected' && tick.status !== 'unknown') break;
        worked = true;
      }
    }
    if (!stopping && flowTail && (await flowTail.tick())) worked = true;
    if (!stopping && (await enqueueSlots())) worked = true;
    if (!stopping && (await runner.tick()).status === 'ran') worked = true;
    if (!stopping) await refresh(!worked);
    return worked;
  }

  /* Jobs at times (jobSchedule.ts): each due slot enqueued once, under a key
     every process computes alike, so the store keeps one run of it however
     many hosts see the minute. After a stop the most recent missed slot is
     the one enqueued; the ones before it are skipped. A store with no run of
     the job yet starts at the next slot instead. */
  const timed: readonly Pick<CapturedJob, 'id' | 'version' | 'every' | 'input' | 'realm' | 'runAs'>[] = [
    ...[...module.jobs.values()].filter((job) => job.every),
    ...builtIn.map((job) => ({
      id: job.id,
      version: BUILT_IN_VERSION,
      every: job.every,
      runAs: BUILT_IN_ACTOR.slice('service:'.length),
      ...(job.realm ? { realm: job.realm } : {}),
    })),
  ];
  const slotDue = new Map<string, number | undefined>();
  /* A machine's timers: each a sweep a minute for the records that have waited
     long enough, each enqueued once per stay — keyed by the record and the
     moment it entered the state — whichever process sees it first. The
     timer's command runs only from that state (its verb), so a record that
     moved on meanwhile is refused and the job ends. */
  const timers = options.sweep ? [...module.jobs.values()].filter((job) => job.timer) : [];
  let swept = Number.NEGATIVE_INFINITY;
  async function sweepTimers(): Promise<boolean> {
    const at = now();
    if (!timers.length || at - swept < SWEEP_MS) return false;
    swept = at;
    let enqueued = false;
    for (const job of timers) {
      let due: Awaited<ReturnType<NonNullable<typeof options.sweep>>>;
      try {
        due = await options.sweep!(job.timer!, new Date(at - job.timer!.ms), job.runAs);
      } catch {
        continue;
      }
      for (const { key, since, tenantId } of due) {
        /* A tenant's stay is that tenant's: its tenant is part of the key, so two
           tenants' records alike in key and moment are two runs, never one. */
        const stay = `after-${createHash('sha256')
          .update(JSON.stringify(tenantId === undefined ? [job.id, key, since] : [job.id, tenantId, key, since]))
          .digest('hex')
          .slice(0, 48)}`;
        try {
          await jobs.enqueue(
            {
              job: job.id,
              version: job.version,
              idempotencyKey: stay,
              input: { key, input: {}, since },
              provenance: {
                appId: deployment.appId,
                actorId: `service:${job.runAs}`,
                ...(tenantId === undefined ? {} : { tenantId }),
                correlationId: stay,
                causationId: stay,
              },
            },
            at,
          );
          enqueued = true;
        } catch {
          /* Unavailable now: the next sweep asks again, under the same key. */
        }
      }
    }
    return enqueued;
  }
  async function enqueueSlots(): Promise<boolean> {
    let enqueued = await sweepTimers();
    for (const job of timed) {
      const at = now();
      const next = slotDue.get(job.id);
      if (next !== undefined && at < next) continue;
      /* A store that holds no run of the job has missed nothing (OP9): its first slot is the next one, so a first
         start never runs a job by surprise. One that holds a run catches up the latest slot it missed. */
      if (next === undefined) {
        let fresh: boolean;
        try {
          fresh = (await jobs.inspect({ job: job.id }, 1)).length === 0;
        } catch {
          continue; // Unavailable now: the next cycle asks again.
        }
        if (fresh) {
          slotDue.set(job.id, nextSlot(job.every!, at));
          continue;
        }
      }
      const slot = latestSlot(job.every!, at);
      if (slot !== undefined && (next === undefined || slot >= next)) {
        /* A tenant App's job per tenant runs once for each tenant active now,
           each carrying its tenant: the one its attempt is admitted in and
           bounded by (tenantJobs.ts). Once on the platform, it carries none. */
        let runs: readonly (string | undefined)[] = [undefined];
        if (job.realm === 'tenant') {
          if (!options.tenants) continue;
          try {
            runs = await options.tenants();
          } catch {
            continue;
          }
        }
        try {
          for (const tenantId of runs) {
            const key = tenantId === undefined ? everySlotKey(slot) : everyTenantSlotKey(slot, tenantId);
            await jobs.enqueue(
              {
                job: job.id,
                version: job.version,
                idempotencyKey: key,
                input: { key: {}, input: job.input ?? {} },
                runAt: slot,
                provenance: {
                  appId: deployment.appId,
                  actorId: `service:${job.runAs}`,
                  ...(tenantId === undefined ? {} : { tenantId }),
                  correlationId: key,
                  causationId: key,
                },
              },
              at,
            );
            enqueued = true;
          }
        } catch {
          continue;
        } // Unavailable now: the next cycle asks again, under the same keys.
      }
      slotDue.set(job.id, nextSlot(job.every!, slot ?? at));
    }
    return enqueued;
  }
  /** How long until the next slot of a job at times, so an idle wait never sleeps past it. */
  const untilSlot = (): number => {
    const next = Math.min(...[...slotDue.values()].filter((value): value is number => value !== undefined));
    return Number.isFinite(next) ? Math.max(0, next - Date.now()) : Number.POSITIVE_INFINITY;
  };
  const tick = (): Promise<boolean> => {
    if (stopping) return Promise.resolve(false);
    return (active ??= cycle().finally(() => {
      active = undefined;
    }));
  };
  /* The last polling wait, which the next one doubles, and when the scheduled
     cycle fires: a wake shortens a long wait and never lengthens a short one. */
  let waited: number | undefined;
  let due = 0;
  /** How long until a machine timer's next sweep, so a quiet wait never sleeps past it. */
  const untilSweep = (): number => (timers.length ? Math.max(0, swept + SWEEP_MS - now()) : Number.POSITIVE_INFINITY);
  /** The wait after a cycle: none after work; for the next thing due while every write is heard; else a poll. */
  const idleWait = (worked: boolean): number => {
    if (worked) {
      waited = 0;
      return 0;
    }
    const hearing = !flowTail && heard?.hearing() === true;
    let wait: number;
    if (hearing && !overdue) {
      waited = 0;
      wait = quietMs;
    } else wait = waited = nextIdleWait(waited, false, idleMs, maxIdleMs);
    return Math.min(wait, untilSlot(), Math.max(0, nextDue - Date.now()), untilSweep());
  };
  /* A wake heard while a cycle runs: that cycle may already have read past
     the fact, so the next one follows at a wake's delay rather than an idle
     wait's — which, with a long idle wait, was the fact left for a minute. */
  let woken = false;
  const after = (worked: boolean): void => {
    const again = woken && !worked;
    woken = false;
    if (!again) {
      schedule(idleWait(worked));
      return;
    }
    // As a wake between cycles does: soon, and the idle waits after it start short.
    schedule(WAKE_MS);
    waited = 0;
  };
  const schedule = (delay: number): void => {
    if (stopping) return;
    due = Date.now() + delay;
    timer = setTimeout(() => {
      timer = undefined;
      woken = false;
      void tick().then(after, () => after(false));
    }, delay);
    // The listener keeps the process alive, not the loop.
    timer.unref?.();
  };
  let started = false;
  let unlisten: (() => void) | undefined;
  let listening: Promise<CommandEventListener | undefined> | undefined;
  /** The listener once its first LISTEN is in place: until then, and without one, the host polls. */
  let heard: CommandEventListener | undefined;
  const wake = (): void => {
    if (!started || stopping) return;
    // The cycle running now looks again soon after it ends, and from then the waits start short again.
    if (!timer) {
      waited = 0;
      woken = true;
      return;
    }
    if (due - Date.now() <= WAKE_MS) {
      waited = 0;
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    schedule(WAKE_MS);
    waited = 0;
  };

  return Object.freeze({
    ...(workflows ? { workflows: createWorkflowOperator({ workflows, jobs, appId: deployment.appId, now, wake: () => wake() }) } : {}),
    queue: Object.freeze({
      jobs: jobQueueOperator(jobs, now, () => wake()),
      deliveries: Object.freeze(deliveries.map(({ kind, name, store }) => deliveryQueueOperator(kind, name, store, now, () => wake()))),
    }),
    readiness(): readonly ReadinessCheckInput[] {
      if (stopping) return Object.freeze([check('jobs', 'shutting_down'), check('events.delivery', 'shutting_down')]);
      return Object.freeze([
        runner.status() === 'running' ? jobsCheck : check('jobs', 'worker_halted'),
        deliveries.every(({ producer }) => producer.status() === 'running') ? deliveryCheck : check('events.delivery', 'worker_halted'),
      ]);
    },
    tick,
    async runNow(name: string, timeoutMs = 30_000) {
      const job = jobToRun(module, name);
      if (typeof job === 'string') throw new JobDeclarationError(`Jobs: ${job}`);
      /* Its own key, not a slot's: the slot the schedule enqueues is still its own, and a run now is a second run,
         after the schedule's if that one holds its lease (jobManualRun.ts). */
      const { id } = await enqueueManualRun(jobs, deployment.appId, job, now());
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await findRun(jobs, job.id, id);
        /* Its first attempt has ended: done, refused, or waiting for a retry, which a test reads as not done. */
        const ended = attemptEnded(found);
        if (ended) return Object.freeze({ state: ended.state, code: ended.lastCode });
        if (Date.now() > deadline)
          throw new Error(`Jobs: "${name}" did not finish within ${timeoutMs}ms (it is ${found?.state ?? 'unknown'}).`);
        if (!(await tick())) await new Promise((done) => setTimeout(done, 25));
      }
    },
    start(): void {
      if (started || stopping) return;
      started = true;
      if (options.wakeInProcess !== false) unlisten = onCommandEvents(wake);
      // The App's record pages show their flows' runs, and start a manual one, through the host that keeps them.
      if (workflows && flowRunners.size)
        withdrawFlowRuns = provideFlowRuns(
          deployment.appId,
          flowRunsAccess({ workflows, jobs, appId: deployment.appId, runners: flowRunners, now, wake: () => wake() }),
        );
      /* Behind a transaction-mode pooler no session keeps a LISTEN: the connection's
         "listen" URL, which skips the pooler, carries it, and without one polling
         alone is the answer, as it is when the first connect fails. */
      const listenUrl = pg ? wakeListenUrl((target as { postgres: string }).postgres, pg.pooler, options.listen) : undefined;
      if (listenUrl) {
        listening = listenForCommandEvents(listenUrl, wake).then(
          (listener) => (stopping ? void listener.close() : (heard = listener)),
          () => undefined,
        );
      }
      schedule(0);
    },
    wake,
    stop(): Promise<void> {
      return (stopped ??= (async () => {
        stopping = true;
        unlisten?.();
        withdrawFlowRuns?.();
        await (await listening)?.close();
        if (timer) clearTimeout(timer);
        await runner.halt();
        for (const { producer } of deliveries) await producer.stop().catch(() => {});
        await active?.catch(() => false);
        await jobs.close().catch(() => {});
        await workflows?.close().catch(() => {});
        // The decision store is the host's once given: its runs are done when the runner halts.
        await options.decide?.store.close().catch(() => {});
        await pg?.close().catch(() => {});
      })());
    },
  });
}

const BUILT_IN_VERSION = 1;

/** The runner's handlers for the server's own jobs: each runs its work, as background work, and takes no input. */
function builtInHandlers(builtIn: readonly BuiltInJob[]): Record<string, AnyJobDefinition> {
  return Object.fromEntries(
    builtIn.map((job) => [
      job.id,
      defineJobHandler<unknown>({
        version: BUILT_IN_VERSION,
        input: { parse: (input: unknown) => input },
        // A run per tenant carries the tenant the host enqueued it for; one without is no run of it.
        handle: (context) => {
          const tenantId = context.provenance.tenantId;
          if (job.realm !== 'tenant') return job.run();
          if (typeof tenantId !== 'string' || !tenantId) throw new JobRejected('A run per tenant names its tenant.');
          return job.run(tenantId);
        },
      }),
    ]),
  );
}

/** The server grants its own jobs, for this App and at their one version; every other job is asked of the App's authorizer. */
function builtInGrants(builtIn: readonly BuiltInJob[], appId: string, expiresAt: () => number, others: JobAuthorizer): JobAuthorizer {
  if (!builtIn.length) return others;
  const ids = new Set(builtIn.map((job) => job.id));
  return (request) =>
    ids.has(request.job)
      ? request.version === BUILT_IN_VERSION && request.provenance.appId === appId && request.provenance.actorId === BUILT_IN_ACTOR
        ? { audience: 'mistri.jobs', job: request.job, version: request.version, appId, expiresAt: expiresAt() }
        : null
      : others(request);
}
