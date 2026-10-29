/**
 * The connection registry.
 *
 * The server used to hold exactly one adapter. It now holds several, opened
 * lazily: naming a connection costs nothing until you look at it, which
 * matters when a config file lists eight databases and you only wanted one.
 *
 * Two rules shape everything here.
 *
 * A connection string is a credential. It is read from disk or the command
 * line, kept in this module, and never sent to the browser — the client sees
 * an id, a name and a dialect. Anything that reaches the page has been
 * through `publicView`, and there is a test asserting a password does not
 * survive the trip.
 *
 * Introspection is per connection and cached, because it is the expensive
 * part of connecting and the schema does not change while you browse. It is
 * refreshable on request, since sometimes it does.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { connect } from '../adapters/connect.js';
import { UNTRUSTED_NETWORK } from '../adapters/net/untrustedDatabase.js';
import { configLocations } from './config/locations.js';
import { redact, scrubSecrets } from './connectionRedaction.js';
import { hideColumns, parseHiddenColumns, withoutHiddenColumns, type HiddenColumnRules } from './hiddenColumns.js';
export { redact, scrubSecrets } from './connectionRedaction.js';
import { shapeOnly } from './shapeonly.js';
import { resolveConnection, expandEnv, keychainAvailable, keychainSet, writeCredential } from './auth/credentials.js';
import { httpConnectionOf, openHttp, type HttpAuthConfig, type HttpConnectionConfig } from './httpConnection.js';
import {
  checkServices,
  isServiceKind,
  isUrlless,
  keptUnread,
  parseConfigSections,
  serviceConnectionOf,
  serviceEntry,
  type ConfigSections,
  type ServiceConfig,
  type ServiceKind,
  type ServiceKinds,
} from './configSections.js';
import { CACHE_SECTIONS, openCache } from './cacheService.js';
import { MemoryCacheStore, scopedCache, type CacheStore } from '../adapters/cache/cacheStore.js';
import type { HttpDescription } from '../adapters/http/httpDescription.js';
import type { Adapter } from '../adapters/adapter.js';
import type { PoolRoleStats } from '../adapters/poolMetrics.js';
import { listenOf, poolOf, replicaEngine, replicasOf, type PoolSize } from './poolConfig.js';
import type { DatabaseSchema } from '../shared/schema.js';
import { slug } from '../shared/slug.js';
import type { PublicConnection, SecretSource } from '../shared/connection.js';
import { sqliteTargetFrom } from './configPaths.js';
import { product } from './product.js';
export { sqliteTargetFrom } from './configPaths.js';
export type { PublicConnection } from '../shared/connection.js';

export interface ConnectionConfig {
  /** Stable identifier, used by the client and in URLs. */
  id: string;
  name: string;
  /**
   * SQLite path, database URL, or an API's base URL. Never leaves the server. A SQLite path a config file wrote
   * relative to itself is already located here (`loadConfig`): every reader of the url opens the one file.
   */
  url: string;
  /** The url as the config file wrote it, when locating it changed it: what a save writes back. */
  writtenUrl?: string;
  /** Postgres only. */
  schemas?: string[];
  /**
   * Whether this connection may be written to at all.
   *
   * Read-only unless the config says otherwise, and the server enforces it —
   * the browser's write toggle is a second gate, not the only one. A guard in
   * the browser is not a guard: the client decides whether to *offer* editing,
   * and until now the server took that decision on trust, so anything that
   * could reach the endpoint could write.
   *
   * Per connection rather than per process because that is the shape of the
   * actual risk. The same session usually holds a local database you want to
   * edit and a production one you emphatically do not, and a global flag
   * forces you to choose between restarting to fix a row and leaving
   * production editable all afternoon.
   */
  writable?: boolean;
  /**
   * Where this database's migrations are (`tablewalk migrate`): a directory
   * relative to the config file, and the history table's name when it is not
   * tablewalk's own `__mistri_schema_history` (a team moving over from
   * Flyway names `flyway_schema_history`). Read by the migrate command only.
   */
  migrations?: { dir: string; table?: string };
  /**
   * Whether rows may leave this connection at all. Default true.
   *
   * `"rows": false` is the enforced form of the boundary the README states
   * in prose: shape is safe to hand an agent, row values are not, and a
   * production database is exactly where that distinction matters. The
   * catalog, counts, null fractions, plans and lint still answer; anything
   * that would return a value out of a row refuses, at the adapter, for
   * every endpoint and tool at once.
   */
  rows?: boolean;
  /**
   * Columns no one is served over this connection: table (id, bare name or
   * "*") → column names, `*` a wildcard within a name. The Workbench, MCP and
   * every App on it see a catalog without them, and raw SQL is refused
   * (hiddenColumns.ts).
   */
  hidden?: HiddenColumnRules;
  /**
   * A PostgreSQL connection's pools: `{ "read": 16, "write": 8 }` lets
   * sixteen reads and eight App writes hold a connection at once (each 1–64;
   * `--read-pool` and `--write-pool`, else sized from the cores, when absent). The database
   * browser writes through one whatever `write` says (writeLanes.ts).
   */
  pool?: PoolSize;
  /**
   * Read replicas of a PostgreSQL database, by URL, each resolved
   * as `url` is. Lists, dashboards, counts and exports read from them in
   * turn; record pages, writes, commands and a person's reads just after
   * their own write stay on the primary (packages/engine/src/adapters/replicas.ts).
   */
  replicas?: string[];
  /**
   * A PostgreSQL connection's direct URL for `LISTEN`, used by a jobs host
   * when `url` goes through a transaction-mode pooler, which cannot hold a
   * listening session (packages/mistri/src/adapters/events/postgresCommandEventWake.ts).
   */
  listen?: string;
  /**
   * Present for an API read through its description (`"kind": "http"` in the
   * config file); `url` is then the API's base URL. It holds no secret:
   * `auth` keeps its `${VAR}` references until the connection opens.
   */
  http?: HttpConnectionConfig;
  /** Where this came from, so the UI can say why it is listed. */
  source: 'argument' | 'config' | 'session';
}

interface Entry {
  config: ConnectionConfig;
  /**
   * True when the URL was supplied by a client the server does not treat as
   * the operator — a browser reaching a server bound beyond loopback. Such a
   * URL is used exactly as written: no `${VAR}` expansion, no keychain, no
   * credentials file. The route decides who is trusted; see `clientTrusted`
   * in the server. A URL from the config file, the command line, or a
   * loopback browser resolves normally.
   */
  untrustedUrl?: boolean;
  /**
   * True only for a URL an untrusted client typed: it is dialled to the public
   * network alone. A URL the operator already resolved (`resolved` on `add`)
   * is used as written too, but it is the operator's, and may name this
   * machine or the private network its database lives on.
   */
  sealed?: boolean;
  adapter?: Adapter;
  /** The adapter as dialed, beneath the hidden-column and shape-only wrappers: the one the dial hooks were told of. */
  dialed?: Adapter;
  /** Synchronous invalidation is independent of the bounded request drain. */
  adapterEpoch?: object;
  adapterLifetime?: object;
  closingAdapters?: number;
  schema?: DatabaseSchema;
  error?: string;
  secret?: SecretSource;
  warning?: string;
  /**
   * The open in progress, if there is one.
   *
   * Two overlapping opens of the same connection both saw no adapter and both
   * dialled. The second assignment won and the first was never closed — on
   * Postgres, a leaked backend for the life of the process. Sharing the
   * promise makes concurrent callers wait for the one connection instead.
   */
  opening?: Promise<{ adapter: Adapter; schema: DatabaseSchema }>;
  /** Requests currently holding this adapter. See `Registry.lease`. */
  busy: number;
  /** Woken when `busy` reaches zero. */
  idle: Array<() => void>;
}

export class Registry {
  /** The environment this registry's references resolve in: an App's own in a suite, else the process's (undefined). */
  readonly environment?: NodeJS.ProcessEnv;
  /** A suite captures each App's references once; standalone registries retain
   * the existing process-environment lookup when a connection opens. */
  constructor(options: { environment?: NodeJS.ProcessEnv } = {}) {
    this.environment = options.environment === undefined ? undefined : Object.freeze({ ...options.environment });
  }
  private entries = new Map<string, Entry>();
  private activeId: string | null = null;
  private invalidateAdapter(entry: Entry): () => void {
    entry.adapterEpoch = {};
    entry.adapterLifetime = undefined;
    entry.closingAdapters = (entry.closingAdapters ?? 0) + 1;
    return () => {
      entry.closingAdapters! -= 1;
    };
  }

  /** Private serving-owner fence, not an authorization proof or a lease.
   * Refuses synchronously once closure starts, even while drain/close awaits. */
  captureAdapterLifetime(id: string, expectedAdapter: Adapter): () => void {
    const entry = this.entries.get(id);
    const lifetime = entry?.adapterLifetime;
    const current = () => {
      if (
        !entry ||
        !lifetime ||
        this.entries.get(id) !== entry ||
        entry.closingAdapters ||
        entry.adapterLifetime !== lifetime ||
        entry.adapter !== expectedAdapter ||
        !entry.schema
      ) {
        throw new Error('The connection adapter is no longer current.');
      }
    };
    current();
    return current;
  }
  /** Told of each adapter a connection dials, before anything can write through it. */
  private readonly dialedHooks: Array<(id: string, adapter: Adapter) => void> = [];
  /** Record history binds its tables here, so a reconnect records exactly as the adapter it replaced did (recordHistory.ts). */
  onAdapterDialed(hook: (id: string, adapter: Adapter) => void): void {
    this.dialedHooks.push(hook);
  }
  /**
   * The adapter a connection has open now, as dialed: the object the dial
   * hooks were told of and a write capture is keyed by, or undefined while
   * none is open. Nothing is dialed. Trusted server code only (live sync's
   * binding): it is beneath the hidden-column and shape-only wrappers, so it
   * is never handed to a reader.
   */
  dialedAdapter(id: string): Adapter | undefined {
    const entry = this.entries.get(id);
    return entry?.adapter && entry.schema && !entry.closingAdapters ? entry.dialed : undefined;
  }
  /** Where a connection's one-time notices go: stderr, where startup speaks. Tests replace it. */
  onWarning: (message: string) => void = (message) => console.error(`${product()}: ${message}`);
  /** The services the config names beside its databases: not databases, never listed or browsed. The cache is the engine's; the App framework registers the rest (configSections.ts). */
  private readonly services: ServiceConfig[] = [];
  /** The config sections this registry's services were read under: what saves them back and what makes a kind a singleton. */
  sections: ConfigSections = CACHE_SECTIONS;
  private cacheStore?: CacheStore;
  private cacheWarnedAt = 0;
  /* State a module keeps per registry (a plugged-in search provider, a mail transport), made on first use. */
  private readonly moduleState = new Map<string, { value: unknown; resetOnClose: boolean }>();
  /* A wider role, said once per connection per run. A schema refresh (the
     UI's, or the MCP `refresh` tool) dials again, and each dial used to say
     it again: the same paragraph every time an agent re-read the schema. Keyed by what was said, so a
     role that gained a grant since is still news. */
  private readonly rolesSaid = new Set<string>();

  /** A service from the config. Names are unique among services; a kind that is a singleton (the cache, the email service) is configured once. */
  addService(service: ServiceConfig): void {
    if (this.services.some((s) => s.name === service.name)) throw new Error(`A service named "${service.name}" is already configured.`);
    const singleton = this.sections.kinds[service.kind]?.singleton;
    if (singleton && this.services.some((s) => s.kind === service.kind)) {
      throw new Error(`"${service.name}" would be a second ${singleton}; a deployment has one.`);
    }
    this.services.push(service);
  }

  /** The entries of kinds this binary does not read (`others: 'keep'`), as written, for a save to put back. */
  private readonly kept: Array<Record<string, unknown>> = [];
  keep(entry: Record<string, unknown>): void {
    this.kept.push(entry);
  }
  keptEntries(): ReadonlyArray<Record<string, unknown>> {
    return [...this.kept];
  }

  /** The services as written — references intact — for saving the config back. */
  serviceConfigs(): ServiceConfig[] {
    return [...this.services];
  }

  /** The services of one kind, as written. */
  servicesOfKind<K extends ServiceKind>(kind: K): Array<ServiceKinds[K]> {
    return this.services.filter((s): s is ServiceKinds[K] => s.kind === kind);
  }

  /** State a module keeps for this registry, made on first use; `resetOnClose` state is forgotten by `closeServices`. */
  serviceState<T>(key: string, make: () => T, options: { resetOnClose?: boolean } = {}): T {
    let held = this.moduleState.get(key);
    if (!held) {
      held = { value: make(), resetOnClose: options.resetOnClose === true };
      this.moduleState.set(key, held);
    }
    return held.value as T;
  }

  /**
   * The deployment's cache: the Valkey a cache connection names, dialed on
   * first use, or this process's own. Its outages are said at most once a
   * minute; meanwhile every read is a miss.
   */
  cache(): CacheStore {
    if (this.cacheStore) return this.cacheStore;
    const configured = this.servicesOfKind('cache')[0];
    this.cacheStore = configured
      ? openCache(configured, (message) => {
          if (Date.now() - this.cacheWarnedAt < 60_000) return;
          this.cacheWarnedAt = Date.now();
          this.onWarning(`${message} Reading it as misses until it answers.`);
        })
      : new MemoryCacheStore();
    return this.cacheStore;
  }

  async closeServices(): Promise<void> {
    const store = this.cacheStore;
    this.cacheStore = undefined;
    for (const [key, held] of this.moduleState) if (held.resetOnClose) this.moduleState.delete(key);
    await store?.close();
  }

  add(config: Omit<ConnectionConfig, 'id'> & { id?: string }, options: { untrusted?: boolean; resolved?: boolean } = {}): ConnectionConfig {
    const id = config.id ?? slug(config.name, 'connection');
    /* Ids have to be unique because the client addresses connections by them;
       a duplicate name gets a suffix rather than silently replacing. */
    let unique = id;
    let n = 2;
    while (this.entries.has(unique)) unique = `${id}-${n++}`;
    const full: ConnectionConfig = { ...config, id: unique };
    this.entries.set(unique, {
      config: full,
      untrustedUrl: options.untrusted === true || options.resolved === true,
      sealed: options.untrusted === true,
      busy: 0,
      idle: [],
    });
    if (!this.activeId) this.activeId = unique;
    return full;
  }

  /** The file a SQLite connection opens, absolute, where its URL is written out (no `${VAR}`): what a refusal names. */
  sqliteFile(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.config.http || entry.config.url.includes('$')) return undefined;
    const url = entry.config.url;
    if (/^[a-z][\w+.-]*:\/\//i.test(url) || url === ':memory:') return undefined;
    return resolve(url.replace(/^sqlite:(\/\/)?/i, ''));
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** The stored configuration, for the manager to edit and to write back. */
  configOf(id: string): ConnectionConfig | undefined {
    return this.entries.get(id)?.config;
  }

  /** Every stored configuration, in order, including its secrets as written. */
  configs(): ConnectionConfig[] {
    return [...this.entries.values()].map((e) => e.config);
  }

  /**
   * Each database connection's URL as opening it would read it: `${VAR}` references resolved through this
   * registry's captured environment (an untrusted URL as written), an API's left out. Read in one pass with no
   * await, so an update between reads cannot retarget a connection already visited.
   */
  openableUrls(): string[] {
    const urls: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.config.http) continue;
      urls.push(entry.untrustedUrl ? entry.config.url : expandEnv(entry.config.url, this.environment));
    }
    return urls;
  }

  /**
   * Change a connection's name, target or schema list.
   *
   * The open adapter is discarded whenever the target changes, because an
   * entry whose URL says one database while its schema describes another is
   * the worst of both: it looks edited and behaves as it did before. The name
   * alone can change without reconnecting.
   */
  async update(id: string, patch: Partial<Omit<ConnectionConfig, 'id'>>, options: { untrusted?: boolean } = {}): Promise<ConnectionConfig> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No connection called "${id}".`);

    const retarget =
      (patch.url !== undefined && patch.url !== entry.config.url) ||
      (patch.schemas !== undefined && JSON.stringify(patch.schemas) !== JSON.stringify(entry.config.schemas));

    const moved = patch.url !== undefined && patch.url !== entry.config.url;
    entry.config = { ...entry.config, ...patch, id };
    // A new url is the one typed now; the file's spelling of the old one is not saved over it.
    if (moved) delete entry.config.writtenUrl;
    if (retarget) {
      /* The writable flag does not follow a URL to a new database.

         `writable` is the config's statement about *one* database: this file
         may be edited, that server may not. An entry that kept the flag while
         its URL changed carried "may be written" to whatever the new URL
         named — any SQLite file the server user can read, any Postgres it
         can reach — and `/api/sql` with `write: true` would then run there.
         Retargeting makes the entry read-only; a connection that should be
         writable says so in the config, where the decision is reviewable.
         `rows: false` is the opposite kind of flag, a restriction, and it
         stays: a shape-only connection pointed elsewhere is still shape-only.

         A URL handed over by a client the route does not trust is marked, and
         `dial` resolves it without secrets from then on. */
      entry.config.writable = false;
      if (patch.url !== undefined) entry.untrustedUrl = entry.sealed = options.untrusted === true;
      const finish = this.invalidateAdapter(entry);
      try {
        await this.drain(id);
        await entry.adapter?.close().catch(() => {});
        entry.adapter = entry.dialed = undefined;
        entry.schema = undefined;
        entry.error = undefined;
      } finally {
        finish();
      }
    }
    return entry.config;
  }

  /**
   * Replace a connection's stored URL with one that names the same database.
   *
   * This is how a password moves out of the URL and into the keychain when
   * the connections are saved: the target has not changed, only how the
   * secret is remembered, so nothing that `update` does for a retarget —
   * closing the adapter, dropping the writable flag, marking the URL as an
   * untrusted client's — applies. The same-target rule is checked, not assumed: with
   * the password blanked on both sides the two URLs must be identical, or
   * this refuses rather than quietly becoming a retarget with the guards off.
   */
  rewriteUrl(id: string, url: string): ConnectionConfig {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No connection called "${id}".`);
    if (sameTarget(entry.config.url, url) === false) {
      throw new Error(`"${entry.config.name}": the rewritten URL names a different database.`);
    }
    entry.config = { ...entry.config, url };
    delete entry.config.writtenUrl;
    /* The URL is now the operator's, whatever it was before: saving is the
       explicit act of making a session connection permanent, and the secret
       the next open resolves by name is one this server stored. */
    entry.untrustedUrl = entry.sealed = false;
    return entry.config;
  }

  /**
   * Forget a connection.
   *
   * This used to refuse the last one, and the reason it gave was honest: a
   * browser with no database to browse was a page that could not do anything,
   * and the way out of that state was not obvious. Both halves of that have
   * stopped being true — the server starts with nothing now, and the page it
   * serves in that state exists to do exactly one thing, which is get you out
   * of it. A rule that guards against a state the product supports is just a
   * connection you cannot remove.
   *
   * The active connection moves to whatever remains, or to nothing.
   */
  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No connection called "${id}".`);
    const finish = this.invalidateAdapter(entry);
    try {
      await this.drain(id);
      await entry.adapter?.close().catch(() => {});
      this.entries.delete(id);
      if (this.activeId === id) this.activeId = [...this.entries.keys()][0] ?? null;
    } finally {
      finish();
    }
  }

  get active(): string | null {
    return this.activeId;
  }

  /**
   * Choose the default connection, or `null` for none.
   *
   * Null is reachable now that the server starts with nothing, and it is what
   * an add has to fall back to when the connection it just made turns out not
   * to open: `add` makes the first one active before anything has tried to
   * dial it, so a failed first add left the whole application pointed at a
   * connection that had never worked.
   */
  setActive(id: string | null): void {
    if (id !== null && !this.entries.has(id)) throw new Error(`No connection called "${id}".`);
    this.activeId = id;
  }

  list(): PublicConnection[] {
    return [...this.entries.values()].map((e) => publicView(e));
  }

  /**
   * Open a connection if it is not already open, and return it with its
   * schema. A failure is recorded on the entry rather than thrown away, so
   * the sidebar can show which connection is broken and why.
   */
  async open(id: string): Promise<{ adapter: Adapter; schema: DatabaseSchema }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No connection called "${id}".`);
    if (entry.adapter && entry.schema) return { adapter: entry.adapter, schema: entry.schema };
    /* Already dialling: wait for that one rather than starting a second.
       Two tabs selecting the same unopened connection at the same moment used
       to open two real connections and leak whichever finished first. */
    if (entry.opening) return entry.opening;

    entry.opening = this.dial(entry);
    try {
      return await entry.opening;
    } finally {
      entry.opening = undefined;
    }
  }

  /* Every read runs in a read-only transaction, which holds for everything
     tablewalk sends but not for a superuser: the role is the boundary that
     always holds. Never fatal: a catalog that will not say is not a reason to
     warn, or to keep the connection closed. */
  private async warnWiderRole(name: string, adapter: Adapter): Promise<void> {
    try {
      const role = await adapter.privileges!();
      const wider = [...(role.superuser ? ['superuser'] : []), ...role.writes, ...(role.create ? ['CREATE'] : [])];
      const said = `${name}\u0000${wider.join('\u0000')}`;
      if (wider.length && !this.rolesSaid.has(said)) {
        this.rolesSaid.add(said);
        this.onWarning(
          `"${name}" is read-only here, but its database role can do more (${wider.join('; ')}). ` +
            'Reads still run in read-only transactions; connect as a role that can only read and the database enforces it too.',
        );
      }
    } catch {
      /* Nothing to say. */
    }
  }

  /* Each replica resolved as the primary's URL was, under the same name, so a
     password kept for the connection is the replica's too — a physical
     replica has the primary's roles. A reference is only known now, so the
     engine is checked again here (replicasOf checked what was literal). */
  private async resolveReplicas(entry: Entry, primary: string): Promise<string[]> {
    const engine = replicaEngine(primary);
    if (!engine) throw new Error(`"${entry.config.name}" has "replicas", but SQLite has no replicas. Remove "replicas".`);
    return Promise.all(
      (entry.config.replicas ?? []).map(async (url) => {
        const resolved = await resolveConnection(entry.config.name, url, { secrets: !entry.untrustedUrl, environment: this.environment });
        if (replicaEngine(resolved.url) !== engine)
          throw new Error(`"${entry.config.name}" has a replica that is not a ${engine} URL; a replica is the same engine as its primary.`);
        return resolved.url;
      }),
    );
  }

  private async dial(entry: Entry): Promise<{ adapter: Adapter; schema: DatabaseSchema }> {
    const epoch = entry.adapterEpoch;

    /* Declared out here so the catch can sweep it. It holds the secret in its
       expanded form, which is exactly what a driver quotes back on failure. */
    let resolved: Awaited<ReturnType<typeof resolveConnection>> | undefined;
    let adapter: Adapter | undefined;
    let published = false;
    try {
      /* The stored URL may be a reference rather than a secret: an env var,
         a keychain entry, or a name in the credentials file. It is resolved
         here, at the last possible moment, and the resolved form is handed
         straight to the adapter without being stored anywhere. */
      if (entry.config.http) {
        /* A URL that arrived from an untrusted client opens with no
           credential, as a database URL does: the header is bound to the
           host the operator wrote, never to one a browser named. */
        /* The deployment's cache under this connection's own prefix: an answer
           kept for one API is never read back as another's. openHttp uses it
           only where the connection opted in (`"cache": { "ttl": … }`). */
        const opened = await openHttp(entry.config.name, entry.config.url, entry.config.http, {
          secrets: !entry.untrustedUrl,
          environment: this.environment,
          ...(entry.config.http.cache ? { cache: scopedCache(this.cache(), `tw:http:${entry.config.id}:`) } : {}),
        });
        entry.secret = opened.secret;
        entry.warning = opened.warning;
        adapter = opened.adapter;
      } else {
        resolved = await resolveConnection(entry.config.name, entry.config.url, {
          secrets: !entry.untrustedUrl,
          environment: this.environment,
        });
        entry.secret = resolved.source;
        entry.warning = resolved.warning;
        /* A literal URL was checked against its "pool" when the file was
           read; one that was a reference is only known now. Said rather than
           refused: the connection still works, on the default pool. */
        if (entry.config.pool && !/^postgres(ql)?:\/\//i.test(resolved.url)) {
          this.onWarning(
            `"${entry.config.name}" has "pool", which sizes PostgreSQL connections; it names another engine, so "pool" has no effect.`,
          );
        }
        const replicas = entry.config.replicas?.length ? await this.resolveReplicas(entry, resolved.url) : undefined;
        adapter = connect(resolved.url, {
          ...(replicas ? { replicas } : {}),
          schemas: entry.config.schemas ?? [],
          label: entry.config.name,
          // An address a browser beyond this machine typed reaches the public network only, with nothing filled in.
          ...(entry.sealed ? { network: UNTRUSTED_NETWORK } : {}),
          ...(entry.config.pool
            ? {
                postgres: {
                  ...(entry.config.pool.read !== undefined ? { readers: entry.config.pool.read } : {}),
                  ...(entry.config.pool.write !== undefined ? { writers: entry.config.pool.write } : {}),
                },
              }
            : {}),
        });
      }
      const read = await adapter.introspect();
      /* The catalog as served: a hidden column is not in it, for any caller. */
      const schema = entry.config.hidden ? withoutHiddenColumns(read, entry.config.hidden, entry.config.name) : read;
      for (const hook of this.dialedHooks) hook(entry.config.id, adapter);
      /* Wrapped before it is stored, so nothing can reach the unwrapped one:
         the boundary is a property of the connection, not a rule each caller
         remembers. Introspection happens first because the catalog is the
         part a shape-only connection exists to serve. */
      /* Hidden columns are cut first, so a shape-only connection's catalog
         and counts never name them either. */
      const hidden = entry.config.hidden ? hideColumns(adapter, entry.config.name, entry.config.hidden, read) : adapter;
      entry.adapter = entry.config.rows === false ? shapeOnly(hidden, entry.config.name) : hidden;
      entry.dialed = adapter;
      published = true;
      entry.schema = schema;
      if (entry.adapterEpoch === epoch && !entry.closingAdapters) entry.adapterLifetime = {};
      entry.error = undefined;
      /* Read-only here, over a role that could do more: said once, on the
         first open, before anything else uses the handle. */
      if (!entry.config.writable && adapter.privileges) await this.warnWiderRole(entry.config.name, adapter);
      /* The stored one, which is the wrapped one where it matters. Returning
         the raw adapter here would hand the first caller a way past the
         boundary the line above just put up. */
      return { adapter: entry.adapter, schema };
    } catch (err) {
      // Failed introspection/wrapping never reaches closeAll's ownership map.
      // Once published, the registry owns closure (including wrapped adapters).
      if (adapter && !published) {
        try {
          await adapter.close();
        } catch {
          /* Preserve the original, scrubbed acquisition error. */
        }
      }
      /* Scrubbed here, at the one place a failure becomes a stored string.
      
         `resolved` is the URL with the secret expanded into it, and it is the
         thing a driver quotes back. It may not exist yet — `resolveConnection`
         can be what failed — so the configured URL is swept as well, since an
         inline password lives in that one. */
      entry.error = scrubSecrets((err as Error).message, resolved?.url, entry.config.url);
      /* A missing password, said as one.
      
         Moving a secret to the keychain gives this tool a failure mode it did
         not have before: the entry can be removed, or the keychain locked, or
         the file copied to a machine that has neither. What the driver says
         then is its own internal complaint — Postgres answers "SASL:
         SCRAM-SERVER-FIRST-MESSAGE: client password must be a string", which
         names nothing a reader can act on and does not even contain the word
         "password" in a useful position.

         So when the URL names a user, no password was found for it, and the
         connection failed, the reason is stated where the reader is already
         looking. Only then: guessing at any other failure would be worse than
         the driver's own words, which are usually right. And only when a
         lookup actually ran — a URL from an untrusted client resolves nothing,
         so "looked in the keychain" would be a lie about it. */
      if (resolved?.source === 'none' && !entry.untrustedUrl && namesUserWithoutPassword(resolved.url)) {
        entry.error =
          `no password found for "${entry.config.name}". ` +
          'Looked in the environment, the keychain, and the credentials file. ' +
          'If it was moved to the keychain and has since been removed, add the connection again ' +
          `with its password. (The database said: ${entry.error})`;
      }
      // Rethrown with the connection named, because "ECONNREFUSED" on its own
      // does not say which of eight databases is down.
      throw new Error(`${entry.config.name}: ${entry.error}`);
    }
  }

  /**
   * Hold a connection open for the length of one request.
   *
   * Closing an adapter is not an operation the thing using it finds out
   * about. A slow `/api/run` in one tab and a `refresh` in another meant the
   * pg client was ended mid-query — the read came back as a driver-level
   * "connection closed" 500, and on SQLite as a use-after-close. Nothing
   * counted who was using what.
   *
   * The lease is taken when a request resolves its connection and released
   * when the response ends, whichever way it ends.
   */
  lease(id: string): () => void {
    const entry = this.entries.get(id);
    if (!entry) return () => {};
    entry.busy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.busy -= 1;
      if (entry.busy <= 0) {
        entry.busy = 0;
        for (const wake of entry.idle.splice(0)) wake();
      }
    };
  }

  /**
   * Wait for the requests using a connection to finish.
   *
   * Bounded, because a query can be stuck for as long as the statement
   * timeout allows and "the close hangs" is a worse failure than "the close
   * was slightly rude". After the wait it closes anyway — which is the old
   * behaviour, now as a last resort rather than as the only one.
   */
  private async drain(id: string, ms = 5_000): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.busy <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      entry.idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Drop the cached schema so the next open re-reads the catalog. */
  async refresh(id: string): Promise<{ adapter: Adapter; schema: DatabaseSchema }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`No connection called "${id}".`);
    const finish = this.invalidateAdapter(entry);
    try {
      await this.drain(id);
      if (entry.adapter) await entry.adapter.close();
      entry.adapter = entry.dialed = undefined;
      entry.schema = undefined;
    } finally {
      finish();
    }
    return this.open(id);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    const finish = entries.map((entry) => this.invalidateAdapter(entry));
    try {
      await Promise.allSettled(entries.map((entry) => entry.adapter?.close()));
    } finally {
      for (const done of finish) done();
    }
  }

  /**
   * Every open connection's pool meters, for the operator surface. A
   * connection is named by its position among the configured ones — the
   * order of tablewalk.json, then the command line — and never by its name
   * or URL, which that surface must not carry. A connection not yet opened
   * has no pool to report.
   */
  poolStats(): ConnectionPoolStats[] {
    return [...this.entries.values()].flatMap((entry, index) => {
      const adapter = entry.adapter;
      if (!adapter?.poolStats) return [];
      try {
        return adapter.poolStats().map((stats) => ({ ...stats, position: index + 1, dialect: adapter.dialect }));
      } catch {
        // Instrumentation must not become a new failure path for the operator read.
        return [];
      }
    });
  }
}

/** One open pool's meters, by its connection's position among the configured ones. */
export type ConnectionPoolStats = PoolRoleStats & { readonly position: number; readonly dialect: string };

/**
 * Whether two connection strings name the same database, ignoring the
 * password. `null` when either is not a URL (a SQLite path), in which case
 * the answer is plain string equality, decided by the caller.
 */
function sameTarget(a: string, b: string): boolean | null {
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.password = '';
    y.password = '';
    return x.toString() === y.toString();
  } catch {
    return null;
  }
}

function publicView(entry: Entry): PublicConnection {
  return {
    id: entry.config.id,
    name: entry.config.name,
    dialect: entry.config.http ? 'http' : dialectOf(entry.config.url),
    // As the file wrote it, as it always read in the sidebar.
    detail: redact(entry.config.writtenUrl ?? entry.config.url),
    source: entry.config.source,
    connected: Boolean(entry.schema),
    tables: entry.schema?.tables.length,
    error: entry.error,
    secret: entry.secret,
    warning: entry.warning,
    /* Safe to send, unlike the URL: a schema list is a set of names the user
       chose to browse, and the manager needs them to prefill its editor. */
    schemas: entry.config.schemas,
    /* Sent so the interface can be honest about it: a write toggle offered on
       a connection the server will refuse to write is a button that lies. */
    writable: Boolean(entry.config.writable),
    /* Same reason as `writable`: an interface that offers a query bar on a
       connection the server will not read rows from is an interface that
       lies. */
    ...(entry.config.rows === false ? { rows: false } : {}),
    // Same reason again: a SQL box on a connection that refuses SQL lies.
    ...(entry.config.hidden ? { hidesColumns: true as const } : {}),
  };
}

/* Read off the scheme, with SQLite as the fallback because a SQLite target is
   a bare file path and has no scheme to read.

   An unlisted scheme was once labelled "sqlite" in the picker and the
   connection manager — a wrong answer to the one question those labels
   exist to answer. Adding an adapter means adding its scheme here;
   `connect.ts` is the other half of the same list. */
function dialectOf(url: string): string {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres';
  return 'sqlite';
}

/* ---------- the config file ---------- */

interface ConfigFile {
  connections: Array<{
    name: string;
    url: string;
    schemas?: string[];
    /** Opt in to writes. Absent or false means the server refuses them. */
    writable?: boolean;
    /** `false` makes the connection shape-only: no row values leave it. */
    rows?: boolean;
    /** Table → columns never served over the connection (hiddenColumns.ts). */
    hidden?: HiddenColumnRules;
    /** `{ "read": n, "write": m }`: a PostgreSQL connection's pool sizes, checked by poolOf. */
    pool?: unknown;
    /** Read replicas' URLs, checked by replicasOf. */
    replicas?: unknown;
    /** A direct URL for LISTEN behind a pooler, checked by listenOf. */
    listen?: unknown;
    /** `"http"` for an API, `"cache"`, `"webhook"`, … for a service (serviceConnections.ts); absent for a database. */
    kind?: 'http' | ServiceKind;
    /** A description file relative to this one, or the description itself. */
    description?: string | HttpDescription;
    auth?: HttpAuthConfig;
    insecure?: boolean;
    allowLinkLocal?: boolean;
    cache?: { ttl: number };
    /** Where its migrations are (tablewalk migrate), checked below. */
    migrations?: { dir: string; table?: string };
  }>;
}

export interface LoadedConfig {
  path: string;
  /** As written — a SQLite path located against the file (`writtenUrl` keeps the spelling) — plus an HTTP connection's fields checked and its description resolved against the file, and a checked pool. */
  connections: Array<
    Omit<ConfigFile['connections'][number], 'pool' | 'replicas' | 'listen'> & {
      writtenUrl?: string;
      http?: HttpConnectionConfig;
      pool?: PoolSize;
      replicas?: string[];
      listen?: string;
    }
  >;
  /** The services the file names beside its databases, checked; never databases, never listed as connections. */
  services: ServiceConfig[];
  /** Entries of kinds these sections keep unread (`others: 'keep'`), as written. */
  kept?: Array<Record<string, unknown>>;
  /* The App framework's top-level sections (`analytics`) are added by the module that registers them (configSections.ts). */
}

/**
 * Read the first config file that exists.
 *
 * A missing file is not an error — most people will never write one. A file
 * that exists but is malformed *is* an error, and is reported rather than
 * skipped: silently ignoring a config someone wrote is worse than refusing.
 *
 * A SQLite path written relative to the file is located here, once, against
 * the file's folder (`sqliteTargetFrom`), and `writtenUrl` keeps the spelling
 * for a save. Every tool reads its connections through here — a start, check,
 * build, migrate, seed, a suite, the token and test commands — and each used
 * to apply the rule itself or not at all: a migrate run from an App's folder
 * looked for `./shop.db` there while the server beside it opened the file
 * next to the config, and the command journal a start puts beside the
 * database was made in the working directory. A value from the environment
 * (`"${DATABASE_URL}"`) is not the file's: it is read as given, from where
 * tablewalk runs, as the same variable is without a config.
 */
export async function loadConfig(explicit: string | undefined, sections: ConfigSections): Promise<LoadedConfig | undefined> {
  for (const path of configLocations(explicit)) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      if (explicit) throw new Error(`No config file at ${path}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
    }
    const connections = (parsed as ConfigFile)?.connections;
    if (!Array.isArray(connections)) {
      throw new Error(`${path} needs a "connections" array.`);
    }
    const services: ServiceConfig[] = [];
    const kept: Array<Record<string, unknown>> = [];
    const loaded = connections.flatMap((c, i) => {
      if (keptUnread(sections, c?.kind)) {
        kept.push(c as unknown as Record<string, unknown>);
        return [];
      }
      /* An identity provider, and a host that signs people in, are found by their issuer, which is their address;
         the OAuth authorization server is this server itself, and has none of its own. */
      if (!c || ((typeof c.url !== 'string' || !c.url) && !isUrlless(sections, c.kind))) {
        throw new Error(`${path}: connection ${i + 1} has no "url".`);
      }
      if (typeof c.name !== 'string' || !c.name) {
        throw new Error(`${path}: connection ${i + 1} has no "name".`);
      }
      /* A cache or a webhook is not a database: checked by its own
         rules, kept apart, and never offered as a connection to browse. */
      if (isServiceKind(sections, c.kind)) {
        services.push(serviceConnectionOf(sections, c as unknown as Record<string, unknown>, path));
        return [];
      }
      /* Refused rather than coerced. `"writable": "false"` is a string, and
         every non-empty string is truthy — quietly reading that as permission
         to write to production is the one mistake in this file worth being
         loud about. */
      if (c.writable !== undefined && typeof c.writable !== 'boolean') {
        throw new Error(
          `${path}: connection "${c.name}" has "writable": ${JSON.stringify(c.writable)}. ` + `It must be true or false, without quotes.`,
        );
      }
      /* Same reasoning one boundary further out: `"rows": "false"` is a
         truthy string, and reading it as permission would open exactly the
         connection someone wrote it to close. */
      if (c.rows !== undefined && typeof c.rows !== 'boolean') {
        throw new Error(
          `${path}: connection "${c.name}" has "rows": ${JSON.stringify(c.rows)}. ` + `It must be true or false, without quotes.`,
        );
      }
      if (c.rows === false && c.writable) {
        /* Writing is how rows get in, and an insert answers with the stored
           row. Allowing both would be a boundary with a door in it. */
        throw new Error(
          `${path}: connection "${c.name}" is both "writable" and "rows": false. ` +
            `A shape-only connection cannot be written to — drop one of them.`,
        );
      }
      if (c.hidden !== undefined) parseHiddenColumns(c.hidden, `${path}: connection "${c.name}"`);
      const migrations: unknown = c.migrations;
      if (
        migrations !== undefined &&
        (typeof migrations !== 'object' ||
          migrations === null ||
          typeof (migrations as { dir?: unknown }).dir !== 'string' ||
          Object.keys(migrations).some((key) => key !== 'dir' && key !== 'table') ||
          !['undefined', 'string'].includes(typeof (migrations as { table?: unknown }).table))
      ) {
        throw new Error(
          `${path}: connection "${c.name}" has "migrations": ${JSON.stringify(migrations)}. It is { "dir": "<directory>" }, and "table" when the history table is not ${product()}'s own.`,
        );
      }
      const http = httpConnectionOf(c as unknown as Record<string, unknown>, path);
      const pool = poolOf(c as unknown as Record<string, unknown>, http !== undefined, path);
      const replicas = replicasOf(c as unknown as Record<string, unknown>, http !== undefined, path);
      const listen = listenOf(c as unknown as Record<string, unknown>, http !== undefined, path);
      const { pool: _written, replicas: _listed, listen: _direct, ...entry } = c;
      const located = http ? c.url : sqliteTargetFrom(c.url, dirname(resolve(path)));
      return [
        {
          ...entry,
          ...(located !== c.url ? { url: located, writtenUrl: c.url } : {}),
          ...(http ? { http } : {}),
          ...(pool ? { pool } : {}),
          ...(replicas ? { replicas } : {}),
          ...(listen ? { listen } : {}),
        },
      ];
    });
    checkServices(sections, services, path);
    return { path, connections: loaded, services, ...(kept.length ? { kept } : {}), ...parseConfigSections(sections, parsed, path) };
  }
  return undefined;
}

/* ---------- storing a secret for a runtime-added connection ---------- */

interface StoreResult {
  stored: 'keychain' | 'file';
  /** The URL to keep, with the password removed. */
  url: string;
}

/**
 * Split a connection string into a URL worth persisting and a secret worth
 * protecting, then store the secret where the platform can protect it.
 *
 * The URL that gets written to disk never contains the password. That is the
 * property worth having: a config file that leaks is embarrassing, not a
 * breach, and a connection list can be shared or committed without thinking
 * about it.
 */
/**
 * A URL that names a user and carries no password.
 *
 * The shape that means "a password was expected from somewhere else" — which
 * is exactly the shape `storeSecret` leaves behind, and so the shape whose
 * failure deserves an explanation rather than the driver's own words.
 */
function namesUserWithoutPassword(url: string): boolean {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.username) && !parsed.password;
  } catch {
    return false;
  }
}

export async function storeSecret(name: string, url: string): Promise<StoreResult | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // A file path has no secret to store.
  }
  if (!parsed.password) return undefined;

  const secret = decodeURIComponent(parsed.password);

  /* An environment reference is not a secret to move — it is the *absence* of
     one, and the arrangement this file recommends first.
     `postgres://app:${PROD_PASSWORD}@host/db` stores nothing anywhere; the
     value arrives from the environment at open time. Moving it would put the
     literal characters `${PROD_PASSWORD}` into the keychain and strip the
     reference out of the URL, breaking the workflow in the course of trying
     to secure it.

     Checked on the raw password rather than with `hasInlinePassword`, which
     is only asked *after* expansion — by then a reference has already become
     the value it names, and the distinction this needs is gone. */
  if (/\$\{?[A-Za-z_]/.test(secret)) return undefined;
  parsed.password = '';
  const withoutSecret = parsed.toString();

  if (keychainAvailable() && (await keychainSet(name, secret))) {
    return { stored: 'keychain', url: withoutSecret };
  }
  await writeCredential(name, secret);
  return { stored: 'file', url: withoutSecret };
}

/**
 * Write connections back to a config file.
 *
 * The rule this respects: **a page never edits a file on disk without being
 * told to.** Adding or editing a connection changes the running session only;
 * this is the separate, explicit act of making that permanent, and the UI has
 * to name the file it is about to write.
 *
 * URLs are stored exactly as they were typed, which is what makes
 * `postgres://app:${PROD_PASSWORD}@db/app` survive a round trip as a
 * reference rather than being resolved into the secret it points at. The
 * corollary is that a password someone typed inline gets written inline —
 * true of any config file, and the reason the UI warns about it before this
 * is ever called.
 *
 * Only the `connections` key is rewritten. The registry knows about
 * connections and nothing else, so building the file out of it alone deleted
 * the `views` and `queries` a team had committed — and reported success. A
 * file with a section this function does not understand is a file it has no
 * business rewriting from scratch.
 */
/* A url the file did not write — a connection added in the session — is the working directory's when it is a
   relative SQLite path, and the file is read from its own folder: so it is saved where it is. */
function savedUrl(url: string): string {
  return url && sqliteTargetFrom(url, process.cwd());
}

export async function saveConfig(
  path: string,
  connections: ConnectionConfig[],
  services: readonly ServiceConfig[] = [],
  sections: ConfigSections = CACHE_SECTIONS,
  kept: ReadonlyArray<Record<string, unknown>> = [],
): Promise<void> {
  const body = {
    ...(await existingConfig(path)),
    connections: [
      ...connections
        // Session connections are included: making them permanent is the whole
        // point of pressing the button.
        .map((c) => ({
          name: c.name,
          url: c.writtenUrl ?? savedUrl(c.url),
          ...(c.schemas?.length ? { schemas: c.schemas } : {}),
          // Written only when true. Absent means read-only, and a file full of
          // `"writable": false` would suggest the flag is doing something.
          ...(c.writable ? { writable: true } : {}),
          // And the same rule inverted: only written when it is doing something.
          ...(c.rows === false ? { rows: false } : {}),
          // Kept as written: a save from the connection manager must not unhide a column.
          ...(c.hidden ? { hidden: c.hidden } : {}),
          // A pool size is the file's capacity plan; a save that dropped it would change it.
          ...(c.pool ? { pool: { ...c.pool } } : {}),
          // And so are its replicas, as written, references and all.
          ...(c.replicas?.length ? { replicas: [...c.replicas] } : {}),
          // Where its migrations live is the file's, too.
          ...(c.migrations ? { migrations: c.migrations } : {}),
          /* An API keeps its description as it was written, relative to the
           file, and its auth with the `${VAR}` references still in it. */
          ...(c.http
            ? {
                kind: 'http' as const,
                description: c.http.description,
                ...(c.http.auth ? { auth: c.http.auth } : {}),
                ...(c.http.insecure ? { insecure: true } : {}),
                ...(c.http.allowLinkLocal ? { allowLinkLocal: true } : {}),
                ...(c.http.cache ? { cache: c.http.cache } : {}),
              }
            : {}),
        })),
      /* The cache and the other services, as they were read: the registry does
         not list them as connections, and a save built from the list alone
         deleted them from the file. */
      ...services.map((service) => serviceEntry(sections, service)),
      // And the entries this binary keeps unread: another reader of the file's.
      ...kept,
    ],
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * What is already in the file, so that writing connections back keeps it.
 *
 * A file that does not exist yet is simply an empty object — the first save
 * writes a file with one key in it. A file that exists and cannot be parsed
 * is the case worth stopping on: overwriting it would replace something
 * hand-edited with a machine-generated stub, and the person who typed the
 * stray comma would find their views gone rather than their typo reported.
 */
async function existingConfig(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}), so its other settings cannot be ` +
        'preserved. Fix the file, or save to a different path.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  /* `connections` is dropped because it is about to be written from the
     registry; everything else — views, queries, comments, keys a later
     version adds — is carried through untouched. */
  const { connections: _drop, ...rest } = parsed as Record<string, unknown>;
  return rest;
}
