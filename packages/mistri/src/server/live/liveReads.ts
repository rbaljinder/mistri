/**
 * The `mistri-reads` header: the tables a read answered from, so a page
 * refetches a query when one of them changes and not when another does
 * (DESIGN-LIVE-SYNC §3.2).
 *
 * It is a superset by construction, since a table it misses is an update the
 * page never sees, while one too many only costs a refetch. From the read's
 * base table it takes every path the request names that resolves there (a
 * column, a reference walked, an aggregate's relationship by its name), and
 * then, for each table so far, what a read of it can reach without naming it:
 * the tables its references point at (a record's label), its tags, its rollups'
 * children and its computed columns' paths; and the tables that point at the
 * base (an aggregate or a `has` filter over them). Where a read's base is not
 * in the served schema, or anything cannot be read, the header is left off and
 * the page falls back to its query family's rule.
 *
 * It names only tables the reader is served: a rollup over a table they cannot
 * read refreshes when its own table changes, or on focus.
 */
import type { ServerResponse } from 'node:http';
import type { Adapter, CountItem } from '@mistriwork/engine/adapters/adapter.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { rollupReads } from '@mistriwork/engine/shared/rollups.js';
import { tryResolvePath } from '@mistriwork/engine/shared/viewPaths.js';

export const READS_HEADER = 'mistri-reads';

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:[.+][A-Za-z_$][\w$]*)*$/;
/* A request is small; a walk that meets more than this is not one this header describes. */
const MAX_STRINGS = 4_000;

function strings(value: unknown, out: Set<string>, depth = 0): boolean {
  if (depth > 12 || out.size > MAX_STRINGS) return false;
  if (typeof value === 'string') {
    if (value.length <= 256 && IDENTIFIER.test(value)) out.add(value);
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => strings(item, out, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).every((item) => strings(item, out, depth + 1));
  return true;
}

/** Every table a path from `from` walks through, or nothing where it does not resolve. */
function pathTables(schema: DatabaseSchema, from: string, path: string, into: Set<string>): void {
  const { resolved } = tryResolvePath(schema, from, path);
  if (!resolved) return;
  for (const hop of resolved.hops) {
    into.add(hop.from.table);
    into.add(hop.to.table);
  }
  into.add(resolved.table.id);
  if (resolved.rollup) for (const read of rollupReads(resolved.rollup)) into.add(read.table);
}

/** The tables a read of `base` asked as `request` answers from; undefined where that cannot be told. */
export function readTables(schema: DatabaseSchema, base: string, request: unknown): string[] | undefined {
  const tables = new Map<string, TableMeta>(schema.tables.map((table) => [table.id, table]));
  if (!tables.has(base)) return undefined;
  const asked = new Set<string>();
  if (!strings(request, asked)) return undefined;
  const reached = new Set<string>([base]);
  for (const text of asked) {
    pathTables(schema, base, text, reached);
    for (const fk of schema.foreignKeys)
      if (fk.name === text || `${fk.from.table}.${fk.from.columns.join('+')}` === text) {
        reached.add(fk.from.table);
        reached.add(fk.to.table);
      }
  }
  for (const fk of schema.foreignKeys) if (fk.to.table === base) reached.add(fk.from.table);
  for (const id of [...reached]) {
    const table = tables.get(id);
    if (!table) continue;
    for (const fk of schema.foreignKeys) if (fk.from.table === id) reached.add(fk.to.table);
    if (table.tags) {
      reached.add(table.tags.through);
      reached.add(table.tags.to);
    }
    for (const rollup of Object.values(table.rollups ?? {}))
      for (const read of rollupReads(rollup)) {
        reached.add(read.table);
        for (const field of read.fields) if (field.includes('.')) pathTables(schema, read.table, field, reached);
      }
    for (const computed of Object.values(table.computed ?? {})) for (const path of computed.reads) pathTables(schema, id, path, reached);
  }
  return [...reached].filter((id) => tables.has(id)).sort();
}

/**
 * The reader a route reads through, telling `reply` what each read answered
 * from: the union over the request's reads, or no header once one of them
 * cannot be told.
 */
export function trackingReads(adapter: Adapter, schema: DatabaseSchema, reply: ServerResponse): Adapter {
  const seen = new Set<string>();
  let unknown = false;
  const note = (base: string, request: unknown) => {
    if (unknown || reply.headersSent) return;
    let found: string[] | undefined;
    try {
      found = readTables(schema, base, request);
    } catch {
      found = undefined;
    }
    if (!found) {
      unknown = true;
      reply.removeHeader(READS_HEADER);
      return;
    }
    for (const id of found) seen.add(id);
    reply.setHeader(READS_HEADER, [...seen].sort().map(encodeURIComponent).join(','));
  };
  const reads: Record<string, (...args: never[]) => unknown> = {
    query: (request: { table: string }) => note(request.table, request),
    count: (table: string, filter: unknown) => note(table, filter ?? null),
    countEach: (items: readonly CountItem[]) => {
      for (const item of items) note(item.table, item.filter ?? null);
    },
    runView: (view: { base: string }) => note(view.base, view),
    countView: (view: { base: string }) => note(view.base, view),
    runBreakdown: (definition: { base: string }) => note(definition.base, definition),
    countBreakdown: (definition: { base: string }) => note(definition.base, definition),
  };
  const wrap = (property: string | symbol, value: unknown): unknown => {
    if (typeof property !== 'string' || typeof value !== 'function') return value;
    const noting = Object.hasOwn(reads, property) ? reads[property] : undefined;
    if (!noting) return value.bind(adapter);
    return (...args: unknown[]) => {
      (noting as (...values: unknown[]) => void)(...args);
      return (value as (...values: unknown[]) => unknown).apply(adapter, args);
    };
  };
  /* The proxy stands on an empty object whose prototype is the reader, never on the reader itself: a row policy's
     reader is frozen (appPolicyContext.ts), and a proxy over a frozen object must answer each of its methods with
     that very method, not a wrapper — the engine throws, and every public read under a policy was a 500. */
  return new Proxy(Object.create(adapter) as Adapter, {
    get: (_shadow, property) => wrap(property, Reflect.get(adapter, property)),
    ownKeys: () => Reflect.ownKeys(adapter),
    getOwnPropertyDescriptor: (_shadow, property) => {
      const own = Reflect.getOwnPropertyDescriptor(adapter, property);
      if (!own) return undefined;
      return 'value' in own ? { ...own, value: wrap(property, own.value), configurable: true } : { ...own, configurable: true };
    },
  });
}
