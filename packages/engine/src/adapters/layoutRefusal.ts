/**
 * What a store says when the layout it holds is not the one this build expects.
 *
 * Every store attests its layout at open, and an attestation compares a whole
 * catalog, so on its own it can only say "missing or not the layout this
 * version expects". The version row is read apart, after the comparison has
 * failed, to say which way the difference runs: a newer build wrote it
 * (upgrade to open it) or an older one did (`mistri migrate stores up`,
 * which `migrate stores status` already reports in the same words). Nothing
 * is altered either way. A store with no readable version row, or at the
 * expected version, keeps the store's own generic message.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from './postgresPool.js';

/** The message for a store found at `found` when `expected` was wanted; undefined when the version does not explain the refusal. */
export function layoutRefusal(store: string, found: unknown, expected: number): string | undefined {
  const version = typeof found === 'number' || typeof found === 'bigint' || typeof found === 'string' ? Number(found) : NaN;
  if (!Number.isInteger(version) || version === expected) return undefined;
  if (version > expected)
    return (
      `${store} is at layout version ${version}, newer than the version ${expected} this build expects. ` +
      'A newer build wrote it: upgrade to open it. It is refused, not altered.'
    );
  return (
    `${store} is at layout version ${version}, older than the version ${expected} this build expects. ` +
    'Stop the server and run `mistri migrate stores up` to bring it forward (`mistri migrate stores status` ' +
    `says whether a step exists from version ${version}). It is refused, not altered.`
  );
}

/** The one version a meta table's rows hold, or null when there is not exactly one. */
export function versionOfRows(rows: readonly { version?: unknown }[]): number | null {
  const version = rows.length === 1 ? Number(rows[0].version) : NaN;
  return Number.isInteger(version) ? version : null;
}

/** Best effort, after a refusal: the version a SQLite meta table (in `main`) holds. */
export function sqliteLayoutVersion(db: DatabaseSync, metaTable: string): number | null {
  try {
    return versionOfRows(db.prepare(`SELECT version FROM main."${metaTable}"`).all());
  } catch {
    return null;
  }
}

/** Best effort, after a refusal: the version a PostgreSQL meta table holds (`qualified` is the quoted table name). */
export async function postgresLayoutVersion(client: PgQuery, qualified: string): Promise<number | null> {
  try {
    return versionOfRows(
      (await client.query(`SELECT version FROM ${qualified}`)).rows as {
        version?: unknown;
      }[],
    );
  } catch {
    return null;
  }
}
