/**
 * Surfaces: what a front end the App draws itself — a Next.js page on the same domain, say — may read and run of the
 * App, declared in `surfaces/<key>.surface.ts` with `defineSurface` (server/app/appSurfaces.ts reads the files). A
 * surface is a free-form page with nothing to draw: its reads, commands, forms and loader are judged by the
 * very rules a page's are (appPageViews.ts parsePageView), so every refusal and code is a page's, and who it is offered
 * to is said by what it reads, as a page's is.
 *
 * A request that names a surface in `X-Mistri-Surface` is held to it on the server (server/http/surfaceGate.ts); the
 * reader's grants, row policy and field ceilings still decide the rest, as they do for every request.
 */
import type { AppDef, AppSurface } from './appModel.js';
import type { ContentContext, ParsedView } from './appViews.js';
import { parsePageView } from './appPageViews.js';
import { opensTo } from './appViewRoles.js';

/** One surfaces/ file, read: its key (the file's name), where it was written and what `defineSurface` was given. */
export interface SurfaceFile {
  key: string;
  at: string;
  fields: Record<string, unknown>;
}

/** The header a headless front end names its surface in, on every request it makes (lowercase, as Node reads it). */
export const SURFACE_HEADER = 'x-mistri-surface';

/** Each surface, judged as the free-form page it would be: the same keys, refusals and roles, with nothing to draw. */
export function parseSurfaces(
  files: readonly SurfaceFile[],
  ctx: ContentContext,
  views: ReadonlyMap<string, ParsedView>,
): Record<string, AppSurface> {
  const surfaces: Record<string, AppSurface> = {};
  for (const { key, at, fields } of files) {
    /* The component a page would be drawn by: never compiled or served, it only satisfies the page's shape. */
    const raw = { ...fields, kind: 'page', component: { id: `surface-${key}`, module: `./surfaces/${key}.surface.ts`, kind: 'page' } };
    const { view } = parsePageView(raw, key, at, ctx, views);
    const page = view.page!;
    surfaces[key] = {
      key,
      label: view.label,
      ...(view.description === undefined ? {} : { description: view.description }),
      reads: page.reads,
      commands: page.commands,
      ...(page.loader ? { loader: page.loader } : {}),
      ...(page.forms ? { forms: page.forms } : {}),
      ...(view.roles ? { roles: view.roles } : {}),
    };
  }
  return surfaces;
}

/**
 * The surface `key` names, when a principal holding `roles` may use it: undefined for a surface the App does not have,
 * or one offered only to roles they do not hold. An App with no roles offers each surface to everyone it serves.
 */
export function surfaceFor(app: Pick<AppDef, 'surfaces' | 'auth'>, roles: readonly string[], key: string): AppSurface | undefined {
  const surface = app.surfaces && Object.hasOwn(app.surfaces, key) ? app.surfaces[key] : undefined;
  return surface && opensTo(surface, roles, app.auth) ? surface : undefined;
}
