/**
 * A free-form page's loader, held to what the page declares, as a source
 * load (apps.ts) and a build's (appBuild.ts) both judge it. Apart from the
 * loaders themselves, so neither load pulls the command runtime in to ask.
 */
import type { AppDef } from '../../shared/app.js';
import type { PageLoader } from '../commands/pageLoaders.js';

/**
 * Each free-form page's loader, held to what the page declares: one the
 * commands module exports, reading only resources the page reads. The page
 * names it, so a loader no page names never runs.
 */
export function checkPageLoaders(app: AppDef, loaders: Readonly<Record<string, PageLoader>> | undefined, where: string): void {
  for (const [key, view] of Object.entries(app.views)) {
    const name = 'sections' in view ? view.page?.loader : undefined;
    if (!name) continue;
    const at = `${where}: pages/${key}.page.tsx`;
    const loader = loaders && Object.hasOwn(loaders, name) ? loaders[name] : undefined;
    if (!loader) {
      throw new Error(
        `[page-loader] ${at} names the loader "${name}", which the commands module does not export: export const loaders = defineLoaders({ ${name}: defineLoader({ … }) }).`,
      );
    }
    const page = (view as { page: { reads: string[] } }).page;
    const stray = loader.reads.find((resource) => !page.reads.includes(resource));
    if (stray) {
      throw new Error(
        `[page-loader] ${at}: its loader "${name}" reads "${stray}", which the page does not declare in its reads. A loader reads what its page reads.`,
      );
    }
  }
}
