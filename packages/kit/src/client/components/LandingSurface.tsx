/**
 * The public landing: an App's front page for someone who is not signed in.
 * No sidebar, no query bar, no session — a headline, the calls to action,
 * the author's sections and a footer, in the App's name and dress. Every
 * string the author wrote is drawn as React text, so markup in it is shown
 * and never run; the links were held to https:, mailto: and tel: when the
 * App loaded, and are held to them again here before they become an href.
 */
import { useId, type MouseEvent, type ReactNode } from 'react';
import type { AppLanding, LandingAction, LandingImage, LandingLink, LandingSection } from '@mistriwork/engine/shared/servedApp.js';
import { Accordion, AccordionItem } from './Accordion.js';
import './LandingSurface.css';
import { shown } from '../addressMount.js';
import { imageSources, imageFallbackSet, MEDIA_IMAGE_SIZES } from '@mistriwork/engine/shared/imageWidths.js';
import { Icon } from './Icon.js';
import { Badge, IconRows, PhotoTiles } from '@mistriwork/ui/HeroBlocks.js';

/** A call to action that opens one of the App's views: its address, and how to follow it in place. */
type ViewLink = { href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };

/**
 * What only the App can draw, handed in by the App that draws the landing:
 * the sections that read its rows, and the address of a view a call to
 * action opens. Signed out without the App, both are absent, and the page
 * is the author's text alone.
 */
interface LandingHost {
  renderSection?: (section: LandingSection) => ReactNode;
  openView?: (view: string) => ViewLink | undefined;
  /** The address of the hero's photo, a row of the App's files. */
  imageSrc?: (image: LandingImage) => string | undefined;
}

/**
 * The top of the page. With a photo it is laid out `split` — the words and
 * the photo side by side — or `overlay` — the photo behind the words under
 * the photo stage's scrim, whose ink keeps its contrast whatever the
 * picture and the theme. The photo's box has its size before the photo
 * arrives, so nothing moves; on a phone it sits above the words. A search
 * inside the hero is the search section's panel; the highlights are one
 * quiet line under the actions, and the points are rows of an icon and a
 * line. Tiles are two to four photos in a mosaic where the one photo would
 * stand, sized before they arrive as it is; a badge is a pill over the
 * heading.
 */
function Hero({ landing, app, id, host }: { landing: AppLanding; app: { id: string; name: string }; id: string; host: LandingHost }) {
  const hero = landing.hero;
  const src = hero.image ? host.imageSrc?.(hero.image) : undefined;
  /* Tiles are drawn only when every one of them has its address: a mosaic with a hole in it reads as broken. */
  const tiles = hero.tiles?.map((tile) => ({ tile, src: host.imageSrc?.(tile) }));
  const tiled = tiles?.every((each) => each.src) ? (tiles as Array<{ tile: LandingImage; src: string }>) : undefined;
  const layout = src ? (hero.layout ?? 'split') : tiled ? 'split' : undefined;
  const search = hero.search ? host.renderSection?.({ kind: 'search', ...hero.search }) : null;
  /* With no photo to stand beside the words, a desk sets the points there instead (LandingSurface.css): a column
     of reasons opposite the headline, not a list trailing under the button. On a phone they follow the actions,
     where they always were. */
  const points = hero.points?.length ? (
    <IconRows rows={hero.points.map((point) => ({ icon: <Icon name={point.icon} size={18} />, text: point.text }))} />
  ) : null;
  const beside = !layout && points !== null;
  return (
    <section
      className={`front-hero${layout ? ` front-hero-${layout}` : beside ? ' front-hero-beside' : ''}`}
      aria-labelledby={`${id}-headline`}
    >
      {src && (
        <div className="front-hero-media">
          <picture>
            {imageSources(src).map((source) => (
              <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={MEDIA_IMAGE_SIZES} />
            ))}
            <img
              src={src}
              srcSet={imageFallbackSet(src)}
              sizes={MEDIA_IMAGE_SIZES}
              alt={hero.image!.alt}
              decoding="async"
              fetchPriority="high"
            />
          </picture>
        </div>
      )}
      {tiled && (
        <PhotoTiles
          tiles={tiled.map(({ tile, src: at }) => ({ src: at, srcSet: imageFallbackSet(at), sizes: MEDIA_IMAGE_SIZES, alt: tile.alt }))}
        />
      )}
      <div className="front-hero-text">
        {/* No eyebrow naming the App: the bar above already says it, and a
          headline under its own brand's name read as the brand said twice.
          A badge is the author's own few words, in a pill. */}
        {hero.badge && <Badge icon={hero.badge.icon && <Icon name={hero.badge.icon} size={14} />}>{hero.badge.text}</Badge>}
        <h1 id={`${id}-headline`}>{hero.heading}</h1>
        {hero.description && <Prose text={hero.description} className="front-lede" />}
        <Actions appId={app.id} actions={hero.actions} openView={host.openView} />
        {hero.highlights?.length ? (
          <ul className="front-highlights">
            {hero.highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        {beside ? null : points}
      </div>
      {beside ? <div className="front-hero-points">{points}</div> : null}
      {search ? <div className="front-hero-search">{search}</div> : null}
    </section>
  );
}

/** Where a call to action goes when the App says nothing better: the public form's own page, or staff sign-in. */
export function actionHref(appId: string, action: LandingAction): string {
  const app = `/${encodeURIComponent(appId)}`;
  return shown('view' in action ? `${app}/form/${encodeURIComponent(action.view)}` : `${app}/sign-in`);
}

/** The parser's rule, said again at the last moment an href can do harm. */
export function safeHref(href: string): string | undefined {
  return /^(?:https:\/\/|mailto:|tel:)/i.test(href) ? href : undefined;
}

/** A blank line starts a paragraph; that is the whole of the formatting. */
function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((paragraph, index) => (
        <p key={index} className={className}>
          {paragraph.trim()}
        </p>
      ))}
    </>
  );
}

function Actions({ appId, actions, openView }: { appId: string; actions: readonly LandingAction[]; openView?: LandingHost['openView'] }) {
  return (
    <div className="front-actions">
      {actions.map((action, index) => {
        const kind = action.intent ?? (index === 0 ? 'primary' : 'secondary');
        const link = 'view' in action ? openView?.(action.view) : undefined;
        return (
          <a
            key={index}
            className={`front-action front-action-${kind}`}
            href={link?.href ?? actionHref(appId, action)}
            onClick={link?.onClick}
          >
            {action.label}
          </a>
        );
      })}
    </div>
  );
}

function Link({ link }: { link: LandingLink }) {
  const href = safeHref(link.href);
  return href ? <a href={href}>{link.label}</a> : <span>{link.label}</span>;
}

/* A section's heading is an h2; an item's is an h3 under it, or an h2 when
   the section has no title of its own — so the outline never skips a level. */
function Section({ section, appId, id, host }: { section: LandingSection; appId: string; id: string; host: LandingHost }) {
  const headingId = `${id}-title`;
  const Item = section.title ? 'h3' : 'h2';
  const heading = section.title ? <h2 id={headingId}>{section.title}</h2> : null;
  const labelled = section.title ? headingId : undefined;
  const className = `front-section front-${section.kind}`;
  switch (section.kind) {
    case 'features':
    case 'steps': {
      const List = section.kind === 'steps' ? 'ol' : 'ul';
      return (
        <section className={className} aria-labelledby={labelled}>
          {heading}
          <List className="front-items">
            {section.items.map((item, index) => (
              <li key={index}>
                <Item>{item.title}</Item>
                <Prose text={item.description} />
              </li>
            ))}
          </List>
        </section>
      );
    }
    case 'faq':
      return (
        <section className={className} aria-labelledby={labelled}>
          {heading}
          <div className="front-questions">
            <Accordion>
              {section.items.map((item, index) => (
                <AccordionItem key={index} title={item.question} level={section.title ? 3 : 2}>
                  <div className="front-answer">
                    <Prose text={item.answer} />
                  </div>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      );
    case 'view':
    case 'search': {
      /* Rows are the App's to draw; without it there is nothing to show, and no heading over nothing. */
      const body = host.renderSection?.(section);
      if (!body) return null;
      return (
        <section className={className} aria-labelledby={labelled}>
          {heading}
          {body}
        </section>
      );
    }
    case 'text':
      return (
        <section className={className} aria-labelledby={labelled}>
          {heading}
          <div className="front-prose">
            <Prose text={section.text} />
          </div>
        </section>
      );
    case 'callToAction':
      return (
        <section className={className} aria-labelledby={headingId}>
          <h2 id={headingId}>{section.title}</h2>
          {section.description && <Prose text={section.description} />}
          <Actions appId={appId} actions={section.actions} openView={host.openView} />
        </section>
      );
    case 'contact':
      return (
        <section className={className} aria-labelledby={labelled}>
          {heading}
          <ul className="front-links">
            {section.items.map((link, index) => (
              <li key={index}>
                <Link link={link} />
              </li>
            ))}
          </ul>
        </section>
      );
  }
}

export function LandingSurface({
  landing,
  app,
  renderSection,
  openView,
  imageSrc,
}: { landing: AppLanding; app: { id: string; name: string } } & LandingHost) {
  const host = { renderSection, openView, imageSrc };
  const id = useId();
  /* A landing is served the App's footer (landingRoutes),
     so there is one footer per App rather than a front page whose small print
     disagrees with every other room's. */
  const footer = landing.footer;
  return (
    <div className="front">
      <Hero landing={landing} app={app} id={id} host={host} />
      {(landing.sections ?? []).map((section, index) => (
        <Section key={index} section={section} appId={app.id} id={`${id}-s${index}`} host={host} />
      ))}
      {footer && (
        <footer className="front-footer">
          {footer.text && <Prose text={footer.text} />}
          {footer.links?.length ? (
            <ul className="front-links">
              {footer.links.map((link, index) => (
                <li key={index}>
                  <Link link={link} />
                </li>
              ))}
            </ul>
          ) : null}
        </footer>
      )}
    </div>
  );
}
