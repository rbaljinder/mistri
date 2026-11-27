/**
 * PostgreSQL control-plane routing directory (`mistri.shard_*` tables).
 *
 * Lives in a dedicated PostgreSQL control-plane database (mirroring `auth.store`
 * and `suite-*`). Holds shard node registrations, tenant-to-shard placements,
 * account-to-tenant discovery indexes, custom-domain/subdomain host mappings,
 * and opt-in non-tenant lookup vindex entries. Emits `NOTIFY mistri_shard_topology`
 * on mutations so every pod's `CachedShardDirectory` invalidates immediately.
 */
import { sharedPgConnections, type PgConnectionManager, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { SMALL_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { RUNTIME_SCHEMA, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import {
  createShardRouter,
  DEFAULT_SHARD_BUCKETS,
  isShardId,
  type ShardBucketRange,
  type ShardRouter,
  type ShardStatus,
  type ShardStrategy,
} from '@mistriwork/engine/shared/sharding.js';
import { listenForWake, type CommandEventListener } from '../events/postgresCommandEventWake.js';
import {
  SHARD_DIRECTORY_TABLES,
  SHARD_DIRECTORY_VERSION,
  SHARD_TOPOLOGY_CHANNEL,
  type DirectoryAccountTenant,
  type DirectoryHostEntry,
  type DirectoryLookupEntry,
  type DirectoryShardNode,
  type DirectoryTenantPlacement,
  type DirectoryTenantStatus,
  type ShardDirectory,
  type ShardDirectoryBinding,
} from './shardDirectory.js';

const q = (logical: string): string => runtimeTable('postgres', logical);

const META = q(SHARD_DIRECTORY_TABLES.meta);
const NODE = q(SHARD_DIRECTORY_TABLES.node);
const TENANT = q(SHARD_DIRECTORY_TABLES.tenant);
const ACCOUNT_TENANT = q(SHARD_DIRECTORY_TABLES.accountTenant);
const HOST = q(SHARD_DIRECTORY_TABLES.host);
const LOOKUP = q(SHARD_DIRECTORY_TABLES.lookup);

/** Provision the `mistri.shard_*` control-plane directory tables idempotently on `url`. */
export async function provisionPostgresShardDirectory(
  url: string,
  binding: ShardDirectoryBinding,
): Promise<Readonly<{ version: number; provisioned: boolean }>> {
  const manager = sharedPgConnections(url, SMALL_STORE_POOL);
  try {
    return await manager.withWriteClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${RUNTIME_SCHEMA}"`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${META} (
            singleton integer PRIMARY KEY CHECK (singleton = 1),
            version integer NOT NULL,
            app_id text COLLATE "C" NOT NULL,
            source_id text COLLATE "C" NOT NULL,
            store_id text COLLATE "C" NOT NULL,
            strategy text COLLATE "C" NOT NULL,
            buckets integer NOT NULL,
            created_at bigint NOT NULL
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${NODE} (
            shard_id text COLLATE "C" PRIMARY KEY,
            label text NOT NULL,
            status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'draining', 'read_only')),
            buckets_json text,
            weight double precision NOT NULL DEFAULT 1,
            updated_at bigint NOT NULL
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${TENANT} (
            tenant_id text COLLATE "C" PRIMARY KEY,
            shard_id text COLLATE "C" NOT NULL REFERENCES ${NODE}(shard_id) ON DELETE RESTRICT,
            status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'suspended', 'migrating', 'closed')),
            display_name text,
            version integer NOT NULL DEFAULT 1,
            updated_at bigint NOT NULL
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS shard_tenant_shard_idx ON ${TENANT} (shard_id, status)
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${ACCOUNT_TENANT} (
            account_id text COLLATE "C" NOT NULL,
            tenant_id text COLLATE "C" NOT NULL,
            shard_id text COLLATE "C" NOT NULL REFERENCES ${NODE}(shard_id) ON DELETE RESTRICT,
            status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'revoked')),
            PRIMARY KEY (account_id, tenant_id)
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS shard_account_tenant_tenant_idx ON ${ACCOUNT_TENANT} (tenant_id)
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${HOST} (
            host text COLLATE "C" PRIMARY KEY,
            tenant_id text COLLATE "C" NOT NULL,
            shard_id text COLLATE "C" NOT NULL REFERENCES ${NODE}(shard_id) ON DELETE RESTRICT,
            app text COLLATE "C" NOT NULL,
            kind text COLLATE "C" NOT NULL CHECK (kind IN ('subdomain', 'custom')),
            status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'pending', 'failed')),
            is_primary boolean NOT NULL DEFAULT false
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS shard_host_tenant_idx ON ${HOST} (tenant_id)
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${LOOKUP} (
            resource text COLLATE "C" NOT NULL,
            lookup_key text COLLATE "C" NOT NULL,
            shard_id text COLLATE "C" NOT NULL REFERENCES ${NODE}(shard_id) ON DELETE RESTRICT,
            vbucket integer NOT NULL,
            PRIMARY KEY (resource, lookup_key)
          )
        `);
        const existing = await client.query(`SELECT version, app_id, source_id, store_id FROM ${META} WHERE singleton = 1`);
        let provisioned = false;
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO ${META} (singleton, version, app_id, source_id, store_id, strategy, buckets, created_at)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7)`,
            [
              SHARD_DIRECTORY_VERSION,
              binding.appId,
              binding.sourceId,
              binding.storeId,
              binding.strategy ?? 'directory',
              binding.buckets ?? DEFAULT_SHARD_BUCKETS,
              Date.now(),
            ],
          );
          provisioned = true;
        } else {
          const row = existing.rows[0] as Record<string, unknown>;
          if (
            Number(row.version) !== SHARD_DIRECTORY_VERSION ||
            row.app_id !== binding.appId ||
            row.source_id !== binding.sourceId ||
            row.store_id !== binding.storeId
          ) {
            throw new Error(`Shard directory at "${binding.storeId}" is bound to another application, source, or layout version.`);
          }
        }
        await client.query('COMMIT');
        return Object.freeze({ version: SHARD_DIRECTORY_VERSION, provisioned });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  } finally {
    await manager.close();
  }
}

/** Check whether the `shard-directory` layout is present at the current version on `client`. */
export async function postgresShardDirectoryReady(client: PgQuery): Promise<boolean> {
  try {
    const { rows } = await client.query(`SELECT version FROM ${META} WHERE singleton = 1`);
    return rows.length > 0 && Number((rows[0] as Record<string, unknown>).version) === SHARD_DIRECTORY_VERSION;
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    if (code === '42P01' || code === '3F000') return false;
    throw error;
  }
}

function parseNodeRow(row: Record<string, unknown>): DirectoryShardNode {
  const buckets =
    typeof row.buckets_json === 'string' && row.buckets_json ? (JSON.parse(row.buckets_json) as ShardBucketRange[]) : undefined;
  return Object.freeze({
    shardId: row.shard_id as string,
    label: row.label as string,
    status: row.status as ShardStatus,
    ...(buckets ? { buckets } : {}),
    weight: Number(row.weight),
    updatedAt: Number(row.updated_at),
  });
}

function parseTenantRow(row: Record<string, unknown>): DirectoryTenantPlacement {
  return Object.freeze({
    tenantId: row.tenant_id as string,
    shardId: row.shard_id as string,
    status: row.status as DirectoryTenantStatus,
    displayName: (row.display_name as string | null) ?? null,
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  });
}

function parseHostRow(row: Record<string, unknown>): DirectoryHostEntry {
  return Object.freeze({
    host: row.host as string,
    tenantId: row.tenant_id as string,
    shardId: row.shard_id as string,
    app: row.app as string,
    kind: row.kind as 'subdomain' | 'custom',
    status: row.status as 'active' | 'pending' | 'failed',
    primary: Boolean(row.is_primary),
  });
}

/**
 * Open a PostgreSQL-backed `ShardDirectory` over `url`.
 *
 * Optionally attaches a `LISTEN mistri_shard_topology` client (on `listenUrl`
 * or `url`) so topology and placement updates invalidate every pod's cache
 * immediately.
 */
export async function openPostgresShardDirectory(
  url: string,
  options: {
    readonly listenUrl?: string;
    readonly listen?: boolean;
    readonly now?: () => number;
  } = {},
): Promise<ShardDirectory> {
  const manager: PgConnectionManager = sharedPgConnections(url, SMALL_STORE_POOL);
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let wakeListener: CommandEventListener | undefined;

  const fireListeners = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Listener errors never fail directory operations. */
      }
    }
  };

  let strategy: ShardStrategy = 'directory';
  let buckets = DEFAULT_SHARD_BUCKETS;

  try {
    const meta = await manager.withReadClient(async (client) => {
      if (!(await postgresShardDirectoryReady(client))) {
        throw new Error(`Shard directory store is missing or not at version ${SHARD_DIRECTORY_VERSION}.`);
      }
      const { rows } = await client.query(`SELECT strategy, buckets FROM ${META} WHERE singleton = 1`);
      return rows[0] as Record<string, unknown>;
    });
    strategy = (meta.strategy as ShardStrategy) ?? 'directory';
    buckets = Number(meta.buckets) || DEFAULT_SHARD_BUCKETS;
  } catch (error) {
    await manager.close();
    throw error;
  }

  if (options.listen !== false) {
    const target = options.listenUrl ?? (manager.pooler === 'transaction' ? undefined : url);
    if (target) {
      try {
        wakeListener = await listenForWake(target, SHARD_TOPOLOGY_CHANNEL, fireListeners);
      } catch {
        /* Behind a pooler without a direct listen URL, callers fall back to CachedShardDirectory TTL. */
      }
    }
  }

  const notifyInTx = async (client: PgQuery) => {
    await client.query(`SELECT pg_notify('${SHARD_TOPOLOGY_CHANNEL}', '')`);
  };

  const listShards = async (): Promise<readonly DirectoryShardNode[]> => {
    const { rows } = await (
      await manager.read()
    ).query(`SELECT shard_id, label, status, buckets_json, weight, updated_at FROM ${NODE} ORDER BY shard_id COLLATE "C"`);
    return Object.freeze(rows.map((row) => parseNodeRow(row as Record<string, unknown>)));
  };

  return {
    listShards,

    async registerShard(node) {
      if (!isShardId(node.shardId)) throw new RangeError(`Invalid shard id "${node.shardId}".`);
      const updatedAt = now();
      const bucketsJson = node.buckets ? JSON.stringify(node.buckets) : null;
      await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO ${NODE} (shard_id, label, status, buckets_json, weight, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (shard_id) DO UPDATE
               SET label = EXCLUDED.label, status = EXCLUDED.status, buckets_json = EXCLUDED.buckets_json,
                   weight = EXCLUDED.weight, updated_at = EXCLUDED.updated_at`,
            [node.shardId, node.label, node.status, bucketsJson, node.weight, updatedAt],
          );
          await notifyInTx(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      fireListeners();
      return Object.freeze({ ...node, updatedAt });
    },

    async updateShardStatus(shardId, status) {
      const updatedAt = now();
      const changed = await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          const res = await client.query(`UPDATE ${NODE} SET status = $2, updated_at = $3 WHERE shard_id = $1`, [
            shardId,
            status,
            updatedAt,
          ]);
          if (res.rowCount) await notifyInTx(client);
          await client.query('COMMIT');
          return Boolean(res.rowCount);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      if (changed) fireListeners();
      return changed;
    },

    async pickShardForNewTenant() {
      const { rows } = await (
        await manager.read()
      ).query(
        `SELECT n.shard_id, n.weight,
                COUNT(t.tenant_id) FILTER (WHERE t.status <> 'closed')::int AS active_tenants
         FROM ${NODE} n
         LEFT JOIN ${TENANT} t ON t.shard_id = n.shard_id
         WHERE n.status = 'active' AND n.weight > 0
         GROUP BY n.shard_id, n.weight
         ORDER BY (COUNT(t.tenant_id) FILTER (WHERE t.status <> 'closed')::double precision / n.weight) ASC, n.shard_id COLLATE "C" ASC
         LIMIT 1`,
      );
      if (!rows.length) throw new Error('No active shard with positive placement weight is available for new tenants.');
      return (rows[0] as Record<string, unknown>).shard_id as string;
    },

    async getTenant(tenantId) {
      const { rows } = await (
        await manager.read()
      ).query(`SELECT tenant_id, shard_id, status, display_name, version, updated_at FROM ${TENANT} WHERE tenant_id = $1`, [tenantId]);
      return rows.length ? parseTenantRow(rows[0] as Record<string, unknown>) : undefined;
    },

    async shardForTenant(tenantId) {
      const { rows } = await (await manager.read()).query(`SELECT shard_id FROM ${TENANT} WHERE tenant_id = $1`, [tenantId]);
      return rows.length ? ((rows[0] as Record<string, unknown>).shard_id as string) : undefined;
    },

    async placeTenant(input) {
      const updatedAt = now();
      const placed = await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          const { rows } = await client.query(
            `INSERT INTO ${TENANT} (tenant_id, shard_id, status, display_name, version, updated_at)
             VALUES ($1, $2, $3, $4, 1, $5)
             ON CONFLICT (tenant_id) DO UPDATE
               SET status = EXCLUDED.status,
                   display_name = COALESCE(EXCLUDED.display_name, ${TENANT}.display_name),
                   version = ${TENANT}.version + 1,
                   updated_at = EXCLUDED.updated_at
             WHERE ${TENANT}.shard_id = EXCLUDED.shard_id
             RETURNING tenant_id, shard_id, status, display_name, version, updated_at`,
            [input.tenantId, input.shardId, input.status ?? 'active', input.displayName ?? null, updatedAt],
          );
          if (!rows.length) {
            throw new Error(`Tenant "${input.tenantId}" is already placed on another shard.`);
          }
          await notifyInTx(client);
          await client.query('COMMIT');
          return parseTenantRow(rows[0] as Record<string, unknown>);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      fireListeners();
      return placed;
    },

    async setTenantStatus(tenantId, status) {
      const updatedAt = now();
      const updated = await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          const { rows } = await client.query(
            `UPDATE ${TENANT}
             SET status = $2, version = version + 1, updated_at = $3
             WHERE tenant_id = $1
             RETURNING tenant_id, shard_id, status, display_name, version, updated_at`,
            [tenantId, status, updatedAt],
          );
          if (rows.length) await notifyInTx(client);
          await client.query('COMMIT');
          return rows.length ? parseTenantRow(rows[0] as Record<string, unknown>) : undefined;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      if (updated) fireListeners();
      return updated;
    },

    async moveTenantPlacement(tenantId, targetShardId, status = 'active') {
      const updatedAt = now();
      const moved = await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          const { rows } = await client.query(
            `UPDATE ${TENANT}
             SET shard_id = $2, status = $3, version = version + 1, updated_at = $4
             WHERE tenant_id = $1
             RETURNING tenant_id, shard_id, status, display_name, version, updated_at`,
            [tenantId, targetShardId, status, updatedAt],
          );
          if (!rows.length) throw new Error(`Unknown tenant "${tenantId}".`);
          await client.query(`UPDATE ${ACCOUNT_TENANT} SET shard_id = $2 WHERE tenant_id = $1`, [tenantId, targetShardId]);
          await client.query(`UPDATE ${HOST} SET shard_id = $2 WHERE tenant_id = $1`, [tenantId, targetShardId]);
          await notifyInTx(client);
          await client.query('COMMIT');
          return parseTenantRow(rows[0] as Record<string, unknown>);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      fireListeners();
      return moved;
    },

    async indexAccountTenant(entry: DirectoryAccountTenant) {
      await manager.withWriteClient(async (client) => {
        await client.query(
          `INSERT INTO ${ACCOUNT_TENANT} (account_id, tenant_id, shard_id, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, tenant_id) DO UPDATE SET shard_id = EXCLUDED.shard_id, status = EXCLUDED.status`,
          [entry.accountId, entry.tenantId, entry.shardId, entry.status],
        );
      });
    },

    async removeAccountTenant(accountId, tenantId) {
      await manager.withWriteClient(async (client) => {
        await client.query(`DELETE FROM ${ACCOUNT_TENANT} WHERE account_id = $1 AND tenant_id = $2`, [accountId, tenantId]);
      });
    },

    async tenantsForAccount(accountId) {
      const { rows } = await (
        await manager.read()
      ).query(
        `SELECT account_id, tenant_id, shard_id, status FROM ${ACCOUNT_TENANT}
         WHERE account_id = $1 AND status = 'active'
         ORDER BY tenant_id COLLATE "C"`,
        [accountId],
      );
      return Object.freeze(
        rows.map((row) => {
          const r = row as Record<string, unknown>;
          return Object.freeze({
            accountId: r.account_id as string,
            tenantId: r.tenant_id as string,
            shardId: r.shard_id as string,
            status: r.status as 'active' | 'revoked',
          });
        }),
      );
    },

    async upsertHost(entry) {
      const host = entry.host.toLowerCase();
      await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO ${HOST} (host, tenant_id, shard_id, app, kind, status, is_primary)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (host) DO UPDATE
               SET tenant_id = EXCLUDED.tenant_id, shard_id = EXCLUDED.shard_id, app = EXCLUDED.app,
                   kind = EXCLUDED.kind, status = EXCLUDED.status, is_primary = EXCLUDED.is_primary`,
            [host, entry.tenantId, entry.shardId, entry.app, entry.kind, entry.status, entry.primary],
          );
          await notifyInTx(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      fireListeners();
    },

    async removeHost(host) {
      const removed = await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          const res = await client.query(`DELETE FROM ${HOST} WHERE host = $1`, [host.toLowerCase()]);
          if (res.rowCount) await notifyInTx(client);
          await client.query('COMMIT');
          return Boolean(res.rowCount);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      if (removed) fireListeners();
      return removed;
    },

    async getHost(host) {
      const { rows } = await (
        await manager.read()
      ).query(`SELECT host, tenant_id, shard_id, app, kind, status, is_primary FROM ${HOST} WHERE host = $1`, [host.toLowerCase()]);
      return rows.length ? parseHostRow(rows[0] as Record<string, unknown>) : undefined;
    },

    async listHosts() {
      const { rows } = await (
        await manager.read()
      ).query(`SELECT host, tenant_id, shard_id, app, kind, status, is_primary FROM ${HOST} ORDER BY host COLLATE "C"`);
      return Object.freeze(rows.map((row) => parseHostRow(row as Record<string, unknown>)));
    },

    async putLookup(entry: DirectoryLookupEntry) {
      await manager.withWriteClient(async (client) => {
        await client.query(
          `INSERT INTO ${LOOKUP} (resource, lookup_key, shard_id, vbucket)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (resource, lookup_key) DO UPDATE SET shard_id = EXCLUDED.shard_id, vbucket = EXCLUDED.vbucket`,
          [entry.resource, entry.lookupKey, entry.shardId, entry.vbucket],
        );
      });
    },

    async getLookup(resource, lookupKey) {
      const { rows } = await (
        await manager.read()
      ).query(`SELECT resource, lookup_key, shard_id, vbucket FROM ${LOOKUP} WHERE resource = $1 AND lookup_key = $2`, [
        resource,
        lookupKey,
      ]);
      if (!rows.length) return undefined;
      const r = rows[0] as Record<string, unknown>;
      return Object.freeze({
        resource: r.resource as string,
        lookupKey: r.lookup_key as string,
        shardId: r.shard_id as string,
        vbucket: Number(r.vbucket),
      });
    },

    async removeLookup(resource, lookupKey) {
      const res = await manager.withWriteClient((client) =>
        client.query(`DELETE FROM ${LOOKUP} WHERE resource = $1 AND lookup_key = $2`, [resource, lookupKey]),
      );
      return Boolean(res.rowCount);
    },

    async router(): Promise<ShardRouter> {
      const nodes = await listShards();
      return createShardRouter({
        strategy,
        buckets,
        shards: nodes.map((node) => ({
          id: node.shardId,
          status: node.status,
          ...(node.buckets ? { buckets: node.buckets } : {}),
        })),
      });
    },

    onTopologyChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async close() {
      listeners.clear();
      await wakeListener?.close();
      await manager.close();
    },
  };
}
