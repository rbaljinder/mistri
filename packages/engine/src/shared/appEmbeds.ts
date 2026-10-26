/**
 * Which views a dashboard embeds, and which of those only a dashboard opens.
 * The client asks this to lay out its rooms on first paint; it is apart from
 * appPayload.ts because that module builds the payload from the parsed App,
 * and importing it took the manifest parser into the first script. It reads
 * the views by their shape, so the shared client asks it without the App's
 * model.
 */
import { navViewKeys, type ServedNavNode } from './servedApp.js';

/** A view that embeds others: a dashboard, whose sections and aside may each name a list view. */
interface Embedding {
  sections: readonly { view?: string }[];
  aside?: readonly { view?: string }[];
}

const embeds = (view: object): view is Embedding => Object.hasOwn(view, 'sections');

/** The list views a dashboard section embeds, by key. */
export function embedTargets(views: Readonly<Record<string, object>>): Set<string> {
  return new Set(
    Object.values(views).flatMap((view) =>
      embeds(view) ? [...view.sections, ...(view.aside ?? [])].flatMap((section) => (section.view ? [section.view] : [])) : [],
    ),
  );
}

/**
 * The views only a dashboard opens: embedded by one, and neither in nav
 * nor among `homes`. Each has a room, where the embed's "open →" goes, and
 * no menu lists it. The server passes every view a home rule names; the
 * client, which knows only its own, the home it was served.
 */
export function embeddedOnlyViews(
  app: { views: Readonly<Record<string, object>>; nav: readonly ServedNavNode[] },
  homes: Iterable<string>,
): Set<string> {
  const listed = new Set([...navViewKeys(app.nav), ...homes]);
  return new Set([...embedTargets(app.views)].filter((key) => !listed.has(key)));
}
