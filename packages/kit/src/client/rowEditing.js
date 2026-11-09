/**
 * Whether a row may be edited here, and the two values a flag column holds:
 * the questions every editor asks before it draws, kept apart from the
 * record draft's store (write.js) so a grid's cell (GridCellEditor.tsx) can
 * ask them without loading the draft machinery and its boot-time wiring.
 * write.js re-exports both; the rules are these, once.
 */
import { prefersPages, state, writeAllowed } from './core.js';
import { planColumn } from './columns.js';
import { pageBridge } from './uiBridge.js';

const writableConnection = () => Boolean(state.connections?.find((c) => c.id === state.activeConnection)?.writable);

/**
 * The two values a boolean column actually holds, or null if it is not one.
 *
 * SQLite has no boolean and keeps
 * 0 and 1 in an INTEGER, so the pair depends on the column rather than on a
 * type name. Written back exactly as it was read, which is what stops an
 * edit to a *different* field of the same row from rewriting `1` to `true`
 * on the way past. The grid's own rule, not a second one.
 */
export function booleanChoices(column, row) {
  const plan = planColumn(column, column?.name ?? '', row ? [row] : []);
  if (plan.kind !== 'boolean') return null;
  return /bool/i.test(column?.type ?? '') ? { yes: 'true', no: 'false' } : { yes: '1', no: '0' };
}

/**
 * Whether the row is in a state its machine freezes (`final: { freeze: true }`): the server refuses every write to it,
 * so no editor is offered. Judged from the row's own state, which a row that does not carry the column cannot say.
 */
function frozenRow(tableId, row) {
  if (!row) return false;
  const app =
    /** @type {{ resources?: Record<string, { machine?: import('@mistriwork/engine/shared/servedApp.js').ServedMachine }> } | null} */ (
      pageBridge.activeApp()
    );
  const machine = app?.resources?.[tableId]?.machine;
  const value = machine ? row[machine.column] : undefined;
  return (
    machine !== undefined && value !== undefined && value !== null && machine.states.some((s) => s.freeze && s.value === String(value))
  );
}

/** True when this row can be edited at all: write mode on, and a full key; a frozen row (`row`, where the caller has it) is not. */
export function canEditRow(table, key, row) {
  if (!state.canWrite || !table || table.isView) return false;
  if (frozenRow(table.id, row)) return false;
  if (prefersPages() && !writableConnection()) return false;
  if (!writeAllowed(table.id)) return false;
  const pk = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  return pk.length > 0 && pk.every((c) => key[c] !== undefined && key[c] !== null);
}
