/**
 * Turn whatever the user typed into an adapter.
 *
 * There is exactly one place that decides which dialect a string means, so
 * adding a database later is a case here rather than a search through
 * the server.
 */
import type { Adapter } from './adapter.js';
import { SqliteAdapter } from './sqlite.js';
import { PostgresAdapter } from './postgres.js';
import type { PgConnectionOptions } from './postgresPool.js';
import type { NetworkPolicy } from './net/networkPolicy.js';

interface ConnectOptions {
  /**
   * Restrict Postgres introspection to these schemas.
   */
  schemas?: string[];
  /** Display name; defaults to something derived and password-free. */
  label?: string;
  /** A PostgreSQL connection's pool, as its config entry sizes it; the
   * process defaults fill the rest. Every other dialect ignores it. */
  postgres?: PgConnectionOptions;
  /** Read replicas of a PostgreSQL database, already resolved: lag-tolerant reads go to them (replicas.ts). */
  replicas?: readonly string[];
  /** Set when an untrusted client typed the address: it is dialled sealed, through this policy (net/untrustedDatabase.ts). */
  network?: NetworkPolicy;
}

/** What a mysql:// or mariadb:// address, or a config that names one, is told. */
export const MYSQL_REFUSAL = 'MySQL is not supported; use PostgreSQL or SQLite.';

export function connect(target: string, options: ConnectOptions = {}): Adapter {
  const replicas = options.replicas?.length ? options.replicas : undefined;
  if (/^postgres(ql)?:\/\//i.test(target)) {
    if (replicas?.some((url) => !/^postgres(ql)?:\/\//i.test(url)))
      throw new Error("A PostgreSQL connection's replicas are postgres://… URLs.");
    const pool =
      replicas || options.network ? { ...options.postgres, ...(replicas ? { replicas } : {}), network: options.network } : options.postgres;
    return new PostgresAdapter(target, options.label, options.schemas ?? [], undefined, pool);
  }
  /* Said by name rather than as an unknown scheme: MySQL and MariaDB were never in 1.0, and a config that
     still names one should hear that, not "don't know how to open". */
  if (/^(mysql|mariadb):\/\//i.test(target)) throw new Error(MYSQL_REFUSAL);
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
      'Supported: a SQLite file path, sqlite:<path>, or postgres://…',
  );
}
