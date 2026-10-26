import { lstatSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { registerPrune } from '../retention/pruner.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  captureJobPolicy,
  jobFail,
  JobStoreUnavailable,
  JOB_ATTEMPT_OUTCOMES,
  JOB_CODES,
  JOB_HISTORY_LIMIT,
  JOB_REDRIVE_LIMIT,
  JOB_STATES,
  type JobPolicy,
  type JobPolicyInput,
} from './jobStoreTypes.js';

/* The reserved runtime prefix, as every runtime namespace uses: the App
   catalog and the command facade hide whatever sits under it
   (shared/runtimeTables.ts), so a job store provisioned into a business
   database never surfaces as a table an App could browse or write. */
export const JOB_PREFIX = '__mistri_job_';
const prefix = JOB_PREFIX;
export const JOB_TABLES = Object.freeze({ policy: `${prefix}policy`, job: `${prefix}job`, attempt: `${prefix}attempt` });
const t = JOB_TABLES;

/* The tries of a job that finished (succeeded or cancelled) go with the job's
   window, together: verifyJobRow wants a job's history whole or, for a finished
   job, absent. A job that failed, is unknown, retrying or in flight keeps every
   try, since an operator may still redrive or inspect it. */
registerPrune({
  id: 'job-attempts',
  window: 'attempts',
  table: t.attempt,
  time: 'finished_at',
  group: ['job_id'],
  clock: 'epoch-ms',
  where: (table) => `outcome <> 'leased' AND job_id IN (SELECT id FROM ${table(t.job)} WHERE state IN ('succeeded','cancelled'))`,
});
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');
const string = (name: string, max: number) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name})='text' AND instr(${name},char(0))=0 AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max})`;
const integer = (name: string, max = Number.MAX_SAFE_INTEGER) =>
  `${name} INTEGER NOT NULL CHECK (typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${max})`;
const definitions = new Map([
  [
    t.policy,
    `CREATE TABLE "${t.policy}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  version INTEGER NOT NULL CHECK (version=1),
  ${string('policy_json', 4096)},
  ${integer('last_clock')},
  ${integer('next_seq')}
)`,
  ],
  [
    t.job,
    `CREATE TABLE "${t.job}" (
  ${string('id', 36)} PRIMARY KEY,
  ${integer('seq')} UNIQUE,
  ${string('job', 128)},
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  ${string('idempotency_key', 128)},
  ${string('fingerprint', 64)},
  ${string('input_json', 65536)},
  ${string('provenance_json', 1024)},
  state TEXT NOT NULL CHECK (state IN (${list(JOB_STATES)})),
  ${integer('attempts', JOB_HISTORY_LIMIT)},
  max_attempts INTEGER NOT NULL CHECK (typeof(max_attempts)='integer' AND max_attempts BETWEEN 1 AND 32),
  ${integer('redrives', JOB_REDRIVE_LIMIT)},
  attempt_limit INTEGER NOT NULL CHECK (typeof(attempt_limit)='integer' AND attempt_limit BETWEEN 1 AND ${JOB_HISTORY_LIMIT}),
  ${integer('run_at')},
  ${integer('created_at')},
  ${integer('updated_at')},
  fence TEXT,
  lease_until INTEGER,
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
  last_code TEXT CHECK (last_code IN (${list(JOB_CODES)})),
  result_json TEXT CHECK (result_json IS NULL OR (typeof(result_json)='text' AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 65536)),
  UNIQUE (job,idempotency_key),
  CHECK (attempts<=attempt_limit),
  CHECK ((state IN ('leased','unknown') AND typeof(fence)='text' AND length(fence)=36 AND typeof(lease_until)='integer' AND lease_until>=0 AND attempts>0)
    OR (state NOT IN ('leased','unknown') AND fence IS NULL AND lease_until IS NULL)),
  CHECK ((state='scheduled' AND attempts=0 AND last_code IS NULL) OR state<>'scheduled'),
  CHECK (result_json IS NULL OR state='succeeded')
)`,
  ],
  [
    t.attempt,
    `CREATE TABLE "${t.attempt}" (
  ${string('job_id', 36)} REFERENCES "${t.job}" (id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (typeof(attempt)='integer' AND attempt BETWEEN 1 AND ${JOB_HISTORY_LIMIT}),
  fence TEXT UNIQUE CHECK (fence IS NULL OR (typeof(fence)='text' AND length(fence)=36)),
  ${integer('started_at')},
  deadline INTEGER CHECK (deadline IS NULL OR typeof(deadline)='integer'),
  outcome TEXT NOT NULL CHECK (outcome IN (${list(JOB_ATTEMPT_OUTCOMES)})),
  code TEXT CHECK (code IN (${list(JOB_CODES)})),
  finished_at INTEGER,
  operator TEXT CHECK (operator IS NULL OR (typeof(operator)='text' AND instr(operator,char(0))=0 AND length(CAST(operator AS BLOB)) BETWEEN 1 AND 128)),
  PRIMARY KEY (job_id,attempt),
  CHECK ((outcome='redriven' AND fence IS NULL AND deadline IS NULL AND code IS 'redriven' AND typeof(finished_at)='integer'
      AND finished_at=started_at AND operator IS NOT NULL)
    OR (outcome<>'redriven' AND fence IS NOT NULL AND typeof(deadline)='integer' AND deadline>started_at AND operator IS NULL
      AND ((outcome='leased' AND code IS NULL AND finished_at IS NULL)
        OR (outcome<>'leased' AND code IS NOT NULL AND code<>'redriven' AND typeof(finished_at)='integer' AND finished_at>=started_at))))
)`,
  ],
  [`${prefix}due`, `CREATE INDEX "${prefix}due" ON "${t.job}" (state,run_at,seq)`],
]);
type Catalog = { type: string; name: string; tbl_name: string; sql: string | null };
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): Catalog[] {
  return db
    .prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema
    WHERE substr(name,1,?)=? COLLATE NOCASE OR substr(tbl_name,1,?)=? COLLATE NOCASE`)
    .all(prefix.length, prefix, prefix.length, prefix) as unknown as Catalog[];
}
/** The reserved namespace must be exactly the known objects, and the captured
 * policy must be the one the file was provisioned with. Nothing else in the
 * file is read: business tables are not this store's concern. */
const SQLITE_JOB_STORE_VERSION = 1;
export function assertSqliteJobStore(db: DatabaseSync, policy: JobPolicy): void {
  try {
    if (db.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 1)
      return jobFail(undefined, 'The job store was opened with foreign keys off; it is only ever read with them on.');
    const entries = catalog(db, 'main');
    if (
      catalog(db, 'temp').length ||
      entries.filter((entry) => entry.sql !== null).length !== definitions.size ||
      entries.some((entry) =>
        entry.sql === null ? entry.type !== 'index' || !definitions.has(entry.tbl_name) : definitions.get(entry.name) !== entry.sql,
      )
    )
      return jobFail(layoutRefusal('The job store', sqliteLayoutVersion(db, t.policy), SQLITE_JOB_STORE_VERSION));
    const meta = db
      .prepare(`SELECT singleton,version,policy_json,last_clock,next_seq FROM main."${t.policy}"
      WHERE typeof(policy_json)='text' AND instr(policy_json,char(0))=0 AND length(CAST(policy_json AS BLOB))<=4096`)
      .all();
    if (
      meta.length !== 1 ||
      meta[0].singleton !== 1 ||
      meta[0].version !== SQLITE_JOB_STORE_VERSION ||
      meta[0].policy_json !== canonicalCommandJson(policy) ||
      typeof meta[0].last_clock !== 'number' ||
      !Number.isSafeInteger(meta[0].last_clock) ||
      meta[0].last_clock < 0 ||
      typeof meta[0].next_seq !== 'number' ||
      !Number.isSafeInteger(meta[0].next_seq) ||
      meta[0].next_seq < 0
    )
      return jobFail(layoutRefusal('The job store', meta.length === 1 ? meta[0].version : undefined, SQLITE_JOB_STORE_VERSION));
  } catch (error) {
    if (error instanceof JobStoreUnavailable) throw error;
    return jobFail(undefined, error);
  }
}

/** Pins the existing physical file for this private lifetime. Refuses symlinks,
 * replacement and unlink; never falls back to a new/in-memory database. */
export function openJobStoreFile(existingPath: string): { db: DatabaseSync; verifyFile(): void } {
  let db: DatabaseSync | undefined;
  try {
    if (typeof existingPath !== 'string') return jobFail();
    /* Said by what is wrong with the path: a wrong path, a directory, a link, read as "could not be verified" alone,
       sent an App's author to the store's layout instead of to the path (field report TR8). */
    let found: ReturnType<typeof lstatSync>;
    try {
      found = lstatSync(existingPath);
    } catch (error) {
      return jobFail(
        undefined,
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `The job store's database "${existingPath}" does not exist: check the connection's path, or provision the store there (mistri migrate stores up --jobs <file>).`
          : error,
      );
    }
    if (!found.isFile())
      return jobFail(
        undefined,
        `The job store's database "${existingPath}" is ${found.isSymbolicLink() ? 'a symbolic link' : 'not a file'}: name the database file itself.`,
      );
    const path = realpathSync(existingPath),
      before = statSync(path);
    const verifyFile = () => {
      try {
        const after = lstatSync(existingPath);
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || realpathSync(existingPath) !== path) jobFail();
      } catch {
        jobFail();
      }
    };
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    verifyFile();
    db.exec('PRAGMA busy_timeout=50');
    return { db, verifyFile };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* Discard failed acquisition. */
    }
    if (error instanceof JobStoreUnavailable) throw error;
    return jobFail(undefined, error);
  }
}

/** Explicit provisioning of an existing file, idempotent for the same policy.
 * A different namespace or bound for the same file is refused: there is no
 * repair, no migration and no startup hook. */
export function provisionSqliteJobStore(existingPath: string, input: JobPolicyInput): { version: 1; provisioned: boolean } {
  const policy = captureJobPolicy(input);
  const file = openJobStoreFile(existingPath),
    db = file.db;
  try {
    db.exec('BEGIN IMMEDIATE');
    const provisioned = !catalog(db, 'main').length && !catalog(db, 'temp').length;
    if (provisioned) {
      for (const ddl of definitions.values())
        db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.'));
      db.prepare(`INSERT INTO main."${t.policy}" VALUES (1,1,?,0,0)`).run(canonicalCommandJson(policy));
    }
    assertSqliteJobStore(db, policy);
    file.verifyFile();
    db.exec('COMMIT');
    return { version: 1, provisioned };
  } catch {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* Never reuse the handle. */
    }
    return jobFail();
  } finally {
    db.close();
  }
}
