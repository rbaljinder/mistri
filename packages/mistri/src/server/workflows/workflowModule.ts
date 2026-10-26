/**
 * The workflow vocabulary, `@mistriwork/mistri/workflows`. A workflow is a
 * declaration: the committed fact that starts it, the principal it runs as
 * and an async function whose every durable act is a named step on `w`. A
 * step's result is stored the first time it completes; when the function runs
 * again after a wake-up or a crash, a completed step returns its stored
 * result without running again (workflowEngine.ts). Declarations are captured
 * and frozen here and nothing runs; the `--jobs` host does that.
 */
import { isProxy } from 'node:util/types';
import { isBusinessEvent, type BusinessEvent, type BusinessEventPayload } from '../commands/businessEvents.js';
import type { BusinessCommand } from '../commands/businessCommands.js';
import { parseDuration as sharedDuration } from '@mistriwork/engine/shared/duration.js';

/** A name is persisted, so it is checked like an identifier: it becomes part of a job id and a delivery destination. */
const WORKFLOW_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/;
const PRINCIPAL = /^[a-z][a-z0-9-]{0,62}$/;
const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;
const COMMAND_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONNECTION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class WorkflowDeclarationError extends Error {
  readonly code = 'invalid-workflow-declaration';
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowDeclarationError';
  }
}
const fail = (message: string): never => {
  throw new WorkflowDeclarationError(message);
};

/**
 * A step the workflow may catch: the command (or the outside service) said no,
 * for good. Retrying cannot change the answer, so none is made. Uncaught, it
 * ends the instance as `failed`, naming the step.
 */
export class StepRefused extends Error {
  readonly step: string;
  /** The command's refusal code, or `http_<status>` for a call. */
  readonly code: string;
  constructor(step: string, code: string) {
    super(`Step "${step}" was refused: ${code}.`);
    this.name = 'StepRefused';
    this.step = step;
    this.code = code;
  }
}

/**
 * A row-driven flow that cannot go on (flowRunner.ts): a step its rows
 * describe that the run cannot take. Not a crash and not a refusal: the
 * instance ends as `failed` with this reason, which its record page shows,
 * at `step` — the one a Retry runs again once the rows are fixed.
 */
export class FlowStopped extends Error {
  readonly step: string;
  readonly reason: string;
  constructor(step: string, reason: string) {
    super(reason);
    this.name = 'FlowStopped';
    this.step = step;
    this.reason = reason;
  }
}

/** `'30 seconds'`, `'5 minutes'`, `'2 hours'`, `'1 day'`: a number and a unit (packages/engine/src/shared/duration.ts). */
export type Duration = string;
/** The longest a timer or a wait may be: a year. A longer one is a modelling question, not a timer. */
const MAX_DURATION_MS = 366 * 86_400_000;
/** A duration in milliseconds; refuses what it cannot read, with `where` in the message. */
export function parseDuration(value: unknown, where: string): number {
  const ms = sharedDuration(value);
  if (!ms || ms > MAX_DURATION_MS)
    return fail(`${where} must be a duration such as '30 seconds', '5 minutes', '2 hours' or '2 days', at most a year.`);
  return ms;
}

/** How a step is tried again: `attempts` in all, waiting `backoff` doubled each time, at most `max`. */
export interface RetryOptions {
  readonly attempts?: number;
  readonly backoff?: Duration;
  readonly max?: Duration;
}
export interface StepOptions {
  readonly retry?: RetryOptions;
  /** How long one try may take. */
  readonly timeout?: Duration;
}

/** A step's name: text, or `[name, key]` for one made in a loop, so each pass is its own step. */
export type StepName = string | readonly [string, string | number];

/** The target of a command that names a record: its key, or, for a single-column key, the value. */
export type StepTarget = string | number | Readonly<Record<string, string | number>>;

export interface RunArguments<Input = unknown> extends StepOptions {
  readonly target?: StepTarget;
  readonly input?: Input;
}
export interface CallRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface CallOptions<Out = unknown> extends StepOptions {
  /** From the response's JSON to what the step keeps. Pure. */
  readonly parse?: (json: unknown) => Out;
}
export interface WaitOptions<Payload> {
  /** Which delivery counts. Pure: it is asked again on every wake-up. */
  readonly match?: (event: Payload) => boolean;
  /**
   * The wait ends with `null` after this long. Omitted, it waits for the event.
   * It may be computed from the start payload (a window by priority); `check`
   * then records the step's timeout as `dynamic` and each instance judges its own.
   */
  readonly timeout?: Duration;
}

/** What a workflow's function is given: the durable steps, and the version it started at. */
export interface WorkflowApi {
  /** The workflow's `version` when this instance started. */
  readonly version: number;
  /** Run an App command as the workflow's principal, once: its receipt key is the instance and the step. Returns its output. */
  run<Out = unknown>(name: StepName, command: string, args?: RunArguments): Promise<Out>;
  /** An outbound call through a declared webhook connection, with an `Idempotency-Key` header. At least once. */
  call<Out = unknown>(name: StepName, connection: string, request: CallRequest, options?: CallOptions<Out>): Promise<Out>;
  /** A durable timer. */
  sleep(name: StepName, duration: Duration): Promise<void>;
  /** A durable timer to a time. */
  until(name: StepName, when: Date | string | number): Promise<void>;
  /** The first matching event recorded since the instance began, or `null` at the timeout. */
  waitFor<Payload extends BusinessEventPayload<Payload>>(
    name: StepName,
    event: BusinessEvent<Payload>,
    options?: WaitOptions<Payload>,
  ): Promise<Payload | null>;
  /** The time, as a step: the same on every run of this instance. */
  now(name?: StepName): Promise<Date>;
}

/** The same, typed from a registry: `run` takes the command's input and returns its output. */
export interface TypedWorkflowApi<Commands extends Readonly<Record<string, AnyCommand>>> extends Omit<WorkflowApi, 'run'> {
  run<Name extends keyof Commands & string>(
    name: StepName,
    command: Name,
    args?: RunArguments<InputOf<Commands[Name]>>,
  ): Promise<OutputOf<Commands[Name]>>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand = BusinessCommand<any, any, any>;
type InputOf<C> = C extends BusinessCommand<infer I, unknown, never> ? I : C extends BusinessCommand<infer I, never, never> ? I : unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OutputOf<C> = C extends BusinessCommand<any, infer O, any> ? O : unknown;

export interface WorkflowDeclaration<Payload extends BusinessEventPayload<Payload>, Api = WorkflowApi> {
  /** Bump when the steps change in a way live instances must not follow; `w.version` exposes it. Default 1. */
  readonly version?: number;
  /** The fact that starts an instance, and its key: one live instance per key. */
  readonly start: Readonly<{ event: BusinessEvent<Payload>; key: (event: Payload) => string | number }>;
  /** A principal the module declares; its commands run as it. */
  readonly runAs: string;
  /** The other events its steps wait on, so the host delivers them. Every `waitFor` names one of these. */
  // Each event has its own payload type; the host reads only their identities.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly listens?: readonly BusinessEvent<any>[];
  readonly run: (w: Api, start: Payload) => Promise<unknown>;
}

declare const workflowType: unique symbol;
/** A captured workflow. */
export interface Workflow {
  readonly version: number;
  readonly runAs: string;
  readonly [workflowType]: true;
}
declare const workflowsType: unique symbol;
export interface Workflows {
  readonly names: readonly string[];
  readonly [workflowsType]: true;
}

/** A workflow as the host reads it. */
export interface CapturedWorkflow {
  readonly name: string;
  readonly version: number;
  readonly runAs: string;
  /** The event that starts an instance, and every one it may wait on. */
  readonly start: Readonly<{ name: string; version: number }>;
  readonly listens: readonly Readonly<{ name: string; version: number }>[];
  // The payload type is the declaration's business, erased here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly events: ReadonlyMap<string, BusinessEvent<any>>;
  readonly key: (payload: unknown) => unknown;
  readonly run: (w: WorkflowApi, start: unknown) => Promise<unknown>;
  /** A runner of a resource's row-driven flows (flowRunner.ts): started by the host from the record's changes, never by its start event. */
  readonly flows?: Readonly<{ resource: string }>;
}

const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return fail(`${where} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail(`${where} must not inherit configuration.`);
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || reserved.has(key)) return fail(`${where} has an unsafe property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail(`${where} must contain only enumerable data properties.`);
    copy[key] = descriptor.value;
  }
  return copy;
}
function exactly(value: Record<string, unknown>, keys: readonly string[], where: string, optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) fail(`${where} has an unknown option: ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${where} is missing its ${key}.`);
}

const workflows = new WeakMap<object, CapturedWorkflow>();
const collections = new WeakMap<object, readonly CapturedWorkflow[]>();

/**
 * Capture and freeze one workflow, without calling its function. A
 * trusted-code API, not a sandbox: the function runs in the server.
 */
export function defineWorkflow<Payload extends BusinessEventPayload<Payload>>(declaration: WorkflowDeclaration<Payload>): Workflow {
  const value = plainRecord(declaration, 'Workflow');
  exactly(value, ['start', 'runAs', 'run'], 'Workflow', ['version', 'listens']);
  const version = Object.hasOwn(value, 'version') ? value.version : 1;
  if (!Number.isSafeInteger(version) || (version as number) < 1) fail('Workflow version must be a positive integer.');
  if (typeof value.runAs !== 'string' || !PRINCIPAL.test(value.runAs))
    fail('Workflow runAs must name a principal: lowercase letters, digits and hyphens.');
  const start = plainRecord(value.start, 'Workflow start');
  exactly(start, ['event', 'key'], 'Workflow start');
  if (!isBusinessEvent(start.event)) fail('Workflow start.event must be an event created with defineEvent.');
  if (typeof start.key !== 'function' || isProxy(start.key))
    fail("Workflow start.key must be a function from the event to the workflow's key.");
  if (typeof value.run !== 'function' || isProxy(value.run)) fail('Workflow run must be an async function: run(w, start).');
  // The payload types are the declaration's business, erased here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = new Map<string, BusinessEvent<any>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyEvent = BusinessEvent<any>;
  const begin = start.event as AnyEvent;
  const listens: Array<{ name: string; version: number }> = [];
  for (const event of Object.hasOwn(value, 'listens')
    ? Array.isArray(value.listens)
      ? (value.listens as unknown[])
      : fail('Workflow listens must be a list of events.')
    : []) {
    if (!isBusinessEvent(event)) fail('Workflow listens holds events created with defineEvent.');
    const identity = `${(event as AnyEvent).name}@${(event as AnyEvent).version}`;
    if (!events.has(identity) && identity !== `${begin.name}@${begin.version}`) {
      events.set(identity, event as AnyEvent);
      listens.push({ name: (event as AnyEvent).name, version: (event as AnyEvent).version });
    }
  }
  events.set(`${begin.name}@${begin.version}`, begin);
  const key = start.key as (payload: unknown) => unknown,
    run = value.run as (w: WorkflowApi, start: unknown) => Promise<unknown>;
  const captured: CapturedWorkflow = Object.freeze({
    name: '',
    version: version as number,
    runAs: value.runAs as string,
    start: Object.freeze({ name: begin.name, version: begin.version }),
    listens: Object.freeze(listens.map((item) => Object.freeze(item))),
    events,
    key: (payload: unknown) => Reflect.apply(key, undefined, [payload]),
    run: (w: WorkflowApi, input: unknown) => Reflect.apply(run, undefined, [w, input]),
  });
  const workflow = Object.freeze({ version: captured.version, runAs: captured.runAs }) as unknown as Workflow;
  workflows.set(workflow, captured);
  return workflow;
}

/** Trusted platform code only (flowRunner.ts): the workflow runs a resource's row-driven flows. */
export function markFlowWorkflow(workflow: Workflow, resource: string): Workflow {
  const captured = workflows.get(workflow);
  if (!captured || captured.flows) return fail('A flows runner is marked once.');
  workflows.set(workflow, Object.freeze({ ...captured, flows: Object.freeze({ resource }) }));
  return workflow;
}

/** The workflows of a module: a workflow is named by its key, which is part of its stored identity. */
export function defineWorkflows(declared: Readonly<Record<string, Workflow>>): Workflows {
  const value = plainRecord(declared, 'Workflows');
  const entries = Object.entries(value);
  if (!entries.length) fail('Workflows must declare at least one workflow.');
  const captured: CapturedWorkflow[] = [];
  for (const [id, workflow] of entries) {
    const found = workflow && typeof workflow === 'object' ? workflows.get(workflow) : undefined;
    if (!found) return fail(`Workflow "${id}" must be created with defineWorkflow.`);
    if (!WORKFLOW_NAME.test(id))
      fail("A workflow's name (its key) must start with a letter and contain only letters, digits, underscores or hyphens, at most 60.");
    captured.push(Object.freeze({ ...found, name: id }));
  }
  const result = Object.freeze({ names: Object.freeze(captured.map((item) => item.name)) }) as unknown as Workflows;
  collections.set(result, Object.freeze(captured));
  return result;
}

/** The captured workflows behind a defineWorkflows result. */
export function capturedWorkflows(value: unknown): readonly CapturedWorkflow[] {
  const found = value && typeof value === 'object' ? collections.get(value) : undefined;
  return found ?? fail('Workflows must be created with defineWorkflows.');
}

/**
 * `defineWorkflow` whose `w.run` is typed from the command registry the
 * workflow runs against: the command's name, its input and its output.
 * `const { defineWorkflow } = workflowsFor<typeof commands>();`
 */
export function workflowsFor<Commands extends Readonly<Record<string, AnyCommand>>>(): {
  defineWorkflow<Payload extends BusinessEventPayload<Payload>>(
    declaration: WorkflowDeclaration<Payload, TypedWorkflowApi<Commands>>,
  ): Workflow;
} {
  return { defineWorkflow: (declaration) => defineWorkflow(declaration as unknown as WorkflowDeclaration<never>) };
}

/** A step's name as persisted: the text, or `name[key]` for a loop's. */
export function stepName(name: unknown): string {
  const plain = (text: unknown) => typeof text === 'string' && STEP_NAME.test(text);
  if (plain(name)) return name as string;
  if (
    Array.isArray(name) &&
    name.length === 2 &&
    plain(name[0]) &&
    (Number.isSafeInteger(name[1]) || (typeof name[1] === 'string' && /^[A-Za-z0-9_.:@-]{1,64}$/.test(name[1])))
  )
    return `${name[0]}[${name[1]}]`;
  return fail('A step name is text of letters, digits, spaces, dots, dashes and underscores, or [name, key] for a step made in a loop.');
}
export const isStatic = (name: unknown): boolean => typeof name === 'string';

/** A command or connection reference as the engine hashes and runs it. */
export const commandReference = (value: unknown, where: string): string =>
  typeof value === 'string' && COMMAND_ID.test(value) ? value : fail(`${where} must name a command, as defineCommands registers it.`);
export const connectionReference = (value: unknown, where: string): string =>
  typeof value === 'string' && CONNECTION.test(value) ? value : fail(`${where} must name a webhook connection from the config file.`);
