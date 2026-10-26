/**
 * Flows whose steps are rows: a resource's `flows` binds a table of
 * flows and a table of their steps, which an administrator edits while the
 * App runs, to the durable workflow engine that runs them on its records:
 *
 *   purchase_order: {
 *     flows: {
 *       from: 'po_flow', steps: 'po_flow_step',
 *       set: ['notes'],
 *       events: { 'po.decided': 'order' },
 *       kinds: { approval: { command: 'requestApproval', input: ['approver'], waitFor: 'po.decided' } },
 *     },
 *   }
 *
 * The rows have fixed column names, so there is one way to write one. A flow
 * is `id`, `name` and `start` (`created`, `updated` or `manual`), and may
 * have a `condition` in the query language, `changes` (the one column an
 * update must change) and `active`. A step is `flow_id`, `position` and
 * `kind`, with the inputs its kind reads: the platform's own kinds (`wait`,
 * `until`, `branch`, `set`, `waitFor`, `notify`) and the App's, each of which runs one
 * of the App's commands on the record — so whatever a flow does to data goes
 * through the command door, under its rules, principal and audit.
 *
 * Steps that share a position start together, and the run goes on once each
 * is done. A step of an App kind that waits for an event may wait for `all`
 * of those its command asked (its `mode`), end early when its `condition`
 * holds, give up after its `duration`, and run the kind's `remind` command
 * every `remind` while it waits.
 *
 * A `notify` step tells an `audience` its `message`: the resource's `notify`
 * rules `on: { flow: '<audience>' }` say who that is and how (`to`, `send`,
 * `email`), and the words are the step's (`{message}` in the rule's title),
 * kept in the inbox in the step's own transaction (adapters/inbox/inbox.ts).
 *
 * Pure, and shared: the server judges a stored row here (appValidation.ts)
 * and compiles a flow's rows into the plan a run follows (flowCommand.ts)
 * with the same words, so a row the form accepted is a step the run can take.
 */
import { parseDuration } from '@mistriwork/engine/shared/duration.js';

/** A step kind the App declares: the command it runs on the record, the step columns it takes as input, and an event to wait for after. */
interface FlowKind {
  readonly command: string;
  /** Step columns passed to the command under their own names; `'note?'` is one a step may leave empty. */
  readonly input?: readonly string[];
  /** An event of `events` the run waits for once the command has run. */
  readonly waitFor?: string;
  /** A command run on the record, with the same input, every `remind` a step of this kind waits. */
  readonly remind?: string;
}

/** `resources.<r>.flows`: the tables the flows and their steps are rows of, and what those rows may do. */
export interface FlowBinding {
  readonly from: string;
  readonly steps: string;
  /** Columns of the record a `set` step may write. None: the App offers no `set` step. */
  readonly set?: readonly string[];
  /** The events a run may wait for, each with the payload field that names the record it is about. */
  readonly events?: Readonly<Record<string, string>>;
  readonly kinds?: Readonly<Record<string, FlowKind>>;
}

/** The platform's own step kinds. */
const BUILT_IN_KINDS = ['wait', 'until', 'branch', 'set', 'waitFor', 'notify'] as const;
/** The longest a notify step's words may be: a notice is a line. */
const MESSAGE_MOST = 500;
const FLOW_TRIGGERS = ['created', 'updated', 'manual'] as const;
export type FlowTrigger = (typeof FLOW_TRIGGERS)[number];

/** The columns every flows table has, and every steps table: the rest are read where present. */
const FLOW_NEEDED = ['id', 'name', 'start'] as const;
const STEP_NEEDED = ['flow_id', 'position', 'kind'] as const;
/** The most steps one flow runs: a process, not a program. */
export const FLOW_STEPS_MOST = 100;
/** The longest a step may wait: the workflow engine's own ceiling. */
const DURATION_MOST = 366 * 86_400_000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KIND_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const COMMAND_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** `resources.<r>.flows`, read for its shape. Throws the sentence the author reads. */
export function parseFlows(raw: unknown, at: string): FlowBinding {
  const here = `${at}, flows`;
  if (!isObject(raw))
    throw new Error(
      `${here} is not an object → { from, steps, set?, events?, kinds? }, like flows: { from: 'po_flow', steps: 'po_flow_step' }.`,
    );
  const unknown = Object.keys(raw).find((key) => !['from', 'steps', 'set', 'events', 'kinds'].includes(key));
  if (unknown) throw new Error(`${here} has "${unknown}"; it takes from, steps, set, events and kinds.`);
  for (const name of ['from', 'steps'] as const)
    if (typeof raw[name] !== 'string' || !raw[name].trim())
      throw new Error(`${here}: "${name}" names the resource whose rows are the ${name === 'from' ? 'flows' : "flows' steps"}.`);
  const binding: { -readonly [K in keyof FlowBinding]: FlowBinding[K] } = {
    from: (raw.from as string).trim(),
    steps: (raw.steps as string).trim(),
  };
  if (raw.set !== undefined) {
    if (!Array.isArray(raw.set) || !raw.set.length || raw.set.some((column) => typeof column !== 'string' || !IDENTIFIER.test(column)))
      throw new Error(`${here}: "set" lists the record's own columns a set step may write, like set: ['notes'].`);
    binding.set = Object.freeze([...new Set(raw.set as string[])]);
  }
  if (raw.events !== undefined) {
    if (!isObject(raw.events) || !Object.keys(raw.events).length)
      throw new Error(
        `${here}: "events" names each event a run may wait for and the payload field naming the record, like events: { 'po.decided': 'order' }.`,
      );
    for (const [name, field] of Object.entries(raw.events)) {
      if (!EVENT_NAME.test(name))
        throw new Error(`${here}, events "${name}": an event is named as defineEvent names it, like 'po.decided'.`);
      if (typeof field !== 'string' || !IDENTIFIER.test(field))
        throw new Error(`${here}, events "${name}": name the payload field that holds the record's id, like 'order'.`);
    }
    binding.events = Object.freeze({ ...(raw.events as Record<string, string>) });
  }
  if (raw.kinds !== undefined) {
    if (!isObject(raw.kinds) || !Object.keys(raw.kinds).length)
      throw new Error(`${here}: "kinds" names each step kind the App adds, like kinds: { send: { command: 'sendPurchaseOrder' } }.`);
    const kinds: Record<string, FlowKind> = {};
    for (const [name, value] of Object.entries(raw.kinds)) {
      const kind = `${here}, kinds "${name}"`;
      if (!KIND_NAME.test(name)) throw new Error(`${kind}: a step kind is a word of letters, digits and underscores.`);
      if ((BUILT_IN_KINDS as readonly string[]).includes(name))
        throw new Error(
          `${kind}: "${name}" is one of the platform's own step kinds (${BUILT_IN_KINDS.join(', ')}); name the App's kind another word.`,
        );
      if (!isObject(value)) throw new Error(`${kind} is not an object → { command, input?, waitFor?, remind? }.`);
      const extra = Object.keys(value).find((key) => !['command', 'input', 'waitFor', 'remind'].includes(key));
      if (extra) throw new Error(`${kind} has "${extra}"; it takes command, input, waitFor and remind.`);
      if (typeof value.command !== 'string' || !COMMAND_ID.test(value.command))
        throw new Error(`${kind}: "command" names one of the App's commands, which the step runs on the record.`);
      const entry: { command: string; input?: readonly string[]; waitFor?: string; remind?: string } = { command: value.command };
      if (value.input !== undefined) {
        if (
          !Array.isArray(value.input) ||
          !value.input.length ||
          value.input.some((column) => typeof column !== 'string' || !IDENTIFIER.test(column.replace(/\?$/, '')))
        )
          throw new Error(
            `${kind}: "input" lists the step columns the command takes, like input: ['approver'] ('note?' for one a step may leave empty).`,
          );
        entry.input = Object.freeze([...(value.input as string[])]);
      }
      if (value.waitFor !== undefined) {
        if (typeof value.waitFor !== 'string' || !binding.events || !Object.hasOwn(binding.events, value.waitFor))
          throw new Error(`${kind}: "waitFor" names one of the flows' events, which "events" lists.`);
        entry.waitFor = value.waitFor;
      }
      if (value.remind !== undefined) {
        if (typeof value.remind !== 'string' || !COMMAND_ID.test(value.remind) || entry.waitFor === undefined)
          throw new Error(`${kind}: "remind" names one of the App's commands, run on the record while a step waits for "waitFor".`);
        entry.remind = value.remind;
      }
      kinds[name] = Object.freeze(entry);
    }
    binding.kinds = Object.freeze(kinds);
  }
  return Object.freeze(binding);
}

/** Every command a binding's kinds run, with the kind that runs it: its step's command, and its reminder. */
export const flowKindCommands = (binding: FlowBinding): { kind: string; command: string }[] =>
  Object.entries(binding.kinds ?? {}).flatMap(([kind, declared]) => [
    { kind, command: declared.command },
    ...(declared.remind ? [{ kind, command: declared.remind }] : []),
  ]);

/** A kind's input column, and whether a step may leave it empty. */
const kindInputs = (kind: FlowKind): { column: string; optional: boolean }[] =>
  (kind.input ?? []).map((name) => ({ column: name.replace(/\?$/, ''), optional: name.endsWith('?') }));

interface CatalogTable {
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly primaryKey: boolean }[];
}

/** Why a binding cannot run on this catalog, or undefined. `machine` is the record's state column, which only its verbs move. */
export function flowsProblem(
  binding: FlowBinding,
  table: CatalogTable,
  from: CatalogTable | undefined,
  steps: CatalogTable | undefined,
  machine?: string,
): string | undefined {
  const has = (meta: CatalogTable, name: string) => meta.columns.some((column) => column.name === name);
  if (table.columns.filter((column) => column.primaryKey).length !== 1)
    return `flows: "${table.name}" has no single-column key; a flow's run and the events it waits for name a record by one key.`;
  if (!from) return `flows: "${binding.from}" is not a declared resource on this connection.`;
  if (!steps) return `flows: "${binding.steps}" is not a declared resource on this connection.`;
  const missing = (meta: CatalogTable, needed: readonly string[]) => needed.filter((name) => !has(meta, name));
  const flowGap = missing(from, FLOW_NEEDED);
  if (flowGap.length)
    return `flows: "${from.name}" has no ${flowGap.map((name) => `"${name}"`).join(', ')}; a flow row has id, name and start (and may have condition, changes and active).`;
  const stepGap = missing(steps, STEP_NEEDED);
  if (stepGap.length)
    return `flows: "${steps.name}" has no ${stepGap.map((name) => `"${name}"`).join(', ')}; a step row has flow_id, position and kind (and the columns its kind reads).`;
  for (const column of binding.set ?? []) {
    if (!has(table, column)) return `flows: set names "${column}", which "${table.name}" does not have.`;
    if (table.columns.find((candidate) => candidate.name === column)!.primaryKey) return `flows: set names "${column}", the record's key.`;
    if (column === machine) return `flows: set names "${column}", the state column of the record's machine, which only its verbs move.`;
  }
  for (const [name, kind] of Object.entries(binding.kinds ?? {}))
    for (const { column } of kindInputs(kind))
      if (!has(steps, column)) return `flows: kind "${name}" takes "${column}", which "${steps.name}" does not have.`;
  return undefined;
}

/* ---------- a row, judged ---------- */

/** What a row breaks, by the column that says it. */
type FlowBreak =
  | 'name'
  | 'start'
  | 'condition'
  | 'changes'
  | 'kind'
  | 'position'
  | 'duration'
  | 'dateField'
  | 'setField'
  | 'goto'
  | 'event'
  | 'input'
  | 'mode'
  | 'remind'
  | 'together'
  | 'audience'
  | 'message'
  | 'flowId';

/** What the server says of a break: a fixed sentence, never the row's value. */
export const FLOW_REASONS: Readonly<Record<FlowBreak, string>> = Object.freeze({
  name: 'Name the flow.',
  start: 'Choose created, updated or manual.',
  condition: 'Write a condition in the query language about this record, like status = draft.',
  changes: "Name one of the record's columns.",
  kind: 'Choose one of the step kinds this App offers.',
  position: 'Give the step a whole-number position.',
  duration: "Enter a duration, like '2 hours' or '3 days', at most a year.",
  dateField: "Name one of the record's date columns.",
  setField: 'Name a column a flow may set.',
  goto: "Name a later step's position.",
  event: 'Choose one of the events this App’s flows wait for.',
  input: 'This step kind needs a value here.',
  mode: 'Choose any or all: all waits for each one the step asks.',
  remind: "Enter how often to remind, like '1 day', on a step whose kind reminds.",
  together: 'A branch decides alone: give it a position no other step has.',
  audience: "Choose who is told: one of the audiences this App's notices name.",
  message: `Write what they are told, at most ${MESSAGE_MOST} characters.`,
  flowId: 'Choose the flow this step belongs to.',
});

/** What the judge knows of the record's table: its columns, its date columns, and whether a condition reads. */
export interface FlowRecordShape {
  readonly columns: ReadonlySet<string>;
  readonly dates: ReadonlySet<string>;
  /** Whether a condition is a filter over the record's stored columns. */
  readonly condition: (text: string) => boolean;
  /** The audiences the resource's `notify` rules name `on: { flow }`: whom a `notify` step may tell. */
  readonly audiences?: ReadonlySet<string>;
}

const text = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const said = typeof value === 'string' ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  return said ? said : undefined;
};
const whole = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const durationMs = (value: unknown): number | undefined => {
  const ms = parseDuration(text(value));
  return ms && ms <= DURATION_MOST ? ms : undefined;
};

/** Every break of a flow row, by column. */
export function flowRowBreaks(row: Readonly<Record<string, unknown>>, record: FlowRecordShape): { field: string; reason: FlowBreak }[] {
  const breaks: { field: string; reason: FlowBreak }[] = [];
  if (!text(row.name)) breaks.push({ field: 'name', reason: 'name' });
  if (!(FLOW_TRIGGERS as readonly string[]).includes(text(row.start) ?? '')) breaks.push({ field: 'start', reason: 'start' });
  const condition = text(row.condition);
  if (condition !== undefined && !record.condition(condition)) breaks.push({ field: 'condition', reason: 'condition' });
  const changes = text(row.changes);
  if (changes !== undefined && !record.columns.has(changes)) breaks.push({ field: 'changes', reason: 'changes' });
  return breaks;
}

/** Every break of a step row, by column: an unknown kind, or an input its kind needs and lacks or cannot read. */
export function stepRowBreaks(
  row: Readonly<Record<string, unknown>>,
  binding: FlowBinding,
  record: FlowRecordShape,
): { field: string; reason: FlowBreak }[] {
  const breaks: { field: string; reason: FlowBreak }[] = [];
  const say = (field: string, reason: FlowBreak) => breaks.push({ field, reason });
  if (row.flow_id === null || row.flow_id === undefined || row.flow_id === '') say('flow_id', 'flowId');
  const position = whole(row.position);
  if (position === undefined || position < 0) say('position', 'position');
  const kind = text(row.kind) ?? '';
  const duration = text(row.duration);
  switch (kind) {
    case 'wait':
      if (durationMs(duration) === undefined) say('duration', 'duration');
      break;
    case 'until':
      if (!record.dates.has(text(row.field) ?? '')) say('field', 'dateField');
      if (duration !== undefined && durationMs(duration) === undefined) say('duration', 'duration');
      break;
    case 'branch': {
      const condition = text(row.condition);
      if (condition === undefined || !record.condition(condition)) say('condition', 'condition');
      // A branch only jumps forward, so a run visits each step at most once.
      if (text(row.goto) !== undefined) {
        const to = whole(row.goto);
        if (to === undefined || (position !== undefined && to <= position)) say('goto', 'goto');
      }
      break;
    }
    case 'set':
      if (!(binding.set ?? []).includes(text(row.field) ?? '')) say('field', 'setField');
      break;
    case 'waitFor':
      if (!Object.hasOwn(binding.events ?? {}, text(row.event) ?? '')) say('event', 'event');
      if (duration !== undefined && durationMs(duration) === undefined) say('duration', 'duration');
      break;
    case 'notify': {
      if (!record.audiences?.has(text(row.audience) ?? '')) say('audience', 'audience');
      const message = text(row.message);
      if (message === undefined || message.length > MESSAGE_MOST) say('message', 'message');
      break;
    }
    default: {
      const declared = Object.hasOwn(binding.kinds ?? {}, kind) ? binding.kinds![kind] : undefined;
      if (!declared) {
        say('kind', 'kind');
        break;
      }
      const inputs = kindInputs(declared);
      for (const { column, optional } of inputs) if (!optional && text(row[column]) === undefined) say(column, 'input');
      /* The wait's own columns, where the kind does not take them as input: only a kind that waits has a wait to shape. */
      const own = (column: string) => !inputs.some((input) => input.column === column);
      const waits = declared.waitFor !== undefined;
      const mode = text(row.mode);
      if (own('mode') && mode !== undefined && (!waits || (mode !== 'any' && mode !== 'all'))) say('mode', 'mode');
      const remind = text(row.remind);
      if (own('remind') && remind !== undefined && (!declared.remind || durationMs(remind) === undefined)) say('remind', 'remind');
      if (own('duration') && duration !== undefined && (!waits || durationMs(duration) === undefined)) say('duration', 'duration');
      const condition = text(row.condition);
      if (own('condition') && condition !== undefined && (!waits || !record.condition(condition))) say('condition', 'condition');
    }
  }
  return breaks;
}

/* ---------- a flow's rows, as the plan a run follows ---------- */

/** One step as a run takes it: read once, when the run starts, and kept with it. */
export type PlanStep = Readonly<
  {
    position: number;
    title?: string;
    /** Its place among the steps that share its position, from 1, where more than one does: they start together. */
    member?: number;
  } & (
    | { kind: 'wait'; duration: string }
    | { kind: 'until'; field: string; duration?: string }
    | { kind: 'branch'; condition: string; goto?: number }
    | { kind: 'set'; field: string; value: string | null }
    | { kind: 'waitFor'; event: string; field: string; duration?: string }
    | { kind: 'notify'; audience: string; message: string }
    | {
        kind: 'command';
        name: string;
        command: string;
        input: Readonly<Record<string, string>>;
        waitFor?: { event: string; field: string };
        /** Wait for each one the command asked (its output's `asked`), not the first. */
        mode?: 'all';
        /** The wait ends early once this holds of the record. */
        condition?: string;
        /** The most the wait lasts; then the run goes on. */
        duration?: string;
        /** The command run every `every` while the step waits. */
        remind?: { command: string; every: string };
      }
  )
>;

export interface FlowPlan {
  readonly flow: string;
  readonly name: string;
  readonly steps: readonly PlanStep[];
  /** The first row that cannot run: the run stops on it, saying why, before it does anything. */
  readonly problem?: Readonly<{ position: number | null; reason: string }>;
}

/** A flow's rows as its plan, in position order. Judged as a write judges them, so a row the form refused never runs. */
export function flowPlan(
  flow: Readonly<Record<string, unknown>>,
  rows: readonly Readonly<Record<string, unknown>>[],
  binding: FlowBinding,
  record: FlowRecordShape,
): FlowPlan {
  const id = text(flow.id) ?? '';
  const name = text(flow.name) ?? id;
  /* Steps that share a position keep one order, by their own key, so a run's steps are named the same each time they are read. */
  const ordered = [...rows].sort(
    (a, b) => (whole(a.position) ?? 0) - (whole(b.position) ?? 0) || String(a.id ?? '').localeCompare(String(b.id ?? '')),
  );
  if (ordered.length > FLOW_STEPS_MOST)
    return { flow: id, name, steps: [], problem: { position: null, reason: `A flow runs at most ${FLOW_STEPS_MOST} steps.` } };
  const steps: PlanStep[] = [];
  const shared = new Map<number, number>();
  for (const row of ordered) shared.set(whole(row.position) ?? -1, (shared.get(whole(row.position) ?? -1) ?? 0) + 1);
  const members = new Map<number, number>();
  for (const row of ordered) {
    const position = whole(row.position) ?? -1;
    const broken = stepRowBreaks(row, binding, record)[0];
    if (broken) return { flow: id, name, steps: [], problem: { position, reason: `${broken.field}: ${FLOW_REASONS[broken.reason]}` } };
    const together = shared.get(position)! > 1;
    if (together && (text(row.kind) === 'branch' || text(row.remind) !== undefined))
      return {
        flow: id,
        name,
        steps: [],
        problem: {
          position,
          reason: text(row.kind) === 'branch' ? FLOW_REASONS.together : 'A step that starts together with others sends no reminders.',
        },
      };
    const member = (members.get(position) ?? 0) + 1;
    members.set(position, member);
    const title = text(row.title);
    const head = { position, ...(title ? { title: title.slice(0, 200) } : {}), ...(together ? { member } : {}) };
    const kind = text(row.kind)!;
    const duration = text(row.duration);
    switch (kind) {
      case 'wait':
        steps.push({ ...head, kind, duration: duration! });
        break;
      case 'until':
        steps.push({ ...head, kind, field: text(row.field)!, ...(duration ? { duration } : {}) });
        break;
      case 'branch': {
        const to = whole(row.goto);
        steps.push({ ...head, kind, condition: text(row.condition)!, ...(to === undefined ? {} : { goto: to }) });
        break;
      }
      case 'set':
        steps.push({ ...head, kind, field: text(row.field)!, value: text(row.value) ?? null });
        break;
      case 'waitFor': {
        const event = text(row.event)!;
        steps.push({ ...head, kind, event, field: binding.events![event], ...(duration ? { duration } : {}) });
        break;
      }
      case 'notify':
        steps.push({ ...head, kind, audience: text(row.audience)!, message: text(row.message)! });
        break;
      default: {
        const declared = binding.kinds![kind];
        const inputs = kindInputs(declared);
        const input = Object.fromEntries(
          inputs.flatMap(({ column }) => {
            const value = text(row[column]);
            return value === undefined ? [] : [[column, value]];
          }),
        );
        const own = (column: string) => (inputs.some((each) => each.column === column) ? undefined : text(row[column]));
        const wait = declared.waitFor
          ? {
              waitFor: { event: declared.waitFor, field: binding.events![declared.waitFor] },
              ...(own('mode') === 'all' ? { mode: 'all' as const } : {}),
              ...(own('condition') ? { condition: own('condition')! } : {}),
              ...(own('duration') ? { duration: own('duration')! } : {}),
              ...(declared.remind && own('remind') ? { remind: { command: declared.remind, every: own('remind')! } } : {}),
            }
          : {};
        steps.push({ ...head, kind: 'command', name: kind, command: declared.command, input, ...wait });
      }
    }
  }
  return { flow: id, name, steps };
}

/** Whether a flow row is switched on: no `active` column, or one that is not false. */
export function flowActive(row: Readonly<Record<string, unknown>>): boolean {
  const value = row.active;
  return !(value === false || value === 0 || value === '0' || value === 'false' || value === 'f');
}

/** Whether a flow starts on this change: its `start`, and an update's `changes` column among the columns that changed.
 * A change naming a flow starts that one alone: a manual start, or `mistri flows start --flow` (flowStarts.ts). */
export function flowTriggered(
  row: Readonly<Record<string, unknown>>,
  change: Readonly<{ trigger: FlowTrigger; changed: readonly string[]; flow?: string }>,
): boolean {
  if (!flowActive(row)) return false;
  const trigger = text(row.start);
  if (change.trigger === 'manual') return trigger === 'manual' && text(row.id) === change.flow;
  if (trigger !== change.trigger || (change.flow !== undefined && text(row.id) !== change.flow)) return false;
  const changes = text(row.changes);
  return change.trigger === 'created' || changes === undefined || change.changed.includes(changes);
}
