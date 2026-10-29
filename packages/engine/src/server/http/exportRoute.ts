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
 * the first batch, and nothing is counted.
 *
 * Each batch is the ordinary read through this request's own reader —
 * the same grants, fields and errors as `/api/run` — so an export can never
 * hold a row the list could not show. Batches follow the list's order with
 * the key as its tiebreak. Where that order is the key alone and every value
 * in it compares exactly (integers and text; anything on SQLite), a batch
 * starts after the last row of the one before (keyset): no row is skipped or
 * repeated however deep the file goes. Any other order pages by offset, as
 * the list's own pager does.
 *
 * Not offered inside a row-policy App — its replies are held until the policy
 * context settles, which a stream cannot be (handler.ts) — nor on a tenant
 * host; the client exports through `/api/run` there, as it always did.
 *
 * What an App decides of it is `ExportHooks` (mistri: http/appExport.ts): who
 * exports which table, who `me` is in the question, and what an amount kept
 * in minor units says in a CSV. The database browser exports every table it
 * reads, as stored.
 */
import type { ServerResponse } from 'node:http';
import { createBrotliCompress, createGzip, constants as zlib } from 'node:zlib';
import type { Writable } from 'node:stream';
import type { Condition, Filter } from '../../adapters/adapter.js';
import { MAX_LIMIT, clampLimit } from '../../shared/reads.js';
import { parseQuery } from '../../shared/query.js';
import { textToView } from '../../shared/viewtext.js';
import { findTable, primaryKey, resolveOrder, type DatabaseSchema, type Order, type TableMeta } from '../../shared/schema.js';
import { backrefsTo, resolveAggregate, tryResolvePath, type ViewDef } from '../../shared/viewPaths.js';
import { CRLF, csvField, csvRecord, jsonRecord } from '../../shared/csv.js';
import { readRecords, readView } from '../resourceReadOperations.js';
import { acceptedEncoding, httpRead, send } from './reply.js';
import type { PostContext } from './context.js';
import { rollupReads } from '../../shared/rollups.js';

const EXPORT_PATH = '/api/export';
/** Rows read per statement: large enough that a 100,000-row file is a hundred
 * reads, small enough that one batch is never a memory event. */
const BATCH = 1000;
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

export async function exportRoute(post: PostContext, hooks: ExportHooks): Promise<boolean> {
  const { res, path, body, adapter, schema, appNow } = post;
  if (path !== EXPORT_PATH) return false;
  /* An App that grants by role says who exports which table (appExportable); the file is refused where the Export menu is not offered. */
  const may = hooks.may(post);
  if (!may('')) {
    send(res, 403, { error: 'Export is not available to this person.' });
    return true;
  }
  // Never reached in one (httpRowPolicyAllows), and refused here as well: a policy reply cannot stream.
  if (post.rowPolicy) {
    send(res, 403, {
      error: 'This operation is unavailable in a row-policy application.',
    });
    return true;
  }
  const format = body.format ?? 'csv';
  if (typeof format !== 'string' || !Object.hasOwn(FORMATS, format)) {
    send(res, 400, { error: 'format must be "csv", "json" or "ndjson".' });
    return true;
  }
  if (body.columns !== undefined && (!Array.isArray(body.columns) || body.columns.some((column) => typeof column !== 'string'))) {
    send(res, 400, { error: 'columns must be a list of column names.' });
    return true;
  }
  const text = String(body.q ?? '');
  const me = await hooks.person?.(post, text);
  const person = me === undefined ? {} : { me };
  const parsed = parseQuery(text, { schema, now: appNow(), ...person });

  /* A question only a view can answer (a path through a reference) exports
     as a view, paged by offset: its rows have no single key to resume from. */
  if ((!parsed.query || parsed.errors.length) && adapter.runView) {
    const asView = textToView(schema, text, {
      id: 'export',
      name: '',
      now: appNow(),
      ...person,
    });
    if (asView.view && !asView.errors.length) {
      const view = asView.view;
      /* Every table the view reaches, not only its base: a column through a reference, an aggregate or a filter on one reads another table's rows into the file. */
      for (const reached of viewTables(schema, view))
        if (!may(reached)) return refuseTable(res, reached === UNKNOWN_TABLE ? view.base : reached);
      const total = clampLimit(view.limit ?? MAX_LIMIT);
      const read = (offset: number) =>
        httpRead(() => readView(adapter, schema, view, { limit: Math.min(BATCH, total - offset), offset }, 'none')).then(
          ({ result }) => result,
        );
      await stream(res, format as Format, view.base, total, read, requested(body) ?? undefined, hooks.amounts?.(post, view.base));
      return true;
    }
  }
  if (!parsed.query) {
    send(res, 200, { errors: parsed.errors });
    return true;
  }
  if (parsed.errors.length) {
    send(res, 200, { errors: parsed.errors });
    return true;
  }

  const query = parsed.query;
  const table = findTable(schema, query.table);
  if (!table) {
    send(res, 404, { error: `Unknown table "${query.table}"` });
    return true;
  }
  if (!may(table.id)) return refuseTable(res, table.id);
  const wanted = requested(body) ?? (query.columns?.length ? query.columns : undefined);
  for (const reached of queryTables(schema, table, query, wanted))
    if (!may(reached)) return refuseTable(res, reached === UNKNOWN_TABLE ? table.id : reached);
  const total = clampLimit(query.limit ?? MAX_LIMIT);
  const order = resolveOrder(table, query.orderBy).order;
  const keyset = keysetOrder(table, order, schema.dialect);
  /* The key is read even when the file does not show it: it is where the
     next batch starts. It never reaches the file (`wanted` is the file's). */
  const reading = wanted && keyset ? [...new Set([...wanted, ...keyset.map((o) => o.column)])] : wanted;
  let after: Record<string, unknown> | undefined;
  const read = async (offset: number) => {
    const { result } = await httpRead(() =>
      readRecords(
        adapter,
        schema,
        {
          ...query,
          ...(reading ? { columns: reading } : {}),
          orderBy: order,
          filter: keyset && after ? beyond(query.filter, keyset, after) : query.filter,
          limit: Math.min(BATCH, total - offset),
          offset: keyset ? 0 : offset,
        },
        'none',
      ),
    );
    after = result.rows.at(-1);
    return result;
  };
  await stream(res, format as Format, table.id, total, read, wanted, hooks.amounts?.(post, table.id));
  return true;
}

function refuseTable(res: ServerResponse, tableId: string): true {
  send(res, 403, {
    error: `Export of "${tableId}" is not available to this person.`,
  });
  return true;
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

/* Types whose values come back exactly as stored on Postgres. */
const EXACT_TYPE = /^(tiny|small|medium|big)?int(eger)?\d*\b|^(big|small)?serial|char|text|uuid/i;

/**
 * The order a keyset can resume, or undefined. Only the key, and only
 * columns whose value comes back exactly as it is stored: an integer or text
 * on Postgres — a timestamp comes back to the millisecond and a
 * float rounded, and resuming "after" a rounded value repeats or skips rows —
 * and anything on SQLite, which hands back what it holds.
 */
function keysetOrder(table: TableMeta, order: Order[], dialect: string): Order[] | undefined {
  const key = primaryKey(table);
  if (!key.length || order.length !== key.length || order.some((o, i) => o.column !== key[i])) return undefined;
  if (dialect === 'http') return undefined;
  const exact = order.every((o) => {
    const column = table.columns.find((c) => c.name === o.column);
    if (!column || column.nullable) return false;
    return dialect === 'sqlite' || EXACT_TYPE.test(column.type);
  });
  return exact ? order : undefined;
}

/**
 * The rows after `last` in `order`, within the question's own filter: for a
 * key (a, b) ascending, `a > x OR (a = x AND b > y)`, crossed with each of the
 * filter's OR-groups so every group keeps all of its own conditions. Values
 * are bound like any other condition's.
 */
function beyond(filter: Filter | undefined, order: Order[], last: Record<string, unknown>): Filter {
  const steps: Condition[][] = order.map((o, i) => [
    ...order.slice(0, i).map((earlier) => ({
      column: earlier.column,
      op: '=' as const,
      value: last[earlier.column] as Condition['value'],
    })),
    {
      column: o.column,
      op: o.direction === 'desc' ? ('<' as const) : ('>' as const),
      value: last[o.column] as Condition['value'],
    },
  ]);
  const groups = filter?.groups?.length ? filter.groups : [[]];
  return {
    groups: groups.flatMap((group) => steps.map((step) => [...group, ...step])),
  };
}

async function stream(
  res: ServerResponse,
  format: Format,
  table: string,
  total: number,
  read: (offset: number) => Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }>,
  wanted: string[] | undefined,
  amounts?: (row: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  /* The first batch is read before a byte is written: a refusal, a column
     that does not exist, a database that is down all still answer as the
     ordinary error they are, through the handler's own mapping. */
  let batch = await read(0);
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
  if (out !== res) (out as unknown as NodeJS.ReadableStream).pipe(res);
  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => {
      if (res.destroyed) return reject(new Error('The export was abandoned.'));
      if (out.write(chunk)) resolve();
      else out.once('drain', resolve);
    });
  try {
    /* A spreadsheet opens a UTF-8 CSV without a byte-order mark in the local
       codepage; the browser's own export writes one too (export.js). */
    if (format === 'csv') await write(`﻿${columns.map(csvField).join(',')}${CRLF}`);
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
      written += batch.rows.length;
      if (batch.rows.length < BATCH || written >= total) break;
      batch = await read(written);
    }
    if (format === 'json') await write(written ? '\n]\n' : '[]\n');
    out.end();
  } catch {
    /* Past the first byte a status cannot change: the connection is cut, so
       the browser reports a failed download rather than saving half a file
       that looks whole. */
    res.destroy();
  }
}
