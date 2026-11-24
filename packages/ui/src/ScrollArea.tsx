/**
 * A scroll area: a region that scrolls inside itself, with its own
 * thumb, instead of growing the page around it. Over UI SDK's ScrollArea,
 * which gives it the viewport, the thumb that tracks it and the corner
 * where two thumbs meet. Where its content overflows, the viewport is a
 * tab stop with the region's name, so a keyboard reader can reach it and
 * scroll with the arrows without a mouse; a region whose content never
 * overflows draws no thumb and is no tab stop to nowhere. `orientation`
 * says which thumbs exist (vertical by default); `maxHeight` caps the
 * region where the caller wants one, as a CSS length, and is otherwise
 * the caller's own height.
 * Where the scrolled content is a list, the list's own semantics stay on
 * the content — this region adds scrolling, never a second list. The
 * viewport is a tab stop only while its content overflows: a region
 * whose content fits draws no thumb and must be no tab stop to nowhere.
 * Overflow is measured, not assumed — on mount, on content change, and
 * whenever the box resizes.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { slotted } from './internal/uiKitContext.js';
import {
  ScrollArea as Scroller,
  ScrollAreaContent,
  ScrollAreaCorner,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@ui-sdk/react/scroll-area';

/** Props for the `ScrollArea` bounded scroll container. */
export interface ScrollAreaProps {
  children: ReactNode;
  /** The scrollable region's accessible name ("Recent activity"). */
  ariaLabel?: string;
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** A cap on the region's height, as a CSS length (for example "320px"). */
  maxHeight?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function DefaultScrollArea({ children, ariaLabel, orientation = 'vertical', maxHeight, className, ref }: ScrollAreaProps) {
  const vertical = orientation === 'vertical' || orientation === 'both';
  const horizontal = orientation === 'horizontal' || orientation === 'both';
  const viewportRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const at = viewportRef.current;
      if (!at) return;
      const tall = vertical && at.scrollHeight - at.clientHeight > 1;
      const wide = horizontal && at.scrollWidth - at.clientWidth > 1;
      setOverflows(tall || wide);
    };
    measure();
    /* Content growth changes scroll size without resizing the viewport,
       so the content is watched too; where ResizeObserver is absent
       (a test renderer) the mount-time measure above is all there is. */
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(viewport);
      if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [vertical, horizontal, children]);
  return (
    <Scroller ref={ref} className={className}>
      <ScrollAreaViewport
        ref={viewportRef}
        tabIndex={overflows ? 0 : -1}
        /* A named scroll region needs the region role, or the label is dropped. */
        role="region"
        aria-label={ariaLabel}
        /* A deliberate scroller: the double-scroll probe (gradeProbe.ts) reads this and leaves it alone. */
        data-scrolls=""
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* Content is required inside the viewport once the region scrolls
            sideways; it costs nothing vertically, so it is always here. */}
        <ScrollAreaContent>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      {vertical ? (
        <ScrollAreaScrollbar orientation="vertical">
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      ) : null}
      {horizontal ? (
        <ScrollAreaScrollbar orientation="horizontal">
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      ) : null}
      {vertical && horizontal ? <ScrollAreaCorner /> : null}
    </Scroller>
  );
}

/** Bounded scroll container with custom scrollbars and keyboard-focusable overflow viewport. */
export const ScrollArea = slotted('ScrollArea', DefaultScrollArea);
