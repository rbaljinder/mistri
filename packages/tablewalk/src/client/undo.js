/**
 * Undo, for writes that have already landed.
 *
 * Write mode is the frightening part of this tool, and most of what makes it
 * frightening is that an edit is a one-way door. Saying "Undo" beside the
 * confirmation is what turns a decision into a correction.
 *
 * This used to keep its own stack: the write path knew what every column held
 * before it changed it, and putting those values back was a one-line call. It
 * worked, and it covered exactly one third of the writes that reach a
 * database through this tool. Not an insert. Not a delete. And not a single
 * thing an agent did over MCP, which is the half of the product where a write
 * is least likely to be watched.
 *
 * So the record moved to the server — `server/journal.ts`, one journal per
 * connection, written by every door — and this asks. What is kept here is the
 * part that was always the browser's: the keystroke, the menu item, a
 * confirmation's own Undo, and saying what happened afterwards.
 *
 * The guarantees did not move, they widened. The journal re-reads every row
 * before it writes anything and refuses the whole revert if one has changed
 * since, because putting an old value back over a newer one is not an undo,
 * it is a silent overwrite. It is in-session for the same reason this was: a
 * stack that outlives the process invites undoing something from an hour ago,
 * by which time the row has moved on.
 *
 * The database browser's alone. An App has no Undo: its writes run side by
 * side on a writer pool, so "the last write" is no longer one thing, and a
 * save is corrected by another save (server writeLanes.ts). Every entry
 * point here answers nothing outside the Workbench.
 */
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { api, state, toast } from '@mistriwork/kit/client/core.js';
import { queryClient } from '@mistriwork/kit/client/components/mount.js';
import { captureSessionIdentity, sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { advanceRecordSource } from '@mistriwork/kit/client/recordSource.js';
import { createHistoryQuarantine, historyToken, historyTokenAvailable, quarantineHistory } from '@mistriwork/kit/client/historyToken.js';
import { say } from './copy/shell/undo.js';
import { canUseDatabaseTools } from '@mistriwork/kit/client/connectionScope.js';
import { addHostListener } from '@mistriwork/kit/client/shellHost.js';

/* What the server last told us there was to undo. Held so the menu can name
   it without a request per repaint — the menu's detail is a function and is
   called on every open. Refreshed after anything that writes. */
let pending = null;
let refreshGeneration = 0;
// One gate and quarantine per connection, retired with the selected identity.
const inFlight = new Map();
/** @type {Map<string, import('@mistriwork/kit/client/historyToken.js').HistoryQuarantine>} */
const uncertain = new Map();
const historyState = (connection, identity) => uncertain.get(connection) ?? createHistoryQuarantine(identity.tenantRequired === true);
const UNKNOWN = say('undoWasNotConfirmed');

subscribeSessionIdentity(() => {
  pending = null;
  refreshGeneration++;
  inFlight.clear();
  uncertain.clear();
});

const ownsSession = (identity) => identity === sessionIdentity() && (identity.mode === 'anonymous' || identity.mode === 'authenticated');
const current = (connection, identity) => ownsSession(identity) && connection === state.activeConnection;

const forConnection = () => (pending && current(pending.connection, pending.identity) ? pending : null);
const nextForConnection = () => {
  if (!canUseDatabaseTools() || sessionIdentity().tenantRequired) return null;
  const next = forConnection()?.next;
  return !inFlight.has(state.activeConnection) &&
    next &&
    !next.undoState &&
    historyTokenAvailable(historyState(state.activeConnection, sessionIdentity()), next.id)
    ? next
    : null;
};

/**
 * Ask the server what there is to undo.
 *
 * Failures are silent and leave the menu saying "nothing to undo", which is
 * the safe direction to be wrong in: offering an undo that cannot happen is
 * worse than not offering one that could.
 */
export async function refreshUndo() {
  const connection = state.activeConnection;
  const identity = captureSessionIdentity();
  // Only the Workbench has a history to read; a public visitor has none of its own (the shell's publicVisitor).
  if (!connection || !canUseDatabaseTools() || !ownsSession(identity) || identity.tenantRequired || shell().publicVisitor()) return;
  const generation = ++refreshGeneration;
  /* A connection (or App) that says it writes nothing has no history to
     read, and asking anyway answered 403 on every page of a read-only App —
     a console error for a question whose answer was already known. */
  if (state.connections?.find((c) => c.id === connection)?.writable === false) {
    pending = { connection, identity, next: null, writes: [] };
    return;
  }
  try {
    const data = await api('/api/revert', ownedBy(connection));
    if (generation !== refreshGeneration || !current(connection, identity)) return;
    pending = {
      connection,
      identity,
      next: 'next' in data ? (data.next ?? null) : null,
      writes: 'writes' in data && Array.isArray(data.writes) ? data.writes : [],
    };
  } catch {
    if (generation === refreshGeneration && current(connection, identity)) pending = { connection, identity, next: null, writes: [] };
  }
}

export const canUndo = () => Boolean(nextForConnection());

/** What the menu item says it would undo, or null. */
export function undoDescription() {
  return nextForConnection()?.summary ?? null;
}

/**
 * Undo the last write on this connection.
 *
 * The decision about *which* write, and whether it is still safe to undo, is
 * the journal's — this reports what it decided, and answers whether it applied.
 * @param {import('@mistriwork/kit/client/historyToken.js').HistoryToken} [expectedId]
 * @returns {Promise<boolean | undefined>}
 */
export async function undoLast(expectedId = undefined) {
  const connection = state.activeConnection;
  const identity = captureSessionIdentity();
  if (!canUseDatabaseTools() || identity.tenantRequired) return;
  const next = nextForConnection();
  const targetId = expectedId ?? next?.id;
  if (!connection || !targetId) return;
  const data = await undoEntry(connection, targetId, () => toast(UNKNOWN, 'error'));
  if (!data || !current(connection, identity) || data.outcome === 'unknown') return false;
  if (data.reverted && data.outcome !== 'not_applied') {
    toast('undone' in data && data.undone?.summary ? `Undone: ${data.undone.summary}.` : 'Undone.', 'ok');
    return true;
  }
  const first = data.errors?.[0]?.message ?? data.errors?.[0];
  toast(first ?? say('nothingToUndo'), first ? 'error' : 'info');
  return false;
}

/**
 * The Undo a Workbench confirmation carries for the write it confirms. It
 * names that write's journal entry and no other, so pressing it after something newer landed is
 * refused by the server rather than undoing the newer thing; and it belongs
 * to the session and connection that made the write. `after` runs only when
 * the server said the Undo applied (the list to go back to, the counts).
 * @param {unknown} undoId
 * @param {() => void} [after]
 * @returns {{ label: string, run: () => Promise<void> } | undefined}
 */
export function undoToast(undoId, after) {
  const connection = state.activeConnection;
  const identity = captureSessionIdentity();
  if (
    !connection ||
    !canUseDatabaseTools() ||
    identity.tenantRequired ||
    !ownsSession(identity) ||
    historyToken(undoId, false) === undefined
  )
    return undefined;
  return {
    label: say('common.undo'),
    run: async () => {
      if (!current(connection, identity)) return;
      if (
        (await undoLast(/** @type {import('@mistriwork/kit/client/historyToken.js').HistoryToken} */ (undoId))) &&
        current(connection, identity)
      )
        after?.();
    },
  };
}

/** Shared by the menu and save dock: a lost response gates every Undo surface.
 * @param {string} connection
 * @param {import('@mistriwork/kit/client/historyToken.js').HistoryToken} expectedId
 * @param {(message: string) => void} [onUnknown]
 */
export async function undoEntry(connection, expectedId, onUnknown = (_message) => {}) {
  const identity = captureSessionIdentity();
  if (!canUseDatabaseTools() || identity.tenantRequired || !connection || !current(connection, identity)) return;
  if (historyToken(expectedId, identity.tenantRequired === true) === undefined) return;
  if (inFlight.has(connection) || !historyTokenAvailable(historyState(connection, identity), expectedId)) {
    return { reverted: false, outcome: 'not_applied', errors: [{ message: say('thisUndoIsPending') }] };
  }
  const attempt = {};
  inFlight.set(connection, attempt);
  // A preview already on the wire must not republish the submitted entry.
  refreshGeneration++;
  const quarantine = () => uncertain.set(connection, quarantineHistory(historyState(connection, identity), expectedId));
  let data;
  try {
    try {
      data = await api('/api/revert', { ...ownedBy(connection), confirm: true, expectedId });
    } catch (err) {
      if (!ownsSession(identity)) return;
      data = { reverted: false, outcome: err.outcome === 'not_applied' ? 'not_applied' : 'unknown', errors: [{ message: err.message }] };
    }
    if (!ownsSession(identity)) return;
    const unknown = data?.outcome === 'unknown' || (data?.outcome !== 'not_applied' && data?.reverted !== true);
    if (unknown) {
      quarantine();
      data = { reverted: false, outcome: 'unknown', errors: [{ message: UNKNOWN }] };
    }
    if (!current(connection, identity)) return;

    if (unknown || data.reverted) {
      // Keep mounted editors and their draft stores; refresh their data in place.
      advanceRecordSource();
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'command-prepare' });
    }
    // A slow history read must not delay warning that the write is uncertain.
    if (unknown) onUnknown(UNKNOWN);
    await refreshUndo();
    if (!current(connection, identity)) return;

    return data;
  } finally {
    if (inFlight.get(connection) === attempt) inFlight.delete(connection);
  }
}

/**
 * Bind ⌘Z.
 *
 * Stands aside for text fields, where it means "undo my typing" and taking it
 * over would be worse than not offering it — the staged-edit inputs are
 * exactly where someone is most likely to press it for the other reason.
 */
export function initUndo() {
  addHostListener(
    document,
    'keydown',
    (e) => {
      if (e.key !== 'z' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const tag = document.activeElement?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable)
      )
        return;
      if (!canUndo()) return;
      e.preventDefault();
      void undoLast();
    },
    true,
  );
}
