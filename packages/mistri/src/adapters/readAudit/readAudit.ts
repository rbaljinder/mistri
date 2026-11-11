/**
 * The read audit, the store's half: who read which of an audited resource's
 * rows, when and through which door. One row per read a request makes of an
 * audited resource (a list page is one read, a record one), written before
 * the rows leave the server (server/readAudit.ts says why and how).
 *
 * A row names the reader, never what they read: the record's id, or the
 * query that found rows with how many it found and the ids of the ones it
 * returned, bounded by the page. No field value is ever kept, so the log is
 * not a second copy of the data it guards.
 *
 * Append-only on both engines (SQLite triggers, PostgreSQL rules), and the
 * layout checks count them, so a store with them dropped is refused. Nothing
 * prunes it: a read audit is evidence for as long as the store exists
 * (SECURITY.md). A tenant App's rows carry the tenant and are written and
 * read only through that tenant's own fenced source.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';

/** Version 2 adds the `command` route and the command's id beside it: a command's handler and lookup read audited
    rows too (version 1 never saw them). Version 3 adds the reader's roles and, on a tenant App, the membership it read
    through: an account id alone could not say what the reader was let read, nor which membership held a token. An
    older store is upgraded in place by `mistri migrate stores up`. */
export const READ_AUDIT_VERSION = 3;
export const READ_AUDIT_PREFIX = '__mistri_read_audit_';
export const READ_AUDIT_TABLES = Object.freeze({
  meta: `${READ_AUDIT_PREFIX}meta`,
  row: `${READ_AUDIT_PREFIX}row`,
});
/** One record's readers, newest last: what `mistri audit reads --record` asks. */
export const READ_AUDIT_RECORD_INDEX = `${READ_AUDIT_PREFIX}row_record`;
/** By age: what `--since` asks, so neither scans the log. */
export const READ_AUDIT_AT_INDEX = `${READ_AUDIT_PREFIX}row_at`;

/** The doors a read comes through. `related` is a list of an audited resource read beside another record's page;
    `command` is a command's handler or lookup reading, and the row names the command. */
export const READ_ROUTES = Object.freeze([
  'page',
  'api',
  'mcp',
  'assistant',
  'export',
  'picker',
  'custom-page',
  'related',
  'command',
] as const);
export type ReadRoute = (typeof READ_ROUTES)[number];

/** Bounds, the same on every engine. `ids` is a page's worth: a longer one is kept cut and says so (`count` stays whole). */
export const READ_AUDIT_LIMITS = Object.freeze({
  app: 200,
  tenant: 200,
  actor: 400,
  visit: 200,
  resource: 512,
  command: 200,
  /** A membership's id, as long as tenant administration lets one be (tenantAdministration.ts). */
  membership: 1024,
  /** The roles' JSON array: a role's name is a word, and a reader holds a few. */
  roles: 4096,
  record: 2048,
  query: 16_384,
  ids: 65_536,
  idCount: 500,
});

export class ReadAuditUnavailable extends Refusal {
  constructor(
    message = 'The read audit store is missing or is not the layout this version expects. It is provisioned once, never on ' +
      "startup: run `mistri migrate stores up --app <the App's directory>`, or provisionStores(<the database>, { only: ['read-audit'] }) from " +
      '@mistriwork/mistri/maintenance against the database, then start again. A foreign layout is refused, not altered.',
  ) {
    super(message);
    this.name = 'ReadAuditUnavailable';
  }
}

/** One read, as it is appended. Exactly one of `record` and `query`. */
export interface ReadAuditRow {
  /** ISO instant. */
  readonly at: string;
  readonly app: string;
  /** The tenant whose rows were read; '' outside a tenant App. */
  readonly tenant: string;
  /** An account id, or `service:<principal>`, `support:<operator>`, `api-token:<id>`, `assistant:<account>`. */
  readonly actor: string;
  /** The roles the read was granted under, as the grant held them, sorted; absent where no role grants it (a
      signed-out visitor, a service, a support operator). An API token's are the token's own, which may be fewer than
      its holder's. */
  readonly roles?: readonly string[];
  /** On a tenant App, the membership the reader read through: a person's own, or the one that holds the API token. */
  readonly membership?: string;
  /** A support visit's id, when the read was made under one. */
  readonly visit?: string;
  readonly resource: string;
  readonly route: ReadRoute;
  /** The command whose handler or lookup made the read: present exactly when the route is `command`. */
  readonly command?: string;
  /** One record's id, as the store's key text. */
  readonly record?: string;
  /** The normalized query (where, search, sort, offset) that found the rows, as canonical JSON. */
  readonly query?: string;
  /** How many rows the query returned. */
  readonly count?: number;
  /** The returned rows' ids, as a JSON array of strings, at most `idCount`. */
  readonly ids?: string;
}

export interface StoredReadAudit extends ReadAuditRow {
  readonly id: number;
}

/** What `mistri audit reads` and `host.readAudit()` ask: newest first, every filter optional but the limit. */
export interface ReadAuditQuery {
  readonly app?: string;
  readonly tenant?: string;
  readonly resource?: string;
  readonly record?: string;
  readonly actor?: string;
  /** ISO instant: rows at or after it. */
  readonly since?: string;
  readonly limit: number;
}

const text = (value: unknown, limit: number, name: string, empty = false): string => {
  if (typeof value !== 'string' || (!empty && !value) || Buffer.byteLength(value) > limit)
    throw new Refusal(`A read audit row's ${name} must be a string of at most ${limit} bytes.`);
  return value;
};

/** The row as it may be stored, or a refusal; never trimmed silently but for `ids`, which says so by its own length. */
export function assertReadAuditRow(row: ReadAuditRow): ReadAuditRow {
  if (typeof row !== 'object' || row === null) throw new Refusal('A read audit row must be an object.');
  if (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))) throw new Refusal("A read audit row's at must be an ISO instant.");
  text(row.app, READ_AUDIT_LIMITS.app, 'app');
  text(row.tenant, READ_AUDIT_LIMITS.tenant, 'tenant', true);
  text(row.actor, READ_AUDIT_LIMITS.actor, 'actor');
  if (row.roles !== undefined) {
    if (!Array.isArray(row.roles) || row.roles.some((role) => typeof role !== 'string' || !role))
      throw new Refusal("A read audit row's roles must be a list of role names.");
    text(JSON.stringify(row.roles), READ_AUDIT_LIMITS.roles, 'roles');
  }
  if (row.membership !== undefined) text(row.membership, READ_AUDIT_LIMITS.membership, 'membership');
  if (row.visit !== undefined) text(row.visit, READ_AUDIT_LIMITS.visit, 'visit');
  text(row.resource, READ_AUDIT_LIMITS.resource, 'resource');
  if (!(READ_ROUTES as readonly string[]).includes(row.route))
    throw new Refusal(`A read audit row's route must be one of ${READ_ROUTES.join(', ')}.`);
  if ((row.command !== undefined) !== (row.route === 'command'))
    throw new Refusal("A read audit row names its command exactly when its route is 'command'.");
  if (row.command !== undefined) text(row.command, READ_AUDIT_LIMITS.command, 'command');
  if ((row.record === undefined) === (row.query === undefined)) throw new Refusal('A read audit row names one record or one query.');
  if (row.record !== undefined) text(row.record, READ_AUDIT_LIMITS.record, 'record');
  if (row.query !== undefined) {
    text(row.query, READ_AUDIT_LIMITS.query, 'query');
    if (!Number.isSafeInteger(row.count) || row.count! < 0) throw new Refusal("A read audit row's count must be a whole number.");
    text(row.ids, READ_AUDIT_LIMITS.ids, 'ids');
    const ids: unknown = JSON.parse(row.ids!);
    if (!Array.isArray(ids) || ids.length > READ_AUDIT_LIMITS.idCount || ids.some((id) => typeof id !== 'string'))
      throw new Refusal(`A read audit row's ids must be at most ${READ_AUDIT_LIMITS.idCount} strings.`);
  } else if (row.count !== undefined || row.ids !== undefined) throw new Refusal('A read audit row of one record has no count or ids.');
  return row;
}

export function assertReadAuditQuery(query: ReadAuditQuery): ReadAuditQuery {
  if (typeof query !== 'object' || query === null) throw new Refusal('A read audit query must be an object.');
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000)
    throw new Refusal('A read audit query reads 1 to 10000 rows.');
  for (const key of ['app', 'tenant', 'resource', 'record', 'actor'] as const)
    if (query[key] !== undefined && typeof query[key] !== 'string') throw new Refusal(`A read audit query's ${key} must be a string.`);
  if (query.since !== undefined && (typeof query.since !== 'string' || Number.isNaN(Date.parse(query.since))))
    throw new Refusal("A read audit query's since must be an ISO instant.");
  return query;
}

/** A stored row read back, the same on both engines. */
export function storedReadAudit(row: Record<string, unknown>): StoredReadAudit {
  return Object.freeze({
    id: Number(row.id),
    at: String(row.at),
    app: String(row.app),
    tenant: String(row.tenant),
    actor: String(row.actor),
    ...(row.roles_json == null ? {} : { roles: Object.freeze(JSON.parse(String(row.roles_json)) as string[]) }),
    ...(row.membership == null ? {} : { membership: String(row.membership) }),
    ...(row.visit == null ? {} : { visit: String(row.visit) }),
    resource: String(row.resource),
    route: row.route as ReadRoute,
    ...(row.command == null ? {} : { command: String(row.command) }),
    ...(row.record_key == null ? {} : { record: String(row.record_key) }),
    ...(row.query_json == null ? {} : { query: String(row.query_json), count: Number(row.row_count), ids: String(row.ids_json) }),
  });
}

/**
 * The filters both engines apply, as (column, value) pairs in one order. `shown` is a record's: a row that read it by
 * its key, or a list read whose returned ids include it. A list page is how most records are seen, so a record's
 * readers asked by key alone missed every one who saw it in a list (a field report). Each engine says it its own way.
 */
export function readAuditFilters(query: ReadAuditQuery): Array<readonly [column: string, op: '=' | '>=' | 'shown', value: string]> {
  const filters: Array<readonly [string, '=' | '>=' | 'shown', string]> = [];
  if (query.app !== undefined) filters.push(['app', '=', query.app]);
  if (query.tenant !== undefined) filters.push(['tenant', '=', query.tenant]);
  if (query.resource !== undefined) filters.push(['resource', '=', query.resource]);
  if (query.record !== undefined) filters.push(['record_key', 'shown', query.record]);
  if (query.actor !== undefined) filters.push(['actor', '=', query.actor]);
  if (query.since !== undefined) filters.push(['at', '>=', new Date(query.since).toISOString()]);
  return filters;
}
