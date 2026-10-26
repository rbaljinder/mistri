/**
 * What `check` and startup say of a module's decisions, and what each one
 * reads.
 *
 * Against the commands: the answer command is registered, not public, and
 * names one record of the decision's `target`; the answer field is one of its
 * inputs, of a type a decision can answer (a choice, a number, a yes or no, a
 * reference, or a list of references); every other input of it is optional,
 * since the decision runs it with the answer alone.
 *
 * Against the App and its catalog: the answer field is a column of the
 * target; each input is a column, a rollup or computed column of it, or a
 * label path through its references; none is `hidden` or named by
 * `audit.redact` — a redacted value is not kept even in an audit, so it is
 * not sent to a provider either. Each input is read through the answer
 * command as `runAs` (decideReads.ts), so the tables a label path or a rollup
 * reaches must be in that command's `read`: a decision never reads what its
 * command could not.
 */
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppCommandField } from '../../shared/command.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import type { AnyBusinessCommand, BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { CapturedDecision } from './decisionModule.js';

/** A decision's answer type, before a reference's choices are read: what the lock records and the provider is told. */
export type DecisionAnswerSpec =
  | Readonly<{ kind: 'choice'; options: readonly Readonly<{ value: string | number; label: string }>[] }>
  | Readonly<{ kind: 'number'; min?: number; max?: number; integer?: boolean; step?: number }>
  | Readonly<{ kind: 'bool' }>
  | Readonly<{ kind: 'reference'; from: string; by: string; labelColumn: string; query?: string }>
  /** A group of one reference repeated: the command's input is `[{ [inner]: key }, …]`. */
  | Readonly<{ kind: 'references'; inner: string; from: string; by: string; labelColumn: string; query?: string; max: number }>;

/** The answer field's type as a decision answers it, or why it cannot. */
export function answerSpec(command: AnyBusinessCommand, field: string): DecisionAnswerSpec | string {
  const found = command.fields.find((each) => each.name === field);
  if (!found) return `has no input "${field}"`;
  const scalar = (each: AppCommandField): DecisionAnswerSpec | undefined => {
    switch (each.type) {
      case 'choice':
        return { kind: 'choice', options: each.options.map(({ value, label }) => ({ value, label })) };
      case 'number':
        return {
          kind: 'number',
          ...(each.min === undefined ? {} : { min: each.min }),
          ...(each.max === undefined ? {} : { max: each.max }),
          ...(each.integer ? { integer: true } : {}),
          ...(each.step === undefined ? {} : { step: each.step }),
        };
      case 'boolean':
        return { kind: 'bool' };
      case 'reference':
        return {
          kind: 'reference',
          from: each.from,
          by: each.by,
          labelColumn: each.labelColumn,
          ...(each.query === undefined ? {} : { query: each.query }),
        };
      default:
        return undefined;
    }
  };
  if (found.type === 'group') {
    const [inner, ...more] = found.fields;
    const one = inner && !more.length ? scalar(inner) : undefined;
    if (!found.repeat || !one || one.kind !== 'reference')
      return `input "${field}" is a group; a decision answers a group of one reference repeated, field.group({ id: field.reference(...) }, { repeat: { max } })`;
    return { ...one, kind: 'references', inner: inner.name, max: found.repeat.max };
  }
  return (
    scalar(found) ??
    `input "${field}" is a ${found.type} field; a decision answers a choice, a number, a yes or no, a reference or a list of references`
  );
}

/** Why the module's decisions cannot run against these commands; empty when they can. */
export function decisionCommandProblems(
  decisions: Iterable<CapturedDecision>,
  app: Pick<AppDef, 'sources'>,
  commands: BusinessCommandRegistry,
): string[] {
  const problems: string[] = [];
  for (const decision of decisions) {
    const id = decision.answer.command.id;
    const say = (problem: string) => problems.push(`decision "${decision.name}" lands through command "${id}", which ${problem}.`);
    const command = Object.hasOwn(commands, id) ? commands[id] : undefined;
    if (!command) {
      say('the commands module does not register');
      continue;
    }
    if (command.public) say('is public: only its public form runs it');
    if (command.targets !== undefined && command.targets !== 'one')
      say(`says targets: '${command.targets}'; a decision's command names the one record it is about`);
    const resource = logicalResource(app, command.source, command.target);
    if (resource !== decision.target) say(`targets "${resource}", not the decision's target "${decision.target}"`);
    const spec = answerSpec(command, decision.answer.field);
    if (typeof spec === 'string') say(spec);
    const required = command.fields.filter((field) => field.name !== decision.answer.field && 'required' in field && field.required);
    if (required.length)
      say(
        `requires ${required.map((field) => `"${field.name}"`).join(', ')}; a decision runs it with its answer alone, so every other input is optional`,
      );
  }
  return problems;
}

/** One input as it is read: a stored column of the target, a derived name of it, or a label path's hops. */
type DecisionInputRead =
  | Readonly<{ input: string; kind: 'column' }>
  | Readonly<{ input: string; kind: 'derived' }>
  | Readonly<{
      input: string;
      kind: 'path';
      /** Each hop: from a column of the table before to the logical table it names, by its column there. */
      hops: readonly Readonly<{ column: string; table: string; by: string }>[];
      column: string;
    }>;

/** What a decision reads of its target, in the logical catalog: its inputs and the column it answers. */
export interface DecisionReads {
  readonly table: string;
  readonly key: readonly string[];
  readonly inputs: readonly DecisionInputRead[];
  /** Every logical table an input reaches beyond the target: the answer command must read each. */
  readonly reaches: readonly string[];
}

/** Columns of a resource no provider is sent: `hidden`, and what `audit.redact` names (`'values'`: all of them). */
function unsent(app: AppDef, resource: string): (column: string) => boolean {
  const def = app.resources?.[resource];
  const hidden = new Set(def?.hidden ?? []);
  const redact = def?.audit?.redact;
  return (column) => hidden.has(column) || redact === 'values' || (Array.isArray(redact) && redact.includes(column));
}

/** What a decision reads of the App's catalog, or the problems that keep it from reading it. */
export function decisionReads(
  decision: CapturedDecision,
  app: AppDef,
  schema: DatabaseSchema,
): { reads?: DecisionReads; problems: string[] } {
  const problems: string[] = [];
  const say = (problem: string) => problems.push(`decision "${decision.name}": ${problem}.`);
  const tableOf = (id: string): TableMeta | undefined => schema.tables.find((table) => table.id === id);
  const target = tableOf(decision.target);
  if (!target) {
    say(`its target "${decision.target}" is not a resource of App "${app.id}" this server can read`);
    return { problems };
  }
  const has = (table: TableMeta, column: string) => table.columns.some((each) => each.name === column);
  if (!has(target, decision.answer.field))
    say(
      `it answers "${decision.answer.field}", which is not a column of "${decision.target}": the answer field's name is the column it fills`,
    );
  if (unsent(app, decision.target)(decision.answer.field))
    say(`it answers "${decision.answer.field}", which "${decision.target}" hides or redacts`);
  const inputs: DecisionInputRead[] = [];
  const reaches = new Set<string>();
  for (const input of decision.inputs) {
    const [first, ...rest] = input.split('.');
    if (!rest.length) {
      if (has(target, input)) inputs.push({ input, kind: 'column' });
      else if (Object.hasOwn(target.rollups ?? {}, input) || Object.hasOwn(target.computed ?? {}, input)) {
        inputs.push({ input, kind: 'derived' });
        const via = target.rollups?.[input]?.via;
        if (via) reaches.add(via.slice(0, via.lastIndexOf('.')));
      } else say(`input "${input}" is not a column, rollup or computed column of "${decision.target}"`);
      if (unsent(app, decision.target)(input)) say(`input "${input}" is hidden or redacted on "${decision.target}", and is never sent`);
      continue;
    }
    /* A label path: each step a reference to the next table, the last a column of it. */
    const hops: Array<{ column: string; table: string; by: string }> = [];
    let at: TableMeta | undefined = target;
    let failed = false;
    for (const column of [first, ...rest.slice(0, -1)]) {
      const fk = schema.foreignKeys.find(
        (key) => key.from.table === at!.id && key.from.columns.length === 1 && key.from.columns[0] === column,
      );
      if (!fk) {
        say(`input "${input}": "${column}" is not a reference of "${at!.id}"`);
        failed = true;
        break;
      }
      if (unsent(app, at!.id)(column)) say(`input "${input}" passes through "${column}", which "${at!.id}" hides or redacts`);
      hops.push({ column, table: fk.to.table, by: fk.to.columns[0] });
      reaches.add(fk.to.table);
      at = tableOf(fk.to.table);
      if (!at) {
        say(`input "${input}" reaches "${fk.to.table}", which App "${app.id}" does not serve`);
        failed = true;
        break;
      }
    }
    if (failed) continue;
    const last = rest.at(-1)!;
    if (!has(at!, last)) say(`input "${input}": "${last}" is not a column of "${at!.id}"`);
    else if (unsent(app, at!.id)(last)) say(`input "${input}" is hidden or redacted on "${at!.id}", and is never sent`);
    inputs.push({ input, kind: 'path', hops, column: last });
  }
  const key = target.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (!key.length) say(`"${decision.target}" has no primary key, so a decision cannot name its record`);
  return problems.length ? { problems } : { reads: { table: decision.target, key, inputs, reaches: [...reaches] }, problems };
}

/** Each table an input reaches that the answer command does not read: the reads go through it. */
export function decisionFootprintProblems(
  decision: CapturedDecision,
  reads: DecisionReads,
  command: AnyBusinessCommand,
  app: Pick<AppDef, 'sources'>,
): string[] {
  const footprint = new Set(
    [...command.read, ...command.write, command.target].map((local) => logicalResource(app, command.source, local)),
  );
  return reads.reaches
    .filter((table) => !footprint.has(table))
    .map(
      (table) =>
        `decision "${decision.name}" reads "${table}" for its inputs, and command "${decision.answer.command.id}" does not: ` +
        `inputs are read through the answer command as "${decision.runAs}", so add "${table}" to its read.`,
    );
}

/** The effective decisions, one line each, as `check` prints them. */
export function describeDecisions(decisions: Iterable<CapturedDecision>): string[] {
  return [...decisions].map(
    (decision) =>
      `decisions: ${decision.name} ${decision.every ? `every "${decision.every.text}" (${decision.every.timezone})${decision.where ? ` where ${decision.where}` : ''}` : `on ${decision.on!.event.name}@${decision.on!.event.version} (${decision.on!.from.id})`}` +
      ` → ${decision.answer.command.id}.${decision.answer.field} as ${decision.runAs}, asking ${decision.providers.join(' then ')}` +
      `; suggest ≥ ${decision.suggest}${decision.apply === undefined ? ', never applies' : `, apply ≥ ${decision.apply} once pinned`}`,
  );
}
