/**
 * Asking the fixture database what the page should be saying.
 *
 * The alternative is a number somebody once read off the screen and pasted
 * into an assertion — "the Related panel says 3" — which stops being a test of
 * the panel the moment the fixture gains a row, and passes for the wrong
 * reason if the panel starts counting the wrong relationship.
 *
 * So the expected value comes from the same place the page's value should have
 * come from: the database. A test that reads `2` here and finds `3` on screen
 * has found a bug in the counting, which is the only thing it was ever about.
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * Wait for the server's writes rather than failing on them.
 *
 * These reads run while the app is writing to the same file — that is the
 * point of them — and one writer at a time is SQLite's whole locking model.
 * Without this the assertion after a write occasionally came back "database
 * is locked", which is a slow machine rather than a bug and looks exactly
 * like one.
 */
function open(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** One column of one row, as whatever SQLite says it is. */
export function scalar(file: string, sql: string, ...params: unknown[]): unknown {
  const db = open(file);
  try {
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}

/** A count, as a number, because `COUNT(*)` comes back as a BigInt-ish thing. */
export function count(file: string, sql: string, ...params: unknown[]): number {
  return Number(scalar(file, sql, ...params));
}

export function rows<T = Record<string, unknown>>(file: string, sql: string, ...params: unknown[]): T[] {
  const db = open(file);
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}
