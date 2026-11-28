/**
 * The assistant store on SQLite: the layout, its attestation, the explicit
 * provisioning step, and a private connection the store's statements run on.
 *
 * Attested as the inbox is: SQLite keeps each CREATE statement's text, so the
 * reserved tables and their index must read exactly as this version writes
 * them, with no trigger or view under the prefix. The connection is its own,
 * like the workflow store's — a conversation is never written inside a
 * business write, so it has no handle of the adapter's to share.
 */
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  ASSISTANT_INDEX,
  ASSISTANT_LIMITS,
  ASSISTANT_MEMORY_INDEX,
  ASSISTANT_PREFIX,
  ASSISTANT_RUN_INDEX,
  ASSISTANT_STORE_VERSION,
  ASSISTANT_TABLES,
  AssistantStoreUnavailable,
  createAssistantStore,
  type AssistantStore,
  type Db,
  type Row,
} from './assistantStore.js';
import { provisionSqliteTenantSwitch, sqliteTenantSwitchReady } from '../switch/sqliteTenantSwitch.js';

const { meta, conversation, event, usage, memory, run, automation } = ASSISTANT_TABLES;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) <= ${limit}`;
/** The version row's table, which pins this version: the upgrade (storeLayouts.ts) rebuilds it to pin the next. */
const ASSISTANT_META_SQLITE = `CREATE TABLE "${meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${ASSISTANT_STORE_VERSION})
)`;
const definitions = new Map<string, string>([
  [meta, ASSISTANT_META_SQLITE],
  [
    conversation,
    `CREATE TABLE "${conversation}" (
  id TEXT COLLATE BINARY PRIMARY KEY,
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', ASSISTANT_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', ASSISTANT_LIMITS.tenant)}),
  account TEXT COLLATE BINARY NOT NULL CHECK (${bytes('account', ASSISTANT_LIMITS.account)}),
  title TEXT NOT NULL CHECK (${bytes('title', ASSISTANT_LIMITS.title)}),
  state TEXT NOT NULL CHECK (state IN ('idle', 'awaiting')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  ],
  [
    event,
    `CREATE TABLE "${event}" (
  conversation TEXT COLLATE BINARY NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND ${bytes('body_json', ASSISTANT_LIMITS.body)}),
  at TEXT NOT NULL,
  PRIMARY KEY (conversation, seq)
)`,
  ],
  [
    usage,
    `CREATE TABLE "${usage}" (
  app TEXT COLLATE BINARY NOT NULL,
  tenant TEXT COLLATE BINARY NOT NULL,
  account TEXT COLLATE BINARY NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (app, tenant, account, day)
)`,
  ],
  [
    memory,
    `CREATE TABLE "${memory}" (
  id TEXT COLLATE BINARY PRIMARY KEY,
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', ASSISTANT_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', ASSISTANT_LIMITS.tenant)}),
  account TEXT COLLATE BINARY NOT NULL CHECK (${bytes('account', ASSISTANT_LIMITS.account)}),
  scope TEXT NOT NULL CHECK (scope IN ('person', 'app')),
  agent TEXT COLLATE BINARY NOT NULL CHECK (${bytes('agent', ASSISTANT_LIMITS.memoryAgent)}),
  content TEXT NOT NULL CHECK (${bytes('content', ASSISTANT_LIMITS.memoryContent)}),
  source TEXT NOT NULL CHECK (source IN ('assistant', 'person')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  ],
  [
    run,
    `CREATE TABLE "${run}" (
  id TEXT COLLATE BINARY PRIMARY KEY,
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', ASSISTANT_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', ASSISTANT_LIMITS.tenant)}),
  account TEXT COLLATE BINARY NOT NULL CHECK (${bytes('account', ASSISTANT_LIMITS.account)}),
  conversation TEXT COLLATE BINARY NOT NULL,
  agent TEXT COLLATE BINARY NOT NULL CHECK (${bytes('agent', ASSISTANT_LIMITS.memoryAgent)}),
  source TEXT COLLATE BINARY NOT NULL CHECK (${bytes('source', ASSISTANT_LIMITS.runSource)}),
  title TEXT NOT NULL CHECK (${bytes('title', ASSISTANT_LIMITS.title)}),
  prompt TEXT NOT NULL CHECK (${bytes('prompt', ASSISTANT_LIMITS.runPrompt)}),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting', 'completed', 'failed', 'cancelled')),
  steps INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  summary TEXT NOT NULL CHECK (${bytes('summary', ASSISTANT_LIMITS.runSummary)}),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
)`,
  ],
  [
    automation,
    `CREATE TABLE "${automation}" (
  app TEXT COLLATE BINARY NOT NULL CHECK (${bytes('app', ASSISTANT_LIMITS.app)}),
  tenant TEXT COLLATE BINARY NOT NULL CHECK (${bytes('tenant', ASSISTANT_LIMITS.tenant)}),
  account TEXT COLLATE BINARY NOT NULL CHECK (${bytes('account', ASSISTANT_LIMITS.account)}),
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'trigger')),
  automation_id TEXT COLLATE BINARY NOT NULL CHECK (${bytes('automation_id', ASSISTANT_LIMITS.automationId)}),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  last_slot TEXT NOT NULL,
  last_run_id TEXT COLLATE BINARY NOT NULL,
  last_run_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, tenant, account, kind, automation_id)
)`,
  ],
]);
const INDEXES = new Map<string, string>([
  [ASSISTANT_INDEX, `CREATE INDEX "${ASSISTANT_INDEX}" ON "${conversation}" (app, tenant, account, updated_at)`],
  [ASSISTANT_MEMORY_INDEX, `CREATE INDEX "${ASSISTANT_MEMORY_INDEX}" ON "${memory}" (app, tenant, scope, account, updated_at)`],
  [ASSISTANT_RUN_INDEX, `CREATE INDEX "${ASSISTANT_RUN_INDEX}" ON "${run}" (app, tenant, account, updated_at)`],
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
    .all(ASSISTANT_PREFIX.length, ASSISTANT_PREFIX, ASSISTANT_PREFIX.length, ASSISTANT_PREFIX) as unknown as CatalogEntry[];

/** Exactly this version's tables and indexes, nothing else under the prefix, its version row, and the tenant switch store beside it. */
export function sqliteAssistantReady(db: DatabaseSync): boolean {
  if (!sqliteTenantSwitchReady(db)) return false;
  if (
    db
      .prepare(`SELECT 1 FROM temp.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`)
      .get(ASSISTANT_PREFIX.length, ASSISTANT_PREFIX, ASSISTANT_PREFIX.length, ASSISTANT_PREFIX)
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
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === ASSISTANT_STORE_VERSION;
}

const inMain = (ddl: string) => ddl.replace('CREATE TABLE ', 'CREATE TABLE main.').replace('CREATE INDEX ', 'CREATE INDEX main.');

/** Version 1 to 2: adds the scoped durable memory table, durable background runs table, automation state table, and their owner indexes. */
export function sqliteAssistantUpgradeFrom1(): readonly string[] {
  return Object.freeze([
    inMain(definitions.get(memory)!),
    inMain(INDEXES.get(ASSISTANT_MEMORY_INDEX)!),
    inMain(definitions.get(run)!),
    inMain(INDEXES.get(ASSISTANT_RUN_INDEX)!),
    inMain(definitions.get(automation)!),
    `DROP TABLE main."${meta}"`,
    inMain(ASSISTANT_META_SQLITE),
    `INSERT INTO main."${meta}" (singleton, version) VALUES (1, ${ASSISTANT_STORE_VERSION})`,
  ]);
}

/**
 * Explicit maintenance. Never run when an App opens: a file without the
 * store gets this version; the same layout again changes nothing; anything
 * else under the prefix is refused unchanged.
 */
export function provisionSqliteAssistant(existingPath: string): { version: typeof ASSISTANT_STORE_VERSION; provisioned: boolean } {
  if (!statSync(existingPath).isFile()) throw new Refusal('Assistant store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      let provisioned = false;
      if (catalog(db).length === 0) {
        for (const ddl of definitions.values()) db.exec(inMain(ddl));
        for (const ddl of INDEXES.values()) db.exec(inMain(ddl));
        db.prepare(`INSERT INTO main."${meta}" (singleton, version) VALUES (1, ?)`).run(ASSISTANT_STORE_VERSION);
        provisioned = true;
      }
      /* The tenants' switches are a store of their own that the decision store shares (adapters/switch). */
      if (provisionSqliteTenantSwitch(db)) provisioned = true;
      if (!sqliteAssistantReady(db))
        throw new AssistantStoreUnavailable(layoutRefusal('The assistant store', sqliteLayoutVersion(db, meta), ASSISTANT_STORE_VERSION));
      db.exec('COMMIT');
      return { version: ASSISTANT_STORE_VERSION, provisioned };
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
export function openSqliteAssistant(existingPath: string): AssistantStore {
  const db = new DatabaseSync(realpathSync(existingPath));
  db.exec('PRAGMA busy_timeout = 5000');
  if (!sqliteAssistantReady(db)) {
    const message = layoutRefusal('The assistant store', sqliteLayoutVersion(db, meta), ASSISTANT_STORE_VERSION);
    db.close();
    throw new AssistantStoreUnavailable(message);
  }
  let closed = false;
  const driver: Db = {
    all: async (sql, ...params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Row[],
    run: async (sql, ...params) => Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
  };
  /* Each call is one synchronous transaction behind a promise: the work's
     statements are all `await`s of already-settled promises, so nothing
     else runs on this connection between BEGIN and COMMIT. */
  let queue = Promise.resolve();
  const transaction = <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      if (closed) throw new AssistantStoreUnavailable();
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
  return createAssistantStore(
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
