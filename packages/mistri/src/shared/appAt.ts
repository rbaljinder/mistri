/**
 * A resource's timers at an instant its record keeps: `at: { due_at:
 * 'markSla', warn_at: { command: 'warnSla', when: "state = 'running'" } }`.
 * Each runs its command through the jobs once the column's time has come and
 * the record matches `when` (the query language, over the record's own
 * columns), once for each instant the column holds: moving the instant arms
 * the timer again. It is the resource's, not a machine state's, because what
 * decides it — an SLA clock running, a reminder not yet sent — is often
 * written by many commands, and a machine's column moves only along its
 * edges. A state says itself with a `when`: `"status = 'open'"`.
 *
 * A timer may come due a while `before` or `after` the instant (`before: '24
 * hours'`), and a column that needs several takes a list of them: a reminder a
 * day ahead and another two hours ahead are two timers on `starts_at`, each
 * once per instant, so a rescheduled appointment is reminded again and the
 * old instant is never due.
 */

import { DURATION_WORDS, parseDuration } from '@mistriwork/engine/shared/duration.js';

/** One timer at an instant: the column, the command, and the condition the record is in. */
export interface AppAtTimer {
  column: string;
  command: string;
  /** Query-language conditions over the record's own columns, without the table name. */
  when?: string;
  /** How long before or after the instant the timer comes due, in the duration grammar: `'24 hours'`. At most one of them. */
  before?: string;
  after?: string;
}

/** The signed distance from a timer's instant to when it comes due: negative `before` it, positive `after`. */
export function atOffsetMs(timer: Pick<AppAtTimer, 'before' | 'after'>): number {
  if (timer.before !== undefined) return -(parseDuration(timer.before) ?? 0);
  return timer.after === undefined ? 0 : (parseDuration(timer.after) ?? 0);
}

const KEYS = new Set(['command', 'when', 'before', 'after']);
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A resource's `at`, read: each column's timers, in the authored order. */
export function parseResourceAt(raw: unknown, at: string, isCommand: (command: string) => boolean): AppAtTimer[] {
  const here = `${at}, "at"`;
  if (!isRecord(raw) || !Object.keys(raw).length)
    throw new Error(`${here} is not { due_at: 'aCommand' } or { due_at: { command: 'aCommand', when: "status = 'open'" } }.`);
  return Object.entries(raw).flatMap(([column, value]) => {
    const where = `${here} "${column}"`;
    if (!COLUMN.test(column)) throw new Error(`${where}: name a date or timestamp column of the resource.`);
    const specs = Array.isArray(value) ? value : [value];
    if (!specs.length) throw new Error(`${where} is an empty list. Give it a timer, or leave the column out.`);
    /* Each timer on a column is its own job, named by its offset: two at the same distance would be one job. */
    const offsets = new Set<number>();
    return specs.map((item) => {
      const timer = parseTimer(item, column, where, isCommand);
      const ms = atOffsetMs(timer);
      if (offsets.has(ms))
        throw new Error(
          `${where} has two timers ${ms === 0 ? 'at the instant itself' : `${ms > 0 ? 'after' : 'before'} it by the same time`} [at-offset]. ` +
            `Each timer on a column comes due at its own time: give one a different before or after, or join their commands into one.`,
        );
      offsets.add(ms);
      return timer;
    });
  });
}

function parseTimer(value: unknown, column: string, where: string, isCommand: (command: string) => boolean): AppAtTimer {
  const spec = typeof value === 'string' ? { command: value } : value;
  if (!isRecord(spec)) throw new Error(`${where} is a command's name, { command, when, before or after }, or a list of them.`);
  for (const key of Object.keys(spec))
    if (!KEYS.has(key)) throw new Error(`${where} has no "${key}". A timer takes command, when, and before or after.`);
  if (typeof spec.command !== 'string' || !isCommand(spec.command))
    throw new Error(`${where} runs ${JSON.stringify(spec.command)}, which is not one of the App's commands. A timer runs a command.`);
  if (spec.when !== undefined && (typeof spec.when !== 'string' || !spec.when.trim()))
    throw new Error(`${where} has a "when" that is not conditions in the query language: "status = 'open'".`);
  if (spec.before !== undefined && spec.after !== undefined)
    throw new Error(
      `${where} comes due both before and after "${column}" [at-offset]. A timer is one time: keep one, or make two timers in a list.`,
    );
  const side = spec.before !== undefined ? 'before' : spec.after !== undefined ? 'after' : undefined;
  const wait = side === undefined ? undefined : spec[side];
  if (side !== undefined && (typeof wait !== 'string' || !parseDuration(wait)))
    throw new Error(`${where}, ${side} ${JSON.stringify(wait)}: say how long as ${DURATION_WORDS} [at-offset].`);
  return {
    column,
    command: spec.command,
    ...(typeof spec.when === 'string' ? { when: spec.when.trim() } : {}),
    ...(side === undefined ? {} : { [side]: (wait as string).trim() }),
  };
}
