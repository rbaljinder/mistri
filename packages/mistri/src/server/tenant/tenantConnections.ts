/**
 * The pools a tenant App's request paths share on one database.
 *
 * Its reader, its discovery, its writer (with record history, inbox and live stores), administration and support
 * each opened a manager of their own, so one process could hold `3R + 6W + 5` connections on its database before
 * the jobs host's, outbox's and integrations' (docs/postgresql.md) — a field deployment whose role allowed eighteen
 * could not be sized to fit at all, ran four-and-four pools, and still answered busy under a burst. They are one
 * manager now (postgresPool.ts sharedPgConnections): `R` readers, `W` writers and the background writer for all of
 * them, each still with its own write lanes, so a record's saves keep their order. The server's own stores sit on
 * a manager of their own (connectionBudget.ts RUNTIME_STORE_POOL), so a burst of job claims never takes a writer a
 * person's save is waiting for.
 *
 * Its readers pipeline: a snapshot's BEGIN, its membership and its read leave in one flight (tenantReadSource.ts).
 * Every other holder asks one statement at a time, which a pipelining client sends exactly as before.
 */
import { sharedPostgresAdapter, type PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import { poolSizes } from '@mistriwork/engine/adapters/postgresPool.js';

const TENANT_REQUEST_POOL = Object.freeze({ pipelineReads: true });

/* The `"pool"` of each tenant database's connection, by URL (declareTenantPool): what `tenantAdapter` sizes the shared
   manager with, ahead of `--read-pool` and `--write-pool`, as an ordinary App's connection does (Registry.dial). */
const declared = new Map<string, { readonly read?: number; readonly write?: number }>();

/** Say what `pool` the tenant App's connection on `url` has (none, the process's settings size it). */
export function declareTenantPool(url: string, pool: { read?: number; write?: number } | undefined): void {
  declared.set(url, Object.freeze({ ...pool }));
}

/** Forget every declared pool: a test's, between hosts. */
export function forgetTenantPools(): void {
  declared.clear();
}

/** The readers and writers the request pool on `url` takes: the connection's `"pool"`, else the process's settings. */
function tenantPoolSizes(url: string): { readers: number; writers: number } {
  const pool = declared.get(url);
  return poolSizes({
    ...(pool?.read !== undefined ? { readers: pool.read } : {}),
    ...(pool?.write !== undefined ? { writers: pool.write } : {}),
  });
}

/** The readers of the widest request pool declared, or the process's default: what the arrival gate halves (tenantArrivals.ts). */
export function tenantRequestReaders(): number {
  const sizes = [...declared.keys()].map((url) => tenantPoolSizes(url).readers);
  return sizes.length ? Math.max(...sizes) : poolSizes().readers;
}

/**
 * An adapter of the tenant host's on `url`: its own catalog, lanes and stores, the database's one request pool. A
 * replica's holds its readers only (`replica`): its writers and background writer are never opened.
 */
export function tenantAdapter(url: string, label: string, replica = false): PostgresAdapter {
  const { readers, writers } = tenantPoolSizes(url);
  return sharedPostgresAdapter(url, label, { ...TENANT_REQUEST_POOL, readers, writers, ...(replica ? { readersOnly: true } : {}) });
}
