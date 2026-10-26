/**
 * @mistriwork/search-typesense: Typesense as an App's search provider.
 *
 * Core asks a provider for the index a resource's `search.connection` names
 * (packages/mistri/src/server/app/searchProvider.ts); this pack answers with a Typesense
 * client over core's egress, one per connection, opened on first use. The
 * connection is written as it was in mistri.json before search left core:
 *
 *   { "name": "search", "url": "https://search.internal:8108",
 *     "auth": { "apiKey": "${TYPESENSE_API_KEY}" }, "collectionPrefix": "acme" }
 *
 * and checked by `typesenseConnectionOf` the same way. Unpublished until
 * after 1.0: it reaches into core by path, and the seam it plugs into is
 * internal until then.
 */
import { expandEnvReferences } from '../../../packages/engine/src/server/auth/credentials.js';
import { egressPolicyOf } from '../../../packages/engine/src/server/cacheService.js';
import { SHARED_SERVICE_KEYS, checkServiceKeys } from '../../../packages/engine/src/server/configSections.js';
import type { SearchProvider } from '../../../packages/mistri/src/server/app/searchProvider.js';
import { TypesenseClient } from './typesenseClient.js';

export { TypesenseClient } from './typesenseClient.js';

export interface TypesenseConnectionConfig {
  name: string;
  url: string;
  auth?: { apiKey: string };
  /** Collections are `<prefix>_<app>_<resource>`, so deployments can share one engine. Default `mistri`. */
  collectionPrefix?: string;
  insecure?: boolean;
  allowLinkLocal?: boolean;
}

const KEYS = [...SHARED_SERVICE_KEYS, 'collectionPrefix'];

/** A connection entry, checked; `where` names it in a refusal. A config someone wrote is refused rather than half-read. */
export function typesenseConnectionOf(entry: Record<string, unknown>, where: string): TypesenseConnectionConfig {
  checkServiceKeys(entry, 'search', KEYS, where);
  if (typeof entry.name !== 'string' || !entry.name) throw new Error(`${where} has no "name".`);
  if (typeof entry.url !== 'string' || !entry.url) throw new Error(`${where} has no "url".`);
  const url = entry.url;
  // A URL that is still a reference is checked when it opens, once the environment has said what it is.
  if (!url.includes('${')) searchBase(url, entry.insecure === true, where);
  if (
    entry.collectionPrefix !== undefined &&
    (typeof entry.collectionPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(entry.collectionPrefix))
  ) {
    throw new Error(`${where} has a "collectionPrefix" that is not a name of letters, digits and underscores, starting with a letter.`);
  }
  return {
    name: entry.name,
    url,
    ...(entry.insecure === true ? { insecure: true } : {}),
    ...(entry.allowLinkLocal === true ? { allowLinkLocal: true } : {}),
    ...(entry.auth !== undefined ? { auth: searchAuth(entry.auth, where) } : {}),
    ...(typeof entry.collectionPrefix === 'string' ? { collectionPrefix: entry.collectionPrefix } : {}),
  };
}

function searchAuth(value: unknown, where: string): { apiKey: string } {
  const auth = value as Record<string, unknown>;
  const keys = auth && typeof auth === 'object' && !Array.isArray(auth) ? Object.keys(auth).join(',') : '';
  if (keys === 'apiKey' && typeof auth.apiKey === 'string' && auth.apiKey) return { apiKey: auth.apiKey };
  throw new Error(`${where} has an "auth" mistri cannot read. Write { "apiKey": "\${TYPESENSE_API_KEY}" }.`);
}

/* A search engine's base URL: https unless the operator said otherwise, no credential in it, ending in "/". */
function searchBase(text: string, insecure: boolean, where: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${where} has a "url" that is not a URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecure)) {
    throw new Error(
      `${where} has a ${url.protocol}// "url". Use https, or set "insecure": true for a search service on a trusted network.`,
    );
  }
  if (url.username || url.password) throw new Error(`${where} has a credential in its "url"; it belongs in "auth".`);
  if (url.search || url.hash) throw new Error(`${where} has a query or fragment in its "url"; the base is a path only.`);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/** Open one connection: a Typesense client over egress. Nothing is sent until the first call; credentials are expanded here, never logged. */
function openTypesense(connection: TypesenseConnectionConfig): TypesenseClient {
  const where = `connection "${connection.name}"`;
  return new TypesenseClient({
    base: searchBase(expandEnvReferences(connection.url), connection.insecure === true, where),
    label: connection.name,
    policy: egressPolicyOf(connection),
    ...(connection.auth ? { apiKey: expandEnvReferences(connection.auth.apiKey) } : {}),
    ...(connection.collectionPrefix ? { collectionPrefix: connection.collectionPrefix } : {}),
  });
}

/** The provider core plugs in (`plugSearch(registry, typesenseSearch([...]))`): each connection by its name. */
export function typesenseSearch(connections: readonly TypesenseConnectionConfig[]): SearchProvider {
  const names = connections.map((connection) => connection.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) throw new Error(`A search connection named "${twice}" is already configured.`);
  const opened = new Map<string, TypesenseClient>();
  return {
    index(name) {
      const known = opened.get(name);
      if (known) return known;
      const connection = connections.find((each) => each.name === name);
      if (!connection) return undefined;
      const client = openTypesense(connection);
      opened.set(name, client);
      return client;
    },
  };
}
