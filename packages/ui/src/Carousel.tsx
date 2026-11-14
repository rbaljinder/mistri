/**
 * A carousel: one slide at a time from a row of them, chosen with Previous
 * and Next or with a dot per slide. Plain React: one slide, two steps and
 * a dot row is all one is. The slides are the
 * caller's array (the Tabs pattern), not children kept in step by hand.
 * Controlled with `index`/`onIndexChange`, uncontrolled with
 * `defaultIndex`. The ends do not wrap: Previous disables on the first
 * slide and Next on the last, so the row keeps its shape and a reader is
 * never spun back to the start without asking. Only the current slide is
 * exposed to assistive tech (the rest are `aria-hidden`); the arrow keys
 * on the region move, Home goes first, End goes last — only while focus
 * is on the carousel or its own controls, so a widget inside a slide
 * keeps its keys — and
 * the slide's movement is silenced for a reader who asked for reduced
 * motion (the track's transition lives under `no-preference` in the
 * stylesheet). A step button that disables under a focused finger
 * hands focus to the other step, never to nowhere.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { slotted } from './internal/uiKitContext.js';

export interface CarouselSlide {
  /** The slide's short name, said after its number ("1 of 3: Studio"). */
  label?: string;
  children: ReactNode;
}

export interface CarouselProps {
  slides: readonly CarouselSlide[];
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number, details: ChangeDetails<'navigate'>) => void;
  /** The region's accessible name, where the carousel needs one ("Project photos"). */
  ariaLabel?: string;
  /** Every word the carousel says, in the caller's language; any left out are English. */
  words?: Partial<CarouselWords>;
  className?: string;
}

interface CarouselWords {
  /** The region's name when `ariaLabel` is not given. */
  region: string;
  /** The step buttons' visible words. */
  previous: ReactNode;
  next: ReactNode;
  /** The dot row's name. */
  chooseSlide: string;
  /** A slide's name: "1 of 3: Studio". */
  slide: (number: number, total: number, label?: string) => string;
  /** A dot's name: "Go to slide 2: Studio". */
  goToSlide: (number: number, label?: string) => string;
  /** The polite status line read as the slide changes. */
  status: (number: number, total: number, label?: string) => string;
}

const ENGLISH: CarouselWords = {
  region: 'Carousel',
  previous: 'Previous slide',
  next: 'Next slide',
  chooseSlide: 'Choose a slide',
  slide: (n, total, label) => `${n} of ${total}${label ? `: ${label}` : ''}`,
  goToSlide: (n, label) => `Go to slide ${n}${label ? `: ${label}` : ''}`,
  status: (n, total, label) => `Slide ${n} of ${total}${label ? `: ${label}` : ''}`,
};

/* One slide at a time, the others out of reach: only the slide in view is in the tab order and the tree. Drawn by
   hand on the carousel's parts, which the stylesheet dresses: UI SDK's own carousel is a scroller that keeps its
   neighbours beside the slide and chooses among them with tabs, which is another control with other names. */
function DefaultCarousel({ slides, index, defaultIndex = 0, onIndexChange, ariaLabel, words: given, className }: CarouselProps) {
  const words = { ...ENGLISH, ...given };
  const [own, setOwn] = useState(defaultIndex);
  const region = useRef<HTMLElement>(null);
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  /* The step the keyboard was last on, so one that disables under it is rescued even where the browser has
     already dropped the focus to the body. */
  const lastStep = useRef<'previous' | 'next' | null>(null);
  const last = slides.length - 1;
  const at = slides.length ? Math.min(Math.max(index ?? own, 0), last) : 0;
  useEffect(() => {
    if (!slides.length) return;
    const active = document.activeElement;
    const lost = active === document.body;
    const hand = (to: 'previous' | 'next') => {
      const other = to === 'previous' ? previous.current : next.current;
      if (other && !other.disabled) {
        other.focus();
        lastStep.current = to;
      } else {
        // Both ends shut (one slide): the carousel itself takes it.
        region.current?.focus();
        lastStep.current = null;
      }
    };
    // Only while the focus is still on that step or has fallen from it: a reader who moved on is not pulled back.
    if (at === 0 && lastStep.current === 'previous' && (lost || active === previous.current)) hand('next');
    else if (at === last && lastStep.current === 'next' && (lost || active === next.current)) hand('previous');
  }, [at, last, slides.length]);
  if (!slides.length) return null;
  const go = (to: number, event: SyntheticEvent) => {
    const place = Math.min(Math.max(to, 0), last);
    if (place === at) return;
    if (index === undefined) setOwn(place);
    onIndexChange?.(place, changeDetails('navigate', event));
  };
  /* The keys are the carousel's only while the keyboard is on the carousel itself or on one of its own controls.
     What is inside a slide (a caret, a slider, a tab row) keeps them, and so does what is drawn in a portal: React
     hands a portal's events up through this tree, so the document, not the React tree, says whose they are. */
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    const control = target?.closest?.('[data-part="carousel-control"]');
    if (target !== region.current && !(control && control.closest('[data-slot="carousel"]') === region.current)) return;
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    go(to, event);
  };
  return (
    <section
      ref={region}
      data-slot="carousel"
      className={className || undefined}
      aria-roledescription="carousel"
      aria-label={ariaLabel ?? words.region}
      // Reached by the hand-over above and never by Tab.
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div data-slot="carousel-stage">
        <button
          ref={previous}
          type="button"
          data-slot="carousel-previous"
          data-part="carousel-control"
          data-variant="quiet"
          disabled={at === 0}
          data-disabled={at === 0 ? '' : undefined}
          onFocus={() => {
            lastStep.current = 'previous';
          }}
          onClick={(event) => go(at - 1, event)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M10 3.5 5.5 8l4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span data-slot="visually-hidden">{words.previous}</span>
        </button>
        <div data-slot="carousel-viewport" style={{ overflow: 'hidden', minWidth: 0 }}>
          <div data-slot="carousel-content" style={{ display: 'flex', gap: 0, transform: `translateX(-${at * 100}%)` }}>
            {slides.map((slide, place) => (
              <div
                key={place}
                data-slot="carousel-item"
                role="group"
                aria-roledescription="slide"
                aria-label={words.slide(place + 1, slides.length, slide.label)}
                aria-hidden={place !== at || undefined}
                inert={place !== at || undefined}
                data-active={place === at ? '' : undefined}
                style={{ flex: '0 0 100%', minWidth: 0 }}
              >
                {slide.children}
              </div>
            ))}
          </div>
        </div>
        <button
          ref={next}
          type="button"
          data-slot="carousel-next"
          data-part="carousel-control"
          data-variant="quiet"
          disabled={at === last}
          data-disabled={at === last ? '' : undefined}
          onFocus={() => {
            lastStep.current = 'next';
          }}
          onClick={(event) => go(at + 1, event)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M6 3.5 10.5 8 6 12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span data-slot="visually-hidden">{words.next}</span>
        </button>
      </div>
      <span data-slot="carousel-indicator-group" role="group" aria-label={words.chooseSlide}>
        {slides.map((slide, place) => (
          <button
            key={place}
            type="button"
            data-slot="carousel-indicator"
            data-part="carousel-control"
            data-selected={place === at ? '' : undefined}
            aria-label={words.goToSlide(place + 1, slide.label)}
            aria-current={place === at || undefined}
            onClick={(event) => go(place, event)}
          />
        ))}
      </span>
      <p data-slot="visually-hidden" aria-live="polite">
        {words.status(at + 1, slides.length, slides[at]?.label)}
      </p>
    </section>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Carousel = slotted('Carousel', DefaultCarousel, { onIndexChange: [1, 'navigate'] });
