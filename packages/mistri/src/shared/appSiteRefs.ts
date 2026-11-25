/**
 * Cross-view reachability checks for public site chrome (`ui.site`) and list / landing embed
 * record links that open a named custom page (`open: { page, param? }`).
 */
import type { OpenTarget } from '@mistriwork/engine/shared/servedApp.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ViewLike {
  kind: string;
}

interface ListViewEntry {
  at: string;
  view: { open?: 'drawer' | 'page' | OpenTarget };
}

interface LandingEntry {
  landing: {
    sections?: ReadonlyArray<{ kind: string; view?: string; open?: OpenTarget }>;
  };
}

/**
 * Validate `ui.site` view links and `open: { page }` targets against declared views,
 * appending errors to `across` and returning the reachable view keys they reference.
 */
export function collectSiteAndOpenReachable(
  rawApp: Record<string, unknown>,
  where: string,
  views: ReadonlyMap<string, ViewLike>,
  lists: readonly ListViewEntry[],
  landings: readonly LandingEntry[],
  across: string[],
): string[] {
  const keys: string[] = [];
  const rawSite = isRecord(rawApp.ui) && isRecord(rawApp.ui.site) ? rawApp.ui.site : undefined;
  if (rawSite) {
    const headerLinks = Array.isArray(rawSite.links) ? rawSite.links.filter(isRecord) : [];
    for (const link of headerLinks) {
      if (typeof link.view === 'string') {
        if (!views.has(link.view)) across.push(`${where}: ui.site.links names "${link.view}", which is not a view this App declares.`);
        else keys.push(link.view);
      }
    }
    if (isRecord(rawSite.search) && typeof rawSite.search.view === 'string') {
      if (!views.has(rawSite.search.view))
        across.push(`${where}: ui.site.search names "${rawSite.search.view}", which is not a view this App declares.`);
      else keys.push(rawSite.search.view);
    }
    if (isRecord(rawSite.cta) && typeof rawSite.cta.view === 'string') {
      if (!views.has(rawSite.cta.view))
        across.push(`${where}: ui.site.cta names "${rawSite.cta.view}", which is not a view this App declares.`);
      else keys.push(rawSite.cta.view);
    }
    if (isRecord(rawSite.footer) && Array.isArray(rawSite.footer.links)) {
      for (const link of rawSite.footer.links.filter(isRecord)) {
        if (typeof link.view === 'string') {
          if (!views.has(link.view))
            across.push(`${where}: ui.site.footer.links names "${link.view}", which is not a view this App declares.`);
          else keys.push(link.view);
        }
      }
    }
  }
  for (const list of lists) {
    if (typeof list.view.open === 'object') {
      const target = views.get(list.view.open.page);
      if (!target || target.kind !== 'dashboard') {
        across.push(`${list.at} has open.page "${list.view.open.page}", which is not a page view this App declares.`);
      } else {
        keys.push(list.view.open.page);
      }
    }
  }
  for (const { landing } of landings) {
    for (const section of landing.sections ?? []) {
      if (section.kind === 'view' && typeof section.open === 'object' && section.open !== null) {
        const target = views.get(section.open.page);
        if (!target || target.kind !== 'dashboard') {
          across.push(
            `${where}: landing embed "${section.view}" has open.page "${section.open.page}", which is not a page view this App declares.`,
          );
        } else {
          keys.push(section.open.page);
        }
      }
    }
  }
  return keys;
}
