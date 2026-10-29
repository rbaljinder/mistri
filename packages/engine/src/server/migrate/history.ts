/**
 * The history table: Flyway's layout, column for column and engine by engine,
 * so Flyway reads what tablewalk wrote and tablewalk reads what Flyway wrote.
 * Only the name is tablewalk's: `__mistri_schema_history` by default, a
 * reserved runtime table (shared/runtimeTables.ts), so an App never lists it,
 * a tenant App's database may hold it, and it is never another team's
 * `flyway_schema_history`. Naming theirs is how a team moves over from Flyway,
 * and it is said, never assumed.
 */
import { quoteIdent, type MigrationDb } from './database.js';
import { compareVersions, type MigrationFile } from './files.js';
import { product } from '../product.js';

export const DEFAULT_HISTORY_TABLE = '__mistri_schema_history';

interface HistoryRow {
  readonly installed_rank: number;
  readonly version: string | null;
  readonly description: string;
  readonly type: string;
  readonly script: string;
  readonly checksum: number | null;
  readonly installed_by: string;
  readonly installed_on: string;
  readonly execution_time: number;
  readonly success: boolean;
}

export const BASELINE_DESCRIPTION = '<< Flyway Baseline >>';

export function qualified(db: MigrationDb, table: string): string {
  return db.home === undefined ? quoteIdent(db.dialect, table) : `${quoteIdent(db.dialect, db.home)}.${quoteIdent(db.dialect, table)}`;
}

/** The DDL Flyway itself runs for this table (its createMetaDataTable.sql per engine). */
export function historyDdl(db: MigrationDb, table: string): string[] {
  const name = qualified(db, table);
  const index = quoteIdent(db.dialect, `${table}_s_idx`);
  if (db.dialect === 'sqlite') {
    return [
      `CREATE TABLE ${name} (
    "installed_rank" INT NOT NULL PRIMARY KEY,
    "version" VARCHAR(50),
    "description" VARCHAR(200) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "script" VARCHAR(1000) NOT NULL,
    "checksum" INT,
    "installed_by" VARCHAR(100) NOT NULL,
    "installed_on" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    "execution_time" INT NOT NULL,
    "success" BOOLEAN NOT NULL
)`,
      `CREATE INDEX ${index} ON ${name} ("success")`,
    ];
  }
  return [
    `CREATE TABLE ${name} (
    "installed_rank" INT NOT NULL,
    "version" VARCHAR(50),
    "description" VARCHAR(200) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "script" VARCHAR(1000) NOT NULL,
    "checksum" INTEGER,
    "installed_by" VARCHAR(100) NOT NULL,
    "installed_on" TIMESTAMP NOT NULL DEFAULT now(),
    "execution_time" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL
)`,
    `ALTER TABLE ${name} ADD CONSTRAINT ${quoteIdent('postgres', `${table}_pk`)} PRIMARY KEY ("installed_rank")`,
    `CREATE INDEX ${index} ON ${name} ("success")`,
  ];
}

export async function historyExists(db: MigrationDb, table: string): Promise<boolean> {
  const rows =
    db.dialect === 'sqlite'
      ? await db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
      : db.dialect === 'postgres'
        ? await db.all('SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = ? AND tablename = ?', [db.home, table])
        : [];
  return rows.length > 0;
}

/** Every row, in the order they were installed. A table in another layout is refused, never written. */
export async function readHistory(db: MigrationDb, table: string): Promise<HistoryRow[]> {
  if (!(await historyExists(db, table))) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    // The time as text to the second, as each engine keeps it: a Date would be read in this machine's zone.
    const on = db.dialect === 'postgres' ? "to_char(installed_on, 'YYYY-MM-DD HH24:MI:SS')" : 'substr(installed_on, 1, 19)';
    rows =
      await db.all(`SELECT installed_rank, version, description, type, script, checksum, installed_by, ${on} AS installed_on, execution_time, success
      FROM ${qualified(db, table)} ORDER BY installed_rank`);
  } catch {
    throw new Error(`${table} is not a Flyway-layout history table; name another with --history-table.`);
  }
  return rows.map((row) => ({
    installed_rank: Number(row.installed_rank),
    version: row.version === null ? null : String(row.version),
    description: String(row.description),
    type: String(row.type),
    script: String(row.script),
    checksum: row.checksum === null || row.checksum === undefined ? null : Number(row.checksum),
    installed_by: String(row.installed_by ?? ''),
    installed_on: String(row.installed_on),
    execution_time: Number(row.execution_time),
    success: row.success === true || row.success === 1 || row.success === '1' || row.success === 't',
  }));
}

export async function insertHistory(
  db: MigrationDb,
  table: string,
  row: {
    version: string | null;
    description: string;
    type: string;
    script: string;
    checksum: number | null;
    executionTime: number;
    success: boolean;
  },
): Promise<void> {
  const name = qualified(db, table);
  const [{ next }] = await db.all<{ next: number | string }>(`SELECT COALESCE(MAX(installed_rank), 0) + 1 AS next FROM ${name}`);
  await db.run(
    `INSERT INTO ${name} (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(next),
      row.version,
      row.description,
      row.type,
      row.script,
      row.checksum,
      db.user,
      row.executionTime,
      db.dialect === 'postgres' ? row.success : row.success ? 1 : 0,
    ],
  );
}

/** What the rows say, as Flyway reads them: a later DELETE row cancels the one it names. */
export interface History {
  readonly rows: readonly HistoryRow[];
  readonly baseline?: HistoryRow;
  /** Each versioned migration in force, by version. */
  readonly versioned: ReadonlyMap<string, HistoryRow>;
  /** Each repeatable's latest run in force, by description. */
  readonly repeatable: ReadonlyMap<string, HistoryRow>;
  readonly failed: readonly HistoryRow[];
  readonly lastRank: number;
}

export function readRows(rows: readonly HistoryRow[]): History {
  let baseline: HistoryRow | undefined;
  const versioned = new Map<string, HistoryRow>();
  const repeatable = new Map<string, HistoryRow>();
  const failed: HistoryRow[] = [];
  for (const row of rows) {
    if (row.type === 'BASELINE') {
      baseline = row;
      continue;
    }
    if (row.type === 'SCHEMA') continue;
    const map = row.version === null ? repeatable : versioned;
    const key = row.version ?? row.description;
    if (row.type === 'DELETE') {
      map.delete(key);
      continue;
    }
    if (!row.success) {
      failed.push(row);
      continue;
    }
    if (row.version !== null) {
      // A version applied twice is Flyway's to have refused; the first stands.
      if (!versioned.has(key)) versioned.set(key, row);
    } else repeatable.set(key, row);
  }
  return { rows, baseline, versioned, repeatable, failed, lastRank: rows.reduce((max, row) => Math.max(max, row.installed_rank), 0) };
}

export interface Plan {
  readonly history: History;
  readonly pending: readonly MigrationFile[];
  /** What stops a run: said per file, with what to do. */
  readonly problems: readonly string[];
  /** Said, never a failure: an applied version newer than every file (Flyway's "future"). */
  readonly notes: readonly string[];
}

/**
 * Files against history, with Flyway's rules: an applied file must still be
 * there with the same checksum and description; a failed row stops everything
 * until it is repaired; a new version below the newest applied one is out of
 * order and refused, since running it would apply a change out of the order
 * the others were tested in; a repeatable is pending when it is new or has
 * changed. A version at or below the baseline is the baseline's.
 */
export function plan(files: readonly MigrationFile[], history: History): Plan {
  const problems: string[] = [];
  const notes: string[] = [];
  const baseline = history.baseline?.version ?? undefined;
  const above = (version: string) => baseline === undefined || compareVersions(version, baseline) > 0;
  const seen = new Map<string, MigrationFile>();
  for (const file of files) {
    if (file.version === undefined) continue;
    const twin = [...seen.values()].find((other) => compareVersions(other.version!, file.version!) === 0);
    if (twin) problems.push(`${file.script} and ${twin.script} are both version ${file.version}: give one of them the next free version.`);
    seen.set(file.version, file);
  }
  for (const row of history.failed) {
    problems.push(
      `${row.script} failed on ${row.installed_on}. What it did before it failed may still be there: undo or finish it by hand, then \`${product()} migrate repair\` removes the failed entry.`,
    );
  }
  const byVersion = (version: string) => files.find((file) => file.version !== undefined && compareVersions(file.version, version) === 0);
  const highestFile = files.reduce<string | undefined>(
    (max, file) => (file.version !== undefined && (max === undefined || compareVersions(file.version, max) > 0) ? file.version : max),
    undefined,
  );
  let highestApplied: string | undefined;
  for (const [version, row] of history.versioned) {
    if (highestApplied === undefined || compareVersions(version, highestApplied) > 0) highestApplied = version;
    const file = byVersion(version);
    if (!file) {
      if (highestFile !== undefined && compareVersions(version, highestFile) > 0)
        notes.push(`version ${version} (${row.script}) is applied but has no file here: a newer checkout applied it.`);
      else
        problems.push(
          `${row.script} was applied on ${row.installed_on} and is not in the directory any more. Put it back, or \`${product()} migrate repair\` marks it deleted.`,
        );
      continue;
    }
    if (row.checksum !== file.checksum) {
      problems.push(
        `${file.script} changed after it was applied (checksum ${row.checksum} applied, ${file.checksum} now). Put it back as it was and write the change as a new migration, or \`${product()} migrate repair\` accepts the file as it is now.`,
      );
    } else if (row.description !== file.description) {
      problems.push(
        `${file.script} was applied as "${row.description}"; its name now says "${file.description}". Rename it back, or \`${product()} migrate repair\`.`,
      );
    }
  }
  for (const [description, row] of history.repeatable) {
    if (!files.some((file) => file.kind === 'repeatable' && file.description === description)) {
      problems.push(
        `${row.script} was applied and is not in the directory any more. Put it back, or \`${product()} migrate repair\` marks it deleted.`,
      );
    }
  }
  const pending: MigrationFile[] = [];
  for (const file of files) {
    if (file.kind === 'versioned') {
      if (history.versioned.has(file.version!) || [...history.versioned.keys()].some((v) => compareVersions(v, file.version!) === 0))
        continue;
      if (!above(file.version!)) continue;
      if (highestApplied !== undefined && compareVersions(file.version!, highestApplied) < 0) {
        problems.push(
          `${file.script} is new, but version ${highestApplied} is already applied: give it a version after ${highestApplied}.`,
        );
        continue;
      }
      pending.push(file);
    } else {
      const applied = history.repeatable.get(file.description);
      if (!applied || applied.checksum !== file.checksum) pending.push(file);
    }
  }
  return { history, pending, problems, notes };
}
