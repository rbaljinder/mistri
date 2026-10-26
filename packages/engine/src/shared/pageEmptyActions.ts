/**
 * A page's ways on, kept only where they lead somewhere: an App's pages are
 * served with its final rooms (appPayload.ts), and the database browser's
 * with none, so a configured page there offers no way on to a room.
 */
import type { PageDef } from './page.js';

/** Strip a related-list action whose destination is absent from final rooms. */
export function withAvailablePageEmptyActions(
  pages: readonly PageDef[],
  app: { readonly views: Readonly<Record<string, { readonly error?: unknown }>> },
): PageDef[] {
  const available = new Set(
    Object.entries(app.views)
      .filter(([, view]) => !view.error)
      .map(([key]) => key),
  );
  return pages.map((page) => ({
    ...page,
    sections: page.sections.map((section) => {
      // A page note's one way on goes where the reader has the room, or nowhere.
      if (section.kind === 'note' && section.action && 'view' in section.action && !available.has(section.action.view)) {
        const { action: _action, ...note } = section;
        return note;
      }
      if (section.kind !== 'list' || !section.empty?.action || available.has(section.empty.action.view)) return section;
      const { action: _action, ...empty } = section.empty;
      return { ...section, empty };
    }),
  }));
}
