/**
 * A record's life read off its status vocabulary: the one inference the
 * scaffold writes as a `machine()` and `tablewalk seed` walks when no App
 * says otherwise.
 *
 * A CHECK or enum list of plain words on a column named like a state is the
 * work's states in their order. Most of them are a path — received, in
 * progress, ready, collected — walked one verb at a time to the last, which
 * is final. A word that calls the work off (cancelled, rejected, lost) is an
 * exit: final, reached from every open state by a verb that asks first. A
 * word that parks the work (on hold, waiting for parts) is a side state: one
 * verb into it from the step before it, one back. That is a draft of how the
 * work moves, not a rule about the business: the author adds the skips and
 * the commands.
 *
 * Stamps follow: a date column named for a state (`ready_at`) is the
 * platform's to write as the record enters it, so it is left alone; one
 * named for what entering a state means (`completed_on` beside `collected`,
 * `cancelled_at` beside a `cancel` verb) is set by the verbs that lead there.
 */
import { columnKind, momentColumn, stateStampColumn, type ColumnMeta, type TableMeta } from '../shared/schema.js';

const said = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/* Words that call the work off: the exits. */
const EXIT =
  /^(cancell?ed|rejected|declined|denied|lost|closed_lost|void|voided|withdrawn|abandoned|failed|expired|refunded|no_show|dismissed|discarded|dropped|disqualified|unqualified|churned|terminated|aborted|wont_fix|duplicate|spam)$/;
/* Words that park the work: a side state, left the way it was entered. */
const HOLD = /^(on_hold|hold|paused|blocked|stalled|deferred|snoozed|backordered|waiting|waiting_\w+)$/;

/* The verb that leads into a state, by the state's word: what a person does to put the record there. */
const INTO: Record<string, string> = {
  in_progress: 'start',
  working: 'start',
  started: 'start',
  active: 'activate',
  open: 'open',
  ready: 'markReady',
  done: 'complete',
  complete: 'complete',
  completed: 'complete',
  finished: 'finish',
  collected: 'collect',
  picked_up: 'markPickedUp',
  closed: 'close',
  resolved: 'resolve',
  approved: 'approve',
  accepted: 'accept',
  confirmed: 'confirm',
  qualified: 'qualify',
  won: 'markWon',
  closed_won: 'markWon',
  shipped: 'ship',
  delivered: 'deliver',
  fulfilled: 'fulfill',
  invoiced: 'invoice',
  paid: 'markPaid',
  sent: 'send',
  submitted: 'submit',
  published: 'publish',
  scheduled: 'schedule',
  assigned: 'assign',
  in_review: 'sendForReview',
  review: 'sendForReview',
  archived: 'archive',
  returned: 'markReturned',
  on_hold: 'hold',
  hold: 'hold',
  paused: 'pause',
  blocked: 'block',
  cancelled: 'cancel',
  canceled: 'cancel',
  rejected: 'reject',
  declined: 'decline',
  denied: 'deny',
  lost: 'markLost',
  closed_lost: 'markLost',
  void: 'void',
  voided: 'void',
  withdrawn: 'withdraw',
  abandoned: 'abandon',
  failed: 'markFailed',
  expired: 'expire',
  refunded: 'refund',
  dismissed: 'dismiss',
  discarded: 'discard',
  disqualified: 'disqualify',
  terminated: 'terminate',
};

/* What a stamp's word says entering a state means, when it is not the state's own name. */
const DONE_STAMP = /^(completed|finished|closed|done|resolved|fulfilled|delivered|collected|picked_up|handed_over|shipped)$/;
const START_STAMP = /^(started|begun|commenced|work_started)$/;
const EXIT_STAMP = /^(cancell?ed|rejected|declined|lost|voided|withdrawn|abandoned|failed|terminated|closed_lost)$/;
const SINCE = /^(status|state|stage|phase)_(changed|updated|since|entered)(_at|_on)?$|^(status|state|stage|phase)_since$/i;
const REASON = /(^|_)reason$/i;

const camel = (words: string) => words.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** One verb of the drafted machine: the states it leaves, where it goes, and what it writes beside the column. */
interface DraftedVerb {
  verb: string;
  from: string[];
  to: string;
  /** Asks first: it calls the work off. */
  confirm?: true;
  /** The text column that says why it was called off. */
  reason?: string;
  /** Date columns set to now as the record moves (never a state's own stamp, which the platform writes). */
  stamps: string[];
}

/** A machine read off a status vocabulary. */
export interface DraftedMachine {
  column: string;
  /** Every state, in the vocabulary's order. */
  states: string[];
  /** The forward path, first state to the final one. */
  path: string[];
  /** Side states, each with the path state it is entered from and returns to. */
  holds: Map<string, string>;
  /** The final states that call the work off. */
  exits: string[];
  /** Each verb once, forward ones first, the exits last. */
  verbs: DraftedVerb[];
  /** The timestamp the platform stamps whenever the state changes. */
  since?: string;
}

/** Whether a vocabulary reads as a lifecycle: three or more plain words, at least two of them steps forward. */
export function draftMachine(table: TableMeta, column: ColumnMeta): DraftedMachine | undefined {
  const states = column.allowed ?? [];
  if (states.length < 3 || states.length > 10 || column.flag || !states.every((state) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(state)))
    return undefined;
  const exits = states.filter((state, i) => i > 0 && EXIT.test(said(state)));
  const holdStates = states.filter((state, i) => i > 0 && !exits.includes(state) && HOLD.test(said(state)));
  const path = states.filter((state) => !exits.includes(state) && !holdStates.includes(state));
  if (path.length < 2) return undefined;
  const holds = new Map<string, string>();
  for (const hold of holdStates) {
    /* Entered from the path state the vocabulary lists before it; one listed after the last step returns to the step before. */
    const before = states.slice(0, states.indexOf(hold)).filter((state) => path.includes(state) && state !== path.at(-1));
    holds.set(hold, before.at(-1) ?? path[0]);
  }
  /* A state named for a plan (due, scheduled) would read the plan's date as the moment it was entered: `due_on` stamped
     as the record is made. Such a vocabulary is a schedule's, not a lifecycle's. */
  if (
    states.some(
      (state) =>
        /^(due|scheduled|planned|expected|overdue|late)$/.test(said(state)) &&
        stateStampColumn(state, table.columns, { column: column.name }),
    )
  )
    return undefined;
  const final = path.at(-1)!;
  const open = states.filter((state) => state !== final && !exits.includes(state));

  const taken = new Set<string>();
  const verbFor = (state: string) => {
    const word = INTO[said(state)] ?? camel(`mark_${said(state)}`);
    let verb = word;
    for (let n = 2; taken.has(verb); n++) verb = `${word}${n}`;
    taken.add(verb);
    return verb;
  };
  const dated = table.columns.filter(
    (c) =>
      !c.primaryKey &&
      c.name !== column.name &&
      /_(at|on)$/.test(c.name) &&
      (momentColumn(c) !== undefined || columnKind(c.type ?? '') === 'date'),
  );
  const since = table.columns.find((c) => SINCE.test(c.name) && momentColumn(c) !== undefined)?.name;
  const machine = { column: column.name, ...(since ? { since } : {}) };
  /* A stamp the state's own name says is the platform's; one the verb's meaning says is the verb's. */
  const stampsFor = (to: string) =>
    dated
      .filter((c) => c.name !== since && stateStampColumn(to, table.columns, machine)?.name !== c.name)
      .filter((c) => {
        const word = said(c.name.replace(/_(at|on)$/, ''));
        if (states.some((state) => said(state) === word)) return false;
        const state = said(to);
        if (word === `${state}d` || word === `${state}ed` || state === `${word}d`) return true;
        if (to === final) return DONE_STAMP.test(word);
        if (exits.includes(to)) return EXIT_STAMP.test(word) && (exits.length === 1 || word.startsWith(state.slice(0, 4)));
        return path.length > 2 && to === path[1] && START_STAMP.test(word);
      })
      .map((c) => c.name);
  const reasonFor = (exit: string) => {
    const reasons = table.columns.filter((c) => REASON.test(c.name) && columnKind(c.type ?? '') === 'text' && !c.allowed?.length);
    return (reasons.find((c) => c.name.startsWith(said(exit).slice(0, 4))) ?? (reasons.length === 1 ? reasons[0] : undefined))?.name;
  };

  const verbs: DraftedVerb[] = [];
  const add = (from: string[], to: string, extra: Partial<DraftedVerb> = {}) => {
    const stamps = stampsFor(to);
    verbs.push({ verb: verbFor(to), from, to, stamps, ...extra });
  };
  for (let i = 0; i + 1 < path.length; i++) add([path[i]], path[i + 1]);
  for (const [hold, base] of holds) {
    add([base], hold);
    verbs.push({ verb: taken.has('resume') ? verbFor(base) : (taken.add('resume'), 'resume'), from: [hold], to: base, stamps: [] });
  }
  for (const exit of exits) {
    const reason = reasonFor(exit);
    add(open, exit, { confirm: true, ...(reason ? { reason } : {}) });
  }
  return { column: column.name, states, path, holds, exits, verbs, ...(since ? { since } : {}) };
}

/** Every column the machine writes: its column, its `since`, each state's own stamp and each verb's. */
export function machineWrites(table: TableMeta, machine: DraftedMachine): Set<string> {
  const written = new Set<string>([machine.column, ...(machine.since ? [machine.since] : [])]);
  for (const state of machine.states) {
    const own = stateStampColumn(state, table.columns, machine);
    if (own) written.add(own.name);
  }
  for (const verb of machine.verbs) for (const stamp of verb.stamps) written.add(stamp);
  return written;
}
