/**
 * @mistriwork/search-sqlite: SQLite FTS5 as an App's search provider.
 *
 * Core asks a provider for the index a resource's `search.connection` names
 * (packages/mistri/src/server/app/searchProvider.ts); this pack answers with
 * an FTS5 table per collection in one SQLite file, over Node's built-in
 * `node:sqlite` — no service, no SDK, no network. The connection is written
 * as the deployment's own file:
 *
 *   { "name": "fts", "file": "./search.db", "collectionPrefix": "acme" }
 *
 * and checked by `sqliteSearchConnectionOf` the same way. Unpublished until
 * after 1.0: it reaches into core by path, and the seam it plugs into is
 * internal until then.
 *
 * A file is opened on first use, never at plug-in, so a deployment that
 * declares the connection but serves no searched App never touches the
 * disk; `${VAR}` references in `file` expand when it opens, as a service
 * URL's do, and are never logged. One file holds every collection, and one
 * handle serves every App in the process; `close()` is for tests and
 * shutdown, after which the next call reopens the file.
 */
import { DatabaseSync } from 'node:sqlite';
import { expandEnvReferences } from '../../../packages/engine/src/server/auth/credentials.js';
import type { SearchProvider } from '../../../packages/mistri/src/server/app/searchProvider.js';
import { SqliteFtsIndex } from './sqliteFts.js';

export { SqliteFtsIndex } from './sqliteFts.js';

export interface SqliteSearchConnectionConfig {
  name: string;
  /** The index file; `:memory:` holds it in this process only, like the memory provider. */
  file: string;
  /** Collections are `<prefix>_<app>_<resource>`, so deployments can share one file. Default `mistri`. */
  collectionPrefix?: string;
}

const KEYS = ['name', 'file', 'collectionPrefix'];

/** A connection entry, checked; `where` names it in a refusal. A config someone wrote is refused rather than half-read. */
export function sqliteSearchConnectionOf(entry: Record<string, unknown>, where: string): SqliteSearchConnectionConfig {
  const unknown = Object.keys(entry).filter((key) => !KEYS.includes(key));
  if (unknown.length)
    throw new Error(`${where} names ${unknown.join(', ')}, which a SQLite search connection does not take (it takes ${KEYS.join(', ')}).`);
  if (typeof entry.name !== 'string' || !entry.name) throw new Error(`${where} has no "name".`);
  if (typeof entry.file !== 'string' || !entry.file) throw new Error(`${where} has no "file".`);
  if (
    entry.collectionPrefix !== undefined &&
    (typeof entry.collectionPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(entry.collectionPrefix))
  ) {
    throw new Error(`${where} has a "collectionPrefix" that is not a name of letters, digits and underscores, starting with a letter.`);
  }
  return {
    name: entry.name,
    file: entry.file,
    ...(typeof entry.collectionPrefix === 'string' ? { collectionPrefix: entry.collectionPrefix } : {}),
  };
}

/** The provider core plugs in (`plugSearch(registry, sqliteSearch([...]))`): each connection by its name. */
export function sqliteSearch(connections: readonly SqliteSearchConnectionConfig[]): SearchProvider & { close(): void } {
  const names = connections.map((connection) => connection.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) throw new Error(`A search connection named "${twice}" is already configured.`);
  const opened = new Map<string, { db: DatabaseSync; index: SqliteFtsIndex }>();
  const open = (connection: SqliteSearchConnectionConfig): SqliteFtsIndex => {
    const known = opened.get(connection.name);
    if (known) return known.index;
    const db = new DatabaseSync(expandEnvReferences(connection.file));
    /* node:sqlite is synchronous, so a lock held by another process stalls the event loop for as long as this waits.
       WAL lets a reader and a writer share the file without waiting on each other, and the short timeout bounds
       the wait that remains to a blip rather than five seconds of a frozen server. */
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 150');
    const index = new SqliteFtsIndex(db, connection.collectionPrefix ?? 'mistri');
    opened.set(connection.name, { db, index });
    return index;
  };
  return {
    index(name) {
      const connection = connections.find((each) => each.name === name);
      return connection ? open(connection) : undefined;
    },
    close() {
      for (const { db } of opened.values()) db.close();
      opened.clear();
    },
  };
}
