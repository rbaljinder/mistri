/**
 * The read audit's store, as the server binds it: the refusal to start an App
 * whose audited resources sit on a database without the store, and the read
 * `mistri audit reads` and the test kit's `host.readAudit()` make.
 *
 * Kept apart from readAudit.ts, which authorizeResources imports: that one
 * must stay light, and this one loads an App's runtime resources.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppDef } from '../shared/app.js';
import { ReadAuditUnavailable, type ReadAuditQuery, type ReadAuditRow, type StoredReadAudit } from '../adapters/readAudit/readAudit.js';
import type { AppHost } from './app/apps.js';
import { appEntrypoint } from './app/appEntrypoint.js';
import { loadAppRuntimeResources } from './app/appRuntimeResources.js';
import { storesOf } from './stores/appStores.js';
import type { AuditedAccess, ReadAuditSink } from './readAudit.js';

/** What a database (or a tenant's facade over one) answers for the read audit. */
interface ReadAuditStore {
  readAuditReady(): Promise<boolean>;
  appendReadAudit(row: ReadAuditRow): Promise<void>;
  readReadAudit(query: ReadAuditQuery): Promise<StoredReadAudit[]>;
}

const holdsReadAudit = (source: unknown): source is ReadAuditStore =>
  typeof source === 'object' &&
  source !== null &&
  typeof (source as ReadAuditStore).readAuditReady === 'function' &&
  typeof (source as ReadAuditStore).appendReadAudit === 'function' &&
  typeof (source as ReadAuditStore).readReadAudit === 'function';

/** The read audit over a source: a dialect adapter's store, a tenant facade itself, or a refusal for anything else. */
export function readAuditStoreOf(source: unknown, connection = 'this connection'): ReadAuditStore {
  const store = storesOf(source);
  if (!holdsReadAudit(store))
    throw new ReadAuditUnavailable(`The read audit is kept in SQLite or PostgreSQL, and ${connection} is neither.`);
  return store;
}

/**
 * A grant with its read audit sink, where the reader is known and its rows
 * sit on `source`: unchanged where the grant audits nothing, so an App that
 * audits nothing carries no sink.
 */
export function withReadAuditSink<T extends AuditedAccess>(
  access: T,
  sink: Omit<ReadAuditSink, 'append'>,
  source: unknown,
  connection: string,
): T {
  if (!access.audited?.size) return access;
  return {
    ...access,
    readAudit: { ...sink, append: (row) => readAuditStoreOf(source, `connection "${connection}"`).appendReadAudit(row) },
  };
}

/** As `withReadAuditSink`, for rows that belong on several databases: each row goes to the source of the connection it names. */
export function withReadAuditSinkPer<T extends AuditedAccess>(
  access: T,
  sink: Omit<ReadAuditSink, 'append'>,
  sourceOf: (connection: string) => unknown | Promise<unknown>,
): T {
  if (!access.audited?.size) return access;
  return {
    ...access,
    readAudit: {
      ...sink,
      append: async (row, connection) => readAuditStoreOf(await sourceOf(connection), `connection "${connection}"`).appendReadAudit(row),
    },
  };
}

/** The resources whose reads an App audits. */
export const auditedResources = (app: Pick<AppDef, 'resources'>): string[] =>
  Object.entries(app.resources ?? {})
    .filter(([, resource]) => resource.audit?.reads === true)
    .map(([name]) => name);

const ensured = new WeakMap<Registry, WeakSet<AppDef>>();

/**
 * Refuse to serve an App whose audited resources sit on a database without
 * the store, naming the command that makes it: at startup and on the first
 * request after a reload, before any route reads. An App that audits nothing
 * opens nothing here.
 */
export async function ensureAppReadAudit(registry: Registry, host: AppHost): Promise<void> {
  const { app } = host.app;
  let seen = ensured.get(registry);
  if (!seen) ensured.set(registry, (seen = new WeakSet()));
  if (seen.has(app)) return;
  const audited = auditedResources(app);
  if (audited.length) {
    const entry = appEntrypoint(host, registry);
    if (!entry) return;
    const releases: Array<() => void> = [];
    try {
      const resources = await loadAppRuntimeResources(registry, app, entry, (owner) => releases.push(registry.lease(owner)));
      for (const connection of new Set(audited.map((resource) => resources.connectionFor(resource)))) {
        const { adapter } = await registry.open(connection);
        const store = storesOf(adapter);
        if (!holdsReadAudit(store) || !(await store.readAuditReady()))
          throw new ReadAuditUnavailable(readAuditUnavailable(app.id, connection, adapter.dialect));
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
  seen.add(app);
}

/* As record history's refusal: the one command and the one call; the URL or path is the operator's to supply. */
function readAuditUnavailable(app: string, connection: string, dialect: string): string {
  const at = `${app} audits reads of a resource, and the read audit store on connection "${connection}" is unavailable`;
  const call =
    dialect === 'sqlite'
      ? "provisionStores({ sqlite: '<the database file>' }, { only: ['read-audit'] })"
      : dialect === 'postgres'
        ? "provisionStores({ postgres: '<the connection's URL>' }, { only: ['read-audit'] }), as a role that may create tables"
        : undefined;
  if (!call) return `${at}: the read audit is kept in SQLite or PostgreSQL, and this connection is ${dialect}.`;
  return (
    `${at}: it is provisioned once, never on startup. Run \`mistri migrate stores up --app <the App's directory>\` ` +
    `with the server stopped, or ${call} from @mistriwork/mistri/maintenance, then start again.`
  );
}

/**
 * An App's read audit, newest first, from every database its audited
 * resources sit on. `query.app` is the App's own id unless the caller names
 * one; rows from two databases are merged by when they were written.
 */
export async function readAppReadAudit(
  registry: Registry,
  host: AppHost,
  query: Omit<ReadAuditQuery, 'limit'> & { limit?: number },
): Promise<StoredReadAudit[]> {
  const { app } = host.app;
  const audited = query.resource !== undefined ? [query.resource] : auditedResources(app);
  if (!audited.length) return [];
  const entry = appEntrypoint(host, registry);
  if (!entry) return [];
  const limit = query.limit ?? 1000;
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, entry, (owner) => releases.push(registry.lease(owner)));
    const rows: StoredReadAudit[] = [];
    for (const connection of new Set(audited.map((resource) => resources.connectionFor(resource)))) {
      const { adapter } = await registry.open(connection);
      rows.push(
        ...(await readAuditStoreOf(adapter, `connection "${connection}"`).readReadAudit({ ...query, app: query.app ?? app.id, limit })),
      );
    }
    return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id)).slice(0, limit);
  } finally {
    for (const release of releases.reverse()) release();
  }
}
