/**
 * A record's state machine: `machine: machine('status', { submitted: { on: {
 * assignReviewer: 'in_review', withdraw: 'withdrawn' } }, …, withdrawn: {
 * final: true } })`. The graph is the one statement of how the record moves,
 * and everything about moving it is read from here:
 *
 * - the verbs a record offers, as actions in the graph's order: a verb that
 *   names one of the App's commands runs it, from the states that list it;
 *   any other word is a fixed move, an update that sets the column;
 * - what the server admits, on every door: a generic write moves the column
 *   only as a fixed verb from the stored state (appTransitions.ts), a command
 *   runs only from a state that lists it and writes the column only along an
 *   edge (businessCommandExecution.ts), and a new record starts in the first
 *   state;
 * - the stepper, a board's lanes and the header's forward verb (the first verb
 *   of the current state), and the words a history line says;
 * - what runs on its own: a timer `after` the record has stayed a while, a
 *   command run through the jobs; and the moves only a service may make
 *   (`by`), which no button offers — a contract's term ending, moved by the
 *   sales clock. A timer at an instant a column holds is the resource's own
 *   (`at`, appAt.ts), whatever moves the record, so a state says it with a
 *   `when`.
 *
 * States keep their declared order: it is the record's order.
 */
import { fieldLabel } from './command.js';
import { DURATION_WORDS, parseDuration } from '@mistriwork/engine/shared/duration.js';
import type { MachineStates } from '@mistriwork/engine/shared/schema.js';

/** A fixed verb's extras, as authored: `set` keeps its stamps (`now`, `me`) for the action's parser. */
interface MachineFixed {
  set: Record<string, unknown>;
  reason?: string;
  when?: string;
  confirm?: boolean;
  bulk?: boolean;
}
/** One verb leaving one state: where it may go, and whether a command or a fixed update takes it. */
interface MachineEdge {
  verb: string;
  from: string;
  to: string[];
  command?: string;
  fixed?: MachineFixed;
  label: string;
}
interface MachineStateDef {
  name: string;
  label: string;
  final?: true;
  /** Timers: a command run through the jobs when the record has stayed this long (ms) in the state. */
  after?: { after: string; ms: number; command: string }[];
  /** Moves no verb makes: the states a service principal holding the role may move the record to from here. */
  by?: { role: string; to: string[] }[];
}
/** A machine as the App holds and serves it. */
export interface AppMachineDef {
  column: string;
  since?: string;
  /** The states a command may insert a new record in besides the first (`entry: ['qualify', 'discover']`): a lead
      converted after its qualifying call opens its deal at Discovery. A form's New record still starts first. */
  entry?: string[];
  /** Named sets of states (`groups: { onBench: ['checked_in', 'in_repair'] }`): `status is onBench` in the query
      language, as `status is open` is, each group's states in the machine's order. */
  groups?: Record<string, string[]>;
  states: MachineStateDef[];
  /** Every verb from every state, in the graph's order: states first to last, each state's verbs as written. */
  edges: MachineEdge[];
}

const STATE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROLE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERB = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GROUP = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/* What a state's old `at` named, so the refusal writes the resource's for it. */
const firstKey = (value: unknown) => (isRecord(value) ? Object.keys(value)[0] : undefined);
const firstCommand = (value: unknown) => {
  const command = isRecord(value) ? Object.values(value)[0] : undefined;
  return typeof command === 'string' ? command : undefined;
};

/** The query language's words for "the column holds one of these states". */
const inStates = (column: string, states: readonly string[]): string =>
  states.length === 1 ? `${column} = ${states[0]}` : `${column} in (${states.join(', ')})`;

/**
 * Parse a resource's `machine`. `isCommand` says whether a verb names one of
 * the App's commands (the parse's catalog): such a verb is resolved to the
 * command the browser is served; any other is a fixed move.
 */
export function parseMachine(raw: unknown, at: string, isCommand: (verb: string) => boolean): AppMachineDef {
  const here = `${at}, "machine"`;
  if (!isRecord(raw))
    throw new Error(`${here} is a machine: machine('status', { draft: { on: { submit: 'submitted' } }, submitted: { final: true } }).`);
  for (const key of Object.keys(raw))
    if (!['column', 'states', 'since', 'entry', 'groups'].includes(key))
      throw new Error(`${here} has no "${key}". It takes column, states, since, entry and groups.`);
  const column = raw.column;
  if (typeof column !== 'string' || !column.trim() || column.includes('.'))
    throw new Error(`${here} needs the "column" its states are, a column of the resource.`);
  if (raw.since !== undefined && (typeof raw.since !== 'string' || !raw.since.trim() || raw.since.includes('.') || raw.since === column)) {
    throw new Error(`${here} "since" names the timestamp column stamped when the state changes, another column of the resource.`);
  }
  if (!isRecord(raw.states) || !Object.keys(raw.states).length)
    throw new Error(`${here} needs "states": each state, in the record's order, and the verbs that leave it.`);
  const names = Object.keys(raw.states);
  if (names.length > 32) throw new Error(`${here} has ${names.length} states; a machine holds at most 32.`);
  for (const name of names) if (!STATE.test(name)) throw new Error(`${here}: "${name}" is not a state's value: letters, digits, _ and -.`);
  const states: MachineStateDef[] = [];
  const edges: MachineEdge[] = [];
  for (const name of names) {
    const where = `${here}, state "${name}"`;
    const state = raw.states[name];
    if (!isRecord(state)) throw new Error(`${where} is an object: { on: { verb: 'next' } }, or { final: true }.`);
    for (const key of Object.keys(state))
      if (key === 'at')
        throw new Error(
          `${where} has an "at": a timer at an instant is the resource's own, not a state's. Say it on the resource with a when: ` +
            `at: { ${firstKey(state.at) ?? 'due_at'}: { command: '${firstCommand(state.at) ?? 'aCommand'}', when: "${raw.column} = '${name}'" } }.`,
        );
      else if (!['on', 'after', 'by', 'final'].includes(key))
        throw new Error(`${where} has no "${key}". A state takes on, after, by and final.`);
    if (state.final !== undefined && state.final !== true) throw new Error(`${where} has a "final" that is not true.`);
    if (state.final === true && state.on !== undefined) throw new Error(`${where} is final, so no verb leaves it; drop "on", or "final".`);
    const def: MachineStateDef = { name, label: fieldLabel(name), ...(state.final === true ? { final: true as const } : {}) };
    if (state.after !== undefined) {
      if (!isRecord(state.after) || !Object.keys(state.after).length)
        throw new Error(`${where} has an "after" that is not { '3 days': 'aCommand' }.`);
      def.after = Object.entries(state.after).map(([wait, command]) => {
        const ms = parseDuration(wait);
        if (!ms) throw new Error(`${where}, after "${wait}": say how long as ${DURATION_WORDS}.`);
        if (typeof command !== 'string' || !isCommand(command)) {
          throw new Error(
            `${where}, after "${wait}" runs ${JSON.stringify(command)}, which is not one of the App's commands. A timer runs a command.`,
          );
        }
        return { after: wait.trim(), ms, command };
      });
      if (state.final === true) throw new Error(`${where} is final, so it has no timer to leave it; drop "after", or "final".`);
    }
    /* A move no verb makes and no button offers: only a service principal holding the role takes it. */
    if (state.by !== undefined) {
      if (!isRecord(state.by) || !Object.keys(state.by).length)
        throw new Error(`${where} has a "by" that is not { a_service_role: ['next'] }.`);
      if (state.final === true) throw new Error(`${where} is final, so nothing moves it; drop "by", or "final".`);
      def.by = Object.entries(state.by).map(([role, target]) => {
        if (!ROLE.test(role)) throw new Error(`${where}, by "${role}" is not a role's name.`);
        const to = typeof target === 'string' ? [target] : Array.isArray(target) ? [...target] : [];
        if (!to.length || to.some((next) => typeof next !== 'string' || !names.includes(next) || next === name))
          throw new Error(`${where}, by "${role}": name the other states it moves the record to, of ${names.join(', ')}.`);
        if (new Set(to).size !== to.length) throw new Error(`${where}, by "${role}" names a state twice.`);
        return { role, to: to as string[] };
      });
    }
    states.push(def);
    if (state.on === undefined) continue;
    if (!isRecord(state.on) || !Object.keys(state.on).length) throw new Error(`${where} has an "on" that is not { verb: 'next' }.`);
    for (const [verb, move] of Object.entries(state.on)) {
      const place = `${where}, verb "${verb}"`;
      if (!VERB.test(verb)) throw new Error(`${place} is not a verb: a word, or one of the App's commands by name.`);
      const detail = isRecord(move) ? move : undefined;
      if (detail)
        for (const key of Object.keys(detail)) {
          if (!['to', 'label', 'set', 'reason', 'when', 'confirm', 'bulk'].includes(key))
            throw new Error(`${place} has no "${key}". A verb takes to, label, set, reason, when, confirm and bulk.`);
        }
      const target = detail ? detail.to : move;
      const to = typeof target === 'string' ? [target] : Array.isArray(target) ? [...target] : [];
      if (!to.length || to.some((next) => typeof next !== 'string'))
        throw new Error(`${place} goes nowhere: name the state it moves the record to.`);
      for (const next of to as string[]) {
        if (!names.includes(next)) throw new Error(`${place} goes to "${next}", which is not one of the states (${names.join(', ')}).`);
      }
      if (new Set(to).size !== to.length) throw new Error(`${place} names a state twice.`);
      const label =
        detail?.label === undefined
          ? fieldLabel(verb)
          : typeof detail.label === 'string' && detail.label.trim()
            ? detail.label.trim()
            : (() => {
                throw new Error(`${place} has a "label" that is not text.`);
              })();
      /* `{to}` is the state the verb leads to, in the column's words: one state, so one word. */
      if (label.includes('{to}') && to.length !== 1)
        throw new Error(
          `${place} says "{to}" in its label and goes to ${to.join(' or ')}; name the one state it leads to, or write the label out.`,
        );
      if (detail?.when !== undefined && (typeof detail.when !== 'string' || !detail.when.trim()))
        throw new Error(`${place} has a "when" that is not a condition.`);
      for (const flag of ['confirm', 'bulk'] as const) {
        if (detail?.[flag] !== undefined && typeof detail[flag] !== 'boolean')
          throw new Error(`${place} has a "${flag}" that is not true or false.`);
      }
      if (isCommand(verb)) {
        /* A command verb that asks nothing may still ask first (`confirm: true`), as an action running a command may:
           a hand-over that commits on one click cannot be taken back. One with inputs is refused it where the action is. */
        for (const key of ['set', 'reason'] as const) {
          if (detail?.[key] !== undefined)
            throw new Error(
              `${place} runs the command "${verb}", which asks what it needs through its own input; "${key}" is a fixed move's.`,
            );
        }
        edges.push({
          verb,
          from: name,
          to: to as string[],
          command: verb,
          label,
          ...(detail?.when !== undefined || detail?.bulk !== undefined || detail?.confirm !== undefined
            ? {
                fixed: {
                  set: {},
                  ...(detail.when ? { when: (detail.when as string).trim() } : {}),
                  ...(detail.confirm === true ? { confirm: true } : {}),
                  ...(detail.bulk === true ? { bulk: true } : {}),
                },
              }
            : {}),
        });
        continue;
      }
      if (to.length !== 1)
        throw new Error(`${place} goes to ${to.join(' or ')}; a fixed move sets one state. Only a command chooses among several.`);
      if (detail?.set !== undefined && !isRecord(detail.set))
        throw new Error(`${place} has a "set" that is not the columns it writes beside the state.`);
      /* The moment the state changed, when the machine keeps it: stamped by the server as `now` is. */
      const set = {
        ...(detail?.set as Record<string, unknown> | undefined),
        [column]: to[0] as string,
        ...(typeof raw.since === 'string' ? { [raw.since.trim()]: { auto: 'now' } } : {}),
      };
      if (isRecord(detail?.set) && Object.hasOwn(detail.set, column))
        throw new Error(`${place} sets "${column}" itself; the machine does, from "to".`);
      if (detail?.reason !== undefined && (typeof detail.reason !== 'string' || !detail.reason.trim() || detail.reason.includes('.'))) {
        throw new Error(`${place} has a "reason" that is not a column of the resource.`);
      }
      edges.push({
        verb,
        from: name,
        to: to as string[],
        label,
        fixed: {
          set,
          ...(detail?.reason ? { reason: (detail.reason as string).trim() } : {}),
          ...(detail?.when ? { when: (detail.when as string).trim() } : {}),
          ...(detail?.confirm === true ? { confirm: true } : {}),
          ...(detail?.bulk === true ? { bulk: true } : {}),
        },
      });
    }
  }
  for (const state of states)
    for (const timer of state.after ?? []) {
      if (!edges.some((edge) => edge.from === state.name && edge.command === timer.command)) {
        throw new Error(
          `${here}, state "${state.name}": timer "${timer.command}" needs an on edge in this state naming where it moves the record [machine-timer-edge].`,
        );
      }
    }
  /* A fixed verb is one button: from every state that lists it, it writes the same thing. */
  for (const verb of new Set(edges.filter((edge) => edge.fixed && !edge.command).map((edge) => edge.verb))) {
    const same = edges.filter((edge) => edge.verb === verb);
    const first = JSON.stringify(same[0].fixed) + same[0].label;
    if (same.some((edge) => JSON.stringify(edge.fixed) + edge.label !== first)) {
      throw new Error(
        `${here}: the fixed verb "${verb}" moves to different states (or says it differently) from ${same.map((edge) => `"${edge.from}"`).join(' and ')}; name each its own verb.`,
      );
    }
  }
  if (states[0].final) throw new Error(`${here}: "${states[0].name}" is the first state, where a new record starts, and it is final.`);
  /* Where a command may start a record besides the first state: each one of the states, said once. */
  let entry: string[] | undefined;
  if (raw.entry !== undefined) {
    if (!Array.isArray(raw.entry) || !raw.entry.length || raw.entry.some((state) => typeof state !== 'string'))
      throw new Error(`${here} has an "entry" that is not a list of the states a command may insert a record in.`);
    for (const state of raw.entry as string[]) {
      if (!names.includes(state))
        throw new Error(`${here} "entry" names "${state}", which is not one of the states (${names.join(', ')}).`);
    }
    if (new Set(raw.entry).size !== raw.entry.length) throw new Error(`${here} "entry" names a state twice.`);
    entry = (raw.entry as string[]).filter((state) => state !== names[0]);
  }
  /* A group is a word the query language reads as its states: never a state's own name, nor `open`, which
     `is open` says. Its states are said in the machine's order, whatever order they were written in. */
  let groups: Record<string, string[]> | undefined;
  if (raw.groups !== undefined) {
    if (!isRecord(raw.groups) || !Object.keys(raw.groups).length)
      throw new Error(`${here} has "groups" that are not { onBench: ['checked_in', 'in_repair'] }.`);
    groups = {};
    for (const [group, members] of Object.entries(raw.groups)) {
      const where = `${here}, group "${group}"`;
      if (!GROUP.test(group)) throw new Error(`${where} is not a word: letters, digits and _, starting with a letter.`);
      if (names.includes(group)) throw new Error(`${where} is the name of a state; name the group another word.`);
      if (group === 'open')
        throw new Error(`${where}: "open" is what \`is open\` says (every state that is not final); name the group another word.`);
      if (!Array.isArray(members) || !members.length || members.some((member) => typeof member !== 'string'))
        throw new Error(`${where} is a list of the states it holds.`);
      for (const member of members as string[])
        if (!names.includes(member)) throw new Error(`${where} names "${member}", which is not one of the states (${names.join(', ')}).`);
      if (new Set(members).size !== members.length) throw new Error(`${where} names a state twice.`);
      groups[group] = names.filter((name) => (members as string[]).includes(name));
    }
  }
  return {
    column: column.trim(),
    ...(raw.since === undefined ? {} : { since: (raw.since as string).trim() }),
    states,
    edges,
    ...(entry?.length ? { entry } : {}),
    ...(groups ? { groups } : {}),
  };
}

/** The machine's states as the query language reads them on its column: open, final, and its groups. */
export function machineStates(machine: Pick<AppMachineDef, 'states' | 'groups'>): MachineStates {
  return {
    open: machine.states.filter((state) => !state.final).map((state) => state.name),
    final: machine.states.filter((state) => state.final).map((state) => state.name),
    ...(machine.groups ? { groups: machine.groups } : {}),
  };
}

/** Each verb once, in the graph's order, with every state it leaves from and every state it may reach. */
export function machineVerbs(machine: AppMachineDef): Array<MachineEdge & { froms: string[]; tos: string[] }> {
  const verbs = new Map<string, MachineEdge & { froms: string[]; tos: string[] }>();
  for (const edge of machine.edges) {
    const held = verbs.get(edge.verb);
    if (!held) verbs.set(edge.verb, { ...edge, froms: [edge.from], tos: [...edge.to] });
    else {
      held.froms.push(edge.from);
      for (const next of edge.to) if (!held.tos.includes(next)) held.tos.push(next);
    }
  }
  return [...verbs.values()];
}

/** Every (from → to) the graph allows, any verb. */
function machineMoves(machine: AppMachineDef): Map<string, Set<string>> {
  const moves = new Map<string, Set<string>>();
  for (const edge of machine.edges) {
    const next = moves.get(edge.from) ?? new Set<string>();
    for (const to of edge.to) next.add(to);
    moves.set(edge.from, next);
  }
  return moves;
}

/** The record's forward path, the stepper: from the first state, each state's first verb's first state, until a final one or a loop. */
export function machinePath(machine: AppMachineDef): string[] {
  const path = [machine.states[0].name];
  for (;;) {
    const next = machine.edges.find((edge) => edge.from === path[path.length - 1])?.to[0];
    if (!next || path.includes(next)) return path;
    path.push(next);
  }
}

/** Problems `mistri check` names about the graph itself: states no path reaches, and states no path leaves that are not final. */
export function machineProblems(machine: AppMachineDef, at: string): string[] {
  const problems: string[] = [];
  const moves = machineMoves(machine);
  for (const state of machine.states)
    for (const by of state.by ?? []) {
      const next = moves.get(state.name) ?? new Set<string>();
      for (const to of by.to) next.add(to);
      moves.set(state.name, next);
    }
  const reached = new Set([machine.states[0].name, ...(machine.entry ?? [])]);
  for (let grew = true; grew;) {
    grew = false;
    for (const state of [...reached])
      for (const next of moves.get(state) ?? [])
        if (!reached.has(next)) {
          reached.add(next);
          grew = true;
        }
  }
  for (const state of machine.states) {
    if (!reached.has(state.name))
      problems.push(
        `${at}: the state "${state.name}" is unreachable: no verb from "${machine.states[0].name}" leads to it [machine-unreachable].`,
      );
    if (!state.final && !moves.get(state.name)?.size && !state.after?.length) {
      problems.push(
        `${at}: the state "${state.name}" is a dead end: no verb leaves it and it is not final [machine-dead-end]. Give it a verb, or final: true.`,
      );
    }
  }
  return problems;
}

/**
 * The actions a machine offers, as authored actions for the resource's action
 * parser, in the graph's order — each verb once — with the exits last: a verb
 * that only leads out of the forward path into a final state (cancel,
 * withdraw, decline) is drawn after the ones that move the record on.
 */
export function machineActions(
  machine: AppMachineDef,
  words: Readonly<Record<string, unknown>> = {},
): Array<{
  id: string;
  label: string;
  when: string;
  /** A command verb that says itself differently from different states: each label, and the states it is said from. */
  labels?: Array<{ when: string; label: string }>;
  /** A command verb's every step, from a state to a state: a board by the machine's column moves a card through it. */
  move?: { column: string; edges: Array<{ from: string; to: string }> };
  command?: string;
  set?: MachineFixed['set'];
  reason?: string;
  confirm?: boolean;
  bulk?: boolean;
}> {
  const path = machinePath(machine);
  const exit = (verb: { tos: string[] }) =>
    verb.tos.every((to) => !path.includes(to) && machine.states.find((state) => state.name === to)?.final);
  const verbs = machineVerbs(machine);
  /* `{to}` filled with the state's word, as the stepper says it: the column's display `values`, else the state's name. */
  const said = (edge: MachineEdge) =>
    edge.label.split('{to}').join(typeof words[edge.to[0]] === 'string' ? (words[edge.to[0]] as string) : fieldLabel(edge.to[0]));
  return [...verbs.filter((verb) => !exit(verb)), ...verbs.filter(exit)].map((verb) => {
    const when = [inStates(machine.column, verb.froms), ...(verb.fixed?.when ? [`(${verb.fixed.when})`] : [])].join(' and ');
    /* Per-state labels (G65): "Move to Proposal" from Discovery, "Move to Negotiation" from Proposal. Each distinct
       label once, with the states that say it, in the graph's order. */
    const edges = machine.edges.filter((edge) => edge.verb === verb.verb);
    const byLabel = new Map<string, string[]>();
    for (const edge of edges) byLabel.set(said(edge), [...(byLabel.get(said(edge)) ?? []), edge.from]);
    const label = said(edges[0]);
    const labels =
      byLabel.size > 1 ? [...byLabel].map(([text, froms]) => ({ when: inStates(machine.column, froms), label: text })) : undefined;
    return verb.command
      ? {
          id: verb.verb,
          label,
          when,
          ...(labels ? { labels } : {}),
          /* Each step the verb takes (G62): "Move to {to}" leads Discovery to Proposal and Proposal to Negotiation, and a
             verb with several ends from one state is a drop onto any of them where its command asks for the column. */
          move: { column: machine.column, edges: edges.flatMap((edge) => edge.to.map((to) => ({ from: edge.from, to }))) },
          command: verb.command,
          // One button from every state: it asks first if any state's edge says so.
          ...(edges.some((edge) => edge.fixed?.confirm) ? { confirm: true } : {}),
          ...(verb.fixed?.bulk ? { bulk: true } : {}),
        }
      : {
          id: verb.verb,
          label,
          when,
          set: verb.fixed!.set,
          ...(verb.fixed!.reason ? { reason: verb.fixed!.reason } : {}),
          ...(verb.fixed!.confirm ? { confirm: true } : {}),
          ...(verb.fixed!.bulk ? { bulk: true } : {}),
        };
  });
}

/**
 * Each page over a resource with a machine draws its stepper: the forward
 * path, in order, on the page's summary — its first main-column fields(),
 * unless they say another presentation — or, without one, its header: where
 * a stepper stood when an author placed one by hand. The steps say the words
 * the column's display gives each state.
 */
export function withMachineSteppers<P extends { base: string; sections: ReadonlyArray<object> }>(
  pages: readonly P[],
  machineOf: (base: string) => { machine: AppMachineDef; words?: Record<string, string> } | undefined,
): P[] {
  return pages.map((page) => {
    const found = machineOf(page.base);
    if (!found) return page;
    const sections = page.sections as ReadonlyArray<{ kind?: unknown; presentation?: unknown; region?: unknown; workflow?: unknown }>;
    /* fields() in the main column is a summary unless it says otherwise (PageFields.tsx); the aside's is a property rail. */
    const drawn = (section: (typeof sections)[number]) => section.presentation ?? (section.region === 'aside' ? 'properties' : 'summary');
    const at = ['summary', 'header']
      .map((presentation) => sections.findIndex((section) => section.kind === 'fields' && drawn(section) === presentation))
      .find((index) => index >= 0);
    if (at === undefined || sections[at].workflow) return page;
    const { machine, words = {} } = found;
    const steps = machinePath(machine).map((value) => ({
      value,
      label: typeof words[value] === 'string' ? words[value] : fieldLabel(value),
    }));
    if (steps.length < 2) return page;
    return {
      ...page,
      sections: sections.map((section, index) =>
        index === at ? { ...section, workflow: { field: machine.column, steps, ordered: true } } : section,
      ),
    };
  });
}
