import { type RefObject, useEffect, useRef, useState } from 'react';

/* The width something has to draw in, in the stylesheet's pixels, kept as its box changes. What decides a layout
   is the room a thing was given and not the window: a list in a panel beside another reads as a phone would.
   Until it is measured (and where nothing measures, as in a test) it is `fallback`. */
export function useWidth<T extends HTMLElement = HTMLDivElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}
