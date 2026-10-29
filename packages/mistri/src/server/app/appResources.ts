import {
  Refusal,
  type Adapter,
  type DeleteRequest,
  type ScopedReads,
  type TellRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { nativeVerifiedCommandRunner, type VerifiedCommandRunner } from '../commands/verifiedCommandRunner.js';
import { isRuntimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { compileView, resolveAggregate, type ViewDef, type ViewFilter } from '@mistriwork/engine/shared/view.js';
import { compileBreakdown, type BreakdownDef } from '@mistriwork/engine/shared/breakdown.js';
import { ANSI_STYLE } from '@mistriwork/engine/shared/filter.js';
import type { ForeignKey } from '@mistriwork/engine/shared/schema.js';
import { declaredEdge, impliedEdges, withDeclaredEdges, type DeclaredReference } from '@mistriwork/engine/shared/declaredReferences.js';
import { withDeclaredDates } from '../../shared/declaredDates.js';
import type { DeclaredDate } from '../../shared/appModel.js';
import { renamedComputed } from '@mistriwork/engine/shared/rollups.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { runScopedTransactionFacade } from '../policy/scopedTransactionFacade.js';
import {
  capturePublicPlacementAdmission,
  capturePublicPlacementOwner,
  capturePublicPlacementScope,
} from '../../adapters/commands/publicPlacementTransaction.js';
import { commandsOf } from '../stores/commandStores.js';

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
function carriedReferences<T extends { references?: ForeignKey[] }>(def: T, catalog: AppResourceCatalog): T {
  const { references: _requested, ...rest } = def;
  const references = physicalReferencesOf(catalog);
  return (references.length ? { ...rest, references } : rest) as T;
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
  const physical = carriedReferences(
    renamedComputed(
      {
        ...rest,
        base: catalog.toPhysical(breakdown.base),
        ...(dated.length ? { dateColumns: dated } : {}),
        // A rail's counts under a tags filter read the link and tag tables as the list does (physicalView).
        ...(rest.tagged ? { tagged: physicalTags(rest.tagged, catalog.toPhysical) } : {}),
        ...(rest.filter ? { filter: physicalAny(rest.filter, catalog.toPhysical) } : {}),
      },
      catalog.toPhysical,
    ),
    catalog,
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
  return {
    ...carriedReferences(view, catalog),
    base: toPhysical(view.base),
    // Resolve child-table identifiers while they still belong to this catalog.
    ...(view.aggregates
      ? {
          aggregates: view.aggregates.map((aggregate) => {
            const resolved = resolveAggregate(schema, view.base, aggregate);
            return { ...aggregate, via: `${toPhysical(resolved.child.id)}.${resolved.fk.from.columns.join('+')}`, alias: resolved.name };
          }),
        }
      : {}),
    // A rollup names its child by endpoints, so renaming the table is the whole translation.
    ...(view.computed ? { computed: renamedComputed(view, toPhysical).computed } : {}),
    // A record's tags name their link and tag tables by id: renamed the same way.
    ...(view.tagged ? { tagged: physicalTags(view.tagged, toPhysical) } : {}),
    ...(view.filter ? { filter: physicalAny(view.filter, toPhysical) } : {}),
  };
}

/* An `any` condition names its child rows by endpoints, as a rollup does (`opportunity.account_id`): renaming the
   table is the whole translation. The child's own conditions are its columns and references, which keep their names. */
function physicalAny(filter: ViewFilter, toPhysical: (table: string) => string): ViewFilter {
  if (!filter.groups.some((group) => group.some((condition) => condition.any))) return filter;
  return {
    groups: filter.groups.map((group) =>
      group.map((condition) => {
        if (!condition.any) return condition;
        const { via } = condition.any;
        const child = via.slice(0, via.lastIndexOf('.'));
        return { ...condition, any: { ...condition.any, via: `${toPhysical(child)}${via.slice(child.length)}` } };
      }),
    ),
  };
}

/** A record's tags name their link and tag tables by id: renamed, as a rollup's child is. */
function physicalTags(tagged: NonNullable<ViewDef['tagged']>, toPhysical: (id: string) => string): NonNullable<ViewDef['tagged']> {
  return Object.fromEntries(
    Object.entries(tagged).map(([path, tags]) => [path, { ...tags, through: toPhysical(tags.through), to: toPhysical(tags.to) }]),
  );
}

/** Internal identity-only facade over an already bound physical capability. */
export function mapAppScopedReads(reads: ScopedReads, catalog: AppResourceCatalog): ScopedReads {
  const { toPhysical, toLogical } = catalog;
  const scoped: ScopedReads = {
    query: (request) => reads.query({ ...request, table: toPhysical(request.table) }),
    count: (table, filter, limit) => reads.count(toPhysical(table), filter, limit),
    runView: async (view, offset) => {
      const result = await reads.runView(resourceView(view, catalog), offset);
      return {
        ...result,
        resolved: result.resolved.map((column) => ({ ...column, table: toLogical(column.table) })),
        joins: result.joins.map((join) => ({ ...join, table: toLogical(join.table) })),
      };
    },
    countView: (view, limit) => reads.countView(resourceView(view, catalog), limit),
    runBreakdown: (breakdown, offset) => reads.runBreakdown(resourceBreakdown(breakdown, catalog), offset),
    countBreakdown: (breakdown) => reads.countBreakdown(resourceBreakdown(breakdown, catalog)),
    ...(reads.countEach
      ? {
          countEach: (items, limit) =>
            reads.countEach!(
              items.map((item) => ({ table: toPhysical(item.table), filter: item.filter })),
              limit,
            ),
        }
      : {}),
  };
  return Object.freeze(scoped);
}

/** The logical name of a table whose name another schema shares: `billing.partner` → `billing_partner`. */
function qualifiedResourceName(table: { name: string; schema?: string; id: string }): string {
  const qualified = table.schema ? `${table.schema}_${table.name}` : table.id;
  return qualified.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(?=[0-9])/, '_');
}

/** Build identities without changing the registry's physical catalog. */
export function appResourceCatalog(
  physicalSchema: DatabaseSchema,
  resources: Record<string, string> = {},
  /** The App's soft keys within this catalog, in its logical names (declaredReferences.ts). */
  references: readonly DeclaredReference[] = [],
  /** The App's TEXT columns it declares dates, in its logical names (declaredDates.ts). */
  dates: readonly DeclaredDate[] = [],
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
    if (physicalToLogical.has(physical)) {
      throw new Error(`Table "${physical}" has multiple app resource names. Configure one resource name per table.`);
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
  const logical: DatabaseSchema = {
    ...physicalSchema,
    tables: physicalSchema.tables.map((table) => ({
      ...table,
      id: toLogical(table.id),
      name: toLogical(table.id),
      schema: '',
      columns: table.columns.map((column) => ({
        ...column,
        ...(column.references ? { references: { ...column.references, table: toLogical(column.references.table) } } : {}),
      })),
    })),
    foreignKeys: physicalSchema.foreignKeys.map((fk) => ({
      ...fk,
      from: { ...fk.from, table: toLogical(fk.from.table) },
      to: { ...fk.to, table: toLogical(fk.to.table) },
    })),
  };
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
  return { schema, toPhysical, toLogical };
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
): AppResources {
  return createAppResourcesOver(physicalAdapter, appResourceCatalog(physicalSchema, resources, references, dates));
}

/** The facade over a catalog already built: one source's, or several sources' that share one connection (appSourceAdapter.ts). */
export function createAppResourcesOver(physicalAdapter: Adapter, catalog: AppResourceCatalog): AppResources {
  const { schema, toPhysical, toLogical } = catalog;
  // Scoped capabilities belong to this deployment, not its mutable presentation
  // metadata. Keep reverse-path resolution detached as well as rule validation.
  const scopedCatalog = { ...catalog, schema: structuredClone(schema) };
  // Keep this exact identity map private: later mutations of a presentation
  // catalog must not enroll newly discovered objects into transaction evidence.
  const evidenceIds = new Map(schema.tables.map((table) => [toPhysical(table.id), table.id]));
  const viewToPhysical = (view: ViewDef): ViewDef => resourceView(view, catalog);
  const mapWrite = <T extends { table: string }>(request: T): T => ({ ...request, table: toPhysical(request.table) });
  const transaction = (tx: WriteTransaction): WriteTransaction => ({
    ...(tx.lockRecord ? { lockRecord: (request: DeleteRequest) => tx.lockRecord!(mapWrite(request)) } : {}),
    query: (request) => tx.query(mapWrite(request)),
    count: (table, filter) => tx.count(toPhysical(table), filter),
    insert: (request) => tx.insert(mapWrite(request)),
    update: (request) => tx.update(mapWrite(request)),
    remove: (request) => tx.remove(mapWrite(request)),
    ...(tx.tell ? { tell: (request: TellRequest) => tx.tell!(mapWrite(request)) } : {}),
  });
  const adapter: Adapter = {
    dialect: physicalAdapter.dialect,
    introspect: async () => schema,
    query: (request) => physicalAdapter.query(mapWrite(request)),
    count: (table, filter, limit) => physicalAdapter.count(toPhysical(table), filter, limit),
    close: () => physicalAdapter.close(),
  };
  if (physicalAdapter.scopeReads)
    adapter.scopeReads = async (input) => {
      // Validate every logical rule before binding, including unused resources.
      // This synchronous snapshot precedes the physical adapter's first await.
      const scope = snapshotRowScope(scopedCatalog.schema, input);
      const mapped: Record<string, RowScope[string]> = Object.create(null);
      for (const [table, rule] of Object.entries(scope)) mapped[toPhysical(table)] = rule;
      const reads = await physicalAdapter.scopeReads!(Object.freeze(mapped));
      return mapAppScopedReads(reads, scopedCatalog);
    };
  if (typeof physicalAdapter.scopeTransaction === 'function')
    adapter.scopeTransaction = async (input, run) => {
      const scope = snapshotRowScope(scopedCatalog.schema, input);
      const mapped: Record<string, RowScope[string]> = Object.create(null);
      for (const [table, rule] of Object.entries(scope)) mapped[toPhysical(table)] = rule;
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
    adapter.scopeCommandTransaction = async (input, run, events) => {
      const scope = snapshotRowScope(scopedCatalog.schema, input);
      const mapped: Record<string, RowScope[string]> = Object.create(null);
      for (const [table, rule] of Object.entries(scope)) mapped[toPhysical(table)] = rule;
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
      for (const [table, rule] of Object.entries(scope)) mapped[placementTable(table)] = rule;
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
  if (physicalAdapter.estimateCount) adapter.estimateCount = (table) => physicalAdapter.estimateCount!(toPhysical(table));
  if (physicalAdapter.profile)
    adapter.profile = async (table, limits) => ({
      ...(await physicalAdapter.profile!(toPhysical(table), limits)),
      table,
    });
  if (physicalAdapter.ddl) adapter.ddl = (table) => physicalAdapter.ddl!(toPhysical(table));
  if (physicalAdapter.runSql) adapter.runSql = (request) => physicalAdapter.runSql!(request);
  if (physicalAdapter.explainSql) adapter.explainSql = (request) => physicalAdapter.explainSql!(request);
  if (physicalAdapter.update) adapter.update = (request) => physicalAdapter.update!(mapWrite(request));
  if (physicalAdapter.insert) adapter.insert = (request) => physicalAdapter.insert!(mapWrite(request));
  if (physicalAdapter.remove) adapter.remove = (request) => physicalAdapter.remove!(mapWrite(request));
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
    adapter.runView = async (view, offset) => {
      const result = await physicalAdapter.runView!(viewToPhysical(view), offset);
      return {
        ...result,
        resolved: result.resolved.map((column) => ({ ...column, table: toLogical(column.table) })),
        joins: result.joins.map((join) => ({ ...join, table: toLogical(join.table) })),
      };
    };
  if (physicalAdapter.countView) adapter.countView = (view, limit) => physicalAdapter.countView!(viewToPhysical(view), limit);
  if (physicalAdapter.runBreakdown)
    adapter.runBreakdown = (breakdown, offset) => physicalAdapter.runBreakdown!(resourceBreakdown(breakdown, catalog), offset);
  if (physicalAdapter.countBreakdown)
    adapter.countBreakdown = (breakdown, limit) => physicalAdapter.countBreakdown!(resourceBreakdown(breakdown, catalog), limit);
  if (physicalAdapter.countEach)
    adapter.countEach = (items, limit) =>
      physicalAdapter.countEach!(
        items.map((item) => ({ table: toPhysical(item.table), filter: item.filter })),
        limit,
      );
  return { schema, adapter, toPhysical, toLogical };
}
