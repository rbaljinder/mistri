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
 */

/** One timer at an instant: the column, the command, and the condition the record is in. */
export interface AppAtTimer {
  column: string;
  command: string;
  /** Query-language conditions over the record's own columns, without the table name. */
  when?: string;
}

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A resource's `at`, read: each column's timer, in the authored order. */
export function parseResourceAt(raw: unknown, at: string, isCommand: (command: string) => boolean): AppAtTimer[] {
  const here = `${at}, "at"`;
  if (!isRecord(raw) || !Object.keys(raw).length)
    throw new Error(`${here} is not { due_at: 'aCommand' } or { due_at: { command: 'aCommand', when: "status = 'open'" } }.`);
  return Object.entries(raw).map(([column, value]) => {
    const where = `${here} "${column}"`;
    if (!COLUMN.test(column)) throw new Error(`${where}: name a date or timestamp column of the resource.`);
    const spec = typeof value === 'string' ? { command: value } : value;
    if (!isRecord(spec)) throw new Error(`${where} is a command's name, or { command, when }.`);
    for (const key of Object.keys(spec))
      if (key !== 'command' && key !== 'when') throw new Error(`${where} has no "${key}". A timer takes command and when.`);
    if (typeof spec.command !== 'string' || !isCommand(spec.command))
      throw new Error(`${where} runs ${JSON.stringify(spec.command)}, which is not one of the App's commands. A timer runs a command.`);
    if (spec.when !== undefined && (typeof spec.when !== 'string' || !spec.when.trim()))
      throw new Error(`${where} has a "when" that is not conditions in the query language: "status = 'open'".`);
    return { column, command: spec.command, ...(typeof spec.when === 'string' ? { when: spec.when.trim() } : {}) };
  });
}
