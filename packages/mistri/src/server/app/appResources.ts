import {
  oneAtATime,
  Refusal,
  type Adapter,
  type AggregateRequest,
  type DeleteRequest,
  type ScopedReads,
  type TellRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import type { TriggerAcceptance, TriggerChange } from '@mistriwork/engine/adapters/storeHost.js';
import { nativeVerifiedCommandRunner, type VerifiedCommandRunner } from '../commands/verifiedCommandRunner.js';
import { isRuntimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { compileView, resolveAggregate, type ViewDef, type ViewFilter } from '@mistriwork/engine/shared/view.js';
import { compileBreakdown, type BreakdownDef } from '@mistriwork/engine/shared/breakdown.js';
import { ANSI_STYLE, type AnyRows, type Condition, type Filter } from '@mistriwork/engine/shared/filter.js';
import { parseQuery, readsOf, saidAt } from '@mistriwork/engine/shared/query.js';
import type { ViewCondition } from '@mistriwork/engine/shared/viewPaths.js';
import type { Rollup } from '@mistriwork/engine/shared/rollups.js';
import type { ForeignKey } from '@mistriwork/engine/shared/schema.js';
import { declaredEdge, impliedEdges, withDeclaredEdges, type DeclaredReference } from '@mistriwork/engine/shared/declaredReferences.js';
import { withDeclaredDates } from '../../shared/declaredDates.js';
import type { DeclaredDate } from '../../shared/appModel.js';
import { renamedComputed } from '@mistriwork/engine/shared/rollups.js';
import { renameViaTargets, snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { runScopedTransactionFacade } from '../policy/scopedTransactionFacade.js';
import {
  capturePublicPlacementAdmission,
  capturePublicPlacementOwner,
  capturePublicPlacementScope,
} from '../../adapters/commands/publicPlacementTransaction.js';
import { commandsOf } from '../stores/commandStores.js';
import { narrowedWrites } from './appNarrowedWrites.js';

export interface AppResourceCatalog {
  schema: DatabaseSchema;
  toPhysical(name: string): string;
  toLogical(id: string): string;
  /**
   * Where the catalog is narrower than its connection (a source scoped to a
   * schema): the connection's own graph, and the part of it this catalog
   * may reach. The engine resolves a view's paths against the whole
   * connection, so every view is compiled against both first, and one that
   * would walk a key out of the catalog, or resolve a hop differently, is
   * refused before it reaches the database.
   */
  bounds?: { full: DatabaseSchema; within: DatabaseSchema };
  /**
   * The narrowed resources (appNarrowed.ts), by logical name: the conditions every read of each stands on, over its
   * table's own columns. ANDed into the read below, never a grant; a write through one is kept inside them
   * (appNarrowedWrites.ts).
   */
  narrowed?: ReadonlyMap<string, Filter>;
}

const outOfBounds = (): never => {
  throw new Refusal("This view reaches a table outside the App's source. A source scoped to a schema reads that schema alone.");
};

/**
 * A transaction's catalog evidence cut to what the catalog may reach. The
 * connection's own description holds every schema, and a key from a table
 * in reach to one outside it is real; the App's catalog drops that key, as
 * if the far table were not there (appSourceCatalog.ts), so the evidence it
 * is attested against drops it the same way. The engine's own row checks
 * still run against the whole description.
 */
function reachable(actual: DatabaseSchema, bounds: AppResourceCatalog['bounds']): DatabaseSchema {
  if (!bounds) return actual;
  const ids = new Set(bounds.within.tables.map((table) => table.id));
  return {
    ...actual,
    tables: actual.tables
      .filter((table) => ids.has(table.id))
      .map((table) => ({
        ...table,
        columns: table.columns.map((column) => {
          if (!column.references || ids.has(column.references.table)) return column;
          const { references: _outside, ...kept } = column;
          return kept;
        }),
      })),
    foreignKeys: actual.foreignKeys.filter((fk) => ids.has(fk.from.table) && ids.has(fk.to.table)),
  };
}

/** The same statement against the catalog's reach as against its whole connection, or a refusal. */
function checkBounds(bounds: AppResourceCatalog['bounds'], compile: (schema: DatabaseSchema) => string): void {
  if (!bounds) return;
  /* A view the connection cannot compile either is wrong on its own terms:
     the engine says why, as it would for any App. */
  let full: string;
  try {
    full = compile(bounds.full);
  } catch {
    return;
  }
  let within: string;
  try {
    within = compile(bounds.within);
  } catch {
    return outOfBounds();
  }
  if (within !== full) outOfBounds();
}

export interface AppResources extends AppResourceCatalog {
  adapter: Adapter;
}

/* Per catalog: carried on every view a reader compiles. */
const implied = new WeakMap<DatabaseSchema, ForeignKey[]>();
const impliedEdgesOf = (schema: DatabaseSchema): ForeignKey[] => {
  let edges = implied.get(schema);
  if (!edges) implied.set(schema, (edges = impliedEdges(schema)));
  return edges;
};

/**
 * The App's declared references in the database's names, for a compiler
 * whose catalog has no such key. Always the catalog's own: whatever a
 * request carried under `references` is replaced, never forwarded.
 */
function carriedReferences<T extends { references?: ForeignKey[] }>(def: T, catalog: AppResourceCatalog, base?: string): T {
  const { references: _requested, ...rest } = def;
  const references = base === undefined ? physicalReferencesOf(catalog) : referencesFrom(catalog, base);
  return (references.length ? { ...rest, references } : rest) as T;
}

/* The soft keys a statement over `base` carries. Where one table is several resources (appNarrowed.ts), each may say
   its own column points somewhere else (`orderEvents.correlation_id → orders`, `chatEvents.correlation_id →
   conversations`); in the database's names both are the table's one column, so a statement over one of them carries
   its own and none of its siblings'. Kept per catalog and base, as the references are. */
const referencesByBase = new WeakMap<AppResourceCatalog['schema'], Map<string, readonly ForeignKey[]>>();
function referencesFrom(catalog: AppResourceCatalog, base: string): ForeignKey[] {
  if (!catalog.narrowed?.size) return physicalReferencesOf(catalog);
  let byBase = referencesByBase.get(catalog.schema);
  if (!byBase) referencesByBase.set(catalog.schema, (byBase = new Map()));
  let kept = byBase.get(base);
  if (!kept) {
    const { schema, toPhysical } = catalog;
    let table: string | undefined;
    try {
      table = toPhysical(base);
    } catch {
      table = undefined;
    }
    const declared = [...schema.foreignKeys.filter((fk) => fk.declared), ...impliedEdgesOf(schema)].filter(
      (fk) => fk.from.table === base || table === undefined || toPhysical(fk.from.table) !== table,
    );
    kept = Object.freeze(
      declared.map((fk) => ({
        ...fk,
        from: { ...fk.from, table: toPhysical(fk.from.table) },
        to: { ...fk.to, table: toPhysical(fk.to.table) },
      })),
    );
    byBase.set(base, kept);
  }
  return kept as ForeignKey[];
}

/* ---------- narrowed resources (appNarrowed.ts): their conditions in every read ---------- */

/** Each group of `groups` with each of `more`'s: two OR-of-ANDs ANDed. */
function andGroups<C>(groups: readonly (readonly C[])[] | undefined, more: readonly (readonly C[])[]): C[][] {
  if (!groups?.length) return more.map((group) => [...group]);
  return groups.flatMap((group) => more.map((extra) => [...group, ...extra]));
}

/** A request's filter in the database's names: the narrowed resource's conditions ANDed in, and the child an `any`/`no`
    asks about renamed, as a view's is (physicalAny). The filter as it was for any other table. */
function physicalFilter(filter: Filter | undefined, table: string, catalog: AppResourceCatalog): Filter | undefined {
  const narrowed = narrowedFilter(filter, table, catalog);
  return narrowed && physicalAny(narrowed, catalog);
}

/** A request's filter with the narrowed resource's conditions ANDed in; the filter as it was for any other table. */
function narrowedFilter(filter: Filter | undefined, table: string, catalog: AppResourceCatalog): Filter | undefined {
  const fixed = catalog.narrowed?.get(table);
  return fixed ? { groups: andGroups(filter?.groups, fixed.groups) } : filter;
}

/** The same, for a view's or a breakdown's filter, whose conditions address paths. */
function narrowedViewFilter(filter: ViewFilter | undefined, table: string, catalog: AppResourceCatalog): ViewFilter | undefined {
  const fixed = catalog.narrowed?.get(table);
  if (!fixed) return filter;
  const paths = fixed.groups.map((group) => group.map(({ column, ...rest }: Condition): ViewCondition => ({ path: column, ...rest })));
  return { groups: andGroups(filter?.groups, paths) };
}

/** A rollup (and the inner one it reads) counting only the rows its child resource reads, where that child is narrowed. */
function narrowedRollup<R extends Rollup>(rollup: R, catalog: AppResourceCatalog): R {
  const child = rollup.via.slice(0, rollup.via.lastIndexOf('.'));
  const filter = narrowedFilter(rollup.filter, child, catalog);
  return {
    ...rollup,
    ...(filter ? { filter } : {}),
    ...(rollup.of ? { of: narrowedRollup(rollup.of, catalog) } : {}),
  };
}

function narrowedComputed<T extends { computed?: Record<string, import('@mistriwork/engine/shared/rollups.js').ComputedPath> }>(
  def: T,
  catalog: AppResourceCatalog,
): T {
  if (!catalog.narrowed?.size || !def.computed) return def;
  return {
    ...def,
    computed: Object.fromEntries(Object.entries(def.computed).map(([path, rollup]) => [path, narrowedRollup(rollup, catalog)])),
  };
}

/**
 * A row scope in the database's names. A narrowed resource is read under its table's row policy, ANDed with its
 * conditions: a policy that gives two resources of one table different rules would make the conditions a grant, so
 * it is refused rather than one rule silently chosen.
 */
function physicalScope(scope: RowScope, toPhysical: (table: string) => string): Record<string, RowScope[string]> {
  const mapped: Record<string, RowScope[string]> = Object.create(null);
  for (const [table, rule] of Object.entries(scope)) {
    const physical = toPhysical(table);
    if (Object.hasOwn(mapped, physical) && JSON.stringify(mapped[physical]) !== JSON.stringify(renameViaTargets(rule, toPhysical)))
      throw new Refusal(
        `The row policy gives "${table}" a rule of its own, and another resource of its table another: a narrowed resource reads its table's rows under the table's one rule.`,
      );
    mapped[physical] = renameViaTargets(rule, toPhysical);
  }
  return mapped;
}

/* The same array for the same catalog and naming, every time, rather than the catalog's edges renamed again for
   every read: the compiler keeps the catalog a view's references widen by that array's identity, and by its text
   where a scoped reader has copied it (declaredReferences.ts withViewReferences) — a field report's large tenant
   App rebuilt that catalog for every list, count and breakdown of an enter, about a tenth of its CPU. Keyed by the
   naming function as well as the catalog, because a reader may be handed a catalog literal that pairs the two
   afresh. */
const physicalReferences = new WeakMap<DatabaseSchema, WeakMap<(table: string) => string, readonly ForeignKey[]>>();
function physicalReferencesOf({ schema, toPhysical }: AppResourceCatalog): ForeignKey[] {
  let byNaming = physicalReferences.get(schema);
  if (!byNaming) physicalReferences.set(schema, (byNaming = new WeakMap()));
  let kept = byNaming.get(toPhysical);
  if (!kept) {
    // With the legs its composite keys imply: a tenant's reader follows `group_id` where it cannot read `tenant_id`.
    const declared = [...schema.foreignKeys.filter((fk) => fk.declared), ...impliedEdgesOf(schema)];
    kept = Object.freeze(
      declared.map((fk) => ({
        ...fk,
        from: { ...fk.from, table: toPhysical(fk.from.table) },
        to: { ...fk.to, table: toPhysical(fk.to.table) },
      })),
    );
    byNaming.set(toPhysical, kept);
  }
  return kept as ForeignKey[];
}

/* The text columns the App declares dates, in the database's names: the same for the same catalog and naming, and
   a scan of every column of every table — on a large App, a breakdown's largest cost after its compile — when
   made afresh for each of an enter's breakdowns. Kept as the references are (physicalReferencesOf). */
const datedColumns = new WeakMap<DatabaseSchema, WeakMap<(table: string) => string, readonly string[]>>();
function datedColumnsOf({ schema, toPhysical }: AppResourceCatalog): string[] {
  let byNaming = datedColumns.get(schema);
  if (!byNaming) datedColumns.set(schema, (byNaming = new WeakMap()));
  let kept = byNaming.get(toPhysical);
  if (!kept) {
    kept = Object.freeze(
      schema.tables.flatMap((table) =>
        table.columns.filter((column) => / as date(time)?$/.test(column.type)).map((column) => `${toPhysical(table.id)}.${column.name}`),
      ),
    );
    byNaming.set(toPhysical, kept);
  }
  return kept as string[];
}

/** A breakdown in the database's names: its base, its rollups' children, the soft keys it may walk and the
    text columns the App declares dates, which the database's compiler would otherwise refuse to bucket.
    Always the catalog's own, as the references are. */
function resourceBreakdown(breakdown: BreakdownDef, catalog: AppResourceCatalog): BreakdownDef {
  const { dateColumns: _requested, ...rest } = breakdown;
  const dated = datedColumnsOf(catalog);
  const filter = narrowedViewFilter(rest.filter, breakdown.base, catalog);
  const physical = carriedReferences(
    renamedComputed(
      narrowedComputed(
        {
          ...rest,
          base: catalog.toPhysical(breakdown.base),
          ...(dated.length ? { dateColumns: dated } : {}),
          // A rail's counts under a tags filter read the link and tag tables as the list does (physicalView).
          ...(rest.tagged ? { tagged: physicalTags(rest.tagged, catalog.toPhysical) } : {}),
          ...(filter ? { filter: physicalAny(filter, catalog) } : {}),
          // A `count when [any ticket]` asks about its child as the filter does: renamed, or on PostgreSQL the
          // compiler finds no table by the App's name and refuses the whole batch the figure rode in.
          ...(rest.measures ? { measures: rest.measures.map((m) => (m.where ? { ...m, where: physicalAny(m.where, catalog) } : m)) } : {}),
        },
        catalog,
      ),
      catalog.toPhysical,
    ),
    catalog,
    breakdown.base,
  );
  checkBounds(catalog.bounds, (schema) => compileBreakdown(schema, physical, ANSI_STYLE).text);
  return physical;
}

function resourceView(view: ViewDef, catalog: AppResourceCatalog): ViewDef {
  const physical = physicalView(view, catalog);
  checkBounds(catalog.bounds, (schema) => compileView(schema, physical, ANSI_STYLE).text);
  return physical;
}

function physicalView(view: ViewDef, catalog: AppResourceCatalog): ViewDef {
  const { schema, toPhysical } = catalog;
  const filter = narrowedViewFilter(view.filter, view.base, catalog);
  return {
    ...carriedReferences(view, catalog, view.base),
    base: toPhysical(view.base),
    // Resolve child-table identifiers while they still belong to this catalog.
    ...(view.aggregates
      ? {
          aggregates: view.aggregates.map((aggregate) => {
            const resolved = resolveAggregate(schema, view.base, aggregate);
            // An aggregate has no conditions of its own to carry a narrowed child's: a rollup does (narrowedRollup).
            if (catalog.narrowed?.has(resolved.child.id))
              throw new Refusal(`"${resolved.child.id}" is a narrowed resource; count its rows with a rollup on the record it points at.`);
            return { ...aggregate, via: `${toPhysical(resolved.child.id)}.${resolved.fk.from.columns.join('+')}`, alias: resolved.name };
          }),
        }
      : {}),
    // A rollup names its child by endpoints, so renaming the table is the whole translation.
    ...(view.computed ? { computed: renamedComputed(narrowedComputed(view, catalog), toPhysical).computed } : {}),
    // A record's tags name their link and tag tables by id: renamed the same way.
    ...(view.tagged ? { tagged: physicalTags(view.tagged, toPhysical) } : {}),
    ...(filter ? { filter: physicalAny(filter, catalog) } : {}),
  };
}

/* An `any` condition names its child rows by endpoints, as a rollup does (`opportunity.account_id`): renaming the
   table is the whole translation. The child's own conditions are its columns and references, which keep their names;
   a narrowed child's conditions join them, so `any` asks only of the rows that resource reads. */
function physicalAny<F extends { groups: Array<Array<{ any?: AnyRows }>> }>(filter: F, catalog: AppResourceCatalog): F {
  if (!filter.groups.some((group) => group.some((condition) => condition.any))) return filter;
  return {
    ...filter,
    groups: filter.groups.map((group) =>
      group.map((condition) => {
        if (!condition.any) return condition;
        const { via } = condition.any;
        const child = via.slice(0, via.lastIndexOf('.'));
        const narrowed = narrowedFilter(condition.any.filter, child, catalog);
        return {
          ...condition,
          any: {
            ...condition.any,
            via: `${catalog.toPhysical(child)}${via.slice(child.length)}`,
            ...(narrowed ? { filter: narrowed } : {}),
          },
        };
      }),
    ),
  } as F;
}

/** A record's tags name their link and tag tables by id: renamed, as a rollup's child is. */
function physicalTags(tagged: NonNullable<ViewDef['tagged']>, toPhysical: (id: string) => string): NonNullable<ViewDef['tagged']> {
  return Object.fromEntries(
    Object.entries(tagged).map(([path, tags]) => [path, { ...tags, through: toPhysical(tags.through), to: toPhysical(tags.to) }]),
  );
}

/** Internal identity-only facade over an already bound physical capability. */
export function mapAppScopedReads(reads: ScopedReads, catalog: AppResourceCatalog): ScopedReads {
  const { toPhysical } = catalog;
  const scoped: ScopedReads = {
    query: (request) => reads.query(physicalRead(request, catalog)),
    count: (table, filter, limit) => reads.count(toPhysical(table), physicalFilter(filter, table, catalog), limit),
    runView: async (view, offset) => logicalResult(view, await reads.runView(resourceView(view, catalog), offset), catalog),
    countView: (view, limit) => reads.countView(resourceView(view, catalog), limit),
    runBreakdown: (breakdown, offset) => reads.runBreakdown(resourceBreakdown(breakdown, catalog), offset),
    countBreakdown: (breakdown) => reads.countBreakdown(resourceBreakdown(breakdown, catalog)),
    ...(reads.aggregate ? { aggregate: (request) => reads.aggregate!(physicalRead(request, catalog)) } : {}),
    ...(reads.countEach
      ? {
          countEach: (items, limit) =>
            reads.countEach!(
              items.map((item) => ({ table: toPhysical(item.table), filter: narrowedFilter(item.filter, item.table, catalog) })),
              limit,
            ),
        }
      : {}),
  };
  return Object.freeze(scoped);
}

/** A single-table read in the database's names, a narrowed resource's conditions ANDed into its filter. */
function physicalRead<T extends { table: string; filter?: Filter }>(request: T, catalog: AppResourceCatalog): T {
  const filter = physicalFilter(request.filter, request.table, catalog);
  return { ...request, table: catalog.toPhysical(request.table), ...(filter ? { filter } : {}) };
}

/** A view's answer in the App's names. Its base's own columns are the view's base, which a narrowed resource shares
    its table with: named by the table they would be the table's resource's, whose display and labels are not its. */
function logicalResult<
  R extends { resolved: Array<{ table: string; hops: number; aggregate?: unknown }>; joins: Array<{ table: string }> },
>(view: ViewDef, result: R, catalog: AppResourceCatalog): R {
  const narrowed = catalog.narrowed?.has(view.base) === true;
  return {
    ...result,
    resolved: result.resolved.map((column) => ({
      ...column,
      table: narrowed && column.hops === 0 && !column.aggregate ? view.base : catalog.toLogical(column.table),
    })),
    joins: result.joins.map((join) => ({ ...join, table: catalog.toLogical(join.table) })),
  };
}

/** The logical name of a table whose name another schema shares: `billing.partner` → `billing_partner`. */
function qualifiedResourceName(table: { name: string; schema?: string; id: string }): string {
  const qualified = table.schema ? `${table.schema}_${table.name}` : table.id;
  return qualified.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(?=[0-9])/, '_');
}

/**
 * A narrowed resource's conditions, read against its table: its own columns only, compared with fixed values. A
 * path, another column, a child's rows, a date read off the clock or `me` would make the filter something other
 * than fixed conditions on the row, so each is refused with the way to say it.
 */
function narrowedConditions(schema: DatabaseSchema, logical: string, table: string, text: string): Filter {
  const at = `App resource "${logical}", query "${text}"`;
  const prefix = `${table} `;
  const { value: parsed, clock } = readsOf(() => parseQuery(`${prefix}${text}`, { schema }));
  if (parsed.errors.length || !parsed.query) {
    const error = parsed.errors[0];
    throw new Error(`${at}: ${error ? saidAt(error, `${prefix}${text}`, prefix.length) : 'it does not read as conditions.'}`);
  }
  const { filter, columns, orderBy, limit } = parsed.query;
  if (columns.length || orderBy.length || limit !== undefined)
    throw new Error(`${at}: a resource's query says conditions only; the columns and the order are its lists' own.`);
  if (!filter.groups.length) throw new Error(`${at}: it says no conditions.`);
  if (clock) throw new Error(`${at}: a resource's conditions are fixed, so they read no date relative to today.`);
  for (const condition of filter.groups.flat()) {
    if (condition.any || condition.other !== undefined || condition.column.includes('.'))
      throw new Error(
        `${at}: "${condition.column}" is not one of ${table}'s own columns compared with a value; a resource's conditions read its own row.`,
      );
  }
  return filter;
}

/** Build identities without changing the registry's physical catalog. */
export function appResourceCatalog(
  physicalSchema: DatabaseSchema,
  resources: Record<string, string> = {},
  /** The App's soft keys within this catalog, in its logical names (declaredReferences.ts). */
  references: readonly DeclaredReference[] = [],
  /** The App's TEXT columns it declares dates, in its logical names (declaredDates.ts). */
  dates: readonly DeclaredDate[] = [],
  /** The App's narrowed resources, local name → the conditions their reads stand on (appNarrowed.ts). */
  narrowed: Readonly<Record<string, string>> = {},
): AppResourceCatalog {
  const visible = new Set(physicalSchema.tables.filter((table) => !isRuntimeTable(table.name)).map((table) => table.id));
  physicalSchema = {
    ...physicalSchema,
    tables: physicalSchema.tables
      .filter((table) => visible.has(table.id))
      .map((table) => ({
        ...table,
        columns: table.columns.map((column) => {
          if (!column.references || visible.has(column.references.table)) return column;
          const { references: _hidden, ...publicColumn } = column;
          return publicColumn;
        }),
      })),
    foreignKeys: physicalSchema.foreignKeys.filter((fk) => visible.has(fk.from.table) && visible.has(fk.to.table)),
  };
  const physicalIds = new Set(physicalSchema.tables.map((table) => table.id));
  const logicalToPhysical = new Map<string, string>();
  const physicalToLogical = new Map<string, string>();
  /* A narrowed resource bound to a table another resource names: a copy of the table under its own name, never the
     name the table answers to. Each table's own name stays one, its unnarrowed resource's or its inferred one. */
  const copies: string[] = [];
  let inferring = false;
  const add = (logical: string, physical: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(logical)) {
      throw new Error(`App resource "${logical}" needs a simple identifier, such as "incidents".`);
    }
    if (!physicalIds.has(physical)) throw new Error(`App resource "${logical}" names unknown table "${physical}".`);
    const previous = logicalToPhysical.get(logical);
    if (previous && previous !== physical) {
      throw new Error(
        `App resource "${logical}" is ambiguous between "${previous}" and "${physical}". Configure distinct resource names for these tables.`,
      );
    }
    if (!inferring && Object.hasOwn(narrowed, logical) && Object.hasOwn(resources, logical)) {
      logicalToPhysical.set(logical, physical);
      copies.push(logical);
      return;
    }
    if (physicalToLogical.has(physical)) {
      throw new Error(
        `Table "${physical}" has multiple app resource names. Bind it again only with a "query" (Preview), the conditions that resource reads.`,
      );
    }
    logicalToPhysical.set(logical, physical);
    physicalToLogical.set(physical, logical);
  };
  for (const [logical, physical] of Object.entries(resources)) add(logical, physical);
  /* A name two schemas share (Liquibase's databasechangelog in each, a
     `partner` in sales and in settings) is inferred for neither: each is
     `<schema>_<name>`, whichever the App binds. Counting every table, bound or
     not, keeps an inferred name from changing when the App binds its twin,
     and a table the App never names cannot keep the App from loading. */
  const named = new Map<string, number>();
  for (const table of physicalSchema.tables) named.set(table.name, (named.get(table.name) ?? 0) + 1);
  inferring = true;
  for (const table of physicalSchema.tables) {
    if (physicalToLogical.has(table.id)) continue;
    add((named.get(table.name) ?? 0) > 1 ? qualifiedResourceName(table) : table.name, table.id);
  }
  const toPhysical = (name: string): string => {
    const physical = logicalToPhysical.get(name);
    if (!physical) throw new Refusal(`Unknown app resource "${name}".`);
    return physical;
  };
  const toLogical = (id: string): string => {
    const logical = physicalToLogical.get(id);
    if (!logical) throw new Refusal(`Unknown table "${id}" in the app resource catalog.`);
    return logical;
  };
  /* A copy that is its table's only binding (a narrowed resource named after its table) is the table's own name. */
  for (const [index, name] of [...copies.entries()].reverse()) {
    if (physicalToLogical.get(logicalToPhysical.get(name)!) === name) copies.splice(index, 1);
  }
  const logicalTable = (table: DatabaseSchema['tables'][number], id: string) => ({
    ...table,
    id,
    name: id,
    schema: '',
    columns: table.columns.map((column) => ({
      ...column,
      ...(column.references ? { references: { ...column.references, table: toLogical(column.references.table) } } : {}),
    })),
  });
  const logicalKey = (fk: ForeignKey, from = toLogical(fk.from.table)): ForeignKey => ({
    ...fk,
    from: { ...fk.from, table: from },
    to: { ...fk.to, table: toLogical(fk.to.table) },
  });
  const byId = new Map(physicalSchema.tables.map((table) => [table.id, table]));
  const logical: DatabaseSchema = {
    ...physicalSchema,
    tables: [
      ...physicalSchema.tables.map((table) => logicalTable(table, toLogical(table.id))),
      // Its table's columns and keys out; a key into the table still lands on the table's own name.
      ...copies.map((name) => logicalTable(byId.get(logicalToPhysical.get(name)!)!, name)),
    ],
    foreignKeys: [
      ...physicalSchema.foreignKeys.map((fk) => logicalKey(fk)),
      ...copies.flatMap((name) =>
        physicalSchema.foreignKeys.filter((fk) => fk.from.table === logicalToPhysical.get(name)).map((fk) => logicalKey(fk, name)),
      ),
    ],
  };
  const fixed = new Map<string, Filter>();
  for (const [name, text] of Object.entries(narrowed)) {
    const physical = logicalToPhysical.get(name);
    if (physical === undefined) throw new Error(`App resource "${name}" has a "query", and no table it reads.`);
    fixed.set(name, narrowedConditions(physicalSchema, name, physical, text));
  }
  /* Edges in this logical catalog only: the registry's physical one, and any
     scoped catalog captured from the database, never hold them. */
  const declared = withDeclaredEdges(
    logical,
    references.map((reference) => declaredEdge(logical, reference, `App resource "${reference.table}", references "${reference.column}"`)),
  );
  /* A composite key's other leg is a reference too, where it names one row alone: a tenant's
     `(tenant_id, incident_id) REFERENCES incident (tenant_id, id)` keeps the watcher in its customer, and
     `incident_id` is still the ticket — its path, its label, its type — to every reader, the checker and a reader
     who reads `tenant_id` whole as much as a tenant who cannot (impliedEdges). */
  const schema = withDeclaredDates(withDeclaredEdges(declared, impliedEdges(declared)), dates);
  return { schema, toPhysical, toLogical, ...(fixed.size ? { narrowed: fixed } : {}) };
}

const verifiedRunners = new WeakMap<Adapter, VerifiedCommandRunner>();
/** Only a framework-created mapping wrapper has a runner; copies do not. */
export const appResourceVerifiedCommandRunner = (adapter: Adapter): VerifiedCommandRunner | undefined => verifiedRunners.get(adapter);

/** A per-app adapter facade; only structured identifiers cross this boundary. */
export function createAppResources(
  physicalAdapter: Adapter,
  physicalSchema: DatabaseSchema,
  resources: Record<string, string> = {},
  references: readonly DeclaredReference[] = [],
  dates: readonly DeclaredDate[] = [],
  narrowed: Readonly<Record<string, string>> = {},
): AppResources {
  return createAppResourcesOver(physicalAdapter, appResourceCatalog(physicalSchema, resources, references, dates, narrowed));
}

/** The facade over a catalog already built: one source's, or several sources' that share one connection (appSourceAdapter.ts). */
export function createAppResourcesOver(physicalAdapter: Adapter, catalog: AppResourceCatalog): AppResources {
  const { schema, toPhysical, toLogical } = catalog;
  // Scoped capabilities belong to this deployment, not its mutable presentation
  // metadata. Keep reverse-path resolution detached as well as rule validation.
  const scopedCatalog = { ...catalog, schema: structuredClone(schema) };
  // Keep this exact identity map private: later mutations of a presentation
  // catalog must not enroll newly discovered objects into transaction evidence.
  // A table's own name only: a narrowed resource's copy of it is never what a physical table is evidence of.
  const evidenceIds = new Map(
    schema.tables
      .filter((table) => !catalog.narrowed?.has(table.id) || toLogical(toPhysical(table.id)) === table.id)
      .map((table) => [toPhysical(table.id), table.id]),
  );
  const viewToPhysical = (view: ViewDef): ViewDef => resourceView(view, catalog);
  const mapWrite = <T extends { table: string }>(request: T): T => ({ ...request, table: toPhysical(request.table) });
  const mapRead = <T extends { table: string; filter?: Filter }>(request: T): T => physicalRead(request, catalog);
  /* A write through a narrowed resource is kept inside its query (appNarrowedWrites.ts): in the write's own
     transaction, whatever door it came through, since every door writes through here. */
  const narrowedTable = (table: string) => {
    const filter = catalog.narrowed?.get(table);
    return filter ? { resource: table, physical: toPhysical(table), filter } : undefined;
  };
  const transaction = (tx: WriteTransaction): WriteTransaction => {
    const through = (table: string) => {
      const narrowed = narrowedTable(table);
      return narrowed && narrowedWrites(tx, narrowed);
    };
    /* A batch through a narrowed resource goes a row at a time, each kept inside its query as a single write is. */
    const anyNarrowed = (requests: readonly { table: string }[]) => requests.some((request) => narrowedTable(request.table));
    const mapped: WriteTransaction = {
      ...(tx.lockRecord ? { lockRecord: (request: DeleteRequest) => tx.lockRecord!(mapWrite(request)) } : {}),
      query: (request) => tx.query(mapRead(request)),
      count: (table, filter) => tx.count(toPhysical(table), physicalFilter(filter, table, catalog)),
      ...(tx.aggregate ? { aggregate: (request: AggregateRequest) => tx.aggregate!(mapRead(request)) } : {}),
      insert: (request) => through(request.table)?.insert(request) ?? tx.insert(mapWrite(request)),
      update: (request) => through(request.table)?.update(request) ?? tx.update(mapWrite(request)),
      remove: (request) => through(request.table)?.remove(request) ?? tx.remove(mapWrite(request)),
      ...(tx.tell ? { tell: (request: TellRequest) => through(request.table)?.tell(request) ?? tx.tell!(mapWrite(request)) } : {}),
    };
    if (tx.insertMany)
      mapped.insertMany = (requests) =>
        anyNarrowed(requests) ? oneAtATime(requests, (request) => mapped.insert(request)) : tx.insertMany!(requests.map(mapWrite));
    if (tx.updateMany)
      mapped.updateMany = (requests) =>
        anyNarrowed(requests) ? oneAtATime(requests, (request) => mapped.update(request)) : tx.updateMany!(requests.map(mapWrite));
    return mapped;
  };
  /* A single write outside a transaction: one through a narrowed resource is run in one, so its checks and the
     write are one unit. A source that writes one statement at a time cannot hold it there, and says so. */
  const alone = <R>(table: string, write: (writes: ReturnType<typeof narrowedWrites>) => Promise<R>): Promise<R> | undefined => {
    const narrowed = narrowedTable(table);
    if (!narrowed) return undefined;
    if (!physicalAdapter.transaction)
      throw new Refusal(
        `"${table}" is a narrowed resource, and its source cannot run a write in a transaction to keep it inside its query.`,
      );
    return physicalAdapter.transaction((tx) => write(narrowedWrites(tx, narrowed)));
  };
  const adapter: Adapter = {
    dialect: physicalAdapter.dialect,
    introspect: async () => schema,
    query: (request) => physicalAdapter.query(mapRead(request)),
    count: (table, filter, limit) => physicalAdapter.count(toPhysical(table), physicalFilter(filter, table, catalog), limit),
    close: () => physicalAdapter.close(),
  };
  if (physicalAdapter.scopeReads)
    adapter.scopeReads = async (input) => {
      // Validate every logical rule before binding, including unused resources.
      // This synchronous snapshot precedes the physical adapter's first await.
      const scope = snapshotRowScope(scopedCatalog.schema, input);
      const mapped = physicalScope(scope, toPhysical);
      const reads = await physicalAdapter.scopeReads!(Object.freeze(mapped));
      return mapAppScopedReads(reads, scopedCatalog);
    };
  if (typeof physicalAdapter.scopeTransaction === 'function')
    adapter.scopeTransaction = async (input, run) => {
      const scope = snapshotRowScope(scopedCatalog.schema, input);
      const mapped = physicalScope(scope, toPhysical);
      // Mapping refusals happen inside the facade's failure accounting, so a
      // caught unknown resource cannot commit earlier successful physical writes.
      return physicalAdapter.scopeTransaction!(Object.freeze(mapped), (tx, actual) => {
        const mappedCatalog = mapScopeCatalog(reachable(actual, catalog.bounds), evidenceIds);
        const evidence = captureScopeCatalog({
          ...mappedCatalog,
          tables: mappedCatalog.tables.map((table) => ({ ...table, name: table.id, schema: '' })),
        });
        return runScopedTransactionFacade(transaction(tx), (records) => run(records, evidence));
      });
    };
  if (typeof commandsOf(physicalAdapter).scopeCommandTransaction === 'function')
    adapter.scopeCommandTransaction = async (input, run, events, triggers) => {
      const scope = snapshotRowScope(scopedCatalog.schema, input);
      const mapped = physicalScope(scope, toPhysical);
      // Named triggers travel by physical table, and what they changed comes back by resource.
      const physicalTriggers: TriggerAcceptance | undefined = triggers && {
        named: new Map([...triggers.named].map(([table, named]) => [toPhysical(table), named])),
        ...(triggers.changed
          ? {
              changed: (change: TriggerChange) =>
                triggers.changed!({
                  ...change,
                  table: evidenceIds.get(change.table) ?? change.table,
                  on: evidenceIds.get(change.on) ?? change.on,
                }),
            }
          : {}),
      };
      return commandsOf(physicalAdapter).scopeCommandTransaction!(
        Object.freeze(mapped),
        (tx, journal, actual) => {
          const mappedCatalog = mapScopeCatalog(reachable(actual, catalog.bounds), evidenceIds);
          const evidence = captureScopeCatalog({
            ...mappedCatalog,
            tables: mappedCatalog.tables.map((table) => ({ ...table, name: table.id, schema: '' })),
          });
          // Only the trusted runtime callback receives the journal; record mapping
          // failures must still abort the shared record/receipt/audit transaction.
          return runScopedTransactionFacade(transaction(tx), (records) => run(records, journal, evidence));
        },
        events,
        physicalTriggers,
      );
    };
  // Placement is a captured source-owner capability, never dynamically looked
  // up on a mutable adapter or catalog after deployment. Columns have no App
  // aliases: only exact table identities change; key/expected scalars do not.
  const place = commandsOf(physicalAdapter).publicPlacementCommandTransaction?.bind(physicalAdapter);
  const recoverPlacement = commandsOf(physicalAdapter).publicPlacementReceipt?.bind(physicalAdapter);
  const placementIds = new Map([...evidenceIds].map(([physical, logical]) => [logical, physical]));
  const placementTable = (logical: string): string => {
    const physical = placementIds.get(logical);
    if (!physical) throw new Refusal('Unknown public placement resource.');
    return physical;
  };
  if (place)
    adapter.publicPlacementCommandTransaction = async (input, inputAdmission, run) => {
      const scope = snapshotRowScope(scopedCatalog.schema, capturePublicPlacementScope(input));
      const admission = capturePublicPlacementAdmission(inputAdmission);
      const mapped: Record<string, RowScope[string]> = Object.create(null);
      for (const [table, rule] of Object.entries(scope)) {
        // A narrowed resource's copy of a table: nothing placed reads through it (placementTable refuses its name).
        if (!placementIds.has(table) && catalog.narrowed?.has(table)) continue;
        mapped[placementTable(table)] = rule;
      }
      const anchors = admission.anchors.map((anchor) => {
        const table = scopedCatalog.schema.tables.find((table) => table.id === anchor.table);
        const primary = table?.columns.filter((column) => column.primaryKey).map((column) => column.name);
        if (
          !table ||
          !primary?.length ||
          !Object.hasOwn(scope, table.id) ||
          scope[table.id] === false ||
          primary.length !== Object.keys(anchor.key).length ||
          primary.some((column) => !Object.hasOwn(anchor.key, column)) ||
          Object.keys(anchor.expected).some((name) => !table.columns.some((column) => column.name === name))
        ) {
          throw new Refusal('Public placement anchor is outside the captured source catalog.');
        }
        return Object.freeze({ ...anchor, table: placementTable(anchor.table) });
      });
      return place(Object.freeze(mapped), Object.freeze({ ...admission, anchors: Object.freeze(anchors) }), (tx, journal, actual) => {
        // Do not use reachable(): a newly discovered/out-of-source dependency
        // must refuse rather than disappear from transaction catalog evidence.
        const mappedCatalog = mapScopeCatalog(actual, evidenceIds);
        const evidence = captureScopeCatalog({
          ...mappedCatalog,
          tables: mappedCatalog.tables.map((table) => ({ ...table, name: table.id, schema: '' })),
        });
        const map = <T extends { table: string }>(request: T): T => ({ ...request, table: placementTable(request.table) });
        return runScopedTransactionFacade(
          {
            query: (request) => tx.query(map(request)),
            count: (table, filter) => tx.count(placementTable(table), filter),
            insert: (request) => tx.insert(map(request)),
            update: (request) => tx.update(map(request)),
            remove: (request) => tx.remove(map(request)),
          },
          (records) => run(records, journal, evidence),
        );
      });
    };
  // Recovery does not consult today's aliases, scope, anchors or epoch. The
  // issuer authenticates the original owner and retains this exact source.
  if (recoverPlacement)
    adapter.publicPlacementReceipt = (owner, submission) => recoverPlacement(capturePublicPlacementOwner(owner), submission);
  // Preserve capability detection: absent optional methods must stay absent.
  // The table's estimate is not a narrowed resource's: its rows are counted, as a table without an estimate's are.
  if (physicalAdapter.estimateCount)
    adapter.estimateCount = (table) =>
      catalog.narrowed?.has(table)
        ? physicalAdapter.count(toPhysical(table), narrowedFilter(undefined, table, catalog))
        : physicalAdapter.estimateCount!(toPhysical(table));
  if (physicalAdapter.profile)
    adapter.profile = async (table, limits) => ({
      ...(await physicalAdapter.profile!(toPhysical(table), limits)),
      table,
    });
  if (physicalAdapter.ddl) adapter.ddl = (table) => physicalAdapter.ddl!(toPhysical(table));
  if (physicalAdapter.runSql) adapter.runSql = (request) => physicalAdapter.runSql!(request);
  if (physicalAdapter.explainSql) adapter.explainSql = (request) => physicalAdapter.explainSql!(request);
  if (physicalAdapter.update)
    adapter.update = (request) => alone(request.table, (writes) => writes.update(request)) ?? physicalAdapter.update!(mapWrite(request));
  if (physicalAdapter.insert)
    adapter.insert = (request) => alone(request.table, (writes) => writes.insert(request)) ?? physicalAdapter.insert!(mapWrite(request));
  if (physicalAdapter.remove)
    adapter.remove = (request) => alone(request.table, (writes) => writes.remove(request)) ?? physicalAdapter.remove!(mapWrite(request));
  if (physicalAdapter.transaction) adapter.transaction = (run) => physicalAdapter.transaction!((tx) => run(transaction(tx)));
  if (commandsOf(physicalAdapter).commandTransaction)
    adapter.commandTransaction = (run, events) =>
      commandsOf(physicalAdapter).commandTransaction!((tx, journal) => run(transaction(tx), journal), events);
  const verified = nativeVerifiedCommandRunner(physicalAdapter);
  if (verified)
    verifiedRunners.set(adapter, (verify, run, events) =>
      verified(verify, (tx, journal) => runScopedTransactionFacade(transaction(tx), (records) => run(records, journal)), events),
    );
  if (physicalAdapter.runView)
    adapter.runView = async (view, offset) => logicalResult(view, await physicalAdapter.runView!(viewToPhysical(view), offset), catalog);
  if (physicalAdapter.countView) adapter.countView = (view, limit) => physicalAdapter.countView!(viewToPhysical(view), limit);
  if (physicalAdapter.runBreakdown)
    adapter.runBreakdown = (breakdown, offset) => physicalAdapter.runBreakdown!(resourceBreakdown(breakdown, catalog), offset);
  if (physicalAdapter.countBreakdown)
    adapter.countBreakdown = (breakdown, limit) => physicalAdapter.countBreakdown!(resourceBreakdown(breakdown, catalog), limit);
  if (physicalAdapter.aggregate) adapter.aggregate = (request) => physicalAdapter.aggregate!(mapRead(request));
  if (physicalAdapter.countEach)
    adapter.countEach = (items, limit) =>
      physicalAdapter.countEach!(
        items.map((item) => ({ table: toPhysical(item.table), filter: narrowedFilter(item.filter, item.table, catalog) })),
        limit,
      );
  return { schema, adapter, toPhysical, toLogical };
}
