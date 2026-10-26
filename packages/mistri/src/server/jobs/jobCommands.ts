/**
 * The two seams a job crosses. Delivery to the job store: the transport a
 * job's destination publishes through, which decodes the event with its
 * declaration and enqueues the planned job under the event's id. The job
 * store to the command executor: the handler the runner calls, which runs
 * the job's command through the same binding and executor HTTP uses, as the
 * job's service principal.
 *
 * Every hop carries a durable key derived from the event id, never from a
 * job row: the enqueue is idempotent by (job, event id), and the command's
 * idempotency key is a hash of the job, its version and the event id. An
 * attempt after the first looks the command's receipt up before running it,
 * so an attempt whose outcome was lost lands on the receipt that exists.
 */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import { JobRefusal, type JobEnqueueInput } from '../../adapters/jobs/jobStoreTypes.js';
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import {
  executeBusinessCommand,
  isBusinessCommandExecutionError,
  lookupBusinessCommandStatus,
  type BusinessCommandResult,
} from '../commands/businessCommandExecution.js';
import { parseEventPayload } from '../commands/businessEvents.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import { serviceActor } from './jobAuthorization.js';
import type { CapturedJob, CapturedJobModule } from './jobModule.js';
import { defineJobHandler, defineJobHandlers, JobRejected, type AnyJobDefinition, type JobContext, type JobRegistry } from './jobs.js';
import type { CaptureCommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';

/** A command binding for one attempt, over the App loaded now; release returns its source leases. */
export interface JobCommandBinding {
  readonly binding: BusinessCommandBinding;
  /** Attempt-owned capture, called after command authorization, never at registration. */
  readonly captureFlags?: CaptureCommandFlags;
  release(): void;
}

type CommandKey = Readonly<Record<string, string | number>>;
interface JobInput {
  readonly key: CommandKey;
  readonly input: unknown;
  readonly since?: string;
}

/** The command's idempotency key: the same for every attempt and every re-delivery of one event. */
export const jobCommandKey = (job: string, version: number, eventId: string): string =>
  `job-${createHash('sha256').update(`${job}\n${version}\n${eventId}`).digest('hex')}`;

function commandKey(value: unknown): CommandKey {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) throw new Error();
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16) throw new Error();
  for (const [column, part] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(column) ||
      !(typeof part === 'string' ? part.length > 0 && part.length <= 1024 : Number.isSafeInteger(part))
    )
      throw new Error();
  }
  return Object.freeze(Object.fromEntries(entries)) as CommandKey;
}
function jobInput(value: unknown): JobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  if (!['input,key', 'input,key,since'].includes(Object.keys(record).sort().join(','))) throw new Error();
  if (Object.hasOwn(record, 'since') && (typeof record.since !== 'string' || !record.since.length || record.since.length > 128))
    throw new Error();
  // A job at times names no record: its key is empty.
  const empty = record.key && typeof record.key === 'object' && !Array.isArray(record.key) && !Object.keys(record.key).length;
  return Object.freeze({
    key: empty ? Object.freeze({}) : commandKey(record.key),
    input: record.input,
    ...(record.since === undefined ? {} : { since: record.since as string }),
  });
}

/** The job store's key for one slot of a job at times: the same in every process, so the slot runs once. */
export const everySlotKey = (slot: number): string => `every-${String(slot).padStart(16, '0')}`;
/** One tenant's run of a slot, on a tenant App: the slot's key and the tenant, hashed (a key cannot carry every tenant id's length). */
export const everyTenantSlotKey = (slot: number, tenantId: string): string =>
  `${everySlotKey(slot)}-${createHash('sha256').update(tenantId).digest('hex').slice(0, 40)}`;
function dueAt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const at = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) throw new Error();
  return at;
}
/** The job one event plans: its schedule run on the declaration's own reading of the payload. */
function plan(job: CapturedJob, payloadJson: string): { runAt?: number; key: CommandKey; input: unknown } {
  const planned = job.schedule!(parseEventPayload(job.event!, payloadJson));
  if (!planned || typeof planned !== 'object' || Array.isArray(planned) || isProxy(planned)) throw new Error();
  const value = planned as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['runAt', 'key', 'input'].includes(key))) throw new Error();
  const runAt = dueAt(value.runAt);
  return {
    ...(runAt === undefined ? {} : { runAt }),
    key: commandKey(value.key),
    input: value.input === undefined ? {} : JSON.parse(canonicalCommandJson(value.input)),
  };
}

/** One job destination's transport. `accepted` is the job store's durable
 * acceptance; a duplicate replays the job already accepted. */
export function jobTransport(
  options: Readonly<{ job: CapturedJob; store: JobStore; appId: string; now: () => number }>,
): EventPublicationTransport {
  const { job, store, appId, now } = options;
  return async (publication) => {
    const envelope = publication.envelope;
    // A receipt's other facts reach this destination too; the job takes only its own.
    if (envelope.name !== job.event!.name || envelope.version !== job.event!.version) return 'accepted';
    let request: JobEnqueueInput;
    try {
      const planned = plan(job, envelope.payloadJson);
      request = {
        job: job.id,
        version: job.version,
        idempotencyKey: publication.idempotencyKey,
        input: { key: planned.key, input: planned.input },
        ...(planned.runAt === undefined ? {} : { runAt: planned.runAt }),
        // A tenant's fact carries its tenant on: the one its job may act for, from the verified envelope.
        provenance: {
          appId,
          actorId: envelope.actorId,
          ...(envelope.scope === 'tenant' ? { tenantId: envelope.tenantId } : {}),
          correlationId: envelope.correlationId,
          causationId: envelope.eventId,
        },
      };
    } catch {
      return 'rejected';
    }
    try {
      await store.enqueue(request, now());
      return 'accepted';
    } catch (error) {
      // A coded refusal changed nothing and never will; anything else is unknown.
      if (error instanceof JobRefusal) return 'rejected';
      throw error;
    }
  };
}

/* A refusal that the next attempt may not repeat: the record moved, the
   writer was busy, or the attempt ran out of time. Everything else the
   command refused, it will refuse again. */
const RETRIED = new Set(['stale_record', 'temporarily_unavailable', 'row_locked', 'cancelled']);
function classified(error: unknown): Error {
  if (error instanceof AppAccessDenied) return new JobRejected("The job's command refused: forbidden.");
  if (isBusinessCommandExecutionError(error)) {
    return RETRIED.has(error.code)
      ? new Error(`The job's command answered ${error.code}.`)
      : new JobRejected(`The job's command refused: ${error.code}.`);
  }
  return error instanceof Error ? error : new Error('The job attempt failed.');
}
const settled = (result: BusinessCommandResult) => Object.freeze({ receiptId: result.receiptId, replayed: result.replayed });

/** What binds one attempt's command: over the App loaded now, or, on a tenant
 * App, as the attempt's service principal for the tenant its job names. */
export type JobAttemptBinding = (context: JobContext, job: CapturedJob) => Promise<JobCommandBinding>;

/** The runner's registry: one handler a job, each running its command as its principal. */
export function jobHandlers(
  options: Readonly<{
    module: CapturedJobModule;
    appId: string;
    bind: JobAttemptBinding;
    /** Handlers the host adds beside the module's jobs: a workflow's advance (workflows/workflowHost.ts). */
    extra?: Readonly<Record<string, AnyJobDefinition>>;
  }>,
): JobRegistry {
  const handlers: Record<string, AnyJobDefinition> = {};
  for (const job of options.module.jobs.values()) {
    const actor = serviceActor(options.appId, job.runAs, options.module.principals.get(job.runAs)!);
    /* Background work: its command writes through the background writer
       (writeLanes.ts asBackgroundWork), never one a person's save waits for. */
    handlers[job.id] = defineJobHandler<JobInput>({
      version: job.version,
      input: { parse: jobInput },
      handle: (context, input) =>
        asBackgroundWork(async () => {
          const eventId = context.provenance.causationId;
          if (!eventId) throw new JobRejected('The job names no event.');
          const request = {
            command: job.command.id,
            commandVersion: job.command.version,
            key: input.key,
            // A job prepares no form: the command reads its target fresh and names no revision.
            expectedVersion: 0,
            idempotencyKey: jobCommandKey(job.id, job.version, eventId),
            input: input.input,
          };
          if (job.timer && input.since === undefined) throw new JobRejected('The timer names no stay.');
          const execution = {
            signal: context.signal,
            requestId: `job:${context.jobId}:${context.attempt}`,
            now: () => new Date(context.now()),
            ...(job.timer
              ? {
                  timer: {
                    ...(job.timer.column === undefined ? {} : { column: job.timer.column, state: job.timer.state }),
                    since: job.timer.since,
                    enteredAt: input.since!,
                    ...(job.timer.when === undefined ? {} : { when: job.timer.when }),
                  },
                }
              : {}),
          };
          let bound: JobCommandBinding | undefined;
          try {
            bound = await options.bind(context, job);
            const authorized = bound.binding.authorize(job.command.id, actor);
            const captureFlags = bound.captureFlags;
            const flags = await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
            const attempt = { ...execution, flags };
            // Status before retry: an earlier attempt may have committed and lost its answer.
            if (context.attempt > 1) {
              const status = await lookupBusinessCommandStatus(bound.binding, actor, request, attempt);
              if (status.status === 'applied') return settled(status);
            }
            return settled(await executeBusinessCommand(bound.binding, actor, request, { ...attempt, door: 'job' }));
          } catch (error) {
            throw classified(error);
          } finally {
            bound?.release();
          }
        }),
    });
  }
  return defineJobHandlers({ ...handlers, ...options.extra });
}
