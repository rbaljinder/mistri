/**
 * A record page's anatomy in placeholders, for a row still out past the navigation hold's cap. A part of its own
 * (onDemand.tsx): it is drawn only once that wait has lasted a second and a half, so no first page carries it.
 */
import { say } from '../copy/shell/components/Skeleton.js';
import type { PageSection } from '@mistriwork/engine/shared/pageModel.js';
import { GridSkeleton, bar, widthAt } from './Skeleton.js';
import './PageSkeleton.css';

/** One section of a record page, before it answers: its title's bar, then rows in its own shape. */
function sectionShape(section: PageSection, i: number) {
  const body =
    section.kind === 'fields' ? (
      <div className="sk-fields sk-page-fields">
        {Array.from({ length: Math.min(Math.max(section.paths?.length ?? 4, 2), 8) }, (_, f) => (
          <div key={f} className="sk-page-field">
            {bar(30, 9)}
            {bar(widthAt(f + i), 12)}
          </div>
        ))}
      </div>
    ) : section.kind === 'list' ? (
      <GridSkeleton columns={4} rows={3} />
    ) : (
      <div className="sk-page-block">
        {bar(widthAt(i) + 10, 12)}
        {bar(widthAt(i + 1), 12)}
        {bar(widthAt(i + 2) * 0.6, 12)}
      </div>
    );
  return (
    <section key={i} className="sk-page-section">
      {section.title ? bar(18, 12) : null}
      {body}
    </section>
  );
}

/**
 * A record page past the navigation hold's cap with its row still out: the page's own anatomy in placeholders — a
 * head of name and facts, the main column's sections and the aside's — drawn from the page's definition, so what
 * arrives stands where its placeholder stood. It sits inside the box that holds the page's height and is replaced
 * whole, so nothing under it moves. Before it, the reader past the cap saw an empty pane under the crumbs.
 */
export function PageSkeleton({ sections }: { sections: readonly PageSection[] }) {
  const shown = sections.filter((section) => !section.hidden);
  const main = shown.filter((section) => section.region !== 'aside').slice(0, 4);
  const aside = shown.filter((section) => section.region === 'aside').slice(0, 3);
  return (
    <div className="sk-page" role="status" aria-label={say('loadingRecord')}>
      <div className="sk-page-head">
        {bar(32, 22)}
        <div className="sk-page-facts">
          {Array.from({ length: 4 }, (_, f) => (
            <span key={f} className="sk-page-fact">
              {bar(60, 9)}
              {bar(widthAt(f + 2), 12)}
            </span>
          ))}
        </div>
      </div>
      <div className={aside.length ? 'page-layout sk-page-layout' : 'sk-page-layout'}>
        <div className="sk-page-main">{main.map(sectionShape)}</div>
        {aside.length ? <div className="sk-page-aside">{aside.map(sectionShape)}</div> : null}
      </div>
    </div>
  );
}
