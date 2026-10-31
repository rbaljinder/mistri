/**
 * A page section's box, whatever is in it: its heading, a fold when it is a
 * later group of fields, the placeholder while its data is on the way, and the note that names a section that
 * could not run. Every section kind draws through this, so they all head,
 * fold and break the same way.
 *
 * A section's heading is an h2: the record's name in the head is the room's
 * one h1, and what a section holds (a card's title) is the h3 under it. The
 * size is the class's, not the tag's, so the level can say the outline.
 */
import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { disclosure, findTable } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { GridSkeleton } from './Skeleton.js';
import { sectionClass, type PageSection } from './pageModel.js';
import { PageRenderContext, spoken } from './pageContext.js';
import { useMessageLanguage } from './useMessageLanguage.js';
import { Problem } from './Notes.js';
import { useListNavigation } from './listNavigation.js';
import { say } from '../copy/record/components/PageSectionBox.js';

/* A suggested page titles a related list by its table's name (`visit_attachment`), which an App says as words, as
   every untitled list's head already is. An authored title has words or capitals of its own and is left as written. */
const titled = (title: string) => (/^[a-z][a-z0-9_.]*$/.test(title) ? spoken(title) : title);

/** A section's box: its heading, or a fold when it is a later group of fields. */
export function SectionBox({
  section,
  body,
  foldable,
  broken,
  crashed,
  hidden,
  tools,
}: {
  section: PageSection;
  body: ReactNode;
  /** What the section offers beside its heading — a related list's Add and verbs — drawn in the heading's row. */
  tools?: ReactNode;
  foldable: boolean;
  broken?: string;
  /** Kept drawn but taking no place: a custom section whose component draws nothing. */
  hidden?: boolean;
  /** A boundary's note, for a section that threw while drawing: said under its heading like a failed read. */
  crashed?: ReactNode;
}) {
  useMessageLanguage();
  const { preview } = useContext(PageRenderContext);
  const content = preview ? (
    <div style={{ display: 'contents' }} inert>
      {body}
    </div>
  ) : (
    body
  );
  const heading =
    (section.title === undefined ? undefined : titled(section.title)) ??
    (section.kind === 'history'
      ? say('history')
      : section.kind === 'flows'
        ? say('flows')
        : section.kind === 'diagram'
          ? say('diagram')
          : undefined) ??
    spoken(section.kind === 'fields' ? '' : ((findTable(section.from ?? '') as TableMeta | undefined)?.name ?? section.from ?? ''));
  const details = useRef<HTMLDetailsElement>(null);
  const bound = useRef(false);
  // The shell's navigation: viewLink would be an import back into the walk that draws this page.
  const navigate = useListNavigation();
  useEffect(() => {
    if (details.current && !bound.current) {
      bound.current = true;
      disclosure(details.current, { dismissible: false });
    }
  });
  if (broken !== undefined || crashed !== undefined) {
    return (
      <section className={`${sectionClass(section)} page-broken`}>
        <h2 className="page-section-head">{heading || say('thisSection')}</h2>
        {crashed ?? <Problem text={broken ?? ''} />}
      </section>
    );
  }
  if (foldable && heading) {
    return (
      <section className={sectionClass(section)}>
        <details className="page-fold" ref={details} open>
          <summary className="page-section-head page-fold-head">
            <span>{heading}</span>
          </summary>
          {content}
        </details>
      </section>
    );
  }
  /* A gallery is a picture: its title names it for assistive technology,
     and a "Photos" heading over the photos says nothing a sighted reader
     needs. It leads the page without a rule above it. */
  const gallery = section.kind === 'list' && section.presentation === 'gallery';
  /* An embedded list view's heading is the way to the whole of it: the view's own room, where the reader has it. */
  const room = section.view && !preview ? navigate?.(section.view) : undefined;
  const headed = heading && (
    <h2 className={gallery ? 'page-section-head visually-hidden' : 'page-section-head'}>
      {room ? (
        <a className="page-section-link" {...room}>
          {heading}
        </a>
      ) : (
        heading
      )}
    </h2>
  );
  return (
    <section className={`${sectionClass(section)}${gallery ? ' page-gallery' : ''}`} hidden={hidden || undefined}>
      {tools ? (
        <div className="page-section-bar">
          {headed}
          {tools}
        </div>
      ) : (
        headed
      )}
      {content}
    </section>
  );
}

export function Loading({ section }: { section: PageSection }) {
  return (
    <section className={`${sectionClass(section)} loading`}>
      {section.title && <h2 className="page-section-head">{titled(section.title)}</h2>}
      {section.kind === 'list' ? <GridSkeleton columns={4} rows={3} /> : <div className="sk-bar" />}
    </section>
  );
}
