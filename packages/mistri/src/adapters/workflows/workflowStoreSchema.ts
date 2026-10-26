// The workflow store's layout on SQLite and PostgreSQL: its tables, its migration, and the checks that refuse a foreign file.
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describePostgresRelations, withPostgresMaintenanceTransaction } from '../commands/postgresCommandJournal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { layoutRefusal, postgresLayoutVersion, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  STEP_KINDS,
  STEP_STATUSES,
  WORKFLOW_STATES,
  workflowFail,
  WorkflowStoreUnavailable,
  WORKFLOW_JSON_MAX,
} from './workflowStoreTypes.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/* The reserved runtime prefix, as every runtime namespace uses: the App
   catalog and the command facade hide whatever sits under it
   (shared/runtimeTables.ts). The workflow store is its own namespace beside
   the job store's, in the same database, so the job store's exact-catalog
   attestation never sees it. */
export const WORKFLOW_PREFIX = '__mistri_workflow_';
/* Version 2: an operator's Cancel and Retry are kept, with who and when
   (the `action` table), and on PostgreSQL the store is one per App: a meta row
   per namespace (the App's job namespace, jobLoader.ts), and every instance
   and signal names its own, so several Apps sharing one database never list,
   cancel, retry or wake each other's instances. SQLite keeps one App per file. */
export const WORKFLOW_STORE_VERSION = 1;
export const WORKFLOW_TABLES = Object.freeze({
  meta: `${WORKFLOW_PREFIX}meta`,
  instance: `${WORKFLOW_PREFIX}instance`,
  step: `${WORKFLOW_PREFIX}step`,
  signal: `${WORKFLOW_PREFIX}signal`,
  action: `${WORKFLOW_PREFIX}action`,
});
/** What an operator did to an instance, kept in its history. */
const WORKFLOW_ACTIONS = Object.freeze(['cancel', 'retry'] as const);
const t = WORKFLOW_TABLES;
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

/* ---------- SQLite ---------- */

const text = (name: string, max: number) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name})='text' AND instr(${name},char(0))=0 AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max})`;
const maybeText = (name: string, max: number) =>
  `${name} TEXT COLLATE BINARY CHECK (${name} IS NULL OR (typeof(${name})='text' AND instr(${name},char(0))=0 AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}))`;
const integer = (name: string) => `${name} INTEGER NOT NULL CHECK (typeof(${name})='integer' AND ${name}>=0)`;
const maybeInteger = (name: string) => `${name} INTEGER CHECK (${name} IS NULL OR (typeof(${name})='integer' AND ${name}>=0))`;

const SQLITE_META_DDL = `CREATE TABLE "${t.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  version INTEGER NOT NULL CHECK (version=${WORKFLOW_STORE_VERSION})
)`;
const SQLITE_ACTION_DDL = `CREATE TABLE "${t.action}" (
  seq INTEGER PRIMARY KEY,
  ${text('instance_id', 36)} REFERENCES "${t.instance}" (id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (${list(WORKFLOW_ACTIONS)})),
  ${text('operator', 128)},
  ${integer('at')}
)`;
const SQLITE_ACTION_INDEX = `CREATE INDEX "${WORKFLOW_PREFIX}action_instance" ON "${t.action}" (instance_id,seq)`;
const inMain = (ddl: string) =>
  ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace(/CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX main.');

const definitions = new Map([
  [t.meta, SQLITE_META_DDL],
  [
    t.instance,
    `CREATE TABLE "${t.instance}" (
  ${text('id', 36)} PRIMARY KEY,
  ${text('workflow', 128)},
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  ${text('key', 512)},
  state TEXT NOT NULL CHECK (state IN (${list(WORKFLOW_STATES)})),
  ${integer('epoch')},
  ${text('start_event_id', 128)},
  ${text('start_json', WORKFLOW_JSON_MAX)},
  ${integer('signal_floor')},
  ${maybeText('wait_event', 256)},
  ${maybeInteger('wake_at')},
  ${maybeText('current_step', 256)},
  ${maybeText('problem', 128)},
  ${maybeText('problem_step', 256)},
  ${maybeText('problem_json', 4096)},
  ${maybeText('result_json', WORKFLOW_JSON_MAX)},
  ${integer('created_at')},
  ${integer('updated_at')},
  UNIQUE (workflow,start_event_id)
)`,
  ],
  [
    t.step,
    `CREATE TABLE "${t.step}" (
  ${text('instance_id', 36)} REFERENCES "${t.instance}" (id) ON DELETE CASCADE,
  ${text('name', 256)},
  ${integer('ordinal')},
  kind TEXT NOT NULL CHECK (kind IN (${list(STEP_KINDS)})),
  ${text('hash', 64)},
  status TEXT NOT NULL CHECK (status IN (${list(STEP_STATUSES)})),
  ${integer('attempts')},
  ${maybeInteger('wake_at')},
  ${maybeText('result_json', WORKFLOW_JSON_MAX)},
  ${maybeText('event_id', 128)},
  ${maybeText('error_code', 128)},
  ${integer('created_at')},
  ${integer('updated_at')},
  PRIMARY KEY (instance_id,name)
)`,
  ],
  [
    t.signal,
    `CREATE TABLE "${t.signal}" (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ${text('workflow', 128)},
  ${text('event_id', 128)},
  ${text('name', 128)},
  version INTEGER NOT NULL CHECK (typeof(version)='integer' AND version>=1),
  ${text('payload_json', WORKFLOW_JSON_MAX)},
  ${integer('recorded_at')},
  UNIQUE (workflow,event_id)
)`,
  ],
  [t.action, SQLITE_ACTION_DDL],
  [
    `${WORKFLOW_PREFIX}live`,
    `CREATE UNIQUE INDEX "${WORKFLOW_PREFIX}live" ON "${t.instance}" (workflow,key) WHERE state IN ('running','waiting')`,
  ],
  [`${WORKFLOW_PREFIX}waiting`, `CREATE INDEX "${WORKFLOW_PREFIX}waiting" ON "${t.instance}" (workflow,wait_event) WHERE state='waiting'`],
  [`${WORKFLOW_PREFIX}signal_event`, `CREATE INDEX "${WORKFLOW_PREFIX}signal_event" ON "${t.signal}" (workflow,name,version,seq)`],
  [`${WORKFLOW_PREFIX}action_instance`, SQLITE_ACTION_INDEX],
]);

type Catalog = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): Catalog[] {
  return db
    .prepare(
      `SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema
    WHERE substr(name,1,?)=? COLLATE NOCASE OR substr(tbl_name,1,?)=? COLLATE NOCASE`,
    )
    .all(WORKFLOW_PREFIX.length, WORKFLOW_PREFIX, WORKFLOW_PREFIX.length, WORKFLOW_PREFIX) as unknown as Catalog[];
}

/** The reserved namespace must be exactly the known objects, at the version this build holds. */
export function assertSqliteWorkflowStore(db: DatabaseSync): void {
  try {
    if (db.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 1) return workflowFail();
    // AUTOINCREMENT keeps its counter in sqlite_sequence, which is SQLite's and is not under our prefix.
    const entries = catalog(db, 'main');
    if (
      catalog(db, 'temp').length ||
      entries.filter((entry) => entry.sql !== null && entry.type !== 'index').length !== 5 ||
      entries.some((entry) => (entry.sql === null ? false : definitions.get(entry.name) !== entry.sql)) ||
      entries.filter((entry) => entry.type === 'index' && entry.sql !== null).length !== 4
    )
      return workflowFail(layoutRefusal('The workflow store', sqliteLayoutVersion(db, t.meta), WORKFLOW_STORE_VERSION));
    const meta = db.prepare(`SELECT singleton,version FROM main."${t.meta}"`).all();
    if (meta.length !== 1 || meta[0].singleton !== 1 || meta[0].version !== WORKFLOW_STORE_VERSION)
      return workflowFail(layoutRefusal('The workflow store', meta.length === 1 ? meta[0].version : undefined, WORKFLOW_STORE_VERSION));
  } catch (error) {
    if (error instanceof WorkflowStoreUnavailable) throw error;
    return workflowFail();
  }
}

/** Opens an existing file, refusing a link or anything but a file; never creates a database. */
export function openWorkflowStoreFile(existingPath: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    if (typeof existingPath !== 'string' || !lstatSync(existingPath).isFile()) return workflowFail();
    db = new DatabaseSync(realpathSync(existingPath), {
      enableForeignKeyConstraints: true,
    });
    db.exec('PRAGMA busy_timeout=5000');
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      /* Discard failed acquisition. */
    }
    return workflowFail();
  }
}

/** Explicit provisioning of an existing file, idempotent. A foreign or older layout is refused unchanged. */
export function provisionSqliteWorkflowStore(existingPath: string): {
  version: 1;
  provisioned: boolean;
} {
  const db = openWorkflowStoreFile(existingPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const provisioned = !catalog(db, 'main').length && !catalog(db, 'temp').length;
    if (provisioned) {
      for (const ddl of definitions.values()) db.exec(inMain(ddl));
      db.prepare(`INSERT INTO main."${t.meta}" VALUES (1,?)`).run(WORKFLOW_STORE_VERSION);
    }
    assertSqliteWorkflowStore(db);
    db.exec('COMMIT');
    return { version: 1, provisioned };
  } catch {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* Never reuse the handle. */
    }
    return workflowFail();
  } finally {
    db.close();
  }
}

/* ---------- PostgreSQL ---------- */

const q = (name: string) => runtimeTable('postgres', name);
const NAMESPACE = /^[A-Za-z0-9_-]{1,128}$/;
/** The App's job namespace (jobLoader.ts), which the workflow store shares. */
export const captureWorkflowNamespace = (namespace: unknown): string =>
  typeof namespace === 'string' && NAMESPACE.test(namespace) ? namespace : workflowFail();
const namespaceColumn = `namespace text COLLATE "C" NOT NULL REFERENCES ${q(t.meta)} (namespace) ON DELETE RESTRICT`;
const PG_META_DDL = `CREATE TABLE ${q(t.meta)} (
  namespace text COLLATE "C" PRIMARY KEY CHECK (octet_length(namespace) BETWEEN 1 AND 128),
  version integer NOT NULL CHECK (version = ${WORKFLOW_STORE_VERSION})
)`;
const PG_ACTION_DDL = `CREATE TABLE ${q(t.action)} (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instance_id text COLLATE "C" NOT NULL REFERENCES ${q(t.instance)} (id) ON DELETE CASCADE,
  action text COLLATE "C" NOT NULL CHECK (action IN (${list(WORKFLOW_ACTIONS)})),
  operator text COLLATE "C" NOT NULL CHECK (octet_length(operator) BETWEEN 1 AND 128),
  at bigint NOT NULL CHECK (at >= 0)
)`;
const PG_INDEXES = [
  `CREATE UNIQUE INDEX "${WORKFLOW_PREFIX}live" ON ${q(t.instance)} (namespace, workflow, key) WHERE state IN ('running', 'waiting')`,
  `CREATE INDEX "${WORKFLOW_PREFIX}waiting" ON ${q(t.instance)} (namespace, workflow, wait_event) WHERE state = 'waiting'`,
  `CREATE INDEX "${WORKFLOW_PREFIX}signal_event" ON ${q(t.signal)} (namespace, workflow, name, version, seq)`,
  `CREATE INDEX "${WORKFLOW_PREFIX}action_instance" ON ${q(t.action)} (instance_id, seq)`,
];
const START_UNIQUE = `CONSTRAINT "${WORKFLOW_PREFIX}instance_start" UNIQUE (namespace, workflow, start_event_id)`;
const SIGNAL_UNIQUE = `CONSTRAINT "${WORKFLOW_PREFIX}signal_event_id" UNIQUE (namespace, workflow, event_id)`;
const POSTGRES_DEFINITIONS: readonly string[] = [
  PG_META_DDL,
  `CREATE TABLE ${q(t.instance)} (
  id text COLLATE "C" PRIMARY KEY CHECK (octet_length(id) = 36),
  workflow text COLLATE "C" NOT NULL CHECK (octet_length(workflow) BETWEEN 1 AND 128),
  version bigint NOT NULL CHECK (version >= 1),
  key text COLLATE "C" NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 512),
  state text COLLATE "C" NOT NULL CHECK (state IN (${list(WORKFLOW_STATES)})),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  start_event_id text COLLATE "C" NOT NULL CHECK (octet_length(start_event_id) BETWEEN 1 AND 128),
  start_json text COLLATE "C" NOT NULL CHECK (octet_length(start_json) BETWEEN 1 AND ${WORKFLOW_JSON_MAX}),
  signal_floor bigint NOT NULL CHECK (signal_floor >= 0),
  wait_event text COLLATE "C" CHECK (octet_length(wait_event) BETWEEN 1 AND 256),
  wake_at bigint CHECK (wake_at >= 0),
  current_step text COLLATE "C" CHECK (octet_length(current_step) BETWEEN 1 AND 256),
  problem text COLLATE "C" CHECK (octet_length(problem) BETWEEN 1 AND 128),
  problem_step text COLLATE "C" CHECK (octet_length(problem_step) BETWEEN 1 AND 256),
  problem_json text COLLATE "C" CHECK (octet_length(problem_json) BETWEEN 1 AND 4096),
  result_json text COLLATE "C" CHECK (octet_length(result_json) BETWEEN 1 AND ${WORKFLOW_JSON_MAX}),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= 0),
  ${namespaceColumn},
  ${START_UNIQUE}
)`,
  `CREATE TABLE ${q(t.step)} (
  instance_id text COLLATE "C" NOT NULL REFERENCES ${q(t.instance)} (id) ON DELETE CASCADE,
  name text COLLATE "C" NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 256),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text COLLATE "C" NOT NULL CHECK (kind IN (${list(STEP_KINDS)})),
  hash text COLLATE "C" NOT NULL CHECK (octet_length(hash) BETWEEN 1 AND 64),
  status text COLLATE "C" NOT NULL CHECK (status IN (${list(STEP_STATUSES)})),
  attempts integer NOT NULL CHECK (attempts >= 0),
  wake_at bigint CHECK (wake_at >= 0),
  result_json text COLLATE "C" CHECK (octet_length(result_json) BETWEEN 1 AND ${WORKFLOW_JSON_MAX}),
  event_id text COLLATE "C" CHECK (octet_length(event_id) BETWEEN 1 AND 128),
  error_code text COLLATE "C" CHECK (octet_length(error_code) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (instance_id, name)
)`,
  `CREATE TABLE ${q(t.signal)} (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow text COLLATE "C" NOT NULL CHECK (octet_length(workflow) BETWEEN 1 AND 128),
  event_id text COLLATE "C" NOT NULL CHECK (octet_length(event_id) BETWEEN 1 AND 128),
  name text COLLATE "C" NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 128),
  version bigint NOT NULL CHECK (version >= 1),
  payload_json text COLLATE "C" NOT NULL CHECK (octet_length(payload_json) BETWEEN 1 AND ${WORKFLOW_JSON_MAX}),
  recorded_at bigint NOT NULL CHECK (recorded_at >= 0),
  ${namespaceColumn},
  ${SIGNAL_UNIQUE}
)`,
  PG_ACTION_DDL,
  ...PG_INDEXES,
];

/* The columns each table holds, by name, type and nullability; the checks and
   indexes are provisioned with them. Deparsed constraint text differs
   between PostgreSQL releases, so the layout is attested by what a reader
   and a writer depend on, not by the text of a CHECK. */
// The tables as PostgreSQL names them in the runtime schema.
const pg = postgresRuntimeNames(t);
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  [pg.meta]: ['namespace text not null', 'version integer not null'],
  [pg.instance]: [
    'id text not null',
    'workflow text not null',
    'version bigint not null',
    'key text not null',
    'state text not null',
    'epoch bigint not null',
    'start_event_id text not null',
    'start_json text not null',
    'signal_floor bigint not null',
    'wait_event text',
    'wake_at bigint',
    'current_step text',
    'problem text',
    'problem_step text',
    'problem_json text',
    'result_json text',
    'created_at bigint not null',
    'updated_at bigint not null',
    'namespace text not null',
  ],
  [pg.step]: [
    'instance_id text not null',
    'name text not null',
    'ordinal integer not null',
    'kind text not null',
    'hash text not null',
    'status text not null',
    'attempts integer not null',
    'wake_at bigint',
    'result_json text',
    'event_id text',
    'error_code text',
    'created_at bigint not null',
    'updated_at bigint not null',
  ],
  [pg.signal]: [
    'seq bigint not null',
    'workflow text not null',
    'event_id text not null',
    'name text not null',
    'version bigint not null',
    'payload_json text not null',
    'recorded_at bigint not null',
    'namespace text not null',
  ],
  [pg.action]: ['seq bigint not null', 'instance_id text not null', 'action text not null', 'operator text not null', 'at bigint not null'],
};
/** The indexes a reader and a writer depend on, by the table they are on. */
const INDEXES: Readonly<Record<string, readonly string[]>> = {
  [pg.instance]: [`${WORKFLOW_PREFIX}live`, `${WORKFLOW_PREFIX}waiting`, `${WORKFLOW_PREFIX}instance_start`],
  [pg.signal]: [`${WORKFLOW_PREFIX}signal_event`, `${WORKFLOW_PREFIX}signal_event_id`],
  [pg.action]: [`${WORKFLOW_PREFIX}action_instance`],
};
// The identity columns' own sequences are the other relations.
const SEQUENCES = [`${pg.signal}_seq_seq`, `${pg.action}_seq_seq`];

/** The exact layout, and this namespace's row at this version. */
export async function assertPostgresWorkflowStore(client: PgQuery, namespace: string): Promise<void> {
  try {
    const layoutFail = async () =>
      workflowFail(layoutRefusal('The workflow store', await postgresLayoutVersion(client, q(t.meta)), WORKFLOW_STORE_VERSION));
    const actual = await describePostgresRelations(client, WORKFLOW_PREFIX);
    const tables = actual.filter((relation) => relation.kind === 'r');
    const others = actual.filter((relation) => relation.kind !== 'r' && !SEQUENCES.includes(relation.name));
    if (others.length || tables.length !== Object.keys(COLUMNS).length) return layoutFail();
    for (const relation of tables) {
      const expected = COLUMNS[relation.name];
      const found = relation.columns.map((column) => `${column.name} ${column.type}${column.notnull ? ' not null' : ''}`);
      if (
        relation.schema !== runtimeSchema('postgres') ||
        !expected ||
        found.join('|') !== expected.join('|') ||
        relation.triggers ||
        relation.rules ||
        relation.policies ||
        relation.rls
      )
        return layoutFail();
      const names = relation.indexes.map((definition) => /INDEX (\S+) ON/.exec(definition)?.[1]);
      if ((INDEXES[relation.name] ?? []).some((name) => !names.includes(name))) return layoutFail();
    }
    const meta = (await client.query(`SELECT version FROM ${q(t.meta)} WHERE namespace = $1`, [captureWorkflowNamespace(namespace)])).rows;
    if (meta.length !== 1 || meta[0].version !== WORKFLOW_STORE_VERSION)
      return workflowFail(layoutRefusal('The workflow store', meta.length === 1 ? meta[0].version : undefined, WORKFLOW_STORE_VERSION));
  } catch (error) {
    if (error instanceof WorkflowStoreUnavailable) throw error;
    return workflowFail();
  }
}

/** Explicit maintenance, idempotent, under the shared migration lock. A
 * database without the store gets its tables; a namespace without a row gets one. */
export async function migratePostgresWorkflowStore(url: string, namespace: string): Promise<{ version: 1; migrated: boolean }> {
  const ns = captureWorkflowNamespace(namespace);
  try {
    return await withPostgresMaintenanceTransaction(url, async (client) => {
      if (!(await describePostgresRelations(client, WORKFLOW_PREFIX)).length)
        for (const ddl of POSTGRES_DEFINITIONS) await client.query(ddl);
      const migrated =
        (
          await client.query(`INSERT INTO ${q(t.meta)} (namespace, version) VALUES ($1, $2) ON CONFLICT (namespace) DO NOTHING`, [
            ns,
            WORKFLOW_STORE_VERSION,
          ])
        ).rowCount === 1;
      await assertPostgresWorkflowStore(client, ns);
      return { version: 1 as const, migrated };
    });
  } catch {
    return workflowFail();
  }
}
