/**
 * A page's loader, run: for one reader, over the request's own scoped reader,
 * through read-only handles that are revoked when its time is up, and with
 * its result held to a size (pageLoaders.ts says what a loader is).
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { commandCatalog, createCommandDb, type ReadTable, type UntypedRow } from './commandDb.js';
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
  return Object.freeze({ ...handle, insert: refused, insertFile: refused, update: refused, remove: refused });
}

/**
 * Run one loader for one reader. `reader` is the request's own, already
 * scoped to them; `schema` is their catalog, so a table they cannot read is
 * not in it and the loader is refused before it starts.
 */
export async function runPageLoader(options: {
  name: string;
  loader: PageLoader;
  reader: Pick<Adapter, 'query' | 'count'>;
  schema: DatabaseSchema;
  /** A declared resource's table in `schema` (logicalResource for a qualified source). */
  logical?: (local: string) => string;
  params: Readonly<Record<string, string | undefined>>;
  viewer: PageLoaderViewer;
  now: Date;
}): Promise<unknown> {
  const { loader, reader, schema } = options;
  const logical = options.logical ?? ((local: string) => local);
  const idOf = (local: string) => tableNamed(schema, logical(local))?.id;
  const catalog = loader.reads.every((name) => idOf(name) !== undefined)
    ? commandCatalog(schema, loader.reads, (name) => idOf(name)!)
    : undefined;
  if (!catalog) throw new PageLoaderRefused(403, 'page_undeclared', `The loader "${options.name}" reads what this reader cannot.`);
  let open = true;
  const controller = new AbortController();
  const revoked = () => new PageLoaderRefused(504, 'loader_timeout', `The loader "${options.name}" ran out of time.`);
  /* Only these two, and only while it runs: no transaction, no writer, no other table. */
  const tx = Object.freeze({
    query: async (request: Parameters<Adapter['query']>[0]) => {
      if (!open) throw revoked();
      const result = await reader.query({ ...request, table: idOf(request.table)! });
      if (!open) throw revoked();
      return result;
    },
    count: async (table: string, filter?: Parameters<Adapter['count']>[1]) => {
      if (!open) throw revoked();
      const result = await reader.count(idOf(table)!, filter);
      if (!open) throw revoked();
      return result;
    },
  });
  const handles = createCommandDb({ tx, catalog, read: loader.reads, write: [], now: () => options.now });
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
            now: options.now,
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
