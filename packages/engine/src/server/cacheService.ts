/**
 * The cache a config file can name beside its databases:
 *
 *   { "name": "cache", "kind": "cache", "url": "valkeys://cache.internal:6379/0",
 *     "auth": { "password": "${VALKEY_PASSWORD}" } }
 *
 * A cache (Valkey, or anything speaking its protocol) keeps what may vanish: cached API answers and rate-limit
 * windows, shared by every instance. Not a source of truth, optional, and a deployment has one. Checked when the
 * file is read, opened when first used. The credential is a `${VAR}` reference expanded only when it opens, as an
 * HTTP connection's is, never logged, and written back on save exactly as it was read.
 *
 * The other services (search, webhooks, email, identity) are the App framework's: serviceConnections.ts.
 */
import { DEFAULT_POLICY, type EgressPolicy } from '../adapters/http/egress.js';
import { RespClient } from '../adapters/cache/resp.js';
import { ValkeyCacheStore } from '../adapters/cache/cacheStore.js';
import { expandEnvReferences } from './auth/credentials.js';
import { SHARED_SERVICE_KEYS, checkServiceKeys, serviceWhere, type ConfigSections } from './configSections.js';
import { product } from './product.js';

interface CacheServiceConfig {
  kind: 'cache';
  name: string;
  /** `valkey://host:6379/0`, `valkeys://` (TLS); `redis://` and `rediss://` too. `${VAR}` references intact. */
  url: string;
  auth?: { username?: string; password: string };
  insecure?: boolean;
  allowLinkLocal?: boolean;
}

declare module './configSections.js' {
  interface ServiceKinds {
    cache: CacheServiceConfig;
  }
}

const CACHE_PROTOCOLS = new Set(['valkey:', 'valkeys:', 'redis:', 'rediss:']);
const TLS_PROTOCOLS = new Set(['valkeys:', 'rediss:']);

function cacheConnectionOf(entry: Record<string, unknown>, path: string): CacheServiceConfig {
  const where = serviceWhere(entry, path);
  checkServiceKeys(entry, 'cache', SHARED_SERVICE_KEYS, where);
  const url = String(entry.url);
  // A URL that is still a reference is checked when it opens, once the environment has said what it is.
  if (!url.includes('${')) cacheAddress(url, entry.insecure === true, where);
  return {
    kind: 'cache',
    name: String(entry.name),
    url,
    ...(entry.insecure === true ? { insecure: true } : {}),
    ...(entry.allowLinkLocal === true ? { allowLinkLocal: true } : {}),
    ...(entry.auth !== undefined ? { auth: cacheAuth(entry.auth, where) } : {}),
  };
}

/** What the engine reads of a config file beside `connections`: the cache. */
export const CACHE_SECTIONS: ConfigSections = {
  kinds: {
    cache: {
      singleton: 'cache',
      parse: cacheConnectionOf,
      entry: ({ kind, name, url, auth, insecure, allowLinkLocal }: CacheServiceConfig) => ({
        name,
        kind,
        url,
        ...(auth ? { auth } : {}),
        ...(insecure === true ? { insecure: true } : {}),
        ...(allowLinkLocal === true ? { allowLinkLocal: true } : {}),
      }),
    },
  },
  checks: [],
  top: {},
};

function cacheAuth(value: unknown, where: string): { username?: string; password: string } {
  const auth = value as Record<string, unknown>;
  const keys = auth && typeof auth === 'object' && !Array.isArray(auth) ? Object.keys(auth).sort().join(',') : '';
  if (
    (keys === 'password' || keys === 'password,username') &&
    typeof auth.password === 'string' &&
    auth.password &&
    (auth.username === undefined || (typeof auth.username === 'string' && auth.username))
  ) {
    return { ...(typeof auth.username === 'string' ? { username: auth.username } : {}), password: auth.password };
  }
  throw new Error(
    `${where} has an "auth" ${product()} cannot read. Write { "password": "\${VALKEY_PASSWORD}" }, with a "username" for an ACL user.`,
  );
}

/** Where a cache connection dials: host, port, TLS and database, with no credential in the URL. */
export function cacheAddress(text: string, insecure: boolean, where: string): { host: string; port: number; tls: boolean; db: number } {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${where} has a "url" that is not a URL.`);
  }
  if (!CACHE_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${where} has a ${url.protocol}// "url". A cache is valkeys:// (TLS) or valkey://; redis:// and rediss:// work too.`);
  }
  const tls = TLS_PROTOCOLS.has(url.protocol);
  if (!tls && !insecure) {
    throw new Error(
      `${where} has a plain ${url.protocol}// "url". Use valkeys:// (TLS), or set "insecure": true for a cache on a trusted network.`,
    );
  }
  if (url.username || url.password) throw new Error(`${where} has a credential in its "url"; it belongs in "auth".`);
  if (url.search || url.hash) throw new Error(`${where} has a query or fragment in its "url".`);
  const db = url.pathname.replace(/^\//, '');
  if (db && !/^\d{1,2}$/.test(db)) throw new Error(`${where} names database "${db}" in its "url"; a cache database is a number (0–15).`);
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 6379, tls, db: db ? Number(db) : 0 };
}

/** The shared network policy a service's flags ask for. */
export const egressPolicyOf = (service: { insecure?: boolean; allowLinkLocal?: boolean }): EgressPolicy => ({
  ...DEFAULT_POLICY,
  insecure: service.insecure === true,
  allowLinkLocal: service.allowLinkLocal === true,
});

/** Open the cache: a Valkey client behind the shared network policy. Nothing dials until the first command. */
export function openCache(service: CacheServiceConfig, onUnavailable: (message: string) => void): ValkeyCacheStore {
  const where = `connection "${service.name}"`;
  const address = cacheAddress(expandEnvReferences(service.url), service.insecure === true, where);
  const client = new RespClient({
    ...address,
    ...(service.auth?.username ? { username: expandEnvReferences(service.auth.username) } : {}),
    ...(service.auth ? { password: expandEnvReferences(service.auth.password) } : {}),
    policy: egressPolicyOf(service),
  });
  return new ValkeyCacheStore(client, (message) => onUnavailable(`cache "${service.name}": ${message}`));
}
