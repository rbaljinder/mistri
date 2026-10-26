import type { JobProvenance } from '../../adapters/jobs/jobStoreTypes.js';

/** Experimental server-only contract; registration does not authorize, schedule or run a job. */
interface JobValidator<T> {
  parse(value: unknown): T;
}

/** Produced by the injected authorizer for one attempt and rechecked after the
 * handler settles. It is never stored, never a bearer token, never reused. */
export interface JobGrant {
  readonly audience: 'mistri.jobs';
  readonly job: string;
  readonly version: number;
  readonly appId: string;
  readonly expiresAt: number;
}

/**
 * What a handler receives. Deliberately no database handle, transaction or
 * command executor: a job that must write composes a caller-injected effect
 * (the App binds it to its commands) so authority and idempotency stay with
 * the command layer, not with the runner.
 */
export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly job: string;
  readonly version: number;
  readonly provenance: JobProvenance;
  /** Fires at the attempt deadline or on halt. A handler that keeps going
   * after it fires is recorded as unknown, never as succeeded. */
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** Asks the store, each call: a cancel requested while this attempt runs.
   * Cooperative; the handler decides whether to stop (throw JobCancelled) or
   * finish. Refuses once the lease is over. */
  readonly cancelRequested: () => Promise<boolean>;
  readonly grant: JobGrant;
}

export interface JobDefinition<Input> {
  readonly version: number;
  readonly input: JobValidator<Input>;
  readonly handle: (context: JobContext, input: Input) => unknown | Promise<unknown>;
}

// A registry is heterogeneous. Its named members retain their concrete input types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition = JobDefinition<any>;
export type JobRegistry = Readonly<Record<string, AnyJobDefinition>>;

/** A permanent refusal from a handler: retrying cannot help. Terminal 'rejected'. */
export class JobRejected extends Error {
  readonly code = 'rejected';
  constructor(message = 'The job handler rejected this job permanently.') {
    super(message);
    this.name = 'JobRejected';
  }
}
/** The handler honoured a cancel request and stopped without effect. */
export class JobCancelled extends Error {
  readonly code = 'cancelled';
  constructor(message = 'The job handler stopped on a cancel request.') {
    super(message);
    this.name = 'JobCancelled';
  }
}
export class JobDefinitionError extends Error {
  readonly code = 'invalid-job-definition';
  constructor(message: string) {
    super(message);
    this.name = 'JobDefinitionError';
  }
}

const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const jobIdentifier = /^[A-Za-z][A-Za-z0-9_-]*$/;
const registered = new WeakSet<object>();
const fields = new Set(['version', 'input', 'handle']);
const fail = (message: string): never => {
  throw new JobDefinitionError(message);
};

function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${where} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail(`${where} must not inherit configuration.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || reserved.has(key)) return fail(`${where} has an unsafe property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail(`${where} must contain only enumerable data properties.`);
  }
  return value as Record<string, unknown>;
}

function validator<T>(value: unknown, where: string): JobValidator<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${where} must provide a synchronous parse function.`);
  const parse = (value as { parse?: unknown }).parse;
  if (typeof parse !== 'function') return fail(`${where} must provide a synchronous parse function.`);
  // Do not invoke application validators during registration. Capture the method
  // so replacing it after registration cannot change the validated definition.
  return Object.freeze({
    parse(input: unknown): T {
      const result: unknown = Reflect.apply(parse, value, [input]);
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        // A mistaken async parser may already have rejected. Consume that
        // rejection while refusing its asynchronous result synchronously.
        void Promise.resolve(result).catch(() => {});
        return fail(`${where} must return synchronously, not a promise.`);
      }
      return result as T;
    },
  });
}

/**
 * Validate and freeze a job definition without invoking its validator or handler.
 * This is a trusted-code API, not a sandbox or a resource-authorization boundary.
 */
export function defineJobHandler<Input>(definition: JobDefinition<Input>): JobDefinition<Input> {
  const value = plainRecord(definition, 'Job');
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(`Job has an unknown option: ${key}.`);
  for (const key of fields) if (!Object.hasOwn(value, key)) fail(`Job is missing its ${key}.`);
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) fail('Job version must be a positive safe integer.');
  if (typeof value.handle !== 'function') fail('Job handler must be a function.');
  const result: JobDefinition<Input> = Object.freeze({
    version: value.version as number,
    input: validator<Input>(value.input, 'Job input validator'),
    handle: value.handle as JobDefinition<Input>['handle'],
  });
  registered.add(result);
  return result;
}

/** The runner accepts only definitions that went through defineJobHandler. */
export function isDefinedJob(value: unknown): value is AnyJobDefinition {
  return !!value && typeof value === 'object' && registered.has(value);
}

/**
 * IDs come only from own object keys. Keep this registry on the server, never
 * in an App manifest or browser bundle; a job ID names durable rows.
 */
export function defineJobHandlers<const Jobs extends Record<string, AnyJobDefinition>>(jobs: Jobs): Readonly<Jobs> {
  const value = plainRecord(jobs, 'Job registry');
  const entries = Object.entries(value);
  if (!entries.length) fail('Job registry must not be empty.');
  const result: Record<string, AnyJobDefinition> = Object.create(null);
  for (const [id, definition] of entries) {
    if (!jobIdentifier.test(id)) fail('Job IDs must start with a letter and contain only letters, digits, underscores or hyphens.');
    if (!isDefinedJob(definition)) return fail(`Job "${id}" must be created with defineJobHandler.`);
    result[id] = definition;
  }
  return Object.freeze(result) as Readonly<Jobs>;
}
