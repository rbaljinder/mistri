/**
 * A free-form page's loader: server code that reads for the page, declared
 * beside the App's commands and named by the page (`definePage({ loader })`,
 * or `loaders: [...]` for several, each read with `page.useLoader(name)`).
 *
 *   export const loaders = defineLoaders({
 *     pickWalk: defineLoader({
 *       reads: ['pick_list', 'order_line'],
 *       load: async ({ db }) => ({ lists: await db.pick_list.where({ status: 'to_pick' }).limit(40) }),
 *     }),
 *   });
 *
 * A loader that wants the App's computed columns or rollups beside a row's own
 * (a balance, an alert count) declares each as `'table.name'` among its `reads`
 * and asks for it with `.with(…)`, which the lists' own SQL answers in the one
 * read, so it does not read rows again to work them out:
 *
 *   reads: ['invoice', 'invoice.balance', 'invoice.open_alerts'],
 *   load: async ({ db }) => ({ rows: await db.invoice.where({ status: 'open' }).with('balance', 'open_alerts').limit(20) }),
 *
 * A loader is a reader, never a writer, and never anyone but the person the
 * page is drawn for:
 *
 *   - its `db` is the command `db`'s read-only handle (commandDb.ts) over the
 *     request's own reader — the one `/api/view/run` reads through, with the
 *     reader's grants, field projection and row policy already on it
 *     (http/source.ts; a tenant App's host serves the same route). It has the
 *     tables it declares and no others, and `.segment(name)` reads one of
 *     their segments; a write on one is refused, and there is no
 *     transaction, no adapter and no SQL to reach for;
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

/** A `reads` entry's table: `'invoice.balance'` is the `invoice` table's, a plain name its own. */
type ReadTableOf<Name extends string> = Name extends `${infer T}.${string}` ? T : Name;

/** What a loader's `load` is handed. */
export interface PageLoaderContext<Src = string, R extends string = string> {
  /** The tables it declared, read-only, as this reader may read them. */
  readonly db: CommandTables<SourceTables<Src, string>, R, never>;
  /** The page's address parameters it keeps, as the address says them now. */
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly viewer: PageLoaderViewer;
  /** The instant the page is loaded at, as a command's `now()` is, so a line moves between them unchanged. */
  readonly now: () => Date;
  /** Today's date (`YYYY-MM-DD`) in the reader's zone: the tenant's, then the App's `ui.timezone`, then UTC. */
  readonly today: () => string;
  /** The zone `today()` reads: an IANA name, `UTC` where none is set. */
  readonly timezone: string;
  /**
   * The App's `choose`, by name: the key of the row the person picked (the site they work at), proven for this
   * request; undefined where nothing is chosen. A `where` text can say `chosen.<name>` as well.
   */
  readonly chosen: Readonly<Record<string, string | number | undefined>>;
  /** Aborted when its time is up. */
  readonly signal: AbortSignal;
}

/** A loader as `defineLoader` makes it. */
export interface PageLoader<Result = unknown, Src = string, R extends string = string> {
  /** The tables it reads (a `'table.name'` entry names the table here, and its derived name in `derived`). */
  readonly reads: readonly R[];
  /** The computed columns and rollups it may ask for with `.with`, by table. */
  readonly derived: Readonly<Record<string, readonly string[]>>;
  readonly source?: string;
  /** Milliseconds. */
  readonly timeout: number;
  readonly load: (context: PageLoaderContext<Src, R>) => Result | Promise<Result>;
}

const made = new WeakSet<object>();
const LOADER_KEYS = new Set(['reads', 'source', 'timeout', 'load']);
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A page's loader: the resources it reads (each one the page reads too; none,
 * `reads: []`, for a loader that hands the page only what the server knows), an
 * optional timeout (`'2 seconds'`, at most ten), and `load`, which reads
 * through `db` and returns what the page's component is handed as `data`.
 */
export function defineLoader<
  Result,
  Src = string,
  const R extends readonly ((keyof SourceTables<Src, string> & string) | `${keyof SourceTables<Src, string> & string}.${string}`)[] =
    readonly (keyof SourceTables<Src, string> & string)[],
>(definition: {
  readonly reads: R;
  readonly source?: Src;
  readonly timeout?: `${number} second` | `${number} seconds`;
  readonly load: (context: PageLoaderContext<Src, ReadTableOf<R[number]>>) => Result | Promise<Result>;
}): PageLoader<Awaited<Result>, Src, ReadTableOf<R[number]>> {
  if (!definition || typeof definition !== 'object') throw new TypeError('defineLoader takes { reads, load }.');
  for (const key of Object.keys(definition)) if (!LOADER_KEYS.has(key)) throw new TypeError(`defineLoader has no "${key}".`);
  const reads = definition.reads as unknown;
  /* `reads: []` reads nothing: a page's configuration (a program's name, its limits, words its brand uses) handed from
     the server's own settings. Its `db` holds no table; everything else bounds it as any loader. */
  if (!Array.isArray(reads) || reads.some((name) => typeof name !== 'string' || !name))
    throw new TypeError("A loader's reads are the resources it reads: reads: ['pick_list'], or reads: [] for none.");
  if (typeof definition.load !== 'function') throw new TypeError("A loader's load is the function that reads for the page.");
  const timeout = definition.timeout === undefined ? LOADER_TIMEOUT_DEFAULT : parseDuration(definition.timeout);
  if (timeout === undefined || timeout < 1000 || timeout > LOADER_TIMEOUT_MOST)
    throw new TypeError("A loader's timeout is between '1 second' and '10 seconds'.");
  const source = definition.source === undefined ? undefined : sourceName(definition.source);
  if (definition.source !== undefined && !source) throw new TypeError("A loader's source is a defineSource() handle or its name.");
  /* `'invoice.balance'` asks for the computed column or rollup `balance` of `invoice` through `.with`: the table is
     among the reads too, so what a loader may read is one list a person can see. */
  const tables = new Set<string>();
  const derived: Record<string, string[]> = Object.create(null);
  for (const entry of reads as string[]) if (!entry.includes('.')) tables.add(entry);
  for (const entry of reads as string[]) {
    const dot = entry.lastIndexOf('.');
    if (dot < 0) continue;
    const table = entry.slice(0, dot);
    const name = entry.slice(dot + 1);
    if (!tables.has(table) || !name)
      throw new TypeError(`A loader's reads name "${entry}", a computed column or rollup of "${table}": list "${table}" in reads too.`);
    (derived[table] ??= []).push(name);
  }
  const loader = Object.freeze({
    reads: Object.freeze([...tables]),
    derived: Object.freeze(
      Object.fromEntries(Object.entries(derived).map(([table, names]) => [table, Object.freeze([...new Set(names)])])),
    ),
    ...(source ? { source } : {}),
    timeout,
    load: definition.load,
  });
  made.add(loader);
  return loader as unknown as PageLoader<Awaited<Result>, Src, ReadTableOf<R[number]>>;
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
