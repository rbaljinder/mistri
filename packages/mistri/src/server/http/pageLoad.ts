/**
 * A free-form page's two server routes beside the reads every room makes.
 *
 * `POST /api/pages/load { page, params }` runs the loader the page names
 * (commands/pageLoaders.ts) for this reader. The request names a page, never
 * a loader: the page is found in the App as projected for the reader's roles
 * (a page they may not open is not found, the way a view that does not exist
 * is not), its reads must all be in their catalog, a signed-out visitor is
 * served only a page that says `public: true`, and only the parameters the
 * page keeps may be passed. A page that names no loader has none to run.
 *
 * `x-mistri-page: <path>` on a read or a command says the request is a
 * page's: a resource outside the page's `reads`, or a command outside its
 * `commands`, is refused (403, `page_undeclared`). That is drift protection —
 * a page that asks for what it did not declare is told so in its own room —
 * not the security boundary: a client may leave the header off, and what a
 * reader may read and run is their grants', decided below this, per request.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { logicalResource, zonedNow, type AppDef, type AppDashboardView } from '../../shared/app.js';
import { appForRoles } from '../../shared/appViewRoles.js';
import { appZone } from '../../shared/appUi.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import { PageLoaderRefused, runPageLoader } from '../commands/pageLoaderRun.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';

export { PAGE_HEADER, PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
/** The longest parameter value a page's address keeps. */
const PARAM_MOST = 1024;

type Reply = { status: number; body: Record<string, unknown> };
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
  reader: Pick<Adapter, 'query' | 'count'>;
  schema: DatabaseSchema;
  /** The reader's zone, where `ui.timezone` reads one (readerZone.ts). */
  zone?: string;
}): Promise<Reply> {
  const { app, body, schema } = options;
  if (typeof body.page !== 'string' || body.page.length > 64) return { status: 400, body: { error: 'Name the page: { page }.' } };
  const view = pageFor(app, options.roles, body.page);
  if (!view || (!options.signedIn && !view.page.public)) return notFound;
  if (!view.page.reads.every((resource) => tableNamed(schema, resource))) return notFound;
  const name = view.page.loader;
  if (!name) return { status: 400, body: { error: `The page "${body.page}" declares no loader.`, code: 'page_undeclared' } };
  const loader = options.loaders && Object.hasOwn(options.loaders, name) ? options.loaders[name] : undefined;
  if (!loader) return notFound;
  const given = body.params ?? {};
  if (!given || typeof given !== 'object' || Array.isArray(given))
    return { status: 400, body: { error: 'A page\'s params are { name: "value" }.' } };
  const params: Record<string, string> = {};
  for (const [param, value] of Object.entries(given)) {
    if (!view.page.params.includes(param)) {
      return { status: 400, body: { error: `The page "${body.page}" keeps no "${param}" in its address.`, code: 'page_undeclared' } };
    }
    if (typeof value !== 'string' || value.length > PARAM_MOST)
      return { status: 400, body: { error: `"${param}" is not a parameter's text.` } };
    params[param] = value;
  }
  try {
    const data = await runPageLoader({
      name,
      loader,
      reader: options.reader,
      schema,
      ...(loader.source ? { logical: (local: string) => logicalResource(app, loader.source!, local) } : {}),
      params,
      viewer: { ...(options.account === undefined ? {} : { account: options.account }), roles: [...options.roles] },
      now: zonedNow(appZone(app.ui, options.zone), clockNow()),
    });
    return { status: 200, body: { data } };
  } catch (error) {
    if (error instanceof PageLoaderRefused) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}

/* The tables a read request names: a view's base, a breakdown's leading word. */
function tablesAsked(path: string, body: Record<string, unknown>): string[] | undefined {
  const leading = (text: unknown) => (typeof text === 'string' ? (text.trim().split(/\s+/)[0] ?? '') : '');
  if (path === '/api/view/run') {
    const view = body.view as { base?: unknown } | undefined;
    return [typeof view?.base === 'string' ? view.base : leading(body.text)];
  }
  if (path === '/api/breakdown') return [leading(body.text)];
  if (path === '/api/breakdowns' && Array.isArray(body.items)) return body.items.map((item) => leading((item as { text?: unknown })?.text));
  return undefined;
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
  const asked = tablesAsked(path, body);
  if (!asked) return undefined;
  const id = (name: string) => (options.schema && tableNamed(options.schema, name)?.id) ?? name;
  const declared = new Set(view.page.reads.map(id));
  const stray = asked.find((table) => !declared.has(id(table)));
  return stray === undefined ? undefined : refuse(`The page "${key}" reads ${view.page.reads.join(', ')}; "${stray}" is not one of them.`);
}
