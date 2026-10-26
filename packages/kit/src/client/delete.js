/**
 * Deleting a row, having first said what that would do.
 *
 * This is the one destructive action in tablewalk, and it is also the one place
 * the tool has a genuine advantage over every other database client — not
 * through cleverness, but because of what it already knows. It counts what
 * points at a row in order to draw the Related panel; the same counts answer
 * "what breaks if this goes" *before* the delete rather than as a constraint
 * violation afterwards.
 *
 * The count alone is not the answer, which is the part most tools would get
 * wrong if they tried. Three rows pointing at this one means three rows
 * deleted under `cascade`, three rows left holding a null under `set null`, and
 * a delete that simply fails under `restrict`. Three outcomes behind one
 * number. So the dialog leads with the *rule*, and a rule the adapter could not
 * determine says so rather than being quietly rendered as harmless.
 *
 * The button and its dialog are a component (components/DeleteButton.tsx); what
 * stays here is the gate every write affordance shares.
 */
import { state, writeAllowed } from './core.js';

/**
 * Whether this connection will accept a delete at all.
 *
 * Asked of the server's own answer rather than inferred: `writable` is on the
 * connection list precisely so the interface does not offer a button the server
 * would refuse.
 */
export function canDelete(table) {
  if (!state.canWrite || !table || table.isView || table.deletable === false) return false;
  if (!writeAllowed(table.id)) return false;
  return Boolean(state.connections?.find((c) => c.id === state.activeConnection)?.writable);
}
