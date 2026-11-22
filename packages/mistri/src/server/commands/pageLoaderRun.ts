/**
 * A page's loader, run: for one reader, over the request's own scoped reader,
 * through read-only handles that are revoked when its time is up, and with
 * its result held to a size (pageLoaders.ts says what a loader is).
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { renamedAnyRows } from '@mistriwork/engine/shared/filter.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { ResourceReadError, readView, type ResourceReader } from '@mistriwork/engine/server/resourceReadOperations.js';
import type { ViewDef } from '@mistriwork/engine/shared/view.js';
import { chosenContext, type Chosen } from '../app/appChoices.js';
import { zoneDay } from '../app/appStamps.js';
import { commandCatalog, createCommandDb, zonedCatalog, type ReadTable, type UntypedRow } from './commandDb.js';
import { isBusinessCommandExecutionError } from './commandErrors.js';
import { LOADER_RESULT_MOST, type PageLoader, type PageLoaderViewer } from './pageLoaders.js';

/** Why a loader's run was refused, with the status the route answers. */
export class PageLoaderRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: 'page_undeclared' | 'loader_timeout' | 'loader_too_large' | 'loader_result' | 'not_found' | 'loader_refused',
    message: string,
  ) {
    super(message);
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
  reader: Pick<Adapter, 'query' | 'count' | 'aggregate'> & Partial<Pick<Adapter, 'runView'>>;
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
}): Promise<unknown> {
  const { loader, reader, schema } = options;
  const logical = options.logical ?? ((local: string) => local);
  const idOf = (local: string) => tableNamed(schema, logical(local))?.id;
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
  const named = (filter: Parameters<Adapter['count']>[1]) => (filter ? { filter: renamedAnyRows(filter, child) } : {});
  /* Only these, and only while it runs: no transaction, no writer, no other table. */
  const tx = Object.freeze({
    query: async (request: Parameters<Adapter['query']>[0]) => {
      if (!open) throw revoked();
      const result = await reader.query({ ...request, table: idOf(request.table)!, ...named(request.filter) });
      if (!open) throw revoked();
      return result;
    },
    count: async (table: string, filter?: Parameters<Adapter['count']>[1]) => {
      if (!open) throw revoked();
      const result = await reader.count(idOf(table)!, renamedAnyRows(filter, child));
      if (!open) throw revoked();
      return result;
    },
    /* A sum or a group, through the reader as `count` is (its rows and its granted columns), while the loader runs. */
    ...(reader.aggregate
      ? {
          aggregate: async (request: Parameters<NonNullable<Adapter['aggregate']>>[0]) => {
            if (!open) throw revoked();
            const result = await reader.aggregate!({ ...request, table: idOf(request.table)! });
            if (!open) throw revoked();
            return result;
          },
        }
      : {}),
  });
  /* `.with(…)`: the rows of one table with the computed columns and rollups asked for, as a list of that table reads
     them — one view through the reader the list reads through (resourceReadOperations.ts readView), so the SQL, the
     grants and field projection, and the row policy are the list's own, in one statement. A name this reader's catalog
     does not serve (an input its field grant hides) is refused as a list refuses it. */
  const readDerived: NonNullable<Parameters<typeof createCommandDb>[0]['readDerived']> = async (request) => {
    if (!open) throw revoked();
    const base = idOf(request.table)!;
    const meta = tableNamed(schema, logical(request.table))!;
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
      ...(request.filter.groups.length
        ? { filter: { groups: request.filter.groups.map((group) => group.map(({ column, ...rest }) => ({ ...rest, path: column }))) } }
        : {}),
      ...(request.orderBy.length ? { orderBy: request.orderBy.map((order) => ({ path: order.column, direction: order.direction })) } : {}),
      limit: request.limit,
    };
    try {
      const read = await readView(reader as unknown as ResourceReader, schema, view, { limit: request.limit }, 'none');
      if (!open) throw revoked();
      return { rows: read.result.rows as never };
    } catch (error) {
      if (error instanceof ResourceReadError && error.status !== 501)
        throw new PageLoaderRefused(403, 'loader_refused', `The loader "${options.name}": ${error.message}`);
      throw error;
    }
  };
  const handles = createCommandDb({
    tx,
    catalog,
    read: loader.reads,
    write: [],
    now: () => options.now,
    ...(loader.derived && Object.keys(loader.derived).length ? { derived: loader.derived, readDerived } : {}),
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
      Promise.resolve().then(() =>
        loader.load(
          Object.freeze({
            db: db as never,
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
