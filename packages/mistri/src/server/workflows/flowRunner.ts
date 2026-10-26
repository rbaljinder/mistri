/**
 * The runner of a resource's row-driven flows, as a jobs module
 * declares it:
 *
 *   workflows: defineWorkflows({ orderFlows: flowRunner('purchase_order', { runAs: 'automation', listens: [poDecided] }) })
 *
 * It is a durable workflow like any (workflowEngine.ts) whose steps are not
 * written in code but read from rows (appFlows.ts): one instance per record
 * and flow, started by the host when a change of the record matches a flow
 * (jobHost.ts), never by an event. Its first step reads the flow's rows as a
 * plan and keeps it, so a flow edited while a run is under way changes the
 * next run and never this one; every step after is the engine's own — a
 * timer, a wait for an event about this record, or a command — under a name
 * made of its kind and its position, so a restart replays what was done.
 * Steps that share a position begin one after another (their commands run,
 * their fields are set) and are then waited on in turn: the run goes on once
 * each is done, whichever finished first, because an event a wait took is no
 * other wait's and one recorded before its wait began still counts.
 *
 * A row the run cannot follow stops it with a sentence (FlowStopped), which
 * the record's page shows; the rows are judged when written too, so this is
 * the rare case of a row written before a rule changed.
 */
import { shape, text } from '../commands/commandShapes.js';
import { defineEvent, isBusinessEvent, type BusinessEvent } from '../commands/businessEvents.js';
import { flowCommandId } from './flowCommand.js';
import {
  defineWorkflow,
  FlowStopped,
  markFlowWorkflow,
  WorkflowDeclarationError,
  type Duration,
  type Workflow,
  type WorkflowApi,
} from './workflowModule.js';
import type { FlowPlan, PlanStep } from '../../shared/appFlows.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';

/** A run's start, as the host writes it: the record (its history key, and its key's value) and the flow. */
interface FlowStart {
  readonly record: string;
  readonly target: string;
  readonly flow: string;
}
/* The platform's own: never recorded by a command and never delivered; it is
   the parser the engine reads a run's start with. */
const FLOW_START: BusinessEvent<FlowStart> = defineEvent(
  'mistri.flow',
  shape({ record: text({ max: 440 }), target: text({ max: 512 }), flow: text({ max: 128 }) }),
);

export interface FlowRunnerOptions {
  /** A principal the jobs module declares: it runs the flows' reads and `set` steps, and each step kind's command. */
  readonly runAs: string;
  /** The events a step may wait for, as the App's `flows.events` names them. */
  // Each event has its own payload type; the runner reads only the field that names the record.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly listens?: readonly BusinessEvent<any>[];
  /** Bump when a change to how the runner runs must not reach instances already running. Default 1. */
  readonly version?: number;
}

/** A key's value as its command names it: a whole number where it reads as one (ids past 2^53 stay text). */
const targetOf = (value: string): string | number => {
  const n = Number(value);
  return /^-?\d+$/.test(value) && Number.isSafeInteger(n) && String(n) === value ? n : value;
};
const plain = (raw: unknown): Record<string, unknown> => {
  const value = raw && typeof raw === 'object' ? (raw as { json?: unknown }).json : undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : undefined;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};

/** Declare the runner of a resource's flows. Its steps are the rows; nothing here runs until the `--jobs` host starts. */
export function flowRunner(resource: string, options: FlowRunnerOptions): Workflow {
  if (typeof resource !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resource))
    throw new WorkflowDeclarationError(
      "flowRunner names a resource of the App whose flows it runs, like flowRunner('purchase_order', { runAs }).",
    );
  if (!options || typeof options !== 'object') throw new WorkflowDeclarationError('flowRunner takes { runAs, listens?, version? }.');
  const unknown = Object.keys(options).find((key) => !['runAs', 'listens', 'version'].includes(key));
  if (unknown) throw new WorkflowDeclarationError(`flowRunner has an unknown option: ${unknown}.`);
  const listens = options.listens ?? [];
  if (!Array.isArray(listens) || listens.some((event) => !isBusinessEvent(event)))
    throw new WorkflowDeclarationError('flowRunner listens holds events created with defineEvent.');
  const events = new Map(listens.map((event) => [event.name, event]));
  const command = flowCommandId(resource);
  const workflow = defineWorkflow<FlowStart>({
    start: { event: FLOW_START, key: (start) => `${start.record}|${start.flow}` },
    runAs: options.runAs,
    listens: [...listens],
    ...(options.version === undefined ? {} : { version: options.version }),
    run: (w, start) => runFlow(w, start, command, events),
  });
  return markFlowWorkflow(workflow, resource);
}

/** The most reminders one step sends: past them it waits on, quietly. */
const REMINDERS_MOST = 50;
/** The most decisions an `all` step waits for. */
const ASKED_MOST = 1_000;
/** A wait's time as the engine reads it, in whole seconds. */
const seconds = (ms: number): Duration => `${Math.max(1, Math.ceil(ms / 1000))} seconds`;

async function runFlow(
  w: WorkflowApi,
  start: FlowStart,
  command: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: ReadonlyMap<string, BusinessEvent<any>>,
): Promise<unknown> {
  const target = targetOf(start.target);
  const ask = async (name: string | readonly [string, number | string], input: Record<string, string>) =>
    plain(await w.run(name, command, { target, input }));
  const plan = (await ask('load', { op: 'load', flow: start.flow })) as unknown as FlowPlan;
  if (plan.problem)
    throw new FlowStopped(
      'load',
      plan.problem.position === null ? plan.problem.reason : `Step ${plan.problem.position}: ${plan.problem.reason}`,
    );
  for (const step of plan.steps) {
    const awaited = step.kind === 'waitFor' ? step.event : step.kind === 'command' ? step.waitFor?.event : undefined;
    if (awaited !== undefined && !events.has(awaited))
      throw new FlowStopped('load', `Step ${step.position}: the flows runner does not listen for "${awaited}".`);
  }
  /* The wait for an event about this record: its field names the record's key. */
  const waitFor = (name: number | string, event: string, field: string, timeout?: Duration) =>
    w.waitFor(['event', name], events.get(event)!, {
      match: (payload: Record<string, unknown>) =>
        payload[field] !== null && payload[field] !== undefined && String(payload[field]) === start.target,
      ...(timeout === undefined ? {} : { timeout }),
    });
  /* A step's own name: its position, and its place where several share it ("3.2"), so each is a step of its own. */
  const keyOf = (step: PlanStep): number | string => (step.member === undefined ? step.position : `${step.position}.${step.member}`);

  /* What a step does first: everything but its wait. Steps that share a position all begin before any is waited on. */
  const begin = async (step: PlanStep): Promise<unknown> => {
    const key = keyOf(step);
    switch (step.kind) {
      case 'until': {
        const { value } = await ask(['date', key], { op: 'date', field: step.field });
        return typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
      }
      case 'set':
        await ask(['set', key], { op: 'set', field: step.field, ...(step.value === null ? {} : { value: step.value }) });
        return undefined;
      case 'command':
        return w.run(['run', key], step.command, { target, input: step.input });
      case 'notify':
        // Told in the step's own transaction, so a replay finds its receipt and tells nobody twice.
        await ask(['tell', key], { op: 'tell', audience: step.audience, message: step.message });
        return undefined;
      default:
        return undefined;
    }
  };

  /* What a step then waits for. */
  const settle = async (step: PlanStep, begun: unknown): Promise<void> => {
    const key = keyOf(step);
    switch (step.kind) {
      case 'wait':
        await w.sleep(['wait', key], step.duration);
        return;
      case 'until': {
        const when = begun as number;
        // An empty date is not a time to wait for: the step passes.
        if (Number.isFinite(when)) await w.until(['until', key], when + (step.duration ? (parseDuration(step.duration) ?? 0) : 0));
        return;
      }
      case 'waitFor':
        await waitFor(key, step.event, step.field, step.duration);
        return;
      case 'command':
        if (step.waitFor) await decided(step, key, begun);
        return;
      default:
        return;
    }
  };

  /*
   * A command step's wait: for the first event about the record, or under
   * `all` for as many as its command asked, each event taken once. Its
   * `condition` ends it early once it holds; its `duration` ends it, and the
   * run goes on; every `remind` it waits, its kind's reminder runs. Each
   * round of waiting is a step of its own (`event[3]`, `event[3-1]`, …), and
   * the time left is read from the engine's clock as a step (`clock[3-1]`),
   * so the duration counts the time decisions took too and a replay asks
   * the same thing.
   */
  const decided = async (step: Extract<PlanStep, { kind: 'command' }>, key: number | string, answer: unknown): Promise<void> => {
    let asked = 1;
    if (step.mode === 'all') {
      const said = answer && typeof answer === 'object' ? (answer as { asked?: unknown }).asked : undefined;
      if (typeof said !== 'number' || !Number.isSafeInteger(said) || said < 0 || said > ASKED_MOST)
        throw new FlowStopped(
          `run[${key}]`,
          `Step ${step.position}: its command "${step.command}" must answer how many it asked (asked: a whole number) for the step to wait for all of them.`,
        );
      asked = said;
    }
    const capMs = step.duration === undefined ? undefined : parseDuration(step.duration);
    const everyMs = step.remind === undefined ? undefined : parseDuration(step.remind.every);
    const began = capMs === undefined ? 0 : (await w.now(['clock', key])).getTime();
    let got = 0,
      round = 0,
      reminded = 0;
    while (got < asked) {
      const name = round === 0 ? key : `${key}-${round}`;
      const left = capMs === undefined ? undefined : round === 0 ? capMs : began + capMs - (await w.now(['clock', name])).getTime();
      round++;
      if (left !== undefined && left <= 0) return;
      const reminding = everyMs !== undefined && reminded < REMINDERS_MOST;
      const timeoutMs = reminding ? (left === undefined ? everyMs : Math.min(everyMs, left)) : left;
      const event = await waitFor(name, step.waitFor!.event, step.waitFor!.field, timeoutMs === undefined ? undefined : seconds(timeoutMs));
      if (event) {
        got++;
        if (got < asked && step.condition !== undefined) {
          const { holds } = await ask(['check', name], { op: 'check', condition: step.condition });
          if (holds === true) return;
        }
        continue;
      }
      // The duration is up: the run goes on, undecided.
      if (left !== undefined && timeoutMs! >= left) return;
      reminded++;
      await w.run(['remind', `${key}-${reminded}`], step.remind!.command, { target, input: step.input });
    }
  };

  let at = 0;
  while (at < plan.steps.length) {
    const step: PlanStep = plan.steps[at];
    if (step.kind === 'branch') {
      const { holds } = await ask(['check', step.position], { op: 'check', condition: step.condition });
      // Not holding, it goes on at `goto` (the first step from that position), or ends the run.
      const to =
        holds === true ? at + 1 : step.goto === undefined ? -1 : plan.steps.findIndex((candidate) => candidate.position >= step.goto!);
      at = to < 0 ? plan.steps.length : to;
      continue;
    }
    // The steps that share its position start together, and the run goes on once each is done.
    let end = at + 1;
    while (end < plan.steps.length && plan.steps[end].position === step.position) end++;
    const group = plan.steps.slice(at, end);
    const begun: unknown[] = [];
    for (const member of group) begun.push(await begin(member));
    for (const [index, member] of group.entries()) await settle(member, begun[index]);
    at = end;
  }
  return { flow: plan.flow };
}
