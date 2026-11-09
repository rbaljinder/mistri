/**
 * The read audit, the server's half: a resource that says `audit: { reads:
 * true }` has every read of its rows written down, who and through which door,
 * before those rows leave the server.
 *
 * The seam is the one place a reader's rows are authorized, authorizeResources
 * (app/appAccess.ts), not each route: a route added later that reads an
 * audited resource is audited because it cannot read it any other way. Two
 * things meet there. The grant carries the audited tables and a sink (the
 * App, the tenant, the reader and where a row is appended), resolved where
 * the reader is; the door a request came in by (page, api, mcp, ...) rides
 * the request's async context, set where the request is routed.
 *
 * It fails closed. A read of an audited table outside any door (no context at
 * all) or under a grant without a sink is refused, so a path nobody wired
 * cannot read quietly; the server's own reads (a label, a zone, a mail it
 * sends) say so with `withoutReadAudit`. A row that cannot be written stops
 * the request: ReadAuditFailed is answered 503 with no body, and the rows it
 * read never leave.
 *
 * What a row costs: one insert, its own statement, on the audited table's
 * own database, and nothing for a table that is not audited. Within one
 * process a re-read inside COALESCE_MS that matches an earlier row on every
 * field that says what was read (app, tenant, actor, visit, resource, route,
 * the record or the query and the ids it returned) is not written again: a
 * page that refetches the same list three times in a breath is one read. A
 * new query, a new route or another page of the same list always writes.
 * Coalescing is per process, so a second replica writes its own row.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { QueryRequest, ViewResult } from '@mistriwork/engine/adapters/adapter.js';
import type { QueryResult } from '@mistriwork/engine/shared/reads.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { ViewDef } from '@mistriwork/engine/shared/viewPaths.js';
import { PAGE_HEADER } from '@mistriwork/engine/shared/pageRoutes.js';
import { READ_AUDIT_LIMITS, type ReadAuditRow, type ReadRoute } from '../adapters/readAudit/readAudit.js';

/** Where audited rows are written, resolved with the reader's grant. */
export interface ReadAuditSink {
  readonly app: string;
  /** The tenant whose rows these are; '' outside a tenant App. */
  readonly tenant: string;
  /** An account id, `service:<principal>`, `support:<operator>`, `api-token:<id>` or `public` for a signed-out visitor; the assistant's reads are written `assistant:<this>`. */
  readonly actor: string;
  /** A support visit's id. */
  readonly visit?: string;
  /** One row, durable before it resolves, on the database that holds `connection`'s rows. */
  append(row: ReadAuditRow, connection: string): Promise<void>;
}

/** The door a request came in by. `actor` replaces the sink's (an API token's reads are `api-token:<id>`). */
interface ReadDoor {
  readonly route: ReadRoute;
  readonly actor?: string;
}

/** A read audit row could not be written, or an audited read came by no door: the request is answered 503, empty. */
export class ReadAuditFailed extends Error {
  /* `cause` is what failed beneath: a tenant's unavailable writer (tenant/tenantReadAudit.ts), which the tenant host answers 503. */
  constructor(message = 'The read could not be recorded in the read audit.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReadAuditFailed';
  }
}

/* `null` is the server's own read, never audited; no store at all is a read by no door, refused. */
const doors = new AsyncLocalStorage<ReadDoor | null>();

/** Run a request's work as reads through `route`. */
export function withReadRoute<T>(route: ReadRoute, work: () => T, actor?: string): T {
  return doors.run({ route, ...(actor ? { actor } : {}) }, work);
}

/** The server's own reads (a label, a zone, a notification's record): not a reader's, so not audited. */
export function withoutReadAudit<T>(work: () => T): T {
  return doors.run(null, work);
}

/** The door the current request came in by, if any. */
export function currentReadRoute(): ReadRoute | undefined {
  return doors.getStore()?.route;
}

/** The header a picker's read (the kit's `pickerApi`) and a related list's (`relatedApi`) carry: the same reads a list makes, said for what they are. */
const READ_HEADER = 'x-mistri-read';

/** How a request's address (and the two headers that say more) names its door; `page` unless it says otherwise. */
export function readRouteOf(pathname: string, headers: Readonly<Record<string, string | string[] | undefined>> = {}): ReadRoute {
  /* The address decides first: a header only refines a page's read, so no request can relabel an export or an API
     read as something milder in the log. */
  const door = routeOfPath(pathname);
  if (door !== 'page') return door;
  if (headers[READ_HEADER] === 'picker') return 'picker';
  if (headers[READ_HEADER] === 'related') return 'related';
  /* A free-form page's own reads say which page asks (kit `pageApi`). */
  if (headers[PAGE_HEADER] !== undefined) return 'custom-page';
  return 'page';
}

function routeOfPath(pathname: string): ReadRoute {
  if (pathname === '/api/export' || pathname.startsWith('/api/export/')) return 'export';
  if (pathname === '/api/pages/load') return 'custom-page';
  if (pathname === '/api/references') return 'picker';
  if (pathname.startsWith('/api/assistant')) return 'assistant';
  if (pathname === '/api/mcp' || pathname.startsWith('/mcp')) return 'mcp';
  if (pathname.startsWith('/api/v')) return 'api';
  return 'page';
}

const COALESCE_MS = 60_000;
const COALESCE_LIMIT = 10_000;
/* Each key's first row and when it was asked for: a read coalesced into a row still being written waits for that
   row, so no rows leave on the strength of a write that may yet fail. */
const recent = new Map<string, { at: number; written: Promise<void> }>();

function coalesced(key: string, now: number): Promise<void> | undefined {
  const prior = recent.get(key);
  if (prior !== undefined && now - prior.at < COALESCE_MS) return prior.written;
  recent.delete(key);
  if (recent.size >= COALESCE_LIMIT) {
    /* Oldest first: a Map keeps insertion order, and a key re-set above moved to the end. */
    for (const [old, { at }] of recent) {
      if (recent.size < COALESCE_LIMIT && now - at < COALESCE_MS) break;
      recent.delete(old);
    }
  }
  return undefined;
}

/** For tests: forget what was written, so a re-read writes again. */
export function forgetReadAuditCoalescing(): void {
  recent.clear();
}

/** The table's key columns, which a row's ids are read from. */
function keyColumns(schema: DatabaseSchema, table: string): string[] {
  const found = schema.tables.find((candidate) => candidate.id === table);
  return found ? found.columns.filter((column) => column.primaryKey).map((column) => column.name) : [];
}

const keyText = (row: Record<string, unknown>, columns: readonly string[]): string | undefined => {
  if (!columns.length || columns.some((column) => row[column] === undefined || row[column] === null)) return undefined;
  return columns.length === 1 ? String(row[columns[0]]) : JSON.stringify(columns.map((column) => String(row[column])));
};

/** The one record a read named by its key alone (`id = 7`), or undefined for any other read. */
function namedRecord(
  groups: ReadonlyArray<ReadonlyArray<{ op: string; value?: unknown; other?: string }>> | undefined,
  key: string | undefined,
  keys: readonly string[],
) {
  if (keys.length !== 1 || groups?.length !== 1 || groups[0].length !== 1) return undefined;
  const condition = groups[0][0] as { op: string; value?: unknown; other?: string; column?: string; path?: string };
  const column = condition.column ?? condition.path;
  if (column !== keys[0] || condition.op !== '=' || condition.other !== undefined) return undefined;
  if (typeof condition.value !== 'string' && typeof condition.value !== 'number') return undefined;
  return key === undefined || key === String(condition.value) ? String(condition.value) : undefined;
}

interface Read {
  readonly table: string;
  readonly resource: string;
  readonly connection: string;
  readonly groups: ReadonlyArray<ReadonlyArray<{ op: string; value?: unknown; other?: string }>> | undefined;
  readonly sort: unknown;
  readonly offset: number;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** The result's names of the table's key columns, in key order; empty where the read did not return them. */
  readonly keys: readonly string[];
}

/**
 * Write one row for a read, or refuse. `sink` absent with a door set is a
 * grant nobody wired: refused. Resolves once the row is durable.
 */
async function record(read: Read, sink: ReadAuditSink | undefined): Promise<void> {
  const door = doors.getStore();
  if (door === null) return;
  if (door === undefined || !sink) throw new ReadAuditFailed('An audited resource was read outside any audited door.');
  const ids = read.rows.flatMap((row) => keyText(row, read.keys) ?? []);
  const named = namedRecord(read.groups, read.rows.length <= 1 ? ids[0] : undefined, read.keys);
  /* The assistant reads as the person it acts for, and says so. */
  const actor = door.actor ?? (door.route === 'assistant' ? `assistant:${sink.actor}` : sink.actor);
  const base = {
    at: new Date().toISOString(),
    app: sink.app,
    tenant: sink.tenant,
    actor: actor.slice(0, READ_AUDIT_LIMITS.actor),
    ...(sink.visit ? { visit: sink.visit } : {}),
    resource: read.resource,
    route: door.route,
  };
  let row: ReadAuditRow;
  if (named !== undefined && read.rows.length <= 1) row = { ...base, record: named };
  else {
    const kept = ids.slice(0, READ_AUDIT_LIMITS.idCount);
    row = {
      ...base,
      query: canonicalCommandJson({ where: read.groups ?? [], sort: read.sort ?? [], offset: read.offset }, READ_AUDIT_LIMITS.query),
      count: read.rows.length,
      ids: JSON.stringify(kept),
    };
  }
  const key = [
    row.app,
    row.tenant,
    row.actor,
    row.visit ?? '',
    row.resource,
    row.route,
    row.record ?? '',
    row.query ?? '',
    row.ids ?? '',
  ].join('\0');
  const now = Date.now();
  const pending = coalesced(key, now);
  if (pending) return pending;
  const written = sink.append(row, read.connection).catch((error: unknown) => {
    if (recent.get(key)?.written === written) recent.delete(key);
    throw new ReadAuditFailed(`The read could not be recorded in the read audit: ${(error as Error).message}`, { cause: error });
  });
  recent.set(key, { at: now, written });
  return written;
}

/** The parts of a grant authorizeResources reads: which tables are audited (table id → resource) and where rows go. */
export interface AuditedAccess {
  readonly audited?: ReadonlyMap<string, string>;
  readonly readAudit?: ReadAuditSink;
}

/** A `query` of an audited table, its row written before its result is handed on. */
export async function auditQueryRead(
  access: AuditedAccess,
  schema: DatabaseSchema,
  connection: string,
  request: QueryRequest,
  result: QueryResult,
): Promise<QueryResult> {
  const resource = access.audited?.get(request.table);
  if (resource === undefined) return result;
  const keys = keyColumns(schema, request.table);
  await record(
    {
      table: request.table,
      resource,
      connection,
      groups: request.filter?.groups,
      sort: request.orderBy,
      offset: request.offset,
      rows: result.rows,
      keys: keys.every((column) => result.columns.includes(column)) ? keys : [],
    },
    access.readAudit,
  );
  return result;
}

/** A `runView` over an audited base table: its base rows' ids, never a joined table's. */
export async function auditViewRead(
  access: AuditedAccess,
  schema: DatabaseSchema,
  connection: string,
  view: ViewDef,
  offset: number,
  result: ViewResult,
): Promise<ViewResult> {
  const resource = access.audited?.get(view.base);
  if (resource === undefined) return result;
  const keys = keyColumns(schema, view.base);
  const names = keys.map((column) => result.resolved.find((compiled) => compiled.hops === 0 && compiled.column === column)?.name);
  await record(
    {
      table: view.base,
      resource,
      connection,
      groups: view.filter?.groups,
      sort: view.orderBy,
      offset,
      rows: result.rows,
      keys: names.every((name): name is string => name !== undefined) ? names : [],
    },
    access.readAudit,
  );
  return result;
}
