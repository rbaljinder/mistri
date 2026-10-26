/**
 * Turn whatever the user typed into an adapter.
 *
 * There is exactly one place that decides which dialect a string means, so
 * adding a third database later is a case here rather than a search through
 * the server.
 */
import type { Adapter } from './adapter.js';
import { SqliteAdapter } from './sqlite.js';
import { PostgresAdapter } from './postgres.js';
import { MysqlAdapter } from './mysql.js';
import type { PgConnectionOptions } from './postgresPool.js';
import type { NetworkPolicy } from './net/networkPolicy.js';

interface ConnectOptions {
  /**
   * Restrict Postgres introspection to these schemas.
   *
   * MySQL has no second level of namespacing — a database *is* a schema — so
   * for a MySQL URL these are further databases to browse alongside the one
   * the URL selects, which is the same sentence with the same meaning.
   */
  schemas?: string[];
  /** Display name; defaults to something derived and password-free. */
  label?: string;
  /** A PostgreSQL connection's pool, as its config entry sizes it; the
   * process defaults fill the rest. Every other dialect ignores it. */
  postgres?: PgConnectionOptions;
  /** A MySQL source's App writer pool; the process default fills an omitted size. */
  mysql?: { writers?: number };
  /** Read replicas of a PostgreSQL or MySQL database, already resolved: lag-tolerant reads go to them (replicas.ts). */
  replicas?: readonly string[];
  /** Set when an untrusted client typed the address: it is dialled sealed, through this policy (net/untrustedDatabase.ts). */
  network?: NetworkPolicy;
}

export function connect(target: string, options: ConnectOptions = {}): Adapter {
  const replicas = options.replicas?.length ? options.replicas : undefined;
  if (/^postgres(ql)?:\/\//i.test(target)) {
    if (replicas?.some((url) => !/^postgres(ql)?:\/\//i.test(url)))
      throw new Error("A PostgreSQL connection's replicas are postgres://… URLs.");
    const pool =
      replicas || options.network ? { ...options.postgres, ...(replicas ? { replicas } : {}), network: options.network } : options.postgres;
    return new PostgresAdapter(target, options.label, options.schemas ?? [], undefined, pool);
  }
  /* `mariadb://` too: MariaDB speaks the MySQL protocol and its catalog is
     the same `information_schema`, so refusing the scheme would be turning
     someone away from a database this adapter can already read. */
  if (/^(mysql|mariadb):\/\//i.test(target)) {
    if (replicas?.some((url) => !/^(mysql|mariadb):\/\//i.test(url))) throw new Error("A MySQL connection's replicas are mysql://… URLs.");
    return new MysqlAdapter(target, options.label, options.schemas ?? [], options.mysql?.writers, replicas, options.network);
  }
  /* Said before the file is opened: a SQLite file is read where it lies,
     and a copy of it elsewhere would be another database, not a replica. */
  if (replicas && (/^sqlite:/i.test(target) || /\.(db|sqlite|sqlite3)$/i.test(target) || !target.includes('://')))
    throw new Error('SQLite has no replicas: a file is read where it is. Remove "replicas".');
  if (/^sqlite:/i.test(target)) {
    const file = target.replace(/^sqlite:(\/\/)?/i, '');
    return new SqliteAdapter(file, options.label ?? file);
  }
  // A bare path is a SQLite file. This is the common case for the demo and
  // for anyone poking at an app's local database, so it needs no scheme.
  if (/\.(db|sqlite|sqlite3)$/i.test(target) || !target.includes('://')) {
    return new SqliteAdapter(target, options.label ?? target);
  }
  /* The scheme, not the target.
  
     `target` here is the *resolved* connection string — the password has
     already been expanded into it — and this message was stored on the
     connection entry and served to the browser from then on. The scheme is
     the whole of the useful content anyway: what is wrong is the protocol,
     and repeating the credentials does not help anyone fix it. */
  const scheme = target.match(/^([a-z][\w+.-]*):\/\//i)?.[1];
  throw new Error(
    `Don't know how to open ${scheme ? `a "${scheme}://" connection` : 'that connection'}. ` +
      'Supported: a SQLite file path, sqlite:<path>, postgres://… or mysql://…',
  );
}
