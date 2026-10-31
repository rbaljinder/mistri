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
 * on the region move, Home goes first, End goes last, and the slide's
 * movement is silenced for a reader who asked for reduced motion (the
 * track's transition lives under `no-preference` in standalone.css).
 */
import { useState, type ReactNode } from 'react';

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
  if (!slides.length) return null;
  const current = Math.min(Math.max(index ?? uncontrolled, 0), slides.length - 1);
  const go = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), slides.length - 1);
    if (index === undefined) setUncontrolled(clamped);
    onIndexChange?.(clamped);
  };
  const onRegionKeyDown = (event: React.KeyboardEvent) => {
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
      className={['ui-carousel', className].filter(Boolean).join(' ')}
      aria-roledescription="carousel"
      aria-label={label ?? 'Carousel'}
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
        <button type="button" className="ui-carousel-step" disabled={current === 0} onClick={() => go(current - 1)}>
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
        <button type="button" className="ui-carousel-step" disabled={current === slides.length - 1} onClick={() => go(current + 1)}>
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
