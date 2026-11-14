/**
 * A connection's `"pool"` and `"replicas"` in tablewalk.json, checked where the file is read:
 * `{ "read": n, "write": m }`, each a whole number from 1 to 64 and either
 * one optional, on a PostgreSQL connection. Apart from the loader because
 * the rule is the pool's (postgresPool.ts holds the bounds); the loader only
 * asks it, as it asks httpConnection.ts about an API's fields.
 */
import { isReaderCount, MAX_READERS } from '../adapters/postgresPool.js';
import { isWriterCount, MAX_WRITERS } from '../adapters/writeLanes.js';
import { MAX_REPLICAS } from '../adapters/replicas.js';

/** A connection's pool as its entry sizes it; what it leaves out is the process default. */
export interface PoolSize {
  read?: number;
  write?: number;
}

/**
 * Refused rather than clamped or ignored, as `writable` is: a number quietly
 * overridden is a capacity plan that is not the one in the file. An HTTP
 * connection has no pool, and neither has a URL that plainly names another
 * engine; one that is still a `${VAR}` reference is checked when it opens
 * (Registry.dial), once the environment has said what it names. `write`
 * sizes the writers an App writes through; the database browser writes
 * through one whatever it says (writeLanes.ts).
 */
export function poolOf(entry: Record<string, unknown>, http: boolean, path: string): PoolSize | undefined {
  const written = entry.pool;
  if (written === undefined) return undefined;
  const where = `${path}: connection "${String(entry.name)}"`;
  if (http) throw new Error(`${where} is an HTTP connection; "pool" sizes database connections.`);
  if (!written || typeof written !== 'object' || Array.isArray(written)) {
    throw new Error(`${where} has "pool": ${JSON.stringify(written)}. It must be an object such as { "read": 16, "write": 8 }.`);
  }
  const pool = written as Record<string, unknown>;
  const stray = Object.keys(pool).find((key) => key !== 'read' && key !== 'write');
  if (stray !== undefined) throw new Error(`${where} has "pool.${stray}". A pool takes "read" and "write".`);
  if (pool.read === undefined && pool.write === undefined) {
    throw new Error(
      `${where} has an empty "pool". Say how many connections may read or write at once, such as { "read": 16, "write": 8 }.`,
    );
  }
  if (pool.read !== undefined && !isReaderCount(pool.read)) {
    throw new Error(
      `${where} has "pool": { "read": ${JSON.stringify(pool.read)} }. It must be a whole number from 1 to ${MAX_READERS}, without quotes.`,
    );
  }
  if (pool.write !== undefined && !isWriterCount(pool.write)) {
    throw new Error(
      `${where} has "pool": { "write": ${JSON.stringify(pool.write)} }. It must be a whole number from 1 to ${MAX_WRITERS}, without quotes.`,
    );
  }
  const url = String(entry.url);
  if (!url.includes('$')) {
    if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error(`${where} is not a PostgreSQL connection; SQLite has no pool. Remove "pool".`);
  }
  return { ...(pool.read !== undefined ? { read: pool.read } : {}), ...(pool.write !== undefined ? { write: pool.write as number } : {}) };
}

/**
 * A connection's `"replicas"`: `["postgres://…", "${REPLICA_URL}", …]`, read
 * replicas of the database `url` names, each a URL of the same engine and
 * each resolved as `url` is (`${VAR}`, keychain, credentials file). Up to
 * MAX_REPLICAS. Refused for SQLite and HTTP, where nothing could replicate,
 * rather than quietly ignored: a replica plan that is not happening is a
 * capacity plan that is not the one in the file. A URL that is still a
 * reference is checked when it opens (Registry.dial).
 */
export function replicasOf(entry: Record<string, unknown>, http: boolean, path: string): string[] | undefined {
  const written = entry.replicas;
  if (written === undefined) return undefined;
  const where = `${path}: connection "${String(entry.name)}"`;
  if (http) throw new Error(`${where} is an HTTP connection; "replicas" are copies of a database.`);
  if (!Array.isArray(written) || !written.length || written.some((url) => typeof url !== 'string' || !url.trim())) {
    throw new Error(
      `${where} has "replicas": ${JSON.stringify(written)}. It must be a list of database URLs, such as ["postgres://reader@replica-1/app"].`,
    );
  }
  if (written.length > MAX_REPLICAS) throw new Error(`${where} names ${written.length} replicas; at most ${MAX_REPLICAS}.`);
  const replicas = (written as string[]).map((url) => url.trim());
  if (new Set(replicas).size !== replicas.length) throw new Error(`${where} names one replica twice in "replicas".`);
  const url = String(entry.url);
  if (!url.includes('$')) {
    const engine = replicaEngine(url);
    if (!engine) throw new Error(`${where} is not a PostgreSQL connection; SQLite has no replicas. Remove "replicas".`);
    const stray = replicas.find((replica) => !replica.includes('$') && replicaEngine(replica) !== engine);
    if (stray !== undefined) throw new Error(`${where} has a replica that is not a ${engine} URL; a replica is the same engine as "url".`);
  }
  return replicas;
}

/**
 * A connection's `"listen"`: a direct PostgreSQL URL (`"postgres://app@db:5432/app"`, or `${VAR}`) a jobs host
 * holds its `LISTEN` on. Behind a transaction-mode pooler a session keeps no server connection between
 * statements, so the main `url` cannot listen; this one names the database without the pooler. Refused for
 * anything but PostgreSQL rather than ignored: a wake that is not happening is a 30-second wait nobody chose.
 */
export function listenOf(entry: Record<string, unknown>, http: boolean, path: string): string | undefined {
  const written = entry.listen;
  if (written === undefined) return undefined;
  const where = `${path}: connection "${String(entry.name)}"`;
  if (http) throw new Error(`${where} is an HTTP connection; "listen" is a database URL to wait for notifications on.`);
  if (typeof written !== 'string' || !written.trim()) {
    throw new Error(
      `${where} has "listen": ${JSON.stringify(written)}. It must be a PostgreSQL URL, such as "postgres://app@db-direct:5432/app".`,
    );
  }
  const listen = written.trim();
  if (!listen.includes('$') && replicaEngine(listen) !== 'PostgreSQL')
    throw new Error(`${where} has a "listen" that is not a PostgreSQL URL; only PostgreSQL has LISTEN/NOTIFY.`);
  const url = String(entry.url);
  if (!url.includes('$') && replicaEngine(url) !== 'PostgreSQL')
    throw new Error(`${where} is not a PostgreSQL connection, so it has nothing to listen on. Remove "listen".`);
  return listen;
}

/**
 * A connection's `"backstop": "rls"` and its `"owner"`: the database's row-level security as a second wall behind
 * the tenant scope (docs/postgresql.md). `url` and `replicas` then name the runtime role, which owns nothing and
 * reads under the pinned policy; `owner` names the role that owns the tables and serves what crosses tenants by
 * design. Both or neither: a backstop with no owner has nobody to resolve a public address or run the jobs that
 * read every tenant, and an owner with no backstop is a second pool doing what `url` does. Refused for HTTP and
 * SQLite, which have no roles to separate.
 */
export function backstopOf(entry: Record<string, unknown>, http: boolean, path: string): { owner: string; backstop: 'rls' } | undefined {
  const { owner, backstop } = entry;
  if (owner === undefined && backstop === undefined) return undefined;
  const where = `${path}: connection "${String(entry.name)}"`;
  if (http) throw new Error(`${where} is an HTTP connection; "backstop" and "owner" separate database roles. Remove them.`);
  if (backstop === undefined) {
    throw new Error(
      `${where} has "owner" without "backstop". The owner's URL is only used under "backstop": "rls"; add it, or remove "owner".`,
    );
  }
  if (backstop !== 'rls') throw new Error(`${where} has "backstop": ${JSON.stringify(backstop)}. The one backstop is "rls".`);
  if (owner === undefined) {
    throw new Error(
      `${where} has "backstop": "rls" without "owner". Add "owner": the URL of the role that owns the tables, such as "\${OWNER_URL}".`,
    );
  }
  if (typeof owner !== 'string' || !owner.trim()) {
    throw new Error(`${where} has "owner": ${JSON.stringify(owner)}. It must be a PostgreSQL URL, such as "postgres://owner@db:5432/app".`);
  }
  const written = owner.trim();
  if (!written.includes('$') && replicaEngine(written) !== 'PostgreSQL')
    throw new Error(`${where} has an "owner" that is not a PostgreSQL URL; the backstop is PostgreSQL's row-level security.`);
  const url = String(entry.url);
  if (!url.includes('$') && replicaEngine(url) !== 'PostgreSQL')
    throw new Error(`${where} is not a PostgreSQL connection; SQLite has no roles or row-level security. Remove "backstop" and "owner".`);
  return { owner: written, backstop: 'rls' };
}

/** Which engine a URL names, for a replica's agreement with its primary; undefined for anything else. */
export function replicaEngine(url: string): 'PostgreSQL' | undefined {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'PostgreSQL';
  return undefined;
}
