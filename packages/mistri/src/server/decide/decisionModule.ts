/**
 * The decisions vocabulary, part of `@mistriwork/mistri/jobs`. A decision is a
 * declaration: a question about one record of `target`, the record fields it
 * is asked from, the command whose input field it answers, and how sure a
 * provider's answer must be before that command runs (`apply`) or a person is
 * offered it (`suggest`). It holds no prompt template and no handler: the
 * answer's type is the answer field's own (a choice, a number, a yes or no, a
 * reference, a list of references), and landing it is the command's
 * business, under its grants, its `when` and its transaction.
 *
 * A decision never runs inside a command's handler — a model call would hold
 * the write. It runs after a command commits (`on`, a job's trigger) or on a
 * clock over the records `where` holds (`every`, a job at times), as the
 * principal `runAs` names; the jobs host does that (decideHost.ts). So a
 * decision is captured here and handed to `defineJobs` as `decisions`, where
 * each becomes a job of the module under the reserved `decide-` prefix:
 * decisions on one trigger, record and command are one job, one batched
 * provider call and one command run.
 */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isBusinessEvent, type BusinessEvent, type BusinessEventPayload } from '../commands/businessEvents.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import { parseEvery, type JobEvery } from '../jobs/jobSchedule.js';
import type { CapturedJob, JobCommandReference } from '../jobs/jobModule.js';
import { PROVIDER_NAMES, type ProviderName } from './providers/decisionProvider.js';

/** The reserved prefix of a decision's job id: a jobs module cannot declare a job under it. */
const DECISION_JOB_PREFIX = 'decide-';
export const isDecisionJob = (id: string): boolean => id.startsWith(DECISION_JOB_PREFIX);

/** A decision's name is persisted (its rows, its lock lines, its job's id), so it is checked like an identifier. */
const DECISION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,55}$/;
const PRINCIPAL = /^[a-z][a-z0-9-]{0,62}$/;
const COMMAND_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESOURCE = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\.[A-Za-z_][A-Za-z0-9_]{0,127})?$/;
/** A column, a rollup, a computed column, or a label path through references (`caller_id.company_id.name`). */
const INPUT = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\.[A-Za-z_][A-Za-z0-9_]{0,127}){0,3}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** At most this many inputs: a decision is asked from a record's fields, not a document. */
const MAX_INPUTS = 24;
/** A clock decision's records each slot: the rest wait for the next. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const DEFAULT_DEADLINE_MS = 3_000;
/** Below an attempt's own time (jobLoader.ts, at most 15 seconds), with room to read and to apply. */
const MAX_DEADLINE_MS = 10_000;
const DEFAULT_FRESH_MS = 600_000;
/** The default `suggest`: below it, nothing is shown. */
const DEFAULT_SUGGEST = 0.6;

export class DecisionDeclarationError extends Error {
  readonly code = 'invalid-decision-declaration';
  constructor(message: string) {
    super(message);
    this.name = 'DecisionDeclarationError';
  }
}
const fail = (message: string): never => {
  throw new DecisionDeclarationError(message);
};

/** The record a decision is about, from the fact that starts it. */
export type DecisionKey = Readonly<Record<string, string | number>>;

interface DecisionBase {
  /** What is asked, in words a person would ask it: it is sent as it is, and shown in "Why this?". */
  readonly question: string;
  /** The resource the decision is about: the answer command's target. */
  readonly target: string;
  /** The record fields it is asked from: the target's columns, rollups and computed columns, and label paths (`caller_id.company_id.name`). */
  readonly inputs: readonly string[];
  /** The command that lands the answer, and its input field the answer is: that field's type is the answer's. Only a person
   * granted this command is shown the suggestion, its list mark or "Why this?"; the server holds the rest back. */
  readonly answer: Readonly<{ command: string; field: string }>;
  /** At or above it, the command runs as `runAs` — only once `mistri decide eval --pin` pinned the provider's model. Omitted: the decision only suggests. */
  readonly apply?: number;
  /** At or above it (below `apply`), a person is offered the answer on the field. Default 0.6; at least 0.5. */
  readonly suggest?: number;
  /** A principal the module declares: inputs and choices are read, and the command runs, as it. */
  readonly runAs: string;
  /** Who answers: the first, then each next one while the one before is failing — a fallback only suggests, unless pinned. */
  readonly provider: ProviderName | readonly ProviderName[];
  /** The provider's model; omitted, its default. */
  readonly model?: string;
  /** How long a provider has to answer: `'3 seconds'` (the default), at most 10 seconds. */
  readonly deadline?: string;
  /** How long a busy or failing provider is tried again before the decision is given up as `none`: `'10 minutes'` (the default). */
  readonly fresh?: string;
}

/** A decision after a command commits: the job trigger's `on`, and the record the fact names. */
export interface EventDecisionDeclaration<Payload extends BusinessEventPayload<Payload>> extends DecisionBase {
  readonly on: Readonly<{ event: BusinessEvent<Payload>; command: string; key: (event: Payload) => DecisionKey }>;
}

/** A decision on a clock: each slot, over at most `limit` records `where` holds, oldest asked first. */
export interface ClockDecisionDeclaration extends DecisionBase {
  /** Five cron fields, or @hourly, @daily, @weekly, @monthly, read on `timezone`'s wall clock (UTC unless named). */
  readonly every: string;
  readonly timezone?: string;
  /** The records asked about, in the query language over the target's columns; omitted, every record. */
  readonly where?: string;
  /** A tenant App's: once per active tenant, or once on the platform. */
  readonly realm?: 'tenant' | 'platform';
  /** At most this many records a slot; default 500, at most 5,000. */
  readonly limit?: number;
}

declare const decisionType: unique symbol;
/** A captured decision declaration. */
export interface Decision {
  readonly question: string;
  readonly target: string;
  readonly [decisionType]: true;
}
declare const decisionsType: unique symbol;
/** What `defineDecisions` returns: handed to `defineJobs` as `decisions`. */
export interface Decisions {
  readonly names: readonly string[];
  readonly [decisionsType]: true;
}

/** A decision as the host reads it. */
export interface CapturedDecision {
  readonly name: string;
  readonly question: string;
  readonly target: string;
  readonly inputs: readonly string[];
  readonly answer: Readonly<{ command: JobCommandReference; field: string }>;
  readonly apply?: number;
  readonly suggest: number;
  readonly runAs: string;
  readonly providers: readonly ProviderName[];
  readonly model?: string;
  readonly deadlineMs: number;
  readonly freshMs: number;
  // The event's payload type is the declaration's business, erased here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly on?: Readonly<{ event: BusinessEvent<any>; from: JobCommandReference; key: (payload: unknown) => unknown }>;
  readonly every?: JobEvery;
  readonly where?: string;
  readonly realm?: 'tenant' | 'platform';
  readonly limit: number;
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
function commandReference(value: unknown, where: string): JobCommandReference {
  if (typeof value !== 'string' || !COMMAND_ID.test(value))
    return fail(`${where} must name a command, as defineCommands registers it: command: 'triageTicket'.`);
  return Object.freeze({ id: value, version: 1 });
}
function threshold(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 1)
    return fail(`Decision ${where} is a probability from 0.5 to 1, such as ${where}: 0.9.`);
  return value;
}
function duration(value: unknown, fallback: number, where: string, low: number, high: number, example: string): number {
  if (value === undefined) return fallback;
  const ms = parseDuration(value);
  if (!ms || ms < low || ms > high) return fail(`Decision ${where} is a duration ${example}.`);
  return ms;
}

const captured = new WeakMap<object, Omit<CapturedDecision, 'name'>>();
const collections = new WeakMap<object, readonly CapturedDecision[]>();

/**
 * Capture and freeze one decision, without calling its key. A trusted-code
 * API, not a sandbox: the key runs in the server, on each fact's payload.
 */
export function defineDecision(declaration: ClockDecisionDeclaration): Decision;
export function defineDecision<Payload extends BusinessEventPayload<Payload>>(declaration: EventDecisionDeclaration<Payload>): Decision;
export function defineDecision<Payload extends BusinessEventPayload<Payload>>(
  declaration: EventDecisionDeclaration<Payload> | ClockDecisionDeclaration,
): Decision {
  const value = plainRecord(declaration, 'Decision');
  const common = ['question', 'target', 'inputs', 'answer', 'runAs', 'provider'];
  const optional = ['apply', 'suggest', 'model', 'deadline', 'fresh'];
  const clock = Object.hasOwn(value, 'every');
  if (clock && Object.hasOwn(value, 'on')) fail('Decision runs after a command commits (on) or on a clock (every), not both.');
  if (!clock && !Object.hasOwn(value, 'on'))
    fail("Decision needs a trigger: on: { event, command, key } after a command commits, or every: '0 5 * * 1' on a clock.");
  if (clock) exactly(value, [...common, 'every'], 'Decision', [...optional, 'timezone', 'where', 'realm', 'limit']);
  else exactly(value, [...common, 'on'], 'Decision', optional);

  const question = value.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 500)
    fail('Decision question is the question asked, in words, at most 500 characters.');
  if (typeof value.target !== 'string' || !RESOURCE.test(value.target))
    fail("Decision target names a resource of the App: target: 'incident'.");
  const inputs = value.inputs;
  if (
    !Array.isArray(inputs) ||
    !inputs.length ||
    inputs.length > MAX_INPUTS ||
    inputs.some((input) => typeof input !== 'string' || !INPUT.test(input)) ||
    new Set(inputs).size !== inputs.length
  )
    fail(
      `Decision inputs are 1 to ${MAX_INPUTS} distinct fields of the record: columns, rollups, computed columns or label paths ('caller_id.company_id.name').`,
    );
  const answer = plainRecord(value.answer, 'Decision answer');
  exactly(answer, ['command', 'field'], 'Decision answer');
  const command = commandReference(answer.command, 'Decision answer.command');
  if (typeof answer.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(answer.field))
    fail("Decision answer.field names the command's input field the answer is: field: 'category_id'.");
  if ((inputs as string[]).includes(answer.field as string))
    fail(`Decision inputs name "${answer.field}", the field it answers: an answer is never asked from itself.`);
  const suggest = value.suggest === undefined ? DEFAULT_SUGGEST : threshold(value.suggest, 'suggest');
  const apply = value.apply === undefined ? undefined : threshold(value.apply, 'apply');
  if (apply !== undefined && !(suggest < apply))
    fail(`Decision suggest (${suggest}) must be below apply (${apply}): between them, a person is offered the answer.`);
  if (typeof value.runAs !== 'string' || !PRINCIPAL.test(value.runAs))
    fail('Decision runAs must name a principal: lowercase letters, digits and hyphens.');
  const providers = typeof value.provider === 'string' ? [value.provider] : value.provider;
  if (
    !Array.isArray(providers) ||
    !providers.length ||
    providers.some((name) => !(PROVIDER_NAMES as readonly unknown[]).includes(name)) ||
    new Set(providers).size !== providers.length
  )
    fail(`Decision provider is ${PROVIDER_NAMES.map((name) => `'${name}'`).join(' or ')}, or a list of them, the first asked first.`);
  if (value.model !== undefined && (typeof value.model !== 'string' || !MODEL.test(value.model)))
    fail("Decision model names the provider's model: model: 'claude-sonnet-5-5'.");
  const deadlineMs = duration(value.deadline, DEFAULT_DEADLINE_MS, 'deadline', 1_000, MAX_DEADLINE_MS, "from '1 second' to '10 seconds'");
  const freshMs = duration(value.fresh, DEFAULT_FRESH_MS, 'fresh', 60_000, 86_400_000, "from '1 minute' to '1 day'");

  let on: CapturedDecision['on'];
  let every: JobEvery | undefined;
  let limit = DEFAULT_LIMIT;
  if (clock) {
    try {
      every = parseEvery(value.every, value.timezone ?? 'UTC');
    } catch (error) {
      return fail(`Decision ${(error as Error).message}`);
    }
    if (value.where !== undefined && (typeof value.where !== 'string' || !value.where.trim() || value.where.length > 1000))
      fail("Decision where is a condition in the query language over the target's columns: where: \"status = 'active'\".");
    if (value.realm !== undefined && value.realm !== 'tenant' && value.realm !== 'platform')
      fail("Decision realm is 'tenant' or 'platform'.");
    if (value.limit !== undefined) {
      if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_LIMIT)
        fail(`Decision limit is a whole number of records from 1 to ${MAX_LIMIT.toLocaleString('en-US')}.`);
      limit = value.limit as number;
    }
  } else {
    const trigger = plainRecord(value.on, 'Decision on');
    exactly(trigger, ['event', 'command', 'key'], 'Decision on');
    if (!isBusinessEvent(trigger.event)) fail('Decision on.event must be an event created with defineEvent.');
    const key = trigger.key;
    if (typeof key !== 'function' || isProxy(key)) fail("Decision on.key must be a function of the event's payload to the record's key.");
    on = Object.freeze({
      event: trigger.event as BusinessEvent<Payload>,
      from: commandReference(trigger.command, 'Decision on.command'),
      key: (payload: unknown) => Reflect.apply(key as (payload: unknown) => unknown, undefined, [payload]),
    });
  }
  const decision = Object.freeze({ question: question as string, target: value.target as string }) as unknown as Decision;
  captured.set(
    decision,
    Object.freeze({
      question: (question as string).trim(),
      target: value.target as string,
      inputs: Object.freeze([...(inputs as string[])]),
      answer: Object.freeze({ command, field: answer.field as string }),
      ...(apply === undefined ? {} : { apply }),
      suggest,
      runAs: value.runAs as string,
      providers: Object.freeze([...(providers as ProviderName[])]),
      ...(value.model === undefined ? {} : { model: value.model as string }),
      deadlineMs,
      freshMs,
      ...(on ? { on } : {}),
      ...(every ? { every } : {}),
      ...(value.where === undefined ? {} : { where: (value.where as string).trim() }),
      ...(value.realm === undefined ? {} : { realm: value.realm as 'tenant' | 'platform' }),
      limit,
    }),
  );
  return decision;
}

/** The decisions of a jobs module, by name: its rows, its lock lines and its job are named after it. */
export function defineDecisions(declared: Readonly<Record<string, Decision>>): Decisions {
  const value = plainRecord(declared, 'Decisions');
  const entries = Object.entries(value);
  if (!entries.length) fail('Decisions must declare at least one decision.');
  const list: CapturedDecision[] = [];
  for (const [name, decision] of entries) {
    if (!DECISION_NAME.test(name))
      fail(
        `Decision "${name}": a decision's name (its key) starts with a letter and holds only letters, digits and underscores, at most 56.`,
      );
    const found = decision && typeof decision === 'object' ? captured.get(decision) : undefined;
    if (!found) return fail(`Decision "${name}" must be created with defineDecision.`);
    list.push(Object.freeze({ name, ...found }));
  }
  const result = Object.freeze({ names: Object.freeze(list.map((item) => item.name)) }) as unknown as Decisions;
  collections.set(result, Object.freeze(list));
  return result;
}

/** One defineDecision result as the host reads it, under the name a defineDecisions key would give it. */
export function capturedDecision(decision: Decision, name: string): CapturedDecision {
  if (!DECISION_NAME.test(name))
    return fail(`Decision "${name}": a decision's name starts with a letter and holds only letters, digits and underscores.`);
  const found = decision && typeof decision === 'object' ? captured.get(decision) : undefined;
  return found ? Object.freeze({ name, ...found }) : fail(`Decision "${name}" must be created with defineDecision.`);
}

/** The captured decisions behind a defineDecisions result. */
export function capturedDecisions(value: unknown): readonly CapturedDecision[] {
  const found = value && typeof value === 'object' ? collections.get(value) : undefined;
  return found ?? fail('Jobs decisions must be created with defineDecisions.');
}

/* ---------- decisions as jobs ---------- */

/** What a decision job's run carries: the records it is about, a decision each. */
export interface DecisionRun {
  readonly records: readonly Readonly<{ decision: string; key: DecisionKey }>[];
}

/**
 * The jobs a module's decisions run as. Decisions after one fact of one
 * command, about one target, landed by one command as one principal through
 * one provider list, are one job — one batched call, one command run for a
 * record they share. Each decision on a clock is a job at times of its own,
 * whose slot reads the records due and runs each as a job of the same id.
 * A job's id is `decide-` and its first decision's name, so it is stable
 * while that decision is declared.
 */
export function decisionJobs(decisions: readonly CapturedDecision[]): CapturedJob[] {
  const groups = new Map<string, CapturedDecision[]>();
  for (const decision of decisions) {
    if (decision.every) continue;
    const on = decision.on!;
    const group = JSON.stringify([
      on.event.name,
      on.event.version,
      on.from.id,
      decision.target,
      decision.answer.command.id,
      decision.runAs,
      decision.providers,
      decision.model ?? '',
    ]);
    groups.set(group, [...(groups.get(group) ?? []), decision]);
  }
  const jobs: CapturedJob[] = [];
  for (const members of groups.values()) {
    const [first] = members;
    const on = first.on!;
    const names = Object.freeze(members.map((member) => member.name));
    jobs.push(
      Object.freeze({
        id: `${DECISION_JOB_PREFIX}${first.name}`,
        version: 1,
        event: on.event,
        from: on.from,
        runAs: first.runAs,
        command: first.answer.command,
        decide: names,
        // Each decision's own reading of the fact: a record each, which the run groups by key.
        schedule: (payload: unknown) => {
          const records = members.map((member) => ({ decision: member.name, key: member.on!.key(payload) as DecisionKey }));
          return { key: records[0].key, input: { records } satisfies DecisionRun };
        },
      }),
    );
  }
  for (const decision of decisions) {
    if (!decision.every) continue;
    jobs.push(
      Object.freeze({
        id: `${DECISION_JOB_PREFIX}${decision.name}`,
        version: 1,
        every: decision.every,
        input: {},
        ...(decision.realm ? { realm: decision.realm } : {}),
        runAs: decision.runAs,
        command: decision.answer.command,
        decide: Object.freeze([decision.name]),
      }),
    );
  }
  return jobs;
}

/** A decision's contract, as decisions.lock records it: what it asks, from what, of what type, and of whom. */
export function decisionContract(decision: CapturedDecision, answerType: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        question: decision.question,
        target: decision.target,
        inputs: decision.inputs,
        answer: { command: decision.answer.command.id, field: decision.answer.field, type: answerType },
        providers: decision.providers,
      }),
    )
    .digest('hex')
    .slice(0, 12);
}
