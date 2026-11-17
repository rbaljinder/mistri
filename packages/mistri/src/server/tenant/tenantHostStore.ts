/**
 * The host table's statements, on each engine, for one maintenance transaction (tenantMaintenance.ts). A row names
 * whose public pages a hostname draws (http/tenantHosts.ts) and admits no one, so it has no version to fence: the
 * transaction's writer lock (SQLite) or a statement's own atomicity (PostgreSQL) is what orders two changes. Every
 * write here is a maintenance step that journals a receipt beside it, and a refused write says so by its return,
 * leaving the maintenance step to word the refusal.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { TENANT_TABLES, type TenantHostRow } from './tenantStoreContract.js';

export interface TenantHostOps {
  /** Every row, by host in byte order. */
  list(): Promise<readonly TenantHostRow[]>;
  get(host: string): Promise<TenantHostRow | null>;
  /** False when the host is already a row (one host shows one tenant). */
  insert(row: TenantHostRow): Promise<boolean>;
  /** False when there was no such row. */
  remove(host: string): Promise<boolean>;
  /** Makes `host` its tenant's one primary, clearing the flag on that tenant's others; false when there is no such row. */
  setPrimary(tenantId: string, host: string): Promise<boolean>;
  /** A custom domain's verification state, by host; false when there is no such row. */
  update(host: string, change: TenantHostChange): Promise<boolean>;
}

/** What a check changes on a row: never its tenant, App, kind or source, so a check cannot move a host. */
export interface TenantHostChange {
  readonly status: TenantHostRow['status'];
  readonly checkedAt: number | null;
  readonly failures: number;
  /** When the answers began being only "unavailable" (null once any other answer comes): see customDomains.ts. */
  readonly unavailableSince: number | null;
}

const COLUMNS = 'host, tenant_id, app, kind, status, verify_token, checked_at, failures, is_primary, source, created_at, unavailable_since';

function rowOf(row: Record<string, unknown>): TenantHostRow {
  return Object.freeze({
    host: row.host as string,
    tenantId: row.tenant_id as string,
    app: row.app as string,
    kind: row.kind as TenantHostRow['kind'],
    status: row.status as TenantHostRow['status'],
    primary: Number(row.is_primary) === 1,
    source: row.source as TenantHostRow['source'],
    verifyToken: (row.verify_token as string | null) ?? null,
    checkedAt: row.checked_at === null || row.checked_at === undefined ? null : Number(row.checked_at),
    failures: Number(row.failures),
    createdAt: Number(row.created_at),
    unavailableSince: row.unavailable_since === null || row.unavailable_since === undefined ? null : Number(row.unavailable_since),
  });
}
const values = (row: TenantHostRow) => [
  row.host,
  row.tenantId,
  row.app,
  row.kind,
  row.status,
  row.verifyToken,
  row.checkedAt,
  row.failures,
  row.primary ? 1 : 0,
  row.source,
  row.createdAt,
  row.unavailableSince,
];

export function sqliteTenantHostOps(db: DatabaseSync, assertCurrent: () => void): TenantHostOps {
  const table = `main."${TENANT_TABLES.host}"`;
  return {
    list: async () => {
      assertCurrent();
      return Object.freeze(
        db
          .prepare(`SELECT ${COLUMNS} FROM ${table} ORDER BY host COLLATE BINARY`)
          .all()
          .map((row) => rowOf({ ...row })),
      );
    },
    get: async (host) => {
      assertCurrent();
      const row = db.prepare(`SELECT ${COLUMNS} FROM ${table} WHERE host = ? COLLATE BINARY`).get(host);
      return row ? rowOf({ ...row }) : null;
    },
    insert: async (row) => {
      assertCurrent();
      return (
        db
          .prepare(`INSERT INTO ${table} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (host) DO NOTHING`)
          .run(...values(row)).changes === 1
      );
    },
    remove: async (host) => {
      assertCurrent();
      return db.prepare(`DELETE FROM ${table} WHERE host = ? COLLATE BINARY`).run(host).changes === 1;
    },
    setPrimary: async (tenantId, host) => {
      assertCurrent();
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE host = ? COLLATE BINARY AND tenant_id = ? COLLATE BINARY`).get(host, tenantId))
        return false;
      db.prepare(`UPDATE ${table} SET is_primary = (host = ? COLLATE BINARY) WHERE tenant_id = ? COLLATE BINARY`).run(host, tenantId);
      return true;
    },
    update: async (host, change) => {
      assertCurrent();
      return (
        db
          .prepare(`UPDATE ${table} SET status = ?, checked_at = ?, failures = ?, unavailable_since = ? WHERE host = ? COLLATE BINARY`)
          .run(change.status, change.checkedAt, change.failures, change.unavailableSince, host).changes === 1
      );
    },
  };
}

export function postgresTenantHostOps(client: PgQuery, assertCurrent: () => void): TenantHostOps {
  const table = runtimeTable('postgres', TENANT_TABLES.host);
  const columns = COLUMNS.replace('checked_at', 'checked_at::float8 AS checked_at')
    .replace('created_at', 'created_at::float8 AS created_at')
    .replace('unavailable_since', 'unavailable_since::float8 AS unavailable_since');
  const run = async (sql: string, params: unknown[] = []) => {
    assertCurrent();
    const result = await client.query(sql, params);
    assertCurrent();
    return result;
  };
  return {
    list: async () => Object.freeze((await run(`SELECT ${columns} FROM ${table} ORDER BY host COLLATE "C"`)).rows.map((row) => rowOf(row))),
    get: async (host) => {
      const rows = (await run(`SELECT ${columns} FROM ${table} WHERE host = $1`, [host])).rows;
      return rows[0] ? rowOf(rows[0]) : null;
    },
    insert: async (row) =>
      (
        await run(
          `INSERT INTO ${table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (host) DO NOTHING`,
          values(row),
        )
      ).rowCount === 1,
    remove: async (host) => (await run(`DELETE FROM ${table} WHERE host = $1`, [host])).rowCount === 1,
    setPrimary: async (tenantId, host) => {
      if (!(await run(`SELECT 1 FROM ${table} WHERE host = $1 AND tenant_id = $2`, [host, tenantId])).rows.length) return false;
      await run(`UPDATE ${table} SET is_primary = CASE WHEN host = $1 THEN 1 ELSE 0 END WHERE tenant_id = $2`, [host, tenantId]);
      return true;
    },
    update: async (host, change) =>
      (
        await run(`UPDATE ${table} SET status = $1, checked_at = $2, failures = $3, unavailable_since = $4 WHERE host = $5`, [
          change.status,
          change.checkedAt,
          change.failures,
          change.unavailableSince,
          host,
        ])
      ).rowCount === 1,
  };
}
