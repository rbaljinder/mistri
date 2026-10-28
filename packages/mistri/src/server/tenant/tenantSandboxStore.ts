/**
 * The sandbox store: which tenants are sandboxes, whose clone
 * each one is, its dev clock, and the item map an import reads — for each row
 * a clone copied as configuration, its key in the sandbox, its key in the
 * live tenant, and a digest of the row as the clone found it (the base an
 * import compares both sides against).
 *
 * It lives in the business database beside the tenant store, under its own
 * prefix (the tenant store's layout is enumerated exactly, so it takes no new
 * table), and is provisioned explicitly — `provisionSqliteTenantSandboxes`,
 * `provisionPostgresTenantSandboxes` — never at startup; startup attests it
 * where the App marks a resource clone (tenantFeatureClone.ts). Every read and
 * write here runs inside a caller's own transaction, on its session, and
 * every row is keyed by the App: nothing here decides who may clone.
 */
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { withPostgresMaintenanceTransaction } from '../../adapters/commands/postgresCommandJournalSchema.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { layoutRefusal, versionOfRows } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { CloneValue } from './tenantClonePlan.js';
import { denyLayout } from './tenantStoreContract.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const SANDBOX_PREFIX = '__mistri_sandbox_';
export const SANDBOX_TABLES = Object.freeze({
  tenant: `${SANDBOX_PREFIX}tenant`,
  item: `${SANDBOX_PREFIX}item`,
  meta: `${SANDBOX_PREFIX}meta`,
});
/** The layout's version, kept in the meta table's one row. */
const SANDBOX_STORE_VERSION = 1;

/** A sandbox's dev clock: it reads `skewMs` ahead of real time when set at `setAt`,
 * and gains `rate − 1` milliseconds on it every real millisecond after. */
export interface SandboxClock {
  readonly skewMs: number;
  readonly rate: number;
  readonly setAt: number;
}
export interface SandboxRecord {
  readonly tenantId: string;
  readonly sourceTenantId: string;
  readonly samples: boolean;
  readonly createdAt: string;
  readonly clock: SandboxClock;
}
export interface SandboxItem {
  readonly sandboxKey: string;
  readonly liveKey: string;
  readonly base: string;
}

/** One statement runner on a caller's open transaction: `?` placeholders, both engines. */
export interface SandboxSession {
  readonly dialect: 'sqlite' | 'postgres';
  all(sql: string, params?: readonly CloneValue[]): Promise<Record<string, CloneValue>[]>;
  run(sql: string, params?: readonly CloneValue[]): Promise<number>;
}
export function sqliteSandboxSession(db: DatabaseSync, active: () => void = () => {}): SandboxSession {
  return Object.freeze({
    dialect: 'sqlite' as const,
    async all(sql: string, params: readonly CloneValue[] = []) {
      active();
      const statement = db.prepare(sql);
      // Exact integers: a copied id past 2^53 must not round.
      statement.setReadBigInts(true);
      const rows = statement.all(...(params as (string | number | bigint | Uint8Array | null)[]));
      active();
      return rows.map((row) => ({ ...row }) as Record<string, CloneValue>);
    },
    async run(sql: string, params: readonly CloneValue[] = []) {
      active();
      const result = db.prepare(sql).run(...(params as (string | number | bigint | Uint8Array | null)[]));
      active();
      return Number(result.changes);
    },
  });
}
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
export function postgresSandboxSession(client: PgQuery, active: () => void = () => {}): SandboxSession {
  return Object.freeze({
    dialect: 'postgres' as const,
    async all(sql: string, params: readonly CloneValue[] = []) {
      active();
      const rows = (await client.query(numbered(sql), [...params])).rows;
      active();
      return rows as Record<string, CloneValue>[];
    },
    async run(sql: string, params: readonly CloneValue[] = []) {
      active();
      const result = await client.query(numbered(sql), [...params]);
      active();
      return Number(result.rowCount ?? 0);
    },
  });
}

/* ---------- layout ---------- */

const COLUMNS = Object.freeze({
  tenant: ['app', 'tenant_id', 'source_tenant_id', 'samples', 'created_at', 'clock_skew_ms', 'clock_rate', 'clock_set_at'],
  item: ['app', 'tenant_id', 'resource', 'sandbox_key', 'live_key', 'base'],
  meta: ['singleton', 'version'],
});
const DDL = {
  sqlite: [
    `CREATE TABLE main."${SANDBOX_TABLES.tenant}" (app TEXT NOT NULL, tenant_id TEXT NOT NULL, source_tenant_id TEXT NOT NULL,
      samples INTEGER NOT NULL CHECK (samples IN (0, 1)), created_at TEXT NOT NULL,
      clock_skew_ms INTEGER NOT NULL DEFAULT 0, clock_rate INTEGER NOT NULL DEFAULT 1, clock_set_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app, tenant_id))`,
    `CREATE TABLE main."${SANDBOX_TABLES.item}" (app TEXT NOT NULL, tenant_id TEXT NOT NULL, resource TEXT NOT NULL,
      sandbox_key TEXT NOT NULL, live_key TEXT NOT NULL, base TEXT NOT NULL,
      PRIMARY KEY (app, tenant_id, resource, sandbox_key))`,
    `CREATE TABLE main."${SANDBOX_TABLES.meta}" (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = ${SANDBOX_STORE_VERSION}))`,
    `INSERT INTO main."${SANDBOX_TABLES.meta}" (singleton, version) VALUES (1, ${SANDBOX_STORE_VERSION})`,
  ],
  postgres: [
    `CREATE TABLE ${runtimeTable('postgres', SANDBOX_TABLES.tenant)} (app text COLLATE "C" NOT NULL, tenant_id text COLLATE "C" NOT NULL,
      source_tenant_id text COLLATE "C" NOT NULL, samples integer NOT NULL CHECK (samples IN (0, 1)), created_at text NOT NULL,
      clock_skew_ms bigint NOT NULL DEFAULT 0, clock_rate integer NOT NULL DEFAULT 1, clock_set_at bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (app, tenant_id))`,
    `CREATE TABLE ${runtimeTable('postgres', SANDBOX_TABLES.item)} (app text COLLATE "C" NOT NULL, tenant_id text COLLATE "C" NOT NULL,
      resource text COLLATE "C" NOT NULL, sandbox_key text COLLATE "C" NOT NULL, live_key text COLLATE "C" NOT NULL, base text NOT NULL,
      PRIMARY KEY (app, tenant_id, resource, sandbox_key))`,
    `CREATE TABLE ${runtimeTable('postgres', SANDBOX_TABLES.meta)} (singleton integer PRIMARY KEY CHECK (singleton = 1),
      version integer NOT NULL CHECK (version = ${SANDBOX_STORE_VERSION}))`,
    `INSERT INTO ${runtimeTable('postgres', SANDBOX_TABLES.meta)} (singleton, version) VALUES (1, ${SANDBOX_STORE_VERSION})`,
  ],
};
/** Each table's columns as the database has them, or null where it has no such table. */
async function layout(session: SandboxSession): Promise<Record<keyof typeof COLUMNS, string[] | null>> {
  const names = { tenant: SANDBOX_TABLES.tenant, item: SANDBOX_TABLES.item, meta: SANDBOX_TABLES.meta };
  const tables = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, runtimeName(session.dialect, name)])) as Record<
    keyof typeof COLUMNS,
    string
  >;
  if (session.dialect === 'sqlite') {
    const read = async (table: string): Promise<string[] | null> => {
      const rows = await session.all(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table]);
      return rows.length ? rows.map((row) => String(row.name)) : null;
    };
    return { tenant: await read(tables.tenant), item: await read(tables.item), meta: await read(tables.meta) };
  }
  /* The three tables in one read: a member's chooser asks this before it draws, and each read is a round trip. */
  const rows = await session.all(
    `SELECT table_name AS "table", column_name AS name FROM information_schema.columns WHERE table_schema = '${runtimeSchema('postgres')}' AND table_name IN (?, ?, ?) ORDER BY table_name, ordinal_position`,
    [tables.tenant, tables.item, tables.meta],
  );
  const columnsOf = (table: string): string[] | null => {
    const found = rows.filter((row) => row.table === table).map((row) => String(row.name));
    return found.length ? found : null;
  };
  return { tenant: columnsOf(tables.tenant), item: columnsOf(tables.item), meta: columnsOf(tables.meta) };
}
const sameColumns = (found: readonly string[] | null, expected: readonly string[]) =>
  !!found && found.length === expected.length && found.every((column, index) => column === expected[index]);

/** Whether the store is there: false when it was never provisioned; a store that is there and not this layout refuses,
 * and one at another version says which way (nothing is altered either way). */
export async function sandboxStorePresent(session: SandboxSession): Promise<boolean> {
  const found = await layout(session);
  if (!found.tenant && !found.item && !found.meta) return false;
  for (const name of ['tenant', 'item'] as const)
    if (!sameColumns(found[name], COLUMNS[name])) return denyTenant('The sandbox store is not the layout this mistri provisions.');
  const version = sameColumns(found.meta, COLUMNS.meta)
    ? versionOfRows(await session.all(`SELECT version FROM ${table(session, SANDBOX_TABLES.meta)}`))
    : null;
  if (version !== SANDBOX_STORE_VERSION)
    return denyLayout(
      version === null
        ? 'The sandbox store is not the layout this mistri provisions.'
        : layoutRefusal('The sandbox store', version, SANDBOX_STORE_VERSION),
    );
  return true;
}
export async function assertSandboxStore(session: SandboxSession): Promise<void> {
  if (!(await sandboxStorePresent(session)))
    denyTenant(
      "The sandbox store is not provisioned: run provisionStores(<the database>, { only: ['tenant-sandboxes'] }) from @mistriwork/mistri/maintenance.",
    );
}

/** Startup's attestation on SQLite, which is synchronous: the store is there, in this layout. */
export function assertSqliteSandboxStore(db: DatabaseSync): void {
  const columns = (name: string) =>
    db
      .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
      .all(name)
      .map((row) => row.name);
  if (
    JSON.stringify(columns(SANDBOX_TABLES.tenant)) !== JSON.stringify(COLUMNS.tenant) ||
    JSON.stringify(columns(SANDBOX_TABLES.item)) !== JSON.stringify(COLUMNS.item)
  )
    denyTenant('The sandbox store is missing or is not this layout: run provisionSqliteTenantSandboxes.');
  const meta = columns(SANDBOX_TABLES.meta);
  const version =
    JSON.stringify(meta) === JSON.stringify(COLUMNS.meta)
      ? versionOfRows(db.prepare(`SELECT version FROM main."${SANDBOX_TABLES.meta}"`).all())
      : null;
  if (version !== SANDBOX_STORE_VERSION)
    denyLayout(
      version === null
        ? 'The sandbox store is not the layout this mistri provisions.'
        : layoutRefusal('The sandbox store', version, SANDBOX_STORE_VERSION),
    );
}

/** The sandbox store on an existing SQLite business file, once; idempotent, and a foreign layout is refused unchanged. */
export function provisionSqliteTenantSandboxes(existingPath: string): {
  provisioned: boolean;
} {
  if (!statSync(existingPath).isFile()) throw new Error('Sandbox store provisioning requires an existing SQLite file.');
  const db = new DatabaseSync(existingPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const present = !!db
        .prepare(`SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND substr(name, 1, ?) = ? LIMIT 1`)
        .get(SANDBOX_PREFIX.length, SANDBOX_PREFIX);
      if (!present) for (const ddl of DDL.sqlite) db.exec(ddl);
      const columns = (table: string) =>
        db
          .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
          .all(table)
          .map((row) => row.name);
      if (
        JSON.stringify(columns(SANDBOX_TABLES.tenant)) !== JSON.stringify(COLUMNS.tenant) ||
        JSON.stringify(columns(SANDBOX_TABLES.item)) !== JSON.stringify(COLUMNS.item) ||
        JSON.stringify(columns(SANDBOX_TABLES.meta)) !== JSON.stringify(COLUMNS.meta)
      )
        throw new Error('The sandbox store is not the layout this mistri provisions.');
      const version = versionOfRows(db.prepare(`SELECT version FROM main."${SANDBOX_TABLES.meta}"`).all());
      if (version !== SANDBOX_STORE_VERSION)
        throw new Error(
          layoutRefusal('The sandbox store', version, SANDBOX_STORE_VERSION) ??
            'The sandbox store is not the layout this mistri provisions.',
        );
      db.exec('COMMIT');
      return { provisioned: !present };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
/** The same on a PostgreSQL database, in its public schema. */
export async function provisionPostgresTenantSandboxes(url: string): Promise<{ provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Error('Sandbox store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const session = postgresSandboxSession(client);
    const found = await layout(session);
    const provisioned = !found.tenant && !found.item && !found.meta;
    if (provisioned) for (const ddl of DDL.postgres) await client.query(ddl);
    try {
      await assertSandboxStore(session);
    } catch {
      throw new Error('The sandbox store is not the layout this mistri provisions.');
    }
    return { provisioned };
  });
}

/* ---------- rows ---------- */

const T = SANDBOX_TABLES;
const integer = (value: CloneValue, least: number): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < least) return denyTenant();
  return number;
};
const record = (row: Record<string, CloneValue>): SandboxRecord =>
  Object.freeze({
    tenantId: String(row.tenant_id),
    sourceTenantId: String(row.source_tenant_id),
    samples: Number(row.samples) === 1,
    createdAt: String(row.created_at),
    clock: Object.freeze({
      skewMs: integer(row.clock_skew_ms, 0),
      rate: integer(row.clock_rate, 1),
      setAt: integer(row.clock_set_at, 0),
    }),
  });
const table = (session: SandboxSession, name: string) => runtimeTable(session.dialect, name);

/** The App's sandbox rows, on a session whose store the caller has attested. */
export function sandboxRows(session: SandboxSession, appId: string) {
  const tenants = table(session, T.tenant),
    items = table(session, T.item);
  return Object.freeze({
    async read(tenantId: string): Promise<SandboxRecord | null> {
      const rows = await session.all(`SELECT * FROM ${tenants} WHERE app = ? AND tenant_id = ?`, [appId, tenantId]);
      return rows[0] ? record(rows[0]) : null;
    },
    /** Which of these tenants are sandboxes. */
    async among(tenantIds: readonly string[]): Promise<ReadonlySet<string>> {
      if (!tenantIds.length) return new Set();
      const rows =
        session.dialect === 'sqlite'
          ? await session.all(`SELECT tenant_id FROM ${tenants} WHERE app = ? AND tenant_id IN (SELECT value FROM json_each(?))`, [
              appId,
              JSON.stringify(tenantIds),
            ])
          : // A tenant id is [a-z0-9_-] (parseTenantSelector): a comma never splits one.
            await session.all(`SELECT tenant_id FROM ${tenants} WHERE app = ? AND tenant_id = ANY(string_to_array(?, ','))`, [
              appId,
              tenantIds.join(','),
            ]);
      return new Set(rows.map((row) => String(row.tenant_id)));
    },
    /** The sandboxes cloned from a tenant, in byte order: at most fifty are named. */
    async of(sourceTenantId: string): Promise<readonly string[]> {
      const rows = await session.all(
        `SELECT tenant_id FROM ${tenants} WHERE app = ? AND source_tenant_id = ? ORDER BY tenant_id${session.dialect === 'sqlite' ? ' COLLATE BINARY' : ''} LIMIT 50`,
        [appId, sourceTenantId],
      );
      return rows.map((row) => String(row.tenant_id));
    },
    /** Every sandbox whose clock reads ahead of real time. */
    async clocks(): Promise<readonly SandboxRecord[]> {
      return (await session.all(`SELECT * FROM ${tenants} WHERE app = ? AND (clock_skew_ms <> 0 OR clock_rate <> 1)`, [appId])).map(record);
    },
    async create(value: Omit<SandboxRecord, 'clock'>): Promise<void> {
      await session.run(
        `INSERT INTO ${tenants} (app, tenant_id, source_tenant_id, samples, created_at, clock_skew_ms, clock_rate, clock_set_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, 0)`,
        [appId, value.tenantId, value.sourceTenantId, value.samples ? 1 : 0, value.createdAt],
      );
    },
    async setClock(tenantId: string, clock: SandboxClock): Promise<void> {
      const changed = await session.run(
        `UPDATE ${tenants} SET clock_skew_ms = ?, clock_rate = ?, clock_set_at = ? WHERE app = ? AND tenant_id = ?`,
        [clock.skewMs, clock.rate, clock.setAt, appId, tenantId],
      );
      if (changed !== 1) denyTenant();
    },
    async items(tenantId: string, resource: string): Promise<ReadonlyMap<string, SandboxItem>> {
      const rows = await session.all(`SELECT sandbox_key, live_key, base FROM ${items} WHERE app = ? AND tenant_id = ? AND resource = ?`, [
        appId,
        tenantId,
        resource,
      ]);
      return new Map(
        rows.map((row) => [
          String(row.sandbox_key),
          Object.freeze({
            sandboxKey: String(row.sandbox_key),
            liveKey: String(row.live_key),
            base: String(row.base),
          }),
        ]),
      );
    },
    async putItem(tenantId: string, resource: string, item: SandboxItem): Promise<void> {
      await session.run(`DELETE FROM ${items} WHERE app = ? AND tenant_id = ? AND resource = ? AND sandbox_key = ?`, [
        appId,
        tenantId,
        resource,
        item.sandboxKey,
      ]);
      await session.run(`INSERT INTO ${items} (app, tenant_id, resource, sandbox_key, live_key, base) VALUES (?, ?, ?, ?, ?, ?)`, [
        appId,
        tenantId,
        resource,
        item.sandboxKey,
        item.liveKey,
        item.base,
      ]);
    },
    async deleteItem(tenantId: string, resource: string, sandboxKey: string): Promise<void> {
      await session.run(`DELETE FROM ${items} WHERE app = ? AND tenant_id = ? AND resource = ? AND sandbox_key = ?`, [
        appId,
        tenantId,
        resource,
        sandboxKey,
      ]);
    },
  });
}
export type SandboxRows = ReturnType<typeof sandboxRows>;
