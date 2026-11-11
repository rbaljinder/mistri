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
 * the request: ReadAuditFailed is answered 503 (READ_NOT_RECORDED), and the rows it
 * read never leave.
 *
 * What a row costs: a place in the next group commit on the audited table's
 * own database (adapters/readAudit/groupCommit.ts) — one insert and one writer
 * for the rows gathered while the ones before them were written, so a page's
 * reads together cost a few round trips, not one each — and nothing for
 * a table that is not audited. Within one
 * process a re-read inside COALESCE_MS that matches an earlier row on every
 * field that says what was read (app, tenant, actor, visit, resource, route,
 * the record or the query and the ids it returned) is not written again: a
 * page that refetches the same list three times in a breath is one read. A
 * new query, a new route or another page of the same list always writes.
 * Coalescing is per process, so a second replica writes its own row.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { isPoolBusy, POOL_BUSY_MESSAGE, poolBusyRetryAfterSeconds } from '@mistriwork/engine/adapters/poolMetrics.js';
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
  /** Rows written in a transaction that may yet roll back (a command handler's reads): never coalesced, since a row
   * rolled back was never kept, and the same read again must write it again. */
  readonly held?: boolean;
}

/** The door a request came in by. `actor` replaces the sink's (an API token's reads are `api-token:<id>`). */
interface ReadDoor {
  readonly route: ReadRoute;
  readonly actor?: string;
  /** A command's id, where the read is its handler's or its lookup's (route `command`). */
  readonly command?: string;
}

/** A read audit row could not be written, or an audited read came by no door: the request is answered 503 (READ_NOT_RECORDED). */
export class ReadAuditFailed extends Error {
  /* `cause` is what failed beneath: a tenant's unavailable writer (tenant/tenantReadAudit.ts), which the tenant host answers 503. */
  constructor(message = 'The read could not be recorded in the read audit.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReadAuditFailed';
  }
}

/** What both hosts answer (503) when a read's row could not be written: fixed words, never why, and none of what was read. */
export const READ_NOT_RECORDED = Object.freeze({ error: 'The read could not be recorded. Try again.', code: 'read_not_recorded' });

/** Whether `error` is a read the audit could not record, directly or beneath what wrapped it. */
export function readNotRecorded(error: unknown): boolean {
  return auditFailure(error) !== undefined;
}

function auditFailure(error: unknown): ReadAuditFailed | undefined {
  for (let at = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) if (at instanceof ReadAuditFailed) return at;
  return undefined;
}

/**
 * What a read the audit could not record is answered (503 either way, and nothing it read leaves). A row refused
 * because the pool lent no writer in time is the server busy, said as any busy refusal is (reply.ts sendBusy), with
 * when to ask again, so a client retries it; any other failure keeps the fixed words, never why.
 */
export function readAuditRefusal(error: unknown): { body: { error: string; code: string }; retryAfter?: number } {
  for (let at = auditFailure(error)?.cause, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++)
    if (isPoolBusy(at)) return { body: { error: POOL_BUSY_MESSAGE, code: 'server_busy' }, retryAfter: poolBusyRetryAfterSeconds(at) };
  return { body: READ_NOT_RECORDED };
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

/**
 * A batched read's own door: the batch (`POST /api/boot` with `reads`) is one request, so the `x-mistri-read` a picker's
 * or a related list's read would have carried alone rides on its item, and is read here as the header is. The address
 * still decides first, and only a page's read is refined, as `readRouteOf` has it.
 */
export function withReadKind<T>(path: string, kind: string | undefined, work: () => T): T {
  const door = doors.getStore();
  if (!door || door.route !== 'page' || kind === undefined) return work();
  const route = readRouteOf(path, { [READ_HEADER]: kind });
  return route === door.route ? work() : doors.run({ ...door, route }, work);
}

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
  if (/^\/api\/v\d+(\/|$)/.test(pathname)) return 'api';
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
  /** What the read was, where it was no query of the table (the event feed's `$events`); never a record. */
  readonly said?: string;
}

/**
 * The text a list read's row keeps for what it asked: its conditions, sort and offset as canonical JSON. A parsed
 * condition carries members the JSON has no word for — `is empty` is `{ op: 'isNull', value: undefined }` — and the
 * canonical writer refuses those outright; refused there, the read failed as no audit failure at all and a tenant
 * page answered it as its session lost (a field report). So the conditions go through JSON first, which leaves an
 * absent member out and spells a bigint as its digits. What still cannot be kept — a query past
 * READ_AUDIT_LIMITS.query — is a read the audit could not record, answered as one (`mistri check` names the App's
 * own queries that would be: build/checkReadAudit.ts).
 */
export function auditQuery(groups: unknown, sort: unknown, offset: number): string {
  try {
    const plain: unknown = JSON.parse(
      JSON.stringify({ where: groups ?? [], sort: sort ?? [], offset }, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
    return canonicalCommandJson(plain, READ_AUDIT_LIMITS.query);
  } catch (error) {
    throw new ReadAuditFailed('The read could not be recorded in the read audit: its query is too large to keep.', { cause: error });
  }
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
  const named = read.said === undefined ? namedRecord(read.groups, read.rows.length <= 1 ? ids[0] : undefined, read.keys) : undefined;
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
    ...(door.route === 'command' && door.command !== undefined ? { command: door.command } : {}),
  };
  let row: ReadAuditRow;
  if (named !== undefined && read.rows.length <= 1) row = { ...base, record: named };
  else {
    const kept = ids.slice(0, READ_AUDIT_LIMITS.idCount);
    row = {
      ...base,
      query: read.said ?? auditQuery(read.groups, read.sort, read.offset),
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
    row.command ?? '',
    row.record ?? '',
    row.query ?? '',
    row.ids ?? '',
  ].join('\0');
  const now = Date.now();
  const pending = sink.held ? undefined : coalesced(key, now);
  if (pending) return pending;
  const written = sink.append(row, read.connection).catch((error: unknown) => {
    if (recent.get(key)?.written === written) recent.delete(key);
    throw new ReadAuditFailed(`The read could not be recorded in the read audit: ${(error as Error).message}`, { cause: error });
  });
  if (!sink.held) recent.set(key, { at: now, written });
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

/** Where a command's reads of audited resources are written: the sink of the person it runs for, and each table's database. */
export interface CommandReadAudit {
  readonly sink: ReadAuditSink;
  /** The registry owner of a logical table, which its row is written to. */
  connectionOf(table: string): string;
}

/**
 * A command's own read of an audited resource — its handler's `db` or `tx`, or its lookup's sources and target — its
 * row written before the rows are handed on, under the route `command` with the command's id. One path for both, so a
 * handler and a lookup are audited alike. Whoever the request came in as still reads: an API token's id, or the
 * assistant acting for its person. The server's own work (withoutReadAudit) writes nothing, as every other read; a read
 * with no sink is refused (ReadAuditFailed), which fails the command and nothing else.
 */
export async function auditCommandRead(
  audit: CommandReadAudit | undefined,
  command: string,
  read: {
    /** The logical table read, and the resource its row is written under. */
    readonly table: string;
    readonly resource: string;
    readonly keys: readonly string[];
    readonly groups?: ReadonlyArray<ReadonlyArray<{ op: string; value?: unknown; other?: string }>>;
    readonly sort?: unknown;
    readonly offset?: number;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
  },
): Promise<void> {
  const outer = doors.getStore();
  if (outer === null) return;
  if (!audit) throw new ReadAuditFailed('An audited resource was read by a command with no read audit to record it.');
  const actor = outer?.actor ?? (outer?.route === 'assistant' ? `assistant:${audit.sink.actor}` : undefined);
  await doors.run({ route: 'command', command, ...(actor ? { actor } : {}) }, () =>
    record(
      {
        table: read.table,
        resource: read.resource,
        connection: audit.connectionOf(read.table),
        groups: read.groups,
        sort: read.sort,
        offset: read.offset ?? 0,
        rows: read.rows,
        keys: read.keys,
      },
      audit.sink,
    ),
  );
}

/* A row's query is JSON (its store checks it), so the feed's is the JSON string. */
const EVENT_FEED_QUERY = JSON.stringify('$events');

/**
 * An event feed's page (api/apiEventFeed.ts), its rows written before it is handed on: an event says which record it
 * is about and what happened to it, so the page is a read of those records. One row per audited resource it names, each
 * the query `$events` with the distinct keys the page carried; events about a resource that does not audit its reads write
 * nothing, and an App that audits none pays no statement. Each resource's row goes to the database that holds it. Always the API's door, whatever the request's.
 */
export async function auditEventFeed(
  access: AuditedAccess,
  schema: DatabaseSchema,
  connectionOf: (resource: string) => string,
  items: ReadonlyArray<{ readonly resource: string; readonly key: Readonly<Record<string, unknown>> }>,
): Promise<void> {
  if (!access.audited?.size) return;
  /* A record is read once however many of its events the page holds. */
  const about = new Map<string, Map<string, Readonly<Record<string, unknown>>>>();
  for (const { resource, key } of items)
    if (access.audited.has(resource)) about.set(resource, (about.get(resource) ?? new Map()).set(canonicalCommandJson(key), key));
  /* The sink takes a row at a time: one statement per resource, which a page seldom spans more than a few of.
     Every append settles before the first failure is thrown: the caller releases the connections it leased
     for these writes as soon as this returns, and one must not go idle under a sibling still writing. */
  const settled = await withReadRoute('api', () =>
    Promise.allSettled(
      [...about].map(async ([table, rows]) =>
        record(
          {
            table,
            resource: access.audited!.get(table)!,
            connection: connectionOf(access.audited!.get(table)!),
            groups: undefined,
            sort: undefined,
            offset: 0,
            rows: [...rows.values()],
            keys: keyColumns(schema, table),
            said: EVENT_FEED_QUERY,
          },
          access.readAudit,
        ),
      ),
    ),
  );
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}
