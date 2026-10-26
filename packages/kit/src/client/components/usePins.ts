/**
 * Columns that stay put when a wide table scrolls sideways.
 *
 * `position: sticky` needs a `left` for each pinned column, and the offsets
 * are the widths of the columns before it — not known until the browser
 * has laid the table out. So they are measured after layout, again on
 * resize, and again when the rows are repainted under them, and handed
 * back as numbers for the cells to wear. Rounded *down*, so consecutive
 * frozen columns overlap by a fraction of a pixel rather than leaving a
 * hairline through which the scrolling content shows.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { viewportBox } from '../core.js';

/** Column name → sticky left, in layout pixels. */
type PinOffsets = Map<string, number>;

export function usePins(
  wrapRef: RefObject<HTMLElement | null>,
  drawn: string[],
  pinned: string[],
  /** Cell offset: an expander column shifts every data cell right by one. */
  shift: number,
  /** Anything whose change moves the columns — the rows painted. */
  repaintKey: unknown,
): PinOffsets {
  const [lefts, setLefts] = useState<PinOffsets>(new Map());

  const measure = () => {
    const wrap = wrapRef.current;
    const head = wrap?.querySelector('thead tr') as HTMLTableRowElement | null;
    if (!wrap || !head || !pinned.length) {
      setLefts((m) => (m.size ? new Map() : m));
      return;
    }
    const indexes = pinned
      .map((name) => drawn.indexOf(name))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    let offset = 0;
    const next: PinOffsets = new Map();
    for (const i of indexes) {
      next.set(drawn[i], Math.floor(offset));
      const cell = head.cells[i + shift];
      offset += cell ? viewportBox(cell).width : 0;
    }
    setLefts((m) => {
      if (m.size === next.size && [...next].every(([k, v]) => m.get(k) === v)) return m;
      return next;
    });
  };

  useLayoutEffect(measure, [drawn.join(','), pinned.join(','), shift, repaintKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !pinned.length) return;
    const size = new ResizeObserver(() => measure());
    size.observe(wrap);
    /* The seam appears only once there is something behind it. */
    const mark = () => {
      if (wrap.scrollLeft > 0) wrap.dataset.scrolled = '1';
      else delete wrap.dataset.scrolled;
    };
    wrap.addEventListener('scroll', mark, { passive: true });
    mark();
    return () => {
      size.disconnect();
      wrap.removeEventListener('scroll', mark);
    };
  }, [wrapRef, pinned.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return lefts;
}
