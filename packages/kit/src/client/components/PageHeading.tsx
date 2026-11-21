/**
 * The head of a dashboard or a free-form page, as markup: the title, its star, a line of intro, and, when there are
 * any, the page's verbs and a way back. DashHead is the platform's own use of it; a free-form page that draws its own
 * head reaches it through the SDK's `PageHeader`, so both wear the one set of classes and every look and theme
 * dresses them alike (features.css `.dash-head`).
 */
import type { ReactNode } from 'react';

export function PageHeading({
  title,
  favorite,
  description,
  actions,
  back,
  hidden = false,
  level = 1,
}: {
  title: ReactNode;
  /** The Favorites star beside the title. */
  favorite?: ReactNode;
  description?: ReactNode;
  /** The page's verbs, at the head's far end. */
  actions?: ReactNode;
  /** A way back, over the title. */
  back?: ReactNode;
  /** The title stays for a screen reader and is not seen. */
  hidden?: boolean;
  /** A page has one h1, the platform's; a head a page draws itself is an h2. */
  level?: 1 | 2;
}) {
  const Title = level === 1 ? 'h1' : 'h2';
  const drawn = actions !== undefined && actions !== null && actions !== false;
  const heading = <Title className={`applist-title${hidden ? ' visually-hidden' : ''}`}>{title}</Title>;
  /* A page that draws its own head says its own intro; `heading: false` hides only the title. */
  const intro = description ? <p className="note dash-description">{description}</p> : null;
  return (
    <div className={`applist-head dash-head${drawn ? ' has-actions' : ''}${back ? ' has-back' : ''}`}>
      {back ? <div className="dash-head-back">{back}</div> : null}
      {/* With verbs, the head is two regions: the words (title over intro) and the verbs. As siblings in one wrapping
          row, an intro narrower than the line's room stood beside the verbs at a desk, a field report's page read
          "title · intro · picker" across. Two regions hold the intro under its title and stack under it at a phone. */}
      {drawn ? (
        <>
          <div className="dash-head-text">
            {heading}
            {favorite}
            {intro}
          </div>
          <div className="applist-head-tools dash-head-actions">{actions}</div>
        </>
      ) : (
        <>
          {heading}
          {favorite}
          {intro}
        </>
      )}
    </div>
  );
}
