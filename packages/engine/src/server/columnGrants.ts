/**
 * A grant over a catalog, and every check that holds a request to it: which
 * tables and columns a reader reads and writes, the catalog pruned to them
 * (its edges too, since a relationship can disclose a table), and each
 * query, view, breakdown, filter and write refused where it reaches past
 * them. The engine's, because two products hold requests to one: an App
 * role's grant (app/appAccess.ts, which adds its rules over writes through
 * `WriteRules`) and a connection's hidden columns (hiddenColumns.ts), which
 * has no App in it to ask.
 */
import {
  ANSI_STYLE,
  Refusal,
  type Filter,
  type QueryRequest,
  type WriteTransaction,
  type InsertRequest,
  type UpdateRequest,
  type DeleteRequest,
  type TellRequest,
} from '../adapters/adapter.js';
import { freezeDerivedCatalog, isCapturedScopeCatalog, isFixedScopeCatalog } from '../shared/scopeCatalog.js';
import { compileView, resolveAggregate, tryResolvePath, type ViewDef } from '../shared/view.js';
import { rollupReads, type Rollup } from '../shared/rollups.js';
import { compileBreakdown, measureConditions, type BreakdownDef } from '../shared/breakdown.js';
import { textToView } from '../shared/viewtext.js';
import { textToBreakdown } from '../shared/breakdowntext.js';
import { isJsonType, type DatabaseSchema, type ForeignKey } from '../shared/schema.js';
import { impliedEdges } from '../shared/declaredReferences.js';
import { unformedColumns } from '../shared/form.js';
import type { RowScope } from '../shared/rowScope.js';
import { isServerRequest } from './serverRequests.js';

/**
 * A reader reaching past its grant. Its name is the App's, where most
 * refusals are met; a connection's hidden columns (hiddenColumns.ts) say
 * which boundary answered in a refusal of their own.
 */
export class AppAccessDenied extends Refusal {
  constructor(message = 'Access to this resource is denied.') {
    super(message);
    this.name = 'AppAccessDenied';
  }
}

export interface ColumnGrant {
  readable: ReadonlySet<string>;
  writable: ReadonlySet<string>;
  /** Of `writable`, where a generic insert may make a row (`roles.<role>.create`). Absent: all of it. */
  creatable?: ReadonlySet<string>;
  /** Missing entries retain unrestricted columns within the resource grants. */
  fields?: ReadonlyMap<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>;
  /** Columns read and written by the server for its own work (a file's object
      and hash): never listed in a served catalog, and refused to every request
      but the server's own (`serverRequest`). */
  internal?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Private server-owned scope. Writes require an explicit scoped transaction. */
  rows?: RowScope;
}

/** Preserve changes made before invocation, never changes during its awaits.
 * These copied sets stay private; freezing a Set alone would not freeze grants. */
export function captureGrant<G extends ColumnGrant>(grant: G): G {
  return {
    ...grant,
    readable: new Set(grant.readable),
    writable: new Set(grant.writable),
    ...(grant.creatable ? { creatable: new Set(grant.creatable) } : {}),
    ...(grant.fields
      ? {
          fields: new Map(
            [...grant.fields].map(([table, fields]) => [table, { read: new Set(fields.read), write: new Set(fields.write) }]),
          ),
        }
      : {}),
  };
}

const withoutCarriedReferences = <T extends { references?: unknown }>(def: T): T => {
  if (!def || typeof def !== 'object' || !('references' in def)) return def;
  const { references: _requested, ...rest } = def;
  return rest as T;
};

/* Pruning a catalog to a grant allocated a fresh catalog on every request (9%
   of a busy server's allocation), though the answer is the same for the same
   catalog and the same grant. Only a grant its owner says is never changed
   (markStableGrant: the HTTP source keeps one per App, catalog and role set)
   is remembered, by the identity of its sets, so a grant built and edited by
   a caller is judged afresh every time as before. */
const stableGrants = new WeakSet<object>();
export function markStableGrant<T extends ColumnGrant>(grant: T): T {
  stableGrants.add(grant.readable);
  return grant;
}
/* What a stable grant's pruning was made from: its sets by identity, and only
   whether it had a row scope, which is all pruning reads of one. A tenant's
   grant is kept per role set and handed each request with that person's own
   scope beside it (tenantReadRuntime.ts), so the scope itself is never the
   key, and never kept here past its request. */
type PrunedFrom = Pick<ColumnGrant, 'writable' | 'creatable' | 'fields' | 'internal'> & { scoped: boolean; pruned: DatabaseSchema };
const prunedCatalogs = new WeakMap<DatabaseSchema, WeakMap<object, PrunedFrom>>();
/* A tenant request resolves its grant afresh each time, so its sets are never
   the same objects twice, and every read in it pruned the catalog again
   (G118). A captured catalog is frozen, and pruning reads nothing of the grant
   but the five things in this key, so the answer for a catalog and a key is
   kept — bounded, oldest out first — and frozen, so no caller can change the
   copy another one is handed. */
const prunedByContent = new WeakMap<DatabaseSchema, Map<string, DatabaseSchema>>();
const PRUNED = 256;
const sorted = (names: Iterable<string>) => [...names].sort();
function grantKey(access: ColumnGrant): string {
  return JSON.stringify([
    sorted(access.readable),
    sorted(access.writable),
    access.creatable ? sorted(access.creatable) : null,
    access.fields
      ? [...access.fields].map(([table, { read, write }]) => [table, sorted(read), sorted(write)]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      : null,
    access.rows !== undefined,
    access.internal
      ? [...access.internal].map(([table, columns]) => [table, sorted(columns)]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      : null,
  ]);
}
/** Test-only: how many times a catalog was pruned rather than reused. */
export const pruneCounters = { pruned: 0 };

/** Hide graph edges as well as tables: a relationship can disclose another resource. */
export function accessibleSchema(schema: DatabaseSchema, access: ColumnGrant): DatabaseSchema {
  if (!stableGrants.has(access.readable)) {
    if (!isCapturedScopeCatalog(schema)) return pruneCatalog(schema, access);
    let byKey = prunedByContent.get(schema);
    if (!byKey) prunedByContent.set(schema, (byKey = new Map()));
    const key = grantKey(access);
    const known = byKey.get(key);
    if (known) return known;
    const pruned = freezeDerivedCatalog(pruneCatalog(schema, access));
    if (byKey.size >= PRUNED) byKey.delete(byKey.keys().next().value!);
    byKey.set(key, pruned);
    return pruned;
  }
  let byGrant = prunedCatalogs.get(schema);
  if (!byGrant) prunedCatalogs.set(schema, (byGrant = new WeakMap()));
  const kept = byGrant.get(access.readable);
  const scoped = access.rows !== undefined;
  if (
    kept &&
    kept.writable === access.writable &&
    kept.creatable === access.creatable &&
    kept.fields === access.fields &&
    kept.internal === access.internal &&
    kept.scoped === scoped
  )
    return kept.pruned;
  // Frozen over a captured catalog, as the content path's is: what reads it later (resourceChecks) may then keep by its identity.
  const made = pruneCatalog(schema, access);
  const pruned = isCapturedScopeCatalog(schema) ? freezeDerivedCatalog(made) : made;
  const { writable, creatable, fields, internal } = access;
  byGrant.set(access.readable, { writable, creatable, fields, internal, scoped, pruned });
  return pruned;
}

function pruneCatalog(schema: DatabaseSchema, access: ColumnGrant): DatabaseSchema {
  pruneCounters.pruned++;
  const scoped = access.rows !== undefined;
  const readable = (table: string, column: string) => access.readable.has(table) && (access.fields?.get(table)?.read.has(column) ?? true);
  /* Read by the server, never listed: an internal column is left out of what the catalog names, but not out of what the grant allows. */
  const listed = (table: string, column: string) => readable(table, column) && !access.internal?.get(table)?.has(column);
  const reaches = (fk: ForeignKey) =>
    access.readable.has(fk.from.table) &&
    access.readable.has(fk.to.table) &&
    fk.from.columns.every((column) => readable(fk.from.table, column)) &&
    fk.to.columns.every((column) => readable(fk.to.table, column));
  const kept = schema.foreignKeys.filter(reaches);
  const keptSet = new Set(kept);
  /* A composite key this reader cannot follow whole — a tenant's
     `(tenant_id, group_id)`, whose ownership column no tenant reads — is still
     followed by a leg that names one row alone (declaredReferences.ts
     impliedEdges), so `group_id` keeps its link and its label.
     Only where the composite is dropped: a reader who reads it whole has it. */
  const dropped = schema.foreignKeys.filter((fk) => !fk.declared && fk.from.columns.length > 1 && !keptSet.has(fk));
  // The single-column keys kept, by table: a leg is added only where none already leaves its column.
  const keptSingle = new Map<string, Set<string>>();
  for (const fk of kept)
    if (fk.from.columns.length === 1) {
      const columns = keptSingle.get(fk.from.table);
      if (columns) columns.add(fk.from.columns[0]);
      else keptSingle.set(fk.from.table, new Set(fk.from.columns));
    }
  const legs = dropped.length
    ? impliedEdges({ ...schema, foreignKeys: dropped }).filter(
        (edge) => reaches(edge) && !keptSingle.get(edge.from.table)?.has(edge.from.columns[0]),
      )
    : [];
  const foreignKeys = legs.length ? [...kept, ...legs] : kept;
  /* Each edge by the table it leaves, and the tables an inferred edge points
     at: asked below for every column of every table, a scan of the whole
     graph each time made one pruning of a few hundred tables cost
     milliseconds, and startup prunes once per command and role. */
  const served = new Set(foreignKeys);
  const leaving = (edges: readonly ForeignKey[]) => {
    const by = new Map<string, ForeignKey[]>();
    for (const edge of edges) {
      const list = by.get(edge.from.table);
      if (list) list.push(edge);
      else by.set(edge.from.table, [edge]);
    }
    return by;
  };
  const servedFrom = leaving(foreignKeys),
    allFrom = leaving(schema.foreignKeys);
  const inferredTo = new Set(schema.foreignKeys.flatMap((fk) => (fk.declared ? [] : [fk.to.table])));
  return {
    ...schema,
    tables: schema.tables
      .filter((table) => access.readable.has(table.id))
      .map((table) => {
        const { approxRows: _approxRows, ...withoutEstimate } = table;
        return {
          ...(scoped ? withoutEstimate : table),
          ...(access.fields?.has(table.id)
            ? {
                deletable:
                  access.writable.has(table.id) &&
                  table.columns.every((column) => readable(table.id, column.name) && access.fields!.get(table.id)!.write.has(column.name)),
              }
            : {}),
          /* A write grant whose columns leave out one a new row needs (a key,
           a NOT NULL without a default) can edit rows and never make one:
           New is not offered rather than refused on every save. */
          ...(access.fields?.has(table.id) &&
          access.writable.has(table.id) &&
          !table.isView &&
          unformedColumns(table, (column) => access.fields!.get(table.id)!.write.has(column)).length
            ? { insertable: false }
            : {}),
          // A role that edits and never creates (`create`): the same answer, said by the author.
          ...(access.creatable && access.writable.has(table.id) && !access.creatable.has(table.id) ? { insertable: false } : {}),
          ...(scoped
            ? {
                deletable:
                  access.writable.has(table.id) &&
                  !table.isView &&
                  table.columns.some((column) => column.primaryKey) &&
                  !inferredTo.has(table.id) &&
                  table.columns.every(
                    (column) => readable(table.id, column.name) && (access.fields?.get(table.id)?.write.has(column.name) ?? true),
                  ),
              }
            : {}),
          ...(table.indexed ? { indexed: table.indexed.filter((column) => listed(table.id, column)) } : {}),
          // Like `indexed`: a hidden column is not named, even as unique.
          ...(table.unique ? { unique: table.unique.filter((column) => listed(table.id, column)) } : {}),
          ...(table.uniquePairs
            ? {
                uniquePairs: table.uniquePairs.filter((pair) => pair.every((column) => listed(table.id, column))),
              }
            : {}),
          ...(table.trigram
            ? {
                trigram: table.trigram.filter((column) => listed(table.id, column)),
              }
            : {}),
          columns: table.columns
            .filter((column) => listed(table.id, column.name))
            .map((column) => {
              const scope = access.fields?.get(table.id);
              const metadata = {
                ...column,
                // A column the database computes stays unwritable whatever the grant says.
                ...(scope ? { writable: column.writable !== false && access.writable.has(table.id) && scope.write.has(column.name) } : {}),
                ...(scoped
                  ? {
                      writable:
                        column.writable !== false &&
                        access.writable.has(table.id) &&
                        !table.isView &&
                        (scope?.write.has(column.name) ?? true),
                    }
                  : {}),
              };
              const reference = column.references;
              // A surviving component of a hidden composite FK must not advertise
              // a relationship whose other join columns cannot be read — unless the
              // column is a key of its own this reader follows: its own single key, or
              // the leg the composite implies. Beside a tenant's composite, a single key
              // lost its link here and its cells drew the raw id.
              const followed = (servedFrom.get(table.id) ?? []).some(
                (edge) =>
                  edge.from.columns.length === 1 &&
                  edge.from.columns[0] === column.name &&
                  edge.to.table === reference?.table &&
                  edge.to.columns[0] === reference?.column,
              );
              const hiddenEdge =
                !followed && (allFrom.get(table.id) ?? []).some((fk) => fk.from.columns.includes(column.name) && !served.has(fk));
              if (!reference || (readable(reference.table, reference.column) && !hiddenEdge)) return metadata;
              const { references: _references, ...visible } = metadata;
              return visible;
            }),
        };
      }),
    foreignKeys,
  };
}

/** Capture data before checking it: queued adapters must execute what we authorized.
 * Getters, inherited properties and coercible objects are not structured requests. */
export function requestData<T>(value: T, ancestors = new Set<object>()): T {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  // Bytes are data too (a file upload's content), copied so no caller keeps a handle on what is written.
  if (value instanceof Uint8Array && (Object.getPrototypeOf(value) === Uint8Array.prototype || Buffer.isBuffer(value)))
    return Buffer.from(value) as T;
  if (typeof value !== 'object' || ancestors.has(value)) throw new AppAccessDenied();
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new AppAccessDenied();
  ancestors.add(value);
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) || (array && !/^(0|[1-9][0-9]*)$/.test(key)))
      throw new AppAccessDenied();
    entries.push([key, requestData(descriptor.value, ancestors)]);
  }
  ancestors.delete(value);
  if (array) {
    if (entries.length !== (value as unknown[]).length) throw new AppAccessDenied();
    return entries.map(([, item]) => item) as T;
  }
  return Object.fromEntries(entries) as T;
}

/* A pruned catalog's full-catalog comparison (resourceChecks), kept per pruned catalog nothing can change. */
const comparisons = new WeakMap<DatabaseSchema, DatabaseSchema>();

/** Every read and write check against one grant, over the catalog it prunes: an App role's (app/appAccess.ts) and a connection's hidden columns (hiddenColumns.ts) alike. */
export function resourceChecks(full: DatabaseSchema, access: ColumnGrant) {
  const schema = accessibleSchema(full, access);
  /* What the pruned compile is compared with: every table and edge of the
     full catalog, so a hop that pruning disambiguated differently still
     shows, but each table's columns as this reader reads them. A relation
     written out whole (a rollup's filtered rows, a row scope) lists its
     columns, and that list is meant to differ by the ones cut. */
  /* With the legs pruning followed in place of a composite key the reader
     cannot read whole (pruneCatalog): the full catalog joins on the composite
     only under its own hop name, so `group_id` is the same join on both. */
  /* Built when a view or breakdown is compiled, not for every request: the
     scan of every edge against every edge was among a tenant read's largest
     costs in a field report's profile, for a catalog most requests never
     compare. Kept per pruned catalog where both catalogs are fixed: such a
     pruning is the answer for one grant's content (accessibleSchema), and
     the columns cut here are that grant's `fields`, so the same pruned
     catalog always stands beside the same comparison. */
  let compared: DatabaseSchema | undefined;
  const unprunedCatalog = (): DatabaseSchema => {
    if (compared) return compared;
    const fixed = isCapturedScopeCatalog(full) && isFixedScopeCatalog(schema);
    const kept = fixed ? comparisons.get(schema) : undefined;
    if (kept) return (compared = kept);
    const legs = schema.foreignKeys.filter(
      (fk) => !full.foreignKeys.some((other) => other.name === fk.name && other.from.table === fk.from.table),
    );
    const followed = legs.length ? { ...full, foreignKeys: [...full.foreignKeys, ...legs] } : full;
    const made = access.fields
      ? {
          ...followed,
          tables: full.tables.map((table) => {
            const read = access.fields!.get(table.id)?.read;
            return read ? { ...table, columns: table.columns.filter((column) => read.has(column.name)) } : table;
          }),
        }
      : followed;
    /* Frozen where it is kept: a catalog nothing can change, so what is compiled against it — every view and
       breakdown of an enter is compiled here a second time — is kept with it too (breakdown.ts compileBreakdown). */
    if (fixed) comparisons.set(schema, freezeDerivedCatalog(made));
    return (compared = made);
  };
  const assertRead = (table: string) => {
    if (!access.readable.has(table)) throw new AppAccessDenied();
  };
  const assertWrite = (table: string) => {
    assertRead(table);
    if (!access.writable.has(table)) throw new AppAccessDenied();
  };
  /* An `internal` column is the server's: a request that names it — a
     column, a filter, a sort, a value — is refused as one naming a column it
     may not have, unless the server built the request itself. */
  const assertFields = (table: string, columns: string[], mode: 'read' | 'write' = 'read', server = false) => {
    assertRead(table);
    const declared = full.tables.find((item) => item.id === table);
    const allowed = access.fields?.get(table);
    const internal = server ? undefined : access.internal?.get(table);
    for (const column of columns) {
      if (
        !declared?.columns.some((item) => item.name === column) ||
        internal?.has(column) ||
        (allowed && (!allowed.read.has(column) || (mode === 'write' && !allowed.write.has(column))))
      ) {
        throw new AppAccessDenied();
      }
    }
  };
  /* Every column of a table: a delete's before-image, a cascade's dependents,
     a profile. A removal takes the server's columns with the row, so `owned`
     leaves them out of what the principal must hold; a read of them never does. */
  const assertAllFields = (table: string, mode: 'read' | 'write' = 'read', owned = false) =>
    assertFields(
      table,
      full.tables
        .find((item) => item.id === table)
        ?.columns.map((column) => column.name)
        .filter((column) => !owned || !access.internal?.get(table)?.has(column)) ?? [],
      mode,
    );
  const recordFields = (table: string, record: object, mode: 'read' | 'write', server = false) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new AppAccessDenied();
    assertFields(table, Object.keys(record), mode, server);
    // A written value may also be bytes (a file's content, already copied by requestData); a key or a read never is.
    if (
      Object.values(record).some(
        (value) =>
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'number' &&
          typeof value !== 'boolean' &&
          !(mode === 'write' && value instanceof Uint8Array),
      )
    )
      throw new AppAccessDenied();
  };
  const keyFields = (table: string, key: object) => {
    recordFields(table, key, 'read');
    const primary = full.tables.find((item) => item.id === table)?.columns.filter((column) => column.primaryKey) ?? [];
    if (
      !primary.length ||
      Object.keys(key).length !== primary.length ||
      primary.some((column) => !Object.hasOwn(key, column.name)) ||
      Object.values(key).some((value) => typeof value !== 'string' && typeof value !== 'number')
    )
      throw new AppAccessDenied();
  };
  const filterFor = (table: string, input?: Filter, server = false) => {
    assertRead(table);
    const filter = requestData(input);
    if (filter) for (const group of filter.groups) for (const condition of group) assertFields(table, [condition.column], 'read', server);
    return filter;
  };
  const queryFor = (input: QueryRequest) => {
    const server = isServerRequest(input);
    const request = requestData(input);
    assertRead(request.table);
    const columns = request.columns?.length
      ? request.columns
      : (schema.tables.find((table) => table.id === request.table)?.columns.map((column) => column.name) ?? []);
    // Never pass an empty projection to an adapter: it means SELECT *.
    if (!columns.length) throw new AppAccessDenied();
    assertFields(request.table, columns, 'read', server);
    for (const order of request.orderBy ?? []) assertFields(request.table, [order.column], 'read', server);
    return { ...request, columns, filter: filterFor(request.table, request.filter, server) };
  };
  /* A rollup reads its child rows: the child, the reference, the column it
     sums and the columns its filter narrows by must all be readable here —
     an inner rollup's too — or the number would be built from values this
     reader may not see. A view's and a breakdown's alike. */
  const assertRollups = (computed?: Record<string, Rollup>) => {
    for (const rollup of Object.values(computed ?? {})) {
      for (const { table, fields } of rollupReads(rollup)) {
        assertRead(table);
        assertFields(table, fields);
      }
    }
  };
  /* A computed column reads its record's columns (computed.ts): each must be
     one this reader is served, through readable references, or the value
     would say what its inputs may not. A pinned expression is the catalog's,
     never a request's, and is held to the reader here all the same. */
  const assertExpressions = (base: string, expressions?: ViewDef['expressions'], rollups?: ViewDef['computed']) => {
    for (const expressed of Object.values(expressions ?? {})) {
      for (const read of expressed.reads) {
        const path = expressed.on ? `${expressed.on}.${read}` : read;
        /* A rollup it reads is pinned beside it (viewLabels.ts withViewComputed),
           not on this catalog, and assertRollups has held it to the reader. */
        if (rollups && Object.hasOwn(rollups, path)) continue;
        const { resolved } = tryResolvePath(schema, base, path);
        if (!resolved) throw new AppAccessDenied();
        for (const hop of resolved.hops) {
          assertRead(hop.from.table);
          assertRead(hop.to.table);
        }
        assertRead(resolved.table.id);
        if (!resolved.rollup && !resolved.computed) assertFields(resolved.table.id, [resolved.column.name]);
      }
    }
  };
  /* A record's tags read their link rows and the tags themselves
     (tagLists.ts): both tables, and the columns read there, must be this
     reader's, or a chip would say what the reader may not read. Pinned from
     the catalog, never a request, and held to the reader here all the same. */
  const assertTags = (tagged?: ViewDef['tagged']) => {
    for (const tags of Object.values(tagged ?? {})) {
      assertFields(tags.through, [tags.from, tags.via]);
      assertFields(tags.to, [tags.tagKey, tags.label, ...(tags.tone ? [tags.tone] : [])]);
    }
  };
  /* `any opportunity where stage = won` reads the rows that point at the record (view.ts): their table, the
     reference they point through, and every column their conditions name — through readable references, as a
     path anywhere is — must be this reader's, or the list would answer a question about rows they cannot read.
     Their scope is the statement's (rowScope.ts), so a row policy on them narrows the answer as it narrows them. */
  const assertAnyRows = (filter?: ViewDef['filter']) => {
    for (const condition of filter?.groups.flat() ?? []) {
      if (!condition.any) continue;
      if (typeof condition.any !== 'object' || typeof condition.any.via !== 'string') throw new AppAccessDenied();
      const { via } = condition.any;
      const child = via.slice(0, via.lastIndexOf('.'));
      assertRead(child);
      assertFields(child, via.slice(child.length + 1).split('+'));
      for (const inner of condition.any.filter?.groups.flat() ?? []) {
        for (const path of [inner.column, ...(inner.other === undefined ? [] : [inner.other])]) {
          const { resolved } = tryResolvePath(schema, child, path);
          if (!resolved || resolved.rollup || resolved.computed || resolved.tags) throw new AppAccessDenied();
          for (const hop of resolved.hops) {
            assertFields(hop.from.table, hop.from.columns);
            assertFields(hop.to.table, hop.to.columns);
          }
          assertFields(resolved.table.id, [resolved.column.name]);
        }
      }
    }
  };
  const viewFor = (input: ViewDef) => {
    // The soft keys a compiler below may walk are the App's to attach, never a request's.
    let view = withoutCarriedReferences(requestData(input));
    if (view.text !== undefined) {
      if (typeof view.text !== 'string') throw new AppAccessDenied();
      const parsed = textToView(schema, view.text, { id: view.id, name: view.name });
      if (!parsed.view || parsed.errors.length) throw new AppAccessDenied();
      // Text is authoritative until materialized. Never forward it alongside
      // checked columns for another layer to parse against its full catalog.
      // Pagination is invocation-owned, not part of text authority over paths.
      // Keep the caller's normalized cap when materializing against this graph.
      view = { ...parsed.view, limit: view.limit ?? parsed.view.limit, source: view.source, connection: view.connection };
    }
    assertRead(view.base);
    if (!view.columns?.length)
      view.columns = schema.tables.find((table) => table.id === view.base)!.columns.map((column) => ({ path: column.name }));
    if (!view.columns.length) throw new AppAccessDenied();
    for (const aggregate of view.aggregates ?? []) {
      if (aggregate.column !== undefined) assertFields(resolveAggregate(schema, view.base, aggregate).child.id, [aggregate.column]);
    }
    assertRollups(view.computed);
    assertExpressions(view.base, view.expressions, view.computed);
    assertTags(view.tagged);
    assertAnyRows(view.filter);
    // Validate against the pruned graph before the underlying full catalog can
    // resolve a forbidden forward path, filter, sort or reverse aggregate.
    const compiled = compileView(schema, view, ANSI_STYLE);
    // Pruning can change hop disambiguation. Refuse if the full compiler would
    // execute a different relationship from the one checked above.
    if (compiled.text !== compileView(unprunedCatalog(), view, ANSI_STYLE).text) throw new AppAccessDenied();
    return view;
  };
  const breakdownFor = (input: BreakdownDef) => {
    let breakdown = withoutCarriedReferences(requestData(input));
    if (breakdown.text !== undefined) {
      if (typeof breakdown.text !== 'string') throw new AppAccessDenied();
      const parsed = textToBreakdown(schema, breakdown.text);
      if (!parsed.breakdown || parsed.errors.length) throw new AppAccessDenied();
      const { text: _text, ...materialized } = parsed.breakdown;
      breakdown = { ...materialized, limit: breakdown.limit ?? materialized.limit };
    }
    assertRead(breakdown.base);
    assertRollups(breakdown.computed);
    assertExpressions(breakdown.base, breakdown.expressions, breakdown.computed);
    assertTags(breakdown.tagged);
    assertAnyRows(breakdown.filter);
    for (const where of measureConditions(breakdown.measures)) assertAnyRows(where);
    const compiled = compileBreakdown(schema, breakdown, ANSI_STYLE);
    if (compiled.text !== compileBreakdown(unprunedCatalog(), breakdown, ANSI_STYLE).text) throw new AppAccessDenied();
    return breakdown;
  };
  const assertRelatedWrites = (table: string, fields?: string[]) => {
    const visited = new Set<string>();
    const visit = (target: string) => {
      if (visited.has(target)) return;
      visited.add(target);
      // The database's keys only: a declared reference is never authority for a write (declaredReferences.ts).
      for (const fk of full.foreignKeys.filter((fk) => fk.to.table === target && !fk.declared)) {
        if (fields && target === table && !fk.to.columns.some((column) => fields.includes(column))) continue;
        // Unknown actions and hidden dependents must not be treated as harmless.
        assertRead(fk.from.table);
        assertFields(fk.from.table, fk.from.columns);
        assertFields(fk.to.table, fk.to.columns);
        if (!fields && (fk.onDelete === 'restrict' || fk.onDelete === 'no action')) continue;
        assertWrite(fk.from.table);
        // Cascaded deletion removes every field. ON UPDATE is not introspected,
        // so only a fully writable dependent is safe for key changes/unknowns.
        if (fields || fk.onDelete === 'cascade' || !fk.onDelete) assertAllFields(fk.from.table, 'write', true);
        else assertFields(fk.from.table, fk.from.columns, 'write');
        visit(fk.from.table);
      }
    };
    visit(table);
  };
  /* A write may point a row only at a parent the principal reads: an
     insert at every parent it names (its values and its key), an update at
     those whose columns it sets. A reference the write does not touch is not
     its to vouch for; checking it refused a borrower's phone edit over the
     applicant row their profile points at, which the App never declares. */
  const assertParentReads = (table: string, values: Readonly<Record<string, unknown>> | undefined, insert: boolean) => {
    const meta = full.tables.find((item) => item.id === table);
    const set = new Set([
      ...Object.keys(values ?? {}),
      ...(insert ? (meta?.columns.filter((column) => column.primaryKey).map((column) => column.name) ?? []) : []),
    ]);
    for (const fk of full.foreignKeys.filter(
      (fk) => fk.from.table === table && !fk.declared && fk.from.columns.some((column) => set.has(column)),
    )) {
      assertFields(fk.to.table, fk.to.columns);
    }
  };
  return {
    schema,
    assertRead,
    assertWrite,
    assertAllFields,
    assertParentReads,
    recordFields,
    keyFields,
    queryFor,
    filterFor,
    viewFor,
    breakdownFor,
    assertRelatedWrites,
  };
}

/** Pure catalog validation through the same graph boundary as runtime reads. */
export function validateResourceView(schema: DatabaseSchema, access: ColumnGrant, view: ViewDef): ViewDef {
  return resourceChecks(schema, access).viewFor(view);
}

/* A JSON column's object or array is written as its JSON text: every door
   (a form, a command, the API, an import) passes here, so the checks below
   and the adapters, the tenant's managed transaction among them, stay scalar. */
function jsonWritten<R extends InsertRequest | UpdateRequest>(full: DatabaseSchema, request: R): R {
  const values = request.values as Record<string, unknown> | undefined;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return request;
  const json = jsonColumns(full, request.table);
  const objects = Object.keys(values).filter((column) => json.has(column) && values[column] !== null && typeof values[column] === 'object');
  if (!objects.length) return request;
  return { ...request, values: { ...values, ...Object.fromEntries(objects.map((column) => [column, JSON.stringify(values[column])])) } };
}

function jsonColumns(full: DatabaseSchema, table: string): Set<string> {
  return new Set(
    full.tables
      .find((item) => item.id === table)
      ?.columns.filter((column) => isJsonType(column.type))
      .map((column) => column.name) ?? [],
  );
}

/* An update's `expected` names each written column but a JSON one, which no
   engine compares (updateGuard.ts) and which a stale write cannot hide in:
   it is written whole. */
export function expectedCovers(full: DatabaseSchema, request: UpdateRequest): boolean {
  const json = jsonColumns(full, request.table);
  const expected = request.expected!;
  const columns = Object.keys(request.values).filter((column) => !json.has(column) || Object.hasOwn(expected, column));
  return Object.keys(expected).length === columns.length && columns.every((column) => Object.hasOwn(expected, column));
}

export type ResourceChecks = ReturnType<typeof resourceChecks>;

/**
 * What a product adds to the writes a grant admits (app/appAccess.ts: an
 * App's validation, transitions, stamps, fixed actions and what a line
 * consumes). Each runs once the grant's own checks have passed, and writes
 * through the transaction the checks were given; left out, the write is that
 * transaction's own.
 */
export interface WriteRules<G extends ColumnGrant> {
  /** This call's grant, kept stable across its awaits: `captureGrant`, with the product's own rules copied beside it. */
  capture(grant: G): G;
  /** A lock on a table the grant does not write, which the reader may still update some other way. */
  locksUnwritable?(table: string, grant: G): boolean;
  insert?(request: InsertRequest, grant: G, server: boolean): ReturnType<WriteTransaction['insert']>;
  /** An update to a table outside `writable`: what answers it instead of the grant's refusal, or undefined. */
  unwritable?(request: UpdateRequest, grant: G): ReturnType<WriteTransaction['update']> | undefined;
  update?(request: UpdateRequest, grant: G): ReturnType<WriteTransaction['update']>;
  remove?(request: DeleteRequest, grant: G): ReturnType<WriteTransaction['remove']>;
}

/** Apply the same graph-aware checks to an already-owned transaction handle. */
export function authorizeColumnWrites<G extends ColumnGrant>(
  full: DatabaseSchema,
  grant: G,
  writer: WriteTransaction,
  rules?: (checks: ResourceChecks) => WriteRules<G>,
): WriteTransaction {
  // An arbitrary transaction handle has no proof of row enforcement. Only
  // authorizeResources may bind the explicit capability before composing this.
  if (grant.rows !== undefined) throw new AppAccessDenied();
  const checks = resourceChecks(full, grant);
  const { assertRead, assertWrite, assertAllFields, recordFields, keyFields, queryFor, filterFor, assertRelatedWrites } = checks;
  const product = rules?.(checks);
  // Keep each call's rules stable across its awaits; the next call reads current grants.
  const capture = (current: G): G => (product ? product.capture(current) : captureGrant(current));
  return {
    ...(writer.lockRecord
      ? {
          lockRecord: async (input: DeleteRequest) => {
            const request = requestData(input);
            if (grant.writable.has(request.table) || !product?.locksUnwritable?.(request.table, grant)) assertWrite(request.table);
            else assertRead(request.table);
            keyFields(request.table, request.key);
            await writer.lockRecord!(request);
          },
        }
      : {}),
    // A flow's notify step tells of a record the principal reads; it writes nothing.
    ...(writer.tell
      ? {
          tell: async (input: TellRequest) => {
            const request = requestData(input);
            assertRead(request.table);
            keyFields(request.table, request.key);
            await writer.tell!(request);
          },
        }
      : {}),
    query: (request) => writer.query(queryFor(request)),
    count: (table, filter) => writer.count(table, filterFor(table, filter)),
    insert: (input) => {
      const server = isServerRequest(input);
      const request = jsonWritten(full, requestData(input));
      const operation = capture(grant);
      assertWrite(request.table);
      if (operation.creatable && !operation.creatable.has(request.table)) throw new AppAccessDenied();
      recordFields(request.table, request.values, 'write', server);
      const written = product?.insert ? product.insert(request, operation, server) : (async () => writer.insert(request))();
      return written.then((result) => {
        const readable = operation.fields?.get(request.table)?.read;
        if (!readable || !result.row) return result;
        return { ...result, row: Object.fromEntries(Object.entries(result.row).filter(([column]) => readable.has(column))) };
      });
    },
    update: (input) => {
      const request = jsonWritten(full, requestData(input));
      const operation = capture(grant);
      if (!operation.writable.has(request.table)) {
        const answered = product?.unwritable?.(request, operation);
        if (answered) return answered;
      }
      assertWrite(request.table);
      recordFields(request.table, request.values, 'write', isServerRequest(input));
      keyFields(request.table, request.key);
      if (request.expected !== undefined) {
        recordFields(request.table, request.expected, 'read');
        if (!expectedCovers(full, request)) throw new AppAccessDenied();
      }
      assertRelatedWrites(request.table, Object.keys(request.values));
      return product?.update ? product.update(request, operation) : (async () => writer.update(request))();
    },
    remove: (input) => {
      const request = requestData(input);
      assertWrite(request.table);
      keyFields(request.table, request.key);
      // Delete/Undo requires a complete readable before-image and permission
      // to remove all fields, including those protected from ordinary updates.
      assertAllFields(request.table, 'write', true);
      assertRelatedWrites(request.table);
      return product?.remove ? product.remove(request, grant) : writer.remove(request);
    },
  };
}
