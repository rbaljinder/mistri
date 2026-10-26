import { lstatSync, realpathSync, statSync } from 'node:fs';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';
import { POSTGRES_AUTH_PREFIX } from '../../adapters/auth/postgresAuthStore.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { scrubSecrets } from '@mistriwork/engine/server/connections.js';
import { captureTenantData, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { expandEnv, resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { AuthStoreExclusion } from './sqliteStoreIdentity.js';

export { captureAuthStoreExclusion } from './sqliteStoreIdentity.js';
export type { AuthStoreExclusion } from './sqliteStoreIdentity.js';

const refuse = (): never => {
  throw new Error('Authentication storage must remain separate from the captured business database and its SQLite sidecars.');
};

function destination(path: string): string {
  const tail: string[] = [];
  let ancestor = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink is not an absent destination: SQLite may follow it
      // and create the target. Missing parent paths resolve via their ancestor.
      try {
        if (lstatSync(ancestor).isSymbolicLink()) refuse();
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Synchronous acquisition fence, also called after auth's module-import waits.
 * It does not promise protection against hostile concurrent filesystem writers. */
export function assertAuthStoreSeparation(store: string, input: AuthStoreExclusion): void {
  try {
    const excluded = captureTenantData(input);
    tenantRecord(excluded, ['path', 'device', 'inode']);
    tenantIdentifier(excluded.path, 32768);
    if (![excluded.device, excluded.inode].every((value) => Number.isSafeInteger(value) && value >= 0)) return refuse();
    const info = statSync(excluded.path);
    if (!info.isFile() || info.dev !== excluded.device || info.ino !== excluded.inode) return refuse();
    const suffixes = ['', '-wal', '-shm', '-journal'];
    // SQLite resolves a database symlink before deriving its journal filename.
    // Check both written and resolved bases; resolving only "alias.db-wal"
    // would miss the sidecar beside the actual database target.
    const businessRoots = new Set([excluded.path, destination(excluded.path)]);
    const authRoots = new Set([resolve(store), destination(store)]);
    for (const business of businessRoots)
      for (const auth of authRoots)
        for (const businessSuffix of suffixes)
          for (const authSuffix of suffixes) {
            const left = business + businessSuffix,
              right = auth + authSuffix;
            if (destination(left) === destination(right)) return refuse();
            try {
              const a = statSync(left),
                b = statSync(right);
              if (a.dev === b.dev && a.ino === b.ino) return refuse();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
  } catch {
    return refuse();
  }
}

/* ---------- the PostgreSQL store ---------- */

/*
 * Two layers, because a URL is not a database.
 *
 * The URL comparison runs before anything is opened, and reads each URL the
 * way the driver will: through pg-connection-string, the parser `pg` itself
 * uses, so `?host=` and `?port=` override the authority here exactly as they
 * do on the wire, with pg's own defaults and PG* variables filling what the
 * URL leaves out. A host is compared by what it reaches, not how it is
 * spelled: every name for this machine (localhost and *.localhost,
 * 127.0.0.0/8, ::1 and its mapped forms, 0.0.0.0, a Unix socket directory,
 * its own hostname and interface addresses) is one host, and case, trailing
 * dots and alternative IPv4/IPv6 spellings are canonicalised. That refuses
 * more than it strictly must (two servers on different sockets of one
 * machine with the same port and database name), which is the safe way to
 * be wrong.
 *
 * Text cannot see DNS aliases, port forwards or proxies, so it is not the
 * authority: `assertPostgresAuthStoreServerSeparation` is, once the store is
 * open, by asking each server who it is.
 */

/** The one host every local spelling folds into; not a spelling a URL can produce. */
const THIS_MACHINE = ' this machine';

interface PgConnectionString {
  host?: string | null;
  port?: string | number | null;
  database?: string | null;
  user?: string | null;
}
interface PgReading {
  readonly parse: (url: string) => PgConnectionString;
  readonly defaults: { host?: unknown; port?: unknown; user?: unknown; database?: unknown };
}

let reading: PgReading | undefined;
/** The installed driver's parser and defaults, loaded synchronously so the
 * comparison can run before anything is awaited. pg-connection-string is
 * resolved from `pg`'s own location: the copy the driver uses, not another. */
function pgReading(): PgReading {
  if (reading) return reading;
  const here = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = here.resolve('pg');
  } catch {
    throw new Error('A postgres:// authentication store needs the "pg" package. Install it with: npm install pg');
  }
  const parser = createRequire(entry)('pg-connection-string') as { parse?: PgReading['parse'] };
  const pg = here('pg') as { defaults?: PgReading['defaults'] };
  if (typeof parser.parse !== 'function' || !pg.defaults)
    throw new Error('Could not read connection strings the way the installed "pg" package does.');
  return (reading = { parse: parser.parse, defaults: pg.defaults });
}

/** A host as a resolver would see it. IPv4 shorthand (`127.1`, `2130706433`)
 * and IPv6 spellings canonicalise through the WHATWG host parser; anything
 * that is not a plain ASCII name or address is compared as written. */
function canonicalHost(raw: string): string {
  let name = raw.trim().toLowerCase();
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  if (name.includes(':')) {
    name = name.replace(/%.*$/, '');
    try {
      return new URL(`http://[${name}]`).hostname.slice(1, -1);
    } catch {
      return name;
    }
  }
  name = name.replace(/\.+$/, '');
  if (!/^[a-z0-9._-]+$/.test(name)) return name;
  try {
    return new URL(`http://${name}`).hostname.replace(/\.+$/, '');
  } catch {
    return name;
  }
}

const loopback = (name: string): boolean =>
  name === '' ||
  name === 'localhost' ||
  name.endsWith('.localhost') ||
  name === '0.0.0.0' ||
  name === '::' ||
  name === '::1' ||
  (isIP(name) === 4 && name.startsWith('127.')) ||
  (isIP(name) === 6 && /^::(ffff:)?(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(name));

let ownNames: ReadonlySet<string> | undefined;
/** This machine's hostname and interface addresses, which reach a local server as surely as localhost does. */
function thisMachine(): ReadonlySet<string> {
  if (ownNames) return ownNames;
  const names = new Set<string>();
  try {
    names.add(canonicalHost(hostname()));
  } catch {
    /* no hostname to add */
  }
  try {
    for (const list of Object.values(networkInterfaces())) for (const address of list ?? []) names.add(canonicalHost(address.address));
  } catch {
    /* no interfaces to add */
  }
  names.delete('');
  return (ownNames = names);
}

function hostKey(host: string): string {
  if (host.trim().startsWith('/')) return THIS_MACHINE; // a Unix-domain socket directory
  const name = canonicalHost(host);
  return loopback(name) || thisMachine().has(name) ? THIS_MACHINE : name;
}

interface PostgresTarget {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

/** Where the driver would connect for this URL; null for a URL that is not
 * PostgreSQL's, or that the driver's parser cannot read. A password is never
 * looked at. */
function postgresTarget(url: string): PostgresTarget | null {
  if (!/^postgres(ql)?:\/\//i.test(url)) return null;
  const { parse, defaults } = pgReading();
  let config: PgConnectionString;
  try {
    config = parse(url);
  } catch {
    return null;
  }
  // pg's `val`: the URL's value when truthy, else PG<NAME>, else pg.defaults;
  // and a database left unnamed is the user's name. The PG* defaults match the
  // actual pg driver, which always reads them from process.env; callers supply
  // the captured App environment only for reference expansion, not for these.
  const setting = (value: unknown, name: string, fallback: unknown): unknown => value || process.env[`PG${name}`] || fallback;
  const user = setting(config.user, 'USER', defaults.user);
  const database = setting(config.database, 'DATABASE', defaults.database) ?? user;
  const host = setting(config.host, 'HOST', defaults.host) ?? 'localhost';
  const port = Number.parseInt(String(setting(config.port, 'PORT', defaults.port)), 10);
  return { host: hostKey(String(host)), port: String(port), database: String(database ?? '') };
}

/**
 * The PostgreSQL store may not be a business database. Refuses the store URL
 * when, read as the driver reads it, it reaches the same host, port and
 * database as any configured connection, with the same error the file rule
 * gives; a SQLite connection is never a collision for a PostgreSQL store.
 * Compared before anything is opened. The store is the resolved URL; a
 * connection's `${VAR}` references are expanded the way the registry expands
 * them, and compared as written when unset, so an unset one cannot hide a
 * collision.
 */
export function assertPostgresAuthStoreSeparation(
  store: string,
  connections: readonly { readonly url: string }[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const target = postgresTarget(store);
  if (target === null) return refuse();
  for (const connection of connections) {
    if (typeof connection?.url !== 'string') return refuse();
    let url = connection.url;
    try {
      url = expandEnv(url, environment);
    } catch {
      /* compared as written */
    }
    const other = postgresTarget(url);
    if (other && other.host === target.host && other.port === target.port && other.database === target.database) return refuse();
  }
}

/** A configured connection as the registry stores it: the name addresses its
 * keychain entry, and a `session` connection was added at runtime and gets
 * no secrets, as the registry dials an untrusted one. */
export interface PostgresSeparationConnection {
  readonly url: string;
  readonly name?: string;
  readonly source?: string;
}

interface ServerIdentity {
  readonly system: string | null;
  readonly database: string;
}

/* `pg_control_system()` is executable by PUBLIC on a stock server; its
   system identifier is fixed at initdb and shared only by physical copies
   of the cluster (a streaming replica serves the same data, so the same
   answer is right there). A role it has been revoked from, or a server that
   answers nothing usable, leaves the identity unknown, and unknown is
   treated as the same server. `inet_server_addr()` and `data_directory` are
   not used as a substitute: an address differs per interface and the
   directory is the same default path in every container, so neither can
   prove two servers different, which is the only thing a fallback would be
   asked to do. */
async function serverIdentity(client: PgQuery): Promise<ServerIdentity> {
  const database = String((await client.query('SELECT pg_catalog.current_database()::text AS database')).rows[0]?.database);
  let system: string | null = null;
  try {
    const row = (await client.query('SELECT system_identifier::text AS system FROM pg_catalog.pg_control_system()')).rows[0];
    if (typeof row?.system === 'string' && /^[1-9][0-9]*$/.test(row.system)) system = row.system;
  } catch {
    /* unknown */
  }
  return { system, database };
}

interface ProbeClient extends PgQuery {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}
interface ClientModule {
  Client?: new (options: Record<string, unknown>) => ProbeClient;
  default?: ClientModule;
}

const unconfirmed = (name: string, detail: string) =>
  new Error(
    `Could not confirm that connection "${name}" is separate from the authentication store: ${detail}. ` +
      'Every PostgreSQL connection must be reachable at startup when sessions are kept in PostgreSQL.',
  );

async function probe(
  url: string,
  name: string,
  written: string,
  prefixes: readonly string[],
): Promise<{ identity: ServerIdentity; visible: boolean }> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as ClientModule;
  const Client = pg.Client ?? pg.default?.Client;
  if (!Client) throw new Error('Could not find a Client export in the "pg" package.');
  /* Bounded by the driver, not by a `statement_timeout` startup parameter:
     PgBouncer refuses a startup parameter it does not know ("unsupported
     startup parameter"), so behind one the check could never connect and
     every App with a PostgreSQL store refused to start. Its statements are
     single catalog reads, which a pooler of either mode may run anywhere. */
  const client = new Client({ ...pgConnectionOptions(url), connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  client.on('error', () => {});
  try {
    await client.connect();
    const identity = await serverIdentity(client);
    /* The runtime schema of the connection's own database holds that App's
       own runtime tables, which its role may well own: only a store's tables
       there (the auth store of another App, say) are a reach to refuse. */
    const visible =
      (
        await client.query(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
                       WHERE n.nspname = $1 AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
                         AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                                      WHERE c.relnamespace = n.oid AND pg_catalog.lower(c.relname) LIKE ANY ($2::text[]))) AS visible`,
          [RUNTIME_SCHEMA, prefixes.map((prefix) => `${prefix.toLowerCase().replaceAll('_', '\\_')}%`)],
        )
      ).rows[0]?.visible === true;
    return { identity, visible };
  } catch (error) {
    throw unconfirmed(name, scrubSecrets(String((error as Error)?.message ?? error), url, written));
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The authoritative check, once the store's pool is open: each configured
 * PostgreSQL connection is dialled as the registry would dial it and asked
 * for its server's identity and its database. The same server and the same
 * database refuse with the separation error, whatever the URLs said.
 *
 * And in depth, for the raw SQL paths (`/api/sql`, the MCP `sql` and
 * `explain` tools), which run the operator's statements and filter no
 * schema: a connection whose role can use a runtime schema holding a
 * store's tables (`mistri.auth_…`) on the store's server, in whatever
 * database, is refused too. SQL text is never inspected for schema names;
 * the role's reach is what is refused.
 *
 * A connection that cannot be reached, or whose URL cannot be resolved, is
 * a refusal rather than a pass: it may be reachable later, and nothing
 * would check it then.
 *
 * `prefixes` name the store's tables in the runtime schema: the sign-in
 * store's `auth_`, or a suite's grant, preference and authority stores'.
 */
export async function assertPostgresAuthStoreServerSeparation(
  store: PgQuery,
  connections: readonly PostgresSeparationConnection[],
  environment: NodeJS.ProcessEnv = process.env,
  prefixes: readonly string[] = [POSTGRES_AUTH_PREFIX],
): Promise<void> {
  let storeIdentity: ServerIdentity | undefined;
  for (const connection of connections) {
    if (typeof connection?.url !== 'string') return refuse();
    const name = typeof connection.name === 'string' && connection.name ? connection.name : 'a configured connection';
    let url: string;
    try {
      url = connection.name
        ? (await resolveConnection(connection.name, connection.url, { secrets: connection.source !== 'session', environment })).url
        : expandEnv(connection.url, environment);
    } catch (error) {
      // Never openable in this process, and not known to be PostgreSQL: nothing to compare.
      if (!/^postgres(ql)?:\/\//i.test(connection.url)) continue;
      throw unconfirmed(name, scrubSecrets(String((error as Error)?.message ?? error), connection.url));
    }
    if (!/^postgres(ql)?:\/\//i.test(url)) continue;
    storeIdentity ??= await serverIdentity(store);
    const { identity, visible } = await probe(url, name, connection.url, prefixes);
    const sameServer = storeIdentity.system === null || identity.system === null || storeIdentity.system === identity.system;
    if (!sameServer) continue;
    if (identity.database === storeIdentity.database) return refuse();
    if (visible) {
      throw new Error(
        `Authentication storage must remain separate from the business databases: connection "${name}" can use a "${RUNTIME_SCHEMA}" schema holding ${prefixes
          .map((prefix) => `${prefix}…`)
          .join(
            ' or ',
          )} tables on the authentication store's PostgreSQL server, which its raw SQL could read. Connect it as a role without USAGE on that schema, or keep the store on another server.`,
      );
    }
  }
}
