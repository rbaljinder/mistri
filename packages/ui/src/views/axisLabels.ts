/* How many labels an axis can carry without one running into the next. A Gantt ruler and a trace's duration axis are
   both placed by percentage along a width the view does not choose, so the count that fits is read off the element:
   a ruler labelled at every second day said "Sep 1Sep 3Sep 5Sep 7" in a card 140px wide. */
import { type RefObject, useLayoutEffect, useState } from 'react';

/* A label's width is estimated from its length rather than measured: the labels are short, tabular and of one size,
   and measuring each would mean drawing them once to throw the drawing away. The figures are generous (a wide
   glyph at the axis's 12px, and a clear gap), so the estimate errs towards fewer labels. A label is given one and a
   half times its width because the two at the ends are drawn inside the edge rather than centred on their tick,
   which brings each half a label closer to its neighbour. */
const CHAR_PX = 7;
const GAP_PX = 10;
const room = (widestChars: number) => Math.max(1, widestChars) * CHAR_PX * 1.5 + GAP_PX;

/* The width assumed before the element has been measured (the first render, and a server's): a phone's, so an
   unmeasured axis is sparse rather than overprinted. */
const UNMEASURED_PX = 320;

/** Label one tick in this many, so `tickCount` labels of at most `widestChars` characters fit in `widthPx`. */
export function labelEvery(tickCount: number, widestChars: number, widthPx: number): number {
  const width = widthPx > 0 ? widthPx : UNMEASURED_PX;
  const fits = Math.max(1, Math.floor(width / room(widestChars)));
  return Math.max(1, Math.ceil(tickCount / fits));
}

/** The element's width, kept current as it is resized; 0 until it is first measured. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
