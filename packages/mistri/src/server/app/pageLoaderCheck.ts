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
      const stray = loader.reads.find((resource) => !view.page!.reads.includes(resource));
      if (stray) {
        throw new Error(
          `[page-loader] ${at}: its loader "${name}" reads "${stray}", which the page does not declare in its reads. A loader reads what its page reads.`,
        );
      }
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
