/**
 * The decision store on SQLite: the layout, its attestation, the explicit
 * provisioning step, and a private connection the store's statements run on.
 *
 * Attested as the assistant's is: SQLite keeps each CREATE statement's text,
 * so the reserved tables and their indexes must read exactly as this version
 * writes them, with no trigger or view under the prefix. The connection is
 * its own: a decision is recorded outside any business write, before the
 * command that lands it and after, never inside it.
 */
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  createDecisionStore,
  DECISION_AGE_INDEX,
  DECISION_LIMITS,
  DECISION_PREFIX,
  DECISION_RECORD_INDEX,
  DECISION_STORE_VERSION,
  DECISION_TABLES,
  DecisionStoreUnavailable,
  type DecisionStore,
  type Db,
  type Row,
} from './decisionStore.js';
import { provisionSqliteTenantSwitch, sqliteTenantSwitchReady } from '../switch/sqliteTenantSwitch.js';

const { meta, record, usage } = DECISION_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
const definitions = new Map<string, string>([
  [
    meta,
    `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${DECISION_STORE_VERSION})
)`,
  ],
  [
    record,
    `CREATE TABLE "${record}" (
  id TEXT COLLATE BINARY PRIMARY KEY,
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', DECISION_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', DECISION_LIMITS.tenant)}),
  decision TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  resource TEXT NOT NULL,
  record_key TEXT NOT NULL,
  field TEXT NOT NULL,
  trigger TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  inputs_digest TEXT NOT NULL,
  input_fields TEXT NOT NULL,
  choices_digest TEXT NOT NULL,
  answer TEXT CHECK (answer IS NULL OR ${bytes('answer', DECISION_LIMITS.answer)}),
  probability REAL CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'suggested', 'accepted', 'corrected', 'ignored', 'below', 'none')),
  outcome_reason TEXT NOT NULL,
  corrected_to TEXT,
  outcome_by TEXT NOT NULL,
  outcome_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  units INTEGER NOT NULL,
  created_at TEXT NOT NULL
)`,
  ],
  [
    usage,
    `CREATE TABLE "${usage}" (
  app TEXT COLLATE BINARY NOT NULL,
  tenant TEXT COLLATE BINARY NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL,
  units INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  PRIMARY KEY (app, tenant, day)
)`,
  ],
]);
const INDEXES = new Map<string, string>([
  [DECISION_RECORD_INDEX, `CREATE INDEX "${DECISION_RECORD_INDEX}" ON "${record}" (app, tenant, resource, record_key, created_at)`],
  [DECISION_AGE_INDEX, `CREATE INDEX "${DECISION_AGE_INDEX}" ON "${record}" (app, created_at)`],
]);

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
const catalog = (db: DatabaseSync): CatalogEntry[] =>
  db
    .prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
    .all(DECISION_PREFIX.length, DECISION_PREFIX, DECISION_PREFIX.length, DECISION_PREFIX) as unknown as CatalogEntry[];

/** Exactly this version's tables and indexes, nothing else under the prefix, and its version row. */
export function sqliteDecisionsReady(db: DatabaseSync): boolean {
  if (!sqliteTenantSwitchReady(db)) return false;
  if (
    db
      .prepare(`SELECT 1 FROM temp.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`)
      .get(DECISION_PREFIX.length, DECISION_PREFIX, DECISION_PREFIX.length, DECISION_PREFIX)
  )
    return false;
  const entries = catalog(db);
  const tables = entries.filter((entry) => entry.type === 'table');
  const indexes = entries.filter((entry) => entry.type === 'index');
  if (
    tables.length !== definitions.size ||
    tables.some((entry) => definitions.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && entry.type !== 'index') ||
    indexes.some((entry) => !((entry.sql === null && definitions.has(entry.tbl_name)) || INDEXES.get(entry.name) === entry.sql)) ||
    [...INDEXES.keys()].some((name) => !indexes.some((entry) => entry.name === name))
  )
    return false;
  const rows = db.prepare(`SELECT singleton, version FROM main."${meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === DECISION_STORE_VERSION;
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.');

/**
 * Explicit maintenance. Never run when an App opens: a file without the store
 * gets this version; the same layout again changes nothing; anything else
 * under the prefix is refused unchanged.
 */
export function provisionSqliteDecisions(existingPath: string): { version: typeof DECISION_STORE_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Decision store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        for (const ddl of INDEXES.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(DECISION_STORE_VERSION);
        provisioned = true;
      }
      /* The tenants' switches are a store of their own that the assistant store shares (adapters/switch). */
      if (provisionSqliteTenantSwitch(db)) provisioned = true;
      if (!sqliteDecisionsReady(db))
        throw new DecisionStoreUnavailable(layoutRefusal('The decision store', sqliteLayoutVersion(db, meta), DECISION_STORE_VERSION));
      db.exec('COMMIT');
      return { version: DECISION_STORE_VERSION, provisioned };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve the provisioning failure. */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/** One private connection over an existing, provisioned file; opening attests, and a store that cannot be is not returned. */
export function openSqliteDecisions(existingPath: string): DecisionStore {
  const db = new DatabaseSync(realpathSync(existingPath));
  db.exec('PRAGMA busy_timeout = 5000');
  if (!sqliteDecisionsReady(db)) {
    const message = layoutRefusal('The decision store', sqliteLayoutVersion(db, meta), DECISION_STORE_VERSION);
    db.close();
    throw new DecisionStoreUnavailable(message);
  }
  let closed = false;
  const driver: Db = {
    all: async (sql, ...params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Row[],
    run: async (sql, ...params) => Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
  };
  /* Each call is one synchronous transaction behind a promise, as the assistant store's is (sqliteAssistant.ts). */
  let queue = Promise.resolve();
  const transaction = <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      if (closed) throw new DecisionStoreUnavailable();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(driver);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return createDecisionStore(
    transaction,
    (name) => `main."${name}"`,
    async () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  );
}
