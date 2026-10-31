/**
 * The seam a search provider plugs into: the four things App search asks of
 * an index (appSearchRuntime.ts) and nothing of any engine's own shape.
 *
 * Core rides on the database. A resource's `search` block names a connection
 * and the fields an index holds; what answers it is a provider, and the
 * providers are packs (packs/search-typesense is the first, packs/search-sqlite
 * the second), not core, so a deployment that wants Typesense, SQLite FTS5 or
 * another engine chooses it and core never carries a vendor's client or config. Without a provider plugged in, a
 * `search` block is refused at startup and a text filter runs on the database.
 *
 * Internal on purpose: nothing exports it from an entry point, so it does not
 * freeze at 1.0. The packs ship after 1.0 and consume it then, when it is
 * made public with the API they need.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';

/** The index did not answer: the search falls back to the database, and the message names the connection, never its key. */
export class SearchUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchUnavailable';
  }
}

/** One indexed record: the key as `id`, the declared fields as text. */
export type SearchDocument = { id: string } & Record<string, string>;

/** Only the documents whose `field` holds `value` exactly: a tenant's. The provider writes it in its engine's terms. */
export interface SearchScope {
  field: string;
  value: string;
}

/** One search connection's index. */
export interface SearchIndex {
  /** Collections are `<prefix>_<app>_<resource>` (appSearch.ts), so deployments can share one engine. */
  readonly collectionPrefix: string;
  /** The collection exists and holds every field named, each optional text; a field added later is added. */
  ensureCollection(name: string, fields: readonly string[]): Promise<void>;
  upsert(collection: string, document: SearchDocument): Promise<void>;
  /** Gone from the index; a document that was never there is gone already. */
  remove(collection: string, id: string): Promise<void>;
  /** The keys of the best matches for `phrase` across `fields`, best first, at most `limit`; a collection never indexed matches nothing. */
  search(collection: string, phrase: string, fields: readonly string[], limit: number, scope?: SearchScope): Promise<string[]>;
}

/** What a pack hands core: the index a `search.connection` names, or undefined when it has none of that name. */
export interface SearchProvider {
  index(connection: string): SearchIndex | undefined;
}

const held = (registry: Registry) =>
  registry.serviceState('search-provider', () => ({ provider: undefined as SearchProvider | undefined }));

/** Plug a provider into this registry: every App it serves searches through it. */
export function plugSearch(registry: Registry, provider: SearchProvider): void {
  held(registry).provider = provider;
}

/** The registry's provider; undefined when none is plugged in, and then every search runs on the database. */
export function searchProviderOf(registry: Registry): SearchProvider | undefined {
  return held(registry).provider;
}

/** Said when a `search` block meets a registry with no provider. */
export const NO_SEARCH_PROVIDER =
  'no search provider is plugged in. Search providers are packs (Typesense is @mistriwork/search-typesense, SQLite FTS5 is @mistriwork/search-sqlite), which ship after 1.0; ' +
  'until then remove the "search" block, name the connection "memory" for the built-in in-memory provider, and a text filter runs on the database.';
