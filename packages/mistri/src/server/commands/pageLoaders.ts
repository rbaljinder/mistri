/**
 * A free-form page's loader: server code that reads for the page, declared
 * beside the App's commands and named by the page (`definePage({ loader })`).
 *
 *   export const loaders = defineLoaders({
 *     pickWalk: defineLoader({
 *       reads: ['pick_list', 'order_line'],
 *       load: async ({ db }) => ({ lists: await db.pick_list.where({ status: 'to_pick' }).limit(40) }),
 *     }),
 *   });
 *
 * A loader is a reader, never a writer, and never anyone but the person the
 * page is drawn for:
 *
 *   - its `db` is the command `db`'s read-only handle (commandDb.ts) over the
 *     request's own reader — the one `/api/view/run` reads through, with the
 *     reader's grants, field projection and row policy already on it
 *     (http/source.ts; a tenant App's host, tenant/tenantHttp.ts, does not
 *     serve the route yet, and refuses it). It has the tables it declares
 *     and no others; a write on one is refused, and there is no transaction,
 *     no adapter and no SQL to reach for;
 *   - it runs only for a page that names it, whose reads include every one
 *     of its own, for a reader the page is served to: the page is found in
 *     the App as projected for this reader, never named by the request;
 *   - it ends: after its timeout its handles are revoked, so a read it
 *     started late answers nothing, and what it returns is cut off at
 *     `LOADER_RESULT_MOST` bytes of JSON rather than sent whole.
 *
 * Its code is deployment code, trusted like a command's handler: the bounds
 * above are what it may reach, not a sandbox for what it may compute. This
 * module is what an App authors with (@mistriwork/mistri/commands); the run is
 * pageLoaderRun.ts, kept apart so an App's typecheck does not read the
 * server's adapter types.
 */
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import { sourceName, type CommandTables, type SourceTables } from './commandDb.js';

/** The longest a loader may run, and how long one that says nothing does. */
const LOADER_TIMEOUT_MOST = 10_000;
const LOADER_TIMEOUT_DEFAULT = 5_000;
/** The most JSON a loader's result may be, in bytes: a page's data, not an export. */
export const LOADER_RESULT_MOST = 256 * 1024;

/** Who the page is drawn for, as a loader may know it. */
export interface PageLoaderViewer {
  /** The signed-in account, or undefined for a signed-out visitor of a public page. */
  readonly account?: string;
  readonly roles: readonly string[];
}

/** What a loader's `load` is handed. */
export interface PageLoaderContext<Src = string, R extends string = string> {
  /** The tables it declared, read-only, as this reader may read them. */
  readonly db: CommandTables<SourceTables<Src, string>, R, never>;
  /** The page's address parameters it keeps, as the address says them now. */
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly viewer: PageLoaderViewer;
  /** The App's now, in its timezone. */
  readonly now: Date;
  /** Aborted when its time is up. */
  readonly signal: AbortSignal;
}

/** A loader as `defineLoader` makes it. */
export interface PageLoader<Result = unknown, Src = string, R extends string = string> {
  readonly reads: readonly R[];
  readonly source?: string;
  /** Milliseconds. */
  readonly timeout: number;
  readonly load: (context: PageLoaderContext<Src, R>) => Result | Promise<Result>;
}

const made = new WeakSet<object>();
const LOADER_KEYS = new Set(['reads', 'source', 'timeout', 'load']);
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A page's loader: the resources it reads (each one the page reads too), an
 * optional timeout (`'2 seconds'`, at most ten), and `load`, which reads
 * through `db` and returns what the page's component is handed as `data`.
 */
export function defineLoader<
  Result,
  Src = string,
  const R extends readonly (keyof SourceTables<Src, string> & string)[] = readonly (keyof SourceTables<Src, string> & string)[],
>(definition: {
  readonly reads: R;
  readonly source?: Src;
  readonly timeout?: `${number} second` | `${number} seconds`;
  readonly load: (context: PageLoaderContext<Src, R[number]>) => Result | Promise<Result>;
}): PageLoader<Awaited<Result>, Src, R[number]> {
  if (!definition || typeof definition !== 'object') throw new TypeError('defineLoader takes { reads, load }.');
  for (const key of Object.keys(definition)) if (!LOADER_KEYS.has(key)) throw new TypeError(`defineLoader has no "${key}".`);
  const reads = definition.reads as unknown;
  if (!Array.isArray(reads) || !reads.length || reads.some((name) => typeof name !== 'string' || !name))
    throw new TypeError("A loader's reads are the resources it reads: reads: ['pick_list'].");
  if (typeof definition.load !== 'function') throw new TypeError("A loader's load is the function that reads for the page.");
  const timeout = definition.timeout === undefined ? LOADER_TIMEOUT_DEFAULT : parseDuration(definition.timeout);
  if (timeout === undefined || timeout < 1000 || timeout > LOADER_TIMEOUT_MOST)
    throw new TypeError("A loader's timeout is between '1 second' and '10 seconds'.");
  const source = definition.source === undefined ? undefined : sourceName(definition.source);
  if (definition.source !== undefined && !source) throw new TypeError("A loader's source is a defineSource() handle or its name.");
  const loader = Object.freeze({
    reads: Object.freeze([...new Set(reads as string[])]),
    ...(source ? { source } : {}),
    timeout,
    load: definition.load,
  });
  made.add(loader);
  return loader as unknown as PageLoader<Awaited<Result>, Src, R[number]>;
}

/** The App's loaders by name: `export const loaders = defineLoaders({ pickWalk })` in its commands module. */
export function defineLoaders<const L extends Record<string, Pick<PageLoader, 'reads' | 'timeout'>>>(loaders: L): Readonly<L> {
  if (!loaders || typeof loaders !== 'object' || Array.isArray(loaders))
    throw new TypeError('defineLoaders takes { name: defineLoader(…) }.');
  const out: Record<string, PageLoader> = Object.create(null);
  for (const [name, loader] of Object.entries(loaders)) {
    if (!NAME.test(name)) throw new TypeError(`The loader "${name}": a loader's name is a word of letters, digits and underscores.`);
    if (!loader || typeof loader !== 'object' || !made.has(loader))
      throw new TypeError(`The loader "${name}" must be made with defineLoader.`);
    out[name] = loader as unknown as PageLoader;
  }
  return Object.freeze(out) as unknown as Readonly<L>;
}

/** The registry a commands module exports as `loaders`, checked; undefined when it exports none. */
export function pageLoadersOf(module: Record<string, unknown>, file: string): Readonly<Record<string, PageLoader>> | undefined {
  const loaders = module.loaders;
  if (loaders === undefined) return undefined;
  if (!loaders || typeof loaders !== 'object' || !Object.values(loaders).every((loader) => made.has(loader as object))) {
    throw new TypeError(
      `The commands module "${file}" exports "loaders" that defineLoaders did not make: export const loaders = defineLoaders({ … }).`,
    );
  }
  return loaders as Readonly<Record<string, PageLoader>>;
}
