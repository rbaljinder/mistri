import {
  Refusal,
  WriteConflict,
  type Adapter,
  type DeleteRequest,
  type DeleteResult,
  type InsertRequest,
  type InsertResult,
  type UpdateRequest,
  type UpdateResult,
  type WriteTransaction,
} from '../adapters/adapter.js';
import { snapshotScopedData } from '../adapters/scoped/scopedReads.js';
import { inRecordLane } from '../adapters/writeLanes.js';
import { withWriteAhead } from '../adapters/writeAhead.js';
import { isPoolBusy } from '../adapters/poolMetrics.js';
import { writeFailureOutcome } from './constraints.js';
import {
  journalFieldsMatch,
  journalImageMatches,
  quarantineHistory,
  recordWrite,
  summarise,
  type JournalEntry,
  type WriteStep,
} from './journal.js';
import { runRecordedTransaction } from './recordHistoryOperations.js';
import { referencesTo, type DatabaseSchema, type ForeignKey } from '../shared/schema.js';
import { carryServerRequest } from './serverRequests.js';

interface RecordWriteOptions {
  adapter: Adapter;
  connection: string;
  /** Owns logical/physical mapping and verified account attribution for every entry. */
  record?: typeof recordWrite;
  /** Verified history ownership, paired with the exact physical connection.
   * Used to fail closed if publishing even an uncertainty barrier fails. */
  historyOwner?: { principal?: string; app?: string };
  completeInverse?: boolean;
  by?: string;
  /** False where an App writes: it has no Undo, so nothing is journaled (unrecorded). */
  journal?: boolean;
}

type Entry = Omit<JournalEntry, 'id' | 'at' | 'connection'>;
type Kind = 'update' | 'insert' | 'delete';
type Recorded<Result> = { result: Result; undoId?: number };
/** What else a deletion may change: see recordedDelete. */
interface Dependents {
  references?: readonly ForeignKey[];
  unseen?: boolean;
}

function barrier(kind: Kind, table: string, reason: string, unknown = false): Entry {
  const entry = {
    kind,
    summary: reason,
    reason,
    revertible: false,
    ...(unknown ? { undoState: 'unknown' as const } : { blocksUndo: true }),
    // Keep the logical resource for source attribution, but no record values.
    steps: [{ table }],
  };
  return entry;
}

async function recorded<Result>(
  options: RecordWriteOptions,
  kind: Kind,
  table: string,
  run: (tx: WriteTransaction) => Promise<{ result: Result; entry: Entry }>,
): Promise<Recorded<Result>> {
  const { adapter: writer, record = recordWrite, connection, by } = options;
  const historyOwner = options.historyOwner ? { ...options.historyOwner } : undefined;
  if (!writer.transaction) throw new Refusal('Recorded writes require a supported transaction writer.');
  return runRecordedTransaction({
    mode: 'write',
    transaction: writer.transaction.bind(writer),
    work: run,
    history: {
      publish: (entry) => record(connection, { ...entry, ...(by ? { by } : {}) }),
      quarantine: () => quarantineHistory(connection, historyOwner),
    },
    uncertainty: {
      ...barrier(kind, table, 'Write outcome or history unconfirmed. Refresh and reconcile before further editing.', true),
      revertible: false,
      undoState: 'unknown',
    },
    // A refused checkout: no writer was leased, or the transaction rolled back (a failed rollback is an unknown outcome, which isPoolBusy does not claim).
    isRejection: (error) =>
      error instanceof Refusal || error instanceof WriteConflict || isPoolBusy(error) || writeFailureOutcome(error) === 'rejected',
  });
}

/**
 * An App's write. An App has no Undo, so it keeps no journal entry and
 * captures no images for one; what it keeps is the transaction and the row
 * lock the journal's capture ran in. Inside them the App's adapter judges
 * transitions on the locked row and validates the stored row after the
 * write, and a refusal there rolls the write back — the reasons a single
 * statement would not do. The lane (writeLanes.ts) keeps saves of one
 * record in the order they arrived, now that saves of different records
 * run side by side.
 */
async function unrecorded<Result>(
  options: RecordWriteOptions,
  request: { table: string; key?: Record<string, unknown> },
  run: (tx: WriteTransaction) => Promise<Result>,
): Promise<Recorded<Result>> {
  const writer = options.adapter;
  if (!writer.transaction) throw new Refusal('Writes require a supported transaction writer.');
  const work = () => writer.transaction!(run);
  return { result: await (request.key ? inRecordLane(request.table, request.key, work) : work()) };
}

async function original(tx: WriteTransaction, request: DeleteRequest, columns?: string[]) {
  // Merely using the writer handle is not enough under READ COMMITTED: another
  // transaction could change the row between SELECT and mutation. The adapter
  // owns the dialect-specific row lock (or SQLite's existing writer fence).
  if (!tx.lockRecord) throw new Refusal('Recorded writes require a transaction record-lock capability.');
  await tx.lockRecord({ table: request.table, key: request.key });
  return rowAt(tx, request, columns);
}

async function rowAt(tx: WriteTransaction, request: DeleteRequest, columns?: string[]) {
  const result = await tx.query({
    table: request.table,
    ...(columns ? { columns } : {}),
    filter: { groups: [Object.entries(request.key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
    limit: 2,
    offset: 0,
  });
  return result.rows.length === 1 ? { ...snapshotScopedData(result.rows[0]) } : undefined;
}

/** One row of a new record's lines as a save sends it: the values the reader set. */
export interface LineRow {
  values: Record<string, string | number | boolean | null>;
}

/**
 * One collection of a record's lines, judged by the route (formLinesWrite.ts):
 * the child table, the reference that joins a row to the record and the
 * record's column it holds, the column the rows' places
 * fill, and every row, in order.
 */
export interface LineCollection {
  table: string;
  whose: string;
  refers: string;
  order?: string;
  rows: readonly LineRow[];
  /** Filled as the lines are written: the key of every row inserted, for the search index to follow once the transaction commits. */
  written?: Record<string, string | number>[];
}

/**
 * A record's lines, written in its transaction once the record is: each row
 * the insert the reader could make of it alone, so the
 * App's adapter judges every one (grants, validation, transitions) and a
 * refusal of any rolls back the record with them. A refused row's fields
 * cross as `table[i].field`, so the form marks the line, not the record.
 */
/**
 * A refusal that names the fields it turned down — the App framework's
 * validation (app/appValidationDenied.ts) — said again by a line with each
 * field at the line's place, so the form marks the line, not the record.
 */
export interface FieldRefusal extends Refusal {
  readonly fields: readonly string[];
  renamed(rename: (field: string) => string): Refusal;
}

const isFieldRefusal = (error: unknown): error is FieldRefusal =>
  error instanceof Refusal && typeof (error as Partial<FieldRefusal>).renamed === 'function';

/**
 * What writes a record's lines: the transaction itself where its adapter
 * judges every row, or, under a row policy or a tenant lease, that writer's
 * own facade — its transitions, its stamps, its deletion policy — so a line
 * is held to exactly what the same row would be held to alone.
 */
export type LineWriter = Pick<WriteTransaction, 'query' | 'insert' | 'lockRecord'> & {
  update(request: UpdateRequest): Promise<unknown>;
  remove(request: DeleteRequest): Promise<unknown>;
};

export async function writeLines(tx: LineWriter, lines: readonly LineCollection[], record: Readonly<Record<string, unknown>> | undefined) {
  for (const line of lines) {
    /* A transaction tried again writes them again: only the last attempt's keys stand. */
    const written: Record<string, string | number>[] = (line.written = []);
    const bound = record?.[line.refers];
    if (typeof bound !== 'string' && typeof bound !== 'number')
      throw new Refusal("The record's key was not read back, so its lines cannot be joined to it.");
    const marked = async <T>(i: number, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (!isFieldRefusal(error)) throw error;
        /* The table's own name, unqualified: a field crosses as one segment and a column (fieldErrors.ts). */
        throw error.renamed((name) => `${line.table.slice(line.table.lastIndexOf('.') + 1)}[${i}].${name}`);
      }
    };
    const placed = (row: LineRow, i: number) => ({ ...row.values, ...(line.order ? { [line.order]: i + 1 } : {}) });
    for (const [i, row] of line.rows.entries()) {
      const made = await marked(i, () =>
        tx.insert(snapshotScopedData({ table: line.table, values: { ...placed(row, i), [line.whose]: bound } })),
      );
      written.push(made.key as Record<string, string | number>);
    }
  }
}

export async function recordedUpdate(options: RecordWriteOptions, input: UpdateRequest): Promise<Recorded<UpdateResult>> {
  const request = snapshotScopedData(input);
  if (!Object.keys(request.values).length) throw new Refusal('Nothing to set.');
  if (options.journal === false)
    // The record it locks, reads and writes, told to the transaction so its lock and row go behind the BEGIN (writeAhead.ts).
    return withWriteAhead(
      { targets: [{ table: request.table, key: request.key as Record<string, string | number> }], writes: true, locks: true },
      () =>
        unrecorded(options, request, async (tx) => {
          // The row the App judges is the row the write replaces: a plain read would not hold it.
          if (!tx.lockRecord) throw new Refusal('Writes require a transaction record-lock capability.');
          await tx.lockRecord({ table: request.table, key: request.key });
          return tx.update(request);
        }),
    );
  return recorded(options, 'update', request.table, async (tx) => {
    // PK fields identify the predicate; they need not be readable projections.
    const before = await original(tx, request, Object.keys(request.values));
    const losslessBefore = Boolean(before && (await journalFieldsMatch(tx, request.table, request.key, before)));
    const result = await tx.update(request);
    const touched = Object.keys(result.applied);
    // Store the database image, not its write-intent DTO (booleans, defaults
    // and AFTER triggers can have a different stored representation).
    const after = result.affected === 1 && touched.length ? await rowAt(tx, request, touched) : undefined;
    if (
      !losslessBefore ||
      !before ||
      !after ||
      !touched.length ||
      touched.some((column) => !Object.hasOwn(before, column)) ||
      !(await journalFieldsMatch(tx, request.table, request.key, after))
    ) {
      return { result, entry: barrier('update', request.table, 'The updated record has no complete original for Undo.') };
    }
    const steps: WriteStep[] = [
      {
        table: request.table,
        key: { ...request.key },
        before: Object.fromEntries(touched.map((column) => [column, before[column]])),
        after,
        exactFields: true,
      },
    ];
    return { result, entry: { kind: 'update', summary: summarise('update', steps), revertible: true, steps } };
  });
}

export async function recordedInsert(
  options: RecordWriteOptions,
  input: InsertRequest,
  /** Rows that go with the new one, in its transaction, made from it: a record's tag links (tagLists.ts). */
  alongside?: (result: InsertResult) => readonly InsertRequest[],
  /** The new record's lines (`form.lines`), inserted in its transaction and joined to it (formLinesWrite.ts). */
  lines?: readonly LineCollection[],
): Promise<Recorded<InsertResult>> {
  // An upload's file columns are the server's to write (serverRequests.ts): the copy keeps the mark.
  const request = carryServerRequest(input, snapshotScopedData(input));
  const completeInverse = options.completeInverse !== false;
  if (lines?.length && options.journal !== false) throw new Refusal("A record's lines are saved with it in an App.");
  const withRows = async (tx: WriteTransaction, result: InsertResult) => {
    for (const row of alongside?.(result) ?? []) await tx.insert(snapshotScopedData(row));
    if (lines?.length) await writeLines(tx, lines, { ...result.row, ...result.key });
    return result;
  };
  if (options.journal === false) return unrecorded(options, request, async (tx) => withRows(tx, await tx.insert(request)));
  return recorded(options, 'insert', request.table, async (tx) => {
    const result = await withRows(tx, await tx.insert(request));
    /* An Undo of the record alone would leave its tags' link rows pointing at nothing. */
    if (alongside && alongside(result).length) {
      return {
        result,
        entry: barrier('insert', request.table, 'This creation added rows beside the record, which one Undo does not take back.'),
      };
    }
    if (
      !tx.lockRecord ||
      !completeInverse ||
      !Object.keys(result.key ?? {}).length ||
      !result.row ||
      !Object.keys(result.row).length ||
      !(await journalImageMatches(tx, request.table, result.row))
    ) {
      return {
        result,
        entry: barrier('insert', request.table, 'This creation has no complete identifiable inverse under the current permissions.'),
      };
    }
    const steps: Array<WriteStep & { wholeRow: true }> = [
      { table: request.table, key: { ...result.key }, after: { ...snapshotScopedData(result.row) }, wholeRow: true },
    ];
    return { result, entry: { kind: 'insert', summary: summarise('insert', steps), revertible: true, steps } };
  });
}

/**
 * Many new rows of one table in one transaction, recorded as one entry: an
 * import. Undo removes every row it added or none, as a single insert's
 * does, and only when each row's whole stored image could be captured; one
 * that could not makes the entry a barrier that says why.
 */
export async function recordedImport(
  options: RecordWriteOptions,
  inputs: readonly InsertRequest[],
  checkpoint: () => void = () => {},
): Promise<Recorded<InsertResult[]>> {
  const requests = inputs.map((input) => snapshotScopedData(input));
  const table = requests[0]?.table;
  if (!table || requests.some((request) => request.table !== table)) throw new Refusal('An import writes rows of one table.');
  if (options.journal === false)
    return unrecorded(options, { table }, async (tx) => {
      const results: InsertResult[] = [];
      for (const request of requests) {
        checkpoint();
        results.push(await tx.insert(request));
      }
      checkpoint();
      return results;
    });
  let complete = options.completeInverse !== false;
  return recorded(options, 'insert', table, async (tx) => {
    const results: InsertResult[] = [];
    const steps: Array<WriteStep & { wholeRow: true }> = [];
    for (const request of requests) {
      checkpoint();
      const result = await tx.insert(request);
      results.push(result);
      if (
        complete &&
        (!tx.lockRecord ||
          !Object.keys(result.key ?? {}).length ||
          !result.row ||
          !Object.keys(result.row).length ||
          !(await journalImageMatches(tx, table, result.row)))
      )
        complete = false;
      if (complete) steps.push({ table, key: { ...result.key }, after: { ...snapshotScopedData(result.row!) }, wholeRow: true });
    }
    checkpoint();
    if (!complete)
      return {
        result: results,
        entry: barrier('insert', table, 'This import has no complete identifiable inverse under the current permissions.'),
      };
    return { result: results, entry: { kind: 'insert', summary: summarise('insert', steps), revertible: true, steps } };
  });
}

/**
 * Captures this row only. A database-owned cascade (or `set null`) is not a
 * graph Undo: putting the parent back would leave its children gone or
 * emptied, which is half an undo. So when one of `dependents.references` —
 * the incoming references whose rule changes the rows behind them, named as
 * this writer names them — has a row pointing at this one, read on the same
 * writer before the delete, the entry is a barrier that says why, and the
 * deletion is undone whole or not at all. `dependents.unseen` says such a
 * reference exists from a table this writer cannot read (one an App does not
 * declare): it cannot be counted here, so it is a barrier whatever it holds.
 */
export async function recordedDelete(
  options: RecordWriteOptions,
  input: DeleteRequest,
  dependents: Dependents = {},
): Promise<Recorded<DeleteResult>> {
  const request = snapshotScopedData(input);
  const completeInverse = options.completeInverse !== false;
  if (options.journal === false) return unrecorded(options, request, (tx) => tx.remove(request));
  return recorded(options, 'delete', request.table, async (tx) => {
    const before = await original(tx, request);
    const complete = completeInverse && Boolean(before && (await journalImageMatches(tx, request.table, before)));
    const touches = complete && (dependents.unseen === true || (await touchesDependents(tx, request.key, dependents.references ?? [])));
    const result = await tx.remove(request);
    if (touches) {
      return { result, entry: barrier('delete', request.table, 'Rows elsewhere depended on it, so this deletion cannot be undone.') };
    }
    if (!complete || result.affected !== 1 || !before || !Object.keys(before).length) {
      return { result, entry: barrier('delete', request.table, 'The deleted record has no complete original for Undo.') };
    }
    /* The key as the row stored it, not as the request spelled it: an
       address says `1` as text, and a restore is checked against the stored
       row, whose integer 1 is not the string '1'. */
    const key = Object.fromEntries(
      Object.entries(request.key).map(([column, value]) => [column, Object.hasOwn(before, column) ? before[column] : value]),
    );
    const steps: WriteStep[] = [{ table: request.table, key, before, wholeRow: true }];
    return { result, entry: { kind: 'delete', summary: summarise('delete', steps), revertible: true, steps } };
  });
}

/** Whether a row behind one of these references points at `key`. A count that
 * cannot be taken is read as yes: an Undo that might be partial is not offered. */
async function touchesDependents(tx: WriteTransaction, key: Record<string, unknown>, dependents: readonly ForeignKey[]) {
  for (const fk of dependents) {
    const conditions = fk.to.columns.map((column, i) => ({
      column: fk.from.columns[i] ?? fk.from.columns[0],
      op: '=' as const,
      value: key[column],
    }));
    if (conditions.some((condition) => condition.value === undefined || condition.value === null)) return true;
    try {
      const found = await tx.query({
        table: fk.from.table,
        columns: fk.from.columns,
        filter: { groups: [conditions as Array<{ column: string; op: '='; value: string | number }>] },
        limit: 1,
        offset: 0,
      });
      if (found.rows.length) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The incoming references a deletion of `table` would change rows through:
 * every rule but a refusal, an unreported one included. */
export function changingReferences(schema: DatabaseSchema, table: string): ForeignKey[] {
  return referencesTo(schema, table).filter((fk) => !fk.declared && fk.onDelete !== 'restrict' && fk.onDelete !== 'no action');
}

/**
 * A deletion's dependents read off the database's own catalog, never an
 * App's reduced one: a cascade into a table the App does not declare still
 * happens. `physical` is the connection's catalog and `table` its name there;
 * `writerName` gives the name the writer reads a physical table by, or
 * undefined when it cannot read it — which makes the reference unseen.
 */
export function deletionDependents(
  physical: DatabaseSchema,
  table: string,
  writerName: (physicalTable: string) => string | undefined,
): Dependents {
  const references: ForeignKey[] = [];
  // A table the catalog does not know cannot be shown to have no dependents.
  let unseen = !physical.tables.some((item) => item.id === table);
  for (const fk of changingReferences(physical, table)) {
    const name = writerName(fk.from.table);
    if (name === undefined) unseen = true;
    else references.push({ ...fk, from: { ...fk.from, table: name } });
  }
  return { references, unseen };
}
