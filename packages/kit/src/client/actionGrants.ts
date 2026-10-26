/**
 * What this reader may run on a table, as the server said in the App payload: the fixed actions a role
 * of theirs runs on a table it does not write (`roles.<role>.actions`), as action ids by table id, and
 * whether any verb at all is theirs. A runtime answer the server asks again inside every write; here it
 * only decides which buttons are drawn. The kit's: its lists and the record page draw a verb by it, in
 * whichever shell serves the payload, and it reads a verb by its id and command alone.
 */
import { writeAllowed } from './core.js';

/** A verb as the grants read it: its id, and the command it runs where it runs one. */
interface Verb {
  id: string;
  command?: { id: string };
}

export function grantedActionIds(
  app: { grantedActions?: Record<string, string[]> } | null | undefined,
  tableId: string,
): readonly string[] {
  const granted = app?.grantedActions;
  return granted && Object.hasOwn(granted, tableId) ? granted[tableId] : [];
}

/**
 * Whether this reader may run any of a table's verbs here (ActionBar judges each again): a granted
 * command, or a fixed action on a table they write or one a role of theirs runs without write. It reads
 * only the App payload and the write scope, both known when a list first draws, so a row's ⋯ is decided
 * before the first row and never appears and then vanishes.
 */
export function mayRunAny(
  app: { grantedCommands?: readonly string[]; grantedActions?: Record<string, string[]> } | null | undefined,
  tableId: string,
  actions: readonly Verb[],
): boolean {
  const commands = app?.grantedCommands ?? [];
  const writes = writeAllowed(tableId);
  const granted = grantedActionIds(app, tableId);
  return actions.some((action) => (action.command ? commands.includes(action.command.id) : writes || granted.includes(action.id)));
}
