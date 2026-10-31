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
 * on the region move, Home goes first, End goes last — except where
 * focus sits inside an input, where the keys stay the input's own — and
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
  label?: string;
  previousLabel?: ReactNode;
  nextLabel?: ReactNode;
  className?: string;
}

export function CarouselControl({
  slides,
  index,
  defaultIndex = 0,
  onIndexChange,
  label,
  previousLabel = 'Previous slide',
  nextLabel = 'Next slide',
  className,
}: CarouselProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultIndex);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLElement>(null);
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
    /* Inside an input the keys are the input's: arrows move its caret,
       Home and End its ends, and the region must not hijack them. */
    const target = event.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable
    )
      return;
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
      aria-label={label ?? 'Carousel'}
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
              aria-label={`${i + 1} of ${slides.length}${slide.label ? `: ${slide.label}` : ''}`}
              aria-hidden={i !== current || undefined}
              inert={i !== current || undefined}
            >
              {slide.children}
            </div>
          ))}
        </div>
      </div>
      <div className="ui-carousel-controls">
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
          {previousLabel}
        </button>
        <span className="ui-carousel-dots" role="group" aria-label="Choose a slide">
          {slides.map((slide, i) => (
            <button
              key={i}
              type="button"
              className="ui-carousel-dot"
              aria-label={`Go to slide ${i + 1}${slide.label ? `: ${slide.label}` : ''}`}
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
          {nextLabel}
        </button>
      </div>
      <p className="ui-carousel-status">
        Slide {current + 1} of {slides.length}
        {slides[current]?.label ? `: ${slides[current]?.label}` : ''}
      </p>
    </section>
  );
}

/** The short name, as the other primitives export theirs. */
export const Carousel = CarouselControl;
