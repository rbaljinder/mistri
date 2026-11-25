/**
 * A free-form page's or a surface's loader, held to what it declares, as a source
 * load (apps.ts) and a build's (appBuild.ts) both judge it. Apart from the
 * loaders themselves, so neither load pulls the command runtime in to ask.
 */
import { logicalResource, type AppDef } from '../../shared/app.js';
import type { PageLoader } from '../commands/pageLoaders.js';

/**
 * A loader's `'table.name'` reads (`.with('name')`) held to the App: each names a computed column or rollup the
 * table's resource declares. An undeclared or unknown one is named here, where the author can fix it, not found by a
 * request. Whether this reader is served it (a field grant) is the run's to say.
 */
function checkDerivedReads(app: AppDef, loader: PageLoader, name: string, at: string): void {
  for (const [table, names] of Object.entries(loader.derived ?? {})) {
    const resource = app.resources?.[loader.source ? logicalResource(app, loader.source, table) : table];
    const known = [...Object.keys(resource?.computed ?? {}), ...Object.keys(resource?.rollups ?? {})];
    const stray = names.find((each) => !known.includes(each));
    if (stray !== undefined) {
      throw new Error(
        `[page-loader] ${at}: its loader "${name}" reads "${table}.${stray}", which is no computed column or rollup of "${table}"` +
          `${known.length ? ` (it has ${known.join(', ')})` : ''}. List only the ones the App declares.`,
      );
    }
  }
}

/**
 * A loader's `elevate` held to the App, as a command's is (businessCommandAuthorization.ts), and refused in a
 * command's words where a command's is refused. An elevated table is read under the App's own authority, so it is one
 * of the App's declared resources and no part of what the page reads; and there is no such authority to read under
 *   - where the App's rows are its policy's (`auth.rows: 'policy'`): every read there is the caller's rows;
 *   - on a public page: a signed-out visitor holds no role to read above;
 *   - on a surface: a front end the App does not draw is held to what its reader reads;
 *   - on a page a platform role is offered, in a tenant App: an elevated read is made inside one tenant;
 *   - over a resource that audits its reads: a loader's elevated read is not audited, where a command's is.
 */
function checkElevation(
  app: AppDef,
  loader: PageLoader,
  name: string,
  at: string,
  place: { public?: boolean; surface?: boolean; roles?: readonly string[] },
): void {
  const elevated = loader.elevate?.read;
  if (!elevated?.length) return;
  const said = elevated.map((table) => `"${table}"`).join(', ');
  if (app.auth?.rows === 'policy')
    throw new Error(
      `[loader-elevate] ${at}: its loader "${name}" elevates its read of ${said}, but the App's rows are its policy's: ` +
        "a loader reads the caller's rows there, so no read is elevated. Grant the role the table, or drop elevate.",
    );
  if (place.public)
    throw new Error(
      `[loader-elevate] ${at}: its loader "${name}" elevates its read of ${said}, and a public page has no role to read above: drop its elevate.`,
    );
  if (place.surface)
    throw new Error(
      `[loader-elevate] ${at}: its loader "${name}" elevates its read of ${said}, and a surface's loader reads what its reader reads: drop its elevate, or run a command.`,
    );
  if (!app.auth?.roles)
    throw new Error(
      `[loader-elevate] ${at}: its loader "${name}" elevates its read of ${said}, and the App grants by no roles ("auth.roles"), so there is no grant to read above: drop its elevate.`,
    );
  for (const local of elevated) {
    const resource = loader.source ? logicalResource(app, loader.source, local) : local;
    const declared = app.resources?.[resource];
    if (!declared)
      throw new Error(
        `[loader-elevate] ${at}: its loader "${name}" elevates its read of "${local}", which is outside the App's resource ceiling: ` +
          `a loader reads only resources the App declares. Declare resources.${resource}, or drop it from the loader's reads.`,
      );
    if (declared.audit?.reads)
      throw new Error(
        `[loader-elevate] ${at}: its loader "${name}" elevates its read of "${local}", which audits its reads (audit.reads), and a loader's elevated read is not audited: read it through a command, or drop the elevation.`,
      );
  }
  const platform = (place.roles ?? []).find((role) => app.auth?.roles?.[role]?.realm === 'platform');
  if (app.auth.rows === 'tenant' && platform !== undefined)
    throw new Error(
      `[loader-elevate] ${at}: its loader "${name}" elevates its read of ${said}, and the page is offered to the platform role "${platform}": ` +
        "an elevated read is made inside one tenant. Offer the page to the tenant's roles, or drop elevate.",
    );
}

/**
 * Each free-form page's loaders (`loader` and `loaders`), each held to what the page declares: one the
 * commands module exports, reading only resources the page reads. The page
 * names it, so a loader no page names never runs. A surface's loader is held to
 * the surface's reads the same way: the runtime limits the loader's db to its own
 * `reads`, so a subset of the surface's is what keeps a surface from loading a
 * table it may not read.
 *
 * A loader that says the address parameters it reads (`params`) is held to the
 * ones the page keeps, and they are put on the page as it is served
 * (`loaderParams`): the one thing this check adds to the App it reads.
 */
export function checkPageLoaders(app: AppDef, loaders: Readonly<Record<string, PageLoader>> | undefined, where: string): void {
  for (const [key, view] of Object.entries(app.views)) {
    if (!('sections' in view) || !view.page) continue;
    const at = `${where}: pages/${key}.page.tsx`;
    /* The page's allowlist is its `loader` and its `loaders`: each held to the page's reads, a loader reading what its page reads. */
    for (const name of [view.page.loader, ...(view.page.loaders ?? [])]) {
      if (!name) continue;
      const loader = loaders && Object.hasOwn(loaders, name) ? loaders[name] : undefined;
      if (!loader) {
        throw new Error(
          `[page-loader] ${at} names the loader "${name}", which the commands module does not export: export const loaders = defineLoaders({ ${name}: defineLoader({ … }) }).`,
        );
      }
      /* A table the loader elevates is read under the App's authority, not the page's reader's: no part of the page's reads. */
      const stray = loader.reads.find((resource) => !view.page!.reads.includes(resource) && !loader.elevate?.read.includes(resource));
      if (stray) {
        throw new Error(
          `[page-loader] ${at}: its loader "${name}" reads "${stray}", which the page does not declare in its reads. A loader reads what its page reads` +
            `${(view.page.optionalReads ?? []).includes(stray) ? " for every reader, and an optional read is not every reader's: read it in the component with { optional: true }" : ''}.`,
        );
      }
      checkElevation(app, loader, name, at, {
        ...(view.page.public ? { public: true } : {}),
        ...(view.roles ? { roles: view.roles } : {}),
      });
      checkDerivedReads(app, loader, name, at);
      const unkept = loader.params?.find((param) => !view.page!.params.includes(param));
      if (unkept !== undefined) {
        throw new Error(
          `[page-loader] ${at}: its loader "${name}" reads the parameter "${unkept}", which the page does not keep in its address` +
            `${view.page.params.length ? ` (it keeps ${view.page.params.join(', ')})` : ''}. Add it to the page's params, or take it out of the loader's.`,
        );
      }
      /* Served with the page, so it asks each loader the parameters it reads and no others (client hooks.ts pageLoadPlace). */
      if (loader.params) (view.page.loaderParams ??= {})[name] = [...loader.params];
    }
  }
  for (const [key, surface] of Object.entries(app.surfaces ?? {})) {
    const name = surface.loader;
    if (!name) continue;
    const at = `${where}: surfaces/${key}.surface.ts`;
    const loader = loaders && Object.hasOwn(loaders, name) ? loaders[name] : undefined;
    if (!loader) {
      throw new Error(
        `[page-loader] ${at} names the loader "${name}", which the commands module does not export: export const loaders = defineLoaders({ ${name}: defineLoader({ … }) }).`,
      );
    }
    checkElevation(app, loader, name, at, { surface: true });
    const stray = loader.reads.find((resource) => !surface.reads.includes(resource));
    if (stray) {
      throw new Error(
        `[page-loader] ${at}: its loader "${name}" reads "${stray}", which the surface does not declare in its reads. A loader reads what its surface reads.`,
      );
    }
    checkDerivedReads(app, loader, name, at);
    if (loader.params?.length) {
      throw new Error(
        `[page-loader] ${at}: its loader "${name}" reads the parameter "${loader.params[0]}", and a surface keeps none: a front end passes no params.`,
      );
    }
  }
}
