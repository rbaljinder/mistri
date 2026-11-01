/**
 * A carousel: one slide at a time from a row of them, chosen with Previous
 * and Next or with a dot per slide. Plain React — Base UI has no carousel,
 * and one slide, two steps and a dot row is all one is. The slides are the
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
 * motion (the track's transition lives under `no-preference` in
 * standalone.css). A step button that disables under a focused finger
 * hands focus to the other step, never to nowhere.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface CarouselSlide {
  /** The slide's short name, said after its number ("1 of 3: Studio"). */
  label?: string;
  children: ReactNode;
}

export interface CarouselProps {
  slides: readonly CarouselSlide[];
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
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

export function Carousel({ slides, index, defaultIndex = 0, onIndexChange, ariaLabel, words: given, className }: CarouselProps) {
  const words = { ...ENGLISH, ...given };
  const [uncontrolled, setUncontrolled] = useState(defaultIndex);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  /* The step last focused, so a step that disables under it is rescued
     even where the browser already moved focus to the body on disable. */
  const lastStepRef = useRef<'prev' | 'next' | null>(null);
  const current = slides.length ? Math.min(Math.max(index ?? uncontrolled, 0), slides.length - 1) : 0;
  const go = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), slides.length - 1);
    if (index === undefined) setUncontrolled(clamped);
    onIndexChange?.(clamped);
  };
  /* A step that disables under its own focus hands focus on: the other
     step where it is live, the region itself where both ends are shut
     (one slide). Rescue runs only while focus is still on that step or
     has already fallen to the body — a reader who tabbed onward is never
     pulled back, and a caller-driven index change moves nothing. */
  useEffect(() => {
    if (!slides.length) return;
    const active = document.activeElement;
    const lost = active === document.body;
    /* The rescued step becomes the last-focused one: the next disable
       under it rescues again, even where the rescue focus itself is
       what set the ref (the null-after-focus ordering bug, otherwise). */
    const focusStep = (step: 'prev' | 'next') => {
      const other = step === 'prev' ? prevRef.current : nextRef.current;
      if (other && !other.disabled) {
        other.focus();
        lastStepRef.current = step;
      } else {
        regionRef.current?.focus();
        lastStepRef.current = null;
      }
    };
    if (current === 0 && lastStepRef.current === 'prev' && (lost || active === prevRef.current)) focusStep('next');
    else if (current === slides.length - 1 && lastStepRef.current === 'next' && (lost || active === nextRef.current)) focusStep('prev');
  }, [current, slides.length]);
  if (!slides.length) return null;
  const onRegionKeyDown = (event: React.KeyboardEvent) => {
    /* The keys are the carousel's only while focus is on the carousel itself or its own controls. A widget inside a
       slide (an input's caret, a slider, a tab list, a menu) owns them, and so does anything drawn in a portal: React
       delivers a portal's events up through this tree, so the DOM, not the React tree, says whose they are. */
    const target = event.target as Node | null;
    if (target !== regionRef.current && !(target && controlsRef.current?.contains(target))) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(current - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(current + 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      go(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      go(slides.length - 1);
    }
  };
  return (
    <section
      ref={regionRef}
      className={['ui-carousel', className].filter(Boolean).join(' ')}
      aria-roledescription="carousel"
      aria-label={ariaLabel ?? words.region}
      /* Programmatic focus only, for the step-disable rescue above:
         -1 is no tab stop. */
      tabIndex={-1}
      onKeyDown={onRegionKeyDown}
    >
      <div className="ui-carousel-viewport">
        <div className="ui-carousel-track" style={{ transform: `translateX(-${current * 100}%)` }}>
          {slides.map((slide, i) => (
            <div
              key={i}
              className="ui-carousel-slide"
              role="group"
              aria-roledescription="slide"
              aria-label={words.slide(i + 1, slides.length, slide.label)}
              aria-hidden={i !== current || undefined}
              inert={i !== current || undefined}
            >
              {slide.children}
            </div>
          ))}
        </div>
      </div>
      <div className="ui-carousel-controls" ref={controlsRef}>
        <button
          ref={prevRef}
          type="button"
          className="ui-carousel-step"
          disabled={current === 0}
          onFocus={() => {
            lastStepRef.current = 'prev';
          }}
          onClick={() => go(current - 1)}
        >
          {words.previous}
        </button>
        <span className="ui-carousel-dots" role="group" aria-label={words.chooseSlide}>
          {slides.map((slide, i) => (
            <button
              key={i}
              type="button"
              className="ui-carousel-dot"
              aria-label={words.goToSlide(i + 1, slide.label)}
              aria-current={i === current || undefined}
              onClick={() => go(i)}
            />
          ))}
        </span>
        <button
          ref={nextRef}
          type="button"
          className="ui-carousel-step"
          disabled={current === slides.length - 1}
          onFocus={() => {
            lastStepRef.current = 'next';
          }}
          onClick={() => go(current + 1)}
        >
          {words.next}
        </button>
      </div>
      <p className="ui-carousel-status" aria-live="polite">
        {words.status(current + 1, slides.length, slides[current]?.label)}
      </p>
    </section>
  );
}
