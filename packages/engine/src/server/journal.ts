/**
 * What was written, and how to put it back.
 *
 * Transactions protect a call from failing *halfway*. They do nothing at all
 * about a call that succeeded and should not have — which is the failure mode
 * that actually happens when an agent has write access: nothing errored,
 * nothing rolled back, and the row is simply wrong now. Every destructive
 * label in the tool surface warns about that and none of them helped after
 * the fact.
 *
 * So every write that lands is recorded with what it would take to undo it,
 * and `revert` undoes the last one. The browser has had an undo for its own
 * edits since write mode shipped; this is the same idea one door out, covering
 * the writes an agent makes as well, and covering inserts and deletes, which
 * that one never did.
 *
 * Three things it deliberately does not do.
 *
 * It is **not persisted**. The browser's undo stack makes this argument and it
 * is the right one: a stack that outlives the process invites undoing
 * something from an hour ago, by which time the row has very likely moved on
 * and the "undo" is an overwrite wearing a friendly name. In-session is the
 * honest scope.
 *
 * It **checks before it writes**. Putting the old value back over a newer one
 * is not an undo, it is a silent overwrite — so the row is re-read first and
 * the revert refused if it no longer holds what this journal put there. An
 * undo that can quietly destroy someone else's edit is worse than no undo.
 *
 * And it **does not pretend about SQL**. A `runSql` write is recorded so the
 * history is complete, and marked unrevertible with the reason: arbitrary SQL
 * has no general inverse, and guessing one is how a safety net becomes the
 * thing that cut you.
 */
import {
  Refusal,
  TransactionOutcomeUnknown,
  WriteConflict,
  type Adapter,
  type Filter,
  type QueryResult,
  type WriteTransaction,
} from '../adapters/adapter.js';
import { snapshotScopedData } from '../adapters/scoped/scopedReads.js';

type WriteKind = 'update' | 'insert' | 'delete' | 'insert_graph' | 'delete_graph' | 'sql';

/** One row's worth of change, and everything needed to reverse it. */
export interface WriteStep {
  table: string;
  /** The row's primary key. Absent only where the write never had one. */
  key?: Record<string, unknown>;
  /** What the row held before. The inverse of an update or a delete. */
  before?: Record<string, unknown>;
  /** What it holds after, which is what a revert checks is still true. */
  after?: Record<string, unknown>;
  /** Complete stored image for bounded single-row inverses. Requires a fenced
   * transaction and lossless comparison; restore also requires non-replacing
   * insertion. Unmarked graph/scoped entries retain their existing contracts. */
  wholeRow?: boolean;
  /** Bounded update inverse: fence and compare only the touched fields, then
   * verify their restored stored values before committing. */
  exactFields?: boolean;
}

export interface JournalEntry {
  id: number;
  connection: string;
  kind: WriteKind;
  at: string;
  /** One line, in the words someone would use about it afterwards. */
  summary: string;
  /** Who made it, when a proxy header said (see --auth-proxy-header). */
  by?: string;
  /** Verified account and authored app identity, never request-supplied labels. */
  principal?: string;
  app?: string;
  revertible: boolean;
  /** Present when it is not, saying why rather than leaving it to be guessed. */
  reason?: string;
  /** In-memory attempt state, not a durable operation receipt. */
  undoState?: 'pending' | 'unknown';
  /** A confirmed write without a safe inverse must not expose an older Undo. */
  blocksUndo?: boolean;
  steps: WriteStep[];
}

/** Enough to walk back a mistake, not a session. Matches the browser's depth. */
const DEPTH = 50;

/* Per connection: a write on staging is not undoable on production, and a
   single stack would offer exactly that. */
const journals = new Map<string, JournalEntry[]>();
let nextId = 1;

const entriesFor = (connection: string): JournalEntry[] => {
  if (!journals.has(connection)) journals.set(connection, []);
  return journals.get(connection)!;
};

/** Record a write that landed. Returns the entry, mostly for tests. */
export function recordWrite(connection: string, entry: Omit<JournalEntry, 'id' | 'at' | 'connection'>): JournalEntry {
  const full: JournalEntry = {
    id: nextId++,
    connection,
    at: new Date().toISOString(),
    ...entry,
  };
  const list = entriesFor(connection);
  list.push(full);
  if (list.length > DEPTH) list.shift();
  return full;
}

/** The most recent first, which is the order anyone asks about them in. */
export function history(connection: string, limit = 10): JournalEntry[] {
  return [...entriesFor(connection)].reverse().slice(0, Math.max(1, limit));
}

/** The newest write that could still be undone, if there is one. */
export function lastRevertible(connection: string): JournalEntry | undefined {
  return latestRevertible([...entriesFor(connection)].reverse());
}

/** Entries are newest first. Never silently step past an unresolved Undo. */
export function latestRevertible(entries: readonly JournalEntry[]): JournalEntry | undefined {
  for (const entry of entries) {
    if (entry.blocksUndo || entry.undoState === 'pending' || entry.undoState === 'unknown') return undefined;
    if (entry.revertible) return entry;
  }
  return undefined;
}

export function forget(connection: string, id: number): void {
  const list = entriesFor(connection);
  const at = list.findIndex((e) => e.id === id);
  if (at !== -1) list.splice(at, 1);
}

/** Testing seam: a fresh process is the normal state, and tests want it too. */
export function clearJournal(connection?: string): void {
  if (connection === undefined) journals.clear();
  else journals.delete(connection);
}

/** Fail closed without publishing another entry (or consulting a clock). The
 * caller supplies already verified ownership; no record values are introduced. */
export function quarantineHistory(connection: string, owner?: { principal?: string; app?: string }): void {
  for (const entry of journals.get(connection) ?? []) {
    if (owner && (entry.principal !== owner.principal || entry.app !== owner.app)) continue;
    entry.revertible = false;
    entry.undoState = 'unknown';
    entry.reason = 'Newer write history could not be confirmed. Refresh and reconcile before further editing.';
  }
}

const keyFilter = (key: Record<string, unknown>): Filter => ({
  groups: [
    Object.entries(key).map(([column, value]) => ({
      column,
      op: '=' as const,
      value: value as string | number | boolean,
    })),
  ],
});

/** The row as it stands now, or undefined if it is gone. */
async function currentRow(
  adapter: Pick<Adapter, 'query'>,
  table: string,
  key: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const result = await adapter.query({ table, filter: keyFilter(key), limit: 1, offset: 0 });
  return result.rows[0] as Record<string, unknown> | undefined;
}

/* Compared as strings, because a value that went through the database and came
   back may be a different JavaScript type than the one that went in — SQLite
   hands back an integer for a boolean, and a driver may widen a numeric. The
   question is "is this still the value we wrote", not "is this the same
   object". */
const same = (a: unknown, b: unknown): boolean => a === b || (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

type RevertResult = {
  entry: JournalEntry;
  /** What was put back, in the order it was put back. */
  steps?: Array<{ table: string; key?: Record<string, unknown>; action: string }>;
} & ({ reverted: true; outcome: 'applied'; errors?: never } | { reverted: false; outcome: 'not_applied' | 'unknown'; errors?: string[] });

/**
 * Undo one recorded write.
 *
 * Every step is checked against the database before anything is written, and
 * the whole revert is refused if any of them has moved on. Half an undo is
 * worse than none: it leaves the row in a state neither the write nor the
 * revert intended, and nothing recorded that it happened.
 */
export async function revert(
  adapter: Adapter,
  connection: string,
  entry: JournalEntry,
  errorMessage: (error: unknown) => string = (error) => (error as Error).message,
): Promise<RevertResult> {
  // HTTP may pass a logical-resource projection, not the actual journal object.
  // Gate by the canonical entry so stale copies cannot start a second attempt.
  const canonical = entriesFor(connection).find((item) => item.id === entry.id);
  if (!canonical || canonical.connection !== entry.connection) {
    return { reverted: false, outcome: 'not_applied', entry, errors: ['This write is no longer available to undo.'] };
  }
  if (canonical.undoState) {
    return {
      reverted: false,
      outcome: 'unknown',
      entry,
      errors: [canonical.undoState === 'pending' ? 'This Undo is already in progress. Do not retry it.' : undoUncertain],
    };
  }
  if (canonical.blocksUndo || entry.blocksUndo || !canonical.revertible || !entry.revertible) {
    return { reverted: false, outcome: 'not_applied', entry, errors: [canonical.reason ?? entry.reason ?? 'That write cannot be undone.'] };
  }
  if (!adapter.update || !adapter.insert || !adapter.remove || !adapter.transaction) {
    return { reverted: false, outcome: 'not_applied', entry, errors: ['This connection cannot safely undo writes in one transaction.'] };
  }
  let owned: JournalEntry;
  try {
    owned = snapshotScopedData(entry);
    // Logical-resource projections may rename tables, but cannot weaken the
    // canonical inverse contract by dropping its comparison markers.
    if (canonical.steps.some((step) => step.wholeRow || step.exactFields)) {
      if (owned.kind !== canonical.kind || owned.steps.length !== canonical.steps.length) {
        throw new Refusal('This write has no complete inverse projection.');
      }
      owned.steps.forEach((step, index) => {
        if (canonical.steps[index].wholeRow) step.wholeRow = true;
        if (canonical.steps[index].exactFields) step.exactFields = true;
      });
    }
  } catch (error) {
    return { reverted: false, outcome: 'not_applied', entry, errors: [errorMessage(error)] };
  }
  canonical.undoState = 'pending';
  try {
    const result = await revertOwned(adapter, connection, owned, errorMessage);
    if (result.outcome === 'unknown') {
      canonical.undoState = 'unknown';
      canonical.revertible = false;
      canonical.reason = undoUncertain;
      Object.assign(owned, { undoState: 'unknown', revertible: false, reason: undoUncertain });
    }
    return result;
  } catch (error) {
    // Mutation failures are classified in revertOwned. This is a preflight
    // read failure: no inverse operation has entered its transaction yet.
    return { reverted: false, outcome: 'not_applied', entry, errors: [errorMessage(error)] };
  } finally {
    if (canonical.undoState === 'pending') delete canonical.undoState;
  }
}

const undoUncertain = 'The Undo outcome could not be confirmed. Refresh and reconcile the records; do not retry this Undo.';

function scalarImage(image: Record<string, unknown> | undefined): image is Record<string, string | number | boolean | null> {
  // A display label might now be real text. Even SQL cannot recover the
  // original type from that journal image, so refuse the ambiguous label too.
  return Boolean(
    image &&
    Object.keys(image).length &&
    Object.values(image).every(
      (value) =>
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'string' && !/^<\d+ bytes>$/.test(value)) ||
        (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))),
    ),
  );
}

const imagePredicates = (image: Record<string, string | number | boolean | null>) =>
  Object.entries(image).map(([column, value]) =>
    value === null ? { column, op: 'isNull' as const } : { column, op: '=' as const, value },
  );

function returnedImageMatches(current: QueryResult, image: Record<string, unknown>): boolean {
  return (
    current.rows.length === 1 &&
    Object.keys(current.rows[0]).length === Object.keys(image).length &&
    current.columns.length === Object.keys(image).length &&
    Object.entries(image).every(
      ([column, value]) => Object.hasOwn(current.rows[0], column) && current.columns.includes(column) && current.rows[0][column] === value,
    )
  );
}

/** Call on the fenced writer BOTH when capturing an image and when undoing it.
 * SQL equality detects lossy driver conversions (e.g. submillisecond dates);
 * strict scalar comparison also rejects NULL/empty and collation-equivalent
 * text changes. Capture-time validation is essential: a later rounded value
 * could match an image whose original precision was already lost.
 * Permission wrappers must expose complete raw fields before marking wholeRow.
 * This proves one scalar row, not trigger/cascade side effects or DDL history. */
export async function journalImageMatches(
  tx: Pick<WriteTransaction, 'query'>,
  table: string,
  image: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (!scalarImage(image)) return false;
  const filter: Filter = { groups: [imagePredicates(image)] };
  const current = await tx.query({ table, filter, limit: 2, offset: 0 });
  return returnedImageMatches(current, image);
}

/** The touched-field counterpart to journalImageMatches. Call under lockRecord
 * before and after a shared update to establish lossless history, and around
 * its inverse to detect races and restore coercion. Untouched fields need no
 * projection or inverse permission. A successful capture is not a guarantee
 * that generic type coercion will restore it; inverse readback must still pass. */
export async function journalFieldsMatch(
  tx: Pick<WriteTransaction, 'query'>,
  table: string,
  key: Record<string, unknown> | undefined,
  values: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (
    !scalarImage(values) ||
    !key ||
    !Object.keys(key).length ||
    Object.values(key).some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
  )
    return false;
  const filter: Filter = { groups: [...keyFilter(key).groups.map((group) => [...group, ...imagePredicates(values)])] };
  const current = await tx.query({ table, columns: Object.keys(values), filter, limit: 2, offset: 0 });
  return returnedImageMatches(current, values);
}

async function completeImageMatches(tx: WriteTransaction, step: WriteStep, image: Record<string, unknown> | undefined): Promise<boolean> {
  if (
    !image ||
    !step.key ||
    !Object.keys(step.key).length ||
    Object.entries(step.key).some(([column, value]) => !Object.hasOwn(image, column) || image[column] !== value)
  )
    return false;
  return journalImageMatches(tx, step.table, image);
}

async function revertOwned(
  adapter: Adapter,
  connection: string,
  entry: JournalEntry,
  errorMessage: (error: unknown) => string,
): Promise<RevertResult> {
  /* An insert is undone by removing what it added, and a delete by putting it
     back — so a graph's steps are reversed, children before parents or the
     other way round depending on which it was. The order a graph went in is
     the order it must come out of, backwards. */
  const steps = entry.kind === 'insert_graph' || entry.kind === 'delete_graph' ? [...entry.steps].reverse() : entry.steps;

  const undoing =
    entry.kind === 'insert' || entry.kind === 'insert_graph'
      ? 'remove'
      : entry.kind === 'delete' || entry.kind === 'delete_graph'
        ? 'restore'
        : 'put back';

  /* Checked first, all of it, before anything is written. */
  const problems: string[] = [];
  for (const step of steps) {
    // An outside read is neither the complete image nor a lock. New bounded
    // inverses do all validation below, after acquiring the transaction fence.
    if (step.wholeRow || step.exactFields) continue;
    if (!step.key) {
      problems.push(`A ${step.table} row in this write has no key, so it cannot be found again.`);
      continue;
    }
    const row = await currentRow(adapter, step.table, step.key);
    if (undoing === 'restore') {
      /* The row was deleted; putting it back is only honest if nothing has
         taken its key since. */
      if (row) problems.push(`${step.table} ${describe(step.key)} exists again, so restoring it would overwrite something.`);
      continue;
    }
    if (!row) {
      problems.push(`${step.table} ${describe(step.key)} is gone, so there is nothing to undo.`);
      continue;
    }
    const moved = Object.entries(step.after ?? {}).filter(([column, value]) => !same(row[column], value));
    if (moved.length) {
      problems.push(
        `${step.table} ${describe(step.key)} has changed since — "${moved[0][0]}" is no longer what this write left. ` +
          'Undoing would overwrite that.',
      );
    }
  }
  if (problems.length) return { reverted: false, outcome: 'not_applied', entry, errors: problems };

  const done: RevertResult['steps'] = [];
  /* The steps go back as one transaction where the adapter offers one, so a
     revert that fails on its third row leaves the first two as they were:
     half an undo is the state neither the write nor the revert intended.
     Legacy preflight stays on the read handle. Bounded single-row images are
     checked inside the writer, after a fence: a shared handle alone does not
     exclude concurrent PG writers. No nontransactional fallback. */
  const undo = async (tx: WriteTransaction) => {
    for (const step of steps) {
      if (
        (step.wholeRow || step.exactFields) &&
        (!step.key ||
          !Object.keys(step.key).length ||
          !tx.lockRecord ||
          (step.wholeRow && !['insert', 'delete'].includes(entry.kind)) ||
          (step.exactFields && entry.kind !== 'update'))
      ) {
        throw new Refusal('This connection cannot fence a complete single-row inverse.');
      }
      if (step.key && tx.lockRecord) await tx.lockRecord({ table: step.table, key: step.key as Record<string, string | number> });
    }
    for (const step of steps) {
      if (undoing === 'remove') {
        if (step.wholeRow && !(await completeImageMatches(tx, step, step.after))) throw new WriteConflict();
        const removed = await tx.remove({ table: step.table, key: step.key as Record<string, string | number> });
        if (step.wholeRow && removed.affected !== 1) throw new WriteConflict();
        done.push({ table: step.table, key: { ...step.key }, action: 'removed' });
      } else if (undoing === 'restore') {
        if (step.wholeRow && (await currentRow(tx, step.table, step.key!))) throw new WriteConflict();
        // An absent-row read does not reserve a PK. The transaction insert
        // contract MUST reject every uniqueness conflict, including SQLite
        // schema REPLACE policies, so a racing occupant cannot be overwritten.
        // Trigger/cascade side effects remain the adapter's row-only boundary.
        await tx.insert({
          table: step.table,
          values: (step.before ?? {}) as Record<string, string | number | boolean | null>,
        });
        if (step.wholeRow && !(await completeImageMatches(tx, step, step.before))) throw new WriteConflict();
        done.push({ table: step.table, key: { ...step.key }, action: 'restored' });
      } else {
        if (
          step.exactFields &&
          (!scalarImage(step.before) ||
            !scalarImage(step.after) ||
            Object.keys(step.before).length !== Object.keys(step.after).length ||
            Object.keys(step.before).some((column) => !Object.hasOwn(step.after!, column)) ||
            !(await journalFieldsMatch(tx, step.table, step.key, step.after)))
        )
          throw new WriteConflict();
        const updated = await tx.update({
          table: step.table,
          key: step.key as Record<string, string | number>,
          values: (step.before ?? {}) as Record<string, string | number | boolean | null>,
          expected: (step.after ?? {}) as Record<string, string | number | boolean | null>,
          // Returning to the recorded before-image is not a new transition.
          restore: true,
        });
        if (step.exactFields && (updated.affected !== 1 || !(await journalFieldsMatch(tx, step.table, step.key, step.before))))
          throw new WriteConflict();
        done.push({ table: step.table, key: { ...step.key }, action: 'put back' });
      }
    }
  };
  try {
    await adapter.transaction!((tx) => undo(tx));
  } catch (err) {
    if (err instanceof TransactionOutcomeUnknown) {
      return { reverted: false, outcome: 'unknown', entry, errors: [undoUncertain] };
    }
    return {
      reverted: false,
      outcome: 'not_applied',
      entry,
      steps: [],
      errors: [`${errorMessage(err)}${done.length ? ' — nothing was changed; the whole undo rolled back.' : ''}`],
    };
  }

  forget(connection, entry.id);
  return { reverted: true, outcome: 'applied', entry, steps: done };
}

const describe = (key: Record<string, unknown>): string => {
  const parts = Object.entries(key);
  return parts.length === 1 ? String(parts[0][1]) : parts.map(([c, v]) => `${c}=${v}`).join(',');
};

/** A sentence for the history, in the words someone would use about it. */
export function summarise(kind: WriteKind, steps: WriteStep[], detail?: string): string {
  const table = steps[0]?.table ?? 'something';
  const n = steps.length;
  switch (kind) {
    case 'update':
      return `Updated ${table} ${steps[0]?.key ? describe(steps[0].key) : ''}`.trim();
    // Many rows of one table in one insert entry is an import (recordedImport).
    case 'insert':
      return n > 1 ? `Imported ${n} rows into ${table}` : `Inserted into ${table}`;
    case 'delete':
      return `Deleted ${table} ${steps[0]?.key ? describe(steps[0].key) : ''}`.trim();
    case 'insert_graph':
      return `Inserted ${n} row${n === 1 ? '' : 's'} as one graph`;
    case 'delete_graph':
      return `Deleted ${n} row${n === 1 ? '' : 's'} as one graph`;
    default:
      return detail ? `Ran SQL: ${detail}` : 'Ran a SQL write';
  }
}
