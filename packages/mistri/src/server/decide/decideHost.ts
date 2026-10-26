/**
 * Decisions at run time: the job handlers behind each `decide-<name>` job.
 *
 * One run is about one record (an event decision's, or one a clock sweep
 * found) and the decisions the run names. For each, as the decision's
 * principal through its answer command (decideReads.ts): read the inputs and
 * the column it answers, ask the first provider that may be asked, read the
 * reply against the field's type, and act on its probability (design §2):
 *
 *   p ≥ apply, a pinned model, the field still empty → run the command: applied
 *   suggest ≤ p, or a guard that failed             → suggested
 *   p < suggest                                      → below
 *
 * The row is begun before anything is asked, under an id every attempt of
 * the run computes alike — so a retry, or a second host, finds the row it
 * began and a settled decision is never asked again. A busy provider is
 * tried again, by the job's own backoff, while the decision is fresh; after
 * that, and on a timeout, an invalid answer, a refusal or a cap, the row
 * says `none` and why. A tenant's switch that is off records nothing at all.
 *
 * Nothing here holds the writer while a provider is asked: the reads are
 * advice reads (or the command's transaction where a verifier owns the
 * source), and only the apply takes the writer, as any background command
 * does (writeLanes.ts).
 */
import { createHash } from 'node:crypto';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { attributeAction, attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { CONFIDENCE_WORDS, confidenceOf } from '../../shared/decisionSuggestions.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { JobStore } from '../../adapters/jobs/jobStoreContract.js';
import type { DecisionOwner, DecisionStore, OutcomeReason } from '../../adapters/decide/decisionStore.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import type { AuthorizedBusinessCommand } from '../commands/businessCommandAccess.js';
import { executeBusinessCommand, isBusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import { jobCommandKey, type JobAttemptBinding, type JobCommandBinding } from '../jobs/jobCommands.js';
import type { CapturedJob, CapturedJobModule } from '../jobs/jobModule.js';
import { defineJobHandler, JobRejected, type AnyJobDefinition, type JobContext } from '../jobs/jobs.js';
import { readAnswer } from './decisionAnswer.js';
import { answerSpec, decisionReads } from './decisionChecks.js';
import { decisionTrust, type LockedDecision } from './decisionLock.js';
import type { CapturedDecision, DecisionKey } from './decisionModule.js';
import {
  digestOf,
  isEmpty,
  readCurrent,
  readDue,
  readRecord,
  recordKeyText,
  sameAnswer,
  type PlannedDecision,
  type RecordRead,
} from './decideReads.js';
import { circuitClosed, decisionProviders, recordCall, type DecisionProviders } from './providers/decisionProviders.js';
import { asProviderFailure, type DecisionProvider, type DecisionResult, type ProviderName } from './providers/decisionProvider.js';

/** A decision's writes, in the record's history: the system's, as the decision, named by it (design §2). */
const DECISION_ACTOR_PREFIX = 'decision:';
const decisionActor = (name: string): string => `${DECISION_ACTOR_PREFIX}${name}`;

/** What the host is given to decide with: its store, the lock read at start, and how to reach the catalog. */
export interface DecisionRuntime {
  readonly store: DecisionStore;
  /** decisions.lock as it was when the server started: a new pin takes a restart. */
  readonly lock: ReadonlyMap<string, LockedDecision>;
  /** Each decision's contract digest now (decisionCheck.ts `decisionDigests`). */
  readonly digests: ReadonlyMap<string, string>;
  /** The App's catalog as it is served: what an input's path or rollup is read through. */
  readonly schema: () => Promise<DatabaseSchema>;
  /** Injected in tests; the environment's keys otherwise (decisionProviders.ts). */
  readonly providers?: () => DecisionProviders;
  /** A tenant App: each run carries its tenant, whose switches are read before every call. */
  readonly tenancy: boolean;
  /** The calls a tenant may make a day (tenant policy `decisions.callsPerTenantPerDay`); absent, no cap. */
  readonly callsPerDay?: (tenant: string) => number | undefined;
}

interface RunInput {
  readonly key: DecisionKey;
  readonly records?: readonly Readonly<{ decision: string; key: DecisionKey }>[];
}
const KEY_PART = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function decisionKey(value: unknown): DecisionKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const entries = Object.entries(value);
  if (entries.length > 16) throw new Error();
  for (const [column, part] of entries)
    if (!KEY_PART.test(column) || !(typeof part === 'string' ? part.length > 0 && part.length <= 1024 : Number.isSafeInteger(part)))
      throw new Error();
  return Object.freeze(Object.fromEntries(entries)) as DecisionKey;
}
/** A decision job's input: `{ key, input: { records } }` for a record, `{ key: {}, input: {} }` for a clock's sweep. */
function runInput(value: unknown, names: ReadonlySet<string>): RunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const { key, input } = value as { key?: unknown; input?: unknown };
  const parsed = decisionKey(key);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  const records = (input as { records?: unknown }).records;
  if (records === undefined) {
    if (Object.keys(parsed).length) throw new Error();
    return { key: parsed };
  }
  if (!Array.isArray(records) || !records.length || records.length > 64) throw new Error();
  return {
    key: parsed,
    records: Object.freeze(
      records.map((record: unknown) => {
        const { decision, key: own } = (record ?? {}) as { decision?: unknown; key?: unknown };
        if (typeof decision !== 'string' || !names.has(decision)) throw new Error();
        return Object.freeze({ decision, key: decisionKey(own) });
      }),
    ),
  };
}

/** A row's id: the same for every attempt of one decision of one record by one trigger. */
const decisionRowId = (owner: DecisionOwner, decision: string, recordKey: string, trigger: string): string =>
  createHash('sha256')
    .update(JSON.stringify([owner.app, owner.tenant, decision, recordKey, trigger]))
    .digest('hex')
    .slice(0, 40);

/** One clock slot's run of one record: the slot's key and the record, hashed. Never a slot's or a manual run's key
 * shape (jobStoreRules.ts oneAtATime): a slot's records run beside each other, not one at a time. */
const recordRunKey = (slotKey: string, recordKey: string): string =>
  `decide-${createHash('sha256').update(`${slotKey}\n${recordKey}`).digest('hex').slice(0, 48)}`;

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const iso = (at: number) => new Date(at).toISOString();

/** Plans per App definition: a reload plans again, an attempt on the same App does not. */
const plans = new WeakMap<AppDef, Map<string, Promise<Readonly<{ reads?: PlannedDecision; problem?: string }>>>>();

/** The runner's handlers for the module's decision jobs: each overriding the job's ordinary command handler. */
export function decisionHandlers(
  options: Readonly<{
    module: CapturedJobModule;
    appId: string;
    app: () => AppDef;
    bind: JobAttemptBinding;
    jobs: JobStore;
    runtime: DecisionRuntime;
  }>,
): Record<string, AnyJobDefinition> {
  const handlers: Record<string, AnyJobDefinition> = {};
  const decisions = options.module.decisions;
  if (!decisions?.size) return handlers;
  for (const job of options.module.jobs.values()) {
    if (!job.decide?.length) continue;
    const names = new Set(job.decide);
    const actor = serviceActor(options.appId, job.runAs, options.module.principals.get(job.runAs)!);
    handlers[job.id] = defineJobHandler<RunInput>({
      version: job.version,
      input: { parse: (value) => runInput(value, names) },
      handle: (context, input) =>
        asBackgroundWork(async () => {
          let bound: JobCommandBinding | undefined;
          try {
            bound = await options.bind(context, job);
            const authorized = bound.binding.authorize(job.command.id, actor);
            if (!input.records) return await sweep(options, job, context, authorized);
            return await decideRecord(options, job, context, bound, authorized, input.records);
          } finally {
            bound?.release();
          }
        }),
    });
  }
  return handlers;
}

/** A clock slot: the records `where` holds, at most `limit`, each enqueued as a run of its own under the slot's key. */
async function sweep(
  options: Parameters<typeof decisionHandlers>[0],
  job: CapturedJob,
  context: JobContext,
  authorized: AuthorizedBusinessCommand,
): Promise<{ enqueued: number }> {
  const decision = options.module.decisions!.get(job.decide![0])!;
  const slotKey = context.provenance.causationId;
  if (!slotKey) throw new JobRejected('The sweep names no slot.');
  const keys = await readDue(authorized, decision.where, decision.limit, new Date(context.now()));
  for (const key of keys)
    await options.jobs.enqueue(
      {
        job: job.id,
        version: job.version,
        idempotencyKey: recordRunKey(slotKey, recordKeyText(key)),
        input: { key, input: { records: [{ decision: decision.name, key }] } },
        provenance: { ...context.provenance, causationId: slotKey },
      },
      context.now(),
    );
  return { enqueued: keys.length };
}

interface Asked {
  readonly decision: CapturedDecision;
  readonly planned: PlannedDecision;
  readonly id: string;
  readonly createdAt: number;
}

/** One record's decisions: read once, asked by provider, each acted on and recorded. */
async function decideRecord(
  options: Parameters<typeof decisionHandlers>[0],
  job: CapturedJob,
  context: JobContext,
  bound: JobCommandBinding,
  authorized: AuthorizedBusinessCommand,
  records: NonNullable<RunInput['records']>,
): Promise<{ decided: number }> {
  const { runtime } = options;
  const app = options.app();
  const tenant = context.provenance.tenantId ?? '';
  /* The platform realm of a tenant App never decides: consent is a tenant's (design §4). */
  if (runtime.tenancy && !tenant) return { decided: 0 };
  const owner: DecisionOwner = { app: options.appId, tenant };
  const providers = (runtime.providers ?? decisionProviders)();
  const switchedOn = runtime.tenancy
    ? new Set((await runtime.store.switches(options.appId, tenant)).filter((each) => each.enabled).map((each) => each.provider))
    : undefined;
  const now = () => context.now();
  const eventId = context.provenance.causationId;
  if (!eventId) throw new JobRejected('The decision run names no trigger.');
  const trigger = job.every ? `every:${eventId}` : `event:${job.event!.name}#${eventId}`;
  const local = (logical: string) =>
    Object.keys(authorized.catalog).find((name) => logicalResource(app, authorized.command.source, name) === logical);

  /* Group by record: one read serves every decision of it. */
  const byKey = new Map<string, { key: DecisionKey; names: string[] }>();
  for (const record of records) {
    const text = recordKeyText(record.key);
    const entry = byKey.get(text) ?? { key: record.key, names: [] };
    entry.names.push(record.decision);
    byKey.set(text, entry);
  }
  let decided = 0;
  let again = false;
  for (const { key, names } of byKey.values()) {
    const planned: PlannedDecision[] = [];
    for (const name of names) {
      const decision = options.module.decisions!.get(name)!;
      // Nothing is recorded for a decision no provider may be asked for: no key, or the tenant's switch off.
      if (!decision.providers.some((provider) => providers[provider] && (!switchedOn || switchedOn.has(provider)))) continue;
      const plan = await planOf(app, decision, authorized, runtime);
      if (plan.reads) planned.push(plan.reads);
    }
    if (!planned.length) continue;
    const read = await readRecord(authorized, local, planned, key, new Date(now()));
    if (!read) continue;
    const asked: Asked[] = [];
    for (const plan of planned) {
      const decision = options.module.decisions!.get(plan.name)!;
      const id = decisionRowId(owner, decision.name, read.recordKey, trigger);
      const trust = decisionTrust(runtime.lock, decision.name, runtime.digests.get(decision.name) ?? '');
      const begun = await runtime.store.begin(owner, {
        id,
        decision: decision.name,
        contractVersion: trust.contractVersion,
        resource: decision.target,
        recordKey: read.recordKey,
        field: decision.answer.field,
        trigger,
        inputFields: decision.inputs,
        createdAt: iso(now()),
      });
      if (begun.row.outcomeReason !== 'pending') continue; // Decided by an earlier attempt, or another host.
      asked.push({ decision, planned: plan, id, createdAt: Date.parse(begun.row.createdAt) });
    }
    /* The cap is read before the call (design §5): over it, each is `none (cap)` and nothing is asked. */
    const cap = runtime.callsPerDay?.(tenant);
    if (cap !== undefined && asked.length && (await runtime.store.calls(owner, day(now()))).tenant >= cap) {
      for (const each of asked) await give(runtime.store, owner, each, read, 'none', 'cap', now());
      decided += asked.length;
      continue;
    }
    for (const group of byProvider(asked, providers, switchedOn, now())) {
      const outcome = await ask(job, context, bound, authorized, owner, read, group, runtime, now);
      decided += outcome.decided;
      again ||= outcome.again;
    }
  }
  // A busy provider is asked again by the job's backoff, while the decisions it left pending are fresh.
  if (again) throw new Error('A decision provider was busy; the decision is asked again.');
  return { decided };
}

/** A decision's plan for the App loaded now: its reads and its answer's type, or why it cannot be made. */
async function planOf(
  app: AppDef,
  decision: CapturedDecision,
  authorized: AuthorizedBusinessCommand,
  runtime: DecisionRuntime,
): Promise<Readonly<{ reads?: PlannedDecision; problem?: string }>> {
  let cached = plans.get(app);
  if (!cached) plans.set(app, (cached = new Map()));
  let plan = cached.get(decision.name);
  if (!plan) {
    plan = (async () => {
      const spec = answerSpec(authorized.command, decision.answer.field);
      if (typeof spec === 'string') return { problem: spec };
      const reads = decisionReads(decision, app, await runtime.schema());
      if (!reads.reads) return { problem: reads.problems.join(' ') };
      return { reads: { name: decision.name, field: decision.answer.field, reads: reads.reads, spec } };
    })();
    cached.set(decision.name, plan);
    plan.catch(() => cached!.delete(decision.name));
  }
  return plan;
}

/** The decisions asked of one provider together: a batching provider in one call, any other one by one. */
function byProvider(
  asked: readonly Asked[],
  providers: DecisionProviders,
  switchedOn: ReadonlySet<string> | undefined,
  at: number,
): Array<{ provider: DecisionProvider | undefined; asks: Asked[] }> {
  const groups = new Map<string, { provider: DecisionProvider | undefined; asks: Asked[] }>();
  for (const each of asked) {
    /* The first provider that may be asked now: a fallback is asked while the one before it is failing. */
    const usable = each.decision.providers.filter((name) => providers[name] && (!switchedOn || switchedOn.has(name)));
    const name = usable.find((candidate) => circuitClosed(candidate, at));
    const provider = name ? providers[name] : undefined;
    const group = `${name ?? ''}|${each.decision.model ?? ''}`;
    const entry = groups.get(group) ?? { provider, asks: [] };
    if (provider && !provider.batches && entry.asks.length) groups.set(`${group}|${each.id}`, { provider, asks: [each] });
    else groups.set(group, { ...entry, asks: [...entry.asks, each] });
  }
  return [...groups.values()];
}

async function give(
  store: DecisionStore,
  owner: DecisionOwner,
  asked: Asked,
  read: RecordRead,
  outcome: 'none',
  reason: OutcomeReason,
  at: number,
  provider = '',
): Promise<void> {
  await store.answer(owner, asked.id, {
    provider,
    model: '',
    modelVersion: '',
    inputsDigest: digestOf(read.inputs.get(asked.decision.name) ?? {}),
    choicesDigest: read.choicesDigest.get(asked.decision.name) ?? '',
    answer: null,
    probability: null,
    outcome,
    outcomeReason: reason,
    latencyMs: 0,
    costMicros: 0,
    units: 0,
    at: iso(at),
  });
}

/** Ask one provider for a group of decisions of one record, and act on each answer. */
async function ask(
  job: CapturedJob,
  context: JobContext,
  bound: JobCommandBinding,
  authorized: AuthorizedBusinessCommand,
  owner: DecisionOwner,
  read: RecordRead,
  group: { provider: DecisionProvider | undefined; asks: Asked[] },
  runtime: DecisionRuntime,
  now: () => number,
): Promise<{ decided: number; again: boolean }> {
  const { provider, asks } = group;
  const fresh = (each: Asked) => now() < each.createdAt + each.decision.freshMs && context.attempt < context.maxAttempts;
  if (!provider) {
    // Every provider's circuit is open: busy, asked again while fresh.
    const stale = asks.filter((each) => !fresh(each));
    for (const each of stale) await give(runtime.store, owner, each, read, 'none', 'error', now());
    return { decided: stale.length, again: stale.length < asks.length };
  }
  const deadline = AbortSignal.timeout(Math.max(...asks.map((each) => each.decision.deadlineMs)));
  const signal = AbortSignal.any([deadline, context.signal]);
  const started = now();
  let result: DecisionResult;
  try {
    result = await provider.decide({
      ...(asks[0].decision.model ? { model: asks[0].decision.model } : {}),
      asks: asks.map((each) => ({
        id: each.decision.name,
        question: each.decision.question,
        inputs: read.inputs.get(each.decision.name) ?? {},
        answer: read.answers.get(each.decision.name)!,
      })),
      signal,
    });
    recordCall(provider.name, true, now());
  } catch (error) {
    const failure = asProviderFailure(error, deadline);
    recordCall(provider.name, false, now());
    /* A timeout is final at once (design §5); a busy provider is asked again while the decision is fresh. */
    const final = (each: Asked) => failure.kind !== 'busy' || !fresh(each);
    const reason: OutcomeReason = failure.kind === 'timeout' ? 'timeout' : failure.kind === 'refused' ? 'refused' : 'error';
    let decided = 0;
    for (const each of asks.filter(final)) {
      await give(runtime.store, owner, each, read, 'none', reason, now(), provider.name);
      decided += 1;
    }
    return { decided, again: decided < asks.length };
  }
  const latencyMs = Math.max(0, now() - started);
  // One call's cost, split across the decisions it answered.
  const share = (total: number) => Math.round(total / asks.length);
  await runtime.store.spend(owner, day(now()), result.units, result.costMicros);
  let decided = 0;
  for (const each of asks) {
    const name = each.decision.name;
    const reply = result.replies.find((candidate) => candidate.id === name);
    const type = read.answers.get(name)!;
    const answer = reply ? readAnswer(type, reply) : undefined;
    const base = {
      provider: provider.name,
      model: result.model,
      modelVersion: result.modelVersion,
      inputsDigest: digestOf(read.inputs.get(name) ?? {}),
      choicesDigest: read.choicesDigest.get(name) ?? '',
      latencyMs,
      costMicros: share(result.costMicros),
      units: share(result.units),
      at: iso(now()),
    };
    decided += 1;
    if (!answer) {
      await runtime.store.answer(owner, each.id, { ...base, answer: null, probability: null, outcome: 'none', outcomeReason: 'invalid' });
      continue;
    }
    const acted = await act(job, context, bound, authorized, read, each, answer, provider.name, result, runtime);
    await runtime.store.answer(owner, each.id, {
      ...base,
      answer: answer.answer,
      probability: answer.probability,
      outcome: acted.outcome,
      outcomeReason: acted.reason,
    });
  }
  return { decided, again: false };
}

/** What a read answer comes to: the stale guard, the pin, the thresholds, and the command when it applies. */
async function act(
  job: CapturedJob,
  context: JobContext,
  bound: JobCommandBinding,
  authorized: AuthorizedBusinessCommand,
  read: RecordRead,
  asked: Asked,
  answer: { answer: unknown; probability: number },
  provider: ProviderName,
  result: DecisionResult,
  runtime: DecisionRuntime,
): Promise<{ outcome: 'applied' | 'suggested' | 'accepted' | 'below' | 'none'; reason: OutcomeReason }> {
  const { decision } = asked;
  const current = read.current.get(decision.name);
  /* A field already holding this answer is the answer accepted: someone got there first (design §2). */
  if (!isEmpty(current) && sameAnswer(current, answer.answer)) return { outcome: 'accepted', reason: 'filled' };
  if (answer.probability < decision.suggest) return { outcome: 'below', reason: '' };
  const trust = decisionTrust(runtime.lock, decision.name, runtime.digests.get(decision.name) ?? '');
  /* Only a pinned (provider, model version) applies: a fallback, or a model that drifted, only suggests (design §5). */
  const applies = decision.apply !== undefined && answer.probability >= decision.apply && trust.pinned(provider, result.modelVersion);
  if (!applies) return { outcome: 'suggested', reason: isEmpty(current) ? '' : 'filled' };
  /* Never overwrite a person's value: a filled field gets a suggestion beside it. */
  if (!isEmpty(current)) return { outcome: 'suggested', reason: 'filled' };
  /* The guard read again, just before the write: a field filled meanwhile is a person's. */
  const now = await readCurrent(authorized, read.key, [decision.answer.field]);
  if (!now) return { outcome: 'none', reason: 'stale' };
  if (!isEmpty(now[decision.answer.field])) return { outcome: 'suggested', reason: 'stale' };
  try {
    const flags = await commandFlagsOnce(() => bound.captureFlags?.(authorized.actor))();
    /* The history line says what ran, and which decision ran it how surely: "Categorize · Triage category (very likely)". */
    const name = `${humanName(decision.name)} (${CONFIDENCE_WORDS[confidenceOf(answer.probability)]})`;
    await attributeWrites({ via: 'system', actor: decisionActor(decision.name), name }, () =>
      attributeAction(humanName(decision.answer.command.id), () =>
        executeBusinessCommand(
          bound.binding,
          authorized.actor,
          {
            // The job's reference is the one pinned to the version authority.lock holds.
            command: job.command.id,
            commandVersion: job.command.version,
            key: read.key,
            expectedVersion: 0,
            idempotencyKey: jobCommandKey(`decide:${decision.name}`, 1, asked.id),
            input: { [decision.answer.field]: answer.answer },
          },
          {
            signal: context.signal,
            requestId: `decide:${context.jobId}:${context.attempt}`,
            now: () => new Date(context.now()),
            flags,
            door: 'job',
          },
        ),
      ),
    );
    return { outcome: 'applied', reason: '' };
  } catch (error) {
    /* The command's own refusal (its `when`, a guard) is the record's word: `none (refused)`. Anything that
       may pass on a retry leaves the answer offered instead, so a person can still take it. */
    if (isBusinessCommandExecutionError(error) && !RETRIED.has(error.code)) return { outcome: 'none', reason: 'refused' };
    return { outcome: 'suggested', reason: 'stale' };
  }
}
const RETRIED = new Set(['stale_record', 'temporarily_unavailable', 'row_locked', 'cancelled']);
