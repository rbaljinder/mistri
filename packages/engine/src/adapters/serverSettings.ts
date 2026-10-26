/**
 * What one server was started with that is read far below its requests: the
 * client-address rule a rate limit keys by (http/trust.ts `forwardedClient`),
 * and the pool sizes, pooler mode, lock wait and write order every adapter it
 * opens takes (postgresPool.ts, writeLanes.ts).
 *
 * These were process globals, set once at startup, which was right while a
 * process was one server. `createHandler` (embed/handler.ts) puts
 * several in one host process, and each started by overwriting the globals:
 * the last handler's proxy trust decided whose X-Forwarded-For every
 * handler's limits believed. So a handler's settings are a value it carries,
 * and everything it runs — its startup, every request it is given, its
 * close — runs inside `withServerSettings`, where `serverSettings()` reads
 * them. The command line is one server per process and installs its own as
 * the process's (`configureServerSettings`), which is what is read outside
 * any scope.
 *
 * A scope rather than an argument: the readers are a dozen limiters and the
 * constructor of every pool, opened by the registry, a tenant source, the job
 * host and a startup check alike. An argument would have to reach each, and
 * one that missed would quietly return to the default — the failure this
 * exists to end. A scope reaches all of them by construction, timers and
 * all, since an async context follows its callbacks.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolerMode } from './poolMetrics.js';

export type WriteOrder = 'serial' | 'keyed';

/** `--trust-proxy-hops` and `--trust-proxy-cloudflare`: how a forwarded client address is found (trust.ts). */
export interface ClientAddressPolicy {
  /** This many proxies append to X-Forwarded-For, the socket peer being the first. */
  readonly hops?: number;
  /** The server is reachable only through Cloudflare, which sets CF-Connecting-IP. */
  readonly cloudflare?: boolean;
}

export interface ServerSettings {
  readonly clientAddress: ClientAddressPolicy;
  /** `--read-pool`: a PostgreSQL reader pool's size; unset, it follows the write order (postgresPool.ts). */
  readonly readers?: number;
  /** `--pooler`. */
  readonly pooler: PoolerMode;
  /** `--write-pool`; unset, the balanced size (writeLanes.ts). */
  readonly writers?: number;
  /** `--lock-timeout`; unset, the default. */
  readonly lockTimeoutMs?: number;
  /**
   * `keyed` where the server serves Apps, `serial` for the database browser
   * (writeLanes.ts). Settled once the config is read, before a connection
   * opens, so it is the one field startup writes after the scope is entered.
   */
  writeOrder: WriteOrder;
}

/** What a server that names nothing gets. */
export function defaultServerSettings(): ServerSettings {
  return { clientAddress: {}, pooler: 'session', writeOrder: 'serial' };
}

let processSettings: ServerSettings = defaultServerSettings();
const scope = new AsyncLocalStorage<ServerSettings>();

/** The settings of the server this work belongs to: its scope's, or the process's. */
export function serverSettings(): ServerSettings {
  return scope.getStore() ?? processSettings;
}

/** Run `work`, and everything it starts, as the server `settings` describe. */
export function withServerSettings<T>(settings: ServerSettings, work: () => T): T {
  return scope.run(settings, work);
}

/**
 * Change the process's settings — what is read outside any scope: the
 * command line's one server, a test. Fields it leaves out keep their value.
 */
export function configureServerSettings(change: Partial<ServerSettings>): void {
  processSettings = { ...processSettings, ...change };
}
