/**
 * Headless mode's door: a front end the App draws itself — a Next.js page on the same domain, using
 * `@mistriwork/mistri/react` — names the surface it is in `X-Mistri-Surface` on every request
 * (shared/appSurfaces.ts), and is held to it here.
 *
 * How a headless request is recognized: by that header. An App that says `ui.headless: true` serves its API to
 * nothing else, so a request under `/api/` that reaches its routes without the header is refused; in any App, a header
 * naming no surface the reader may use (none by that key, one offered to other roles, an empty or repeated header) is
 * refused. A request that names a surface may only take the routes a headless host calls (client/embed/host.ts): its
 * reads, its loader, its commands and its files. Each refusal is 403 `{ code: 'surface' }`.
 *
 * This narrows, never widens: the reader's grants, row policy and field ceilings still decide what a read returns
 * and whether a command runs, as they do for every request. The doors before the routes — signing in, the account's
 * own pages, the embed boot, a public form — are not an App's data and are not judged here.
 */
import type { IncomingMessage } from 'node:http';
import type { AppDef, AppSurface } from '../../shared/appModel.js';
import { appCommandGrants, logicalResource } from '../../shared/app.js';
import type { EmbedSurfaceCommand } from '../../shared/embedProtocol.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { commandActionLabel } from '../recordHistory.js';
import { SURFACE_HEADER, surfaceFor } from '../../shared/appSurfaces.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { SOURCE_CLIENT } from '@mistriwork/engine/server/devclient.js';
import { PAGE_LOAD_PATH, tablesAsked } from './pageLoad.js';

type Reply = { status: 403; body: { error: string; code: 'surface' } };

/** The routes a surface's requests take, by method: what a headless host calls and nothing else. */
const SURFACE_POSTS: ReadonlySet<string> = new Set([
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
  PAGE_LOAD_PATH,
  COMMAND_ROUTES.prepare,
  COMMAND_ROUTES.execute,
  COMMAND_ROUTES.status,
  COMMAND_ROUTES.availability,
  COMMAND_ROUTES.check,
]);
const SURFACE_GETS: ReadonlySet<string> = new Set(['/api/file']);

const refuse = (error: string): Reply => ({ status: 403, body: { error, code: 'surface' } });

/**
 * The App a request addresses, judged before its body is read: the one its `?app=` names (a headless host names it on
 * every request, client/embed/host.ts), else the one that signs this person in, else the only one. `undefined` where
 * none can be told — a signed-out request to a server of several Apps that names none in its address — and a request
 * that names a surface there is refused, since there is no App whose surfaces to judge it by. One that names no
 * surface is let past here and judged where its App is resolved (`headlessHeld`).
 */
export function addressedApp(ctx: Pick<RequestContext, 'signedIn' | 'appHosts' | 'url'>): AppDef | undefined {
  const named = ctx.url.searchParams.get('app');
  if (named) return ctx.appHosts?.find((host) => host.app.app.id === named)?.app.app;
  return ctx.signedIn?.app.app ?? (ctx.appHosts?.length === 1 ? ctx.appHosts[0].app.app : undefined);
}

/**
 * The routes about the session rather than an App's data, open to a headless App's front end with or without a
 * surface: who is signed in, and signing in and out (`/api/auth/…`, which the door mostly answers first).
 */
const sessionRoute = (path: string) => path === '/api/whoami' || path.startsWith('/api/auth/');

/** A headless App's request that names no surface, found where its App is resolved: answered 403 `{ code: 'surface' }` (server.ts). */
export class SurfaceRefused extends Error {
  readonly code = 'surface';
}

/**
 * The second look, where a request's App is resolved from its body as well as its address (appData.ts, importRoutes.ts):
 * a request to a headless App that names no surface is refused there, whichever way it named the App — the gate
 * before it could tell only the App its address names.
 */
export function headlessHeld(ctx: Pick<RequestContext, 'req' | 'path'>, app: AppDef | undefined): void {
  if (!app?.ui?.headless || !ctx.path.startsWith('/api/') || sessionRoute(ctx.path)) return;
  if (ctx.req.headers[SURFACE_HEADER] !== undefined || surfaceBootAsks.has(ctx.req)) return;
  throw new SurfaceRefused(headlessRefusal(app));
}

const headlessRefusal = (app: Pick<AppDef, 'name'>) =>
  `${app.name} is served headless: name the surface a request is from in X-Mistri-Surface.`;

/**
 * The surface a request names and the reader may use, `undefined` where it names none, or a refusal. Every route
 * that judges a request's content against its surface starts here, so each says the same thing.
 */
export function namedSurface(
  app: Pick<AppDef, 'surfaces' | 'auth'>,
  roles: readonly string[],
  header: string | string[] | undefined,
): AppSurface | Reply | undefined {
  if (header === undefined) return undefined;
  const surface = typeof header === 'string' && header ? surfaceFor(app, roles, header) : undefined;
  return surface ?? refuse('This request names no surface you may use.');
}

export const isSurfaceRefusal = (value: AppSurface | Reply | undefined): value is Reply => value !== undefined && 'status' in value;

/**
 * What a surface's request asks for, judged against the surface: the resources a read names, the commands a command
 * request runs, the table a file is read from. The loader is the surface's own, so it is never named.
 */
export function surfaceRefusal(options: {
  surface: AppSurface;
  path: string;
  body: Record<string, unknown>;
  /** A file's table, for `GET /api/file`. */
  table?: string;
  /** The reader's catalog, where a read is judged; a command needs none. */
  schema?: DatabaseSchema;
}): Reply | undefined {
  const { surface, path, body } = options;
  if (path.startsWith('/api/commands/')) {
    const names =
      path === COMMAND_ROUTES.availability && Array.isArray(body.checks)
        ? body.checks.map((check) => (check as { command?: unknown })?.command)
        : [body.command];
    const stray = names.find((name) => typeof name !== 'string' || !surface.commands.includes(name));
    return stray === undefined
      ? undefined
      : refuse(`The surface "${surface.key}" runs ${surface.commands.join(', ') || 'no commands'}; "${String(stray)}" is not one of them.`);
  }
  const asked = options.table === undefined ? tablesAsked(path, body) : [options.table];
  if (!asked) return undefined;
  const id = (name: string) => (options.schema && tableNamed(options.schema, name)?.id) ?? name;
  const declared = new Set(surface.reads.map(id));
  const stray = asked.find((table) => !declared.has(id(table)));
  return stray === undefined
    ? undefined
    : refuse(`The surface "${surface.key}" reads ${surface.reads.join(', ')}; "${stray}" is not one of them.`);
}

/**
 * The requests the embed's boot asks on a surface's behalf (embed/boot.ts): the reader's catalog, which a surface's
 * own requests never ask for. Marked by the boot's loop, and let past the gate, which judges what the front end asks.
 */
export const surfaceBootAsks = new WeakSet<IncomingMessage>();

/**
 * What a surface runs, for the boot: each command with the label its action is drawn with, its version, the resource
 * whose records it runs on, its input, and whether this reader is granted it. A command the App does not register is
 * left out; check refuses it.
 */
export function surfaceCommands(
  app: AppDef,
  surface: AppSurface,
  registry: BusinessCommandRegistry | undefined,
  roles: readonly string[],
): Omit<EmbedSurfaceCommand, 'key'>[] {
  const grants = appCommandGrants(app, [...roles]);
  return surface.commands.flatMap((id) => {
    const command = registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (!command) return [];
    return [
      {
        id,
        label: commandActionLabel(app, { command: id }) ?? id,
        version: command.version,
        ...(command.targets === 'none' ? {} : { target: logicalResource(app, command.source, command.target) }),
        granted: grants.has(id),
        input: structuredClone(command.fields) as EmbedSurfaceCommand['input'],
      },
    ];
  });
}

/** What a headless App's own screen answers, with 404: it draws none; its front end is another's. */
export const HEADLESS_SCREEN = 'this App is headless; it is served through its embed surfaces';

/**
 * Whether a page address is one of a headless App's own screens, which it does not serve. Its sign-in (and an OAuth
 * consent, `?authorize=`) still opens: a person signs in there for the front end that draws the App.
 */
export function headlessScreen(ctx: Pick<RequestContext, 'path' | 'url' | 'appHosts'>): boolean {
  const [, segment = '', ...rest] = ctx.path.split('/');
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return false;
  }
  const app = ctx.appHosts?.find((host) => host.app.app.id === id)?.app.app;
  if (!app?.ui?.headless || ctx.url.searchParams.has('authorize')) return false;
  const parts = rest.filter(Boolean);
  if (SOURCE_CLIENT && sourceFile(parts)) return false;
  return !(parts.length === 1 && parts[0] === 'sign-in');
}

/* The sign-in page's own files where the client is served from source: Vite's (`@vite/client`, `@fs/…`), its
   dependencies and the modules and stylesheets at the root, which a mount at the root places under the App. A built
   client's are under `/assets`, no App's address. */
const sourceFile = (parts: readonly string[]) =>
  parts.length > 0 && (parts[0].startsWith('@') || parts[0] === 'node_modules' || /\.[a-z0-9]+$/i.test(parts.at(-1)!));

/**
 * The first of an App's routes: a headless App's request with no surface, a surface no one by that key may use, or a
 * route a surface does not take, refused before anything is read. What the request names is judged where it is read
 * (appData.ts for reads and the loader, the command route for commands, appFileRead.ts for a file).
 */
export function surfaceGateRoute(ctx: RequestContext): boolean {
  if (!ctx.path.startsWith('/api/') || sessionRoute(ctx.path) || surfaceBootAsks.has(ctx.req)) return false;
  const app = addressedApp(ctx);
  const header = ctx.req.headers[SURFACE_HEADER];
  if (header === undefined) {
    if (!app?.ui?.headless) return false;
    send(ctx.res, 403, refuse(headlessRefusal(app)).body);
    return true;
  }
  if (!app) {
    if (!ctx.appHosts?.length) return false;
    send(ctx.res, 403, refuse('A surface names its App: add ?app=<the App id> to the request.').body);
    return true;
  }
  const named = namedSurface(app, sessionRoles(ctx.identity.role), header);
  if (isSurfaceRefusal(named)) {
    send(ctx.res, named.status, named.body);
    return true;
  }
  const routes = ctx.req.method === 'POST' ? SURFACE_POSTS : ctx.req.method === 'GET' ? SURFACE_GETS : undefined;
  if (routes?.has(ctx.path)) return false;
  send(ctx.res, 403, refuse(`A surface's requests read, load and run; ${ctx.req.method} ${ctx.path} is none of them.`).body);
  return true;
}
