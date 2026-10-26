/**
 * What `mistri check` says of an App's machines (appMachine.ts), beside
 * the graph's own shape: its column and `since` are the table's, and every
 * verb can run through a role or a public form — a command granted to a role
 * or named by a public form, a fixed verb on a table a role writes or runs by
 * name. Otherwise the record cannot leave that state by that verb.
 *
 * `machineCommandWarnings` reads the commands module beside the App: a
 * command that judges a machine's column in its `when`, writes that column in
 * its handler and is not one of its verbs or timers moves the record outside
 * the graph as far as the App says; the server refuses such a write at run
 * time unless it follows an edge. What a handler writes is read off its
 * source (`status:` in an object it passes), so the check can miss a column
 * written through a computed key; the run-time refusal cannot.
 */
import { appCommandGrants, grantsByRole, isPublicForm, logicalResource, resolveAppAccess, type AppDef } from '../../shared/app.js';
import { machineProblems, machineVerbs } from '../../shared/appMachine.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appConsumesRules } from '../../shared/appConsumes.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';

export function machineChecks(app: AppDef, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.machine) continue;
    problems.push(...machineProblems(resource.machine, `resources "${name}", machine`));
  }
  if (!grantsByRole(app)) return problems;
  /* Who can run a verb is judged on the whole catalog, at startup and by `check`. A reader's own catalog (the App's
     payload, built per principal) leaves out the tables their role cannot read, and every role's grants resolve
     against all the App's resources: there they would refuse, so a role that cannot read a table with a fixed verb
     was answered 500. */
  if (Object.keys(app.resources ?? {}).some((name) => !schema.tables.some((table) => table.id === name))) return problems;
  const roles = Object.keys(app.auth?.roles ?? {});
  const publicCommands = new Set(
    Object.values(app.views)
      .filter(isPublicForm)
      .flatMap((form) => [form.command.id, ...(form.steps ?? []).flatMap((step) => (step.command ? [step.command.id] : []))]),
  );
  /* Each role's command grants and access, read once for every verb: both
     re-read the App's whole policy, and a large App's machines have many
     verbs. */
  const commandsOf = new Map<string, ReadonlySet<string>>();
  const writableOf = new Map<string, ReadonlySet<string>>();
  const commands = (role: string) => commandsOf.get(role) ?? commandsOf.set(role, appCommandGrants(app, [role])).get(role)!;
  const writable = (role: string) =>
    writableOf.get(role) ?? writableOf.set(role, resolveAppAccess(app, schema, [role]).writable).get(role)!;
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.machine) continue;
    for (const verb of machineVerbs(resource.machine)) {
      const runs =
        (verb.command !== undefined && publicCommands.has(verb.command)) ||
        roles.some((role) =>
          verb.command
            ? commands(role).has(verb.command)
            : writable(role).has(name) || (app.auth?.roles?.[role]?.actions?.[name] ?? []).includes(verb.verb),
        );
      if (!runs) {
        problems.push(
          `resources "${name}", machine: the verb "${verb.verb}" from ${verb.froms.map((from) => `"${from}"`).join(', ')} is one no role may run ` +
            `[machine-verb-unrunnable]: ${verb.command ? `grant the command to a role (roles.<role>.commands: ['${verb.command}'])` : `let a role write "${name}", or run it by name (roles.<role>.actions: { ${name}: ['${verb.verb}'] })`}.`,
        );
      }
    }
  }
  return problems;
}

/** Commands that judge a machine's column and are neither its verbs, its timers nor a service's own moves. */
export function machineCommandWarnings(app: AppDef, commands: BusinessCommandRegistry | undefined): string[] {
  if (!commands) return [];
  const warnings: string[] = [];
  for (const [id, command] of Object.entries(commands)) {
    const target = logicalResource(app, command.source, command.target);
    const machine = app.resources?.[target]?.machine;
    if (!machine || command.when === undefined) continue;
    const judged =
      typeof command.when === 'string'
        ? new RegExp(`(^|[^\\w.])${machine.column}([^\\w]|$)`).test(command.when)
        : Object.hasOwn(command.when, machine.column);
    const inGraph =
      machine.edges.some((edge) => edge.command === id) ||
      machine.states.some((state) => (state.after ?? []).some((timer) => timer.command === id)) ||
      /* A service's own move (`by`) is no verb: its command is the one a role it names is granted. */
      machine.states.some((state) => state.by?.some((move) => appCommandGrants(app, [move.role]).has(id)));
    const writes = new RegExp(`(^|[^\\w.])['"]?${machine.column}['"]?\\s*:`).test(writtenTo(app, target, String(command.handle)));
    if (judged && writes && !inGraph) {
      warnings.push(
        `command "${id}" judges "${machine.column}" of "${target}" and is not a verb of its machine [machine-command-outside]: ` +
          `name it in the states it runs from (on: { ${id}: '<next>' }), which then decides where it runs; a write of "${machine.column}" off the graph is refused.`,
      );
    }
  }
  return warnings;
}

/* What a table's handle says it reads and writes; the rest of a call is the table's own. */
const TABLE_CALL = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|find|where|count|insert|insertFile|update|remove)\s*\(/g;
const READS = new Set(['get', 'find', 'where', 'count']);

/**
 * A handler's source with what it says to another of the App's tables, and
 * what it reads of its own, cut out: `db.payment.update(row, { status: 'paid' })`
 * in a command over an order writes the payment's status, not the order's, and
 * `db.order.find({ status: 'open' })` reads one. A write through anything else
 * (an alias, a helper, an object built first) still reads as the target's.
 */
function writtenTo(app: AppDef, target: string, source: string): string {
  const namesOf = (name: string) => {
    const physical = app.resources?.[name]?.physical;
    return physical ? [name, physical, physical.slice(physical.lastIndexOf('.') + 1)] : [name];
  };
  const own = new Set(namesOf(target));
  const tables = new Set(Object.keys(app.resources ?? {}).flatMap(namesOf));
  let out = '';
  let from = 0;
  for (const match of source.matchAll(TABLE_CALL)) {
    const open = match.index + match[0].length - 1;
    if (open < from) continue;
    const [, table, method] = match;
    const elsewhere = tables.has(table) && !own.has(table);
    if (!elsewhere && !(own.has(table) && READS.has(method))) continue;
    out += source.slice(from, open + 1);
    from = closing(source, open);
  }
  return out + source.slice(from);
}

/** Past the bracket that closes the one at `open`, strings and templates skipped. */
function closing(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if ((c === ')' || c === '}' || c === ']') && --depth === 0) return i;
  }
  return source.length;
}

/**
 * Commands that write a balance a line's `consumes` (or `restocks`) already
 * moves while writing such a line: the handler's write and the rule's would
 * count the same line twice. A command that writes the balance and no line —
 * a stock count, a restock with no receipt — keeps the balance itself, which
 * is its to do, and is not named. Read off the handler's source, as
 * machineCommandWarnings reads a machine's column (`on_hand:` in an object it
 * passes, on a command over the parent or naming its table; the line's table
 * as its target or named), so a column written through a computed key is missed.
 */
export function consumesCommandWarnings(app: AppDef, schema: DatabaseSchema, commands: BusinessCommandRegistry | undefined): string[] {
  if (!commands) return [];
  const rules = [...appConsumesRules(app, schema).rules.values()].flat();
  if (!rules.length) return [];
  const names = (id: string) => {
    const table = schema.tables.find((candidate) => candidate.id === id);
    return { said: table?.name ?? id, all: new Set([id, table?.name ?? id]) };
  };
  const warnings = new Set<string>();
  for (const [id, command] of Object.entries(commands)) {
    const source = String(command.handle);
    const target = logicalResource(app, command.source, command.target);
    const touches = (all: Set<string>) =>
      all.has(target) || [...all].some((name) => source.includes(`'${name}'`) || source.includes(`"${name}"`));
    for (const rule of rules) {
      const parent = names(rule.parent);
      const line = names(rule.table);
      if (!touches(parent.all) || !touches(line.all)) continue;
      if (!new RegExp(`(^|[^\\w.])['"]?${rule.balance}['"]?\\s*:`).test(source)) continue;
      warnings.add(
        `command "${id}" writes "${rule.balance}" of "${parent.said}" and a "${line.said}" line, whose ${rule.gives ? 'restocks' : 'consumes'} already moves it [consumes-written]: ` +
          `leave the balance to the rule, or drop the rule where the command keeps the balance itself.`,
      );
    }
  }
  return [...warnings];
}
