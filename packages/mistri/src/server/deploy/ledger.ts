/**
 * The deploy record: one row per deploy in `__mistri_deploys`, in the database the migrations run against, beside
 * the migration history table (a reserved runtime table, so an App never lists it). It is shared between operators
 * and CI, which a file on one machine would not be.
 */
import { openMigrationDb, quoteIdent, type MigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import { qualified } from '@mistriwork/engine/server/migrate/history.js';
import type { DeployLedger, DeployRow } from './types.js';

const DEPLOYS_TABLE = '__mistri_deploys';

interface Stored {
  id: string;
  started_at: string;
  finished_at: string | null;
  operator: string;
  git_sha: string | null;
  build_id: string;
  worker_version: string | null;
  migrations: string;
  contract: number | boolean;
  result: DeployRow['result'];
  rollback_of: string | null;
  note: string | null;
}

const rowOf = (stored: Stored): DeployRow => ({
  id: stored.id,
  startedAt: stored.started_at,
  finishedAt: stored.finished_at,
  operator: stored.operator,
  gitSha: stored.git_sha,
  buildId: stored.build_id,
  workerVersion: stored.worker_version,
  migrations: JSON.parse(stored.migrations) as string[],
  contract: Boolean(stored.contract),
  result: stored.result,
  rollbackOf: stored.rollback_of,
  note: stored.note,
});

/** The wording the three dialects use for a table that is not there (SQLite, PostgreSQL, MySQL). */
const MISSING_TABLE = /no such table|does not exist|doesn't exist/i;

const COLUMN: Record<string, string> = {
  finishedAt: 'finished_at',
  result: 'result',
  buildId: 'build_id',
  workerVersion: 'worker_version',
  migrations: 'migrations',
  contract: 'contract',
  note: 'note',
};

export function sqlLedger(db: MigrationDb): DeployLedger {
  const table = qualified(db, DEPLOYS_TABLE);
  return {
    async ensure() {
      await db.run(
        `CREATE TABLE IF NOT EXISTS ${table} (
    ${quoteIdent(db.dialect, 'id')} VARCHAR(64) NOT NULL PRIMARY KEY,
    "started_at" VARCHAR(40) NOT NULL,
    "finished_at" VARCHAR(40),
    "operator" VARCHAR(200) NOT NULL,
    "git_sha" VARCHAR(64),
    "build_id" VARCHAR(64) NOT NULL,
    "worker_version" VARCHAR(100),
    "migrations" TEXT NOT NULL,
    "contract" INT NOT NULL,
    "result" VARCHAR(20) NOT NULL,
    "rollback_of" VARCHAR(64),
    "note" TEXT
)`,
      );
    },
    async start(row) {
      await db.run(
        `INSERT INTO ${table} ("id", "started_at", "finished_at", "operator", "git_sha", "build_id", "worker_version", "migrations", "contract", "result", "rollback_of", "note") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.startedAt,
          row.finishedAt,
          row.operator,
          row.gitSha,
          row.buildId,
          row.workerVersion,
          JSON.stringify(row.migrations),
          row.contract ? 1 : 0,
          row.result,
          row.rollbackOf,
          row.note,
        ],
      );
    },
    async finish(id, patch) {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (!entries.length) return;
      const values = entries.map(([key, value]) =>
        key === 'migrations' ? JSON.stringify(value) : key === 'contract' ? (value ? 1 : 0) : value,
      );
      await db.run(`UPDATE ${table} SET ${entries.map(([key]) => `"${COLUMN[key]}" = ?`).join(', ')} WHERE "id" = ?`, [...values, id]);
    },
    async recent(limit) {
      /* A read never creates the table: before the first deploy there is simply nothing recorded. */
      const rows = await db
        .all<Stored>(`SELECT * FROM ${table} ORDER BY "started_at" DESC LIMIT ${Math.max(1, Math.floor(limit))}`)
        .catch((error: Error) => {
          if (MISSING_TABLE.test(error.message)) return [];
          throw error;
        });
      return rows.map(rowOf);
    },
    close: () => db.close(),
  };
}

/** The record in the database at `url`, whose history table lives in `schemas[0]` (PostgreSQL). */
export async function openLedger(url: string, schemas: readonly string[]): Promise<DeployLedger> {
  return sqlLedger(await openMigrationDb(url, schemas, true));
}
