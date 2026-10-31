/**
 * @mistriwork/search-postgres: Postgres tsvector as an App's search provider.
 *
 * Core asks a provider for the index a resource's `search.connection` names
 * (packages/mistri/src/server/app/searchProvider.ts); this pack answers with
 * a tsvector table per collection in the database the connection names, over
 * `pg` — already an optional dependency of the engine, loaded on first use,
 * so the pack adds no dependency. The connection is written as the
 * deployment's own database URL:
 *
 *   { "name": "pgsearch", "url": "${DATABASE_URL}", "collectionPrefix": "acme" }
 *
 * and checked by `postgresSearchConnectionOf` the same way. Unpublished until
 * after 1.0: it reaches into core by path, and the seam it plugs into is
 * internal until then.
 *
 * A pool is opened on first use, never at plug-in, so a deployment that
 * declares the connection but serves no searched App never connects;
 * `${VAR}` references in `url` expand when it opens, as a service URL's do,
 * and are never logged. One database holds every collection, and one pool
 * serves every App in the process; `close()` is for tests and shutdown,
 * after which the next call reopens the pool. The index itself is tables
 * in Postgres, so it survives a restart and no reindex is needed after one.
 * The index is a copy: a record deleted outside the App keeps its document
 * until the next write or reindex, and searches already hide rows the
 * database no longer has.
 */
import { expandEnvReferences } from '../../../packages/engine/src/server/auth/credentials.js';
import type { SearchProvider } from '../../../packages/mistri/src/server/app/searchProvider.js';
import { PostgresTsvectorIndex } from './postgresTsvector.js';

export { PostgresTsvectorIndex } from './postgresTsvector.js';

export interface PostgresSearchConnectionConfig {
  name: string;
  /** The database that holds the index tables; a Postgres URL, as a mistri connection's `url` is. */
  url: string;
  /** Collections are `<prefix>_<app>_<resource>`, so deployments can share one database. Default `mistri`. */
  collectionPrefix?: string;
}

const KEYS = ['name', 'url', 'collectionPrefix'];

/** A connection entry, checked; `where` names it in a refusal. A config someone wrote is refused rather than half-read. */
export function postgresSearchConnectionOf(entry: Record<string, unknown>, where: string): PostgresSearchConnectionConfig {
  const unknown = Object.keys(entry).filter((key) => !KEYS.includes(key));
  if (unknown.length)
    throw new Error(
      `${where} names ${unknown.join(', ')}, which a Postgres search connection does not take (it takes ${KEYS.join(', ')}).`,
    );
  if (typeof entry.name !== 'string' || !entry.name) throw new Error(`${where} has no "name".`);
  if (typeof entry.url !== 'string' || !entry.url) throw new Error(`${where} has no "url".`);
  if (
    entry.collectionPrefix !== undefined &&
    (typeof entry.collectionPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(entry.collectionPrefix))
  ) {
    throw new Error(`${where} has a "collectionPrefix" that is not a name of letters, digits and underscores, starting with a letter.`);
  }
  return {
    name: entry.name,
    url: entry.url,
    ...(typeof entry.collectionPrefix === 'string' ? { collectionPrefix: entry.collectionPrefix } : {}),
  };
}

/** The provider core plugs in (`plugSearch(registry, postgresSearch([...]))`): each connection by its name. */
export function postgresSearch(connections: readonly PostgresSearchConnectionConfig[]): SearchProvider & { close(): Promise<void> } {
  const names = connections.map((connection) => connection.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) throw new Error(`A search connection named "${twice}" is already configured.`);
  const opened = new Map<string, PostgresTsvectorIndex>();
  const open = (connection: PostgresSearchConnectionConfig): PostgresTsvectorIndex => {
    const known = opened.get(connection.name);
    if (known) return known;
    const index = new PostgresTsvectorIndex(expandEnvReferences(connection.url), connection.collectionPrefix ?? 'mistri');
    opened.set(connection.name, index);
    return index;
  };
  return {
    index(name) {
      const connection = connections.find((each) => each.name === name);
      return connection ? open(connection) : undefined;
    },
    async close() {
      for (const index of opened.values()) await index.close();
      opened.clear();
    },
  };
}
