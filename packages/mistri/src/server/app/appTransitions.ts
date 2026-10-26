/**
 * A machine's column (appMachine.ts), on the generic write path — Save, a
 * list's cell, an import, a fixed verb — run inside the write's own
 * transaction, after the row is locked, so the row it judges is the row
 * being written.
 *
 * A change is allowed when the new value is a fixed verb's `to` and that
 * verb's `when` — the states it leaves from, and its own condition — holds
 * for the stored row: the condition that decided whether the button was
 * offered, now checked where it can be relied on. A verb that asks a
 * `reason` needs one in the same write. Writing the value the row already
 * has is not a change. History's revert sets `restore`: a record returning
 * to its recorded before-image is not a new transition. A command's writes
 * are held to the same graph by the executor (businessCommandExecution.ts).
 */
import {
  Refusal,
  type Condition,
  type InsertRequest,
  type QueryRequest,
  type QueryResult,
  type UpdateRequest,
} from '@mistriwork/engine/adapters/adapter.js';
import { appTransitionRules, zonedNow, type AppDef, type AppTransitionRules, type AppUpdateAction } from '../../shared/app.js';
import { parseQuery, type QueryPerson } from '@mistriwork/engine/shared/query.js';
import { typedValue } from '../../shared/formLines.js';
import { compares } from '@mistriwork/engine/shared/computedValue.js';
import { readMeSets, textsMentionMe } from './appMe.js';
import { nowStamp } from './appStamps.js';
import { stateStampColumn } from '@mistriwork/engine/shared/schema.js';
import { AppAccessDenied } from './appAccessDenied.js';
import { sayRefusal } from '@mistriwork/engine/shared/refusal.js';
import type { ColumnMeta, DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

export type { AppTransitionRules };

/** Safe to show: it names the column and the action, never a stored value but the one written. */
export class AppTransitionDenied extends Refusal {
  /** `said` is what the person who asked is told (sayRefusal), where `message` holds more than they may read: the record's stored state. */
  constructor(message: string, said: string = message) {
    super(message);
    this.name = 'AppTransitionDenied';
    sayRefusal(this, said);
  }
}

/** Resolve once at binding. A rule the server could not enforce fails the App, never a write. */
export function compileAppTransitions(schema: DatabaseSchema, app: AppDef): AppTransitionRules | undefined {
  const { rules, problems } = appTransitionRules(app, schema);
  if (problems.length) throw new Error(problems[0]);
  return rules.size ? rules : undefined;
}

/* Values cross JSON and the driver: 3 and '3' are one status, null is only null. */
const same = (a: unknown, b: unknown) =>
  a === null || a === undefined || b === null || b === undefined ? (a ?? null) === (b ?? null) : String(a) === String(b);

type Reader = { query: (request: QueryRequest) => Promise<QueryResult> };

const exactly = (key: Record<string, string | number>): Condition[] =>
  Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }));

/** The record's key beside each of the condition's groups, as a bulk command's targets are judged. */
async function holds(
  reader: Reader,
  schema: DatabaseSchema,
  table: string,
  key: Record<string, string | number>,
  when: string | undefined,
  now: Date,
  me?: () => Promise<QueryPerson>,
): Promise<boolean> {
  if (!when) return true;
  // `me` is the writer's own session, as it was when the button was offered.
  const person = me && textsMentionMe([when], schema) ? { me: await readMeSets(await me(), [when], schema, reader) } : {};
  const parsed = parseQuery(`${table} ${when}`, { schema, now, columnValues: true, ...person });
  // One that no longer parses holds for nothing: the server does not vouch for a verb it cannot read.
  if (!parsed.query || parsed.errors.length) return false;
  const groups = parsed.query.filter.groups.length ? parsed.query.filter.groups : [[]];
  if (!groups.flat().some((condition) => condition.other !== undefined)) {
    const matched = await reader.query({
      table,
      columns: Object.keys(key),
      limit: 1,
      offset: 0,
      filter: { groups: groups.map((group) => [...exactly(key), ...group]) },
    });
    return matched.rows.length > 0;
  }
  /* Two of the row's columns compared (`qty < reorder_at`): no single-table read writes one, so the row is read
     by its key and the rest of its group, and the comparison judged of the values read, as the statement would. */
  const meta = schema.tables.find((candidate) => candidate.id === table);
  if (!meta) return false;
  for (const group of groups) {
    const compared = group.filter((condition) => condition.other !== undefined);
    const stored = group.filter((condition) => condition.other === undefined);
    const matched = await reader.query({
      table,
      columns: [...new Set([...Object.keys(key), ...compared.flatMap((condition) => [condition.column, condition.other!])])],
      limit: 1,
      offset: 0,
      filter: { groups: [[...exactly(key), ...stored]] },
    });
    const row = matched.rows[0];
    if (
      row &&
      compared.every((condition) =>
        compares(
          condition.op,
          typedValue(meta, condition.column, row[condition.column]),
          typedValue(meta, condition.other!, row[condition.other!]),
        ),
      )
    )
      return true;
  }
  return false;
}

/**
 * Refuse an update that moves a machine's column other than along an edge of
 * its graph. `stored` is the locked row when the caller already has it. What
 * it answers is written beside the move: the machine's `since`, stamped
 * whenever the state changes and the request does not say it itself.
 */
export async function assertTransitions(
  reader: Reader,
  schema: DatabaseSchema,
  rules: AppTransitionRules | undefined,
  request: UpdateRequest,
  stored?: Record<string, unknown>,
  now: Date = new Date(),
  me?: () => Promise<QueryPerson>,
): Promise<Record<string, string> | undefined> {
  const rule = rules?.get(request.table);
  if (!rule || request.restore === true) return undefined;
  const columns = schema.tables.find((table) => table.id === request.table)?.columns ?? [];
  const touched = [...rule.fields.keys()].filter((column) => Object.hasOwn(request.values, column));
  const clocked = machineClocks(rule, columns).filter((column) => Object.hasOwn(request.values, column));
  if (!touched.length && !clocked.length) return undefined;
  let moved = false;
  /* The verbs this write is: a stamp column one of them sets is that verb's word, judged with it. */
  const matched: AppUpdateAction[] = [];
  let row = stored;
  if (!row) {
    const read = await reader.query({
      table: request.table,
      columns: [...touched, ...clocked],
      limit: 2,
      offset: 0,
      filter: { groups: [exactly(request.key)] },
    });
    if (read.rows.length !== 1) throw new AppTransitionDenied('The record to change could not be found.');
    row = read.rows[0];
  }
  for (const column of touched) {
    const next = request.values[column];
    if (same(row[column], next)) continue;
    let allowed = false;
    let wanting: string | undefined;
    for (const action of rule.fields.get(column)!) {
      if (!same(action.set[column], next)) continue;
      // A fixed verb carries its stamps with the move; callers cannot replace
      // the person or moment it records. The machine supplies its own since.
      if (Object.entries(action.set).some(([field, value]) => field !== rule.since && !same(request.values[field], value))) continue;
      if (!(await holds(reader, schema, request.table, request.key, action.when, zonedNow(rule.timezone, now), me))) continue;
      const reason = action.reason === undefined ? undefined : request.values[action.reason];
      if (action.reason !== undefined && (typeof reason !== 'string' || !reason.trim())) {
        wanting ??= action.label;
        continue;
      }
      allowed = true;
      matched.push(action);
      break;
    }
    if (allowed) {
      moved = true;
      continue;
    }
    if (wanting) throw new AppTransitionDenied(`"${wanting}" needs a reason.`);
    throw new AppTransitionDenied(
      `"${column}" moves only by its machine's verbs, and none takes it from ${JSON.stringify(row[column] ?? null)} to ${JSON.stringify(next)} now.`,
      // The record's current state is not allowed to move there; the state it is in is not said, as the column may not be theirs to read.
      `The record's current state does not allow this change: "${column}" cannot move to ${JSON.stringify(next)} by any action this account can run on it now.`,
    );
  }
  /* The machine's clocks are its own. Every role that writes the table may
     write them (shared/appAccess.ts withMachineColumns), so that a verb can,
     and an `after` timer counts from `since`: a write that set it back an
     hour fired the timer an hour early. So no write says one but a verb that
     sets it, word for word; what a write repeats unchanged is left alone. A
     fixed move carries `since` as the word `now` (shared/appMachine.ts), as
     its button sends it; that word is the verb's, and the stamp below writes
     the server's moment over it whatever it says. */
  const verbSets = (column: string) => matched.some((action) => Object.hasOwn(action.set, column));
  const verbSays = (column: string) =>
    matched.some((action) => Object.hasOwn(action.set, column) && same(action.set[column], request.values[column]));
  for (const column of clocked) {
    if (same(row[column], request.values[column]) || verbSays(column)) continue;
    throw new AppTransitionDenied(`"${column}" is stamped by its machine as the state moves; no write sets it.`);
  }
  if (!moved) return undefined;
  const stamps: Record<string, string> = {};
  // Always, when the state moved: a `since` the write repeated would keep the clock of the state it left.
  if (rule.since !== undefined) {
    const column = columns.find((candidate) => candidate.name === rule.since);
    const stamp = column && nowStamp(column, now, rule.timezone);
    if (stamp !== undefined) stamps[rule.since] = stamp;
  }
  /* The state's own stamp (`ready_at` beside `ready`), written as the record enters it unless its verb says it. */
  const entered = stateStampColumn(String(request.values[rule.column]), columns, rule);
  if (entered && !verbSets(entered.name)) stamps[entered.name] = nowStamp(entered, now, rule.timezone)!;
  return Object.keys(stamps).length ? stamps : undefined;
}

/* The columns a machine stamps: its `since`, and each state's own (`ready_at`). */
function machineClocks(rule: NonNullable<ReturnType<AppTransitionRules['get']>>, columns: readonly ColumnMeta[]): string[] {
  const states = new Set([...rule.starts.values(), ...rule.moves.keys(), ...[...rule.moves.values()].flatMap((to) => [...to])]);
  const stamps = [...states].flatMap((state) => stateStampColumn(state, columns, rule)?.name ?? []);
  return [...new Set([...(rule.since === undefined ? [] : [rule.since]), ...stamps])];
}

/** A new record starts in the machine's first state: the column is left to its default, or says that state. */
export function assertTransitionInsert(
  rules: AppTransitionRules | undefined,
  request: InsertRequest,
  schema?: DatabaseSchema,
  now: Date = new Date(),
): InsertRequest['values'] | undefined {
  const rule = rules?.get(request.table);
  if (!rule) return;
  for (const column of rule.fields.keys()) {
    if (!Object.hasOwn(request.values, column)) continue;
    if (rule.starts.has(column) && same(rule.starts.get(column), request.values[column])) continue;
    throw new AppTransitionDenied(
      `"${column}" starts in ${JSON.stringify(rule.starts.get(column) ?? null)}, its machine's first state, and then moves only by its verbs.`,
    );
  }
  const columns = schema?.tables.find((table) => table.id === request.table)?.columns ?? [];
  // A new record's clocks start as it is made: none is the writer's to say.
  for (const column of machineClocks(rule, columns))
    if (Object.hasOwn(request.values, column) && request.values[column] !== null)
      throw new AppTransitionDenied(`"${column}" is stamped by its machine as the record is made; no write sets it.`);
  const values: InsertRequest['values'] = {};
  for (const [column, start] of rule.starts) if (!Object.hasOwn(request.values, column)) values[column] = start;
  if (rule.since && (request.values[rule.since] ?? null) === null) {
    const column = columns.find((column) => column.name === rule.since);
    const stamp = column && nowStamp(column, now, rule.timezone);
    if (stamp !== undefined) values[rule.since] = stamp;
  }
  /* The first state's own stamp (`booked_at` beside `booked`): the record enters it as it is made. */
  const entered = stateStampColumn(String(request.values[rule.column] ?? rule.starts.get(rule.column)), columns, rule);
  if (entered && (request.values[entered.name] ?? null) === null) values[entered.name] = nowStamp(entered, now, rule.timezone)!;
  return values;
}

/**
 * An update a role is not granted: no fixed action it holds is this body, or that action's `when` does not hold.
 * It is the role's grant refusing, so it answers as access does (403), never as a bad request a caller could fix.
 */
export class AppActionNotGranted extends AppAccessDenied {
  constructor() {
    super('This change is not one of the actions this account may run on the record now.');
    this.name = 'AppActionNotGranted';
  }
}

/**
 * A fixed action granted without write (`roles.<role>.actions`): the update
 * is admitted only when it is exactly one of the granted actions — its `set`
 * as authored, word for word (a stamp is still its word here and is resolved
 * after), its reason column and nothing else — and that action's `when` holds
 * for the stored row, judged inside the write as a declared transition is. A
 * body that adds a column, drops one, or says another value is refused whole,
 * so the grant can never be widened into a general edit.
 */
export async function assertGrantedAction(
  reader: Reader,
  schema: DatabaseSchema,
  granted: readonly AppUpdateAction[],
  request: UpdateRequest,
  now: Date = new Date(),
  me?: () => Promise<QueryPerson>,
  /** The App's zone: `now` is an instant, and a `when`'s date phrase reads the App's wall clock, as its list does. */
  zone?: string,
): Promise<void> {
  const written = Object.keys(request.values ?? {});
  for (const action of granted) {
    const columns = new Set([...Object.keys(action.set), ...(action.reason === undefined ? [] : [action.reason])]);
    if (written.length !== columns.size || written.some((column) => !columns.has(column))) continue;
    if (Object.entries(action.set).some(([column, value]) => request.values[column] !== value)) continue;
    if (
      action.reason !== undefined &&
      (Object.hasOwn(action.set, action.reason) ||
        typeof request.values[action.reason] !== 'string' ||
        !String(request.values[action.reason]).trim())
    )
      continue;
    if (!(await holds(reader, schema, request.table, request.key, action.when, zonedNow(zone, now), me))) continue;
    return;
  }
  throw new AppActionNotGranted();
}
