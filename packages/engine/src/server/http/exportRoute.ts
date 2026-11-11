/**
 * An export, streamed: `POST /api/export { q, format, columns? }` answers
 * with the file itself — CSV, a JSON array or NDJSON — read in batches and
 * written as each arrives, compressed when the request accepts it.
 *
 * "All matching rows" used to be one `/api/run` of up to 100,000 rows: the
 * whole result held as objects, serialized as one JSON string (about 19 MB
 * and 175 ms of a blocked event loop at the ceiling), with a total counted
 * beside it that the file never used. Here a batch is read, written, and let
 * go, so memory stays flat whatever the size, the first byte leaves after
 * the first batch, and nothing is counted. A file paged by key has no row
 * ceiling: it holds every row the question matches, or as many as its own
 * `limit` says. A file paged by offset does (`EXPORT_OFFSET_ROWS`): each of
 * its batches reads past every row before it, so its cost grows with the
 * square of its length, and one past the ceiling is refused before a byte is
 * written. A person has at most `EXPORTS_IN_FLIGHT` files streaming at once.
 *
 * The next batch is read only once the last has been handed on: a write the
 * connection cannot take yet waits for it to drain (backpressure), so a slow
 * client holds the server to a batch in flight, not the whole file. A client
 * that goes away stops the export — the statement in flight is cancelled
 * (statementControl.ts) and nothing more is read.
 *
 * Each batch is the ordinary read through this request's own reader —
 * the same grants, fields, row scope, narrowed resources and errors as
 * `/api/run` — so an export can never hold a row the list could not show.
 * Batches page the way the list's own pager does (keysetReadHttp.ts): in the
 * list's order with the key as its tiebreak, each starting after the last row
 * of the one before, as a continuation ANDed into the question's own filter,
 * so a batch costs what the first one did however deep the file goes and no
 * row is skipped or repeated. Where the list pages by offset — no primary
 * key, a union, a sort through a reference or on a value that does not come
 * back as it is stored — so does the file.
 *
 * Inside a row-policy App each batch is a read of the policy's own facade,
 * its row scope ANDed into the batch as into a list's page, and the file
 * holds only what the reader's list could show. A policy reply is held until
 * its context settles (handler.ts): the file's rows go as they are read, each
 * already the reader's, but its last write waits for the context, so a
 * context that fails after the rows were read cuts the connection and the
 * browser never saves a file that looks whole. A tenant's lease streams the
 * same way through `exportFile` (mistri: tenant/tenantHttp.ts).
 *
 * What an App decides of it is `ExportHooks` (mistri: http/appExport.ts): who
 * exports which table, who `me` is in the question, and what an amount kept
 * in minor units says in a CSV. The database browser exports every table it
 * reads, as stored.
 */
import type { ServerResponse } from 'node:http';
import type { Adapter } from '../../adapters/adapter.js';
import { createBrotliCompress, createGzip, constants as zlib } from 'node:zlib';
import type { Writable } from 'node:stream';
import { withCancellation } from '../../adapters/statementControl.js';
import { parseQuery } from '../../shared/query.js';
import { textToView } from '../../shared/viewtext.js';
import { findTable, resolveOrder, tableDialect, type DatabaseSchema, type TableMeta } from '../../shared/schema.js';
import { backrefsTo, resolveAggregate, tryResolvePath, type ViewDef } from '../../shared/viewPaths.js';
import { CRLF, csvField, csvRecord, jsonRecord } from '../../shared/csv.js';
import type { PageStep } from '../../shared/keysetPage.js';
import { readRecords, readView } from '../resourceReadOperations.js';
import { recordsPaging, settlePage, viewPaging } from '../keysetReadHttp.js';
import { acceptedEncoding, httpRead, policyResponses, send } from './reply.js';
import type { PostContext } from './context.js';
import { rollupReads } from '../../shared/rollups.js';

const EXPORT_PATH = '/api/export';
/** Rows read per statement, and so the most the server holds of a file at once:
 * large enough that a million-row file is a thousand reads, small enough that
 * one batch is never a memory event. */
export const EXPORT_BATCH = 1000;
/** The most rows a file paged by offset holds, as many as the old one-read export did: past it the database reads
 * every row before each batch again, so a deeper file is refused (`export_too_large`) rather than ground out. */
export const EXPORT_OFFSET_ROWS = 100_000;
/** Files one person streams at once. Each holds a connection and a statement at a time for as long as its client
 * reads, so a few clients that read slowly could otherwise hold every connection the pool has. */
export const EXPORTS_IN_FLIGHT = 2;
const inFlight = new Map<string, number>();
const FORMATS = {
  csv: { type: 'text/csv', extension: 'csv' },
  json: { type: 'application/json', extension: 'json' },
  ndjson: { type: 'application/x-ndjson', extension: 'ndjson' },
} as const;
type Format = keyof typeof FORMATS;

/** Who `me` is in a question, where its words name `me` (parseQuery's `me`). */
type Person = NonNullable<Parameters<typeof parseQuery>[1]>['me'];

/** What a product decides of an export. */
export interface ExportHooks {
  /** Whether this request's person may export a table (`''`: any table); `/api/run` bounds its reads by the same answer. */
  may(post: PostContext): (tableId: string) => boolean;
  /** Who `me` is in the question `text`, read only where its words name `me`. */
  person?(post: PostContext, text: string): Promise<Person | undefined>;
  /** A row as a CSV says it: an amount kept in minor units as the figure it is, a value as its component's word. */
  amounts?(post: PostContext, tableId: string): ((row: Record<string, unknown>) => Record<string, unknown>) | undefined;
}

/** One export, on what its host reads it through: the routes below, or a tenant's lease (mistri: tenant/tenantHttp.ts). */
interface ExportAsked {
  res: ServerResponse;
  body: Record<string, unknown>;
  /** The reader every batch is read through: this request's own, with its grants, fields and row scope. */
  adapter: Adapter;
  schema: DatabaseSchema;
  now: () => Date;
  /** Whether a table may be exported (`''`: any table). */
  may: (tableId: string) => boolean;
  person?: (text: string) => Promise<Person | undefined>;
  amounts?: (tableId: string) => ((row: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** Headers the file carries beside its own: a tenant lease's owner, which its client checks before it keeps the file. */
  headers?: Record<string, string>;
  /** A reply that is not the file (a refusal, the question's errors), sent the host's way. */
  answer?: (status: number, body: unknown) => void;
  /** Who is exporting, counted against `EXPORTS_IN_FLIGHT`; the client's address where no one is named. */
  who?: string;
}

export async function exportRoute(post: PostContext, hooks: ExportHooks): Promise<boolean> {
  if (post.path !== EXPORT_PATH) return false;
  const { person, amounts } = hooks;
  const end = await exportFile({
    res: post.res,
    body: post.body,
    adapter: post.adapter,
    schema: post.schema,
    now: post.appNow,
    may: hooks.may(post),
    ...(post.who ? { who: post.who } : {}),
    ...(person ? { person: (text: string) => person(post, text) } : {}),
    ...(amounts ? { amounts: (tableId: string) => amounts(post, tableId) } : {}),
  });
  if (!end) return true;
  /* A row policy's reply waits for its context (handler.ts underPolicy): so does the file's last write. */
  const held = policyResponses.get(post.res);
  if (held) held.reply = end;
  else end();
  return true;
}

/**
 * The export, streamed. Resolves with the file's last write, for the caller
 * to make once whatever the reads ran in has settled; undefined when the
 * answer was not a file (it was sent already) or the file was cut.
 */
export async function exportFile(asked: ExportAsked): Promise<(() => void) | undefined> {
  const { res, body, adapter, schema, may } = asked;
  const answer = asked.answer ?? ((status: number, value: unknown) => send(res, status, value));
  const amountsOf = (tableId: string) => asked.amounts?.(tableId);
  /* An App that grants by role says who exports which table (appExportable); the file is refused where the Export menu is not offered. */
  if (!may('')) {
    answer(403, { error: 'Export is not available to this person.' });
    return undefined;
  }
  /* Counted until the response closes, whichever way it ends: a refusal, the file, or a client that left. */
  const who = asked.who ?? `address:${res.req?.socket?.remoteAddress ?? ''}`;
  const running = inFlight.get(who) ?? 0;
  if (running >= EXPORTS_IN_FLIGHT) {
    answer(429, { code: 'too_many_exports', error: `At most ${EXPORTS_IN_FLIGHT} exports run at once. Wait for one to finish.` });
    return undefined;
  }
  inFlight.set(who, running + 1);
  res.once('close', () => {
    const left = (inFlight.get(who) ?? 1) - 1;
    if (left > 0) inFlight.set(who, left);
    else inFlight.delete(who);
  });
  const format = body.format ?? 'csv';
  if (typeof format !== 'string' || !Object.hasOwn(FORMATS, format)) {
    answer(400, { error: 'format must be "csv", "json" or "ndjson".' });
    return undefined;
  }
  if (body.columns !== undefined && (!Array.isArray(body.columns) || body.columns.some((column) => typeof column !== 'string'))) {
    answer(400, { error: 'columns must be a list of column names.' });
    return undefined;
  }
  const text = String(body.q ?? '');
  const me = await asked.person?.(text);
  const person = me === undefined ? {} : { me };
  const parsed = parseQuery(text, { schema, now: asked.now(), ...person });

  /* A question only a view can answer (a path through a reference) exports
     as a view, paged by offset: its rows have no single key to resume from. */
  if ((!parsed.query || parsed.errors.length) && adapter.runView) {
    const asView = textToView(schema, text, {
      id: 'export',
      name: '',
      now: asked.now(),
      ...person,
    });
    if (asView.view && !asView.errors.length) {
      const view = asView.view;
      /* Every table the view reaches, not only its base: a column through a reference, an aggregate or a filter on one reads another table's rows into the file. */
      for (const reached of viewTables(schema, view))
        if (!may(reached)) return refuseTable(answer, reached === UNKNOWN_TABLE ? view.base : reached);
      const base = findTable(schema, view.base);
      /* A union pages by offset: its rows have no one key order across branches (unionReads.ts), as the list's. */
      const keyed = base && !base.union ? base : undefined;
      const byOffset = !keyed || !viewPaging(schema, keyed, view, undefined);
      let step: PageStep | undefined;
      const read = async (offset: number, size: number) => {
        const paging = keyed && viewPaging(schema, keyed, view, step);
        /* Past the first batch with no boundary to resume from, the file goes on by offset in the same total order. */
        const continued = paging && (!step || paging.continuation) ? paging : undefined;
        const { result } = await httpRead(() =>
          readView(
            adapter,
            schema,
            continued?.view ?? view,
            { limit: size, offset: continued?.continuation ? 0 : offset },
            'none',
            undefined,
            continued?.continuation,
          ),
        );
        if (!continued) return result;
        const settled = settlePage(continued.order, continued.extra, result);
        step = settled.bounds ? { after: settled.bounds.last } : undefined;
        return { columns: settled.columns, rows: settled.rows };
      };
      return stream(
        res,
        format as Format,
        view.base,
        rowsWanted(view.limit),
        read,
        requested(body) ?? undefined,
        amountsOf(view.base),
        asked.headers,
        byOffset ? answer : undefined,
      );
    }
  }
  /* Not a file, so not a 200: a client reads the status before the body. A table this reader is not served is not
     found — the same answer whether it exists or not, so a refusal tells nothing — and any other question that cannot
     be read is a bad request. Either way `errors` says why, as `/api/run`'s does. */
  if (!parsed.query || parsed.errors.length) {
    answer(servesTable(schema, text) ? 400 : 404, { errors: parsed.errors });
    return undefined;
  }

  const query = parsed.query;
  const table = findTable(schema, query.table);
  if (!table) {
    answer(404, { error: `Unknown table "${query.table}"` });
    return undefined;
  }
  if (!may(table.id)) return refuseTable(answer, table.id);
  const wanted = requested(body) ?? (query.columns?.length ? query.columns : undefined);
  for (const reached of queryTables(schema, table, query, wanted))
    if (!may(reached)) return refuseTable(answer, reached === UNKNOWN_TABLE ? table.id : reached);
  /* The order the list reads in, made total with the key; an offset batch reads in it too. */
  const order = tableDialect(schema, table) === 'http' && !query.orderBy?.length ? undefined : resolveOrder(table, query.orderBy).order;
  const byOffset = table.union || !recordsPaging(table, tableDialect(schema, table), query.orderBy, wanted, query.filter, undefined);
  let step: PageStep | undefined;
  const read = async (offset: number, size: number) => {
    /* A union pages by offset: its rows have no one key order across branches (unionReads.ts), as the list's. */
    const paging = table.union ? undefined : recordsPaging(table, tableDialect(schema, table), query.orderBy, wanted, query.filter, step);
    /* Past the first batch with no boundary to resume from, the file goes on by offset in the same total order. */
    const continued = paging && (!step || paging.continuation) ? paging : undefined;
    /* An order column the file does not show is read for the boundary and taken out again (settlePage): it never
       reaches the file, whose columns are `wanted`. */
    const columns = continued?.columns ?? wanted;
    const { result } = await httpRead(() =>
      readRecords(
        adapter,
        schema,
        {
          ...query,
          ...(columns ? { columns } : {}),
          ...(order ? { orderBy: order } : {}),
          limit: size,
          offset: continued?.continuation ? 0 : offset,
        },
        'none',
        undefined,
        continued?.continuation,
      ),
    );
    if (!continued) return result;
    const settled = settlePage(continued.order, continued.extra, result);
    step = settled.bounds ? { after: settled.bounds.last } : undefined;
    return { columns: settled.columns, rows: settled.rows };
  };
  return stream(
    res,
    format as Format,
    table.id,
    rowsWanted(query.limit),
    read,
    wanted,
    amountsOf(table.id),
    asked.headers,
    byOffset ? answer : undefined,
  );
}

/** Whether the question's first word is a table in this reader's schema, by id or by bare name (as parseQuery finds it); an empty question names none and is no missing table. */
function servesTable(schema: DatabaseSchema, text: string): boolean {
  const first = text.trim().split(/\s+/)[0];
  return !first || findTable(schema, first) !== undefined || schema.tables.some((table) => table.name === first);
}

function refuseTable(answer: (status: number, body: unknown) => void, tableId: string): undefined {
  answer(403, {
    error: `Export of "${tableId}" is not available to this person.`,
  });
  return undefined;
}

/** Stands for a table a view reaches that cannot be named (a many-valued condition it cannot resolve): never exportable. */
const UNKNOWN_TABLE = '\u0000unknown';

/** Every table a view reads from: its base, each table along a reference path in its columns, filter and order, and the rows its aggregates and `any` conditions read. */
function viewTables(schema: DatabaseSchema, view: ViewDef): Set<string> {
  const tables = new Set<string>([view.base]);
  const path = pathReach(schema, view.base, tables);
  for (const column of view.columns) path(column.path);
  for (const order of view.orderBy ?? []) if (!order.alias) path(order.path);
  for (const group of view.filter?.groups ?? []) {
    for (const condition of group) {
      if (condition.any) {
        const child = backrefsTo(schema, view.base).find((b) => b.name === condition.any!.via);
        tables.add(child ? child.child : UNKNOWN_TABLE);
      } else path(condition.path);
      if (condition.other) path(condition.other);
    }
  }
  // The ones pinned to the view already (viewLabels.ts withViewComputed), as a read pins them.
  for (const rollup of Object.values(view.computed ?? {})) for (const { table } of rollupReads(rollup)) tables.add(table);
  for (const expressed of Object.values(view.expressions ?? {}))
    for (const read of expressed.reads) path(expressed.on ? `${expressed.on}.${read}` : read);
  for (const aggregate of view.aggregates ?? []) {
    try {
      const resolved = resolveAggregate(schema, view.base, aggregate);
      tables.add(resolved.child.id);
      tables.add(resolved.parent.id);
    } catch {
      tables.add(UNKNOWN_TABLE);
    }
  }
  return tables;
}

/** Every table a single-table query's file reads: its own, and those its computed columns and rollups read. */
function queryTables(
  schema: DatabaseSchema,
  table: TableMeta,
  query: NonNullable<ReturnType<typeof parseQuery>['query']>,
  wanted: readonly string[] | undefined,
): Set<string> {
  const tables = new Set<string>([table.id]);
  const path = pathReach(schema, table.id, tables);
  // A stored column is the table's own; an unknown one the read refuses by name.
  const derived = (name: string) => Object.hasOwn(table.rollups ?? {}, name) || Object.hasOwn(table.computed ?? {}, name);
  const names = [
    ...(wanted ?? table.columns.map((each) => each.name)),
    ...(query.orderBy ?? []).map((order) => order.column),
    ...(query.filter?.groups ?? []).flatMap((group) =>
      group.flatMap((condition) => [condition.column, ...(condition.other ? [condition.other] : [])]),
    ),
  ];
  for (const name of new Set(names)) if (derived(name)) path(name);
  return tables;
}

/* Adds to `tables` every table a path from `base` reads. */
function pathReach(schema: DatabaseSchema, base: string, tables: Set<string>): (text: string) => void {
  const seen = new Set<string>();
  const path = (text: string): void => {
    const { resolved } = tryResolvePath(schema, base, text);
    if (!resolved) {
      tables.add(UNKNOWN_TABLE);
      return;
    }
    for (const hop of resolved.hops) tables.add(hop.to.table);
    tables.add(resolved.table.id);
    /* A rollup is a figure of another table's rows, and a computed column is
       worked out of the columns it reads: either carries those tables into
       the file as surely as a column through a reference does. */
    if (resolved.rollup) for (const { table } of rollupReads(resolved.rollup)) tables.add(table);
    if (resolved.computed && !seen.has(text)) {
      seen.add(text);
      const on = text.includes('.') ? text.slice(0, text.lastIndexOf('.') + 1) : '';
      for (const read of resolved.computed.reads) path(`${on}${read}`);
    }
  };
  return path;
}

function requested(body: Record<string, unknown>): string[] | undefined {
  return Array.isArray(body.columns) && body.columns.length ? (body.columns as string[]) : undefined;
}

/** How many rows the file holds: the question's own `limit` where it says one, with no ceiling; every row otherwise. */
function rowsWanted(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : typeof limit === 'string' && limit.trim() !== '' ? Number(limit) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : Infinity;
}

/** Said when the client went away mid-file: nothing reads it, it only stops the loop. */
class Abandoned extends Error {
  constructor() {
    super('The export was abandoned.');
    this.name = 'Abandoned';
  }
}

async function stream(
  res: ServerResponse,
  format: Format,
  table: string,
  total: number,
  read: (offset: number, size: number) => Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }>,
  wanted: string[] | undefined,
  amounts?: (row: Record<string, unknown>) => Record<string, unknown>,
  headers: Record<string, string> = {},
  /** Where the file pages by offset: how a file past `EXPORT_OFFSET_ROWS` is refused. */
  byOffset?: (status: number, body: unknown) => void,
): Promise<(() => void) | undefined> {
  /* A client that leaves stops the read in flight (the adapters watch this signal) and every one after it. */
  const stop = new AbortController();
  const left = () => {
    if (!res.writableFinished) stop.abort();
  };
  res.once('close', left);
  const reading = (offset: number) => withCancellation(stop.signal, () => read(offset, Math.min(EXPORT_BATCH, total - offset)));
  try {
    /* One row read past the ceiling says, before a byte is written, whether the file would go deeper than an offset
       read should: one read as deep as the ceiling, rather than a file that reads deeper with every batch. */
    if (byOffset && total > EXPORT_OFFSET_ROWS) {
      const beyond = await withCancellation(stop.signal, () => read(EXPORT_OFFSET_ROWS, 1));
      if (stop.signal.aborted) return undefined;
      if (beyond.rows.length) {
        byOffset(422, {
          code: 'export_too_large',
          error: `This export is more than ${EXPORT_OFFSET_ROWS.toLocaleString('en-US')} rows, and its rows are read by position. Narrow the question, or give it a limit.`,
        });
        return undefined;
      }
    }
    /* The first batch is read before a byte is written: a refusal, a column
       that does not exist, a database that is down all still answer as the
       ordinary error they are, through the handler's own mapping. */
    let batch = await reading(0);
    if (stop.signal.aborted) return undefined;
    const columns = wanted ?? batch.columns;
    const spec = FORMATS[format];
    const encoding = acceptedEncoding(res);
    res.writeHead(200, {
      'content-type': `${spec.type}; charset=utf-8`,
      'content-disposition': `attachment; filename="${table.replace(/[^\w.-]+/g, '_')}.${spec.extension}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      vary: 'Accept-Encoding',
      ...(encoding ? { 'content-encoding': encoding } : {}),
      ...headers,
    });
    const out: Writable =
      encoding === 'br'
        ? createBrotliCompress({
            params: {
              [zlib.BROTLI_PARAM_QUALITY]: 4,
              [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
            },
          })
        : encoding === 'gzip'
          ? createGzip({ level: 6 })
          : res;
    if (out !== res) {
      (out as unknown as NodeJS.ReadableStream).pipe(res);
      stop.signal.addEventListener('abort', () => out.destroy(), { once: true });
    }
    /* Backpressure: a chunk the connection cannot take yet holds the loop until it drains, so the next batch is
       read only once this one is on its way. A client that leaves meanwhile ends the wait (a drain that never comes
       would hold the loop and its batch for good). */
    const write = (chunk: string) =>
      new Promise<void>((resolve, reject) => {
        if (stop.signal.aborted || res.destroyed) return reject(new Abandoned());
        if (out.write(chunk)) return resolve();
        const settle = (fn: () => void) => () => {
          out.off('drain', drained);
          stop.signal.removeEventListener('abort', gone);
          fn();
        };
        const drained = settle(resolve);
        const gone = settle(() => reject(new Abandoned()));
        out.once('drain', drained);
        stop.signal.addEventListener('abort', gone, { once: true });
      });
    try {
      /* A spreadsheet opens a UTF-8 CSV without a byte-order mark in the local
         codepage; the browser's own export writes one too (export.js). */
      if (format === 'csv') await write(`\ufeff${columns.map(csvField).join(',')}${CRLF}`);
      let written = 0;
      for (;;) {
        const lines = batch.rows.map((row, i) =>
          format === 'csv'
            ? `${csvRecord(columns, amounts ? amounts(row) : row)}${CRLF}`
            : format === 'ndjson'
              ? `${JSON.stringify(jsonRecord(columns, row))}\n`
              : // A JSON array as export.js's toJson writes one: two-space indent, one record per element.
                `${written + i === 0 ? '[\n' : ',\n'}${JSON.stringify(jsonRecord(columns, row), null, 2).replace(/^/gm, '  ')}`,
        );
        if (lines.length) await write(lines.join(''));
        const size = Math.min(EXPORT_BATCH, total - written);
        written += batch.rows.length;
        if (batch.rows.length < size || written >= total) break;
        batch = await reading(written);
        if (stop.signal.aborted) throw new Abandoned();
      }
      if (format === 'json') await write(written ? '\n]\n' : '[]\n');
      /* The last write is the caller's to make: a reply held for a context that has not settled yet waits for it. */
      return () => {
        if (!res.destroyed) out.end();
      };
    } catch {
      /* Past the first byte a status cannot change: the connection is cut, so
         the browser reports a failed download rather than saving half a file
         that looks whole. */
      stop.abort();
      res.destroy();
      return undefined;
    }
  } finally {
    res.off('close', left);
  }
}
