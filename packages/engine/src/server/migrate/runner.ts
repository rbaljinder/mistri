/**
 * The migration runner: status, up, validate, baseline and repair over one
 * database, with no opinion about how they are printed (migrate/cli.ts says
 * them; `@mistriwork/mistri/maintenance` hands `migrateUp` to a seed).
 *
 * Forward only. Each file runs once, in version order, in its own
 * transaction on SQLite and PostgreSQL, then its history row is written in
 * that same transaction, so a file is either applied and recorded or neither.
 * MySQL commits DDL as it goes: a file there runs outside a transaction, and
 * a failure is recorded as failed and stops the run, as Flyway does, because
 * what ran before the failing statement is in the database and only a person
 * can say whether to finish it or undo it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMigrationDb, quoteIdent, splitPostgres, type Dialect, type MigrationDb } from './database.js';
import { readMigrations, type MigrationDirectory, type MigrationFile } from './files.js';
import {
  BASELINE_DESCRIPTION,
  historyDdl,
  historyExists,
  insertHistory,
  plan,
  qualified,
  readHistory,
  readRows,
  type Plan,
} from './history.js';
import {
  carryForward,
  drift,
  readSchema,
  readSnapshot,
  sorted,
  writeSnapshot,
  type Change,
  type Objects,
  type StoredSnapshot,
} from './snapshot.js';
import { product } from '../product.js';

export interface MigrateTarget {
  /** The resolved URL or SQLite path: secrets expanded, never printed. */
  readonly url: string;
  /** The schemas the run owns: PostgreSQL's first is where the history lives. */
  readonly schemas: readonly string[];
  readonly dir: string;
  readonly table: string;
}

/** The baseline's snapshot file, beside the migrations. Never run: no V or R, and not .sql. */
const BASELINE_FILE = 'baseline.schema.json';

/** How long a run waits for another to finish before it gives up, as Flyway's default retries do. */
const LOCK_WAIT_MS = 60_000;

export interface Status {
  readonly dialect: Dialect;
  readonly home: string | undefined;
  readonly directory: MigrationDirectory;
  readonly plan: Plan;
  readonly started: boolean;
  /** Changes made outside migrations since the last run recorded the schema. */
  readonly drift?: readonly Change[];
  readonly snapshot?: StoredSnapshot;
  /** History rows written after the recorded schema: another runner's, whose changes read as drift. */
  readonly behind: number;
  /** With no history yet: the tables and views already there, which want a baseline before anything runs. */
  readonly holds: number;
}

async function withDb<T>(target: MigrateTarget, create: boolean, run: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await openMigrationDb(target.url, target.schemas, create);
  try {
    return await run(db);
  } finally {
    await db.close();
  }
}

const refuseNonTransactional = (db: MigrationDb, directory: MigrationDirectory) => {
  const file = directory.files.find((each) => !each.transactional);
  if (file && db.dialect === 'sqlite') {
    throw new Error(
      `${file.script}.conf says executeInTransaction=false, and SQLite runs every migration in a transaction: its write lock is what keeps two runs apart. Remove the .conf.`,
    );
  }
};

async function readStatus(db: MigrationDb, target: MigrateTarget): Promise<Status> {
  const directory = readMigrations(target.dir);
  const started = await historyExists(db, target.table);
  const history = readRows(await readHistory(db, target.table));
  const snapshot = started ? await readSnapshot(db, target.table) : undefined;
  const live = snapshot ? await readSchema(db, target.schemas, target.table) : undefined;
  const behind = snapshot
    ? history.rows.filter((row) => row.installed_rank > snapshot.rank && row.success && row.type !== 'DELETE').length
    : 0;
  const holds = started
    ? 0
    : Object.keys(await readSchema(db, target.schemas, target.table)).filter((key) => /^(table|view|materialized view) /.test(key)).length;
  return {
    dialect: db.dialect,
    home: db.home,
    directory,
    plan: plan(directory.files, history),
    started,
    ...(snapshot && live ? { drift: drift(snapshot.objects, live), snapshot } : {}),
    behind,
    holds,
  };
}

export function migrationStatus(target: MigrateTarget): Promise<Status> {
  return withDb(target, false, (db) => readStatus(db, target));
}

interface UpResult {
  readonly status: Status;
  readonly applied: ReadonlyArray<{ readonly file: MigrationFile; readonly ms: number }>;
  /** Set when a file failed: the run stopped there. */
  readonly failure?: { readonly file: MigrationFile; readonly message: string; readonly recorded: boolean };
  /** Set when the database was refused before anything ran. */
  readonly refused?: string;
  /** With dryRun: what would run, in order. */
  readonly wouldRun?: readonly MigrationFile[];
}

/**
 * Apply every pending migration. Under the run's lock the plan is read again
 * before each file, so a second deploy that waited finds the first's work
 * done and applies nothing twice.
 */
export function migrateUp(target: MigrateTarget, options: { dryRun?: boolean; waiting?: () => void } = {}): Promise<UpResult> {
  return withDb(target, !options.dryRun, async (db) => {
    const directory = readMigrations(target.dir);
    refuseNonTransactional(db, directory);
    await db.lock(target.table, LOCK_WAIT_MS, options.waiting ?? (() => {}));
    const initial = await readStatus(db, target);
    /* R7, and Flyway's rule: a database with tables and no history is
       recorded as it is before anything runs on it. */
    if (initial.holds) {
      return {
        status: initial,
        applied: [],
        refused: `the database already holds ${initial.holds} table${initial.holds === 1 ? '' : 's'} or view${initial.holds === 1 ? '' : 's'} and no migration history. Record it as it is first: ${product()} migrate baseline`,
      };
    }
    if (initial.plan.problems.length) return { status: initial, applied: [] };
    if (options.dryRun) return { status: initial, applied: [], wouldRun: initial.plan.pending };

    const expected = initial.snapshot?.objects;
    const before = await readSchema(db, target.schemas, target.table);
    if (!initial.started) {
      if (db.dialect === 'postgres' && target.schemas.length)
        await db.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent('postgres', db.home!)}`);
      await ensureHistory(db, target.table);
    }
    const applied: Array<{ file: MigrationFile; ms: number }> = [];
    let failure: UpResult['failure'];
    for (;;) {
      if (db.dialect === 'sqlite') await db.run('BEGIN IMMEDIATE');
      const now = plan(directory.files, readRows(await readHistory(db, target.table)));
      const next = now.pending[0];
      if (now.problems.length || !next) {
        if (db.dialect === 'sqlite') await db.run('COMMIT');
        break;
      }
      const result = await apply(db, target.table, next);
      if ('message' in result) {
        failure = { file: next, ...result };
        break;
      }
      applied.push({ file: next, ms: result.ms });
    }
    /* Recorded after a failure too: what did apply is migrations' work, and
       what had drifted before the run stays drift. */
    if (applied.length || !initial.snapshot) {
      const after = await readSchema(db, target.schemas, target.table);
      const lastRank = readRows(await readHistory(db, target.table)).lastRank;
      await writeSnapshot(
        db,
        target.table,
        lastRank,
        expected
          ? carryForward(
              expected,
              before,
              after,
              applied.map(({ file }) => file.sql),
            )
          : after,
      );
    }
    return { status: await readStatus(db, target), applied, ...(failure ? { failure } : {}) };
  });
}

/* Created under the write lock and looked for again inside it: on SQLite two
   first runs can both have seen no table before either took the lock. */
function ensureHistory(db: MigrationDb, table: string): Promise<void> {
  return transaction(db, async () => {
    if (!(await historyExists(db, table))) for (const ddl of historyDdl(db, table)) await db.run(ddl);
  });
}

async function transaction(db: MigrationDb, run: () => Promise<void>): Promise<void> {
  if (db.dialect === 'mysql') {
    await run();
    return;
  }
  await db.run(db.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    await run();
    await db.run('COMMIT');
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {});
    throw error;
  }
}

const sayError = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];

/* A transactional PostgreSQL file whose statement waited out its lock
   (database.ts MIGRATION_LOCK_TIMEOUT_MS) rolled back whole, so it is tried
   again after a pause that grows: a long transaction on the table may end.
   Five tries, about half a minute in all, and then it says so. */
const LOCK_ATTEMPTS = 5;
const lockWaited = (error: unknown) => (error as { code?: unknown })?.code === '55P03';
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One file and its history row. On SQLite the caller's BEGIN IMMEDIATE is already open. */
async function apply(
  db: MigrationDb,
  table: string,
  file: MigrationFile,
): Promise<{ ms: number } | { message: string; recorded: boolean }> {
  const started = performance.now();
  const row = (success: boolean) => ({
    version: file.version ?? null,
    description: file.description,
    type: 'SQL',
    script: file.script,
    checksum: file.checksum,
    executionTime: Math.round(performance.now() - started),
    success,
  });
  if (file.transactional && db.dialect === 'postgres') {
    for (let attempt = 1; ; attempt++) {
      const tried = await applyInTransaction(db, table, file, row);
      if (!('locked' in tried)) return tried;
      if (attempt === LOCK_ATTEMPTS) {
        return {
          message:
            `${tried.locked}. It waited for another transaction's lock ${LOCK_ATTEMPTS} times; nothing of it was applied. ` +
            'Run it again when the transaction holding the table has finished.',
          recorded: false,
        };
      }
      await pause(attempt * 1_000);
    }
  }
  if (file.transactional && db.dialect !== 'mysql') {
    try {
      await db.script(file.sql);
      if (db.dialect === 'sqlite') {
        /* Foreign keys are off while a migration runs, so a table can be
           rebuilt the way SQLite's manual says; they are checked here, before
           the commit, so none is left pointing nowhere. */
        const broken = await db.all<{ table: string; parent: string }>('PRAGMA foreign_key_check');
        if (broken.length) {
          const first = broken[0];
          throw new Error(
            `it leaves ${broken.length} row${broken.length === 1 ? '' : 's'} of ${first.table} pointing at no row of ${first.parent}`,
          );
        }
      }
      await insertHistory(db, table, row(true));
      await db.run('COMMIT');
      return { ms: row(true).executionTime };
    } catch (error) {
      await db.run('ROLLBACK').catch(() => {});
      return { message: `${sayError(error)}. Nothing of it was applied.`, recorded: false };
    }
  }
  try {
    if (db.dialect === 'postgres') for (const statement of splitPostgres(file.sql)) await db.script(statement);
    else await db.script(file.sql);
    await insertHistory(db, table, row(true));
    return { ms: row(true).executionTime };
  } catch (error) {
    await insertHistory(db, table, row(false)).catch(() => {});
    const why = db.dialect === 'mysql' ? 'MySQL commits DDL as it runs' : 'it ran outside a transaction';
    return {
      message: `${sayError(error)}. ${why}, so the statements before the failing one are applied: finish or undo them by hand, then ${product()} migrate repair.`,
      recorded: true,
    };
  }
}

/** One PostgreSQL file in its own transaction: applied, refused, or rolled back after a lock wait ran out. */
async function applyInTransaction(
  db: MigrationDb,
  table: string,
  file: MigrationFile,
  row: (success: boolean) => Parameters<typeof insertHistory>[2],
): Promise<{ ms: number } | { message: string; recorded: boolean } | { locked: string }> {
  await db.run('BEGIN');
  try {
    await db.script(file.sql);
    await insertHistory(db, table, row(true));
    await db.run('COMMIT');
    return { ms: row(true).executionTime };
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {});
    if (lockWaited(error)) return { locked: sayError(error) };
    return { message: `${sayError(error)}. Nothing of it was applied.`, recorded: false };
  }
}

export interface Validation {
  readonly status: Status;
  readonly valid: boolean;
}

/**
 * Flyway's validate — every applied file unchanged and present, nothing
 * pending, nothing failed — and one thing Flyway cannot see: the database
 * is still what its migrations made it.
 */
export async function migrateValidate(target: MigrateTarget): Promise<Validation> {
  const status = await migrationStatus(target);
  const valid = status.started && !status.plan.problems.length && !status.plan.pending.length && !status.drift?.length;
  return { status, valid };
}

interface BaselineResult {
  readonly already?: string;
  readonly refused?: string;
  readonly objects: Objects;
  /** The snapshot file, and whether this run wrote it. */
  readonly file: string;
  readonly wrote: boolean;
}

/**
 * Record the database as it is as version 0: nothing that exists is touched,
 * and history starts here. The schema as read is written beside the
 * migrations, read-only, and kept as the one migrations start from.
 */
export function migrateBaseline(target: MigrateTarget, options: { dryRun?: boolean } = {}): Promise<BaselineResult> {
  return withDb(target, false, async (db) => {
    await db.lock(target.table, LOCK_WAIT_MS, () => {});
    const history = readRows(await readHistory(db, target.table));
    const file = join(target.dir, BASELINE_FILE);
    const objects = await readSchema(db, target.schemas, target.table);
    if (history.baseline)
      return {
        already: `baselined as version ${history.baseline.version} on ${history.baseline.installed_on}`,
        objects,
        file,
        wrote: false,
      };
    const applied = history.rows.filter((row) => row.type !== 'DELETE').length;
    if (applied)
      return {
        refused: `${target.table} already records ${applied} migration${applied === 1 ? '' : 's'}; a baseline starts a history, it does not join one`,
        objects,
        file,
        wrote: false,
      };
    if (options.dryRun) return { objects, file, wrote: false };
    await ensureHistory(db, target.table);
    await transaction(db, async () => {
      await insertHistory(db, target.table, {
        version: '0',
        description: BASELINE_DESCRIPTION,
        type: 'BASELINE',
        script: BASELINE_DESCRIPTION,
        checksum: null,
        executionTime: 0,
        success: true,
      });
      await writeSnapshot(db, target.table, readRows(await readHistory(db, target.table)).lastRank, objects);
    });
    let wrote = false;
    if (!existsSync(file)) {
      mkdirSync(target.dir, { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            about:
              'The schema as it was when ' +
              product() +
              ' migrate baseline recorded it as version 0: a record, never run. Migrations after it start from here.',
            dialect: db.dialect,
            schemas: target.schemas.length ? target.schemas : db.home ? [db.home] : [],
            taken: new Date().toISOString().slice(0, 19).replace('T', ' '),
            objects: sorted(objects),
          },
          null,
          2,
        )}\n`,
        { mode: 0o444, flag: 'wx' },
      );
      wrote = true;
    }
    return { objects, file, wrote };
  });
}

interface RepairResult {
  readonly actions: readonly string[];
}

/**
 * Make the history agree with the files again, as Flyway's repair does:
 * failed entries removed, an applied file's checksum and description taken
 * from the file as it is now, a file that is gone marked deleted. And the
 * recorded schema retaken when another runner applied migrations after it,
 * since their changes cannot be told from drift; drift itself is never
 * repaired away.
 */
export function migrateRepair(target: MigrateTarget, options: { dryRun?: boolean } = {}): Promise<RepairResult> {
  return withDb(target, false, async (db) => {
    await db.lock(target.table, LOCK_WAIT_MS, () => {});
    const status = await readStatus(db, target);
    const { history } = status.plan;
    const name = qualified(db, target.table);
    const actions: string[] = [];
    const work: Array<() => Promise<void>> = [];
    const flag = (value: boolean) => (db.dialect === 'postgres' ? value : value ? 1 : 0);
    if (history.failed.length) {
      actions.push(...history.failed.map((row) => `removed the failed entry for ${row.script}`));
      work.push(() => db.run(`DELETE FROM ${name} WHERE success = ?`, [flag(false)]));
    }
    const files = status.directory.files;
    for (const [version, row] of history.versioned) {
      const file = files.find((each) => each.version === version);
      if (file) {
        if (file.checksum !== row.checksum || file.description !== row.description) {
          actions.push(`${file.script}: history now says checksum ${file.checksum}, "${file.description}"`);
          work.push(() =>
            db.run(`UPDATE ${name} SET checksum = ?, description = ? WHERE installed_rank = ?`, [
              file.checksum,
              file.description,
              row.installed_rank,
            ]),
          );
        }
      } else if (!status.plan.notes.some((note) => note.startsWith(`version ${version} `))) {
        actions.push(`marked ${row.script} deleted`);
        work.push(() =>
          insertHistory(db, target.table, {
            version: row.version,
            description: row.description,
            type: 'DELETE',
            script: row.script,
            checksum: row.checksum,
            executionTime: 0,
            success: true,
          }),
        );
      }
    }
    for (const [description, row] of history.repeatable) {
      if (files.some((file) => file.kind === 'repeatable' && file.description === description)) continue;
      actions.push(`marked ${row.script} deleted`);
      work.push(() =>
        insertHistory(db, target.table, {
          version: null,
          description,
          type: 'DELETE',
          script: row.script,
          checksum: row.checksum,
          executionTime: 0,
          success: true,
        }),
      );
    }
    if (status.started && (!status.snapshot || status.behind)) {
      actions.push(
        status.snapshot
          ? `recorded the schema again: ${status.behind} migration${status.behind === 1 ? ' was' : 's were'} applied after it by another runner, so what they changed is now what migrations made`
          : 'recorded the schema as it is now: drift is measured from here',
      );
      work.push(async () =>
        writeSnapshot(
          db,
          target.table,
          readRows(await readHistory(db, target.table)).lastRank,
          await readSchema(db, target.schemas, target.table),
        ),
      );
    }
    if (!options.dryRun && work.length)
      await transaction(db, async () => {
        for (const step of work) await step();
      });
    return { actions };
  });
}

/**
 * Around a run another tool makes (`--tool flyway`): the schema read before
 * it, and recorded after it as tablewalk's own runs record it, so drift stays
 * measured whichever tool applied the files.
 */
export async function recordAround(target: MigrateTarget, run: () => Promise<number>): Promise<number> {
  const before = await withDb(target, false, async (db) => ({
    expected: (await readSnapshot(db, target.table))?.objects,
    objects: await readSchema(db, target.schemas, target.table),
    rank: readRows(await readHistory(db, target.table)).lastRank,
  })).catch(() => undefined);
  const code = await run();
  await withDb(target, false, async (db) => {
    if (!(await historyExists(db, target.table))) return;
    const lastRank = readRows(await readHistory(db, target.table)).lastRank;
    if (before && lastRank === before.rank && before.expected) return;
    const after = await readSchema(db, target.schemas, target.table);
    // What the other tool applied, read back from the files its history rows name.
    const { files } = readMigrations(target.dir);
    const scripts = new Set(
      readRows(await readHistory(db, target.table))
        .rows.filter((row) => row.installed_rank > (before?.rank ?? 0))
        .map((row) => row.script),
    );
    const applied = files.filter((file) => scripts.has(file.script)).map((file) => file.sql);
    await writeSnapshot(
      db,
      target.table,
      lastRank,
      before?.expected ? carryForward(before.expected, before.objects, after, applied) : after,
    );
  }).catch(() => {});
  return code;
}
