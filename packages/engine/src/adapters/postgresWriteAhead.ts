/**
 * What a Postgres transaction sends behind its BEGIN, and the small
 * statement builders that send and the transaction share. The ahead statements
 * must be exactly the ones the transaction sends in its turn, so they are built
 * here by the same rules (`plainStatement`, `scopedStatement`,
 * `rowLockStatement`) that `postgres.ts` calls when it sends them; this file
 * holds no other state than the per-handle lock bookkeeping below.
 */
import { POSTGRES_STYLE, buildWhere, clampLimit, clampOffset, type Filter, type QueryRequest, type SqlFragment } from './adapter.js';
import { holdAhead, sendAhead, sendsAhead, type AheadReport, type PipelinedStatement } from './postgresTransactionHandle.js';
import { createScopedReads } from './scoped/scopedReads.js';
import { KeyRows } from './scoped/keyRows.js';
import type { PostgresScopeCatalog } from './scoped/postgresScopeCatalog.js';
import type { PgQuery } from './postgresPool.js';
import { isRuntimeRelation, qualified } from './postgresValues.js';
import { capturesWrites } from './writeCapture.js';
import type { WriteAhead } from './writeAhead.js';
import type { RowScope } from '../shared/rowScope.js';
import type { DatabaseSchema, TableMeta } from '../shared/schema.js';
import type { PostgresTransactionJournal } from './storeHost.js';
import type { PostgresTransactionVerifier } from './postgres.js';

/* The row scope an unscoped transaction's kept rows are filed under (keyRows.ts): none, the same object every time. */
export const PLAIN_SCOPE: RowScope = Object.freeze({});

/* The record locks a transaction took behind its BEGIN (openPlain), by statement, each with what marks it taken.
   Only those: a lock taken later could be let go by a ROLLBACK TO SAVEPOINT, one taken at the opening cannot. */
export const heldLocks = new WeakMap<PgQuery, Map<string, () => void>>();
/* Of those, the ones that found their row: it is the transaction's, unmoving, until it ends (openPlain's `widen`). */
export const heldRows = new WeakMap<PgQuery, Set<string>>();
export const lockKey = (text: string, values: readonly unknown[]) => JSON.stringify([text, values]);
/* lockRecordNow's statement for a row named by its whole primary key, and its values. */
export function rowLockStatement(table: TableMeta, key: Readonly<Record<string, string | number>>): [string, unknown[]] {
  const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
  const where = buildWhere({ groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] }, POSTGRES_STYLE);
  return [`SELECT ${pk.map(POSTGRES_STYLE.quote).join(', ')} FROM ${qualified(table)}${where.text} FOR UPDATE`, where.params];
}

/* A table's schema and name from the name a request gives it, as assertPostgresTable reads it. */
export function plainTable(table: string): { schema: string; name: string } {
  const dot = table.indexOf('.');
  return dot === -1 ? { schema: 'public', name: table } : { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

/* A table's catalog id from the name a request gives it: a bare name is in the public schema, as assertPostgresTable reads it. */
export const catalogId = (table: string) => (table.includes('.') ? table : `public.${table}`);

/* The statement queryOn sends for an unordered read, without sending it: the table as its id names it
   (assertPostgresTable), the read bounded as every read is. */
export function plainStatement(request: QueryRequest): SqlFragment | undefined {
  if (request.orderBy?.length) return undefined;
  const at = plainTable(request.table);
  const where = buildWhere(request.filter, POSTGRES_STYLE);
  const cols = request.columns?.length ? request.columns.map((column) => POSTGRES_STYLE.quote(column)).join(', ') : '*';
  const n = where.params.length;
  return {
    text: `SELECT ${cols} FROM ${qualified(at)}${where.text} LIMIT $${n + 1} OFFSET $${n + 2}`,
    params: [...where.params, clampLimit(request.limit), clampOffset(request.offset)],
  };
}

/* A statement a scoped read would send, without sending it: createScopedReads
   compiles before it executes, so the executor is reached synchronously and
   says what it was handed. */
/** A row lock as a scoped transaction keeps it: its table and the filter that names the row. */
export const rowLockKey = (table: TableMeta, filter: Filter) => `${table.id}\u0000${JSON.stringify(filter)}`;

export function scopedStatement(schema: DatabaseSchema, within: RowScope, request: QueryRequest): SqlFragment | undefined {
  let said: SqlFragment | undefined;
  void createScopedReads(schema, within, POSTGRES_STYLE, async (sql) => {
    said = sql;
    return { columns: [], rows: [], ms: 0, sql };
  })
    .query(request)
    .catch(() => {});
  return said;
}

/* Statements sent ahead that a committed transaction never asked: a hint
   that no longer says what the transaction does. Warned once per statement
   outside production; a refused transaction stops early, and leaves some by
   design. With MISTRI_AHEAD_REPORT set, every transaction's account is a line
   on stderr (e2e/write-storm.spec.ts reads it). */
const warnedAhead = new Set<string>();
export function reportWriteAhead(report: AheadReport | undefined, committed: boolean): void {
  if (!report || (!report.sent && !report.missed)) return;
  const said = (key: string) => {
    try {
      return String((JSON.parse(key) as unknown[])[0]).slice(0, 160);
    } catch {
      return key.slice(0, 160);
    }
  };
  if (process.env.MISTRI_AHEAD_REPORT)
    process.stderr.write(
      `mistri-ahead ${JSON.stringify({ at: Date.now(), committed, sent: report.sent, taken: report.taken, answered: report.answered, missed: report.missed, left: report.left.map(said), redone: report.redone, asked: report.asked })}\n`,
    );
  if (!committed || process.env.NODE_ENV === 'production') return;
  for (const statement of report.left.map(said)) {
    if (warnedAhead.has(statement)) continue;
    warnedAhead.add(statement);
    process.emitWarning(`A statement sent ahead was never asked by the transaction it was sent for: ${statement}`, 'MistriWriteAhead');
  }
}

/** The statements openPlain sends behind the BEGIN; each exactly what the transaction sends in its turn (lockRecordNow, queryOn). */
export function sendPlainAhead(
  owner: object,
  write: PgQuery,
  schema: DatabaseSchema,
  keyRows: KeyRows,
  journal: PostgresTransactionJournal<unknown> | undefined,
  hint: WriteAhead,
): Promise<unknown>[] {
  if (!sendsAhead(write)) return [];
  const opening: PipelinedStatement[] = [];
  try {
    if (hint.receipt !== undefined && journal?.ahead) opening.push(...journal.ahead(hint.receipt));
  } catch {
    /* Asked in its turn. */
  }
  const answers = sendAhead(write, opening);
  for (const target of hint.targets) {
    const table = schema.tables.find((candidate) => candidate.id === catalogId(target.table));
    if (!table || table.isView || isRuntimeRelation(table.id)) continue;
    const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    const key = target.key;
    if (
      !pk.length ||
      Object.keys(key).length !== pk.length ||
      !pk.every((column) => Object.hasOwn(key, column) && (typeof key[column] === 'string' || typeof key[column] === 'number'))
    )
      continue;
    const filter: Filter = { groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] };
    if (!hint.readOnly && (hint.locks || (hint.writes && capturesWrites(owner, table.id)))) {
      /* lockRecordNow's statement, where the transaction will send it (the save's own lock, the history capture's). Held rather than answered once: the row stays locked until the transaction ends,
         so each later lock of it in this transaction (the command's, the history capture's) is answered by it, even
         after a write to another record has moved the statement generation. */
      const [text, values] = rowLockStatement(table, key as Readonly<Record<string, string | number>>);
      const lock = holdAhead(write, { text, values });
      if (lock) {
        answers.push(lock.answer);
        const locks = heldLocks.get(write) ?? new Map<string, () => void>();
        heldLocks.set(write, locks);
        const rows = heldRows.get(write) ?? new Set<string>();
        heldRows.set(write, rows);
        void lock.answer.then(
          (result) => {
            if (result.rows.length <= 1) locks.set(lockKey(text, values), lock.take);
            // Only a row that is there is held: one that is not could be inserted by another transaction meanwhile.
            if (result.rows.length === 1) rows.add(lockKey(text, values));
          },
          () => {},
        );
      }
    }
    const read = plainStatement({ table: table.id, filter, limit: 2, offset: 0 });
    const row = read && holdAhead(write, { text: read.text, values: read.params });
    if (row) {
      answers.push(row.answer);
      keyRows.keep(
        PLAIN_SCOPE,
        table,
        filter,
        row.answer.then((result) => result.rows),
        row.take,
      );
    }
  }
  return answers;
}

/**
 * The statements a scoped transaction opens with, sent behind its BEGIN
 * (openWrite's `sent`), from what it was told (writeAhead.ts) and the scope
 * catalog read last time: the verifier's own (its fence), the journal's
 * receipt lookup, and for each target its row lock, its row read in full
 * through the scope (kept to answer its reads by key, keyRows.ts), and,
 * where the write is captured for history, the capture's own lock and read
 * (historyWrites). Each is exactly the statement the transaction sends in
 * its turn, built by the same rules; one it never sends is left, counted,
 * and changes nothing. None where the client does not pipeline.
 */
export function sendWriteAhead(
  owner: object,
  write: PgQuery,
  scope: RowScope,
  peeked: PostgresScopeCatalog | undefined,
  keyRows: KeyRows,
  journal: PostgresTransactionJournal<unknown> | undefined,
  verify: PostgresTransactionVerifier | undefined,
  hint: WriteAhead | undefined,
  locked: Set<string>,
): Promise<unknown>[] {
  if (!sendsAhead(write) || (!hint && !verify?.ahead)) return [];
  const opening: PipelinedStatement[] = [];
  try {
    opening.push(...(verify?.ahead?.() ?? []));
    if (hint?.receipt !== undefined && journal?.ahead) opening.push(...journal.ahead(hint.receipt));
  } catch {
    /* Asked in its turn. */
  }
  const answers = sendAhead(write, opening);
  for (const target of (peeked && hint?.targets) || []) {
    const table = peeked!.schema.tables.find((candidate) => candidate.id === catalogId(target.table));
    if (!table || !peeked!.lockable.has(table.id)) continue;
    const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    const key = target.key;
    if (
      !pk.length ||
      Object.keys(key).length !== pk.length ||
      !pk.every((column) => Object.hasOwn(key, column) && (typeof key[column] === 'string' || typeof key[column] === 'number'))
    )
      continue;
    // The scoped transaction's own key filter and lock (scopedTransaction.ts keyFilter, `lock` above).
    const filter: Filter = { groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] };
    const where = buildWhere(filter, POSTGRES_STYLE);
    if (!hint!.readOnly) {
      answers.push(...sendAhead(write, [{ text: `SELECT 1 FROM ${qualified(table)}${where.text} FOR UPDATE`, values: where.params }]));
      locked.add(rowLockKey(table, filter));
    }
    // With its reference columns' stored text, as the scoped transaction reads its rows (storedText.ts).
    const read = scopedStatement(peeked!.schema, scope, { table: table.id, filter, limit: 2, offset: 0, storedText: true });
    const row = read && holdAhead(write, { text: read.text, values: read.params });
    if (row) {
      answers.push(row.answer);
      keyRows.keep(
        scope,
        table,
        filter,
        row.answer.then((result) => result.rows),
        row.take,
      );
    }
    if (hint!.writes && !hint!.readOnly && capturesWrites(owner, table.id)) {
      // historyWrites' read: lockRecordNow, then queryOn of the whole row by the key as given.
      const given = buildWhere(
        { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
        POSTGRES_STYLE,
      );
      const n = given.params.length;
      answers.push(
        ...sendAhead(write, [
          {
            text: `SELECT ${pk.map(POSTGRES_STYLE.quote).join(', ')} FROM ${qualified(table)}${where.text} FOR UPDATE`,
            values: where.params,
          },
          { text: `SELECT * FROM ${qualified(table)}${given.text} LIMIT $${n + 1} OFFSET $${n + 2}`, values: [...given.params, 2, 0] },
        ]),
      );
    }
  }
  return answers;
}
