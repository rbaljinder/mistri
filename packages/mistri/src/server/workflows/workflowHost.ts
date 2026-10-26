/**
 * The seams a workflow crosses, on top of the jobs' own.
 *
 * Delivery to the workflow store: the transport a workflow's destination
 * publishes through. An event that starts the workflow starts an instance
 * under the event's id (one live instance per key); every event the workflow
 * names is also recorded as a signal for the instances that may wait on it,
 * and each instance found waiting for it is woken. Both end in the same
 * thing: a wake-up job in the job store, under a key derived from what it is
 * about, so a redelivery or a second host enqueues it once.
 *
 * The job store to the engine: one handler a workflow, `wf-<name>`, whose
 * job input names an instance. Running it advances that instance, and what
 * the advance leaves waiting becomes the next wake-up job: a timer at its
 * time, a retry's back-off, a continuation when the advance yielded. A step's
 * command runs through the binding and executor HTTP and jobs use, as the
 * workflow's principal, under the receipt key of its instance and step.
 */
import { createHash } from 'node:crypto';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { WorkflowStore } from '../../adapters/workflows/workflowStoreContract.js';
import { WorkflowRefusal } from '../../adapters/workflows/workflowStoreTypes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import {
  executeBusinessCommand,
  isBusinessCommandExecutionError,
  lookupBusinessCommandStatus,
} from '../commands/businessCommandExecution.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { callHeaders, type Webhook } from '../commands/commandEffects.js';
import { parseEventPayload } from '../commands/businessEvents.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import type { JobAttemptBinding } from '../jobs/jobCommands.js';
import type { CapturedJob, CapturedJobModule } from '../jobs/jobModule.js';
import { defineJobHandler, JobRejected, type AnyJobDefinition, type JobContext } from '../jobs/jobs.js';
import { advance, type EngineEnvironment } from './workflowEngine.js';
import { stepRequestId, wakeKey, WORKFLOW_JOB_VERSION, workflowJobId, workflowPartition } from './workflowKeys.js';
import { StepRefused, type CapturedWorkflow } from './workflowModule.js';
import { flowCommandId } from './flowCommand.js';

/* A refusal the next try may not repeat: the record moved, the writer was
   busy, or the try ran out of time. Everything else the command refused it
   will refuse again (jobCommands.ts RETRIED, the same classification). */
const RETRIED = new Set(['stale_record', 'temporarily_unavailable', 'row_locked', 'cancelled']);
/* An outside service that answers 408, 429 or 5xx is asked again; any other 4xx is its final word. */
const retriedStatus = (status: number) => status === 408 || status === 429 || status >= 500;

interface WakeInput {
  readonly instance: string;
}
/** A change of a record that may start its flows (jobHost.ts), or a person's start of a manual one. */
export interface FlowDispatch {
  /** What started it, unique to it: a history row, or a manual start. Part of each instance's start id. */
  readonly change: string;
  /** The record's history key, which a run's instance key begins with. */
  readonly record: string;
  /** The value of the record's key. */
  readonly target: string;
  readonly trigger: 'created' | 'updated' | 'manual';
  readonly changed: readonly string[];
  /** A manual start's flow. */
  readonly flow?: string;
}
const wakeInput = (value: unknown): WakeInput => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join() !== 'instance' ||
    typeof (value as WakeInput).instance !== 'string' ||
    !/^[0-9a-f-]{36}$/.test((value as WakeInput).instance)
  )
    throw new Error();
  return Object.freeze({ instance: (value as WakeInput).instance });
};
const CHANGE = /^[A-Za-z0-9:_-]{1,60}$/;
/** A flows runner's job input: a wake-up, or a dispatch the host wrote. Anything else is refused whole. */
const flowsInput = (value: unknown): WakeInput | { dispatch: FlowDispatch } => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'dispatch') return wakeInput(value);
  const given = (value as { dispatch?: unknown }).dispatch as Record<string, unknown> | undefined;
  if (
    !given ||
    typeof given !== 'object' ||
    Object.keys(given).some((key) => !['change', 'record', 'target', 'trigger', 'changed', 'flow'].includes(key)) ||
    typeof given.change !== 'string' ||
    !CHANGE.test(given.change) ||
    typeof given.record !== 'string' ||
    given.record.length > 440 ||
    typeof given.target !== 'string' ||
    !given.target ||
    given.target.length > 512 ||
    !['created', 'updated', 'manual'].includes(given.trigger as string) ||
    !Array.isArray(given.changed) ||
    given.changed.length > 120 ||
    given.changed.some((column) => typeof column !== 'string' || column.length > 128) ||
    (given.flow !== undefined && (typeof given.flow !== 'string' || !given.flow || given.flow.length > 64))
  )
    throw new Error();
  return Object.freeze({ dispatch: Object.freeze({ ...(given as unknown as FlowDispatch) }) });
};

/** Enqueue a wake-up for an instance, carrying its tenant on a tenant App. Idempotent by `key`. */
async function wake(
  jobs: JobStore,
  workflow: CapturedWorkflow,
  appId: string,
  tenantId: string | undefined,
  instance: string,
  key: string,
  now: number,
  runAt?: number,
): Promise<void> {
  await jobs.enqueue(
    {
      job: workflowJobId(workflow.name),
      version: WORKFLOW_JOB_VERSION,
      idempotencyKey: key,
      input: { instance },
      ...(runAt === undefined ? {} : { runAt }),
      provenance: {
        appId,
        actorId: `service:${workflow.runAs}`,
        ...(tenantId === undefined ? {} : { tenantId }),
        correlationId: instance,
        causationId: instance,
      },
    },
    now,
  );
}

/** One workflow destination's transport. `accepted` is the stores' durable acceptance; a duplicate replays what was accepted.
 * `tenancy`: a tenant App's, where each fact is one tenant's, read from its verified envelope: it starts and wakes that tenant's
 * instances alone, in that tenant's partition of the store, and a fact that names no tenant starts and wakes nothing. */
export function workflowTransport(
  options: Readonly<{
    workflow: CapturedWorkflow;
    workflows: WorkflowStore;
    jobs: JobStore;
    appId: string;
    now: () => number;
    tenancy?: boolean;
  }>,
): EventPublicationTransport {
  const { workflow, workflows, jobs, appId, now } = options;
  const startIdentity = `${workflow.start.name}@${workflow.start.version}`;
  return async (publication) => {
    const envelope = publication.envelope;
    const identity = `${envelope.name}@${envelope.version}`;
    // A receipt's other facts reach this destination too; a workflow takes only its own.
    const event = workflow.events.get(identity);
    if (!event) return 'accepted';
    const tenantId = options.tenancy ? (envelope.scope === 'tenant' ? envelope.tenantId : undefined) : undefined;
    // Never without a tenant on a tenant App: such a fact reaches no instance.
    if (options.tenancy && tenantId === undefined) return 'rejected';
    const partition = workflowPartition(workflow.name, tenantId);
    let key: string | undefined;
    if (identity === startIdentity) {
      try {
        const value = workflow.key(parseEventPayload(event, envelope.payloadJson));
        key =
          typeof value === 'string' && value.length && Buffer.byteLength(value) <= 512
            ? value
            : typeof value === 'number' && Number.isSafeInteger(value)
              ? String(value)
              : undefined;
      } catch {
        /* No key: the event cannot start this workflow, and never will. */
      }
    }
    try {
      // Recorded before the start is taken, so a new instance's window opens after this very event
      // (the start event is also skipped by id, for the instance it started).
      const woken = await workflows.signal(
        {
          workflow: partition,
          eventId: envelope.eventId,
          name: envelope.name,
          version: envelope.version,
          payloadJson: envelope.payloadJson,
        },
        now(),
      );
      for (const instance of woken)
        await wake(jobs, workflow, appId, tenantId, instance, wakeKey('signal', instance, envelope.eventId), now());
      if (key !== undefined) {
        const started = await workflows.start(
          { workflow: partition, version: workflow.version, key, eventId: envelope.eventId, startJson: envelope.payloadJson },
          now(),
        );
        // A redelivery finds the instance its first delivery made, and enqueues the same wake-up again.
        if (started) await wake(jobs, workflow, appId, tenantId, started.id, wakeKey('start', started.id), now());
      }
      // Its waiting instances were woken above either way; an event with no key is the one that cannot start.
      return identity === startIdentity && key === undefined ? 'rejected' : 'accepted';
    } catch (error) {
      if (error instanceof WorkflowRefusal) return 'rejected';
      throw error;
    }
  };
}

/** The webhook connections a step may call, by name. */
export interface WebhookSource {
  get(name: string): Webhook | undefined;
}

export interface WorkflowHandlerOptions {
  readonly module: CapturedJobModule;
  readonly appId: string;
  readonly bind: JobAttemptBinding;
  readonly commands: BusinessCommandRegistry;
  readonly webhooks: WebhookSource;
  readonly workflows: WorkflowStore;
  readonly jobs: JobStore;
  readonly now: () => number;
  /** The most one step may take: below the job attempt's own deadline. */
  readonly attemptTimeoutMs: number;
  /** A tenant App's: each wake-up carries its instance's tenant, and the advance reads only that tenant's partition. */
  readonly tenancy?: boolean;
}

/** The runner's handlers for the module's workflows: `wf-<name>`, each advancing one instance. */
export function workflowHandlers(options: WorkflowHandlerOptions): Record<string, AnyJobDefinition> {
  const handlers: Record<string, AnyJobDefinition> = {};
  for (const workflow of options.module.workflows.values()) {
    const actor = serviceActor(options.appId, workflow.runAs, options.module.principals.get(workflow.runAs)!);
    const pseudo = Object.freeze({
      id: workflowJobId(workflow.name),
      version: WORKFLOW_JOB_VERSION,
      runAs: workflow.runAs,
      command: Object.freeze({ id: workflow.name, version: WORKFLOW_JOB_VERSION }),
    }) as CapturedJob;
    /* A flows runner's writes say they are one (flowRunner.ts): the host does not start flows on a change a flow made. */
    const attributed = <T>(work: () => Promise<T>): Promise<T> =>
      workflow.flows ? attributeWrites({ via: 'system', actor: flowActor(workflow.name) }, work) : work();
    handlers[workflowJobId(workflow.name)] = workflow.flows
      ? defineJobHandler<WakeInput | { dispatch: FlowDispatch }>({
          version: WORKFLOW_JOB_VERSION,
          input: { parse: flowsInput },
          handle: (context, input) =>
            asBackgroundWork(() =>
              attributed(() =>
                'dispatch' in input
                  ? dispatchFlows(options, workflow, actor, pseudo, context, input.dispatch)
                  : advanceInstance(options, workflow, actor, pseudo, context, input.instance),
              ),
            ),
        })
      : defineJobHandler<WakeInput>({
          version: WORKFLOW_JOB_VERSION,
          input: { parse: wakeInput },
          handle: (context, input) => asBackgroundWork(() => advanceInstance(options, workflow, actor, pseudo, context, input.instance)),
        });
  }
  return handlers;
}

/** One step's command, run as the workflow's principal through the same binding and door as HTTP's, under its receipt key: its output, or StepRefused. */
async function stepCommand(
  options: WorkflowHandlerOptions,
  actor: ReturnType<typeof serviceActor>,
  pseudo: CapturedJob,
  context: JobContext,
  request: Parameters<EngineEnvironment['runCommand']>[0],
): Promise<unknown> {
  const now = options.now;
  const registered = Object.hasOwn(options.commands, request.command) ? options.commands[request.command] : undefined;
  if (!registered) throw new StepRefused(request.step, 'unknown_command');
  let bound;
  try {
    bound = await options.bind(context, pseudo);
    let authorized;
    try {
      authorized = bound.binding.authorize(request.command, actor);
    } catch {
      throw new StepRefused(request.step, 'forbidden');
    }
    // A scalar target is the value of the target's one key column.
    let key: Readonly<Record<string, string | number>> = {};
    if (request.target !== undefined) {
      const target = request.target;
      if (target !== null && typeof target === 'object' && !Array.isArray(target)) key = target as typeof key;
      else if ((typeof target === 'string' || typeof target === 'number') && authorized.keyColumns.length === 1)
        key = { [authorized.keyColumns[0]]: target };
      else throw new StepRefused(request.step, 'invalid_target');
    } else if (registered.targets !== 'none' && authorized.keyColumns.length) throw new StepRefused(request.step, 'invalid_target');
    const captureFlags = bound.captureFlags;
    const flags = await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
    const command = {
      command: request.command,
      commandVersion: registered.version,
      key,
      // A workflow prepares no form: the command reads its target fresh and names no revision.
      expectedVersion: 0,
      idempotencyKey: request.idempotencyKey,
      input: request.input === undefined ? {} : request.input,
    };
    const attempt = {
      signal: request.signal,
      requestId: stepRequestId(context.jobId, request.step),
      now: () => new Date(now()),
      flags,
    };
    // Status before running: an earlier try may have committed and lost its answer.
    const status = await lookupBusinessCommandStatus(bound.binding, actor, command, attempt);
    if (status.status === 'applied') return status.result;
    return (await executeBusinessCommand(bound.binding, actor, command, { ...attempt, door: 'workflow' })).result;
  } catch (error) {
    if (error instanceof StepRefused) throw error;
    if (error instanceof AppAccessDenied) throw new StepRefused(request.step, 'forbidden');
    if (isBusinessCommandExecutionError(error)) {
      if (RETRIED.has(error.code)) throw new Error(`The step's command answered ${error.code}.`);
      throw new StepRefused(request.step, error.code);
    }
    throw error instanceof Error ? error : new Error('The step failed.');
  } finally {
    bound?.release();
  }
}

async function advanceInstance(
  options: WorkflowHandlerOptions,
  workflow: CapturedWorkflow,
  actor: ReturnType<typeof serviceActor>,
  pseudo: CapturedJob,
  context: JobContext,
  instance: string,
): Promise<unknown> {
  const { jobs, appId } = options,
    now = options.now;
  /* The tenant the wake-up carries, set by this host from a verified envelope
     and kept with it: the instance must be in that tenant's partition, or it
     is not found, and the waits read that partition's signals alone. The
     step's command is bound for the same tenant (options.bind). */
  const tenantId = options.tenancy ? context.provenance.tenantId : undefined;
  if (options.tenancy && tenantId === undefined) throw new JobRejected('The workflow wake-up names no tenant.');
  const partition = workflowPartition(workflow.name, tenantId);
  const workflows: typeof options.workflows = Object.freeze({
    ...options.workflows,
    begin: (id: string, at: number) => options.workflows.begin(id, at, partition),
    signals: (name: string, event: string, version: number, afterSeq: number) =>
      name === workflow.name ? options.workflows.signals(partition, event, version, afterSeq) : Promise.resolve([]),
  });
  const environment: EngineEnvironment = {
    store: workflows,
    workflow,
    now,
    signal: context.signal,
    budgetMs: Math.floor(options.attemptTimeoutMs / 2),
    stepTimeoutMs: Math.max(1_000, options.attemptTimeoutMs - 2_000),

    runCommand: (request) => stepCommand(options, actor, pseudo, context, request),

    async call(request) {
      const webhook = options.webhooks.get(request.connection);
      if (!webhook?.call) throw new StepRefused(request.step, 'unknown_connection');
      /* The engine checked the headers against what every request owns; the connection's own credential header is
         known only here. Naming it is refused, not tried: no retry can make it the step's to send. */
      if (request.request.headers && webhook.credentialHeader) {
        try {
          callHeaders(request.request.headers, webhook.credentialHeader);
        } catch {
          throw new StepRefused(request.step, 'owned_header');
        }
      }
      const reply = await webhook.call(
        {
          method: request.request.method ?? 'POST',
          path: request.request.path,
          ...(request.request.body === undefined ? {} : { body: request.request.body }),
          ...(request.request.headers ? { headers: request.request.headers } : {}),
        },
        request.idempotencyKey,
      );
      if (reply.status >= 200 && reply.status <= 299) return reply.json ?? null;
      if (retriedStatus(reply.status))
        throw Object.assign(new Error(`The service answered ${reply.status}.`), { code: `http_${reply.status}` });
      throw new StepRefused(request.step, `http_${reply.status}`);
    },
  };

  const result = await advance(environment, instance);
  switch (result.status) {
    case 'waiting':
      // A timer, or a back-off; an event wait with no timeout is woken by its event alone.
      if (result.wakeAt !== null)
        await wake(
          jobs,
          workflow,
          appId,
          tenantId,
          instance,
          wakeKey('timer', instance, result.step ?? '', result.wakeAt),
          now(),
          result.wakeAt,
        );
      break;
    case 'continue':
      await wake(jobs, workflow, appId, tenantId, instance, wakeKey('resume', instance, result.epoch), now());
      break;
    case 'aborted':
      throw new Error('The workflow advance was cut short.');
    default:
      break;
  }
  // The instance's state is the account of it; the job only says the advance happened.
  return Object.freeze({ state: result.status });
}

/** Who a flows runner's writes are attributed to in the record's history: never shown, and how the host knows a flow made a change. */
export const FLOW_ACTOR_PREFIX = 'flow:';
const flowActor = (workflow: string) => `${FLOW_ACTOR_PREFIX}${workflow}`;

/**
 * A change of a record, or a person's start of a manual flow: which of the
 * resource's flows start on it — asked of the flow command, as the runner's
 * principal, against the record as it is now — and one instance of each,
 * keyed by the record and the flow, so a flow already running on the record
 * is not started twice. Under the change's id: a redelivered dispatch starts
 * nothing new. A record gone meanwhile starts nothing.
 */
async function dispatchFlows(
  options: WorkflowHandlerOptions,
  workflow: CapturedWorkflow,
  actor: ReturnType<typeof serviceActor>,
  pseudo: CapturedJob,
  context: JobContext,
  dispatch: FlowDispatch,
): Promise<unknown> {
  const tenantId = options.tenancy ? context.provenance.tenantId : undefined;
  if (options.tenancy && tenantId === undefined) throw new JobRejected('The flow dispatch names no tenant.');
  const partition = workflowPartition(workflow.name, tenantId);
  let reply: unknown;
  try {
    reply = await stepCommand(options, actor, pseudo, context, {
      instance: context.jobId,
      step: 'match',
      command: flowCommandId(workflow.flows!.resource),
      target: dispatch.target,
      input: {
        op: 'match',
        trigger: dispatch.trigger,
        changed: JSON.stringify(dispatch.changed),
        ...(dispatch.flow === undefined ? {} : { flow: dispatch.flow }),
      },
      idempotencyKey: `wf-${createHash('sha256').update(`flows\n${context.jobId}`).digest('hex')}`,
      signal: context.signal,
    });
  } catch (error) {
    // The record is gone, or the runner may no longer read it: nothing starts, and nothing will on a retry.
    if (error instanceof StepRefused) return Object.freeze({ started: 0 });
    throw error;
  }
  const json = reply && typeof reply === 'object' ? (reply as { json?: unknown }).json : undefined;
  const flows = typeof json === 'string' ? (JSON.parse(json) as { flows?: unknown }).flows : undefined;
  let started = 0;
  for (const flow of Array.isArray(flows) ? flows : []) {
    if (typeof flow !== 'string' || !flow || flow.length > 64) continue;
    const instance = await options.workflows.start(
      {
        workflow: partition,
        version: workflow.version,
        key: `${dispatch.record}|${flow}`,
        eventId: `${dispatch.change}:${flow}`,
        startJson: JSON.stringify({ record: dispatch.record, target: dispatch.target, flow }),
      },
      options.now(),
    );
    if (!instance) continue;
    started++;
    await wake(options.jobs, workflow, options.appId, tenantId, instance.id, wakeKey('start', instance.id), options.now());
  }
  return Object.freeze({ started });
}
