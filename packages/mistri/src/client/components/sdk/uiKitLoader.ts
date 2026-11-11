/**
 * An App's control kit (Preview; @mistriwork/ui UiKit.tsx), installed before the shell draws anything: the head
 * names it (clientHttp.ts `uiKit`) and preloads its module beside the entry, and its stylesheet is already a link
 * there, so the first render draws the kit's controls and nothing is swapped after paint. Loaded only when the head
 * names a kit: an App without one never fetches this module, and the Workbench's page never names one.
 *
 * The page's side of `@mistriwork/mistri/ui` goes first (host.tsx), as for a component, so the kit's bare imports
 * find the page's own React, and its `defineUiKit` the page's own seam, whose installed kit every primitive reads.
 */
import { installUiKit, uiKitProblems, type UiKit } from '@mistriwork/ui/UiKit.js';
import './host.js';

/** Installs the kit served at `href` (the address the head preloaded), linking `css` if the head did not. */
export async function installServedUiKit(href: string, css: string | undefined): Promise<void> {
  if (css && !document.head.querySelector(`link[data-component-css="ui-kit"][href="${CSS.escape(css)}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = css;
    link.dataset.componentCss = 'ui-kit';
    document.head.append(link);
  }
  const kit = ((await import(/* @vite-ignore */ href)) as { default?: unknown }).default;
  /* The server read the same slots at load (appPages.ts uiKitModuleProblems); a kit that changed under a running page
     is refused here in the same words rather than half-installed. */
  const problems = uiKitProblems(kit);
  if (problems.length) throw new Error(`The UI kit ${problems.join(' It ')}`);
  installUiKit(kit as UiKit);
}
