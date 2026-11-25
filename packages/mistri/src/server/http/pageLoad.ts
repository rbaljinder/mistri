/**
 * A free-form page's two server routes beside the reads every room makes.
 *
 * `POST /api/pages/load { page, params, loader? }` runs a loader the page names
 * (commands/pageLoaders.ts) for this reader. The page is found in the App as
 * projected for the reader's roles (a page they may not open is not found, the
 * way a view that does not exist is not), its reads must all be in their
 * catalog, a signed-out visitor is served only a page that says `public: true`,
 * and only the parameters the page keeps may be passed. The loader is the
 * page's `loader` unless the request names one of its `loaders`; the name is
 * looked up in the page's own list, as projected for this reader, and never
 * trusted alone: a name the page does not list is not found, as a page is not.
 * A page that names no loader has none to run.
 *
 * `x-mistri-page: <path>` on a read or a command says the request is a
 * page's: a resource outside the page's `reads`, or a command outside its
 * `commands`, is refused (403, `page_undeclared`). That is drift protection —
 * a page that asks for what it did not declare is told so in its own room —
 * not the security boundary: a client may leave the header off, and what a
 * reader may read and run is their grants', decided below this, per request.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { logicalResource, type AppDef, type AppDashboardView } from '../../shared/app.js';
import type { AppSurface } from '../../shared/appModel.js';
import { appForRoles } from '../../shared/appViewRoles.js';
import { appZone } from '../../shared/appUi.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import { strayRead } from './tablesReached.js';
import { READS_HEADER, readTables } from '../live/liveReads.js';
import { PageLoaderRefused, runPageLoader } from '../commands/pageLoaderRun.js';
import { readChosen, type StoredPicks } from '../app/appChoices.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';

export { PAGE_HEADER, PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
/** The longest parameter value a page's address keeps. */
const PARAM_MOST = 1024;

type Reply = { status: number; body: Record<string, unknown> };
/** A loader's answer, and the tables it answers from where they can be told: its route says them as `mistri-reads`. */
type LoadReply = Reply & { reads?: readonly string[] };

/**
 * The tables a loader answers from: every table it declares, and what a read of each can reach without naming it
 * (live/liveReads.ts: its references, its rollups' children, its computed columns' paths), so the page that ran a
 * command asks the loader again only when the command wrote one of them. Undefined, and so asked again after every
 * command, for a loader that declares none (it hands the page what the server knows) or one that cannot be told.
 */
function loaderReads(schema: DatabaseSchema, loader: PageLoader, logical: (local: string) => string): readonly string[] | undefined {
  if (!loader.reads.length) return undefined;
  const reads = new Set<string>();
  for (const name of loader.reads) {
    const id = tableNamed(schema, logical(name))?.id;
    const found = id === undefined ? undefined : readTables(schema, id, null);
    if (!found) return undefined;
    for (const table of found) reads.add(table);
  }
  return [...reads].sort();
}

/** A load's reply said on `reply`: its tables as the header a read's own would be, or none where they are not told. */
export function tellLoaderReads(
  reply: { readonly headersSent: boolean; setHeader(name: string, value: string): unknown; removeHeader(name: string): unknown },
  loaded: { reads?: readonly string[] },
): void {
  if (reply.headersSent) return;
  /* Set or taken off, never left: the reader a loader reads through tells the tables of the reads it happened to make
     (liveReads.ts trackingReads), which are not all of them. */
  if (loaded.reads) reply.setHeader(READS_HEADER, loaded.reads.map(encodeURIComponent).join(','));
  else reply.removeHeader(READS_HEADER);
}
const notFound: Reply = { status: 404, body: { error: 'No such page.', code: 'not_found' } };

/** The free-form page a reader holding `roles` may open under `key`, or undefined. */
function pageFor(
  app: AppDef,
  roles: readonly string[],
  key: string,
): (AppDashboardView & { page: NonNullable<AppDashboardView['page']> }) | undefined {
  const view = Object.hasOwn(app.views, key) ? appForRoles(app, roles).views[key] : undefined;
  return view && 'sections' in view && view.page ? (view as AppDashboardView & { page: NonNullable<AppDashboardView['page']> }) : undefined;
}

/** Run the loader of the page a request names, for this reader, over their own reader and catalog. */
export async function pageLoad(options: {
  app: AppDef;
  roles: readonly string[];
  /** Whether the reader is signed in, or the App signs nobody in (everyone is its operator). */
  signedIn: boolean;
  /** The signed-in account, where there is one. */
  account?: string;
  loaders: Readonly<Record<string, PageLoader>> | undefined;
  body: Record<string, unknown>;
  reader: Pick<Adapter, 'query' | 'count' | 'aggregate'>;
  schema: DatabaseSchema;
  /** The catalog the loader's tables are told from, where `schema` is a copy made for this request: the kept one,
      whose answers are kept with it (a tenant's, tenantHttp.ts). */
  toldFrom?: DatabaseSchema;
  /** The reader's zone, where `ui.timezone` reads one (readerZone.ts). */
  zone?: string;
  /* The surface a headless request names (surfaceGate.ts): its loader is run in place of a page's, and it keeps no
     parameters, so a front end passes none. */
  surface?: AppSurface;
  /** The request's `x-mistri-chosen` (app/appChoices.ts): read again under `reader` before the loader sees it. */
  chosenHeader?: string | string[];
  /** What the person has stored for a name the header leaves out (app/appPreferences.ts). */
  chosenStored?: StoredPicks;
}): Promise<LoadReply> {
  const { app, body, schema, surface } = options;
  if (!surface && (typeof body.page !== 'string' || body.page.length > 64))
    return { status: 400, body: { error: 'Name the page: { page }.' } };
  const view = surface
    ? { page: { reads: surface.reads, loader: surface.loader, loaders: undefined, params: [] as string[], public: false } }
    : pageFor(app, options.roles, body.page as string);
  const named = surface ? `The surface "${surface.key}"` : `The page "${String(body.page)}"`;
  if (!view || (!options.signedIn && !view.page.public)) return notFound;
  if (!view.page.reads.every((resource) => tableNamed(schema, resource))) return notFound;
  const allowed = [view.page.loader, ...(view.page.loaders ?? [])].filter((each): each is string => each !== undefined);
  if (!allowed.length) return { status: 400, body: { error: `${named} declares no loader.`, code: 'page_undeclared' } };
  if (body.loader !== undefined && (typeof body.loader !== 'string' || body.loader.length > 64))
    return { status: 400, body: { error: 'Name the loader: { loader }.' } };
  const name = (body.loader as string | undefined) ?? view.page.loader;
  if (name === undefined)
    return { status: 400, body: { error: `${named} names several loaders; say which one: { loader }.`, code: 'page_undeclared' } };
  if (!allowed.includes(name)) return notFound;
  const loader = options.loaders && Object.hasOwn(options.loaders, name) ? options.loaders[name] : undefined;
  if (!loader) return notFound;
  const given = body.params ?? {};
  if (!given || typeof given !== 'object' || Array.isArray(given))
    return { status: 400, body: { error: 'A page\'s params are { name: "value" }.' } };
  const params: Record<string, string> = {};
  for (const [param, value] of Object.entries(given)) {
    if (!view.page.params.includes(param)) {
      return { status: 400, body: { error: `${named} keeps no "${param}" in its address.`, code: 'page_undeclared' } };
    }
    if (typeof value !== 'string' || value.length > PARAM_MOST)
      return { status: 400, body: { error: `"${param}" is not a parameter's text.` } };
    params[param] = value;
  }
  /* A loader that says the parameters it reads is handed those alone: the page keys it by them (client hooks.ts
     pageLoadPlace), so one it read without saying would be a value the page never asked it again for. */
  if (loader.params) for (const param of Object.keys(params)) if (!loader.params.includes(param)) delete params[param];
  try {
    const data = await runPageLoader({
      name,
      loader,
      reader: options.reader,
      schema,
      ...(loader.source ? { logical: (local: string) => logicalResource(app, loader.source!, local) } : {}),
      params,
      viewer: { ...(options.account === undefined ? {} : { account: options.account }), roles: [...options.roles] },
      now: clockNow(),
      timezone: appZone(app.ui, options.zone),
      chosen: await readChosen(app, schema, options.reader, options.chosenHeader, options.chosenStored),
    });
    const logical = loader.source ? (local: string) => logicalResource(app, loader.source!, local) : (local: string) => local;
    let reads: readonly string[] | undefined;
    try {
      reads = loaderReads(options.toldFrom ?? schema, loader, logical);
    } catch {
      reads = undefined;
    }
    return { status: 200, body: { data }, ...(reads ? { reads } : {}) };
  } catch (error) {
    if (error instanceof PageLoaderRefused) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}

/**
 * The refusal for a request a page sent outside its manifest, or undefined.
 * Only reads a page makes and the commands it runs are judged; a header
 * naming no page this reader may open is refused as undeclared too.
 */
export function pageManifestRefusal(options: {
  app: AppDef;
  roles: readonly string[];
  header: string | string[] | undefined;
  path: string;
  body: Record<string, unknown>;
  /** The reader's catalog, where a read is judged; a command needs none. */
  schema?: DatabaseSchema;
}): Reply | undefined {
  const { header, path, body } = options;
  if (header === undefined) return undefined;
  const refuse = (what: string): Reply => ({ status: 403, body: { error: what, code: 'page_undeclared' } });
  const key = Array.isArray(header) ? undefined : header;
  const view = key ? pageFor(options.app, options.roles, key) : undefined;
  if (!view) return refuse('This request names no page you may open.');
  if (path.startsWith('/api/commands/')) {
    const names =
      path === '/api/commands/availability' && Array.isArray(body.checks)
        ? body.checks.map((check) => (check as { command?: unknown })?.command)
        : [body.command];
    const stray = names.find((name) => typeof name !== 'string' || !view.page.commands.includes(name));
    return stray === undefined
      ? undefined
      : refuse(`The page "${key}" runs ${view.page.commands.join(', ') || 'no commands'}; "${String(stray)}" is not one of them.`);
  }
  const stray = strayRead(options.schema, view.page.reads, path, body);
  return stray === undefined ? undefined : refuse(`The page "${key}" reads ${view.page.reads.join(', ')}; "${stray}" is not one of them.`);
}
