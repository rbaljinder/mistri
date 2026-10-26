/**
 * The SQLite reads that could hold the whole server, and where they run.
 *
 * node:sqlite runs a statement on the thread that asked, to its end: a
 * filtered list, a count or a breakdown over a million rows held every other
 * request — a page of another table, the runtime check, a sign-in — for as
 * long as it took (sqliteStatementProcess.ts says why a thread cannot help).
 * Such a read runs in the statement process instead, on a read-only handle
 * of its own on the same file, and the server goes on answering; its cap
 * (30 seconds) stops one that would never finish.
 *
 * Which reads: those over a large relation that cannot stop after the page —
 * an aggregate, a filter over a scan (one that matches rarely reads the whole
 * table to fill twenty rows), or a plan that sorts everything it found
 * (`USE TEMP B-TREE FOR ORDER BY`). A filter an index searches — an equality,
 * or a keyset page's range (keysetPage.ts) — starts where its rows are and
 * stays. A large relation is a table of
 * PROCESS_ROWS or more, one whose size is unknown (a file past a quarter
 * gigabyte that ANALYZE never read), or a SQL view, which may cost anything.
 * An unfiltered page walked in an index's order stops at its LIMIT and stays
 * in process: the child costs about 27 ms to start, which is more than that
 * page ever took. An in-memory database has no second handle and never moves.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { DatabaseSchema } from '../shared/schema.js';
import { ANSI_STYLE, MAX_LIMIT } from './adapter.js';
import { scaleRows, scalesOf } from './sqliteDecimals.js';
import { runInStatementProcess } from './sqliteStatementProcess.js';
import { cancellation, STATEMENT_TIMEOUT_MS } from './statementControl.js';

/** Past this many rows a scan of a table is worth a process start: about 50 ms of filtering on one thread. */
export const PROCESS_ROWS = 250_000;

const heavy = new WeakMap<DatabaseSchema, string[]>();

/** The quoted names of the relations a read of which may stall: large, of unknown size, or a view. */
export function heavyRelations(schema: DatabaseSchema | null): string[] {
  if (!schema) return [];
  let names = heavy.get(schema);
  if (!names) {
    names = schema.tables
      .filter((table) => table.isView || table.approxRows === undefined || table.approxRows >= PROCESS_ROWS)
      .map((table) => ANSI_STYLE.quote(table.name));
    heavy.set(schema, names);
  }
  return names;
}

/** Whether this statement may hold the thread: it reads a heavy relation and cannot stop at its page. */
export function stalls(
  db: DatabaseSync,
  text: string,
  params: readonly SQLInputValue[],
  relations: readonly string[],
  aggregate: boolean,
): boolean {
  if (!relations.some((name) => text.includes(name))) return false;
  if (aggregate) return true;
  try {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail);
    /* A sort of everything found; a sort of ties within an index's order
       ("LAST TERM", "RIGHT PART") only reads as far as the page. */
    if (plan.some((detail) => /TEMP B-TREE FOR (ORDER BY|GROUP BY|DISTINCT)/.test(detail))) return true;
    /* A filter over a scan may read the whole table to fill its page. An
       index search (an equality, or a range such as a keyset page's bound)
       starts where the rows are and reads in the list's order. */
    return /\bWHERE\b/i.test(text) && plan.some((detail) => /^SCAN (?!CONSTANT ROW|\()/.test(detail));
  } catch {
    /* A statement that cannot be planned will not prepare either; it fails
       in process with the engine's own words. */
    return false;
  }
}

/** Run one compiled read in the statement process: its rows as objects, raw, as the in-process driver reads them. */
export async function readInProcess(file: string, text: string, params: readonly SQLInputValue[]): Promise<Array<Record<string, unknown>>> {
  const signal = cancellation() ?? new AbortController().signal;
  const answer = await runInStatementProcess(
    { file, text, fallback: text, bounded: false, limit: MAX_LIMIT + 1, refuseReserved: false, params: [...params] },
    STATEMENT_TIMEOUT_MS,
    signal,
  );
  return scaleRows(
    answer.rows.map((row) => Object.fromEntries(answer.columns.map((column, at) => [column, row[at]]))),
    answer.columns,
    scalesOf(answer.types.map((type) => ({ type }))),
  );
}
