/**
 * A row-driven flow's own command: what its runner reads of the
 * flow's rows and the record, and the `set` steps it writes, as one command
 * the platform defines per resource with flows — `flows-<resource>` — never
 * the App's commands module.
 *
 * Why a command, when the runner is trusted server code: so that everything
 * a flow does to data crosses the same door every other write does. The
 * record is read in the command's own transaction under the runner's
 * principal, whose roles must read the record and both tables of rows; a
 * `set` is written under the App's validation and recorded in the record's
 * history and the receipts' journal; and each read the run depends on is a
 * step whose answer is kept (flowRunner.ts), so a restart replays it rather
 * than reading again. Its grant is the runner's alone (flowCommandBrand.ts).
 *
 * One input, `op`, says which of six things it is:
 *   load   — the flow's rows as its plan (appFlows.ts `flowPlan`), once per run;
 *   check  — whether a condition holds of the record now;
 *   date   — a date column's value, for an `until` step;
 *   set    — write one of the `flows.set` columns;
 *   tell   — a `notify` step: the record's `notify` rules `on: { flow }` tell
 *            their people, in this transaction (WriteTransaction.tell);
 *   match  — which flows start on this change of the record.
 */
import { flowKindCommands, flowPlan, flowTriggered, FLOW_STEPS_MOST, type FlowTrigger } from '../../shared/appFlows.js';
import { homeSourceOf, logicalResource, type AppDef } from '../../shared/app.js';
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import { columnKind, isFlagColumn, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { servedFlows, type ServedFlows } from '../app/flowRecord.js';
import { defineCommand, defineCommands, type AnyBusinessCommand, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { defineSource } from '../commands/commandDb.js';
import { refuse } from '../commands/commandErrors.js';
import { field } from '../commands/commandFields.js';
import { shape, text } from '../commands/commandShapes.js';
import { FLOW_TELL, markFlowCommand } from '../commands/flowCommandBrand.js';

/** The command a resource's flows run as. A resource's name may start with an underscore; a command's may not. */
export const flowCommandId = (resource: string): string => `flows-${resource}`;
const RESOURCE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The most flows one resource keeps: each change reads them all. */
const FLOWS_MOST = 200;

export interface FlowRunnerRef {
  readonly workflow: string;
  readonly resource: string;
  readonly runAs: string;
}

/** Why these runners cannot run on this App and catalog, one sentence each. */
export function flowCommandProblems(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  runners: readonly FlowRunnerRef[],
): string[] {
  const problems: string[] = [];
  const served = new Map(servedFlows(app, schema).map((entry) => [entry.resource, entry]));
  const home = homeSourceOf(app);
  const seen = new Set<string>();
  for (const runner of runners) {
    const at = `workflow "${runner.workflow}"`;
    if (seen.has(runner.resource))
      problems.push(`${at}: another runner already runs the flows of "${runner.resource}"; a resource has one.`);
    seen.add(runner.resource);
    if (!app.resources?.[runner.resource]?.flows) {
      problems.push(`${at} runs the flows of "${runner.resource}", which declares none: give resources.${runner.resource} a flows block.`);
      continue;
    }
    const entry = served.get(runner.resource);
    if (!entry) {
      problems.push(`${at}: the flows of "${runner.resource}" cannot run on this catalog (\`check\` says why).`);
      continue;
    }
    if (
      !RESOURCE.test(runner.resource) ||
      !home ||
      [entry.resource, entry.binding.from, entry.binding.steps].some((name) => logicalResource(app, home, name) !== name)
    )
      problems.push(
        `${at}: the flows of "${runner.resource}" and their rows must be resources of the App's own source, named as identifiers.`,
      );
    if (Object.hasOwn(registry, flowCommandId(runner.resource)))
      problems.push(
        `${at}: the commands module registers "${flowCommandId(runner.resource)}", the name the flows' own command runs as. Rename the command.`,
      );
    for (const { kind, command } of flowKindCommands(entry.binding))
      if (!Object.hasOwn(registry, command))
        problems.push(`${at}: step kind "${kind}" runs command "${command}", which the commands module does not register.`);
  }
  return problems;
}

/** A `set` step's text as the column's value: a number, a yes or no, or text; empty is null. */
function columnValue(served: ServedFlows, column: string, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined || value === '') return null;
  const meta = served.table.columns.find((candidate) => candidate.name === column)!;
  const said = String(value).trim();
  if (isFlagColumn(meta)) {
    const yes = ['true', '1', 'yes'].includes(said.toLowerCase()),
      no = ['false', '0', 'no'].includes(said.toLowerCase());
    if (!yes && !no) refuse('invalid_input', 'value');
    return columnKind(meta.type) === 'boolean' ? yes : yes ? 1 : 0;
  }
  if (columnKind(meta.type) === 'number') {
    const n = Number(said);
    return Number.isFinite(n) && said !== '' ? n : refuse('invalid_input', 'value');
  }
  return String(value);
}

type Row = Readonly<Record<string, string | number | boolean | null>>;
interface FlowTable {
  find(where: string): Promise<Row | undefined>;
  where(where?: string): { limit(count: number): PromiseLike<Row[]> };
  count(where?: string): Promise<number>;
  update(row: Row, changes: Readonly<Record<string, string | number | boolean | null>>): Promise<Row>;
}

function synthesize(served: ServedFlows, runner: FlowRunnerRef, source: string): AnyBusinessCommand {
  const { binding, record } = served;
  const target = served.resource;
  const key = served.table.columns.find((column) => column.primaryKey)!.name;
  const command = defineCommand({
    source: defineSource(source),
    target,
    read: [binding.from, binding.steps],
    input: {
      op: field.choice(['load', 'check', 'date', 'set', 'tell', 'match']),
      flow: field.text({ optional: true, max: 128 }),
      condition: field.textarea({ optional: true, max: 1000 }),
      field: field.text({ optional: true, max: 128 }),
      value: field.textarea({ optional: true, max: 10000 }),
      trigger: field.choice(['created', 'updated', 'manual'], { optional: true }),
      changed: field.textarea({ optional: true, max: 16384 }),
      audience: field.text({ optional: true, max: 40 }),
      message: field.textarea({ optional: true, max: 500 }),
    },
    output: shape({ json: text({ max: 60000 }) }),
    async handle(ctx, input) {
      const db = ctx.db as unknown as Readonly<Record<string, FlowTable>>;
      const row = ctx.record as Row;
      const self = `${key} = ${quoteValue(row[key])}`;
      const holds = async (condition: string) => record.condition(condition) && (await db[target].count(andQuery(self, condition))) > 0;
      const reply = (value: unknown) => ({ json: JSON.stringify(value) });
      switch (input.op) {
        case 'load': {
          const flow = input.flow === undefined ? undefined : await db[binding.from].find(`id = ${quoteValue(input.flow)}`);
          if (!flow)
            return reply({ flow: input.flow ?? '', name: '', steps: [], problem: { position: null, reason: 'The flow was deleted.' } });
          const steps = await db[binding.steps].where(`flow_id = ${quoteValue(flow.id)}`).limit(FLOW_STEPS_MOST + 1);
          return reply(flowPlan(flow, steps, binding, record));
        }
        case 'check':
          if (input.condition === undefined) return refuse('invalid_input', 'condition');
          return reply({ holds: await holds(input.condition) });
        case 'date':
          if (input.field === undefined || !record.dates.has(input.field)) return refuse('invalid_input', 'field');
          return reply({ value: row[input.field] ?? null });
        case 'set': {
          if (input.field === undefined || !(binding.set ?? []).includes(input.field)) return refuse('invalid_input', 'field');
          await db[target].update(row, { [input.field]: columnValue(served, input.field, input.value) });
          return reply({});
        }
        case 'tell': {
          if (input.audience === undefined || !record.audiences?.has(input.audience)) return refuse('invalid_input', 'audience');
          if (input.message === undefined || !input.message.trim()) return refuse('invalid_input', 'message');
          const tell = (ctx as unknown as { [FLOW_TELL]?: (audience: string, message: string) => Promise<void> })[FLOW_TELL];
          if (!tell) return refuse('invalid_input', 'audience');
          await tell(input.audience, input.message.trim());
          return reply({});
        }
        default: {
          let changed: unknown;
          try {
            changed = JSON.parse(input.changed ?? '[]');
          } catch {
            return refuse('invalid_input', 'changed');
          }
          if (!Array.isArray(changed) || changed.some((column) => typeof column !== 'string') || input.trigger === undefined)
            return refuse('invalid_input', 'changed');
          const flows = await db[binding.from].where().limit(FLOWS_MOST);
          const started: string[] = [];
          for (const flow of flows) {
            if (
              !flowTriggered(flow, {
                trigger: input.trigger as FlowTrigger,
                changed: changed as string[],
                ...(input.flow ? { flow: input.flow } : {}),
              })
            )
              continue;
            const condition = typeof flow.condition === 'string' ? flow.condition.trim() : '';
            if (!condition || (await holds(condition))) started.push(String(flow.id));
          }
          return reply({ flows: started });
        }
      }
    },
  });
  markFlowCommand(command, { resource: target, runAs: runner.runAs });
  return command as AnyBusinessCommand;
}

const synthesized = new WeakMap<object, Map<string, AnyBusinessCommand>>();

/** The registry a jobs host runs these runners against: the App's own, plus each resource's flow command. Refuses, with the check's words, where a runner cannot run. */
export function withFlowCommands(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  runners: readonly FlowRunnerRef[],
): BusinessCommandRegistry {
  if (!runners.length) return registry;
  const problems = flowCommandProblems(app, schema, registry, runners);
  if (problems.length) throw new Error(problems.join(' '));
  const served = new Map(servedFlows(app, schema).map((entry) => [entry.resource, entry]));
  const cache = synthesized.get(schema) ?? new Map<string, AnyBusinessCommand>();
  synthesized.set(schema, cache);
  const added: Record<string, AnyBusinessCommand> = {};
  for (const runner of runners) {
    const cacheKey = `${app.id}\0${runner.resource}\0${runner.runAs}`;
    const command = cache.get(cacheKey) ?? synthesize(served.get(runner.resource)!, runner, homeSourceOf(app)!);
    cache.set(cacheKey, command);
    added[flowCommandId(runner.resource)] = command;
  }
  return defineCommands({ ...registry, ...added });
}
