/**
 * Whether a due date's row is still open, so a date that has passed is drawn in the warning tone
 * (valueModel.ts, the `relative` format). Only a date the conventions treat as a due date
 * (shared/dueDate.ts): a `created_at` an author asked to be said from today is history, not a
 * deadline. Open is read off the row, never guessed: its resource's machine (a state that is not
 * final), else a yes-or-no named like done (`completed`, Tick's task) that is no. A row that says
 * neither — the column not fetched, no machine, no such flag — is not called overdue.
 */
import type { ServedMachine } from '@mistriwork/engine/shared/servedApp.js';
import { DUE } from '@mistriwork/engine/shared/dueDate.js';
import { pageBridge } from '../uiBridge.js';

const DONE = /^(is_)?(done|complete|completed|closed|resolved)$/i;
const YES = new Set(['true', 't', '1', 'yes']);

const machineOf = (tableId: string): ServedMachine | undefined =>
  (pageBridge.activeApp() as { resources?: Record<string, { machine?: ServedMachine }> } | null)?.resources?.[tableId]?.machine;

export function dueOpen(tableId: string | undefined, column: string, row: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!tableId || !row || !DUE.test(column)) return false;
  const machine = machineOf(tableId);
  if (machine) {
    const state = row[machine.column];
    if (state === null || state === undefined) return false;
    return !machine.states.some((s) => s.final && s.value === String(state));
  }
  const done = Object.keys(row).find((name) => DONE.test(name));
  if (done === undefined) return false;
  const value = row[done];
  if (value === null || value === undefined) return false;
  return !YES.has(String(value).toLowerCase());
}
