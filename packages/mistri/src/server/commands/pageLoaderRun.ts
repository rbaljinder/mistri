/**
 * A page's loader, run: for one reader, over the request's own scoped reader,
 * through read-only handles that are revoked when its time is up, and with
 * its result held to a size (pageLoaders.ts says what a loader is).
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { cteTables, remapCteTables } from '@mistriwork/engine/shared/cte.js';
import { renamedAnyRows } from '@mistriwork/engine/shared/filter.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { ResourceReadError, readView, readViewCount, type ResourceReader } from '@mistriwork/engine/server/resourceReadOperations.js';
import type { ViewDef } from '@mistriwork/engine/shared/view.js';
import { chosenContext, type Chosen } from '../app/appChoices.js';
import { zoneDay, zoned } from './currentZone.js';
import { commandCatalog, createCommandDb, cteOf, zonedCatalog, type ReadTable, type UntypedRow } from './commandDb.js';
import { isBusinessCommandExecutionError } from './commandErrors.js';
import { LOADER_RESULT_MOST, type PageLoader, type PageLoaderViewer } from './pageLoaders.js';

/** The App's own reader and catalog, for a loader's elevated tables alone. */
export interface ElevatedReads {
  readonly reader: Pick<Adapter, 'query'> & Partial<Pick<Adapter, 'count' | 'aggregate' | 'cte'>>;
  readonly schema: DatabaseSchema;
}

/** Why a loader's run was refused, with the status the route answers. */
export class PageLoaderRefused extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'page_undeclared'
      | 'loader_timeout'
      | 'loader_too_large'
      | 'loader_result'
      | 'not_found'
      | 'loader_refused'
      | 'loader_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PageLoaderRefused';
  }
}

const READS_ONLY = "A page's loader reads; it cannot write. Change data through one of the App's commands.";

/* A table handle with no way to write, saying so when one is asked for: a loader that tries is refused in words. */
function readOnly(handle: ReadTable<UntypedRow>): ReadTable<UntypedRow> {
  const refused = () => {
    throw new PageLoaderRefused(403, 'loader_refused', READS_ONLY);
  };
  return Object.freeze({ ...handle, insert: refused, insertFile: refused, moveFile: refused, update: refused, remove: refused });
}

/**
 * Run one loader for one reader. `reader` is the request's own, already
 * scoped to them; `schema` is their catalog, so a table they cannot read is
 * not in it and the loader is refused before it starts.
 */
export async function runPageLoader(options: {
  name: string;
  loader: PageLoader;
  reader: Pick<Adapter, 'query' | 'count' | 'aggregate'> & Partial<Pick<Adapter, 'runView' | 'countView' | 'cte'>>;
  schema: DatabaseSchema;
  /** A declared resource's table in `schema` (logicalResource for a qualified source). */
  logical?: (local: string) => string;
  params: Readonly<Record<string, string | undefined>>;
  viewer: PageLoaderViewer;
  /** The instant the page is loaded at. */
  now: Date;
  /** The reader's zone (the tenant's, then the App's): what `today()` and a date phrase read; UTC where none is named. */
  timezone?: string;
  /** The App's `choose` as this request proved it (app/appChoices.ts); absent where it declares none. */
  chosen?: Chosen;
  /**
   * The App's own reader and catalog for the tables the loader elevates (`defineLoader({ elevate })`): what a
   * command's handler reads its footprint through, and in a tenant App the member's tenant and row scope still. Only
   * the elevated tables are read through it; absent, a loader that elevates is refused before it starts.
   */
  elevated?: ElevatedReads;
}): Promise<unknown> {
  const { loader, reader } = options;
  const logical = options.logical ?? ((local: string) => local);
  const lifted = new Set(loader.elevate?.read ?? []);
  const above = options.elevated;
  if (lifted.size && !above)
    throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}" elevates a read, and no read is elevated here.`);
  /* One catalog for the loader's handles: the reader's own, with each elevated table as the App reads it. A table is
     in one or the other by the loader's declaration alone, never by which catalog happens to hold it. */
  const liftedIds = new Set<string>();
  for (const local of lifted) {
    const id = tableNamed(above!.schema, logical(local))?.id;
    if (id === undefined)
      throw new PageLoaderRefused(403, 'page_undeclared', `The loader "${options.name}" reads what this reader cannot.`);
    liftedIds.add(id);
  }
  const schema: DatabaseSchema = lifted.size
    ? {
        ...options.schema,
        tables: [
          ...options.schema.tables.filter((table) => !liftedIds.has(table.id)),
          ...above!.schema.tables.filter((table) => liftedIds.has(table.id)),
        ],
        foreignKeys: [
          ...options.schema.foreignKeys.filter((fk) => !liftedIds.has(fk.from.table) && !liftedIds.has(fk.to.table)),
          ...above!.schema.foreignKeys.filter((fk) => liftedIds.has(fk.from.table) || liftedIds.has(fk.to.table)),
        ],
      }
    : options.schema;
  const idOf = (local: string) => tableNamed(schema, logical(local))?.id;
  /* Whose authority a read of `local` is under: the App's for a table the loader elevates, the reader's for every other. */
  const through = (local: string) => (lifted.has(local) ? above!.reader : reader);
  const found = loader.reads.every((name) => idOf(name) !== undefined)
    ? commandCatalog(schema, loader.reads, (name) => idOf(name)!)
    : undefined;
  /* `now` stays an instant, as a command's is; the catalog's zone is what reads a date phrase on the wall clock. */
  const catalog = found && zonedCatalog(found, options.timezone);
  if (!catalog) throw new PageLoaderRefused(403, 'page_undeclared', `The loader "${options.name}" reads what this reader cannot.`);
  let open = true;
  const controller = new AbortController();
  const revoked = () => new PageLoaderRefused(504, 'loader_timeout', `The loader "${options.name}" ran out of time.`);
  /* An `any`/`no` child is named locally as the table is, and is one of the loader's declared reads (commandDb.ts). */
  const child = (local: string): string => {
    const id = idOf(local);
    if (id === undefined)
      throw new PageLoaderRefused(403, 'page_undeclared', `The loader "${options.name}" reads what this reader cannot.`);
    return id;
  };
  /* One statement is read under one authority: a condition on another table's rows (`any`, `no`, `in`), at any depth,
     never carries the reader into an elevated table, nor the App's authority into a table the reader's grants and row
     scope narrow. Judged on the loader's own names, before anything is asked. */
  const oneAuthority = (base: string, filter: Parameters<Adapter['count']>[1]): void => {
    if (!lifted.size) return;
    for (const condition of filter?.groups.flat() ?? []) {
      const via = condition.any?.via;
      const other = condition.within?.table ?? (via === undefined ? undefined : via.slice(0, via.lastIndexOf('.')));
      if (other === undefined) continue;
      if (lifted.has(other) !== lifted.has(base))
        throw new PageLoaderRefused(
          403,
          'loader_refused',
          `The loader "${options.name}" asks "${base}" about its "${other}" rows, and only one of the two is elevated: read each on its own.`,
        );
      oneAuthority(base, condition.any?.filter);
    }
  };
  const named = (base: string, filter: Parameters<Adapter['count']>[1]) => {
    oneAuthority(base, filter);
    return filter ? { filter: renamedAnyRows(filter, child) } : {};
  };
  /* Only these, and only while it runs: no transaction, no writer, no other table. */
  const tx = Object.freeze({
    query: async (request: Parameters<Adapter['query']>[0]) => {
      if (!open) throw revoked();
      const result = await through(request.table).query({
        ...request,
        table: idOf(request.table)!,
        ...named(request.table, request.filter),
      });
      if (!open) throw revoked();
      return result;
    },
    count: async (table: string, filter?: Parameters<Adapter['count']>[1]) => {
      if (!open) throw revoked();
      const source = through(table);
      if (!source.count) throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}" cannot count "${table}" here.`);
      const result = await source.count(idOf(table)!, named(table, filter).filter);
      if (!open) throw revoked();
      return result;
    },
    /* A sum or a group, through the reader as `count` is (its rows and its granted columns), while the loader runs. */
    ...(reader.aggregate
      ? {
          aggregate: async (request: Parameters<NonNullable<Adapter['aggregate']>>[0]) => {
            if (!open) throw revoked();
            const source = through(request.table);
            if (!source.aggregate)
              throw new PageLoaderRefused(
                403,
                'loader_refused',
                `The loader "${options.name}" cannot sum or group "${request.table}" here.`,
              );
            oneAuthority(request.table, request.filter);
            const result = await source.aggregate({ ...request, table: idOf(request.table)! });
            if (!open) throw revoked();
            return result;
          },
        }
      : {}),
    ...(reader.cte
      ? {
          cte: async (request: Parameters<NonNullable<Adapter['cte']>>[0]) => {
            if (!open) throw revoked();
            const tables = cteTables(request);
            if (!tables.length) throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}" ran an empty CTE.`);
            const firstLifted = lifted.has(tables[0]!);
            for (const tbl of tables) {
              if (idOf(tbl) === undefined)
                throw new PageLoaderRefused(403, 'page_undeclared', `The loader "${options.name}" reads what this reader cannot.`);
              if (lifted.has(tbl) !== firstLifted)
                throw new PageLoaderRefused(
                  403,
                  'loader_refused',
                  `The loader "${options.name}" joins "${tables[0]}" with "${tbl}" across elevated and non-elevated authority; read each on its own.`,
                );
            }
            const source = firstLifted ? above!.reader : reader;
            if (!source.cte) throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}" cannot run SQL CTEs here.`);
            const result = await source.cte(remapCteTables(request, (name) => idOf(name)!));
            if (!open) throw revoked();
            return result;
          },
        }
      : {}),
  });
  /* `.with(…)` and rollup wheres: the rows (or count) of one non-elevated table with the computed columns and rollups
     the reader is served, as a list of that table reads them — one view through the reader the list reads through
     (resourceReadOperations.ts readView / readViewCount), so the SQL, the grants and field projection, and the row
     policy are the list's own, in one statement. */
  const viewFilterOf = (filter: Parameters<NonNullable<Parameters<typeof createCommandDb>[0]['readDerived']>>[0]['filter']) =>
    filter.groups.length
      ? { filter: { groups: filter.groups.map((group) => group.map(({ column, ...rest }) => ({ ...rest, path: column }))) } }
      : {};
  const readDerived: NonNullable<Parameters<typeof createCommandDb>[0]['readDerived']> = async (request) => {
    if (!open) throw revoked();
    if (lifted.has(request.table))
      throw new PageLoaderRefused(
        403,
        'loader_refused',
        `The loader "${options.name}" elevates "${request.table}", which reads its own stored columns only.`,
      );
    const base = idOf(request.table)!;
    const meta = tableNamed(options.schema, logical(request.table))!;
    const served = (each: string) => Object.hasOwn(meta.rollups ?? {}, each) || Object.hasOwn(meta.computed ?? {}, each);
    const stray = request.names.find((each) => !served(each) || meta.columns.some((column) => column.name === each));
    if (stray !== undefined) {
      throw new PageLoaderRefused(
        403,
        'loader_refused',
        `The loader "${options.name}" asks for "${stray}" of ${request.table}, which is not a computed column or rollup this reader is served.`,
      );
    }
    const view: ViewDef = {
      id: `loader:${options.name}`,
      name: options.name,
      base,
      columns: [...meta.columns.map((column) => column.name), ...request.names].map((path) => ({ path })),
      ...viewFilterOf(request.filter),
      ...(request.orderBy.length ? { orderBy: request.orderBy.map((order) => ({ path: order.column, direction: order.direction })) } : {}),
      limit: request.limit,
    };
    try {
      const read = await readView(reader as unknown as ResourceReader, options.schema, view, { limit: request.limit }, 'none');
      if (!open) throw revoked();
      return { rows: read.result.rows as never };
    } catch (error) {
      if (error instanceof ResourceReadError && error.status !== 501)
        throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}": ${error.message}`);
      throw error;
    }
  };
  const countDerived: NonNullable<Parameters<typeof createCommandDb>[0]['countDerived']> = async (request) => {
    if (!open) throw revoked();
    if (lifted.has(request.table))
      throw new PageLoaderRefused(
        403,
        'loader_refused',
        `The loader "${options.name}" elevates "${request.table}", which counts its own stored columns only.`,
      );
    const base = idOf(request.table)!;
    const meta = tableNamed(options.schema, logical(request.table))!;
    const view: ViewDef = {
      id: `loader:${options.name}`,
      name: options.name,
      base,
      columns: [{ path: meta.columns[0]!.name }],
      ...viewFilterOf(request.filter),
    };
    try {
      const counted = await readViewCount(reader as unknown as ResourceReader, options.schema, view, undefined, { exact: true });
      if (!open) throw revoked();
      return counted.count;
    } catch (error) {
      if (error instanceof ResourceReadError && error.status !== 501)
        throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}": ${error.message}`);
      throw error;
    }
  };
  const hasDerived = Boolean(loader.derived && Object.keys(loader.derived).length);
  const handles = createCommandDb({
    tx,
    catalog,
    read: loader.reads,
    write: [],
    now: () => options.now,
    ...(lifted.size ? { elevated: lifted } : {}),
    ...(hasDerived ? { derived: loader.derived } : {}),
    ...(hasDerived || typeof reader.runView === 'function' ? { readDerived } : {}),
    ...(typeof reader.countView === 'function' ? { countDerived } : {}),
    ...(options.chosen ? { chosen: options.chosen } : {}),
  });
  const db = Object.freeze(Object.fromEntries(Object.entries(handles).map(([name, handle]) => [name, readOnly(handle)])));
  let timer: NodeJS.Timeout | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      open = false;
      controller.abort();
      reject(revoked());
    }, loader.timeout);
  });
  let result: unknown;
  try {
    result = await Promise.race([
      Promise.resolve().then(
        zoned(options.timezone, () =>
          loader.load(
            Object.freeze({
              db: db as never,
              cte: cteOf(handles),
              params: Object.freeze({ ...options.params }),
              viewer: options.viewer,
              now: () => options.now,
              today: () => zoneDay(options.now, options.timezone),
              timezone: options.timezone ?? 'UTC',
              chosen: chosenContext(options.chosen),
              signal: controller.signal,
            }),
          ),
        ),
      ),
      timeUp,
    ]);
  } catch (error) {
    if (error instanceof PageLoaderRefused) throw error;
    if (isBusinessCommandExecutionError(error)) {
      throw error.code === 'not_found'
        ? new PageLoaderRefused(404, 'not_found', error.message)
        : new PageLoaderRefused(422, 'loader_refused', error.message);
    }
    throw error;
  } finally {
    open = false;
    clearTimeout(timer);
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(result === undefined ? null : result);
  } catch {
    throw new PageLoaderRefused(500, 'loader_result', `The loader "${options.name}" returned what JSON cannot say.`);
  }
  if (Buffer.byteLength(text) > LOADER_RESULT_MOST) {
    throw new PageLoaderRefused(
      500,
      'loader_too_large',
      `The loader "${options.name}" returned more than ${LOADER_RESULT_MOST / 1024} KiB; a page's data is read in pages, not whole.`,
    );
  }
  return JSON.parse(text);
}
