/**
 * An `http` connection in the config file: checked when the file is read,
 * opened when the connection is first used.
 *
 *   { "name": "Desk", "kind": "http", "url": "https://desk.example/v1/",
 *     "description": "desk.http.json", "auth": { "bearer": "${DESK_TOKEN}" },
 *     "cache": { "ttl": 60 } }
 *
 * The description is the file `tablewalk --from-openapi` drafts, found
 * relative to the config file so the two travel together — or the description
 * itself, inline, which is what `--openapi` drafts in memory and what saving
 * such a connection writes. The credential is written as a `${VAR}` reference
 * and expanded only here, at open, into a header the adapter hands to egress;
 * it is never stored expanded, never sent to the browser, and never attached
 * to a URL a browser supplied. `cache` opts the connection's reads into the
 * deployment's cache (the process's own, or the Valkey a `"kind": "cache"`
 * connection names) for `ttl` seconds.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DEFAULT_POLICY } from '../adapters/http/egress.js';
import { HttpAdapter, type HttpAuth } from '../adapters/http/httpAdapter.js';
import { readDescription, type HttpDescription } from '../adapters/http/httpDescription.js';
import type { CacheStore } from '../adapters/cache/cacheStore.js';
import type { SecretSource } from '../shared/connection.js';
import { expandEnvReferences } from './auth/credentials.js';
import { product } from './product.js';

/** As written in the config file: either a bearer token or one named header, `${VAR}` references intact. */
export type HttpAuthConfig = { bearer: string } | { header: string; value: string };

export interface HttpConnectionConfig {
  /** The description file as written, relative to the config file, or the description itself; written back as it is on save. */
  description: string | HttpDescription;
  /** A description file, resolved against the config file's directory. */
  descriptionPath?: string;
  auth?: HttpAuthConfig;
  /** Plain `http:` to the API. */
  insecure?: boolean;
  /** Link-local addresses, where cloud metadata answers. */
  allowLinkLocal?: boolean;
  /** Reads answered from the cache for `ttl` seconds after the API answered them. */
  cache?: { ttl: number };
}

const HTTP_ONLY = ['description', 'auth', 'insecure', 'allowLinkLocal', 'cache'] as const;
/* RFC 9110's token, minus the headers the request itself owns. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const OWNED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'cookie']);
/* A day: an answer older than that is not a cached answer, it is a copy. */
const MAX_CACHE_TTL_SECONDS = 86_400;

/**
 * An entry's HTTP fields, checked: the resolved block for an `http`
 * connection, undefined for a database. Throws naming the field, because a
 * config someone wrote is refused rather than half-read. Service kinds
 * (`cache`, `webhook`, …) are read by serviceConnections.ts before this is asked.
 */
export function httpConnectionOf(entry: Record<string, unknown>, path: string): HttpConnectionConfig | undefined {
  const where = `${path}: connection "${String(entry.name)}"`;
  if (entry.kind === undefined) {
    const stray = HTTP_ONLY.find((key) => entry[key] !== undefined);
    if (stray) throw new Error(`${where} has "${stray}", which only an HTTP connection takes. Add "kind": "http", or remove it.`);
    return undefined;
  }
  /* Said by name rather than as an unknown kind: a config written for 0.9.5 or earlier had one, and the reader should learn where it went. */
  if (entry.kind === 'search') {
    throw new Error(
      `${where} has "kind": "search". Search providers are not part of ${product()}: they are packs (Typesense is @mistriwork/search-typesense, SQLite FTS5 is @mistriwork/search-sqlite, Postgres tsvector is @mistriwork/search-postgres), which ship after 1.0. Remove the entry, and a text filter runs on the database.`,
    );
  }
  if (entry.kind !== 'http') {
    throw new Error(
      `${where} has "kind": ${JSON.stringify(entry.kind)}. The kinds are "http", "cache" and "webhook"; a database needs none.`,
    );
  }
  // Writes to an API arrive with their own slice; until then a flag saying otherwise would be a promise nothing keeps.
  if (entry.writable === true) throw new Error(`${where} is an HTTP connection, which is read-only; remove "writable".`);
  if (entry.schemas !== undefined) throw new Error(`${where} is an HTTP connection; "schemas" belongs to Postgres.`);
  const written = entry.description;
  let description: string | HttpDescription;
  if (typeof written === 'string' && written) description = written;
  else if (written && typeof written === 'object' && !Array.isArray(written))
    description = readDescription(written, `${where}: "description"`);
  else
    throw new Error(
      `${where} needs a "description": the file ${product()} --from-openapi drafts from the API's spec, or the description itself.`,
    );
  for (const flag of ['insecure', 'allowLinkLocal'] as const) {
    if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
      throw new Error(`${where} has "${flag}": ${JSON.stringify(entry[flag])}. It must be true or false, without quotes.`);
    }
  }
  // A base URL that is still a reference is checked when it opens, once the environment has said what it is.
  if (!String(entry.url).includes('${')) baseUrl(String(entry.url), entry.insecure === true, where);
  return {
    description,
    ...(typeof description === 'string' ? { descriptionPath: resolve(dirname(path), description) } : {}),
    ...(entry.auth !== undefined ? { auth: authOf(entry.auth, where) } : {}),
    ...(entry.insecure === true ? { insecure: true } : {}),
    ...(entry.allowLinkLocal === true ? { allowLinkLocal: true } : {}),
    ...(entry.cache !== undefined ? { cache: cacheOf(entry.cache, where) } : {}),
  };
}

function cacheOf(value: unknown, where: string): { ttl: number } {
  const cache = value as Record<string, unknown>;
  const keys = cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.keys(cache).join(',') : '';
  if (keys === 'ttl' && Number.isSafeInteger(cache.ttl) && (cache.ttl as number) >= 1 && (cache.ttl as number) <= MAX_CACHE_TTL_SECONDS) {
    return { ttl: cache.ttl as number };
  }
  throw new Error(
    `${where} has a "cache" ${product()} cannot read. Write { "ttl": 60 }: whole seconds, from 1 to ${MAX_CACHE_TTL_SECONDS}.`,
  );
}

function authOf(value: unknown, where: string): HttpAuthConfig {
  const auth = value as Record<string, unknown>;
  const keys = auth && typeof auth === 'object' && !Array.isArray(auth) ? Object.keys(auth).sort().join(',') : '';
  if (keys === 'bearer' && typeof auth.bearer === 'string' && auth.bearer) return { bearer: auth.bearer };
  if (keys === 'header,value' && typeof auth.header === 'string' && typeof auth.value === 'string' && auth.value) {
    if (!HEADER_NAME.test(auth.header) || OWNED_HEADERS.has(auth.header.toLowerCase())) {
      throw new Error(`${where} has "auth.header": ${JSON.stringify(auth.header)}, which is not a header a credential can travel in.`);
    }
    return { header: auth.header, value: auth.value };
  }
  throw new Error(
    `${where} has an "auth" ${product()} cannot read. Write { "bearer": "\${TOKEN}" } or { "header": "x-api-key", "value": "\${KEY}" }.`,
  );
}

/* The base every description path resolves under: https unless the operator
   said otherwise, no credential in it, and ending in "/" so a relative path
   extends it rather than replacing its last segment. */
function baseUrl(text: string, insecure: boolean, where: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${where} has a "url" that is not a URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecure)) {
    throw new Error(`${where} has a ${url.protocol}// "url". Use https, or set "insecure": true for an API on a trusted network.`);
  }
  if (url.username || url.password) throw new Error(`${where} has a credential in its "url"; it belongs in "auth".`);
  if (url.search || url.hash) throw new Error(`${where} has a query or fragment in its "url"; the base is a path only.`);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/* A description file, read and checked. */
async function describedIn(file: string): Promise<HttpDescription> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`the description file ${file} could not be read.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  return readDescription(raw, file);
}

/**
 * Open an HTTP connection: read its description, resolve its credential and
 * hand both to the adapter. `secrets: false` — a URL a browser supplied —
 * opens without the credential rather than sending it to that URL, and
 * without the cache: an answer fetched for one URL is not kept under a name
 * another URL could be given.
 */
export async function openHttp(
  name: string,
  url: string,
  http: HttpConnectionConfig,
  options: { secrets: boolean; cache?: CacheStore; environment?: NodeJS.ProcessEnv },
): Promise<{ adapter: HttpAdapter; secret: SecretSource; warning?: string }> {
  const where = `"${name}"`;
  const base = baseUrl(options.secrets ? expandEnvReferences(url, options.environment) : url, http.insecure === true, where);
  const description = typeof http.description === 'string' ? await describedIn(http.descriptionPath ?? http.description) : http.description;

  let auth: HttpAuth | undefined;
  let secret: SecretSource = 'none';
  let warning: string | undefined;
  if (http.auth && options.secrets) {
    const written = 'bearer' in http.auth ? http.auth.bearer : http.auth.value;
    const value = expandEnvReferences(written, options.environment);
    auth =
      'bearer' in http.auth ? { header: 'authorization', value: `Bearer ${value}` } : { header: http.auth.header.toLowerCase(), value };
    secret = value !== written ? 'environment' : 'inline';
    if (secret === 'inline') warning = 'This connection has its credential written into the config file. Prefer ${ENV_VAR}.';
  }
  const policy = { ...DEFAULT_POLICY, insecure: http.insecure === true, allowLinkLocal: http.allowLinkLocal === true };
  const cache = http.cache && options.cache && options.secrets ? { store: options.cache, ttlMs: http.cache.ttl * 1000 } : undefined;
  return { adapter: new HttpAdapter({ base, description, label: name, auth, policy, ...(cache ? { cache } : {}) }), secret, warning };
}
