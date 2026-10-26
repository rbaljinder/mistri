/**
 * The record's main content and optional context rail share one responsive layout, arranged by the page's
 * archetype (shared/pageLayouts.ts). `data-layout` names it from the first render, so the columns are the
 * archetype's before any section has landed; the geometry is page.css's, keyed on it.
 */
import type { ReactNode } from 'react';
import type { PageLayoutName } from '@mistriwork/engine/shared/pageLayouts.js';
import { say } from '../copy/record/components/PageLayout.js';

export function PageLayout({
  children,
  aside,
  asideLabel = say('recordContext'),
  layout,
  below,
  panel,
}: {
  children: ReactNode;
  aside?: ReactNode;
  asideLabel?: string;
  layout?: PageLayoutName;
  /** A showcase's body: the main column's sections after its photos, under the showcase band at full width. */
  below?: ReactNode;
  /** A showcase's panel, named by what it offers ("Home: Asking rent") rather than as the record's context. */
  panel?: { noun: string; figure?: string };
}) {
  if (!aside) {
    return (
      <div className="page-body" data-layout={layout}>
        {children}
        {below}
      </div>
    );
  }
  /* A showcase is two bands, in reading order: the photos with the panel beside them, then the body under both. On
     a phone the three stack as written, so the price and its call to action follow the photos, not every list. */
  if (layout === 'showcase') {
    return (
      <div className="page-layout" data-layout="showcase">
        <div className="page-body page-main page-showcase">{children}</div>
        <aside
          className="page-body page-aside page-panel"
          aria-label={panel ? (panel.figure ? say('showcasePanel', { noun: panel.noun, figure: panel.figure }) : panel.noun) : asideLabel}
        >
          {aside}
        </aside>
        {below && <div className="page-body page-showcase-body">{below}</div>}
      </div>
    );
  }
  return (
    <div className="page-layout" data-layout={layout}>
      <div className="page-body page-main">{children}</div>
      <aside className="page-body page-aside" aria-label={asideLabel}>
        {aside}
      </aside>
    </div>
  );
}
