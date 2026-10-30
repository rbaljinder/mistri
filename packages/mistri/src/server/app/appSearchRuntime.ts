/**
 * Search at runtime: asking the engine, and keeping its index in step.
 *
 * The engine is whatever search provider is plugged in (searchProvider.ts);
 * with none, an App that declares search is refused at startup, and every
 * other App's text filters run on the database.
 *
 * The engine is an index, never a source of truth. It holds a copy of each
 * searched resource's declared fields under the record's key. Inside an App,
 * a text filter (`name contains "stone"`) on a declared field is asked of the
 * engine, and the condition becomes "the key is one of these" — read, as
 * every row is, through the request's own adapter: the reader's grants, row
 * policy and field ceiling decide what comes back, and the list's rows, its
 * counts and its breakdowns all ask the same question. The URL and the
 * filter box keep what was typed. When the engine does not answer, the
 * filter runs on the database, as it did before, and the reply says so.
 *
 * The index follows the App's writes: after a committed insert, update or
 * delete, the record is re-read from the database and its document written
 * or removed. Off the request, bounded and retried; a record that still
 * fails is said once and left to `mistri --reindex`.
 */
import type { Adapter, CountItem, QueryRequest } from '@mistriwork/engine/adapters/adapter.js';
import { appSearchProblem, searchCollection, searchDocField, searchPaths, type SearchPath } from '../../shared/appSearch.js';
import type { AppDef, AppSearchDef } from '../../shared/appModel.js';
import { measureConditions, type BreakdownDef } from '@mistriwork/engine/shared/breakdown.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import { columnKind, primaryKey, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { ViewCondition, ViewFilter } from '@mistriwork/engine/shared/viewPaths.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { commandsOf } from '../stores/commandStores.js';
import { appForConnection, type AppHost } from './apps.js';
import { appSourceConnections } from './appRuntimeResources.js';
import {
  NO_SEARCH_PROVIDER,
  SearchUnavailable,
  searchProviderOf,
  type SearchDocument,
  type SearchIndex,
  type SearchScope,
} from './searchProvider.js';
import { MEMORY_SEARCH_CONNECTION, memorySearchProvider } from './memorySearch.js';

interface SearchedResource {
  name: string;
  search: AppSearchDef;
  table: TableMeta;
  key: string;
  /** Its fields that follow a reference (`requester.name`), each copied into the document from the row it points at. */
  paths: SearchPath[];
}

/** The resource's search over `table`, its paths resolved in `tables`; undefined when this catalog cannot run it. */
function searchedOver(name: string, search: AppSearchDef, table: TableMeta, tables: readonly TableMeta[]): SearchedResource | undefined {
  if (appSearchProblem(search, table, tables)) return undefined;
  return { name, search, table, key: primaryKey(table)[0], paths: searchPaths(search, table, tables) as SearchPath[] };
}
/* The fields a record's own row holds, and the document's fields: its own, then each path's. */
const ownFields = (found: SearchedResource) => found.search.fields.filter((field) => !field.includes('.'));
const docFields = (found: SearchedResource) => found.search.fields.map(searchDocField);
const pathSearches = (app: AppDef) =>
  Object.values(app.resources ?? {}).some((resource) => resource.search?.fields.some((f) => f.includes('.')));

/** The resource over `tableId` that declares a search this catalog can run, or undefined. */
function searchedResource(app: AppDef, schema: DatabaseSchema, tableId: string): SearchedResource | undefined {
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.search) continue;
    const table = tableNamed(schema, name);
    if (!table || table.id !== tableId) continue;
    return searchedOver(name, resource.search, table, schema.tables);
  }
  return undefined;
}

const searches = (app: AppDef) => Object.values(app.resources ?? {}).some((resource) => resource.search);

/**
 * Checked at startup and by mistri check: every search names a
 * connection the plugged-in provider has. A tenant App's searches run
 * through tenantSearch.ts, on the same index with each document's tenant.
 */
export function assertAppSearch(apps: readonly AppDef[], registry: Registry): void {
  const provider = searchProviderOf(registry);
  for (const app of apps) {
    for (const [name, resource] of Object.entries(app.resources ?? {})) {
      if (!resource.search) continue;
      /* The built-in memory provider needs no plug-in: a search through
         `memory` is satisfied by it, whatever the registry holds. */
      if (resource.search.connection === MEMORY_SEARCH_CONNECTION) continue;
      if (!provider) throw new Error(`App "${app.name}": resources "${name}" declares a search, and ${NO_SEARCH_PROVIDER}`);
      if (!provider.index(resource.search.connection)) {
        throw new Error(
          `App "${app.name}": resources "${name}" searches through "${resource.search.connection}", which the search provider does not have.`,
        );
      }
    }
  }
}

/* The index a resource's search names; undefined without a provider or without that connection. The memory
   connection falls back to the built-in provider, so a `memory` search works with no pack plugged in. */
const indexOf = (registry: Registry, found: SearchedResource): SearchIndex | undefined =>
  searchProviderOf(registry)?.index(found.search.connection) ?? memorySearchProvider.index(found.search.connection);

const collectionOf = (index: SearchIndex, app: AppDef, found: SearchedResource) =>
  searchCollection(index.collectionPrefix, app.id, found.name);

/* The engine hands keys back as text; an integer key is compared as the number it is. */
function keyValue(found: SearchedResource, text: string): string | number {
  const column = found.table.columns.find((c) => c.name === found.key);
  return column && columnKind(column.type ?? '') === 'number' && /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : text;
}

/* An outage is said at most once a minute per search connection. */
const warned = new Map<string, number>();
function warnUnavailable(registry: Registry, connection: string, message: string): void {
  if (Date.now() - (warned.get(connection) ?? 0) < 60_000) return;
  warned.set(connection, Date.now());
  registry.onWarning(`${message} Searching the database instead until it answers.`);
}

/* The most keys one text filter becomes: the engine's page, best first. A
   search answers "the best matches", not every row a substring would. */
const MAX_HITS = 250;

interface SearchContext {
  registry: Registry;
  appHosts: AppHost[];
  connection: string;
  schema: DatabaseSchema;
  /** Called when a filter fell back to the database because the engine did not answer. */
  onFallback: () => void;
}

/**
 * The request's adapter, with its text filters on searched fields asked of
 * the engine. Everything else — writes, views, the catalog — passes through
 * untouched; an App that declares no search gets the adapter itself.
 */
export function searchAwareAdapter(adapter: Adapter, context: SearchContext): Adapter {
  const { registry, schema } = context;
  const app = appForConnection(context.appHosts, context.connection, registry.configOf(context.connection)?.name)?.app.app;
  if (!app || !searches(app) || !searchProviderOf(registry)) return adapter;
  return searchFiltered(adapter, app, schema, engineAsker(registry, app, context.onFallback));
}

/** The document field that holds a tenant-owned record's tenant. Never a
 * declared field: a resource's own `tenant` column stays its own. */
const TENANT_FIELD = 'mistri_tenant';

/* The documents of one tenant; the provider says it in its engine's terms (and refuses an id it cannot quote). */
const tenantScope = (tenantId: string): SearchScope => {
  if (!tenantId) throw new SearchUnavailable('the tenant cannot be named to the engine.');
  return { field: TENANT_FIELD, value: tenantId };
};

/**
 * A tenant context's reader, with its text filters on searched fields asked
 * of the engine within its tenant: one collection per App holds every
 * tenant's documents, each with its tenant, and every question this side
 * asks names the tenant the lease admitted. The keys that come back are then
 * read through `adapter` — the context's own reader, under its tenant, grants
 * and row scope — so even an index that held a wrong document could only
 * narrow a list, never show another tenant's row. A resource that is not
 * tenant-owned (`tenantColumns` names it not) is asked across the index, as
 * its rows are the platform's.
 */
export function tenantSearchAdapter(
  adapter: Adapter,
  context: Readonly<{
    registry: Registry;
    app: AppDef;
    schema: DatabaseSchema;
    tenantId: string;
    /** Logical resource → its tenant column; absent for a resource not owned by a tenant. */
    tenantColumns: Readonly<Record<string, string>>;
    onFallback?: () => void;
  }>,
): Adapter {
  const { registry, app } = context;
  if (!searches(app) || !searchProviderOf(registry)) return adapter;
  return searchFiltered(
    adapter,
    app,
    context.schema,
    engineAsker(registry, app, context.onFallback ?? (() => {}), (found) =>
      context.tenantColumns[found.name] === undefined ? undefined : tenantScope(context.tenantId),
    ),
  );
}

/* The keys matching `text` in `column`, or undefined when the engine did not answer; asked once per request. */
function engineAsker(
  registry: Registry,
  app: AppDef,
  onFallback: () => void,
  scopeOf: (found: SearchedResource) => SearchScope | undefined = () => undefined,
): Asker {
  const asked = new Map<string, Promise<string[] | undefined>>();
  return (found, fields, text) => {
    const id = JSON.stringify([found.table.id, fields, text]);
    let answer = asked.get(id);
    if (!answer) {
      answer = (async () => {
        try {
          const index = indexOf(registry, found);
          if (!index) return undefined;
          return await index.search(collectionOf(index, app, found), text, [...fields], MAX_HITS, scopeOf(found));
        } catch (error) {
          if (!(error instanceof SearchUnavailable)) throw error;
          warnUnavailable(registry, found.search.connection, error.message);
          onFallback();
          return undefined;
        }
      })();
      asked.set(id, answer);
    }
    return answer;
  };
}

type Asker = (found: SearchedResource, fields: readonly string[], text: string) => Promise<string[] | undefined>;

/* `adapter` with each text filter on a searched field turned into the keys `engineKeys` answers. */
function searchFiltered(adapter: Adapter, app: AppDef, schema: DatabaseSchema, engineKeys: Asker): Adapter {
  /* One condition, as the engine would ask it: `key in (…)`, or a condition
     no row meets when nothing matched; left alone when it is not a text
     filter on a searched field, or when the engine did not answer. */
  const asSearched = async (found: SearchedResource, column: string, op: string, value: unknown) => {
    if (op !== 'contains' || typeof value !== 'string' || !value.trim() || !found.search.fields.includes(column)) return undefined;
    /* A record's own text field is asked with its paths beside it: the box that
       searches a ticket's subject finds it by its requester's name too. A path
       asked by name is asked alone. */
    const fields = column.includes('.') ? [searchDocField(column)] : [column, ...found.paths.map((path) => path.doc)];
    const ids = await engineKeys(found, fields, value.trim());
    if (!ids) return undefined;
    return ids.length ? { op: 'in' as const, value: ids.map((id) => keyValue(found, id)) } : { op: 'isNull' as const, value: undefined };
  };

  const filterFor = async (table: string, filter: Filter | undefined): Promise<Filter | undefined> => {
    const found = filter && searchedResource(app, schema, table);
    if (!found) return filter;
    const groups = await Promise.all(
      filter.groups.map((group) =>
        Promise.all(
          group.map(async (condition): Promise<Condition> => {
            const searched = await asSearched(found, condition.column, condition.op, condition.value);
            if (!searched) return condition;
            return searched.op === 'in' ? { column: found.key, op: 'in', value: searched.value } : { column: found.key, op: 'isNull' };
          }),
        ),
      ),
    );
    return { groups };
  };

  /* A breakdown filters by paths; only a bare path — a column of its own table — can be one the index holds. */
  const viewFilterFor = async (table: string, filter: ViewFilter | undefined): Promise<ViewFilter | undefined> => {
    const found = filter && searchedResource(app, schema, table);
    if (!found) return filter;
    const groups = await Promise.all(
      filter.groups.map((group) =>
        Promise.all(
          group.map(async (condition): Promise<ViewCondition> => {
            if ((condition.path.includes('.') && !found.paths.some((p) => p.field === condition.path)) || condition.other !== undefined)
              return condition;
            const searched = await asSearched(found, condition.path, condition.op, condition.value);
            if (!searched) return condition;
            return searched.op === 'in'
              ? { ...condition, path: found.key, op: 'in', value: searched.value }
              : { path: found.key, op: 'isNull' };
          }),
        ),
      ),
    );
    return { groups };
  };

  const target = adapter;
  const wrap = (property: string | symbol, value: (...args: unknown[]) => unknown) => {
    if (property === 'query') {
      return async (request: QueryRequest) => target.query({ ...request, filter: await filterFor(request.table, request.filter) });
    }
    if (property === 'count') {
      return async (table: string, filter?: Filter, ...rest: unknown[]) =>
        value.call(target, table, await filterFor(table, filter), ...rest);
    }
    if (property === 'countEach') {
      /* Each item's text filter asked of the engine, as `count` asks it, so
         a tab's badge counts what its list will show. */
      return async (items: readonly CountItem[], ...rest: unknown[]) =>
        value.call(
          target,
          await Promise.all(items.map(async (item) => ({ table: item.table, filter: await filterFor(item.table, item.filter) }))),
          ...rest,
        );
    }
    if (property === 'runBreakdown' || property === 'countBreakdown') {
      return async (breakdown: BreakdownDef, ...rest: unknown[]) =>
        value.call(
          target,
          {
            ...breakdown,
            filter: await viewFilterFor(breakdown.base, breakdown.filter),
            /* A funnel's stages are conditions of their own (`count when [...]`), searched as the section's are. */
            ...(measureConditions(breakdown.measures).length
              ? {
                  measures: await Promise.all(
                    breakdown.measures.map(async (m) => (m.where ? { ...m, where: await viewFilterFor(breakdown.base, m.where) } : m)),
                  ),
                }
              : {}),
          },
          ...rest,
        );
    }
    return value.bind(target);
  };
  /* A frozen reader (a tenant context's) cannot stand behind a proxy that
     answers its own methods differently; it is copied, method by method. */
  if (Object.isFrozen(adapter))
    return Object.freeze(
      Object.fromEntries(
        Object.entries(adapter).map(([property, value]) => [
          property,
          typeof value === 'function' ? wrap(property, value as (...args: unknown[]) => unknown) : value,
        ]),
      ),
    ) as unknown as Adapter;
  /* A dialect adapter's commands are its journal's (stores/commandStores.ts), not its own members: forwarded as the rest is. */
  const commands = commandsOf(adapter) as Record<PropertyKey, unknown>;
  return new Proxy(adapter, {
    get(proxied, property) {
      const value =
        Reflect.get(proxied, property, proxied) ?? (typeof property === 'string' && property in commands ? commands[property] : undefined);
      return typeof value === 'function' ? wrap(property, value as (...args: unknown[]) => unknown) : value;
    },
  });
}

/* A row as its index document: the key as `id`, each declared field as text; a
   field with no value, or bytes, is left out rather than indexed as "null". */
function documentOf(
  row: Record<string, unknown>,
  found: SearchedResource,
  tenantColumn?: string,
  followed?: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): SearchDocument {
  const document: SearchDocument = { id: String(row[found.key]) };
  if (tenantColumn !== undefined) document[TENANT_FIELD] = String(row[tenantColumn]);
  const put = (field: string, value: unknown) => {
    if (value === null || value === undefined || value instanceof Uint8Array) return;
    document[field] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  };
  for (const field of ownFields(found)) put(field, row[field]);
  for (const path of found.paths) {
    const via = row[path.via];
    if (via !== null && via !== undefined) put(path.doc, followed?.get(path.doc)?.get(String(via)));
  }
  return document;
}

/* The columns a record's document is read from: its key, its own fields, each path's reference, and its tenant. */
function documentColumns(found: SearchedResource, tenantColumn?: string): string[] {
  const columns = [found.key, ...ownFields(found), ...found.paths.map((path) => path.via)];
  if (tenantColumn !== undefined) columns.push(tenantColumn);
  return [...new Set(columns)];
}

/**
 * Each path's value for the rows read, by the reference they hold: one read
 * of the referenced table per path for a page of rows, through the same
 * adapter, so a document is the database's word at the time it was written.
 */
async function followPaths(
  adapter: Adapter,
  found: SearchedResource,
  rows: readonly Record<string, unknown>[],
): Promise<Map<string, Map<string, unknown>>> {
  const followed = new Map<string, Map<string, unknown>>();
  for (const path of found.paths) {
    const values = new Map<string, unknown>();
    followed.set(path.doc, values);
    const keys = [...new Set(rows.map((row) => row[path.via]).filter((v) => v !== null && v !== undefined))] as Array<string | number>;
    for (let i = 0; i < keys.length; i += 500) {
      const read = await adapter.query({
        table: path.table,
        columns: [path.key, path.column],
        filter: { groups: [[{ column: path.key, op: 'in', value: keys.slice(i, i + 500) }]] },
        limit: 500,
        offset: 0,
      });
      for (const row of read.rows) values.set(String(row[path.key]), row[path.column]);
    }
  }
  return followed;
}

/** Where a resource's rows are: its connection and its table there, which a
 * write names exactly, since one connection may back several sources. */
interface IndexTarget {
  connection: string;
  resource: string;
  physical: string;
}
interface IndexJob extends IndexTarget {
  app: AppDef;
  key: Record<string, unknown>;
  attempt: number;
  /** A tenant-owned resource's tenant column, physical: its value goes in each document. */
  tenantColumn?: string;
  /** Not this record's document but the documents that copy it: every searched row whose path points at it. */
  dependents?: true;
  /** A tenant App's resource → tenant column, for those dependents' documents. */
  tenantColumns?: Readonly<Record<string, string>>;
}

/* The most dependents one write re-indexes; past it the rest wait for --reindex, and it is said. */
const MAX_DEPENDENTS = 10_000;

/** The searched resource `resource` over its physical table, read from its own connection's catalog. */
function searchedAt(app: AppDef, physicalSchema: DatabaseSchema, target: Omit<IndexTarget, 'connection'>): SearchedResource | undefined {
  const search = app.resources?.[target.resource]?.search;
  const table = physicalSchema.tables.find((candidate) => candidate.id === target.physical);
  if (!search || !table) return undefined;
  return searchedOver(target.resource, search, table, physicalSchema.tables);
}

/**
 * Each searched resource's connection and physical table, as the App binds
 * it: its source's connection, its `physical` id or its own name, in the
 * schema its source is scoped to. Without sources, the App's one connection.
 */
async function searchTargets(
  registry: Registry,
  app: AppDef,
  owner: string,
): Promise<Array<IndexTarget | { resource: string; problem: string }>> {
  const bound = app.sources ? appSourceConnections(registry, app) : undefined;
  const targets: Array<IndexTarget | { resource: string; problem: string }> = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.search) continue;
    const connection = bound ? bound.get(resource.source!) : owner;
    if (!connection) {
      targets.push({ resource: name, problem: 'its source has no connection' });
      continue;
    }
    const { schema } = await registry.open(connection);
    const scope = resource.source ? app.sources?.[resource.source]?.schema : undefined;
    const tables = scope === undefined ? schema : { ...schema, tables: schema.tables.filter((table) => table.schema === scope) };
    const wanted = resource.physical ?? name.slice(name.indexOf('.') + 1);
    const table = tables.tables.find((candidate) => candidate.id === wanted) ?? tableNamed(tables, wanted);
    targets.push(table ? { connection, resource: name, physical: table.id } : { resource: name, problem: 'it has no such table' });
  }
  return targets;
}

const RETRY_MS = [250, 2_000, 10_000];
const REINDEX_PAGE = 500;

/**
 * Keeps each searched resource's index in step with the App's writes. A
 * write never waits for it: `touched` queues the record (once, however often
 * it is touched before its turn) and returns.
 */
class SearchIndexer {
  private readonly queue = new Map<string, IndexJob>();
  private draining?: Promise<void>;
  private waiting = 0;
  private readonly ensured = new Set<string>();

  constructor(
    private readonly registry: Registry,
    private readonly retryMs: readonly number[] = RETRY_MS,
  ) {}

  /** A committed write to `tableId` in `app`: re-index that record soon. A
   * tenant-owned resource names its tenant column, whose value each document keeps. */
  touched(
    app: AppDef,
    target: IndexTarget,
    key: Record<string, unknown>,
    tenantColumn?: string,
    /** A tenant App's resource → tenant column: the documents that copy this record keep their own tenant. */
    tenantColumns?: Readonly<Record<string, string>>,
  ): void {
    if (!searches(app)) return;
    if (app.resources?.[target.resource]?.search)
      this.enqueue({ app, ...target, key, attempt: 0, ...(tenantColumn === undefined ? {} : { tenantColumn }) });
    // A row another resource's search copies a value of (`requester.name`): its copies follow it.
    if (pathSearches(app)) this.enqueue({ app, ...target, key, attempt: 0, dependents: true, ...(tenantColumns ? { tenantColumns } : {}) });
  }

  /** Resolves once nothing is queued, running or waiting to retry; tests and shutdown use it. */
  async settled(): Promise<void> {
    while (this.queue.size || this.draining || this.waiting) {
      await (this.draining ?? new Promise((resolve) => setTimeout(resolve, 20)));
    }
  }

  /**
   * Every searched resource of `app` (or only `only`), read from the database
   * in key order and written to its index. Records deleted outside the App
   * keep their documents, which the re-read on every search already hides.
   */
  async reindex(
    app: AppDef,
    connection: string,
    only?: string,
    page = REINDEX_PAGE,
    /** A tenant App's resource → tenant column (tenantSearch.ts); each document keeps its row's tenant. */
    tenantColumns: Readonly<Record<string, string>> = {},
  ): Promise<Array<{ resource: string; indexed: number }>> {
    const done: Array<{ resource: string; indexed: number }> = [];
    for (const target of await searchTargets(this.registry, app, connection)) {
      const name = target.resource;
      if (only !== undefined && name !== only) continue;
      if ('problem' in target) throw new Error(`resources "${name}" cannot be indexed on this connection: ${target.problem}`);
      const { adapter, schema } = await this.registry.open(target.connection);
      const found = searchedAt(app, schema, target);
      const table = schema.tables.find((candidate) => candidate.id === target.physical)!;
      if (!found)
        throw new Error(
          `resources "${name}" cannot be indexed on this connection: ${appSearchProblem(app.resources![name].search!, table, schema.tables)}`,
        );
      const index = this.index(found);
      const collection = collectionOf(index, app, found);
      const tenantColumn = tenantColumns[name];
      await this.ensure(index, collection, docFields(found), tenantColumn !== undefined);
      const columns = documentColumns(found, tenantColumn);
      let indexed = 0;
      /* Each page starts after the last key the one before it read, never at
         an offset: an offset makes the database walk every row it skips, so
         a reindex of n rows read n²/2 of them — minutes on a large table for
         what is one pass in key order. */
      let after: string | number | undefined;
      for (;;) {
        const read = await adapter.query({
          table: found.table.id,
          columns,
          ...(after === undefined ? {} : { filter: { groups: [[{ column: found.key, op: '>', value: after }]] } }),
          orderBy: [{ column: found.key, direction: 'asc' }],
          limit: page,
          offset: 0,
        });
        const followed = await followPaths(adapter, found, read.rows);
        for (let i = 0; i < read.rows.length; i += 4) {
          await Promise.all(
            read.rows.slice(i, i + 4).map((row) => index.upsert(collection, documentOf(row, found, tenantColumn, followed))),
          );
        }
        indexed += read.rows.length;
        if (read.rows.length < page) break;
        after = read.rows[read.rows.length - 1][found.key] as string | number;
      }
      done.push({ resource: name, indexed });
    }
    if (only !== undefined && !done.length) throw new Error(`No searched resource is named "${only}".`);
    return done;
  }

  private index(found: SearchedResource): SearchIndex {
    const index = indexOf(this.registry, found);
    if (!index) {
      if (!searchProviderOf(this.registry)) throw new SearchUnavailable(`"${found.search.connection}": ${NO_SEARCH_PROVIDER}`);
      throw new SearchUnavailable(`"${found.search.connection}" is not a connection of the search provider.`);
    }
    return index;
  }

  private async ensure(index: SearchIndex, collection: string, fields: readonly string[], tenant = false): Promise<void> {
    if (this.ensured.has(collection)) return;
    await index.ensureCollection(collection, tenant ? [...fields, TENANT_FIELD] : fields);
    this.ensured.add(collection);
  }

  private enqueue(job: IndexJob): void {
    this.queue.set(JSON.stringify([job.app.id, job.resource, job.key, job.dependents ?? false]), job);
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.size) {
      const [id, job] = this.queue.entries().next().value!;
      this.queue.delete(id);
      try {
        await this.apply(job);
      } catch (error) {
        if (job.attempt < this.retryMs.length) {
          this.waiting++;
          setTimeout(() => {
            this.waiting--;
            this.enqueue({ ...job, attempt: job.attempt + 1 });
          }, this.retryMs[job.attempt]).unref();
        } else {
          this.registry.onWarning(
            `the search index missed a change to ${job.resource} (${(error as Error).message}). ` +
              'Searches still re-read every row; run mistri --reindex to bring the index back in step.',
          );
        }
      }
    }
  }

  private async apply(job: IndexJob): Promise<void> {
    if (job.dependents) return this.applyDependents(job);
    const { adapter, schema } = await this.registry.open(job.connection);
    const found = searchedAt(job.app, schema, job);
    if (!found) return;
    const index = this.index(found);
    const collection = collectionOf(index, job.app, found);
    await this.ensure(index, collection, docFields(found), job.tenantColumn !== undefined);
    const key = job.key[found.key];
    if (key === undefined || key === null) return;
    const columns = documentColumns(found, job.tenantColumn);
    const result = await adapter.query({
      table: found.table.id,
      columns,
      limit: 1,
      offset: 0,
      filter: { groups: [[{ column: found.key, op: '=', value: key as string | number }]] },
    });
    const row = result.rows[0];
    if (row) await index.upsert(collection, documentOf(row, found, job.tenantColumn, await followPaths(adapter, found, [row])));
    else await index.remove(collection, String(key));
  }

  /**
   * The reverse step of a path: a write to a row a searched path points at
   * (`person` 7, which `ticket.requester.name` copies) re-indexes every
   * searched row whose reference holds its key, each as its own job — found
   * by the reference column, in key order, at most MAX_DEPENDENTS of them.
   */
  private async applyDependents(job: IndexJob): Promise<void> {
    const { adapter, schema } = await this.registry.open(job.connection);
    for (const target of await searchTargets(this.registry, job.app, job.connection)) {
      if ('problem' in target || target.connection !== job.connection) continue;
      const found = searchedAt(job.app, schema, target);
      for (const path of found?.paths ?? []) {
        if (path.table !== job.physical) continue;
        const value = job.key[path.key];
        if (value === undefined || value === null) continue;
        let after: string | number | undefined,
          seen = 0;
        for (;;) {
          const read = await adapter.query({
            table: found!.table.id,
            columns: [found!.key],
            filter: {
              groups: [
                [
                  { column: path.via, op: '=', value: value as string | number },
                  ...(after === undefined ? [] : [{ column: found!.key, op: '>' as const, value: after }]),
                ],
              ],
            },
            orderBy: [{ column: found!.key, direction: 'asc' }],
            limit: REINDEX_PAGE,
            offset: 0,
          });
          const tenantColumn = job.tenantColumns?.[target.resource];
          for (const row of read.rows)
            this.enqueue({
              app: job.app,
              ...target,
              key: { [found!.key]: row[found!.key] },
              attempt: 0,
              ...(tenantColumn === undefined ? {} : { tenantColumn }),
            });
          seen += read.rows.length;
          if (read.rows.length < REINDEX_PAGE) break;
          if (seen >= MAX_DEPENDENTS) {
            this.registry.onWarning(
              `a change to ${job.resource} is copied into more than ${MAX_DEPENDENTS} ${target.resource} search documents; ` +
                'the rest follow at the next mistri --reindex.',
            );
            break;
          }
          after = read.rows[read.rows.length - 1][found!.key] as string | number;
        }
      }
    }
  }
}

const indexers = new WeakMap<Registry, SearchIndexer>();

/** The registry's one indexer: one queue per process, whichever route wrote. */
export function indexerFor(registry: Registry): SearchIndexer {
  let indexer = indexers.get(registry);
  if (!indexer) {
    indexer = new SearchIndexer(registry);
    indexers.set(registry, indexer);
  }
  return indexer;
}
