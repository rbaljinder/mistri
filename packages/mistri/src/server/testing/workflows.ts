/**
 * A controlled clock for a workflow: the real engine and a real workflow
 * store, with the commands and calls its steps make replaced by functions the
 * test provides, and time that moves only when the test says. A command's
 * receipt is kept the way the real one is (by the step's idempotency key), so
 * a step run again after a simulated crash does not run its command twice.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteWorkflowStore } from '../../adapters/workflows/workflowStore.js';
import { provisionSqliteWorkflowStore } from '../../adapters/workflows/workflowStoreSchema.js';
import type { WorkflowStore } from '../../adapters/workflows/workflowStoreContract.js';
import type { WorkflowInspection, WorkflowStepInspection } from '../../adapters/workflows/workflowStoreTypes.js';
import { advance } from '../workflows/workflowEngine.js';
import { capturedWorkflows, defineWorkflows, StepRefused, type CallRequest, type Workflow } from '../workflows/workflowModule.js';
import { parseEventPayload, type BusinessEvent } from '../commands/businessEvents.js';

export interface WorkflowDriverOptions {
  /** The workflow, named by its key as `defineWorkflows` names it: `{ creditDecision }`. */
  readonly workflow: Readonly<Record<string, Workflow>>;
  /** What each command a step runs does. Throw `StepRefused` or an error with a `code` to refuse; anything else is retried. */
  readonly commands?: Readonly<Record<string, (request: Readonly<{ target: unknown; input: unknown }>) => unknown | Promise<unknown>>>;
  /** What each connection a step calls answers: a JSON value, or a throw. */
  readonly calls?: Readonly<Record<string, (request: CallRequest) => unknown | Promise<unknown>>>;
  /** A store to run against (a live PostgreSQL one, say); a private SQLite file by default. */
  readonly store?: WorkflowStore;
  readonly start?: string | number | Date;
}

/** Controlled time, events and crashes over one workflow. Call `close` when done. */
export async function createWorkflowDriver(options: WorkflowDriverOptions) {
  const workflow = capturedWorkflows(defineWorkflows(options.workflow))[0];
  let directory: string | undefined;
  let store = options.store;
  if (!store) {
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-workflow-'));
    const file = join(directory, 'workflows.db');
    writeFileSync(file, '');
    provisionSqliteWorkflowStore(file);
    store = openSqliteWorkflowStore(file);
  }
  let current = new Date(options.start ?? '2026-01-01T00:00:00.000Z').getTime();
  if (!Number.isFinite(current)) throw new Error('Invalid workflow clock start.');
  const clock = () => current;
  const executions = new Map<string, number>();
  const receipts = new Map<string, unknown>();
  const pending = new Map<string, number>();
  let killAt: string | undefined;
  let kill: AbortController | undefined;

  const run = async (id: string): Promise<string> => {
    kill = new AbortController();
    const result = await advance(
      {
        store,
        workflow,
        now: clock,
        signal: kill.signal,
        async runCommand(request) {
          if (!receipts.has(request.idempotencyKey)) {
            const handler = options.commands?.[request.command];
            if (!handler) throw new StepRefused(request.step, 'unknown_command');
            executions.set(request.command, (executions.get(request.command) ?? 0) + 1);
            receipts.set(request.idempotencyKey, await handler({ target: request.target, input: request.input }));
          }
          // The command committed; a crash here loses only the answer, as the real one can.
          if (killAt === request.step) {
            killAt = undefined;
            kill?.abort();
            await new Promise<never>(() => {});
          }
          return receipts.get(request.idempotencyKey);
        },
        async call(request) {
          const handler = options.calls?.[request.connection];
          if (!handler) throw new StepRefused(request.step, 'unknown_connection');
          executions.set(`call:${request.connection}`, (executions.get(`call:${request.connection}`) ?? 0) + 1);
          return handler(request.request);
        },
      },
      id,
    );
    pending.delete(id);
    if (result.status === 'waiting' && result.wakeAt !== null) pending.set(id, result.wakeAt);
    if (result.status === 'continue') pending.set(id, current);
    return result.status;
  };

  /** Advance every instance that is due, until none is. */
  const settle = async (): Promise<void> => {
    for (let rounds = 0; rounds < 1_000; rounds++) {
      const due = [...pending].find(([, at]) => at <= current);
      if (!due) return;
      await run(due[0]);
    }
    throw new Error('The workflow never settled.');
  };

  return {
    /** A fact is committed: it starts an instance (when it is the workflow's start event) and wakes the ones waiting for it. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async emit<Payload extends object>(event: BusinessEvent<any>, payload: Payload, eventId = `evt-${randomUUID()}`): Promise<void> {
      const json = JSON.stringify(payload);
      const identity = `${event.name}@${event.version}`;
      if (!workflow.events.has(identity)) return;
      const woken = await store.signal(
        { workflow: workflow.name, eventId, name: event.name, version: event.version, payloadJson: json },
        current,
      );
      for (const id of woken) pending.set(id, current);
      if (identity === `${workflow.start.name}@${workflow.start.version}`) {
        const value = workflow.key(parseEventPayload(workflow.events.get(identity)!, json));
        const started = await store.start(
          { workflow: workflow.name, version: workflow.version, key: String(value), eventId, startJson: json },
          current,
        );
        if (started) pending.set(started.id, current);
      }
      await settle();
    },
    /** Move time forward and run what comes due. */
    async advance(milliseconds: number): Promise<void> {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Clock advance must be a finite nonnegative duration.');
      current += milliseconds;
      await settle();
    },
    /** The next advance stops at the step, after its command committed and before the step was recorded: a process killed mid-advance. */
    killDuring(step: string): void {
      killAt = step;
    },
    /** Advance the instance now, as a wake-up would; for after a simulated crash. */
    async resume(id: string): Promise<string> {
      const status = await run(id);
      await settle();
      return status;
    },
    async cancel(id: string, operator = 'test') {
      const result = await store.cancel(id, operator, current);
      pending.delete(id);
      return result;
    },
    async retry(id: string, operator = 'test') {
      const instance = await store.retry(id, operator, current);
      pending.set(id, current);
      await settle();
      return instance;
    },
    instances: (): Promise<readonly WorkflowInspection[]> => store.inspect({ workflow: workflow.name }, 500),
    steps: (id: string): Promise<readonly WorkflowStepInspection[]> => store.steps(id),
    /** How many times a command (or `call:<connection>`) actually ran. */
    executed: (name: string): number => executions.get(name) ?? 0,
    now: clock,
    store,
    async close(): Promise<void> {
      if (!options.store) await store.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}
