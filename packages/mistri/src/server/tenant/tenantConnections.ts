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
import { declareBackstopRoles, forgetBackstopRoles } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import { poolSizes } from '@mistriwork/engine/adapters/postgresPool.js';

const TENANT_REQUEST_POOL = Object.freeze({ pipelineReads: true });

/* The `"pool"` of each tenant database's connection, by URL (declareTenantPool): what `tenantAdapter` sizes the shared
   manager with, ahead of `--read-pool` and `--write-pool`, as an ordinary App's connection does (Registry.dial). */
const declared = new Map<string, { readonly read?: number; readonly write?: number }>();

/** Say what `pool` the tenant App's connection on `url` has (none, the process's settings size it). */
export function declareTenantPool(url: string, pool: { read?: number; write?: number } | undefined): void {
  declared.set(url, Object.freeze({ ...pool }));
}

/** Forget every declared pool and backstop: a test's, between hosts. */
export function forgetTenantPools(): void {
  declared.clear();
  backstops.clear();
  forgetBackstopRoles();
}

/* The owner's pool under the row-security backstop: what crosses tenants by design (a public address resolved, the
   jobs' sweep of every tenant, administration, enrollment's catalog) is a small share of the traffic, and it must
   not take a connection the role's request pool is counting on. */
const OWNER_POOL = Object.freeze({ read: 2, write: 2 });

/* Each tenant database's backstop, by its runtime URL and each replica's (declareTenantBackstop). */
const backstops = new Map<string, Readonly<{ owner: string; role: string }>>();

/**
 * Say that the tenant database on `url` runs under the row-security backstop (docs/postgresql.md): `url` and
 * `replicas` connect as the runtime `role`, `owner` as `ownerRole`, which owns the tables. Declared once enrollment
 * has attested the pair (tenantEnrollment.ts); from then on `tenantAdapter` hands the runtime's adapters the role,
 * and an `'owner'` adapter the owner's own small pool.
 */
export function declareTenantBackstop(
  url: string,
  backstop: { owner: string; role: string; ownerRole: string; replicas?: readonly string[] },
): void {
  declareBackstopRoles(backstop.role, backstop.ownerRole);
  const entry = Object.freeze({ owner: backstop.owner, role: backstop.role });
  for (const each of [url, ...(backstop.replicas ?? [])]) backstops.set(each, entry);
  if (!declared.has(backstop.owner)) declareTenantPool(backstop.owner, OWNER_POOL);
}

/** The backstop declared on `url` — the owner's URL and the runtime role the pinned policy binds — or undefined. */
export function tenantBackstop(url: string): Readonly<{ owner: string; role: string }> | undefined {
  return backstops.get(url);
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
 *
 * `role`, under a declared backstop (declareTenantBackstop): `'runtime'` runs as the role the pinned policy binds,
 * so a scoped read or write must say its tenant (PostgresAdapterOptions.rowSecurity); `'owner'` runs on the owner's
 * URL and pool, which the policy does not bind, on the primary only. Without a backstop both are today's adapter.
 */
export function tenantAdapter(url: string, label: string, replica = false, role: 'runtime' | 'owner' = 'runtime'): PostgresAdapter {
  const backstop = backstops.get(url);
  if (backstop && role === 'owner') {
    const owner = tenantPoolSizes(backstop.owner);
    return sharedPostgresAdapter(
      backstop.owner,
      label,
      { ...TENANT_REQUEST_POOL, ...owner },
      { rowSecurity: { role: backstop.role, bypass: true } },
    );
  }
  const { readers, writers } = tenantPoolSizes(url);
  return sharedPostgresAdapter(
    url,
    label,
    { ...TENANT_REQUEST_POOL, readers, writers, ...(replica ? { readersOnly: true } : {}) },
    backstop ? { rowSecurity: { role: backstop.role } } : {},
  );
}
