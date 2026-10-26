/**
 * What a workflow's steps are, found without running anything real: the
 * function is run against a recording `w` whose steps answer at once with a
 * permissive value, so the commands, connections and events it names, and the
 * durations it writes, can be checked at `check` and at startup rather than
 * on the day an instance first reaches them.
 *
 * A function branches on what its steps return, so it is run again and again,
 * depth first: at every `waitFor` and `call` the answer is each of null (a
 * timeout), a permissive value with numbers high, and one with numbers zero,
 * so every combination of answers is taken once. The steps seen are the
 * union. This is a best effort that never runs a command or reaches a
 * connection: the exploration stops at MAX_RUNS runs (and says so, `capped`),
 * a branch beyond that is not seen, and code that throws on a permissive value
 * is simply not followed further. What it finds is checked; what it cannot
 * reach is not blamed.
 */
import { flowCommandId } from './flowCommand.js';
import { flowKindCommands } from '../../shared/appFlows.js';
import { appCommandGrants, type AppDef } from '../../shared/app.js';
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { serviceRoleRefusal } from '../commands/businessCommandAuthorization.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import type { CapturedJobModule } from '../jobs/jobModule.js';
import {
  commandReference,
  connectionReference,
  isStatic,
  parseDuration,
  stepName,
  WorkflowDeclarationError,
  type CapturedWorkflow,
  type StepOptions,
  type WorkflowApi,
} from './workflowModule.js';

export interface ProbedStep {
  /** A loop's step is `name[*]`: its key is only known when it runs. */
  readonly name: string;
  readonly kind: 'run' | 'call' | 'sleep' | 'until' | 'waitFor' | 'now';
  /** The command a `run` names, the connection a `call` names, or the `name@version` a `waitFor` waits for. */
  readonly target?: string;
  /**
   * `dynamic`: a `waitFor` whose timeout is computed from what the probe
   * cannot know (the start payload), so it is judged when an instance runs.
   * Not part of the lock's lines or digest: the timeout is not the step's identity.
   */
  readonly timeout?: 'dynamic';
}
export interface Probe {
  readonly steps: readonly ProbedStep[];
  readonly problems: readonly string[];
  /** The function ran far enough to name a step in at least one run. */
  readonly seen: boolean;
  /** The exploration stopped at MAX_RUNS with answers left to try: a branch beyond them is not in `steps`. */
  readonly capped: boolean;
}

/** A value that answers anything: a property, a call, iteration, a comparison. Never a promise, so awaiting it returns it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function permissive(number: number): any {
  const value = new Proxy(function () {}, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => number;
      if (property === Symbol.iterator)
        return function* () {
          /* nothing to iterate */
        };
      if (property === 'length') return 0;
      return permissive(number);
    },
    apply: () => permissive(number),
    construct: () => permissive(number),
    has: () => true,
  });
  made.add(value);
  return value;
}
const made = new WeakSet<object>();
/**
 * A timeout the probe cannot judge: the permissive value itself, or text built
 * from one, where every number the start payload gave reads as zero ('0 hours',
 * `${start.hours * 60}m`). A literal is still judged.
 */
const unseen = (value: unknown): boolean =>
  (typeof value === 'function' && made.has(value)) || (typeof value === 'string' && /^0+(?:\.0+)?\s*[a-z]+$/.test(value.trim()));

class ProbeLimit extends Error {}
const STEP_LIMIT = 400;
const PASS_MS = 1_500;
/** The most runs of one workflow's function: three answers at each wait or call grows as 3^n. */
const MAX_RUNS = 64;
/** What a `waitFor` or `call` answers, in the order the exploration tries them. */
const ANSWERS = [
  { none: true, number: 0 },
  { none: false, number: 1e9 },
  { none: false, number: 0 },
] as const;

/** Run the workflow's function against a recording `w` for every combination of answers (up to MAX_RUNS), and say what it names and what is wrong with it. */
export async function probeWorkflow(workflow: CapturedWorkflow): Promise<Probe> {
  const steps = new Map<string, ProbedStep>();
  const problems = new Set<string>();
  const where = `workflow "${workflow.name}"`;
  // The answers each run took, one per wait or call it reached; the next run keeps all but the last unexhausted one.
  let path: number[] = [],
    runs = 0,
    capped = false;
  for (;;) {
    if (runs === MAX_RUNS) {
      capped = true;
      break;
    }
    runs++;
    const prefix = path,
      taken: number[] = [];
    let live = true;
    const answer = (): unknown => {
      if (!live) return permissive(0);
      const index = taken.length < prefix.length ? prefix[taken.length] : 0;
      taken.push(index);
      return ANSWERS[index].none ? null : permissive(ANSWERS[index].number);
    };
    const used = new Set<string>();
    let count = 0,
      nows = 0;
    const note = (raw: unknown, kind: ProbedStep['kind'], target?: string): void => {
      if (++count > STEP_LIMIT) throw new ProbeLimit();
      let name: string;
      try {
        name = stepName(raw);
      } catch (error) {
        problems.add(`${where}: ${(error as Error).message}`);
        return;
      }
      const shown = isStatic(raw) ? name : `${(raw as readonly [string, unknown])[0]}[*]`;
      if (isStatic(raw)) {
        if (used.has(name))
          problems.add(
            `${where}: step "${name}" is used twice in one run. Give each step its own name, or [name, key] for one made in a loop.`,
          );
        used.add(name);
      }
      const before = steps.get(shown);
      if (!before) steps.set(shown, Object.freeze({ name: shown, kind, ...(target === undefined ? {} : { target }) }));
      else if (before.kind !== kind || before.target !== target) {
        problems.add(
          `${where}: step "${shown}" is a ${before.kind}${before.target ? ` of ${before.target}` : ''} on one path and a ${kind}${target ? ` of ${target}` : ''} on another; a step's name is its identity.`,
        );
      }
    };
    const options = (value: StepOptions | undefined, step: string): void => {
      for (const [field, text] of [
        ['timeout', value?.timeout],
        ['retry.backoff', value?.retry?.backoff],
        ['retry.max', value?.retry?.max],
      ] as const) {
        if (text === undefined) continue;
        try {
          parseDuration(text, `${field} of step "${step}"`);
        } catch (error) {
          problems.add(`${where}: ${(error as Error).message}`);
        }
      }
      const attempts = value?.retry?.attempts;
      if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1 || attempts > 32))
        problems.add(`${where}: retry.attempts of step "${step}" is a whole number from 1 to 32.`);
    };
    const guard = <T>(work: () => T): Promise<T> => {
      try {
        return Promise.resolve(work());
      } catch (error) {
        return error instanceof ProbeLimit ? Promise.reject(error) : Promise.resolve(permissive(0));
      }
    };
    const w = {
      version: 1,
      run: (raw: unknown, command: unknown, args?: StepOptions) =>
        guard(() => {
          let ref = '';
          try {
            ref = commandReference(command, `${where}: w.run command`);
          } catch (error) {
            problems.add((error as Error).message);
          }
          note(raw, 'run', ref);
          options(args, String(raw));
          return permissive(0);
        }),
      call: (raw: unknown, connection: unknown, _request: unknown, opts?: StepOptions) =>
        guard(() => {
          let ref = '';
          try {
            ref = connectionReference(connection, `${where}: w.call connection`);
          } catch (error) {
            problems.add((error as Error).message);
          }
          note(raw, 'call', ref);
          options(opts, String(raw));
          return answer();
        }),
      sleep: (raw: unknown, duration: unknown) =>
        guard(() => {
          note(raw, 'sleep');
          try {
            parseDuration(duration, `${where}: sleep "${String(raw)}"`);
          } catch (error) {
            problems.add((error as Error).message);
          }
          return undefined;
        }),
      until: (raw: unknown, when: unknown) =>
        guard(() => {
          note(raw, 'until');
          if (
            !Number.isFinite(new Date(when as never).getTime()) &&
            when !== undefined &&
            typeof when !== 'object' &&
            typeof when !== 'function'
          )
            problems.add(`${where}: until "${String(raw)}" needs a time.`);
          return undefined;
        }),
      now: (raw?: unknown) =>
        guard(() => {
          note(raw ?? `now#${++nows}`, 'now');
          return new Date(0);
        }),
      waitFor: (raw: unknown, event: { name?: string; version?: number } | undefined, opts?: { timeout?: unknown }) =>
        guard(() => {
          const identity = `${event?.name}@${event?.version}`;
          note(raw, 'waitFor', identity);
          if (!workflow.events.has(identity))
            problems.add(
              `${where}: step "${String(raw)}" waits for "${identity}", which the workflow does not list in listens. The host delivers only the events a workflow names.`,
            );
          if (opts?.timeout !== undefined) {
            try {
              parseDuration(opts.timeout, `${where}: waitFor "${String(raw)}" timeout`);
            } catch (error) {
              if (!unseen(opts.timeout)) problems.add((error as Error).message);
              else {
                const shown = isStatic(raw) ? String(raw) : `${(raw as readonly [string, unknown])[0]}[*]`;
                const step = steps.get(shown);
                if (step?.kind === 'waitFor') steps.set(shown, Object.freeze({ ...step, timeout: 'dynamic' as const }));
              }
            }
          }
          return answer();
        }),
    } as unknown as WorkflowApi;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => workflow.run(w, permissive(0)))
          .catch((error) => {
            if (error instanceof WorkflowDeclarationError) problems.add(`${where}: ${error.message}`);
          }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PASS_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (!(error instanceof ProbeLimit)) throw error;
    } finally {
      clearTimeout(timer);
      live = false;
    }
    while (taken.length && taken[taken.length - 1] === ANSWERS.length - 1) taken.pop();
    if (!taken.length) break;
    taken[taken.length - 1]++;
    path = taken;
  }
  return Object.freeze({ steps: Object.freeze([...steps.values()]), problems: Object.freeze([...problems]), seen: steps.size > 0, capped });
}

export interface WorkflowChecks {
  readonly app: AppDef;
  readonly commands: BusinessCommandRegistry;
  /** Whether the config file names a webhook connection of this name. */
  readonly hasConnection: (name: string) => boolean;
  /** The binding the jobs' commands are authorized through: a step's command is authorized as the principal, once, here. */
  readonly binding?: BusinessCommandBinding;
}
export interface WorkflowShape {
  readonly workflow: CapturedWorkflow;
  readonly steps: readonly ProbedStep[];
  readonly problems: readonly string[];
  /** The probe stopped at MAX_RUNS: a branch beyond it is not in `steps`. */
  readonly capped: boolean;
}

/**
 * Every workflow of the module, probed and judged: the commands and
 * connections its steps name exist, its principal is granted each command,
 * no step's command records the very fact that starts it, and its names and
 * durations read. The shapes are the lock's (workflowContracts.ts).
 */
export async function checkWorkflows(module: CapturedJobModule, checks: WorkflowChecks): Promise<WorkflowShape[]> {
  const shapes: WorkflowShape[] = [];
  for (const workflow of module.workflows.values()) {
    // A flows runner's steps are rows, not code: there is nothing to probe, and what its rows may run is judged below.
    const probe = workflow.flows ? { steps: [] as ProbedStep[], problems: [] as string[], capped: false } : await probeWorkflow(workflow);
    const problems = [...probe.problems];
    const where = `workflow "${workflow.name}"`;
    const roles = module.principals.get(workflow.runAs)!;
    const granted = appCommandGrants(checks.app, roles);
    const refusal = serviceRoleRefusal(checks.app, roles);
    if (workflow.flows) problems.push(...flowRunnerProblems(workflow, where, roles, checks));
    for (const step of probe.steps) {
      if (step.kind === 'run' && step.target) {
        const command = Object.hasOwn(checks.commands, step.target) ? checks.commands[step.target] : undefined;
        if (!command) {
          problems.push(`${where}: step "${step.name}" runs command "${step.target}", which the commands module does not register.`);
          continue;
        }
        if (command.public)
          problems.push(`${where}: step "${step.name}" runs command "${step.target}", which is public: only its public form runs it.`);
        if (!refusal && !granted.has(step.target))
          problems.push(
            `${where}: principal "${workflow.runAs}" (roles ${roles.join(', ')}) is not granted command "${step.target}", which step "${step.name}" runs.`,
          );
        else if (!refusal && checks.binding) {
          try {
            checks.binding.authorize(step.target, serviceActor(checks.app.id, workflow.runAs, roles));
          } catch {
            problems.push(
              `${where}: principal "${workflow.runAs}" cannot run command "${step.target}" for step "${step.name}": its roles must read the command's whole footprint.`,
            );
          }
        }
        // A step whose command records the fact that starts the workflow could start it again.
        if (
          (getCommandEvents(command)?.expectation ?? []).some(
            (event) => event.name === workflow.start.name && event.version === workflow.start.version,
          )
        ) {
          problems.push(
            `${where}: step "${step.name}" runs command "${step.target}", which records "${workflow.start.name}", the event that starts this workflow: it could start itself again.`,
          );
        }
      }
      if (step.kind === 'call' && step.target && !checks.hasConnection(step.target)) {
        problems.push(
          `${where}: step "${step.name}" calls connection "${step.target}", which the config file does not name. Add a "kind": "webhook" connection called "${step.target}".`,
        );
      }
    }
    shapes.push(Object.freeze({ workflow, steps: probe.steps, problems: Object.freeze(problems), capped: probe.capped }));
  }
  return shapes;
}

/* What a flows runner's rows may run (appFlows.ts): each step kind's command
   granted to its principal, and every event the App's flows wait for one it
   listens for, so a step a row names is never one the host cannot take. */
function flowRunnerProblems(workflow: CapturedWorkflow, where: string, roles: readonly string[], checks: WorkflowChecks): string[] {
  const problems: string[] = [];
  const binding = checks.app.resources?.[workflow.flows!.resource]?.flows;
  if (!binding)
    return [
      `${where} runs the flows of "${workflow.flows!.resource}", which declares none: give resources.${workflow.flows!.resource} a flows block.`,
    ];
  const own = flowCommandId(workflow.flows!.resource);
  if (checks.binding && Object.hasOwn(checks.commands, own)) {
    try {
      checks.binding.authorize(own, serviceActor(checks.app.id, workflow.runAs, roles));
    } catch {
      problems.push(
        `${where}: principal "${workflow.runAs}" (roles ${roles.join(', ')}) must read "${workflow.flows!.resource}", "${binding.from}" and "${binding.steps}" to run their flows.`,
      );
    }
  }
  const granted = appCommandGrants(checks.app, roles);
  for (const { kind: name, command } of flowKindCommands(binding)) {
    if (!Object.hasOwn(checks.commands, command)) continue;
    if (!granted.has(command)) {
      problems.push(
        `${where}: principal "${workflow.runAs}" (roles ${roles.join(', ')}) is not granted command "${command}", which step kind "${name}" runs.`,
      );
      continue;
    }
    if (checks.binding) {
      try {
        checks.binding.authorize(command, serviceActor(checks.app.id, workflow.runAs, roles));
      } catch {
        problems.push(
          `${where}: principal "${workflow.runAs}" cannot run command "${command}" for step kind "${name}": its roles must read the command's whole footprint.`,
        );
      }
    }
  }
  const heard = new Set(workflow.listens.map((event) => event.name));
  for (const event of Object.keys(binding.events ?? {}))
    if (!heard.has(event))
      problems.push(
        `${where}: the flows of "${workflow.flows!.resource}" wait for "${event}", which the runner does not listen for; add it to flowRunner's listens.`,
      );
  return problems;
}
