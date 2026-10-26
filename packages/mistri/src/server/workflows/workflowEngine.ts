/**
 * One advance of one workflow instance: run its function until it ends or
 * reaches a step that has to wait, persisting each step as it completes.
 *
 * The function is ordinary async code, and the durable parts are the named
 * steps on `w`. A step already recorded returns its stored result, so a
 * second advance (after a wake-up, a restart or a crash) repeats nothing: it
 * walks the memoized steps and continues at the first one that has not
 * completed.
 *
 * Three rules carry the design:
 *
 * - Suspension never throws into user code. A step that must wait records
 *   that and then hangs its promise, while the advance returns through a
 *   control channel; a `try/catch` in the workflow cannot swallow a wait.
 *   The hung promise holds nothing and is collected with the closure.
 * - Every store write presents the instance's epoch, one at a time. A cancel,
 *   a retry or another host's advance moves the epoch, and this advance's next
 *   write is refused: it stops where it is ('overtaken') and writes nothing.
 * - A recorded step that is asked for again with another kind or other
 *   arguments is never reused: the instance stops as `diverged`, showing
 *   both. A new step name runs normally and a recorded one no longer asked
 *   for is ignored, which is what lets ordinary code changes reach
 *   in-flight instances.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { WorkflowStore } from '../../adapters/workflows/workflowStoreContract.js';
import {
  SIGNAL_PAGE,
  WORKFLOW_JSON_MAX,
  workflowProblemError,
  type WorkflowOutcome,
  type WorkflowStep,
} from '../../adapters/workflows/workflowStoreTypes.js';
import { parseEventPayload } from '../commands/businessEvents.js';
import { callHeaders } from '../commands/commandEffects.js';
import { callPathStaysInside } from '../webhooks.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { stepReceiptKey } from './workflowKeys.js';
import {
  commandReference,
  connectionReference,
  FlowStopped,
  parseDuration,
  stepName,
  StepRefused,
  WorkflowDeclarationError,
  type CallOptions,
  type CallRequest,
  type CapturedWorkflow,
  type RunArguments,
  type StepOptions,
  type WaitOptions,
  type WorkflowApi,
} from './workflowModule.js';

/** What the host gives an advance: the clock, and the two ways a step reaches outside. */
export interface EngineEnvironment {
  readonly store: WorkflowStore;
  readonly workflow: CapturedWorkflow;
  readonly now: () => number;
  /** Fires at the job attempt's deadline or on halt: the advance stops where it is. */
  readonly signal?: AbortSignal;
  /** Real elapsed time after which the advance yields and is continued by a fresh one. */
  readonly budgetMs?: number;
  /** The most one try of a step may take, however long the step asks for. */
  readonly stepTimeoutMs?: number;
  /** Throws StepRefused for a refusal retrying cannot change; any other error is retried. Returns the command's output. */
  runCommand(
    request: Readonly<{
      instance: string;
      step: string;
      command: string;
      target?: unknown;
      input?: unknown;
      idempotencyKey: string;
      signal: AbortSignal;
    }>,
  ): Promise<unknown>;
  /** The same for an outbound call: StepRefused for a 4xx that is not 408 or 429. Returns the response's JSON. */
  call(
    request: Readonly<{
      instance: string;
      step: string;
      connection: string;
      request: CallRequest;
      idempotencyKey: string;
      signal: AbortSignal;
    }>,
  ): Promise<unknown>;
}

export type Advance =
  /** No live instance by that id: nothing to do. */
  | Readonly<{ status: 'gone' }>
  | Readonly<{ status: 'completed' | 'failed' | 'diverged' }>
  /** Suspended at a step; a job is due at `wakeAt` when it has one, and a matching event wakes it earlier. */
  | Readonly<{ status: 'waiting'; step: string | null; wakeAt: number | null }>
  /** The budget is spent: another advance should follow at once. */
  | Readonly<{ status: 'continue'; epoch: number }>
  /** Cancelled, retried or advanced by another host meanwhile: this one wrote nothing more. */
  | Readonly<{ status: 'overtaken' }>
  /** The attempt's deadline passed or the host is halting. */
  | Readonly<{ status: 'aborted' }>;

const DEFAULTS = Object.freeze({
  run: { attempts: 3, backoff: '5 seconds', max: '5 minutes' },
  call: { attempts: 5, backoff: '10 seconds', max: '10 minutes' },
  timeout: '30 seconds',
});
const MAX_ATTEMPTS = 32;
const CALL_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BUDGET_MS = 8_000;
/** A wait re-reads the signals this many times when another arrives while it decides. */
const SIGNAL_RETRIES = 8;

const hashOf = (kind: string, ...args: readonly unknown[]): string =>
  createHash('sha256')
    .update(canonicalCommandJson([kind, ...args.map((arg) => arg ?? null)]))
    .digest('hex');
const codeOf = (error: unknown): string => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : 'error';
};
/** A problem as the store keeps it: at most 128 bytes, cut between characters. */
/* The workflow's own code threw: the error's name and code are kept for an operator, its message never is (it may
   quote a payload or a credential). */
function workflowErrorOutcome(error: unknown): WorkflowOutcome {
  const kept = workflowProblemError(error);
  return {
    state: 'failed',
    problem: 'workflow_error',
    problemStep: null,
    ...(kept ? { problemJson: JSON.stringify({ error: kept }) } : {}),
  };
}
function boundedProblem(text: string): string {
  let kept = '';
  for (const character of text) {
    if (Buffer.byteLength(kept + character) > 128) break;
    kept += character;
  }
  return kept || 'flow_stopped';
}
class StepTimeout extends Error {
  readonly code = 'timeout';
}

/** Advance the instance `id` once. Never throws for what a workflow or a step did: those are states. */
export async function advance(env: EngineEnvironment, id: string): Promise<Advance> {
  const { store, workflow } = env;
  const begun = await store.begin(id, env.now());
  if (!begun) return { status: 'gone' };
  const { instance } = begun;
  const memo = new Map<string, WorkflowStep>(begun.steps.map((step) => [step.name, step]));
  const taken = new Set(begun.steps.map((step) => step.eventId).filter((eventId): eventId is string => eventId !== null));
  let epoch = instance.epoch;
  const startedAt = performance.now(),
    budgetMs = env.budgetMs ?? DEFAULT_BUDGET_MS;
  const stepTimeoutMs = env.stepTimeoutMs ?? parseDuration(DEFAULTS.timeout, 'timeout');

  let ended = false;
  let settle!: (value: Advance) => void;
  const control = new Promise<Advance>((resolve) => {
    settle = resolve;
  });
  /** Ends the advance with `outcome` and hangs the step that asked, so the function never sees it. */
  const stop = (outcome: Advance): Promise<never> => {
    ended = true;
    settle(outcome);
    return new Promise<never>(() => {});
  };
  const onAbort = () => {
    void stop({ status: 'aborted' });
  };
  if (env.signal?.aborted) onAbort();
  else env.signal?.addEventListener('abort', onAbort, { once: true });

  /* Store writes are one at a time, in the order steps asked: a parallel pair
     of steps must not race each other's epoch. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const persist = async (name: string, write: Omit<WorkflowStep, 'name' | 'ordinal' | 'createdAt' | 'updatedAt'>): Promise<void> => {
    const next = await serial(() => store.step(id, epoch, { name, ...write }, env.now()));
    if (next === undefined) return stop({ status: 'overtaken' });
    epoch = next;
    const now = env.now(),
      before = memo.get(name);
    memo.set(name, { name, ordinal: before?.ordinal ?? memo.size, createdAt: before?.createdAt ?? now, updatedAt: now, ...write });
  };
  const finish = async (outcome: Parameters<WorkflowStore['finish']>[2]): Promise<never> => {
    const done = await serial(() => store.finish(id, epoch, outcome, env.now()));
    return stop(done ? { status: outcome.state } : { status: 'overtaken' });
  };
  const failStep = (step: string, problem: string) => finish({ state: 'failed', problem, problemStep: step });
  const suspend = async (step: string | null, wakeAt: number | null, event?: { name: string; version: number }, seenSeq = 0) => {
    const result = await serial(() => store.suspend(id, epoch, { step, wakeAt, seenSeq, ...(event ? { event } : {}) }, env.now()));
    if (result === undefined) return stop({ status: 'overtaken' });
    if (result === 'signal') return 'signal' as const;
    return stop({ status: 'waiting', step, wakeAt });
  };

  const used = new Set<string>();
  let unnamedNow = 0;
  /** A step's name, its recorded row, and the guard: a recorded step asked for differently diverges the instance. */
  const enter = async (
    raw: unknown,
    kind: WorkflowStep['kind'],
    hash: string,
  ): Promise<{ name: string; recorded: WorkflowStep | undefined }> => {
    if (ended) await new Promise<never>(() => {});
    const name = stepName(raw);
    if (used.has(name))
      throw new WorkflowDeclarationError(`Step "${name}" ran twice in one run: give each step of a loop its own name, as [name, key].`);
    used.add(name);
    const recorded = memo.get(name);
    if (recorded && (recorded.kind !== kind || recorded.hash !== hash)) {
      await finish({
        state: 'diverged',
        problem: 'diverged',
        problemStep: name,
        problemJson: JSON.stringify({ recorded: { kind: recorded.kind, hash: recorded.hash }, requested: { kind, hash } }),
      });
    }
    return { name, recorded };
  };
  const stored = (step: WorkflowStep): unknown => (step.resultJson === null ? undefined : JSON.parse(step.resultJson));
  const keep = (name: string, value: unknown): Promise<string> => {
    const json = canonicalCommandJson(value ?? null);
    return Buffer.byteLength(json) > WORKFLOW_JSON_MAX ? failStep(name, 'result_too_large') : Promise.resolve(json);
  };

  /** A command or a call: tried with back-off until it answers, is refused, or runs out of attempts. */
  const action = async (
    kind: 'run' | 'call',
    name: string,
    hash: string,
    recorded: WorkflowStep | undefined,
    options: StepOptions | undefined,
    exec: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> => {
    if (recorded?.status === 'completed') return stored(recorded);
    if (recorded?.status === 'refused') throw new StepRefused(name, recorded.errorCode ?? 'refused');
    if (recorded?.status === 'failed') return failStep(name, 'step_failed');
    const defaults = DEFAULTS[kind];
    const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, options?.retry?.attempts ?? defaults.attempts));
    const backoffMs = parseDuration(options?.retry?.backoff ?? defaults.backoff, 'retry.backoff');
    const maxBackoffMs = parseDuration(options?.retry?.max ?? defaults.max, 'retry.max');
    const timeoutMs = Math.min(stepTimeoutMs, parseDuration(options?.timeout ?? DEFAULTS.timeout, 'timeout'));
    const tried = recorded?.attempts ?? 0;
    // A back-off that has not run out is waited for by a timer, not by this advance.
    if (recorded?.wakeAt != null && env.now() < recorded.wakeAt) return suspend(name, recorded.wakeAt).then(() => undefined);
    if (performance.now() - startedAt > budgetMs) {
      const next = await serial(() => store.release(id, epoch, env.now()));
      return stop(next === undefined ? { status: 'overtaken' } : { status: 'continue', epoch: next });
    }
    const controller = new AbortController();
    const forward = () => controller.abort();
    env.signal?.addEventListener('abort', forward, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StepTimeout());
        }, timeoutMs);
      });
      const output = await Promise.race([exec(controller.signal), timedOut]);
      if (ended) return new Promise<never>(() => {});
      const json = await keep(name, output);
      await persist(name, {
        kind,
        hash,
        status: 'completed',
        attempts: tried + 1,
        wakeAt: null,
        resultJson: json,
        eventId: null,
        errorCode: null,
      });
      return JSON.parse(json);
    } catch (error) {
      if (ended) return new Promise<never>(() => {});
      if (error instanceof StepRefused) {
        await persist(name, {
          kind,
          hash,
          status: 'refused',
          attempts: tried + 1,
          wakeAt: null,
          resultJson: null,
          eventId: null,
          errorCode: error.code,
        });
        throw new StepRefused(name, error.code);
      }
      const count = tried + 1;
      if (count >= attempts) {
        await persist(name, {
          kind,
          hash,
          status: 'failed',
          attempts: count,
          wakeAt: null,
          resultJson: null,
          eventId: null,
          errorCode: codeOf(error),
        });
        return failStep(name, 'step_failed');
      }
      const wakeAt = env.now() + Math.min(maxBackoffMs, backoffMs * 2 ** (count - 1));
      await persist(name, {
        kind,
        hash,
        status: 'pending',
        attempts: count,
        wakeAt,
        resultJson: null,
        eventId: null,
        errorCode: codeOf(error),
      });
      await suspend(name, wakeAt);
      return undefined;
    } finally {
      clearTimeout(timer);
      env.signal?.removeEventListener('abort', forward);
    }
  };

  /** A durable timer: its wake-up time is fixed the first time it is reached. */
  const timer = async (raw: unknown, hash: string, wakeAt: () => number): Promise<void> => {
    const { name, recorded } = await enter(raw, 'sleep', hash);
    if (recorded?.status === 'completed') return;
    const at = recorded?.wakeAt ?? wakeAt();
    if (!recorded)
      await persist(name, {
        kind: 'sleep',
        hash,
        status: 'pending',
        attempts: 0,
        wakeAt: at,
        resultJson: null,
        eventId: null,
        errorCode: null,
      });
    if (env.now() >= at)
      return persist(name, {
        kind: 'sleep',
        hash,
        status: 'completed',
        attempts: 0,
        wakeAt: at,
        resultJson: null,
        eventId: null,
        errorCode: null,
      });
    await suspend(name, at);
  };

  const w: WorkflowApi = Object.freeze({
    version: instance.version,

    async run(raw: unknown, command: string, args?: RunArguments): Promise<never> {
      const ref = commandReference(command, 'w.run command');
      const input = args?.input === undefined ? null : JSON.parse(canonicalCommandJson(args.input));
      const target = args?.target === undefined ? null : args.target;
      const hash = hashOf('run', ref, target, input);
      const { name, recorded } = await enter(raw, 'run', hash);
      const done = await action('run', name, hash, recorded, args, (signal) =>
        env.runCommand({
          instance: id,
          step: name,
          command: ref,
          ...(args?.target === undefined ? {} : { target: args.target }),
          ...(args?.input === undefined ? {} : { input: args.input }),
          idempotencyKey: stepReceiptKey(id, name),
          signal,
        }),
      );
      return done as never;
    },

    async call(raw: unknown, connection: string, request: CallRequest, options?: CallOptions): Promise<never> {
      const ref = connectionReference(connection, 'w.call connection');
      if (!request || typeof request.path !== 'string') throw new WorkflowDeclarationError('w.call needs a request with a path.');
      if (!callPathStaysInside(request.path))
        throw new WorkflowDeclarationError('A w.call path starts with a single "/" and stays inside the connection\'s address.');
      /* What a request may say is checked before it is tried: a path, a method or a header the request cannot carry
         failed on the wire as a transient error and was sent again on every retry, and a header the request
         owns (the connection's credential, its host) was the step's to replace. An effect's headers obey the
         same rule; the Idempotency-Key is the one a call may set for its provider. */
      if (request.method !== undefined && !CALL_METHODS.has(request.method))
        throw new WorkflowDeclarationError(`w.call method is one of ${[...CALL_METHODS].join(', ')}.`);
      if (request.headers !== undefined) {
        try {
          callHeaders(request.headers);
        } catch {
          throw new WorkflowDeclarationError(
            'w.call headers are at most 8 names and visible values the request does not own: never host, authorization, cookie, content-type, accept or a length.',
          );
        }
      }
      const canonical = JSON.parse(
        canonicalCommandJson({
          method: request.method ?? 'POST',
          path: request.path,
          body: request.body ?? null,
          headers: request.headers ?? {},
        }),
      );
      const hash = hashOf('call', ref, canonical);
      const { name, recorded } = await enter(raw, 'call', hash);
      const parse = options?.parse;
      const done = await action('call', name, hash, recorded, options, async (signal) => {
        const json = await env.call({
          instance: id,
          step: name,
          connection: ref,
          request,
          idempotencyKey: stepReceiptKey(id, name),
          signal,
        });
        return parse ? parse(json) : json;
      });
      return done as never;
    },

    async sleep(raw: unknown, duration: string): Promise<void> {
      const ms = parseDuration(duration, 'w.sleep duration');
      await timer(raw, hashOf('sleep', ms), () => env.now() + ms);
    },

    async until(raw: unknown, when: Date | string | number): Promise<void> {
      const at = new Date(when).getTime();
      if (!Number.isFinite(at)) throw new WorkflowDeclarationError('w.until needs a time: a Date, an ISO string or epoch milliseconds.');
      await timer(raw, hashOf('until', at), () => at);
    },

    async now(raw?: unknown): Promise<Date> {
      const { name, recorded } = await enter(raw ?? `now#${++unnamedNow}`, 'now', hashOf('now'));
      if (recorded?.status === 'completed') return new Date(Number(stored(recorded)));
      const at = env.now();
      await persist(name, {
        kind: 'now',
        hash: hashOf('now'),
        status: 'completed',
        attempts: 0,
        wakeAt: null,
        resultJson: String(at),
        eventId: null,
        errorCode: null,
      });
      return new Date(at);
    },

    async waitFor(raw: unknown, event: { name: string; version: number }, options?: WaitOptions<never>): Promise<never> {
      const identity = `${event?.name}@${event?.version}`;
      const known = workflow.events.get(identity);
      if (!known)
        throw new WorkflowDeclarationError(
          `Workflow "${workflow.name}" waits for "${identity}" and does not list it in listens: the host delivers only the events a workflow names.`,
        );
      const timeoutMs = options?.timeout === undefined ? null : parseDuration(options.timeout, 'waitFor timeout');
      const hash = hashOf('waitFor', identity, timeoutMs);
      const { name, recorded } = await enter(raw, 'waitFor', hash);
      if (recorded?.status === 'completed')
        return (recorded.eventId === null ? null : parseEventPayload(known, recorded.resultJson!)) as never;
      const wakeAt = recorded ? recorded.wakeAt : timeoutMs === null ? null : env.now() + timeoutMs;
      if (!recorded)
        await persist(name, {
          kind: 'waitFor',
          hash,
          status: 'pending',
          attempts: 0,
          wakeAt,
          resultJson: null,
          eventId: null,
          errorCode: null,
        });
      for (let round = 0; round < SIGNAL_RETRIES; round++) {
        let seen = instance.signalFloor;
        for (;;) {
          const page = await store.signals(workflow.name, event.name, event.version, seen);
          for (const signal of page) {
            seen = signal.seq;
            // The start event is not its own wait's answer, and an event one wait took is no other's.
            if (signal.eventId === instance.startEventId || taken.has(signal.eventId)) continue;
            const payload = parseEventPayload(known, signal.payloadJson);
            if (options?.match && !options.match(payload as never)) continue;
            taken.add(signal.eventId);
            await persist(name, {
              kind: 'waitFor',
              hash,
              status: 'completed',
              attempts: 0,
              wakeAt,
              resultJson: signal.payloadJson,
              eventId: signal.eventId,
              errorCode: null,
            });
            return payload as never;
          }
          if (page.length < SIGNAL_PAGE) break;
        }
        if (wakeAt !== null && env.now() >= wakeAt) {
          await persist(name, {
            kind: 'waitFor',
            hash,
            status: 'completed',
            attempts: 0,
            wakeAt,
            resultJson: 'null',
            eventId: null,
            errorCode: null,
          });
          return null as never;
        }
        // A signal recorded between the read and the suspend sends the run round again.
        if ((await suspend(name, wakeAt, { name: event.name, version: event.version }, seen)) !== 'signal') break;
      }
      return failStep(name, 'wait_unsettled');
    },
  } as WorkflowApi);

  /** The end of the advance: what the instance became, or why this advance stopped. Never awaited from user code. */
  const end = (outcome: Parameters<WorkflowStore['finish']>[2]): Promise<Advance> => {
    void finish(outcome);
    return control;
  };
  let start: unknown;
  try {
    start = parseEventPayload(workflow.events.get(`${workflow.start.name}@${workflow.start.version}`)!, instance.startJson);
  } catch {
    env.signal?.removeEventListener('abort', onAbort);
    return end({ state: 'failed', problem: 'start_invalid', problemStep: null });
  }

  const body = (async () => {
    try {
      return { kind: 'value' as const, value: await workflow.run(w, start) };
    } catch (error) {
      return { kind: 'error' as const, error };
    }
  })();
  try {
    const result = await Promise.race([body, control.then((outcome) => ({ kind: 'control' as const, outcome }))]);
    if (result.kind === 'control') return result.outcome;
    if (ended) return await control;
    if (result.kind === 'error') {
      return await end(
        result.error instanceof StepRefused
          ? { state: 'failed', problem: 'step_refused', problemStep: result.error.step }
          : result.error instanceof FlowStopped
            ? // A row-driven flow's own sentence: the instance's record page shows it, so it is kept, cut to the store's bound.
              {
                state: 'failed',
                problem: boundedProblem(result.error.reason),
                problemStep: memo.has(result.error.step) ? result.error.step : null,
              }
            : workflowErrorOutcome(result.error),
      );
    }
    let json: string | null = null;
    try {
      json = result.value === undefined ? null : canonicalCommandJson(result.value);
    } catch {
      return await end({ state: 'failed', problem: 'result_invalid', problemStep: null });
    }
    if (json !== null && Buffer.byteLength(json) > WORKFLOW_JSON_MAX)
      return await end({ state: 'failed', problem: 'result_invalid', problemStep: null });
    return await end({ state: 'completed', resultJson: json });
  } finally {
    env.signal?.removeEventListener('abort', onAbort);
  }
}
